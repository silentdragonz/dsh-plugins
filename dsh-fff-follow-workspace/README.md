# dsh-fff-follow-workspace

Persistent fff search tools for the DeepSeek Harness: `ffgrep`, `fffind`, and
`fff_multi_grep`, backed by the `fff-mcp` binary spoken to over MCP stdio.

fff-mcp roots its search index at the directory it was spawned in. This plugin
keeps **one server per workspace directory**: every tool call resolves the
calling session's workspace (session header `cwd`) and routes to the server
rooted there, so searches follow whichever repo the agent is working in. Idle
servers are reused across calls and sessions; the cache is LRU-capped and the
whole pool is torn down when the plugin unmounts.

## History

This is the persistent (composition-file) form of the former *dynamic* Cordis
plugin of the same name. Dynamic plugins disappear on process restart; this
package is mounted as a host row from the profile's bundle layer stack and
survives restarts.

## Activation

The package is a DSH plugin bundle: its manifest declares
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so adding it as a
plugin mounts it automatically — no composition editing required:

```sh
dsh plugin --profile web add dsh-fff-follow-workspace          # from the registry
dsh plugin --profile web add file:/path/to/dsh-fff-follow-workspace  # from a checkout
```

`dsh plugin` installs the package into the profile, then reconciles the
profile's `dsh.profile.bundles` layer stack: a dependency whose manifest
declares `dsh.bundle` joins the stack, and the profile boot applies its
`cordis.patch.yml` — which inserts the `fff-follow-workspace` row that mounts
this plugin. The stack re-evaluates on every later `dsh plugin` run, so the
row survives `update` and `remove` reconciles.

If the package was wired by hand before this bundle declaration existed
(an `insert` row for `fff-follow-workspace` in the profile's own
`cordis.patch.yml`), remove that row when the bundle layer takes over: the
bundle insert and the manual insert would both mount at the next boot, and
the loader rejects a duplicate entry id.

## Configuration

The inserted row carries no config; every field has a schema default in
`lib/index.js`. Override per deployment from the profile's own patch layer
(`~/.dsh/profiles/<name>/cordis.patch.yml`), targeting the row id:

```yaml
- id: fff-follow-workspace
  config:
    binPath: /usr/local/bin/fff-mcp
```

| Field             | Default                          | Meaning                                        |
| ----------------- | -------------------------------- | ---------------------------------------------- |
| `binPath`         | `/home/node/.dsh/fff/fff-mcp`    | Absolute path of the fff-mcp executable        |
| `defaultCwd`      | `/workspace/workspace/tmp`       | Workspace when no live session has a cwd       |
| `initTimeoutMs`   | `15000`                          | Handshake timeout per attempt                  |
| `callTimeoutMs`   | `60000`                          | Per `tools/call` timeout                       |
| `graceMs`         | `3000`                           | SIGTERM→SIGKILL grace for the child process    |
| `maxConnections`  | `4`                              | Cached workspace servers (LRU eviction)        |

## Requirements

- The `fff-mcp` binary at `binPath` (this deployment: `~/.dsh/fff/fff-mcp`).
- Host services: `tools`, `subprocess`, `sessions` (all provided by the stock
  web profile). `agents` and `systemPrompt` are used opportunistically.
