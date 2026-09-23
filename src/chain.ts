/**
 * The fallback chain: drives one human-like search per engine, strictly in
 * the user's order, inside a shared deadline. Every failure mode — CAPTCHA or
 * bot wall, timeout, parse failure, zero results, a profile held by an open
 * sign-in window — classifies the attempt and moves to the next engine; a
 * CAPTCHA additionally triggers the (asynchronous, non-blocking) login
 * episode for that engine.
 * @module dsh-human-search/chain
 */

import { EngineBusyError } from './browser.ts'
import type { Logger, WebSearchSource } from './dsh.ts'
import type { EngineAdapter, EngineId } from './engines/types.ts'
import type { HealthRegistry } from './health.ts'
import { humanPause, humanType, sleep } from './human.ts'
import type { Page } from 'playwright'
import type { Config, ConfigStore } from './settings.ts'

/**
 * The pool surface the chain needs: one bounded headless page per engine and
 * the cheap availability probe backing `available()`.
 */
export interface SearchPoolPort {
  withHeadlessPage<T>(engine: EngineId, timeoutMs: number, operation: (page: Page) => Promise<T>): Promise<T>
  hasUsableBrowser(): boolean
}

/** The login-coordinator surface the chain needs. */
export interface LoginPort {
  start(engine: EngineId, trigger: 'auto' | 'manual'): void
  hasPendingWindow(): boolean
}

/** Raised inside the driver when a settled page carries block signals. */
export class BlockedError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`blocked: ${reason}`)
    this.name = 'BlockedError'
    this.reason = reason
  }
}

/** How one engine's attempt ended. */
export type AttemptOutcome =
  | 'ok'
  | 'blocked'
  | 'timeout'
  | 'error'
  | 'empty'
  | 'busy'
  | 'skipped'

/** One engine's attempt record. */
export interface Attempt {
  readonly engine: EngineId
  readonly outcome: AttemptOutcome
  readonly detail: string | undefined
  readonly ms: number
  readonly sources: number
}

/** The whole chain's outcome. */
export interface ChainResult {
  readonly attempts: readonly Attempt[]
  readonly sources: readonly WebSearchSource[]
  readonly servedBy: EngineId | undefined
  /** True when sources were cut to the request's cap. */
  readonly truncated: boolean
}

/** Everything the chain needs besides the query. */
export interface ChainDeps {
  readonly pool: SearchPoolPort
  readonly adapters: ReadonlyMap<EngineId, EngineAdapter>
  readonly health: HealthRegistry
  readonly logins: LoginPort
  readonly store: ConfigStore
  readonly logger: Logger
}

/**
 * Run the ordered fallback chain for one query. Never throws: every engine
 * failure is recorded and the chain moves on; an empty result means every
 * engine failed (or the budget ran out).
 */
export async function runSearchChain(
  deps: ChainDeps,
  order: readonly EngineId[],
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<ChainResult> {
  const config: Config = deps.store.get()
  const deadline = Date.now() + config.chainBudgetMs
  const attempts: Attempt[] = []
  const cap = maxResults > 0 ? maxResults : 15

  for (const engine of order) {
    if (signal?.aborted === true) break
    const remaining = deadline - Date.now()
    if (remaining < 1_500) break
    const adapter = deps.adapters.get(engine)
    if (adapter === undefined) continue

    if (!deps.health.shouldTry(engine)) {
      attempts.push({ engine, outcome: 'skipped', detail: 'blocked; awaiting sign-in or cooldown', ms: 0, sources: 0 })
      continue
    }

    const budget = Math.min(config.perEngineTimeoutMs, remaining)
    const locale = config.locale.length > 0 ? config.locale : adapter.defaultLocale
    const started = Date.now()
    try {
      const sources = await deps.pool.withHeadlessPage(engine, budget, async page =>
        driveOneSearch(page, adapter, query, locale, budget, signal))
      const ms = Date.now() - started
      if (sources.length === 0) {
        attempts.push({ engine, outcome: 'empty', detail: 'no organic results parsed', ms, sources: 0 })
        continue
      }
      deps.health.markOk(engine)
      attempts.push({ engine, outcome: 'ok', detail: undefined, ms, sources: sources.length })
      const truncated = sources.length > cap
      return {
        attempts,
        sources: truncated ? sources.slice(0, cap) : sources,
        servedBy: engine,
        truncated,
      }
    } catch (error) {
      const ms = Date.now() - started
      const record = (outcome: AttemptOutcome, detail: string): void => {
        attempts.push({ engine, outcome, detail, ms, sources: 0 })
      }
      if (error instanceof EngineBusyError) {
        record('busy', 'profile held by the open sign-in window')
        continue
      }
      if (error instanceof BlockedError) {
        record('blocked', error.reason)
        deps.health.markBlocked(engine, error.reason)
        deps.logins.start(engine, 'auto')
        continue
      }
      if (signal !== undefined && signal.aborted) {
        record('error', 'aborted')
        break
      }
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('timed out') || message.includes('TimeoutError')) {
        record('timeout', message)
      } else {
        record('error', message)
        deps.logger.info('human-search: engine "%s" attempt failed: %s', engine, message)
      }
    }
  }

  return { attempts, sources: [], servedBy: undefined, truncated: false }
}

/**
 * Drive one human-like search on an engine page: open the engine's home,
 * dismiss consent walls, find the search box, type like a person, submit,
 * then settle into a wait-for-results-or-block loop. Bounded by the pool's
 * page timeout around the whole call.
 */
async function driveOneSearch(
  page: Page,
  adapter: EngineAdapter,
  query: string,
  locale: string,
  budget: number,
  signal: AbortSignal | undefined,
): Promise<readonly WebSearchSource[]> {
  signal?.throwIfAborted()
  const navTimeout = Math.max(3_000, Math.min(budget - 1_500, 12_000))
  await page.goto(adapter.homeUrl(locale), { waitUntil: 'domcontentloaded', timeout: navTimeout })
  await adapter.prepare?.(page)

  // Some walls appear before any typing; check immediately after consent.
  const initialBlock = await adapter.blockedReason(page)
  if (initialBlock !== undefined) throw new BlockedError(initialBlock)

  const box = page.locator(adapter.searchBoxSelector).first()
  await box.waitFor({ state: 'visible', timeout: 5_000 })
  await box.click({ timeout: 2_000 })
  await humanPause()
  await humanType(page, query)
  await page.keyboard.press('Enter')

  const settleDeadline = Date.now() + Math.min(adapter.settleMs + 2_500, budget)
  while (Date.now() < settleDeadline) {
    if (signal !== undefined && signal.aborted) throw new Error('aborted')
    const blocked = await adapter.blockedReason(page)
    if (blocked !== undefined) throw new BlockedError(blocked)
    const count = await page.locator(adapter.resultSelector).count().catch(() => 0)
    if (count > 0) {
      // Organic anchors are present; give snippets a beat to render.
      await sleep(Math.min(400, Math.max(50, adapter.settleMs / 8)))
      const sources = await adapter.extractSources(page).catch(() => [])
      if (sources.length > 0) return sources
    }
    await sleep(350)
  }
  return []
}
