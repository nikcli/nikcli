#!/usr/bin/env bun
/**
 * `script/perf-baseline.ts` — EOT-01 candidate-budget probe.
 *
 * Boots an isolated nikcli server in-process, fires N requests against the
 * four hot routes (`/global/event`, `/event`, `/health`, `/session/:id/message`
 * when a session can be created), and reports min/median/p95/max in
 * milliseconds plus a counter snapshot from `effect/lifecycle-counters.ts`.
 *
 * This is the probe the spec demands: reproducible measurements against the
 * real router, no mocks. Numbers vary by host, so the script is the *harness*,
 * not a single value. The CI gate uses `script/bench-compare.ts` to diff a
 * recorded baseline against a candidate run.
 *
 * Defaults follow EOT-01: 30 samples per route. Override with `--samples`.
 * Routes can be skipped with `--skip <prefix>`.
 */
import { Effect, Layer } from "effect"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Config } from "@/config/config"
import { Server } from "@/server/server"
import { runtimeFor, runPromise } from "@/effect/runtime"
import { snapshot, reset } from "@/effect/lifecycle-counters"

type Sample = number

function summarize(samples: Sample[]): {
  min: number
  median: number
  p95: number
  max: number
} {
  if (samples.length === 0) return { min: 0, median: 0, p95: 0, max: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]
  return {
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  }
}

function parseArgs(argv: string[]) {
  const out = {
    samples: 30,
    skip: new Set<string>(),
    route: undefined as string | undefined,
    json: undefined as string | undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--samples") out.samples = Math.max(1, Number(argv[++i]))
    else if (arg === "--skip") out.skip.add(argv[++i])
    else if (arg === "--route") out.route = argv[++i]
    else if (arg === "--json") out.json = argv[++i]
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: perf-baseline.ts [--samples N] [--route /path] [--skip /prefix] [--json out.json]")
      process.exit(0)
    }
  }
  return out
}

type Probe = {
  name: string
  method: "GET" | "POST"
  path: string
  buildBody?: (i: number) => string
}

const PROBES: Probe[] = [
  { name: "global/event-head", method: "GET", path: "/global/event" },
  { name: "event-head", method: "GET", path: "/event" },
  // `GET /session`, not `POST /session/list`: the group is declared with
  // `.prefix("/session")` and the endpoint path is `/`. The wrong spelling
  // answered 405 and `time()` recorded it, so the baseline carried a real
  // number for a route that does not exist.
  { name: "session-list", method: "GET", path: "/session" },
]

/**
 * Thrown when a probe does not describe a real request.
 *
 * A baseline is only evidence if every number in it came from the route it
 * claims. A 404 or a 405 answers in microseconds and looks like an excellent
 * result, so swallowing it does not produce a gap in the data — it produces a
 * plausible lie. Anything outside 2xx/3xx stops the run.
 */
class ProbeUnreachable extends Error {
  constructor(probe: Probe, detail: string) {
    super(`${probe.method} ${probe.path}: ${detail}`)
  }
}

async function time(probe: Probe): Promise<Sample> {
  const url = "http://localhost:4096" + probe.path
  const init: RequestInit = { method: probe.method }
  if (probe.buildBody) init.body = probe.buildBody(0)
  const start = performance.now()
  let response: Response
  try {
    response = await Server.fetch(new Request(url, init))
  } catch (error) {
    throw new ProbeUnreachable(probe, `threw ${String(error).slice(0, 120)}`)
  }
  const elapsed = performance.now() - start
  // Cancel before asserting on the status: an SSE body left open keeps the
  // connection — and the process — alive.
  await response.body?.cancel().catch(() => undefined)
  if (response.status >= 400) throw new ProbeUnreachable(probe, `status ${response.status}`)
  return elapsed
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const home = join(tmpdir(), `nikcli-perf-${Date.now()}-${process.pid}`)
  process.env.NIKCLI_TEST_HOME = home
  process.env.NIKCLI_TEST_MODE = "1"
  process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
  process.env.XDG_DATA_HOME = join(home, "data")
  process.env.XDG_CACHE_HOME = join(home, "cache")
  process.env.XDG_CONFIG_HOME = join(home, "config")
  process.env.XDG_STATE_HOME = join(home, "state")

  reset()
  // `Layer.build` produces `Effect<void, never, Scope>`; `runPromise` only
  // accepts `Effect<…, never, never>`, so we wrap with `Effect.scoped`.
  await runPromise(Effect.scoped(Layer.build(Config.defaultLayer).pipe(Effect.asVoid)))

  const routes: {
    name: string
    method: string
    path: string
    n: number
    min: number
    median: number
    p95: number
    max: number
  }[] = []
  const reportLines: string[] = []
  reportLines.push(`nikcli perf baseline — samples=${args.samples} home=${home}`)
  reportLines.push("")

  for (const probe of PROBES) {
    if (args.skip.has(probe.path)) continue
    if (args.route && !probe.path.startsWith(args.route)) continue

    // Warm up one request (router initializes on first hit).
    await time(probe)

    const samples: Sample[] = []
    for (let i = 0; i < args.samples; i++) {
      samples.push(await time(probe))
    }

    const summary = summarize(samples)
    routes.push({ name: probe.name, method: probe.method, path: probe.path, n: samples.length, ...summary })
    reportLines.push(
      `${probe.name.padEnd(20)} min=${summary.min.toFixed(2)}ms  median=${summary.median.toFixed(2)}ms  p95=${summary.p95.toFixed(2)}ms  max=${summary.max.toFixed(2)}ms  (n=${samples.length})`,
    )
  }

  reportLines.push("")
  reportLines.push("lifecycle counters:")
  const snap = snapshot()
  for (const [key, value] of Object.entries(snap)) {
    if (value === 0) continue
    reportLines.push(`  ${key.padEnd(32)} ${value}`)
  }

  console.log(reportLines.join("\n"))

  if (args.json) {
    /**
     * The machine-readable form, for `bench-compare.ts`.
     *
     * `host` is recorded because these timings are not portable and a baseline
     * that hides where it came from invites someone to diff it against a
     * different machine and call the difference a regression.
     */
    const artifact = {
      version: 1,
      recordedAt: new Date().toISOString(),
      samples: args.samples,
      host: {
        platform: process.platform,
        arch: process.arch,
        cpus: navigator.hardwareConcurrency,
        bun: Bun.version,
      },
      routes,
      counters: snap,
    }
    await Bun.write(args.json, JSON.stringify(artifact, null, 2) + "\n")
    console.error(`Wrote ${args.json}`)
  }

  await rm(home, { recursive: true, force: true }).catch(() => undefined)
  // Drop the runtime cache so the next test starts clean.
  const layer = Layer.empty
  const runtime = runtimeFor(layer)
  await runtime.dispose()
}

main().then(
  () => {
    // Explicit, because the in-process server and the instance it booted keep
    // handles open: falling off the end of `main` left the probe running
    // forever. That is why no baseline artifact was ever produced — the
    // measurement finished in under a second and the command never returned.
    process.exit(0)
  },
  (error) => {
    console.error("perf-baseline failed:", error instanceof Error ? error.message : error)
    process.exit(1)
  },
)
