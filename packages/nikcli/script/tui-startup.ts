#!/usr/bin/env bun
/**
 * Time-to-first-paint and time-to-usable-prompt for the compiled TUI.
 *
 * `--version` and `--help` never import `@opentui/core`, so they cannot measure
 * a startup regression in the terminal. This spawns the real binary in a PTY
 * and records first printable content plus the interactive prompt, which is
 * the comparison `specs/effect-tui/08-host-plugins-startup.md` asks across a
 * packaging change: a new `package.json` that re-imports a backend chain shows
 * up here and nowhere else.
 *
 * Warm runs share one NIKCLI_TEST_HOME after a separately reported bootstrap
 * (migrations and config). Cold runs each get an isolated home. Defaults follow
 * EOT-01: 30 warm samples and 10 descriptive cold samples. Override with
 * WARM_RUNS / COLD_RUNS (`RUNS` is an alias for WARM_RUNS).
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnPty, type NativePty } from "@nikcli-ai/util/pty"
import {
  formatBytes,
  stallRate,
  summarizeSamples,
  trailingControlSequences,
  type SampleSummary,
  type StartupStall,
} from "@tui/util/runtime-samples"
import { formatProbeEnvironment, probeEnvironment } from "@nikcli-ai/util/probe-env"

const BIN = process.argv[2] ?? ""
if (!BIN || !existsSync(BIN)) throw new Error(`usage: tui-startup.ts <binary>  (got ${BIN || "nothing"})`)

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, "..")
const repoRoot = findRepoRoot(packageRoot)
const WARM_RUNS = envInt("WARM_RUNS", envInt("RUNS", 30))
const COLD_RUNS = envInt("COLD_RUNS", 10)
const COLS = envInt("COLS", 100)
const ROWS = envInt("ROWS", 30)
const TIMEOUT_MS = envInt("TIMEOUT_MS", 60_000)
const HOST_MODE = process.env.HOST_MODE || "embedded"
const PROMPT_MARKERS = (process.env.PROMPT_MARKERS || "Ask anything,Run a command")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)

if (WARM_RUNS === 0 && COLD_RUNS === 0) {
  throw new Error("WARM_RUNS and COLD_RUNS cannot both be 0")
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI_OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g")
const ANSI_DCS = new RegExp(`${ESC}P[^${ESC}]*${ESC}\\\\`, "g")
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, "g")
const ANSI_OTHER = new RegExp(`${ESC}[@-Z\\\\-_]`, "g")
function plain(raw: string) {
  return raw.replace(ANSI_OSC, "").replace(ANSI_DCS, "").replace(ANSI_CSI, "").replace(ANSI_OTHER, "")
}

function envInt(name: string, fallback: number) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return Math.floor(value)
}

function findRepoRoot(start: string) {
  let dir = start
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/** Child RSS in bytes. Absent on this host/OS, not a zero-cost success. */
function rssBytes(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === "linux") {
      const status = readFileSync(`/proc/${pid}/status`, "utf8")
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m)
      if (!match) return undefined
      return Number(match[1]) * 1024
    }
    const result = Bun.spawnSync({
      cmd: ["ps", "-o", "rss=", "-p", String(pid)],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) return undefined
    const kb = Number(new TextDecoder().decode(result.stdout).trim())
    if (!Number.isFinite(kb) || kb <= 0) return undefined
    return Math.round(kb * 1024)
  } catch {
    return undefined
  }
}

type Marks = {
  spawnMs: number
  firstPaintMs: number
  usablePromptMs: number
  /** Child RSS at usable prompt, when the host can read it. Missing is omitted, never 0. */
  rssBytes?: number
}

/**
 * A start that produced no sample. Recorded, never thrown: one wedged start used
 * to abort the whole collection, so the probe could not say how often it happens
 * (`specs/effect-tui/00-startup-hang.md`, requirement 1). `lastSequences` is what
 * the terminal was last sent, payloads reduced to request names — the evidence
 * that located the capability-negotiation hang, without carrying screen text or
 * paths into the report.
 */
type Stall = {
  outcome: StartupStall
  spawnMs: number
  /** Present for `no-prompt`: the frame arrived, the prompt did not. */
  firstPaintMs?: number
  lastSequences: string[]
}

