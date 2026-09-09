/**
 * Arize Phoenix tracing backend for the DeepSeek Harness telemetry seam.
 *
 * The shipped OTLP backend (@deepseek-ai/dsh-session-telemetry-otel) maps
 * session records onto OTel LOGS. Phoenix wants TRACES: this backend mounts
 * the same sessionTelemetry service but composes the OTel trace pipeline
 * instead - a TracerProvider with a BatchSpanProcessor and an OTLP/HTTP span
 * exporter - and projects the records handed over by the seam's capture
 * coordinator onto proper OpenInference spans (see ./mapper.js). Everything
 * downstream of span.end() - batching, retry, queueing, loss policy - is the
 * SDK's, configured verbatim through the exporter/processor passthroughs,
 * exactly like the log backend.
 *
 * Because the seam admits ONE backend implementation per context, loading
 * this plugin replaces the OTLP log backend; the bundle patch disables the
 * session-telemetry-otel row so the two cannot collide.
 *
 * Config modes mirror the log backend:
 *   FULL           every captured record is projected live into spans.
 *   FEEDBACK_ONLY  a feedback/record event replays the canonical session-log
 *                  suffix through the projector on demand.
 *   DISABLED       no SDK state is constructed; nothing leaves the process.
 *
 * @module dsh-phoenix-tracing
 */
import { createRequire } from 'node:module';
import { DiagLogLevel, diag } from '@opentelemetry/api';
import z from '@deepseek-ai/schemastery';
import { SessionTelemetryBackend, SessionTelemetryCoordinator } from '@deepseek-ai/dsh-session-telemetry';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm';
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import { PROJECTOR_SCOPE, SpanProjector } from './mapper.js';

const { version } = createRequire(import.meta.url)('../package.json');

/** Session-sharing policy, sharing the seam's serialized vocabulary. */
const MODES = ['FULL', 'FEEDBACK_ONLY', 'DISABLED'];
const DEFAULT_PHOENIX_MODE = 'DISABLED';
const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 3000;
const MAX_TIMER_DELAY_MILLIS = 2147483647;
const DEFAULT_TRACES_URL = 'http://localhost:6006/v1/traces';
const DISABLED_FEEDBACK_WARNING = 'phoenix-tracing is DISABLED; nothing will be shared and this feedback remains local';
const NON_CANONICAL_FEEDBACK_WARNING = 'phoenix-tracing ignored a feedback event absent from the canonical session log';
const DROP_RECORD = function () {};

/** Schemastery validator for the plugin config; value checks live in the constructor. */
export const Config = z.object({
  mode: z.union(MODES).default(DEFAULT_PHOENIX_MODE),
  /** Full OTLP traces endpoint (default http://localhost:6006/v1/traces). */
  endpoint: z.string(),
  /** Exporter headers, e.g. api_key for Phoenix Cloud. */
  headers: z.any(),
  /** Phoenix project name (x-project-name header + openinference.project.name). */
  projectName: z.string(),
  /** Gate prompt/completion/tool text on spans (default true; false keeps ids/counts only). */
  captureContent: z.boolean(),
  /** Additionally fold reasoning text into rendered assistant text (default false). */
  captureReasoning: z.boolean(),
  /** Bound on every long string attribute (default 32768 chars). */
  maxContentChars: z.number(),
  /** Passed verbatim to OTLPTraceExporter (url is filled from endpoint). */
  exporter: z.any(),
  /** Passed verbatim to BatchSpanProcessor (minus the exporter slot). */
  processor: z.any(),
  /** Outer bound on the SDK shutdown path. */
  shutdownTimeoutMillis: z.number(),
});

/** Resolve the mode defensively (direct construction bypasses the schema). */
function resolveMode(mode) {
  const resolved = mode == null ? DEFAULT_PHOENIX_MODE : mode;
  if (MODES.indexOf(resolved) === -1) throw new Error('phoenix-tracing: unsupported mode ' + JSON.stringify(resolved));
  return resolved;
}

