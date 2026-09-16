/// <reference types="@types/bun" />

import { afterEach, describe, expect, test } from "bun:test"
import { MobileClient } from "./client"

type Call = { authorization: string | null }

const realFetch = globalThis.fetch

/** Answers 401 until a request arrives bearing `accepted`, then 200. */
function stubFetch(accepted: string | null) {
  const calls: Call[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const authorization = headers.Authorization ?? null
    calls.push({ authorization })
    const ok = accepted !== null && authorization === `Bearer ${accepted}`
    return new Response(ok ? JSON.stringify({ ok: true }) : "unauthorized", {
      status: ok ? 200 : 401,
      headers: { "content-type": ok ? "application/json" : "text/plain" },
    })
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

/**
 * The account token expires long before the pairing token does, and a refresh can fail outright
 * once the refresh token is gone. Without a fallback the phone was simply locked out of a host
 * that would still have honoured the pairing token it was set up with.
 */
describe("MobileClient 401 handling", () => {
  test("falls back to the pairing token when the refresh returns nothing", async () => {
    const calls = stubFetch("nkm_pairing")
    const client = new MobileClient(
      { url: "http://host.test", token: "expired_account" },
      { onUnauthorized: async () => null, fallbackToken: "nkm_pairing" },
    )

    await expect(client.request("/mobile/bootstrap")).resolves.toEqual({ ok: true } as never)
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer expired_account", "Bearer nkm_pairing"])
  })

  test("prefers a refreshed account token over the pairing token", async () => {
    const calls = stubFetch("fresh_account")
    const client = new MobileClient(
      { url: "http://host.test", token: "expired_account" },
      { onUnauthorized: async () => "fresh_account", fallbackToken: "nkm_pairing" },
    )

    await expect(client.request("/mobile/bootstrap")).resolves.toEqual({ ok: true } as never)
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer expired_account", "Bearer fresh_account"])
  })

  // With no account signed in, `config.token` already *is* the pairing token, so resending it
  // would only earn a second 401 and double every failed request.
  test("does not retry when the fallback is what already failed", async () => {
    const calls = stubFetch(null)
    const client = new MobileClient(
      { url: "http://host.test", token: "nkm_pairing" },
      { onUnauthorized: async () => null, fallbackToken: "nkm_pairing" },
    )

    await expect(client.request("/mobile/bootstrap")).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  test("ignores a blank fallback token", async () => {
    const calls = stubFetch(null)
    const client = new MobileClient(
      { url: "http://host.test", token: "expired_account" },
      { onUnauthorized: async () => null, fallbackToken: "   " },
    )

    await expect(client.request("/mobile/bootstrap")).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  test("keeps the fallback across withDirectory", async () => {
    const calls = stubFetch("nkm_pairing")
    const client = new MobileClient(
      { url: "http://host.test", token: "expired_account" },
      { onUnauthorized: async () => null, fallbackToken: "nkm_pairing" },
    ).withDirectory("/tmp/project")

    await expect(client.request("/mobile/bootstrap")).resolves.toEqual({ ok: true } as never)
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer expired_account", "Bearer nkm_pairing"])
  })
})
