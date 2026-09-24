/**
 * Reading the runtime's pulse.
 *
 * When the stream "feels less fluid", the thing that has actually changed is
 * almost always **event loop delay**: the renderer paints on a loop, and any
 * work that keeps the loop busy postpones the next frame. A markdown re-parse
 * or a whole-message scan does not show up as CPU load worth noticing — it
 * shows up as a frame that arrived late.
 *
 * The functions here turn samples into something a person can read at a glance
 * while using the TUI, which is the point: a jank you can see while it happens
 * is worth more than a benchmark that reproduces it afterwards.
 *
 * Dependency-free on purpose — no Solid, no renderer, no `process`. The caller
 * samples; this only interprets. Same rule as `select-controller.ts` and
 * `path-format.ts`.
 *
 * Ported from opencode v2's `component/devtools-bar.tsx`, where these live
 * inside the component.
 */

export type RuntimeSample = Readonly<{
  /** Percent of one core used since the previous sample. */
  cpu: number
  /** Resident set size, in bytes. */
  memory: number
  /** 99th-percentile event loop delay, in milliseconds. */
  delay: number
  /** `performance.now()` when the sample was taken. */
  time: number
}>

/** How far back `runtimeStatus` looks. */
export const STATUS_WINDOW_MS = 6_000

/** How long samples are kept for the graph. */
export const SAMPLE_RETENTION_MS = 30_000

/** How often to sample. Cheap enough to leave running, coarse enough to be quiet. */
export const SAMPLE_INTERVAL_MS = 2_000

export type RuntimeStatus = "normal" | "medium" | "high"

/** Percent of one core, from microseconds of CPU over milliseconds of wall clock. */
export function cpuPercent(microseconds: number, elapsedMilliseconds: number): number {
  if (elapsedMilliseconds <= 0) return 0
  return (microseconds / 1_000 / elapsedMilliseconds) * 100
}

/**
 * The worst delay in the recent window, bucketed.
 *
 * The thresholds are what they are because of what a person notices. Under
 * 20 ms the loop keeps up with a 50fps repaint and nothing is visibly wrong.
 * Past 100 ms frames are being dropped in visible groups — that is the point
 * where "it stutters" stops being subjective.
 *
 * It takes the **maximum**, not the mean: a stream that is smooth except for a
 * 300 ms stall every second is not a smooth stream, and an average would hide
 * exactly the spike worth seeing.
 */
export function runtimeStatus(samples: readonly Pick<RuntimeSample, "delay" | "time">[]): RuntimeStatus {
  const latest = samples.at(-1)?.time
  if (latest === undefined) return "normal"
  const delay = Math.max(
    0,
    ...samples.filter((sample) => sample.time > latest - STATUS_WINDOW_MS).map((sample) => sample.delay),
  )
  if (delay >= 100) return "high"
  if (delay >= 20) return "medium"
  return "normal"
}

export function statusIcon(status: RuntimeStatus): string {
  if (status === "high") return "●"
  if (status === "medium") return "⦿"
  return "○"
}

/** Keep only the samples still inside the retention window. */
export function retain<Sample extends { time: number }>(samples: readonly Sample[], now: number): Sample[] {
  return samples.filter((sample) => sample.time >= now - SAMPLE_RETENTION_MS)
}

/**
 * A sparkline, two samples per character.
 *
 * Braille cells carry a 2×4 dot matrix, so one character holds two columns of
 * four steps — eight pixels of graph per terminal cell, in a font every
 * terminal already has. The series is scaled to its own min/max rather than to
 * a fixed ceiling: the shape of the variation is what carries the information,
 * and an absolute scale would flatten it to a straight line most of the time.
 *
 * Short input is padded on the left with its first value, so the graph grows
 * from the right as samples arrive instead of stretching.
 */
export function brailleGraph(values: readonly number[], width: number): string {
  if (width <= 0 || values.length === 0) return ""
  const min = Math.min(...values)
  const range = Math.max(...values) - min
  const points = [
    ...Array<number | undefined>(Math.max(0, width * 2 - values.length)).fill(values.at(0)),
    ...values,
  ].slice(-width * 2)
  // Dot bit positions per column, bottom row first — the braille block orders
  // its lower dots after the upper ones, so this cannot be a plain range.
  const dots = [
    [6, 2, 1, 0],
    [7, 5, 4, 3],
  ] as const
  return Array.from({ length: width }, (_, index) => {
    const bits = [points[index * 2], points[index * 2 + 1]].reduce<number>((result, value, column) => {
      if (value === undefined) return result
      const height = 1 + Math.round((range === 0 ? 0 : (value - min) / range) * 3)
      return dots[column]!.slice(0, height).reduce<number>((bits, dot) => bits | (1 << dot), result)
    }, 0)
    return String.fromCodePoint(0x2800 + bits)
  }).join("")
}

