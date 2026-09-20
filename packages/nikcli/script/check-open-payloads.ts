#!/usr/bin/env bun
/**
 * `script/check-open-payloads.ts` — EOT-10 open-payload guard.
 *
 * `specs/effect-tui/10-contracts-errors-security.md` and
 * `packages/nikcli/AGENTS.md` ban bare `Schema.Unknown` (and
 * `Schema.Array(Schema.Unknown)`) on HttpApi success / domain fields, except
 * where the producer is genuinely opaque (third-party APIs, SSE frames,
 * polymorphic event-sourced entries, bodyless redirects, WebSocket upgrades).
 *
 * `Schema.Record(Schema.String, Schema.Unknown)` is **not** a violation —
 * the codegen emits it as `{ [k: string]: unknown }`, which is a typed record
 * of `unknown` values, not an `any`. It is the canonical shape for arbitrary
 * key/value metadata (e.g. `SessionPart.metadata`, `PermissionRule.metadata`,
 * `MissionRun.data`). We track it in the allowlist so the policy stays
 * explicit, but it does not block CI on its own.
 *
 * This script enforces the policy in CI:
 *  1. Read the allowlist at `specs/httpapi-open-payloads.json`.
 *  2. Scan every `*.ts` file under `src/server/httpapi/` for
 *     `Schema.Unknown`, `Schema.Array(Schema.Unknown)`,
 *     `Schema.optional(Schema.Unknown)`, `Schema.optionalKey(Schema.Unknown)`,
 *     `Schema.optional(Schema.Array(Schema.Unknown))`,
 *     `Schema.optionalKey(Schema.Array(Schema.Unknown))`,
 *     `Schema.Record(Schema.String, Schema.Unknown)`.
 *  3. Fail with a non-zero exit code if a `Schema.Unknown` use is not in the
 *     allowlist.
 *
 * The allowlist is keyed by **file plus the declaring line's text**, with a
 * `count` when a file declares the same shape more than once. It is not keyed
 * by line number: a line number makes every unrelated edit above a listed
 * site fail this gate, and the repair — renumbering the allowlist — is a diff
 * that looks like review and contains none. The snippet is also what a
 * reviewer actually needs to see next to the justification.
 *
 * The script never edits the allowlist for the caller; it only reports the
 * diff. PR review is the place where new entries are added — with a docblock
 * on the producer, an EOT-10 owner, and a runtime/consumer test.
 */

import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
const PACKAGE_ROOT = path.join(REPO_ROOT, "packages", "nikcli")

/**
 * `--dir` / `--allowlist` point the gate at a synthetic tree so its own test
 * can exercise the real script rather than a copy of its regexes. CI passes
 * neither and gets the paths below.
 */
function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

const HTTPAPI_DIR = path.resolve(flag("dir") ?? path.join(PACKAGE_ROOT, "src", "server", "httpapi"))
const ALLOWLIST = path.resolve(flag("allowlist") ?? path.join(PACKAGE_ROOT, "specs", "httpapi-open-payloads.json"))
/** Paths in the report and in allowlist keys are relative to this. */
const PATH_BASE = flag("dir") ? HTTPAPI_DIR : PACKAGE_ROOT

type AllowlistEntry = {
  file: string
  snippet: string
  /** Identical declarations in this file. Absent means exactly one. */
  count?: number
  owner: string
  kind: string
  justification: string
}
type Allowlist = { entries: AllowlistEntry[] }

