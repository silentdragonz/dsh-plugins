/**
 * OTLP/HTTP wire test: point the plugin's exact export stack (OTLPTraceExporter
 * + BatchSpanProcessor + BasicTracerProvider) at a local HTTP sink and verify
 * that projected spans arrive as a real OTLP protobuf export with the Phoenix
 * project routing header, using the production code path end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import PhoenixSessionBackend from '../lib/index.js';

function makeCtx() {
  const handlers = new Map();
  const ctx = {
    reflect: { provide: function (name, value) { ctx[name] = value; } },
    on: function (type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    emit: function (type) {
      const args = Array.prototype.slice.call(arguments, 1);
      for (const fn of handlers.get(type) || []) fn.apply(null, args);
    },
    waterfall: function (name, value, next) { return next(); },
    effect: function () {},
    sessions: { list: function () { return []; } },
    logger: { warn: function () {}, info: function () {}, debug: function () {}, error: function () {} },
  };
  return ctx;
}

test('spans export over OTLP/HTTP to the configured Phoenix endpoint', async () => {
  const requests = [];
  const server = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      requests.push({ path: req.url, contentType: req.headers['content-type'], project: req.headers['x-project-name'], body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  try {
    const ctx = makeCtx();
    const backend = new PhoenixSessionBackend(ctx, {
      mode: 'FULL',
      endpoint: 'http://127.0.0.1:' + port + '/v1/traces',
      projectName: 'wire-test',
      processor: { scheduledDelayMillis: 50, maxExportBatchSize: 64 },
      exporter: { timeoutMillis: 4000 },
      shutdownTimeoutMillis: 4000,
    });
    const session = {
      id: 'sess-wire', firstLiveSeq: 0, log: [], header: { cwd: '/w' },
      get seq() { return this.log.length; },
      eventAt: function (seq) { return this.log[seq]; },
      snapshotEvents: function (fromSeq = 0, toSeqExclusive = this.log.length) {
        return Object.freeze(this.log.slice(fromSeq, toSeqExclusive));
      },
    };
    ctx.emit('session/created', session);
    const publish = function (type, data) {
      const event = { type: type, seq: session.log.length, time: Date.now(), data: data };
      session.log[event.seq] = event;
      ctx.emit('session/event', session, event);
    };
    publish('turn/start', { turn: 1 });
    publish('user/message', { content: [{ type: 'text', text: 'wire probe' }], source: { kind: 'user' } });
    publish('step/start', { turn: 1, step: 0 });
    publish('assistant/message', {
      turn: 1, step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }], source: { kind: 'model', provider: 'acme', model: 'wire-model' } },
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    publish('step/end', { turn: 1, step: 0 });
    publish('turn/end', { turn: 1, reason: { kind: 'completed' } });

    await backend.shutdown(); // drains the batch queue through the exporter

    assert.ok(requests.length >= 1, 'exporter delivered at least one request');
    const post = requests[0];
    assert.equal(post.path, '/v1/traces');
    // Regression pin (Phoenix rejects JSON with 415): traces must go out as protobuf
    assert.equal(post.contentType, 'application/x-protobuf');
    assert.equal(post.project, 'wire-test');
    assert.ok(post.body.length > 0, 'non-empty payload');
    // Structural span-tree correctness is covered by tests/mapper.test.mjs; the
    // wire test pins the transport contract and payload content. String fields
    // appear verbatim in the OTLP protobuf wire format.
    const text = post.body.toString('latin1');
    const scope = ['dsh-phoenix-tracing', 'sess-wire', 'wire probe', 'Step 1.0', 'LLM call wire-model',
      'openinference.span.kind', 'llm.token_count.total', 'llm.model_name', 'input.value', 'output.value',
      'deepseek-harness', 'wire-test'];
    for (const needle of scope) assert.ok(text.includes(needle), 'payload carries ' + needle);
    assert.ok(post.body.length > 500, 'payload sized plausibly for the tree: ' + post.body.length);

  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }
});
