/**
 * Plugin configuration: the schemastery schema that serves three roles —
 * loader-validated row config, the `web-human-search` settings namespace the
 * web GUI edits, and the resolved shape the provider projects per search.
 * @module dsh-human-search/settings
 */

import z from '@deepseek-ai/schemastery'
import { ENGINE_IDS, isEngineId, type EngineId } from './engines/types.ts'
import { ENGINE_ORDER_DEFAULT } from './dsh.ts'

/** Settings namespace; also the `settings.plugin.item` card key. */
export const SETTINGS_NAMESPACE = 'web-human-search'

/** One ordered engine preference. Order in the array is the try order. */
export interface EngineEntry {
  readonly id: EngineId
  readonly enabled: boolean
}

/** Resolved plugin configuration. */
export interface Config {
  /** Ordered engine chain; the array order is the fallback order. */
  engines: EngineEntry[]
  /** Run search browsers headless; `false` watches every search live. */
  readonly headless: boolean
  /** Locale override for every engine; empty string uses per-engine defaults. */
  readonly locale: string
  /** Explicit browser executable; empty string uses channel/managed discovery. */
  readonly executablePath: string
  /** Per-engine search budget in ms. */
  readonly perEngineTimeoutMs: number
  /** Whole-chain budget in ms; must fit the stock web_search tool timeout. */
  readonly chainBudgetMs: number
  /** Close idle engine browsers after this many ms; 0 keeps them alive. */
  readonly idleCloseMs: number
  /**
   * Card → host command channel: `<engineId>:<nonce>`. The card writes it to
   * request a sign-in window; the host consumes the nonce and clears it.
   */
  readonly loginCommand: string
}

/** Defaults shown in a fresh settings page before any user override. */
export const DEFAULT_CONFIG: Config = {
  engines: ENGINE_ORDER_DEFAULT.map(id => ({ id, enabled: true })),
  headless: true,
  locale: '',
  executablePath: '',
  perEngineTimeoutMs: 15_000,
  chainBudgetMs: 50_000,
  idleCloseMs: 300_000,
  loginCommand: '',
}

/** The schemastery schema: row config validator and settings namespace schema. */
export const Config: z<Config> = z.object({
  engines: z.array(z.object({
    id: z.union([...ENGINE_IDS] as [EngineId, ...EngineId[]]),
    enabled: z.boolean().default(true),
  })).default(DEFAULT_CONFIG.engines),
  headless: z.boolean().default(true),
  locale: z.string().default(''),
  executablePath: z.string().default(''),
  perEngineTimeoutMs: z.number().step(1).min(1_000).max(60_000).default(15_000),
  chainBudgetMs: z.number().step(1).min(10_000).max(120_000).default(50_000),
  idleCloseMs: z.number().step(1).min(0).max(86_400_000).default(300_000),
  loginCommand: z.string().default(''),
})

/**
 * Normalize any resolved section into a safe configuration: keep known
 * engines in their given order, drop duplicates, append missing engines
 * (enabled) in default order so the chain never silently loses an engine.
 */
export function normalizeConfig(raw: unknown): Config {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Config>
  const seen = new Set<EngineId>()
  const engines: EngineEntry[] = []
  for (const entry of value.engines ?? []) {
    if (entry === undefined || !isEngineId(entry.id) || seen.has(entry.id)) continue
    seen.add(entry.id)
    engines.push({ id: entry.id, enabled: entry.enabled !== false })
  }
  for (const id of ENGINE_ORDER_DEFAULT) {
    if (seen.has(id)) continue
    engines.push({ id, enabled: true })
  }
  const num = (given: unknown, fallback: number): number =>
    typeof given === 'number' && Number.isFinite(given) && given > 0 ? given : fallback
  return {
    engines,
    headless: value.headless !== false,
    locale: typeof value.locale === 'string' ? value.locale : '',
    executablePath: typeof value.executablePath === 'string' ? value.executablePath : '',
    perEngineTimeoutMs: Math.min(num(value.perEngineTimeoutMs, DEFAULT_CONFIG.perEngineTimeoutMs), 60_000),
    chainBudgetMs: Math.min(num(value.chainBudgetMs, DEFAULT_CONFIG.chainBudgetMs), 120_000),
    idleCloseMs: num(value.idleCloseMs, DEFAULT_CONFIG.idleCloseMs),
    loginCommand: typeof value.loginCommand === 'string' ? value.loginCommand : '',
  }
}

/**
 * The authoritative-configuration holder. `installSection` swaps the source
 * thunk when the settings service attaches; without it, the composition entry
 * stays authoritative for the plugin's lifetime.
 */
export class ConfigStore {
  private source: () => unknown

  constructor(base: unknown) {
    this.source = () => base
  }

  /** Replace the authoritative source (settings scope or composition entry). */
  replace(source: () => unknown): void {
    this.source = source
  }

  /** The currently authoritative, normalized configuration. */
  get(): Config {
    return normalizeConfig(this.source())
  }
}

/** A parsed login command. */
export interface LoginCommand {
  readonly engine: EngineId
  readonly nonce: number
}

/**
 * Parse a `loginCommand` value; `undefined` when absent or malformed.
 * Format: `<engineId>:<nonce>`.
 */
export function parseLoginCommand(value: string): LoginCommand | undefined {
  const match = /^([a-z]+):(\d+)$/.exec(value.trim())
  if (match === null || !isEngineId(match[1])) return undefined
  const nonce = Number(match[2])
  return { engine: match[1], nonce }
}
