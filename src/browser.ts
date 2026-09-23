/**
 * The browser pool: one persistent, plugin-private Chromium context per
 * engine, driven headless for searches and reopened headed for interactive
 * sign-in. A Chromium user-data-dir admits exactly one live browser, so each
 * engine slot is a small state machine (`closed → headless ⇄ headed`) guarded
 * by a promise-chain mutex; a headed sign-in session exclusively owns the
 * profile and headless attempts on that engine fail fast so the chain fails
 * over instead of queueing behind the user.
 * @module dsh-human-search/browser
 */

import { existsSync } from 'node:fs'
import { chromium, type BrowserContext, type Page } from 'playwright'
import type { Logger } from './dsh.ts'
import type { EngineAdapter, EngineId } from './engines/types.ts'
import { jitter, sleep } from './human.ts'
import type { ConfigStore } from './settings.ts'
import { bindPlaywrightBrowsersPath, engineProfileDir, type StateLayout } from './state.ts'

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
  readonly options: { channel?: string, executablePath?: string, userAgent?: string }
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
   * Whether any usable browser exists: an explicitly configured executable, a
   * known system browser, or a plugin-managed Chromium install. Cheap local
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
    if (config.executablePath.length > 0 && existsSync(config.executablePath)) return true
    if (SYSTEM_BROWSER_PATHS.some(path => existsSync(path))) return true
    try {
      return existsSync(chromium.executablePath())
    } catch {
      return false
    }
  }

  /** Launch candidates in preference order. */
  private candidates(config: ReturnType<ConfigStore['get']>): LaunchCandidate[] {
    const list: LaunchCandidate[] = []
    if (config.executablePath.length > 0) {
      list.push({ label: `configured (${config.executablePath})`, options: { executablePath: config.executablePath } })
    }
    list.push({ label: 'system Google Chrome', options: { channel: 'chrome' } })
    list.push({ label: 'system Microsoft Edge', options: { channel: 'msedge' } })
    list.push({ label: 'plugin-managed Chromium', options: {} })
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

  /**
   * Launch (or reuse) the engine's persistent headless context. Managed
   * Chromium in headless mode reports a `HeadlessChrome` user agent, an
   * instant bot signal, so one probe relaunches with the headful-equivalent
   * agent string when needed.
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
    const adapter = this.adapters.get(engine)
    const locale = config.locale.length > 0 ? config.locale : (adapter?.defaultLocale ?? 'en-US')
    const userDataDir = engineProfileDir(this.layout, engine)
    const viewport = { width: jitter(1_280, 320), height: jitter(800, 240) }
    let lastError: unknown
    for (const candidate of this.candidates(config)) {
      try {
        let context = await chromium.launchPersistentContext(userDataDir, {
          ...candidate.options,
          headless: headed ? false : config.headless,
          locale,
          viewport,
        })
        if (!headed && config.headless && candidate.options.channel === undefined && candidate.options.executablePath === undefined) {
          const fixed = await this.fixManagedHeadlessUa(context, userDataDir, candidate, locale, viewport)
          if (fixed !== undefined) context = fixed
        }
        return context
      } catch (error) {
        lastError = error
        this.logger.info('human-search: browser candidate "%s" unavailable for %s: %s', candidate.label, engine, String(error))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * Read the launched context's real user agent; when the managed Chromium
   * headless shell reports a `Headless` marker, relaunch once with the
   * headful-equivalent agent string (same version and platform tokens).
   */
  private async fixManagedHeadlessUa(
    context: BrowserContext,
    userDataDir: string,
    candidate: LaunchCandidate,
    locale: string,
    viewport: { width: number, height: number },
  ): Promise<BrowserContext | undefined> {
    try {
      const page = await context.newPage()
      const ua: string = await page.evaluate(() => navigator.userAgent)
      await page.close()
      if (!ua.includes('Headless')) return undefined
      await context.close()
      const headfulUa = ua.replace(/HeadlessChrome\//, 'Chrome/')
      return await chromium.launchPersistentContext(userDataDir, {
        ...candidate.options,
        headless: true,
        locale,
        viewport,
        userAgent: headfulUa,
      })
    } catch (error) {
      this.logger.warn('human-search: user-agent probe failed; keeping original context: %s', String(error))
      return undefined
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
      const result = await Promise.race([
        operation(page),
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

