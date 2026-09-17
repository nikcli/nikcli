/**
 * HTTP client for JEV Trader.
 *
 * A hand-written `fetch` wrapper rather than a generated client: JEV is a
 * third-party deployment, not one of nikcli's own servers, so there is no
 * schema to generate from and the plugin has to survive a surface that can
 * change under it. Results are returned as `{ data }` / `{ error }` — the same
 * shape `api.client.*` hands the other integration plugins — so the dialogs
 * read one way whichever client they talk to.
 *
 * Every call takes its `fetch` and clock from `deps`, which is what makes the
 * whole file testable without a network.
 */
import { cleanApiPrefix, cleanBaseUrl, resolveApiKey, type Env, type JevSettings, DEFAULT_BASE_URL } from "./settings"
import {
  normalizePortfolio,
  normalizePositions,
  normalizeQuotes,
  normalizeSignals,
  sanitizeText,
  type JevOverview,
  type JevPortfolio,
  type JevPosition,
  type JevQuote,
  type JevSignal,
} from "./model"

export type JevResult<Value> = { data: Value; error?: undefined } | { data?: undefined; error: string }

export type JevDeps = {
  fetch?: typeof fetch
  env?: Env
  /** Per-request budget. A trading panel that hangs is worse than one that says it timed out. */
  timeoutMs?: number
}

export const DEFAULT_TIMEOUT_MS = 10_000

/** Routes the plugin uses, relative to `apiPrefix`. */
export const ROUTES = {
  portfolio: "/portfolio",
  positions: "/positions",
  quotes: "/quotes",
  signals: "/signals",
} as const

/**
 * Absolute URL for a route. Built by concatenation rather than `new URL(path,
 * base)`, which would discard a path in the base URL — a JEV reachable at
 * `https://host/jev` is a normal deployment. Returns `""` when the result is
 * not a URL at all, which {@link request} reports as a configuration error.
 */
