#!/usr/bin/env bun
/**
 * `script/check-flag-capture.ts` — the Flag capture-at-import gate.
 *
 * `packages/util/src/flag.ts` reads the environment two ways:
 *
 *   export const NIKCLI_X = truthy("NIKCLI_X")   // captured once, at import
 *   export function x() { return truthy("NIKCLI_X") }   // read on every access
 *
 * A constant is fixed by whichever module in the process touches a flag
 * first. That is fine for a variable the environment already holds when the
 * process starts, and wrong for one that is set afterwards — by the CLI's
 * argv middleware, by a worker thread's setup, or by a test file's own module
 * scope. `flag.ts` documents the hazard on `autoApprove` and `cacheRetention`;
 * the reason this script exists is that documenting it did not stop four more
 * from being added as constants.
 *
 * The rule is mechanical, so it can be checked: **a flag assigned anywhere in
 * the repository at runtime must not be a captured constant.** The script
 * intersects the two sets and fails on the overlap.
 *
 * What this caught the first time it was run by hand: `NIKCLI_AUTH_ISSUER`,
 * `NIKCLI_AUTH_JWKS_URL`, `NIKCLI_AUTH_AUDIENCE` and `NIKCLI_AUTH_JWT_SECRET`,
 * which had eight tests in `test/server/local-account-session.test.ts` failing
 * in a directory run and passing alone, for a year, with nothing wrong in
 * either file. Then `NIKCLI_REQUIRE_OAUTH` and `NIKCLI_LEGACY_LOGIN` — an auth
 * gate that `test/server/unified-auth.fixture.ts` sets at its own module
 * scope, so the fixture's own tests could have run against a gate that was
 * never closed.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
const FLAG_FILE = path.join(REPO_ROOT, "packages", "util", "src", "flag.ts")

/** Directories scanned for runtime assignments. */
const SCAN_GLOBS = [
  "packages/*/src/**/*.{ts,tsx}",
  "packages/*/test/**/*.{ts,tsx}",
  "packages/*/script/**/*.ts",
  "script/**/*.ts",
]

/**
 * Variables a process legitimately sets for itself before anything reads a
 * flag, or sets only to hand to a child. An entry needs a reason: the check
 * is worth nothing if the way to pass it is to add a name here.
 */
const ALLOWLIST: Record<string, string> = {
  // Set by the test preload before any test module is evaluated, which is
  // earlier than any import of flag.ts can be.
}

type Captured = { name: string; line: number }

/** `export const NIKCLI_X = truthy("NIKCLI_X")` / `= process.env["NIKCLI_X"]`. */
function capturedConstants(source: string): Captured[] {
  const out: Captured[] = []
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!/^\s*export const [A-Z_0-9]+\s*=/.test(line)) continue
    // The env var the constant reads — usually its own name, but a constant
    // may read a differently-named variable, so take it from the expression.
    const read = line.match(/truthy\("([A-Z_0-9]+)"\)|process\.env(?:\.|\[")([A-Z_0-9]+)/)
    if (!read) continue
    out.push({ name: read[1] ?? read[2], line: i + 1 })
  }
  return out
}

/** `process.env.X = …` / `process.env["X"] = …`, excluding comparisons. */
async function assignedAtRuntime(): Promise<Map<string, string[]>> {
  const hits = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const pattern of SCAN_GLOBS) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT, absolute: true })) {
      if (seen.has(file)) continue
      seen.add(file)
      if (file === FLAG_FILE) continue
      const lines = readFileSync(file, "utf8").split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        for (const match of lines[i].matchAll(/process\.env(?:\.([A-Z_0-9]+)|\["([A-Z_0-9]+)"\])\s*=(?!=)/g)) {
          const name = match[1] ?? match[2]
          const where = `${path.relative(REPO_ROOT, file)}:${i + 1}`
          hits.set(name, [...(hits.get(name) ?? []), where])
        }
      }
    }
  }
  return hits
}

async function main() {
  const captured = capturedConstants(readFileSync(FLAG_FILE, "utf8"))
  const assigned = await assignedAtRuntime()

  const violations: { name: string; line: number; where: string[] }[] = []
  for (const entry of captured) {
    if (entry.name in ALLOWLIST) continue
    const where = assigned.get(entry.name)
    if (where) violations.push({ name: entry.name, line: entry.line, where })
  }

  console.log(
    `flag capture — ${captured.length} captured constant(s) in packages/util/src/flag.ts, ${assigned.size} env name(s) assigned at runtime`,
  )

  if (violations.length > 0) {
    console.error("")
    console.error(`FAIL: ${violations.length} flag(s) captured at import but assigned at runtime:`)
    for (const v of violations) {
      console.error(`  ${v.name}  (flag.ts:${v.line})`)
      // Cap the list: one example is enough to find the pattern, and a flag
      // every test file sets would otherwise bury the other violations.
      for (const where of v.where.slice(0, 3)) console.error(`      assigned at ${where}`)
      if (v.where.length > 3) console.error(`      … and ${v.where.length - 3} more`)
    }
    console.error("")
    console.error(
      "Convert each to a function that reads process.env on every access (see `autoApprove` in flag.ts), or explain in ALLOWLIST why the assignment always happens before any flag is read.",
    )
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("check-flag-capture failed:", error)
  process.exit(2)
})
