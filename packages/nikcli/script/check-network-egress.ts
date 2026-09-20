#!/usr/bin/env bun
/**
 * `script/check-network-egress.ts` — EOT-17 outbound-egress accounting gate.
 *
 * `specs/effect-tui/17-sandbox-permission-boundaries.md` wants "network policy
 * routes every outbound HTTP/WS through one chokepoint; bypass is a defect."
 * The codebase does **not** have that chokepoint: `fetch`/`WebSocket` are
 * called directly from ~50 modules, and the only Effect `FetchHttpClient`
 * layer (`observability/otlp.ts`) is OTLP-only. Wrapping a chokepoint that
 * nothing calls would be theatre.
 *
 * What is enforceable today is **accounting**: every module that can reach the
 * network is listed with a purpose, and a new one fails CI until a reviewer
 * puts it in the inventory. This is the same discipline as
 * `check-route-coverage.ts` and `check-open-payloads.ts`.
 *
 * Modes:
 *   - default: validate `specs/network-egress.json` against the scan.
 *     Fails on an unlisted egress file (new surface) or a listed file with no
 *     egress (stale entry).
 *   - `--report`: print the discovered files as JSON, for regenerating the
 *     inventory. The detector here is the same one validation uses, so the
 *     inventory cannot drift from the enforcer.
 *
 * Detection rules (deliberately narrow — a false positive costs a review, a
 * false negative costs a blind egress):
 *   - a **bare** `fetch(...)` call: excludes `Server.fetch(...)` (in-process
 *     loopback), `foo.fetch(...)`, and `fetchFn`-style identifiers.
 *   - `new WebSocket(`, `Bun.connect(`, `new EventSource(`,
 *     `http.request(` / `https.request(`.
 *   - skipped: comment lines, `function fetch(` / `async fetch(` declarations,
 *     and `as typeof globalThis.fetch` type positions.
 */

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
const SCOPES = [path.join(REPO_ROOT, "packages", "nikcli", "src"), path.join(REPO_ROOT, "packages", "llm", "src")]
const INVENTORY = path.join(REPO_ROOT, "packages", "nikcli", "specs", "network-egress.json")

/** Standalone `fetch(` — not a member call, not a longer identifier. */
const BARE_FETCH = /(?<![\w.$])fetch\s*\(/
const EGRESS_SINKS = [
  BARE_FETCH,
  /\bnew\s+WebSocket\s*\(/,
  /\bBun\.connect\s*\(/,
  /\bnew\s+EventSource\s*\(/,
  /\bhttps?\.request\s*\(/,
]

/** Lines that look like egress but are not. */
const SKIP = [
  /^\s*(\/\/|\*|\/\*)/, // comment
  /\b(?:function|async|get|set)\s+fetch\s*\(/, // declaration
  /\bServer\.fetch\s*\(/, // in-process loopback
  /\btypeof\s+globalThis\.fetch/, // type position
  /\bfetch\s*:\s*/, // property definition
]

type Hit = { file: string; line: number; snippet: string }

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for await (const entry of new Bun.Glob("**/*.ts").scan({
    cwd: dir,
    absolute: true,
  })) {
    if (entry.endsWith(".test.ts")) continue
    out.push(entry)
  }
  return out.sort()
}

function scanSource(source: string): Hit[] {
  const hits: Hit[] = []
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (SKIP.some((skip) => skip.test(line))) continue
    if (!EGRESS_SINKS.some((sink) => sink.test(line))) continue
    hits.push({ file: "", line: i + 1, snippet: line.trim() })
  }
  return hits
}

async function discover(): Promise<Map<string, Hit[]>> {
  const found = new Map<string, Hit[]>()
  for (const scope of SCOPES) {
    const files = await listFiles(scope).catch(() => [])
    for (const file of files) {
      const hits = scanSource(readFileSync(file, "utf8"))
      if (hits.length === 0) continue
      const rel = path.relative(REPO_ROOT, file)
      found.set(
        rel,
        hits.map((hit) => ({ ...hit, file: rel })),
      )
    }
  }
  return found
}

async function main() {
  const report = process.argv.includes("--report")
  const found = await discover()

  if (report) {
    const payload = [...found.entries()]
      .map(([file, hits]) => ({
        file,
        count: hits.length,
        samples: hits.slice(0, 2).map((h) => h.snippet),
      }))
      .sort((a, b) => a.file.localeCompare(b.file))
    writeFileSync(
      path.join(REPO_ROOT, "packages", "nikcli", "specs", "network-egress.report.json"),
      JSON.stringify(payload, null, 2) + "\n",
    )
    console.log(`network-egress report — ${found.size} file(s) with outbound egress`)
    return
  }

  let inventory: { entries: { file: string; purpose: string }[] } = {
    entries: [],
  }
  try {
    inventory = JSON.parse(readFileSync(INVENTORY, "utf8"))
  } catch (error) {
    console.error(`cannot read ${path.relative(REPO_ROOT, INVENTORY)}:`, error)
    process.exit(2)
  }

  const listed = new Map(inventory.entries.map((entry) => [entry.file, entry]))
  const unlisted = [...found.keys()].filter((file) => !listed.has(file)).sort()
  const stale = [...listed.keys()].filter((file) => !found.has(file)).sort()
  const unknownPurpose = inventory.entries.filter((entry) => !entry.purpose).map((entry) => entry.file)

  console.log(`network egress — ${found.size} file(s) with egress, ${inventory.entries.length} listed`)

  if (unlisted.length > 0 || stale.length > 0 || unknownPurpose.length > 0) {
    console.error("")
    if (unlisted.length > 0) {
      console.error(`FAIL: ${unlisted.length} egress file(s) not in the inventory:`)
      for (const file of unlisted) console.error(`  + ${file}`)
    }
    if (stale.length > 0) {
      console.error(`FAIL: ${stale.length} listed file(s) have no egress:`)
      for (const file of stale) console.error(`  - ${file}`)
    }
    if (unknownPurpose.length > 0) {
      console.error(`FAIL: ${unknownPurpose.length} entr(ies) missing a purpose:`)
      for (const file of unknownPurpose) console.error(`  ? ${file}`)
    }
    console.error("")
    console.error("Run `bun run script/check-network-egress.ts --report` and add the new file(s)")
    console.error("with a purpose to packages/nikcli/specs/network-egress.json, or remove the stale entry.")
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("check-network-egress failed:", error)
  process.exit(2)
})
