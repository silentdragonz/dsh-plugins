/**
 * Fetch helpers for the plugin's own fenced host routes
 * (/api/dsh-sidebar-security-audit/*, served by the same origin), plus the
 * harness open-in-app routes (dsh >= 0.1.5-rc.1) that launch files'
 * directories in the user's default editor.
 */
import type { RunsResponse, TextFileResponse } from './types.ts'

const API = '/api/dsh-sidebar-security-audit'

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params).toString()
  const resp = await fetch(query.length > 0 ? `${API}${path}?${query}` : `${API}${path}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  })
  const body: unknown = await resp.json().catch(() => undefined)
  if (!resp.ok) {
    const message = body !== null && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${resp.status}`
    throw new Error(message)
  }
  return body as T
}

export const api = {
  /** List audit runs (default root when omitted). */
  runs: (root?: string): Promise<RunsResponse> =>
    getJson<RunsResponse>('/runs', root !== undefined && root !== '' ? { root } : {}),
  /** Raw findings.json content for one run directory (contained in `root`). */
  findings: (dir: string, root: string): Promise<TextFileResponse> =>
    getJson<TextFileResponse>('/findings', { dir, root }),
  /** Raw text of one whitelisted artifact file (REPORT.md etc.). */
  report: (dir: string, file: string, root: string): Promise<TextFileResponse> =>
    getJson<TextFileResponse>('/report', { dir, file, root }),
  /**
   * Open one existing absolute file in a host CLI editor (zed): the host
   * spawns `<cli> <path>[:<line>]`, the launch form that reuses the running
   * editor's open workspace window (the zed:// URL route replaces it with a
   * file-only project instead).
   */
  openFile: async (app: string, filePath: string, line?: number): Promise<void> => {
    const resp = await fetch(`${API}/open-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(line !== undefined ? { app, path: filePath, line } : { app, path: filePath }),
    })
    if (!resp.ok) {
      const body: unknown = await resp.json().catch(() => undefined)
      const message = body !== null && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${resp.status}`
      throw new Error(message)
    }
  },
}

/** The harness open-in-app routes (mounted on the same webServer origin). */
const OPEN_APPS_ROUTE = '/open-in-app/apps'
const OPEN_LAUNCH_ROUTE = '/open-in-app/open'

export const openInApp = {
  /**
   * App ids the host probed as installed (the harness's probed editor
   * catalog). Empty on any failure — a host without open-in-app renders no
   * file links at all.
   */
  apps: async (): Promise<string[]> => {
    try {
      const resp = await fetch(OPEN_APPS_ROUTE, { headers: { accept: 'application/json' } })
      if (!resp.ok) return []
      const body: unknown = await resp.json().catch(() => undefined)
      if (body === null || typeof body !== 'object' || !('apps' in body) || !Array.isArray(body.apps)) return []
      return body.apps.filter((id): id is string => typeof id === 'string')
    } catch {
      return []
    }
  },
  /** Launch one probed app on one absolute directory. */
  launch: async (app: string, path: string): Promise<void> => {
    const resp = await fetch(OPEN_LAUNCH_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app, path }),
    })
    if (!resp.ok) {
      const body: unknown = await resp.json().catch(() => undefined)
      const message = body !== null && typeof body === 'object' && 'message' in body
        ? String(body.message)
        : `HTTP ${resp.status}`
      throw new Error(message)
    }
  },
}

/** better-sidebar's external-open wire route (the sidebar file tree's "open with" channel). */
const OPEN_EXTERNAL_ROUTE = '/sidebar/api/open.external'

export const openExternal = {
  /**
   * Hand a custom-scheme URL (vscode://file/<path>:<line> …) to the OS
   * protocol handler via better-sidebar's host opener — the same channel
   * the sidebar's own file tree uses, so the file itself opens in the
   * editor (the harness open-in-app route only takes directories).
   */
  url: async (url: string): Promise<void> => {
    const resp = await fetch(OPEN_EXTERNAL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'url', url }),
    })
    const body: unknown = await resp.json().catch(() => undefined)
    const okFlag = body !== null && typeof body === 'object' && 'ok' in body ? body.ok : undefined
    if (!resp.ok || okFlag !== true) {
      const detail = body !== null && typeof body === 'object' && 'error' in body
        && body.error !== null && typeof body.error === 'object' && 'message' in body.error
        ? String(body.error.message)
        : `HTTP ${resp.status}`
      throw new Error(detail)
    }
  },
}
