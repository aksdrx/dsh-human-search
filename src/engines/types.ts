/**
 * The engine adapter contract: everything the generic human-search driver
 * needs to drive one search engine in a real browser. Adapters are pure
 * descriptions of engine markup and behavior — no browser lifecycle of their
 * own — so the driver owns the human-like interaction flow uniformly.
 * @module dsh-human-search/engines/types
 */

import type { Page } from 'playwright'
import type { WebSearchSource } from '../dsh.ts'

/** The engines this plugin ships. */
export type EngineId = 'google' | 'duckduckgo' | 'bing' | 'baidu' | 'sogou'

/** All valid engine ids. */
export const ENGINE_IDS: readonly EngineId[] = ['google', 'duckduckgo', 'bing', 'baidu', 'sogou']

/** Whether a value is a known engine id. */
export function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && (ENGINE_IDS as readonly string[]).includes(value)
}

/** What one settled results page means to the chain. */
export type PageOutcome =
  | { readonly kind: 'ok'; readonly sources: readonly WebSearchSource[] }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'empty' }

/**
 * One engine's driving surface. Selectors are engine facts; the driver
 * supplies typing, waiting, and timing.
 */
export interface EngineAdapter {
  readonly id: EngineId
  /** Locale used when the user sets no override. */
  readonly defaultLocale: string
  /** Where a human would start a search. */
  homeUrl(locale: string): string
  /**
   * The engine's results page for a query, verbatim. The human typing flow
   * is always tried first; this is the graceful fallback when an engine
   * renders its homepage without a usable search box (regional variants,
   * failed hydration).
   */
  searchUrl(locale: string, query: string): string
  /** Where the headed sign-in window opens (login page, or the engine itself when it has none). */
  loginUrl(locale: string): string
  /** CSS selector for the search box on the home page. */
  readonly searchBoxSelector: string
  /** CSS selector matching organic result anchors; presence means results loaded. */
  readonly resultSelector: string
  /** How long the driver waits for results-or-block before classifying as empty. */
  readonly settleMs: number
  /**
   * Why this page is blocked (CAPTCHA, bot wall, verification), or undefined
   * when it is not. Called on settled pages and, polled, inside the headed
   * sign-in session to detect success.
   */
  blockedReason(page: Page): Promise<string | undefined>
  /** Extract organic sources from a settled, unblocked results page. */
  extractSources(page: Page): Promise<readonly WebSearchSource[]>
  /** One-time page preparation (cookie-consent dialogs). */
  prepare?(page: Page): Promise<void>
  /** Human-facing engine name for notes and UI copy. */
  readonly label: string
}
