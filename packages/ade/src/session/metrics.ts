/**
 * Session metrics: time, tokens, cost.
 *
 * Every formatter takes the raw value and returns a string ready for the UI.
 * The formats match what the rest of ADE already shows — "41s", "3m 08s",
 * "$0,42" — so that the numbers feel native rather than pasted from a log.
 *
 * `SessionTiming` tracks *active* time: the wall clock minus the intervals
 * where the agent was blocked waiting for user permission. That distinction
 * matters because a session that ran for two minutes but spent eighteen of
 * them on a permission prompt is a two-minute session, not a twenty-minute one.
 */

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

/**
 * Human-readable elapsed time, compact.
 *
 * - Under a minute: "41s"
 * - Under an hour:  "3m 08s"
 * - An hour or more: "1h 02m"
 *
 * Negative or non-finite inputs return "0s" — a running timer that hasn't
 * ticked yet is zero, not an error.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"

  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes < 60) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m`
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Compact token count with Italian decimal separator.
 *
 * - Under 1 000: "742"
 * - Under 1 000 000: "2,1k"
 * - 1 000 000+: "1,3M"
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0"

  if (n < 1_000) return String(Math.round(n))

  if (n < 1_000_000) {
    const k = n / 1_000
    return `${k.toFixed(1).replace(".", ",")}k`
  }

  const m = n / 1_000_000
  return `${m.toFixed(1).replace(".", ",")}M`
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * USD cost with Italian decimal separator and dollar prefix.
 *
 * Always two decimals: "$0,42", "$12,00".
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "$0,00"
  return `$${usd.toFixed(2).replace(".", ",")}`
}

// ---------------------------------------------------------------------------
// Elapsed time
// ---------------------------------------------------------------------------

/**
 * Wall-clock milliseconds between two timestamps.
 *
 * Both parameters are epoch-ms, the same unit `Date.now()` returns. Passing
 * `now` explicitly keeps the function pure: the caller owns the clock.
 */
export function elapsed(startedAt: number, now: number): number {
  const diff = now - startedAt
  return diff > 0 ? diff : 0
}

// ---------------------------------------------------------------------------
// Active-time tracking
// ---------------------------------------------------------------------------

/**
 * Accumulates active time across pause/resume cycles.
 *
 * The model is a series of active segments: each `resume` opens one, each
 * `pause` closes it and banks the milliseconds. `activeSegmentStart` being
 * defined means the agent is currently working; `undefined` means it's paused.
 */
export interface SessionTiming {
  /** Epoch-ms when the session started. */
  startedAt: number
  /** Cumulative active milliseconds from completed segments. */
  accumulatedMs: number
  /**
   * Epoch-ms when the current active segment began.
   * `undefined` when the agent is paused (no running segment).
   */
  activeSegmentStart?: number
}

/** Brand-new timing, active from `now`. */
export function startTiming(now: number): SessionTiming {
  return { startedAt: now, accumulatedMs: 0, activeSegmentStart: now }
}

/** Pause: close the current active segment and bank it. Idempotent. */
export function pauseTiming(timing: SessionTiming, now: number): SessionTiming {
  if (timing.activeSegmentStart === undefined) return timing
  const segment = Math.max(0, now - timing.activeSegmentStart)
  return {
    ...timing,
    accumulatedMs: timing.accumulatedMs + segment,
    activeSegmentStart: undefined,
  }
}

/** Resume: open a new active segment. Idempotent. */
export function resumeTiming(timing: SessionTiming, now: number): SessionTiming {
  if (timing.activeSegmentStart !== undefined) return timing
  return { ...timing, activeSegmentStart: now }
}

/** Total active ms up to `now`, including any in-progress segment. */
export function activeElapsed(timing: SessionTiming, now: number): number {
  const inProgress = timing.activeSegmentStart !== undefined ? Math.max(0, now - timing.activeSegmentStart) : 0
  return timing.accumulatedMs + inProgress
}

// ---------------------------------------------------------------------------
// Workbench aggregate
// ---------------------------------------------------------------------------

export interface PaneMetrics {
  tokens: number
  costUsd: number
  activeMs: number
}

export interface WorkbenchMetrics {
  totalTokens: number
  totalCostUsd: number
  totalActiveMs: number
}

/** Sum metrics across all panes in the workbench. */
export function sumMetrics(panes: PaneMetrics[]): WorkbenchMetrics {
  let totalTokens = 0
  let totalCostUsd = 0
  let totalActiveMs = 0
  for (const p of panes) {
    totalTokens += p.tokens
    totalCostUsd += p.costUsd
    totalActiveMs += p.activeMs
  }
  return { totalTokens, totalCostUsd, totalActiveMs }
}
