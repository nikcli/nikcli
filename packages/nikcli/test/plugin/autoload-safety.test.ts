import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"

/**
 * EOT-14 / `packages/nikcli/AGENTS.md` rule 5 — autoload safety.
 *
 * Custom tools under `{tool,tools}/*.{js,ts}` are **not** imported by
 * default. The contract:
 *
 *  - `NIKCLI_ALLOW_PLUGIN_AUTOLOAD=1` opts the whole config-dir in.
 *  - `tool.allow: ["file.ts"]` opts a specific file (works without the env).
 *  - `tool.pin: { "file.ts": "<sha256>" }` requires the file to hash to that
 *    value; a mismatch is refused, not silently re-imported.
 *
 * This is a static, structural test: it reads the registry source and
 * asserts the contract survives refactors. No filesystem or runtime, no
 * chance of an attacker-controlled file being executed by the test.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const REGISTRY = path.join(REPO_ROOT, "packages", "nikcli", "src", "tool", "registry.ts")
const FLAG_DEFS = path.join(REPO_ROOT, "packages", "util", "src", "flag.ts")
const AGENTS = path.join(REPO_ROOT, "packages", "nikcli", "AGENTS.md")

function grep(pattern: string, file: string): string[] {
  const result = spawnSync("rg", ["-n", "--no-messages", pattern, file], {
    encoding: "utf8",
  })
  if (result.status === 1 || result.status === 2) return []
  return result.stdout.trim().split("\n").filter(Boolean)
}

describe("EOT-14 custom-tool autoload safety", () => {
  it("registry.ts enforces NIKCLI_ALLOW_PLUGIN_AUTOLOAD or tool.allow", () => {
    const lines = grep("NIKCLI_ALLOW_PLUGIN_AUTOLOAD", REGISTRY)
    expect(lines.length).toBeGreaterThan(0)
    const registry = readFileSync(REGISTRY, "utf8")
    expect(registry).toMatch(/NIKCLI_ALLOW_PLUGIN_AUTOLOAD\s*\|\|\s*allowlist\.length\s*>\s*0/)
  })

  it("registry.ts honours tool.allow — files not in the allowlist are skipped, not loaded", () => {
    const registry = readFileSync(REGISTRY, "utf8")
    expect(registry).toMatch(/not in tool\.allow/)
    // The skip path uses `continue`, not `throw` — a non-allowed file is
    // silently ignored, the surrounding autoload keeps running.
    expect(registry).toMatch(/continue/)
  })

  it("registry.ts verifies tool.pin via sha256 and refuses on mismatch", () => {
    const registry = readFileSync(REGISTRY, "utf8")
    expect(registry).toMatch(/sha256/i)
    expect(registry).toMatch(/custom tool hash mismatch/)
    expect(registry).toMatch(/refusing to load/i)
  })

  it("util/flag.ts declares NIKCLI_ALLOW_PLUGIN_AUTOLOAD", () => {
    const flagLines = grep("NIKCLI_ALLOW_PLUGIN_AUTOLOAD", FLAG_DEFS)
    expect(flagLines.length).toBeGreaterThan(0)
  })

  it("AGENTS.md documents the autoload rule for human review", () => {
    const agents = readFileSync(AGENTS, "utf8")
    expect(agents).toMatch(/NIKCLI_ALLOW_PLUGIN_AUTOLOAD/)
    // AGENTS.md documents the contract in JSON form: "allow" and "pin"
    // inside the "tool" object.
    expect(agents).toMatch(/"allow":\s*\["my-tool\.ts"\]/)
    expect(agents).toMatch(/"pin":\s*\{\s*"my-tool\.ts"/)
  })

  it("config docs describe the same contract", () => {
    const config = readFileSync(path.join(REPO_ROOT, "packages", "nikcli", "src", "config", "config.ts"), "utf8")
    expect(config).toMatch(/NIKCLI_ALLOW_PLUGIN_AUTOLOAD/)
    // The schema declares `tool.allow` and `tool.pin` under a nested `tool:`
    // object — match the schema shape (allow/pin as zod array/record) and
    // additionally match the dotted-form the runtime reads in `registry.ts`.
    expect(config).toMatch(/allow:\s*z[\s\S]*?\.array\(z\.string\(\)\)/)
    expect(config).toMatch(/pin:\s*z[\s\S]*?\.record\(z\.string\(\), z\.string\(\)\)/)
  })
})
