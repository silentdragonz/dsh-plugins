/**
 * Host half of the dsh-sidebar-security-audit plugin: one fenced, read-only
 * route family (/api/dsh-sidebar-security-audit/*) that lets the
 * dsh-better-sidebar panel discover and read cloudflare/security-audit skill
 * runs — findings.json, REPORT.md, FINDINGS-DETAIL.md, architecture.md.
 *
 * Default audit root: the panel's workspace .security-audit folder when it
 * exists (the workspace is the session the panel tab is scoped to, sent as
 * the `session` param and resolved via the sessions service; else the
 * client's `cwd` hint, then host-side guesses), else the skill's default
 * output root (~/security-audit-skill; customizable via fallbackRoot /
 * auditRoot config). An explicit root
 * override (panel input; ~-, or workspace-relative) must be an existing
 * directory. Every served path is contained inside the audit root in use,
 * with symlink-escape refusal.
 * @module dsh-sidebar-security-audit
 */
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isTrustedApiRequest } from './host/fence.ts'
import {
  FALLBACK_ROOT, defaultAuditRoot, expandRoot,
  isSafeInside, readRunFile, resolveInside, scanRuns,
} from './host/scan.ts'

export { scanRuns, readRunFile, resolveInside, isSafeInside, summarizeFindings } from './host/scan.ts'

/** Plugin identity for the cordis patch row. */
export const name = 'dsh-sidebar-security-audit'

/** Services required before mounting. `sessions` backs workspace cwd discovery. */
export const inject = ['webServer', 'webRuntime', 'sessions']

/** Optional plugin config (cordis patch row `config:`). */
export interface PluginSettings {
  /** Explicit audit root, expanded at use (~ → home; relative → against the workspace). */
  auditRoot?: string
  /** Audit root used when the workspace has no .security-audit folder (default ~/security-audit-skill). */
  fallbackRoot?: string
}

interface PluginWebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Loose face of a live harness session (header carries the workspace cwd). */
export interface SessionFace { header?: { cwd?: string } }

/** Structural face of the host context (mirrors the actual runtime shape). */
export interface PluginContext {
  webServer: PluginWebServer
  webRuntime: { trustedHosts: readonly string[] }
  plugin?: { config?: PluginSettings }
  /** Host registry lookup (the agents service), when present. */
  get?(id: string): unknown
  /** Host sessions service, when present. */
  sessions?: {
    get?(id: string): SessionFace | undefined
    list?(): SessionFace[]
  }
  effect(fn: () => void | (() => void), label?: string): unknown
}

/** The route family prefix. */
export const API_PREFIX = '/api/dsh-sidebar-security-audit'

/**
 * Editors opened by spawning their CLI with the file as argument. Zed's
 * `zed://file/...` URL route ignores `cli_default_open_behavior` and opens a
 * file-only project that replaces the already-open workspace window; the CLI
 * path-argument form (`zed <file>[:<line>]`) honors it and reuses the
 * workspace window, so file links for these apps go through /open-file.
 */
const CLI_FILE_EDITORS: ReadonlySet<string> = new Set(['zed'])

/** Max request body bytes accepted by /open-file. */
const MAX_OPEN_BODY_BYTES = 65536

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

function resolvedSettings(ctx: PluginContext): { auditRoot: string; fallbackRoot: string } {
  const cfg = ctx.plugin?.config ?? {}
  return {
    auditRoot: typeof cfg.auditRoot === 'string' && cfg.auditRoot !== '' ? cfg.auditRoot : '',
    fallbackRoot: typeof cfg.fallbackRoot === 'string' && cfg.fallbackRoot !== '' ? cfg.fallbackRoot : FALLBACK_ROOT,
  }
}

/**
 * Workspace the panel treats as local. Route handlers run outside model-call
 * context, so the panel's own scope is the only per-tab signal: the tab's
 * `session` id first (resolved through the sessions service to the
 * authoritative header cwd), then the client's list-summary `cwd` hint when
 * the id misses, then the live initiator's session, then any session, then
 * the process cwd. Without the session parameter a tab browsing another
 * workspace would be served the first session's (or the harness's) cwd.
 */
