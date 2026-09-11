// dsh-shtv client bundle.
// 1) tool.call.toolview card for mcp__browser__browser_take_screenshot (same-origin <img>).
// 2) dsh-better-sidebar "Live Browser" tab: live frames from the host's /live routes.
//    The frame pump lives in the MCP browser's Playwright process; it idles unless the
//    host says active (this panel's Start/Stop toggles that flag same-origin). Starting
//    the pump for the first time (or after a browser restart) is agent work: the Start
//    button also asks the current conversation when no pump heartbeat is seen.
window.__ModuleLoader__.load({
	id: "dsh-shtv",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		const API = "/api/dsh-shtv";
		const STALE_MS = 5000;

		/* ---------- shared helpers ---------- */
		function collectPaths(node, depth, out) {
			if (node == null || depth > 4 || out.length > 12) return;
			if (typeof node === "string") {
				const m = /\]?\(?([\w.\/-]+\.(?:png|jpe?g|webp))/i.exec(node);
				if (m && out.indexOf(m[1]) < 0) out.push(m[1]);
				return;
			}
			if (typeof node !== "object") return;
			let keys;
			try { keys = Object.keys(node); } catch (e) { return; }
			for (const k of keys.slice(0, 24)) {
				let v;
				try { v = node[k]; } catch (e) { continue; }
				collectPaths(v, depth + 1, out);
			}
		}
		function displayName(p) {
			if (typeof p !== "string" || p === "") return "browser_take_screenshot";
			const parts = p.split("/");
			return parts[parts.length - 1];
		}

		/* ---------- screenshot tool card ---------- */
		function Card(props) {
			const [state, setState] = React.useState("loading");
			const [open, setOpen] = React.useState(false);
			const paths = [];
			try { collectPaths(props.block, 0, paths); } catch (e) { /* empty */ }
			const rawPath = paths.length > 0 ? paths[paths.length - 1] : null;
			const src = rawPath === null ? API + "/image" : API + "/image?path=" + encodeURIComponent(rawPath);
			const name = displayName(rawPath);
			React.useEffect(() => {
				if (!open) return;
				function onKey(e) {
					if (e.key === "Escape") setOpen(false);
				}
				try {
					if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
						window.addEventListener("keydown", onKey);
						return () => {
							try { window.removeEventListener("keydown", onKey); } catch (e) { /* ignore */ }
						};
					}
				} catch (e) { /* no window */ }
			}, [open]);
			if (state === "error") {
				return React.createElement("div", { style: { padding: 10, fontSize: 12, opacity: 0.75, fontFamily: "monospace" } }, "browser_take_screenshot — image unavailable (" + name + ")");
			}
			return React.createElement("div", { style: { maxWidth: 760 } },
				React.createElement("img", {
					src: src,
					alt: name,
					title: "Click to view full size",
					onLoad: () => setState("ready"),
					onError: () => setState("error"),
					onClick: () => state === "ready" && setOpen(true),
					style: { width: "100%", height: "auto", borderRadius: 8, display: "block", cursor: "zoom-in", visibility: state === "ready" ? "visible" : "hidden" }
				}),
				state === "ready" ? null : React.createElement("div", { style: { padding: "10px 0", opacity: 0.6, fontSize: 12, fontFamily: "monospace" } }, "Loading screenshot…"),
				React.createElement("div", { style: { fontSize: 12, opacity: 0.65, padding: "5px 2px", fontFamily: "monospace" } }, name),
				open
					? React.createElement("div", {
							onClick: () => setOpen(false),
							style: { position: "fixed", top: 0, right: 0, bottom: 0, left: 0, zIndex: 2147483000, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }
						},
						React.createElement("div", {
							onClick: (e) => { e.stopPropagation(); },
							style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, maxWidth: "96vw", maxHeight: "96vh" }
						},
							React.createElement("img", {
								src: src,
								alt: name,
								style: { maxWidth: "94vw", maxHeight: "88vh", width: "auto", height: "auto", borderRadius: 6, boxShadow: "0 10px 50px rgba(0,0,0,0.7)", display: "block", cursor: "zoom-out" }
							}),
							React.createElement("div", { style: { fontSize: 12, color: "rgba(255,255,255,0.75)", fontFamily: "monospace" } }, name + " — click anywhere or Esc to close")))
					: null);
		}

		/* ---------- live feed tab ---------- */
		const SEED_MSG = "[dsh-shtv live] No frame pump is running. Please seed the pump: GET " + API + "/live/stopstate via the browser's page.request first; if there is no recent pump, run the documented dsh-shtv pump snippet through browser_run_code_unsafe (loop: while host stopstate.stop is false and active is true, page.screenshot to .playwright-mcp/live/frame.jpg jpeg q55 scale css; poll " + API + "/live/stopstate via page.request each cycle; waitForTimeout(active?600:1200)). Then GET " + API + "/live/set?on=1. Do not screenshot into the chat.";

		function sendAgentMessage(sessions, text) {
			try {
				const current = sessions.list.getSnapshot().current;
				const conv = sessions.scope(current)?.get("conversation");
				if (conv === undefined) return false;
				conv.send(text);
				return true;
			} catch (e) {
				return false;
			}
		}

		function LivePanel(props) {
			const sessions = props.sessions;
			const [meta, setMeta] = React.useState(null);
			const [tick, setTick] = React.useState(0);
			const [note, setNote] = React.useState("");
			React.useEffect(() => {
				let alive = true;
				let timer = null;
				async function poll() {
					try {
						const r = await fetch(API + "/live/meta?_=" + Date.now(), { headers: { accept: "application/json" } });
						const m = await r.json();
						if (alive) setMeta(m);
					} catch (e) {
						if (alive) setMeta({ exists: false, pump: null });
					}
					if (alive) setTick((t) => t + 1);
					timer = setTimeout(poll, 1000);
				}
				poll();
				return () => { alive = false; if (timer !== null) clearTimeout(timer); };
			}, []);
			async function setOn(on) {
				try {
					const r = await fetch(API + "/live/set?on=" + (on ? 1 : 0));
					const j = await r.json();
					if (on && j && j.pumpActive === false) {
						const sent = sendAgentMessage(sessions, SEED_MSG);
						setNote(sent ? "no pump running — asked the agent to seed it" : "no pump running — ask the agent to seed the live pump");
					} else {
						setNote(on ? "play requested" : "pause requested");
					}
				} catch (e) {
					setNote("control failed: " + String(e && e.message ? e.message : e));
				}
			}
			const exists = meta !== null && meta.exists === true;
			const active = exists && meta.ageMs < STALE_MS;
			const status = active
				? "LIVE — " + Math.round(meta.ageMs) + " ms"
				: meta !== null && meta.active === true && meta.pump === false
					? "playing, no pump — press Play again to notify the agent"
					: meta !== null && meta.active === true
						? "playing — waiting for frames"
						: exists ? "paused — last frame " + Math.round(meta.ageMs / 1000) + "s ago" : "no frames yet";
			return React.createElement("div", {
				style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#101014", color: "#c9c9cf", fontFamily: "ui-monospace,monospace" }
			},
				React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.08)" } },
					React.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: active ? "#3fb950" : "#6e7681", boxShadow: active ? "0 0 6px #3fb950" : "none" } }),
					React.createElement("span", { style: { fontSize: 12 } }, status),
					React.createElement("div", { style: { flex: 1 } }),
					React.createElement("button", {
						type: "button",
						onClick: () => setOn(true),
						style: { font: "inherit", fontSize: 12, padding: "3px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer" }
					}, "Play"),
					React.createElement("button", {
						type: "button",
						onClick: () => setOn(false),
						style: { font: "inherit", fontSize: 12, padding: "3px 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer" }
					}, "Pause"),
					React.createElement("a", {
						href: API + "/live/page", target: "_blank", rel: "noreferrer",
						style: { font: "inherit", fontSize: 12, padding: "3px 8px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.18)", color: "#7aa2f7", textDecoration: "none" }
					}, "⧉")),
				note === "" ? null : React.createElement("div", { style: { fontSize: 11, opacity: 0.65, padding: "4px 10px" } }, note),
				React.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" } },
					active
						? React.createElement("img", {
								src: API + "/live/frame?tick=" + tick,
								alt: "live browser frame",
								style: { maxWidth: "100%", maxHeight: "100%", display: "block" }
							})
						: React.createElement("div", { style: { textAlign: "center", fontSize: 12, opacity: 0.7, padding: 24, lineHeight: 1.7 } },
								"Live feed idle.", React.createElement("br"),
								"Press Play — the pump captures only while playing.")));
		}

		/* ---------- plugin wiring ---------- */
		/** Services required before mounting. betterSidebar must be DECLARED in
		 *  inject to be visible on the cordis context (the row waits if it
		 *  mounts before the sidebar's client layer). */
		const inject = ["slots", "sessions", "betterSidebar"];
		/** Plugin body. */
		function apply(ctx) {
			const disposers = [];
			if (ctx.slots !== undefined) {
				disposers.push(ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
					name: "tool.call.toolview",
					key: "mcp__browser__browser_take_screenshot"
				}, (props) => React.createElement(Card, props))), "dsh-shtv: toolview"));
			}
			if (ctx.betterSidebar !== undefined) {
				disposers.push(ctx.effect(() => ctx.betterSidebar.registerTab({
					id: "shtv:live",
					title: () => "Live Browser",
					order: 58,
					single: true,
					component: () => React.createElement(LivePanel, { sessions: ctx.sessions })
				}), "dsh-shtv: live tab"));
			}
			return () => { for (const d of disposers) { try { d(); } catch (e) { /* ignore */ } } };
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
