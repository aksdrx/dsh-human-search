/**
 * Bundle-shape regression guard for the browser half.
 *
 * The dsh web shell loads plugin browser halves as classic <script> tags and
 * requires a `window.__ModuleLoader__.load({ id, factory })` registration; a
 * plain ESM artifact is a SyntaxError that kills the whole shared combo
 * script and takes every co-installed plugin down with it — the 0.1.0
 * release shipped exactly that and broke the web GUI on install. These
 * checks keep that failure class from returning.
 * @module dsh-human-search/tests/bundle
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bundlePath = new URL('../lib/client.js', import.meta.url)
const manifestPath = new URL('../package.json', import.meta.url)

describe('lib/client.js boot-registration shape', () => {
  const source = readFileSync(bundlePath, 'utf8')
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string }

  it('registers through __ModuleLoader__.load with the package-name id', () => {
    expect(source.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(source).toContain(`id: ${JSON.stringify(pkg.name)}`)
    expect(source).toContain('factory: (require)')
  })

  it('contains no classic-script-breaking ESM syntax', () => {
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/^\s*export\s/m)
    expect(source).not.toContain('import(')
  })

  it('resolves react through the factory-injected require', () => {
    expect(source).toContain('require("react")')
  })

  it('exports the plugin entry face (inject + apply)', () => {
    expect(source).toContain('exports.apply')
    expect(source).toContain('exports.inject')
  })
})
