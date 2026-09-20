#!/usr/bin/env bun
/**
 * Emit one span through the real observability layer, then exit.
 *
 * The companion to `test/observability/otlp-smoke.test.ts`. It exists as a
 * separate process because `src/observability/otlp.ts` reads
 * `OTEL_EXPORTER_OTLP_ENDPOINT` once, at module load, and decides `enabled` and
 * `layer` from it. Setting the variable inside a test cannot move that — the
 * existing `otlp.test.ts` says so in its own header — so the only honest way to
 * exercise the export path is to start a process with the endpoint already in
 * its environment.
 *
 * The span deliberately carries a forbidden key and a credential-shaped value.
 * What the collector receives is the proof that redaction survives the whole
 * path, not just a unit call to `sanitizeSpanAttributes`.
 */
import { Effect } from "effect"
import { AppRuntime } from "@/effect/runtime"

await AppRuntime.runPromise(
  Effect.void.pipe(
    Effect.withSpan("otlp.smoke", {
      attributes: {
        "service.name": "nikcli.smoke",
        "event.class": "smoke.span",
        // Dropped by the key rule, in both its punctuated and camelCase forms.
        "user.token": "nku_smokesmokesmokesmoke1234",
        authToken: "nku_camelcamelcamelcamel5678",
        // Kept as a key, redacted as a value.
        "http.route": "postgres://svc:hunter2@db.internal/app",
      },
    }),
  ),
)

// Disposing the runtime closes the exporter's scope, which is what flushes.
await AppRuntime.dispose()
process.exit(0)