type Attempt = { ok: true; marks: Marks } | { ok: false; stall: Stall }

const live = new Set<NativePty>()
const homes = new Set<string>()

/** Bounded grace period between SIGTERM and SIGKILL when reaping a probe child. */
const REAP_GRACE_MS = 2000

function scratch() {
  const home = mkdtempSync(path.join(os.tmpdir(), "nikcli-startup-"))
  homes.add(home)
  return home
}

/**
 * Resolve when the child has actually exited, or escalate to SIGKILL after a
 * bounded grace period. The probe must not advance to the next sample, nor
 * remove the per-run home directory, while the child still holds the terminal
 * or its temporary files; doing so leaves overlapping processes and unreadable
 * failures. The previous implementation called `pty.kill()` without waiting,
 * which did not detect a hung child or guarantee cleanup before home removal.
 */
export async function waitForExit(pty: NativePty): Promise<void> {
  let resolveExit!: () => void
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  pty.onExit(() => resolveExit())
  // `kill` already escalates from pending data and exits; the onExit listener
  // fires when the child actually leaves the process table.
  pty.kill()
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, REAP_GRACE_MS)
  })
  // Resolve synchronously when the child exits, so we never settle `exited`
  // after `grace` and miss the escalation. The second await checks whether
  // SIGTERM was enough: if not, escalate to SIGKILL and wait for the real
  // exit. A race-free check would need a shared flag, so the `onExit` callback
  // resolves the same `exited` promise we await below.
  let exitedBeforeGrace = false
  const track = exited.then(() => {
    exitedBeforeGrace = true
  })
  await Promise.race([track, grace])
  if (!exitedBeforeGrace) {
    if (timer) clearTimeout(timer)
    pty.kill("SIGKILL")
  }
  await exited
}