function currentWorkspace(ctx: PluginContext, sessionId: string, cwdHint: string): string {
  if (sessionId !== '') {
    const cwd = ctx.sessions?.get?.(sessionId)?.header?.cwd
    if (cwd !== undefined && cwd !== '') return cwd
  }
  if (cwdHint !== '' && path.isAbsolute(cwdHint)) return cwdHint
  const agents = ctx.get?.('agents') as { currentInitiator?: () => { id?: string } | undefined } | undefined
  const initiator = agents?.currentInitiator?.()
  const session = initiator !== undefined && initiator.id !== undefined
    ? ctx.sessions?.get?.(initiator.id)
    : undefined
  const cwd = session?.header?.cwd
    ?? ctx.sessions?.list?.().find(s => s?.header?.cwd !== undefined)?.header?.cwd
  return cwd !== undefined && cwd !== '' ? cwd : process.cwd()
}

/** Resolve a requested run directory inside the audit root, or refuse. */
async function guardedDir(auditRoot: string, raw: string | null, res: ServerResponse): Promise<string | null> {
  if (raw === null || raw === '') {
    writeJson(res, 400, { error: 'missing dir parameter' })
    return null
  }
  const dir = resolveInside(auditRoot, raw)
  if (dir === null) {
    writeJson(res, 403, { error: 'run directory outside the audit root' })
    return null
  }
  if (!(await isSafeInside(auditRoot, dir))) {
    writeJson(res, 403, { error: 'run directory fails containment check (symlink escape?)' })
    return null
  }
  return dir
}

async function handleRequest(ctx: PluginContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const sub = url.pathname.slice(API_PREFIX.length) || '/'
  const workspace = currentWorkspace(
    ctx,
    url.searchParams.get('session') ?? '',
    url.searchParams.get('cwd') ?? '',
  )
  const settings = resolvedSettings(ctx)
  const defaultRoot = settings.auditRoot !== ''
    ? expandRoot(settings.auditRoot, workspace)
    : await defaultAuditRoot(workspace, expandRoot(settings.fallbackRoot, workspace))

  if (sub === '/health') {
    writeJson(res, 200, { ok: true, root: defaultRoot, workspace })
    return
  }
  if (sub === '/runs') {
    const requested = url.searchParams.get('root') ?? ''
    if (requested === '') {
      writeJson(res, 200, { root: defaultRoot, workspace, runs: await scanRuns(defaultRoot) })
      return
    }
    const root = expandRoot(requested, workspace)
    try {
      if (!(await fs.stat(root)).isDirectory()) {
        writeJson(res, 400, { error: `audit root is not a directory: ${root}` })
        return
      }
    } catch {
      writeJson(res, 400, { error: `audit root does not exist: ${root}` })
      return
    }
    writeJson(res, 200, { root, workspace, runs: await scanRuns(root) })
    return
  }
  if (sub === '/findings' || sub === '/report') {
    const rootParam = url.searchParams.get('root')
    if (rootParam === null || rootParam === '') {
      writeJson(res, 400, { error: 'missing root parameter' })
      return
    }
    const auditRoot = expandRoot(rootParam, workspace)
    const dir = await guardedDir(auditRoot, url.searchParams.get('dir'), res)
    if (dir === null) return
    const file = sub === '/findings' ? 'findings.json' : url.searchParams.get('file')
    if (file === null || file === '') {
      writeJson(res, 400, { error: 'missing file parameter' })
      return
    }
    const result = await readRunFile(dir, file)
    if ('error' in result) {
      writeJson(res, result.error.startsWith('file not found') ? 404 : 400, result)
      return
    }
    writeJson(res, 200, { dir, file, ...result })
    return
  }
  writeJson(res, 404, { error: 'not found' })
}

/**
 * Resolve candidate Zed CLI executables: PATH names first (`zed`, then the
 * Fedora/RHEL package name `zeditor`), then the command token of the
 * dev.zed.Zed desktop entry (the same launcher the harness open-in-app
 * catalog uses on Linux). Absolute tokens verify on disk; bare names are
 * verified against PATH by the spawn itself.
 */
