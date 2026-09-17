import { describe, expect, test } from "bun:test"
import type { SavedLine } from "./persist"
import {
  MAX_CHARS_PER_PANE,
  MAX_LINES_PER_PANE,
  boundPaneTranscript,
  boundWorkspaceTranscripts,
} from "./transcript-budget"

const lines = (count: number, text = "x"): SavedLine[] =>
  Array.from({ length: count }, (_, i) => ({ kind: "step", text: `${i}:${text}` }))

describe("boundPaneTranscript", () => {
  test("a short transcript is kept whole", () => {
    const input = lines(5)
    expect(boundPaneTranscript(input)).toEqual(input)
  })

  /*
   * The tail, not the head. After a restart what a user looks for is how the
   * session ended — the error, the last command, the question it was asking.
   */
  test("keeps the end of a long transcript, in order", () => {
    const kept = boundPaneTranscript(lines(1000), 10, 1_000_000)
    expect(kept).toHaveLength(10)
    expect(kept[0].text).toBe("990:x")
    expect(kept[9].text).toBe("999:x")
  })

  test("the character bound applies as well as the line bound", () => {
    const kept = boundPaneTranscript(lines(100, "y".repeat(100)), 100, 500)
    expect(kept.length).toBeLessThan(100)
    expect(kept.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(500)
    // Still the newest ones.
    expect(kept[kept.length - 1].text.startsWith("99:")).toBe(true)
  })

  /*
   * A pane whose whole transcript is one enormous line must not restore
   * empty: an empty pane says nothing happened, which is the wrong thing to
   * say about a session that printed a megabyte.
   */
  test("one oversized line is truncated, never dropped", () => {
    const kept = boundPaneTranscript([{ kind: "shell", text: "z".repeat(50_000) }], 10, 100)
    expect(kept).toHaveLength(1)
    expect(kept[0].text.length).toBeLessThan(50_000)
    expect(kept[0].text.endsWith("…")).toBe(true)
  })

  test("the defaults are the documented ones", () => {
    const kept = boundPaneTranscript(lines(5_000))
    expect(kept).toHaveLength(MAX_LINES_PER_PANE)
    expect(kept.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(
      MAX_CHARS_PER_PANE,
    )
  })

  test("an empty transcript stays empty", () => {
    expect(boundPaneTranscript([])).toEqual([])
  })
})

describe("boundWorkspaceTranscripts", () => {
  const pane = (id: string, count: number) => ({ id, lines: lines(count, "y".repeat(50)) })

  test("under budget, nothing is touched", () => {
    const panes = [pane("a", 2), pane("b", 2)]
    expect(boundWorkspaceTranscripts(panes, "a", 1_000_000)).toEqual(panes)
  })

  /*
   * Six sessions each individually within budget are collectively not, and
   * overflowing the quota throws on write — which saves nothing at all,
   * the one outcome worse than saving less.
   */
  test("over budget, the total comes down", () => {
    const panes = [pane("a", 40), pane("b", 40), pane("c", 40)]
    const out = boundWorkspaceTranscripts(panes, "c", 2_000)
    const total = out.reduce(
      (sum, p) => sum + (p.lines ?? []).reduce((n, line) => n + line.text.length, 0),
      0,
    )
    expect(total).toBeLessThanOrEqual(2_000)
  })

  test("the focused session keeps more than the others", () => {
    const panes = [pane("a", 40), pane("b", 40), pane("c", 40)]
    const out = boundWorkspaceTranscripts(panes, "c", 2_000)
    const size = (id: string) => out.find((p) => p.id === id)!.lines!.length
    expect(size("c")).toBeGreaterThan(size("a"))
  })

  test("no pane is emptied entirely, however tight the budget", () => {
    const panes = [pane("a", 40), pane("b", 40)]
    const out = boundWorkspaceTranscripts(panes, "b", 1)
    for (const p of out) expect(p.lines!.length).toBeGreaterThanOrEqual(1)
  })

  test("panes without a transcript are left alone", () => {
    const out = boundWorkspaceTranscripts([{ id: "a" }, pane("b", 40)], "b", 100)
    expect(out[0]).toEqual({ id: "a" })
  })
})
