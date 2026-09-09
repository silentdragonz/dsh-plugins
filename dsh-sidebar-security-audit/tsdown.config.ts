/**
 * tsdown build for dsh-sidebar-security-audit:
 * - lib/index.js  — host half (ESM, node): /api/dsh-sidebar-security-audit routes
 * - lib/client.js — browser bundle (CJS closure factory) registered with the DSH
 *   client module loader under the plugin id; react/cordis resolve through the
 *   shell's frozen module table at runtime, everything else is inlined.
 * Mirrors the dsh-better-sidebar ecosystem preset (see the official starter).
 */
import { defineConfig } from 'tsdown'

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    clean: true,
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({\n\tid: "dsh-sidebar-security-audit",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;`,
      footer: 'return module.exports;\n\t}\n});',
      codeSplitting: false,
    },
  },
])
