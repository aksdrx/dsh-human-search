/**
 * Managed-browser resolution unit tests over `resolveManagedExecutable`.
 * @module dsh-human-search/tests/browser
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveManagedExecutable } from '../src/browser.ts'

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
  it('finds the headless shell for headless and full chrome for headed', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') return
    const shell = fakeBrowser('chromium_headless_shell-1243', 'chrome-headless-shell-linux64/chrome-headless-shell')
    const chrome = fakeBrowser('chromium-1243', 'chrome-linux64/chrome')
    expect(resolveManagedExecutable(root, true)).toBe(shell)
    expect(resolveManagedExecutable(root, false)).toBe(chrome)
  })

  it('prefers the highest revision', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') return
    const newest = fakeBrowser('chromium_headless_shell-1300', 'chrome-headless-shell-linux64/chrome-headless-shell')
    fakeBrowser('chromium_headless_shell-999', 'chrome-headless-shell-linux64/chrome-headless-shell')
    expect(resolveManagedExecutable(root, true)).toBe(newest)
  })

  it('returns undefined for a missing or empty browsers root', () => {
    expect(resolveManagedExecutable(join(root, 'nothing'), true)).toBeUndefined()
  })
})
