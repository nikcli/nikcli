import { describe, expect, it } from "bun:test"
import { ProviderError } from "@/provider/error"

/**
 * EOT-11 provider error classifier contract.
 *
 * `ProviderError.parseAPICallError` is the canonical classifier that
 * SessionRetry (and other callers) consume to decide whether to retry.
 * The contract:
 *
 *  - `context_overflow` is terminal. Retry will not help.
 *  - `payload_too_large` is terminal. Reduce the request body.
 *  - `api_error` carries the underlying `isRetryable` from the AI SDK.
 *  - `parseStreamError` handles the wire shape the SDK sees on a stream
 *    abort: discriminated union members + a JSON-string fallback.
 *
 * `isContextOverflowError` is the predicate the prompt-compaction and
 * `MessageV2.fromError` paths both rely on; a regression here breaks
 * every model call that hits a context limit.
 */
class FakeAPICallError extends Error {
  readonly statusCode?: number
  readonly responseBody?: string
  readonly isRetryable: boolean
  constructor(input: { statusCode?: number; responseBody?: string; isRetryable?: boolean; message: string }) {
    super(input.message)
    this.statusCode = input.statusCode
    this.responseBody = input.responseBody
    this.isRetryable = input.isRetryable ?? false
  }
}

function err(input: { statusCode?: number; responseBody?: string; isRetryable?: boolean; message: string }) {
  // `APICallError` is a branded type from the AI SDK with symbol-keyed fields
  // that a hand-rolled stub cannot reproduce without copying the SDK's brand
  // machinery. The classifier only reads `statusCode`, `responseBody`,
  // `isRetryable`, and `message`, so casting through `unknown` is the smallest
  // honest way to construct the input shape.
  return new FakeAPICallError(input) as unknown as Parameters<typeof ProviderError.parseAPICallError>[0]["error"]
}

describe("EOT-11 ProviderError.parseAPICallError", () => {
  it("classifies Anthropic 'prompt is too long' as context_overflow", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic",
      error: err({
        statusCode: 400,
        message: "prompt is too long",
        responseBody: "prompt is too long",
      }),
    })
    expect(result.type).toBe("context_overflow")
    if (result.type === "context_overflow") {
      expect(result.statusCode).toBe(400)
    }
  })

  it("classifies OpenAI 'input is too long for requested model' as context_overflow", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai",
      error: err({
        statusCode: 400,
        message: "input is too long for requested model",
      }),
    })
    expect(result.type).toBe("context_overflow")
  })

  it("classifies Anthropic 'prompt too long; exceeded model context length' as context_overflow", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic",
      error: err({
        statusCode: 400,
        message: "prompt too long; exceeded model context length",
      }),
    })
    expect(result.type).toBe("context_overflow")
  })

  it("classifies a 413 status as payload_too_large even without a matching message", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai",
      error: err({ statusCode: 413, message: "something else" }),
    })
    expect(result.type).toBe("payload_too_large")
  })

  it("classifies 'request_too_large' as payload_too_large", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic",
      error: err({ statusCode: 400, message: "request_too_large" }),
    })
    expect(result.type).toBe("payload_too_large")
  })

  it("classifies a generic 429 rate-limit as api_error with isRetryable=false by default", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai",
      error: err({
        statusCode: 429,
        message: "rate limit exceeded",
        isRetryable: false,
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.isRetryable).toBe(false)
      expect(result.statusCode).toBe(429)
    }
  })

  it("classifies a 503 as api_error and respects isRetryable=true", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai",
      error: err({
        statusCode: 503,
        message: "service unavailable",
        isRetryable: true,
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.isRetryable).toBe(true)
    }
  })

  it("falls back to the explicit message when the error carries none", () => {
    const emptyMessage = err({ statusCode: 500, message: "" })
    const result = ProviderError.parseAPICallError({
      providerID: "openai",
      error: emptyMessage,
      message: "explicit override",
    })
    expect(result.message).toBe("explicit override")
  })
})

