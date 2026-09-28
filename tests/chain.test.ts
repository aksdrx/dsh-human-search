/**
 * Fallback-chain unit tests over `src/chain.ts` with scripted engines.
 * @module dsh-human-search/tests/chain
 */

import { describe, expect, it } from 'vitest'
import { runSearchChain, urlCarriesQuery } from '../src/chain.ts'
import { HealthRegistry } from '../src/health.ts'
import {
  fakeAdapter, fakeLogins, fakePool, silentLogger, testStore,
  type EngineScript,
} from './helpers.ts'
import type { EngineId } from '../src/engines/types.ts'

/** Build chain deps around one script table. */
function makeDeps(scripts: Partial<Record<EngineId, () => EngineScript>>, health = new HealthRegistry(silentLogger)) {
  const entries = Object.entries(scripts) as Array<[EngineId, () => EngineScript]>
  const adapters = new Map(entries.map(([id, script]) => [id, fakeAdapter(id, script)]))
  const logins = fakeLogins()
  return {
    deps: {
      pool: fakePool(scripts),
      adapters,
      health,
      logins,
      store: testStore(),
      logger: silentLogger,
    },
    logins,
  }
}

// Titles carry the query word so the decoy relevance guard accepts them
// (tests search for "query").
const hit = (url: string): { url: string, title: string, snippet: string } => ({ url, title: `query — Title ${url}`, snippet: 'a snippet' })

// A source with nothing to do with the query, as a decoy SERP serves.
const gossip = (n: number): { url: string, title: string, snippet: string } => ({
  url: `https://gossip.example/${String(n)}`,
  title: `Celebrity sightings ${String(n)}`,
  snippet: 'trending now',
})

describe('runSearchChain', () => {
  it('serves from the first healthy engine without side effects', async () => {
    const { deps, logins } = makeDeps({
      google: () => ({ resultsPresent: true, sources: [hit('https://a.example/1'), hit('https://b.example/2')] }),
    })
    const result = await runSearchChain(deps, ['google', 'bing'], 'query', 8, undefined)
    expect(result.servedBy).toBe('google')
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(false)
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]?.outcome).toBe('ok')
    expect(logins.calls).toHaveLength(0)
  })

  it('fails over on a CAPTCHA, triggers the login episode, and records the trail', async () => {
    const { deps, logins } = makeDeps({
      google: () => ({ blocked: 'captcha' }),
      duckduckgo: () => ({ resultsPresent: true, sources: [hit('https://ddg.example/1')] }),
    })
    const result = await runSearchChain(deps, ['google', 'duckduckgo'], 'query', 8, undefined)
    expect(result.servedBy).toBe('duckduckgo')
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['blocked', 'ok'])
    expect(logins.calls).toEqual([['google', 'auto']])
    expect(deps.health.shouldTry('google')).toBe(false)
  })

  it('fails over on empty results and on timeouts', { timeout: 15_000 }, async () => {
    const { deps } = makeDeps({
      google: () => ({ resultsPresent: true, sources: [] }),
      duckduckgo: () => ({ timeout: true }),
      bing: () => ({ resultsPresent: true, sources: [hit('https://bing.example/1')] }),
    })
    const result = await runSearchChain(deps, ['google', 'duckduckgo', 'bing'], 'query', 8, undefined)
    expect(result.servedBy).toBe('bing')
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['empty', 'timeout', 'ok'])
  })

  it('classifies a held profile as busy and a launch failure as error', async () => {
    const { deps } = makeDeps({
      google: () => ({ busy: true }),
      duckduckgo: () => ({ launchError: 'no usable browser' }),
      bing: () => ({ resultsPresent: true, sources: [hit('https://bing.example/1')] }),
    })
    const result = await runSearchChain(deps, ['google', 'duckduckgo', 'bing'], 'query', 8, undefined)
    expect(result.servedBy).toBe('bing')
    expect(result.attempts.map(attempt => attempt.outcome)).toEqual(['busy', 'error', 'ok'])
  })

  it('skips engines inside the blocked cooldown', async () => {
    const health = new HealthRegistry(silentLogger)
    health.markBlocked('google', 'captcha')
    const { deps } = makeDeps({
      google: () => { throw new Error('must not be attempted') },
      bing: () => ({ resultsPresent: true, sources: [hit('https://bing.example/1')] }),
    }, health)
    const result = await runSearchChain({ ...deps, health }, ['google', 'bing'], 'query', 8, undefined)
    expect(result.servedBy).toBe('bing')
    expect(result.attempts[0]).toMatchObject({ engine: 'google', outcome: 'skipped' })
  })

  it('caps sources at maxResults and flags truncation', async () => {
    const { deps } = makeDeps({
      google: () => ({
        resultsPresent: true,
        sources: [1, 2, 3, 4, 5].map(n => hit(`https://x.example/${String(n)}`)),
      }),
    })
    const result = await runSearchChain(deps, ['google'], 'query', 2, undefined)
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('reports every engine failed without throwing', async () => {
    const { deps } = makeDeps({
      google: () => ({ blocked: 'captcha' }),
      duckduckgo: () => ({ blocked: 'anomaly' }),
    })
    const result = await runSearchChain(deps, ['google', 'duckduckgo'], 'query', 8, undefined)
    expect(result.servedBy).toBeUndefined()
    expect(result.sources).toHaveLength(0)
    expect(result.attempts.every(attempt => attempt.outcome === 'blocked')).toBe(true)
  })

  it('stops early when the chain budget is spent', async () => {
    // One engine that settles empty consumes its whole per-engine budget;
    // afterwards the remaining chain budget can no longer fit an attempt.
    const store = testStore({ perEngineTimeoutMs: 800, chainBudgetMs: 2_000 })
    const { deps } = makeDeps({
      google: () => ({ resultsPresent: false }),
      bing: () => { throw new Error('must not be attempted') },
    })
    const result = await runSearchChain({ ...deps, store }, ['google', 'bing'], 'query', 8, undefined)
    expect(result.servedBy).toBeUndefined()
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]?.outcome).toBe('empty')
  })

  it('respects an aborted signal before any engine runs', async () => {
    const { deps } = makeDeps({
      google: () => { throw new Error('must not run') },
    })
    const controller = new AbortController()
    controller.abort()
    const result = await runSearchChain(deps, ['google'], 'query', 8, controller.signal)
    expect(result.attempts).toHaveLength(0)
    expect(result.servedBy).toBeUndefined()
  })
})

