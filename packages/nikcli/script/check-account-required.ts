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
 * The raw `/account/*` group is exempt by definition — the caller is signing
 * in, so demanding an existing session would make signing in impossible.
 *
 * `PRIVILEGED_FILES` is empty, and that is a finding rather than a backlog.
 * Each surface the guard was written for turned out to be account-optional
 * on purpose: sync identifies an unauthenticated local caller as `"operator"`
 * and reports `configured: false` without an account, share POSTs to
 * `s.nikcli-ai.dev` with no authorization header, and the mobile companion
 * carries its own `nkm_` capability tokens. Listing any of them here would
 * not harden a route; it would turn working behaviour into a 401. See the
 * docblock on `src/account/guard.ts` for the evidence per surface.
 *
 * The script does two things:
 *
 * 1. Static check: every file in `PRIVILEGED_FILES` must import
 *    `@/account/guard`. This is what makes the list load-bearing — a route
 *    declared privileged and then served without the guard fails CI.
 *
 * 2. Wiring check: `src/account/guard.ts` must export `requireAccount` and
 *    `requireAccountOrThrow`. A test in `test/account/state.test.ts`
 *    exercises both, so the guard cannot rot while it waits for a caller.
 *
 * Add a file here when a route genuinely cannot serve an unauthenticated
 * caller — not to work through the list above.
 */

import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
/** `--src` points the privileged-file check at a synthetic tree for this script's own test. */
const NIKCLI_SRC = path.resolve(flag("src") ?? path.join(REPO_ROOT, "packages", "nikcli", "src"))
const REAL_SRC = path.join(REPO_ROOT, "packages", "nikcli", "src")
const GUARD_FILE = path.join(REAL_SRC, "account", "guard.ts")
const STATE_FILE = path.join(REAL_SRC, "account", "state.ts")
const DECLARED_PRIVILEGED_FILES: string[] = [
  // Empty deliberately — see the header. Add a file only when its route
  // cannot serve an unauthenticated caller; the check then asserts it
  // imports `@/account/guard`.
]

/**
 * `--privileged=a.ts,b.ts` overrides the list so this script's own test can
 * prove the check bites. An empty list that has never been shown to fail is
 * indistinguishable from a check that does nothing.
 */
const override = flag("privileged")
const PRIVILEGED_FILES: string[] = override
  ? override
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  : DECLARED_PRIVILEGED_FILES

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
