import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { MAX_PARALLEL_TURNS, acquireTurn, limitReached, turnsRunning } from "./terms"

describe("turns on a plan", () => {
  const held: { release: () => void }[] = []
  afterEach(() => held.splice(0).forEach((slot) => slot.release()))

  test("only a few run at once, and a finished one gives its place back", () => {
    for (let i = 0; i < MAX_PARALLEL_TURNS; i++) {
      const slot = acquireTurn("claude", "Claude Code")
      if ("problem" in slot) throw new Error(slot.problem)
      held.push(slot)
    }
    const refused = acquireTurn("claude", "Claude Code")
    expect("problem" in refused && refused.problem).toContain("al massimo")
    held.pop()!.release()
    const again = acquireTurn("claude")
    expect("release" in again).toBe(true)
    if ("release" in again) held.push(again)
  })

  test("releasing twice does not free a second place, and nikcli is not counted", () => {
    const slot = acquireTurn("codex")
    if ("problem" in slot) throw new Error(slot.problem)
    slot.release()
    slot.release()
    expect(turnsRunning("codex")).toBe(0)
    for (let i = 0; i < MAX_PARALLEL_TURNS + 2; i++) expect("release" in acquireTurn("nikcli")).toBe(true)
  })
})

test("a plan limit is recognised in what the CLIs say", () => {
  expect(limitReached("Claude AI usage limit reached|1757880000")).toBe(true)
  expect(limitReached("You've hit your usage limit. Upgrade to Pro or try again in 3 hours.")).toBe(true)
  expect(limitReached("stream error: 429 Too Many Requests")).toBe(true)
  expect(limitReached("File not found: limits.ts")).toBe(false)
})

test("ADE's source never touches the CLIs' credentials", () => {
  const forbidden = [".credentials.json", ".codex/auth.json", ".codex\\auth.json", "CLAUDE_CODE_OAUTH_TOKEN"]
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory()
        ? walk(path)
        : /\.(ts|tsx|rs)$/.test(name) && !/\.test\.ts$/.test(name)
          ? [path]
          : []
    })
  const root = join(import.meta.dir, "..", "..")
  const files = [...walk(join(root, "src")), ...walk(join(root, "src-tauri", "src"))]
  const hits = files.filter((file) => forbidden.some((needle) => readFileSync(file, "utf8").includes(needle)))
  expect(hits).toEqual([])
})
