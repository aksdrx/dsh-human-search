/**
 * Settings schema and normalization unit tests over `src/settings.ts`.
 * @module dsh-human-search/tests/settings
 */

import { describe, expect, it } from 'vitest'
import { Config as ConfigSchema } from '../src/settings.ts'
import { normalizeConfig, parseLoginCommand } from '../src/settings.ts'

describe('normalizeConfig', () => {
  it('fills every default from an empty section', () => {
    const config = normalizeConfig({})
    expect(config.headless).toBe(true)
    expect(config.locale).toBe('')
    expect(config.executablePath).toBe('')
    expect(config.perEngineTimeoutMs).toBe(15_000)
    expect(config.chainBudgetMs).toBe(50_000)
    expect(config.idleCloseMs).toBe(300_000)
    expect(config.engines.map(entry => entry.id)).toEqual(['google', 'duckduckgo', 'bing', 'baidu', 'sogou'])
    expect(config.engines.every(entry => entry.enabled)).toBe(true)
  })

  it('keeps the user order, drops duplicates and unknown ids, appends missing', () => {
    const config = normalizeConfig({
      engines: [
        { id: 'baidu', enabled: false },
        { id: 'baidu', enabled: true },
        { id: 'not-an-engine', enabled: true },
        { id: 'bing', enabled: true },
      ],
    })
    expect(config.engines).toEqual([
      { id: 'baidu', enabled: false },
      { id: 'bing', enabled: true },
      { id: 'google', enabled: true },
      { id: 'duckduckgo', enabled: true },
      { id: 'sogou', enabled: true },
    ])
  })

  it('bounds numeric fields even when the stored section lies', () => {
    const config = normalizeConfig({ perEngineTimeoutMs: 999_999, chainBudgetMs: Number.NaN } as Record<string, unknown>)
    expect(config.perEngineTimeoutMs).toBe(60_000)
    expect(config.chainBudgetMs).toBe(50_000)
  })
})

describe('parseLoginCommand', () => {
  it('parses engine and nonce', () => {
    expect(parseLoginCommand('google:1730000000123')).toEqual({ engine: 'google', nonce: 1_730_000_000_123 })
  })
  it('rejects malformed values', () => {
    expect(parseLoginCommand('')).toBeUndefined()
    expect(parseLoginCommand('google:')).toBeUndefined()
    expect(parseLoginCommand('nope:123')).toBeUndefined()
    expect(parseLoginCommand('google:abc')).toBeUndefined()
  })
})

describe('Config schema', () => {
  it('resolves the documented defaults through schemastery', () => {
    const resolved = ConfigSchema({} as Parameters<typeof ConfigSchema>[0]) as ReturnType<typeof normalizeConfig>
    expect(resolved.headless).toBe(true)
    expect(resolved.loginCommand).toBe('')
    expect(Array.isArray(resolved.engines)).toBe(true)
    expect(resolved.perEngineTimeoutMs).toBe(15_000)
  })
  it('serializes to a JSON envelope (settings wire requirement)', () => {
    const json = ConfigSchema.toJSON() as { uid: number, refs: Record<string, { type: string }> }
    expect(typeof json.uid).toBe('number')
    expect(json.refs).toBeTypeOf('object')
    expect(Object.values(json.refs).some(node => node.type === 'object')).toBe(true)
  })
})
