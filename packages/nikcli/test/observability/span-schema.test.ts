import { describe, expect, it } from "bun:test"
import {
  ALLOWED_SPAN_ATTRIBUTES,
  isForbiddenSpanAttribute,
  promptLengthBucket,
  sanitizeSpanAttributes,
  splitKeySegments,
} from "@/observability/span-schema"

describe("isForbiddenSpanAttribute", () => {
  it("keeps every key in the fixed schema", () => {
    for (const key of ALLOWED_SPAN_ATTRIBUTES) {
      expect(isForbiddenSpanAttribute(key)).toBe(false)
    }
  })

  it("drops content and credential keys", () => {
    for (const key of [
      "prompt.text",
      "llm.completion",
      "file.path",
      "request.body",
      "http.url",
      "auth.token",
      "oauth.code",
      "pkce.verifier",
      "user.email",
      "client.ip",
      "account.id",
    ]) {
      expect(isForbiddenSpanAttribute(key)).toBe(true)
    }
  })

  it("drops the header keys Effect's server span records that carry an IP or a URL", () => {
    // Each of these reached a sanitized span intact before the header words
    // were added: `x-forwarded-for` is a client IP, the others are URLs.
    for (const key of [
      "http.request.header.x-forwarded-for",
      "http.request.header.forwarded",
      "http.request.header.referer",
      "http.request.header.referrer",
      "http.request.header.origin",
      "http.response.header.location",
    ]) {
      expect(isForbiddenSpanAttribute(key)).toBe(true)
    }
  })

  it("matches per segment, so an innocent key is not caught by a substring", () => {
    // "http.route" survives even though "route" is adjacent to forbidden keys,
    // and "description" is not dropped for containing "ip".
    expect(isForbiddenSpanAttribute("http.route")).toBe(false)
    expect(isForbiddenSpanAttribute("error.description")).toBe(false)
    expect(isForbiddenSpanAttribute("provider.model")).toBe(false)
  })

  it("lets the schema override a forbidden segment", () => {
    // The spec permits a prompt as a hash and a length bucket, nothing else.
    expect(isForbiddenSpanAttribute("prompt.hash")).toBe(false)
    expect(isForbiddenSpanAttribute("prompt.length_bucket")).toBe(false)
    expect(isForbiddenSpanAttribute("prompt.value")).toBe(true)
  })

  it("splits on every separator the emitters use", () => {
    expect(splitKeySegments("http.status_code")).toEqual(["http", "status", "code"])
    expect(splitKeySegments("a-b/c")).toEqual(["a", "b", "c"])
  })
})

describe("sanitizeSpanAttributes", () => {
  it("keeps allowed attributes as-is", () => {
    const { attributes, dropped } = sanitizeSpanAttributes([
      ["http.route", "/session/:id"],
      ["http.status_code", 200],
    ])
    expect(attributes).toEqual({ "http.route": "/session/:id", "http.status_code": "200" })
    expect(dropped).toEqual([])
  })

  it("drops forbidden keys and reports them", () => {
    const { attributes, dropped } = sanitizeSpanAttributes([
      ["session.id", "ses_1"],
      ["prompt.text", "how do I exfiltrate"],
    ])
    expect(attributes).toEqual({ "session.id": "ses_1" })
    expect(dropped).toEqual(["prompt.text"])
  })

  it("redacts secret-shaped values on keys it keeps", () => {
    const { attributes } = sanitizeSpanAttributes([["error.kind", "failed with sk-abcdefghijklmnopqrstuvwx"]])
    expect(attributes?.["error.kind"]).not.toContain("sk-abcdefghijklmnopqrstuvwx")
    expect(attributes?.["error.kind"]).toContain("[REDACTED]")
  })

  it("redacts before truncating, so no secret prefix survives the budget", () => {
    const secret = "sk-" + "a".repeat(400)
    const { attributes } = sanitizeSpanAttributes([["error.category", secret]])
    expect(attributes?.["error.category"]).not.toContain("sk-aaaa")
  })

  it("caps the attribute count", () => {
    const many: [string, unknown][] = Array.from({ length: 50 }, (_, i) => [`error.kind${i}`, i])
    const { attributes } = sanitizeSpanAttributes(many)
    expect(Object.keys(attributes ?? {})).toHaveLength(32)
  })

  it("still drops forbidden keys past the count cap", () => {
    const many: [string, unknown][] = Array.from({ length: 40 }, (_, i) => [`error.kind${i}`, i])
    many.push(["prompt.text", "secret question"])
    const { attributes, dropped } = sanitizeSpanAttributes(many)
    expect(dropped).toEqual(["prompt.text"])
    expect(JSON.stringify(attributes)).not.toContain("secret question")
  })

  it("returns undefined when nothing survives", () => {
    expect(sanitizeSpanAttributes([["prompt.text", "x"]]).attributes).toBeUndefined()
    expect(sanitizeSpanAttributes([]).attributes).toBeUndefined()
  })

  it("skips null and undefined values", () => {
    const { attributes } = sanitizeSpanAttributes([
      ["session.id", null],
      ["workspace.id", undefined],
      ["host.mode", "cli"],
    ])
    expect(attributes).toEqual({ "host.mode": "cli" })
  })
})

describe("promptLengthBucket", () => {
  it("buckets instead of reporting an exact length", () => {
    expect(promptLengthBucket(0)).toBe("0")
    expect(promptLengthBucket(10)).toBe("<64")
    expect(promptLengthBucket(63)).toBe("<64")
    expect(promptLengthBucket(64)).toBe("<256")
    expect(promptLengthBucket(100_000)).toBe(">=65536")
  })

  it("does not distinguish two prompts inside one bucket", () => {
    expect(promptLengthBucket(300)).toBe(promptLengthBucket(900))
  })

  it("handles nonsense input", () => {
    expect(promptLengthBucket(-1)).toBe("unknown")
    expect(promptLengthBucket(Number.NaN)).toBe("unknown")
  })
})
