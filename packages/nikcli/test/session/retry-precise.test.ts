import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"

function apiErr(input: ConstructorParameters<typeof MessageV2.APIError>[0]) {
  return new MessageV2.APIError(input)
}

describe("SessionRetry.delay precise table (no API error)", () => {
  let randomSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    randomSpy = spyOn(Math, "random").mockReturnValue(0)
  })
  afterEach(() => {
    randomSpy.mockRestore()
  })

  const expected: Record<number, number> = {
    1: 2_000,
    2: 4_000,
    3: 8_000,
    4: 16_000,
    5: 30_000,
    6: 30_000,
    7: 30_000,
    12: 30_000,
  }
  for (const [attemptStr, want] of Object.entries(expected)) {
    const attempt = Number(attemptStr)
    it(`attempt ${attempt} → ${want} ms`, () => {
      expect(SessionRetry.delay(attempt)).toBe(want)
    })
  }
})

describe("SessionRetry.delay precise (headers)", () => {
  let randomSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    randomSpy = spyOn(Math, "random").mockReturnValue(0)
  })
  afterEach(() => {
    randomSpy.mockRestore()
  })

  it("retry-after-ms wins with exact float string", () => {
    const e = apiErr({
      message: "x",
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "1500.5" },
    })
    expect(SessionRetry.delay(99, e)).toBe(1500.5)
  })

  it("retry-after seconds string → ceil(seconds * 1000)", () => {
    const e = apiErr({
      message: "x",
      isRetryable: true,
      responseHeaders: { "retry-after": "3" },
    })
    expect(SessionRetry.delay(1, e)).toBe(3000)
  })

  it("retry-after fractional seconds still uses parseFloat then ceil", () => {
    const e = apiErr({
      message: "x",
      isRetryable: true,
      responseHeaders: { "retry-after": "1.1" },
    })
    expect(SessionRetry.delay(1, e)).toBe(1100)
  })

  it("invalid retry-after-ms falls through to numeric retry-after then backoff", () => {
    const e = apiErr({
      message: "x",
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "nan", "retry-after": "not-num" },
    })
    expect(SessionRetry.delay(3, e)).toBe(8_000)
  })
})

describe("SessionRetry.retryable precise strings", () => {
  it("FreeUsageLimitError in message returns exact credit URL line", () => {
    const e = apiErr({
      message: "prefix FreeUsageLimitError suffix",
      isRetryable: true,
    })
    expect(SessionRetry.retryable(e.toObject())).toBe("Free usage exceeded, add credits https://nikcli-ai.dev/zen")
  })

  it("FreeUsageLimitError in responseBody only", () => {
    const e = apiErr({
      message: "ok",
      isRetryable: true,
      responseBody: '{"type":"FreeUsageLimitError"}',
    })
    expect(String(SessionRetry.retryable(e.toObject())).startsWith("Free usage exceeded")).toBe(true)
  })

  it("Overloaded in message short-circuits to fixed phrase", () => {
    const e = apiErr({ message: "model Overloaded now", isRetryable: true })
    expect(SessionRetry.retryable(e.toObject())).toBe("Provider is overloaded")
  })

  it("retryable API returns raw message when JSON not matched", () => {
    const e = apiErr({ message: "plain provider text", isRetryable: true })
    expect(SessionRetry.retryable(e.toObject())).toBe("plain provider text")
  })

  it("mapJson: rate_limit code → Rate Limited", () => {
    const e = apiErr({
      message: JSON.stringify({ type: "error", error: { code: "rate_limit_something" } }),
      isRetryable: true,
    })
    expect(SessionRetry.retryable(e.toObject())).toBe("Rate Limited")
  })

  it("mapJson: server_error type → Provider Server Error", () => {
    const e = apiErr({
      message: JSON.stringify({ type: "error", error: { type: "server_error" } }),
      isRetryable: true,
    })
    expect(SessionRetry.retryable(e.toObject())).toBe("Provider Server Error")
  })

  it("mapJson: error.message no_kv_space → Provider Server Error", () => {
    const e = apiErr({
      message: JSON.stringify({ error: { message: "no_kv_space exceeded" } }),
      isRetryable: true,
    })
    expect(SessionRetry.retryable(e.toObject())).toBe("Provider Server Error")
  })

  it("mapJson: bare truthy error key → Provider Server Error", () => {
    const e = apiErr({
      message: JSON.stringify({ error: true }),
      isRetryable: true,
    })
    expect(SessionRetry.retryable(e.toObject())).toBe("Provider Server Error")
  })

  it("non-API toObject with JSON message uses mapJson only", () => {
    const plain = {
      name: "OtherError" as const,
      data: { message: '{"type":"error","error":{"type":"too_many_requests"}}' },
    }
    expect(SessionRetry.retryable(plain as never)).toBe("Too Many Requests")
  })

  it("non-API exhausted code", () => {
    const plain = {
      name: "OtherError" as const,
      data: { message: '{"code":"capacity_exhausted"}' },
    }
    expect(SessionRetry.retryable(plain as never)).toBe("Provider is overloaded")
  })

  it("non-API unavailable code", () => {
    const plain = {
      name: "OtherError" as const,
      data: { message: '{"code":"service_unavailable"}' },
    }
    expect(SessionRetry.retryable(plain as never)).toBe("Provider is overloaded")
  })
})

describe("SessionRetry constants precise", () => {
  it("exported numeric constants match implementation expectations", () => {
    expect(SessionRetry.RETRY_INITIAL_DELAY).toBe(2000)
    expect(SessionRetry.RETRY_BACKOFF_FACTOR).toBe(2)
    expect(SessionRetry.RETRY_MAX_DELAY_NO_HEADERS).toBe(30_000)
    expect(SessionRetry.RETRY_MAX_ATTEMPTS).toBe(5)
    expect(SessionRetry.RETRY_MAX_DELAY).toBe(2_147_483_647)
  })
})
