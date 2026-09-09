# dsh-sidebar-security-audit

A [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) panel for the
[cloudflare/security-audit](https://github.com/cloudflare/security-audit-skill) skill: discovers audit
runs, parses `findings.json` (the skill's report-schema.json shape), and renders the results in the
DSH web sidebar.

## What it does

Registers a **Security Audit** sidebar tab (shield icon) that:

- Scans an audit root — default `/workspace/workspace/security-audit-skill` — for runs laid out as
  `<root>/<repo>/run-<N>/` (any directory holding `findings.json` / `REPORT.md` /
  `FINDINGS-DETAIL.md` / `architecture.md` counts as a run).
- Selects a run and parses its `findings.json` into **confirmed / rejected** findings.
- Shows severity stats (critical/high/medium/low/informational chips, click to filter), a
  confirmed/rejected toggle, and free-text search.
- Renders each finding as a card: severity + confidence badges, description, root cause, the
  entrypoint→sink **trace**, exploitation conditions, execution (payloads / instructions /
  expected result), remediation and severity rationale. Rejected findings show the rejection reason.
- Opens `REPORT.md` / `FINDINGS-DETAIL.md` / `architecture.md` in the sidebar's built-in markdown
  viewer via better-sidebar's `openFile` service call.
- Lets you point the scan at a different root (persisted in localStorage), defaulting back to the
  server-side root at any time.

## Security model

The host half serves one fenced, **read-only** route family:

| Route | Purpose |
|---|---|
| `GET /api/dsh-sidebar-security-audit/health` | effective root/base |
| `GET /api/dsh-sidebar-security-audit/runs?root=` | run discovery + findings.json summary |
| `GET /api/dsh-sidebar-security-audit/findings?dir=` | raw findings.json for a run |
| `GET /api/dsh-sidebar-security-audit/report?dir=&file=` | whitelisted artifact text |

- Same browser-trust fence as the DSH `/api` gateway (loopback/trusted Host, cross-site refusal).
- Every path must resolve inside the **base** directory (default `/workspace/workspace`); symlink
  escapes are refused via realpath containment. Only the four artifact filenames are readable.

## Why /workspace/workspace?

The upstream skill defaults its output to `~/security-audit-skill/…`; in this container the global
home is **not writable**, so the installed skill's default output root is patched to
`/workspace/workspace/security-audit-skill/<repo>/run-<N>` and this panel reads exactly there.

## Configuration (optional)

On the cordis patch row (profile `cordis.patch.yml`):

```yaml
- id: security-audit-panel
  config:
    auditRoot: /workspace/workspace/security-audit-skill
    base: /workspace/workspace
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
