# dsh-codegraph-follow-workspace

CodeGraph semantic code search for the DeepSeek Harness: the single
`codegraph_explore` tool, backed by [CodeGraph](https://github.com/colbymchenry/codegraph)
(`codegraph serve --mcp`) spoken to over MCP stdio.

CodeGraph roots its pre-built knowledge graph (`.codegraph/` SQLite index) and
its file watcher at the directory the server was spawned in. This plugin keeps
**one server per workspace directory**: every tool call resolves the calling
session's workspace (session header `cwd`) and routes to the server rooted
there, so graph queries follow whichever repo the agent is working in. The
index auto-syncs on file changes, so answers stay fresh while the agent edits.
Idle servers are reused across calls and sessions; the cache is LRU-capped and
the whole pool is torn down when the plugin unmounts.

## Activation

The package is a DSH plugin bundle: its manifest declares
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so adding it as a
plugin mounts it automatically — no composition editing required:

```sh
dsh plugin --profile web add dsh-codegraph-follow-workspace          # from the registry
dsh plugin --profile web add file:/path/to/dsh-codegraph-follow-workspace  # from a checkout
```

`dsh plugin` installs the package into the profile, then reconciles the
profile's `dsh.profile.bundles` layer stack: a dependency whose manifest
declares `dsh.bundle` joins the stack, and the profile boot applies its
`cordis.patch.yml` — which inserts the `codegraph-follow-workspace` row that
mounts this plugin. The stack re-evaluates on every later `dsh plugin` run, so
the row survives `update` and `remove` reconciles.

## Prerequisites

- The `codegraph` CLI on the host (default `binPath: codegraph`, resolvable on
  `PATH`; install per the [CodeGraph README](https://github.com/colbymchenry/codegraph#get-started)
  or point `binPath` at an absolute path).
- **Each workspace must be indexed once**: `codegraph init` inside the
  project creates the `.codegraph/` directory and builds the graph. Without an
  index the tool returns CodeGraph's own guidance to use built-in search tools
  instead of failing loudly. Auto-sync keeps an initialized index fresh from
  then on.
- Host services: `tools`, `subprocess`, `sessions` (all provided by the stock
  web profile). `agents` and `systemPrompt` are used opportunistically.

## Configuration

The inserted row carries no config; every field has a schema default in
`lib/index.js`. Override per deployment from the profile's own patch layer
(`~/.dsh/profiles/<name>/cordis.patch.yml`), targeting the row id:

```yaml
- id: codegraph-follow-workspace
  config:
    binPath: /usr/local/bin/codegraph
```

| Field             | Default                    | Meaning                                                      |
| ----------------- | -------------------------- | ------------------------------------------------------------ |
| `binPath`         | `codegraph`                | Path of the codegraph executable (absolute, or on `PATH`)    |
| `binArgs`         | `[]`                       | Extra argv between the binary and `serve --mcp`              |
| `defaultCwd`      | `/workspace/workspace/tmp` | Workspace when no live session has a cwd                     |
| `initTimeoutMs`   | `30000`                    | Handshake timeout per attempt (index catch-up can be slow)   |
| `callTimeoutMs`   | `120000`                   | Per `tools/call` timeout                                     |
| `graceMs`         | `3000`                     | SIGTERM→SIGKILL grace for the child process                  |
| `maxConnections`  | `4`                        | Cached workspace servers (LRU eviction)                      |

## Requirements

- Host services: `tools`, `subprocess`, `sessions` (all provided by the stock
  web profile). `agents` and `systemPrompt` are used opportunistically.