async function reap() {
  // Reap child PTYs deterministically: signal once, wait, then escalate.
  // Awaiting all of them concurrently keeps the total shutdown bounded by the
  // slowest child rather than N * REAP_GRACE_MS.
  await Promise.all([...live].map((pty) => waitForExit(pty)))
  live.clear()
  for (const home of homes) {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
  homes.clear()
}

async function once(home: string): Promise<Attempt> {
  const started = performance.now()
  let firstPaintMs = 0
  let usablePromptMs = 0
  let raw = ""

  const pty = spawnPty({
    command: BIN,
    cols: COLS,
    rows: ROWS,
    cwd: home,
    env: {
      ...process.env,
      NIKCLI_TEST_HOME: home,
      NIKCLI_DISABLE_AUTOUPDATE: "1",
      NIKCLI_TERMINAL: "1",
      TERM: process.env.TERM || "xterm-256color",
    },
  })
  live.add(pty)
  const spawnMs = performance.now() - started

  pty.onData((data) => {
    raw += data
    const text = plain(raw)
    if (!firstPaintMs && text.replace(/\s/g, "").length > 200) firstPaintMs = performance.now() - started
    if (!usablePromptMs && PROMPT_MARKERS.some((marker) => text.includes(marker))) {
      usablePromptMs = performance.now() - started
    }
  })

  const deadline = Date.now() + TIMEOUT_MS
  while ((!firstPaintMs || !usablePromptMs) && Date.now() < deadline) await Bun.sleep(10)
  const rss = rssBytes(pty.pid)
  // Wait for the child to exit before deleting the per-run home. Otherwise the
  // next sample inherits a database file that may still be locked by the prior
  // child on some hosts, and bootstrap races overlap their migrations.
  await waitForExit(pty)
  live.delete(pty)
  if (!firstPaintMs || !usablePromptMs) {
    return {
      ok: false,
      stall: {
        outcome: firstPaintMs ? "no-prompt" : "never-painted",
        spawnMs,
        ...(firstPaintMs ? { firstPaintMs } : {}),
        lastSequences: trailingControlSequences(raw),
      },
    }
  }
  return { ok: true, marks: { spawnMs, firstPaintMs, usablePromptMs, rssBytes: rss } }
}

function describeStall(stall: Stall) {
  const painted = stall.firstPaintMs !== undefined ? ` firstPaint=${stall.firstPaintMs.toFixed(0)}ms` : ""
  const last = stall.lastSequences.length > 0 ? ` last=[${stall.lastSequences.join(", ")}]` : " last=[]"
  return `STALLED ${stall.outcome} after ${TIMEOUT_MS}ms${painted}${last}`
}

function definedNumbers(values: readonly (number | undefined)[]) {
  return values.filter((value): value is number => value !== undefined)
}

function series(samples: Marks[]) {
  return {
    spawnMs: samples.map((sample) => sample.spawnMs),
    firstPaintMs: samples.map((sample) => sample.firstPaintMs),
    usablePromptMs: samples.map((sample) => sample.usablePromptMs),
    rssBytes: definedNumbers(samples.map((sample) => sample.rssBytes)),
  }
}

/**
 * Progress goes to stderr, the JSON report to stdout.
 *
 * `bun run bench:startup <bin> > baseline.json` has to produce a file
 * `script/bench-compare.ts` can read, and it could not while the percentile
 * lines shared the stream with the report. EOT-01's P0 exit asks for "a
 * baseline comparison format"; a blob that needs a human to trim it is not one.
 */
function progress(...args: unknown[]) {
  console.error(...args)
}

function line(label: string, stats: SampleSummary, note?: string, format: (value: number) => string = ms) {
  const suffix = note ? ` ${note}` : ""
  progress(
    `${label}: n=${stats.count} min=${format(stats.min)} median=${format(stats.median)} p95=${format(stats.p95)} max=${format(stats.max)}${suffix}`,
  )
}

function ms(value: number) {
  return `${value.toFixed(0)}ms`
}

type WarmSummary = {
  firstPaint: SampleSummary | null
  usablePrompt: SampleSummary | null
  rssBytes: SampleSummary | null
}

function samplesLine(label: string, values: number[], format: (value: number) => string = (value) => value.toFixed(0)) {
  progress(`${label}: ${values.map(format).join(",")}`)
}

/**
 * Compare this run against a stored one, when `BASELINE` names a file.
 *
 * `script/bench-compare.ts` cannot do this: it reads the `test/benchmarks`
 * runner's `{ samples: [{ suite, name }] }` shape, while this probe emits
 * warm/cold series. Feeding one to the other fails with "samples.map is not a
 * function", which is how the P0 "baseline comparison format" turned out to be
 * two formats that do not meet.
 *
 * Descriptive by default. `BASELINE_MAX_REGRESSION` (a percentage) makes it a
 * gate: exceed it on a warm median or p95 and the probe exits non-zero. Cold
 * samples stay descriptive — EOT-01 already treats them that way, and 10 cold
 * runs on a loaded machine do not support a threshold.
 */
function compareAgainstBaseline(report: { startup: { hangRate: number }; summary: { warm: WarmSummary | null } }) {
  const file = process.env.BASELINE
  if (!file) return
  if (!existsSync(file)) throw new Error(`BASELINE file not found: ${file}`)

  const previous = JSON.parse(readFileSync(file, "utf8")) as {
    startup?: { hangRate?: number }
    summary?: { warm?: WarmSummary | null }
  }
  // A baseline recorded before stalls were counted has no rate; say so rather
  // than reading its absence as a clean 0.
  const hangBefore = previous.startup?.hangRate
  progress(
    `baseline hangRate: ${hangBefore === undefined ? "not recorded" : hangBefore.toFixed(3)} -> ${report.startup.hangRate.toFixed(3)}`,
  )
  const before = previous.summary?.warm
  const after = report.summary.warm
  if (!before || !after) {
    progress("baseline: one of the two runs has no warm samples; nothing to compare")
    return
  }

  const limit = process.env.BASELINE_MAX_REGRESSION ? Number(process.env.BASELINE_MAX_REGRESSION) : undefined
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`BASELINE_MAX_REGRESSION must be a positive percentage, got ${process.env.BASELINE_MAX_REGRESSION}`)
  }

  const regressions: string[] = []
  for (const metric of ["firstPaint", "usablePrompt", "rssBytes"] as const) {
    const a = before[metric]
    const b = after[metric]
    if (!a || !b) continue
    const format = metric === "rssBytes" ? formatBytes : ms
    for (const stat of ["median", "p95"] as const) {
      const from = a[stat]
      const to = b[stat]
      // A zero baseline cannot express a percentage, and a metric that was
      // zero and is not any more is a change worth seeing rather than dividing.
      const delta = from === 0 ? Number.POSITIVE_INFINITY : ((to - from) / from) * 100
      const sign = delta >= 0 ? "+" : ""
      progress(`baseline warm ${metric} ${stat}: ${format(from)} -> ${format(to)} (${sign}${delta.toFixed(1)}%)`)
      if (limit !== undefined && delta > limit) {
        regressions.push(`${metric} ${stat} ${sign}${delta.toFixed(1)}% (limit ${limit}%)`)
      }
    }
  }

  if (regressions.length > 0) {
    throw new Error(`startup regressed against ${file}: ${regressions.join(", ")}`)
  }
}

