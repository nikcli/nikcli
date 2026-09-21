import { describe, expect, it } from "bun:test"
import { DISCLOSURE, DISCLOSURE_THRESHOLD, summaryLine, worthCollapsing } from "@tui/component/disclosure"
import { tuiSource } from "./tui-source"

/**
 * One disclosure grammar, used by every session surface that carries detail.
 *
 * The transcript used to mix rows that were one line with rows that were thirty
 * — a background job finishing queues a wake message whose text is the job's
 * entire result — and nothing told the reader which was which, or that anything
 * could be done about it.
 */
describe("disclosure marks", () => {
  it("keeps three distinct marks, because they mean three different things", () => {
    expect(new Set(Object.values(DISCLOSURE)).size).toBe(3)
    expect(DISCLOSURE.follow).not.toBe(DISCLOSURE.closed)
  })

  it("collapses a body only once it is taller than something read in passing", () => {
    expect(worthCollapsing("one line")).toBe(false)
    expect(worthCollapsing("a\nb\nc")).toBe(false)
    expect(worthCollapsing(Array(DISCLOSURE_THRESHOLD).fill("x").join("\n"))).toBe(false)
    expect(
      worthCollapsing(
        Array(DISCLOSURE_THRESHOLD + 1)
          .fill("x")
          .join("\n"),
      ),
    ).toBe(true)
  })

  it("summarises with the first line that has something on it", () => {
    expect(summaryLine('Background task "Explore" finished.\nStatus: complete')).toBe(
      'Background task "Explore" finished.',
    )
    // Leading blanks are how a machine-written body usually starts.
    expect(summaryLine("\n\n  Result:  \nmore")).toBe("Result:")
    expect(summaryLine("   ")).toBe("")
  })
})

describe("the surfaces that speak it", () => {
  it("the user message collapses a long body and folds it from the mark, not the text", async () => {
    const source = await tuiSource("routes/session/parts/user-message.tsx")
    expect(source).toContain("worthCollapsing")
    expect(source).toContain("DISCLOSURE.closed")
    // Clicking inside the body is a selection. A handler there would fold the
    // message away exactly when somebody is trying to read it.
    expect(source).toContain("onMouseDown={() => setExpanded(false)}")
    expect(source).not.toContain("onMouseUp={() => setExpanded")
  })

  it("the task card uses the same marks rather than its own glyphs", async () => {
    const source = await tuiSource("component/session-task-card.tsx")
    expect(source).toContain("DISCLOSURE.follow")
    expect(source).toContain("DISCLOSURE.open")
    expect(source).toContain("DISCLOSURE.closed")
  })
})
