import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-account-effect-home-"))
process.env.NIKCLI_TEST_HOME = testHome

preserveTestEnv(["NIKCLI_TEST_HOME"])

const { Account } = await import("@/account")

function runAccount<A, E>(effect: Effect.Effect<A, E, any>) {
  return Effect.runPromise(effect.pipe(Effect.provide(Account.defaultLayer)) as Effect.Effect<A, E, never>)
}

describe("Account.Service", () => {
  beforeEach(async () => {
    await fs.rm(path.join(testHome, "data", "accounts.db"), { force: true })
    await fs.rm(path.join(testHome, "data", "accounts.db-shm"), {
      force: true,
    })
    await fs.rm(path.join(testHome, "data", "accounts.db-wal"), {
      force: true,
    })
    await fs.mkdir(path.join(testHome, "data"), { recursive: true })
  })

  it("provides local account operations through the Effect service boundary", async () => {
    const result = await runAccount(
      Effect.gen(function* () {
        const account = yield* Account.Service
        return {
          config: yield* account.config(),
          list: yield* account.list(),
          active: yield* account.active(),
          removed: yield* account.remove("account_missing"),
        }
      }),
    )

    expect(result.config.serverUrl).toContain("https://")
    expect(result.list).toEqual([])
    expect(result.active).toBeUndefined()
    expect(result.removed).toBe(false)
  })

  it("persists the verified OAuth profile when device login completes", async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      requests.push(url)
      if (url.endsWith("oauth/device/token")) {
        return Response.json({
          status: "success",
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 900,
        })
      }
      if (url.endsWith("userinfo")) {
        return Response.json({
          id: "acc_remote",
          email: "New.User@Example.com",
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    try {
      const result = await runAccount(
        Effect.gen(function* () {
          const account = yield* Account.Service
          const first = yield* account.poll("device-code-1" as never)
          const second = yield* account.poll("device-code-2" as never)
          return {
            first,
            second,
            active: yield* account.active(),
            accounts: yield* account.list(),
          }
        }),
      )

      expect(requests).toEqual([
        "https://auth.nikcli-ai.dev/oauth/device/token",
        "https://auth.nikcli-ai.dev/userinfo",
        "https://auth.nikcli-ai.dev/oauth/device/token",
        "https://auth.nikcli-ai.dev/userinfo",
      ])
      expect(result.second.accountID).toBe(result.first.accountID)
      expect(result.accounts).toHaveLength(1)
      expect(result.active?.id).toBe(result.first.accountID)
      expect(result.active?.email).toBe("new.user@example.com")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("hands the caller a verification link with the code already in it", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: string | URL | Request) =>
      Response.json({
        device_code: "device-code",
        user_code: "1234-5678",
        verification_url: "https://auth.nikcli-ai.dev/device",
        verification_uri_complete: "https://auth.nikcli-ai.dev/device?user_code=1234-5678",
        interval: 5,
        expires_in: 600,
      })) as typeof fetch

    try {
      const start = await runAccount(
        Effect.gen(function* () {
          const account = yield* Account.Service
          return yield* account.login()
        }),
      )
      expect(start.verificationUrlComplete).toBe("https://auth.nikcli-ai.dev/device?user_code=1234-5678")
      expect(start.expiresAt).toBeGreaterThan(Date.now())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("builds the prefilled link itself when the issuer omits it", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: string | URL | Request) =>
      Response.json({
        device_code: "device-code",
        user_code: "1234-5678",
        verification_url: "https://auth.nikcli-ai.dev/device",
        interval: 5,
        expires_in: 600,
      })) as typeof fetch

    try {
      const start = await runAccount(
        Effect.gen(function* () {
          const account = yield* Account.Service
          return yield* account.login()
        }),
      )
      expect(start.verificationUrlComplete).toBe("https://auth.nikcli-ai.dev/device?user_code=1234-5678")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("rejects a malformed device-code response instead of failing later during polling", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: string | URL | Request) =>
      Response.json({ user_code: "1234-5678" })) as typeof fetch

    try {
      await expect(
        runAccount(
          Effect.gen(function* () {
            const account = yield* Account.Service
            return yield* account.login()
          }),
        ),
      ).rejects.toThrow(/unexpected device-code response/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("keeps polling through a network blip instead of losing an approved sign-in", async () => {
    const originalFetch = globalThis.fetch
    let attempts = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith("oauth/device/token")) {
        attempts += 1
        if (attempts === 1) throw new Error("network unreachable")
        if (attempts === 2) return new Response("bad gateway", { status: 502 })
        return Response.json({
          status: "success",
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 900,
        })
      }
      if (url.endsWith("userinfo")) return Response.json({ email: "blip@example.com" })
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    try {
      const result = await runAccount(
        Effect.gen(function* () {
          const account = yield* Account.Service
          // A 1s lifetime keeps the retry backoff short; the deadline is only
          // checked after a poll returns a verdict.
          return yield* account.poll("device-code" as never, { expiresIn: 1 })
        }),
      )
      expect(attempts).toBe(3)
      expect(result.accessToken).toBe("access-token")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("reports a denied sign-in as denied rather than a generic failure", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: string | URL | Request) => Response.json({ status: "denied" })) as typeof fetch

    try {
      await expect(
        runAccount(
          Effect.gen(function* () {
            const account = yield* Account.Service
            return yield* account.poll("device-code" as never)
          }),
        ),
      ).rejects.toThrow(/denied in the browser/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("does not poll after OAuth login is cancelled", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      runAccount(
        Effect.gen(function* () {
          const account = yield* Account.Service
          return yield* account.poll("cancelled-device-code" as never, {
            signal: controller.signal,
          })
        }),
      ),
    ).rejects.toThrow()
  })

  /**
   * `auth.nikcli-ai.dev` serves no `/api/user/orgs` and has no orgs table, so
   * the only answer this call ever got in production was a 404 — which the
   * service raised as `AccountFetchOrgs` and `nikcli account orgs` printed as
   * "Failed to fetch orgs: 404 404 Not Found". An issuer with no organizations
   * endpoint has no organizations, which is an empty list.
   */
  it("reads an issuer without an organizations endpoint as having none", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith("oauth/device/token")) {
        return Response.json({
          status: "success",
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        })
      }
      if (url.endsWith("userinfo")) return Response.json({ email: "orgs@example.com" })
      if (url.endsWith("api/user/orgs")) return new Response("Not Found", { status: 404 })
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    try {
      const orgs = await runAccount(
        Effect.gen(function* () {
          const account = yield* Account.Service
          const session = yield* account.poll("device-code" as never)
          return yield* account.orgs(session.accountID)
        }),
      )
      expect(orgs).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("still reports a real organizations failure", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith("oauth/device/token")) {
        return Response.json({
          status: "success",
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        })
      }
      if (url.endsWith("userinfo")) return Response.json({ email: "orgs-down@example.com" })
      if (url.endsWith("api/user/orgs")) return new Response("boom", { status: 503 })
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    try {
      await expect(
        runAccount(
          Effect.gen(function* () {
            const account = yield* Account.Service
            const session = yield* account.poll("device-code" as never)
            return yield* account.orgs(session.accountID)
          }),
        ),
      ).rejects.toThrow(/503/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

afterAll(async () => {
  await removeTestDir(testHome)
})
