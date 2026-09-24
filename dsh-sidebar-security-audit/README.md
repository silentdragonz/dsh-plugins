# dsh-sidebar-security-audit

A [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) panel for the
[cloudflare/security-audit](https://github.com/cloudflare/security-audit-skill) skill: discovers audit
runs, parses `findings.json` (the skill's report-schema.json shape), and renders the results in the
DSH web sidebar.

## What it does

Registers a **Security Audit** sidebar tab (shield icon) that:

- Scans an audit root for runs laid out as `<root>/<repo>/run-<N>/` (any directory holding
  `findings.json` / `REPORT.md` / `FINDINGS-DETAIL.md` / `architecture.md` counts as a run).
  The default root prefers the workspace's `.security-audit` folder and falls back to
  `~/security-audit-skill` (both customizable — see Configuration).
- Selects a run and parses its `findings.json` into **confirmed / needs validation /
  rejected** findings (current cloudflare/security-audit `report-schema.json`, including the
  required `evidence` sections and `observed_result` execution results).
- Shows severity stats (critical/high/medium/low/informational chips, click to filter), a
  confirmed / needs-validation / rejected toggle, and free-text search. File refs inside findings (trace
  entry/sink paths with line numbers, remediation file names) open the **file itself** in the
  editor selected in the harness open-in-app button (vscode-family / zed URL schemes through
  better-sidebar's external opener; other apps open the file's directory via the harness
  open-in-app route, `dsh >= 0.1.7-rc.1`). A host without the routes renders refs inert.
- Renders each finding as a card: severity + confidence badges, description, root cause, the
  entrypoint→sink **trace**, exploitation conditions, execution (payloads / instructions /
  expected result), remediation and severity rationale. Rejected findings show the rejection reason.
- Opens `REPORT.md` / `FINDINGS-DETAIL.md` / `architecture.md` in the sidebar's built-in markdown
  viewer via better-sidebar's `openFile` service call.
- Lets you point the scan at a different root via the input box (persisted in localStorage):
  absolute paths, `~/…`, or workspace-relative. A nonexistent root reports an explicit error;
  the Default button returns to the server-side root.

## Security model

The host half serves one fenced, **read-only** route family:

| Route | Purpose |
|---|---|
| `GET /api/dsh-sidebar-security-audit/health` | effective audit root |
| `GET /api/dsh-sidebar-security-audit/runs?root=` | run discovery + findings.json summary |
| `GET /api/dsh-sidebar-security-audit/findings?dir=&root=` | raw findings.json for a run |
| `GET /api/dsh-sidebar-security-audit/report?dir=&file=&root=` | whitelisted artifact text |

- Same browser-trust fence as the DSH `/api` gateway (loopback/trusted Host, cross-site refusal).
- Every served path must resolve inside the **audit root in use**; symlink escapes are refused
  via realpath containment. Only the four artifact filenames are readable.

## Where does the root come from?

Resolution order, most specific first:

1. **Panel override** — the input box (absolute, `~/…`, or workspace-relative; must be an
   existing directory).
2. **`auditRoot` config** — pins the root outright.
3. **`<workspace>/.security-audit`** — used when that folder exists in the live workspace
   (session cwd).
4. **`fallbackRoot` config** (default `~/security-audit-skill`) — the upstream skill's default
   output root.

The upstream skill defaults its output to `~/security-audit-skill/…`; in a container where the
global home is not writable, point `fallbackRoot` (or `auditRoot`) at the writable workspace.

## Configuration (optional)

On the cordis patch row (profile `cordis.patch.yml`):

```yaml
- id: security-audit-panel
  config:
    # optional: pin the root outright (~ and relative paths are expanded)
    # auditRoot: /workspace/workspace/security-audit-skill
    # optional: fallback when the workspace has no .security-audit
    # fallbackRoot: /workspace/workspace/security-audit-skill   # default ~/security-audit-skill
```

## Layout

- `src/index.ts` — host half (routes, fence wiring)
- `src/host/scan.ts` — run discovery, findings summary, contained reads
- `src/host/fence.ts` — browser-trust fence (copied pattern, as the sidebar itself does)
- `src/client/` — sidebar tab (AuditPanel, FindingCard, api, styles)

Built with tsdown: `lib/index.js` (ESM host) + `lib/client.js` (CJS factory registered with the DSH
client module loader; react resolves through the shell's module table).

```sh
pnpm install && pnpm build   # needs a writable pnpm store: --store-dir <tmp>
```

## Status

Mounted in the local web profile (`dsh.profile.bundles` + node_modules). A **server restart** of
`dsh web` activates the new plugin; then reload the GUI page to fetch the client bundle.
