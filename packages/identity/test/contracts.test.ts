import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { isAllowedRedirect } from "../src/constants"
import { randomDigits, secureEqual, sha256 } from "../src/crypto"
import { githubRedirectURI } from "../src/login"

function fakeState() {
  const values = new Map<string, string>()
  return {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null
      return type === "json" && value ? JSON.parse(value) : value
    },
    async put(key: string, value: string) {
      values.set(key, value)
    },
    async delete(key: string) {
      values.delete(key)
    },
  } as KVNamespace
}

function fakeDb() {
  return {
    prepare(sql: string) {
      let values: unknown[] = []
      return {
        bind(...input: unknown[]) {
          values = input
          return this
        },
        async run() {
          // Issuing a device code first clears the expired rows whose
          // `user_code` would otherwise stay reserved forever.
          if (sql.includes("DELETE FROM device_codes")) {
            expect(values).toHaveLength(1)
            return { success: true, meta: { changes: 0 } }
          }
          if (!sql.includes("INSERT OR IGNORE INTO device_codes")) throw new Error(`Unexpected SQL: ${sql}`)
          expect(values).toHaveLength(9)
          return { success: true, meta: { changes: 1 } }
        },
      }
    },
  } as D1Database
}

function env(overrides: Partial<Env> = {}): Env {
  const send = async (_message: EmailMessage | Parameters<SendEmail["send"]>[0]) => ({ messageId: "test-message" })
  return {
    ISSUER: "https://auth.nikcli-ai.dev",
    AUDIENCE: "nikcli-api",
    EMAIL_SENDER: "auth@nikcli-ai.dev",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    STATE: fakeState(),
    DB: fakeDb(),
    EMAIL: { send },
    ...overrides,
  } as Env
}

