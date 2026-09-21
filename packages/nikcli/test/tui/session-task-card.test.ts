import { describe, expect, it } from "bun:test"
import { sessionTaskChrome, sessionTaskVisual } from "@tui/component/session-task-card"
import { stripComments, tuiSource } from "./tui-source"

/**
 * Nested subtask versus parallel background job, pinned without mounting the
 * session route. The two used to share a ◆ row plus a muted suffix; the chrome
 * tokens and the two call sites are the whole visual distinction.
 */

describe("session task chrome", () => {
  it("gives nested subtasks and background jobs different glyph, badge, rail and hint", () => {
    const nested = sessionTaskChrome("subtask")
    const parallel = sessionTaskChrome("background")

    expect(nested.glyph).toBe("◆")
    expect(parallel.glyph).toBe("◐")
    expect(nested.badge).toBe("SUBTASK")
    expect(parallel.badge).toBe("BG")
    expect(nested.rail).toBe("┃")
    expect(parallel.rail).toBe("╎")
    expect(nested.hint).toBe("nested in this turn")
    expect(parallel.hint).toBe("running in parallel")

    expect(nested.glyph).not.toBe(parallel.glyph)
    expect(nested.badge).not.toBe(parallel.badge)
    expect(nested.rail).not.toBe(parallel.rail)
    expect(nested.hint).not.toBe(parallel.hint)
  })

  it("keeps the two kinds as the only visual vocabulary", () => {
    expect(Object.keys(sessionTaskVisual).sort()).toEqual(["background", "subtask"])
  })
})

describe("session transcript uses the card, not a dialog", () => {
  it("SubtaskPart picks kind from entry.background and renders SessionTaskCard", async () => {
    const text = stripComments(await tuiSource("routes/session/parts/subtask-part.tsx"))
    expect(text).toContain("function SubtaskPart")
    expect(text).toContain('kind={background() ? "background" : "subtask"}')
    expect(text).toContain("<SessionTaskCard")
    expect(text).not.toContain("· background")
  })

  it("the task tool picks kind from metadata.background, not from having a delegation id", async () => {
    const text = stripComments(await tuiSource("routes/session/tool-view.tsx"))
    expect(text).toContain("function Task(")
    expect(text).toContain("const isBackground = createMemo(() => Boolean(meta().background))")
    expect(text).toContain('kind={isBackground() ? "background" : "subtask"}')
    expect(text).toContain("<SessionTaskCard")
    expect(text).not.toContain("meta().background || meta().delegationId")
    expect(text).not.toContain("follow background task")
  })
})
