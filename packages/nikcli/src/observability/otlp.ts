import { Cause, Effect, Exit, Layer, Logger, Option, Tracer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpExporter, OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { Flag } from "@nikcli-ai/util/flag"
import { TelemetryRecord } from "./telemetry-bus"
import { sanitizeSpanAttributes } from "./span-schema"
import { redactString } from "@nikcli-ai/util/redact"

// Build version/channel from the globals injected at compile time, mirroring
// Installation.VERSION/CHANNEL. Read directly (rather than importing
// Installation) to keep this module free of the bus/effect import cycle, so it
// can be merged into the Effect runtime base.
const version = typeof NIKCLI_VERSION === "string" ? NIKCLI_VERSION : "local"
const channel = typeof NIKCLI_CHANNEL === "string" ? NIKCLI_CHANNEL : "local"

const endpoint = Flag.OTEL_EXPORTER_OTLP_ENDPOINT

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS
  ? Flag.OTEL_EXPORTER_OTLP_HEADERS.split(",").reduce(
      (acc, entry) => {
        const [key, ...value] = entry.split("=")
        acc[key] = value.join("=")
        return acc
      },
      {} as Record<string, string>,
    )
  : undefined

// Live in-process span capture (streamed to the TUI panel) is on by default.
const live = !Flag.NIKCLI_DISABLE_OTEL_LIVE
// Whether anything observability-related is active at all.
const active = Boolean(endpoint) || live

export const enabled = Boolean(endpoint)
export const liveEnabled = live

function resourceAttributes(): Record<string, string> {
  const value = process.env["OTEL_RESOURCE_ATTRIBUTES"]
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(runID: string): {
  serviceName: string
  serviceVersion: string
  attributes: Record<string, string>
} {
  // Opencode #25841: don't overwrite fundamental OTEL env vars. Service name
  // and resource attributes set by the operator/jaeger must win over nikcli
  // defaults. Deployment environment name falls back to the build channel
  // only when the operator did not set it explicitly.
  const env = process.env
  const userResource = resourceAttributes()
  return {
    serviceName: env["OTEL_SERVICE_NAME"] ?? "nikcli",
    serviceVersion: version,
    attributes: {
      ...userResource,
      "deployment.environment.name": userResource["deployment.environment.name"] ?? channel,
      "nikcli.client": Flag.NIKCLI_CLIENT,
      "nikcli.run": runID,
      "service.instance.id": runID,
    },
  }
}

// Publish to the event bus, imported lazily so this module never statically
// depends on bus → effect/runtime (which would form an import cycle, since the
// runtime merges this layer in).
let busPublish: ((record: TelemetryRecord) => void) | undefined
async function getPublish(): Promise<(record: TelemetryRecord) => void> {
  if (!busPublish) {
    const { Bus } = await import("@/bus")
    busPublish = (record) => void Bus.publish(TelemetryRecord, record)
  }
  return busPublish
}

function stringifyAttributes(input: Iterable<readonly [string, unknown]>): Record<string, string> | undefined {
  // Idempotent by the time it runs on an exported span: `sanitizeSpanInPlace`
  // has already cleaned the map. It still runs for the bus-only tracer, which
  // has no exporter to sanitize for.
  return sanitizeSpanAttributes(input).attributes
}

/**
 * A failure cause, redacted, then truncated.
 *
 * `Cause.pretty` renders whatever the error carried — and error messages are
 * where absolute paths, request URLs and the occasional bearer token end up.
 * Span *attributes* were already sanitized at the choke point above; this field
 * went to the live panel and the OTLP exporter raw, which made the redaction
 * policy true of one field on the record and not the other.
 *
 * Redact before truncating: slicing first can cut a credential in half and
 * leave the prefix, which no longer matches the pattern that would have removed
 * it. The same order `Log` uses. `specs/effect-tui/13-observability-pipeline.md`.
 */
function statusMessageOf(cause: Cause.Cause<unknown>): string {
  return redactString(Cause.pretty(cause)).slice(0, 200)
}

function buildRecord(args: {
  id: string
  traceId: string
  parentId?: string
  name: string
  kind: string
  startTime: bigint
  endTime: bigint
  exit: Exit.Exit<unknown, unknown>
  attributes: Iterable<readonly [string, unknown]>
}): TelemetryRecord {
  return {
    id: args.id,
    traceId: args.traceId,
    parentId: args.parentId,
    name: args.name,
    kind: args.kind,
    startTime: Number(args.startTime / 1_000_000n),
    durationMs: Number(args.endTime - args.startTime) / 1e6,
    statusCode: Exit.isFailure(args.exit) ? 2 : 1,
    statusMessage: Exit.isFailure(args.exit) ? statusMessageOf(args.exit.cause) : undefined,
    attributes: stringifyAttributes(args.attributes),
  }
}

function publish(record: TelemetryRecord) {
  void getPublish().then((fn) => fn(record))
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("")
}

// Pure-Effect tracer that publishes each finished span to the bus. No external
// dependency, so it is robust under bundling (unlike the OpenTelemetry Node SDK,
// whose CJS getter exports do not survive ESM interop in the packaged binary).
function makeBusTracer(): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const parent = Option.getOrUndefined(options.parent)
      const traceId = parent && "traceId" in parent ? parent.traceId : randomHex(16)
      const attributes = new Map<string, unknown>()
      const span = {
        _tag: "Span" as const,
        name: options.name,
        spanId: randomHex(8),
        traceId,
        parent: options.parent,
        annotations: options.annotations,
        status: { _tag: "Started" as const, startTime: options.startTime },
        attributes,
        links: options.links,
        sampled: options.sampled,
        kind: options.kind,
        end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
          publish(
            buildRecord({
              id: span.spanId,
              traceId: span.traceId,
              parentId: parent?.spanId,
              name: span.name,
              kind: String(options.kind),
              startTime: options.startTime,
              endTime,
              exit,
              attributes,
            }),
          )
        },
        attribute(key: string, value: unknown) {
          attributes.set(key, value)
        },
        event() {},
        addLinks() {},
      }
      return span as unknown as Tracer.Span
    },
  })
}