function sharingStatusFor(mode) {
  if (mode === 'FULL') return 'full';
  if (mode === 'FEEDBACK_ONLY') return 'feedback-only';
  return 'disabled';
}

/**
 * Normalize an endpoint to a full OTLP traces URL. Accepts a Phoenix base URL
 * (http://localhost:6006) and appends /v1/traces; requires http(s).
 */
function resolveEndpoint(input) {
  const raw = (typeof input === 'string' && input.trim()) || DEFAULT_TRACES_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('phoenix-tracing: endpoint is not a valid URL: ' + JSON.stringify(raw));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('phoenix-tracing: endpoint must be http(s), got ' + url.protocol);
  if (url.pathname === '' || url.pathname === '/' || url.pathname === '/v1')
    url.pathname = '/v1/traces';
  return url.toString();
}

/**
 * Route OTel SDK warnings/errors (export failures included) into the host
 * logger. Without this, OTLP export failures are silent by default - a wrong
 * endpoint or content type drops traces with no trace of the drop.
 */
const DIAG_BRIDGE_KEY = Symbol.for('dsh-phoenix-tracing.diagnostic-bridge');
function bridgeOtelDiagnostics(logger) {
  if (globalThis[DIAG_BRIDGE_KEY]) return;
  globalThis[DIAG_BRIDGE_KEY] = true;
  const render = function (args) { return Array.prototype.map.call(args, String).join(' '); };
  diag.setLogger({
    verbose: function () {},
    debug: function () {},
    info: function () {},
    warn: function () { logger.warn('[phoenix-tracing] ' + render(arguments)); },
    error: function () { logger.warn('[phoenix-tracing] OTel error: ' + render(arguments)); },
  }, DiagLogLevel.WARN);
}

/**
 * The Phoenix backend plugin - the only entry a deployment loads. It always
 * registers the sessionTelemetry service (duplicate load throws; disable the
 * OTLP log row). Uploading modes wire the trace pipeline and compose
 * SessionTelemetryCoordinator; DISABLED constructs no SDK state and warns
 * when recorded feedback stays local.
 */
export class PhoenixSessionBackend extends SessionTelemetryBackend {
  static inject = ['sessions'];
  static Config = Config;

