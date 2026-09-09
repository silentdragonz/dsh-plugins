/**
 * Client half of dsh-ina-theme.
 *
 * Registers two first-class themes with the DSH theme service:
 *   - ina-dark  — the artwork: plum-black canvas, eggplant surfaces,
 *     rose-magenta satchel brand, amber hair-tip highlights, ivory labels.
 *   - ina-light — the same hues as eggplant ink on ivory paper.
 *
 * Both definitions also remap the primitive ramps (DeepSeek brand blue,
 * generic blue, blue-tinted neutrals) to rose / periwinkle-plum / plum-gray so
 * no stray blues survive in buttons, tabs, or folder icons.
 *
 * Settings (this bundle's host route at /api/dsh-ina-theme/settings):
 *   - enabled: theme on/off (off = stock DSH colors)
 *   - scheme:  "system" (follow OS), "light", or "dark"
 * A Settings → "Ina" page edits both. Persistence is two-layer like
 * the catppuccin reference: localStorage is the instant layer (restores
 * synchronously at boot, before the fetch roundtrip), the host route is the
 * durable layer (hydrates localStorage when localStorage is empty).
 *
 * DSH persists only the built-in preference (system/light/dark) and the
 * ThemeService re-adopts it asynchronously after boot and on every settings
 * document reload, which clobbers a third-party theme id. While enabled, a
 * sticky reassert re-applies the selected Ina variant whenever the
 * preference lands back on a built-in. Two mechanics matter and are copied
 * from the working reference:
 *   - the reassert runs in a fresh task (setTimeout 0): a re-entrant setTheme
 *     inside the theme/change dispatch is missed by other subscribers
 *     (ui-layout's ThemePresenter), so the theme would never reach the DOM;
 *   - a hard cap stops any pathological adopt loop, and a successful ina
 *     observation resets the budget so ordinary reloads never exhaust it.
 *
 * Slot registration note (learned the hard way): the registration descriptor
 * MUST carry `name` — the slot core reads the slot coordinate off it; a
 * register without `name` throws `slot "undefined" is not declared` inside
 * apply(), fails the whole fiber, and silently kills the theme registrations.
 *
 * Palette extracted from the reference artwork:
 *   hair/dress #332c3b #2c2637 #26212d · knit #574a5b #675869
 *   eyes #484467 #6b5b82 · satchel #e55b87 #d3537c
 *   hair tips / soles #eaa464 #f4a866 · skin #fee7e4
 *
 * @module dsh-ina-theme/client
 */
