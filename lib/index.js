import { a as storageStatePath, i as resolveStateRoot, n as engineProfileDir, r as ensureStateLayout, t as bindPlaywrightBrowsersPath } from "./state-gsDkSrJy.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
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
	* The rewritten headful-equivalent user agent for the managed headless
	* shell, learned once from the first probe so later engines launch in a
	* single step; `undefined until probed` is tracked separately from
	* "probe decided no rewrite is needed".
	*/
	managedUaFix;
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
		try {
			return existsSync(chromium.executablePath());
		} catch {
			return false;
		}
	}
	/**
	* Launch candidates in preference order. Headless searches prefer the
	* system browsers, then the plugin-managed headless shell; a headed
	* sign-in window needs the full browser binary.
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
		const managed = resolveManagedExecutable(this.layout.browsersRoot, !headed);
		if (managed !== void 0) list.push({
			label: headed ? "plugin-managed Chromium" : "plugin-managed headless shell",
			options: { executablePath: managed },
			managed: true
		});
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
	/**
	* Launch (or reuse) the engine's persistent headless context. Managed
	* Chromium in headless mode reports a `HeadlessChrome` user agent, an
	* instant bot signal, so one probe relaunches with the headful-equivalent
	* agent string when needed.
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
		let lastError;
		for (const candidate of this.candidates(config, headed)) try {
			let userAgent = candidate.options.userAgent;
			if (candidate.managed === true && !headed && config.headless && this.managedUaFix !== null) {
				if (this.managedUaFix !== void 0) userAgent = this.managedUaFix;
			}
			let context = await chromium.launchPersistentContext(userDataDir, {
				...candidate.options,
				...userAgent !== void 0 ? { userAgent } : {},
				headless: headed ? false : config.headless,
				locale,
				viewport
			});
			if (candidate.managed === true && !headed && config.headless && this.managedUaFix === void 0) {
				const probe = await this.probeManagedHeadlessUa(context);
				this.managedUaFix = probe;
				if (probe !== null) {
					await context.close().catch(() => {});
					context = await chromium.launchPersistentContext(userDataDir, {
						...candidate.options,
						userAgent: probe,
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
	* Read a freshly launched managed headless context's real user agent and,
	* when it carries a `Headless` marker, return the headful-equivalent agent
	* string (same version and platform tokens) for every later launch. Runs
	* once per pool; `null` means no rewrite is needed.
	*/
	async probeManagedHeadlessUa(context) {
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
			return await Promise.race([operation(page), sleep(timeoutMs).then(() => {
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
function hostOf$1(url) {
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
	const host = hostOf$1(url);
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
//#region src/chain.ts
/**
* The fallback chain: drives one human-like search per engine, strictly in
* the user's order, inside a shared deadline. Every failure mode — CAPTCHA or
* bot wall, timeout, parse failure, zero results, a profile held by an open
* sign-in window — classifies the attempt and moves to the next engine; a
* CAPTCHA additionally triggers the (asynchronous, non-blocking) login
* episode for that engine.
* @module dsh-human-search/chain
*/
/** Raised inside the driver when a settled page carries block signals. */
var BlockedError = class extends Error {
	reason;
	constructor(reason) {
		super(`blocked: ${reason}`);
		this.name = "BlockedError";
		this.reason = reason;
	}
};
/**
* Run the ordered fallback chain for one query. Never throws: every engine
* failure is recorded and the chain moves on; an empty result means every
* engine failed (or the budget ran out).
*/
async function runSearchChain(deps, order, query, maxResults, signal) {
	const config = deps.store.get();
	const deadline = Date.now() + config.chainBudgetMs;
	const attempts = [];
	const cap = maxResults > 0 ? maxResults : 15;
	for (const engine of order) {
		if (signal?.aborted === true) break;
		const remaining = deadline - Date.now();
		if (remaining < 1500) break;
		const adapter = deps.adapters.get(engine);
		if (adapter === void 0) continue;
		if (!deps.health.shouldTry(engine)) {
			attempts.push({
				engine,
				outcome: "skipped",
				detail: "blocked; awaiting sign-in or cooldown",
				ms: 0,
				sources: 0
			});
			continue;
		}
		const budget = Math.min(config.perEngineTimeoutMs, remaining);
		const locale = config.locale.length > 0 ? config.locale : adapter.defaultLocale;
		const started = Date.now();
		try {
			const sources = await deps.pool.withHeadlessPage(engine, budget, async (page) => driveOneSearch(page, adapter, query, locale, budget, signal));
			const ms = Date.now() - started;
			if (sources.length === 0) {
				attempts.push({
					engine,
					outcome: "empty",
					detail: "no organic results parsed",
					ms,
					sources: 0
				});
				continue;
			}
			deps.health.markOk(engine);
			attempts.push({
				engine,
				outcome: "ok",
				detail: void 0,
				ms,
				sources: sources.length
			});
			const truncated = sources.length > cap;
			return {
				attempts,
				sources: truncated ? sources.slice(0, cap) : sources,
				servedBy: engine,
				truncated
			};
		} catch (error) {
			const ms = Date.now() - started;
			const record = (outcome, detail) => {
				attempts.push({
					engine,
					outcome,
					detail,
					ms,
					sources: 0
				});
			};
			if (error instanceof EngineBusyError) {
				record("busy", "profile held by the open sign-in window");
				continue;
			}
			if (error instanceof BlockedError) {
				record("blocked", error.reason);
				deps.health.markBlocked(engine, error.reason);
				deps.logins.start(engine, "auto");
				continue;
			}
			if (signal !== void 0 && signal.aborted) {
				record("error", "aborted");
				break;
			}
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("timed out") || message.includes("TimeoutError")) record("timeout", message);
			else {
				record("error", message);
				deps.logger.info("human-search: engine \"%s\" attempt failed: %s", engine, message);
			}
		}
	}
	return {
		attempts,
		sources: [],
		servedBy: void 0,
		truncated: false
	};
}
/**
* Drive one human-like search on an engine page: open the engine's home,
* dismiss consent walls, find the search box, type like a person, submit,
* then settle into a wait-for-results-or-block loop. When the homepage never
* offers a usable search box (regional variants, failed hydration), fall
* back to the engine's results URL once. Bounded by the pool's page timeout
* around the whole call.
*/
async function driveOneSearch(page, adapter, query, locale, budget, signal) {
	const startedAt = Date.now();
	signal?.throwIfAborted();
	const navTimeout = Math.max(3e3, Math.min(budget - 1500, 12e3));
	await page.goto(adapter.homeUrl(locale), {
		waitUntil: "domcontentloaded",
		timeout: navTimeout
	});
	await adapter.prepare?.(page);
	const initialBlock = await adapter.blockedReason(page);
	if (initialBlock !== void 0) throw new BlockedError(initialBlock);
	let typed = false;
	try {
		const box = page.locator(adapter.searchBoxSelector).first();
		await box.waitFor({
			state: "visible",
			timeout: 4e3
		});
		await box.click({ timeout: 2e3 });
		await humanPause();
		await humanType(page, query);
		await page.keyboard.press("Enter");
		typed = true;
	} catch {
		typed = false;
	}
	const settleMs = Math.min(adapter.settleMs + 2500, budget);
	const sources = await settleForResults(page, adapter, Date.now() + settleMs, signal);
	if (sources.length > 0 || typed) return sources;
	if (signal !== void 0 && signal.aborted) throw new Error("aborted");
	const remaining = budget - (Date.now() - startedAt);
	if (remaining < 1500) return sources;
	await page.goto(adapter.searchUrl(locale, query), {
		waitUntil: "domcontentloaded",
		timeout: Math.max(3e3, Math.min(remaining - 1e3, 12e3))
	});
	const fallbackBlock = await adapter.blockedReason(page);
	if (fallbackBlock !== void 0) throw new BlockedError(fallbackBlock);
	return settleForResults(page, adapter, Date.now() + Math.min(adapter.settleMs + 2e3, remaining), signal);
}
/**
* Poll a submitted results page until organic sources parse, a block
* appears, or the deadline passes; an empty return means "nothing parsed".
*/
async function settleForResults(page, adapter, deadline, signal) {
	while (Date.now() < deadline) {
		if (signal !== void 0 && signal.aborted) throw new Error("aborted");
		const blocked = await adapter.blockedReason(page);
		if (blocked !== void 0) throw new BlockedError(blocked);
		if (await page.locator(adapter.resultSelector).count().catch(() => 0) > 0) {
			await sleep(Math.min(400, Math.max(50, adapter.settleMs / 8)));
			const sources = await adapter.extractSources(page).catch(() => []);
			if (sources.length > 0) return sources;
		}
		await sleep(350);
	}
	return [];
}

//#endregion
//#region src/health.ts
/** How long a blocked engine is skipped before the chain retries it. */
const BLOCKED_RETRY_MS = 6e5;
/** Per-engine health bookkeeping; trivially concurrent-safe via immutability. */
var HealthRegistry = class {
	logger;
	entries = /* @__PURE__ */ new Map();
	constructor(logger) {
		this.logger = logger;
	}
	set(engine, state, reason) {
		this.entries.set(engine, {
			engine,
			state,
			reason,
			since: Date.now()
		});
	}
	/** Record a successful search. */
	markOk(engine) {
		this.set(engine, "ok");
	}
	/** Record a block (CAPTCHA, bot wall) with its reason. */
	markBlocked(engine, reason) {
		this.set(engine, "blocked", reason);
		this.logger.info("human-search: engine \"%s\" marked blocked (%s)", engine, reason);
	}
	/** Record that an interactive sign-in episode started. */
	markSigningIn(engine) {
		this.set(engine, "signing-in");
	}
	/** Whether the chain should attempt this engine right now. */
	shouldTry(engine) {
		const entry = this.entries.get(engine);
		if (entry === void 0) return true;
		if (entry.state !== "blocked") return true;
		return Date.now() - entry.since >= BLOCKED_RETRY_MS;
	}
	/** Current health snapshot for notes and diagnostics. */
	snapshot() {
		return [...this.entries.values()];
	}
	/** Whether an engine currently has an interactive window open. */
	isSigningIn(engine) {
		return this.entries.get(engine)?.state === "signing-in";
	}
};

//#endregion
//#region src/login.ts
/** How long a headed episode waits for the user before giving up. */
const EPISODE_TIMEOUT_MS = 6e5;
/** Poll cadence while watching the headed page. */
const POLL_INTERVAL_MS = 2e3;
/** After this long parked on the login host, gently steer to the engine. */
const NUDGE_AFTER_MS = 6e4;
var LoginCoordinator = class {
	pool;
	health;
	store;
	layout;
	adapters;
	logger;
	episodes = /* @__PURE__ */ new Map();
	disposed = false;
	constructor(pool, health, store, layout, adapters, logger) {
		this.pool = pool;
		this.health = health;
		this.store = store;
		this.layout = layout;
		this.adapters = adapters;
		this.logger = logger;
	}
	/**
	* Start (or join) the engine's sign-in episode. Fire-and-forget: searches
	* fail over immediately and never wait on the human.
	*/
	start(engine, trigger) {
		if (this.episodes.get(engine) !== void 0) {
			this.logger.info("human-search: sign-in episode for \"%s\" already running", engine);
			return;
		}
		const episode = this.run(engine, trigger).finally(() => {
			this.episodes.delete(engine);
		});
		this.episodes.set(engine, episode);
	}
	/** Whether any engine currently has an interactive window open. */
	hasPendingWindow() {
		return this.episodes.size > 0;
	}
	/** Stop accepting new episodes and let watchers exit; called at dispose. */
	dispose() {
		this.disposed = true;
	}
	async run(engine, trigger) {
		const adapter = this.adapters.get(engine);
		if (adapter === void 0) return;
		this.health.markSigningIn(engine);
		const config = this.store.get();
		const locale = config.locale.length > 0 ? config.locale : adapter.defaultLocale;
		let session;
		try {
			session = await this.pool.openHeaded(engine);
		} catch (error) {
			this.health.markBlocked(engine, `cannot open sign-in window (${String(error)})`);
			this.logger.warn("human-search: could not open a sign-in window for \"%s\" (trigger: %s): %s — an interactive login needs a display on the machine running DSH", engine, trigger, String(error));
			return;
		}
		this.logger.warn("human-search: opened a sign-in window for \"%s\" (trigger: %s). Solve the CAPTCHA and/or sign in there; searches keep running on the other engines meanwhile.", engine, trigger);
		try {
			await session.page.goto(adapter.loginUrl(locale), {
				waitUntil: "domcontentloaded",
				timeout: 3e4
			}).catch((error) => this.logger.warn("human-search: login navigation: %s", String(error)));
			const outcome = await this.waitForClearance(session, adapter, locale);
			if (this.disposed || outcome === "closed") {
				this.health.markBlocked(engine, "sign-in window closed before the block cleared");
				return;
			}
			if (outcome === "timeout") {
				this.health.markBlocked(engine, "sign-in window timed out");
				return;
			}
			await session.page.context().storageState({ path: storageStatePath(this.layout, engine) }).catch((error) => this.logger.warn("human-search: storageState export for \"%s\": %s", engine, String(error)));
			this.health.markOk(engine);
			this.logger.info("human-search: sign-in for \"%s\" complete; cookies persisted for future searches", engine);
		} finally {
			await this.pool.releaseHeaded(engine, session);
		}
	}
	/**
	* Watch the headed page until the block clears, the user closes the
	* window, or the episode times out. Clearance means: the page has left the
	* login host (or never was on one) and no blocked-signals remain.
	*/
	async waitForClearance(session, adapter, locale) {
		const started = Date.now();
		let nudged = false;
		const loginHost = hostOf(adapter.loginUrl(locale));
		const homeHost = hostOf(adapter.homeUrl(locale));
		while (Date.now() - started < EPISODE_TIMEOUT_MS) {
			if (this.disposed) return "closed";
			if (session.page.isClosed() || session.page.context().pages().length === 0) return "closed";
			try {
				const url = session.page.url();
				if (!(loginHost !== homeHost && hostOf(url) === loginHost)) {
					if (await adapter.blockedReason(session.page) === void 0) return "cleared";
				} else if (!nudged && Date.now() - started > NUDGE_AFTER_MS) {
					nudged = true;
					await session.page.goto(adapter.homeUrl(locale), {
						waitUntil: "domcontentloaded",
						timeout: 2e4
					}).catch(() => {});
				}
			} catch {}
			await Promise.race([sleep(POLL_INTERVAL_MS), session.whenClosed]);
		}
		return "timeout";
	}
};
/** Hostname of a URL, lowercase; '' when malformed. */
function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

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
//#region src/provider.ts
/**
* The `human-search` web search provider: presents the fallback chain on the
* `ctx.web` seam. Provenance travels in `content` — the serving engine, the
* fallback trail, and any interactive sign-in window the user should know
* about — while `sources` stays the portable citation shape the seam and the
* stock `web_search` tool already render.
* @module dsh-human-search/provider
*/
/** The provider id configured as `searchProvider` on the `web` seam row. */
const PROVIDER_ID = "human-search";
var HumanSearchProvider = class {
	deps;
	id = PROVIDER_ID;
	constructor(deps) {
		this.deps = deps;
	}
	available() {
		return this.deps.pool.hasUsableBrowser();
	}
	async search(request, signal) {
		const order = this.deps.store.get().engines.filter((entry) => entry.enabled).map((entry) => entry.id);
		if (order.length === 0) throw new HumanSearchError("human-search: no search engines are enabled — enable at least one in Settings → Plugins → Human Web Search", "HUMAN_SEARCH_NO_ENGINES");
		const chain = await runSearchChain(this.deps, order, request.query, request.maxResults ?? 0, signal);
		if (chain.servedBy !== void 0) {
			const content = renderProvenance(this.deps, chain.attempts, chain.servedBy, this.deps.logins);
			return {
				...content !== void 0 ? { content } : {},
				sources: chain.sources,
				truncated: chain.truncated
			};
		}
		throw new HumanSearchError(renderAllFailed(chain.attempts, this.available()), "HUMAN_SEARCH_ALL_ENGINES_FAILED");
	}
};
/** Human label for an engine id. */
function labelOf(deps, engine) {
	return deps.adapters.get(engine)?.label ?? engine;
}
/**
* One short provenance note for a successful search: the serving engine and,
* only when something noteworthy happened on the way, the trail.
*/
function renderProvenance(deps, attempts, servedBy, logins) {
	const trail = attempts.filter((attempt) => attempt.engine !== servedBy || attempt.outcome !== "ok").map((attempt) => `${labelOf(deps, attempt.engine)}: ${attempt.outcome}${attempt.detail !== void 0 ? ` (${attempt.detail})` : ""}`);
	let note = `Human web search served by ${labelOf(deps, servedBy)}.`;
	if (trail.length > 0) note += ` Skipped: ${trail.join("; ")}.`;
	if (logins.hasPendingWindow()) note += " An interactive sign-in window is open on the machine running DSH — the user can complete it there; searches keep working on the other engines.";
	return note;
}
/** The all-engines-failed error text with per-engine reasons and a fix hint. */
function renderAllFailed(attempts, browserAvailable) {
	const lines = attempts.map((attempt) => {
		const detail = attempt.detail !== void 0 ? ` — ${attempt.detail}` : "";
		return `- ${attempt.engine}: ${attempt.outcome}${detail}`;
	});
	const hint = browserAvailable ? "Hint: engines commonly block datacenter IPs; try again, complete a sign-in from the plugin settings card, or reorder engines." : "Hint: no usable browser was found. Install one with `npm run install-browser` in the dsh-human-search package (plugin-managed Chromium), or set executablePath in Settings → Plugins → Human Web Search.";
	return `human-search: every engine failed.\n${lines.join("\n")}\n${hint}`;
}

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
//#region src/index.ts
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
/** Cordis plugin name used by loader diagnostics. */
const name = "web-human-search";
/** The web seam is a hard dependency; nothing works without it. */
const inject = ["web"];
/**
* Mount the plugin: provider on the seam, settings namespace when the
* settings service is present (composition config remains authoritative
* without it), and full teardown of every browser at dispose.
*/
function apply(ctx, config) {
	const store = new ConfigStore(config);
	const layout = ensureStateLayout();
	bindPlaywrightBrowsersPath(layout);
	const pool = new BrowserPool(store, layout, ADAPTERS, ctx.logger);
	const health = new HealthRegistry(ctx.logger);
	const logins = new LoginCoordinator(pool, health, store, layout, ADAPTERS, ctx.logger);
	const provider = new HumanSearchProvider({
		store,
		pool,
		adapters: ADAPTERS,
		health,
		logins,
		logger: ctx.logger
	});
	const web = ctx.get("web");
	if (web === void 0) ctx.logger.warn("human-search: the web seam (ctx.web) is not available; the provider was not registered");
	else web.registerSearchProvider(provider);
	ctx.inject(["settings"], (scopeCtx) => {
		const settings = scopeCtx.get("settings");
		if (settings === void 0) return;
		let lastNonce = -1;
		settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
			setSource: (current) => {
				store.replace(current);
			},
			onChange: () => {
				pool.onConfigChange();
				const current = store.get();
				const command = parseLoginCommand(current.loginCommand);
				if (command !== void 0 && command.nonce !== lastNonce) {
					lastNonce = command.nonce;
					logins.start(command.engine, "manual");
					settings.update(SETTINGS_NAMESPACE, { loginCommand: "" }).catch((error) => {
						ctx.logger.warn("human-search: clearing the login command failed: %s", String(error));
					});
				}
			}
		});
		if (parseLoginCommand(store.get().loginCommand) !== void 0) settings.update(SETTINGS_NAMESPACE, { loginCommand: "" }).catch(() => {});
	});
	ctx.effect(() => () => {
		logins.dispose();
		pool.closeAll();
	}, "human-search: browser teardown");
}

//#endregion
export { ADAPTERS, BrowserPool, Config, DEFAULT_CONFIG, HealthRegistry, HumanSearchProvider, LoginCoordinator, PROVIDER_ID, SETTINGS_NAMESPACE, apply, ensureStateLayout, inject, name, normalizeConfig, parseLoginCommand, resolveStateRoot, runSearchChain };