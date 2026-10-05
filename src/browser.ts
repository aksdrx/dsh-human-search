/**
 * The browser pool: one persistent, plugin-private browser context per
 * engine, driven headless for searches and reopened headed for interactive
 * sign-in. Each engine picks a browser family (Chromium by default; Firefox
 * and WebKit as Playwright-patched escape hatches for sites that block
 * Chrome-family fingerprints). A persistent profile admits exactly one live
 * browser, so each engine slot is a small state machine
 * (`closed → headless ⇄ headed`) guarded by a promise-chain mutex; a headed
 * sign-in session exclusively owns the profile and headless attempts on that
 * engine fail fast so the chain fails over instead of queueing behind the
 * user.
 * @module dsh-human-search/browser
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, firefox, webkit, type BrowserContext, type BrowserType, type Page } from 'playwright'
import type { Logger } from './dsh.ts'
import type { EngineAdapter, EngineId } from './engines/types.ts'
import { jitter, sleep } from './human.ts'
import type { BrowserFamily, ConfigStore } from './settings.ts'
import { bindPlaywrightBrowsersPath, engineProfileDir, type StateLayout } from './state.ts'

/** The playwright browser driver for one family. */
function browserTypeFor(family: BrowserFamily): BrowserType {
  return family === 'firefox' ? firefox : family === 'webkit' ? webkit : chromium
}

/**
 * One candidate's launch failure, condensed: playwright errors arrive with
 * multi-line boxed banners ("Looks like Playwright was just installed…")
 * while the actual cause — "Could not find profile folder", a missing
 * library, a dead executable — hides among the following lines. Keep the
 * first few meaningful lines and drop the box-drawing noise so a failed
 * chain attempt can show every candidate's real reason.
 */
export function describeLaunchFailure(error: unknown): string {
  const text = String(error).replace(/^Error:\s*/, '')
  const lines = text.split('\n')
    .map(line => line.replace(/^[║╔╚╝╠╣╗═\s]+|[║╔╚╝╠╣╗═\s]+$/g, '').trim())
    .filter(line => line.length > 0 && !line.startsWith('Call log:'))
    .filter(line => !line.includes('Playwright was just installed') && !line.includes('<3 Playwright Team') && !line.includes('playwright install'))
  // Playwright prefixes the browser's own stderr with "[pid=N][err]" —
  // those lines are the actual cause ("Could not find profile folder",
  // missing-library tracebacks) and beat the launch-log preamble. The
  // trailing "Call log" section repeats them as "- [pid=N][err] …" bullets.
  const stderrLines = lines.filter(line => line.includes('][err]') && !line.startsWith('- '))
  if (stderrLines.length > 0) return stderrLines.slice(0, 4).join(' | ').slice(0, 400)
  return lines.slice(0, 3).join(' | ').slice(0, 400) || text.slice(0, 200)
}

/** Raised when an engine's profile is held by an interactive sign-in session. */
export class EngineBusyError extends Error {
  readonly engine: EngineId

  constructor(engine: EngineId) {
    super(`engine "${engine}" is busy with an interactive sign-in window`)
    this.name = 'EngineBusyError'
    this.engine = engine
  }
}

/** One launch recipe; the first that works wins. */
interface LaunchCandidate {
  readonly label: string
  readonly options: { channel?: string, executablePath?: string }
}

/** Where common system browsers live, by platform. */
const SYSTEM_BROWSER_PATHS: readonly string[] = process.platform === 'darwin'
  ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  : process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
        '/snap/bin/chromium',
        '/opt/google/chrome/chrome',
      ]

/** Plugin-managed browser kinds, one per registry install directory. */
export type ManagedKind = 'chromium-full' | 'chromium-shell' | 'firefox' | 'webkit'

/**
 * Registry directory layouts for plugin-managed browsers: the install
 * directory prefix and the executable path(s) inside it, per platform
 * (mirrors playwright-core's registry table for revision-current builds).
 */
