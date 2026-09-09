/**
 * dsh-fff-follow-workspace — persistent fff search tools for the DeepSeek
 * Harness.
 *
 * Registers `ffgrep`, `fffind`, and `fff_multi_grep` on the host `tools`
 * registry, backed by the `fff-mcp` binary spoken to over MCP stdio
 * (JSON-RPC 2.0, newline-delimited).
 *
 * fff-mcp roots its index at the directory it was spawned in, so one server
 * process is kept per workspace directory: every tool call resolves the
 * calling session's workspace (its session header `cwd`, falling back to the
 * initiating agent, then any live session, then the configured default) and
 * routes to the server rooted there. Searches therefore follow whichever repo
 * the agent is working in, and a server is reused across calls and sessions
 * on the same workspace instead of being restarted per call.
 *
 * This is the persistent, composition-file form of the former dynamic
 * "fff-follow-workspace" plugin: a bundle row mounted from the profile
 * composition survives restarts.
 *
 * @module dsh-fff-follow-workspace
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

/** Cordis plugin name for loader diagnostics. */
export const name = 'fff-follow-workspace';

/** Services required by this plugin. `agents` and `systemPrompt` are read optionally. */
export const inject = ['tools', 'subprocess', 'sessions'];

export const Config = z.object({
  /** Absolute path of the fff-mcp executable. */
  binPath: z.string().default('/home/node/.dsh/fff/fff-mcp'),
  /** Workspace used when no live session exposes a cwd. */
  defaultCwd: z.string().default('/workspace/workspace/tmp'),
  /** Handshake (initialize + tools/list) timeout per attempt, ms. */
  initTimeoutMs: z.number().default(15000),
  /** Per tools/call timeout, ms. */
  callTimeoutMs: z.number().default(60000),
  /** SIGTERM→SIGKILL grace for the managed fff-mcp child, ms. */
  graceMs: z.number().default(3000),
  /** Cap on simultaneously cached workspace servers (LRU eviction). */
  maxConnections: z.number().default(4),
});

/**
 * Apply the plugin: one MCP connection pool keyed by workspace, three
 * model-facing tools, and guidance. Every side effect is registered on the
 * calling fiber, so plugin stop/update disposes servers and timers.
 * @param ctx - Cordis context.
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
    for (const p of conn.pending.values()) p.reject(new Error('fff MCP connection closed'));
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
    if (!conn.handle.stdin) throw new Error('fff MCP stdin unavailable');
    const msg = { jsonrpc: '2.0', method };
    if (id !== undefined) msg.id = id;
    if (params !== undefined) msg.params = params;
    conn.handle.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** Await one JSON-RPC response by id, with timeout and caller-abort linkage. */
  function request(conn, method, params, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      if (conn.dead) {
        reject(new Error('fff MCP connection is closed'));
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
        finish(reject, new Error(`fff MCP request timed out: ${method}`));
      }, timeoutMs);
      if (signal) {
        if (signal.aborted) {
          finish(reject, new Error('fff MCP request aborted'));
          return;
        }
        onAbort = () => finish(reject, new Error('fff MCP request aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        write(conn, method, params, id);
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  /** Spawn fff-mcp rooted at `cwd` and complete the MCP handshake. */
  async function startConnection(cwd) {
    const handle = ctx.subprocess.spawn({
      argv: [resolved.binPath],
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
            if (msg.error) p.reject(new Error(msg.error.message || 'fff MCP error'));
            else p.resolve(msg.result);
          }
        }
      });
      handle.stdout.on('error', () => { conn.dead = true; });
    }
    handle.done.then(
      () => {
        conn.dead = true;
        for (const p of conn.pending.values()) p.reject(new Error('fff MCP process exited'));
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
      clientInfo: { name: 'dsh-fff-follow-workspace', version: '1.0.0' },
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
  async function ensureConn(cwd, signal) {
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
          throw new Error('fff MCP connection state was disposed');
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
    throw lastErr ?? new Error('fff MCP connection failed');
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

  /** Call one raw fff tool and flatten the MCP result into plain text. */
  async function callFff(cwd, rawName, args, signal) {
    const conn = await ensureConn(cwd, signal);
    const result = await request(conn, 'tools/call', { name: rawName, arguments: args ?? {} },
      resolved.callTimeoutMs, signal);
    let text = '(no output)';
    if (result && Array.isArray(result.content)) {
      text = result.content.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('');
    }
    if (result && result.isError === true) throw new Error(text || 'fff tool error');
    return { text: text || '(no output)' };
  }

  /** Define one public tool forwarding to raw fff tool `rawName`. */
  function makeTool(publicName, rawName, description, parameters) {
    return defineTool({
      name: publicName,
      description,
      parameters,
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
        return callFff(resolveCwd(exec), rawName, args, exec?.signal);
      },
    });
  }

  ctx.tools.register(makeTool('ffgrep', 'grep',
    'Grep file CONTENTS in the current workspace. Plain, regex, or fuzzy mode. Search ONE bare identifier or pattern per call.',
    {
      query: { type: 'string', required: true, description: 'Search text or regex with optional constraint prefixes. One specific term.' },
      context: { type: 'number', description: 'Context lines before/after each match.' },
      maxResults: { type: 'number', description: 'Max matching lines (default 20).' },
      output_mode: { type: 'string', description: "Output format (default 'content')." },
      cursor: { type: 'string', description: 'Cursor from previous result.' },
    }));

  ctx.tools.register(makeTool('fffind', 'find_files',
    'Find files by fuzzy name/path search across the current workspace. Supports path prefixes and glob constraints.',
    {
      query: { type: 'string', required: true, description: 'Fuzzy search query. Supports path prefixes and glob constraints.' },
      maxResults: { type: 'number', description: 'Max results (default 20).' },
      cursor: { type: 'string', description: 'Cursor from previous result.' },
    }));

  ctx.tools.register(makeTool('fff_multi_grep', 'multi_grep',
    'Grep file contents for ANY of several patterns (OR logic). Use for case variants and multiple identifiers.',
    {
      patterns: { type: 'array', items: { type: 'string' }, required: true, description: 'Patterns to match (OR). Include all naming conventions.' },
      constraints: { type: 'string', description: 'File constraints e.g. *.{ts,tsx} !test/.' },
      context: { type: 'number', description: 'Context lines before/after each match.' },
      maxResults: { type: 'number', description: 'Max matching lines.' },
      output_mode: { type: 'string', description: "Output format (default 'content')." },
      cursor: { type: 'string', description: 'Cursor from previous result.' },
    }));

  const systemPrompt = ctx.get('systemPrompt');
  systemPrompt?.section?.({
    name: 'tool:fff',
    order: 108,
    text: 'ffgrep/fffind/fff_multi_grep search the CURRENT session workspace (they follow each session\'s repo). '
      + 'Rules: grep matches single lines — search ONE bare identifier per fffgrep query (never keywords like "struct Foo", and never complex regex spanning tokens); '
      + 'prefer plain text over regex, and use fff_multi_grep with literal patterns for OR variants (snake_case + PascalCase) instead of sequential greps; '
      + 'fffind explores which files exist for a topic; file constraints go inline before the term for grep (e.g. "*.{ts,tsx} src/" myTerm) or in `constraints` for multi_grep. '
      + 'After two greps without a hit, read the top file instead of grepping more variations.',
  });
}
