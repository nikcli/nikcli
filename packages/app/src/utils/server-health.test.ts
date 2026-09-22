import { describe, expect, test } from "bun:test"
import { checkServerHealth, serverUrlMatchesRequest, withServerBearerToken } from "./server-health"

describe("checkServerHealth", () => {
  test("returns healthy response with version", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth("http://localhost:4096", fetch)

    expect(result).toEqual({ healthy: true, version: "1.2.3" })
  })

  test("returns unhealthy when request fails", async () => {
    const fetch = (async () => {
      throw new Error("network")
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth("http://localhost:4096", fetch)

    expect(result).toEqual({ healthy: false })
  })

  test("uses provided abort signal", async () => {
    let signal: AbortSignal | undefined
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    const abort = new AbortController()
    await checkServerHealth("http://localhost:4096", fetch, { signal: abort.signal })

    expect(signal).toBe(abort.signal)
  })
})

describe("server bearer authentication", () => {
  test("matches only the configured server and path boundary", () => {
    expect(serverUrlMatchesRequest("https://s.nikcli-ai.dev", "https://s.nikcli-ai.dev/global/health")).toBe(true)
    expect(serverUrlMatchesRequest("https://s.nikcli-ai.dev/api", "https://s.nikcli-ai.dev/api/session")).toBe(true)
    expect(serverUrlMatchesRequest("https://s.nikcli-ai.dev/api", "https://s.nikcli-ai.dev/apiv2/session")).toBe(false)
    expect(serverUrlMatchesRequest("https://s.nikcli-ai.dev", "https://other.example/global/health")).toBe(false)
  })

  test("adds bearer auth without mutating the source request", async () => {
    let received: Request | undefined
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      received = input instanceof Request ? input : new Request(input, init)
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
    const source = new Request("https://s.nikcli-ai.dev/global/health", {
      headers: { "x-test": "value" },
    })

    await withServerBearerToken(fetcher, "https://s.nikcli-ai.dev", "secret-token")(source)

    expect(source.headers.get("Authorization")).toBeNull()
    expect(received?.headers.get("Authorization")).toBe("Bearer secret-token")
    expect(received?.headers.get("x-test")).toBe("value")
  })

  test("does not leak the token to another origin", async () => {
    let authorization: string | null = null
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      authorization = request.headers.get("Authorization")
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch

    await withServerBearerToken(fetcher, "https://s.nikcli-ai.dev", "secret-token")("https://example.com/global/health")

    expect(authorization).toBeNull()
  })
})
