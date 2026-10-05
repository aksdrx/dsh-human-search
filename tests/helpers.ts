/**
 * Test doubles for the chain/provider/login suites: a scriptable fake page
 * and engine adapters that bypass Playwright entirely.
 * @module dsh-human-search/tests/helpers
 */

import type { Page } from 'playwright'
import { EngineBusyError } from '../src/browser.ts'
import type { SearchPoolPort } from '../src/chain.ts'
import type { LoginPoolPort } from '../src/login.ts'
import type { WebSearchSource } from '../src/dsh.ts'
import type { EngineAdapter, EngineId } from '../src/engines/types.ts'
import type { Config } from '../src/settings.ts'
import { ConfigStore } from '../src/settings.ts'

/** What one fake engine does this test. */
export interface EngineScript {
  /** Block reason to report, if any. */
  blocked?: string
  /** Organic sources to extract once results are "present". */
  sources?: WebSearchSource[]
  /** Whether the result selector matches anything. */
  resultsPresent?: boolean
  /** Simulate the pool-level attempt timeout. */
  timeout?: boolean
  /** Simulate the profile being held by a sign-in window. */
  busy?: boolean
  /** Simulate a launch failure distinct from a timeout. */
  launchError?: string
  /**
   * Submitting navigates to a results URL for this query instead of the
   * typed one (an autosuggest panel handing Enter to a trending
   * suggestion).
   */
  hijackQuery?: string
  /** The typed submit never navigates away (unhydrated homepage JavaScript). */
  submitDead?: boolean
  /** Reported page title; 'Loading…' models a bot-check interstitial stub. */
  title?: string
  /** Organic sources served only after the driver's results-URL fallback. */
  fallbackSources?: WebSearchSource[]
}

/** The store with a fully explicit test configuration. */
export function testStore(overrides: Partial<Config> = {}): ConfigStore {
  const config: Config = {
    engines: [
      { id: 'google', enabled: true, browser: 'chromium' },
      { id: 'duckduckgo', enabled: true, browser: 'chromium' },
      { id: 'bing', enabled: true, browser: 'chromium' },
      { id: 'baidu', enabled: true, browser: 'chromium' },
      { id: 'sogou', enabled: true, browser: 'chromium' },
    ],
    headless: true,
    locale: '',
    executablePath: '',
    // Generous engine budget: the human typing flow alone takes ~1–2s, and
    // the pool-level timeout must not race the settle loop.
    perEngineTimeoutMs: 5_000,
    chainBudgetMs: 15_000,
    idleCloseMs: 0,
    loginCommand: '',
    ...overrides,
  }
  return new ConfigStore(config)
}

/** A no-op logger. */
export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * The minimal fake page the driver touches: a small URL/typing state
 * machine. `goto` records navigations (marking the driver's results-URL
 * fallback), typed characters accumulate into the box's value, and Enter
 * either navigates to a results URL for the typed query, a hijacked one, or
 * nothing at all. Organic results appear per the script: `sources` on the
 * typed-submit SERP, `fallbackSources` only once the fallback URL was used.
 */
export function fakePage(script: EngineScript): Page {
  let url = 'https://engine.example/'
  let typed = ''
  let fellBack = false
  const organic = (): WebSearchSource[] =>
    fellBack && script.fallbackSources !== undefined ? script.fallbackSources : (script.sources ?? [])
  const box = {
    waitFor: async () => {},
    click: async () => {},
    inputValue: async () => typed,
    fill: async (value: string) => { typed = value },
  }
  const locator = {
    first: () => box,
    waitFor: async () => {},
    click: async () => {},
    count: async () => (script.resultsPresent === true || organic().length > 0 ? 3 : 0),
    inputValue: async () => typed,
    fill: async (value: string) => { typed = value },
  }
  const page = {
    url: () => url,
    title: async () => script.title ?? 'Engine results',
    goto: async (target: string) => {
      url = target
      if (target.includes('/search?')) fellBack = true
    },
    keyboard: {
      type: async (char: string) => { typed += char },
      press: async (key: string) => {
        if (key !== 'Enter' || script.submitDead === true) return
        const submitted = script.hijackQuery ?? typed
        if (submitted.length > 0) url = `https://engine.example/search?q=${encodeURIComponent(submitted)}`
      },
    },
    locator: () => locator,
    evaluate: async () => undefined,
    /** Organic sources for the adapter's extractor, per current page state. */
    __organic: organic,
  }
  return page as unknown as Page
}

/** A scriptable engine adapter. */
export function fakeAdapter(id: EngineId, script: () => EngineScript): EngineAdapter {
  return {
    id,
    label: id === 'google' ? 'Google' : id === 'duckduckgo' ? 'DuckDuckGo' : id === 'bing' ? 'Bing' : id === 'baidu' ? 'Baidu' : 'Sogou',
    defaultLocale: 'en-US',
    homeUrl: () => 'https://engine.example/',
    loginUrl: () => `https://login.${id}.example/`,
    searchUrl: (_locale, query) => `https://engine.example/search?q=${encodeURIComponent(query)}`,
    searchBoxSelector: 'input[name="q"]',
    resultSelector: '.result a',
    settleMs: 120,
    blockedReason: async () => script().blocked,
    extractSources: async (page: Page) => {
      const organic = (page as unknown as { __organic?: () => WebSearchSource[] }).__organic
      return organic !== undefined ? organic() : (script().sources ?? [])
    },
  }
}

/** The fake pool keyed by engine, typed against both pool ports. */
export function fakePool(scripts: Partial<Record<EngineId, () => EngineScript>>): SearchPoolPort & LoginPoolPort {
  return {
    async withHeadlessPage<T>(engine: EngineId, timeoutMs: number, operation: (page: Page) => Promise<T>): Promise<T> {
      const script = scripts[engine]?.() ?? {}
      if (script.busy === true) throw new EngineBusyError(engine)
      if (script.launchError !== undefined) throw new Error(script.launchError)
      if (script.timeout === true) {
        throw new Error(`engine attempt timed out after ${String(timeoutMs)}ms`)
      }
      return await operation(fakePage(script))
    },
    hasUsableBrowser: () => true,
    openHeaded: async () => { throw new Error('not implemented by the fake pool') },
    releaseHeaded: async () => {},
  }
}

/** The fake login coordinator (chain-level tests watch `calls` only). */
export function fakeLogins(): ChainLoginsFake {
  const calls: Array<[EngineId, string]> = []
  return {
    calls,
    start: (engine, trigger) => { calls.push([engine, trigger]) },
    hasPendingWindow: () => false,
    dispose: () => {},
  }
}

/** The login-coordinator surface the chain and provider consume. */
export interface ChainLoginsFake {
  readonly calls: Array<[EngineId, string]>
  start(engine: EngineId, trigger: 'auto' | 'manual'): void
  hasPendingWindow(): boolean
  dispose(): void
}
