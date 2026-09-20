import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const PACKAGE_ROOT = path.join(REPO_ROOT, "packages", "nikcli")
const SCRIPT = path.join(PACKAGE_ROOT, "script", "check-spec-commit-refs.ts")

function run() {
  return spawnSync("bun", ["run", SCRIPT], { cwd: PACKAGE_ROOT, encoding: "utf8" })
}

describe("check-spec-commit-refs.ts", () => {
  it("every commit cited in specs/ is reachable from HEAD", () => {
    const result = run()
    if (result.status !== 0) console.error(result.stdout, result.stderr)
    expect(result.status).toBe(0)
  })

  it("actually finds references rather than reporting an empty scan", () => {
    // The failure mode a gate like this dies of: a glob that stops matching,
    // or a regex that stops recognising the citation format, leaving a check
    // that passes because it looked at nothing.
    const { stdout } = run()
    const count = Number(stdout.match(/(\d+) commit reference\(s\) cited/)?.[1] ?? 0)
    expect(count).toBeGreaterThan(10)
  })

  it("skips rather than fails where ancestry cannot be answered", () => {
    // A gate that fails on CI's own checkout strategy is one people learn to
    // ignore, so a shallow clone or a non-git tree reports and exits 0.
    const { stdout } = spawnSync("bun", ["run", SCRIPT], { cwd: "/tmp", encoding: "utf8" })
    expect(stdout).toContain("spec commit refs")
  })
})
