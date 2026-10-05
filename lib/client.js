window.__ModuleLoader__.load({
	id: "dsh-human-search",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		let react = require("react");
		
		//#region client/index.ts
		/**
		* dsh-human-search — the browser half: the "Human Web Search" card in
		* Settings → Plugins → Plugin configuration, keyed by this plugin's settings
		* namespace. The card owns engine ordering (the array order is the fallback
		* order), per-engine enable toggles and sign-in buttons, and the shared
		* behavior fields. Self-contained by design: the only module request is
		* `react`, which the dsh web shell supplies; everything else goes through
		* the client `settingsScope` service.
		* @module dsh-human-search/client
		*/
		/** Engine ids and labels, mirrored from the host half (no cross-face imports). */
		const ENGINES = [
			{
				id: "google",
				label: "Google"
			},
			{
				id: "duckduckgo",
				label: "DuckDuckGo"
			},
			{
				id: "bing",
				label: "Bing"
			},
			{
				id: "baidu",
				label: "Baidu"
			},
			{
				id: "sogou",
				label: "Sogou"
			}
		];
		/** Selectable browser families, mirrored from the host half. */
		const FAMILIES = [
			{
				id: "chromium",
				label: "Chromium"
			},
			{
				id: "firefox",
				label: "Firefox"
			},
			{
				id: "webkit",
				label: "WebKit"
			}
		];
		/** The plugin's settings namespace (also the card's slot key). */
		const NAMESPACE = "web-human-search";
		/** Required client services. */
		const inject = ["slots", "settingsScope"];
		/**
		* Mount the card: bind the namespace scope and register under the Plugins
		* section's keyed card slot, so the tab pairs this card with the namespace
		* the host plugin serves.
		*/
		function apply(ctx) {
			const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					key: NAMESPACE
				}, () => (0, react.createElement)(HumanSearchCard, { scope }));
			});
		}
		/** Normalize a raw browser value to a selectable family. */
		function familyOf(value) {
			return FAMILIES.some((family) => family.id === value) ? value : "chromium";
		}
		/** Build a draft from a resolved section. */
		function draftOf(section) {
			return {
				engines: (section?.engines ?? ENGINES.map((engine) => ({
					id: engine.id,
					enabled: true,
					browser: "chromium"
				}))).filter((entry) => ENGINES.some((engine) => engine.id === entry.id)).map((entry) => ({
					id: entry.id,
					enabled: entry.enabled !== false,
					browser: familyOf(entry.browser)
				})),
				headless: section?.headless !== false,
				locale: section?.locale ?? "",
				executablePath: section?.executablePath ?? "",
				perEngineTimeoutMs: String(section?.perEngineTimeoutMs ?? 1e4)
			};
		}
		/** Whether a draft differs from the section it came from. */
		function isDirty(draft, section) {
			return JSON.stringify(draft) !== JSON.stringify(draftOf(section));
		}
		/** The card component. */
		function HumanSearchCard({ scope }) {
			const snapshot = (0, react.useSyncExternalStore)(scope.subscribe, scope.getSnapshot);
			const [draft, setDraft] = (0, react.useState)(null);
			const [requested, setRequested] = (0, react.useState)("");
			const section = snapshot.value;
			const effective = draft ?? (0, react.useMemo)(() => draftOf(section), [section]);
			const disabled = !snapshot.writable;
			(0, react.useEffect)(() => {
				if (draft !== null && section === void 0) setDraft(null);
			}, [section, draft]);
			const save = (0, react.useCallback)(async () => {
				if (draft === null) return;
				const perEngine = Number(draft.perEngineTimeoutMs);
				await scope.mutate([
					{
						op: "set",
						path: ["engines"],
						value: draft.engines
					},
					{
						op: "set",
						path: ["headless"],
						value: draft.headless
					},
					{
						op: "set",
						path: ["locale"],
						value: draft.locale
					},
					{
						op: "set",
						path: ["executablePath"],
						value: draft.executablePath
					},
					{
						op: "set",
						path: ["perEngineTimeoutMs"],
						value: Number.isFinite(perEngine) && perEngine >= 1e3 ? Math.round(perEngine) : 1e4
					}
				], snapshot.revision);
				setDraft(null);
			}, [
				draft,
				scope,
				snapshot.revision
			]);
			const signIn = (0, react.useCallback)(async (engine) => {
				setRequested(engine);
				await scope.set("loginCommand", `${engine}:${Date.now()}`);
				setTimeout(() => setRequested(""), 2500);
			}, [scope]);
			if (snapshot.status === "loading") return (0, react.createElement)("div", { style: cardStyle() }, (0, react.createElement)("p", null, "Loading human web search settings…"));
			if (snapshot.status === "unavailable" || section === void 0) return (0, react.createElement)("div", { style: cardStyle() }, (0, react.createElement)("p", null, `The host does not serve the "${NAMESPACE}" settings namespace; the dsh-human-search plugin is not loaded.`));
			const overridden = (field) => Object.prototype.hasOwnProperty.call(snapshot.user ?? {}, field);
			const dirty = draft !== null && isDirty(draft, section);
			return (0, react.createElement)("div", { style: cardStyle() }, (0, react.createElement)("h3", { style: {
				margin: "0 0 4px",
				fontSize: "1rem"
			} }, "Human Web Search"), (0, react.createElement)("p", { style: {
				margin: "0 0 12px",
				opacity: .75,
				fontSize: "0.85rem"
			} }, "Searches the web through real engines in a real browser, in this order, falling over to the next engine on any failure. Use \"Sign in\" to open a window for CAPTCHA or account login; cookies stay on this machine, for this plugin only."), (0, react.createElement)(EngineList, {
				engines: effective.engines,
				disabled,
				requested,
				onMove: (index, delta) => {
					if (draft === null) return;
					const engines = [...draft.engines];
					const target = index + delta;
					if (target < 0 || target >= engines.length) return;
					const [entry] = engines.splice(index, 1);
					engines.splice(target, 0, entry);
					setDraft({
						...draft,
						engines
					});
				},
				onToggle: (index) => {
					if (draft === null) return;
					const engines = draft.engines.map((entry, at) => at === index ? {
						...entry,
						enabled: !entry.enabled
					} : entry);
					setDraft({
						...draft,
						engines
					});
				},
				onBrowser: (index, browser) => {
					if (draft === null) return;
					const engines = draft.engines.map((entry, at) => at === index ? {
						...entry,
						browser
					} : entry);
					setDraft({
						...draft,
						engines
					});
				},
				onSignIn: (engine) => {
					signIn(engine);
				}
			}), (0, react.createElement)("p", { style: {
				margin: "0 0 6px",
				fontSize: "0.85rem"
			} }, `Engine order${overridden("engines") ? " · overridden" : ""} — tried top to bottom; disable an engine, pick its browser family, or reorder with the arrows. Firefox and WebKit need a one-time install (Settings hint: run \`npm run install-browser firefox webkit\` in the package).`), (0, react.createElement)(CheckField, {
				label: `Run searches headless${overridden("headless") ? " · overridden" : ""}`,
				hint: "Turn off to watch every search in a visible browser window.",
				checked: effective.headless,
				disabled,
				onChange: (checked) => {
					if (draft !== null) setDraft({
						...draft,
						headless: checked
					});
				}
			}), (0, react.createElement)(TextField, {
				label: `Browser executable${overridden("executablePath") ? " · overridden" : ""}`,
				hint: "Optional absolute path to a Chrome/Chromium/Edge binary for Chromium-family engines; empty uses system browsers, then the plugin-managed Chromium.",
				value: effective.executablePath,
				disabled,
				placeholder: "/usr/bin/google-chrome",
				onChange: (text) => {
					if (draft !== null) setDraft({
						...draft,
						executablePath: text
					});
				}
			}), (0, react.createElement)(TextField, {
				label: `Locale${overridden("locale") ? " · overridden" : ""}`,
				hint: "Optional locale for every engine (e.g. en-US, zh-CN); empty uses each engine's default.",
				value: effective.locale,
				disabled,
				placeholder: "en-US",
				onChange: (text) => {
					if (draft !== null) setDraft({
						...draft,
						locale: text
					});
				}
			}), (0, react.createElement)(TextField, {
				label: `Per-engine timeout (ms)${overridden("perEngineTimeoutMs") ? " · overridden" : ""}`,
				hint: "How long one engine may take before the chain moves on (1000–60000).",
				value: effective.perEngineTimeoutMs,
				disabled,
				placeholder: "10000",
				numeric: true,
				onChange: (text) => {
					if (draft !== null) setDraft({
						...draft,
						perEngineTimeoutMs: text
					});
				}
			}), (0, react.createElement)("div", { style: {
				display: "flex",
				gap: "8px",
				marginTop: "14px"
			} }, (0, react.createElement)("button", {
				type: "button",
				disabled: disabled || !dirty,
				onClick: () => {
					save();
				},
				style: buttonStyle(disabled || !dirty)
			}, "Save"), (0, react.createElement)("button", {
				type: "button",
				disabled: disabled || !dirty,
				onClick: () => setDraft(null),
				style: buttonStyle(disabled || !dirty)
			}, "Discard"), !snapshot.writable ? (0, react.createElement)("span", { style: {
				alignSelf: "center",
				opacity: .7,
				fontSize: "0.8rem"
			} }, "settings are read-only here") : null));
		}
		/** The ordered engine editor with toggles, browser-family selectors, reorder arrows, and sign-in buttons. */
		function EngineList(props) {
			return (0, react.createElement)("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				marginBottom: "6px"
			} }, props.engines.map((entry, index) => {
				const label = ENGINES.find((engine) => engine.id === entry.id)?.label ?? entry.id;
				return (0, react.createElement)("div", {
					key: entry.id,
					style: {
						display: "flex",
						alignItems: "center",
						gap: "8px",
						padding: "6px 8px",
						border: "1px solid rgba(128,128,128,0.35)",
						borderRadius: "6px"
					}
				}, (0, react.createElement)("input", {
					type: "checkbox",
					checked: entry.enabled,
					disabled: props.disabled,
					title: "Include this engine in the chain",
					onChange: () => props.onToggle(index)
				}), (0, react.createElement)("span", { style: {
					minWidth: "96px",
					textDecoration: entry.enabled ? "none" : "line-through",
					opacity: entry.enabled ? 1 : .55
				} }, `${index + 1}. ${label}`), (0, react.createElement)("select", {
					value: entry.browser,
					disabled: props.disabled,
					title: "Browser family for this engine's searches and sign-in windows",
					onChange: (event) => props.onBrowser(index, event.target.value),
					style: {
						...inputStyle(),
						width: "auto",
						padding: "4px 6px"
					}
				}, FAMILIES.map((family) => (0, react.createElement)("option", {
					key: family.id,
					value: family.id
				}, family.label))), (0, react.createElement)("button", {
					type: "button",
					disabled: props.disabled || index === 0,
					onClick: () => props.onMove(index, -1),
					style: buttonStyle(props.disabled || index === 0),
					title: "Move up"
				}, "↑"), (0, react.createElement)("button", {
					type: "button",
					disabled: props.disabled || index === props.engines.length - 1,
					onClick: () => props.onMove(index, 1),
					style: buttonStyle(props.disabled || index === props.engines.length - 1),
					title: "Move down"
				}, "↓"), (0, react.createElement)("button", {
					type: "button",
					disabled: props.disabled,
					onClick: () => props.onSignIn(entry.id),
					style: buttonStyle(props.disabled),
					title: "Open a sign-in window for this engine on the machine running DSH"
				}, props.requested === entry.id ? "Window requested…" : "Sign in"));
			}));
		}
		/** A labeled field wrapper. */
		function Field(props) {
			return (0, react.createElement)("label", { style: {
				display: "block",
				margin: "10px 0"
			} }, (0, react.createElement)("span", { style: {
				display: "block",
				fontSize: "0.85rem",
				marginBottom: "2px"
			} }, props.label), props.children, props.hint !== void 0 ? (0, react.createElement)("span", { style: {
				display: "block",
				opacity: .65,
				fontSize: "0.78rem",
				marginTop: "2px"
			} }, props.hint) : null);
		}
		/** A text (or numeric) input field. */
		function TextField(props) {
			return (0, react.createElement)(Field, {
				label: props.label,
				hint: props.hint
			}, (0, react.createElement)("input", {
				type: "text",
				value: props.value,
				placeholder: props.placeholder,
				disabled: props.disabled,
				inputMode: props.numeric === true ? "numeric" : void 0,
				onChange: (event) => props.onChange(event.target.value),
				style: inputStyle()
			}));
		}
		/** A checkbox field. */
		function CheckField(props) {
			return (0, react.createElement)("label", { style: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				margin: "10px 0"
			} }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: props.checked,
				disabled: props.disabled,
				onChange: (event) => props.onChange(event.target.checked)
			}), (0, react.createElement)("span", null, (0, react.createElement)("span", { style: { fontSize: "0.85rem" } }, props.label), props.hint !== void 0 ? (0, react.createElement)("span", { style: {
				display: "block",
				opacity: .65,
				fontSize: "0.78rem"
			} }, props.hint) : null));
		}
		/** Shared inline styles (theme-neutral: inherits colors, translucent chrome). */
		function cardStyle() {
			return {
				border: "1px solid rgba(128,128,128,0.4)",
				borderRadius: "8px",
				padding: "14px",
				display: "inline-block",
				minWidth: "min(100%, 520px)"
			};
		}
		function inputStyle() {
			return {
				width: "100%",
				padding: "6px 8px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.45)",
				background: "transparent",
				color: "inherit",
				boxSizing: "border-box"
			};
		}
		function buttonStyle(disabled) {
			return {
				padding: "4px 10px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.5)",
				background: "transparent",
				color: "inherit",
				cursor: disabled ? "default" : "pointer",
				opacity: disabled ? "0.5" : "1"
			};
		}
		
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
