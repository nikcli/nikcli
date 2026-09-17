import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { ACTIVITY_CODES } from "../grid/activity"

/*
 * A ratchet on the text written straight into JSX (S41).
 *
 * Counts, per file, the JSX text and the user-facing attributes that are
 * fixed strings rather than `t(…)`, and the fixed text handed to the calls
 * that put words on screen outside JSX: notices, panel notes, reports and
 * inline problems. A pane activity written as a sentence instead of one of
 * the codes in `grid/activity.ts` counts too. The count may only go down: a file
 * above its baseline has gained an untranslated text, and a file below it has
 * lost some and should say so, so the next regression is caught at the new
 * level. `ADE_I18N_BASELINE=write bun run test:unit` rewrites the baseline.
 */

const SRC = join(import.meta.dir, "..")
const BASELINE = join(import.meta.dir, "hardcoded-baseline.json")

const UI_ATTRIBUTES = new Set([
  "title",
  "aria-label",
  "placeholder",
  "alt",
  "label",
  "emptyLabel",
  "subtitle",
  "description",
])

/** Calls whose text arguments end up on screen. */
const SINKS = new Set([
  "appendLine",
  "noteInTerminal",
  "report",
  "addNotice",
  "setNotice",
  "setNote",
  "setProblem",
  "setError",
  "setLoadError",
  "setVoiceNotice",
  "setVoiceSettingsNotice",
])

/** Names and symbols that read the same in any language. */
const NEUTRAL = /^(?:ADE|nik|nikcli|ssh|MCP|git|GitHub|OpenRouter|Codex|Claude Code|&lt;|&gt;|bun run|[A-Z][A-Z0-9_]+)$/

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") sources(path, into)
    } else if (/\.tsx?$/.test(name) && !name.includes(".test.") && !name.endsWith(".d.ts")) into.push(path)
  }
  return into
}

const isText = (text: string) => /\p{L}{2,}/u.test(text) && !NEUTRAL.test(text)
/** Outside JSX a string is often a kind or an id; words with a space are prose. */
const isProse = (text: string) => isText(text.trim()) && /\p{L}{2,}\s+\p{L}/u.test(text)

/** The fixed words in a literal or template, or undefined when it is not one. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ")
  return undefined
}

const calleeName = (call: ts.CallExpression) => {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return undefined
}

/** Fixed text reaching a sink, directly, through `a ? "x" : "y"`, or as an object's `text`. */
function sinkTexts(node: ts.Expression, into: string[]): void {
  const text = literalText(node)
  if (text !== undefined) into.push(text)
  else if (ts.isConditionalExpression(node)) {
    sinkTexts(node.whenTrue, into)
    sinkTexts(node.whenFalse, into)
  } else if (ts.isParenthesizedExpression(node)) sinkTexts(node.expression, into)
  else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && property.name.getText() === "text") sinkTexts(property.initializer, into)
    }
  }
}

function count(path: string): number {
  const file = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let found = 0
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (isText(node.getText().replace(/\s+/g, " ").trim())) found++
    } else if (ts.isJsxAttribute(node) && node.initializer && UI_ATTRIBUTES.has(node.name.getText())) {
      const init = node.initializer
      const literal = ts.isStringLiteral(init)
        ? init.text
        : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)
          ? init.expression.text
          : undefined
      if (literal !== undefined && isText(literal.trim())) found++
    } else if (ts.isCallExpression(node) && SINKS.has(calleeName(node) ?? "")) {
      const texts: string[] = []
      for (const argument of node.arguments) sinkTexts(argument, texts)
      found += texts.filter((text) => isProse(text)).length
    } else if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "activity" &&
      ts.isStringLiteral(node.initializer) &&
      !(ACTIVITY_CODES as readonly string[]).includes(node.initializer.text)
    ) {
      found++
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function measure(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const path of sources(SRC).sort()) {
    const n = count(path)
    if (n > 0) counts[relative(SRC, path).replace(/\\/g, "/")] = n
  }
  return counts
}

describe("fixed text in JSX", () => {
  test("does not grow, and the baseline follows it down", () => {
    const now = measure()
    if (process.env.ADE_I18N_BASELINE === "write") {
      writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n")
      return
    }
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>
    const grew: string[] = []
    const shrank: string[] = []
    for (const file of new Set([...Object.keys(now), ...Object.keys(baseline)])) {
      const was = baseline[file] ?? 0
      const is = now[file] ?? 0
      if (is > was) grew.push(`${file}: ${was} → ${is} (use t() from src/i18n)`)
      if (is < was) shrank.push(`${file}: ${was} → ${is} (lower the baseline: ADE_I18N_BASELINE=write)`)
    }
    expect(grew).toEqual([])
    expect(shrank).toEqual([])
  })
})
