import { describe, expect, it } from "bun:test"
import {
  bodyRows,
  DISCLOSURE,
  DISCLOSURE_THRESHOLD,
  hiddenRows,
  summaryLine,
  worthCollapsing,
} from "@tui/component/disclosure"
import { bodyColumns, COMPONENT_DEFAULTS } from "@tui/context/component-tokens"
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
    expect(worthCollapsing("one line", 80)).toBe(false)
    expect(worthCollapsing("a\nb\nc", 80)).toBe(false)
    expect(worthCollapsing(Array(DISCLOSURE_THRESHOLD).fill("x").join("\n"), 80)).toBe(false)
    expect(
      worthCollapsing(
        Array(DISCLOSURE_THRESHOLD + 1)
          .fill("x")
          .join("\n"),
        80,
      ),
    ).toBe(true)
  })

  it("measures rows, not newlines, so one very long line still collapses", () => {
    // The shape the newline rule let through, and the one most worth hiding: a
    // pasted blob with no breaks at all is one "line" and a screenful of rows.
    const blob = "x".repeat(80 * (DISCLOSURE_THRESHOLD + 2))
    expect(blob.split("\n").length).toBe(1)
    expect(worthCollapsing(blob, 80)).toBe(true)
    expect(bodyRows(blob, 80)).toBe(DISCLOSURE_THRESHOLD + 2)
  })

  it("narrows with the viewport, because wrapping does", () => {
    const text = Array(4).fill("x".repeat(60)).join("\n")
    expect(worthCollapsing(text, 120)).toBe(false)
    expect(worthCollapsing(text, 20)).toBe(true)
  })

  it("counts hidden rows from the summary line, not from the leading blanks", () => {
    expect(hiddenRows("\n\nfirst\nsecond\nthird", 80)).toBe(2)
    expect(hiddenRows("only", 80)).toBe(0)
    expect(hiddenRows("   \n  ", 80)).toBe(0)
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
    // Same phase as the parent, which opens a dialog on mouseup: stopping a
    // mousedown does nothing to the mouseup that follows it, so the mark used
    // to expand the message and then bury it under a dialog.
    expect(source).toContain("setExpanded(false)")
    expect(source).toContain("event.stopPropagation()")
    expect(source).not.toContain("onMouseDown={() => setExpanded")
  })

  it("the task card uses the same marks rather than its own glyphs", async () => {
    const source = await tuiSource("component/session-task-card.tsx")
    expect(source).toContain("DISCLOSURE.follow")
    expect(source).toContain("DISCLOSURE.open")
    expect(source).toContain("DISCLOSURE.closed")
  })
})

/**
 * The rule that made both marks wrong the first time.
 *
 * A mark sits inside a surface that already answers a click — the user message
 * opens a dialog, the task card opens the run. Stopping a `mousedown` does
 * nothing to the `mouseup` that follows it, so a mark handled in the wrong
 * phase expanded its detail and then had the parent bury it: a dialog over the
 * message, or a navigation away from the session.
 *
 * Source-level because the failure is in which event fires, and reproducing
 * that needs a real renderer and a real pointer. The shape is what is pinned.
 */
describe("marks answer the same event their surface does", () => {
  const SURFACES = [
    "routes/session/parts/user-message.tsx",
    "component/session-task-card.tsx",
    "routes/session/tool-view.tsx",
  ]

  for (const file of SURFACES) {
    it(`${file} never toggles from mousedown`, async () => {
      const source = await tuiSource(file)
      expect(source).not.toMatch(/onMouseDown=\{[^}]*set(Expanded|StatusOpen)/)
    })
  }

  it("every clickable surface in the transcript checks the selection first", async () => {
    // A drag ending on a row is somebody selecting text, not asking to be
    // taken somewhere. The card navigates, so it needed this most and had it
    // least.
    for (const file of SURFACES) {
      expect(await tuiSource(file)).toContain("getSelectedText()")
    }
  })
})

/**
 * The estimator and the renderer must agree about how wide a body is.
 *
 * They did not. One subtracted the left and right borders; the other subtracted
 * `borderSides.length`, which counts the top and bottom ones too, though a
 * border on the top costs a row and never a column. They also started from
 * different widths — one from the scrollbox viewport, which falls back to the
 * whole terminal and ignores the sidebar.
 *
 * When they disagree they disagree about whether a body collapses, and the
 * virtualizer reserves a height nothing draws.
 */
describe("body width is one calculation", () => {
  const style = COMPONENT_DEFAULTS["session.user-message"].box

  it("takes columns for side borders and nothing for top or bottom", () => {
    const sides = bodyColumns({ paddingLeft: 0, paddingRight: 0, borderSides: ["left", "right"] }, 100)
    const caps = bodyColumns({ paddingLeft: 0, paddingRight: 0, borderSides: ["top", "bottom"] }, 100)
    expect(sides).toBe(98)
    expect(caps).toBe(100)
  })

  it("subtracts the message's own chrome", () => {
    // Stock user message: two columns of left padding and one of left border.
    expect(bodyColumns(style, 100)).toBe(100 - style.paddingLeft - style.paddingRight - 1)
  })

  it("never returns a width that would divide by zero", () => {
    expect(bodyColumns(style, 0)).toBeGreaterThan(0)
    expect(bodyColumns(style, 1)).toBeGreaterThan(0)
    expect(bodyColumns(style, -50)).toBeGreaterThan(0)
  })

  it("is the only place either side computes it", async () => {
    // A second formula is how the two drifted apart in the first place.
    for (const file of ["routes/session/index.tsx", "routes/session/parts/user-message.tsx"]) {
      const source = await tuiSource(file)
      expect(source).toContain("bodyColumns(")
      expect(source).not.toContain("borderSides.length")
    }
  })
})
