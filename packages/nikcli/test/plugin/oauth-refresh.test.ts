import { afterEach, describe, expect, it } from "bun:test"
import path from "path"
import { Global } from "@nikcli-ai/util/global"
import { CodexAuthPlugin } from "@/plugin/codex"
import { ProviderOAuth } from "@/plugin/oauth-refresh"
import { XAIAuthPlugin } from "@/plugin/xai"
import { FileLock } from "@/util/file-lock"

// Both ChatGPT and SuperGrok rotate the refresh token on every use and refuse
// it the second time. Every test here is some way of presenting a spent token,
// and what it checks is that nikcli no longer does.

const HOUR = 60 * 60 * 1000

function jwt(exp: number) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "none" })}.${part({ exp: Math.floor(exp / 1000) })}.sig`
}

function store(initial: ProviderOAuth.Stored) {
  let current: ProviderOAuth.Stored = initial
  return {
    get current() {
      return current
    },
    set(next: ProviderOAuth.Stored) {
      current = next
    },
    read: async () => ({ ...current }),
  }
}

let seq = 0
const uniqueID = () => `oauth-refresh-test-${process.pid}-${Date.now()}-${seq++}`

describe("ProviderOAuth.expiring", () => {
  const now = 1_000_000_000_000

  it("renews ahead of the deadline, not after it", () => {
    expect(ProviderOAuth.expiring({ access: "a", expires: now + HOUR }, now)).toBe(false)
    expect(ProviderOAuth.expiring({ access: "a", expires: now + 60_000 }, now)).toBe(true)
    expect(ProviderOAuth.expiring({ access: "a", expires: now - 1 }, now)).toBe(true)
  })

  it("treats a missing token or deadline as expired", () => {
    expect(ProviderOAuth.expiring({ access: "", expires: now + HOUR }, now)).toBe(true)
    expect(ProviderOAuth.expiring({ access: "a", expires: 0 }, now)).toBe(true)
  })

  it("honours a JWT's own exp over an optimistic stored deadline", () => {
    expect(ProviderOAuth.expiring({ access: jwt(now + 30_000), expires: now + HOUR }, now)).toBe(true)
    expect(ProviderOAuth.expiring({ access: jwt(now + HOUR), expires: now + HOUR }, now)).toBe(false)
  })
})

describe("ProviderOAuth.renew", () => {
  it("spends the refresh token once for concurrent callers", async () => {
    const auth = store({ type: "oauth", access: "old", refresh: "r1", expires: Date.now() - 1 })
    const spent: string[] = []
    const options: ProviderOAuth.RenewOptions = {
      providerID: uniqueID(),
      read: auth.read,
      async exchange(stored) {
        spent.push(stored.refresh)
        await Bun.sleep(20)
        return { access: "new", refresh: "r2", expires: Date.now() + HOUR }
      },
      async write(tokens) {
        auth.set({ type: "oauth", ...tokens })
      },
    }

    const results = await Promise.all([1, 2, 3, 4].map(() => ProviderOAuth.renew(options)))

    expect(spent).toEqual(["r1"])
    expect(results.map((r) => r.access)).toEqual(["new", "new", "new", "new"])
    expect(auth.current.refresh).toBe("r2")
  })

  it("uses a pair someone else already stored instead of spending it again", async () => {
    // What a second process sees once it gets the claim: the store has moved on.
    const auth = store({ type: "oauth", access: "fresh", refresh: "r2", expires: Date.now() + HOUR })
    let exchanged = 0
    const result = await ProviderOAuth.renew({
      providerID: uniqueID(),
      read: auth.read,
      async exchange() {
        exchanged++
        return { access: "x", refresh: "x", expires: Date.now() + HOUR }
      },
      async write() {},
    })
    expect(exchanged).toBe(0)
    expect(result.access).toBe("fresh")
  })

  it("renews a token the provider rejected, unless it was already replaced", async () => {
    const auth = store({ type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + HOUR })
    let exchanged = 0
    const options = (rejected: string): ProviderOAuth.RenewOptions => ({
      providerID: uniqueID(),
      read: auth.read,
      rejected,
      async exchange(stored) {
        exchanged++
        return { access: `a-after-${stored.refresh}`, refresh: "r2", expires: Date.now() + HOUR }
      },
      async write(tokens) {
        auth.set({ type: "oauth", ...tokens })
      },
    })

    expect((await ProviderOAuth.renew(options("a1"))).access).toBe("a-after-r1")
    expect(exchanged).toBe(1)

    // A late 401 for the token that was just replaced must not rotate again.
    expect((await ProviderOAuth.renew(options("a1"))).access).toBe("a-after-r1")
    expect(exchanged).toBe(1)
  })

  it("never re-spends a refresh token whose rotated pair failed to persist", async () => {
    const auth = store({ type: "oauth", access: "old", refresh: "r1", expires: Date.now() - 1 })
    const spent: string[] = []
    let writable = false
    const options: ProviderOAuth.RenewOptions = {
      providerID: uniqueID(),
      read: auth.read,
      async exchange(stored) {
        spent.push(stored.refresh)
        return { access: "new", refresh: "r2", expires: Date.now() + HOUR }
      },
      async write(tokens) {
        if (!writable) throw new Error("disk full")
        auth.set({ type: "oauth", ...tokens })
      },
    }

    expect((await ProviderOAuth.renew(options)).access).toBe("new")
    expect(auth.current.refresh).toBe("r1")

    writable = true
    expect((await ProviderOAuth.renew(options)).access).toBe("new")
    expect(spent).toEqual(["r1"])
    expect(auth.current.refresh).toBe("r2")
  })

  it("waits for another process's renewal and adopts its pair", async () => {
    const providerID = uniqueID()
    const auth = store({ type: "oauth", access: "old", refresh: "r1", expires: Date.now() - 1 })
    let exchanged = 0

    const other = await FileLock.acquire(
      path.join(Global.Path.state, `provider-refresh-${providerID.replace(/[^\w.-]/g, "_")}.lock`),
    )
    expect(other).toBeDefined()

    const pending = ProviderOAuth.renew({
      providerID,
      read: auth.read,
      async exchange() {
        exchanged++
        return { access: "mine", refresh: "r-mine", expires: Date.now() + HOUR }
      },
      async write(tokens) {
        auth.set({ type: "oauth", ...tokens })
      },
    })

    await Bun.sleep(100)
    auth.set({ type: "oauth", access: "theirs", refresh: "r2", expires: Date.now() + HOUR })
    await other![Symbol.asyncDispose]()

    expect((await pending).access).toBe("theirs")
    expect(exchanged).toBe(0)
  })

  it("replays only bodies a second attempt can resend", () => {
    expect(ProviderOAuth.replayable(undefined)).toBe(true)
    expect(ProviderOAuth.replayable("{}")).toBe(true)
    expect(ProviderOAuth.replayable(new ReadableStream())).toBe(false)
  })
})

// End to end through the plugins' fetch overrides, against a stubbed network.

type Call = { url: string; auth: string | null; body?: string }

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function network(handle: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(init?.headers)
    const call = {
      url,
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : undefined,
    }
    calls.push(call)
    return handle(call)
  }) as typeof fetch
  return calls
}

function pluginInput(auth: ReturnType<typeof store>, writes: Array<{ providerID: string }>) {
  return {
    client: {
      auth: {
        async set(input: { providerID: string; payload: ProviderOAuth.Stored }) {
          writes.push({ providerID: input.providerID })
          auth.set(input.payload)
          return { data: true, error: undefined }
        },
      },
      tui: { showToast: async () => ({ data: true, error: undefined }) },
    },
  } as any
}

const tokenResponse = (access: string, refresh: string) =>
  Response.json({ access_token: access, refresh_token: refresh, expires_in: 3600 })

describe("codex OAuth", () => {
  async function load(auth: ReturnType<typeof store>, writes: Array<{ providerID: string }>) {
    const hooks = await CodexAuthPlugin(pluginInput(auth, writes), { reserveFallback: false })
    const options = await hooks.auth!.loader!(auth.read as any, { models: {} } as any)
    return options.fetch as typeof fetch
  }

  it("stores the renewed pair under openai, where it is read back from", async () => {
    const auth = store({ type: "oauth", access: "old", refresh: "r1", expires: Date.now() - 1 })
    const writes: Array<{ providerID: string }> = []
    const calls = network((call) =>
      call.url.includes("/oauth/token") ? tokenResponse("a2", "r2") : new Response("{}", { status: 200 }),
    )
    const fetchWithAuth = await load(auth, writes)

    await fetchWithAuth("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
    await fetchWithAuth("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(writes.map((w) => w.providerID)).toEqual(["openai"])
    expect(auth.current).toMatchObject({ access: "a2", refresh: "r2" })
    expect(calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(1)
    expect(calls.filter((c) => c.url.includes("chatgpt.com")).map((c) => c.auth)).toEqual(["Bearer a2", "Bearer a2"])
  })

  it("renews once and replays a request answered 401", async () => {
    const auth = store({ type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + HOUR })
    const writes: Array<{ providerID: string }> = []
    const calls = network((call) => {
      if (call.url.includes("/oauth/token")) return tokenResponse("a2", "r2")
      return new Response("{}", { status: call.auth === "Bearer a1" ? 401 : 200 })
    })
    const fetchWithAuth = await load(auth, writes)

    const response = await fetchWithAuth("https://api.openai.com/v1/responses", { method: "POST", body: `{"n":1}` })

    expect(response.status).toBe(200)
    const api = calls.filter((c) => c.url.includes("chatgpt.com"))
    expect(api.map((c) => c.auth)).toEqual(["Bearer a1", "Bearer a2"])
    expect(api[1].body).toBe(`{"n":1}`)
    expect(auth.current.refresh).toBe("r2")
  })

  it("hands back the 401 when renewal itself is refused", async () => {
    const auth = store({ type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + HOUR })
    network((call) =>
      call.url.includes("/oauth/token")
        ? new Response(`{"error":"refresh_token_reused"}`, { status: 401 })
        : new Response("{}", { status: 401 }),
    )
    const fetchWithAuth = await load(auth, [])

    const response = await fetchWithAuth("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
    expect(response.status).toBe(401)
    expect(auth.current.refresh).toBe("r1")
  })

  it("explains an expired sign-in instead of a bare status", async () => {
    const auth = store({ type: "oauth", access: "old", refresh: "r1", expires: Date.now() - 1 })
    network(() => new Response(`{"error":"invalid_grant"}`, { status: 400 }))
    const fetchWithAuth = await load(auth, [])

    await expect(fetchWithAuth("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })).rejects.toThrow(
      "nikcli auth login openai",
    )
  })
})

describe("xai OAuth", () => {
  async function load(auth: ReturnType<typeof store>, writes: Array<{ providerID: string }>) {
    const hooks = await XAIAuthPlugin(pluginInput(auth, writes))
    const options = await hooks.auth!.loader!(auth.read as any, { models: {} } as any)
    return options.fetch as typeof fetch
  }

  function xaiNetwork(api: (call: Call) => Response) {
    return network((call) => {
      if (call.url.includes("openid-configuration"))
        return Response.json({
          authorization_endpoint: "https://auth.x.ai/oauth2/auth",
          token_endpoint: "https://auth.x.ai/oauth2/token",
        })
      if (call.url.includes("/oauth2/token")) return tokenResponse("x2", "xr2")
      return api(call)
    })
  }

  it("renews ahead of expiry and spends the refresh token once under concurrency", async () => {
    const auth = store({ type: "oauth", access: "x1", refresh: "xr1", expires: Date.now() + 30_000 })
    const writes: Array<{ providerID: string }> = []
    const calls = xaiNetwork(() => new Response("{}", { status: 200 }))
    const fetchWithAuth = await load(auth, writes)

    await Promise.all(
      [1, 2, 3].map(() => fetchWithAuth("https://api.x.ai/v1/responses", { method: "POST", body: "{}" })),
    )

    expect(calls.filter((c) => c.url.includes("/oauth2/token"))).toHaveLength(1)
    expect(writes.map((w) => w.providerID)).toEqual(["xai"])
    expect(calls.filter((c) => c.url.includes("api.x.ai")).map((c) => c.auth)).toEqual([
      "Bearer x2",
      "Bearer x2",
      "Bearer x2",
    ])
  })

  it("renews once and replays a request answered 401", async () => {
    const auth = store({ type: "oauth", access: "x1", refresh: "xr1", expires: Date.now() + HOUR })
    const calls = xaiNetwork((call) => new Response("{}", { status: call.auth === "Bearer x1" ? 401 : 200 }))
    const fetchWithAuth = await load(auth, [])

    const response = await fetchWithAuth("https://api.x.ai/v1/responses", { method: "POST", body: "{}" })

    expect(response.status).toBe(200)
    expect(calls.filter((c) => c.url.includes("api.x.ai")).map((c) => c.auth)).toEqual(["Bearer x1", "Bearer x2"])
    expect(auth.current.refresh).toBe("xr2")
  })
})
