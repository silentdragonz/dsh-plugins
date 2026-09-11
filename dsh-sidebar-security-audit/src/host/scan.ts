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
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

/** Workspace-local audit root folder the panel prefers when present. */
export const LOCAL_AUDIT_DIR = '.security-audit'
/** Fallback audit root (the skill's default output root, ~-expanded at use). */
export const FALLBACK_ROOT = '~/security-audit-skill'

/** File names a run directory may contain; also the read whitelist. */
export const RUN_FILES = ['findings.json', 'REPORT.md', 'FINDINGS-DETAIL.md', 'architecture.md'] as const
export type RunFile = typeof RUN_FILES[number]

/** Cap on parsed findings.json size (bytes). */
const MAX_FINDINGS_PARSE_BYTES = 8 * 1024 * 1024
/** Cap on one returned text file (bytes). */
const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024
/** Directory-walk safety caps. */
const MAX_REPOS = 300
const MAX_RUNS_PER_REPO = 100

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'informational'
const SEVERITIES: readonly string[] = ['critical', 'high', 'medium', 'low', 'informational']

export interface FindingCounts {
  total: number
  confirmed: number
  rejected: number
  severity: Record<Severity, number>
}

export interface RunInfo {
  /** Repository folder name (the run's parent), '.' when the root itself is a run. */
  repo: string
  /** Run directory name (e.g. run-1). */
  name: string
  /** Absolute path of the run directory. */
  dir: string
  /** Which known artifact files exist. */
  files: Partial<Record<RunFile, boolean>>
  /** Newest artifact mtime (ms epoch), 0 when unknown. */
  updatedAt: number
  /** Parsed findings.json summary (absent when the file is missing). */
  counts?: FindingCounts
  /** Non-fatal findings.json parse problem. */
  parseError?: string
}

function emptyCounts(): FindingCounts {
  return {
    total: 0, confirmed: 0, rejected: 0,
    severity: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
  }
}

/** Resolve candidate under base and require containment; null when escaping. */
export function resolveInside(base: string, candidate: string): string | null {
  const baseAbs = path.resolve(base)
  const abs = path.resolve(baseAbs, candidate)
  if (abs !== baseAbs && !abs.startsWith(baseAbs + path.sep)) return null
  return abs
}

/** Containment + symlink check: realpath of the deepest existing ancestor must stay inside base. */
export async function isSafeInside(base: string, abs: string): Promise<boolean> {
  const baseAbs = path.resolve(base)
  if (abs !== baseAbs && !abs.startsWith(baseAbs + path.sep)) return false
  // Walk up to the nearest existing ancestor, realpath it, re-check containment.
  let probe = abs
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      const realBase = await fs.realpath(baseAbs).catch(() => baseAbs)
      if (real !== realBase && !real.startsWith(realBase + path.sep)) return false
      return true
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name).sort()
  } catch {
    return []
  }
}

async function statFile(p: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const st = await fs.stat(p)
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

/** Summarize findings.json text (array of confirmed/rejected findings per report-schema.json). */
export function summarizeFindings(raw: string): { counts: FindingCounts; parseError?: string } {
  const counts = emptyCounts()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { counts, parseError: `findings.json is not valid JSON: ${(e as Error).message}` }
  }
  if (!Array.isArray(parsed)) return { counts, parseError: 'findings.json is not an array' }
  for (const item of parsed) {
    counts.total += 1
    if (item === null || typeof item !== 'object') { counts.rejected += 1; continue }
    const verdict = (item as Record<string, unknown>).verdict
    if (verdict === 'confirmed') {
      counts.confirmed += 1
      const sev = (item as Record<string, any>).severity?.overall_severity
      if (typeof sev === 'string' && SEVERITIES.includes(sev)) {
        counts.severity[sev as Severity] += 1
      }
    } else {
      counts.rejected += 1
    }
  }
  return { counts }
}