describe("identity contracts", () => {
  test("publishes OAuth and nikcli discovery", async () => {
    const oauth = await app.fetch(
      new Request("https://auth.nikcli-ai.dev/.well-known/oauth-authorization-server"),
      env(),
    )
    expect(oauth.status).toBe(200)
    const metadata = (await oauth.json()) as {
      issuer: string
      code_challenge_methods_supported: string[]
    }
    expect(metadata.issuer).toBe("https://auth.nikcli-ai.dev")
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"])

    const nikcli = await app.fetch(new Request("https://auth.nikcli-ai.dev/.well-known/nikcli"), env())
    const discovery = (await nikcli.json()) as {
      auth: { command: string[]; env: string }
    }
    expect(discovery.auth.command[0]).toBe("curl")
    expect(discovery.auth.env).toBe("NIKCLI_ACCOUNT_URL")
  })

  test("requires PKCE S256 and registered redirects", async () => {
    const invalid = await app.fetch(
      new Request(
        "https://auth.nikcli-ai.dev/authorize?response_type=code&client_id=nikcli-studio&redirect_uri=https%3A%2F%2Fattacker.test%2Fcallback&state=s&code_challenge=x&code_challenge_method=plain",
      ),
      env(),
    )
    expect(invalid.status).toBe(400)

    const verifier = "a".repeat(43)
    const validUrl = new URL("https://auth.nikcli-ai.dev/authorize")
    validUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: "nikcli-studio",
      redirect_uri: "https://nikcli-ai.dev/dashboard/callback",
      state: "opaque-state",
      code_challenge: verifier,
      code_challenge_method: "S256",
    }).toString()
    const valid = await app.fetch(new Request(validUrl), env())
    expect(valid.status).toBe(200)
    const login = await valid.text()
    expect(login).toContain("Continue with GitHub")
    expect(login).toContain("Continue with passkey")
    expect(login).toContain("your account will be created automatically after verification")
  })

  test("returns the shipped CLI device-code response shape", async () => {
    const response = await app.fetch(
      new Request("https://auth.nikcli-ai.dev/oauth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: "nikcli",
          scope: "openid profile email offline_access",
        }),
      }),
      env(),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(typeof body.device_code).toBe("string")
    expect(body.user_code).toMatch(/^\d{4}-\d{4}$/)
    expect(body.verification_url).toBe("https://auth.nikcli-ai.dev/device")
    // The name RFC 8628 defines, alongside the one nikcli's own clients read.
    expect(body.verification_uri).toBe("https://auth.nikcli-ai.dev/device")
    expect(body.interval).toBe(5)
    // The window has to outlast a github.com round trip with 2FA plus the
    // passkey offer, not just typing the code.
    expect(body.expires_in).toBe(1200)
  })

  // The metadata document advertises this route as `device_authorization_endpoint`,
  // and RFC 8628 specifies that request as form-encoded. Reading JSON only
  // answered a conformant client with a bare 415.
  test("accepts a form-encoded device authorization request", async () => {
    const response = await app.fetch(
      new Request("https://auth.nikcli-ai.dev/oauth/device/code", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "nikcli" }),
      }),
      env(),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.user_code).toMatch(/^\d{4}-\d{4}$/)
    expect(body.verification_uri).toBe("https://auth.nikcli-ai.dev/device")
  })

  test("still rejects an unknown client on a form-encoded request", async () => {
    const response = await app.fetch(
      new Request("https://auth.nikcli-ai.dev/oauth/device/code", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "not-a-nikcli-client" }),
      }),
      env(),
    )

    expect(response.status).toBe(400)
  })

  test("redraws the user code when the generated one is already taken", async () => {
    // `device_codes.user_code` is UNIQUE and rows outlive their expiry, so a
    // freshly drawn eight-digit code can collide with one issued long ago. The
    // plain INSERT turned that into a 500 and "Failed to start device code
    // flow" in the terminal; the redraw is what keeps it a non-event.
    const attempted: string[] = []
    const db = {
      prepare(sql: string) {
        let values: unknown[] = []
        return {
          bind(...input: unknown[]) {
            values = input
            return this
          },
          async run() {
            if (sql.includes("DELETE FROM device_codes")) return { success: true, meta: { changes: 0 } }
            attempted.push(values[1] as string)
            // Refuse the first draw exactly as a UNIQUE conflict would.
            return { success: true, meta: { changes: attempted.length === 1 ? 0 : 1 } }
          },
        }
      },
    } as unknown as D1Database

    const response = await app.fetch(
      new Request("https://auth.nikcli-ai.dev/oauth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: "nikcli" }),
      }),
      env({ DB: db }),
    )

    expect(response.status).toBe(200)
    expect(attempted).toHaveLength(2)
    expect(attempted[0]).not.toBe(attempted[1])
    const body = (await response.json()) as Record<string, unknown>
    expect(body.user_code).toBe(attempted[1])
  })

  test("reports a device code it could not allocate instead of failing opaquely", async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return this
          },
          async run() {
            if (sql.includes("DELETE FROM device_codes")) return { success: true, meta: { changes: 0 } }
            return { success: true, meta: { changes: 0 } }
          },
        }
      },
    } as unknown as D1Database

    const response = await app.fetch(
      new Request("https://auth.nikcli-ai.dev/oauth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: "nikcli" }),
      }),
      env({ DB: db }),
    )

    expect(response.status).toBe(503)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: "temporarily_unavailable" })
  })

  /**
   * A user who has just clicked "Approve device" is not finished, and the page
   * they land on has to say so — closing it there is what leaves a terminal
   * polling a code nobody will approve.
   */
  test("tells a device approval that the terminal is not connected yet", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this
          },
          async first() {
            return {
              device_code_hash: "hash",
              user_code: "1234-5678",
              client_id: "nikcli",
              scope: "openid",
              status: "pending",
              account_id: null,
              expires_at: Date.now() + 60_000,
              last_poll_at: null,
              created_at: Date.now(),
            }
          },
          async run() {
            return { success: true, meta: { changes: 1 } }
          },
        }
      },
    } as unknown as D1Database

    const response = await app.fetch(
      new Request("https://auth.nikcli-ai.dev/device", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ user_code: "1234-5678", decision: "approve" }).toString(),
      }),
      env({ DB: db }),
    )

    expect(response.status).toBe(200)
    const page = await response.text()
    expect(page).toContain("Your terminal is not connected yet")
    expect(page).toContain("Continue with GitHub")
    // The generic headline would read as an unrelated detour here.
    expect(page).not.toContain("Sign in or create an account")
  })
})