const PATTERNS: RegExp[] = [
  /\bSchema\.Unknown\b/,
  /\bSchema\.Array\(\s*Schema\.Unknown\b/,
  /\bSchema\.optional\(\s*Schema\.Unknown\b/,
  /\bSchema\.optionalKey\(\s*Schema\.Unknown\b/,
  /\bSchema\.optional\(\s*Schema\.Array\(\s*Schema\.Unknown\b/,
  /\bSchema\.optionalKey\(\s*Schema\.Array\(\s*Schema\.Unknown\b/,
  /\bSchema\.Record\(\s*Schema\.String,\s*Schema\.Unknown\b/,
]

async function listHttpApiFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: dir, absolute: true }))
  for (const entry of entries) out.push(entry)
  return out.sort()
}

async function findUnknowns(file: string): Promise<{ file: string; line: number; snippet: string }[]> {
  const source = await readFile(file, "utf8")
  const lines = source.split(/\r?\n/)
  const hits: { file: string; line: number; snippet: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*") || line.trimStart().startsWith("/*")) {
      continue
    }
    if (!PATTERNS.some((pattern) => pattern.test(line))) continue
    hits.push({
      // Package-relative, matching how the allowlist stores `file`. The line
      // is carried for the failure message only — it is not part of the key.
      file: path.relative(PATH_BASE, file),
      line: i + 1,
      snippet: line.trim(),
    })
  }
  return hits
}

/**
 * The allowlist key: package-relative path plus the declaring line's text.
 * Entries may carry the `packages/nikcli/` prefix; the scan never does, so
 * both are normalized to the package-relative form.
 */
function keyOf(file: string, snippet: string): string {
  const normalized = file.startsWith("packages/nikcli/") ? file.slice("packages/nikcli/".length) : file
  return `${normalized}\u0000${snippet}`
}

function describeKey(key: string): string {
  const [file, snippet] = key.split("\u0000")
  return `${file}  ${snippet}`
}

async function main() {
  const allowlistText = await readFile(ALLOWLIST, "utf8")
  const allowlist = JSON.parse(allowlistText) as Allowlist

  const allowed = new Map<string, number>()
  for (const entry of allowlist.entries) {
    const key = keyOf(entry.file, entry.snippet)
    allowed.set(key, (allowed.get(key) ?? 0) + (entry.count ?? 1))
  }

  const files = await listHttpApiFiles(HTTPAPI_DIR)
  const findings: { file: string; line: number; snippet: string }[] = []
  for (const file of files) {
    const hits = await findUnknowns(file)
    findings.push(...hits)
  }

  // Counted, not just matched: a file that grows a second copy of an already
  // justified declaration is a new open payload and needs its own review, even
  // though the text is identical to one that was approved.
  const seen = new Map<string, { count: number; first: { file: string; line: number; snippet: string } }>()
  for (const hit of findings) {
    const key = keyOf(hit.file, hit.snippet)
    const entry = seen.get(key)
    if (entry) entry.count++
    else seen.set(key, { count: 1, first: hit })
  }

  const violations: string[] = []
  for (const [key, { count, first }] of seen) {
    const budget = allowed.get(key) ?? 0
    if (count > budget) {
      violations.push(
        budget === 0
          ? `  ${first.file}:${first.line}  ${first.snippet}`
          : `  ${first.file}:${first.line}  ${first.snippet}  (${count} occurrences, ${budget} allowed)`,
      )
    }
  }

  const staleEntries: string[] = []
  for (const [key, budget] of allowed) {
    const found = seen.get(key)?.count ?? 0
    if (found < budget) {
      staleEntries.push(`${describeKey(key)}  (${budget} allowed, ${found} found)`)
    }
  }

  console.log(
    `open-payload check — ${findings.length} Schema.Unknown use(s) found in ${path.relative(PATH_BASE, HTTPAPI_DIR) || "."}`,
  )
  console.log(`allowlist size: ${allowlist.entries.length}`)

  if (violations.length > 0) {
    console.error("")
    console.error(`FAIL: ${violations.length} Schema.Unknown declaration(s) not covered by the allowlist:`)
    for (const v of violations) console.error(v)
    console.error("")
    console.error(
      "Either (a) add an entry to packages/nikcli/specs/httpapi-open-payloads.json with owner/kind/justification, or (b) replace Schema.Unknown with a typed schema.",
    )
  }

  if (staleEntries.length > 0) {
    console.warn("")
    console.warn(`WARN: ${staleEntries.length} allowlist entries no longer match the source:`)
    for (const stale of staleEntries) {
      console.warn(`  - ${stale}`)
    }
    console.warn("Remove the stale entries (or move the Schema.Unknown back).")
  }

  if (violations.length > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("check-open-payloads failed:", error)
  process.exit(2)
})
