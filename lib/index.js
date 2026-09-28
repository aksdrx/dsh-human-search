import { _ as storageStatePath, a as normalizeConfig, b as sleep, d as relevantSources, f as BrowserPool, g as resolveStateRoot, h as ensureStateLayout, i as SETTINGS_NAMESPACE, l as HumanSearchError, m as bindPlaywrightBrowsersPath, n as ConfigStore, o as parseLoginCommand, p as EngineBusyError, r as DEFAULT_CONFIG, t as Config, u as ADAPTERS, v as humanPause, y as humanType } from "./settings-BPzka6jA.js";

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
* then settle into a wait-for-results-or-block loop. The typed submit is
* verified, not assumed — a homepage whose JavaScript has not hydrated yet
* swallows clicks and keystrokes, and an open autosuggest panel hands Enter
* to a trending suggestion — so anything unusable falls back to the engine's
* results URL once. Bounded by the pool's page timeout around the whole call.
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
	const homeUrl = page.url();
	try {
		const box = page.locator(adapter.searchBoxSelector).first();
		await box.waitFor({
			state: "visible",
			timeout: 4e3
		});
		await box.click({ timeout: 2e3 });
		await humanPause();
		await typeAndSubmit(page, box, query);
	} catch {}
	const remainingAfterTyping = budget - (Date.now() - startedAt);
	const settleMs = Math.min(adapter.settleMs + 2500, remainingAfterTyping - 500);
	if (settleMs > 0) {
		const sources = await settleForResults(page, adapter, Date.now() + settleMs, signal, query, homeUrl);
		if (sources.length > 0) return sources;
	}
	if (signal !== void 0 && signal.aborted) throw new Error("aborted");
	const remaining = budget - (Date.now() - startedAt);
	if (remaining < 1500) return [];
	await page.goto(adapter.searchUrl(locale, query), {
		waitUntil: "domcontentloaded",
		timeout: Math.max(3e3, Math.min(remaining - 1e3, 12e3))
	});
	const fallbackBlock = await adapter.blockedReason(page);
	if (fallbackBlock !== void 0) throw new BlockedError(fallbackBlock);
	const fallbackSettleMs = Math.min(adapter.settleMs + 2e3, budget - (Date.now() - startedAt) - 500);
	if (fallbackSettleMs <= 0) return [];
	return settleForResults(page, adapter, Date.now() + fallbackSettleMs, signal, query, homeUrl);
}
/** How long a results page for another query is watched before bailing. */
const WRONG_QUERY_GRACE_MS = 1500;
/** How long an un-navigated homepage is watched before bailing. */
const HOME_SILENT_GRACE_MS = 2e3;
/**
* Type the query and submit it, verifying the engine actually accepted it:
* the box's value is read back (a not-yet-hydrated page swallows keystrokes
* into nowhere), an explicit fill retries once, and the autosuggest panel is
* dismissed before Enter — with it open, Enter submits the highlighted
* trending suggestion instead of the typed query.
*/
async function typeAndSubmit(page, box, query) {
	await humanType(page, query);
	await page.keyboard.press("Escape");
	if (await readValue(box) !== query) {
		await box.fill(query, { timeout: 1500 }).catch(() => {});
		await page.keyboard.press("Escape");
		if (await readValue(box) !== query) throw new Error("the search box did not accept the query");
	}
	await humanPause();
	await page.keyboard.press("Enter");
}
/** The current value of the search box, or '' when it cannot be read. */
async function readValue(box) {
	try {
		return await box.inputValue({ timeout: 800 });
	} catch {
		return "";
	}
}
/**
* Whether a page URL is a results URL for exactly this query: any search
* parameter (q, wd, query, …) whose decoded value equals the query, in the
* query string or the hash. Catches submits that were hijacked into a
* trending suggestion and engine rewrites of the query.
*/
function urlCarriesQuery(pageUrl, query) {
	let parsed;
	try {
		parsed = new URL(pageUrl);
	} catch {
		return false;
	}
	const carried = (params) => {
		for (const value of params.values()) if (value === query) return true;
		return false;
	};
	if (carried(parsed.searchParams)) return true;
	const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
	if (!hash.includes("=")) return false;
	try {
		return carried(new URLSearchParams(hash));
	} catch {
		return false;
	}
}
/**
* Whether the current page is a bot-check interstitial stub — e.g. Bing's
* "Loading…" redirect page, which already carries decoy results that must
* never be extracted — recognized by its redirect marker or placeholder
* title.
*/
async function isInterstitial(page) {
	try {
		if (/[?&]rdr=/.test(page.url())) return true;
		const title = (await page.title()).trim().toLowerCase();
		return title.length === 0 || title.startsWith("loading");
	} catch {
		return false;
	}
}
/**
* Poll a submitted results page until organic sources for THE query parse, a
* block appears, or the deadline passes. Three page states are never
* mistaken for usable results: interstitial stubs (skipped outright), a SERP
* for a different query (an autosuggest hijack or engine rewrite — bailed on
* quickly so the results-URL fallback can re-run the real query), and
* results sharing no query token at all (a decoy SERP served on the right
* URL under IP-reputation pressure). An empty return means "nothing usable
* parsed".
*/
async function settleForResults(page, adapter, deadline, signal, query, homeUrl) {
	let wrongQuerySince;
	let homeSilentSince;
	while (Date.now() < deadline) {
		if (signal !== void 0 && signal.aborted) throw new Error("aborted");
		if (await isInterstitial(page)) {
			await sleep(350);
			continue;
		}
		const blocked = await adapter.blockedReason(page);
		if (blocked !== void 0) throw new BlockedError(blocked);
		if (await page.locator(adapter.resultSelector).count().catch(() => 0) > 0) {
			await sleep(Math.min(400, Math.max(50, adapter.settleMs / 8)));
			const sources = await adapter.extractSources(page).catch(() => []);
			if (sources.length > 0 && relevantSources(sources, query)) return sources;
			if (urlCarriesQuery(page.url(), query)) wrongQuerySince = void 0;
			else {
				wrongQuerySince ??= Date.now();
				if (Date.now() - wrongQuerySince > WRONG_QUERY_GRACE_MS) return [];
			}
		} else if (page.url() === homeUrl) {
			homeSilentSince ??= Date.now();
			if (Date.now() - homeSilentSince > HOME_SILENT_GRACE_MS) return [];
		} else homeSilentSince = void 0;
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
	* fail over immediately and never wait on the human. The episode promise
	* is failure-contained — an unexpected throw is logged, never surfaced as
	* an unhandled rejection in the host process.
	*/
	start(engine, trigger) {
		if (this.episodes.get(engine) !== void 0) {
			this.logger.info("human-search: sign-in episode for \"%s\" already running", engine);
			return;
		}
		const episode = this.run(engine, trigger).catch((error) => {
			this.logger.error("human-search: sign-in episode for \"%s\" failed: %s", engine, String(error));
		}).finally(() => {
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