window.__ModuleLoader__.load({
	id: "dsh-ina-theme",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// Primitive ramps: scheme-independent, identical in both variants.
		const darkRamp = {
			// Brand blue -> rose (send button, active tab accents, business-state
			// icons / workspace folders, info buttons, bubble highlights).
			"--dsw-static-deepseek-50": "#fdf0f4",
			"--dsw-static-deepseek-100": "#fbe3ec",
			"--dsw-static-deepseek-200": "#f8cfdd",
			"--dsw-static-deepseek-300": "#f0a9c2",
			"--dsw-static-deepseek-400": "#ea779c",
			"--dsw-static-deepseek-450": "#e5628c",
			"--dsw-static-deepseek-500": "#d94e7f",
			"--dsw-static-deepseek-600": "#b84470",
			"--dsw-static-deepseek-800": "#6e2f49",
			"--dsw-static-deepseek-900": "#4a2438",
			// Generic blue -> periwinkle-plum (hair-shadow hues).
			"--dsw-static-blue-50": "#f7f2fa",
			"--dsw-static-blue-75": "#f0e8f6",
			"--dsw-static-blue-100": "#e8dcef",
			"--dsw-static-blue-300": "#c2a3d9",
			"--dsw-static-blue-400": "#a678c8",
			"--dsw-static-blue-450": "#9665bd",
			"--dsw-static-blue-500": "#7e57b8",
			"--dsw-static-blue-600": "#6a44a0",
			"--dsw-static-blue-800": "#4e2f7a",
			"--dsw-static-blue-900": "#3a2354",
			"--dsw-static-blue-950": "#291a3c",
			// Cool blue-gray grays -> plum-tinted neutrals at identical steps.
			"--dsw-static-neutral-bluish-00": "#ffffff",
			"--dsw-static-neutral-bluish-50": "#faf6f9",
			"--dsw-static-neutral-bluish-60": "#f6f1f5",
			"--dsw-static-neutral-bluish-75": "#f2ecf1",
			"--dsw-static-neutral-bluish-100": "#eee6ec",
			"--dsw-static-neutral-bluish-150": "#eae1e9",
			"--dsw-static-neutral-bluish-200": "#e2d7e1",
			"--dsw-static-neutral-bluish-300": "#d3c5cf",
			"--dsw-static-neutral-bluish-400": "#b4a2ae",
			"--dsw-static-neutral-bluish-500": "#9e8d99",
			"--dsw-static-neutral-bluish-600": "#897783",
			"--dsw-static-neutral-bluish-700": "#6a5964",
			"--dsw-static-neutral-bluish-750": "#4a3c47",
			"--dsw-static-neutral-bluish-800": "#3b3038",
			"--dsw-static-neutral-bluish-850": "#322932",
			"--dsw-static-neutral-bluish-875": "#29212a",
			"--dsw-static-neutral-bluish-900": "#211a22",
			"--dsw-static-neutral-bluish-950": "#1a131b",
			"--dsw-static-neutral-bluish-1000": "#140e16",
		};

		const darkTokens = {
			...darkRamp,
			"--dsw-alias-bg-base": "#1f1a26",
			"--dsw-alias-bg-layer-1": "#2a2434",
			"--dsw-alias-bg-layer-2": "#352d40",
			"--dsw-alias-bg-overlay": "#3e3549",
			"--dsw-alias-border-l1": "#463d52",
			"--dsw-alias-border-l2": "#5d506c",
			"--dsw-alias-brand-primary": "#e05a86",
			"--dsw-alias-brand-primary-new-colorprimary-new-color": "#e05a86",
			"--dsw-alias-label-primary": "#f2e9ee",
			"--dsw-alias-label-secondary": "#b6a8c2",
			"--dsw-alias-state-error-primary": "#e8524f",
			"--dsw-alias-state-success-primary": "#8ec07c",
			"--dsw-alias-state-warn-primary": "#eda45f",
			"--dsw-alias-interactive-bg-hover-accent": "#ffffff3d",
			"--dsw-specific-sidebar-fill": "#241e2c",
		};

		const lightTokens = {
			...darkRamp,
			"--dsw-alias-bg-base": "#f8f0ef",
			"--dsw-alias-bg-layer-1": "#fdf8f7",
			"--dsw-alias-bg-layer-2": "#f1e6e9",
			"--dsw-alias-bg-overlay": "#fffcfb",
			"--dsw-alias-border-l1": "#e0d1d9",
			"--dsw-alias-border-l2": "#c6b3c9",
			"--dsw-alias-brand-primary": "#c4406d",
			"--dsw-alias-brand-primary-new-colorprimary-new-color": "#c4406d",
			"--dsw-alias-label-primary": "#372f42",
			"--dsw-alias-label-secondary": "#6e6178",
			"--dsw-alias-state-error-primary": "#c73e45",
			"--dsw-alias-state-success-primary": "#55803c",
			"--dsw-alias-state-warn-primary": "#b97f33",
			"--dsw-alias-interactive-bg-hover-accent": "#3a235424",
			"--dsw-specific-sidebar-fill": "#f0e4e3",
		};

		// ------------------------------------------------------------------
		// Settings store (module singleton). Two-layer persistence:
		// localStorage is the instant layer (synchronous boot restore); the
		// host route is the durable layer (hydrates when localStorage is
		// empty; every write is pushed through saveSettings).
		// ------------------------------------------------------------------
		const API = "/api/dsh-ina-theme/settings";
		const STORAGE_KEY = "dsh-ina-theme-state";
		const RESTORE_KEY = "dsh-ina-theme-restore";
		const BUILTINS = ["system", "light", "dark"];
		const MAX_REASSERTS = 8;

		function sanitizeSettings(raw) {
			const out = { enabled: true, scheme: "system" };
			if (raw !== null && typeof raw === "object") {
				if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
				if (raw.scheme === "light" || raw.scheme === "dark") out.scheme = raw.scheme;
			}
			return out;
		}
		function readLocal() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				return raw === null ? null : sanitizeSettings(JSON.parse(raw));
			} catch {
				return null;
			}
		}
		function writeLocal(settings) {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
			} catch {
				// storage disabled (private mode) — host route still persists
			}
		}
		function readRestorable() {
			try {
				const raw = localStorage.getItem(RESTORE_KEY);
				return BUILTINS.includes(raw) ? raw : "system";
			} catch {
				return "system";
			}
		}
		function rememberRestorable(preference) {
			if (!BUILTINS.includes(preference)) return;
			try {
				localStorage.setItem(RESTORE_KEY, preference);
			} catch {
				// non-fatal: disabling then falls back to "system"
			}
		}

		const instant = readLocal();
		const store = {
			settings: instant === null ? { enabled: true, scheme: "system" } : instant,
			loaded: false,
			persistOk: true,
		};
		let themeSvc = null;
		let reassertCount = 0;
		let reassertTimer = null;
		// Explicit built-in appearance pick observed this session (setTheme
		// wrapper seam; null once a non-built-in preference is applied).
		let liveBuiltinPick = null;
		const listeners = new Set();
		function notify() {
			for (const fn of listeners) fn();
		}

		function prefersDark() {
			return (
				typeof matchMedia === "function" &&
				matchMedia("(prefers-color-scheme: dark)").matches
			);
		}
		function isIna(id) {
			return id === "ina-dark" || id === "ina-light";
		}
		function variantFor(scheme) {
			if (scheme === "light") return "ina-light";
			if (scheme === "dark") return "ina-dark";
			return prefersDark() ? "ina-dark" : "ina-light";
		}
		function applyVariant() {
			if (themeSvc === null || !store.settings.enabled) return;
			const target = variantFor(store.settings.scheme);
			if (themeSvc.getTheme().preference !== target) themeSvc.setTheme(target);
		}
		function fallbackToStock() {
			if (themeSvc === null) return;
			if (isIna(themeSvc.getTheme().preference)) {
				themeSvc.setTheme(readRestorable());
			}
		}
		/**
		 * Sticky reassert: whenever the ThemeService has landed on a built-in
		 * while the theme is enabled, the click mapping decides:
		 *   - an explicit Appearance pick this session (liveBuiltinPick — set
		 *     only through the wrapped setTheme; adopt() writes the runtime
		 *     preference directly and never goes through it) updates the
		 *     scheme setting so both controls drive the same source of truth;
		 *   - a built-in copied from the settings document at boot/reload is
		 *     stale — the persisted Ina choice wins, budgeted.
		 * Only ever called from a fresh task — a re-entrant setTheme inside
		 * the theme/change dispatch is missed by the ThemePresenter and never
		 * reaches the DOM.
		 */
		function reassert() {
			if (themeSvc === null || !store.loaded || !store.settings.enabled) return;
			const current = themeSvc.getTheme().preference;
			if (isIna(current)) {
				// already in effect — reset the budget so an isolated adoption
				// later is still honored.
				reassertCount = 0;
				return;
			}
			if (liveBuiltinPick !== null && liveBuiltinPick === current) {
				// explicit user pick in General → Appearance: map it onto the
				// scheme setting (light/dark pin the variant, system = auto).
				const mapped = current === "light" ? "light" : current === "dark" ? "dark" : "system";
				if (store.settings.scheme !== mapped) {
					store.settings = { enabled: true, scheme: mapped };
					writeLocal(store.settings);
					fetch(API, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(store.settings),
					})
						.then((res) => { store.persistOk = res.ok; })
						.catch(() => { store.persistOk = false; })
						.finally(notify);
				}
				applyVariant();
				return;
			}
			if (reassertCount >= MAX_REASSERTS) return;
			reassertCount += 1;
			applyVariant();
		}
		function scheduleReassert() {
			if (reassertTimer !== null) return;
			reassertTimer = setTimeout(() => {
				reassertTimer = null;
				reassert();
			}, 0);
		}
		function applyBoot() {
			store.loaded = true;
			if (store.settings.enabled) {
				reassertCount = 0;
				applyVariant();
			} else {
				fallbackToStock();
			}
			notify();
		}
		function saveSettings(next) {
			// write state first: setTheme publishes a synchronous theme/change,
			// and the deferred reassert must already see the new saved value.
			store.settings = sanitizeSettings(next);
			writeLocal(store.settings);
			if (store.settings.enabled) {
				reassertCount = 0;
				applyVariant();
			} else {
				fallbackToStock();
			}
			notify();
			fetch(API, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(store.settings),
			})
				.then((res) => {
					store.persistOk = res.ok;
				})
				.catch(() => {
					store.persistOk = false;
				})
				.finally(notify);
		}

		// ------------------------------------------------------------------
		// Settings page UI (Settings → Ina), rendered from the
		// settings.section slot as a full page.
		// ------------------------------------------------------------------
		const secondary = {
			color: "var(--dsw-alias-label-secondary, #777)",
			fontSize: 13,
			lineHeight: 1.5,
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
		};

		function useStore() {
			const [, setTick] = react.useState(0);
			react.useEffect(() => {
				const fn = () => setTick((v) => v + 1);
				listeners.add(fn);
				return () => {
					listeners.delete(fn);
				};
			}, []);
		}

		function Toggle(on, onToggle, label) {
			return react.createElement(
				"button",
				{
					type: "button",
					role: "switch",
					"aria-checked": on,
					"aria-label": label,
					onClick: onToggle,
					style: {
						flex: "0 0 auto",
						width: 44,
						height: 26,
						borderRadius: 13,
						border: "none",
						padding: 3,
						cursor: "pointer",
						display: "flex",
						alignItems: "center",
						justifyContent: on ? "flex-end" : "flex-start",
						background: on
							? "var(--dsw-alias-brand-primary, #d94e7f)"
							: "var(--dsw-alias-border-l2, #999)",
						transition: "background 120ms ease",
					},
				},
				react.createElement("span", {
					style: {
						width: 20,
						height: 20,
						borderRadius: "50%",
						background: "#ffffff",
						display: "block",
					},
				}),
			);
		}

		function Pill(text, value, current, onPick, disabled) {
			const active = current === value;
			return react.createElement(
				"button",
				{
					type: "button",
					disabled,
					onClick: () => onPick(value),
					style: {
						padding: "6px 14px",
						borderRadius: 8,
						cursor: disabled ? "default" : "pointer",
						fontSize: 13,
						fontWeight: active ? 600 : 400,
						border: active
							? "1px solid transparent"
							: "1px solid var(--dsw-alias-border-l2, #bbb)",
						background: active
							? "var(--dsw-alias-brand-primary, #d94e7f)"
							: "transparent",
						color: active ? "#ffffff" : "var(--dsw-alias-label-primary, #333)",
					},
				},
				text,
			);
		}

		function Panel() {
			useStore();
			const s = store.settings;
			return react.createElement(
				"section",
				{
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 20,
						maxWidth: 560,
						color: "var(--dsw-alias-label-primary, #333)",
					},
				},
				react.createElement(
					"div",
					null,
					react.createElement(
						"h3",
						{ style: { margin: "0 0 6px", fontSize: 15 } },
						"Ina theme",
					),
					react.createElement(
						"div",
						{ style: secondary },
						"Eggplant-indigo surfaces, a rose-magenta brand accent, amber highlights — extracted from the Ina artwork.",
					),
				),
				react.createElement(
					"div",
					{ style: rowStyle },
					react.createElement(
						"div",
						null,
						react.createElement("div", { style: { fontWeight: 600 } }, "Enable theme"),
						react.createElement(
							"div",
							{ style: secondary },
							"When off, the stock DSH colors return.",
						),
					),
					Toggle(
						s.enabled,
						() => saveSettings({ ...s, enabled: !s.enabled }),
						"Enable Ina theme",
					),
				),
				react.createElement(
					"div",
					{ style: { ...rowStyle, opacity: s.enabled ? 1 : 0.45 } },
					react.createElement(
						"div",
						null,
						react.createElement("div", { style: { fontWeight: 600 } }, "Variant"),
						react.createElement(
							"div",
							{ style: secondary },
							"Auto follows your OS light/dark setting.",
						),
					),
					react.createElement(
						"div",
						{ style: { display: "flex", gap: 8 } },
						Pill("Auto", "system", s.scheme, (v) => saveSettings({ ...s, scheme: v }), !s.enabled),
						Pill("Light", "light", s.scheme, (v) => saveSettings({ ...s, scheme: v }), !s.enabled),
						Pill("Dark", "dark", s.scheme, (v) => saveSettings({ ...s, scheme: v }), !s.enabled),
					),
				),
				react.createElement(
					"div",
					{ style: { display: "flex", gap: 6, alignItems: "center" } },
					...[
						"#1f1a26",
						"#352d40",
						"#6b5b82",
						"#e05a86",
						"#eda45f",
						"#fee7e4",
					].map((c) =>
						react.createElement("span", {
							key: c,
							title: c,
							style: {
								width: 18,
								height: 18,
								borderRadius: "50%",
								background: c,
								border: "1px solid var(--dsw-alias-border-l2, #bbb)",
								display: "inline-block",
							},
						}),
					),
				),
				store.persistOk === false
					? react.createElement(
							"div",
							{
								style: {
									...secondary,
									color: "var(--dsw-alias-state-error-primary, #c00)",
								},
							},
							"Couldn't reach the theme settings route — changes apply live but won't persist. Restart dsh web to enable persistence.",
						)
					: react.createElement(
							"div",
							{ style: secondary },
							"Choices persist on the server and re-apply on every start.",
						),
			);
		}

		/** Services required before mounting. */
		const inject = ["theme", "slots"];

		/** Plugin body. */
		function apply(ctx) {
			themeSvc = ctx.theme;

			// setTheme wrapper: distinguishes "the user clicked Light/Dark/
			// System in Appearance this session" from "the settings document
			// was adopted" — adopt() writes the runtime preference directly
			// and never goes through setTheme.
			const originalSetTheme = ctx.theme.setTheme;
			ctx.theme.setTheme = (id) => {
				liveBuiltinPick = BUILTINS.includes(id) ? id : null;
				originalSetTheme.call(ctx.theme, id);
			};

			// Register both themes. ctx.effect's setup runs immediately and its
			// RETURN value is the disposer — so the setup must return a cleanup
			// function instead of disposing inline (disposing inline removes the
			// themes right after registering them).
			const disposeDark = ctx.theme.register({
				id: "ina-dark",
				name: "Ina Dark",
				colorScheme: "dark",
				tokens: darkTokens,
			});
			const disposeLight = ctx.theme.register({
				id: "ina-light",
				name: "Ina Light",
				colorScheme: "light",
				tokens: lightTokens,
			});
			ctx.effect(() => () => {
				if (reassertTimer !== null) {
					clearTimeout(reassertTimer);
					reassertTimer = null;
				}
				// undo the setTheme wrapper so a stopped plugin leaves the
				// runtime as it found it
				if (themeSvc !== null) themeSvc.setTheme = originalSetTheme;
				liveBuiltinPick = null;
				disposeLight();
				disposeDark();
				themeSvc = null;
			}, "dsh-ina-theme: theme registrations");

			// Instant layer: apply the localStorage state before any roundtrip
			// so the first paint is already the configured variant.
			applyVariant();

			// Hydrate the durable layer: the host route wins when localStorage
			// had nothing (fresh browser origin) or disagrees (newer save from
			// elsewhere).
			fetch(API)
				.then((res) => {
					store.persistOk = res.ok;
					return res.ok ? res.json() : null;
				})
				.then((data) => {
					if (data === null || typeof data !== "object") return;
					if (instant === null) {
						store.settings = sanitizeSettings(data);
						writeLocal(store.settings);
					} else {
						// localStorage and the server disagree (another device
						// saved newer state, or the route was rewritten): the
						// durable layer wins on boot.
						const server = sanitizeSettings(data);
						const changed =
							server.enabled !== store.settings.enabled ||
							server.scheme !== store.settings.scheme;
						store.settings = server;
						if (changed) writeLocal(server);
					}
				})
				.catch(() => {
					store.persistOk = false;
				})
				.finally(applyBoot);

			// The ThemeService adopts the persisted built-in preference at boot
			// and on every settings-document reload, which can reset a
			// third-party theme id; re-assert from a fresh task (see above).
			// Also remember the last built-in preference so disabling the
			// theme can hand the user back exactly what they had.
			ctx.on("theme/change", (snapshot) => {
				if (!store.loaded) return;
				if (!isIna(snapshot.preference)) rememberRestorable(snapshot.preference);
				scheduleReassert();
			});

			// Auto variant follows the OS scheme live (only while enabled).
			ctx.effect(() => {
				if (typeof matchMedia !== "function") return () => {};
				const mq = matchMedia("(prefers-color-scheme: dark)");
				const onChange = () => applyVariant();
				mq.addEventListener("change", onChange);
				return () => mq.removeEventListener("change", onChange);
			}, "dsh-ina-theme: scheme media listener");

			// Settings page. The registration object MUST carry `name` — the
			// slot core reads the slot coordinate off it; omitting it throws
			// `slot "undefined" is not declared`, fails the fiber, and kills
			// the theme registrations with it.
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "ina-theme",
				order: 35,
				label: "Ina"
			}, Panel));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
