/**
 * Settings for the JEV Trader plugin.
 *
 * Everything lives in the TUI key-value store (`Global.Path.state/kv.json`)
 * rather than in `nikcli.json`, for the same reason the background image does:
 * the endpoint and the watchlist are a personal, per-machine choice and `/jev`
 * edits them live, so a config round-trip would be noise in a shared repo.
 *
 * The API key is the one value that may not want to be persisted at all, so
 * `NIKCLI_JEV_API_KEY` (or `JEV_API_KEY`) wins over the stored one — that is
 * what lets a shared machine or a CI shell talk to JEV without writing a
 * secret to disk.
 */

export const JEV_KV_KEY = "jev_trader"

/** The hosted JEV Trader deployment. A self-hosted one only changes this. */
export const DEFAULT_BASE_URL = "https://jev-trader.vercel.app"

/**
 * Path the REST routes hang off. Split from the base URL because it is the one
 * piece that differs between JEV deployments, and moving it is cheaper than
 * making every single route configurable.
 */
export const DEFAULT_API_PREFIX = "/api"

export type JevSettings = {
  /** Origin of the JEV deployment, no trailing slash. */
  baseUrl: string
  /** Prefix the REST routes live under, leading slash and no trailing one. Empty means none. */
  apiPrefix: string
  /** Stored API key. Empty when it comes from the environment instead — or when the deployment is open. */
  apiKey: string
  /** Whether the plugin talks to JEV at all. Keeps the config while going quiet. */
  enabled: boolean
  /** Symbols the watchlist follows, uppercased and deduped. */
  watchlist: string[]
  /** How often an open JEV dialog refetches. 0 means only on demand. */
  refreshSeconds: number
  /** Currency the amounts are formatted in when JEV does not say. */
  currency: string
}

export const DEFAULT_SETTINGS: JevSettings = {
  baseUrl: DEFAULT_BASE_URL,
  apiPrefix: DEFAULT_API_PREFIX,
  apiKey: "",
  enabled: true,
  watchlist: [],
  refreshSeconds: 30,
  currency: "USD",
}

/** Refresh intervals `/jev` cycles through. `0` is "only when asked". */
export const REFRESH_STEPS = [0, 10, 30, 60, 300] as const

export const REFRESH_MAX = 3600

/** A watchlist row is a ticker, not free text: keep it to what an exchange can name. */
const SYMBOL = /^[A-Z0-9][A-Z0-9._:/-]{0,15}$/

export const WATCHLIST_MAX = 24

/**
 * Normalize whatever is typed into the endpoint prompt.
 *
 * A bare host is assumed to be https — nobody pastes a scheme when copying a
 * Vercel domain out of the address bar, and a plain `http://` default would
 * send the API key over the wire in the clear.
 */
export function cleanBaseUrl(input: string): string {
  let value = input.trim()
  if (value === "") return ""
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) value = value.slice(1, -1).trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
  value = value.replace(/\/+$/, "")
  try {
    const url = new URL(value)
    // Query and hash are meaningless on a base URL and would swallow the path.
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/+$/, "")
  } catch {
    return ""
  }
}

export function cleanApiPrefix(input: string): string {
  const value = input.trim().replace(/\/+$/, "")
  if (value === "" || value === "/") return ""
  return value.startsWith("/") ? value : `/${value}`
}

/** Split a typed list ("aapl, btc-usd nvda") into tickers, keeping the typed order. */
export function parseWatchlist(input: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input.split(/[\s,;]+/)) {
    const symbol = raw.trim().toUpperCase()
    if (!SYMBOL.test(symbol) || seen.has(symbol)) continue
    seen.add(symbol)
    out.push(symbol)
    if (out.length >= WATCHLIST_MAX) break
  }
  return out
}

export type Env = Record<string, string | undefined>

export function envApiKey(env: Env = process.env): string {
  return (env["NIKCLI_JEV_API_KEY"] ?? env["JEV_API_KEY"] ?? "").trim()
}

/** The key a request should use: the environment first, then what `/jev` stored. */
export function resolveApiKey(settings: JevSettings, env: Env = process.env): string {
  return envApiKey(env) || settings.apiKey.trim()
}

/** Never print a key back: a terminal is shoulder-surfable and gets scrolled into pastes. */
export function maskApiKey(key: string): string {
  if (key === "") return "not set"
  if (key.length <= 4) return "••••"
  return `••••${key.slice(-4)}`
}

