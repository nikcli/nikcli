# EOT-13: Observability Pipeline and Tracing

Status: proposed. Tier: 1. Phase: P1. Dependencies: EOT-01, EOT-02.
Owner: observability, brain, profile, and HTTP server maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B26, B27, B28 in the [register](../README.md): `packages/nikcli/src/observability/otlp.ts` already exports an
Effect runtime layer that captures spans in-process for the TUI panel and exports to OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT`
is set; the `telemetry-bus` records `TelemetryRecord`s; `brain/` runs a scheduler; `profile/` reports per-process profile
counters. But the **end-to-end** tracing contract — span boundaries, attribute schema, resource attributes, sampling,
correlation across provider/SDK/SSE/TUI, and redaction — is not unified. Spans exist where Effect services run, but the
TUI side has no first-class trace id, the AI SDK route emits none, the HTTP request boundary spans differ across middleware,
and metric/log dimensions are not coordinated. A spec is needed to make observability a first-class architectural seam, not
a side effect of "merge the OTLP layer into the runtime".

## Scope and Non-Goals

Define the canonical tracing, metrics, and logging contract across the nikcli server, TUI, SDK clients, and provider
adapters. Preserve the existing `Observability.layer`, `liveEnabled`, and `enabled` exports; preserve the existing
`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_RESOURCE_ATTRIBUTES` flags. Do not introduce a new telemetry backend, require
external infrastructure, change the default privacy posture, or expand the high-cardinality dimensions beyond what the
current redacted sink already permits. Do not turn the live TUI panel off by default.

## Design and Requirements

1. Spans are an Effect `Tracer` concern. `Observability.layer` is the canonical runtime merge point: every service's
   `Context.Service` composition includes it. Spans are opened with explicit names (`httpapi.<group>.<endpoint>`,
   `session.<id>.turn`, `tool.<name>.run`, `llm.<provider>.<model>.stream`, `auth.<flow>.transition`,
   `effect.<service>.<op>`). Names are stable, lower-cased, dotted; renames are documented in the catalog.
2. Every HTTP route handler emits a server-side span; the SDK client correlates it through `traceparent`. Every
   `LLMClient.stream` span carries the parent from the originating request, so SSE-delivered events can be tied back to
   the user's prompt. The AI SDK adapter bridges span attributes from the provider's response headers where present.
3. Span attributes follow a fixed schema. Allowed dimensions: `service.name`, `service.version`, `service.channel`,
   `os.platform`, `host.mode` (`cli`/`worker`/`http`/`standalone`), `http.method`, `http.route`, `http.status_code`,
   `provider.id`, `provider.model`, `provider.route`, `session.id`, `workspace.id`, `event.class`, `error.kind`,
   `error.category`. Forbidden dimensions include raw prompts, completions, file paths, URLs with credentials, tokens,
   OAuth codes, PKCE verifiers, emails, account ids, IP addresses, and request bodies. Prompts may only appear as a
   stable hash and a length bucket (e.g. `prompt.length_bucket`).
4. Metrics use `Metrics.Counter`, `Metrics.Histogram`, `Metrics.Gauge` against the same Effect runtime. Allowed metrics:
   `nikcli.session.turn.duration`, `nikcli.llm.stream.duration`, `nikcli.llm.first_token_ms`, `nikcli.llm.tokens.in`,
   `nikcli.llm.tokens.out`, `nikcli.httpapi.request.duration`, `nikcli.httpapi.request.error`,
   `nikcli.event.queue.depth`, `nikcli.event.queue.bytes`, `nikcli.cache.hit`, `nikcli.cache.miss`,
   `nikcli.job.duration`, `nikcli.plugin.generation`, `nikcli.renderer.frame.duration`, `nikcli.dialog.open.duration`.
   Each metric uses fixed-cardinality labels from the schema above; histograms use the Effect default buckets, not custom
   high-cardinality ones.
5. Sampling is a single policy: head sampling at 100% in dev, parent-based + ratio-based in production, with overrides per
   operation class (always-on: errors, auth, provider; sampled: chat completions). The default is **not** to sample
   errors away; `nikcli.error` events are recorded unconditionally.
6. Logs flow through `Log` with structured JSON output and redacted sinks (`safeStringify`, `redactUrl`). Spans correlate
   to logs through `trace_id`/`span_id` injected as log attributes. TUI-visible error formatting goes through
   `formatStack` and honors `NIKCLI_DEBUG`. Spans that overflow the redacted budget are dropped, not truncated to look
   safe.
7. The live TUI panel reads from `telemetry-bus.ts` and shows live span completion, queue depth, and per-route error
   counts. The panel is rate-limited (one update per 250 ms) and bounded to the most recent N entries; it never freezes
   the TUI thread, and never leaks raw span attributes to the screen.
8. `brain/scheduler.ts` exposes a typed schedule registry for background telemetry tasks (cache flush, profile snapshots,
   counter rollup). Schedules use `Schedule.exponential`, `Schedule.jittered`, `Schedule.recurs` and respect the
   `Cancellation`/`Interrupt` chain. A scheduled task that has not finished its previous run does not start a new one.
9. The OTLP exporter is a thin adapter over `effect/unstable/observability`; replacing it (Datadog, Honeycomb, Tempo) is an
   adapter swap, not a refactor. The exporter must respect the same redaction rules; no plaintext prompt leakage at any
   layer.
10. Privacy posture: opt-in only for remote export, default-on for in-process live capture. `NIKCLI_DISABLE_OTEL_LIVE=1`
    disables the live panel. There is no flag that turns **off** redaction; redaction is not a configurable option.

## Telemetry Topology

```text
Effect services + HTTP handlers + AI SDK adapter
  -> Effect Tracer + Effect Metrics
  -> Observability.layer (single merge point in runtime)
  -> in-process TelemetryRecord -> telemetry-bus -> TUI live panel
  -> OtlpExporter -> OTLP_ENDPOINT (opt-in)
