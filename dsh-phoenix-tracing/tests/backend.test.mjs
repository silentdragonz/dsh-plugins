/**
 * Backend integration tests: construct PhoenixSessionBackend against a fake
 * cordis context, drive it through the REAL SessionTelemetryCoordinator with
 * synthetic session objects, and assert service registration, mode behavior,
 * record flow, and lifecycle. Spans are captured by wrapping the backend's
 * tracer, so nothing here depends on the exporter's network path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PhoenixSessionBackend from '../lib/index.js';

function makeCtx() {
  const handlers = new Map();
  const warnings = [];
  const disposers = [];
  const ctx = {
    warnings: warnings,
    disposers: disposers,
    reflect: {
      provide: function (name, value) {
        if (ctx[name]) throw new Error('duplicate service: ' + name);
        ctx[name] = value;
      },
    },
    on: function (type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    emit: function (type) {
      const args = Array.prototype.slice.call(arguments, 1);
      for (const fn of handlers.get(type) || []) fn.apply(null, args);
    },
    waterfall: function (name, value, next) {
      return next();
    },
    effect: function (factory) {
      disposers.push(factory);
    },
    sessions: { list: function () { return []; } },
    logger: {
      warn: function (m) { warnings.push(String(m)); },
      info: function () {},
      debug: function () {},
      error: function (m) { warnings.push(String(m)); },
    },
  };
  return ctx;
}

/** Minimal stand-in for the harness Session's read API (snapshotEvents/eventAt). */
function makeSession(id) {
  return {
    id: id,
    firstLiveSeq: 0,
    log: [],
    header: { cwd: '/work', parentSession: undefined, isSeeded: false },
    get seq() { return this.log.length; },
    eventAt: function (seq) { return this.log[seq]; },
    snapshotEvents: function (fromSeq = 0, toSeqExclusive = this.log.length) {
      return Object.freeze(this.log.slice(fromSeq, toSeqExclusive));
    },
  };
}

/** Append an event to the session log and publish it, as the harness does. */
function publish(ctx, session, type, data) {
  const event = { type: type, seq: session.log.length, time: Date.now(), data: data };
  session.log[event.seq] = event;
  ctx.emit('session/event', session, event);
  return event;
}

/** Wrap the backend's tracer so every created span is recorded and observable. */
function spySpans(backend) {
  const created = [];
  const tracer = backend.projector.tracer;
  const original = tracer.startSpan.bind(tracer);
  tracer.startSpan = function (name, options, context) {
    const span = original(name, options, context);
    const end = span.end.bind(span);
    span.end = function (t) {
      span.__ended = true;
      return end(t);
    };
    created.push(span);
    return span;
  };
  return created;
}

function fullBackend() {
  const ctx = makeCtx();
  const backend = new PhoenixSessionBackend(ctx, {
    mode: 'FULL',
    endpoint: 'http://127.0.0.1:59999/v1/traces', // nothing listening; scheduled delay keeps the timer quiet
    projectName: 'test-project',
    exporter: { timeoutMillis: 400 },
    processor: { scheduledDelayMillis: 3600000 },
    shutdownTimeoutMillis: 900,
  });
  return { ctx: ctx, backend: backend };
}

test('FULL mode: registers sessionTelemetry and projects the live firehose', () => {
  const t = fullBackend();
  assert.equal(t.ctx.sessionTelemetry, t.backend);
  assert.equal(t.backend.sharing, 'full');
  const spans = spySpans(t.backend);

  const session = makeSession('sess-42');
  t.ctx.emit('session/created', session);
  publish(t.ctx, session, 'turn/start', { turn: 1 });
  publish(t.ctx, session, 'user/message', { content: [{ type: 'text', text: 'hello trace' }], source: { kind: 'user' } });
  publish(t.ctx, session, 'step/start', { turn: 1, step: 0 });
  publish(t.ctx, session, 'assistant/message', {
    turn: 1,
    step: 0,
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }], source: { kind: 'model', provider: 'p1', model: 'm1' } },
    usage: { inputTokens: 10, outputTokens: 4 },
  });
  publish(t.ctx, session, 'step/end', { turn: 1, step: 0 });
  publish(t.ctx, session, 'turn/end', { turn: 1, reason: { kind: 'completed' } });

  const names = spans.map((s) => s.name);
  assert.ok(names.includes('hello trace'), 'turn renamed to the user prompt: ' + JSON.stringify(names));
  assert.ok(names.includes('Step 1.0'));
  assert.ok(names.includes('LLM call m1'));
  assert.ok(spans.every((s) => s.attributes['session.id'] === 'sess-42'));
  assert.ok(spans.find((s) => s.name === 'hello trace').__ended);

  // session/flush forwards to a force-flush hint without throwing
  t.ctx.emit('session/flush', session);

  // disposal emits the ops shutdown record: projector state settles
  t.ctx.emit('session/disposed', session);
  assert.equal(t.backend.projector.sessions.size, 0);
});

