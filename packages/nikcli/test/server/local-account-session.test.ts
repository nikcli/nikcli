import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, describe, expect, it, spyOn } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SignJWT } from "jose"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-local-account-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_TEST_MODE = "1"
process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
// Deliberately *not* NIKCLI_REQUIRE_OAUTH: this is the default desktop shape,
// where the terminal talks to an in-process server with no password set.
process.env.NIKCLI_AUTH_ISSUER = "https://auth.test"
process.env.NIKCLI_AUTH_AUDIENCE = "nikcli-api"
process.env.NIKCLI_AUTH_JWT_SECRET = "test-secret-that-is-long-enough-for-hs256"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_TEST_MODE",
  "NIKCLI_DISABLE_MODELS_FETCH",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "NIKCLI_AUTH_ISSUER",
  "NIKCLI_AUTH_AUDIENCE",
  "NIKCLI_AUTH_JWT_SECRET",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])
for (const dir of ["data", "cache", "config", "state"]) {
  await fs.mkdir(path.join(testHome, dir), { recursive: true })
}

const { Instance } = await import("@/project/instance")
const { Server } = await import("@/server/server")
const { Auth } = await import("@/server/httpapi/auth")
const { ServerRouter } = await import("@/server/server-router")
const { AccountRepo } = await import("@/account/repo")
const { Database } = await import("@/database/database")
const { users } = await import("@/user/users.sql")
const { eq } = await import("drizzle-orm")

const ACCOUNT_ID = "acc_localsession"
const EMAIL = "owner@example.com"

function jwt(expiresInSeconds: number, account: { id: string; email: string } = { id: ACCOUNT_ID, email: EMAIL }) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ email: account.email, client_id: "nikcli" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("https://auth.test")
    .setAudience("nikcli-api")
    .setSubject(account.id)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(new TextEncoder().encode(process.env.NIKCLI_AUTH_JWT_SECRET!))
}

/** As the TUI calls it: in-process, no socket, bearer read from the token file. */
function request(pathname: string, token?: string) {
  return Server.fetch(
    new Request(`http://nikcli.local${pathname}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    }),
  )
}

/**
 * As the TUI calls it *since the background service became the default*: over a
 * real socket, on a listener bound to loopback. `server` is what separates this
 * from `Server.fetch`, and it is the only argument the router looks at besides
 * the hostname it was built for.
 */
function overListener(hostname: string, pathname: string, token?: string) {
  const handler = ServerRouter.make({
    fallback: (request) => Server.fetch(request),
    listenHostname: hostname,
  })
  return handler(
    new Request(`http://127.0.0.1:4096${pathname}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    }),
    {} as never,
  )
}

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await removeTestDir(testHome)
})

/**
 * The terminal's stored bearer is a snapshot of a fifteen-minute issuer token,
 * while the account row beside it refreshes itself. Once the snapshot aged out,
 * `/user/me` answered 401, the TUI read "signed out" and opened the sign-in
 * dialog on every launch for someone who had never signed out.
 */
describe("local account session", () => {
  it("reports no session when the machine has no account", async () => {
    expect((await request("/user/me", await jwt(-60))).status).toBe(401)
    expect((await request("/user/me")).status).toBe(401)
  })

  it("answers /user/me from the machine's account when the caller's token expired", async () => {
    AccountRepo.persistAccount(ACCOUNT_ID, EMAIL, "https://auth.test", await jwt(900), "refresh-token" as never, 900)

    const response = await request("/user/me", await jwt(-60))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { email: string }).email).toBe(EMAIL)
  })

  it("answers /user/me with no bearer at all", async () => {
    const response = await request("/user/me")
    expect(response.status).toBe(200)
    expect(((await response.json()) as { email: string }).email).toBe(EMAIL)
  })

  it("reports the active account to /account with an expired bearer", async () => {
    const response = await request("/account", await jwt(-60))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { email: string } | null)?.email).toBe(EMAIL)
  })

  it("answers over the background service's loopback socket", async () => {
    // The regression this guards: the fallback originally required "no
    // `Bun.Server`", but the default TUI stopped being in-process when the
    // background service landed — it dials a loopback listener, so every
    // launch past the token's fifteen minutes reopened the sign-in dialog.
    const response = await overListener("127.0.0.1", "/user/me", await jwt(-60))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { email: string }).email).toBe(EMAIL)
  })

  it("does not answer on a listener that is reachable from off the machine", async () => {
    // The gate is the *listener*, never the peer: a server bound to every
    // interface has callers this machine does not vouch for, so an expired
    // bearer stays expired there.
    expect((await overListener("0.0.0.0", "/user/me", await jwt(-60))).status).toBe(401)
    const account = await overListener("0.0.0.0", "/account", await jwt(-60))
    expect(await account.json()).toBeNull()
  })

  it("never falls back for a request that crossed a socket", async () => {
    // `Auth.markLocal` is the whole gate, and only `ServerRouter` sets it. An
    // unmarked request is one this machine does not vouch for, and it gets the
    // pre-existing answer: nothing.
    const remote = new Request("http://nikcli.local/user/me")
    expect(Auth.isLocal(remote)).toBe(false)
    expect(await Auth.sessionFor(remote)).toBeNull()
  })
})

