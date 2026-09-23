/**
 * Login-coordinator unit tests over `src/login.ts` with a fake headed
 * session: the cannot-open path and the cleared→persist path. The parked
 * and timeout paths rely on wall-clock nudges out of unit scope.
 * @module dsh-human-search/tests/login
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { LoginPoolPort } from '../src/login.ts'
import { LoginCoordinator } from '../src/login.ts'
import { HealthRegistry } from '../src/health.ts'
import { fakeAdapter, silentLogger, testStore } from './helpers.ts'
import type { EngineAdapter, EngineId } from '../src/engines/types.ts'
import { ensureStateLayout, storageStatePath } from '../src/state.ts'
import type { HeadedSession } from '../src/browser.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-human-search-test-'))
const layout = ensureStateLayout(root)
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

/** A fake headed page/context pair. */
function headedFake(script: { url: string, storage: string }): HeadedSession {
  const page = {
    isClosed: () => false,
    url: () => script.url,
    goto: async () => {},
    context: () => ({
      pages: () => [page],
      storageState: async (options: { path?: string }) => {
        if (options?.path !== undefined) writeFileSync(options.path, script.storage)
        return { cookies: [], origins: [] }
      },
    }),
  }
  return {
    engine: 'google',
    page: page as never,
    whenClosed: Promise.resolve(),
    close: async () => {},
  }
}

describe('LoginCoordinator', () => {
  it('marks the engine blocked when no window can open', async () => {
    const health = new HealthRegistry(silentLogger)
    const pool: LoginPoolPort = {
      openHeaded: async () => { throw new Error('no display') },
      releaseHeaded: async () => {},
    }
    const logins = new LoginCoordinator(
      pool,
      health,
      testStore(),
      layout,
      new Map<EngineId, EngineAdapter>([['google', fakeAdapter('google', () => ({}))]]),
      silentLogger,
    )
    logins.start('google', 'manual')
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(health.shouldTry('google')).toBe(false)
    expect(health.snapshot().find(entry => entry.engine === 'google')?.reason).toContain('cannot open sign-in window')
  })

  it('persists cookies and marks the engine ok once the block clears', async () => {
    const health = new HealthRegistry(silentLogger)
    const session = headedFake({ url: 'https://www.google.com/', storage: '{"cookies":[]}' })
    const adapter = fakeAdapter('google', () => ({}))
    const coordinator = new LoginCoordinator(
      { openHeaded: async () => session, releaseHeaded: async () => {} },
      health,
      testStore(),
      layout,
      new Map<EngineId, EngineAdapter>([['google', adapter]]),
      silentLogger,
    )
    coordinator.start('google', 'auto')
    // The clearance poll runs on a 2s cadence; wait for the episode to finish.
    for (let index = 0; index < 40 && health.snapshot().find(entry => entry.engine === 'google')?.state === 'signing-in'; index++) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    expect(health.shouldTry('google')).toBe(true)
    expect(readFileSync(storageStatePath(layout, 'google'), 'utf8')).toBe('{"cookies":[]}')
  })
})
