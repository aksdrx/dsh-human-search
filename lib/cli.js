import { r as ensureStateLayout } from "./state-CnMSsGZY.js";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

//#region src/cli.ts
/**
* `node lib/cli.js install-browser` — download a plugin-managed Chromium into
* the plugin state directory (`<root>/browsers/`), pointed at by
* `PLAYWRIGHT_BROWSERS_PATH` at runtime, so no global cache is touched and
* no system browser is required. Usage output otherwise.
* @module dsh-human-search/cli
*/
/** Locate playwright's bundled CLI script without subpath-export guesses. */
function resolvePlaywrightCli() {
	const require = createRequire(import.meta.url);
	try {
		const manifest = require.resolve("playwright/package.json");
		const candidate = join(dirname(manifest), "cli.js");
		if (existsSync(candidate)) return candidate;
	} catch {}
	const here = dirname(fileURLToPath(import.meta.url));
	for (const base of [here, dirname(here)]) {
		const candidate = join(base, "node_modules", "playwright", "cli.js");
		if (existsSync(candidate)) return candidate;
	}
}
/** The one-command browser setup. */
function installBrowser() {
	const layout = ensureStateLayout();
	mkdirSync(layout.browsersRoot, {
		recursive: true,
		mode: 448
	});
	const cli = resolvePlaywrightCli();
	if (cli === void 0) {
		process.stderr.write("dsh-human-search: cannot locate the playwright CLI inside this install; run `npx playwright@1.63.0 install chromium` with PLAYWRIGHT_BROWSERS_PATH set instead.\n");
		return 1;
	}
	process.stdout.write(`dsh-human-search: installing plugin-managed Chromium into ${layout.browsersRoot} …\n`);
	const result = spawnSync(process.execPath, [
		cli,
		"install",
		"chromium"
	], {
		env: {
			...process.env,
			PLAYWRIGHT_BROWSERS_PATH: layout.browsersRoot
		},
		stdio: "inherit"
	});
	if (result.status !== 0) {
		process.stderr.write("dsh-human-search: Chromium install failed; see the output above.\n");
		return result.status ?? 1;
	}
	process.stdout.write(`dsh-human-search: Chromium installed. Searches will use it when no system Chrome/Edge exists.\n`);
	return 0;
}
function main() {
	const command = process.argv[2];
	if (command === "install-browser") return installBrowser();
	process.stdout.write("usage: node lib/cli.js install-browser\n");
	return command === void 0 ? 0 : 1;
}
process.exit(main());

//#endregion
export {  };