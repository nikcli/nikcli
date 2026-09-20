import { redactString } from "@nikcli-ai/util/redact"

/**
 * The span/metric attribute contract.
 *
 * Spans reach two places a secret must never appear: the live TUI panel, which
 * renders them on screen, and the OTLP exporter, which ships them off the
 * machine. Both go through `sanitizeSpanAttributes`, so the rule is enforced at
 * one choke point rather than at each emitter.
 *
 * Three tiers, in precedence order:
 *   1. `ALLOWED_SPAN_ATTRIBUTES` — the fixed, low-cardinality schema. Kept.
 *   2. A forbidden segment — dropped outright, key and value.
 *   3. Anything else — kept, with the value run through log redaction.
 *
 * Tier 3 exists because emitters predate this schema; tightening to a strict
 * allow-list would silently delete telemetry that is currently useful. Tier 2
 * is the half that cannot wait, and it is not configurable.
 */
export const ALLOWED_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set([
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
  // A prompt may appear only as a stable shape, never as text.
  "prompt.hash",
  "prompt.length_bucket",
])

/**
 * Key segments that carry user content or credentials. Matched per segment
 * (`file.path` is forbidden, `http.route` is not) so an innocent key is never
 * dropped because a forbidden word happens to be a substring of it.
 */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
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
])

const MAX_ATTRIBUTES = 32
const MAX_VALUE_CHARS = 200

/**
 * Break an attribute key into the words the forbidden list is written in.
 *
 * Two things this has to survive, both found by fuzzing the sanitizer rather
 * than by reading it:
 *
 *  - **camelCase.** Splitting only on punctuation made `userToken` a single
 *    segment, `usertoken`, which is in no list — so `authToken`,
 *    `sessionPassword`, `bearerToken` and `accessToken` all walked past the
 *    whole forbidden set. camelCase is the dominant convention in this
 *    codebase, which made it the likeliest spelling rather than an exotic one.
 *  - **separators outside the original class.** `auth:token`, `auth token` and
 *    `auth|token` were each one segment for the same reason.
 *
 * Splitting on a case boundary before lowercasing is what catches the first;
 * the wider character class catches the second.
 */
export function splitKeySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[._\-/:|\s]+/)
    .filter((part) => part.length > 0)
}

export function isForbiddenSpanAttribute(key: string): boolean {
  if (ALLOWED_SPAN_ATTRIBUTES.has(key)) return false
  return splitKeySegments(key).some((segment) => FORBIDDEN_SEGMENTS.has(segment))
}

/**
 * Prompt length as a coarse bucket. The exact character count of a prompt is
 * itself a weak fingerprint, so spans carry the bucket instead.
 */
export function promptLengthBucket(length: number): string {
  if (!Number.isFinite(length) || length < 0) return "unknown"
  if (length === 0) return "0"
  for (const edge of [64, 256, 1024, 4096, 16384, 65536]) {
    if (length < edge) return `<${edge}`
  }
  return ">=65536"
}

export type SanitizedSpanAttributes = {
  readonly attributes: Record<string, string> | undefined
  /** Keys removed because they carry content or credentials. */
  readonly dropped: readonly string[]
}

export function sanitizeSpanAttributes(input: Iterable<readonly [string, unknown]>): SanitizedSpanAttributes {
  const attributes: Record<string, string> = {}
  const dropped: string[] = []
  let kept = 0
  for (const [key, value] of input) {
    if (value === undefined || value === null) continue
    if (isForbiddenSpanAttribute(key)) {
      dropped.push(key)
      continue
    }
    if (kept >= MAX_ATTRIBUTES) continue
    const raw = typeof value === "string" ? value : JSON.stringify(value)
    if (raw === undefined) continue
    // Redact before truncating: slicing a secret to fit the budget would leave
    // a prefix of it on screen and in the export.
    const safe = redactString(raw)
    attributes[key] = safe.length > MAX_VALUE_CHARS ? safe.slice(0, MAX_VALUE_CHARS) + "…" : safe
    kept++
  }
  return { attributes: kept > 0 ? attributes : undefined, dropped }
}
