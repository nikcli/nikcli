import { describe, expect, test } from "bun:test"
import {
  buildHeaders,
  buildUrl,
  checkConnection,
  fetchOverview,
  fetchQuotes,
  fetchSignals,
  request,
  ROUTES,
} from "@tui/feature-plugins/jev/client"
import {
  actionDirection,
  normalizePortfolio,
  normalizePositions,
  normalizeQuotes,
  normalizeSignals,
  pickNumber,
  pickRows,
  sanitizeText,
} from "@tui/feature-plugins/jev/model"
import {
  cleanApiPrefix,
  cleanBaseUrl,
  clampRefresh,
  DEFAULT_BASE_URL,
  DEFAULT_SETTINGS,
  direction,
  endpointLabel,
  formatPercent,
  formatSignedMoney,
  isAuthenticated,
  keyLabel,
  maskApiKey,
  normalize,
  parseWatchlist,
  refreshLabel,
  resolveApiKey,
  stepRefresh,
  watchlistLabel,
  type JevSettings,
} from "@tui/feature-plugins/jev/settings"
import { readSettings, writeSettings, type KVLike } from "@tui/feature-plugins/jev/store"

function settings(patch: Partial<JevSettings> = {}): JevSettings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

function memoryKV(): KVLike {
  const store = new Map<string, unknown>()
  return {
    get: <Value = unknown>(key: string, fallback?: Value) => (store.has(key) ? (store.get(key) as Value) : fallback!),
    set: (key: string, value: unknown) => void store.set(key, value),
  }
}