export type SampleSummary = {
  count: number
  min: number
  median: number
  p95: number
  max: number
}

/**
 * Nearest-rank percentile. Empty input is a failed measurement, not a zero-cost
 * success: a missing sample must not look like a 0 ms result.
 */
export function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new Error("nearestRank requires at least one sample")
  if (!(percentile > 0) || percentile > 100) throw new Error("percentile must be in (0, 100]")
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.ceil((percentile / 100) * sorted.length)
  return sorted[Math.max(0, rank - 1)]!
}

/** min / nearest-rank median / nearest-rank p95 / max. */
export function summarizeSamples(values: readonly number[]): SampleSummary {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    min: sorted[0] ?? nearestRank(sorted, 100),
    median: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    max: nearestRank(sorted, 100),
  }
}

/** `(candidate - baseline) / baseline`. Zero baseline is invalid, not infinity. */
export function relativeDelta(baseline: number, candidate: number): number {
  if (baseline === 0) throw new Error("relativeDelta requires a non-zero baseline")
  return (candidate - baseline) / baseline
}

/** `1.4 GB`, `312 MB`, `48 kB` — two significant digits is all a bar needs. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${Math.round(bytes)} B`
  const units = ["kB", "MB", "GB", "TB"]
  let value = bytes / 1_024
  let unit = 0
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Why a startup attempt produced no sample. `specs/effect-tui/00-startup-hang.md`:
 * a wedged start is data, not an aborted collection — a probe that throws on the
 * first one can never report how often it happens.
 */
export type StartupStall = "never-painted" | "no-prompt"

export type StallRate = { attempts: number; stalls: number; hangRate: number }

/**
 * Stalled attempts over all attempts. Zero attempts is a measurement that did not
 * happen, not a clean run, so it throws rather than reporting a rate of 0.
 */
export function stallRate(attempts: number, stalls: number): StallRate {
  if (!Number.isInteger(attempts) || attempts <= 0) throw new Error("stallRate requires at least one attempt")
  if (!Number.isInteger(stalls) || stalls < 0 || stalls > attempts) {
    throw new Error(`stalls must be an integer in [0, ${attempts}], got ${stalls}`)
  }
  return { attempts, stalls, hangRate: stalls / attempts }
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const CONTROL_SEQUENCE = new RegExp(
  [
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[P_^][^${ESC}]*${ESC}\\\\`,
    `${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`,
    `${ESC}[@-Z\\\\-_]`,
  ].join("|"),
  "g",
)
const OSC_TERMINATOR = new RegExp(`(?:${BEL}|${ESC}\\\\)$`)
const STRING_TERMINATOR = new RegExp(`${ESC}\\\\$`)

/**
 * The last control sequences a terminal was sent, with every payload reduced to
 * what identifies the request.
 *
 * This is what located the never-paints startup: its last output was the block
 * of capability queries the renderer sends before its first frame. Keeping the
 * raw tail instead would carry window titles, working directories and screen
 * text into a shared report, which EOT-01 forbids — so OSC keeps its number and
 * whether it is a query, DCS and APC keep a short command prefix (enough for
 * `+q` XTGETTCAP or the Kitty `G` graphics query), and CSI, which carries no
 * content, is kept whole.
 */
export function trailingControlSequences(raw: string, limit = 12): string[] {
  const labels: string[] = []
  for (const [sequence] of raw.matchAll(CONTROL_SEQUENCE)) {
    const introducer = sequence[1]
    if (introducer === "]") {
      const body = sequence.slice(2).replace(OSC_TERMINATOR, "")
      const [command = "", ...rest] = body.split(";")
      labels.push(`OSC ${command}${rest.includes("?") ? ";?" : ""}`)
    } else if (introducer === "P" || introducer === "_" || introducer === "^") {
      const name = introducer === "P" ? "DCS" : introducer === "_" ? "APC" : "PM"
      const body = sequence.slice(2).replace(STRING_TERMINATOR, "")
      labels.push(`${name} ${body.slice(0, 8).split(/[;,]/)[0]}`)
    } else if (introducer === "[") {
      labels.push(`CSI ${sequence.slice(2)}`)
    } else {
      labels.push(`ESC ${sequence.slice(1)}`)
    }
  }
  return limit > 0 ? labels.slice(-limit) : []
}
