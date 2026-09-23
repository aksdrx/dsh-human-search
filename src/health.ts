/**
 * Engine health: what last happened on each engine and whether the chain
 * should still try it. A blocked engine (CAPTCHA/bot wall) is skipped for a
 * cooldown after a failed sign-in episode — retrying every search would burn
 * the chain budget — while `shouldTry` stays true otherwise so recovery is
 * automatic once the wall lapses.
 * @module dsh-human-search/health
 */

import type { Logger } from './dsh.ts'
import type { EngineId } from './engines/types.ts'

/** Coarse engine state. */
export type EngineHealthState = 'unknown' | 'ok' | 'blocked' | 'signing-in'

/** One engine's last known health. */
export interface EngineHealth {
  readonly engine: EngineId
  readonly state: EngineHealthState
  readonly reason: string | undefined
  /** When this state was recorded (epoch ms). */
  readonly since: number
}

/** How long a blocked engine is skipped before the chain retries it. */
export const BLOCKED_RETRY_MS = 10 * 60_000

/** Per-engine health bookkeeping; trivially concurrent-safe via immutability. */
export class HealthRegistry {
  private readonly entries = new Map<EngineId, EngineHealth>()

  constructor(private readonly logger: Logger) {}

  private set(engine: EngineId, state: EngineHealthState, reason?: string): void {
    this.entries.set(engine, { engine, state, reason, since: Date.now() })
  }

  /** Record a successful search. */
  markOk(engine: EngineId): void {
    this.set(engine, 'ok')
  }

  /** Record a block (CAPTCHA, bot wall) with its reason. */
  markBlocked(engine: EngineId, reason: string): void {
    this.set(engine, 'blocked', reason)
    this.logger.info('human-search: engine "%s" marked blocked (%s)', engine, reason)
  }

  /** Record that an interactive sign-in episode started. */
  markSigningIn(engine: EngineId): void {
    this.set(engine, 'signing-in')
  }

  /** Whether the chain should attempt this engine right now. */
  shouldTry(engine: EngineId): boolean {
    const entry = this.entries.get(engine)
    if (entry === undefined) return true
    if (entry.state !== 'blocked') return true
    return Date.now() - entry.since >= BLOCKED_RETRY_MS
  }

  /** Current health snapshot for notes and diagnostics. */
  snapshot(): readonly EngineHealth[] {
    return [...this.entries.values()]
  }

  /** Whether an engine currently has an interactive window open. */
  isSigningIn(engine: EngineId): boolean {
    return this.entries.get(engine)?.state === 'signing-in'
  }
}