```

## Failure and Cancellation

A telemetry export failure (OTLP down, network error, schema mismatch) is recorded as a typed metric (`nikcli.otel.error`)
and never raises into the application's hot path. The in-process live panel keeps working independently of the OTLP
exporter. Cancellation of a span owner closes the span on `Exit`; a finalizer failure is logged through the redacted sink,
not raised into the application. The live panel cannot block the input thread: a stuck panel is bounded by the rate
limit, not by user input latency.

## Acceptance and Verification

- A recorded workload produces the expected spans, metrics, and logs in order; trace ids are stable across provider → SDK →
  SSE → TUI hops; the live panel renders the same trace tree the exporter would. Spans carry only allowed attributes.
- High-cardinality probe: a synthetic request with session id cardinality in the millions does not blow up span volume;
  forbidden dimensions (prompt, token, path, URL with credentials) are absent from both the live panel and the exported
  data.
- OTLP exporter failure does not affect user-perceived request latency or correctness; the live panel keeps updating.
- Schedule correctness: the same scheduled task never runs concurrently; cancellation stops the next run; backoff and
  jitter are exercised in tests; finalizers run on every exit class.
- Redaction: a fixture with fake secrets, tokens, and URLs is exported/recorded; no secret appears in the export payload,
  the live panel, or the structured log.
- Extend `packages/nikcli/test/observability/`, `packages/nikcli/test/bus/`, `packages/nikcli/test/server/event-feed.test.ts`,
  `packages/nikcli/test/server/event-visibility.test.ts`, and existing telemetry tests. Add a redaction fuzz test that
  feeds known secret shapes and asserts no leak.
- From `packages/nikcli`: `bun test test/observability/ test/bus/ test/server/event-feed.test.ts`. With the OTLP endpoint
  set, run the recorded workload against a local OTLP collector and verify the schema. One final root
  `bun run typecheck` after the slice.
- Meet EOT-01 budgets: instrumentation overhead median within the approved 5%; telemetry export failures do not increase
  p95 request latency above baseline.

## Migration and Rollback

Phase the rollout. First, lock the attribute schema and add span coverage to one route group (start with `session`); then
extend to other groups. Verify each group's spans match the schema and redaction tests before enabling the OTLP exporter
on the next group. Roll back a route group behind a per-group span toggle (default-on), never by disabling redaction or
shrinking the live panel. Removal of the legacy inline logger is the last step and only after every route has the new
span coverage. A rolled-back group keeps its redaction and metric coverage even if spans are temporarily disabled.

## Discipline Addendum — 2026-09-20

`script/check-observability-schema.ts` is in CI and `src/observability/telemetry-consumer.ts` is the reference consumer (commit `644a8f28`).

1. **A span only exists if it runs on a runtime that has the layer.** `effect/runtime.ts:makeRuntime` merges `Observability.layer` into every base it builds, so `Effect.withSpan` reaches both the OTLP exporter and the live panel — but only for effects run through `AppRuntime` or `runtimeFor`. A bare `Effect.runPromise` uses Effect's default runtime, whose tracer discards the span silently: the allocation is paid and nothing is reported. The brain scheduler's per-tick span (`src/brain/scheduler.ts`) shipped on `Effect.runPromise` and reported nothing until it moved to `AppRuntime`. It remains the only `withSpan` in `src`, so the rule has no second example to learn from yet.
2. **The schema gate is structural, and that is the point.** It asserts the spec's forbidden segments and required allowed attributes are present in `span-schema.ts`, and that `otlp.ts` still calls `sanitizeSpanAttributes` — the single redaction choke point. It reads source and imports nothing, so it costs no build and cannot be defeated by a refactor that keeps the code compiling.
3. **The live-panel consumer throttles on the producer's clock.** `createTelemetryConsumer` coalesces on `frame.startTime`, not on arrival time. A span's start time is what the panel displays, and reading it makes the consumer a pure function of its input: the same frames coalesce the same way live or replayed from a capture, and no test has to control the wall clock. `push` is synchronous and O(1) so a producer in a tight loop cannot block the input thread — the invariant the bounded window exists to protect.

## Redaction Fuzz — 2026-09-20

The release gate asks for redaction fuzz. It did not exist, and writing it found four holes
in the choke point — three on the key side, one on the value side. None of them needed a
clever input; all four are spellings a normal contributor would produce.

1. **camelCase keys walked past the entire forbidden list.** `splitKeySegments` split on
   `[._\-/]` only, so `authToken` was one unrecognised segment `authtoken`. So were
   `sessionPassword`, `bearerToken` and `accessToken`. camelCase is this codebase's dominant
   convention, which made it the _likeliest_ spelling for a new attribute rather than an
   exotic one. `apiKey` was blocked only by the coincidence that `apikey` is itself a listed
   segment.
2. **Separators outside the character class.** `auth:token`, `auth token` and `auth|token`
   were each a single segment for the same reason.
3. **A URL's userinfo was not redacted.** `URL_CREDENTIAL_RE` covered the query string, so
   `?token=…` was handled while `postgres://user:hunter2@host/db` — and any git remote
   carrying a token — travelled verbatim into spans and logs. The forbidden-dimension list
   in `README.md` names "URLs with credentials" explicitly; this was the half that was
   missing.
4. **A credential glued to a word character escaped every pattern.** The token shapes were
   anchored with a leading `\b`, which requires a non-word character before the prefix, so
   a value ending `…somethingnku_AAAA` came back intact. The anchors are gone from the
   prefixed formats: `sk-`, `ghp_`, `xoxb-`, `nku_`, `eyJ` are each their own signal and
   nobody writes `xnku_` in prose. `BEARER_RE` keeps its anchor for the opposite reason —
   "Bearer" is an ordinary English word, and a rule that only measured length redacted the
   next word in "Bearer authentication failed".

`test/observability/redaction-fuzz.test.ts` enumerates the spellings rather than random
bytes, because spelling is where the holes were: 13 forbidden words × 5 prefixes × 12
spellings on the key side, and 9 credential shapes each wrapped in three contexts on the
value side.

Two of its cases exist to stop the obvious over-correction. A sanitizer that drops
everything passes a "nothing escaped" test and is useless, so the allowed schema is asserted
to survive; and whole-word matching is asserted to leave `tokenizer.name` and `queue.depth`
alone. Redaction happening _before_ truncation is pinned too — slicing to the budget first
would put the first 200 characters of a credential on screen and in the export.
