/**
 * The login coordinator: runs one interactive sign-in episode per engine.
 * An episode opens the engine's plugin-private profile in a HEADED window on
 * the machine running DSH, navigates to the engine's login page (or its home
 * page when it has no accounts), and waits — polling, never blocking any
 * search — until the block clears (CAPTCHA solved and/or account signed in).
 * On success the context's cookies are exported to the plugin state directory
 * and the profile itself already carries them for future headless runs.
 * @module dsh-human-search/login
 */

import type { HeadedSession } from './browser.ts'
import type { Logger } from './dsh.ts'
import type { EngineAdapter, EngineId } from './engines/types.ts'
import type { ConfigStore } from './settings.ts'
import { sleep } from './human.ts'
import type { HealthRegistry } from './health.ts'
import { storageStatePath, type StateLayout } from './state.ts'

/** How long a headed episode waits for the user before giving up. */
const EPISODE_TIMEOUT_MS = 10 * 60_000

/** Poll cadence while watching the headed page. */
const POLL_INTERVAL_MS = 2_000

/** After this long parked on the login host, gently steer to the engine. */
const NUDGE_AFTER_MS = 60_000

/**
 * The pool surface the login coordinator needs: exclusive headed access to
 * an engine's profile.
 */
export interface LoginPoolPort {
  openHeaded(engine: EngineId): Promise<HeadedSession>
  releaseHeaded(engine: EngineId, session: HeadedSession): Promise<void>
}

export class LoginCoordinator {
  private readonly episodes = new Map<EngineId, Promise<void>>()
  private disposed = false

  constructor(
    private readonly pool: LoginPoolPort,
    private readonly health: HealthRegistry,
    private readonly store: ConfigStore,
    private readonly layout: StateLayout,
    private readonly adapters: ReadonlyMap<EngineId, EngineAdapter>,
    private readonly logger: Logger,
  ) {}

  /**
   * Start (or join) the engine's sign-in episode. Fire-and-forget: searches
   * fail over immediately and never wait on the human. The episode promise
   * is failure-contained — an unexpected throw is logged, never surfaced as
   * an unhandled rejection in the host process.
   */
  start(engine: EngineId, trigger: 'auto' | 'manual'): void {
    const running = this.episodes.get(engine)
    if (running !== undefined) {
      this.logger.info('human-search: sign-in episode for "%s" already running', engine)
      return
    }
    const episode = this.run(engine, trigger)
      .catch((error: unknown) => {
        this.logger.error('human-search: sign-in episode for "%s" failed: %s', engine, String(error))
      })
      .finally(() => {
        this.episodes.delete(engine)
      })
    this.episodes.set(engine, episode)
  }

  /** Whether any engine currently has an interactive window open. */
  hasPendingWindow(): boolean {
    return this.episodes.size > 0
  }

  /** Stop accepting new episodes and let watchers exit; called at dispose. */
  dispose(): void {
    this.disposed = true
  }

  private async run(engine: EngineId, trigger: 'auto' | 'manual'): Promise<void> {
    const adapter = this.adapters.get(engine)
    if (adapter === undefined) return
    this.health.markSigningIn(engine)
    const config = this.store.get()
    const locale = config.locale.length > 0 ? config.locale : adapter.defaultLocale

    let session: HeadedSession | undefined
    try {
      session = await this.pool.openHeaded(engine)
    } catch (error) {
      this.health.markBlocked(engine, `cannot open sign-in window (${String(error)})`)
      this.logger.warn(
        'human-search: could not open a sign-in window for "%s" (trigger: %s): %s — '
        + 'an interactive login needs a display on the machine running DSH',
        engine, trigger, String(error),
      )
      return
    }

    this.logger.warn(
      'human-search: opened a sign-in window for "%s" (trigger: %s). '
      + 'Solve the CAPTCHA and/or sign in there; searches keep running on the other engines meanwhile.',
      engine, trigger,
    )

    try {
      await session.page
        .goto(adapter.loginUrl(locale), { waitUntil: 'domcontentloaded', timeout: 30_000 })
        .catch(error => this.logger.warn('human-search: login navigation: %s', String(error)))

      const outcome = await this.waitForClearance(session, adapter, locale)
      if (this.disposed || outcome === 'closed') {
        this.health.markBlocked(engine, 'sign-in window closed before the block cleared')
        return
      }
      if (outcome === 'timeout') {
        this.health.markBlocked(engine, 'sign-in window timed out')
        return
      }
      // Cleared: persist a portable cookie snapshot next to the profile.
      await session.page.context()
        .storageState({ path: storageStatePath(this.layout, engine) })
        .catch(error => this.logger.warn('human-search: storageState export for "%s": %s', engine, String(error)))
      this.health.markOk(engine)
      this.logger.info('human-search: sign-in for "%s" complete; cookies persisted for future searches', engine)
    } finally {
      await this.pool.releaseHeaded(engine, session)
    }
  }

  /**
   * Watch the headed page until the block clears, the user closes the
   * window, or the episode times out. Clearance means: the page has left the
   * login host (or never was on one) and no blocked-signals remain.
   */
  private async waitForClearance(
    session: HeadedSession,
    adapter: EngineAdapter,
    locale: string,
  ): Promise<'cleared' | 'closed' | 'timeout'> {
    const started = Date.now()
    let nudged = false
    const loginHost = hostOf(adapter.loginUrl(locale))
    const homeHost = hostOf(adapter.homeUrl(locale))
    while (Date.now() - started < EPISODE_TIMEOUT_MS) {
      if (this.disposed) return 'closed'
      if (session.page.isClosed() || session.page.context().pages().length === 0) return 'closed'
      try {
        const url = session.page.url()
        // An engine without accounts uses its home page as the sign-in
        // destination, so parking there is the state to check, not to leave.
        const onLoginHost = loginHost !== homeHost && hostOf(url) === loginHost
        if (!onLoginHost) {
          const blocked = await adapter.blockedReason(session.page)
          if (blocked === undefined) return 'cleared'
        } else if (!nudged && Date.now() - started > NUDGE_AFTER_MS) {
          // Parked on the login page long after finishing: steer to the
          // engine so the check runs where the block lives.
          nudged = true
          await session.page
            .goto(adapter.homeUrl(locale), { waitUntil: 'domcontentloaded', timeout: 20_000 })
            .catch(() => {})
        }
      } catch {
        // Navigation races during user interaction; retry on the next tick.
      }
      await Promise.race([sleep(POLL_INTERVAL_MS), session.whenClosed])
    }
    return 'timeout'
  }
}

/** Hostname of a URL, lowercase; '' when malformed. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}
