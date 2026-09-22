/**
 * dsh-gitlab-follow-workspace — workspace-following GitLab MCP bridge for
 * the DeepSeek Harness.
 *
 * The zereight gitlab-mcp server has no cwd option of its own: its process
 * working directory is chosen by whoever spawns it, and it only matters for
 * the few tools that touch the local filesystem (artifact downloads,
 * attachment downloads, markdown uploads, masking file resolution). DSH's
 * `mcp-client` mounts each server once with a static `cwd`, so relative
 * local paths always land in one fixed directory no matter which repo the
 * calling session is working in.
 *
 * This plugin bridges the same server over MCP stdio (JSON-RPC 2.0,
 * newline-delimited) but keeps one server process per workspace directory:
 * every tool call resolves the calling session's workspace (its session
 * header `cwd`, falling back to the initiating agent, then any live session,
 * then the configured default) and routes to the server rooted there.
 *
 * Tools are discovered once from the server's `tools/list` (paginated) and
 * registered under the same `mcp__<serverName>__<rawName>` public names the
 * stock mcp-client bridge uses, so existing prompts, skills, and muscle
 * memory keep working unchanged. A server is reused across calls and
 * sessions on the same workspace; idle servers are LRU-capped and the whole
 * pool — plus every tool registration — is torn down when the plugin
 * unmounts.
 *
 * Security posture: response masking (GITLAB_MASKING_ENABLED) is enabled for
 * every spawned server by default (operator env can turn it off), and the
 * GitLab toolset starts in readonly permission mode — write/delete calls
 * require a user-approved permission escalation through the host approval
 * seam (readonly → modify → full, with idle/hard-limit de-escalation) unless the
 * operator pins a mode statically via env.GITLAB_PERMISSION_MODE. Escalations
 * are not permanent: modify mode de-escalates after 10 idle minutes; full
 * mode has a HARD 5-minute time limit from entering it — even ongoing tool
 * activity cannot extend it (both configurable). When an expiry lands
 * mid-call the call finishes on its already-escalated server, which is
 * killed as soon as it drains; new calls then gate at the baseline and need
 * a fresh approval.
 *
 * @module dsh-gitlab-follow-workspace
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import z from '@deepseek-ai/schemastery';

/** Cordis plugin name for loader diagnostics. */
export const name = 'gitlab-follow-workspace';

/** Services required by this plugin. `agents` and `systemPrompt` are read optionally. */
export const inject = ['tools', 'subprocess', 'sessions'];

export const Config = z.object({
  /** Namespace for public tool names: `mcp__<serverName>__<rawName>`. */
  serverName: z.string().default('gitlab'),
  /** Command that starts the gitlab MCP server (stdio transport). */
  command: z.string().default('npx'),
  /** Extra argv between the command and nothing — full server argv is `[command, ...args]`. */
  args: z.array(z.string()).default(['-y', '@zereight/mcp-gitlab']),
  /** Extra child environment (merged last, over the built-in masking and permission defaults), e.g. GITLAB_API_URL. */
  env: z.dict(String).default({}),
  /**
   * Initial GitLab permission mode (server-side GITLAB_PERMISSION_MODE).
   * Runtime escalation (readonly → modify → full) is gated through the host
   * approval seam; an explicit env.GITLAB_PERMISSION_MODE override disables
   * the escalation ladder and pins the mode statically.
   */
  permissionMode: z.union(['readonly', 'modify', 'full']).default('readonly'),
  /**
   * Idle window (ms since the last gitlab tool call) before an escalated
   * modify-mode session de-escalates to the configured permissionMode.
   * 0 disables de-escalation (sticky until reload).
   */
  escalationIdleTimeoutMs: z.number().default(600000),
  /**
   * Hard time limit (ms from entering full mode) — full mode always
   * de-escalates at this deadline even during tool activity. A call in
   * flight when it expires finishes on its already-running full-mode
   * server, which is killed as soon as it drains. 0 disables.
   */
  fullEscalationTimeoutMs: z.number().default(300000),
  /**
   * Upstream toolset groups (GITLAB_TOOLSETS) to mount, e.g.
   * ['issues', 'merge_requests', 'ci']. Empty = the server's default-on
   * toolsets (~half the full 240-tool set). Toolsets are mounted statically
   * at boot — the runtime discover_tools activation only reaches one
   * workspace's server process, so prefer this config for context control.
   * An explicit env.GITLAB_TOOLSETS wins.
   */
  toolsets: z.array(z.string()).default([]),
  /**
   * On-demand tool loading: register only the mcp__<serverName>__tools meta
   * tool at mount. action "list" shows the cached catalog (name, description,
   * required permission level); action "enable" registers the named tools on
   * the host registry for all sessions until the plugin reloads. Keeps
   * GitLab definitions out of every session's context until they are used.
   * false front-loads the full toolset like the stock mcp-client.
   */
  lazyTools: z.boolean().default(true),
  /** Workspace used when no live session exposes a cwd. */
  defaultCwd: z.string().default(os.homedir()),
  /** Handshake (initialize + tools/list) timeout per attempt, ms. */
  initTimeoutMs: z.number().default(30000),
  /** Per tools/call timeout, ms. */
  callTimeoutMs: z.number().default(120000),
  /** SIGTERM→SIGKILL grace for a managed gitlab server child, ms. */
  graceMs: z.number().default(3000),
  /** Cap on simultaneously cached workspace servers (LRU eviction). */
  maxConnections: z.number().default(4),
  /** Boot-time tool-discovery attempts before giving up (exponential backoff). */
  discoveryAttempts: z.number().default(10),
});

