/**
 * Family-keyed profile directory unit tests over `engineProfileDir`.
 * @module dsh-human-search/tests/state
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { engineProfileDir, type StateLayout } from '../src/state.ts'

const layout: StateLayout = {
  root: '/state',
  browsersRoot: '/state/browsers',
  profilesRoot: '/state/profiles',
  stateRoot: '/state/session',
} as StateLayout

describe('engineProfileDir', () => {
  it('keeps the historical chromium path for the default family', () => {
    expect(engineProfileDir(layout, 'bing')).toBe(join('/state/profiles', 'bing'))
    expect(engineProfileDir(layout, 'bing', 'chromium')).toBe(join('/state/profiles', 'bing'))
  })

  it('suffixes non-chromium families so profiles never share directories', () => {
    expect(engineProfileDir(layout, 'bing', 'firefox')).toBe(join('/state/profiles', 'bing-firefox'))
    expect(engineProfileDir(layout, 'google', 'webkit')).toBe(join('/state/profiles', 'google-webkit'))
  })
})
