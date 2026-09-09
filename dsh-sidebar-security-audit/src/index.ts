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
import * as path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isTrustedApiRequest } from './host/fence.ts'
import {
  DEFAULT_BASE, DEFAULT_ROOT,
  isSafeInside, readRunFile, resolveInside, scanRuns,
} from './host/scan.ts'

export { scanRuns, readRunFile, resolveInside, isSafeInside, summarizeFindings, DEFAULT_BASE, DEFAULT_ROOT } from './host/scan.ts'

/** Plugin identity for the cordis patch row. */
export const name = 'dsh-sidebar-security-audit'

/** Services required before mounting. */
export const inject = ['webServer', 'webRuntime']

/** Optional plugin config (cordis patch row `config:`). */
export interface PluginSettings {
  /** Audit root the panel defaults to (inside `base`). */
  auditRoot?: string
  /** Containment base for every served path. */
  base?: string
}

interface PluginWebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Structural face of the host context (mirrors the actual runtime shape). */
export interface PluginContext {
  webServer: PluginWebServer
  webRuntime: { trustedHosts: readonly string[] }
  plugin?: { config?: PluginSettings }
  effect(fn: () => void | (() => void), label?: string): unknown
}

/** The route family prefix. */
export const API_PREFIX = '/api/dsh-sidebar-security-audit'

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

function resolvedSettings(ctx: PluginContext): { auditRoot: string; base: string } {
  const cfg = ctx.plugin?.config ?? {}
  const auditRoot = typeof cfg.auditRoot === 'string' && cfg.auditRoot !== '' ? cfg.auditRoot : DEFAULT_ROOT
  const base = typeof cfg.base === 'string' && cfg.base !== ''
    ? cfg.base
    : auditRoot === DEFAULT_ROOT ? DEFAULT_BASE : path.dirname(auditRoot)
  return { auditRoot, base }
}

/** Resolve a requested path parameter inside the base, or refuse. */
async function guardedDir(base: string, raw: string | null, res: ServerResponse): Promise<string | null> {
  if (raw === null || raw === '') {
    writeJson(res, 400, { error: 'missing dir parameter' })
    return null
  }
  const abs = resolveInside(base, raw)
  if (abs === null) {
    writeJson(res, 403, { error: 'path outside the allowed base directory' })
    return null
  }
  if (!(await isSafeInside(base, abs))) {
    writeJson(res, 403, { error: 'path fails containment check (symlink escape?)' })
    return null
  }
  return abs
}

async function handleRequest(ctx: PluginContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const sub = url.pathname.slice(API_PREFIX.length) || '/'
  const { auditRoot, base } = resolvedSettings(ctx)

  if (sub === '/health') {
    writeJson(res, 200, { ok: true, root: auditRoot, base })
    return
  }
  if (sub === '/runs') {
    const requested = url.searchParams.get('root')
    const root = requested !== null && requested !== ''
      ? resolveInside(base, requested)
      : resolveInside(base, auditRoot)
    if (root === null) {
      writeJson(res, 403, { error: 'root outside the allowed base directory' })
      return
    }
    if (!(await isSafeInside(base, root))) {
      writeJson(res, 403, { error: 'root fails containment check (symlink escape?)' })
      return
    }
    const runs = await scanRuns(root)
    writeJson(res, 200, { root, base, runs })
    return
  }
  if (sub === '/findings' || sub === '/report') {
    const dir = await guardedDir(base, url.searchParams.get('dir'), res)
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
