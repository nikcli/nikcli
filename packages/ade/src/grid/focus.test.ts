import { describe, expect, test } from "bun:test"
import { focusAfterClose, moveFocus } from "./focus"

const PANES = ["a", "b", "c", "d", "e"]

describe("focusAfterClose", () => {
  test("closing a background pane leaves focus exactly where it was", () => {
    // The failure this guards is not cosmetic: a session finishing in the
    // background must not pull the keyboard out of the pane being typed into.
    expect(focusAfterClose({ panes: PANES, focused: "d", closing: "a" })).toBe("d")
    expect(focusAfterClose({ panes: PANES, focused: "d", closing: "e" })).toBe("d")
  })

  test("closing the focused pane moves forward, not back to the start", () => {
    expect(focusAfterClose({ panes: PANES, focused: "b", closing: "b" })).toBe("c")
    expect(focusAfterClose({ panes: PANES, focused: "a", closing: "a" })).toBe("b")
  })

  test("closing the focused last pane falls back to its predecessor", () => {
    expect(focusAfterClose({ panes: PANES, focused: "e", closing: "e" })).toBe("d")
  })

  test("closing the only pane leaves nothing focused", () => {
    expect(focusAfterClose({ panes: ["a"], focused: "a", closing: "a" })).toBeUndefined()
  })

  test("repeatedly closing the focused pane walks the grid instead of bouncing", () => {
    let panes = [...PANES]
    let focused: string | undefined = "b"
    const visited: Array<string | undefined> = []
    while (focused) {
      const next = focusAfterClose({ panes, focused, closing: focused })
      panes = panes.filter((id) => id !== focused)
      focused = next
      visited.push(focused)
    }
    expect(visited).toEqual(["c", "d", "e", "a", undefined])
  })

  test("tracks the pane, not its index", () => {
    // "d" sits at index 3 before the close and index 2 after it. Anything that
    // carries the index through returns "e" here.
    expect(focusAfterClose({ panes: PANES, focused: "d", closing: "a" })).toBe("d")
    expect(focusAfterClose({ panes: PANES, focused: "e", closing: "b" })).toBe("e")
  })

  test("closing a pane that is not in the grid changes nothing", () => {
    expect(focusAfterClose({ panes: PANES, focused: "c", closing: "zz" })).toBe("c")
  })

  test("nothing focused stays nothing focused", () => {
    expect(focusAfterClose({ panes: PANES, focused: undefined, closing: "a" })).toBeUndefined()
  })

  test("a focused id that is already gone does not survive the close", () => {
    expect(focusAfterClose({ panes: PANES, focused: "gone", closing: "a" })).toBeUndefined()
  })
})

/**
 *  0 1 2
 *  3 4 5
 *  6 7      — seven panes over three columns, last row short
 */
const SEVEN = { count: 7, columns: 3 }

describe("moveFocus", () => {
  test("moves within the row", () => {
    expect(moveFocus({ ...SEVEN, index: 0, direction: "right" })).toBe(1)
    expect(moveFocus({ ...SEVEN, index: 1, direction: "left" })).toBe(0)
  })

  test("stops at the row edge rather than wrapping onto the next row", () => {
    // Wrapping makes the position of focus something you look up instead of
    // know, in a layout the user arranged deliberately.
    expect(moveFocus({ ...SEVEN, index: 2, direction: "right" })).toBe(2)
    expect(moveFocus({ ...SEVEN, index: 3, direction: "left" })).toBe(3)
  })

  test("moves between rows in the same column", () => {
    expect(moveFocus({ ...SEVEN, index: 1, direction: "down" })).toBe(4)
    expect(moveFocus({ ...SEVEN, index: 4, direction: "up" })).toBe(1)
  })

  test("stops at the top and bottom edges", () => {
    expect(moveFocus({ ...SEVEN, index: 1, direction: "up" })).toBe(1)
    expect(moveFocus({ ...SEVEN, index: 6, direction: "down" })).toBe(6)
  })

  test("descending into a short last row lands on its final pane", () => {
    // Column 2 of row 1 is index 5; row 2 holds only 6 and 7. Refusing the move
    // would leave the last row reachable only by arrowing along it.
    expect(moveFocus({ ...SEVEN, index: 5, direction: "down" })).toBe(6)
  })

  test("does not invent a row below the last one", () => {
    // Index 7 does not exist; index 6 is in the final row and has nothing under
    // it. The clamp must not fire here.
    expect(moveFocus({ count: 7, columns: 3, index: 6, direction: "down" })).toBe(6)
    expect(moveFocus({ count: 6, columns: 3, index: 5, direction: "down" })).toBe(5)
  })

  test("staying put in the last row does not jump to the final pane", () => {
    //  0 1 2
    //  3 4        — index 3 is in the last row, but it is not the last pane.
    // Clamping unconditionally sends it to 4, which is a sideways move dressed
    // up as a downward one.
    expect(moveFocus({ count: 5, columns: 3, index: 3, direction: "down" })).toBe(3)
    expect(moveFocus({ count: 8, columns: 3, index: 6, direction: "down" })).toBe(6)
  })

  test("an exactly full grid has no row below its last one", () => {
    //  0 1 2
    //  3 4 5      — six over three columns, no short row anywhere.
    // The row-below test has to be strict: six cells is not "a row below row 1",
    // it is the end of the grid. Reading it as one sends every pane in the last
    // row skidding to index 5.
    expect(moveFocus({ count: 6, columns: 3, index: 3, direction: "down" })).toBe(3)
    expect(moveFocus({ count: 6, columns: 3, index: 4, direction: "down" })).toBe(4)
    expect(moveFocus({ count: 4, columns: 2, index: 2, direction: "down" })).toBe(2)
  })

  test("a single column is a list", () => {
    expect(moveFocus({ count: 4, columns: 1, index: 0, direction: "down" })).toBe(1)
    expect(moveFocus({ count: 4, columns: 1, index: 3, direction: "down" })).toBe(3)
    expect(moveFocus({ count: 4, columns: 1, index: 2, direction: "right" })).toBe(2)
    expect(moveFocus({ count: 4, columns: 1, index: 2, direction: "left" })).toBe(2)
  })

  test("every move lands on a pane that exists", () => {
    for (const columns of [1, 2, 3, 4]) {
      for (let count = 1; count <= 12; count++) {
        for (let index = 0; index < count; index++) {
          for (const direction of ["left", "right", "up", "down"] as const) {
            const next = moveFocus({ count, columns, index, direction })
            expect(next).toBeGreaterThanOrEqual(0)
            expect(next).toBeLessThan(count)
          }
        }
      }
    }
  })

  test("survives an out-of-range or empty state instead of throwing", () => {
    expect(moveFocus({ count: 0, columns: 3, index: 0, direction: "down" })).toBe(0)
    expect(moveFocus({ count: 3, columns: 3, index: 9, direction: "left" })).toBe(0)
    expect(moveFocus({ count: 3, columns: 0, index: 1, direction: "right" })).toBe(1)
  })
})