const MANAGED_LAYOUTS: Record<ManagedKind, { dir: string, inner: readonly string[] }> = {
  'chromium-full': {
    dir: 'chromium-',
    inner: process.platform === 'win32'
      ? ['chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe']
      : process.platform === 'darwin'
        ? [
            'chrome-mac64/Chromium.app/Contents/MacOS/Chromium',
            'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
            'chrome-mac64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          ]
        : ['chrome-linux64/chrome', 'chrome-linux/chrome'],
  },
  'chromium-shell': {
    dir: 'chromium_headless_shell-',
    inner: process.platform === 'win32'
      ? ['chrome-headless-shell-win64\\chrome-headless-shell.exe']
      : process.platform === 'darwin'
        ? ['chrome-mac/headless_shell']
        : ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-linux/chrome-headless-shell'],
  },
  firefox: {
    dir: 'firefox-',
    inner: process.platform === 'win32'
      ? ['firefox/firefox.exe']
      : process.platform === 'darwin'
        ? ['firefox/Nightly.app/Contents/MacOS/firefox']
        : ['firefox/firefox'],
  },
  webkit: {
    dir: 'webkit-',
    inner: process.platform === 'win32' ? ['Playwright.exe'] : ['pw_run.sh'],
  },
}

/**
 * Resolve a plugin-managed browser under the browsers root. Playwright's
 * registry computes its directory at import time — before any plugin code can
 * set `PLAYWRIGHT_BROWSERS_PATH` — so managed browsers are located by
 * scanning the plugin's own directory layout and passed as explicit
 * `executablePath` values instead. Highest revision wins.
 */
export function resolveManagedExecutable(browsersRoot: string, kind: ManagedKind): string | undefined {
  const { dir: prefix, inner } = MANAGED_LAYOUTS[kind]
  let entries: string[] = []
  try {
    entries = readdirSync(browsersRoot).filter(entry => entry.startsWith(prefix) && /^\d+$/.test(entry.slice(prefix.length)))
  } catch {
    return undefined
  }
  // Highest revision first: the newest install wins.
  entries.sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
  for (const entry of entries) {
    for (const relative of inner) {
      const candidate = join(browsersRoot, entry, relative)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** Per-engine lifecycle state. */
interface EngineSlot {
  mode: 'closed' | 'headless' | 'headed'
  context: BrowserContext | undefined
  /** Serializes every transition and page operation for this engine. */
  chain: Promise<unknown>
  idleTimer: NodeJS.Timeout | undefined
}

/** A headed interactive session handle owned by the login coordinator. */
export interface HeadedSession {
  readonly engine: EngineId
  readonly page: Page
  /** Resolves when the user (or a timeout) closes the window. */
  readonly whenClosed: Promise<void>
  /** Close the headed window and release the profile. */
  close(): Promise<void>
}

/**
 * The pool. Constructed once per plugin; every browser it launches lives in a
 * plugin-private profile directory and is closed at plugin dispose.
 */
export class BrowserPool {
  private readonly slots = new Map<EngineId, EngineSlot>()
  /** Availability probe cache (`available()` must stay cheap and offline). */
  private availability: { value: boolean, at: number } | undefined
  /**
   * Learned headless user-agent fixes keyed by launch candidate (`null`:
   * probed clean). Keyed per executable because the rewrite depends on the
   * binary — the headless shell's agent carries a `HeadlessChrome` marker,
   * while a full Chrome in new-headless mode is already clean. Applies to
   * every candidate, including a user-configured executablePath.
   */
  private readonly uaFixes = new Map<string, string | null>()
  private disposed = false

  constructor(
    private readonly store: ConfigStore,
    private readonly layout: StateLayout,
    private readonly adapters: ReadonlyMap<EngineId, EngineAdapter>,
    private readonly logger: Logger,
  ) {
    bindPlaywrightBrowsersPath(this.layout)
  }

  /**
   * Whether every enabled engine's browser family can resolve a launch
   * candidate: an explicitly configured executable, a known system browser,
   * a plugin-managed install, or a playwright-registry default. Cheap local
   * checks only — no launches, no network.
   */
  hasUsableBrowser(): boolean {
    const now = Date.now()
    if (this.availability !== undefined && now - this.availability.at < 60_000) {
      return this.availability.value
    }
    const value = this.probeAvailability()
    this.availability = { value, at: now }
    return value
  }

  private probeAvailability(): boolean {
    const config = this.store.get()
    const families = new Set(config.engines.filter(entry => entry.enabled).map(entry => entry.browser))
    if (families.size === 0) families.add('chromium')
    return [...families].every(family => this.familyResolvable(config, family))
  }

  /** Whether one family has any launch candidate on this machine. */
  private familyResolvable(config: ReturnType<ConfigStore['get']>, family: BrowserFamily): boolean {
    if (family === 'chromium') {
      if (config.executablePath.length > 0 && existsSync(config.executablePath)) return true
      if (SYSTEM_BROWSER_PATHS.some(path => existsSync(path))) return true
      if (resolveManagedExecutable(this.layout.browsersRoot, 'chromium-full') !== undefined) return true
      if (resolveManagedExecutable(this.layout.browsersRoot, 'chromium-shell') !== undefined) return true
    } else {
      // Firefox and WebKit are playwright-patched builds only — no system
      // channels and no user executablePath apply to them.
      if (resolveManagedExecutable(this.layout.browsersRoot, family) !== undefined) return true
    }
    // Last resort: a playwright-registry install at the default location
    // (installed by other tooling) still works as a launch candidate.
    try {
      return existsSync(browserTypeFor(family).executablePath())
    } catch {
      return false
    }
  }

  /** The configured browser family for one engine (default: chromium). */
  private familyOf(engine: EngineId): BrowserFamily {
    return this.store.get().engines.find(entry => entry.id === engine)?.browser ?? 'chromium'
  }

  /**
   * Launch candidates in preference order. Chromium prefers a configured
   * executable, then system browsers, then the plugin-managed full Chromium
   * (its new-headless fingerprint is far less bot-flagged than the headless
   * shell's — Google serves the shell a /sorry wall even signed in), then the
   * lighter headless shell. Firefox and WebKit resolve from the managed
   * install or the playwright registry only; a headed sign-in window needs a
   * full binary, so the headless shell never appears when `headed`.
   */
  private candidates(config: ReturnType<ConfigStore['get']>, family: BrowserFamily, headed: boolean): LaunchCandidate[] {
    const list: LaunchCandidate[] = []
    if (family === 'chromium') {
      if (config.executablePath.length > 0) {
        list.push({ label: `configured (${config.executablePath})`, options: { executablePath: config.executablePath } })
      }
      list.push({ label: 'system Google Chrome', options: { channel: 'chrome' } })
      list.push({ label: 'system Microsoft Edge', options: { channel: 'msedge' } })
      const managedFull = resolveManagedExecutable(this.layout.browsersRoot, 'chromium-full')
      const managedShell = resolveManagedExecutable(this.layout.browsersRoot, 'chromium-shell')
      if (headed) {
        if (managedFull !== undefined) {
          list.push({ label: 'plugin-managed Chromium', options: { executablePath: managedFull } })
        }
      } else {
        if (managedFull !== undefined) {
          list.push({ label: 'plugin-managed Chromium (new headless)', options: { executablePath: managedFull } })
        }
        if (managedShell !== undefined) {
          list.push({ label: 'plugin-managed headless shell', options: { executablePath: managedShell } })
        }
      }
      list.push({ label: 'default playwright registry Chromium', options: {} })
      return list
    }
    const label = family === 'firefox' ? 'Firefox' : 'WebKit'
    const managed = resolveManagedExecutable(this.layout.browsersRoot, family)
    if (managed !== undefined) {
      list.push({ label: `plugin-managed ${label}`, options: { executablePath: managed } })
    }
    list.push({ label: `default playwright registry ${label}`, options: {} })
    return list
  }

  /** Serialize one engine transition or operation on its mutex chain. */
  private enqueue<T>(engine: EngineId, operation: () => Promise<T>): Promise<T> {
    const slot = this.slot(engine)
    const run = slot.chain.then(operation, operation)
    slot.chain = run.catch(() => {})
    return run
  }

  private slot(engine: EngineId): EngineSlot {
    let slot = this.slots.get(engine)
    if (slot === undefined) {
      slot = { mode: 'closed', context: undefined, chain: Promise.resolve(), idleTimer: undefined }
      this.slots.set(engine, slot)
    }
    return slot
  }

  /** Identity of a launch candidate for the per-executable UA-fix map. */
  private candidateKey(candidate: LaunchCandidate): string {
    return candidate.options.executablePath ?? `channel:${candidate.options.channel ?? 'registry'}`
  }

  /**
   * Launch (or reuse) the engine's persistent headless context in the
   * engine's configured family. Any headless Chromium binary can report a
   * `HeadlessChrome` user agent — the plugin-managed headless shell, or one
   * configured explicitly — an instant bot signal, so the first launch of
   * each chromium-family candidate probes its real agent and relaunches with
   * the headful-equivalent string when needed. Firefox and WebKit agent
   * strings carry no headless marker, so no probe applies.
   */
  private launchHeadless(engine: EngineId): Promise<BrowserContext> {
    return this.enqueue(engine, async () => {
      const slot = this.slot(engine)
      if (slot.mode === 'headed') throw new EngineBusyError(engine)
      if (slot.context !== undefined) return slot.context
      const context = await this.launchPersistent(engine, false)
      slot.mode = 'headless'
      slot.context = context
      return context
    })
  }

  private async launchPersistent(engine: EngineId, headed: boolean): Promise<BrowserContext> {
    const config = this.store.get()
    const family = this.familyOf(engine)
    const browserType = browserTypeFor(family)
    const adapter = this.adapters.get(engine)
    const locale = config.locale.length > 0 ? config.locale : (adapter?.defaultLocale ?? 'en-US')
    const userDataDir = engineProfileDir(this.layout, engine, family)
    const viewport = { width: jitter(1_280, 320), height: jitter(800, 240) }
    const fixHeadlessUa = !headed && config.headless && family === 'chromium'
    let lastError: unknown
    const failures: string[] = []
    for (const candidate of this.candidates(config, family, headed)) {
      try {
        let context = await browserType.launchPersistentContext(userDataDir, {
          ...candidate.options,
          headless: headed ? false : config.headless,
          locale,
          viewport,
        })
        if (fixHeadlessUa) {
          const key = this.candidateKey(candidate)
          if (!this.uaFixes.has(key)) {
            this.uaFixes.set(key, await this.probeHeadlessUa(context))
          }
          const fix = this.uaFixes.get(key) ?? undefined
          if (fix !== undefined) {
            await context.close().catch(() => {})
            context = await browserType.launchPersistentContext(userDataDir, {
              ...candidate.options,
              userAgent: fix,
              headless: true,
              locale,
              viewport,
            })
          }
        }
        return context
      } catch (error) {
        lastError = error
        const executable = candidate.options.executablePath ?? (candidate.options.channel !== undefined ? `channel ${candidate.options.channel}` : 'playwright registry')
        failures.push(`${candidate.label} [${executable}]: ${describeLaunchFailure(error)}`)
        this.logger.info('human-search: browser candidate "%s" unavailable for %s: %s', candidate.label, engine, String(error))
      }
    }
    if (failures.length > 0) {
      // Every candidate's reason, not just the last one's — a missing
      // registry executable must not mask the managed binary's real failure.
      throw new Error(`no usable ${family} browser for engine "${engine}" — ${failures.join('; ')}`)
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'no launch candidates resolved'))
  }

  /**
   * Read a freshly launched headless context's real user agent and, when it
   * carries a `Headless` marker, return the headful-equivalent agent string
   * (same version and platform tokens) for every later launch of the same
   * executable. `null` means no rewrite is needed.
   */
  private async probeHeadlessUa(context: BrowserContext): Promise<string | null> {
    try {
      const page = await context.newPage()
      const ua: string = await page.evaluate(() => navigator.userAgent)
      await page.close()
      if (!ua.includes('Headless')) return null
      return ua.replace(/HeadlessChrome\//, 'Chrome/')
    } catch (error) {
      this.logger.warn('human-search: user-agent probe failed; keeping the original context: %s', String(error))
      return null
    }
  }

  /**
   * Run one operation on a fresh page of the engine's headless context.
   * `timeoutMs` bounds the whole operation: on expiry the page closes (which
   * cancels any in-flight protocol call) and the caller sees a timeout error.
   */
  async withHeadlessPage<T>(
    engine: EngineId,
    timeoutMs: number,
    operation: (page: Page) => Promise<T>,
  ): Promise<T> {
    if (this.disposed) throw new Error('browser pool is disposed')
    if (this.slot(engine).mode === 'headed') throw new EngineBusyError(engine)
    const context = await this.launchHeadless(engine)
    let page: Page | undefined
    try {
      page = await context.newPage()
      const operationPromise = operation(page)
      // The losing side of the race must not surface later as an unhandled
      // rejection when the timeout closes the page under a running call.
      operationPromise.catch(() => {})
      const result = await Promise.race([
        operationPromise,
        sleep(timeoutMs).then(() => { throw new Error(`engine attempt timed out after ${String(timeoutMs)}ms`) }),
      ])
      return result
    } finally {
      this.touchIdle(engine)
      if (page !== undefined) await page.close().catch(() => {})
    }
  }

  /**
   * Open the engine's profile in a headed window, exclusively. Any headless
   * context is closed first (they share the user-data-dir); while the session
   * lives, headless attempts on this engine fail fast.
   */
  async openHeaded(engine: EngineId): Promise<HeadedSession> {
    if (this.disposed) throw new Error('browser pool is disposed')
    return await this.enqueue(engine, async () => {
      const slot = this.slot(engine)
      if (slot.mode === 'headed' && slot.context !== undefined) {
        throw new Error(`engine "${engine}" already has an open sign-in window`)
      }
      if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer)
      if (slot.context !== undefined) {
        await slot.context.close().catch(() => {})
        slot.context = undefined
      }
      slot.mode = 'closed'
      const context = await this.launchPersistent(engine, true)
      slot.mode = 'headed'
      slot.context = context
      const page = await context.newPage()
      let onClose!: () => void
      const whenClosed = new Promise<void>(resolve => {
        onClose = resolve
      })
      context.once('close', () => { onClose() })
      const session: HeadedSession = {
        engine,
        page,
        whenClosed,
        close: async () => { await context.close().catch(() => {}) },
      }
      return session
    })
  }

  /** Release a headed session back to the pool (profile becomes headless-able). */
  async releaseHeaded(engine: EngineId, session: HeadedSession): Promise<void> {
    await session.close()
    await this.enqueue(engine, async () => {
      const slot = this.slot(engine)
      if (slot.mode === 'headed') {
        slot.mode = 'closed'
        slot.context = undefined
      }
    })
  }

  /** Reset (or clear) the idle-close timer after headless activity. */
  private touchIdle(engine: EngineId): void {
    const slot = this.slot(engine)
    if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer)
    const idleCloseMs = this.store.get().idleCloseMs
    if (idleCloseMs <= 0 || slot.mode !== 'headless') return
    slot.idleTimer = setTimeout(() => {
      void this.closeEngine(engine).catch(() => {})
    }, idleCloseMs)
  }

  /** Close one engine's context (headless housekeeping or headed release). */
  async closeEngine(engine: EngineId): Promise<void> {
    await this.enqueue(engine, async () => {
      const slot = this.slot(engine)
      if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer)
      if (slot.context !== undefined) {
        await slot.context.close().catch(() => {})
        slot.context = undefined
      }
      slot.mode = 'closed'
    })
  }

  /** Close every engine context; used at plugin dispose. */
  async closeAll(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.slots.keys()].map(engine => this.closeEngine(engine)))
  }

  /** React to committed configuration: invalidate the availability cache. */
  onConfigChange(): void {
    this.availability = undefined
  }
}

