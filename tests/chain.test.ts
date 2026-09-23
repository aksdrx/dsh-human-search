/**
 * Fallback-chain unit tests over `src/chain.ts` with scripted engines.
 * @module dsh-human-search/tests/chain
 */

import { describe, expect, it } from 'vitest'
import { runSearchChain } from '../src/chain.ts'
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

const hit = (url: string): { url: string, title: string, snippet: string } => ({ url, title: `Title ${url}`, snippet: 'a snippet' })

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
