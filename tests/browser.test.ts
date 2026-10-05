/**
 * Managed-browser resolution unit tests over `resolveManagedExecutable` and
 * launch-failure condensing over `describeLaunchFailure`.
 * @module dsh-human-search/tests/browser
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { describeLaunchFailure, resolveManagedExecutable } from '../src/browser.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-human-search-browsers-'))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

/** Materialize one fake managed browser layout. */
function fakeBrowser(dir: string, binary: string): string {
  const path = join(root, dir, ...binary.split('/'))
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\n')
  return path
}

describe('resolveManagedExecutable', () => {
  it('finds the headless shell and full chrome by kind', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') return
    const shell = fakeBrowser('chromium_headless_shell-1243', 'chrome-headless-shell-linux64/chrome-headless-shell')
    const chrome = fakeBrowser('chromium-1243', 'chrome-linux64/chrome')
    expect(resolveManagedExecutable(root, 'chromium-shell')).toBe(shell)
    expect(resolveManagedExecutable(root, 'chromium-full')).toBe(chrome)
  })

  it('prefers the highest revision', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') return
    const newest = fakeBrowser('chromium_headless_shell-1300', 'chrome-headless-shell-linux64/chrome-headless-shell')
    fakeBrowser('chromium_headless_shell-999', 'chrome-headless-shell-linux64/chrome-headless-shell')
    expect(resolveManagedExecutable(root, 'chromium-shell')).toBe(newest)
  })

  it('finds the managed Firefox layout', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') return
    const firefox = fakeBrowser('firefox-1543', 'firefox/firefox')
    expect(resolveManagedExecutable(root, 'firefox')).toBe(firefox)
  })

  it('finds the managed WebKit layout', () => {
    if (process.platform === 'win32') return
    const webkit = fakeBrowser('webkit-2359', 'pw_run.sh')
    expect(resolveManagedExecutable(root, 'webkit')).toBe(webkit)
  })

  it('never confuses kinds sharing a revision', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') return
    // A firefox-<rev> directory must not satisfy a chromium-full probe even
    // though both use bare numeric suffixes.
    fakeBrowser('firefox-9999', 'firefox/firefox')
    expect(resolveManagedExecutable(root, 'chromium-full')).not.toContain('firefox')
  })

  it('returns undefined for a missing or empty browsers root', () => {
    expect(resolveManagedExecutable(join(root, 'nothing'), 'chromium-full')).toBeUndefined()
    expect(resolveManagedExecutable(join(root, 'nothing'), 'firefox')).toBeUndefined()
    expect(resolveManagedExecutable(join(root, 'nothing'), 'webkit')).toBeUndefined()
  })
})

describe('describeLaunchFailure', () => {
  it('keeps the real cause lines and drops the playwright install banner', () => {
    const boxed = [
      'browserType.launchPersistentContext: Failed to launch the browser process.',
      '╔════════════════════════════════════════════════════════════╗',
      '║ Looks like Playwright was just installed or updated.       ║',
      '║     pnpm exec playwright install                           ║',
      '╚════════════════════════════════════════════════════════════╝',
      '[pid=17][err] Could not find profile folder.',
    ].join('\n')
    const described = describeLaunchFailure(new Error(boxed))
    expect(described).toContain('Could not find profile folder')
    expect(described).not.toContain('Playwright was just installed')
    expect(described).not.toContain('pnpm exec')
    expect(described).not.toContain('Browser logs')
    expect(described).not.toMatch(/[║╔╚═]/u)
  })

  it('falls back to the first lines for registry-style missing-executable errors', () => {
    const boxed = [
      'browserType.launchPersistentContext: Executable doesn\'t exist at /home/x/.dsh/web-human-search/browsers/firefox-1543/firefox/firefox',
      '╔════════════════════════════════════════════════════════════╗',
      '║ Looks like Playwright was just installed or updated.       ║',
      '╚════════════════════════════════════════════════════════════╝',
    ].join('\n')
    const described = describeLaunchFailure(new Error(boxed))
    expect(described).toContain("Executable doesn't exist")
    expect(described).not.toContain('Playwright was just installed')
    expect(described).not.toMatch(/[║╔╚═]/u)
  })

  it('caps the summary at three lines so one candidate cannot flood the chain report', () => {
    const many = ['first', 'second', 'third', 'fourth line must not appear'].join('\n')
    const described = describeLaunchFailure(new Error(many))
    expect(described).toBe('first | second | third')
    expect(described).not.toContain('fourth')
  })

  it('still returns something for a messageless throw', () => {
    expect(describeLaunchFailure('plain failure').length).toBeGreaterThan(0)
  })
})
