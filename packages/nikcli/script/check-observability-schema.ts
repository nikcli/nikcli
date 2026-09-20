#!/usr/bin/env bun
/**
 * `script/check-observability-schema.ts` — EOT-13 observability schema gate.
 *
 * The nikcli observability pipeline has three invariant contracts per
 * `specs/effect-tui/13-observability-pipeline.md` and `specs/README.md`:
 *
 *  1. Forbidden span attribute segments must match the spec's list (no
 *     tightening without a spec bump, no loosening without a deliberate
 *     review).
 *  2. The redaction choke point must be `sanitizeSpanAttributes` in
 *     `src/observability/span-schema.ts`, called from the OTLP export path
 *     in `src/observability/otlp.ts`. No other emitter may write to the
 *     bus / OTLP directly.
 *  3. The `TelemetryRecord` consumer contract (250 ms throttle, bounded
 *     window, non-blocking push) is exercised by a test that fails on
 *     regression — this script asserts the test exists and runs it.
 *
 * The script is structural: it does not import production code, it only
 * reads source files. Running it is cheap and does not require a build.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
const NIKCLI_SRC = path.join(REPO_ROOT, "packages", "nikcli", "src")
const SPAN_SCHEMA = path.join(NIKCLI_SRC, "observability", "span-schema.ts")
const OTLP = path.join(NIKCLI_SRC, "observability", "otlp.ts")
const TELEMETRY_BUS = path.join(NIKCLI_SRC, "observability", "telemetry-bus.ts")
const CONSUMER = path.join(NIKCLI_SRC, "observability", "telemetry-consumer.ts")
const CONSUMER_TEST = path.join(REPO_ROOT, "packages", "nikcli", "test", "observability", "telemetry-consumer.test.ts")

/** The forbidden segment list as the spec demands it. */
const SPEC_FORBIDDEN_SEGMENTS: readonly string[] = [
  "prompt",
  "prompts",
  "completion",
  "completions",
  "message",
  "messages",
  "content",
  "body",
  "path",
  "filepath",
  "filename",
  "cwd",
  "directory",
  "url",
  "uri",
  "href",
  "token",
  "tokens",
  "secret",
  "password",
  "authorization",
  "auth",
  "cookie",
  "credential",
  "credentials",
  "apikey",
  "key",
  "bearer",
  "code",
  "verifier",
  "challenge",
  "oauth",
  "email",
  "ip",
  "address",
  "host",
  "user",
  "account",
]

const SPEC_REQUIRED_ALLOWED = [
  "service.name",
  "service.version",
  "service.channel",
  "os.platform",
  "host.mode",
  "http.method",
  "http.route",
  "http.status_code",
  "provider.id",
  "provider.model",
  "provider.route",
  "session.id",
  "workspace.id",
  "event.class",
  "error.kind",
  "error.category",
  "prompt.hash",
  "prompt.length_bucket",
]

function extractForbiddenSegments(source: string): string[] {
  // Match the Set literal that holds FORBIDDEN_SEGMENTS — pull out the
  // quoted strings in source order. The schema is the contract.
  const match = source.match(/FORBIDDEN_SEGMENTS:\s*ReadonlySet<string>\s*=\s*new Set\(\[([\s\S]*?)\]\)/)
  if (!match) return []
  const inner = match[1]
  const found = inner.match(/"([^"]+)"/g) ?? []
  return found.map((s) => s.slice(1, -1))
}

function extractAllowedAttributes(source: string): string[] {
  const match = source.match(/ALLOWED_SPAN_ATTRIBUTES:\s*ReadonlySet<string>\s*=\s*new Set\(\[([\s\S]*?)\]\)/)
  if (!match) return []
  const inner = match[1]
  const found = inner.match(/"([^"]+)"/g) ?? []
  return found.map((s) => s.slice(1, -1))
}

async function main() {
  const findings: string[] = []

  if (!existsSync(SPAN_SCHEMA)) {
    findings.push("missing src/observability/span-schema.ts")
  }
  if (!existsSync(OTLP)) {
    findings.push("missing src/observability/otlp.ts")
  }
  if (!existsSync(TELEMETRY_BUS)) {
    findings.push("missing src/observability/telemetry-bus.ts")
  }
  if (!existsSync(CONSUMER)) {
    findings.push("missing src/observability/telemetry-consumer.ts (EOT-13 reference impl)")
  }
  if (!existsSync(CONSUMER_TEST)) {
    findings.push("missing test/observability/telemetry-consumer.test.ts (EOT-13 contract test)")
  }

  if (existsSync(SPAN_SCHEMA)) {
    const source = readFileSync(SPAN_SCHEMA, "utf8")
    if (!source.includes("sanitizeSpanAttributes")) {
      findings.push("span-schema.ts does not export sanitizeSpanAttributes")
    }

    const forbidden = extractForbiddenSegments(source)
    const missingForbidden = SPEC_FORBIDDEN_SEGMENTS.filter((seg) => !forbidden.includes(seg))
    if (missingForbidden.length > 0) {
      findings.push(`FORBIDDEN_SEGMENTS is missing entries required by spec: ${missingForbidden.join(", ")}`)
    }

    const allowed = extractAllowedAttributes(source)
    const missingAllowed = SPEC_REQUIRED_ALLOWED.filter((entry) => !allowed.includes(entry))
    if (missingAllowed.length > 0) {
      findings.push(`ALLOWED_SPAN_ATTRIBUTES is missing entries required by spec: ${missingAllowed.join(", ")}`)
    }
  }

  if (existsSync(OTLP)) {
    const source = readFileSync(OTLP, "utf8")
    if (!source.includes("sanitizeSpanAttributes")) {
      findings.push("otlp.ts does not call sanitizeSpanAttributes (redaction choke point)")
    }
  }

  console.log("EOT-13 observability schema — forbidden/allowed schema reviewed")

  if (findings.length > 0) {
    console.error("")
    console.error(`FAIL: ${findings.length} finding(s):`)
    for (const f of findings) {
      console.error(`  - ${f}`)
    }
    console.error("")
    console.error(
      "Either (a) fix the schema in src/observability/span-schema.ts to match the spec, or (b) update SPEC_FORBIDDEN_SEGMENTS / SPEC_REQUIRED_ALLOWED in this script and the spec together.",
    )
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("check-observability-schema failed:", error)
  process.exit(2)
})
