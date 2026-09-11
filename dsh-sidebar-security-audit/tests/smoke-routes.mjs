
import http from 'node:http'
import assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// Sandbox first: fake $HOME (~ expansion target); lib is imported after so
// any homedir caching still sees it.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dsa-smoke-'))
const home = path.join(sandbox, 'home')
const workspace = path.join(sandbox, 'workspace')
await fs.mkdir(home)
await fs.mkdir(workspace)
process.env.HOME = home
const mod = await import('../lib/index.js')

const FINDINGS = JSON.stringify([
  { verdict: 'confirmed', title: 'sql injection', description: 'user input reaches the query', severity: { overall_severity: 'high' } },
  { verdict: 'needs_validation', title: 'ssti maybe', claimed_root_cause: 'rendered user text', blockers: ['needs a template flag'], validation_plan: { local: 'probe {{7*7}}' } },
  { verdict: 'rejected', title: 'false positive', reason: 'parameterized upstream' },
])
const REPORT = '# synthetic report\n'

/** Create a run directory with the two artifacts under root/repo/name. */
async function makeRun(root, repo, name) {
  const dir = path.join(root, repo, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'findings.json'), FINDINGS)
  await fs.writeFile(path.join(dir, 'REPORT.md'), REPORT)
  return dir
}

// Mock the injected services; capture the registered route. Sessions expose
// the sandbox workspace the way live sessions expose their header cwd.
let route = null
const ctx = {
  webServer: { register(r) { route = r; return () => { route = null } } },
  webRuntime: { trustedHosts: [] },
  sessions: {
    get: () => ({ header: { cwd: workspace } }),
    list: () => [{ header: { cwd: workspace } }],
  },
  effect(fn) { fn(); return () => {} },
}
mod.apply(ctx)
assert.ok(route, 'route registered')
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/api/dsh-sidebar-security-audit')
// cordis refuses property access to undeclared services: sessions backs
// workspace cwd discovery and MUST stay declared in inject.
assert.ok(mod.inject.includes('sessions'), 'inject declares sessions')

const server = http.createServer((req, res) => route.handler(req, res))
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

async function get(p, headers = {}) {
  const resp = await fetch('http://127.0.0.1:' + port + p, { headers: { host: '127.0.0.1:' + port, ...headers } })
  return { status: resp.status, body: await resp.json().catch(() => undefined) }
}
const q = (o) => new URLSearchParams(o).toString()
const API = '/api/dsh-sidebar-security-audit'

// --- default root discovery: workspace/.security-audit wins when present
const localRoot = path.join(workspace, '.security-audit')
await makeRun(localRoot, 'sample-app', 'run-1')
const health = await get(`${API}/health`)
console.log('health:', JSON.stringify(health))
assert.equal(health.status, 200)
assert.equal(health.body.root, localRoot)
assert.equal(health.body.workspace, workspace)

const runs = await get(`${API}/runs`)
console.log('runs:', JSON.stringify(runs.body.runs.map(r => ({ repo: r.repo, name: r.name, counts: r.counts && r.counts.confirmed + '/' + r.counts.rejected, sev: r.counts && r.counts.severity.high }))))
assert.equal(runs.status, 200)
assert.equal(runs.body.root, localRoot)
assert.equal(runs.body.workspace, workspace)
assert.ok(runs.body.runs.some(r => r.repo === 'sample-app' && r.name === 'run-1'))
const sample = runs.body.runs.find(r => r.repo === 'sample-app')
const fnd = await get(`${API}/findings?` + q({ dir: sample.dir, root: localRoot }))
assert.equal(JSON.parse(fnd.body.content).length, 3)

const rep = await get(`${API}/report?` + q({ dir: sample.dir, file: 'REPORT.md', root: localRoot }))
assert.equal(rep.status, 200)
assert.ok(rep.body.content.includes('synthetic'))

// --- security: escape, wrong root, missing root, non-whitelisted file, cross-site, POST
const esc = await get(`${API}/findings?` + q({ dir: '/etc', root: localRoot }))
assert.equal(esc.status, 403)
const otherRoot = path.join(workspace, 'other-audits')
const mismatched = await get(`${API}/findings?` + q({ dir: sample.dir, root: otherRoot }))
assert.equal(mismatched.status, 403)
const noRoot = await get(`${API}/findings?` + q({ dir: sample.dir }))
assert.equal(noRoot.status, 400)
const badFile = await get(`${API}/report?` + q({ dir: sample.dir, file: '../../.bashrc', root: localRoot }))
assert.equal(badFile.status, 400)
const xsite = await get(`${API}/health`, { 'sec-fetch-site': 'cross-site' })
assert.equal(xsite.status, 403)
const post = await fetch('http://127.0.0.1:' + port + `${API}/health`, { method: 'POST', headers: { host: '127.0.0.1:' + port } })
assert.equal(post.status, 405)
const nf = await get(`${API}/nope`)
assert.equal(nf.status, 404)

// --- root override: any local directory is now scannable (outside of any fixed base)
const overrideBase = path.join(sandbox, 'other-audits')
await makeRun(overrideBase, 'demo', 'run-2')
const ov = await get(`${API}/runs?` + q({ root: overrideBase }))
console.log('override:', JSON.stringify(ov.body.root))
assert.equal(ov.status, 200)
assert.ok(ov.body.runs.some(r => r.repo === 'demo' && r.name === 'run-2'))

// ~ expansion against $HOME
const tildeBase = path.join(home, 'audits-home')
await makeRun(tildeBase, 'demo', 'run-3')
const tilde = await get(`${API}/runs?` + q({ root: '~/audits-home' }))
assert.equal(tilde.status, 200)
assert.equal(tilde.body.root, tildeBase)
const relBase = path.join(workspace, 'local-audits')
await makeRun(relBase, 'demo', 'run-4')
const rel = await get(`${API}/runs?` + q({ root: 'local-audits' }))
assert.equal(rel.status, 200)
assert.equal(rel.body.root, relBase)

// nonexistent override → explicit error, not a silent empty scan
const missing = await get(`${API}/runs?` + q({ root: path.join(sandbox, 'missing') }))
assert.equal(missing.status, 400)
assert.ok(String(missing.body.error).includes('does not exist'))

// --- fallback: no workspace/.security-audit → fallbackRoot (customizable, ~-expanded)
await fs.rm(localRoot, { recursive: true })
ctx.plugin = { config: { fallbackRoot: '~/audits-fallback' } }
await makeRun(path.join(home, 'audits-fallback'), 'demo', 'run-5')
const fb = await get(`${API}/runs`)
assert.equal(fb.status, 200)
assert.equal(fb.body.root, path.join(home, 'audits-fallback'))
assert.ok(fb.body.runs.some(r => r.repo === 'demo' && r.name === 'run-5'))

// --- auditRoot pins the default outright (wins over workspace discovery)
await makeRun(localRoot, 'sample-app', 'run-1')
ctx.plugin = { config: { auditRoot: '~/audits-pinned' } }
await makeRun(path.join(home, 'audits-pinned'), 'pinned', 'run-6')
const pinned = await get(`${API}/runs`)
assert.equal(pinned.status, 200)
assert.equal(pinned.body.root, path.join(home, 'audits-pinned'))
assert.ok(pinned.body.runs.some(r => r.repo === 'pinned' && r.name === 'run-6'))

server.close()
await fs.rm(sandbox, { recursive: true, force: true })
console.log('ALL ROUTE TESTS PASSED')
