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
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
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
 * Workspace the panel treats as local: the live session cwd when the host
 * exposes sessions (initiator first, then any session), else the process cwd.
 */
function currentWorkspace(ctx: PluginContext): string {
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
  const workspace = currentWorkspace(ctx)
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
