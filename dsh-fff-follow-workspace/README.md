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
package is mounted as a host row from the profile composition and survives
restarts.

## Activation

The package registers nothing on its own; a composition row activates it.
This deployment mounts it from the profile patch layer
(`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: fff-follow-workspace
      name: dsh-fff-follow-workspace
      config:
        binPath: /home/node/.dsh/fff/fff-mcp
        defaultCwd: /workspace/workspace/tmp
```

`cordis.patch.yml` reloads live, so editing the row (or the package) takes
effect without a restart as long as the package is installed under the profile
(`file:` dependency + `pnpm install`).

## Configuration

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
