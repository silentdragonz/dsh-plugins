/**
 * dsh-shtv host plugin.
 *
 * Serves Playwright MCP screenshots from the session workspace over a fenced,
 * loopback-trusted route family (/api/dsh-shtv/*) so the browser half can paint
 * them inline in the tool card as plain same-origin <img> URLs.
 *
 * Every served path is confined to the configured workspace root (default
 * /workspace/workspace/research), image extensions only, symlink-escape
 * refusal, size cap. Read-only.
 * @module dsh-shtv
 */
import * as path from "node:path";
import * as fs from "node:fs/promises";

/** Plugin identity for the cordis patch row. */
export const name = "dsh-shtv";
/** Services required before mounting. */
export const inject = ["webServer", "webRuntime"];
/** The route family prefix. */
export const API_PREFIX = "/api/dsh-shtv";

const DEFAULT_WORKSPACE = "/workspace/workspace/research";
const IMG_EXT = /\.(png|jpe?g|webp)$/i;
const MAX_BYTES = 8 * 1024 * 1024;
/** Live-feed directory (relative to workspace); the MCP-side pump writes frame.jpg there. */
const LIVE_DIR = ".playwright-mcp/live";
/** A frame older than this is considered an idle feed. */
const LIVE_STALE_MS = 5000;

