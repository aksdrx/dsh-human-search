# dsh-human-search

Human-like web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): the stock `web_search` tool is served by a **real browser driving real search engines**, with an ordered fallback chain across **Google, DuckDuckGo, Bing, Baidu, and Sogou**, CAPTCHA/account-login handoff to you, and cookies that persist per engine — used by this plugin only.

No DSH file is modified. Everything the plugin writes lives under `$DSH_HOME/web-human-search/` (profiles, cookies, optional plugin-managed Chromium). Remove the plugin and the harness is exactly as it was.

## How it works

- Registers a `human-search` provider on DSH's `ctx.web` seam and selects it as the deployment's search provider — the stock `web_search` tool, cards, and citation flow work unchanged.
- Each search launches (or reuses) a **persistent, plugin-private Chromium profile per engine**, opens the engine's home page, types the query like a person (per-character jitter, small pauses), and reads the organic results.
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
dsh plugin --profile web add github:<owner>/dsh-human-search

# or from a local checkout (development)
dsh plugin --profile web add /path/to/dsh-human-search
```

Restart the profile (`dsh --profile web` or your usual launcher). The `web` row now selects the `human-search` provider.

### Browser setup

The plugin uses, in order:

1. an explicit **Browser executable** path set in the settings card,
2. your system **Google Chrome / Microsoft Edge / Chromium**,
3. a **plugin-managed Chromium** under `$DSH_HOME/web-human-search/browsers/`.

For 3, install once per machine:

```sh
# inside the installed package directory, or in a checkout:
npm run install-browser        # runs `node lib/cli.js install-browser`
```

Without any browser the provider reports unavailable (stock search errors carry this hint); install one or revert the provider selection (below).

### Settings

Settings → Plugins → Plugin configuration → **Human Web Search**:

- **Engine order** — reorder with ↑/↓, disable engines; the list order is the fallback order.
- **Sign in** per engine — opens the interactive window on the DSH machine immediately.
- **Run searches headless** — off shows every search in a visible window (debugging).
- **Browser executable**, **Locale**, **Per-engine timeout (ms)**.

Everything is stored in your normal DSH settings document (`$DSH_HOME/settings.yaml`, namespace `web-human-search`) and applies live.

Engine notes, learned from live validation:

- Each search types the query into the engine's own box like a person; when an engine renders its homepage without a usable search box (regional variants, failed hydration), the engine's results URL is used once as a graceful fallback.
- Result links wrapped in engine redirects (Google `/url?q=`, Bing `/ck/a` base64 payloads) are unwrapped to their targets; Baidu and Sogou redirect links are kept as-is (they resolve for the reader).
- Baidu and Sogou are Chinese engines and can be slow outside China; raise **Per-engine timeout (ms)** if they time out on your network.

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

Test against a local DSH checkout without touching your real profile:

```sh
dsh plugin --profile human-search-test add .
dsh --profile human-search-test          # headless one-shot; or `dsh web --profile human-search-test`
```

## Compatibility

Built and validated against DSH `0.1.5-alpha.1` (seams: `ctx.web` provider registry, `ctx.settings` namespaces, `settings.plugin.item` card slot, `dsh.bundle`/`dsh.client` package manifests). DSH is pre-1.0; if a seam changes, the plugin fails loud (and the revert above is instant) rather than silently degrading.

## License

MIT
