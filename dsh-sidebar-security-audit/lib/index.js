import * as path from "node:path";
import * as fs from "node:fs/promises";
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
* findings.json / REPORT.md / FINDINGS-DETAIL.md / architecture.md — under a
* root directory (default /workspace/workspace/security-audit-skill, the
* skill's default output root in this deployment). Every resolved path must
* stay inside the configured base (default /workspace/workspace); symlinked
* escapes are refused via realpath containment of the existing ancestor.
*/
/** Default containment base — every served path lives under this directory. */
const DEFAULT_BASE = "/workspace/workspace";
/** Default audit root (the security-audit skill's default output root here). */
const DEFAULT_ROOT = "/workspace/workspace/security-audit-skill";
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
/** Summarize findings.json text (array of confirmed/rejected findings per report-schema.json). */
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
		if (item.verdict === "confirmed") {
			counts.confirmed += 1;
			const sev = item.severity?.overall_severity;
			if (typeof sev === "string" && SEVERITIES.includes(sev)) counts.severity[sev] += 1;
		} else counts.rejected += 1;
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
//#endregion
//#region src/index.ts
/**
* Host half of the dsh-sidebar-security-audit plugin: one fenced, read-only
* route family (/api/dsh-sidebar-security-audit/*) that lets the
* dsh-better-sidebar panel discover and read cloudflare/security-audit skill
* runs — findings.json, REPORT.md, FINDINGS-DETAIL.md, architecture.md.
*
* Default audit root: /workspace/workspace/security-audit-skill (the skill's
* default output root in this deployment — the global ~ directory is not
* writable here). Every served path is contained inside the base directory
* (default /workspace/workspace), with symlink-escape refusal.
* @module dsh-sidebar-security-audit
*/
/** Plugin identity for the cordis patch row. */
const name = "dsh-sidebar-security-audit";
/** Services required before mounting. */
const inject = ["webServer", "webRuntime"];
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
	const auditRoot = typeof cfg.auditRoot === "string" && cfg.auditRoot !== "" ? cfg.auditRoot : DEFAULT_ROOT;
	return {
		auditRoot,
		base: typeof cfg.base === "string" && cfg.base !== "" ? cfg.base : auditRoot === "/workspace/workspace/security-audit-skill" ? DEFAULT_BASE : path.dirname(auditRoot)
	};
}
/** Resolve a requested path parameter inside the base, or refuse. */
async function guardedDir(base, raw, res) {
	if (raw === null || raw === "") {
		writeJson(res, 400, { error: "missing dir parameter" });
		return null;
	}
	const abs = resolveInside(base, raw);
	if (abs === null) {
		writeJson(res, 403, { error: "path outside the allowed base directory" });
		return null;
	}
	if (!await isSafeInside(base, abs)) {
		writeJson(res, 403, { error: "path fails containment check (symlink escape?)" });
		return null;
	}
	return abs;
}
async function handleRequest(ctx, req, res) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const sub = url.pathname.slice(31) || "/";
	const { auditRoot, base } = resolvedSettings(ctx);
	if (sub === "/health") {
		writeJson(res, 200, {
			ok: true,
			root: auditRoot,
			base
		});
		return;
	}
	if (sub === "/runs") {
		const requested = url.searchParams.get("root");
		const root = requested !== null && requested !== "" ? resolveInside(base, requested) : resolveInside(base, auditRoot);
		if (root === null) {
			writeJson(res, 403, { error: "root outside the allowed base directory" });
			return;
		}
		if (!await isSafeInside(base, root)) {
			writeJson(res, 403, { error: "root fails containment check (symlink escape?)" });
			return;
		}
		writeJson(res, 200, {
			root,
			base,
			runs: await scanRuns(root)
		});
		return;
	}
	if (sub === "/findings" || sub === "/report") {
		const dir = await guardedDir(base, url.searchParams.get("dir"), res);
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
export { API_PREFIX, DEFAULT_BASE, DEFAULT_ROOT, apply, inject, isSafeInside, name, readRunFile, resolveInside, scanRuns, summarizeFindings };
