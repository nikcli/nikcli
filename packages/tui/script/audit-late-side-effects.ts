#!/usr/bin/env bun
/**
 * `script/audit-late-side-effects.ts` — EOT-03 triage, not a gate.
 *
 * Finds the shape `await …` followed by an **external side effect** —
 * `dialog.replace`, `route.navigate`, `Bun.spawn`, `.dispose()` — with no
 * cancellation guard between them.
 *
 * Why the shape matters. In Solid, writing a signal after the owner is
 * disposed is harmless: nothing reads it. What is not harmless is acting on
 * the outside world after an await that the user has, in the meantime, walked
 * away from. `ui/dialog.tsx`'s `replace()` sets the stack unconditionally —
 * there is no empty-stack guard — so a `replace` that arrives after the user
 * pressed `esc` **reopens the dialog they just left**.
 *
 * Why this is triage and not CI. The detector is indentation-based and cannot
 * tell a call from a call *site*: `onSelect: () => dialog.replace(…)` built
 * after an await is perfectly safe, because the handler only runs while the
 * component is alive, and it looks identical from here. Roughly one in five
 * hits is real. Turning this into a blocking gate would mean either accepting
 * that ratio or writing an allowlist longer than the findings — so it prints a
 * ranked list for a human to read, and always exits 0.
 *
 * Run: `bun run script/audit-late-side-effects.ts`
 */

import { readFileSync } from "node:fs"
import path from "node:path"

const SRC = path.resolve(import.meta.dirname, "..", "src")

const SIDE_EFFECT = /\b(?:dialog\.(?:open|replace|push)|route\.navigate|navigate)\s*\(|\bBun\.spawn\b|\.dispose\(\)/
const AWAIT = /\bawait\b/
/** Anything that answers "does this result still matter". */
const GUARD = /useAbortOnCleanup|useAttempts|AbortController|disposed\(\)|stale\(\)|\bsignal\b/
const COMMENT = /^\s*(\/\/|\*|\/\*)/
/** How far back to look for the await; past this the two are not one flow. */
const WINDOW = 120

const indent = (line: string) => line.length - line.trimStart().length

type Hit = { file: string; line: number; awaitLine: number; hasHelper: boolean; text: string }

function scan(file: string, rel: string): Hit[] {
  const source = readFileSync(file, "utf8")
  if (!AWAIT.test(source)) return []
  const hasHelper = /useAbortOnCleanup|useAttempts/.test(source)
  const lines = source.split(/\r?\n/)
  const hits: Hit[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!SIDE_EFFECT.test(line) || COMMENT.test(line)) continue
    const own = indent(line)

    let awaitLine: number | undefined
    for (let j = i - 1; j >= 0 && i - j < WINDOW; j--) {
      const back = lines[j]
      if (!back.trim()) continue
      const at = indent(back)
      // Reached the enclosing callable: an await outside it belongs to a
      // different flow, and a non-async one cannot have awaited at all.
      if (at < own && /\b(?:async|function|=>)\b/.test(back)) {
        if (!back.includes("async")) awaitLine = undefined
        break
      }
      if (at <= own + 4 && AWAIT.test(back) && awaitLine === undefined) awaitLine = j + 1
    }
    if (awaitLine === undefined) continue
    // A guard anywhere between the await and the effect is the whole point.
    if (GUARD.test(lines.slice(awaitLine - 1, i).join("\n"))) continue

    hits.push({ file: rel, line: i + 1, awaitLine, hasHelper, text: line.trim().slice(0, 72) })
  }
  return hits
}

const hits: Hit[] = []
for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC, absolute: true })) {
  hits.push(...scan(file, path.relative(SRC, file)))
}

// Files with no helper at all come first: a file that already imports one has
// at least been thought about.
hits.sort((a, b) => Number(a.hasHelper) - Number(b.hasHelper) || a.file.localeCompare(b.file) || a.line - b.line)

console.log(`${hits.length} candidate site(s) — side effect after await, no guard between.`)
console.log("Candidates, not defects: read each one. See this file's docblock.\n")
for (const hit of hits) {
  console.log(`${hit.hasHelper ? "has-helper" : "NO-HELPER "}  ${hit.file}:${hit.line}  (await at ${hit.awaitLine})`)
  console.log(`              ${hit.text}`)
}
