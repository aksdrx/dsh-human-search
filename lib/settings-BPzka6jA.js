import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";

//#region src/human.ts
/** Sleep for `ms` milliseconds. */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/** A random integer in `[base, base + spread]`. */
function jitter(base, spread) {
	return base + Math.floor(Math.random() * (spread + 1));
}
/** A short pause a person takes between noticing a box and typing into it. */
function humanPause() {
	return sleep(jitter(250, 650));
}
/**
* Type text into the currently focused element the way a person does:
* character by character, each keystroke delayed a little differently, with
* occasional slightly-longer pauses — for example after a word boundary.
*/
async function humanType(page, text) {
	for (const char of text) {
		await page.keyboard.type(char, { delay: 0 });
		if (char === " ") await sleep(jitter(70, 180));
		else await sleep(jitter(35, 120));
		if (Math.random() < .04) await sleep(jitter(150, 400));
	}
}

//#endregion
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
//#region src/browser.ts
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
/** Raised when an engine's profile is held by an interactive sign-in session. */
var EngineBusyError = class extends Error {
	engine;
	constructor(engine) {
		super(`engine "${engine}" is busy with an interactive sign-in window`);
		this.name = "EngineBusyError";
		this.engine = engine;
	}
};
/** Where common system browsers live, by platform. */
const SYSTEM_BROWSER_PATHS = process.platform === "darwin" ? [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
] : process.platform === "win32" ? [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
] : [
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/microsoft-edge",
	"/snap/bin/chromium",
	"/opt/google/chrome/chrome"
];
/**
* Resolve a plugin-managed browser under the browsers root. Playwright's
* registry computes its directory at import time — before any plugin code can
* set `PLAYWRIGHT_BROWSERS_PATH` — so managed browsers are located by
* scanning the plugin's own directory layout and passed as explicit
* `executablePath` values instead.
*
* `headless` selects the headless shell (the lighter, automation-safe build
* whose agent string carries a `Headless` marker this pool rewrites);
* otherwise the full Chrome-for-Testing binary is located, which headed
* sign-in sessions need.
*/
function resolveManagedExecutable(browsersRoot, headless) {
	const prefix = headless ? "chromium_headless_shell-" : "chromium-";
	const inner = headless ? process.platform === "win32" ? ["chrome-headless-shell-win64\\chrome-headless-shell.exe"] : process.platform === "darwin" ? ["chrome-mac/headless_shell"] : ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-headless-shell-linux/chrome-headless-shell"] : process.platform === "win32" ? ["chrome-win64\\chrome.exe", "chrome-win\\chrome.exe"] : process.platform === "darwin" ? [
		"chrome-mac64/Chromium.app/Contents/MacOS/Chromium",
		"chrome-mac/Chromium.app/Contents/MacOS/Chromium",
		"chrome-mac64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
	] : ["chrome-linux64/chrome", "chrome-linux/chrome"];
	let entries = [];
	try {
		entries = readdirSync(browsersRoot).filter((entry) => entry.startsWith(prefix) && /^\d+$/.test(entry.slice(prefix.length)));
	} catch {
		return;
	}
	entries.sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
	for (const entry of entries) for (const relative of inner) {
		const candidate = join(browsersRoot, entry, relative);
		if (existsSync(candidate)) return candidate;
	}
}
/**
* The pool. Constructed once per plugin; every browser it launches lives in a
* plugin-private profile directory and is closed at plugin dispose.
*/
var BrowserPool = class {
	store;
	layout;
	adapters;
	logger;
	slots = /* @__PURE__ */ new Map();
	/** Availability probe cache (`available()` must stay cheap and offline). */
	availability;
	/**
	* Learned headless user-agent fixes keyed by launch candidate (`null`:
	* probed clean). Keyed per executable because the rewrite depends on the
	* binary — the headless shell's agent carries a `HeadlessChrome` marker,
	* while a full Chrome in new-headless mode is already clean. Applies to
	* every candidate, including a user-configured executablePath.
	*/
	uaFixes = /* @__PURE__ */ new Map();
	disposed = false;
	constructor(store, layout, adapters, logger) {
		this.store = store;
		this.layout = layout;
		this.adapters = adapters;
		this.logger = logger;
		bindPlaywrightBrowsersPath(this.layout);
	}
	/**
	* Whether any usable browser exists: an explicitly configured executable, a
	* known system browser, or a plugin-managed Chromium install. Cheap local
	* checks only — no launches, no network.
	*/
	hasUsableBrowser() {
		const now = Date.now();
		if (this.availability !== void 0 && now - this.availability.at < 6e4) return this.availability.value;
		const value = this.probeAvailability();
		this.availability = {
			value,
			at: now
		};
		return value;
	}
	probeAvailability() {
		const config = this.store.get();
		if (config.executablePath.length > 0 && existsSync(config.executablePath)) return true;
		if (SYSTEM_BROWSER_PATHS.some((path) => existsSync(path))) return true;
		if (resolveManagedExecutable(this.layout.browsersRoot, true) !== void 0) return true;
		if (resolveManagedExecutable(this.layout.browsersRoot, false) !== void 0) return true;
		try {
			return existsSync(chromium.executablePath());
		} catch {
			return false;
		}
	}
	/**
	* Launch candidates in preference order. Headless searches prefer the
	* system browsers, then the plugin-managed full Chromium (its new-headless
	* fingerprint is far less bot-flagged than the headless shell's — Google
	* serves the shell a /sorry wall even signed in), then the lighter
	* headless shell. A headed sign-in window needs the full browser binary;
	* the headless shell cannot open one.
	*/
	candidates(config, headed) {
		const list = [];
		if (config.executablePath.length > 0) list.push({
			label: `configured (${config.executablePath})`,
			options: { executablePath: config.executablePath }
		});
		list.push({
			label: "system Google Chrome",
			options: { channel: "chrome" }
		});
		list.push({
			label: "system Microsoft Edge",
			options: { channel: "msedge" }
		});
		const managedFull = resolveManagedExecutable(this.layout.browsersRoot, false);
		const managedShell = resolveManagedExecutable(this.layout.browsersRoot, true);
		if (headed) {
			if (managedFull !== void 0) list.push({
				label: "plugin-managed Chromium",
				options: { executablePath: managedFull }
			});
		} else {
			if (managedFull !== void 0) list.push({
				label: "plugin-managed Chromium (new headless)",
				options: { executablePath: managedFull }
			});
			if (managedShell !== void 0) list.push({
				label: "plugin-managed headless shell",
				options: { executablePath: managedShell }
			});
		}
		list.push({
			label: "default playwright registry Chromium",
			options: {}
		});
		return list;
	}
	/** Serialize one engine transition or operation on its mutex chain. */
	enqueue(engine, operation) {
		const slot = this.slot(engine);
		const run = slot.chain.then(operation, operation);
		slot.chain = run.catch(() => {});
		return run;
	}
	slot(engine) {
		let slot = this.slots.get(engine);
		if (slot === void 0) {
			slot = {
				mode: "closed",
				context: void 0,
				chain: Promise.resolve(),
				idleTimer: void 0
			};
			this.slots.set(engine, slot);
		}
		return slot;
	}
	/** Identity of a launch candidate for the per-executable UA-fix map. */
	candidateKey(candidate) {
		return candidate.options.executablePath ?? `channel:${candidate.options.channel ?? "registry"}`;
	}
	/**
	* Launch (or reuse) the engine's persistent headless context. Any headless
	* binary can report a `HeadlessChrome` user agent — the plugin-managed
	* headless shell, or one configured explicitly — an instant bot signal, so
	* the first launch of each candidate executable probes its real agent and
	* relaunches with the headful-equivalent string when needed.
	*/
	launchHeadless(engine) {
		return this.enqueue(engine, async () => {
			const slot = this.slot(engine);
			if (slot.mode === "headed") throw new EngineBusyError(engine);
			if (slot.context !== void 0) return slot.context;
			const context = await this.launchPersistent(engine, false);
			slot.mode = "headless";
			slot.context = context;
			return context;
		});
	}
	async launchPersistent(engine, headed) {
		const config = this.store.get();
		const adapter = this.adapters.get(engine);
		const locale = config.locale.length > 0 ? config.locale : adapter?.defaultLocale ?? "en-US";
		const userDataDir = engineProfileDir(this.layout, engine);
		const viewport = {
			width: jitter(1280, 320),
			height: jitter(800, 240)
		};
		const fixHeadlessUa = !headed && config.headless;
		let lastError;
		for (const candidate of this.candidates(config, headed)) try {
			let context = await chromium.launchPersistentContext(userDataDir, {
				...candidate.options,
				headless: headed ? false : config.headless,
				locale,
				viewport
			});
			if (fixHeadlessUa) {
				const key = this.candidateKey(candidate);
				if (!this.uaFixes.has(key)) this.uaFixes.set(key, await this.probeHeadlessUa(context));
				const fix = this.uaFixes.get(key) ?? void 0;
				if (fix !== void 0) {
					await context.close().catch(() => {});
					context = await chromium.launchPersistentContext(userDataDir, {
						...candidate.options,
						userAgent: fix,
						headless: true,
						locale,
						viewport
					});
				}
			}
			return context;
		} catch (error) {
			lastError = error;
			this.logger.info("human-search: browser candidate \"%s\" unavailable for %s: %s", candidate.label, engine, String(error));
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
	/**
	* Read a freshly launched headless context's real user agent and, when it
	* carries a `Headless` marker, return the headful-equivalent agent string
	* (same version and platform tokens) for every later launch of the same
	* executable. `null` means no rewrite is needed.
	*/
	async probeHeadlessUa(context) {
		try {
			const page = await context.newPage();
			const ua = await page.evaluate(() => navigator.userAgent);
			await page.close();
			if (!ua.includes("Headless")) return null;
			return ua.replace(/HeadlessChrome\//, "Chrome/");
		} catch (error) {
			this.logger.warn("human-search: user-agent probe failed; keeping the original context: %s", String(error));
			return null;
		}
	}
	/**
	* Run one operation on a fresh page of the engine's headless context.
	* `timeoutMs` bounds the whole operation: on expiry the page closes (which
	* cancels any in-flight protocol call) and the caller sees a timeout error.
	*/
	async withHeadlessPage(engine, timeoutMs, operation) {
		if (this.disposed) throw new Error("browser pool is disposed");
		if (this.slot(engine).mode === "headed") throw new EngineBusyError(engine);
		const context = await this.launchHeadless(engine);
		let page;
		try {
			page = await context.newPage();
			const operationPromise = operation(page);
			operationPromise.catch(() => {});
			return await Promise.race([operationPromise, sleep(timeoutMs).then(() => {
				throw new Error(`engine attempt timed out after ${String(timeoutMs)}ms`);
			})]);
		} finally {
			this.touchIdle(engine);
			if (page !== void 0) await page.close().catch(() => {});
		}
	}
	/**
	* Open the engine's profile in a headed window, exclusively. Any headless
	* context is closed first (they share the user-data-dir); while the session
	* lives, headless attempts on this engine fail fast.
	*/
	async openHeaded(engine) {
		if (this.disposed) throw new Error("browser pool is disposed");
		return await this.enqueue(engine, async () => {
			const slot = this.slot(engine);
			if (slot.mode === "headed" && slot.context !== void 0) throw new Error(`engine "${engine}" already has an open sign-in window`);
			if (slot.idleTimer !== void 0) clearTimeout(slot.idleTimer);
			if (slot.context !== void 0) {
				await slot.context.close().catch(() => {});
				slot.context = void 0;
			}
			slot.mode = "closed";
			const context = await this.launchPersistent(engine, true);
			slot.mode = "headed";
			slot.context = context;
			const page = await context.newPage();
			let onClose;
			const whenClosed = new Promise((resolve) => {
				onClose = resolve;
			});
			context.once("close", () => {
				onClose();
			});
			return {
				engine,
				page,
				whenClosed,
				close: async () => {
					await context.close().catch(() => {});
				}
			};
		});
	}
	/** Release a headed session back to the pool (profile becomes headless-able). */
	async releaseHeaded(engine, session) {
		await session.close();
		await this.enqueue(engine, async () => {
			const slot = this.slot(engine);
			if (slot.mode === "headed") {
				slot.mode = "closed";
				slot.context = void 0;
			}
		});
	}
	/** Reset (or clear) the idle-close timer after headless activity. */
	touchIdle(engine) {
		const slot = this.slot(engine);
		if (slot.idleTimer !== void 0) clearTimeout(slot.idleTimer);
		const idleCloseMs = this.store.get().idleCloseMs;
		if (idleCloseMs <= 0 || slot.mode !== "headless") return;
		slot.idleTimer = setTimeout(() => {
			this.closeEngine(engine).catch(() => {});
		}, idleCloseMs);
	}
	/** Close one engine's context (headless housekeeping or headed release). */
	async closeEngine(engine) {
		await this.enqueue(engine, async () => {
			const slot = this.slot(engine);
			if (slot.idleTimer !== void 0) clearTimeout(slot.idleTimer);
			if (slot.context !== void 0) {
				await slot.context.close().catch(() => {});
				slot.context = void 0;
			}
			slot.mode = "closed";
		});
	}
	/** Close every engine context; used at plugin dispose. */
	async closeAll() {
		this.disposed = true;
		await Promise.allSettled([...this.slots.keys()].map((engine) => this.closeEngine(engine)));
	}
	/** React to committed configuration: invalidate the availability cache. */
	onConfigChange() {
		this.availability = void 0;
	}
};

//#endregion
//#region src/engines/util.ts
/** Unwrap `google.com/url?q=…`-style redirect wrappers to the target URL. */
function unwrapRedirect(url) {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/url" || parsed.pathname.startsWith("/url/")) {
			const target = parsed.searchParams.get("q") ?? parsed.searchParams.get("url") ?? parsed.searchParams.get("sa");
			if (target !== null && target.startsWith("http")) return target;
		}
		if (parsed.hostname.endsWith("bing.com") && parsed.pathname === "/ck/a") {
			const payload = parsed.searchParams.get("u");
			if (payload !== null && payload.startsWith("a1")) try {
				const decoded = atob(payload.slice(2).replace(/-/g, "+").replace(/_/g, "/"));
				if (decoded.startsWith("http")) return decoded;
			} catch {}
		}
		return url;
	} catch {
		return url;
	}
}
function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}
/** Hosts that are engine chrome, not organic results. */
const INTERNAL_HOSTS = {
	google: [
		"accounts.google.com",
		"consent.google.com",
		"myaccount.google.com",
		"policies.google.com",
		"support.google.com"
	],
	duckduckgo: [
		"duckduckgo.com",
		"duck.co",
		"spreadduckduckgo.com"
	],
	bing: [
		"login.live.com",
		"account.microsoft.com",
		"go.microsoft.com",
		"bing.com/secure"
	],
	baidu: [
		"passport.baidu.com",
		"wappass.baidu.com",
		"i.baidu.com",
		"passport.baidu.com/v2"
	],
	sogou: [
		"account.sogou.com",
		"123.sogou.com",
		"fankui.sogou.com"
	]
};
/** Whether a URL is engine-internal navigation rather than a result. */
function isInternalLink(url, engine) {
	if (!url.startsWith("http")) return true;
	const host = hostOf(url);
	if (host === "") return true;
	if (INTERNAL_HOSTS[engine].some((internal) => host === internal || host.endsWith(`.${internal}`))) return true;
	if (engine === "google" && (host === "www.google.com" || host === "google.com")) {
		const path = new URL(url).pathname;
		if (path === "/search" || path === "/url" || path === "/" || path.startsWith("/imgres")) return true;
	}
	if (engine === "bing" && (host === "www.bing.com" || host === "bing.com")) {
		const path = new URL(url).pathname;
		if (path === "/search" || path === "/") return true;
	}
	if (engine === "baidu" && host === "www.baidu.com") {
		const path = new URL(url).pathname;
		if (path === "/" || path === "/s" || path.startsWith("/from")) return true;
	}
	if (engine === "sogou" && host === "www.sogou.com") {
		const path = new URL(url).pathname;
		if (path === "/" || path === "/web" || path === "/link") {
			if (path === "/link") return false;
			return true;
		}
	}
	return false;
}
/** Collapse whitespace and truncate a snippet. */
function cleanSnippet(text, max = 240) {
	if (text === void 0) return void 0;
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return void 0;
	return collapsed.length > max ? `${collapsed.slice(0, max).trimEnd()}…` : collapsed;
}
/**
* Lowercased Latin word tokens (length ≥ 3) of a query, for the decoy
* relevance guard. Queries without such tokens — single CJK phrases, short
* numerics — yield no tokens and skip the guard rather than risk rejecting
* good results whose language doesn't share the query's script.
*/
function queryTokens(query) {
	const tokens = [];
	for (const raw of query.toLowerCase().split(/\s+/)) {
		const token = raw.replace(/^\P{L}+|\P{L}+$/gu, "");
		if (token.length >= 3 && /\p{Script=Latn}/u.test(token)) tokens.push(token);
	}
	return tokens;
}
/**
* The decoy guard: engines under IP-reputation pressure serve a
* correct-looking SERP whose results have nothing to do with the query.
* Extracted sources count as relevant when at least one query token appears
* in some title, snippet, or URL; with no usable tokens the check passes
* open-mindedly.
*/
function relevantSources(sources, query) {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return true;
	const haystack = sources.map((source) => `${source.title ?? ""} ${source.snippet ?? ""} ${source.url}`.toLowerCase()).join(" ");
	return tokens.some((token) => haystack.includes(token));
}
/**
* Turn raw in-page extraction into citeable sources: unwrap redirects, drop
* internal and non-http links, require a title, clean snippets, deduplicate
* by URL, and cap the count.
*/
function cleanSources(raw, engine, max = 15) {
	const seen = /* @__PURE__ */ new Set();
	const sources = [];
	for (const item of raw) {
		if (typeof item.url !== "string" || typeof item.title !== "string") continue;
		const url = unwrapRedirect(item.url.trim());
		if (isInternalLink(url, engine)) continue;
		const title = item.title.replace(/\s+/g, " ").trim();
		if (title.length === 0) continue;
		if (seen.has(url)) continue;
		seen.add(url);
		const snippet = cleanSnippet(item.snippet);
		sources.push({
			url,
			title,
			...snippet !== void 0 ? { snippet } : {}
		});
		if (sources.length >= max) break;
	}
	return sources;
}

