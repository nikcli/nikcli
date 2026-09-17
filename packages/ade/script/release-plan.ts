#!/usr/bin/env bun
/**
 * Git plumbing around `src/update/release-plan.ts`, for the ADE workflows.
 *
 *   bun packages/ade/script/release-plan.ts plan [--min-age-hours N] [--skip-shas FILE] [--major-shas FILE]
 *   bun packages/ade/script/release-plan.ts check <from>..<to>
 *   bun packages/ade/script/release-plan.ts notes <from> <to>
 *
 * `plan` looks at HEAD against the newest `ade-v*` tag and, in GitHub Actions,
 * writes `release`, `version`, `tag` and `reason` to `$GITHUB_OUTPUT` and the
 * notes to `release-notes.md`. The sha files list commits of pull requests
 * labelled `release:skip` or `release:major`, one per line.
 *
 * `check` fails when a commit in the range that touches ADE breaks the
 * subject format. `notes` prints the grouped notes for a range.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { COMMIT_TYPES, SKIP_MARKER, invalidSubjects, planRelease, releaseNotes, type Commit } from "../src/update/release-plan"

/** What an ADE release is built from; the same list `ade-release.yml` uses for its notes. */
const RELEASE_PATHS = ["packages/ade", "packages/voice", "packages/plugin/src/v2/ade"]

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

function commits(range: string): Commit[] {
  const out = git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range, "--", ...RELEASE_PATHS)
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split("\x1f")
      return { sha, subject, body }
    })
}

function lastTag(): string | undefined {
  const tags = git("tag", "--list", "ade-v*", "--merged", "HEAD", "--sort=-v:refname").split("\n").filter(Boolean)
  return tags[0]
}

function shas(flag: string, argv: string[]): Set<string> {
  const index = argv.indexOf(flag)
  const file = index >= 0 ? argv[index + 1] : undefined
  if (!file || !existsSync(file)) return new Set()
  return new Set(readFileSync(file, "utf8").split(/\s+/).filter(Boolean))
}

function output(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""))
  }
}

function plan(argv: string[]) {
  const last = lastTag()
  const skip = shas("--skip-shas", argv)
  const major = shas("--major-shas", argv)
  const list = commits(last ? `${last}..HEAD` : "HEAD").map((c) => ({
    ...c,
    body: [c.body, skip.has(c.sha) ? SKIP_MARKER : "", major.has(c.sha) ? "BREAKING CHANGE: labelled release:major" : ""]
      .filter(Boolean)
      .join("\n\n"),
  }))

  const result = planRelease(last, list)
  if (!result) {
    output({ release: "false", reason: `nothing to release since ${last ?? "the beginning"}` })
    return
  }

  /* A release cut minutes after a push can catch a series of commits halfway:
     wait until the newest one has sat for a while. */
  const flag = argv.indexOf("--min-age-hours")
  const hours = flag >= 0 ? Number(argv[flag + 1]) : 0
  const newest = Number(git("log", "-1", "--format=%ct", "HEAD").trim()) * 1000
  const age = (Date.now() - newest) / 3_600_000
  if (age < hours) {
    output({ release: "false", reason: `newest commit is ${age.toFixed(1)}h old, waiting for ${hours}h` })
    return
  }

  if (process.env.GITHUB_OUTPUT) writeFileSync("release-notes.md", `${result.notes}\n`)
  else console.log(`\n${result.notes}\n`)
  output({ release: "true", version: result.version, tag: `ade-v${result.version}`, reason: `${result.bump} since ${last ?? "the beginning"}` })
}

function check(range: string | undefined) {
  if (!range) throw new Error("check needs a range, e.g. origin/feat/ade..HEAD")
  const bad = invalidSubjects(commits(range))
  if (bad.length === 0) {
    console.log("commit subjects ok")
    return
  }
  console.error(`These commits touch ADE and do not follow \`type(scope): description\` (types: ${COMMIT_TYPES.join(", ")}):`)
  for (const c of bad) console.error(`  ${c.sha.slice(0, 10)} ${c.subject}`)
  console.error("See packages/ade/CONTRIBUTING.md.")
  process.exit(1)
}

const [command, ...rest] = process.argv.slice(2)
if (command === "plan") plan(rest)
else if (command === "check") check(rest[0])
else if (command === "notes" && rest[0] && rest[1]) console.log(releaseNotes(commits(`${rest[0]}..${rest[1]}`)))
else {
  console.error("usage: release-plan.ts plan [--min-age-hours N] [--skip-shas FILE] [--major-shas FILE] | check <range> | notes <from> <to>")
  process.exit(2)
}
