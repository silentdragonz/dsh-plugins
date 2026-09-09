# dsh-phoenix-tracing

Arize [Phoenix](https://phoenix.arize.com) tracing backend for the DeepSeek
Harness (DSH).

The shipped OTLP backend (`@deepseek-ai/dsh-session-telemetry-otel`) maps the
harness telemetry seam onto OTLP **logs**. Phoenix is built around **traces**:
this plugin mounts the same telemetry seam but rebuilds the hierarchy the
session records imply and renders it as proper OpenTelemetry spans following
[OpenInference](https://github.com/Arize-ai/openinference) conventions - the
same vocabulary
[Arize's coding-harness-tracing](https://github.com/Arize-ai/coding-harness-tracing)
uses for Claude Code, OpenCode, and friends - then exports them over OTLP/HTTP.

## What you get in Phoenix

One trace per harness turn, grouped into a conversation thread by
`session.id`:

```text
Turn {n} / first user prompt          CHAIN   input.value, output.value, end reason
  Step {t}.{s}                        CHAIN   one agent-loop iteration
    LLM call {model}                  LLM     provider, token accounting,
                                              output/input messages, time-to-first-token
      {tool}                          TOOL    tool.name, tool.call.id, input/output value,
                                              tool.command / tool.file_path / tool.query
```

Additional details:

- **Token accounting** follows the seam's usage: prompt = input + cache-read +
  cache-write tokens; reasoning tokens land in
  `llm.token_count.completion_details.reasoning`.
- **Errors**: failed tool results and error turn-ends set OTel ERROR status;
  `agent/error` bus relays attach an `exception` span event.
- **Feedback** (`feedback/record`) attaches to the turn span as a
  `session.feedback` span event - pair it with Phoenix evaluations.
- **Healing**: spans whose opening or closing bracket never arrived (adoption
  mid-turn, replay past the handoff cursor, crash gaps) are synthesized and
  marked `dsh.incomplete=true` - the trace never silently loses a container.

## Quick start

1. Start Phoenix (Docker):

   ```bash
   docker run -p 6006:6006 arizephoenix/phoenix:latest
   ```

2. Install this plugin into the profile the GUI uses (the `dsh plugin` CLI
   adds the dependency and the bundle entry):

   ```bash
   dsh plugin --profile web add file:/workspace/workspace/tmp/dsh-phoenix-tracing
   ```

3. Point it at Phoenix - either set the environment before launching DSH:

   ```bash
   DSH_PHOENIX_MODE=FULL DSH_PHOENIX_URL=http://localhost:6006/v1/traces DSH_PHOENIX_PROJECT=my-project dsh web
   ```

   or override the mount in the profile's `cordis.patch.yml`:

   ```yaml
   - id: phoenix-tracing
     config:
       mode: FULL
       endpoint: http://localhost:6006/v1/traces
       projectName: my-project
   ```

4. Chat, then open Phoenix (default `http://localhost:6006`) and pick the
   project - sessions appear in the Sessions view, one trace per turn.

For Phoenix Cloud, use the hosted endpoint and an auth header:

```yaml
- id: phoenix-tracing
  config:
    endpoint: https://app.phoenix.arize.com/v1/traces
    headers:
      api_key: your-phoenix-api-key
    projectName: my-project
```

## How it works

The harness telemetry seam (`@deepseek-ai/dsh-session-telemetry`) hands one
backend implementation per context a firehose of logical records - one per
session-log event plus two operational records (`agent-error`, `shutdown`),
after the `session-telemetry/record` redaction waterfall. This plugin:

- composes `SessionTelemetryCoordinator` in `live` or `on-demand` mode
  exactly like the OTLP log backend, so every capture semantic (chunk
  projection, redaction, handoff cursors, disposal) is shared, not duplicated;
- projects the records onto spans with a private `BasicTracerProvider` +
  `BatchSpanProcessor` + `OTLPTraceExporter` from
  `@opentelemetry/exporter-trace-otlp-proto` - OTLP/HTTP with protobuf
  serialization, which self-hosted Phoenix requires (its collector rejects
  `application/json` with HTTP 415). No global registration, no interference
  with anything else using OTel in-process;
- flushes on the seam's turn-end hints and drains within
  `shutdownTimeoutMillis` at teardown.

Because the seam admits one backend per context, the bundle patch disables the
`session-telemetry-otel` row: loading both would throw on the duplicate
`sessionTelemetry` service.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `DISABLED` (schema) / `FULL` (bundle patch) | `FULL`: project live. `FEEDBACK_ONLY`: replay the canonical session log through the projector when a feedback event arrives. `DISABLED`: no SDK state; feedback warns that sharing is off. |
| `endpoint` | `http://localhost:6006/v1/traces` | Full OTLP traces URL. A Phoenix base URL (path `/`, `/v1` or empty) gains `/v1/traces`. |
| `headers` | - | Extra exporter headers (e.g. `api_key` for Phoenix Cloud). `x-project-name` is added automatically from `projectName`. |
| `projectName` | bundle patch: `deepseek-harness` | Phoenix project: sets the `x-project-name` header and the `openinference.project.name` resource attribute. |
| `captureContent` | `true` | Gate prompt/completion/tool text (`input.value`, `output.value`, `llm.input_messages`, `llm.output_messages`, tool arguments/results) and the prompt-derived turn span name. Set `false` for ids/metrics only. |
| `captureReasoning` | `false` | Additionally fold reasoning text into rendered assistant text (implies content capture). |
| `maxContentChars` | `32768` | Bound on every long string attribute; overflow is truncated with a marker. |
| `exporter` | - | Passed verbatim to `OTLPTraceExporter` (`timeoutMillis`, `retries`, ...). |
| `processor` | - | Passed verbatim to `BatchSpanProcessor` (`scheduledDelayMillis`, `maxExportBatchSize`, ...). |
| `shutdownTimeoutMillis` | `3000` | Outer bound on the shutdown drain. |

Bundle-patch environment knobs: `DSH_PHOENIX_MODE`, `DSH_PHOENIX_URL`,
`DSH_PHOENIX_PROJECT`.

## Event-to-span mapping

| Seam record | Span effect |
| --- | --- |
| `turn/start` / `turn/end` | `Turn {n}` CHAIN root (renamed to the first user prompt when content capture is on); `input.value`/`output.value`; OTel status from the end reason |
| `step/start` / `step/end` | `Step {t}.{s}` CHAIN under the turn |
| `assistant/chunk` (first per step) | `dsh.llm.time_to_first_token_ms` on the step's LLM span |
| `assistant/message` | `LLM call {model}` LLM span: `llm.provider`, `llm.model_name`, token counts incl. cache details, flattened tool-call output messages, the turn's user message as `llm.input_messages` |
| `tool/call` | TOOL span named after the tool: `tool.name`, `tool.call.id`, `input.value`, plus `tool.command` (bash), `tool.file_path` (read/write/edit), `tool.query` (grep/glob/web_search), `tool.url` (web_fetch) |
| `tool/result` | `output.value`, ERROR/OK status, `error.type` / `dsh.error.code` |
| `feedback/record` | `session.feedback` span event with `feedback.text` |
| `session/title` | `session.title` attribute on the session's turn spans |
| `request/header` | `dsh.request.model` / `dsh.request.provider` on the active turn |
| `llm/retry*`, `approval/*`, `compaction/*`, `goal/change`, `plan/mode`, ... | Dot-renamed span events with scalar attributes on the innermost live span |
| ops `agent-error` | `exception` span event + ERROR status on the owning turn |
| ops `shutdown` | Synthesizes ends for everything still open, marks them `dsh.incomplete` |

## Troubleshooting

- **No traces in Phoenix?** Restart the harness (`dsh web`) - plugins load at
  startup, so an install or update is not picked up by a running server.
- **Export failures are logged, not silent.** OTel SDK diagnostics are bridged
  into the harness logger: look for `[phoenix-tracing]` lines (e.g. `415
  Unsupported content type`, `ECONNREFUSED`, timeouts) in the server output.
  The exporter retries transient failures; permanent ones drop the batch with
  a logged error.
- **HTTP 415 from the endpoint** means the collector does not accept the wire
  format. This plugin always sends `application/x-protobuf`; older plugin
  copies using `@opentelemetry/exporter-trace-otlp-http` in this workspace
  emitted JSON, which self-hosted Phoenix rejects. Re-install/update.
- **Self-check against a live Phoenix** (no harness restart needed):

  ```bash
  cd <plugin dir>
  node tools-loop.mjs http://192.168.1.195:6006/v1/traces \
    http://192.168.1.195:6006/graphql dsh
  ```

  It exports a marker span through the production stack and polls the Phoenix
  GraphQL API until the span is visible - `LOOP GREEN` proves the endpoint,
  wire format, and project routing work from this machine.

## Development

```bash
npm install
npm test   # projector unit tests, backend integration tests, OTLP wire test
```

The wire test points the production export stack at a local HTTP sink and
asserts the OTLP/HTTP transport contract (protobuf content type, project
header, payload carrying the span tree and OpenInference attributes) - no
Phoenix instance needed. `tools-loop.mjs` covers the live end-to-end case
against a real Phoenix.