//#endregion
//#region src/engines/baidu.ts
const baiduAdapter = {
	id: "baidu",
	label: "Baidu",
	defaultLocale: "zh-CN",
	homeUrl: () => "https://www.baidu.com/",
	loginUrl: () => "https://passport.baidu.com/",
	searchUrl: (_locale, query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
	searchBoxSelector: "input#kw, input[name=\"wd\"]",
	resultSelector: "#content_left .result h3 a, #content_left .c-container h3 a",
	settleMs: 4e3,
	async blockedReason(page) {
		try {
			const url = page.url();
			if (url.includes("wappass.baidu.com") || url.includes("verify")) return "security-verification";
			return await page.evaluate(() => {
				const text = document.body?.innerText ?? "";
				if (text.includes("安全验证") || text.includes("百度安全验证")) return "security-verification";
				if (text.includes("请输入验证码") || text.includes("验证码")) {
					if (document.querySelector("img[src*=\"captcha\"], .passMod_dialog-container, #seccodeImage") !== null) return "captcha";
				}
			});
		} catch {
			return;
		}
	},
	async extractSources(page) {
		const raw = await page.$$eval("#content_left .result h3 a, #content_left .c-container h3 a", (anchors) => {
			const out = [];
			for (const anchor of anchors) {
				const snippet = anchor.closest(".result, .c-container")?.querySelector(".c-abstract, [class*=\"content-right\"], .c-span-last");
				out.push({
					url: anchor.getAttribute("href") ?? "",
					title: anchor.textContent ?? "",
					...snippet?.textContent !== void 0 ? { snippet: snippet.textContent } : {}
				});
			}
			return out;
		});
		return cleanSources(raw, "baidu");
	}
};

//#endregion
//#region src/engines/bing.ts
const bingAdapter = {
	id: "bing",
	label: "Bing",
	defaultLocale: "en-US",
	homeUrl: () => "https://www.bing.com/",
	loginUrl: () => "https://login.live.com/",
	searchUrl: (_locale, query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
	searchBoxSelector: "textarea#sb_form_q, input#sb_form_q, input[name=\"q\"]",
	resultSelector: "#b_results li.b_algo",
	settleMs: 4e3,
	async prepare(page) {
		try {
			const accept = page.locator("#bnp_btn_accept, #bnp_accept_cookie, button[aria-label=\"Accept\"]").first();
			if (await accept.isVisible({ timeout: 500 })) await accept.click({ timeout: 1500 });
		} catch {}
	},
	async blockedReason(page) {
		try {
			const url = page.url();
			if (url.includes("challenges") || url.includes("/verify")) return "challenge";
			return await page.evaluate(() => {
				const text = document.body?.innerText ?? "";
				if (text.includes("are you human") || text.includes("Verify you are human")) return "captcha";
			});
		} catch {
			return;
		}
	},
	async extractSources(page) {
		const raw = await page.$$eval("#b_results li.b_algo", (items) => {
			const out = [];
			for (const item of items) {
				const link = item.querySelector("h2 a");
				if (link === null) continue;
				const snippet = item.querySelector(".b_caption p, p");
				out.push({
					url: link.getAttribute("href") ?? "",
					title: link.textContent ?? "",
					...snippet?.textContent !== void 0 ? { snippet: snippet.textContent } : {}
				});
			}
			return out;
		});
		return cleanSources(raw, "bing");
	}
};

//#endregion
//#region src/engines/duckduckgo.ts
const duckduckgoAdapter = {
	id: "duckduckgo",
	label: "DuckDuckGo",
	defaultLocale: "en-US",
	homeUrl: () => "https://duckduckgo.com/",
	loginUrl: () => "https://duckduckgo.com/",
	searchUrl: (_locale, query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
	searchBoxSelector: "input#searchbox_input, input[name=\"q\"], input[data-testid=\"searchbox-input\"]",
	resultSelector: "article[data-testid=\"result\"], #links .result, .result__body",
	settleMs: 4e3,
	async blockedReason(page) {
		try {
			return await page.evaluate(() => {
				const text = document.body?.innerText ?? "";
				if (text.includes("If this persists")) return "anomaly";
				if (document.querySelector("iframe[src*=\"captcha\"], .anomaly, [class*=\"captcha\"]") !== null) return "captcha";
				if (text.includes("are you a human") || text.includes("verify that you are human")) return "captcha";
			});
		} catch {
			return;
		}
	},
	async extractSources(page) {
		const raw = await page.$$eval("article[data-testid=\"result\"], #links .result, .result__body", (articles) => {
			const out = [];
			for (const article of articles) {
				const link = article.querySelector("a[data-testid=\"result-title-a\"], a.result__a, a[href^=\"http\"]");
				if (link === null) continue;
				const snippet = article.querySelector("[data-result=\"snippet\"], .result__snippet");
				const href = link.getAttribute("href") ?? "";
				out.push({
					url: href,
					title: link.textContent ?? "",
					...snippet?.textContent !== void 0 ? { snippet: snippet.textContent } : {}
				});
			}
			return out;
		});
		return cleanSources(raw, "duckduckgo");
	}
};

//#endregion
//#region src/engines/google.ts
/** Consent accept-button selectors across Google's consent dialog variants. */
const CONSENT_BUTTONS = [
	"button#L2AGLb",
	"button[aria-label=\"Accept all\"]",
	"button[aria-label=\"Accept the use of cookies\"]",
	"form[action*=\"consent\"] button",
	"button:has-text(\"Accept all\")",
	"button:has-text(\"Alle akzeptieren\")",
	"button:has-text(\"Tout accepter\")",
	"button:has-text(\"Accepter tout\")",
	"button:has-text(\"全部接受\")",
	"button:has-text(\"接受全部\")",
	"button:has-text(\"Принять все\")"
];
const googleAdapter = {
	id: "google",
	label: "Google",
	defaultLocale: "en-US",
	homeUrl: () => "https://www.google.com/",
	loginUrl: () => "https://accounts.google.com/",
	searchUrl: (_locale, query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
	searchBoxSelector: "textarea[name=\"q\"], input[name=\"q\"]",
	resultSelector: "#search a h3, #rso a h3",
	settleMs: 6e3,
	async prepare(page) {
		for (const selector of CONSENT_BUTTONS) try {
			const button = page.locator(selector).first();
			if (await button.isVisible({ timeout: 400 })) {
				await button.click({ timeout: 1500 });
				await page.waitForLoadState("domcontentloaded").catch(() => {});
				return;
			}
		} catch {}
	},
	async blockedReason(page) {
		try {
			const url = page.url();
			if (url.includes("/sorry/") || url.includes("/svc/captcha")) return "captcha";
			return await page.evaluate(() => {
				const text = document.body?.innerText ?? "";
				if (document.querySelector("iframe[src*=\"recaptcha\"], #recaptcha, g-recaptcha") !== null) return "captcha";
				if (text.includes("unusual traffic") || text.includes("not a robot")) return "unusual-traffic";
				if (text.includes("Before you continue to Google") || text.includes("before you continue")) return "consent-wall";
			});
		} catch {
			return;
		}
	},
	async extractSources(page) {
		const raw = await page.$$eval("#search a[href], #rso a[href]", (anchors) => {
			const out = [];
			for (const anchor of anchors) {
				const heading = anchor.querySelector("h3");
				if (heading === null) continue;
				const snippet = (heading.closest("div[data-snhf]") ?? heading.parentElement?.parentElement ?? null)?.textContent ?? void 0;
				out.push({
					url: anchor.getAttribute("href") ?? "",
					title: heading.textContent ?? "",
					...snippet !== void 0 ? { snippet } : {}
				});
			}
			return out;
		});
		return cleanSources(raw, "google");
	}
};

//#endregion
//#region src/engines/sogou.ts
const sogouAdapter = {
	id: "sogou",
	label: "Sogou",
	defaultLocale: "zh-CN",
	homeUrl: () => "https://www.sogou.com/",
	loginUrl: () => "https://account.sogou.com/",
	searchUrl: (_locale, query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
	searchBoxSelector: "input#query, input[name=\"query\"]",
	resultSelector: ".results .vrwrap h3 a, .results .rb h3 a, .result h3 a",
	settleMs: 4e3,
	async blockedReason(page) {
		try {
			const url = page.url();
			if (url.includes("antirobot") || url.includes("captcha.sogou.com")) return "antirobot";
			return await page.evaluate(() => {
				const text = document.body?.innerText ?? "";
				if (text.includes("请输入验证码") || text.includes("请输入图片验证码")) return "captcha";
				if (document.querySelector("img[src*=\"captcha\"], #seccodeImage, .code-img") !== null && text.includes("验证")) return "captcha";
			});
		} catch {
			return;
		}
	},
	async extractSources(page) {
		const raw = await page.$$eval(".results .vrwrap h3 a, .results .rb h3 a, .result h3 a", (anchors) => {
			const out = [];
			for (const anchor of anchors) {
				const snippet = anchor.closest(".vrwrap, .rb, .result")?.querySelector(".str-text-info, .str_info, .space-txt, p");
				out.push({
					url: anchor.getAttribute("href") ?? "",
					title: anchor.textContent ?? "",
					...snippet?.textContent !== void 0 ? { snippet: snippet.textContent } : {}
				});
			}
			return out;
		});
		return cleanSources(raw, "sogou");
	}
};

//#endregion
//#region src/engines/index.ts
/** Every shipped adapter. */
const ADAPTERS = /* @__PURE__ */ new Map([
	[googleAdapter.id, googleAdapter],
	[duckduckgoAdapter.id, duckduckgoAdapter],
	[bingAdapter.id, bingAdapter],
	[baiduAdapter.id, baiduAdapter],
	[sogouAdapter.id, sogouAdapter]
]);

//#endregion
//#region src/dsh.ts
/** A machine-routable failure thrown by the provider when every engine failed. */
var HumanSearchError = class extends Error {
	code;
	constructor(message, code) {
		super(message);
		this.name = "HumanSearchError";
		this.code = code;
	}
};
/** The engine ids this plugin ships, in the default order. */
const ENGINE_ORDER_DEFAULT = [
	"google",
	"duckduckgo",
	"bing",
	"baidu",
	"sogou"
];

//#endregion
//#region src/engines/types.ts
/** All valid engine ids. */
const ENGINE_IDS = [
	"google",
	"duckduckgo",
	"bing",
	"baidu",
	"sogou"
];
/** Whether a value is a known engine id. */
function isEngineId(value) {
	return typeof value === "string" && ENGINE_IDS.includes(value);
}

//#endregion
//#region src/settings.ts
/**
* Plugin configuration: the schemastery schema that serves three roles —
* loader-validated row config, the `web-human-search` settings namespace the
* web GUI edits, and the resolved shape the provider projects per search.
* @module dsh-human-search/settings
*/
/** Settings namespace; also the `settings.plugin.item` card key. */
const SETTINGS_NAMESPACE = "web-human-search";
/** Defaults shown in a fresh settings page before any user override. */
const DEFAULT_CONFIG = {
	engines: ENGINE_ORDER_DEFAULT.map((id) => ({
		id,
		enabled: true
	})),
	headless: true,
	locale: "",
	executablePath: "",
	perEngineTimeoutMs: 15e3,
	chainBudgetMs: 5e4,
	idleCloseMs: 3e5,
	loginCommand: ""
};
/** The schemastery schema: row config validator and settings namespace schema. */
const Config = z.object({
	engines: z.array(z.object({
		id: z.union([...ENGINE_IDS]),
		enabled: z.boolean().default(true)
	})).default(DEFAULT_CONFIG.engines),
	headless: z.boolean().default(true),
	locale: z.string().default(""),
	executablePath: z.string().default(""),
	perEngineTimeoutMs: z.number().step(1).min(1e3).max(6e4).default(15e3),
	chainBudgetMs: z.number().step(1).min(1e4).max(12e4).default(5e4),
	idleCloseMs: z.number().step(1).min(0).max(864e5).default(3e5),
	loginCommand: z.string().default("")
});
/**
* Normalize any resolved section into a safe configuration: keep known
* engines in their given order, drop duplicates, append missing engines
* (enabled) in default order so the chain never silently loses an engine.
*/
function normalizeConfig(raw) {
	const value = typeof raw === "object" && raw !== null ? raw : {};
	const seen = /* @__PURE__ */ new Set();
	const engines = [];
	for (const entry of value.engines ?? []) {
		if (entry === void 0 || !isEngineId(entry.id) || seen.has(entry.id)) continue;
		seen.add(entry.id);
		engines.push({
			id: entry.id,
			enabled: entry.enabled !== false
		});
	}
	for (const id of ENGINE_ORDER_DEFAULT) {
		if (seen.has(id)) continue;
		engines.push({
			id,
			enabled: true
		});
	}
	const num = (given, fallback) => typeof given === "number" && Number.isFinite(given) && given > 0 ? given : fallback;
	return {
		engines,
		headless: value.headless !== false,
		locale: typeof value.locale === "string" ? value.locale : "",
		executablePath: typeof value.executablePath === "string" ? value.executablePath : "",
		perEngineTimeoutMs: Math.min(num(value.perEngineTimeoutMs, DEFAULT_CONFIG.perEngineTimeoutMs), 6e4),
		chainBudgetMs: Math.min(num(value.chainBudgetMs, DEFAULT_CONFIG.chainBudgetMs), 12e4),
		idleCloseMs: num(value.idleCloseMs, DEFAULT_CONFIG.idleCloseMs),
		loginCommand: typeof value.loginCommand === "string" ? value.loginCommand : ""
	};
}
/**
* The authoritative-configuration holder. `installSection` swaps the source
* thunk when the settings service attaches; without it, the composition entry
* stays authoritative for the plugin's lifetime.
*/
var ConfigStore = class {
	source;
	constructor(base) {
		this.source = () => base;
	}
	/** Replace the authoritative source (settings scope or composition entry). */
	replace(source) {
		this.source = source;
	}
	/** The currently authoritative, normalized configuration. */
	get() {
		return normalizeConfig(this.source());
	}
};
/**
* Parse a `loginCommand` value; `undefined` when absent or malformed.
* Format: `<engineId>:<nonce>`.
*/
function parseLoginCommand(value) {
	const match = /^([a-z]+):(\d+)$/.exec(value.trim());
	if (match === null || !isEngineId(match[1])) return void 0;
	const nonce = Number(match[2]);
	return {
		engine: match[1],
		nonce
	};
}

//#endregion
export { storageStatePath as _, normalizeConfig as a, sleep as b, isEngineId as c, relevantSources as d, BrowserPool as f, resolveStateRoot as g, ensureStateLayout as h, SETTINGS_NAMESPACE as i, HumanSearchError as l, bindPlaywrightBrowsersPath as m, ConfigStore as n, parseLoginCommand as o, EngineBusyError as p, DEFAULT_CONFIG as r, ENGINE_IDS as s, Config as t, ADAPTERS as u, humanPause as v, humanType as y };