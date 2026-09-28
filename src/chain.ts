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
import { relevantSources } from './engines/util.ts'
import type { HealthRegistry } from './health.ts'
import { humanPause, humanType, sleep } from './human.ts'
import type { Locator, Page } from 'playwright'
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
 * then settle into a wait-for-results-or-block loop. The typed submit is
 * verified, not assumed — a homepage whose JavaScript has not hydrated yet
 * swallows clicks and keystrokes, and an open autosuggest panel hands Enter
 * to a trending suggestion — so anything unusable falls back to the engine's
 * results URL once. Bounded by the pool's page timeout around the whole call.
 */
async function driveOneSearch(
  page: Page,
  adapter: EngineAdapter,
  query: string,
  locale: string,
  budget: number,
  signal: AbortSignal | undefined,
): Promise<readonly WebSearchSource[]> {
  const startedAt = Date.now()
  signal?.throwIfAborted()
  const navTimeout = Math.max(3_000, Math.min(budget - 1_500, 12_000))
  await page.goto(adapter.homeUrl(locale), { waitUntil: 'domcontentloaded', timeout: navTimeout })
  await adapter.prepare?.(page)

  // Some walls appear before any typing; check immediately after consent.
  const initialBlock = await adapter.blockedReason(page)
  if (initialBlock !== undefined) throw new BlockedError(initialBlock)

  // Where the homepage settled after redirects; an unchanged URL later
  // means the submit never navigated anywhere.
  const homeUrl = page.url()

  // The human flow: type into the engine's own box. A box that never
  // appears is not a failure yet — the URL fallback below still gets a
  // chance.
  try {
    const box = page.locator(adapter.searchBoxSelector).first()
    await box.waitFor({ state: 'visible', timeout: 4_000 })
    await box.click({ timeout: 2_000 })
    await humanPause()
    await typeAndSubmit(page, box, query)
  } catch {
    // Box missing or it never accepted the query; settle first (SPA-style
    // engines sometimes submit anyway), then fall through to the fallback.
  }

  const remainingAfterTyping = budget - (Date.now() - startedAt)
  // The 500ms reserve keeps the settle loop's final poll iteration from
  // spilling into the pool-level timeout (which would misreport 'timeout'
  // instead of 'empty').
  const settleMs = Math.min(adapter.settleMs + 2_500, remainingAfterTyping - 500)
  if (settleMs > 0) {
    const sources = await settleForResults(page, adapter, Date.now() + settleMs, signal, query, homeUrl)
    if (sources.length > 0) return sources
  }

  // The typed flow verified nothing usable — swallowed submit, hijacked
  // suggestions, decoy SERP — so go to the engine's results URL directly.
  if (signal !== undefined && signal.aborted) throw new Error('aborted')
  const remaining = budget - (Date.now() - startedAt)
  if (remaining < 1_500) return []
  await page.goto(adapter.searchUrl(locale, query), {
    waitUntil: 'domcontentloaded',
    timeout: Math.max(3_000, Math.min(remaining - 1_000, 12_000)),
  })
  const fallbackBlock = await adapter.blockedReason(page)
  if (fallbackBlock !== undefined) throw new BlockedError(fallbackBlock)
  const fallbackSettleMs = Math.min(adapter.settleMs + 2_000, budget - (Date.now() - startedAt) - 500)
  if (fallbackSettleMs <= 0) return []
  return settleForResults(
    page,
    adapter,
    Date.now() + fallbackSettleMs,
    signal,
    query,
    homeUrl,
  )
}

/** How long a results page for another query is watched before bailing. */
const WRONG_QUERY_GRACE_MS = 1_500

/** How long an un-navigated homepage is watched before bailing. */
const HOME_SILENT_GRACE_MS = 2_000

/**
 * Type the query and submit it, verifying the engine actually accepted it:
 * the box's value is read back (a not-yet-hydrated page swallows keystrokes
 * into nowhere), an explicit fill retries once, and the autosuggest panel is
 * dismissed before Enter — with it open, Enter submits the highlighted
 * trending suggestion instead of the typed query.
 */
