#!/usr/bin/env bun
/**
 * `script/check-spec-paths.ts` — the spec file-reference gate.
 *
 * The specs cite source files constantly, and those citations are how a reader
 * gets from a claim to the code. They rot in one specific way: a migration
 * moves the file, the prose keeps the old path, and the spec goes on
 * certifying a location that no longer holds what it describes.
 *
 * That is not hypothetical — it is the most common defect this catalogue has
 * produced. Four separate spec claims were found stale in a single day by
 * following their own paths: EOT-12 named surfaces that do not require an
 * account, EOT-17 named a chokepoint nothing routes through, EOT-18 pinned its
 * requirement to a wrapper with no registered commands, and EOT-20 declared a
 * package untested whose tests live one package over. Each one read as
 * evidence.
 *
 * **Not every dead path is a defect**, which is why this is an allowlist rather
 * than an existence check. Three reasons are legitimate:
 *
 *  - `historical` — a document describing a completed migration naming what it
 *    removed. `cli-framework.md` citing `yargs-bridge.ts` is correct prose.
 *  - `absence` — a deliberate statement that a path does *not* exist.
 *    `logging-redaction-contract.md` says "There is no
 *    `packages/nikcli/src/util/redact.ts`", and a gate that demanded that file
 *    would be demanding the thing the sentence exists to deny.
 *  - `placeholder` — an example in an explanation, like `handlers/foo.ts`.
 *
 * Anything else fails, and the fix is to repoint the citation rather than to
 * add an entry here.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..")
const SPECS = path.join(REPO_ROOT, "specs")

/** A backticked path with a source-file extension. */
const CITATION = /`((?:packages\/[a-z0-9-]+\/)?(?:src|script|test)\/[A-Za-z0-9/_.-]+\.(?:ts|tsx|md|json))`/g

/** Roots a bare `src/…` citation may be relative to, in order. */
const BARE_ROOTS = ["", "packages/nikcli", "packages/tui"]

type Reason = "historical" | "absence" | "placeholder"

const ALLOWED: Record<string, { reason: Reason; note: string }> = {
  "packages/cli/src/server-process.ts": {
    reason: "historical",
    note: "background-service.md, describing the shape before the daemon landed",
  },
  "packages/nikcli/src/cli/cmd/cmd.ts": {
    reason: "historical",
    note: "removed with the Lifecycle wrapper; named in past tense",
  },
  "src/cli/cmd/cmd.ts": { reason: "historical", note: "same wrapper, cited from 18-cli-command-architecture.md" },
  "packages/nikcli/src/cli/cmd/tui/app.tsx": { reason: "historical", note: "tui-package.md, describing the tree move" },
  "src/cli/cmd/lazy.ts": { reason: "historical", note: "lazy command loading, reverted for first-use latency" },
  "test/cli/lazy-commands.test.ts": { reason: "historical", note: "its test, removed with it" },
  "src/cli/cmd/remote.ts": { reason: "historical", note: "moved to @nikcli-ai/util/remote-tunnel" },
  "src/cli/framework/yargs-bridge.ts": {
    reason: "historical",
    note: "cli-framework.md, naming what the migration deleted",
  },
  "test/cli/effect-cli-parity.test.ts": { reason: "historical", note: "parity tests retired with the bridge" },
  "test/cli/effect-cli-parse-parity.test.ts": { reason: "historical", note: "parity tests retired with the bridge" },
  "src/cli-main.ts": { reason: "historical", note: "the yargs entry the framework migration replaced" },
  "src/bus/global.ts": { reason: "historical", note: "tui-package.md, describing the move" },
  "src/plugin/shared.ts": { reason: "historical", note: "tui-package.md, describing the move" },
  "src/util/lazy.ts": {
    reason: "historical",
    note: "tui-package.md, contrasting it with packages/util/src/lazy.ts during the move",
  },
  "src/storage/effect.ts": { reason: "historical", note: "remove-json-storage.md, naming what it removed" },
  "src/storage/storage.ts": { reason: "historical", note: "remove-json-storage.md, naming what it removed" },
  "test/storage/effect-service.test.ts": { reason: "historical", note: "removed with the storage service" },
  "src/observability/telemetry-consumer.ts": {
    reason: "historical",
    note: "the reference consumer deleted once the real one was found",
  },
  "script/check-cli-table.ts": {
    reason: "historical",
    note: "cli-command-surface.md, on a table that is not a CI check",
  },
  "packages/nikcli/src/util/redact.ts": {
    reason: "absence",
    note: "the sentence exists to say this path does not exist",
  },
  "src/cli/handlers/foo.ts": { reason: "placeholder", note: "an example of registering a handler" },
}

function resolves(cited: string): boolean {
  return BARE_ROOTS.some((root) => existsSync(path.join(REPO_ROOT, root, cited)))
}

async function main() {
  const found = new Map<string, string[]>()
  for await (const file of new Bun.Glob("**/*.md").scan({ cwd: SPECS, absolute: true })) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i].matchAll(CITATION)) {
        const cited = match[1]
        if (resolves(cited)) continue
        const where = `${path.relative(REPO_ROOT, file)}:${i + 1}`
        found.set(cited, [...(found.get(cited) ?? []), where])
      }
    }
  }

  const violations = [...found].filter(([cited]) => !(cited in ALLOWED))
  // An allowlist entry for a path that resolves again is worth removing: the
  // note explains an absence that is no longer true.
  const stale = Object.keys(ALLOWED).filter((cited) => resolves(cited))

  console.log(`spec paths — ${found.size} cited path(s) do not resolve, ${Object.keys(ALLOWED).length} explained`)

  if (stale.length > 0) {
    console.warn("")
    console.warn(`WARN: ${stale.length} allowlist entr(ies) name a path that exists again:`)
    for (const cited of stale) console.warn(`  - ${cited}`)
  }

  if (violations.length > 0) {
    console.error("")
    console.error(`FAIL: ${violations.length} cited path(s) do not resolve and have no reason:`)
    for (const [cited, where] of violations) {
      console.error(`  ${cited}`)
      for (const w of where.slice(0, 3)) console.error(`      cited at ${w}`)
    }
    console.error("")
    console.error(
      "Repoint the citation. Add an ALLOWLIST entry only when the path is named historically, denied on purpose, or is an example — and say which.",
    )
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("check-spec-paths failed:", error)
  process.exit(2)
})