/**
 * The background service always has a password, and its loopback socket is
 * reachable by every local user and any page a browser opens. The password —
 * not the socket — is what makes a caller this machine's operator.
 */
describe("a password-protected loopback server", () => {
  const PASSWORD = "operator-secret"
  const basic = `Basic ${btoa(`nikcli:${PASSWORD}`)}`

  function overService(pathname: string, init: RequestInit = {}) {
    const handler = ServerRouter.make({
      fallback: (request) => Server.fetch(request),
      listenHostname: "127.0.0.1",
    })
    return handler(new Request(`http://127.0.0.1:4096${pathname}`, init), {} as never)
  }

  async function withPassword(fn: () => Promise<void>) {
    Auth.useServicePassword(PASSWORD)
    try {
      await fn()
    } finally {
      Auth.useServicePassword("")
    }
  }

  it("keeps the machine's account from a caller without the password", async () => {
    await withPassword(async () => {
      expect((await overService("/account")).status).toBe(401)
      expect((await overService("/user/me", { headers: { authorization: `Bearer ${await jwt(-60)}` } })).status).toBe(
        401,
      )
    })
  })

  it("answers the operator, who presents the password the way the TUI does", async () => {
    // Basic in the header, the stored bearer as `?token=` — what
    // `BackgroundService.authorizedFetch` sends.
    await withPassword(async () => {
      const account = await overService("/account", { headers: { authorization: basic } })
      expect(account.status).toBe(200)
      expect(((await account.json()) as { email: string } | null)?.email).toBe(EMAIL)

      const me = await overService(`/user/me?token=${await jwt(-60)}`, { headers: { authorization: basic } })
      expect(me.status).toBe(200)
      expect(((await me.json()) as { email: string }).email).toBe(EMAIL)
    })
  })

  it("does not let a user's bearer stand in for the operator on the machine's account", async () => {
    // A valid bearer identifies a user; `/account` reads and replaces this
    // machine's own account, which is the operator's to do.
    await withPassword(async () => {
      const bearer = { authorization: `Bearer ${await jwt(900)}` }
      expect((await overService("/account", { headers: bearer })).status).toBe(401)
      expect((await overService("/account/login", { method: "POST", headers: bearer })).status).toBe(401)
      expect((await overService("/account/login/complete", { method: "POST", headers: bearer })).status).toBe(401)
    })
  })

  it("does not let a caller without the password register a user on the machine's authority", async () => {
    // Registration past the first user needs an admin session. Answering it
    // from the machine's account for anyone on the socket let them mint a user
    // whose bearer the server then admits without the password. The machine's
    // account is admin whenever it was the database's first identity or is
    // on the admin allowlist — the usual single-owner machine.
    Database.syncDb().update(users).set({ role: "admin" }).where(eq(users.email, EMAIL)).run()
    await withPassword(async () => {
      const response = await overService("/user/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "intruder", email: "intruder@example.com", password: "Intruder-1!" }),
      })
      expect(response.status).toBe(403)
      const login = await overService("/user/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "intruder@example.com", password: "Intruder-1!" }),
      })
      expect(login.status).toBe(401)
    })
  })

  it("treats a loopback caller as this machine's operator only once it presents the password", async () => {
    await withPassword(async () => {
      const marked: Request[] = []
      const mark = spyOn(Auth, "markLocal").mockImplementation((request) => void marked.push(request))
      try {
        await overService("/user/status")
        expect(marked).toHaveLength(0)
        await overService("/user/status", { headers: { authorization: "Basic " + btoa("nikcli:wrong") } })
        expect(marked).toHaveLength(0)
        await overService("/user/status", { headers: { authorization: basic } })
        expect(marked).toHaveLength(1)
      } finally {
        mark.mockRestore()
      }
    })
  })

  it("still serves health and preflight to anyone", async () => {
    await withPassword(async () => {
      expect((await overService("/global/health")).status).toBe(200)
      expect((await overService("/account", { method: "OPTIONS" })).status).toBe(204)
    })
  })
})

