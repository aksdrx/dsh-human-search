# dsh-human-search

Human-like web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): the stock `web_search` tool is served by a **real browser driving real search engines**, with an ordered fallback chain across **Google, DuckDuckGo, Bing, Baidu, and Sogou**, CAPTCHA/account-login handoff to you, and cookies that persist per engine — used by this plugin only.

No DSH file is modified. Everything the plugin writes lives under `$DSH_HOME/web-human-search/` (profiles, cookies, optional plugin-managed Chromium). Remove the plugin and the harness is exactly as it was.

## How it works

- Registers a `human-search` provider on DSH's `ctx.web` seam and selects it as the deployment's search provider — the stock `web_search` tool, cards, and citation flow work unchanged.
- Each search launches (or reuses) a **persistent, plugin-private Chromium profile per engine**, opens the engine's home page, types the query like a person (per-character jitter, small pauses), and reads the organic results.
- The typed submit is **verified, not assumed**: the search box's value is read back (a page whose JavaScript has not hydrated yet silently swallows keystrokes), the autosuggest panel is dismissed before Enter (with it open, Enter submits a trending suggestion instead of your query), and the settled page is checked — a SERP for a different query, a "Loading…" bot-check stub, or results sharing no word with the query (a decoy SERP under IP-reputation pressure) is never trusted. Anything unusable retries once through the engine's results URL, then fails over.
- Engines are tried strictly in your configured order. Any failure — CAPTCHA or bot wall, timeout, parse failure, zero results, an engine busy with your sign-in window — fails over to the next engine. The returned result notes which engine served it and why others were skipped.
- When an engine blocks with a CAPTCHA:
  1. the search **fails over immediately** (the other engines keep answering), and
  2. the plugin opens a **headed browser window on the machine running DSH** with that engine's profile, so you can solve the CAPTCHA and optionally sign in to your account (Google account for Google, Microsoft account for Bing, Baidu passport, …).
  3. once the block clears, cookies are persisted (in the profile and as a portable `storageState` snapshot) and the engine rejoins the chain automatically.
- A blocked engine is skipped for a 10-minute cooldown after a failed sign-in attempt so the chain's budget isn't burned on it; the "Sign in" button in the settings card re-opens the window any time.

## Install

Prerequisites: a working DSH installation (`dsh` on your PATH) and Node ≥ 22.

```sh
# from GitHub
dsh plugin --profile web add github:aksdrx/dsh-human-search

# or from a local checkout (development)
dsh plugin --profile web add /path/to/dsh-human-search
```

Restart the profile (`dsh --profile web` or your usual launcher). The `web` row now selects the `human-search` provider.

### Install troubleshooting

- **pnpm blocks the install with an `allowBuilds` hint**: git-hosted plugin installs run package build scripts, which pnpm ≥ 10 blocks until allowed. Copy the exact key the dsh error prints (the full `<package>@<tarball-url>` specifier, not the bare name) under `allowBuilds` in that profile's `pnpm-workspace.yaml`, then re-run the same `add` command. The bare name also works if it's already in the file before the first `add` attempt.
- **Removing the plugin**: use the short package name, not the git specifier — `dsh plugin --profile web remove dsh-human-search`.
- **If the web GUI shows "Failed to load plugins" after an update of this plugin**: update to the latest release (`dsh plugin --profile web add github:aksdrx/dsh-human-search`) and restart, or remove the plugin to restore the GUI. (Version 0.1.0 shipped a browser bundle in the wrong module format that broke the shared plugin load; fixed from 0.1.1.)

### Browser setup

The plugin uses, in order:

1. an explicit **Browser executable** path set in the settings card (Chromium-family engines),
2. your system **Google Chrome / Microsoft Edge / Chromium**,
3. a **plugin-managed Chromium** under `$DSH_HOME/web-human-search/browsers/`.

For 3, install once per machine:

```sh
# inside the installed package directory, or in a checkout:
npm run install-browser        # runs `node lib/cli.js install-browser`
```

Headless searches prefer the plugin-managed **full Chromium** (new-headless mode — a far less bot-flagged fingerprint than the dedicated headless shell; Google serves the shell a CAPTCHA wall even signed in), with the lighter headless shell as fallback. Whichever binary wins, a `HeadlessChrome` user-agent marker — an instant bot signal, from the shell *or* from a manually configured executable — is probed once and rewritten to the headful-equivalent string automatically.

Without any browser the provider reports unavailable (stock search errors carry this hint); install one or revert the provider selection (below).

### Browser families (Firefox & WebKit)

Some engines block anything that smells like Chrome — Playwright Chromium so hard that even the headed sign-in window can't complete a Google login, DuckDuckGo with an anomaly wall keyed to the Chrome TLS fingerprint. Every engine therefore has its own **browser family** selector in the settings card:

- **Chromium** (default) — everything above; unchanged behavior and profile paths.
- **Firefox** — Playwright's own patched Firefox build: a genuinely different engine, TLS fingerprint, and everything else a bot-wall sniffs.
- **WebKit** — Playwright's patched WebKit: a third independent fingerprint. It is *not* real Safari, and engines render slightly differently in it; it's the least battle-tested path, kept as a second escape hatch.

Each family keeps its own per-engine profile directory (e.g. `profiles/bing` vs `profiles/bing-firefox`), so warmed cookies never mix. Firefox and WebKit resolve only from a plugin-managed install or the playwright registry — a system Firefox binary cannot be driven by Playwright, so the **Browser executable** setting applies to Chromium-family engines only.

Install and warm them the same way:

