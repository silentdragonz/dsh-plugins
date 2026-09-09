/**
 * Session-record to OpenInference span projector.
 *
 * The DSH telemetry seam (@deepseek-ai/dsh-session-telemetry) hands a backend
 * a flat firehose of logical records - one per session-log event, plus two
 * operational records (agent-error, shutdown). This module rebuilds the
 * hierarchy those records imply and renders it as proper OTel spans so Arize
 * Phoenix sees traces instead of loose log lines:
 *
 *   Turn {n}           (CHAIN)  root of one trace; carries session.id so
 *                               Phoenix's Sessions view groups traces into
 *                               conversation threads
 *     Step {t}.{s}     (CHAIN)  one loop iteration (a model call plus the tool
 *                               executions it requested)
 *       LLM call {m}   (LLM)    model call: provider/model, token accounting,
 *                               output messages, time-to-first-token
 *       {tool}         (TOOL)   one tool execution requested by that step
 *
 * OpenInference conventions (openinference.span.kind, llm.*, tool.*,
 * input.value / output.value, session.id, turn.id) follow
 * github.com/Arize-ai/coding-harness-tracing so Phoenix renders the spans with
 * its built-in LLM/Agent views and evaluation surfaces.
 *
 * The projector consumes exactly what a SessionTelemetryRecord carries -
 * nothing else about a live session is assumed. Events whose opening bracket
 * never arrived (adoption mid-turn, replay past the handoff cursor) are met
 * with synthesized spans marked dsh.incomplete=true, so a trace never loses a
 * container silently.
 *
 * @module dsh-phoenix-tracing/mapper
 */
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace as traceApi } from '@opentelemetry/api';

/** Instrumentation scope name reported with every projected span. */
export const PROJECTOR_SCOPE = 'dsh-phoenix-tracing';

const DEFAULT_MAX_CONTENT_CHARS = 32768;
const NAME_PREVIEW_CHARS = 60;

/** Non-hierarchical events folded into the active span as span events. */
const GENERIC_EVENT_TYPES = new Set([
  'llm/retry',
  'llm/retry-started',
  'approval/asked',
  'approval/decided',
  'compaction/start',
  'compaction/end',
  'goal/change',
  'plan/mode',
  'sandbox/mode',
  'permission/preset',
]);

/** Turn-end reason to OTel span status, mirroring the seam's alerting severity. */
function turnEndStatus(reason) {
  switch (reason && reason.kind) {
    case 'error':
      return { code: SpanStatusCode.ERROR, message: (reason.error && reason.error.message) || 'turn failed' };
    case 'aborted':
      return { code: SpanStatusCode.UNSET };
    default:
      return { code: SpanStatusCode.OK };
  }
}

function isBlockArray(blocks) {
  return Array.isArray(blocks);
}

