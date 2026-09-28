/**
 * `node lib/cli.js <command>` — package-level helpers that run outside the
 * DSH process against the same shared state the plugin uses:
 *
 *   install-browser    download a plugin-managed Chromium into
 *                      `<state root>/browsers/`
 *   warm [engines…]    open headed windows on the per-engine profiles for a
 *                      one-time human warm-up: search once, solve any
 *                      challenge, optionally sign in; close the window to
 *                      advance. Cookies persist in the profile the headless
 *                      chain reuses — the smoothest first-run experience on
 *                      a fresh IP, and the documented remedy for an engine
 *                      that keeps serving CAPTCHAs or decoy results.
 * @module dsh-human-search/cli
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserPool } from './browser.ts'
import { ADAPTERS } from './engines/index.ts'
import { ENGINE_IDS, isEngineId, type EngineId } from './engines/types.ts'
import { DEFAULT_CONFIG, ConfigStore, type Config } from './settings.ts'
import { bindPlaywrightBrowsersPath, ensureStateLayout } from './state.ts'

/** Locate playwright's bundled CLI script without subpath-export guesses. */
function resolvePlaywrightCli(): string | undefined {
  const require = createRequire(import.meta.url)
  try {
    const manifest = require.resolve('playwright/package.json')
    const candidate = join(dirname(manifest), 'cli.js')
    if (existsSync(candidate)) return candidate
  } catch {
    // Package exports may hide the manifest; fall through to layout probes.
  }
  const here = dirname(fileURLToPath(import.meta.url))
  for (const base of [here, dirname(here)]) {
    const candidate = join(base, 'node_modules', 'playwright', 'cli.js')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** The one-command browser setup. */
function installBrowser(): number {
  const layout = ensureStateLayout()
  mkdirSync(layout.browsersRoot, { recursive: true, mode: 0o700 })
  const cli = resolvePlaywrightCli()
  if (cli === undefined) {
    process.stderr.write('dsh-human-search: cannot locate the playwright CLI inside this install; run `npx playwright@1.63.0 install chromium` with PLAYWRIGHT_BROWSERS_PATH set instead.\n')
    return 1
  }
  process.stdout.write(`dsh-human-search: installing plugin-managed Chromium into ${layout.browsersRoot} …\n`)
  const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: layout.browsersRoot },
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    process.stderr.write('dsh-human-search: Chromium install failed; see the output above.\n')
    return result.status ?? 1
  }
  process.stdout.write(`dsh-human-search: Chromium installed. Searches will use it when no system Chrome/Edge exists.\n`)
  return 0
}

/** Per-engine guidance shown above each warm-up window. */
const WARM_HINTS: Record<EngineId, string> = {
  google: 'Search once; if a CAPTCHA appears, solve it (being signed in to a Google account helps a lot).',
  duckduckgo: 'Search once; solve the "select the ducks" anomaly challenge if it appears.',
  bing: 'Search once or twice; sign in with a Microsoft account if offered.',
  baidu: 'Search once; solve the security verification if shown (a Baidu account login helps).',
  sogou: 'Search once.',
}

/**
 * The interactive warm-up: one headed window per engine, on the shared
 * per-engine profile the headless chain uses. The user completes a search,
 * any challenge, and optional sign-ins in the engine's own pages; closing
 * the window advances to the next engine.
 */
async function warm(requested: string[]): Promise<number> {
  const unknown = requested.filter(id => !isEngineId(id))
  for (const id of unknown) {
    process.stderr.write(`dsh-human-search: unknown engine "${id}" (known: ${ENGINE_IDS.join(', ')})\n`)
  }
  const engines: EngineId[] = requested.filter(isEngineId)
  if (engines.length === 0) {
    process.stderr.write('dsh-human-search: nothing to warm — pass engine ids, e.g. `node lib/cli.js warm duckduckgo bing`.\n')
    return 1
  }
  const layout = ensureStateLayout()
  bindPlaywrightBrowsersPath(layout)
  const executablePath = process.env.DSH_HUMAN_SEARCH_BROWSER ?? ''
  const config: Config = { ...DEFAULT_CONFIG, headless: false, executablePath }
  const store = new ConfigStore(config)
  const logger = {
    info: (...args: unknown[]) => { process.stdout.write(`[warm] ${args.map(String).join(' ')}\n`) },
    warn: (...args: unknown[]) => { process.stdout.write(`[warm] ${args.map(String).join(' ')}\n`) },
    error: (...args: unknown[]) => { process.stderr.write(`[warm] ${args.map(String).join(' ')}\n`) },
  }
  const pool = new BrowserPool(store, layout, ADAPTERS, logger)
  let failures = 0
  try {
    for (const engine of engines) {
      const adapter = ADAPTERS.get(engine)
      if (adapter === undefined) continue
      process.stdout.write(`\n=== ${adapter.label} ===\n${WARM_HINTS[engine]}\nClose the window when done to continue.\n`)
      let session: Awaited<ReturnType<BrowserPool['openHeaded']>> | undefined
      try {
        session = await pool.openHeaded(engine)
        await session.page
          .goto(adapter.homeUrl(adapter.defaultLocale), { waitUntil: 'domcontentloaded', timeout: 30_000 })
          .catch(() => {})
        await session.whenClosed
        process.stdout.write(`-> ${engine} profile warmed; future headless searches reuse its cookies.\n`)
      } catch (error) {
        failures += 1
        process.stderr.write(`-> could not open a warm-up window for ${engine}: ${String(error)}\n`)
        process.stderr.write('   A warm-up needs a display and a full browser binary on this machine; run it from a desktop session (WSLg/X11 on Windows counts), or install one with `install-browser`.\n')
      } finally {
        if (session !== undefined) await pool.releaseHeaded(engine, session).catch(() => {})
      }
    }
  } finally {
    await pool.closeAll().catch(() => {})
  }
  return failures === 0 ? 0 : 1
}

/** Dispatch one CLI command. */
async function main(): Promise<number> {
  const command = process.argv[2]
  if (command === 'install-browser') return installBrowser()
  if (command === 'warm') return await warm(process.argv.slice(3))
  process.stdout.write('usage: node lib/cli.js install-browser\n       node lib/cli.js warm [engines…]\n')
  return command === undefined ? 0 : 1
}

main().then(
  code => { process.exit(code) },
  error => {
    process.stderr.write(`dsh-human-search: ${String(error)}\n`)
    process.exit(1)
  },
)