export function buildUrl(settings: JevSettings, route: string, query?: Record<string, string | undefined>): string {
  const base = cleanBaseUrl(settings.baseUrl)
  if (base === "") return ""
  const prefix = cleanApiPrefix(settings.apiPrefix)
  const suffix = route.startsWith("/") ? route : `/${route}`
  try {
    const url = new URL(`${base}${prefix}${suffix}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value)
    }
    return url.toString()
  } catch {
    return ""
  }
}

/**
 * Auth headers.
 *
 * Both `authorization: Bearer` and `x-api-key` carry the key: which one a JEV
 * deployment reads is not something the plugin can discover, and sending the
 * pair to the endpoint the user configured costs nothing while removing a whole
 * class of "connected but empty" support questions.
 */
export function buildHeaders(settings: JevSettings, env: Env = process.env): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" }
  const key = resolveApiKey(settings, env)
  if (key !== "") {
    headers["authorization"] = `Bearer ${key}`
    headers["x-api-key"] = key
  }
  return headers
}

/** Human-readable reason, with the key never echoed back into it. */
function failure(status: number, body: string): string {
  const detail = (() => {
    try {
      const parsed: unknown = JSON.parse(body)
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>
        for (const key of ["error", "message", "detail"]) {
          const value = record[key]
          if (typeof value === "string" && value.trim() !== "") return sanitizeText(value, 120)
        }
      }
    } catch {
      // Not JSON — fall through to the raw snippet.
    }
    return sanitizeText(body, 120)
  })()
  if (status === 401 || status === 403) return `JEV rejected the API key${detail ? `: ${detail}` : ""}`
  if (status === 404) return `JEV has no such route (404)${detail ? `: ${detail}` : ""}`
  return `JEV answered ${status}${detail ? `: ${detail}` : ""}`
}

export async function request<Value>(
  settings: JevSettings,
  route: string,
  query?: Record<string, string | undefined>,
  deps: JevDeps = {},
): Promise<JevResult<Value>> {
  if (!settings.enabled) return { error: "JEV integration is switched off" }
  const url = buildUrl(settings, route, query)
  if (url === "") return { error: `"${settings.baseUrl || DEFAULT_BASE_URL}" is not a usable JEV endpoint` }

  const impl = deps.fetch ?? fetch
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await impl(url, {
      method: "GET",
      headers: buildHeaders(settings, deps.env),
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) return { error: failure(response.status, body) }
    if (body.trim() === "") return { data: undefined as Value }
    try {
      return { data: JSON.parse(body) as Value }
    } catch {
      // An HTML error page from the platform, not from JEV, lands here.
      return { error: "JEV answered something that is not JSON" }
    }
  } catch (error) {
    if (controller.signal.aborted) return { error: `JEV did not answer within ${Math.round(timeout / 1000)}s` }
    return { error: error instanceof Error ? sanitizeText(error.message, 120) : "Could not reach JEV" }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchPortfolio(settings: JevSettings, deps?: JevDeps): Promise<JevResult<JevPortfolio>> {
  const result = await request<unknown>(settings, ROUTES.portfolio, undefined, deps)
  if (result.error !== undefined) return { error: result.error }
  const portfolio = normalizePortfolio(result.data)
  if (!portfolio) return { error: "JEV returned no portfolio figures" }
  return { data: portfolio }
}

export async function fetchPositions(settings: JevSettings, deps?: JevDeps): Promise<JevResult<JevPosition[]>> {
  const result = await request<unknown>(settings, ROUTES.positions, undefined, deps)
  if (result.error !== undefined) return { error: result.error }
  return { data: normalizePositions(result.data) }
}

export async function fetchQuotes(
  settings: JevSettings,
  symbols: string[],
  deps?: JevDeps,
): Promise<JevResult<JevQuote[]>> {
  if (symbols.length === 0) return { data: [] }
  const result = await request<unknown>(settings, ROUTES.quotes, { symbols: symbols.join(",") }, deps)
  if (result.error !== undefined) return { error: result.error }
  const quotes = normalizeQuotes(result.data)
  // Keep the watchlist's own order, and keep a symbol JEV said nothing about
  // visible as a blank row rather than silently dropping it.
  const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]))
  return { data: symbols.map((symbol) => bySymbol.get(symbol) ?? { symbol }) }
}

export async function fetchSignals(settings: JevSettings, deps?: JevDeps): Promise<JevResult<JevSignal[]>> {
  const result = await request<unknown>(settings, ROUTES.signals, undefined, deps)
  if (result.error !== undefined) return { error: result.error }
  return { data: normalizeSignals(result.data) }
}

/**
 * Everything the overview panel shows, in one round trip's worth of latency.
 *
 * Partial failure is the normal case here — a deployment without `/quotes`, a
 * portfolio route behind a stricter scope — so each section reports its own
 * error and the panel renders whatever did come back.
 */
export async function fetchOverview(settings: JevSettings, deps?: JevDeps): Promise<JevOverview> {
  const [portfolio, positions, quotes] = await Promise.all([
    fetchPortfolio(settings, deps),
    fetchPositions(settings, deps),
    fetchQuotes(settings, settings.watchlist, deps),
  ])
  const errors: string[] = []
  for (const result of [portfolio, positions, quotes]) {
    if (result.error !== undefined) errors.push(result.error)
  }
  return {
    portfolio: portfolio.data,
    positions: positions.data ?? [],
    quotes: quotes.data ?? [],
    errors,
  }
}

/** A cheap "can we talk to it" probe, used by `/jev` after the connect prompt. */
export async function checkConnection(
  settings: JevSettings,
  deps?: JevDeps,
): Promise<{ ok: true; portfolio?: JevPortfolio } | { ok: false; error: string }> {
  const portfolio = await fetchPortfolio(settings, deps)
  if (portfolio.error === undefined) return { ok: true, portfolio: portfolio.data }
  // The portfolio route may simply not exist on this deployment while the rest
  // does, so a 404 is not a failed connection — anything else is.
  const positions = await fetchPositions(settings, deps)
  if (positions.error === undefined) return { ok: true }
  return { ok: false, error: portfolio.error }
}
