/**
 * Projector tests: feed synthetic seam records, assert the span tree,
 * OpenInference attributes, status mapping, healing, and dedupe - against
 * the real OTel SDK with an in-memory exporter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { SpanProjector } from '../lib/mapper.js';

function harness(options) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const projector = new SpanProjector(provider.getTracer('test'), options || {});
  const byName = () => {
    const map = new Map();
    for (const span of exporter.getFinishedSpans()) {
      // names can repeat across steps; key by name is enough for these fixtures
      map.set(span.name, span);
    }
    return map;
  };
  return { exporter, projector, byName };
}

function ledger(seq, time, type, body, extraAttrs) {
  return {
    channel: 'ledger',
    time: time,
    severity: 'info',
    attributes: Object.assign({ 'session.id': 's1', 'event.type': type, 'event.seq': seq }, extraAttrs || {}),
    body: body,
  };
}

function toolResult(seq, time, opts) {
  return {
    channel: 'ledger',
    time: time,
    severity: opts.isError ? 'error' : 'info',
    attributes: { 'session.id': 's1', 'event.type': 'tool/result', 'event.seq': seq },
    body: {
      turn: opts.turn,
      step: opts.step,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: opts.callId, content: [{ type: 'text', text: opts.text }], isError: !!opts.isError }],
        source: { kind: 'tool', callId: opts.callId },
      },
    },
  };
}

function parentId(span) {
  // OTel JS SDK 2.x exposes ReadableSpan.parentSpanContext (1.x: parentSpanId)
  return span.parentSpanContext ? span.parentSpanContext.spanId : span['parentSpanId'];
}

function hrToMs(hrTime) {
  return hrTime[0] * 1000 + Math.round(hrTime[1] / 1e6);
}

test('happy path: full turn with two steps, tools, tokens, and naming', () => {
  const h = harness();
  const records = [
    ledger(1, 1000, 'turn/start', { turn: 1 }),
    ledger(2, 1010, 'user/message', { role: 'user', content: [{ type: 'text', text: 'Fix the bug in parser.rs' }], source: { kind: 'user' } }),
    ledger(3, 1100, 'step/start', { turn: 1, step: 0 }),
    ledger(4, 1300, 'assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'W' } }),
    ledger(5, 1500, 'assistant/message', {
      turn: 1,
      step: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Working...' }, { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }],
        source: { kind: 'model', provider: 'acme', model: 'model-x' },
      },
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 },
    }),
    ledger(6, 1510, 'tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"ls","description":"list files"}' }),
    toolResult(7, 1700, { turn: 1, step: 0, callId: 'call-1', text: 'file.txt' }),
    ledger(8, 1750, 'step/end', { turn: 1, step: 0 }),
    ledger(9, 1800, 'step/start', { turn: 1, step: 1 }),
    ledger(10, 2100, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], source: { kind: 'model', provider: 'acme', model: 'model-x' } },
      usage: { inputTokens: 120, outputTokens: 5 },
    }),
    ledger(11, 2110, 'step/end', { turn: 1, step: 1 }),
    ledger(12, 2200, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  for (const record of records) h.projector.onRecord(record);

  const spans = h.exporter.getFinishedSpans();
  const names = spans.map((s) => s.name).sort();
  assert.deepEqual(names, ['Fix the bug in parser.rs', 'LLM call model-x', 'LLM call model-x', 'Step 1.0', 'Step 1.1', 'bash']);

  const byName = h.byName();
  const turn = byName.get('Fix the bug in parser.rs'); // renamed from "Turn 1"
  const step0 = byName.get('Step 1.0');
  const step1 = byName.get('Step 1.1');
  const tool = byName.get('bash');

  // tree: turn is the root; steps nest under it; tool under step 0
  assert.equal(parentId(turn), undefined);
  assert.equal(parentId(step0), turn.spanContext().spanId);
  assert.equal(parentId(step1), turn.spanContext().spanId);
  assert.equal(parentId(tool), step0.spanContext().spanId);
  // steps of one turn share one trace id
  assert.equal(step0.spanContext().traceId, turn.spanContext().traceId);

  // turn content + outcome
  assert.equal(turn.attributes['openinference.span.kind'], 'CHAIN');
  assert.equal(turn.attributes['session.id'], 's1');
  assert.equal(turn.attributes['turn.id'], 1);
  assert.equal(turn.attributes['input.value'], 'Fix the bug in parser.rs');
  assert.equal(turn.attributes['output.value'], 'Done.');
  assert.equal(turn.attributes['dsh.turn.end_reason'], 'completed');
  assert.equal(turn.status.code, SpanStatusCode.OK);
  assert.equal(hrToMs(turn.startTime), 1000);
  assert.equal(hrToMs(turn.endTime), 2200);

  // LLM span of step 0
  const llms = spans.filter((s) => s.name === 'LLM call model-x');
  assert.equal(llms.length, 2);
  const llm0 = llms.find((s) => parentId(s) === step0.spanContext().spanId);
  assert.equal(llm0.attributes['openinference.span.kind'], 'LLM');
  assert.equal(llm0.attributes['llm.provider'], 'acme');
  assert.equal(llm0.attributes['llm.model_name'], 'model-x');
  assert.equal(llm0.attributes['llm.token_count.prompt'], 140); // 100 + 40 cached
  assert.equal(llm0.attributes['llm.token_count.prompt_details.cache_read'], 40);
  assert.equal(llm0.attributes['llm.token_count.completion'], 20);
  assert.equal(llm0.attributes['llm.token_count.total'], 160);
  assert.equal(llm0.attributes['dsh.llm.time_to_first_token_ms'], 200); // 1300 - 1100
  assert.equal(llm0.attributes['llm.output_messages.0.message.role'], 'assistant');
  assert.equal(llm0.attributes['llm.output_messages.0.message.content'], 'Working...');
  assert.equal(llm0.attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.name'], 'bash');
  assert.equal(llm0.attributes['llm.input_messages.0.message.role'], 'user');
  assert.equal(llm0.attributes['llm.input_messages.0.message.content'], 'Fix the bug in parser.rs');

  // tool span
  assert.equal(tool.attributes['openinference.span.kind'], 'TOOL');
  assert.equal(tool.attributes['tool.name'], 'bash');
  assert.equal(tool.attributes['tool.call.id'], 'call-1');
  assert.equal(tool.attributes['tool.command'], 'ls');
  assert.equal(tool.attributes['tool.description'], 'list files');
  assert.equal(tool.attributes['input.value'], '{"command":"ls","description":"list files"}');
  assert.equal(tool.attributes['output.value'], 'file.txt');
  assert.equal(tool.status.code, SpanStatusCode.OK);
});

test('error statuses: tool result error and turn failure', () => {
  const h = harness();
  h.projector.onRecord(ledger(1, 1000, 'turn/start', { turn: 1 }));
  h.projector.onRecord(ledger(2, 1010, 'step/start', { turn: 1, step: 0 }));
  h.projector.onRecord(ledger(3, 1020, 'tool/call', { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{}' }));
  h.projector.onRecord(toolResult(4, 1030, { turn: 1, step: 0, callId: 'c1', text: 'boom', isError: true }));
  h.projector.onRecord(ledger(5, 1040, 'step/end', { turn: 1, step: 0 }));
  h.projector.onRecord(ledger(6, 1050, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'provider exploded', code: 'ERR' } } }));
  const byName = h.byName();
  assert.equal(byName.get('bash').status.code, SpanStatusCode.ERROR);
  const turn = byName.get('Turn 1');
  assert.equal(turn.status.code, SpanStatusCode.ERROR);
  assert.match(turn.status.message, /provider exploded/);
});

test('healing: unclosed turn and step are completed by later brackets', () => {
  const h = harness();
  h.projector.onRecord(ledger(1, 1000, 'turn/start', { turn: 1 }));
  h.projector.onRecord(ledger(2, 1010, 'step/start', { turn: 1, step: 0 }));
  // crash: no step/end, no assistant/message, no turn/end - turn 2 starts:
  h.projector.onRecord(ledger(3, 2000, 'turn/start', { turn: 2 }));
  const spans = h.exporter.getFinishedSpans();
  const step = spans.find((s) => s.name === 'Step 1.0');
  const turn = spans.find((s) => s.name === 'Turn 1');
  const llm = spans.find((s) => s.name === 'LLM call');
  assert.ok(step.attributes['dsh.incomplete']);
  assert.ok(turn.attributes['dsh.incomplete']);
  assert.ok(llm.attributes['dsh.llm.interrupted']);
  // and the session settles cleanly on the shutdown op
  h.projector.onRecord({ channel: 'ops', time: 9000, severity: 'info', attributes: { 'telemetry.op': 'shutdown', 'session.id': 's1' }, body: { op: 'shutdown' } });
  assert.equal(h.projector.sessions.size, 0);
});

test('orphan tool result synthesizes a TOOL span; duplicate seqs are dropped', () => {
  const h = harness();
  h.projector.onRecord(ledger(1, 1000, 'turn/start', { turn: 1 }));
  h.projector.onRecord(toolResult(5, 1100, { turn: 1, step: 0, callId: 'cX', text: 'stray' }));
  const before = h.exporter.getFinishedSpans().length;
  const stray = h.exporter.getFinishedSpans().find((s) => s.attributes['tool.call.id'] === 'cX');
  assert.ok(stray);
  assert.ok(stray.attributes['dsh.incomplete']);
  assert.equal(stray.attributes['output.value'], 'stray');
  // replay the same seqs: no new spans
  h.projector.onRecord(ledger(1, 1000, 'turn/start', { turn: 1 }));
  h.projector.onRecord(toolResult(5, 1100, { turn: 1, step: 0, callId: 'cX', text: 'stray' }));
  assert.equal(h.exporter.getFinishedSpans().length, before);
});

test('captureContent false strips text but keeps identity and tokens', () => {
  const h = harness({ captureContent: false });
  h.projector.onRecord(ledger(1, 1000, 'turn/start', { turn: 1 }));
  h.projector.onRecord(ledger(2, 1010, 'user/message', { content: [{ type: 'text', text: 'secret prompt' }], source: { kind: 'user' } }));
  h.projector.onRecord(ledger(3, 1100, 'step/start', { turn: 1, step: 0 }));
  h.projector.onRecord(ledger(4, 1200, 'assistant/message', {
    turn: 1,
    step: 0,
    message: { role: 'assistant', content: [{ type: 'text', text: 'secret answer' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    usage: { inputTokens: 7, outputTokens: 3 },
  }));
  h.projector.onRecord(ledger(5, 1210, 'step/end', { turn: 1, step: 0 }));
  h.projector.onRecord(ledger(6, 1300, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
  const spans = h.exporter.getFinishedSpans();
  const turn = spans.find((s) => s.name === 'Turn 1'); // no rename: prompts are off
  assert.equal(turn.attributes['input.value'], undefined);
  const llm = spans.find((s) => s.name === 'LLM call m');
  assert.equal(llm.attributes['output.value'], undefined);
  assert.equal(llm.attributes['llm.output_messages.0.message.content'], undefined);
  assert.equal(llm.attributes['llm.token_count.total'], 10); // counts survive
});

test('agent error op marks the active turn; feedback attaches as span event', () => {
  const h = harness();
  h.projector.onRecord(ledger(1, 1000, 'turn/start', { turn: 1 }, { 'session.cwd': '/work' }));
  h.projector.onRecord(ledger(2, 1010, 'feedback/record', { text: 'great answer' }));
  h.projector.onRecord({
    channel: 'ops', time: 1100, severity: 'error',
    attributes: { 'telemetry.op': 'agent-error', 'session.id': 's1', 'error.name': 'TypeError', turn: 1, step: 0 },
    body: { name: 'TypeError', message: 'x is not a function' },
  });
  h.projector.onRecord(ledger(3, 1200, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }));
  const spans = h.exporter.getFinishedSpans();
  const turn = spans.find((s) => s.name === 'Turn 1');
  assert.equal(turn.attributes['session.cwd'], '/work');
  assert.equal(turn.status.code, SpanStatusCode.ERROR); // agent error wins over aborted
  const events = turn.events.map((e) => e.name);
  assert.ok(events.includes('session.feedback'));
  assert.ok(events.includes('exception'));
  const exception = turn.events.find((e) => e.name === 'exception');
  assert.equal(exception.attributes['exception.type'], 'TypeError');
});