describe("identity security helpers", () => {
  test("uses registered exact redirects with safe loopback development", () => {
    expect(isAllowedRedirect("nikcli-desktop", "nikcli://auth/callback")).toBe(true)
    expect(isAllowedRedirect("nikcli-web", "https://attacker.test/user/callback")).toBe(false)
    expect(isAllowedRedirect("nikcli-web", "http://127.0.0.1:4321/user/callback")).toBe(true)
  })

  test("generates unbiased decimal codes and compares fixed hashes", async () => {
    expect(randomDigits(64)).toMatch(/^\d{64}$/)
    const hash = await sha256("value")
    expect(await secureEqual(hash, hash)).toBe(true)
    expect(await secureEqual(await sha256("other"), hash)).toBe(false)
  })
})

describe("Content Security Policy", () => {
  // The login / email / device / result pages must lock down anything that can
  // exfiltrate data (img-src, font-src, frame-src, …) while still letting
  // browser extensions and userscripts run their own scripts on the page.
  // Without `script-src 'unsafe-inline'`, password managers and the nikcli TUI
  // webview hit "Refused to execute a script" console errors. The issuer
  // origin is also permitted in `script-src` so Cloudflare's
  // "challenge-platform" managed challenge / Turnstile can load. The matching
  // `connect-src 'self'` lets the challenge round-trip its solved token back
  // to the issuer origin via `fetch` — without it, Cloudflare's challenge
  // POSTs hit "Refused to connect".
  // WebAuthn reports "you dismissed the prompt" and "this device holds no
  // passkey for us" as the same NotAllowedError, on purpose, so a site cannot
  // probe which credentials exist. Returning early on it left a phone whose
  // passkey lives in another vendor's keychain — an iCloud passkey opened on
  // Android — with a button that did nothing and said nothing.
  test("the sign-in page answers a NotAllowedError instead of swallowing it", async () => {
    const authUrl =
      "https://auth.nikcli-ai.dev/authorize?response_type=code" +
      "&client_id=nikcli-studio" +
      "&redirect_uri=https%3A%2F%2Fnikcli-ai.dev%2Fdashboard%2Fcallback" +
      "&state=opaque&code_challenge=" +
      "a".repeat(43) +
      "&code_challenge_method=S256"
    const html = await (await app.fetch(new Request(authUrl), env())).text()

    // The old shape: NotAllowedError shared AbortError's bare `return`.
    expect(html).not.toMatch(/NotAllowedError"\s*\|\|\s*name === "AbortError"\) return/)
    expect(html).toMatch(/name === "NotAllowedError"/)
    // Whatever it says must name the two ways forward the page still offers.
    const branch = html.slice(html.indexOf('name === "NotAllowedError"'))
    expect(branch.slice(0, 700)).toMatch(/GitHub/)
    expect(branch.slice(0, 700)).toMatch(/email code/)
    // ...and must not be dressed as a failure: `.notice` alone renders red.
    expect(html).toMatch(/notice hint/)
    expect(html).toMatch(/\.notice\.hint\{/)
  })

  test("HTML pages carry a strict CSP that allows inline scripts, the issuer origin, and self-fetch", async () => {
    const authUrl =
      "https://auth.nikcli-ai.dev/authorize?response_type=code" +
      "&client_id=nikcli-studio" +
      "&redirect_uri=https%3A%2F%2Fnikcli-ai.dev%2Fdashboard%2Fcallback" +
      "&state=opaque&code_challenge=" +
      "a".repeat(43) +
      "&code_challenge_method=S256"
    const response = await app.fetch(new Request(authUrl), env())
    expect(response.status).toBe(200)
    const csp = response.headers.get("Content-Security-Policy") ?? ""
    expect(csp).toMatch(/default-src 'none'/)
    expect(csp).toMatch(/script-src 'unsafe-inline' https:\/\/auth\.nikcli-ai\.dev/)
    expect(csp).toMatch(/style-src 'nonce-/)
    expect(csp).toMatch(/connect-src 'self'/)
    expect(csp).toMatch(/form-action 'self'/)
    expect(csp).toMatch(/base-uri 'none'/)
    expect(csp).toMatch(/frame-ancestors 'none'/)
    // No directive should grant a *third-party* network endpoint for fetch.
    expect(csp).not.toMatch(/connect-src[^;]*https?:\/\//)
  })

  test("502 'Sign-in failed' pages carry the same CSP as the login page", async () => {
    const target = env({ DB: permissiveDb() })
    const loginState = await bootstrapLoginState(target)
    const stub = stubFetch(() => new Response("boom", { status: 503 }))
    try {
      const response = await app.fetch(
        new Request(`https://auth.nikcli-ai.dev/callback/github?code=abc&state=${encodeURIComponent(loginState)}`),
        target,
      )
      expect(response.status).toBe(502)
      const csp = response.headers.get("Content-Security-Policy") ?? ""
      expect(csp).toMatch(/script-src 'unsafe-inline' https:\/\/auth\.nikcli-ai\.dev/)
      expect(csp).toMatch(/connect-src 'self'/)
      expect(csp).toMatch(/default-src 'none'/)
    } finally {
      stub.restore()
    }
  })

  test("Staging uses its own origin in the CSP allowlist", async () => {
    const response = await app.fetch(
      new Request(
        "https://dev.auth.nikcli-ai.dev/authorize?response_type=code" +
          "&client_id=nikcli-studio" +
          "&redirect_uri=https%3A%2F%2Fnikcli-ai.dev%2Fdashboard%2Fcallback" +
          "&state=opaque&code_challenge=" +
          "a".repeat(43) +
          "&code_challenge_method=S256",
      ),
      env({ ISSUER: "https://dev.auth.nikcli-ai.dev" }),
    )
    expect(response.status).toBe(200)
    const csp = response.headers.get("Content-Security-Policy") ?? ""
    expect(csp).toMatch(/script-src 'unsafe-inline' https:\/\/dev\.auth\.nikcli-ai\.dev/)
    expect(csp).toMatch(/connect-src 'self'/)
  })
})

describe("GitHub OAuth redirect_uri", () => {
  test("defaults to ${ISSUER}/callback/github for every environment", () => {
    expect(githubRedirectURI({ ISSUER: "https://auth.nikcli-ai.dev" })).toBe("https://auth.nikcli-ai.dev/callback/github")
    expect(githubRedirectURI({ ISSUER: "https://dev.auth.nikcli-ai.dev" })).toBe(
      "https://dev.auth.nikcli-ai.dev/callback/github",
    )
  })

  test("honors GITHUB_REDIRECT_URI when an operator pins a different registered callback", () => {
    expect(
      githubRedirectURI({
        ISSUER: "https://auth.nikcli-ai.dev",
        GITHUB_REDIRECT_URI: "https://nikcli-ai.dev/api/auth/callback/github",
      }),
    ).toBe("https://nikcli-ai.dev/api/auth/callback/github")
  })

  test("falls back to the computed default when GITHUB_REDIRECT_URI is blank", () => {
    expect(
      githubRedirectURI({
        ISSUER: "https://auth.nikcli-ai.dev",
        GITHUB_REDIRECT_URI: "   ",
      }),
    ).toBe("https://auth.nikcli-ai.dev/callback/github")
  })

  test("/login/github redirects to GitHub with the exact same redirect_uri it will send back", async () => {
    // Bootstrap a valid login_state so startGitHub doesn't 400.
    const shared = env()
    const init = await app.fetch(
      new Request(
        "https://auth.nikcli-ai.dev/authorize?response_type=code&client_id=nikcli-studio" +
          "&redirect_uri=https%3A%2F%2Fnikcli-ai.dev%2Fdashboard%2Fcallback" +
          "&state=opaque&code_challenge=" +
          "a".repeat(43) +
          "&code_challenge_method=S256",
      ),
      shared,
    )
    expect(init.status).toBe(200)
    const loginState = (await init.text()).match(/login_state=([^"]+)"/)?.[1] ?? ""
    expect(loginState).not.toBe("")

    const start = await app.fetch(
      new Request(`https://auth.nikcli-ai.dev/login/github?login_state=${encodeURIComponent(loginState)}`),
      shared,
    )
    expect(start.status).toBe(302)
    const location = start.headers.get("location") ?? ""
    const redirected = new URL(location)
    expect(redirected.origin).toBe("https://github.com")
    expect(redirected.pathname).toBe("/login/oauth/authorize")
    expect(redirected.searchParams.get("client_id")).toBe("test-client")
    expect(redirected.searchParams.get("redirect_uri")).toBe("https://auth.nikcli-ai.dev/callback/github")
    expect(redirected.searchParams.get("scope")).toBe("read:user user:email")
    expect(redirected.searchParams.get("state")).toBe(loginState)
  })

  test("/login/github uses GITHUB_REDIRECT_URI when the operator pins the GitHub OAuth app's callback", async () => {
    const shared = env({
      GITHUB_REDIRECT_URI: "https://nikcli-ai.dev/api/auth/callback/github",
    })
    const init = await app.fetch(
      new Request(
        "https://auth.nikcli-ai.dev/authorize?response_type=code&client_id=nikcli-studio" +
          "&redirect_uri=https%3A%2F%2Fnikcli-ai.dev%2Fdashboard%2Fcallback" +
          "&state=opaque&code_challenge=" +
          "a".repeat(43) +
          "&code_challenge_method=S256",
      ),
      shared,
    )
    expect(init.status).toBe(200)
    const loginState = (await init.text()).match(/login_state=([^"]+)"/)?.[1] ?? ""
    expect(loginState).not.toBe("")

    const start = await app.fetch(
      new Request(`https://auth.nikcli-ai.dev/login/github?login_state=${encodeURIComponent(loginState)}`),
      shared,
    )
    expect(start.status).toBe(302)
    const location = start.headers.get("location") ?? ""
    expect(new URL(location).searchParams.get("redirect_uri")).toBe("https://nikcli-ai.dev/api/auth/callback/github")
  })
})

/**
 * A small in-memory D1 stand-in that supports the handful of statements
 * `linkAccount` issues. It mirrors the production schema column-for-column so
 * the upserts in `linkAccount` behave like they do on Cloudflare. The store
 * persists across `bind()`/`.first()`/`.all()`/`.run()` calls inside a single
 * `linkAccount` invocation so PK collisions and the "find existing" branch
 * are exercised.
 */
function permissiveDb(): D1Database {
  type AccountRow = {
    id: string
    email: string
    created_at: number
    updated_at: number
    disabled_at: number | null
  }
  type AuthMethodRow = {
    id: string
    account_id: string
    provider: string
    subject: string
  }
  type PendingBind = {
    sql: string
    params: unknown[]
  }

  const accounts = new Map<string, AccountRow>()
  const accountsByEmail = new Map<string, AccountRow>()
  const methodsByKey = new Map<string, AuthMethodRow>()
  // `db.batch([...statements])` is an array of `D1PreparedStatement` whose
  // bound values are not exposed on the type. We capture them inside `prepare`
  // so `batch` can replay each statement end-to-end.
  const pendingBatch: PendingBind[] = []

  function lookupAccountLink(provider: string, subject: string): AccountRow | null {
    const method = methodsByKey.get(`${provider}:${subject}`)
    if (!method) return null
    return accounts.get(method.account_id) ?? null
  }

  function buildStatement(sql: string) {
    return {
      bind(...values: unknown[]) {
        const params = values
        const handle = {
          _sql: sql,
          _params: params,
          async first<T>(): Promise<T | null> {
            const s = sql.trim()
            if (
              s.startsWith(
                "SELECT a.id, a.email, a.created_at, a.updated_at, a.disabled_at FROM accounts a JOIN auth_methods",
              )
            ) {
              const found = lookupAccountLink(String(params[0]), String(params[1]))
              return (found as T | null) ?? null
            }
            if (s.startsWith("SELECT id, email, created_at, updated_at, disabled_at FROM accounts WHERE email =")) {
              const found = accountsByEmail.get(String(params[0]).toLowerCase()) ?? null
              return (found as T | null) ?? null
            }
            return null
          },
          async all<T>(): Promise<{ results: T[] }> {
            return { results: [] }
          },
          async run(): Promise<{
            success: boolean
            meta: { changes: number }
          }> {
            const s = sql.trim()
            if (s.startsWith("INSERT OR IGNORE INTO accounts")) {
              const id = String(params[0])
              const email = String(params[1]).toLowerCase()
              const createdAt = Number(params[2])
              const updatedAt = Number(params[3])
              if (!accounts.has(id)) {
                const row: AccountRow = {
                  id,
                  email,
                  created_at: createdAt,
                  updated_at: updatedAt,
                  disabled_at: null,
                }
                accounts.set(id, row)
                accountsByEmail.set(email, row)
                return { success: true, meta: { changes: 1 } }
              }
              return { success: true, meta: { changes: 0 } }
            }
            if (s.startsWith("INSERT OR IGNORE INTO auth_methods")) {
              const id = String(params[0])
              const accountId = String(params[1])
              const provider = String(params[2])
              const subject = String(params[3])
              const key = `${provider}:${subject}`
              if (!methodsByKey.has(key)) {
                methodsByKey.set(key, {
                  id,
                  account_id: accountId,
                  provider,
                  subject,
                })
                return { success: true, meta: { changes: 1 } }
              }
              return { success: true, meta: { changes: 0 } }
            }
            if (s.startsWith("UPDATE accounts SET updated_at =")) {
              const updatedAt = Number(params[0])
              const id = String(params[1])
              const row = accounts.get(id)
              if (row) row.updated_at = updatedAt
              return { success: true, meta: { changes: row ? 1 : 0 } }
            }
            throw new Error(`Unexpected SQL in permissiveDb: ${s}`)
          },
        }
        // Snapshot for the eventual `batch()` call. The production code calls
        // `db.batch([stmt1, stmt2, stmt3])` where each `stmt` is the result of
        // `bind(...)`. We don't get the bound values back from the typed
        // D1PreparedStatement, so we pull them straight off the helper we
        // built and replay them through `buildStatement` below.
        pendingBatch.push({ sql, params })
        return handle as unknown as D1PreparedStatement
      },
    }
  }

  return {
    prepare(sql: string) {
      return buildStatement(sql)
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      // `db.batch([stmt1, stmt2, stmt3])` is called with statements that have
      // already had `bind()` invoked. We can't read the bound values back off
      // the typed `D1PreparedStatement`, so `bind()` snapshots them onto
      // `pendingBatch` whenever it's called. Since `linkAccount` always binds
      // its batch arguments immediately before calling `db.batch`, the most
      // recent `statements.length` entries of `pendingBatch` correspond to
      // those arguments — we drain exactly that many and replay them.
      const take = statements.length
      const drained = pendingBatch.splice(pendingBatch.length - take, take)
      const results: D1Result<T>[] = []
      for (const record of drained) {
        const built = buildStatement(record.sql).bind(...record.params) as unknown as {
          run(): Promise<D1Result<T>>
        }
        results.push(await built.run())
      }
      return results
    },
  } as unknown as D1Database
}

async function bootstrapLoginState(target: Env): Promise<string> {
  const init = await app.fetch(
    new Request(
      "https://auth.nikcli-ai.dev/authorize?response_type=code&client_id=nikcli-studio" +
        "&redirect_uri=https%3A%2F%2Fnikcli-ai.dev%2Fdashboard%2Fcallback" +
        "&state=opaque&code_challenge=" +
        "a".repeat(43) +
        "&code_challenge_method=S256",
    ),
    target,
  )
  expect(init.status).toBe(200)
  const loginState = (await init.text()).match(/login_state=([^"]+)"/)?.[1] ?? ""
  expect(loginState).not.toBe("")
  return loginState
}

interface FetchCall {
  url: string
  init?: RequestInit
}

interface FetchStub {
  calls: FetchCall[]
  restore(): void
}

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchStub {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    return handler({ url, init })
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

describe("GitHub OAuth callback (/callback/github)", () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns 503 with a friendly page when the worker is missing GITHUB_CLIENT_ID", async () => {
    const target = env({
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "test-secret",
      DB: permissiveDb(),
    })
    const response = await app.fetch(
      new Request("https://auth.nikcli-ai.dev/callback/github?code=abc&state=anything"),
      target,
    )
    expect(response.status).toBe(503)
    const body = await response.text()
    expect(body).toContain("Sign-in unavailable")
    expect(body).toContain("GitHub sign-in is not configured")
  })

  test("returns 503 with the same page when the worker is missing GITHUB_CLIENT_SECRET", async () => {
    const target = env({
      GITHUB_CLIENT_ID: "test-client",
      GITHUB_CLIENT_SECRET: "",
      DB: permissiveDb(),
    })
    const response = await app.fetch(
      new Request("https://auth.nikcli-ai.dev/callback/github?code=abc&state=anything"),
      target,
    )
    expect(response.status).toBe(503)
    const body = await response.text()
    expect(body).toContain("Sign-in unavailable")
  })

  test("returns 400 'Sign-in failed' when the callback state has no matching login intent", async () => {
    const target = env({ DB: permissiveDb() })
    const response = await app.fetch(
      new Request("https://auth.nikcli-ai.dev/callback/github?code=abc&state=never-issued"),
      target,
    )
    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain("Sign-in failed")
    expect(body).toContain("invalid or expired")
  })

  test("returns 502 'GitHub rejected the authorization code' when the token exchange HTTP status is not 2xx", async () => {
    const target = env({ DB: permissiveDb() })
    const loginState = await bootstrapLoginState(target)
    const stub = stubFetch(() => new Response("boom", { status: 503 }))
    try {
      const response = await app.fetch(
        new Request(`https://auth.nikcli-ai.dev/callback/github?code=abc&state=${encodeURIComponent(loginState)}`),
        target,
      )
      expect(response.status).toBe(502)
      const body = await response.text()
      expect(body).toContain("GitHub rejected the authorization code (503)")
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0].url).toBe("https://github.com/login/oauth/access_token")
    } finally {
      stub.restore()
    }
  })

  test("returns 502 with GitHub's error_description when the token exchange yields no access_token", async () => {
    const target = env({ DB: permissiveDb() })
    const loginState = await bootstrapLoginState(target)
    const stub = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "bad_verification_code",
            error_description: "code expired",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    )
    try {
      const response = await app.fetch(
        new Request(`https://auth.nikcli-ai.dev/callback/github?code=abc&state=${encodeURIComponent(loginState)}`),
        target,
      )
      expect(response.status).toBe(502)
      const body = await response.text()
      expect(body).toContain("GitHub did not issue an access token")
      expect(body).toContain("code expired")
    } finally {
      stub.restore()
    }
  })

  test("returns 502 with the actual upstream status when the /user API fails", async () => {
    const target = env({ DB: permissiveDb() })
    const loginState = await bootstrapLoginState(target)
    const stub = stubFetch((call) => {
      if (call.url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("forbidden", { status: 403 })
    })
    try {
      const response = await app.fetch(
        new Request(`https://auth.nikcli-ai.dev/callback/github?code=abc&state=${encodeURIComponent(loginState)}`),
        target,
      )
      expect(response.status).toBe(502)
      const body = await response.text()
      // The message now includes the actual upstream status for both /user
      // and /user/emails, plus a hint about whether the token was rejected.
      expect(body).toContain("user=403")
      expect(body).toContain("emails=403")
      expect(body).toMatch(/try again in a moment/i)
      expect(body).toMatch(/oauth token was rejected|rate-limited|outage/i)
      expect(stub.calls.map((c) => c.url)).toEqual([
        "https://github.com/login/oauth/access_token",
        "https://api.github.com/user",
        "https://api.github.com/user/emails",
      ])
    } finally {
      stub.restore()
    }
  })

  test("returns 400 'Verified email required' when the GitHub user has no verified primary email", async () => {
    const target = env({ DB: permissiveDb() })
    const loginState = await bootstrapLoginState(target)
    const stub = stubFetch((call) => {
      if (call.url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (call.url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ id: 12345 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify([{ email: "noreply@github.com", primary: false, verified: true }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    try {
      const response = await app.fetch(
        new Request(`https://auth.nikcli-ai.dev/callback/github?code=abc&state=${encodeURIComponent(loginState)}`),
        target,
      )
      expect(response.status).toBe(400)
      const body = await response.text()
      expect(body).toContain("Verified email required")
    } finally {
      stub.restore()
    }
  })

  test("returns 502 'GitHub returned a profile without an id' when the user payload omits id", async () => {
    const target = env({ DB: permissiveDb() })
    const loginState = await bootstrapLoginState(target)
    const stub = stubFetch((call) => {
      if (call.url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (call.url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ login: "no-id" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify([{ email: "user@example.com", primary: true, verified: true }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    try {
      const response = await app.fetch(
        new Request(`https://auth.nikcli-ai.dev/callback/github?code=abc&state=${encodeURIComponent(loginState)}`),
        target,
      )
      expect(response.status).toBe(502)
      const body = await response.text()
      expect(body).toContain("GitHub returned a profile without an id")
    } finally {
      stub.restore()
    }
  })

  test("completes the happy path: passkey offer then 302 redirect to the client callback", async () => {
    const target = env({ DB: permissiveDb() })
    const loginState = await bootstrapLoginState(target)
    const stub = stubFetch((call) => {
      if (call.url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (call.url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ id: 4242, login: "octocat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify([{ email: "octo@example.com", primary: true, verified: true }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    try {
      const response = await app.fetch(
        new Request(`https://auth.nikcli-ai.dev/callback/github?code=abc&state=${encodeURIComponent(loginState)}`),
        target,
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("Save a passkey")

      const skipped = await app.fetch(
        new Request("https://auth.nikcli-ai.dev/login/passkey/skip", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ login_state: loginState }).toString(),
        }),
        target,
      )
      expect(skipped.status).toBe(302)
      const location = skipped.headers.get("location") ?? ""
      const redirected = new URL(location)
      expect(redirected.origin + redirected.pathname).toBe("https://nikcli-ai.dev/dashboard/callback")
      expect(redirected.searchParams.get("state")).toBe("opaque")
      const code = redirected.searchParams.get("code") ?? ""
      expect(code).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    } finally {
      stub.restore()
    }
  })
})
