/**
 * Plugin-owned on-disk state. Everything this plugin persists lives under one
 * root — never inside the DSH installation — so removing the plugin leaves
 * the harness untouched and one directory holds every trace.
 *
 * Layout:
 *   <root>/profiles/<engine>/   per-engine persistent Chromium user-data-dirs
 *   <root>/state/<engine>.json  exported storageState snapshots (portable cookies)
 *   <root>/browsers/            plugin-managed Chromium downloads
 *
 * Root resolution order: `$DSH_HUMAN_SEARCH_HOME`, then `<DSH_HOME or
 * ~/.dsh>/web-human-search`. `PLAYWRIGHT_BROWSERS_PATH` is pointed at the
 * browsers directory before any playwright registry use so a plugin-managed
 * Chromium never collides with (or silently reuses) other tooling's.
 * @module dsh-human-search/state
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EngineId } from './engines/types.ts'

/** Resolve the plugin state root. */
export function resolveStateRoot(): string {
  const explicit = process.env.DSH_HUMAN_SEARCH_HOME
  if (explicit !== undefined && explicit.length > 0) return explicit
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'web-human-search')
}

/** The plugin's three storage areas. */
export interface StateLayout {
  readonly root: string
  readonly profilesRoot: string
  readonly stateRoot: string
  readonly browsersRoot: string
}

/**
 * Create (idempotently) the plugin state layout with owner-only permissions
 * — cookie profiles are secrets-adjacent and never group/world readable.
 */
export function ensureStateLayout(root: string = resolveStateRoot()): StateLayout {
  const layout: StateLayout = {
    root,
    profilesRoot: join(root, 'profiles'),
    stateRoot: join(root, 'state'),
    browsersRoot: join(root, 'browsers'),
  }
  for (const dir of [layout.root, layout.profilesRoot, layout.stateRoot]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return layout
}

/** One engine's persistent Chromium user-data-dir. */
export function engineProfileDir(layout: StateLayout, engine: EngineId): string {
  return join(layout.profilesRoot, engine)
}

/** One engine's exported storageState path. */
export function storageStatePath(layout: StateLayout, engine: EngineId): string {
  return join(layout.stateRoot, `${engine}.json`)
}

/**
 * Point playwright's registry at the plugin-managed browsers directory.
 * Call once, before the first playwright API use in the process. Returns
 * whether the directory exists yet (i.e. a browser was installed).
 */
export function bindPlaywrightBrowsersPath(layout: StateLayout): boolean {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = layout.browsersRoot
  }
  return existsSync(layout.browsersRoot)
}
