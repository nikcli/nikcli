#!/usr/bin/env bun
/**
 * `script/check-workspace-isolation.ts` — EOT-16 workspace isolation gate.
 *
 * Pins the structural invariants `specs/effect-tui/16-workspace-isolation.md`
 * asks for, so a refactor cannot silently break them:
 *
 *  1. Workspace ids are `wrk_…`. The `wrk` prefix is the discriminator in
 *     `projection.ts` (prefix dispatch) and in the `WorktreeAdaptor`.
 *  2. `WorkspaceRef` and `locallyWorkspace` are exported from
 *     `effect/instance-ref.ts`. The bridge in `effect/instance-scope.ts`
 *     pins a workspace via `locallyWorkspace` when `input.workspaceID` is
 *     present.
 *  3. The bridge comment cites the open B31 gap, so a future refactor that
 *     promotes workspace to its own scope updates the comment too.
 *  4. `workspace/index.ts` does NOT register its own SIGINT/SIGTERM
 *     handlers — connection lifecycle owns them.
 *
 * The script does not import the runtime. It reads source and asserts the
 * contract survives refactors.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
const WORKSPACE_INDEX = path.join(REPO_ROOT, "packages", "nikcli", "src", "workspace", "index.ts")
const INSTANCE_REF = path.join(REPO_ROOT, "packages", "nikcli", "src", "effect", "instance-ref.ts")
const INSTANCE_SCOPE = path.join(REPO_ROOT, "packages", "nikcli", "src", "effect", "instance-scope.ts")
const PROJECTION = path.join(REPO_ROOT, "packages", "nikcli", "src", "sync", "projection.ts")

async function main() {
  const findings: string[] = []

  if (!existsSync(WORKSPACE_INDEX)) {
    findings.push(`missing workspace index: ${path.relative(REPO_ROOT, WORKSPACE_INDEX)}`)
  } else {
    const source = readFileSync(WORKSPACE_INDEX, "utf8")
    if (!/wrk/.test(source)) {
      findings.push(`${path.relative(REPO_ROOT, WORKSPACE_INDEX)} does not mention the wrk prefix`)
    }
    if (!/isStartsWith\(\s*["']wrk["']\s*\)/.test(source)) {
      findings.push(
        `${path.relative(REPO_ROOT, WORKSPACE_INDEX)} does not enforce the wrk prefix via Schema.isStartsWith`,
      )
    }
    if (/process\.once\(\s*["']SIGINT["']/.test(source)) {
      findings.push(
        `${path.relative(REPO_ROOT, WORKSPACE_INDEX)} registers its own SIGINT handler — connection lifecycle owns shutdown`,
      )
    }
    if (/process\.once\(\s*["']SIGTERM["']/.test(source)) {
      findings.push(
        `${path.relative(REPO_ROOT, WORKSPACE_INDEX)} registers its own SIGTERM handler — connection lifecycle owns shutdown`,
      )
    }
  }

  if (!existsSync(INSTANCE_REF)) {
    findings.push(`missing instance-ref module: ${path.relative(REPO_ROOT, INSTANCE_REF)}`)
  } else {
    const source = readFileSync(INSTANCE_REF, "utf8")
    if (!/export.*WorkspaceRef/.test(source)) {
      findings.push(`${path.relative(REPO_ROOT, INSTANCE_REF)} does not export WorkspaceRef`)
    }
    if (!/export.*locallyWorkspace/.test(source)) {
      findings.push(`${path.relative(REPO_ROOT, INSTANCE_REF)} does not export locallyWorkspace`)
    }
  }

  if (!existsSync(INSTANCE_SCOPE)) {
    findings.push(`missing instance-scope module: ${path.relative(REPO_ROOT, INSTANCE_SCOPE)}`)
  } else {
    const source = readFileSync(INSTANCE_SCOPE, "utf8")
    if (!/input\.workspaceID/.test(source)) {
      findings.push(`${path.relative(REPO_ROOT, INSTANCE_SCOPE)} never reads input.workspaceID`)
    }
    if (!/locallyWorkspace\(\s*\{\s*id:\s*input\.workspaceID/.test(source)) {
      findings.push(
        `${path.relative(REPO_ROOT, INSTANCE_SCOPE)} does not pin locallyWorkspace when workspaceID is present`,
      )
    }
    if (!/16-workspace-isolation/.test(source)) {
      findings.push(`${path.relative(REPO_ROOT, INSTANCE_SCOPE)} does not cite EOT-16 in its header`)
    }
    if (!/value carried alongside/i.test(source)) {
      findings.push(
        `${path.relative(REPO_ROOT, INSTANCE_SCOPE)} header should note the B31 gap (workspaceID is a value today)`,
      )
    }
  }

  if (!existsSync(PROJECTION)) {
    findings.push(`missing sync projection: ${path.relative(REPO_ROOT, PROJECTION)}`)
  } else {
    const source = readFileSync(PROJECTION, "utf8")
    // The prefix dispatch is what separates workspace events from session
    // events; without it the reducer folds them together.
    if (!/wrk/.test(source) || !/ses/.test(source)) {
      findings.push(`${path.relative(REPO_ROOT, PROJECTION)} does not dispatch on the wrk/ses prefix`)
    }
  }

  console.log("EOT-16 workspace isolation gate — wrk prefix + WorkspaceRef + instance-scope bridge")

  if (findings.length > 0) {
    console.error("")
    console.error(`FAIL: ${findings.length} finding(s):`)
    for (const finding of findings) {
      console.error(`  - ${finding}`)
    }
    console.error("")
    console.error(
      "Either (a) restore the missing export / structural invariant, or (b) update the requirements in this script and the EOT-16 spec together.",
    )
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("check-workspace-isolation failed:", error)
  process.exit(2)
})
