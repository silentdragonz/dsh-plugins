# dsh-gitlab-follow-workspace

Workspace-following GitLab MCP bridge for the DeepSeek Harness. Bridges the
[`@zereight/mcp-gitlab`](https://github.com/zereight/gitlab-mcp) server over
MCP stdio and keeps **one server process per workspace directory**, so the
GitLab toolset follows whichever repo the agent is working in.

## Why

The zereight gitlab-mcp server has **no cwd option**. Its CLI arguments and
environment variables cover tokens, API URLs, masking, and toolsets — but the
server's process working directory is chosen entirely by whoever spawns it.
The closest variable, `GITLAB_MASKING_WORKSPACE_DIR`, is documented as
*"does not change the process working directory"*.

That matters because several tools touch the **local** filesystem and resolve
relative paths against the server process cwd:

| Tool                    | Local-path argument            |
| ----------------------- | ------------------------------ |
| `download_job_artifacts`| artifact archive destination   |
| `download_attachment`   | `local_path` for saved files   |
| `upload_markdown`       | `file_path` of the file to upload |
| masking config          | `GITLAB_MASKING_CONFIG` resolution |

DSH's stock `mcp-client` bridge mounts each MCP server **once** with a static
`cwd` (its config does have a `cwd` field — but it is fixed at mount time and
cannot follow sessions). With this plugin, every tool call resolves the
calling session's workspace (its session header `cwd`, falling back to the
initiating agent, then any live session, then the configured default) and
routes to a server process rooted there — the same model the
`dsh-fff-follow-workspace` and `dsh-codegraph-follow-workspace` plugins use.

## Behavior

- Tools are discovered once from the server's `tools/list` (paginated) at
  plugin mount and registered under the stock bridge's naming contract,
  `mcp__<serverName>__<rawName>` (default `mcp__gitlab__*`), so prompts and
  skills keep working unchanged.
- Discovery retries with exponential backoff (500 ms → 30 s, 10 attempts by
  default) so a cold `npx` cache or a slow boot cannot leave the plugin dead.
- One server per workspace, reused across calls and sessions; the pool is
  LRU-capped; the whole pool and every tool registration is torn down when
  the plugin unmounts.
- Tool calls carry the caller's abort signal and a per-call timeout.

## Activation

The package is a DSH plugin bundle: its manifest declares
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so adding it as a
plugin mounts it automatically:

```sh
dsh plugin --profile <name> add file:/path/to/dsh-gitlab-follow-workspace
```

**Remove the stock row first.** If a stock `mcp-gitlab` mcp-client insert row
exists in the profile's `cordis.patch.yml`, delete it — both bridges claim the
same `mcp__gitlab__` namespace, and the tool registry rejects duplicates
(the plugin logs a pointed error if it detects this).

Then point the bridge at your GitLab instance from the profile's own patch
layer, targeting the row id:

```yaml
- id: gitlab-follow-workspace
  config:
    env:
      GITLAB_API_URL: https://gitlab.example.com/api/v4
      GITLAB_PERSONAL_ACCESS_TOKEN: glpat-...
```

## Configuration

