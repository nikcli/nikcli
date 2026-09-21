import { describe, expect, it } from "bun:test"
import { SessionEntry } from "@/session/v2/entry"
import { tuiSource } from "./tui-source"
import { partTypes } from "@tui/routes/session/parts/registry"

/**
 * Every entry type reaches the screen.
 *
 * The session renderer draws from the v2 entry union. `fromEntries` folds some
 * types into the turn itself and the rest are looked up in `PART_MAPPING` — and
 * a type in neither used to render as *nothing*, with no error and no gap in
 * the transcript to notice. That is how `retry`, `subtask` and `synthetic`
 * became invisible when the renderer moved onto entries.
 *
 * The absorbed half still reads source: `fromEntries` decides it inline and
 * there is nothing to import. The drawn half used to as well, for the stated
 * reason that importing the session route pulled in the whole TUI — no longer
 * true now that the table lives in `parts/registry.ts`, which imports the part
 * components and nothing else. So that half asks the registry itself, and a
 * renderer registered at runtime counts exactly like a built-in one.
 *
 * The union comes from the schema, so adding a type to `SessionEntry` and
 * forgetting the renderer fails here.
 */

/** Types the turn model absorbs as properties instead of rows. */
async function absorbed() {
  const text = await tuiSource("routes/session/view.ts")
  return new Set([...text.matchAll(/entry\.type === "([a-z-]+)"/g)].map((match) => match[1]!))
}

/** Types with a renderer, built-in or registered. */
function drawn() {
  return new Set(partTypes())
}

describe("entry coverage", () => {
  it("the union is exactly the types the renderer was written against", () => {
    const types = SessionEntry.Entry.options.map((option) => option.shape.type.value as string).sort()
    expect(types).toEqual([
      "compaction",
      "complete",
      "patch",
      "reasoning",
      "retry",
      "snapshot",
      "start",
      "step-finish",
      "step-start",
      "subtask",
      "synthetic",
      "text",
      "tool",
      "user",
    ])
  })

  it("every type is either absorbed by the turn or drawn as a row", async () => {
    const [byTurn, byRow] = [await absorbed(), drawn()]
    const missing = SessionEntry.Entry.options
      .map((option) => option.shape.type.value as string)
      .filter((type) => !byTurn.has(type) && !byRow.has(type))

    // A type here renders as nothing at all. Add a component to `PART_MAPPING`,
    // or fold it into the turn in `fromEntries`.
    expect(missing).toEqual([])
  })

  it("the three that regressed are drawn, not absorbed", () => {
    const byRow = drawn()
    for (const type of ["retry", "subtask", "synthetic"]) {
      expect(byRow.has(type)).toBe(true)
    }
  })

  it("there is a fallback, so an unmapped type is visible rather than silent", async () => {
    const text = await tuiSource("routes/session/parts/assistant-message.tsx")
    expect(text).toContain("fallback={<UnknownPart")
  })

  it("subtask rows use SessionTaskCard so nested and background work do not share a ◆ line", async () => {
    const text = await tuiSource("routes/session/parts/subtask-part.tsx")
    expect(text).toContain("<SessionTaskCard")
    expect(text).toContain('kind={background() ? "background" : "subtask"}')
  })
})
