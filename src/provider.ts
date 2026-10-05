/**
 * The `human-search` web search provider: presents the fallback chain on the
 * `ctx.web` seam. Provenance travels in `content` — the serving engine, the
 * fallback trail, and any interactive sign-in window the user should know
 * about — while `sources` stays the portable citation shape the seam and the
 * stock `web_search` tool already render.
 * @module dsh-human-search/provider
 */

import { runSearchChain, type Attempt, type ChainDeps, type LoginPort, type SearchPoolPort } from './chain.ts'
import { HumanSearchError, type Logger, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from './dsh.ts'
import type { EngineId } from './engines/types.ts'
import type { HealthRegistry } from './health.ts'
import type { LoginPoolPort } from './login.ts'
import type { ConfigStore } from './settings.ts'

/** The provider id configured as `searchProvider` on the `web` seam row. */
export const PROVIDER_ID = 'human-search'

/** Dependencies beyond the store. */
export interface ProviderDeps extends ChainDeps {
  readonly pool: SearchPoolPort & LoginPoolPort
  readonly logins: LoginPort
  readonly health: HealthRegistry
  readonly logger: Logger
}

export class HumanSearchProvider implements WebSearchProvider {
  readonly id = PROVIDER_ID

  constructor(private readonly deps: ProviderDeps) {}

  available(): boolean {
    return this.deps.pool.hasUsableBrowser()
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const config = this.deps.store.get()
    const order: EngineId[] = config.engines.filter(entry => entry.enabled).map(entry => entry.id)
    if (order.length === 0) {
      throw new HumanSearchError(
        'human-search: no search engines are enabled — enable at least one in Settings → Plugins → Human Web Search',
        'HUMAN_SEARCH_NO_ENGINES',
      )
    }

    const chain = await runSearchChain(this.deps, order, request.query, request.maxResults ?? 0, signal)
    if (chain.servedBy !== undefined) {
      const content = renderProvenance(this.deps, chain.attempts, chain.servedBy, this.deps.logins)
      return {
        ...(content !== undefined ? { content } : {}),
        sources: chain.sources,
        truncated: chain.truncated,
      }
    }
    throw new HumanSearchError(renderAllFailed(chain.attempts, this.available()), 'HUMAN_SEARCH_ALL_ENGINES_FAILED')
  }
}

/** Human label for an engine id. */
function labelOf(deps: ProviderDeps, engine: EngineId): string {
  return deps.adapters.get(engine)?.label ?? engine
}

/**
 * One short provenance note for a successful search: the serving engine and,
 * only when something noteworthy happened on the way, the trail.
 */
function renderProvenance(
  deps: ProviderDeps,
  attempts: readonly Attempt[],
  servedBy: EngineId,
  logins: LoginPort,
): string | undefined {
  const trail = attempts
    .filter(attempt => attempt.engine !== servedBy || attempt.outcome !== 'ok')
    .map(attempt => `${labelOf(deps, attempt.engine)}: ${attempt.outcome}${attempt.detail !== undefined ? ` (${attempt.detail})` : ''}`)
  let note = `Human web search served by ${labelOf(deps, servedBy)}.`
  if (trail.length > 0) note += ` Skipped: ${trail.join('; ')}.`
  if (logins.hasPendingWindow()) {
    note += ' An interactive sign-in window is open on the machine running DSH — the user can complete it there; searches keep working on the other engines.'
  }
  return note
}

/** The all-engines-failed error text with per-engine reasons and a fix hint. */
function renderAllFailed(attempts: readonly Attempt[], browserAvailable: boolean): string {
  const lines = attempts.map((attempt) => {
    const detail = attempt.detail !== undefined ? ` — ${attempt.detail}` : ''
    return `- ${attempt.engine}: ${attempt.outcome}${detail}`
  })
  const hint = browserAvailable
    ? 'Hint: engines commonly block datacenter IPs; try again, complete a sign-in from the plugin settings card, or reorder engines.'
    : 'Hint: a browser for one of your enabled engines is missing. Run `npm run install-browser` in the dsh-human-search package (or npx playwright install firefox / webkit for non-Chromium engines), or set executablePath in Settings → Plugins → Human Web Search.'
  return `human-search: every engine failed.\n${lines.join('\n')}\n${hint}`
}
