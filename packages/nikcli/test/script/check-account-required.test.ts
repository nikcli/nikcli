import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const PACKAGE_ROOT = path.join(REPO_ROOT, "packages", "nikcli")
const SCRIPT = path.join(PACKAGE_ROOT, "script", "check-account-required.ts")

function runScript(args: string[] = []) {
  const result = spawnSync("bun", ["run", SCRIPT, ...args], { cwd: PACKAGE_ROOT, encoding: "utf8" })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

describe("check-account-required.ts (EOT-12)", () => {
  it("passes on the real tree", () => {
    const { status, stdout } = runScript()
    expect(status).toBe(0)
    expect(stdout).toContain("account-required guard")
  })

  /**
   * `PRIVILEGED_FILES` is empty on purpose — every surface the guard was
   * written for turned out to be account-optional by design. An empty list
   * that has never been shown to fail is indistinguishable from a check that
   * does nothing, so these cases drive it with a synthetic tree instead.
   */
  describe("with a declared privileged file", () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "nikcli-account-required-"))
      mkdirSync(path.join(dir, "routes"))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const write = (name: string, body: string) => writeFileSync(path.join(dir, "routes", name), body)

    it("passes when the file imports the guard", () => {
      write("good.ts", 'import { requireAccount } from "@/account/guard"\n')
      expect(runScript([`--src=${dir}`, "--privileged=routes/good.ts"]).status).toBe(0)
    })

    it("fails when the file is declared privileged but serves without the guard", () => {
      write("bad.ts", "export const handler = () => new Response()\n")
      const { status, stderr } = runScript([`--src=${dir}`, "--privileged=routes/bad.ts"])
      expect(status).toBe(1)
      expect(stderr).toContain("routes/bad.ts is privileged but does not import @/account/guard")
    })

    it("fails when a declared privileged file does not exist", () => {
      const { status, stderr } = runScript([`--src=${dir}`, "--privileged=routes/gone.ts"])
      expect(status).toBe(1)
      expect(stderr).toContain("missing privileged handler: routes/gone.ts")
    })

    it("checks every declared file, not just the first", () => {
      write("good.ts", 'import { requireAccount } from "@/account/guard"\n')
      write("bad.ts", "export const handler = () => new Response()\n")
      const { status, stderr } = runScript([`--src=${dir}`, "--privileged=routes/good.ts,routes/bad.ts"])
      expect(status).toBe(1)
      expect(stderr).toContain("routes/bad.ts")
      expect(stderr).not.toContain("routes/good.ts")
    })
  })
})