export function clampRefresh(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.refreshSeconds
  return Math.min(REFRESH_MAX, Math.max(0, Math.round(value)))
}

/** Cycle to the next interval, wrapping at the end. */
export function stepRefresh(value: number): number {
  const current = clampRefresh(value)
  const index = REFRESH_STEPS.findIndex((step) => step === current)
  if (index === -1) return REFRESH_STEPS[0]
  return REFRESH_STEPS[(index + 1) % REFRESH_STEPS.length]
}

export function normalize(value: unknown): JevSettings {
  // A bare string is read as the endpoint, so `kv.set("jev_trader", url)` works.
  if (typeof value === "string") {
    return { ...DEFAULT_SETTINGS, baseUrl: cleanBaseUrl(value) || DEFAULT_BASE_URL }
  }
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS }
  const record = value as Record<string, unknown>
  const currency = typeof record["currency"] === "string" ? record["currency"].trim().toUpperCase() : ""
  return {
    baseUrl: typeof record["baseUrl"] === "string" ? cleanBaseUrl(record["baseUrl"]) : DEFAULT_SETTINGS.baseUrl,
    apiPrefix:
      typeof record["apiPrefix"] === "string" ? cleanApiPrefix(record["apiPrefix"]) : DEFAULT_SETTINGS.apiPrefix,
    apiKey: typeof record["apiKey"] === "string" ? record["apiKey"].trim() : DEFAULT_SETTINGS.apiKey,
    enabled: typeof record["enabled"] === "boolean" ? record["enabled"] : DEFAULT_SETTINGS.enabled,
    watchlist: Array.isArray(record["watchlist"])
      ? parseWatchlist(record["watchlist"].filter((item): item is string => typeof item === "string").join(" "))
      : DEFAULT_SETTINGS.watchlist,
    refreshSeconds:
      typeof record["refreshSeconds"] === "number"
        ? clampRefresh(record["refreshSeconds"])
        : DEFAULT_SETTINGS.refreshSeconds,
    currency: /^[A-Z]{3,5}$/.test(currency) ? currency : DEFAULT_SETTINGS.currency,
  }
}

/** Whether there is an endpoint to talk to at all. */
export function isConfigured(settings: JevSettings): boolean {
  return settings.baseUrl !== ""
}

/** Whether a request would carry credentials. An open deployment needs none. */
export function isAuthenticated(settings: JevSettings, env: Env = process.env): boolean {
  return resolveApiKey(settings, env) !== ""
}

export function endpointLabel(settings: JevSettings): string {
  if (settings.baseUrl === "") return "not set"
  try {
    const url = new URL(settings.baseUrl)
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}${settings.apiPrefix}`
  } catch {
    return settings.baseUrl
  }
}

export function refreshLabel(seconds: number): string {
  const value = clampRefresh(seconds)
  if (value === 0) return "on demand"
  if (value % 60 === 0) return `${value / 60}m`
  return `${value}s`
}

export function watchlistLabel(watchlist: string[]): string {
  if (watchlist.length === 0) return "none"
  if (watchlist.length <= 6) return watchlist.join(" ")
  return `${watchlist.slice(0, 6).join(" ")} +${watchlist.length - 6}`
}

export function keyLabel(settings: JevSettings, env: Env = process.env): string {
  if (envApiKey(env) !== "") return `${maskApiKey(envApiKey(env))} (environment)`
  return maskApiKey(settings.apiKey)
}

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function formatMoney(value: number | undefined, currency = DEFAULT_SETTINGS.currency): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
    }).format(value)
  } catch {
    // An unknown currency code throws rather than falling back on its own.
    return `${round(value).toLocaleString()} ${currency}`
  }
}

/** Signed money, for a P&L column where the direction is the point. */
export function formatSignedMoney(value: number | undefined, currency = DEFAULT_SETTINGS.currency): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  const body = formatMoney(Math.abs(value), currency)
  if (value > 0) return `+${body}`
  if (value < 0) return `-${body}`
  return body
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  const body = `${round(Math.abs(value)).toFixed(2)}%`
  if (value > 0) return `+${body}`
  if (value < 0) return `-${body}`
  return body
}

export function formatQuantity(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  if (Number.isInteger(value)) return value.toLocaleString()
  return round(value, 4).toString()
}

/** Which way a number leans, so a view can pick a color without repeating the test. */
export function direction(value: number | undefined): "up" | "down" | "flat" {
  if (value === undefined || !Number.isFinite(value) || value === 0) return "flat"
  return value > 0 ? "up" : "down"
}
