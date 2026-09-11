/**
 * dsh-codegraph-follow-workspace — CodeGraph semantic code search for the
 * DeepSeek Harness.
 *
 * Registers `codegraph_explore` on the host `tools` registry, backed by the
 * `codegraph serve --mcp` binary spoken to over MCP stdio (JSON-RPC 2.0,
 * newline-delimited).
 *
 * CodeGraph roots its index and file watcher at the directory it was spawned
 * in, so one server process is kept per workspace directory: every tool call
 * resolves the calling session's workspace (its session header `cwd`, falling
 * back to the initiating agent, then any live session, then the configured
 * default) and routes to the server rooted there. Exploration therefore
 * follows whichever repo the agent is working in, and a server is reused
 * across calls and sessions on the same workspace instead of being restarted
 * per call. Idle servers are LRU-capped; the whole pool is torn down when the
 * plugin unmounts.
 *
 * @module dsh-codegraph-follow-workspace
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

/** Cordis plugin name for loader diagnostics. */
export const name = 'codegraph-follow-workspace';

/** Services required by this plugin. `agents` and `systemPrompt` are read optionally. */
export const inject = ['tools', 'subprocess', 'sessions'];

export const Config = z.object({
  /** Absolute path of the codegraph executable. */
  binPath: z.string().default('codegraph'),
  /** Extra argv between the binary and the MCP subcommand. */
  binArgs: z.array(z.string()).default([]),
  /** Workspace used when no live session exposes a cwd. */
  defaultCwd: z.string().default('/workspace/workspace/tmp'),
  /** Handshake (initialize + tools/list) timeout per attempt, ms. */
  initTimeoutMs: z.number().default(30000),
  /** Per tools/call timeout, ms. */
  callTimeoutMs: z.number().default(120000),
  /** SIGTERM→SIGKILL grace for the managed codegraph child, ms. */
  graceMs: z.number().default(3000),
  /** Cap on simultaneously cached workspace servers (LRU eviction). */
  maxConnections: z.number().default(4),
});

/**
 * Apply the plugin: one MCP connection pool keyed by workspace, one public
 * tool forwarding to the server rooted at the calling session's workspace.
 *
 * @param {object} ctx - Cordis host context.
 * @param {object} config - Resolved {@link Config}.
 */