| Field               | Default                            | Meaning                                                    |
| ------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `serverName`        | `gitlab`                           | Namespace for public tool names                            |
| `command`           | `npx`                              | Server command (argv head)                                 |
| `args`              | `["-y", "@zereight/mcp-gitlab"]`   | Server argv tail                                           |
| `env`               | `{}`                               | Extra child env, merged last (wins over the built-in masking and permission-mode defaults) |
| `permissionMode`    | `readonly`                         | Initial GitLab permission mode; see [Permissions](#permissions) |
| `escalationIdleTimeoutMs` | `600000`                     | Idle window before an escalated `modify` mode de-escalates to the baseline (0 = never) |
| `fullEscalationTimeoutMs` | `300000`                     | Hard time limit on an escalated `full` mode from entering it — activity cannot extend it (0 = never) |
| `toolsets`           | `[]`                               | Upstream `GITLAB_TOOLSETS` groups to mount (e.g. `['issues', 'merge_requests', 'ci']`); empty = the server's default-on groups |
| `lazyTools`          | `true`                             | On-demand tool loading: mount registers only `mcp__gitlab__tools`; `list` shows the catalog, `enable` registers tools for all sessions until reload |
| `defaultCwd`        | OS home directory                  | Workspace when no live session has a cwd                   |
| `initTimeoutMs`     | `30000`                            | Handshake + tools/list timeout per attempt                 |
| `callTimeoutMs`     | `120000`                           | Per tools/call timeout                                     |
| `graceMs`           | `3000`                             | SIGTERM→SIGKILL grace for managed server children          |
| `maxConnections`    | `4`                                | LRU cap on simultaneously cached workspace servers         |
| `discoveryAttempts` | `10`                               | Boot-time discovery attempts before giving up              |

## Permissions

The GitLab toolset starts in **readonly** permission mode: the server's own
`GITLAB_PERMISSION_MODE` guard blocks every create/update/delete call, and
the bridge registers all tool schemas up front (from throwaway discovery
servers at `full` and `modify` mode) so the model can see what exists.

- **Escalation to `modify`** — first approved create/update call. The bridge
  routes the ask through the host approval seam; approving escalates the
  mode for all workspaces until the plugin reloads or the mode idles out
  (pooled servers respawn with the new mode).
- **Escalation to `full`** — first approved delete/teardown call after that.
  The full-only set is derived empirically at boot by diffing the server's
  `tools/list` between `full` and `modify` mode; if the modify probe fails,
  every destructive-annotated tool conservatively requires `full`.
- **Idle de-escalation** — an escalated `modify` mode drops back to the
  configured baseline (`permissionMode`) after an idle window with no
  gitlab tool activity: 10 minutes (configurable, `0` disables). Every
  tool call refreshes the window, so a task spanning several calls keeps
  the window alive.
- **Hard limit on `full`** — full mode de-escalates to the baseline 5
  minutes after entering it (configurable), **regardless of activity**:
  calls do not extend the window, so an extended session cannot keep
  delete/teardown capability alive. When the deadline lands while a call
  is still running, that call finishes on its already-running full-mode
  server, which is killed as soon as it drains (1 s re-check); new calls
  gate at the baseline from the deadline onward and need a fresh approval.
  In-flight calls are never killed mid-call.
- **No approval channel composed** → the ask fails closed with a pointed
  error naming the mode to set statically.
- **Static mode** — set `permissionMode: modify`/`full` (or the operator env
  `GITLAB_PERMISSION_MODE`) to start there and skip the ladder entirely; an
  explicit `env.GITLAB_PERMISSION_MODE` disables runtime escalation (and
  with it, de-escalation — the mode is operator-controlled).

## Tool definitions and context cost

How the bridge's tools reach the model is configured with `lazyTools`
(default `true`):

- **On demand (default)** — the mount registers exactly one definition,
  `mcp__gitlab__tools`. The full catalog (drained from the server at boot)
  is cached; `action: "list"` prints it (public name, description, and the
  permission level each tool needs: `readonly`/`modify`/`full`), and
  `action: "enable"` registers the named tools on the host registry — no
  server round trip, schemas come from the cache. Enabled tools are
  **global**: every session sees them from its next step, until the plugin
  reloads or disposes. A session that never touches GitLab carries one tool
  definition instead of the whole set. The permission ladder composes:
  enabled delete tools still require the full-mode escalation.
- **Front-loaded (`lazyTools: false`)** — stock mcp-client behavior: every
  discovered tool registers at mount. On `@zereight/mcp-gitlab@2.1.64` that
  is 240 tools, ≈50 KB of definitions (≈13 KB descriptions + ≈33 KB JSON
  schemas) per session.

Combined with `toolsets` the on-demand catalog can be shrunk further: the
cached catalog honors the toolset selection, so `toolsets: ['issues', 'ci']`
+ lazy mode exposes a small catalog with near-zero mount cost. The server's
own runtime `discover_tools` is excluded from the lazy catalog — its
activation only reaches one workspace's server process, while the bridge's
`enable` works across the whole pool. (Under front-loaded mode it is bridged
as an ordinary tool, with the same per-server-process caveat.)

PTC presentation (harness `tools.mode: ptc|both`) remains a host-level
alternative that collapses schemas for all tools; the lazy flow keeps the
native per-tool presentation with on-demand loading instead.

Masking is enabled by default for every spawned server
(`GITLAB_MASKING_ENABLED: 'true'`, covering GitLab token prefixes and IP
addresses in tool output). Turn it off per profile by overriding the same
key in the plugin's `env` config. A workspace may also drop its own
`.gitlab-mcp-mask.json` to extend the built-in rules — it is resolved
against the server process cwd, i.e. the session workspace.

## Limitations

- Tool metadata is synced once at mount; a server upgrade that adds tools is
  picked up on the next plugin reload or host restart.
- Image content blocks (e.g. `download_attachment` image results) degrade to
  text placeholders; the stock mcp-client projects them into durable
  attachments instead.