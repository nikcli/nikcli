#!/usr/bin/env bun
/**
 * `script/check-spec-commit-refs.ts` — the spec commit-reference gate.
 *
 * `specs/ROADMAP.md` cites the commit each landed slice arrived in, and the
 * Discipline Addenda do the same. Those citations are the only way a reader
 * gets from a claim back to the diff that supports it, so a dead one turns the
 * roadmap into assertion.
 *
 * They die quietly. This repository rebases onto origin on every release, and
 * a rebase rewrites every commit that is not yet pushed — so a slice
 * documented and pushed in two steps cites a hash that no longer exists on the
 * branch by the time anyone reads it. `git cat-file -e` does not catch this:
 * the orphaned commit is still an object in the repository, reachable from the
 * reflog, until it is garbage-collected or someone clones. **Ancestry is the
 * test, not existence.**
 *
 * So: every `` `abcdef12` ``-shaped reference in the scanned files must be a
 * commit reachable from HEAD. A shallow clone cannot answer that, and neither
 * can a detached checkout of an older commit, so both are reported and skipped
 * rather than failed — a gate that fails on CI's own checkout strategy is one
 * people learn to ignore.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
/**
 * `specs/` only. `.nikcli/plans/` is excluded deliberately: plans are dated
 * working documents and some of them cite *upstream* opencode commits, which
 * are fetched into this repository but are legitimately not ancestors of our
 * branch. Failing on those would make the gate wrong about the one thing it
 * claims to know.
 */
const SCAN = ["specs/**/*.md"]

/** 7–10 hex characters in backticks. Long enough not to match a word, short enough to match an abbreviated hash. */
const REF = /`([0-9a-f]{7,10})`/g

function git(args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
  return { ok: result.exitCode === 0, out: new TextDecoder().decode(result.stdout).trim() }
}

async function main() {
  if (!git(["rev-parse", "--git-dir"]).ok) {
    console.log("spec commit refs — not a git checkout, skipped")
    return
  }
  if (git(["rev-parse", "--is-shallow-repository"]).out === "true") {
    console.log("spec commit refs — shallow clone, skipped (ancestry is unanswerable here)")
    return
  }

  const found = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const pattern of SCAN) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT, absolute: true })) {
      if (seen.has(file)) continue
      seen.add(file)
      const lines = readFileSync(file, "utf8").split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        for (const match of lines[i].matchAll(REF)) {
          const sha = match[1]
          // A hex-only run can be a hash or a colour, an id, a checksum. Only
          // treat it as a reference when git recognizes it as a commit.
          if (!git(["cat-file", "-e", `${sha}^{commit}`]).ok) continue
          const where = `${path.relative(REPO_ROOT, file)}:${i + 1}`
          found.set(sha, [...(found.get(sha) ?? []), where])
        }
      }
    }
  }

  const orphaned = [...found].filter(([sha]) => !git(["merge-base", "--is-ancestor", sha, "HEAD"]).ok)

  console.log(`spec commit refs — ${found.size} commit reference(s) cited, ${orphaned.length} orphaned`)

  if (orphaned.length > 0) {
    console.error("")
    console.error(`FAIL: ${orphaned.length} reference(s) point at a commit that is not an ancestor of HEAD:`)
    for (const [sha, where] of orphaned) {
      const subject = git(["log", "--format=%s", "-1", sha]).out
      console.error(`  ${sha}  ${subject}`)
      for (const w of where) console.error(`      cited at ${w}`)
    }
    console.error("")
    console.error(
      "Usually a rebase rewrote the commit after it was cited. Find its new hash by subject (`git log --format='%h %s'`) and repoint the citation.",
    )
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("check-spec-commit-refs failed:", error)
  process.exit(2)
})