export function apply(ctx, config) {
  const resolved = config;

  /** One cached server per workspace: { starting, conn, lastUsed }. */
  const states = new Map();
  /** All live timeout handles, cleared on fiber dispose. */
  const timers = new Set();
  /** Most recently seen workspace, so attribution hiccups keep the last repo. */
  let lastCwd = resolved.defaultCwd;

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
    for (const p of conn.pending.values()) p.reject(new Error('codegraph MCP connection closed'));
    conn.pending.clear();
    try {
      conn.handle.terminate();
    } catch {}
  }

  function disposeAll() {
    for (const st of states.values()) if (st.conn) killConn(st.conn);
    states.clear();
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
  }
  ctx.effect(() => disposeAll);

  /** Write one JSON-RPC message; notifications carry no id. */
  function write(conn, method, params, id) {
    if (!conn.handle.stdin) throw new Error('codegraph MCP stdin unavailable');
    const msg = { jsonrpc: '2.0', method };
    if (id !== undefined) msg.id = id;
    if (params !== undefined) msg.params = params;
    conn.handle.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** Await one JSON-RPC response by id, with timeout and caller-abort linkage. */
  function request(conn, method, params, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      if (conn.dead) {
        reject(new Error('codegraph MCP connection is closed'));
        return;
      }
      const id = ++conn.seq;
      let settled = false;
      let disposeTimer = () => {};
      let onAbort = null;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        conn.pending.delete(id);
        disposeTimer();
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        fn(arg);
      };
      conn.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (err) => finish(reject, err),
      });
      disposeTimer = setTimer(() => {
        finish(reject, new Error(`codegraph MCP request timed out: ${method}`));
      }, timeoutMs);
      if (signal) {
        if (signal.aborted) {
          finish(reject, new Error('codegraph MCP request aborted'));
          return;
        }
        onAbort = () => finish(reject, new Error('codegraph MCP request aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        write(conn, method, params, id);
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  /** Spawn `codegraph serve --mcp` rooted at `cwd` and complete the MCP handshake. */
  async function startConnection(cwd) {
    const handle = ctx.subprocess.spawn({
      argv: [resolved.binPath, ...resolved.binArgs, 'serve', '--mcp'],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' },
      graceMs: resolved.graceMs,
    });
    const conn = { cwd, handle, pending: new Map(), seq: 0, dead: false };
    // Never let an EPIPE / stream error on this shared child crash the host.
    if (handle.stdin) handle.stdin.on('error', () => { conn.dead = true; });
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
            if (msg.error) p.reject(new Error(msg.error.message || 'codegraph MCP error'));
            else p.resolve(msg.result);
          }
        }
      });
      handle.stdout.on('error', () => { conn.dead = true; });
    }
    handle.done.then(
      () => {
        conn.dead = true;
        for (const p of conn.pending.values()) p.reject(new Error('codegraph MCP process exited'));
        conn.pending.clear();
        for (const [key, st] of states) {
          if (st.conn === conn) states.delete(key);
        }
      },
      () => { conn.dead = true; },
    );
    await request(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-codegraph-follow-workspace', version: '1.0.0' },
    }, resolved.initTimeoutMs);
    write(conn, 'notifications/initialized');
    await request(conn, 'tools/list', {}, resolved.initTimeoutMs);
    return conn;
  }

  /** Evict the least-recently-used idle server when the cache overflows. */
  function evictIfNeeded() {
    while (states.size > resolved.maxConnections) {
      let victimKey;
      let victim = null;
      for (const [key, st] of states) {
        if (st.conn && !st.starting && (!victim || st.lastUsed < victim.lastUsed)) {
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
  async function ensureConn(cwd) {
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
          throw new Error('codegraph MCP connection state was disposed');
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
    throw lastErr ?? new Error('codegraph MCP connection failed');
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

  /** Call one raw codegraph tool and flatten the MCP result into plain text. */
  async function callCodegraph(cwd, rawName, args, signal) {
    const conn = await ensureConn(cwd);
    const result = await request(conn, 'tools/call', { name: rawName, arguments: args ?? {} },
      resolved.callTimeoutMs, signal);
    let text = '(no output)';
    if (result && Array.isArray(result.content)) {
      text = result.content.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('');
    }
    if (result && result.isError === true) throw new Error(text || 'codegraph tool error');
    return { text: text || '(no output)' };
  }

  ctx.tools.register(defineTool({
    name: 'codegraph_explore',
    description: 'Answer almost any code question about the CURRENT workspace in one call — "how does X work", '
      + 'a flow ("how does X reach Y"), surveying an area, or the symbols you are about to change. Backed by the '
      + 'pre-built CodeGraph knowledge graph for this session\'s repo. Returns the verbatim source of the relevant '
      + 'symbols grouped by file, plus the call paths between them and a blast-radius summary. Query can be a '
      + 'natural-language question or a bag of symbol/file names. Treat returned source as already read; do not '
      + 're-open those files.',
    parameters: {
      query: { type: 'string', required: true, description: 'Symbol names, file names, or short code terms to explore (e.g. "AuthService loginUser session-manager"), or a natural-language question. For a flow question, name the symbols spanning the flow.' },
      maxFiles: { type: 'number', description: 'Maximum number of files to include source code from (default 12).' },
    },
    timeoutMs: resolved.callTimeoutMs + 15000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const callArgs = { query: args.query };
      if (args.maxFiles !== undefined) callArgs.maxFiles = args.maxFiles;
      return callCodegraph(resolveCwd(exec), 'codegraph_explore', callArgs, exec?.signal);
    },
  }));

  const systemPrompt = ctx.get('systemPrompt');
  systemPrompt?.section?.({
    name: 'tool:codegraph',
    order: 108,
    text: 'codegraph_explore answers structural questions about the CURRENT session workspace from a pre-built '
      + 'code knowledge graph (it follows each session\'s repo, and the index auto-syncs on file changes). '
      + 'Call it FIRST for "how does X work", flow ("how does X reach Y"), blast-radius ("what breaks if I change X"), '
      + 'or symbol-lookup questions — one call returns the relevant symbols\' verbatim source grouped by file plus the '
      + 'call paths between them; treat the returned source as already read and do not re-grep or re-open those files. '
      + 'It only covers the indexed repo: for other paths or unindexed projects, fall back to built-in search tools. '
      + 'After an edit, if a staleness banner names the edited file, Read that file directly.',
  });
}