/** Build one RunInfo for a candidate run directory. */
async function inspectRun(repo: string, name: string, dir: string): Promise<RunInfo> {
  const files: Partial<Record<RunFile, boolean>> = {}
  let updatedAt = 0
  for (const file of RUN_FILES) {
    const st = await statFile(path.join(dir, file))
    if (st !== undefined) {
      files[file] = true
      if (st.mtimeMs > updatedAt) updatedAt = st.mtimeMs
    }
  }
  const info: RunInfo = { repo, name, dir, files, updatedAt }
  const findingsSt = await statFile(path.join(dir, 'findings.json'))
  if (findingsSt !== undefined && findingsSt.size <= MAX_FINDINGS_PARSE_BYTES) {
    try {
      const raw = await fs.readFile(path.join(dir, 'findings.json'), 'utf8')
      const { counts, parseError } = summarizeFindings(raw)
      info.counts = counts
      if (parseError !== undefined) info.parseError = parseError
    } catch (e) {
      info.parseError = `failed to read findings.json: ${(e as Error).message}`
    }
  }
  return info
}

/** True when dir holds at least one audit artifact. */
async function looksLikeRun(dir: string): Promise<boolean> {
  for (const file of RUN_FILES) {
    if (await statFile(path.join(dir, file)) !== undefined) return true
  }
  return false
}

/**
 * Scan a root for audit runs. Layout: <root>/<repo>/run-<N>/… ; a root that is
 * itself a run directory is returned as a single entry (repo '.').
 */
export async function scanRuns(root: string): Promise<RunInfo[]> {
  if (await looksLikeRun(root)) {
    return [await inspectRun('.', path.basename(root), root)]
  }
  const runs: RunInfo[] = []
  const repos = await listDirs(root)
  for (const repo of repos.slice(0, MAX_REPOS)) {
    const repoDir = path.join(root, repo)
    // A repo-level artifact directory (run files directly inside).
    if (await looksLikeRun(repoDir)) {
      runs.push(await inspectRun(path.basename(root) === repo ? '.' : repo, repo, repoDir))
      continue
    }
    const children = await listDirs(repoDir)
    for (const child of children.slice(0, MAX_RUNS_PER_REPO)) {
      const childDir = path.join(repoDir, child)
      if (await looksLikeRun(childDir)) runs.push(await inspectRun(repo, child, childDir))
    }
  }
  runs.sort((a, b) => b.updatedAt - a.updatedAt)
  return runs
}

export interface TextFileResult {
  content: string
  truncated: boolean
}

/** Read one whitelisted artifact file from a run directory. */
export async function readRunFile(dir: string, file: string): Promise<TextFileResult | { error: string }> {
  if (!(RUN_FILES as readonly string[]).includes(file)) {
    return { error: `file not allowed: ${file}` }
  }
  const st = await statFile(path.join(dir, file))
  if (st === undefined) return { error: `file not found: ${file}` }
  const handle = await fs.open(path.join(dir, file), 'r')
  try {
    const length = Math.min(st.size, MAX_TEXT_FILE_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    return { content: buffer.toString('utf8'), truncated: st.size > MAX_TEXT_FILE_BYTES }
  } finally {
    await handle.close()
  }
}

/** Expand a configured/requested root: `~` → home, relative → against the workspace. */
export function expandRoot(raw: string, workspace: string): string {
  const home = os.homedir()
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.resolve(home, raw.slice(2))
  return path.resolve(workspace, raw)
}


/**
 * Default audit root: the workspace-local .security-audit folder when it
 * exists, else the (absolute) fallback root.
 */
export async function defaultAuditRoot(workspace: string, fallbackAbs: string): Promise<string> {
  const local = path.join(workspace, LOCAL_AUDIT_DIR)
  try {
    if ((await fs.stat(local)).isDirectory()) return local
  } catch { /* not present */ }
  return fallbackAbs
}
