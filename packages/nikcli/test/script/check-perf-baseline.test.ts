import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const PACKAGE_ROOT = path.join(REPO_ROOT, "packages", "nikcli")
const SCRIPT = path.join(PACKAGE_ROOT, "script", "check-perf-baseline.ts")

function run(args: string[] = []) {
  return spawnSync("bun", ["run", SCRIPT, ...args], { cwd: PACKAGE_ROOT, encoding: "utf8" })
}

const HOST = { platform: "darwin", arch: "arm64", cpus: 10, bun: "1.4.2" }
const route = (over: Partial<Record<string, unknown>> = {}) => ({
  name: "event-head",
  method: "GET",
  path: "/event",
  n: 30,
  min: 1,
  median: 2,
  p95: 3,
  max: 4,
  ...over,
})
const artifact = (over: Record<string, unknown> = {}) => ({
  version: 1,
  recordedAt: "2026-09-20T00:00:00.000Z",
  samples: 30,
  host: HOST,
  routes: [route()],
  counters: { "scope.created": 10, "scope.completed": 10, "scope.finalizer-leak": 0 },
  ...over,
})

describe("check-perf-baseline.ts (EOT-01 / P0)", () => {
  it("passes on the committed baseline", () => {
    const result = run()
    if (result.status !== 0) console.error(result.stdout, result.stderr)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("perf baseline —")
  })

  describe("against a synthetic artifact", () => {
    let dir: string
    const write = (name: string, value: unknown) => {
      const file = path.join(dir, name)
      writeFileSync(file, JSON.stringify(value))
      return file
    }

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "nikcli-perf-gate-"))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it("fails when the artifact is missing", () => {
      const result = run([`--baseline=${path.join(dir, "absent.json")}`])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("baseline missing")
    })

    it("fails when a route carries fewer samples than declared", () => {
      // A short route is a probe that failed partway and reported anyway.
      const file = write("short.json", artifact({ routes: [route({ n: 7 })] }))
      const result = run([`--baseline=${file}`])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("7 samples, expected 30")
    })

    it("fails when the percentiles are out of order", () => {
      const file = write("bad.json", artifact({ routes: [route({ p95: 0.5 })] }))
      const result = run([`--baseline=${file}`])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("percentiles out of order")
    })

    it("fails when a scope was entered and never settled", () => {
      // Machine-independent, so this one is enforced rather than reported.
      const file = write("leak.json", artifact({ counters: { "scope.created": 10, "scope.completed": 8 } }))
      const result = run([`--baseline=${file}`])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("does not equal completed + interrupted + failed")
    })

    it("fails on a finalizer leak", () => {
      const file = write(
        "fin.json",
        artifact({ counters: { "scope.created": 10, "scope.completed": 10, "scope.finalizer-leak": 2 } }),
      )
      const result = run([`--baseline=${file}`])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("scope.finalizer-leak is 2")
    })

    it("fails when the probe measured nothing", () => {
      const file = write("empty.json", artifact({ counters: {} }))
      const result = run([`--baseline=${file}`])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("measured nothing")
    })

    it("reports a p95 regression past the threshold", () => {
      const base = write("base.json", artifact())
      const now = write("now.json", artifact({ routes: [route({ p95: 9 })] }))
      const result = run([`--baseline=${base}`, `--against=${now}`])
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("REGRESSION")
      expect(result.stderr).toContain("p95 regressed")
    })

    it("accepts a p95 move inside the threshold", () => {
      const base = write("base.json", artifact())
      const now = write("now.json", artifact({ routes: [route({ p95: 4 })] }))
      expect(run([`--baseline=${base}`, `--against=${now}`]).status).toBe(0)
    })

    it("refuses to diff two different machines rather than reporting a number", () => {
      // The reason the gate does not enforce wall-clock at all: these timings
      // are not portable, and a cross-host delta is noise wearing a percentage.
      const base = write("base.json", artifact())
      const now = write("now.json", artifact({ host: { ...HOST, arch: "x64", cpus: 4 } }))
      const result = run([`--baseline=${base}`, `--against=${now}`])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("not comparable")
    })
  })
})