/** Concatenate visible text blocks; optional reasoning text; images become a marker. */
function textFromContent(blocks, includeReasoning) {
  if (!isBlockArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'reasoning' && includeReasoning && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join('\n').trim();
}

function collapseWhitespace(text) {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

function truncate(value, max) {
  if (typeof value !== 'string' || value.length <= max) return value;
  return value.slice(0, max) + '...[truncated ' + (value.length - max) + ' chars]';
}

/**
 * Tool-name-aware detail attributes (command, file path, query, url), mirroring
 * the span_renderer of Arize's coding-harness-tracing so Phoenix rows stay
 * scannable without expanding the raw JSON arguments.
 */
function putToolDetails(attrs, toolName, parsedArgs) {
  if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return;
  const str = (key) => (typeof parsedArgs[key] === 'string' ? parsedArgs[key] : undefined);
  let details = {};
  switch (toolName) {
    case 'bash':
      details = { 'tool.command': str('command'), 'tool.description': str('description') || str('command') };
      break;
    case 'read':
    case 'write':
    case 'edit':
      details = { 'tool.file_path': str('file_path'), 'tool.description': str('description') };
      break;
    case 'glob':
      details = { 'tool.query': str('pattern'), 'tool.file_path': str('path') };
      break;
    case 'grep':
      details = { 'tool.query': str('pattern'), 'tool.file_path': str('path') };
      break;
    case 'web_search':
      details = { 'tool.query': Array.isArray(parsedArgs.queries) ? parsedArgs.queries.join(' | ') : str('query') };
      break;
    case 'web_fetch':
    case 'fetch':
      details = { 'tool.url': str('url') };
      break;
    default:
      details = { 'tool.description': str('description') };
      break;
  }
  for (const key of Object.keys(details)) {
    if (details[key]) attrs[key] = details[key];
  }
}

/** Flattened OpenInference assistant-message attributes for one assembled message. */
function putLlmOutputMessages(attrs, message, maxChars) {
  if (!message || typeof message !== 'object') return;
  const base = 'llm.output_messages.0.message';
  attrs[base + '.role'] = 'assistant';
  const text = textFromContent(message.content, false);
  if (text) attrs[base + '.content'] = truncate(text, maxChars);
  const calls = (isBlockArray(message.content) ? message.content : []).filter((b) => b && b.type === 'tool-call');
  calls.forEach((call, index) => {
    const cb = base + '.tool_calls.' + index + '.tool_call';
    if (call.id) attrs[cb + '.id'] = String(call.id);
    if (call.name) attrs[cb + '.function.name'] = call.name;
    if (typeof call.arguments === 'string') attrs[cb + '.function.arguments'] = truncate(call.arguments, maxChars);
  });
}

/** String/number/boolean fields of an event body, namespaced for span events. */
function scalarAttributes(body, prefix) {
  const attrs = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return attrs;
  let count = 0;
  for (const key of Object.keys(body)) {
    if (count >= 16) break;
    const value = body[key];
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      attrs[prefix + '.' + key] = value;
      count += 1;
    }
  }
  return attrs;
}

/**
 * Stateful span builder fed by the telemetry seam's record firehose.
 *
 * Every method is synchronous and non-blocking: span start/end are memory
 * operations, and the OTel SDK's processor owns export timing.
 */
export class SpanProjector {
  /**
   * @param {import('@opentelemetry/api').Tracer} tracer - OTel tracer receiving the projection.
   * @param {object} [options] - projection options.
   * @param {boolean} [options.captureContent] - gate prompt/completion/tool text on spans (default true).
   * @param {boolean} [options.captureReasoning] - additionally fold reasoning text into rendered text.
   * @param {number} [options.maxContentChars] - bound on every long string attribute.
   * @param {number} [options.maxSessions] - LRU bound on tracked sessions.
   * @param {(message: string) => void} [options.warn] - warning sink (never throws from).
   */
  constructor(tracer, options) {
    const opts = options || {};
    this.tracer = tracer;
    this.captureContent = opts.captureContent !== false;
    this.captureReasoning = opts.captureReasoning === true;
    this.maxContentChars = typeof opts.maxContentChars === 'number' ? opts.maxContentChars : DEFAULT_MAX_CONTENT_CHARS;
    this.warn = typeof opts.warn === 'function' ? opts.warn : function () {};
    this.maxSessions = opts.maxSessions == null ? 512 : opts.maxSessions;
    this.sessions = new Map();
  }

  /** Project one seam record (ledger or ops channel). Never throws. */
  onRecord(record) {
    try {
      this.handle(record);
    } catch (error) {
      // Best-effort projection: a malformed record must never take the agent
      // loop - or the rest of the trace - down with it.
      this.warn('phoenix-tracing: projection failed: ' + String(error));
    }
  }

  handle(record) {
    const sessionId = String((record.attributes && record.attributes['session.id']) || 'unknown');
    if (record.channel === 'ops') {
      const op = record.attributes && record.attributes['telemetry.op'];
      if (op === 'shutdown') this.settleSession(sessionId, record.time);
      else if (op === 'agent-error') this.handleAgentError(sessionId, record);
      return;
    }
    const type = record.attributes && record.attributes['event.type'];
    if (!type) return;
    const state = this.ensureSession(sessionId, record);
    const seq = record.attributes['event.seq'];
    if (typeof seq === 'number') {
      if (seq <= state.lastSeq) return; // receiver-side dedupe per the seam contract
      state.lastSeq = seq;
    }
    switch (type) {
      case 'turn/start': return this.onTurnStart(state, record);
      case 'turn/end': return this.onTurnEnd(state, record);
      case 'step/start': return this.onStepStart(state, record);
      case 'step/end': return this.onStepEnd(state, record);
      case 'user/message': return this.onUserMessage(state, record);
      case 'assistant/chunk': return this.onAssistantChunk(state, record);
      case 'assistant/message': return this.onAssistantMessage(state, record);
      case 'tool/call': return this.onToolCall(state, record);
      case 'tool/result': return this.onToolResult(state, record);
      case 'session/title': return this.onSessionTitle(state, record);
      case 'request/header': return this.onRequestHeader(state, record);
      case 'feedback/record': return this.onFeedback(state, record);
      default:
        if (GENERIC_EVENT_TYPES.has(type)) this.onGenericEvent(state, record, type);
    }
  }

  // ---- state ---------------------------------------------------------------

  ensureSession(sessionId, record) {
    let state = this.sessions.get(sessionId);
    if (state) {
      if (record && record.time > state.lastSeen) state.lastSeen = record.time;
      return state;
    }
    this.evictIfNeeded();
    state = {
      id: sessionId,
      lastSeq: -1,
      lastSeen: (record && record.time) || Date.now(),
      title: undefined,
      cwd: undefined,
      parentId: undefined,
      turns: new Map(),
      openTurn: undefined,
      openSteps: new Map(),
      openTools: new Map(),
      pendingFeedback: [],
    };
    if (record && record.attributes) {
      if (record.attributes['session.cwd'] !== undefined) state.cwd = record.attributes['session.cwd'];
      if (record.attributes['session.parent_id'] !== undefined) state.parentId = record.attributes['session.parent_id'];
    }
    this.sessions.set(sessionId, state);
    return state;
  }

  /** Bound memory: settle and drop the least-recently-seen session when over capacity. */
  evictIfNeeded() {
    if (this.sessions.size < this.maxSessions) return;
    let oldestId;
    let oldestSeen = Infinity;
    for (const entry of this.sessions) {
      if (entry[1].lastSeen < oldestSeen) {
        oldestSeen = entry[1].lastSeen;
        oldestId = entry[0];
      }
    }
    if (oldestId !== undefined) {
      this.warn('phoenix-tracing: settling over-capacity session ' + oldestId);
      this.settleSession(oldestId, Date.now());
    }
  }

  // ---- turns ----------------------------------------------------------------

  openTurn(state, turnNo, startTime) {
    if (state.openTurn && state.openTurn.turn === turnNo) return state.openTurn;
    if (state.openTurn) {
      // heal an unclosed prior turn (and any steps still open inside it)
      this.closeOpenStepsIn(state, state.openTurn.turn, startTime);
      this.closeTurn(state.openTurn, startTime, true);
    }
    const attrs = this.sessionAttributes(state);
    attrs['turn.id'] = turnNo;
    attrs['openinference.span.kind'] = 'CHAIN';
    const span = this.tracer.startSpan('Turn ' + turnNo, { kind: SpanKind.INTERNAL, startTime: startTime, attributes: attrs }, ROOT_CONTEXT);
    const ctx = traceApi.setSpan(ROOT_CONTEXT, span);
    const turn = {
      turn: turnNo,
      span: span,
      ctx: ctx,
      inputs: [],
      lastAssistantText: '',
      named: false,
      startTime: startTime,
      ended: false,
    };
    state.turns.set(turnNo, turn);
    state.openTurn = turn;
    for (const feedback of state.pendingFeedback.splice(0)) span.addEvent('session.feedback', feedback.attrs, feedback.time);
    return turn;
  }

  onTurnStart(state, record) {
    this.openTurn(state, Number(record.body && record.body.turn) || 0, record.time);
  }

  onTurnEnd(state, record) {
    const turnNo = Number(record.body && record.body.turn) || (state.openTurn && state.openTurn.turn) || 0;
    let turn = state.turns.get(turnNo);
    if (!turn) {
      // Closing bracket without an opener (replay past the handoff cursor):
      // synthesize so the trace still carries the turn boundary and outcome.
      turn = this.openTurn(state, turnNo, record.time);
      turn.span.setAttribute('dsh.incomplete', true);
    }
    if (turn.ended) return;
    this.closeOpenStepsIn(state, turnNo, record.time); // a turn cannot end with steps still open
    this.closeTurn(turn, record.time, false, record.body && record.body.reason);
    if (state.openTurn === turn) state.openTurn = undefined;
  }

  closeTurn(turn, endTime, incomplete, reason) {
    if (turn.ended) return;
    if (this.captureContent && turn.inputs.length > 0)
      turn.span.setAttribute('input.value', truncate(turn.inputs.join('\n\n'), this.maxContentChars));
    if (this.captureContent && turn.lastAssistantText)
      turn.span.setAttribute('output.value', truncate(turn.lastAssistantText, this.maxContentChars));
    if (reason && reason.kind) turn.span.setAttribute('dsh.turn.end_reason', reason.kind);
    if (incomplete) turn.span.setAttribute('dsh.incomplete', true);
    const status = turnEndStatus(reason);
    if (incomplete && status.code === SpanStatusCode.OK) status.code = SpanStatusCode.UNSET;
    turn.span.setStatus(status);
    turn.span.end(Math.max(endTime, turn.startTime));
    turn.ended = true;
  }

  sessionAttributes(state) {
    const attrs = { 'session.id': state.id };
    if (state.cwd !== undefined) attrs['session.cwd'] = state.cwd;
    if (state.parentId !== undefined) attrs['session.parent_id'] = String(state.parentId);
    if (state.title !== undefined) attrs['session.title'] = state.title;
    return attrs;
  }

  // ---- steps and LLM calls -----------------------------------------------------

  onStepStart(state, record) {
    const turnNo = Number(record.body && record.body.turn) || 0;
    const stepNo = Number(record.body && record.body.step) || 0;
    const turn = state.turns.get(turnNo) || this.openTurn(state, turnNo, record.time);
    this.closeOpenStepsIn(state, turnNo, record.time); // heal steps that never got step/end
    const attrs = this.sessionAttributes(state);
    attrs['turn.id'] = turnNo;
    attrs['dsh.step'] = stepNo;
    attrs['openinference.span.kind'] = 'CHAIN';
    const span = this.tracer.startSpan('Step ' + turnNo + '.' + stepNo, { kind: SpanKind.INTERNAL, startTime: record.time, attributes: attrs }, turn.ctx);
    const ctx = traceApi.setSpan(turn.ctx, span);
    const llmAttrs = this.sessionAttributes(state);
    llmAttrs['turn.id'] = turnNo;
    llmAttrs['dsh.step'] = stepNo;
    llmAttrs['openinference.span.kind'] = 'LLM';
    const llmSpan = this.tracer.startSpan('LLM call', { kind: SpanKind.INTERNAL, startTime: record.time, attributes: llmAttrs }, ctx);
    state.openSteps.set(turnNo + ':' + stepNo, {
      turnNo: turnNo,
      stepNo: stepNo,
      span: span,
      ctx: ctx,
      llmSpan: llmSpan,
      llmEnded: false,
      startTime: record.time,
      ttftSet: false,
      tools: new Map(),
      turn: turn,
    });
  }

  onStepEnd(state, record) {
    const key = (Number(record.body && record.body.turn) || 0) + ':' + (Number(record.body && record.body.step) || 0);
    const step = state.openSteps.get(key);
    if (!step) return;
    this.healStep(step, record.time);
    step.span.setStatus({ code: SpanStatusCode.OK });
    step.span.end(Math.max(record.time, step.startTime));
    state.openSteps.delete(key);
  }

  /** Close a step's still-open LLM/tool spans (cancelled or truncated steps). */
  healStep(step, endTime) {
    if (!step.llmEnded) {
      step.llmSpan.setAttribute('dsh.llm.interrupted', true);
      step.llmSpan.setStatus({ code: SpanStatusCode.UNSET });
      step.llmSpan.end(Math.max(endTime, step.startTime));
      step.llmEnded = true;
    }
    for (const entry of [...step.tools]) {
      const tool = entry[1];
      tool.span.setAttribute('dsh.incomplete', true);
      tool.span.setStatus({ code: SpanStatusCode.UNSET });
      tool.span.end(Math.max(endTime, tool.startTime));
      tool.ended = true;
      step.tools.delete(entry[0]);
      state_unlinkTool(step, tool);
    }
  }

  closeOpenStepsIn(state, turnNo, endTime) {
    for (const entry of [...state.openSteps]) {
      const step = entry[1];
      if (step.turnNo !== turnNo) continue;
      this.healStep(step, endTime);
      step.span.setAttribute('dsh.incomplete', true);
      step.span.setStatus({ code: SpanStatusCode.UNSET });
      step.span.end(Math.max(endTime, step.startTime));
      state.openSteps.delete(entry[0]);
    }
  }

  onAssistantChunk(state, record) {
    const key = (Number(record.body && record.body.turn) || 0) + ':' + (Number(record.body && record.body.step) || 0);
    const step = state.openSteps.get(key);
    if (!step || step.ttftSet) return;
    step.ttftSet = true;
    const ttftMs = record.time - step.startTime;
    if (ttftMs >= 0) step.llmSpan.setAttribute('dsh.llm.time_to_first_token_ms', ttftMs);
  }

  onAssistantMessage(state, record) {
    const turnNo = Number(record.body && record.body.turn) || 0;
    const stepNo = Number(record.body && record.body.step) || 0;
    const key = turnNo + ':' + stepNo;
    let step = state.openSteps.get(key);
    if (!step) {
      // Assembled message with no open step (adoption mid-step): synthesize
      // the brackets so the output still lands inside a step.
      this.onStepStart(state, { channel: 'ledger', time: record.time, attributes: record.attributes, body: { turn: turnNo, step: stepNo } });
      step = state.openSteps.get(key);
      if (step) {
        step.span.setAttribute('dsh.incomplete', true);
        step.llmSpan.setAttribute('dsh.incomplete', true);
      }
    }
    const turn = state.turns.get(turnNo);
    const message = record.body && record.body.message;
    const usage = record.body && record.body.usage;
    const llm = (step && step.llmSpan) || (turn && turn.span);
    if (!llm) return;
    const source = message && message.source;
    if (source && source.provider) llm.setAttribute('llm.provider', String(source.provider));
    if (source && source.model) {
      llm.setAttribute('llm.model_name', String(source.model));
      llm.updateName('LLM call ' + source.model);
    }
    if (record.body && record.body.interrupted) llm.setAttribute('dsh.llm.interrupted', true);
    if (usage && typeof usage === 'object') {
      const cacheRead = Number(usage.cacheReadTokens) || 0;
      const cacheWrite = Number(usage.cacheWriteTokens) || 0;
      const prompt = (Number(usage.inputTokens) || 0) + cacheRead + cacheWrite;
      const completion = Number(usage.outputTokens) || 0;
      llm.setAttribute('llm.token_count.prompt', prompt);
      if (cacheRead) llm.setAttribute('llm.token_count.prompt_details.cache_read', cacheRead);
      if (cacheWrite) llm.setAttribute('llm.token_count.prompt_details.cache_write', cacheWrite);
      llm.setAttribute('llm.token_count.completion', completion);
      if (usage.reasoningTokens) llm.setAttribute('llm.token_count.completion_details.reasoning', Number(usage.reasoningTokens) || 0);
      llm.setAttribute('llm.token_count.total', prompt + completion);
    }
    if (this.captureContent) {
      const outAttrs = {};
      putLlmOutputMessages(outAttrs, message, this.maxContentChars);
      for (const name of Object.keys(outAttrs)) llm.setAttribute(name, outAttrs[name]);
      // Fold the turn's user prompt in as the OpenInference input message so
      // Phoenix dataset/evaluation extraction works out of the box.
      if (turn && turn.inputs.length > 0) {
        llm.setAttribute('llm.input_messages.0.message.role', 'user');
        llm.setAttribute('llm.input_messages.0.message.content', truncate(turn.inputs[0], this.maxContentChars));
      }
      const text = textFromContent(message && message.content, this.captureReasoning);
      if (text) {
        llm.setAttribute('output.value', truncate(text, this.maxContentChars));
        if (turn) turn.lastAssistantText = text;
      }
    }
    if (step && !step.llmEnded) {
      step.llmSpan.setStatus(record.body && record.body.interrupted ? { code: SpanStatusCode.UNSET } : { code: SpanStatusCode.OK });
      step.llmSpan.end(Math.max(record.time, step.startTime));
      step.llmEnded = true;
    }
  }

  // ---- tools --------------------------------------------------------------------

  onToolCall(state, record) {
    const turnNo = Number(record.body && record.body.turn) || 0;
    const stepNo = Number(record.body && record.body.step) || 0;
    const step = state.openSteps.get(turnNo + ':' + stepNo);
    const turn = state.turns.get(turnNo) || this.openTurn(state, turnNo, record.time);
    const name = typeof record.body.name === 'string' && record.body.name ? record.body.name : 'tool';
    const callId = String(record.body.callId != null ? record.body.callId : turnNo + ':' + stepNo + ':' + state.openTools.size);
    const attrs = this.sessionAttributes(state);
    attrs['turn.id'] = turnNo;
    attrs['dsh.step'] = stepNo;
    attrs['openinference.span.kind'] = 'TOOL';
    attrs['tool.name'] = name;
    attrs['tool.call.id'] = callId;
    let parsedArgs;
    const rawArgs = record.body.arguments;
    if (typeof rawArgs === 'string') {
      if (this.captureContent) attrs['input.value'] = truncate(rawArgs, this.maxContentChars);
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch {
        // raw model output may be malformed; detail extraction is best-effort
      }
      putToolDetails(attrs, name, parsedArgs);
    }
    const span = this.tracer.startSpan(name, { kind: SpanKind.INTERNAL, startTime: record.time, attributes: attrs }, (step && step.ctx) || turn.ctx);
    const tool = { span: span, startTime: record.time, step: step, ended: false };
    if (step) step.tools.set(callId, tool);
    state.openTools.set(callId, tool);
  }

  onToolResult(state, record) {
    const message = record.body && record.body.message;
    const resultBlock = message && Array.isArray(message.content) ? message.content[0] : undefined;
    const callId = String((message && message.source && message.source.callId) != null ? message.source.callId : (resultBlock && resultBlock.toolCallId != null ? resultBlock.toolCallId : ''));
    let tool = state.openTools.get(callId);
    if (!tool) {
      // Result without a recorded call (cursor jump, crash gap): synthesize a
      // TOOL span so the model-visible outcome still lands in the trace.
      const turn = state.openTurn;
      const attrs = this.sessionAttributes(state);
      attrs['openinference.span.kind'] = 'TOOL';
      attrs['tool.name'] = 'tool';
      attrs['tool.call.id'] = callId;
      attrs['dsh.incomplete'] = true;
      const span = this.tracer.startSpan('tool', { kind: SpanKind.INTERNAL, startTime: record.time, attributes: attrs }, (turn && turn.ctx) || ROOT_CONTEXT);
      tool = { span: span, startTime: record.time, step: undefined, ended: false };
    }
    if (tool.ended) {
      state.openTools.delete(callId);
      return;
    }
    const isError = (resultBlock && resultBlock.isError === true) || record.severity === 'error';
    if (this.captureContent) {
      const text = textFromContent(resultBlock && resultBlock.content, false);
      if (text) tool.span.setAttribute('output.value', truncate(text, this.maxContentChars));
    }
    const error = record.body && record.body.error;
    if (error && typeof error === 'object') {
      if (typeof error.name === 'string') tool.span.setAttribute('error.type', error.name);
      if (typeof error.code === 'string') tool.span.setAttribute('dsh.error.code', error.code);
    }
    if (isError) tool.span.setStatus({ code: SpanStatusCode.ERROR, message: 'tool error' });
    else tool.span.setStatus({ code: SpanStatusCode.OK });
    tool.span.end(Math.max(record.time, tool.startTime));
    tool.ended = true;
    state.openTools.delete(callId);
    if (tool.step && tool.step.tools.has(callId)) tool.step.tools.delete(callId);
  }

  // ---- session-level records -------------------------------------------------------

  onUserMessage(state, record) {
    const text = textFromContent(record.body && record.body.content, false);
    if (!text) return;
    const turn = state.openTurn || this.openTurn(state, 0, record.time);
    if (this.captureContent) turn.inputs.push(text);
    const sourceKind = record.body && record.body.source && record.body.source.kind;
    // The preview rename carries prompt text, so it is part of the content gate.
    if (this.captureContent && !turn.named && sourceKind === 'user') {
      turn.named = true;
      turn.span.updateName(truncate(collapseWhitespace(text), NAME_PREVIEW_CHARS));
    }
  }

  onSessionTitle(state, record) {
    const title = typeof record.body.title === 'string' ? record.body.title.trim() : '';
    if (!title) return;
    state.title = title;
    for (const turn of state.turns.values()) turn.span.setAttribute('session.title', title);
  }

  onRequestHeader(state, record) {
    const turn = state.openTurn;
    if (!turn) return;
    const config = record.body && record.body.header && record.body.header.config;
    if (config && typeof config.model === 'string') turn.span.setAttribute('dsh.request.model', config.model);
    if (config && typeof config.provider === 'string') turn.span.setAttribute('dsh.request.provider', config.provider);
  }

  onFeedback(state, record) {
    const text = typeof record.body.text === 'string' ? record.body.text : '';
    if (!text) return;
    const attrs = { 'feedback.text': this.captureContent ? truncate(text, this.maxContentChars) : '[redacted]' };
    if (state.openTurn) state.openTurn.span.addEvent('session.feedback', attrs, record.time);
    else state.pendingFeedback.push({ attrs: attrs, time: record.time });
  }

  onGenericEvent(state, record, type) {
    const turnNo = record.body && typeof record.body.turn === 'number' ? record.body.turn : undefined;
    const stepNo = record.body && typeof record.body.step === 'number' ? record.body.step : undefined;
    const step = turnNo !== undefined && stepNo !== undefined ? state.openSteps.get(turnNo + ':' + stepNo) : undefined;
    const target = (step && !step.llmEnded && step.llmSpan) || (step && step.span) || (state.openTurn && state.openTurn.span);
    if (!target) return;
    target.addEvent(type.replace(/\//g, '.'), scalarAttributes(record.body, 'dsh'), record.time);
  }

  handleAgentError(sessionId, record) {
    const state = this.ensureSession(sessionId, record);
    const attrs = { 'exception.type': (record.attributes && record.attributes['error.name']) || 'Error' };
    const detail = record.body;
    if (detail && typeof detail.message === 'string') attrs['exception.message'] = truncate(detail.message, this.maxContentChars);
    if (record.attributes && typeof record.attributes.turn === 'number') attrs['turn.id'] = record.attributes.turn;
    if (record.attributes && typeof record.attributes.step === 'number') attrs['dsh.step'] = record.attributes.step;
    const turnNo = record.attributes && typeof record.attributes.turn === 'number' ? record.attributes.turn : undefined;
    const turn = (turnNo !== undefined && state.turns.get(turnNo)) || state.openTurn;
    if (turn && !turn.ended) {
      turn.span.addEvent('exception', attrs, record.time);
      turn.span.setStatus({ code: SpanStatusCode.ERROR, message: attrs['exception.message'] });
    } else {
      this.warn('phoenix-tracing: agent-error with no live turn for session ' + sessionId);
    }
  }

  // ---- settlement ---------------------------------------------------------------------

  /**
   * Close every span still open for one session.
   * @param {string} sessionId
   * @param {number} [atTime] - epoch-ms end time for spans left open.
   * @param {{ keepState?: boolean }} [options] - keepState retains the turn
   *   index (so a later feedback-replay pass continues the same containers
   *   instead of creating duplicates) while ending all live spans.
   */
  settleSession(sessionId, atTime, options) {
    const opts = options || {};
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const time = atTime || Date.now();
    for (const entry of [...state.openSteps]) {
      const step = entry[1];
      this.healStep(step, time);
      step.span.setAttribute('dsh.incomplete', true);
      step.span.setStatus({ code: SpanStatusCode.UNSET });
      step.span.end(Math.max(time, step.startTime));
      state.openSteps.delete(entry[0]);
    }
    for (const entry of [...state.openTools]) {
      const tool = entry[1];
      if (!tool.ended) {
        tool.span.setAttribute('dsh.incomplete', true);
        tool.span.setStatus({ code: SpanStatusCode.UNSET });
        tool.span.end(Math.max(time, tool.startTime));
        tool.ended = true;
      }
      state.openTools.delete(entry[0]);
    }
    if (state.openTurn) {
      this.closeTurn(state.openTurn, time, true);
      state.openTurn = undefined;
    }
    if (!opts.keepState) this.sessions.delete(sessionId);
  }

  /** Settle every tracked session (backend disposal). */
  closeAll(atTime) {
    for (const id of [...this.sessions.keys()]) this.settleSession(id, atTime || Date.now());
  }
}

function state_unlinkTool(step, tool) {
  // no-op placeholder retained for symmetry; tool maps are cleared by callers
}
