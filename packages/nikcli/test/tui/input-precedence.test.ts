import { describe, expect, it } from "bun:test"
import { INPUT_LAYERS, ownerOf, owns, superseded } from "@tui/util/input-precedence"
import { tuiSource } from "./tui-source"

/**
 * The input precedence EOT-07 requirement 2 names, pinned as an order.
 *
 * The rule this enforces is requirement 3's: an input event cannot both close a
 * dialog and cancel a session. That happens when two layers each believe they
 * are entitled to the same event, which is exactly what an implicit precedence
 * expressed as scattered conditions produces.
 */
describe("input precedence", () => {
  it("orders modal over editable over route over application", () => {
    expect([...INPUT_LAYERS]).toEqual(["modal", "editable", "route", "application"])
  })

  it("gives an open modal the event even while a prompt has focus", () => {
    // The case behind requirement 3: Escape while typing in a dialog closes the
    // dialog. It must not also reach the prompt underneath.
    expect(ownerOf({ modal: true, editable: true, application: true })).toBe("modal")
    expect(owns("editable", { modal: true, editable: true })).toBe(false)
  })

  it("gives a focused editable surface the event over a route handler", () => {
    expect(ownerOf({ editable: true, route: true, application: true })).toBe("editable")
  })

  it("falls through to the application when nothing else is active", () => {
    expect(ownerOf({ application: true })).toBe("application")
  })

  it("drops the event when even the fallback is withheld", () => {
    // A caller may deliberately withhold the fallback — during startup, say —
    // and that is the one case where dropping an event is correct.
    expect(ownerOf({})).toBeUndefined()
    expect(superseded({})).toEqual([])
  })

  it("names the layers that lost, for when two handlers both fire", () => {
    expect(superseded({ modal: true, editable: true, application: true })).toEqual(["editable", "application"])
  })
})

/**
 * The mismatch that keeps this table unwired, in executable form.
 *
 * `input-precedence.ts` had zero production call sites, and wiring it found a
 * reason rather than an oversight: the one site that genuinely arbitrates —
 * `ui/dialog.tsx`'s Ctrl+C branch — resolves the same two layers the opposite
 * way round, and is right to.
 *
 * These cases exist so nobody closes the gap by making the dialog follow the
 * table. That would send Ctrl+C to the modal while the user is typing, which
 * is the behaviour the big comment in `ui/dialog.tsx` records having already
 * been fixed once.
 */
describe("the flat order cannot serve both keys", () => {
  it("puts the modal above the editable, which is right for escape", async () => {
    // Escape must close the dialog even while a text field has focus.
    expect(ownerOf({ modal: true, editable: true })).toBe("modal")
  })

  it("is contradicted by the shipped Ctrl+C arbitration, on purpose", async () => {
    // The dialog gives the key to the focused editor when both are active.
    // Asserted against the source, because mounting a dialog drags in the
    // whole TUI — the trade `dialog-lifecycle.test.ts` documents.
    const src = await tuiSource("ui/dialog.tsx")
    expect(src).toMatch(/renderer\.currentFocusedEditor !== null/)
    expect(src).toMatch(/if \(!isInteractive\)/)

    // So for Ctrl+C the owner the table names is the layer that must *not*
    // take the event. Both statements are true; that is the finding.
    expect(ownerOf({ modal: true, editable: true })).not.toBe("editable")
  })

  it("still names one owner for every unambiguous combination", async () => {
    // The table is not wrong everywhere — only where two layers contend for a
    // key that means different things to each. These are the cases a future
    // key-aware version must keep.
    expect(ownerOf({ editable: true, route: true })).toBe("editable")
    expect(ownerOf({ route: true, application: true })).toBe("route")
    expect(ownerOf({ application: true })).toBe("application")
    expect(ownerOf({})).toBeUndefined()
  })
})
