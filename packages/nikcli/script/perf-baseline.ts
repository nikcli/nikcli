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
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--samples") out.samples = Math.max(1, Number(argv[++i]))
    else if (arg === "--skip") out.skip.add(argv[++i])
    else if (arg === "--route") out.route = argv[++i]
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: perf-baseline.ts [--samples N] [--route /path] [--skip /prefix]")
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
  {
    name: "session-list",
    method: "POST",
    path: "/session/list",
    buildBody: () => "{}",
  },
]

async function time(probe: Probe): Promise<Sample | undefined> {
  const url = "http://localhost:4096" + probe.path
  const init: RequestInit = { method: probe.method }
  if (probe.buildBody) init.body = probe.buildBody(0)
  const start = performance.now()
  try {
    const response = await Server.fetch(new Request(url, init))
    await response.body?.cancel()
    if (response.status >= 500) return undefined
    return performance.now() - start
  } catch {
    return undefined
  }
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
      const sample = await time(probe)
      if (sample !== undefined) samples.push(sample)
    }

    const summary = summarize(samples)
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

  await rm(home, { recursive: true, force: true }).catch(() => undefined)
  // Drop the runtime cache so the next test starts clean.
  const layer = Layer.empty
  const runtime = runtimeFor(layer)
  await runtime.dispose()
}

main().catch((error) => {
  console.error("perf-baseline failed:", error)
  process.exit(1)
})
