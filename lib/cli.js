import { a as isBrowserFamily, c as ENGINE_IDS, d as ADAPTERS, g as ensureStateLayout, h as bindPlaywrightBrowsersPath, l as isEngineId, n as ConfigStore, p as BrowserPool, r as DEFAULT_CONFIG } from "./settings-CaJXXHRF.js";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

//#region src/cli.ts
/**
* `node lib/cli.js <command>` — package-level helpers that run outside the
* DSH process against the same shared state the plugin uses:
*
*   install-browser [kind…]   download plugin-managed browsers into
*                             `<state root>/browsers/`; kind is one of
*                             chromium (default), firefox, webkit, or
*                             chrome (branded Google Chrome, system-wide)
*   warm [--family f] [engines…]
*                             open headed windows on the per-engine
*                             profiles for a one-time human warm-up: search
*                             once, solve any challenge, optionally sign
*                             in; close the window to advance. `--family`
*                             (chromium|firefox|webkit) selects which
*                             family's profiles to warm. Cookies persist in
*                             the profile the headless chain reuses — the
*                             smoothest first-run experience on a fresh IP,
*                             and the documented remedy for an engine that
*                             keeps serving CAPTCHAs or decoy results.
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
/** Install kinds the CLI accepts, with their human labels. */
const INSTALL_KINDS = {
	chromium: "plugin-managed Chromium",
	firefox: "plugin-managed Firefox",
	webkit: "plugin-managed WebKit",
	chrome: "branded Google Chrome (system-wide)"
};
/** The one-command browser setup. */
function installBrowser(requested) {
	const kinds = [];
	for (const arg of requested) {
		if (!(arg in INSTALL_KINDS)) {
			process.stderr.write(`dsh-human-search: unknown install-browser target "${arg}" (known: ${Object.keys(INSTALL_KINDS).join(", ")})\n`);
			return 1;
		}
		kinds.push(arg);
	}
	if (kinds.length === 0) kinds.push("chromium");
	const layout = ensureStateLayout();
	mkdirSync(layout.browsersRoot, {
		recursive: true,
		mode: 448
	});
	const cli = resolvePlaywrightCli();
	if (cli === void 0) {
		process.stderr.write("dsh-human-search: cannot locate the playwright CLI inside this install; run `npx playwright@1.63.0 install <kind>` with PLAYWRIGHT_BROWSERS_PATH set instead.\n");
		return 1;
	}
	for (const kind of kinds) {
		process.stdout.write(`dsh-human-search: installing ${INSTALL_KINDS[kind]} …\n`);
		const result = spawnSync(process.execPath, [
			cli,
			"install",
			kind
		], {
			env: {
				...process.env,
				PLAYWRIGHT_BROWSERS_PATH: layout.browsersRoot
			},
			stdio: "inherit"
		});
		if (result.status !== 0) {
			if (kind === "chrome") process.stderr.write("dsh-human-search: branded Chrome install failed (it needs root on Linux). Run `sudo npx playwright@1.63.0 install chrome` from your terminal, or install google-chrome-stable from Google's apt repository.\n");
			else process.stderr.write(`dsh-human-search: ${kind} install failed; missing system libraries are the usual cause — run \`sudo npx playwright@1.63.0 install-deps ${kind}\` and retry.\n`);
			return result.status ?? 1;
		}
		if (kind === "chrome") process.stdout.write("dsh-human-search: Google Chrome installed. Searches and sign-in windows pick it up automatically as the first non-configured candidate.\n");
		else if (kind === "chromium") process.stdout.write("dsh-human-search: Chromium installed. Searches will use it when no system Chrome/Edge exists.\n");
		else process.stdout.write(`dsh-human-search: ${kind === "firefox" ? "Firefox" : "WebKit"} installed. Assign engines to it via the per-engine browser selector in Settings → Plugins → Human Web Search (or warm its profiles with \`warm --family ${kind}\`).\n`);
	}
	return 0;
}
/** Per-engine guidance shown above each warm-up window. */
const WARM_HINTS = {
	google: "Search once; if a CAPTCHA appears, solve it (being signed in to a Google account helps a lot).",
	duckduckgo: "Search once; solve the \"select the ducks\" anomaly challenge if it appears.",
	bing: "Search once or twice; sign in with a Microsoft account if offered.",
	baidu: "Search once; solve the security verification if shown (a Baidu account login helps).",
	sogou: "Search once."
};
/**
* The interactive warm-up: one headed window per engine, on the shared
* per-engine profile the headless chain uses. The user completes a search,
* any challenge, and optional sign-ins in the engine's own pages; closing
* the window advances to the next engine.
*/
async function warm(args) {
	let family = "chromium";
	const requested = [];
	for (const arg of args) {
		if (arg.startsWith("--family=")) {
			const value = arg.slice(9);
			if (!isBrowserFamily(value)) {
				process.stderr.write(`dsh-human-search: unknown --family "${value}" (known: chromium, firefox, webkit)\n`);
				return 1;
			}
			family = value;
			continue;
		}
		if (arg === "--family") {
			process.stderr.write("dsh-human-search: use --family=<name> (chromium, firefox, webkit)\n");
			return 1;
		}
		requested.push(arg);
	}
	const unknown = requested.filter((id) => !isEngineId(id));
	for (const id of unknown) process.stderr.write(`dsh-human-search: unknown engine "${id}" (known: ${ENGINE_IDS.join(", ")})\n`);
	const engines = requested.filter(isEngineId);
	if (engines.length === 0) {
		process.stderr.write("dsh-human-search: nothing to warm — pass engine ids, e.g. `node lib/cli.js warm duckduckgo bing`.\n");
		return 1;
	}
	const layout = ensureStateLayout();
	bindPlaywrightBrowsersPath(layout);
	const executablePath = process.env.DSH_HUMAN_SEARCH_BROWSER ?? "";
	const config = {
		...DEFAULT_CONFIG,
		headless: false,
		executablePath,
		engines: DEFAULT_CONFIG.engines.map((entry) => ({
			...entry,
			browser: family
		}))
	};
	const store = new ConfigStore(config);
	const pool = new BrowserPool(store, layout, ADAPTERS, {
		info: (...args) => {
			process.stdout.write(`[warm] ${args.map(String).join(" ")}\n`);
		},
		warn: (...args) => {
			process.stdout.write(`[warm] ${args.map(String).join(" ")}\n`);
		},
		error: (...args) => {
			process.stderr.write(`[warm] ${args.map(String).join(" ")}\n`);
		}
	});
	let failures = 0;
	try {
		for (const engine of engines) {
			const adapter = ADAPTERS.get(engine);
			if (adapter === void 0) continue;
			process.stdout.write(`\n=== ${adapter.label}${family === "chromium" ? "" : ` (${family})`} ===\n${WARM_HINTS[engine]}\nClose the window when done to continue.\n`);
			let session;
			try {
				session = await pool.openHeaded(engine);
				await session.page.goto(adapter.homeUrl(adapter.defaultLocale), {
					waitUntil: "domcontentloaded",
					timeout: 3e4
				}).catch(() => {});
				await session.whenClosed;
				process.stdout.write(`-> ${engine} profile warmed; future headless searches reuse its cookies.\n`);
			} catch (error) {
				failures += 1;
				process.stderr.write(`-> could not open a warm-up window for ${engine}: ${String(error)}\n`);
				process.stderr.write("   A warm-up needs a display and a full browser binary on this machine; run it from a desktop session (WSLg/X11 on Windows counts), or install one with `install-browser`.\n");
			} finally {
				if (session !== void 0) await pool.releaseHeaded(engine, session).catch(() => {});
			}
		}
	} finally {
		await pool.closeAll().catch(() => {});
	}
	return failures === 0 ? 0 : 1;
}
/** Dispatch one CLI command. */
async function main() {
	const command = process.argv[2];
	if (command === "install-browser") return installBrowser(process.argv.slice(3));
	if (command === "warm") return await warm(process.argv.slice(3));
	process.stdout.write("usage: node lib/cli.js install-browser [chromium|firefox|webkit|chrome …]\n       node lib/cli.js warm [--family=chromium|firefox|webkit] [engines…]\n");
	return command === void 0 ? 0 : 1;
}
main().then((code) => {
	process.exit(code);
}, (error) => {
	process.stderr.write(`dsh-human-search: ${String(error)}\n`);
	process.exit(1);
});

//#endregion
export {  };