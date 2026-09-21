/**
 * The shapes the JEV plugin renders, and the mapping from whatever the
 * deployment answered into them.
 *
 * Deliberately forgiving. JEV is a hosted product whose payloads are free to
 * gain and rename fields between deploys, and a terminal panel that goes blank
 * because `equity` was renamed `totalEquity` is worse than one that reads both.
 * So every field is looked up under the names it plausibly carries, numbers are
 * accepted as strings, and a collection is unwrapped from whichever envelope it
 * arrived in. Anything genuinely missing stays `undefined` and renders as `—`.
 *
 * Everything here is pure: the panels are testable without a network.
 */

export type JevPortfolio = {
  equity?: number
  cash?: number
  /** Value of the open positions, when reported separately from cash. */
  invested?: number
  pnlDay?: number
  pnlDayPercent?: number
  pnlTotal?: number
  pnlTotalPercent?: number
  currency?: string
  positions?: number
}

export type JevPosition = {
  symbol: string
  side?: "long" | "short"
  quantity?: number
  entryPrice?: number
  lastPrice?: number
  value?: number
  pnl?: number
  pnlPercent?: number
}

export type JevQuote = {
  symbol: string
  price?: number
  change?: number
  changePercent?: number
}

export type JevSignal = {
  symbol: string
  /** Free-form on purpose: JEV is agentic and may answer more than buy/sell/hold. */
  action: string
  confidence?: number
  rationale?: string
  at?: string
}

export type JevOverview = {
  portfolio?: JevPortfolio
  positions: JevPosition[]
  quotes: JevQuote[]
  /** Per-section failures, so one dead route does not blank the whole panel. */
  errors: string[]
}

/** How long a rationale may be before a terminal row stops being a row. */
const TEXT_MAX = 200

/**
 * Make external text safe to hand a terminal.
 *
 * The strings below come from a remote service and are printed straight into
 * the screen buffer, so escape sequences — which could move the cursor, repaint
 * unrelated rows or set the window title — are stripped rather than trusted,
 * and newlines are collapsed so one field cannot take over the panel.
 */
export function sanitizeText(value: string, max = TEXT_MAX): string {
  const stripped = value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  const collapsed = stripped.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** First key that holds a finite number. Numeric strings count: JSON APIs send both. */
export function pickNumber(source: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  if (!source) return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value.replace(/[,_\s]/g, "").replace(/%$/, ""))
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

export function pickText(source: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!source) return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value.trim() !== "") return sanitizeText(value)
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return undefined
}

/**
 * Unwrap a list out of whatever envelope it came in: a bare array, `{ data }`,
 * `{ items }`, `{ results }`, or a named key like `{ positions }`.
 */
export function pickRows(raw: unknown, ...keys: string[]): Record<string, unknown>[] {
  const rows = (() => {
    if (Array.isArray(raw)) return raw
    const source = record(raw)
    if (!source) return []
    for (const key of [...keys, "data", "items", "results", "rows"]) {
      const value = source[key]
      if (Array.isArray(value)) return value
      // `{ data: { positions: [] } }` — one nested envelope is common enough to follow.
      const nested = record(value)
      if (nested) {
        for (const inner of keys) {
          if (Array.isArray(nested[inner])) return nested[inner] as unknown[]
        }
      }
    }
    return []
  })()
  return rows.map((row) => record(row)).filter((row): row is Record<string, unknown> => row !== undefined)
}

/** Unwrap a single object out of `{ data }` / `{ portfolio }` style envelopes. */
export function pickObject(raw: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  const source = record(raw)
  if (!source) return undefined
  for (const key of [...keys, "data", "result"]) {
    const nested = record(source[key])
    if (nested) return nested
  }
  return source
}

function currencyOf(source: Record<string, unknown> | undefined): string | undefined {
  const value = pickText(source, "currency", "quoteCurrency", "baseCurrency")
  if (!value) return undefined
  const upper = value.toUpperCase()
  return /^[A-Z]{3,5}$/.test(upper) ? upper : undefined
}

function symbolOf(row: Record<string, unknown>): string {
  const value = pickText(row, "symbol", "ticker", "asset", "pair", "instrument", "market", "name") ?? ""
  return value.toUpperCase().slice(0, 16)
}

