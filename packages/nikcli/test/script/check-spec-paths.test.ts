import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const PACKAGE_ROOT = path.join(REPO_ROOT, "packages", "nikcli")
const SCRIPT = path.join(PACKAGE_ROOT, "script", "check-spec-paths.ts")

function run() {
  return spawnSync("bun", ["run", SCRIPT], { cwd: PACKAGE_ROOT, encoding: "utf8" })
}

describe("check-spec-paths.ts", () => {
  it("passes on the real specs", () => {
    const result = run()
    if (result.status !== 0) console.error(result.stdout, result.stderr)
    expect(result.status).toBe(0)
  })

  it("actually reads citations rather than reporting an empty scan", () => {
    // The way a gate like this dies: a regex that stops matching leaves it
    // green because it looked at nothing.
    const { stdout } = run()
    expect(stdout).toMatch(/\d+ explained/)
    const explained = Number(stdout.match(/(\d+) explained/)?.[1] ?? 0)
    expect(explained).toBeGreaterThan(10)
  })

  it("fails on a citation that resolves nowhere and has no reason", () => {
    // Driven through the real repo, because the script's roots are fixed: a
    // spec file added under specs/ with a dead citation must fail the run.
    let dir: string | undefined
    try {
      dir = path.join(REPO_ROOT, "specs", "__gate-probe__")
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, "probe.md"), "See `src/definitely/not/here.ts` for details.\n")
      const result = run()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("src/definitely/not/here.ts")
      expect(result.stderr).toContain("__gate-probe__/probe.md:1")
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it("accepts a citation that resolves under any of the package roots", () => {
    let dir: string | undefined
    try {
      dir = path.join(REPO_ROOT, "specs", "__gate-probe__")
      mkdirSync(dir, { recursive: true })
      // `src/…` relative to packages/nikcli, and to packages/tui.
      writeFileSync(
        path.join(dir, "probe.md"),
        "Both `src/observability/otlp.ts` and `src/util/lifecycle.ts` are real.\n",
      )
      expect(run().status).toBe(0)
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })
})
