import { describe, expect, it } from "bun:test"
import path from "node:path"

/**
 * EOT-13's "OTLP smoke against a local collector", and the reason it is worth
 * the cost of a subprocess.
 *
 * `src/observability/otlp.ts` reads `OTEL_EXPORTER_OTLP_ENDPOINT` once, at
 * module load, and decides `enabled` and `layer` from it — `otlp.test.ts` says
 * so in its own header. Setting the variable inside a test cannot move that, so
 * the export path can only be exercised by a process that starts with the
 * endpoint already in its environment.
 *
 * What that bought, the first time it ran: the exporter was shipping span
 * attributes **unredacted**. `sanitizeSpanAttributes` was applied inside
 * `buildRecord`, which builds the record for the live panel, while the OTLP
 * exporter serialises `span.attributes` itself — so the panel was clean and the
 * wire was not, under a comment claiming both paths were covered. A structural
 * gate could not see it: `otlp.ts` did contain the call.
 */

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..")
const EMITTER = path.join(PACKAGE_ROOT, "script", "otlp-smoke-emit.ts")

type Exported = {
  resourceSpans?: {
    scopeSpans?: { spans?: { name: string; attributes?: { key: string; value: { stringValue?: string } }[] }[] }[]
  }[]
}

/** Run the emitter against a throwaway collector and hand back what it posted. */
async function collect(): Promise<{ status: number; payloads: Exported[]; raw: string }> {
  const payloads: Exported[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      payloads.push((await request.json().catch(() => ({}))) as Exported)
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
  })
  try {
    const proc = Bun.spawn(["bun", "run", EMITTER], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${server.port}`,
        NIKCLI_TEST_MODE: "1",
      },
      stdout: "ignore",
      stderr: "ignore",
    })
    const status = await proc.exited
    // The exporter posts as the runtime's scope closes, which lands just after
    // the process reports its exit.
    for (let i = 0; i < 40 && payloads.length === 0; i++) await Bun.sleep(25)
    return { status, payloads, raw: JSON.stringify(payloads) }
  } finally {
    server.stop(true)
  }
}

describe("OTLP export smoke (EOT-13)", () => {
  it("exports the span, with every forbidden key dropped and every value redacted", async () => {
    const { status, payloads, raw } = await collect()
    expect(status).toBe(0)
    expect(payloads.length).toBeGreaterThan(0)

    const spans = payloads.flatMap(
      (p) => p.resourceSpans?.flatMap((rs) => rs.scopeSpans?.flatMap((ss) => ss.spans ?? []) ?? []) ?? [],
    )
    const span = spans.find((s) => s.name === "otlp.smoke")
    expect(span).toBeDefined()

    const attributes = Object.fromEntries((span!.attributes ?? []).map((a) => [a.key, a.value?.stringValue]))

    // Allowed keys survive — a redactor that drops everything is not a pass.
    expect(attributes["service.name"]).toBe("nikcli.smoke")
    expect(attributes["event.class"]).toBe("smoke.span")

    // Forbidden keys are removed, not emptied: the key itself is the half the
    // forbidden list is about, and `[REDACTED]` would still announce it.
    expect(attributes).not.toHaveProperty("user.token")
    expect(attributes).not.toHaveProperty("authToken")

    // A credential in a value is redacted while the value stays useful.
    expect(attributes["http.route"]).toBe("postgres://svc:[REDACTED]@db.internal/app")

    // And nothing secret survives anywhere in the payload, including places
    // this test does not model — resource attributes, scope, status message.
    expect(raw).not.toContain("nku_")
    expect(raw).not.toContain("hunter2")
  }, 60_000)
})
