/**
 * `node lib/cli.js install-browser` — download a plugin-managed Chromium into
 * the plugin state directory (`<root>/browsers/`), pointed at by
 * `PLAYWRIGHT_BROWSERS_PATH` at runtime, so no global cache is touched and
 * no system browser is required. Usage output otherwise.
 * @module dsh-human-search/cli
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureStateLayout } from './state.ts'

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

function main(): number {
  const command = process.argv[2]
  if (command === 'install-browser') return installBrowser()
  process.stdout.write('usage: node lib/cli.js install-browser\n')
  return command === undefined ? 0 : 1
}

process.exit(main())