/**
 * DeepSeek function-name contract: at most 64 characters. Wire-protocol
 * constant, not configuration.
 */
const MAX_PUBLIC_NAME_LENGTH = 64;
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;

/**
 * Derive the model-facing public name for one MCP tool — the same pure
 * function the stock mcp-client bridge uses, so tool names are identical
 * whether a server is mounted there or here.
 * @param serverName - Stable local namespace from plugin config.
 * @param rawName - The MCP server's own tool name.
 * @returns The globally unique, model-facing ToolRuntime name.
 */
function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * Extract model-visible text from one MCP content array (untrusted network
 * boundary: every field is guarded). Text blocks join with '\n'; image,
 * audio, and resource blocks degrade to placeholder lines.
 * @param content - MCP `content` blocks from a tools/call result.
 * @param rawName - Raw tool name, for the empty-result placeholder.
 * @returns The flattened text.
 */
function extractText(content, rawName) {
  if (!Array.isArray(content)) return '(no output)';
  const lines = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      lines.push('[unsupported MCP content block: expected an object]');
      continue;
    }
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) lines.push(block.text);
        break;
      case 'image':
        lines.push(`[image unavailable: ${block.mimeType ?? 'unknown media type'}; save it to a file and open it from disk instead]`);
        break;
      case 'resource_link':
        if (block.name !== undefined && block.uri !== undefined) lines.push(`Resource link: ${block.name} (${block.uri})`);
        else lines.push('[resource link unavailable: the MCP block is missing its name or URI]');
        break;
      case 'audio':
        lines.push(`[audio result unsupported: ${block.mimeType ?? 'unknown media type'}]`);
        break;
      case 'resource':
        lines.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]');
        break;
      default:
        lines.push(`[unsupported MCP content type: ${String(block.type)}]`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : `(${rawName} returned no model-visible content)`;
}

/**
 * Build the diagnostic suffix appended to connection errors: the last lines
 * of the server's stderr (startup diagnostics like a missing token or an npx
 * failure). Empty when the server wrote nothing to stderr.
 * @param tail - Bounded stderr tail captured from the connection.
 * @returns '' or a multi-line suffix.
 */
function stderrSuffix(tail) {
  const trimmed = (tail ?? '').trim();
  if (trimmed.length === 0) return '';
  return `\ngitlab MCP server stderr (tail):\n${trimmed.slice(-2048)}`;
}