describe('runSearchChain submit hardening', () => {
  // The hardening paths wait out real grace windows (wrong-query SERP,
  // un-navigated homepage), so the engine budgets are generous here.
  const generous = { perEngineTimeoutMs: 10_000, chainBudgetMs: 30_000 }

  it('recovers via the results URL when an unhydrated homepage swallows the submit', { timeout: 20_000 }, async () => {
    const { deps } = makeDeps({
      google: () => ({ submitDead: true, fallbackSources: [hit('https://fallback.example/1')] }),
    })
    const result = await runSearchChain({ ...deps, store: testStore(generous) }, ['google'], 'query', 8, undefined)
    expect(result.servedBy).toBe('google')
    expect(result.sources[0]?.url).toBe('https://fallback.example/1')
    expect(result.attempts[0]?.outcome).toBe('ok')
  })

  it('rejects an autosuggest-hijacked SERP and re-runs the real query', { timeout: 20_000 }, async () => {
    const { deps } = makeDeps({
      google: () => ({
        hijackQuery: 'trending celebrity news',
        resultsPresent: true,
        sources: [gossip(1)],
        fallbackSources: [hit('https://real.example/1')],
      }),
    })
    const result = await runSearchChain({ ...deps, store: testStore(generous) }, ['google'], 'query', 8, undefined)
    expect(result.servedBy).toBe('google')
    expect(result.sources[0]?.url).toBe('https://real.example/1')
    expect(result.sources[0]?.title).not.toContain('Celebrity')
  })

  it('treats a decoy SERP on the correct URL as empty and fails over', { timeout: 30_000 }, async () => {
    const { deps } = makeDeps({
      bing: () => ({ resultsPresent: true, sources: [gossip(1)], fallbackSources: [gossip(2)] }),
      baidu: () => ({ resultsPresent: true, sources: [hit('https://baidu.example/1')] }),
    })
    const result = await runSearchChain({ ...deps, store: testStore(generous) }, ['bing', 'baidu'], 'query', 8, undefined)
    expect(result.servedBy).toBe('baidu')
    expect(result.attempts[0]).toMatchObject({ engine: 'bing', outcome: 'empty' })
    expect(result.attempts[1]?.outcome).toBe('ok')
  })

  it('never extracts from a Loading interstitial stub', { timeout: 30_000 }, async () => {
    const { deps } = makeDeps({
      google: () => ({ title: 'Loading…', resultsPresent: true, sources: [hit('https://decoy.example/1')] }),
      duckduckgo: () => ({ resultsPresent: true, sources: [hit('https://ddg.example/1')] }),
    })
    const result = await runSearchChain({ ...deps, store: testStore(generous) }, ['google', 'duckduckgo'], 'query', 8, undefined)
    expect(result.servedBy).toBe('duckduckgo')
    expect(result.attempts[0]?.outcome).toBe('empty')
  })
})

describe('urlCarriesQuery', () => {
  it('matches any search parameter equal to the query', () => {
    expect(urlCarriesQuery('https://www.bing.com/search?q=eBPF+news&form=QBLH', 'eBPF news')).toBe(true)
    expect(urlCarriesQuery('https://www.baidu.com/s?wd=人工智能', '人工智能')).toBe(true)
    expect(urlCarriesQuery('https://www.sogou.com/web?query=rust', 'rust')).toBe(true)
  })
  it('checks hash parameters and decodes escapes', () => {
    expect(urlCarriesQuery('https://duckduckgo.com/?q=web%20search#q=web%20search', 'web search')).toBe(true)
  })
  it('rejects other queries, non-search URLs, and garbage', () => {
    expect(urlCarriesQuery('https://www.bing.com/search?q=butcher', 'eBPF news')).toBe(false)
    expect(urlCarriesQuery('https://www.google.com/', 'eBPF news')).toBe(false)
    expect(urlCarriesQuery('not a url', 'eBPF news')).toBe(false)
  })
})