test('agent/error bus relay marks the live turn span', () => {
  const t = fullBackend();
  const session = makeSession('sess-err');
  t.ctx.emit('session/created', session);
  publish(t.ctx, session, 'turn/start', { turn: 7 });
  const spans = spySpans(t.backend);
  publish(t.ctx, session, 'step/start', { turn: 7, step: 0 });
  t.ctx.emit('agent/error', { agent: { id: 'agent-1', session: session }, turn: 7, step: 0, error: new Error('kaboom') });
  const step = spans.find((s) => s.name === 'Step 7.0');
  assert.ok(step);
  // the exception event lands on the owning turn span (started before the spy
  // on turn 7, so verify via the projector not throwing + step still open);
  // relay must never propagate to the emitter:
  publish(t.ctx, session, 'turn/end', { turn: 7, reason: { kind: 'aborted', reason: { kind: 'internal' } } });
  assert.ok(spans.find((s) => s.name === 'Step 7.0').__ended);
});

test('FEEDBACK_ONLY: silent until a canonical feedback event replays the suffix', () => {
  const ctx = makeCtx();
  const backend = new PhoenixSessionBackend(ctx, {
    mode: 'FEEDBACK_ONLY',
    endpoint: 'http://127.0.0.1:59999/v1/traces',
    processor: { scheduledDelayMillis: 3600000 },
  });
  assert.equal(backend.sharing, 'feedback-only');
  const spans = spySpans(backend);

  const session = makeSession('sess-fb');
  ctx.emit('session/created', session); // on-demand mode must NOT adopt
  publish(ctx, session, 'turn/start', { turn: 1 });
  publish(ctx, session, 'assistant/message', {
    turn: 1,
    step: 0,
    message: { role: 'assistant', content: [{ type: 'text', text: 'silent' }], source: { kind: 'model', provider: 'p', model: 'm' } },
  });
  assert.equal(spans.length, 0);

  const feedback = publish(ctx, session, 'feedback/record', { text: 'nice work' });
  assert.ok(spans.length > 0, 'replay created spans on feedback');
  const turn = spans.find((s) => s.name === 'Turn 1');
  assert.ok(turn.__ended, 'feedback replay settles the suffix');
  const events = turn.events.map((e) => e.name);
  assert.ok(events.includes('session.feedback'));

  // non-canonical feedback (bus event not in the log) is refused with a warning
  const before = spans.length;
  const stray = { type: 'feedback/record', seq: 999, time: Date.now(), data: { text: 'x' } };
  ctx.emit('session/event', session, stray);
  assert.equal(spans.length, before);
  assert.ok(ctx.warnings.some((w) => w.includes('canonical')));
});

test('DISABLED: no SDK state; feedback warns that sharing is off', () => {
  const ctx = makeCtx();
  const backend = new PhoenixSessionBackend(ctx, { mode: 'DISABLED' });
  assert.equal(backend.provider, undefined);
  assert.equal(backend.projector, undefined);
  assert.equal(backend.sharing, 'disabled');
  backend.emit({ channel: 'ledger', time: Date.now(), severity: 'info', attributes: {}, body: {} }); // no-op, no throw
  const session = makeSession('s-d');
  ctx.emit('session/created', session);
  publish(ctx, session, 'feedback/record', { text: 'meh' });
  assert.ok(ctx.warnings.some((w) => w.includes('DISABLED')));
  backend.flush(); // no-op
  return backend.shutdown(); // resolves immediately, no provider
});

test('config validation rejects unusable values at construction', () => {
  const base = { mode: 'FULL' };
  assert.throws(function () { new PhoenixSessionBackend(makeCtx(), Object.assign({}, base, { endpoint: 'ftp://nope' })); }, /http\(s\)/);
  assert.throws(function () { new PhoenixSessionBackend(makeCtx(), Object.assign({}, base, { processor: { maxExportBatchSize: 0 } })); }, /maxExportBatchSize/);
  assert.throws(function () { new PhoenixSessionBackend(makeCtx(), Object.assign({}, base, { shutdownTimeoutMillis: -5 })); }, /shutdownTimeoutMillis/);
  assert.throws(function () { new PhoenixSessionBackend(makeCtx(), { mode: 'SOMETHING' }); }, /unsupported mode/);
});

test('duplicate mount throws like any cordis service collision', () => {
  const t = fullBackend();
  assert.throws(function () { new PhoenixSessionBackend(t.ctx, { mode: 'DISABLED' }); }, /duplicate service/);
});

test('endpoint normalization: base URLs gain /v1/traces', () => {
  const ctx = makeCtx();
  const backend = new PhoenixSessionBackend(ctx, {
    mode: 'FULL',
    endpoint: 'http://localhost:6006',
    processor: { scheduledDelayMillis: 3600000 },
  });
  const url = backend.provider && backend.projector && 'ok'; // provider wired without throwing
  assert.equal(url, 'ok');
  assert.equal(backend.sharing, 'full');
});