// Wraps a real (OTLP-exporting) tracer so spans are both exported and streamed to
// the bus for the live panel.
/**
 * Sanitize the span's own attribute map, in place, before anything reads it.
 *
 * This is the half the choke point was missing. `stringifyAttributes` ran
 * inside `buildRecord`, which builds the record for the live panel — so the
 * panel was clean and **the OTLP exporter was not**. It serialises
 * `span.attributes` itself, and an end-to-end smoke against a local collector
 * showed `user.token` and a `nku_` value going out over the wire verbatim,
 * under a comment claiming both paths were covered.
 *
 * Mutating the map is what makes one pass cover both readers: the record below
 * is built from the same already-sanitized attributes, and the exporter sees
 * exactly what the panel does. Dropped keys are removed rather than emptied —
 * an attribute whose value is `[REDACTED]` still tells a reader the key was
 * present, and the key is the half the forbidden list is about.
 */
function sanitizeSpanInPlace(span: Tracer.Span) {
  const attributes = span.attributes as Map<string, unknown>
  if (!(attributes instanceof Map) || attributes.size === 0) return
  const safe = sanitizeSpanAttributes(attributes.entries()).attributes ?? {}
  attributes.clear()
  for (const [key, value] of Object.entries(safe)) attributes.set(key, value)
}

/**
 * `publishToBus` is what the live panel needs; the sanitizing is what the
 * exporter needs. They are separate because the live panel can be turned off
 * (`NIKCLI_DISABLE_OTEL_LIVE`) and the redaction cannot — wrapping only when
 * live was on meant an export-only configuration shipped raw attributes.
 */
function wrapTracer(base: Tracer.Tracer, publishToBus: boolean): Tracer.Tracer {
  return Tracer.make({
    context: base.context,
    span(options) {
      const span = base.span(options)
      const realEnd = span.end.bind(span)
      ;(span as { end: Tracer.Span["end"] }).end = (endTime, exit) => {
        // Before `realEnd`, which is what hands the span to the exporter.
        sanitizeSpanInPlace(span)
        realEnd(endTime, exit)
        if (!publishToBus) return
        const parent = Option.getOrUndefined(options.parent)
        publish(
          buildRecord({
            id: span.spanId,
            traceId: span.traceId,
            parentId: parent?.spanId,
            name: span.name,
            kind: String(options.kind),
            startTime: options.startTime,
            endTime,
            exit,
            attributes: span.attributes,
          }),
        )
      }
      return span
    },
  })
}

// Effect logs exported over OTLP. nikcli's primary logging is the custom `Log`
// namespace, so this only carries Effect-emitted logs (Effect.log*).
function loggers(runID: string) {
  if (!endpoint) return []
  return [
    OtlpLogger.make({
      url: `${endpoint}/v1/logs`,
      resource: resource(runID),
      headers,
    }),
  ]
}

// The active tracer: when an OTLP endpoint is set, Effect's native OtlpTracer
// (pure Effect — no @opentelemetry) exports spans, wrapped to also feed the live
// panel; otherwise a bus-only tracer for live capture.
function tracerLayer(runID: string): Layer.Layer<never, never, never> {
  return !active
    ? Layer.empty
    : endpoint
      ? Layer.unwrap(
          Effect.gen(function* () {
            const base = yield* OtlpTracer.make({
              url: `${endpoint}/v1/traces`,
              resource: resource(runID),
              headers,
            })
            // Always wrapped: the wrapper is the redaction, not just the live
            // feed. `live` only decides whether the bus also hears about it.
            return Layer.succeed(Tracer.Tracer, wrapTracer(base, live))
          }),
        ).pipe(
          Layer.provide(OtlpSerialization.layerJson),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(OtlpExporter.layerFlusher),
          Layer.orDie,
        )
      : Layer.succeed(Tracer.Tracer, makeBusTracer())
}

// Combined observability layer. Captures spans for the live TUI panel (default
// on) and exports traces/logs over OTLP when an endpoint is configured. No-op
// when nothing is active, so it can be merged into any runtime base unchanged.
//
// `specs/effect-tui/13-observability-pipeline.md` makes this the one merge
// point and fixes the span/metric/log schema and forbidden-dimension list on
// top of it. Redaction there is not a flag: there is no switch that turns it
// off, only the opt-in OTLP endpoint and the live-panel opt-out.
export const layer: Layer.Layer<never, never, never> = active
  ? Layer.unwrap(
      Effect.sync(() => {
        // Per-run correlation id, generated when the observability layer is
        // built rather than at module load. This keeps the module free of an
        // import-time global side effect (so the core can run in constrained
        // runtimes) and gives each runtime/isolate its own run id.
        const runID = crypto.randomUUID().slice(0, 8)
        const logs = endpoint
          ? Logger.layer(loggers(runID), { mergeWithExisting: true }).pipe(
              Layer.provide(OtlpSerialization.layerJson),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(OtlpExporter.layerFlusher),
              Layer.orDie,
            )
          : Layer.empty
        return Layer.mergeAll(logs, tracerLayer(runID))
      }),
    )
  : Layer.empty