  constructor(ctx, config) {
    const mode = resolveMode(config && config.mode);
    super(ctx);
    this.sharing = sharingStatusFor(mode);
    this.shutdownTimeoutMillis = DEFAULT_SHUTDOWN_TIMEOUT_MILLIS;
    this.provider = undefined;
    this.projector = undefined;
    this._drain = Promise.resolve();

    if (mode === 'DISABLED') {
      this._emit = DROP_RECORD;
      ctx.on('session/event', function (_session, event) {
        if (event.type === 'feedback/record') ctx.logger.warn(DISABLED_FEEDBACK_WARNING);
      });
      return;
    }

    const endpoint = resolveEndpoint(config.endpoint);
    bridgeOtelDiagnostics(ctx.logger);
    const shutdownTimeoutMillis = (config && config.shutdownTimeoutMillis) || DEFAULT_SHUTDOWN_TIMEOUT_MILLIS;
    if (!Number.isFinite(shutdownTimeoutMillis) || shutdownTimeoutMillis <= 0 || shutdownTimeoutMillis > MAX_TIMER_DELAY_MILLIS)
      throw new Error('phoenix-tracing: shutdownTimeoutMillis must be a positive finite number <= ' + MAX_TIMER_DELAY_MILLIS + ', got ' + String(shutdownTimeoutMillis));
    const batchSize = config.processor && config.processor.maxExportBatchSize;
    if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1))
      throw new Error('phoenix-tracing: processor.maxExportBatchSize must be a positive integer, got ' + String(batchSize));
    this.shutdownTimeoutMillis = shutdownTimeoutMillis;

    const projectName = (typeof config.projectName === 'string' && config.projectName.trim()) || undefined;
    const resourceAttrs = {
      'service.name': (APP_IDENTITY && APP_IDENTITY.product) || 'deepseek-harness',
      'service.version': (APP_IDENTITY && APP_IDENTITY.version) || 'unknown',
      'user.id': safeUserId(ctx),
    };
    if (projectName) resourceAttrs['openinference.project.name'] = projectName;
    const headers = Object.assign({}, config.headers);
    if (projectName && headers['x-project-name'] === undefined) headers['x-project-name'] = projectName;

    const exporter = new OTLPTraceExporter(Object.assign({}, config.exporter, { url: endpoint, headers: headers }));
    this.provider = new BasicTracerProvider({
      resource: resourceFromAttributes(resourceAttrs),
      spanProcessors: [new BatchSpanProcessor(exporter, Object.assign({}, config.processor))],
    });
    this.projector = new SpanProjector(this.provider.getTracer(PROJECTOR_SCOPE, version), {
      captureContent: config.captureContent,
      captureReasoning: config.captureReasoning,
      maxContentChars: config.maxContentChars,
      warn: function (message) { ctx.logger.warn(message); },
    });

    const enqueue = (record) => { this.projector.onRecord(record); };
    const sink = {
      emit: enqueue,
      flush: () => this.flush(),
      shutdown: () => this.shutdown(),
    };

    if (mode === 'FULL') {
      this._emit = enqueue;
      new SessionTelemetryCoordinator(ctx, sink, 'live');
      return;
    }

    // FEEDBACK_ONLY: capture is replayed on demand at the feedback edge.
    this._emit = DROP_RECORD;
    const coordinator = new SessionTelemetryCoordinator(ctx, sink, 'on-demand');
    ctx.on('session/event', function (session, event) {
      if (event.type !== 'feedback/record') return;
      if (session.eventAt(event.seq) !== event) {
        ctx.logger.warn(NON_CANONICAL_FEEDBACK_WARNING);
        return;
      }
      coordinator.captureSession(session, event.seq);
      // The replay suffix ends at the feedback event; close spans the suffix
      // left open so the batch exports, keeping containers for a later pass.
      this.projector.settleSession(String(session.id), event.time, { keepState: true });
    }.bind(this));
  }

  /**
   * Hand a direct service record to the projector only in FULL; feedback
   * replay uses the coordinator's private path. See the seam contract.
   */
  emit(record) {
    this._emit(record);
  }

  /**
   * Fire-and-forget drain hint after a turn ends. Force-flushes are serialized
   * on one chain so the final shutdown drain orders behind them (the seam's
   * flush/shutdown ordering requirement).
   */
  flush() {
    if (!this.provider) return;
    const provider = this.provider;
    this._drain = this._drain.then(function () {
      return provider.forceFlush();
    }).catch(function () { /* best-effort: the batch processor retries on its own cadence */ });
  }

  /**
   * Drain and shut the SDK down, rejecting after the backend-owned deadline.
   * Mirrors the log backend: the provider promise stays observed after the
   * deadline so a late rejection cannot become unhandled.
   */
  async shutdown() {
    if (!this.provider) return;
    const provider = this.provider;
    const providerShutdown = this._drain.then(function () {
      return provider.shutdown();
    });
    let timer;
    const deadline = new Promise(function (_resolve, reject) {
      timer = setTimeout(function () {
        reject(new Error('phoenix-tracing: provider shutdown exceeded ' + this.shutdownTimeoutMillis + 'ms'));
      }.bind(this), this.shutdownTimeoutMillis);
    }.bind(this));
    try {
      await Promise.race([providerShutdown, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      providerShutdown.catch(function () { /* already past the deadline */ });
    }
    if (this.projector) this.projector.closeAll();
  }
}

/** Anonymous user id, contained: identity plumbing must never fail plugin load. */
function safeUserId(ctx) {
  try {
    return getOrCreateAnonymousUserId();
  } catch (error) {
    ctx.logger.warn('phoenix-tracing: anonymous user id unavailable: ' + String(error));
    return undefined;
  }
}

export default PhoenixSessionBackend;
