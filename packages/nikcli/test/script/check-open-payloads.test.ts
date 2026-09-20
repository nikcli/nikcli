import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const PACKAGE_ROOT = path.join(REPO_ROOT, "packages", "nikcli")
const SCRIPT = path.join(PACKAGE_ROOT, "script", "check-open-payloads.ts")

type Run = { status: number; stdout: string; stderr: string }

/**
 * Run the real gate. With no arguments it scans the real `src/server/httpapi`
 * against the real allowlist; with `dir`/`allowlist` it scans a synthetic
 * tree. Earlier versions of this test re-declared the script's regexes and
 * asserted against the copies, which passes whatever the script does.
 */
function runScript(options: { dir?: string; allowlist?: string } = {}): Run {
  const args = ["run", SCRIPT]
  if (options.dir) args.push(`--dir=${options.dir}`)
  if (options.allowlist) args.push(`--allowlist=${options.allowlist}`)
  const result = spawnSync("bun", args, { cwd: PACKAGE_ROOT, encoding: "utf8" })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

describe("check-open-payloads.ts (EOT-10)", () => {
  it("passes on the real allowlist (no violations, no stale entries)", () => {
    const { status, stdout, stderr } = runScript()
    if (status !== 0) {
      console.error("STDOUT:", stdout)
      console.error("STDERR:", stderr)
    }
    expect(status).toBe(0)
    expect(stdout).toContain("open-payload check")
    expect(stdout).not.toContain("FAIL:")
    expect(stdout).not.toContain("WARN:")
  })

  describe("against a synthetic tree", () => {
    let dir: string
    let src: string
    let allowlist: string

    const write = (file: string, lines: string[]) => writeFileSync(path.join(src, file), lines.join("\n") + "\n")
    const allow = (entries: unknown[]) => writeFileSync(allowlist, JSON.stringify({ entries }, null, 2))

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "nikcli-open-payloads-"))
      src = path.join(dir, "httpapi")
      mkdirSync(src)
      allowlist = path.join(dir, "allowlist.json")
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const entry = (snippet: string, count?: number) => ({
      file: "route.ts",
      snippet,
      ...(count === undefined ? {} : { count }),
      owner: "test",
      kind: "opaque",
      justification: "synthetic fixture",
    })

    it("fails on a Schema.Unknown that is not in the allowlist", () => {
      write("route.ts", ["export const V = Schema.Unknown"])
      allow([])
      const { status, stderr } = runScript({ dir: src, allowlist })
      expect(status).toBe(1)
      expect(stderr).toContain("FAIL:")
      expect(stderr).toContain("route.ts:1")
    })

    it("passes once that exact declaration is justified", () => {
      write("route.ts", ["export const V = Schema.Unknown"])
      allow([entry("export const V = Schema.Unknown")])
      expect(runScript({ dir: src, allowlist }).status).toBe(0)
    })

    it("still passes when unrelated lines shift the declaration down", () => {
      // The reason the allowlist is keyed by text and not by line number: an
      // edit above a justified site is not a new open payload, and a gate
      // that fails on it teaches reviewers to renumber the file unread.
      write("route.ts", ["// added", "// lines", "", "export const V = Schema.Unknown"])
      allow([entry("export const V = Schema.Unknown")])
      expect(runScript({ dir: src, allowlist }).status).toBe(0)
    })

    it("fails on a second copy of an already justified declaration", () => {
      write("route.ts", ["export const V = Schema.Unknown", "export const W = Schema.Unknown"])
      allow([entry("export const V = Schema.Unknown")])
      const { status, stderr } = runScript({ dir: src, allowlist })
      expect(status).toBe(1)
      expect(stderr).toContain("FAIL:")
    })

    it("accepts repeated declarations up to the entry's count", () => {
      write("route.ts", ["data: Schema.Unknown,", "meta: Schema.String,", "data: Schema.Unknown,"])
      allow([entry("data: Schema.Unknown,", 2)])
      expect(runScript({ dir: src, allowlist }).status).toBe(0)
    })

    it("warns, without failing, when an allowlisted declaration is gone", () => {
      write("route.ts", ["export const V = Schema.String"])
      allow([entry("export const V = Schema.Unknown")])
      const { status, stderr } = runScript({ dir: src, allowlist })
      expect(status).toBe(0)
      expect(stderr).toContain("WARN:")
      expect(stderr).toContain("1 allowlist entries no longer match")
    })

    it("ignores Schema.Unknown inside comments", () => {
      write("route.ts", ["// Schema.Unknown is fine in a comment", " * Schema.Unknown too", "export const V = 1"])
      allow([])
      expect(runScript({ dir: src, allowlist }).status).toBe(0)
    })

    it("treats Schema.Record(String, Unknown) as a tracked declaration", () => {
      write("route.ts", ["data: Schema.Record(Schema.String, Schema.Unknown),"])
      allow([])
      const { status, stderr } = runScript({ dir: src, allowlist })
      expect(status).toBe(1)
      expect(stderr).toContain("Schema.Record(Schema.String, Schema.Unknown)")
    })
  })
})
