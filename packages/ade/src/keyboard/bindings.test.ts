import { describe, expect, test } from "bun:test"
import { DEFAULT_BINDINGS, resolveDefaultBindings } from "./bindings"
import { findConflicts } from "./keymap"

describe("DEFAULT_BINDINGS", () => {
  test("every entry has a non-empty command id", () => {
    for (const entry of DEFAULT_BINDINGS) {
      expect(entry.commandId.length).toBeGreaterThan(0)
    }
  })

  test("every entry has a non-empty chord string", () => {
    for (const entry of DEFAULT_BINDINGS) {
      expect(entry.chord.length).toBeGreaterThan(0)
    }
  })

  test("no conflicts on mac", () => {
    const resolved = resolveDefaultBindings("mac")
    const conflicts = findConflicts(resolved)
    expect(conflicts).toEqual([])
  })

  test("no conflicts on other platforms", () => {
    const resolved = resolveDefaultBindings("other")
    const conflicts = findConflicts(resolved)
    expect(conflicts).toEqual([])
  })

  test("resolves to the expected number of bindings", () => {
    const resolved = resolveDefaultBindings("other")
    expect(resolved.length).toBe(DEFAULT_BINDINGS.length)
  })

  test("includes essential bindings", () => {
    const ids = DEFAULT_BINDINGS.map(b => b.commandId)
    expect(ids).toContain("palette.open")
    expect(ids).toContain("session.new")
    expect(ids).toContain("pane.close")
  })

  /*
   * The list must not grow keys for commands the surface does not run. The
   * listener calls preventDefault on whatever resolves here, so an aspirational
   * binding is not inert — it takes the key from whoever would have used it.
   */
  test("binds nothing the surface cannot execute", () => {
    const ids = DEFAULT_BINDINGS.map(b => b.commandId)
    expect(ids).not.toContain("prompt.send")
    expect(ids).not.toContain("files.search")
    // Pane focus belongs to the grid, which measures its own columns.
    expect(ids.filter(id => id.startsWith("focus."))).toEqual([])
  })
})
