#!/usr/bin/env bun
/**
 * `script/check-account-required.ts` — EOT-12 server-side guard gate.
 *
 * `specs/effect-tui/12-identity-onboarding-auth.md` says account creation
 * cannot be skipped. The TUI already enforced this in the UI; this script
 * keeps a server-side guard from going missing.
 *
 * The check is structural: every raw `/account/*` handler in
 * `src/server/httpapi/account.ts` is a flow entry point. The HttpApi security
 * middleware handles bearer / Basic / Tailscale credentials, but it does not
 * decide whether the *server* has an active account — that is a domain
 * concern. Handlers that need an active account on this machine must use
 * `requireAccount` (or `requireAccountOrThrow`) from `@/account/guard`.
 *
 * Today the raw `/account/*` group is exempt (the user is unauthenticated
 * by definition in those flows — they are signing in). The check this
 * script enforces is: privileged groups (sync, share, mobile companion
 * session routes) must not silently bypass the guard.
 *
 * The script does two things:
 *
 * 1. Static check: every HttpApi handler module under `src/server/httpapi/`
 *    that contains a privileged route must also import `@/account/guard`.
 *    The allowlist is by file; today no file is privileged enough to need
 *    the guard, so the allowlist is empty and the script only checks the
 *    helpers compile.
 *
 * 2. Wiring check: `src/account/guard.ts` must export `requireAccount`
 *    and `requireAccountOrThrow`. A test in `test/account/state.test.ts`
 *    exercises both.
 *
 * As more groups adopt the guard, add their file path to `PRIVILEGED_FILES`
 * so the structural check becomes a real lint instead of a placeholder.
 */

import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
const NIKCLI_SRC = path.join(REPO_ROOT, "packages", "nikcli", "src")
const GUARD_FILE = path.join(NIKCLI_SRC, "account", "guard.ts")
const STATE_FILE = path.join(NIKCLI_SRC, "account", "state.ts")
const PRIVILEGED_FILES: string[] = [
  // Populate as new endpoints adopt `requireAccount`. The structural check
  // reads each file and asserts it imports `@/account/guard`.
]

function read(file: string): string {
  return require("node:fs").readFileSync(file, "utf8")
}

async function main() {
  const findings: string[] = []

  if (!existsSync(GUARD_FILE)) {
    findings.push(`missing guard module: ${path.relative(REPO_ROOT, GUARD_FILE)}`)
  }
  if (!existsSync(STATE_FILE)) {
    findings.push(`missing state module: ${path.relative(REPO_ROOT, STATE_FILE)}`)
  }

  if (existsSync(GUARD_FILE)) {
    const source = read(GUARD_FILE)
    if (!source.includes("export function requireAccount")) {
      findings.push(`${path.relative(REPO_ROOT, GUARD_FILE)} does not export requireAccount`)
    }
    if (!source.includes("export async function requireAccountOrThrow")) {
      findings.push(`${path.relative(REPO_ROOT, GUARD_FILE)} does not export requireAccountOrThrow`)
    }
    if (!source.includes("AccountRequiredError")) {
      findings.push(`${path.relative(REPO_ROOT, GUARD_FILE)} does not reference AccountRequiredError`)
    }
  }

  for (const file of PRIVILEGED_FILES) {
    const abs = path.join(NIKCLI_SRC, file)
    if (!existsSync(abs)) {
      findings.push(`missing privileged handler: ${file}`)
      continue
    }
    const source = read(abs)
    if (!source.includes("@/account/guard")) {
      findings.push(`${file} is privileged but does not import @/account/guard`)
    }
  }

  console.log(
    `EOT-12 account-required guard — guard module present, ${PRIVILEGED_FILES.length} privileged files in allowlist`,
  )

  if (findings.length > 0) {
    console.error("")
    console.error(`FAIL: ${findings.length} finding(s):`)
    for (const f of findings) {
      console.error(`  - ${f}`)
    }
    console.error("")
    console.error(
      "Either (a) add the missing export, (b) add the privileged file to PRIVILEGED_FILES in script/check-account-required.ts and import @/account/guard, or (c) fix the missing file path.",
    )
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("check-account-required failed:", error)
  process.exit(2)
})
