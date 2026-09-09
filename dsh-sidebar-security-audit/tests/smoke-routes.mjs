
import http from 'node:http'
import assert from 'node:assert'
import * as mod from '../lib/index.js'

// Mock the two injected services; capture the registered route.
let route = null
const ctx = {
  webServer: { register(r) { route = r; return () => { route = null } } },
  webRuntime: { trustedHosts: [] },
  effect(fn) { fn(); return () => {} },
}
mod.apply(ctx)
assert.ok(route, 'route registered')
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/api/dsh-sidebar-security-audit')

const server = http.createServer((req, res) => route.handler(req, res))
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

async function get(path, headers = {}) {
  const resp = await fetch('http://127.0.0.1:' + port + path, { headers: { host: '127.0.0.1:' + port, ...headers } })
  return { status: resp.status, body: await resp.json().catch(() => undefined) }
}

const health = await get('/api/dsh-sidebar-security-audit/health')
console.log('health:', JSON.stringify(health))
assert.equal(health.status, 200)
assert.equal(health.body.root, '/workspace/workspace/security-audit-skill')
assert.equal(health.body.base, '/workspace/workspace')

const runs = await get('/api/dsh-sidebar-security-audit/runs')
console.log('runs:', JSON.stringify(runs.body.runs.map(r => ({ repo: r.repo, name: r.name, counts: r.counts && r.counts.confirmed + '/' + r.counts.rejected, sev: r.counts && r.counts.severity.critical + r.counts.severity.high }))))
assert.ok(runs.body.runs.some(r => r.repo === 'sample-app' && r.name === 'run-1'))

const sample = runs.body.runs.find(r => r.repo === 'sample-app')
const fnd = await get('/api/dsh-sidebar-security-audit/findings?dir=' + encodeURIComponent(sample.dir))
assert.equal(fnd.status, 200)
assert.equal(JSON.parse(fnd.body.content).length, 2)

const rep = await get('/api/dsh-sidebar-security-audit/report?dir=' + encodeURIComponent(sample.dir) + '&file=REPORT.md')
assert.equal(rep.status, 200)
assert.ok(rep.body.content.includes('synthetic'))

// security: escape, non-whitelisted file, cross-site, POST
const esc = await get('/api/dsh-sidebar-security-audit/findings?dir=' + encodeURIComponent('/etc'))
assert.equal(esc.status, 403)
const bad = await get('/api/dsh-sidebar-security-audit/report?dir=' + encodeURIComponent(sample.dir) + '&file=../../.bashrc')
assert.equal(bad.status, 400)
const xsite = await get('/api/dsh-sidebar-security-audit/health', { 'sec-fetch-site': 'cross-site' })
assert.equal(xsite.status, 403)
const post = await fetch('http://127.0.0.1:' + port + '/api/dsh-sidebar-security-audit/health', { method: 'POST', headers: { host: '127.0.0.1:' + port } })
assert.equal(post.status, 405)
const nf = await get('/api/dsh-sidebar-security-audit/nope')
assert.equal(nf.status, 404)

server.close()
console.log('ALL ROUTE TESTS PASSED')