/**
 * Apply the plugin: one MCP connection pool keyed by workspace, plus the
 * server's full tool set registered on the host `tools` registry with
 * per-call workspace routing. Boot-time discovery retries with exponential
 * backoff; every side effect is registered on the calling fiber, so plugin
 * stop/update disposes servers, timers, and tool registrations.
 * @param ctx - Cordis host context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const resolved = config;

  /** One cached server per workspace: { starting, conn, lastUsed }. */
  const states = new Map();
  /** All live timeout handles, cleared on fiber dispose. */
  const timers = new Set();
  /** Most recently seen workspace, so attribution hiccups keep the last repo. */
  let lastCwd = resolved.defaultCwd;
  /** Set once the plugin is stopping; blocks further spawns and discovery. */
  let disposed = false;
  /** Disposers for every tool registration owned by this plugin. */
  const registrations = [];

  /** GitLab permission-mode ladder: level index of readonly/modify/full. */
  const MODE_LEVELS = { readonly: 0, modify: 1, full: 2 };
  const MODE_NAMES = ['readonly', 'modify', 'full'];
  /** Operator `env.GITLAB_PERMISSION_MODE` hard-override: static mode, no runtime ladder. */
  const overrideMode = resolved.env.GITLAB_PERMISSION_MODE;
  const staticMode = overrideMode !== undefined && MODE_NAMES.includes(overrideMode);
  if (overrideMode !== undefined && !staticMode) {
    ctx.logger.warn(`gitlab-follow-workspace: ignoring invalid env.GITLAB_PERMISSION_MODE "${overrideMode}" (expected one of ${MODE_NAMES.join('/')}), falling back to config permissionMode`);
  }
  /** Current GitLab permission mode; escalates at runtime under the approval seam. */
  let currentMode = staticMode ? overrideMode : resolved.permissionMode;
  /** Baseline the ladder de-escalates back to (the configured initial mode). */
  const initialMode = currentMode;
  /** Live de-escalation timer handle (setTimer cancel fn), or null. */
  let escalationTimer = null;
  /** Live hard-deadline timer for an escalated full mode, or null. */
  let fullDeadlineTimer = null;
  /** Deferred re-check for busy servers after a de-escalation, or null. */
  let drainTimer = null;
  /** Runtime escalation ladder active? (off for a static override or full start) */
  const ladder = !staticMode && currentMode !== 'full';
  /** Raw tool names only allowed at full permission mode; derived empirically at boot. */
  let fullOnlyNames = null;
  /** Cached tool catalog from boot discovery (ladder: full probe; static: pooled list). */
  let catalog = [];
  /** catalog indexed by public tool name, for the enable flow. */
  let catalogByPub = new Map();
  /** Public names of tools registered through the lazy enable flow. */
  const enabledTools = new Set();

  function setTimer(fn, ms) {
    const handle = setTimeout(() => {
      timers.delete(handle);
      fn();
    }, ms);
    timers.add(handle);
    return () => {
      clearTimeout(handle);
      timers.delete(handle);
    };
  }

  function killConn(conn) {
    conn.dead = true;
    for (const p of conn.pending.values()) p.reject(new Error('gitlab MCP connection closed'));
    conn.pending.clear();
    try {
      conn.handle.terminate();
    } catch {}
  }

  function disposeAll() {
    disposed = true;
    for (const st of states.values()) if (st.conn) killConn(st.conn);
    states.clear();
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
    for (const dispose of registrations.splice(0)) {
      try {
        dispose();
      } catch {}
    }
  }
  ctx.effect(() => disposeAll);

  /** Write one JSON-RPC message; notifications carry no id. */
  function write(conn, method, params, id) {
    if (!conn.handle.stdin) throw new Error('gitlab MCP stdin unavailable');
    const msg = { jsonrpc: '2.0', method };
    if (id !== undefined) msg.id = id;
    if (params !== undefined) msg.params = params;
    conn.handle.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** Best-effort MCP cancellation notice after a timeout or caller abort. */
  function notifyCancelled(conn, id, reason) {
    try {
      write(conn, 'notifications/cancelled', { requestId: id, reason });
    } catch {}
  }

  /** Await one JSON-RPC response by id, with timeout and caller-abort linkage. */
  function request(conn, method, params, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      if (conn.dead) {
        reject(new Error('gitlab MCP connection is closed'));
        return;
      }
      const id = ++conn.seq;
      let settled = false;
      let disposeTimer = () => {};
      let onAbort = null;
      /** Settle once; returns whether THIS call performed the settle. */
      const finish = (fn, arg) => {
        if (settled) return false;
        settled = true;
        conn.pending.delete(id);
        disposeTimer();
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        fn(arg);
        return true;
      };
      conn.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (err) => finish(reject, err),
      });
      disposeTimer = setTimer(() => {
        if (finish(reject, new Error(`gitlab MCP request timed out: ${method}`))) {
          notifyCancelled(conn, id, 'timeout');
        }
      }, timeoutMs);
      if (signal) {
        if (signal.aborted) {
          finish(reject, new Error('gitlab MCP request aborted'));
          return;
        }
        onAbort = () => {
          if (finish(reject, new Error('gitlab MCP request aborted'))) {
            notifyCancelled(conn, id, 'aborted');
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        write(conn, method, params, id);
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  /** Spawn the gitlab MCP server rooted at `cwd` and complete the MCP handshake. */
  async function startConnection(cwd, permissionMode = currentMode) {
    const handle = ctx.subprocess.spawn({
      argv: [resolved.command, ...resolved.args],
      cwd,
      // Built-in safe defaults first, so the operator's env wins when it sets
      // the same key (e.g. GITLAB_MASKING_ENABLED: 'false' to turn masking off).
      env: {
        GITLAB_MASKING_ENABLED: 'true',
        GITLAB_PERMISSION_MODE: permissionMode,
        ...(resolved.toolsets.length > 0 ? { GITLAB_TOOLSETS: resolved.toolsets.join(',') } : {}),
        ...resolved.env,
      },
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: resolved.graceMs,
    });
    const conn = { cwd, handle, pending: new Map(), seq: 0, dead: false, tools: [], stderrTail: '' };
    // Never let an EPIPE / stream error on this shared child crash the host.
    if (handle.stdin) handle.stdin.on('error', () => { conn.dead = true; });
    // Keep a bounded tail of server stderr: startup diagnostics (missing
    // token, npx errors) surface in handshake failures instead of vanishing.
    if (handle.stderr) {
      handle.stderr.on('data', (chunk) => {
        conn.stderrTail = (conn.stderrTail + chunk.toString('utf8')).slice(-4096);
      });
      handle.stderr.on('error', () => {}); // stderr loss is diagnostic-only, never fatal
    }
    let buf = '';
    if (handle.stdout) {
      handle.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // foreign stdout noise; not a framed response
          }
          if (msg && msg.id !== undefined && conn.pending.has(msg.id)) {
            const p = conn.pending.get(msg.id);
            conn.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || 'gitlab MCP error'));
            else p.resolve(msg.result);
          }
        }
      });
      handle.stdout.on('error', () => { conn.dead = true; });
    }
    // Child death (clean or crash) must reject in-flight requests immediately
    // and forget this conn, regardless of how the host resolves `done`.
    const onExit = () => {
      conn.dead = true;
      const message = `gitlab MCP process exited${stderrSuffix(conn.stderrTail)}`;
      for (const p of conn.pending.values()) p.reject(new Error(message));
      conn.pending.clear();
      for (const [key, st] of states) {
        if (st.conn === conn) states.delete(key);
      }
    };
    handle.done.then(onExit, onExit);
    // Handshake failure must not orphan the spawned child.
    try {
      await request(conn, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-gitlab-follow-workspace', version: '1.0.0' },
      }, resolved.initTimeoutMs);
      write(conn, 'notifications/initialized');
      // Drain pagination so a server that pages its tool list is fully bridged.
      const seenCursors = new Set();
      let cursor;
      do {
        const page = await request(conn, 'tools/list', cursor === undefined ? {} : { cursor }, resolved.initTimeoutMs);
        for (const tool of page?.tools ?? []) conn.tools.push(tool);
        cursor = page?.nextCursor;
        if (cursor !== undefined && cursor !== null) {
          if (seenCursors.has(cursor)) throw new Error('server repeated a tools/list continuation cursor — invalid tool list');
          seenCursors.add(cursor);
        }
      } while (cursor !== undefined && cursor !== null);
    } catch (err) {
      killConn(conn);
      for (const [key, st] of states) {
        if (st.conn === conn) states.delete(key);
      }
      throw err instanceof Error ? new Error(`${err.message}${stderrSuffix(conn.stderrTail)}`) : err;
    }
    if (conn.tools.length === 0) {
      killConn(conn);
      throw new Error('server listed no tools');
    }
    return conn;
  }

  /** Evict the least-recently-used idle server when the cache overflows. */
  function evictIfNeeded() {
    while (states.size > resolved.maxConnections) {
      let victimKey;
      let victim = null;
      for (const [key, st] of states) {
        if (st.conn && !st.starting && st.conn.pending.size === 0
          && (!victim || st.lastUsed < victim.lastUsed)) {
          victim = st;
          victimKey = key;
        }
      }
      if (victimKey === undefined) return; // nothing idle to evict yet; allow transient overflow
      killConn(victim.conn);
      states.delete(victimKey);
    }
  }

  /** Get (or start) the server for `cwd`, with bounded retries. */
  async function ensureConn(cwd, signal) {
    if (disposed) throw new Error('gitlab MCP bridge is disposed');
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      let st = states.get(cwd);
      if (!st) {
        st = { starting: null, conn: null, lastUsed: Date.now() };
        states.set(cwd, st);
        evictIfNeeded();
      }
      if (st.conn && !st.conn.dead) {
        st.lastUsed = Date.now();
        return st.conn;
      }
      if (st.conn && st.conn.dead) st.conn = null;
      if (st.starting) {
        try {
          return await st.starting;
        } catch (err) {
          lastErr = err;
          continue;
        }
      }
      const started = (async () => {
        const conn = await startConnection(cwd);
        const cur = states.get(cwd);
        if (!cur || cur !== st) {
          // disposed/evicted while starting: do not orphan this child
          try { conn.handle.terminate(); } catch {}
          throw new Error('gitlab MCP connection state was disposed');
        }
        cur.conn = conn;
        cur.starting = null;
        cur.lastUsed = Date.now();
        return conn;
      })();
      st.starting = started;
      started.catch(() => {
        const cur = states.get(cwd);
        if (cur === st) cur.starting = null;
      });
      try {
        return await started;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('gitlab MCP connection failed');
  }

  /** Resolve the calling call's workspace: exec agent → initiator → any session → default. */
  function resolveCwd(exec) {
    const agents = ctx.get('agents');
    const agent = exec?.agent ?? agents?.currentInitiator?.();
    if (agent) {
      const session = ctx.sessions.get(agent.id);
      const cwd = session?.header?.cwd;
      if (cwd) {
        lastCwd = cwd;
        return cwd;
      }
    }
    for (const session of ctx.sessions.list()) {
      const cwd = session?.header?.cwd;
      if (cwd) {
        lastCwd = cwd;
        return cwd;
      }
    }
    return lastCwd;
  }

  /** Call one raw gitlab tool and flatten the MCP result for the model. */
  async function callGitlab(cwd, rawName, args, signal) {
    const conn = await ensureConn(cwd, signal);
    const result = await request(conn, 'tools/call', { name: rawName, arguments: args ?? {} },
      resolved.callTimeoutMs, signal);
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = extractText(result?.content, rawName);
    if (result?.isError === true) throw new Error(text || 'gitlab tool error');
    return { content, text: text || '(no output)' };
  }

  /** Required permission-mode level for one raw tool, from boot classification. */
  function requiredLevel(tool) {
    if (fullOnlyNames !== null) {
      if (fullOnlyNames.has(tool.name)) return 2;
      return tool.annotations?.readOnlyHint === true ? 0 : 1;
    }
    // modify-mode discovery unavailable: fall back to the annotation heuristic
    // (deleteTools ⊆ destructiveTools upstream, so destructive ⇒ full is the
    // safe direction; over-classifying only asks one approval too early).
    if (tool.annotations?.readOnlyHint === true) return 0;
    return tool.annotations?.destructiveHint === true ? 2 : 1;
  }

  /**
   * Arm the timer governing the current escalated mode's expiry. modify
   * mode de-escalates after an idle window (refreshable by tool activity);
   * full mode de-escalates at a HARD deadline armed once at entry — tool
   * activity never refreshes it. At baseline this disarms everything.
   */
  function armEscalationTimeout() {
    disarmEscalationTimer();
    disarmFullDeadlineTimer();
    if (currentMode === initialMode) return;
    const atFull = currentMode === 'full';
    const raw = atFull ? resolved.fullEscalationTimeoutMs : resolved.escalationIdleTimeoutMs;
    const windowMs = typeof raw === 'number' && Number.isFinite(raw) ? raw : Infinity;
    if (windowMs <= 0) return; // de-escalation disabled for this mode
    const reason = atFull ? 'hard time limit' : 'idle';
    const handle = setTimer(() => {
      if (atFull) fullDeadlineTimer = null;
      else escalationTimer = null;
      deescalate(reason);
    }, windowMs);
    if (atFull) fullDeadlineTimer = handle;
    else escalationTimer = handle;
  }

  /**
   * Per-call activity refresh. Only the modify idle window is refreshable;
   * full mode's hard deadline is immune, so it always expires on schedule.
   */
  function refreshEscalationActivity() {
    if (currentMode === 'modify') armEscalationTimeout();
  }

  function disarmEscalationTimer() {
    if (escalationTimer) {
      escalationTimer();
      escalationTimer = null;
    }
  }

  function disarmFullDeadlineTimer() {
    if (fullDeadlineTimer) {
      fullDeadlineTimer();
      fullDeadlineTimer = null;
    }
  }

  /**
   * Drop back to the configured baseline mode and kill idle pooled servers
   * (their next spawn uses the baseline mode's server-side enforcement).
   * Connections with in-flight calls — or still starting — are left alone
   * and re-checked every second, so the last in-flight call finishes on its
   * already-escalated server before it is killed; the escalated mode itself
   * is already gone, so new calls gate at the baseline. The drain re-check
   * is its own timer: tool activity must not cancel it, but a
   * re-escalation does (ensureEscalated).
   */
  function deescalate(reason) {
    if (drainTimer) {
      drainTimer();
      drainTimer = null;
    }
    const from = currentMode;
    currentMode = initialMode;
    let busy = false;
    for (const st of states.values()) {
      if (!st.conn) {
        if (st.starting) busy = true;
        continue;
      }
      if (st.conn.pending.size > 0) {
        busy = true; // drain first; killing now would fail a live call
        continue;
      }
      killConn(st.conn);
    }
    if (from !== initialMode) {
      ctx.logger.info(`gitlab-follow-workspace: permission mode de-escalated ${from} → ${initialMode} (${reason})${busy ? ' — busy servers will be drained and killed' : ''}`);
    }
    if (busy) drainTimer = setTimer(() => deescalate(reason), 1000);
  }

  /**
   * Escalate the GitLab permission mode when `tool` needs more than the
   * current mode. The ask runs through the host approval seam (fail-closed
   * when none is composed); an allowed-once outcome escalates the mode
   * persistently for the rest of the mount — pooled servers are killed so
   * the next call respawns with the new mode's server-side enforcement.
   * In-flight calls on killed servers fail with "connection closed" and are
   * retried by their callers against the upgraded pool. The escalated mode
   * de-escalates back to the configured baseline after the mode's idle
   * window without gitlab tool activity (5 min for full, 10 min otherwise).
   */
  async function ensureEscalated(rawName, tool, exec) {
    const level = requiredLevel(tool);
    if (MODE_LEVELS[currentMode] >= level) return;
    const target = MODE_NAMES[level];
    const approval = ctx.get('approval');
    if (!approval) {
      throw new Error(`gitlab tool "${rawName}" requires ${target} permission mode (currently ${currentMode}), but no approval service is available`
        + ` — set permissionMode: "${target}" (or env.GITLAB_PERMISSION_MODE) and reload to allow it statically`);
    }
    let outcome;
    try {
      outcome = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        callId: exec.callId,
        reason: `GitLab tool "${rawName}" needs ${target} permission mode (currently ${currentMode}).`
          + ` Approving escalates the GitLab toolset to ${target} for all workspaces until the plugin reloads or the mode idles out.`,
        signal: exec.signal,
      });
    } catch (err) {
      throw new Error(`gitlab tool "${rawName}" requires ${target} permission mode, but the approval channel failed: ${String(err)}`);
    }
    if (outcome !== 'allowed-once') {
      const why = outcome === 'rejected' ? 'the user rejected the escalation'
        : outcome === 'cancelled' ? 'the escalation prompt was cancelled'
        : 'no approval channel is available';
      throw new Error(`gitlab tool "${rawName}" was not run: escalation to ${target} was not granted — ${why}`);
    }
    currentMode = target;
    for (const st of states.values()) {
      if (st.conn) killConn(st.conn);
    }
    // Escalation supersedes any pending de-escalation drain: all conns were
    // just killed, nothing left to drain.
    if (drainTimer) {
      drainTimer();
      drainTimer = null;
    }
    armEscalationTimeout();
  }

  /** Build one registry definition forwarding raw tool `tool` per-call by workspace. */
  function makeDefinition(tool) {
    const rawName = tool.name;
    return {
      name: publicToolName(resolved.serverName, rawName),
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { content: { type: 'array', items: {} } },
          required: ['content'],
        },
        render(_args, value) {
          return [{ type: 'text', text: extractText(value?.content, rawName) }];
        },
      },
      timeoutMs: resolved.callTimeoutMs + 15000,
      async execute(args, exec) {
        const cwd = resolveCwd(exec);
        if (ladder) await ensureEscalated(rawName, tool, exec);
        try {
          const result = await callGitlab(cwd, rawName, args, exec?.signal);
          return { content: result.content };
        } finally {
          // Per-call activity refresh: only the modify idle window is
          // refreshable; full mode's hard deadline always expires on time.
          if (ladder) refreshEscalationActivity();
        }
      },
    };
  }

  /**
   * The on-demand discovery surface replacing the front-loaded toolset under
   * lazyTools. `list` renders the cached catalog with per-tool permission
   * tags; `enable` registers cached definitions on the host registry — no
   * server round trip, and the permission ladder still gates execution.
   */
  function makeMetaDefinition() {
    const pub = publicToolName(resolved.serverName, 'tools');
    return {
      name: pub,
      description: 'Discover and enable GitLab tools on demand. GitLab tools are NOT loaded by default (context budget): call with action "list" to see the catalog, then action "enable" with the public names you need. Enabled tools register for all sessions until the plugin reloads; execution still gates by permission mode.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'enable'], description: '\'list\' shows the tool catalog; \'enable\' registers tools for calling.' },
          names: { type: 'array', items: { type: 'string' }, description: 'For "enable": public tool names from the catalog (raw server names also accepted).' },
          filter: { type: 'string', description: 'For "list": substring filter on name or description.' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { content: { type: 'array', items: {} } },
          required: ['content'],
        },
        render(_args, value) {
          return [{ type: 'text', text: extractText(value?.content, 'tools') }];
        },
      },
      timeoutMs: 15000,
      async execute(args) {
        const action = args?.action;
        if (action !== 'list' && action !== 'enable') {
          throw new Error(`unknown action "${String(action)}" — expected "list" or "enable"`);
        }
        if (action === 'list') {
          const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
          const lines = [];
          let available = 0;
          for (const tool of catalog) {
            const name = publicToolName(resolved.serverName, tool.name);
            if (enabledTools.has(name)) continue;
            available++;
            const desc = (tool.description ?? '').replace(/\s+/g, ' ').trim();
            if (filter && !name.toLowerCase().includes(filter) && !desc.toLowerCase().includes(filter)) continue;
            lines.push(`${name} — ${desc} [${MODE_NAMES[requiredLevel(tool)]}]`);
          }
          return { content: [{ type: 'text', text: [
            `gitlab tools: ${enabledTools.size} enabled, ${lines.length} shown of ${available} available (bracket = permission mode required)`,
            ...lines,
          ].join('\n') }] };
        }
        const requested = Array.isArray(args.names) ? args.names : [];
        if (requested.length === 0) {
          throw new Error('action "enable" requires names: the public tool names shown by action "list"');
        }
        const batchDisposers = [];
        const batch = [];
        try {
          for (const name of requested) {
            const pub = typeof name === 'string' && name.startsWith(`mcp__${resolved.serverName}__`)
              ? name
              : publicToolName(resolved.serverName, String(name));
            if (enabledTools.has(pub)) continue;
            const tool = catalogByPub.get(pub);
            if (!tool) throw new Error(`unknown gitlab tool "${String(name)}" — run action "list" for the catalog`);
            batchDisposers.push(ctx.tools.register(makeDefinition(tool)));
            enabledTools.add(pub);
            batch.push(pub);
          }
        } catch (err) {
          for (const dispose of batchDisposers.splice(0)) {
            try { dispose(); } catch {}
          }
          for (const pub of batch) enabledTools.delete(pub);
          throw new Error(`enable failed, nothing registered: ${String(err)} — if the stock mcp-gitlab mcp-client row is still mounted, remove it: both bridges claim the same mcp__${resolved.serverName}__ namespace.`);
        }
        return { content: [{ type: 'text', text: batch.length > 0
          ? `enabled ${batch.length}: ${batch.join(', ')} — callable from your next step${ladder ? '; execution still gates by permission mode' : ''}`
          : 'all requested tools were already enabled' }] };
      },
    };
  }

  /**
   * One discovery attempt: drain the server's tool list and register the full
   * tool set. Under the runtime escalation ladder the registration source is
   * a throwaway server at full permission mode (so every tool schema is
   * known even though pooled servers start restricted), paired with a
   * throwaway modify-mode server whose tool list marks which tools are
   * full-only (upstream blocks delete tools in modify mode); both are killed
   * before registration. Without the ladder (static override, or a full
   * start), the ordinary connection is used and stays pooled as that workspace's server. Any registration failure
   * rolls back every registration — a foreign squatter on this server's
   * namespace (typically the stock `mcp-gitlab` mcp-client row) must be
   * removed before this bridge can mount.
   */
  async function discoverAndRegister() {
    const cwd = resolveCwd(null);
    let tools;
    let pooled = false;
    if (ladder) {
      const fullConn = await startConnection(cwd, 'full');
      try {
        tools = fullConn.tools;
        try {
          const modifyConn = await startConnection(cwd, 'modify');
          try {
            const modifyNames = new Set(modifyConn.tools.map((t) => t.name));
            fullOnlyNames = new Set(tools.filter((t) => !modifyNames.has(t.name)).map((t) => t.name));
          } finally {
            killConn(modifyConn);
          }
        } catch (err) {
          // Fail closed: without the modify list, treat every destructive
          // tool as full-only (annotation heuristic in requiredLevel).
          ctx.logger.warn(`gitlab-follow-workspace: modify-mode discovery failed (${String(err)}) — destructive tools will require escalation to full permission mode`);
        }
      } finally {
        killConn(fullConn);
      }
    } else {
      const conn = await ensureConn(cwd);
      tools = conn.tools;
      pooled = true;
    }
    // Cache the catalog for the lazy enable flow. In lazy mode the server's
    // own discover_tools meta tool is excluded — the bridge's meta tool
    // replaces it (upstream activation is per-server-process anyway).
    catalog = resolved.lazyTools ? tools.filter((t) => t.name !== 'discover_tools') : tools;
    catalogByPub = new Map(catalog.map((t) => [publicToolName(resolved.serverName, t.name), t]));
    try {
      if (resolved.lazyTools) {
        registrations.push(ctx.tools.register(makeMetaDefinition()));
      } else {
        for (const tool of catalog) {
          registrations.push(ctx.tools.register(makeDefinition(tool)));
        }
      }
    } catch (error) {
      for (const dispose of registrations.splice(0)) {
        try {
          dispose();
        } catch {}
      }
      ctx.logger.error(
        `gitlab-follow-workspace: tool registration failed, no tools registered: ${String(error)}`
          + ' — if the stock mcp-gitlab mcp-client row is still mounted, remove it: both bridges claim the same mcp__'
          + resolved.serverName + '__ namespace.',
      );
      return;
    }
    ctx.logger.info(
      `gitlab-follow-workspace: ${resolved.lazyTools ? `registered mcp__${resolved.serverName}__tools meta tool over ${catalog.length} cached definitions (on demand)` : `registered ${tools.length} tools as mcp__${resolved.serverName}__*`}`
      + ` (discovery server rooted at ${cwd}, permission mode ${currentMode}`
      + (ladder ? ', escalation ladder active' : ', static mode') + ')'
      + (pooled ? '' : ' (discovery servers were throwaways)'),
    );
  }

  /** Retry loop for boot-time discovery: exponential backoff, capped delay. */
  function discoverWithRetries(attempt) {
    if (disposed) return;
    discoverAndRegister().catch((error) => {
      if (disposed) return;
      if (attempt < resolved.discoveryAttempts) {
        const delayMs = Math.min(30000, 500 * 2 ** (attempt - 1));
        ctx.logger.warn(`gitlab-follow-workspace: discovery attempt ${attempt}/${resolved.discoveryAttempts} failed: ${String(error)} — retrying in ${delayMs}ms`);
        setTimer(() => discoverWithRetries(attempt + 1), delayMs);
      } else {
        ctx.logger.error(`gitlab-follow-workspace: giving up after ${attempt} failed discovery attempts — no gitlab tools registered; reload the plugin or restart the host to retry: ${String(error)}`);
      }
    });
  }

  discoverWithRetries(1);

  const systemPrompt = ctx.get('systemPrompt');
  systemPrompt?.section?.({
    name: 'tool:gitlab-workspace',
    order: 108,
    text: (resolved.lazyTools
      ? 'GitLab tools are NOT loaded by default (context budget). Call mcp__' + resolved.serverName + '__tools with action "list" '
        + 'to see the catalog (public name, description, required permission mode) and action "enable" with the public names '
        + 'you need — enabled tools register for all sessions until the plugin reloads. '
      : '')
      + 'The mcp__' + resolved.serverName + '__* GitLab tools follow the CURRENT session workspace: the server process '
      + 'backing each call is rooted at this session\'s cwd, so relative local_path / file_path arguments on '
      + 'download_job_artifacts, download_attachment, and upload_markdown resolve against the session workspace. '
      + 'GitLab API operations themselves are remote and unaffected.'
      + (ladder
        ? ' GitLab tools start in READONLY permission mode: write, delete, and teardown calls require the user to '
        + 'approve a permission escalation (readonly → modify for create/update; modify → full for delete/teardown). '
        + 'Each approved escalation persists until the plugin reloads — do not re-ask after one approval. Do not '
        + 'attempt destructive GitLab operations casually; they need explicit user escalation to full mode.'
        : ` GitLab tools run in ${currentMode} permission mode (statically configured).`),
  });
}