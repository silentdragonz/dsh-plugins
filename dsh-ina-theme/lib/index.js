/**
 * Host half of dsh-ina-theme.
 *
 * Owns a tiny fenced settings API for the client half:
 *   GET  /api/dsh-ina-theme/settings  -> { enabled, scheme }
 *   POST /api/dsh-ina-theme/settings  -> save, echo stored value
 *
 * Persistence is a plain JSON document at $DSH_HOME/ina-theme.json
 * (same convention as other local bundles' state files). The route carries
 * the standard browser-trust fence: loopback or configured trusted Host
 * header, cross-site markers refused.
 *
 * @module dsh-ina-theme
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Plugin identity for the cordis patch row. */
export const name = 'dsh-ina-theme'

/** Services required before mounting. */
export const inject = ['webServer', 'webRuntime']

/** The route path. */
export const API_PATH = '/api/dsh-ina-theme/settings'

const SCHEMES = ['system', 'light', 'dark']

function settingsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'ina-theme.json')
}

function defaultSettings() {
  return { enabled: true, scheme: 'system' }
}

/** Coerce any parsed body into the valid settings shape. */
function sanitize(raw) {
  const out = defaultSettings()
  if (raw !== null && typeof raw === 'object') {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    if (SCHEMES.includes(raw.scheme)) out.scheme = raw.scheme
  }
  return out
}

function loadSettings() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')))
  } catch {
    return defaultSettings()
  }
}

function saveSettings(next) {
  const target = settingsPath()
  const tmp = target + '.tmp'
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  fs.renameSync(tmp, target)
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Browser-trust fence, behaviorally identical to the /api gateway's fence
 * (loopback Host or a configured trusted authority passes; cross-site browser
 * markers refuse). Copied because the shared helper is not exported by the
 * DSH packages (dsh-better-sidebar and dsh-sidebar-security-audit do the
 * same). DNS-rebinding / cross-site defense, not authentication.
 */
function isTrustedApiRequest(req, trustedHosts) {
  const host = req.headers['host']
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const parts = hostUrl.hostname.split('.')
  const loopback =
    hostUrl.hostname === 'localhost' ||
    hostUrl.hostname === '[::1]' ||
    (parts.length === 4 &&
      parts[0] === '127' &&
      parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255))
  if (!loopback) {
    const trusted = (trustedHosts || []).some((entry) => {
      try {
        const u = new URL(`http://${entry}`)
        return u.hostname === hostUrl.hostname || u.host === hostUrl.host
      } catch {
        return false
      }
    })
    if (!trusted) return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers['origin']
  if (typeof origin === 'string') {
    try {
      return new URL(origin).host === hostUrl.host
    } catch {
      return false
    }
  }
  return true
}

/** Plugin body. */
export function apply(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
        writeJson(res, 403, { error: 'untrusted request' })
        return
      }
      if (req.method === 'GET') {
        writeJson(res, 200, loadSettings())
        return
      }
      if (req.method === 'POST') {
        try {
          const body = await readBody(req)
          const next = sanitize(JSON.parse(body))
          saveSettings(next)
          writeJson(res, 200, next)
        } catch {
          writeJson(res, 400, { error: 'invalid settings body' })
        }
        return
      }
      writeJson(res, 405, { error: 'method not allowed' })
    },
  })
  ctx.effect(() => dispose, 'dsh-ina-theme: settings route')
}