function header(headers, name) {
	const value = headers[name];
	return typeof value === "string" ? value : void 0;
}
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return;
	}
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === void 0) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
	});
}
function isTrustedApiRequest(request, trustedHosts) {
	const host = header(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

function mimeOf(filePath) {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	return "image/jpeg";
}
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
	res.end(JSON.stringify(body));
}
/** Resolve a requested path inside the workspace root, or refuse. */
function resolveInside(base, raw) {
	if (typeof raw !== "string" || raw === "") return null;
	if (!IMG_EXT.test(raw)) return null;
	const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);
	const rel = path.relative(base, abs);
	if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
	return abs;
}
/** Symlink-aware containment: the realpath must still sit inside the real base. */
async function isSafeInside(base, abs) {
	try {
		const realBase = await fs.realpath(base);
		const realAbs = await fs.realpath(abs);
		const rel = path.relative(realBase, realAbs);
		return rel === "" ? false : rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
	} catch {
		return false;
	}
}
/** Newest image file name in a directory (Playwright names are sortable ISO stamps). */
async function pickLatestImage(dir) {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	let best = null;
	for (const entry of entries) {
		if (!entry.isFile() || !IMG_EXT.test(entry.name)) continue;
		if (best === null || entry.name > best) best = entry.name;
	}
	return best;
}
async function handleImage(req, res, workspace) {
	const url = new URL(req.url ?? "/", "http://localhost");
	let filePath = url.searchParams.get("path");
	if (filePath === null || filePath === "") {
		const inSub = await pickLatestImage(path.join(workspace, ".playwright-mcp"));
		if (inSub !== null) {
			filePath = ".playwright-mcp/" + inSub;
		} else {
			const rootLatest = await pickLatestImage(workspace);
			if (rootLatest === null) {
				writeJson(res, 404, { error: "no images found" });
				return;
			}
			filePath = rootLatest;
		}
	}
	const abs = resolveInside(workspace, filePath);
	if (abs === null) {
		writeJson(res, 403, { error: "path outside the workspace or not an image" });
		return;
	}
	if (!await isSafeInside(workspace, abs)) {
		writeJson(res, 403, { error: "path fails containment check (symlink escape?)" });
		return;
	}
	let bytes;
	try {
		const info = await fs.stat(abs);
		if (!info.isFile()) {
			writeJson(res, 404, { error: "not a file" });
			return;
		}
		if (info.size > MAX_BYTES) {
			writeJson(res, 413, { error: `image too large (${info.size} bytes)` });
			return;
		}
		bytes = await fs.readFile(abs);
	} catch {
		writeJson(res, 404, { error: "file not found" });
		return;
	}
	res.writeHead(200, {
		"content-type": mimeOf(abs),
		"content-length": String(bytes.length),
		"content-disposition": "inline",
		"cache-control": "private, max-age=3600",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff"
	});
	res.end(bytes);
}
/** Feed state from the pump's latest frame file. */
let liveActive = false;
let lastPumpAt = 0;
let lastViewAt = 0;
async function liveMeta(workspace) {
	const pump = Date.now() - lastPumpAt < 4000;
	try {
		const info = await fs.stat(path.join(workspace, LIVE_DIR, "frame.jpg"));
		return { exists: true, bytes: info.size, ageMs: Math.max(0, Date.now() - info.mtimeMs), active: liveActive === true, pump };
	} catch {
		return { exists: false, active: liveActive === true, pump };
	}
}
async function handleLiveFrame(res, workspace) {
	lastViewAt = Date.now();
	let bytes;
	try {
		bytes = await fs.readFile(path.join(workspace, LIVE_DIR, "frame.jpg"));
	} catch {
		writeJson(res, 404, { error: "no live frame yet" });
		return;
	}
	res.writeHead(200, {
		"content-type": "image/jpeg",
		"content-length": String(bytes.length),
		"content-disposition": "inline",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff"
	});
	res.end(bytes);
}
/** Self-refreshing viewer page: used as the sidebar tab's iframe and standalone. */
async function handleLivePage(res, workspace) {
	const meta = await liveMeta(workspace);
	const active = meta.exists === true && meta.ageMs < LIVE_STALE_MS;
	const body = active
		? `<img src="${API_PREFIX}/live/frame?t=${Date.now()}" alt="live browser frame">`
		: `<div class="idle">Live feed idle.<br><span>Ask the agent to <b>start live view</b>, or click Start below if this panel offers it.</span></div>`;
	const html = `<!doctype html><html><head><meta charset="utf-8">`
		+ `<meta http-equiv="refresh" content="${active ? 1 : 3}">`
		+ `<style>html,body{margin:0;height:100%;background:#101014;color:#bbb;font:13px/1.6 ui-monospace,monospace;display:flex;align-items:center;justify-content:center;text-align:center}img{max-width:100%;max-height:100vh;display:block}.idle{padding:24px}.idle span{opacity:.7;font-size:12px}</style>`
		+ `</head><body>${body}</body></html>`;
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
	});
	res.end(html);
}
async function handleRequest(req, res, ctx) {
	const cfg = ctx.plugin?.config ?? {};
	const workspace = typeof cfg.workspace === "string" && cfg.workspace !== "" ? cfg.workspace : DEFAULT_WORKSPACE;
	const url = new URL(req.url ?? "/", "http://localhost");
	const sub = url.pathname.slice(API_PREFIX.length) || "/";
	if (sub === "/health") {
		writeJson(res, 200, { ok: true, workspace });
		return;
	}
	if (sub === "/image") {
		await handleImage(req, res, workspace);
		return;
	}
	if (sub === "/live/frame") {
		await handleLiveFrame(res, workspace);
		return;
	}
	if (sub === "/live/meta") {
		writeJson(res, 200, await liveMeta(workspace));
		return;
	}
	if (sub === "/live/stopstate") {
		// The pump polls this as its heartbeat; it is the only stop authority.
		lastPumpAt = Date.now();
		writeJson(res, 200, { stop: false, active: liveActive === true });
		return;
	}
	if (sub === "/live/set") {
		const on = url.searchParams.get("on");
		if (on === "1" || on === "true") {
			liveActive = true;
		} else if (on === "0" || on === "false") {
			liveActive = false;
		}
		writeJson(res, 200, { active: liveActive, pumpActive: Date.now() - lastPumpAt < 4000 });
		return;
	}
	if (sub === "/live/page") {
		await handleLivePage(res, workspace);
		return;
	}
	writeJson(res, 404, { error: "not found" });
}
/** Plugin body: mount the fenced read-only image route. */
export function apply(ctx) {
	const cfgForDir = ctx.plugin?.config ?? {};
	const wsForDir = typeof cfgForDir.workspace === "string" && cfgForDir.workspace !== "" ? cfgForDir.workspace : DEFAULT_WORKSPACE;
	fs.mkdir(path.join(wsForDir, LIVE_DIR), { recursive: true }).catch(() => {});
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "prefix",
			path: API_PREFIX,
			handler: async (req, res) => {
				try {
					if (!isTrustedApiRequest(req, ctx.webRuntime?.trustedHosts ?? [])) {
						writeJson(res, 403, { error: "forbidden" });
						return;
					}
					if ((req.method ?? "GET") !== "GET") {
						writeJson(res, 405, { error: `method not allowed: ${req.method ?? ""}` });
						return;
					}
					await handleRequest(req, res, ctx);
				} catch (e) {
					writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
				}
			}
		});
		return () => {
			try {
				dispose();
			} catch {}
		};
	}, "dsh-shtv: routes");
}
