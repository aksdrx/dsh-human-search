/**
 * dsh-human-search — the Host plugin half.
 *
 * Registers the `human-search` provider on the `ctx.web` seam and the
 * `web-human-search` settings namespace the web GUI card edits. The engine
 * chain, browser pool, headed sign-in windows, and per-engine cookie profiles
 * are owned entirely by this plugin under `$DSH_HOME/web-human-search/`;
 * nothing inside the DSH installation is read or written.
 * @module dsh-human-search
 */

import { BrowserPool } from './browser.ts'
import type { Context, SettingsService } from './dsh.ts'
import { ADAPTERS } from './engines/index.ts'
import { runSearchChain } from './chain.ts'
import { HealthRegistry } from './health.ts'
import { LoginCoordinator } from './login.ts'
import { HumanSearchProvider, PROVIDER_ID } from './provider.ts'
import {
  Config, ConfigStore, parseLoginCommand, SETTINGS_NAMESPACE,
} from './settings.ts'
import { bindPlaywrightBrowsersPath, ensureStateLayout } from './state.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-human-search'

/** The web seam is a hard dependency; nothing works without it. */
export const inject = ['web']

/** Row-config validator and settings-namespace schema, one object. */
export { Config }
export { PROVIDER_ID, SETTINGS_NAMESPACE }
export { HumanSearchProvider, BrowserPool, LoginCoordinator, HealthRegistry, runSearchChain }
export { normalizeConfig, parseLoginCommand, DEFAULT_CONFIG } from './settings.ts'
export { resolveStateRoot, ensureStateLayout } from './state.ts'
export { ADAPTERS } from './engines/index.ts'

/**
 * Mount the plugin: provider on the seam, settings namespace when the
 * settings service is present (composition config remains authoritative
 * without it), and full teardown of every browser at dispose.
 */
export function apply(ctx: Context, config: unknown): void {
  const store = new ConfigStore(config)
  const layout = ensureStateLayout()
  bindPlaywrightBrowsersPath(layout)

  const pool = new BrowserPool(store, layout, ADAPTERS, ctx.logger)
  const health = new HealthRegistry(ctx.logger)
  const logins = new LoginCoordinator(pool, health, store, layout, ADAPTERS, ctx.logger)
  const provider = new HumanSearchProvider({ store, pool, adapters: ADAPTERS, health, logins, logger: ctx.logger })

  const web = ctx.get('web')
  if (web === undefined) {
    ctx.logger.warn('human-search: the web seam (ctx.web) is not available; the provider was not registered')
  } else {
    web.registerSearchProvider(provider)
  }

  // The optional-settings consumer: registers the namespace the GUI card
  // edits and keeps the authoritative source pointed at the resolved scope.
  ctx.inject(['settings'], (scopeCtx) => {
    const settings = scopeCtx.get('settings') as SettingsService | undefined
    if (settings === undefined) return
    let lastNonce = -1
    settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: current => {
        store.replace(current)
      },
      onChange: () => {
        pool.onConfigChange()
        const current = store.get()
        const command = parseLoginCommand(current.loginCommand)
        if (command !== undefined && command.nonce !== lastNonce) {
          // A fresh manual request from the settings card: run the episode,
          // then clear the command so it never replays after a restart.
          lastNonce = command.nonce
          logins.start(command.engine, 'manual')
          void settings.update(SETTINGS_NAMESPACE, { loginCommand: '' }).catch(error => {
            ctx.logger.warn('human-search: clearing the login command failed: %s', String(error))
          })
        }
      },
    })
    // A command left in the document by an interrupted run is stale, not a
    // user intent from before the process died — clear it without executing.
    if (parseLoginCommand(store.get().loginCommand) !== undefined) {
      void settings.update(SETTINGS_NAMESPACE, { loginCommand: '' }).catch(() => {})
    }
  })

  ctx.effect(() => () => {
    logins.dispose()
    void pool.closeAll()
  }, 'human-search: browser teardown')
}