describe("EOT-11 ProviderError.parseStreamError", () => {
  it("classifies a typed Anthropic stream error as context_overflow", () => {
    const json = JSON.stringify({
      type: "error",
      error: { code: "context_length_exceeded", message: "context too long" },
    })
    const result = ProviderError.parseStreamError(json)
    expect(result?.type).toBe("context_overflow")
  })

  it("classifies a 'token_limit_exceeded' stream error as context_overflow", () => {
    const json = JSON.stringify({
      type: "error",
      error: { code: "token_limit_exceeded", message: "tokens" },
    })
    const result = ProviderError.parseStreamError(json)
    expect(result?.type).toBe("context_overflow")
  })

  it("classifies a 'max_tokens_exceeded' stream error as context_overflow", () => {
    const json = JSON.stringify({
      type: "error",
      error: { code: "max_tokens_exceeded", message: "tokens" },
    })
    const result = ProviderError.parseStreamError(json)
    expect(result?.type).toBe("context_overflow")
  })

  it("classifies a 'prompt_too_long' stream error as context_overflow", () => {
    const json = JSON.stringify({
      type: "error",
      error: { code: "prompt_too_long", message: "tokens" },
    })
    const result = ProviderError.parseStreamError(json)
    expect(result?.type).toBe("context_overflow")
  })

  it("classifies a 'request_too_large' stream error as payload_too_large", () => {
    const json = JSON.stringify({
      type: "error",
      error: { code: "request_too_large", message: "too large" },
    })
    const result = ProviderError.parseStreamError(json)
    expect(result?.type).toBe("payload_too_large")
  })

  it("returns undefined for auth / rate-limit errors (the SDK handles these)", () => {
    const codes = ["insufficient_quota", "rate_limit_exceeded", "authentication_error"]
    for (const code of codes) {
      const json = JSON.stringify({
        type: "error",
        error: { code, message: "x" },
      })
      expect(ProviderError.parseStreamError(json)).toBeUndefined()
    }
  })

  it("falls back to regex matching when the body is not JSON", () => {
    expect(ProviderError.parseStreamError("prompt is too long")?.type).toBe("context_overflow")
    expect(ProviderError.parseStreamError("request_too_large")?.type).toBe("payload_too_large")
    expect(ProviderError.parseStreamError("random unrelated error")).toBeUndefined()
  })

  it("returns undefined for non-error JSON shapes", () => {
    expect(ProviderError.parseStreamError(JSON.stringify({ type: "content_block_delta", delta: {} }))).toBeUndefined()
  })
})

describe("EOT-11 ProviderError.isContextOverflowError", () => {
  it("matches a ContextOverflowError instance by name", () => {
    class ContextOverflowError extends Error {
      override readonly name = "ContextOverflowError"
    }
    expect(ProviderError.isContextOverflowError(new ContextOverflowError("x"))).toBe(true)
  })

  it("matches a MessageContextOverflowError instance by name", () => {
    class MessageContextOverflowError extends Error {
      override readonly name = "MessageContextOverflowError"
    }
    expect(ProviderError.isContextOverflowError(new MessageContextOverflowError("x"))).toBe(true)
  })

  it("matches an Error whose message fits an overflow pattern", () => {
    expect(ProviderError.isContextOverflowError(new Error("exceeds the context window"))).toBe(true)
  })

  it("matches a string message", () => {
    expect(ProviderError.isContextOverflowError("input token count exceeds maximum")).toBe(true)
  })

  it("matches an object with a string message field", () => {
    expect(
      ProviderError.isContextOverflowError({
        message: "input token count exceeds maximum",
      }),
    ).toBe(true)
  })

  it("matches an object whose data.type is context_overflow", () => {
    expect(
      ProviderError.isContextOverflowError({
        data: { type: "context_overflow" },
      }),
    ).toBe(true)
  })

  it("returns false for unrelated errors", () => {
    expect(ProviderError.isContextOverflowError(new Error("rate limit exceeded"))).toBe(false)
    expect(ProviderError.isContextOverflowError(null)).toBe(false)
    expect(ProviderError.isContextOverflowError(undefined)).toBe(false)
    expect(ProviderError.isContextOverflowError(42)).toBe(false)
  })
})

describe("EOT-11 ProviderError.HeaderTimeoutError", () => {
  it("is a tagged error with the timeout in ms and a populated message", () => {
    const error = new ProviderError.HeaderTimeoutError({ ms: 7_500 })
    expect(error._tag).toBe("ProviderHeaderTimeout")
    expect(error.ms).toBe(7_500)
    expect(error.message).toContain("7500")
  })
})

describe("EOT-11 ProviderError.formatOverflowMessage", () => {
  it("includes provider + model + actionable suggestions", () => {
    const message = ProviderError.formatOverflowMessage("anthropic", "claude-opus-4-6")
    expect(message).toContain("anthropic")
    expect(message).toContain("claude-opus-4-6")
    expect(message).toContain("/compact")
    expect(message).toContain("new session")
  })

  it("works without a model id", () => {
    const message = ProviderError.formatOverflowMessage("openai")
    expect(message).toContain("openai")
    expect(message).toContain("/compact")
  })
})
