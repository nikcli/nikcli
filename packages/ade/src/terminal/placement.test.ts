import { describe, expect, it } from "bun:test"
import { placementFor } from "./registry"

/*
 * The rule that decides whether a terminal is opened, moved, or left alone.
 *
 * It exists as its own function because getting it wrong is invisible: xterm's
 * `open()` succeeds silently on a terminal that is already drawn, so a pane
 * that should have been handed the emulator simply stays empty and nothing
 * anywhere reports a fault.
 */
describe("placementFor", () => {
  it("opens a terminal that has never been drawn", () => {
    expect(placementFor(undefined, {})).toBe("open")
    expect(placementFor(null, {})).toBe("open")
  })

  it("moves a terminal drawn inside some other pane", () => {
    const oldPane = {}
    const newPane = {}
    expect(placementFor({ parentElement: oldPane }, newPane)).toBe("move")
  })

  // The pane was rebuilt around the same element, or attach ran twice.
  it("leaves a terminal already in the right pane alone", () => {
    const pane = {}
    expect(placementFor({ parentElement: pane }, pane)).toBe("keep")
  })

  // What the grid actually does when a session starts: every pane is rebuilt,
  // so each terminal is opened once and moved on every rebuild after that.
  it("opens once and moves on each rebuild", () => {
    const panes = [{}, {}, {}]
    let drawn: { parentElement: unknown } | undefined
    const steps = panes.map((pane) => {
      const step = placementFor(drawn, pane)
      drawn = { parentElement: pane }
      return step
    })
    expect(steps).toEqual(["open", "move", "move"])
  })
})
