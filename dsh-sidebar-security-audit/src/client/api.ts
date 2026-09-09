/**
 * Fetch helpers for the plugin's own fenced host routes
 * (/api/dsh-sidebar-security-audit/*, served by the same origin).
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
  /** Raw findings.json content for one run directory. */
  findings: (dir: string): Promise<TextFileResponse> =>
    getJson<TextFileResponse>('/findings', { dir }),
  /** Raw text of one whitelisted artifact file (REPORT.md etc.). */
  report: (dir: string, file: string): Promise<TextFileResponse> =>
    getJson<TextFileResponse>('/report', { dir, file }),
}