// Shared with `packages/tui/script/import-cost.ts` so two probes emit one
// comparison format instead of two that drift apart.
const environment = {
  ...probeEnvironment({ spec: "EOT-01", repoRoot }),
  terminal: {
    term: process.env.TERM || "xterm-256color",
    cols: COLS,
    rows: ROWS,
  },
  hostMode: HOST_MODE,
  instrumentation: process.env.INSTRUMENTATION || "off",
}

let shuttingDown = false
async function fail(error: unknown, code = 1): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true
    await reap()
  }
  console.error(error instanceof Error ? error.message : error)
  process.exit(code)
}

process.on("SIGINT", () => {
  void fail("interrupted", 130)
})
process.on("SIGTERM", () => {
  void fail("terminated", 143)
})

try {
  // Context first: the percentile lines below are meaningless next to another
  // run's without the revision and machine that produced them. This used to
  // reach the JSON blob on the last line and nowhere else.
  progress(formatProbeEnvironment(environment))

  const warm: Marks[] = []
  const cold: Marks[] = []
  let bootstrap: Marks | undefined
  const stalls: { bootstrap: Stall | null; warm: Stall[]; cold: Stall[] } = { bootstrap: null, warm: [], cold: [] }
  let attempts = 0

  if (WARM_RUNS > 0) {
    const home = scratch()
    const first = await once(home)
    attempts++
    if (first.ok) {
      bootstrap = first.marks
      const bootstrapRss = bootstrap.rssBytes !== undefined ? ` rss=${formatBytes(bootstrap.rssBytes)}` : ""
      progress(
        `bootstrap: spawn=${bootstrap.spawnMs.toFixed(0)}ms firstPaint=${bootstrap.firstPaintMs.toFixed(0)}ms usablePrompt=${bootstrap.usablePromptMs.toFixed(0)}ms${bootstrapRss} (fresh home, not a warm sample)`,
      )
    } else {
      stalls.bootstrap = first.stall
      progress(`bootstrap: ${describeStall(first.stall)} (fresh home, not a warm sample)`)
    }
    await Bun.sleep(500)
    for (let i = 0; i < WARM_RUNS; i++) {
      const attempt = await once(home)
      attempts++
      if (!attempt.ok) {
        stalls.warm.push(attempt.stall)
        progress(`warm ${i + 1}/${WARM_RUNS}: ${describeStall(attempt.stall)}`)
        await Bun.sleep(500)
        continue
      }
      const sample = attempt.marks
      warm.push(sample)
      const rss = sample.rssBytes !== undefined ? ` rss=${formatBytes(sample.rssBytes)}` : ""
      progress(
        `warm ${i + 1}/${WARM_RUNS}: firstPaint=${sample.firstPaintMs.toFixed(0)}ms usablePrompt=${sample.usablePromptMs.toFixed(0)}ms${rss}`,
      )
      await Bun.sleep(500)
    }
  }

  for (let i = 0; i < COLD_RUNS; i++) {
    const home = scratch()
    const attempt = await once(home)
    attempts++
    if (!attempt.ok) {
      stalls.cold.push(attempt.stall)
      progress(`cold ${i + 1}/${COLD_RUNS}: ${describeStall(attempt.stall)}`)
      await rm(home, { recursive: true, force: true }).catch(() => {})
      homes.delete(home)
      await Bun.sleep(500)
      continue
    }
    const sample = attempt.marks
    cold.push(sample)
    const rss = sample.rssBytes !== undefined ? ` rss=${formatBytes(sample.rssBytes)}` : ""
    progress(
      `cold ${i + 1}/${COLD_RUNS}: firstPaint=${sample.firstPaintMs.toFixed(0)}ms usablePrompt=${sample.usablePromptMs.toFixed(0)}ms${rss}`,
    )
    await rm(home, { recursive: true, force: true }).catch(() => {})
    homes.delete(home)
    await Bun.sleep(500)
  }

  const warmSeries = series(warm)
  const coldSeries = series(cold)
  if (warm.length > 0) {
    line("warm firstPaint", summarizeSamples(warmSeries.firstPaintMs))
    line("warm usablePrompt", summarizeSamples(warmSeries.usablePromptMs))
    if (warmSeries.rssBytes.length > 0) line("warm rss", summarizeSamples(warmSeries.rssBytes), undefined, formatBytes)
    samplesLine("warm firstPaint samples", warmSeries.firstPaintMs)
    samplesLine("warm usablePrompt samples", warmSeries.usablePromptMs)
    if (warmSeries.rssBytes.length > 0) samplesLine("warm rss samples", warmSeries.rssBytes, formatBytes)
  }
  if (cold.length > 0) {
    line("cold firstPaint", summarizeSamples(coldSeries.firstPaintMs), "(descriptive only)")
    line("cold usablePrompt", summarizeSamples(coldSeries.usablePromptMs), "(descriptive only)")
    if (coldSeries.rssBytes.length > 0) {
      line("cold rss", summarizeSamples(coldSeries.rssBytes), "(descriptive only)", formatBytes)
    }
    samplesLine("cold firstPaint samples", coldSeries.firstPaintMs)
    samplesLine("cold usablePrompt samples", coldSeries.usablePromptMs)
    if (coldSeries.rssBytes.length > 0) samplesLine("cold rss samples", coldSeries.rssBytes, formatBytes)
  }

  // `environment.os.loadavg1` was read before the first spawn. A probe that
  // runs for minutes needs the load it actually ran under, and the probe's own
  // samples contribute to it — a clean reading at the start says nothing about
  // sample 30.
  const loadavg1AtEnd = os.loadavg()[0]
  progress(`load: start=${environment.os.loadavg1.toFixed(2)} end=${loadavg1AtEnd.toFixed(2)}`)

  const startup = stallRate(attempts, (stalls.bootstrap ? 1 : 0) + stalls.warm.length + stalls.cold.length)
  progress(`startup: ${startup.stalls}/${startup.attempts} stalled (hangRate=${startup.hangRate.toFixed(3)})`)

  const report = {
    environment,
    loadavg1AtEnd,
    startup,
    stalls,
    bootstrap: bootstrap ?? null,
    samples: {
      warm: warmSeries,
      cold: coldSeries,
    },
    summary: {
      warm: warm.length
        ? {
            firstPaint: summarizeSamples(warmSeries.firstPaintMs),
            usablePrompt: summarizeSamples(warmSeries.usablePromptMs),
            rssBytes: warmSeries.rssBytes.length > 0 ? summarizeSamples(warmSeries.rssBytes) : null,
          }
        : null,
      cold: cold.length
        ? {
            firstPaint: summarizeSamples(coldSeries.firstPaintMs),
            usablePrompt: summarizeSamples(coldSeries.usablePromptMs),
            rssBytes: coldSeries.rssBytes.length > 0 ? summarizeSamples(coldSeries.rssBytes) : null,
            note: "descriptive only",
          }
        : null,
    },
  }
  compareAgainstBaseline(report)
  console.log(JSON.stringify(report))
  await reap()
  // The report is complete either way; a stalled start still fails the check,
  // because a startup that sometimes does not happen is not a pass.
  process.exit(startup.stalls > 0 ? 1 : 0)
} catch (error) {
  await fail(error)
}
