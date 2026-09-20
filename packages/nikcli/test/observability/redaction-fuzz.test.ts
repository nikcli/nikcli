import { describe, expect, it } from "bun:test"
import {
  ALLOWED_SPAN_ATTRIBUTES,
  isForbiddenSpanAttribute,
  sanitizeSpanAttributes,
  splitKeySegments,
} from "@/observability/span-schema"
import { REDACTED, redactString } from "@nikcli-ai/util/redact"

/**
 * EOT-13's release gate asks for redaction fuzz, and this is it.
 *
 * Not fuzz in the random sense: the generator below enumerates the *spellings*
 * a forbidden word can arrive in, which is where the holes actually were. Two
 * of them were found by running this against the original sanitizer:
 *
 *  - `splitKeySegments` split on punctuation only, so every camelCase key —
 *    `authToken`, `sessionPassword`, `bearerToken`, `accessToken` — was a
 *    single unrecognised segment and walked past the whole forbidden list.
 *    camelCase is this codebase's dominant convention, so that was the likely
 *    spelling rather than an exotic one.
 *  - `auth:token`, `auth token` and `auth|token` were one segment for the same
 *    reason: those separators were not in the character class.
 *
 * A third was found on the value side: `redactString` covered query-string
 * credentials but not a URL's userinfo, so `postgres://user:pw@host/db` — and
 * any git remote with a token in it — travelled verbatim into spans and logs.
 */

/** Words the spec forbids that are unambiguous enough to combine freely. */
const SECRET_WORDS = [
  "token",
  "password",
  "secret",
  "authorization",
  "cookie",
  "credential",
  "apikey",
  "bearer",
  "verifier",
  "challenge",
  "prompt",
  "completion",
  "email",
]

/** Every way a two-word key gets spelled in this codebase and its wire formats. */
function spellings(prefix: string, word: string): string[] {
  const Cap = word[0].toUpperCase() + word.slice(1)
  const Upper = word.toUpperCase()
  return [
    word,
    Upper,
    `${prefix}.${word}`,
    `${prefix}_${word}`,
    `${prefix}-${word}`,
    `${prefix}/${word}`,
    `${prefix}:${word}`,
    `${prefix}|${word}`,
    `${prefix} ${word}`,
    `${prefix}${Cap}`,
    `${prefix}${Upper}`,
    `${prefix}.${Cap}`,
  ]
}

describe("span attribute key fuzz", () => {
  it("blocks every spelling of every forbidden word", () => {
    const escaped: string[] = []
    for (const word of SECRET_WORDS) {
      for (const prefix of ["user", "x", "request", "my", "http"]) {
        for (const key of spellings(prefix, word)) {
          // The allowlist is an exact-match short circuit and outranks the
          // forbidden list on purpose — `prompt.hash` is allowed while
          // `prompt` is forbidden — so an allowed key is not an escape.
          if (ALLOWED_SPAN_ATTRIBUTES.has(key)) continue
          if (!isForbiddenSpanAttribute(key)) escaped.push(key)
        }
      }
    }
    expect(escaped).toEqual([])
  })

  it("keeps the allowed schema reachable, so failing closed is not the same as failing shut", () => {
    // A sanitizer that drops everything passes the test above and is useless.
    for (const key of ALLOWED_SPAN_ATTRIBUTES) {
      expect(isForbiddenSpanAttribute(key)).toBe(false)
    }
    const { attributes } = sanitizeSpanAttributes([...ALLOWED_SPAN_ATTRIBUTES].map((k) => [k, "v"] as const))
    expect(Object.keys(attributes ?? {}).length).toBeGreaterThan(0)
  })

  it("does not block an ordinary key that merely contains a forbidden word inside another", () => {
    // `tokenize` is not `token`; segment matching is whole-word by design.
    for (const key of ["queue.depth", "tokenizer.name", "event.class", "retry.count"]) {
      expect(isForbiddenSpanAttribute(key)).toBe(false)
    }
  })

  it("splits a case boundary into its own segment", () => {
    expect(splitKeySegments("authToken")).toEqual(["auth", "token"])
    expect(splitKeySegments("httpStatusCode")).toEqual(["http", "status", "code"])
    expect(splitKeySegments("auth:token")).toEqual(["auth", "token"])
  })

  it("drops a forbidden key rather than emitting it empty", () => {
    const { attributes, dropped } = sanitizeSpanAttributes([
      ["authToken", "nku_secretsecretsecret1234"],
      ["http.route", "/session"],
    ])
    expect(dropped).toContain("authToken")
    expect(attributes).toEqual({ "http.route": "/session" })
    expect(JSON.stringify(attributes)).not.toContain("nku_")
  })
})

describe("span attribute value fuzz", () => {
  const SECRETS = [
    "nku_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sk-ant-api03-aaaaaaaaaaaaaaaaaaaa",
    "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "xoxb-1234567890-abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln",
    "Bearer abcd1234.efgh5678",
    "postgres://user:hunter2@db.internal/app",
    "https://tok:s3cr3t@github.com/o/r.git",
    "https://api.example.com/cb?code=abc123&state=xyz",
  ]

  it("leaves no secret verbatim in an allowed attribute", () => {
    const survived: string[] = []
    for (const secret of SECRETS) {
      // Wrapped in surrounding prose, because a redactor anchored to the whole
      // string would pass a bare value and miss an embedded one.
      for (const value of [secret, `failed for ${secret} after 2 tries`, `[${secret}]`]) {
        const out = sanitizeSpanAttributes([["http.route", value]]).attributes?.["http.route"] ?? ""
        if (out.includes("hunter2") || out.includes("s3cr3t") || /nku_a|sk-ant|ghp_a|xoxb-|eyJhbGci/.test(out)) {
          survived.push(value)
        }
      }
    }
    expect(survived).toEqual([])
  })

  it("redacts a URL's userinfo while keeping the part that identifies the connection", () => {
    const out = redactString("postgres://svc:hunter2@db.internal/app")
    expect(out).toBe(`postgres://svc:${REDACTED}@db.internal/app`)
  })

  it("redacts before truncating, so a long value cannot leave a prefix of a secret", () => {
    // The order matters: slicing to the budget first would put the first 200
    // characters of a credential on screen and in the export.
    const value = "x".repeat(190) + "nku_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const out = sanitizeSpanAttributes([["http.route", value]]).attributes?.["http.route"] ?? ""
    expect(out).not.toContain("nku_")
  })

  it("caps a value that carries no secret at all", () => {
    const out = sanitizeSpanAttributes([["http.route", "y".repeat(5000)]]).attributes?.["http.route"] ?? ""
    expect(out.length).toBeLessThanOrEqual(201)
  })

  it("survives values that are not strings", () => {
    const { attributes } = sanitizeSpanAttributes([
      ["http.status_code", 200],
      ["event.class", { nested: { token: "nku_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }],
      ["error.kind", ["a", "b"]],
    ])
    expect(attributes?.["http.status_code"]).toBe("200")
    expect(JSON.stringify(attributes)).not.toContain("nku_a")
  })
})
