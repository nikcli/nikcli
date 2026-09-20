#!/usr/bin/env bun
/**
 * `script/check-perf-baseline.ts` — the EOT-01 / P0 baseline gate.
 *
 * P0's exit says: *"Ratify EOT-01 candidate budgets in a reviewed baseline
 * artifact. A noisy or missing baseline is not a pass."* This is what makes the
 * artifact at `specs/perf-baseline.json` reviewable rather than decorative.
 *
 * **What it checks and what it deliberately does not.**
 *
 * Wall-clock timings are not portable. The same probe reports 0.04 ms on this
 * laptop and something else entirely on a shared CI runner, so a committed
 * threshold on milliseconds would fail for the runner's reasons rather than the
 * code's — and a gate that fires for reasons unrelated to the change is one
 * people learn to re-run until it passes. The roadmap's own wording is the
 * argument: a noisy baseline is not a pass either.
 *
 * So the gate splits the artifact in two:
 *
 *  - **Deterministic, enforced.** Every declared route is present, every route
 *    carries the full sample count, min ≤ median ≤ p95 ≤ max, and the lifecycle
 *    counters balance: `scope.created` equals completed + interrupted + failed,
 *    and `scope.finalizer-leak` is zero. Those hold on any machine, and a
 *    change that breaks one is a change in behaviour, not in hardware.
 *  - **Host-dependent, reported.** The timings are printed and, with
 *    `--against <run.json>`, diffed. A diff across different hosts refuses
 *    rather than reporting a number nobody should act on.
 *
 * Regenerate the artifact with:
 *
 *     bun run script/perf-baseline.ts --samples 30 --json specs/perf-baseline.json
 */

import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..")
const DEFAULT_ARTIFACT = path.join(PACKAGE_ROOT, "specs", "perf-baseline.json")

/** Regressions past this fraction are reported by `--against`. 0.5 = 50% slower. */
const P95_REGRESSION = 0.5

type Route = {
  name: string
  method: string
  path: string
  n: number
  min: number
  median: number
  p95: number
  max: number
}
type Artifact = {
  version: number
  recordedAt: string
  samples: number
  host: { platform: string; arch: string; cpus: number; bun: string }
  routes: Route[]
  counters: Record<string, number>
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function load(file: string, label: string, findings: string[]): Artifact | undefined {
  if (!existsSync(file)) {
    findings.push(`${label} missing: ${path.relative(PACKAGE_ROOT, file)}`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Artifact
  } catch (error) {
    findings.push(`${label} is not valid JSON: ${String(error).slice(0, 120)}`)
    return undefined
  }
}

function checkShape(artifact: Artifact, findings: string[]) {
  if (artifact.version !== 1) findings.push(`unknown artifact version ${artifact.version}`)
  if (!artifact.routes?.length) {
    findings.push("artifact declares no routes — a baseline of nothing is not a baseline")
    return
  }
  for (const route of artifact.routes) {
    const where = `${route.name} (${route.method} ${route.path})`
    if (route.n !== artifact.samples) {
      // A short route is a probe that failed partway and still reported.
      findings.push(`${where}: ${route.n} samples, expected ${artifact.samples}`)
    }
    if (!(route.min <= route.median && route.median <= route.p95 && route.p95 <= route.max)) {
      findings.push(
        `${where}: percentiles out of order (min ${route.min}, median ${route.median}, p95 ${route.p95}, max ${route.max})`,
      )
    }
    if (route.min < 0) findings.push(`${where}: negative timing`)
  }
}

function checkCounters(artifact: Artifact, findings: string[]) {
  const c = artifact.counters ?? {}
  const created = c["scope.created"] ?? 0
  const settled = (c["scope.completed"] ?? 0) + (c["scope.interrupted"] ?? 0) + (c["scope.failed"] ?? 0)
  if (created !== settled) {
    // A scope that was entered and never reached an outcome is the leak the
    // counters exist to surface. It is machine-independent, so it is enforced.
    findings.push(`scope.created (${created}) does not equal completed + interrupted + failed (${settled})`)
  }
  if ((c["scope.finalizer-leak"] ?? 0) !== 0) {
    findings.push(`scope.finalizer-leak is ${c["scope.finalizer-leak"]}, expected 0`)
  }
  if (created === 0) findings.push("no scopes were recorded — the probe measured nothing")
}

function sameHost(a: Artifact, b: Artifact) {
  return a.host?.platform === b.host?.platform && a.host?.arch === b.host?.arch && a.host?.cpus === b.host?.cpus
}

function main() {
  const findings: string[] = []
  const baselineFile = path.resolve(flag("baseline") ?? DEFAULT_ARTIFACT)
  const baseline = load(baselineFile, "baseline", findings)

  if (baseline) {
    checkShape(baseline, findings)
    checkCounters(baseline, findings)
  }

  if (baseline && findings.length === 0) {
    console.log(
      `perf baseline — ${baseline.routes.length} route(s), ${baseline.samples} samples, recorded ${baseline.recordedAt} on ${baseline.host.platform}/${baseline.host.arch}`,
    )
    for (const route of baseline.routes) {
      console.log(
        `  ${route.name.padEnd(20)} p95 ${route.p95.toFixed(2)}ms  (median ${route.median.toFixed(2)}ms, n=${route.n})`,
      )
    }
  }

  const againstFile = flag("against")
  if (againstFile && baseline) {
    const current = load(path.resolve(againstFile), "comparison run", findings)
    if (current) {
      if (!sameHost(baseline, current)) {
        console.error("")
        console.error(
          `Refusing to diff: baseline was recorded on ${baseline.host.platform}/${baseline.host.arch} (${baseline.host.cpus} cpus) and the run on ${current.host.platform}/${current.host.arch} (${current.host.cpus} cpus). These timings are not comparable.`,
        )
        process.exit(1)
      }
      console.log("")
      console.log(`p95 against ${path.relative(PACKAGE_ROOT, againstFile)}:`)
      for (const route of current.routes) {
        const before = baseline.routes.find((r) => r.name === route.name)
        if (!before) {
          findings.push(`${route.name}: present in the run, absent from the baseline`)
          continue
        }
        const delta = before.p95 > 0 ? route.p95 / before.p95 - 1 : 0
        const mark = delta > P95_REGRESSION ? "REGRESSION" : ""
        console.log(
          `  ${route.name.padEnd(20)} ${before.p95.toFixed(2)}ms -> ${route.p95.toFixed(2)}ms  ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}%  ${mark}`,
        )
        if (delta > P95_REGRESSION) {
          findings.push(
            `${route.name}: p95 regressed ${(delta * 100).toFixed(0)}% (threshold ${P95_REGRESSION * 100}%)`,
          )
        }
      }
    }
  }

  if (findings.length > 0) {
    console.error("")
    console.error(`FAIL: ${findings.length} finding(s):`)
    for (const f of findings) console.error(`  - ${f}`)
    console.error("")
    console.error(
      "Regenerate with: bun run script/perf-baseline.ts --samples 30 --json specs/perf-baseline.json — and review the diff rather than committing it blind.",
    )
    process.exit(1)
  }
}

main()
