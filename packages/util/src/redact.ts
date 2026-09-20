/**
 * Centralized log redaction and safe serialization.
 *
 * The `Log` namespace calls into this module before writing any value to
 * a persistent log file. The aim is to keep three classes of secret out
 * of the log:
 *   1. Specific keys known to carry credentials (`token`, `secret`,
 *      `password`, `authorization`, `cookie`, `code`, `state`,
 *      `apiKey`, `apikey`, `session`, `bearer`, `x-api-key`).
 *   2. Query-string credentials embedded in URLs (?token=…, ?code=…).
 *   3. Suspected secret-shaped substrings (sk-…, ghp_…, JWT-shape).
 *
 * `safeStringify` is also a defensive serializer: it breaks cycles with a
 * `WeakSet`, caps depth at 4, and caps each leaf at 4096 characters so a
 * single log line never balloons.
 */

/** The single token every redaction path writes. */
export const REDACTED = "[REDACTED]"

const REDACT_KEYS = new Set([
  "token",
  "secret",
  "password",
  "authorization",
  "auth",
  "cookie",
  "code",
  "state",
  "apikey",
  "api_key",
  "session",
  "bearer",
  "x-api-key",
  "x_api_key",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "client_secret",
  "clientSecret",
  "private_key",
  "privateKey",
  "credential",
  "credentials",
])

/**
 * These match without a leading `\b` on purpose.
 *
 * A word boundary before the prefix requires the preceding character to be a
 * non-word one, so a credential concatenated straight onto other text —
 * `...somethingnku_AAAA…` — was not redacted at all. Fuzzing the sanitizer
 * found it; a 200-character value ending in a token came back with the token
 * intact.
 *
 * Dropping the anchor costs nothing here because every one of these formats is
 * *prefixed*: `sk-`, `ghp_`, `xoxb-`, `nku_`, `eyJ`. The prefix is the signal
 * the boundary was standing in for, and nobody writes `xnku_` in prose. This is
 * the opposite trade from `BEARER_RE`, which needs its anchor precisely because
 * "Bearer" is an ordinary English word.
 */
const REDACT_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic style API keys
  /sk-[A-Za-z0-9_-]{16,}/g,
  // GitHub PATs (classic and fine-grained)
  /ghp_[A-Za-z0-9]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Slack tokens
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  // JWT shape (three dot-separated base64url segments)
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // nikcli account tokens. `UserDB` mints these as `nku_` + 32 random bytes of
  // base64url (`src/user/users.ts`), so the redactor has to know the one
  // credential format this product issues itself.
  /nku_[A-Za-z0-9_-]{16,}/g,
]

/**
 * `Authorization: Bearer <token>` where the token matches none of the shapes
 * above.
 *
 * The patterns are prefix- and structure-based, so an opaque bearer token from
 * a provider nobody has enumerated survives them all. The header is the tell:
 * whatever follows `Bearer` in one is a credential regardless of its shape.
 *
 * Replaces only the token, leaving the header name — a log line that still says
 * which header was present is worth more than one that lost it.
 *
 * The lookahead requiring a non-letter is what keeps prose out. `Bearer` also
 * appears in English error text ("Bearer authentication failed"), and a rule
 * that only measured length redacted the next word there, which makes a
 * diagnostic less readable while protecting nothing. Real tokens are base64url
 * or prefixed and effectively always carry a digit, `_`, `-`, `.`, `+` or `/`.
 */
const BEARER_RE = /\b(bearer\s+)((?=[A-Za-z0-9._~+/-]{8,})[A-Za-z]*[0-9._~+/-][A-Za-z0-9._~+/-]*={0,2})/gi

