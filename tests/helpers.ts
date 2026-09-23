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
}

/** The store with a fully explicit test configuration. */
export function testStore(overrides: Partial<Config> = {}): ConfigStore {
  const config: Config = {
    engines: [
      { id: 'google', enabled: true },
      { id: 'duckduckgo', enabled: true },
      { id: 'bing', enabled: true },
      { id: 'baidu', enabled: true },
      { id: 'sogou', enabled: true },
    ],
    headless: true,
    locale: '',
    executablePath: '',
    perEngineTimeoutMs: 2_000,
    chainBudgetMs: 10_000,
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

/** The minimal fake page the driver touches. */
export function fakePage(script: EngineScript): Page {
  return {
    url: () => 'https://engine.example/search?q=test',
    goto: async () => {},
    keyboard: { type: async () => {}, press: async () => {} },
    locator: () => ({
      first: () => ({ waitFor: async () => {}, click: async () => {} }),
      waitFor: async () => {},
      click: async () => {},
      count: async () => (script.resultsPresent === true ? 3 : 0),
    }),
    evaluate: async () => undefined,
  } as unknown as Page
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
    extractSources: async () => script().sources ?? [],
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