```sh
npm run install-browser -- firefox webkit   # managed installs under the state browsers/ dir
npm run install-browser -- chrome           # branded Google Chrome, system-wide (needs sudo on Linux);
                                            # becomes the first non-configured candidate automatically
npm run warm -- --family=firefox bing       # warm the Firefox-family profile of one engine
```

If a family's system libraries are missing, the installer prints the exact `sudo npx playwright@1.63.0 install-deps <kind>` command to run.

### First-run warm-up (recommended)

Fresh machines and datacenter/VPN IPs start with no engine reputation, which means CAPTCHAs or decoy results. Warm the profiles once, as a human, from a desktop session (WSLg/X11 on Windows counts):

```sh
# inside the installed package directory, or in a checkout:
npm run warm                       # duckduckgo, google, bing by default
npm run warm -- bing baidu sogou   # or any subset / order
```

One headed window per engine opens on the plugin's shared profile: run one search, solve any challenge that appears, optionally sign in (Google/Microsoft/Baidu accounts all raise the trust floor), then close the window to advance. Cookies persist in the profile the headless chain reuses for every future search. Set `DSH_HUMAN_SEARCH_BROWSER=/path/to/chrome` to warm with a specific binary.

### Settings

Settings → Plugins → Plugin configuration → **Human Web Search**:

- **Engine order** — reorder with ↑/↓, disable engines, and pick each engine's **browser family** (see above); the list order is the fallback order.
- **Sign in** per engine — opens the interactive window on the DSH machine immediately.
- **Run searches headless** — off shows every search in a visible window (debugging).
- **Browser executable**, **Locale**, **Per-engine timeout (ms)**.

Everything is stored in your normal DSH settings document (`$DSH_HOME/settings.yaml`, namespace `web-human-search`) and applies live.

Engine notes, learned from live validation:

- Each search types the query into the engine's own box like a person; when the typed submit verifies nothing usable — no usable search box (regional variants), a not-yet-hydrated page that swallowed it, a hijacked autosuggest suggestion — the engine's results URL is used once as a graceful fallback.
- Result links wrapped in engine redirects (Google `/url?q=`, Bing `/ck/a` base64 payloads) are unwrapped to their targets; Baidu and Sogou redirect links are kept as-is (they resolve for the reader).
- Extracted results must share at least one word with the query (for Latin-script queries). An engine under IP-reputation pressure sometimes serves a perfectly formed SERP whose results are unrelated decoys; those are treated as "no results" and the chain fails over instead of citing junk.
- Baidu and Sogou are Chinese engines and can be slow outside China; raise **Per-engine timeout (ms)** if they time out on your network.
- If an engine keeps failing on your IP, run the [warm-up](#first-run-warm-up-recommended) once — a minute of real usage builds more trust than any amount of headless retrying.

## CAPTCHA and account login

- The interactive window appears **on the machine running DSH**. When DSH runs on your desktop or laptop, that's your screen. On a headless server there is no display — the plugin logs why, keeps failing over, and you can still complete sign-ins by pointing `DSH_HOME`-based state at a machine with a display or running DSH locally once. SSH with X forwarding also works.
- You never have to give the plugin credentials: you type them into the engine's own pages, in a real browser profile owned by this plugin. Cookies persist only there.
- While a sign-in window is open, that engine's searches fail over instantly instead of queueing.

## Uninstall / revert

```sh
dsh plugin --profile web remove dsh-human-search
```

Removing the bundle also removes the `searchProvider` override (the patch layer leaves with it), restoring the stock DeepSeek-backed search. To keep the plugin installed but use the stock provider, set `web: searchProvider: deepseek-official` in the profile's `cordis.patch.yml`, or export `DSH_WEB_SEARCH_PROVIDER`. Plugin data (profiles/cookies) stays under `$DSH_HOME/web-human-search/` — delete that directory to remove every trace.

## Privacy & footprint

- Cookies, local storage, and exported `storageState` snapshots live in `$DSH_HOME/web-human-search/` (mode 0700) and are never sent anywhere except the engines they belong to. The model sees search results only — never cookies or credentials.
- The plugin performs searches exactly as rendered to a human in a browser; it does not use scraper endpoints or APIs.
- `PLAYWRIGHT_BROWSERS_PATH` is pointed at the plugin's own browsers directory inside the DSH process; a plugin-managed Chromium never touches other tooling's caches.

## Development

```sh
pnpm install
pnpm build        # lib/index.js (host) + lib/client.js (browser)
pnpm test         # unit tests (fixtures, chain logic, schema)
pnpm typecheck
```

Layout: `src/` host half (engine adapters, chain, browser pool, login coordinator, provider), `client/` settings card, `cordis.patch.yml` the bundle layer, `lib/` committed build output (git installs don't run build scripts).

The browser half builds in two steps (`pnpm build`): tsdown emits CJS, then `scripts/wrap-client.mjs` wraps it in the `window.__ModuleLoader__.load({ id, factory })` registration the dsh web shell's boot protocol requires — the shell loads plugin browser halves as classic scripts, where ESM syntax would be a SyntaxError. `tests/bundle.test.ts` guards that shape, and a real-browser check is available via `node tests/drive-gui.mjs` against a running test GUI.

Test against a local DSH checkout without touching your real profile:

```sh
dsh plugin --profile human-search-test add .
dsh --profile human-search-test          # headless one-shot; or `dsh web --profile human-search-test`
```

## Compatibility

Built and validated against DSH `0.1.5-alpha.1` (seams: `ctx.web` provider registry, `ctx.settings` namespaces, `settings.plugin.item` card slot, `dsh.bundle`/`dsh.client` package manifests). DSH is pre-1.0; if a seam changes, the plugin fails loud (and the revert above is instant) rather than silently degrading.

## License

MIT
