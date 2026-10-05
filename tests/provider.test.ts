/**
 * Provider-level unit tests over `src/provider.ts`: provenance notes,
 * truncation, and the coded failures.
 * @module dsh-human-search/tests/provider
 */

import { describe, expect, it } from 'vitest'
import type { LoginPort } from '../src/chain.ts'
import { HumanSearchError } from '../src/dsh.ts'
import { HealthRegistry } from '../src/health.ts'
import { HumanSearchProvider, PROVIDER_ID } from '../src/provider.ts'
import type { Config } from '../src/settings.ts'
import {
  fakeAdapter, fakeLogins, fakePool, silentLogger, testStore, type EngineScript,
} from './helpers.ts'
import type { EngineAdapter, EngineId } from '../src/engines/types.ts'

function makeProvider(
  scripts: Partial<Record<EngineId, () => EngineScript>>,
  overrides: Partial<Config> = {},
  logins: LoginPort = fakeLogins(),
) {
  const entries = Object.entries(scripts) as Array<[EngineId, () => EngineScript]>
  const health = new HealthRegistry(silentLogger)
  const provider = new HumanSearchProvider({
    pool: fakePool(scripts),
    adapters: new Map(entries.map(([id, script]) => [id, fakeAdapter(id, script)])),
    health,
    logins,
    store: testStore(overrides),
    logger: silentLogger,
  })
  return { provider, logins }
}

// Titles carry the query word ("test") so the decoy relevance guard accepts them.
const hit = (url: string) => ({ url, title: `test — Title ${url}`, snippet: 'a snippet' })

describe('HumanSearchProvider', () => {
  it('exposes the stable provider id', () => {
    const { provider } = makeProvider({})
    expect(provider.id).toBe(PROVIDER_ID)
    expect(provider.id).toBe('human-search')
  })

  it('returns sources with a provenance note on success', async () => {
    const { provider } = makeProvider({
      google: () => ({ blocked: 'captcha' }),
      duckduckgo: () => ({ resultsPresent: true, sources: [hit('https://ddg.example/1')] }),
    })
    const result = await provider.search({ query: 'test' })
    expect(result.sources).toHaveLength(1)
    expect(result.content).toContain('served by DuckDuckGo')
    expect(result.content).toContain('Google: blocked (captcha)')
    expect(result.truncated).toBe(false)
  })

  it('omits the trail when the first engine just served', async () => {
    const { provider } = makeProvider({
      google: () => ({ resultsPresent: true, sources: [hit('https://a.example/1')] }),
    })
    const result = await provider.search({ query: 'test' })
    expect(result.content).toBe('Human web search served by Google.')
  })

  it('throws the coded all-engines-failed error with per-engine reasons', async () => {
    const { provider } = makeProvider({
      google: () => ({ blocked: 'captcha' }),
      duckduckgo: () => ({ timeout: true }),
      bing: () => ({ launchError: 'no usable browser' }),
    })
    await expect(provider.search({ query: 'test' })).rejects.toSatisfy((error: unknown) => {
      const typed = error as HumanSearchError
      return typed instanceof HumanSearchError
        && typed.code === 'HUMAN_SEARCH_ALL_ENGINES_FAILED'
        && typed.message.includes('- google: blocked — captcha')
        && typed.message.includes('- duckduckgo: timeout')
        && typed.message.includes('- bing: error — no usable browser')
        // The fake pool reports a browser as available, so the hint names
        // engine blocking rather than the missing-browser setup path.
        && typed.message.includes('engines commonly block datacenter IPs')
    })
  })

  it('names the missing-browser fix when no browser is usable', async () => {
    const google = (): EngineScript => ({ launchError: 'chromium not found' })
    const provider = new HumanSearchProvider({
      pool: { ...fakePool({ google }), hasUsableBrowser: () => false },
      adapters: new Map<EngineId, EngineAdapter>([['google', fakeAdapter('google', google)]]),
      health: new HealthRegistry(silentLogger),
      logins: fakeLogins(),
      store: testStore(),
      logger: silentLogger,
    })
    await expect(provider.search({ query: 'test' })).rejects.toSatisfy((error: unknown) =>
      (error as HumanSearchError).message.includes('a browser for one of your enabled engines is missing'))
  })

  it('refuses to search with every engine disabled', async () => {
    const { provider } = makeProvider(
      { google: () => ({ resultsPresent: true, sources: [hit('https://a.example/1')] }) },
      { engines: [
        { id: 'google', enabled: false, browser: 'chromium' },
        { id: 'duckduckgo', enabled: false, browser: 'chromium' },
        { id: 'bing', enabled: false, browser: 'chromium' },
        { id: 'baidu', enabled: false, browser: 'chromium' },
        { id: 'sogou', enabled: false, browser: 'chromium' },
      ] },
    )
    await expect(provider.search({ query: 'test' })).rejects.toSatisfy((error: unknown) =>
      (error as HumanSearchError).code === 'HUMAN_SEARCH_NO_ENGINES')
  })

  it('mentions an open sign-in window in the provenance note', async () => {
    const { provider } = makeProvider(
      { google: () => ({ resultsPresent: true, sources: [hit('https://a.example/1')] }) },
      {},
      { start: () => {}, hasPendingWindow: () => true },
    )
    const result = await provider.search({ query: 'test' })
    expect(result.content).toContain('interactive sign-in window is open')
  })
})