const URL_CREDENTIAL_RE =
  /([?&])(token|code|access_token|refresh_token|api_key|apikey|state|session|password|secret)=([^&\s#]+)/gi

/**
 * Credentials in a URL's userinfo, `scheme://user:pass@host`.
 *
 * `URL_CREDENTIAL_RE` above covers the query string only, so a connection
 * string — `postgres://user:pw@host/db`, a git remote with a token in it —
 * travelled verbatim into spans and logs. The spec's forbidden-dimension list
 * names "URLs with credentials" explicitly; this is the half that was missing.
 *
 * The username is kept and only the secret replaced: `postgres://user@host` is
 * still useful for telling two connections apart.
 */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]*@/gi

const MAX_DEPTH = 4
const MAX_LEAF = 4096

/**
 * Whether a key names a credential. Matches the original key and its
 * lowercase form, so `clientSecret`, `ClientSecret`, and `client_secret`
 * are all caught by the single `client_secret` entry.
 *
 * Exported because callers that format one entry at a time — `Log`'s
 * scalar branch — have to apply the same rule the object walk below
 * applies, or a flat `{ token: "…" }` escapes redaction entirely.
 */
export function isRedactedKey(key: string): boolean {
  return REDACT_KEYS.has(key) || REDACT_KEYS.has(key.toLowerCase())
}

/**
 * Redact a value recursively. Walks objects and arrays, replacing values
 * whose key matches `REDACT_KEYS` with `[REDACTED]`. Strings are scanned
 * for token-shaped substrings and URL query credentials.
 */
export function redactValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (depth > MAX_DEPTH) return "[max-depth]"
  if (value === null || value === undefined) return value
  if (typeof value === "string") {
    return redactString(value)
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return undefined
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    }
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[circular]"
    seen.add(value as object)
    if (Array.isArray(value)) {
      return value.map((v) => redactValue(v, depth + 1, seen))
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isRedactedKey(k)) {
        out[k] = REDACTED
      } else {
        out[k] = redactValue(v, depth + 1, seen)
      }
    }
    return out
  }
  return String(value)
}

/**
 * Redact token-shaped substrings and URL query credentials in a string.
 * Preserves the rest of the string verbatim so logs stay readable.
 */
export function redactString(input: string): string {
  if (input.length > MAX_LEAF) {
    input = input.slice(0, MAX_LEAF) + "...[truncated]"
  }
  let out = input
  // URL query credentials first, so the resulting "key=…" becomes
  // "key=[REDACTED]" instead of triggering the generic pattern below.
  out = out.replace(URL_CREDENTIAL_RE, (_match, prefix, key) => `${prefix}${key}=${REDACTED}`)
  out = out.replace(URL_USERINFO_RE, (_match, upToUser) => `${upToUser}:${REDACTED}@`)
  out = out.replace(BEARER_RE, (_match, prefix) => `${prefix}${REDACTED}`)
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, REDACTED)
  }
  return out
}

/**
 * Safely stringify a value for logging. Combines `redactValue` with a
 * depth and leaf cap. Use this anywhere a JSON-shaped value is written
 * to a log buffer.
 */
export function safeStringify(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): string {
  if (value === undefined) return "undefined"
  const redacted = redactValue(value, depth, seen)
  try {
    return JSON.stringify(redacted)
  } catch {
    return "[unserializable]"
  }
}

/**
 * Discover suspected secret-shaped substrings in a value. Useful for the
 * TUI toast pipeline, where a presenter might want to warn the user
 * before pasting a "secret" into chat.
 */
export function discover(value: unknown): string[] {
  const findings: string[] = []
  const seen = new WeakSet<object>()
  const walk = (v: unknown, depth: number) => {
    if (depth > MAX_DEPTH) return
    if (typeof v === "string") {
      for (const pattern of REDACT_PATTERNS) {
        pattern.lastIndex = 0
        const match = pattern.exec(v)
        if (match) findings.push(match[0])
      }
      URL_CREDENTIAL_RE.lastIndex = 0
      while (true) {
        const match = URL_CREDENTIAL_RE.exec(v)
        if (!match) break
        findings.push(match[0])
      }
      return
    }
    if (v && typeof v === "object") {
      if (seen.has(v as object)) return
      seen.add(v as object)
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (isRedactedKey(k)) {
          findings.push(`${k}=${REDACTED}`)
        } else {
          walk(child, depth + 1)
        }
      }
    }
  }
  walk(value, 0)
  return findings
}