export function normalizePortfolio(raw: unknown): JevPortfolio | undefined {
  const source = pickObject(raw, "portfolio", "account", "summary")
  if (!source) return undefined
  const portfolio: JevPortfolio = {
    equity: pickNumber(source, "equity", "totalEquity", "netLiquidation", "totalValue", "value", "balance"),
    cash: pickNumber(source, "cash", "cashBalance", "available", "availableCash", "buyingPower"),
    invested: pickNumber(source, "invested", "positionsValue", "marketValue", "exposure"),
    pnlDay: pickNumber(source, "pnlDay", "dayPnl", "dailyPnl", "todayPnl", "unrealizedDayPnl"),
    pnlDayPercent: pickNumber(source, "pnlDayPercent", "dayPnlPercent", "dailyChangePercent", "changePercent"),
    pnlTotal: pickNumber(source, "pnlTotal", "totalPnl", "pnl", "profit", "unrealizedPnl"),
    pnlTotalPercent: pickNumber(source, "pnlTotalPercent", "totalPnlPercent", "returnPercent", "roi"),
    currency: currencyOf(source),
    positions: pickNumber(source, "positions", "positionsCount", "openPositions"),
  }
  const empty = Object.values(portfolio).every((value) => value === undefined)
  return empty ? undefined : portfolio
}

export function normalizePositions(raw: unknown): JevPosition[] {
  return pickRows(raw, "positions", "holdings", "openPositions")
    .map((row): JevPosition => {
      const side = (pickText(row, "side", "direction", "type") ?? "").toLowerCase()
      const quantity = pickNumber(row, "quantity", "qty", "size", "amount", "shares", "units")
      return {
        symbol: symbolOf(row),
        side: side.startsWith("short") || (quantity !== undefined && quantity < 0) ? "short" : "long",
        quantity: quantity === undefined ? undefined : Math.abs(quantity),
        entryPrice: pickNumber(row, "entryPrice", "avgPrice", "averagePrice", "costBasis", "openPrice", "entry"),
        lastPrice: pickNumber(row, "lastPrice", "price", "markPrice", "currentPrice", "last", "close"),
        value: pickNumber(row, "value", "marketValue", "notional", "positionValue"),
        pnl: pickNumber(row, "pnl", "unrealizedPnl", "profit", "gain", "pl"),
        pnlPercent: pickNumber(
          row,
          "pnlPercent",
          "unrealizedPnlPercent",
          "changePercent",
          "returnPercent",
          "plPercent",
        ),
      }
    })
    .filter((position) => position.symbol !== "")
}

export function normalizeQuotes(raw: unknown): JevQuote[] {
  return pickRows(raw, "quotes", "tickers", "prices", "markets")
    .map(
      (row): JevQuote => ({
        symbol: symbolOf(row),
        price: pickNumber(row, "price", "last", "lastPrice", "close", "mark", "mid"),
        change: pickNumber(row, "change", "priceChange", "diff"),
        changePercent: pickNumber(row, "changePercent", "changePct", "percentChange", "change24h", "dayChangePercent"),
      }),
    )
    .filter((quote) => quote.symbol !== "")
}

export function normalizeSignals(raw: unknown): JevSignal[] {
  return pickRows(raw, "signals", "ideas", "alerts", "recommendations")
    .map((row): JevSignal => {
      const confidence = pickNumber(row, "confidence", "score", "conviction", "probability")
      return {
        symbol: symbolOf(row),
        action: (pickText(row, "action", "side", "signal", "direction", "recommendation") ?? "—").toLowerCase(),
        // A confidence given as 0..1 and one given as 0..100 both end up a percent.
        confidence: confidence === undefined ? undefined : confidence <= 1 ? confidence * 100 : confidence,
        rationale: pickText(row, "rationale", "reason", "thesis", "summary", "note", "description"),
        at: pickText(row, "at", "createdAt", "timestamp", "time", "date"),
      }
    })
    .filter((signal) => signal.symbol !== "")
}

/** Tint an action name the way the panels do, without each of them re-deciding. */
export function actionDirection(action: string): "up" | "down" | "flat" {
  const value = action.toLowerCase()
  if (/(^|\b)(buy|long|accumulate|add|bullish)/.test(value)) return "up"
  if (/(^|\b)(sell|short|exit|reduce|close|bearish)/.test(value)) return "down"
  return "flat"
}
