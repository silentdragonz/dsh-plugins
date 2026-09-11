import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
//#region src/host/fence.ts
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
//#endregion
//#region src/host/scan.ts
/**
* Audit-run discovery and reading for the security-audit panel (host side).
*
* Discovers cloudflare/security-audit skill runs — directories containing
* findings.json / REPORT.md / FINDINGS-DETAIL.md / architecture.md — under an
* audit root directory. The default root prefers a workspace-local
* .security-audit folder and falls back to the skill's default output root
* (~/security-audit-skill). Containment is relative to the audit root in
* use: every resolved path must stay inside it; symlinked escapes are
* refused via realpath containment of the existing ancestor.
*/
/** Workspace-local audit root folder the panel prefers when present. */
const LOCAL_AUDIT_DIR = ".security-audit";
/** Fallback audit root (the skill's default output root, ~-expanded at use). */
const FALLBACK_ROOT = "~/security-audit-skill";
/** File names a run directory may contain; also the read whitelist. */
const RUN_FILES = [
	"findings.json",
	"REPORT.md",
	"FINDINGS-DETAIL.md",
	"architecture.md"
];
/** Cap on parsed findings.json size (bytes). */
const MAX_FINDINGS_PARSE_BYTES = 8388608;
/** Cap on one returned text file (bytes). */
const MAX_TEXT_FILE_BYTES = 4194304;
/** Directory-walk safety caps. */
const MAX_REPOS = 300;
const MAX_RUNS_PER_REPO = 100;
const SEVERITIES = [
	"critical",
	"high",
	"medium",
	"low",
	"informational"
];
function emptyCounts() {
	return {
		total: 0,
		confirmed: 0,
		needsValidation: 0,
		rejected: 0,
		severity: {
			critical: 0,
			high: 0,
			medium: 0,
			low: 0,
			informational: 0
		}
	};
}
/** Resolve candidate under base and require containment; null when escaping. */
function resolveInside(base, candidate) {
	const baseAbs = path.resolve(base);
	const abs = path.resolve(baseAbs, candidate);
	if (abs !== baseAbs && !abs.startsWith(baseAbs + path.sep)) return null;
	return abs;
}
/** Containment + symlink check: realpath of the deepest existing ancestor must stay inside base. */
async function isSafeInside(base, abs) {
	const baseAbs = path.resolve(base);
	if (abs !== baseAbs && !abs.startsWith(baseAbs + path.sep)) return false;
	let probe = abs;
	for (;;) try {
		const real = await fs.realpath(probe);
		const realBase = await fs.realpath(baseAbs).catch(() => baseAbs);
		if (real !== realBase && !real.startsWith(realBase + path.sep)) return false;
		return true;
	} catch {
		const parent = path.dirname(probe);
		if (parent === probe) return false;
		probe = parent;
	}
}
async function listDirs(dir) {
	try {
		return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
	} catch {
		return [];
	}
}
async function statFile(p) {
	try {
		const st = await fs.stat(p);
		return st.isFile() ? {
			size: st.size,
			mtimeMs: st.mtimeMs
		} : void 0;
	} catch {
		return;
	}
}
/** Summarize findings.json text (confirmed / needs_validation / rejected findings per report-schema.json). */
function summarizeFindings(raw) {
	const counts = emptyCounts();
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return {
			counts,
			parseError: `findings.json is not valid JSON: ${e.message}`
		};
	}
	if (!Array.isArray(parsed)) return {
		counts,
		parseError: "findings.json is not an array"
	};
	for (const item of parsed) {
		counts.total += 1;
		if (item === null || typeof item !== "object") {
			counts.rejected += 1;
			continue;
		}
		const verdict = item.verdict;
		if (verdict === "confirmed") {
			counts.confirmed += 1;
			const sev = item.severity?.overall_severity;
			if (typeof sev === "string" && SEVERITIES.includes(sev)) counts.severity[sev] += 1;
		} else if (verdict === "needs_validation") counts.needsValidation += 1;
		else counts.rejected += 1;
	}
	return { counts };
}
/** Build one RunInfo for a candidate run directory. */
async function inspectRun(repo, name, dir) {
	const files = {};
	let updatedAt = 0;
	for (const file of RUN_FILES) {
		const st = await statFile(path.join(dir, file));
		if (st !== void 0) {
			files[file] = true;
			if (st.mtimeMs > updatedAt) updatedAt = st.mtimeMs;
		}
	}
	const info = {
		repo,
		name,
		dir,
		files,
		updatedAt
	};
	const findingsSt = await statFile(path.join(dir, "findings.json"));
	if (findingsSt !== void 0 && findingsSt.size <= MAX_FINDINGS_PARSE_BYTES) try {
		const { counts, parseError } = summarizeFindings(await fs.readFile(path.join(dir, "findings.json"), "utf8"));
		info.counts = counts;
		if (parseError !== void 0) info.parseError = parseError;
	} catch (e) {
		info.parseError = `failed to read findings.json: ${e.message}`;
	}
	return info;
}
/** True when dir holds at least one audit artifact. */
async function looksLikeRun(dir) {
	for (const file of RUN_FILES) if (await statFile(path.join(dir, file)) !== void 0) return true;
	return false;
}
/**
* Scan a root for audit runs. Layout: <root>/<repo>/run-<N>/… ; a root that is
* itself a run directory is returned as a single entry (repo '.').
*/
async function scanRuns(root) {
	if (await looksLikeRun(root)) return [await inspectRun(".", path.basename(root), root)];
	const runs = [];
	const repos = await listDirs(root);
	for (const repo of repos.slice(0, MAX_REPOS)) {
		const repoDir = path.join(root, repo);
		if (await looksLikeRun(repoDir)) {
			runs.push(await inspectRun(path.basename(root) === repo ? "." : repo, repo, repoDir));
			continue;
		}
		const children = await listDirs(repoDir);
		for (const child of children.slice(0, MAX_RUNS_PER_REPO)) {
			const childDir = path.join(repoDir, child);
			if (await looksLikeRun(childDir)) runs.push(await inspectRun(repo, child, childDir));
		}
	}
	runs.sort((a, b) => b.updatedAt - a.updatedAt);
	return runs;
}
/** Read one whitelisted artifact file from a run directory. */
async function readRunFile(dir, file) {
	if (!RUN_FILES.includes(file)) return { error: `file not allowed: ${file}` };
	const st = await statFile(path.join(dir, file));
	if (st === void 0) return { error: `file not found: ${file}` };
	const handle = await fs.open(path.join(dir, file), "r");
	try {
		const length = Math.min(st.size, MAX_TEXT_FILE_BYTES);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, 0);
		return {
			content: buffer.toString("utf8"),
			truncated: st.size > MAX_TEXT_FILE_BYTES
		};
	} finally {
		await handle.close();
	}
}
/** Expand a configured/requested root: `~` → home, relative → against the workspace. */
function expandRoot(raw, workspace) {
	const home = os.homedir();
	if (raw === "~") return home;
	if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.resolve(home, raw.slice(2));
	return path.resolve(workspace, raw);
}
/**
* Default audit root: the workspace-local .security-audit folder when it
* exists, else the (absolute) fallback root.
*/
async function defaultAuditRoot(workspace, fallbackAbs) {
	const local = path.join(workspace, LOCAL_AUDIT_DIR);
	try {
		if ((await fs.stat(local)).isDirectory()) return local;
	} catch {}
	return fallbackAbs;
}
//#endregion
//#region src/index.ts
/**
* Host half of the dsh-sidebar-security-audit plugin: one fenced, read-only
* route family (/api/dsh-sidebar-security-audit/*) that lets the
* dsh-better-sidebar panel discover and read cloudflare/security-audit skill
* runs — findings.json, REPORT.md, FINDINGS-DETAIL.md, architecture.md.
*
* Default audit root: the live workspace's .security-audit folder when it
* exists, else the skill's default output root (~/security-audit-skill;
* customizable via fallbackRoot / auditRoot config). An explicit root
* override (panel input; ~-, or workspace-relative) must be an existing
* directory. Every served path is contained inside the audit root in use,
* with symlink-escape refusal.
* @module dsh-sidebar-security-audit
*/
/** Plugin identity for the cordis patch row. */
const name = "dsh-sidebar-security-audit";
/** Services required before mounting. `sessions` backs workspace cwd discovery. */
const inject = [
	"webServer",
	"webRuntime",
	"sessions"
];
/** The route family prefix. */
const API_PREFIX = "/api/dsh-sidebar-security-audit";
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
function resolvedSettings(ctx) {
	const cfg = ctx.plugin?.config ?? {};
	return {
		auditRoot: typeof cfg.auditRoot === "string" && cfg.auditRoot !== "" ? cfg.auditRoot : "",
		fallbackRoot: typeof cfg.fallbackRoot === "string" && cfg.fallbackRoot !== "" ? cfg.fallbackRoot : FALLBACK_ROOT
	};
}
/**
* Workspace the panel treats as local: the live session cwd when the host
* exposes sessions (initiator first, then any session), else the process cwd.
*/
function currentWorkspace(ctx) {
	const initiator = (ctx.get?.("agents"))?.currentInitiator?.();
	const cwd = (initiator !== void 0 && initiator.id !== void 0 ? ctx.sessions?.get?.(initiator.id) : void 0)?.header?.cwd ?? ctx.sessions?.list?.().find((s) => s?.header?.cwd !== void 0)?.header?.cwd;
	return cwd !== void 0 && cwd !== "" ? cwd : process.cwd();
}
/** Resolve a requested run directory inside the audit root, or refuse. */
async function guardedDir(auditRoot, raw, res) {
	if (raw === null || raw === "") {
		writeJson(res, 400, { error: "missing dir parameter" });
		return null;
	}
	const dir = resolveInside(auditRoot, raw);
	if (dir === null) {
		writeJson(res, 403, { error: "run directory outside the audit root" });
		return null;
	}
	if (!await isSafeInside(auditRoot, dir)) {
		writeJson(res, 403, { error: "run directory fails containment check (symlink escape?)" });
		return null;
	}
	return dir;
}
async function handleRequest(ctx, req, res) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const sub = url.pathname.slice(31) || "/";
	const workspace = currentWorkspace(ctx);
	const settings = resolvedSettings(ctx);
	const defaultRoot = settings.auditRoot !== "" ? expandRoot(settings.auditRoot, workspace) : await defaultAuditRoot(workspace, expandRoot(settings.fallbackRoot, workspace));
	if (sub === "/health") {
		writeJson(res, 200, {
			ok: true,
			root: defaultRoot,
			workspace
		});
		return;
	}
	if (sub === "/runs") {
		const requested = url.searchParams.get("root") ?? "";
		if (requested === "") {
			writeJson(res, 200, {
				root: defaultRoot,
				workspace,
				runs: await scanRuns(defaultRoot)
			});
			return;
		}
		const root = expandRoot(requested, workspace);
		try {
			if (!(await fs.stat(root)).isDirectory()) {
				writeJson(res, 400, { error: `audit root is not a directory: ${root}` });
				return;
			}
		} catch {
			writeJson(res, 400, { error: `audit root does not exist: ${root}` });
			return;
		}
		writeJson(res, 200, {
			root,
			workspace,
			runs: await scanRuns(root)
		});
		return;
	}
	if (sub === "/findings" || sub === "/report") {
		const rootParam = url.searchParams.get("root");
		if (rootParam === null || rootParam === "") {
			writeJson(res, 400, { error: "missing root parameter" });
			return;
		}
		const dir = await guardedDir(expandRoot(rootParam, workspace), url.searchParams.get("dir"), res);
		if (dir === null) return;
		const file = sub === "/findings" ? "findings.json" : url.searchParams.get("file");
		if (file === null || file === "") {
			writeJson(res, 400, { error: "missing file parameter" });
			return;
		}
		const result = await readRunFile(dir, file);
		if ("error" in result) {
			writeJson(res, result.error.startsWith("file not found") ? 404 : 400, result);
			return;
		}
		writeJson(res, 200, {
			dir,
			file,
			...result
		});
		return;
	}
	writeJson(res, 404, { error: "not found" });
}
/** Plugin body: mount the fenced read-only routes. */
function apply(ctx) {
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
					await handleRequest(ctx, req, res);
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
	}, "dsh-sidebar-security-audit: routes");
}
//#endregion
export { API_PREFIX, apply, inject, isSafeInside, name, readRunFile, resolveInside, scanRuns, summarizeFindings };