/** A fetch stand-in that records what it was asked and answers a fixed body. */
function stubFetch(answers: Record<string, { status?: number; body: string }>) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString()
    calls.push({ url: href, headers: (init?.headers as Record<string, string>) ?? {} })
    const match = Object.entries(answers).find(([route]) => href.includes(route))
    const answer = match?.[1] ?? { status: 404, body: '{"error":"no route"}' }
    return new Response(answer.body, { status: answer.status ?? 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe("jev settings", () => {
  test("assumes https for a bare host and drops trailing noise", () => {
    expect(cleanBaseUrl("jev-trader.vercel.app")).toBe("https://jev-trader.vercel.app")
    expect(cleanBaseUrl(" https://jev-trader.vercel.app/// ")).toBe("https://jev-trader.vercel.app")
    expect(cleanBaseUrl('"https://jev.example.com/jev"')).toBe("https://jev.example.com/jev")
    expect(cleanBaseUrl("https://jev.example.com/jev?token=x#y")).toBe("https://jev.example.com/jev")
    expect(cleanBaseUrl("http://localhost:3000")).toBe("http://localhost:3000")
    expect(cleanBaseUrl("")).toBe("")
    expect(cleanBaseUrl("not a url at all")).toBe("")
  })

  test("normalizes the api prefix to a leading slash, or nothing", () => {
    expect(cleanApiPrefix("api")).toBe("/api")
    expect(cleanApiPrefix("/api/")).toBe("/api")
    expect(cleanApiPrefix("/")).toBe("")
    expect(cleanApiPrefix("  ")).toBe("")
  })

  test("parses a watchlist into deduped tickers, keeping typed order", () => {
    expect(parseWatchlist("aapl, nvda  btc-usd;aapl")).toEqual(["AAPL", "NVDA", "BTC-USD"])
    expect(parseWatchlist("")).toEqual([])
    expect(parseWatchlist("this-symbol-is-far-too-long")).toEqual([])
  })

  test("reads a bare string as the endpoint", () => {
    expect(normalize("jev.example.com")).toEqual({ ...DEFAULT_SETTINGS, baseUrl: "https://jev.example.com" })
    expect(normalize(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalize(42)).toEqual(DEFAULT_SETTINGS)
  })

  test("normalizes a stored object and rejects junk fields", () => {
    expect(
      normalize({
        baseUrl: "jev.example.com/",
        apiPrefix: "v1",
        apiKey: "  secret  ",
        enabled: false,
        watchlist: ["aapl", 7, "nvda"],
        refreshSeconds: 99999,
        currency: "eur",
      }),
    ).toEqual({
      baseUrl: "https://jev.example.com",
      apiPrefix: "/v1",
      apiKey: "secret",
      enabled: false,
      watchlist: ["AAPL", "NVDA"],
      refreshSeconds: 3600,
      currency: "EUR",
    })
    expect(normalize({ currency: "dollars" }).currency).toBe("USD")
    expect(normalize({ refreshSeconds: Number.NaN }).refreshSeconds).toBe(DEFAULT_SETTINGS.refreshSeconds)
  })

  test("cycles the refresh interval and clamps it", () => {
    expect(stepRefresh(0)).toBe(10)
    expect(stepRefresh(300)).toBe(0)
    expect(stepRefresh(7)).toBe(0)
    expect(clampRefresh(-5)).toBe(0)
    expect(clampRefresh(10_000)).toBe(3600)
    expect(refreshLabel(0)).toBe("on demand")
    expect(refreshLabel(30)).toBe("30s")
    expect(refreshLabel(300)).toBe("5m")
  })

  test("the environment key wins over the stored one, and is never printed", () => {
    const stored = settings({ apiKey: "stored-key-1234" })
    expect(resolveApiKey(stored, {})).toBe("stored-key-1234")
    expect(resolveApiKey(stored, { NIKCLI_JEV_API_KEY: "env-key-9876" })).toBe("env-key-9876")
    expect(resolveApiKey(stored, { JEV_API_KEY: "alt-key-5555" })).toBe("alt-key-5555")
    expect(maskApiKey("stored-key-1234")).toBe("••••1234")
    expect(maskApiKey("")).toBe("not set")
    expect(keyLabel(stored, { NIKCLI_JEV_API_KEY: "env-key-9876" })).toBe("••••9876 (environment)")
    expect(keyLabel(settings(), {})).toBe("not set")
    expect(isAuthenticated(settings(), {})).toBe(false)
    expect(isAuthenticated(settings(), { JEV_API_KEY: "k" })).toBe(true)
  })

  test("labels the endpoint and the watchlist for the settings rows", () => {
    expect(endpointLabel(settings())).toBe("jev-trader.vercel.app/api")
    expect(endpointLabel(settings({ baseUrl: "https://jev.example.com/jev", apiPrefix: "/v1" }))).toBe(
      "jev.example.com/jev/v1",
    )
    expect(endpointLabel(settings({ baseUrl: "" }))).toBe("not set")
    expect(watchlistLabel([])).toBe("none")
    expect(watchlistLabel(["A", "B", "C", "D", "E", "F", "G"])).toBe("A B C D E F +1")
  })

  test("formats amounts with the sign the panels color on", () => {
    expect(formatSignedMoney(1234.5, "USD")).toMatch(/^\+\$1,23[45]/)
    expect(formatSignedMoney(-2, "USD")).toBe("-$2.00")
    expect(formatSignedMoney(0, "USD")).toBe("$0.00")
    expect(formatSignedMoney(undefined)).toBe("—")
    // An invalid currency code must not throw out of a render.
    expect(formatSignedMoney(5, "NOTACURRENCY")).toContain("NOTACURRENCY")
    expect(formatPercent(-1.234)).toBe("-1.23%")
    expect(formatPercent(undefined)).toBe("—")
    expect(direction(1)).toBe("up")
    expect(direction(-1)).toBe("down")
    expect(direction(0)).toBe("flat")
    expect(direction(undefined)).toBe("flat")
  })

  test("settings round-trip through the key-value store", () => {
    const kv = memoryKV()
    expect(readSettings(kv)).toEqual(DEFAULT_SETTINGS)
    writeSettings(kv, { watchlist: parseWatchlist("aapl"), refreshSeconds: 60 })
    expect(readSettings(kv).watchlist).toEqual(["AAPL"])
    expect(readSettings(kv).refreshSeconds).toBe(60)
    writeSettings(kv, { enabled: false })
    expect(readSettings(kv)).toMatchObject({ enabled: false, watchlist: ["AAPL"] })
  })
})

describe("jev payload mapping", () => {
  test("strips escape sequences and clamps external text", () => {
    expect(sanitizeText("\u001b[31mred\u001b[0m text")).toBe("red text")
    expect(sanitizeText("line\nbreak\tand   space")).toBe("line break and space")
    expect(sanitizeText("x".repeat(500)).length).toBe(200)
  })

  test("reads numbers however they were serialized", () => {
    expect(pickNumber({ a: "1,234.5" }, "a")).toBe(1234.5)
    expect(pickNumber({ a: "12%" }, "a")).toBe(12)
    expect(pickNumber({ a: null, b: 3 }, "a", "b")).toBe(3)
    expect(pickNumber({ a: "nope" }, "a")).toBeUndefined()
    expect(pickNumber(undefined, "a")).toBeUndefined()
  })

  test("unwraps a collection out of whatever envelope it arrived in", () => {
    expect(pickRows([{ symbol: "A" }], "positions")).toHaveLength(1)
    expect(pickRows({ positions: [{ symbol: "A" }] }, "positions")).toHaveLength(1)
    expect(pickRows({ data: [{ symbol: "A" }] }, "positions")).toHaveLength(1)
    expect(pickRows({ data: { positions: [{ symbol: "A" }] } }, "positions")).toHaveLength(1)
    expect(pickRows({ nothing: true }, "positions")).toEqual([])
  })

  test("maps a portfolio under either field naming", () => {
    expect(normalizePortfolio({ equity: 1000, cash: 250, dayPnl: -10, currency: "eur" })).toMatchObject({
      equity: 1000,
      cash: 250,
      pnlDay: -10,
      currency: "EUR",
    })
    expect(normalizePortfolio({ data: { totalEquity: "2000", buyingPower: 10 } })).toMatchObject({
      equity: 2000,
      cash: 10,
    })
    expect(normalizePortfolio({ unrelated: "x" })).toBeUndefined()
    expect(normalizePortfolio(null)).toBeUndefined()
  })

  test("maps positions, inferring the side from a negative quantity", () => {
    const positions = normalizePositions({
      positions: [
        { ticker: "aapl", qty: 10, avgPrice: 100, lastPrice: 110, unrealizedPnl: 100, pnlPercent: 10 },
        { symbol: "nvda", size: -4, side: "SHORT" },
        { quantity: 1 },
      ],
    })
    expect(positions).toHaveLength(2)
    expect(positions[0]).toMatchObject({ symbol: "AAPL", side: "long", quantity: 10, lastPrice: 110, pnl: 100 })
    expect(positions[1]).toMatchObject({ symbol: "NVDA", side: "short", quantity: 4 })
  })

  test("maps quotes and signals, normalizing confidence to a percent", () => {
    expect(normalizeQuotes([{ symbol: "btc-usd", last: 50000, change24h: 2.5 }])[0]).toMatchObject({
      symbol: "BTC-USD",
      price: 50000,
      changePercent: 2.5,
    })
    const signals = normalizeSignals({
      signals: [
        { symbol: "aapl", action: "BUY", confidence: 0.82, reason: "momentum" },
        { ticker: "nvda", recommendation: "sell", score: 71 },
      ],
    })
    expect(signals[0]).toMatchObject({ symbol: "AAPL", action: "buy", rationale: "momentum" })
    expect(signals[0]?.confidence).toBeCloseTo(82, 5)
    expect(signals[1]).toMatchObject({ symbol: "NVDA", action: "sell", confidence: 71 })
    expect(actionDirection("Accumulate")).toBe("up")
    expect(actionDirection("reduce exposure")).toBe("down")
    expect(actionDirection("hold")).toBe("flat")
  })
})

describe("jev client", () => {
  test("builds a URL that keeps a path in the base and adds the query", () => {
    expect(buildUrl(settings(), ROUTES.portfolio)).toBe("https://jev-trader.vercel.app/api/portfolio")
    expect(buildUrl(settings({ baseUrl: "https://jev.example.com/jev", apiPrefix: "/v1" }), "positions")).toBe(
      "https://jev.example.com/jev/v1/positions",
    )
    expect(buildUrl(settings({ apiPrefix: "" }), ROUTES.quotes, { symbols: "AAPL,NVDA" })).toBe(
      "https://jev-trader.vercel.app/quotes?symbols=AAPL%2CNVDA",
    )
    expect(buildUrl(settings({ baseUrl: "" }), ROUTES.portfolio)).toBe("")
  })

  test("sends the key as both a bearer token and x-api-key, and nothing when there is none", () => {
    const headers = buildHeaders(settings({ apiKey: "k" }), {})
    expect(headers["authorization"]).toBe("Bearer k")
    expect(headers["x-api-key"]).toBe("k")
    expect(buildHeaders(settings(), {})["authorization"]).toBeUndefined()
  })

  test("reports the status codes a misconfigured connection produces", async () => {
    const unauthorized = stubFetch({ "/portfolio": { status: 401, body: '{"message":"bad key"}' } })
    expect(await request(settings(), ROUTES.portfolio, undefined, { fetch: unauthorized.impl, env: {} })).toEqual({
      error: "JEV rejected the API key: bad key",
    })

    const missing = stubFetch({ "/portfolio": { status: 404, body: "not found" } })
    const result = await request(settings(), ROUTES.portfolio, undefined, { fetch: missing.impl, env: {} })
    expect(result.error).toContain("404")

    const html = stubFetch({ "/portfolio": { body: "<!doctype html><html>…" } })
    expect(await request(settings(), ROUTES.portfolio, undefined, { fetch: html.impl, env: {} })).toEqual({
      error: "JEV answered something that is not JSON",
    })
  })

  test("refuses to call out while disabled, or without an endpoint", async () => {
    const stub = stubFetch({ "/portfolio": { body: "{}" } })
    expect(await request(settings({ enabled: false }), ROUTES.portfolio, undefined, { fetch: stub.impl })).toEqual({
      error: "JEV integration is switched off",
    })
    const noEndpoint = await request(settings({ baseUrl: "" }), ROUTES.portfolio, undefined, { fetch: stub.impl })
    expect(noEndpoint.error).toContain("not a usable JEV endpoint")
    expect(stub.calls).toHaveLength(0)
  })

  test("reports a timeout instead of hanging a panel", async () => {
    const hang = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })) as unknown as typeof fetch
    const result = await request(settings(), ROUTES.portfolio, undefined, { fetch: hang, timeoutMs: 5, env: {} })
    expect(result.error).toContain("did not answer")
  })

  test("keeps the watchlist order and leaves an unquoted symbol visible", async () => {
    const stub = stubFetch({ "/quotes": { body: JSON.stringify({ quotes: [{ symbol: "NVDA", price: 120 }] }) } })
    const result = await fetchQuotes(settings(), ["AAPL", "NVDA"], { fetch: stub.impl, env: {} })
    expect(result.data?.map((quote) => quote.symbol)).toEqual(["AAPL", "NVDA"])
    expect(result.data?.[0]?.price).toBeUndefined()
    expect(result.data?.[1]?.price).toBe(120)
    expect(stub.calls[0]?.url).toContain("symbols=AAPL%2CNVDA")
  })

  test("asks for nothing when the watchlist is empty", async () => {
    const stub = stubFetch({ "/quotes": { body: "[]" } })
    expect(await fetchQuotes(settings(), [], { fetch: stub.impl, env: {} })).toEqual({ data: [] })
    expect(stub.calls).toHaveLength(0)
  })

  test("an overview survives one dead route", async () => {
    const stub = stubFetch({
      "/portfolio": { body: JSON.stringify({ equity: 1000 }) },
      "/positions": { status: 500, body: "boom" },
      "/quotes": { body: JSON.stringify([{ symbol: "AAPL", price: 10 }]) },
    })
    const overview = await fetchOverview(settings({ watchlist: ["AAPL"] }), { fetch: stub.impl, env: {} })
    expect(overview.portfolio).toMatchObject({ equity: 1000 })
    expect(overview.positions).toEqual([])
    expect(overview.quotes).toHaveLength(1)
    expect(overview.errors).toHaveLength(1)
    expect(overview.errors[0]).toContain("500")
  })

  test("a deployment without /portfolio still counts as connected", async () => {
    const stub = stubFetch({
      "/portfolio": { status: 404, body: "no route" },
      "/positions": { body: JSON.stringify([{ symbol: "AAPL", qty: 1 }]) },
    })
    expect(await checkConnection(settings(), { fetch: stub.impl, env: {} })).toEqual({ ok: true })

    const dead = stubFetch({})
    const failed = await checkConnection(settings(), { fetch: dead.impl, env: {} })
    expect(failed.ok).toBe(false)
  })

  test("signals come back sanitized", async () => {
    const stub = stubFetch({
      "/signals": {
        body: JSON.stringify({ signals: [{ symbol: "aapl", action: "buy", reason: "\u001b[31mspoofed\u001b[0m" }] }),
      },
    })
    const result = await fetchSignals(settings(), { fetch: stub.impl, env: {} })
    expect(result.data?.[0]?.rationale).toBe("spoofed")
  })

  test("the hosted deployment is the default endpoint", () => {
    expect(DEFAULT_SETTINGS.baseUrl).toBe(DEFAULT_BASE_URL)
    expect(DEFAULT_BASE_URL).toBe("https://jev-trader.vercel.app")
  })
})