async function zedCliCandidates(): Promise<string[]> {
  const found: string[] = []
  const add = (candidate: string): void => {
    if (candidate !== '' && !found.includes(candidate)) found.push(candidate)
  }
  for (const name of ['zed', 'zeditor']) {
    const dirs = (process.env.PATH ?? '').split(path.delimiter)
    if (dirs.some(entry => entry !== '' && fsSync.existsSync(path.join(entry, name)))) add(name)
  }
  for (const dir of [
    path.join(os.homedir(), '.local/share/applications'),
    '/usr/share/applications',
    '/usr/local/share/applications',
  ]) {
    try {
      const text = await fs.readFile(path.join(dir, 'dev.zed.Zed.desktop'), 'utf8')
      const exec = text.split(/\r?\n/).find(line => line.startsWith('Exec='))
      if (exec !== undefined) {
        const quoted = /^Exec="([^"]+)"/.exec(exec)
        const command = quoted?.[1] ?? exec.slice(5).trim().split(/\s+/)[0] ?? ''
        if (command !== '' && path.isAbsolute(command) && !fsSync.existsSync(command)) continue
        add(command)
      }
      break
    } catch { /* no desktop entry in this directory */ }
  }
  return found
}

/** Spawn one candidate detached; resolves true once the child spawned. */
function spawnDetached(command: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
      child.once('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

/** Read a bounded request body; null when oversized or unreadable. */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_OPEN_BODY_BYTES) return null
      chunks.push(chunk as Buffer)
    }
  } catch {
    return null
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Append one diagnostic line per /open-file request (debug aid). */
function openFileLog(message: string): void {
  try {
    fsSync.appendFileSync(
      path.join(os.homedir(), '.dsh', 'tmp', 'zed-open.log'),
      `${new Date().toISOString()} ${message}\n`,
    )
  } catch { /* logging is best-effort */ }
}

/**
 * POST /open-file {app, path, line?}: open one existing absolute file in a
 * CLI-file editor by spawning `<cli> <path>[:<line>]` — the launch form that
 * reuses the running editor's open workspace window (Zed's zed:// URL route
 * does not; it replaces the window with a file-only project).
 */
async function handleOpenFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const text = await readBody(req)
  if (text === null) {
    writeJson(res, 413, { error: 'request body too large' })
    return
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    writeJson(res, 400, { error: 'body must be JSON' })
    return
  }
  if (body === null || typeof body !== 'object') {
    writeJson(res, 400, { error: 'body must be a JSON object' })
    return
  }
  const { app, path: file, line } = body as { app?: unknown; path?: unknown; line?: unknown }
  if (typeof app !== 'string' || !CLI_FILE_EDITORS.has(app)) {
    writeJson(res, 400, { error: `app must be one of: ${[...CLI_FILE_EDITORS].join(', ')}` })
    return
  }
  if (typeof file !== 'string' || file === '' || !path.isAbsolute(file)) {
    writeJson(res, 400, { error: 'path must be an absolute file path' })
    return
  }
  if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
    writeJson(res, 400, { error: 'line must be a positive integer' })
    return
  }
  const stat = await fs.stat(file).catch(() => undefined)
  if (stat === undefined) {
    openFileLog(`404 missing file=${file} line=${String(line)}`)
    writeJson(res, 404, { error: `file does not exist: ${file}` })
    return
  }
  if (!stat.isFile()) {
    writeJson(res, 400, { error: `path is not a regular file: ${file}` })
    return
  }
  const target = line !== undefined ? `${file}:${line}` : file
  const candidates = await zedCliCandidates()
  for (const candidate of candidates) {
    if (await spawnDetached(candidate, [target])) {
      openFileLog(`ok launched=${candidate} target=${target}`)
      writeJson(res, 200, { ok: true, launched: candidate })
      return
    }
  }
  openFileLog(`fail candidates=[${candidates.join(', ')}] target=${target}`)
  writeJson(res, 502, {
    error: candidates.length === 0
      ? 'no zed CLI found (tried zed, zeditor, dev.zed.Zed desktop entry)'
      : `failed to launch: ${candidates.join(', ')}`,
  })
}

/** Plugin body: mount the fenced read-only routes. */
export function apply(ctx: PluginContext): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          if (!isTrustedApiRequest(req, ctx.webRuntime?.trustedHosts ?? [])) {
            writeJson(res, 403, { error: 'forbidden' })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          if ((req.method ?? 'GET') === 'POST' && pathname === `${API_PREFIX}/open-file`) {
            await handleOpenFile(req, res)
            return
          }
          if ((req.method ?? 'GET') !== 'GET') {
            writeJson(res, 405, { error: `method not allowed: ${req.method ?? ''}` })
            return
          }
          await handleRequest(ctx, req, res)
        } catch (e) {
          writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    })
    return () => {
      try {
        dispose()
      } catch { /* already disposed */ }
    }
  }, 'dsh-sidebar-security-audit: routes')
}
