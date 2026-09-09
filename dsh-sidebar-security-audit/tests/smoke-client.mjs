
import assert from 'node:assert'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const here = path.dirname(fileURLToPath(import.meta.url))
const nodeRequire = createRequire(path.join(here, '..', 'package.json'))

// Simulate window.__ModuleLoader__ exactly like dsh-client-modules does.
let registered = null
globalThis.window = { __ModuleLoader__: { load(entry) { registered = entry } } }
const src = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
// Classic-script eval (the loader injects the bundle as a classic script).
new Function('window', src)(globalThis.window)
assert.ok(registered && registered.id === 'dsh-sidebar-security-audit', 'registered under plugin id')

// Materialize the factory with a module-table require (react comes from the shell table).
const table = { 'react': nodeRequire('react'), 'react/jsx-runtime': nodeRequire('react/jsx-runtime') }
const exportsObj = registered.factory((id) => {
  if (table[id]) return table[id]
  throw new Error('unregistered external: ' + id)
})
assert.deepEqual(exportsObj.inject, ['betterSidebar'])
assert.equal(typeof exportsObj.apply, 'function')

// Mock cordis ctx: capture the registered tab descriptor.
let descriptor = null
const betterSidebar = { registerTab(d) { descriptor = d; return () => { descriptor = null } } }
const ctx = { betterSidebar, effect(fn) { const dispose = fn(); return dispose } }
exportsObj.apply(ctx)
assert.ok(descriptor, 'tab registered')
console.log('tab id:', descriptor.id, '| title:', descriptor.title(), '| single:', descriptor.single, '| order:', descriptor.order)
assert.equal(descriptor.id, 'security-audit:panel')
// icon renders through createElement from the shared table
const iconNode = descriptor.icon(16)
assert.equal(typeof iconNode, 'object')
assert.equal(typeof iconNode.type, 'function') // ShieldIcon element
// component is a function receiving TabComponentProps
assert.equal(typeof descriptor.component, 'function')
console.log('CLIENT BUNDLE CONTRACT OK')
