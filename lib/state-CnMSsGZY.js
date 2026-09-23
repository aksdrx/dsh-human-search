import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

//#region src/state.ts
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
/** Resolve the plugin state root. */
function resolveStateRoot() {
	const explicit = process.env.DSH_HUMAN_SEARCH_HOME;
	if (explicit !== void 0 && explicit.length > 0) return explicit;
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(dshHome, "web-human-search");
}
/**
* Create (idempotently) the plugin state layout with owner-only permissions
* — cookie profiles are secrets-adjacent and never group/world readable.
*/
function ensureStateLayout(root = resolveStateRoot()) {
	const layout = {
		root,
		profilesRoot: join(root, "profiles"),
		stateRoot: join(root, "state"),
		browsersRoot: join(root, "browsers")
	};
	for (const dir of [
		layout.root,
		layout.profilesRoot,
		layout.stateRoot
	]) if (!existsSync(dir)) mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	return layout;
}
/** One engine's persistent Chromium user-data-dir. */
function engineProfileDir(layout, engine) {
	return join(layout.profilesRoot, engine);
}
/** One engine's exported storageState path. */
function storageStatePath(layout, engine) {
	return join(layout.stateRoot, `${engine}.json`);
}
/**
* Point playwright's registry at the plugin-managed browsers directory.
* Call once, before the first playwright API use in the process. Returns
* whether the directory exists yet (i.e. a browser was installed).
*/
function bindPlaywrightBrowsersPath(layout) {
	if (process.env.PLAYWRIGHT_BROWSERS_PATH === void 0) process.env.PLAYWRIGHT_BROWSERS_PATH = layout.browsersRoot;
	return existsSync(layout.browsersRoot);
}

//#endregion
export { storageStatePath as a, resolveStateRoot as i, engineProfileDir as n, ensureStateLayout as r, bindPlaywrightBrowsersPath as t };