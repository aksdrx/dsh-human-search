/**
 * Structural types for the DeepSeek Harness seams this plugin consumes.
 *
 * The plugin reaches every seam through the Cordis context at runtime and
 * imports nothing from the host packages, so these narrow structural types
 * describe exactly the API surface used — verified against the DSH sources
 * (`@deepseek-ai/dsh-web`, `@deepseek-ai/dsh-settings`, cordis). If the host
 * surface drifts, the live validation in the README catches it loudly at
 * runtime instead of at compile time; that trade keeps this package
 * dependency-free and installable into any DSH instance.
 * @module dsh-human-search/dsh
 */

import type { EngineId } from './engines/types.ts'

/** One citeable source, mirroring `WebSearchSource` from `@deepseek-ai/dsh-web`. */
export interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** Search outcome, mirroring `WebSearchResult`. */
export interface WebSearchResult {
  readonly content?: string
  readonly sources: readonly WebSearchSource[]
  readonly truncated: boolean
}

/** Search request, mirroring `WebSearchRequest`. */
export interface WebSearchRequest {
  readonly query: string
  readonly maxResults?: number
}

/**
 * A search-capable backend, mirroring `WebSearchProvider`. Registered with
 * `ctx.web.registerSearchProvider`; `id` is unique within the search kind.
 */
export interface WebSearchProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Run one search; honor `signal` for cancellation. */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/** The web seam (`ctx.web`), narrowed to the registration call used here. */
export interface WebRuntime {
  registerSearchProvider(provider: WebSearchProvider): () => void
}

/** The optional-settings consumer face of `ctx.settings.installSection`. */
export interface SettingsSectionHooks<T> {
  /** Receive the authoritative configuration thunk (scope while attached, entry otherwise). */
  setSource(current: () => T): void
  /** Re-judge derived state after an attach, detach, or committed change. */
  onChange(): void
  /** Reject a resolved section the consumer could not act on. */
  validate?(value: T): void
}

/** The user-settings seam (`ctx.settings`), narrowed to `installSection`. */
export interface SettingsService {
  installSection<T>(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ): void
  /** Merge a patch into one registered namespace's user layer (command clearing). */
  update(ns: string, patch: object): Promise<void>
}

/** Minimal logger face provided by the Cordis context. */
export interface Logger {
  info(format: unknown, ...args: unknown[]): void
  warn(format: unknown, ...args: unknown[]): void
  error(format: unknown, ...args: unknown[]): void
}

/**
 * The Cordis plugin context as this plugin uses it: optional service lookup,
 * fiber-scoped effects, dynamic injection, and the two seams above.
 */
export interface Context {
  get(name: 'web'): WebRuntime | undefined
  get(name: 'settings'): SettingsService | undefined
  get(name: string): unknown
  /** Register a disposal owned by this plugin's fiber. */
  effect(dispose: () => void | Promise<void> | (() => void), label?: string): () => void
  /** Dynamically inject an optional service subtree. */
  inject(names: readonly string[], callback: (ctx: Context) => void): void
  readonly logger: Logger
}

/** A machine-routable failure thrown by the provider when every engine failed. */
export class HumanSearchError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'HumanSearchError'
    this.code = code
  }
}

/** The engine ids this plugin ships, in the default order. */
export const ENGINE_ORDER_DEFAULT: readonly EngineId[] = [
  'google', 'duckduckgo', 'bing', 'baidu', 'sogou',
]