/**
 * Keeping the machine signed in needs the network, and how a refresh *fails*
 * decides whether the sign-in dialog is honest. An issuer that answers "this
 * chain is over" ends the session; an issuer that cannot be reached has said
 * nothing, and reading that as signed out is what greeted a signed-in user
 * with the sign-in chooser on launch.
 */
describe("refreshing the machine's session", () => {
  type Issuer = {
    url: string
    calls: number
    stop: () => void
  }

  /** The `POST {account.url}oauth/token` endpoint `Account.token` refreshes against. */
  function issuer(reply: () => Response | Promise<Response>): Issuer {
    const state = { calls: 0 }
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        if (new URL(request.url).pathname !== "/oauth/token") return new Response("not found", { status: 404 })
        state.calls++
        return reply()
      },
    })
    return {
      url: `http://127.0.0.1:${server.port}/`,
      get calls() {
        return state.calls
      },
      stop: () => server.stop(true),
    }
  }

  /**
   * A machine that signed in and whose access token has since aged out: the
   * account row is active with an expired token, and the local user row beside
   * it is the one the sign-in provisioned.
   */
  async function signedIn(account: { id: string; email: string }, url: string) {
    AccountRepo.persistAccount(account.id, account.email, url, await jwt(-60, account), "refresh-1" as never, -60)
    const provisioned = await request("/user/me", await jwt(900, account))
    expect(provisioned.status).toBe(200)
  }

  it("refreshes the stored pair and answers from the new token", async () => {
    const account = { id: "acc_refresh_ok", email: "refresh-ok@example.com" }
    const auth = issuer(async () =>
      Response.json({
        access_token: await jwt(900, account),
        refresh_token: "refresh-2",
        expires_in: 900,
        token_type: "Bearer",
      }),
    )
    try {
      await signedIn(account, auth.url)

      const response = await request("/user/me")
      expect(response.status).toBe(200)
      expect(((await response.json()) as { email: string }).email).toBe(account.email)
      expect(auth.calls).toBe(1)
      // The rotated token has to land in the row, or the next launch presents
      // the spent one and the issuer revokes the whole family.
      expect(AccountRepo.getRow(account.id)?.refresh_token).toBe("refresh-2")
    } finally {
      auth.stop()
    }
  })

  it("stays signed in when the issuer cannot be reached", async () => {
    const account = { id: "acc_refresh_offline", email: "refresh-offline@example.com" }
    const closed = issuer(() => new Response("unused"))
    const url = closed.url
    closed.stop()
    await signedIn(account, url)

    const response = await request("/user/me")
    expect(response.status).toBe(200)
    expect(((await response.json()) as { email: string }).email).toBe(account.email)
  })

  it("never spends the refresh token while another process holds the claim", async () => {
    // Two nikcli processes — an installed TUI and a dev build, a background
    // service and a `nikcli` command — read the same row. Whichever posts the
    // token second gets the family revoked and signs the machine out for good,
    // so a claim held elsewhere means this one does not post at all.
    const account = { id: "acc_refresh_claimed", email: "refresh-claimed@example.com" }
    const auth = issuer(async () =>
      Response.json({
        access_token: await jwt(900, account),
        refresh_token: "refresh-2",
        expires_in: 900,
        token_type: "Bearer",
      }),
    )
    try {
      await signedIn(account, auth.url)
      const claim = path.join(testHome, "state", `account-refresh-${account.id}.lock`)
      await fs.mkdir(path.dirname(claim), { recursive: true })
      await Bun.write(claim, JSON.stringify({ pid: 4, at: Date.now() }))

      // Still signed in — from the account row, which is what "could not
      // renew" should cost, rather than the sign-in dialog.
      const response = await request("/user/me")
      expect(auth.calls).toBe(0)
      expect(response.status).toBe(200)
      expect(AccountRepo.getRow(account.id)?.refresh_token).toBe("refresh-1")
      await fs.unlink(claim)
    } finally {
      auth.stop()
    }
  })

  it("reports signed out when the issuer rejects the refresh token", async () => {
    // The one failure that really is a signed-out machine: a refresh token the
    // issuer says is spent or revoked cannot be recovered without a new
    // sign-in, so the dialog is the right answer here and only here.
    const account = { id: "acc_refresh_dead", email: "refresh-dead@example.com" }
    const auth = issuer(() => Response.json({ error: "invalid_grant" }, { status: 400 }))
    try {
      await signedIn(account, auth.url)
      expect((await request("/user/me")).status).toBe(401)
    } finally {
      auth.stop()
    }
  })
})