async function typeAndSubmit(page: Page, box: Locator, query: string): Promise<void> {
  await humanType(page, query)
  await page.keyboard.press('Escape')
  if (await readValue(box) !== query) {
    await box.fill(query, { timeout: 1_500 }).catch(() => {})
    await page.keyboard.press('Escape')
    if (await readValue(box) !== query) {
      throw new Error('the search box did not accept the query')
    }
  }
  await humanPause()
  await page.keyboard.press('Enter')
}

/** The current value of the search box, or '' when it cannot be read. */
async function readValue(box: Locator): Promise<string> {
  try {
    return await box.inputValue({ timeout: 800 })
  } catch {
    return ''
  }
}

/**
 * Whether a page URL is a results URL for exactly this query: any search
 * parameter (q, wd, query, …) whose decoded value equals the query, in the
 * query string or the hash. Catches submits that were hijacked into a
 * trending suggestion and engine rewrites of the query.
 */
export function urlCarriesQuery(pageUrl: string, query: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(pageUrl)
  } catch {
    return false
  }
  const carried = (params: URLSearchParams): boolean => {
    for (const value of params.values()) {
      if (value === query) return true
    }
    return false
  }
  if (carried(parsed.searchParams)) return true
  const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
  if (!hash.includes('=')) return false
  try {
    return carried(new URLSearchParams(hash))
  } catch {
    return false
  }
}

/**
 * Whether the current page is a bot-check interstitial stub — e.g. Bing's
 * "Loading…" redirect page, which already carries decoy results that must
 * never be extracted — recognized by its redirect marker or placeholder
 * title.
 */
async function isInterstitial(page: Page): Promise<boolean> {
  try {
    if (/[?&]rdr=/.test(page.url())) return true
    const title = (await page.title()).trim().toLowerCase()
    return title.length === 0 || title.startsWith('loading')
  } catch {
    return false
  }
}

/**
 * Poll a submitted results page until organic sources for THE query parse, a
 * block appears, or the deadline passes. Three page states are never
 * mistaken for usable results: interstitial stubs (skipped outright), a SERP
 * for a different query (an autosuggest hijack or engine rewrite — bailed on
 * quickly so the results-URL fallback can re-run the real query), and
 * results sharing no query token at all (a decoy SERP served on the right
 * URL under IP-reputation pressure). An empty return means "nothing usable
 * parsed".
 */
async function settleForResults(
  page: Page,
  adapter: EngineAdapter,
  deadline: number,
  signal: AbortSignal | undefined,
  query: string,
  homeUrl: string,
): Promise<readonly WebSearchSource[]> {
  let wrongQuerySince: number | undefined
  let homeSilentSince: number | undefined
  while (Date.now() < deadline) {
    if (signal !== undefined && signal.aborted) throw new Error('aborted')
    if (await isInterstitial(page)) {
      await sleep(350)
      continue
    }
    const blocked = await adapter.blockedReason(page)
    if (blocked !== undefined) throw new BlockedError(blocked)
    const count = await page.locator(adapter.resultSelector).count().catch(() => 0)
    if (count > 0) {
      // Organic anchors are present; give snippets a beat to render.
      await sleep(Math.min(400, Math.max(50, adapter.settleMs / 8)))
      const sources = await adapter.extractSources(page).catch(() => [])
      if (sources.length > 0 && relevantSources(sources, query)) return sources
      if (urlCarriesQuery(page.url(), query)) {
        // Right query, unusable content (or still rendering): keep waiting.
        wrongQuerySince = undefined
      } else {
        // A SERP for another query never becomes ours; stop spending the
        // budget so the results-URL fallback can run the real query.
        wrongQuerySince ??= Date.now()
        if (Date.now() - wrongQuerySince > WRONG_QUERY_GRACE_MS) return []
      }
    } else if (page.url() === homeUrl) {
      // The submit never navigated away: the homepage's JavaScript was not
      // ready and swallowed it.
      homeSilentSince ??= Date.now()
      if (Date.now() - homeSilentSince > HOME_SILENT_GRACE_MS) return []
    } else {
      homeSilentSince = undefined
    }
    await sleep(350)
  }
  return []
}
