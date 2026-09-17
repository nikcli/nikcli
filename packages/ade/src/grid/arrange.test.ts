import { describe, expect, test } from "bun:test"
import { CURRENT_VERSION, parseWorkspace, serializeWorkspace } from "../session/persist"
import {
  type Pane,
  type Workbench,
  createWorkbench,
  fromWorkspaceState,
  reorderPanes,
  resizePane,
  toWorkspaceState,
} from "../surface/state"
import {
  type ArrangeTile,
  type Span,
  applyOrder,
  cellsWanted,
  DEFAULT_SPAN,
  dropZone,
  effectiveSpan,
  moveTile,
  neighbour,
  packTiles,
  spanInGrid,
  swapTiles,
} from "./arrange"
import { gridColumns } from "./layout"

const one = { columns: 1, rows: 1 }
const tiles = (...ids: string[]): ArrangeTile[] => ids.map((id) => ({ id, span: one }))

/** Where each id lands, as "row,column", for readable assertions. */
function where(list: ArrangeTile[], order: string[], columns: number) {
  const spanOf = new Map(list.map((t) => [t.id, t.span]))
  const { placements } = packTiles(
    order.map((id) => spanOf.get(id)!),
    columns,
  )
  return Object.fromEntries(order.map((id, i) => [id, placements[i]!]))
}

describe("moveTile: each drop zone", () => {
  // A B
  // C D
  const grid = tiles("A", "B", "C", "D")

  test("before puts the pane immediately ahead of the target", () => {
    expect(moveTile(grid, "D", "B", "before", 2)).toEqual(["A", "D", "B", "C"])
  })

  test("after puts the pane immediately behind the target", () => {
    expect(moveTile(grid, "A", "C", "after", 2)).toEqual(["B", "C", "A", "D"])
  })

  test("above lands directly over the target, same column", () => {
    const order = moveTile(grid, "D", "C", "above", 2)
    const at = where(grid, order, 2)
    expect(at.D!.row + 1).toBe(at.C!.row)
    expect(at.D!.column).toBe(at.C!.column)
  })

  test("below lands directly under the target, same column", () => {
    const order = moveTile(grid, "A", "B", "below", 2)
    const at = where(grid, order, 2)
    expect(at.A!.row).toBe(at.B!.row + 1)
    expect(at.A!.column).toBe(at.B!.column)
  })

  test("above a tile in the top row pushes that tile down a row", () => {
    const order = moveTile(grid, "D", "B", "above", 2)
    const at = where(grid, order, 2)
    expect(at.D!.row + 1).toBe(at.B!.row)
    expect(at.D!.column).toBe(at.B!.column)
  })

  test("in one column, or over a full-width tile, above means just before it", () => {
    expect(moveTile(tiles("A", "B"), "B", "A", "above", 1)).toEqual(["B", "A"])
    const wide: ArrangeTile[] = [{ id: "W", span: { columns: 3, rows: 1 } }, ...tiles("X")]
    expect(moveTile(wide, "X", "W", "above", 3)).toEqual(["X", "W"])
  })

  test("above and below account for a wide pane in the way", () => {
    // M M
    // A B
    // C
    const list: ArrangeTile[] = [{ id: "M", span: { columns: 2, rows: 1 } }, ...tiles("A", "B", "C")]
    const order = moveTile(list, "C", "B", "above", 2)
    const at = where(list, order, 2)
    expect(at.C!.row + 1).toBe(at.B!.row)
    expect(at.C!.column).toBe(at.B!.column)
  })

  test("swap exchanges the two panes and leaves the rest alone", () => {
    expect(moveTile(grid, "A", "D", "swap", 2)).toEqual(["D", "B", "C", "A"])
  })

  test("dropping on itself or on a stranger changes nothing", () => {
    expect(moveTile(grid, "A", "A", "after", 2)).toEqual(["A", "B", "C", "D"])
    expect(moveTile(grid, "A", "Z", "after", 2)).toEqual(["A", "B", "C", "D"])
  })
})

describe("dropZone", () => {
  test("the middle swaps, each edge points its way", () => {
    expect(dropZone(50, 50, 100, 100)).toBe("swap")
    expect(dropZone(5, 50, 100, 100)).toBe("before")
    expect(dropZone(95, 50, 100, 100)).toBe("after")
    expect(dropZone(50, 5, 100, 100)).toBe("above")
    expect(dropZone(50, 95, 100, 100)).toBe("below")
  })
})

describe("keyboard moves", () => {
  test("neighbour follows the geometry, not the index, around a wide pane", () => {
    // M M
    // A B
    const { placements } = packTiles([{ columns: 2, rows: 1 }, one, one], 2)
    expect(neighbour(placements, 0, "down")).toBe(1)
    expect(neighbour(placements, 2, "up")).toBe(0)
    expect(neighbour(placements, 1, "right")).toBe(2)
    expect(neighbour(placements, 1, "left")).toBe(-1)
  })

  test("sideways stays in its row", () => {
    const { placements } = packTiles([one, one, one, one], 2)
    expect(neighbour(placements, 1, "right")).toBe(-1)
  })

  test("swapTiles exchanges two ids", () => {
    expect(swapTiles(["A", "B", "C"], "A", "C")).toEqual(["C", "B", "A"])
  })
})

describe("packTiles", () => {
  test("keeps reading order and leaves a hole rather than back-filling it", () => {
    // A B _   a two-wide pane does not fit after B, so the row stays short
    // M M C
    const { placements, rows } = packTiles([one, one, { columns: 2, rows: 1 }, one], 3)
    expect(placements[2]).toEqual({ row: 1, column: 0, columns: 2, rows: 1 })
    expect(placements[3]).toEqual({ row: 1, column: 2, columns: 1, rows: 1 })
    expect(rows).toBe(2)
  })

  test("a tall pane reserves its cells in the rows below", () => {
    const { placements } = packTiles([{ columns: 1, rows: 2 }, one, one], 2)
    expect(placements[2]).toEqual({ row: 1, column: 1, columns: 1, rows: 1 })
  })
})

describe("sizes", () => {
  test("every session starts as one cell, whatever it is called", () => {
    const list: Array<{ title: string; span?: Span }> = [{ title: "Master" }, { title: "A" }, { title: "B" }, { title: "C" }]
    const columns = gridColumns({ count: cellsWanted(list), width: 1800, height: 900 })
    expect(cellsWanted(list)).toBe(4)
    expect(list.every((tile) => effectiveSpan(tile, columns).columns === 1 && effectiveSpan(tile, columns).rows === 1)).toBe(true)
    expect(DEFAULT_SPAN).toEqual(one)
  })

  test("a resized pane counts the cells it covers when choosing columns", () => {
    expect(cellsWanted([{ span: { columns: 2, rows: 2 } }, {}, {}])).toBe(6)
  })

  test("the user's size wins", () => {
    expect(effectiveSpan({ span: { columns: 3, rows: 2 } }, 3)).toEqual({ columns: 3, rows: 2 })
  })

  test("a chosen size is clamped to the grid, not rewritten", () => {
    expect(effectiveSpan({ span: { columns: 3, rows: 9 } }, 2)).toEqual({ columns: 2, rows: 3 })
  })
})

describe("applyOrder", () => {
  test("another project's panes keep their slots", () => {
    const all = [{ id: "a1" }, { id: "x1" }, { id: "a2" }, { id: "x2" }, { id: "a3" }]
    expect(applyOrder(all, ["a3", "a1", "a2"]).map((p) => p.id)).toEqual(["a3", "x1", "a1", "x2", "a2"])
  })
})

describe("the arrangement survives a restart", () => {
  const pane = (id: string, title: string, workspaceId = "proj"): Pane => ({
    id,
    title,
    status: "done",
    model: "claude",
    mode: "auto",
    agent: "claude-code",
    lines: [],
    cwd: "C:/proj",
    workspaceId,
  })

  const reload = (wb: Workbench) =>
    fromWorkspaceState(parseWorkspace(serializeWorkspace(toWorkspaceState(wb)))!, "proj")

  test("order and chosen sizes come back after save and load", () => {
    let wb: Workbench = {
      ...createWorkbench(),
      panes: [pane("m", "Master"), pane("a", "A"), pane("b", "B"), pane("c", "C")],
    }
    wb = reorderPanes(wb, ["b", "m", "c", "a"])
    wb = resizePane(wb, "m", { columns: 1, rows: 1 })
    wb = resizePane(wb, "c", { columns: 2, rows: 2 })

    const back = reload(wb)
    expect(back.panes.map((p) => p.id)).toEqual(["b", "m", "c", "a"])
    expect(back.panes.find((p) => p.id === "m")!.span).toEqual({ columns: 1, rows: 1 })
    expect(back.panes.find((p) => p.id === "c")!.span).toEqual({ columns: 2, rows: 2 })
    expect(back.panes.find((p) => p.id === "a")!.span).toBeUndefined()
  })

  test("resetting a size removes it, so the default applies again", () => {
    let wb: Workbench = { ...createWorkbench(), panes: [pane("m", "Master")] }
    wb = resizePane(wb, "m", { columns: 1, rows: 1 })
    wb = resizePane(wb, "m", undefined)
    expect(reload(wb).panes[0]!.span).toBeUndefined()
  })

  test("sizes do not bump the store version, so an earlier build still reads it", () => {
    // 0.5.0 refuses a version newer than 4 and then autosaves an empty
    // workbench over the store: a bump here would cost every open session.
    let wb: Workbench = { ...createWorkbench(), panes: [pane("a", "A"), pane("b", "B")] }
    wb = resizePane(wb, "b", { columns: 2, rows: 1 })
    const saved = JSON.parse(serializeWorkspace(toWorkspaceState(wb)))
    expect(CURRENT_VERSION).toBe(4)
    expect(saved.version).toBe(4)
    expect(saved.panes[1].span).toEqual({ columns: 2, rows: 1 })
  })

  test("a store saved before sizes existed: same order, one cell each", () => {
    const v4 = JSON.stringify({
      version: 4,
      panes: [
        { id: "a", title: "A", agent: "claude-code", cwd: "", branch: "", status: "done" },
        { id: "m", title: "Master", agent: "claude-code", cwd: "", branch: "", status: "done" },
      ],
      currentView: "code",
      sidebarWidth: 260,
    })
    const state = parseWorkspace(v4)!
    expect(state.version).toBe(CURRENT_VERSION)
    expect(state.panes.map((p) => p.id)).toEqual(["a", "m"])
    expect(state.panes.every((p) => p.span === undefined)).toBe(true)
    const master = fromWorkspaceState(state, "proj").panes[1]!
    expect(effectiveSpan(master, 3)).toEqual(one)
  })

  test("a damaged size is dropped rather than repaired", () => {
    const damaged = JSON.stringify({
      version: CURRENT_VERSION,
      panes: [
        { id: "a", title: "A", agent: "", cwd: "", branch: "", status: "done", span: { columns: "wide" } },
        { id: "b", title: "B", agent: "", cwd: "", branch: "", status: "done", span: { columns: 40, rows: 0.2 } },
      ],
    })
    const state = parseWorkspace(damaged)!
    expect(state.panes[0]!.span).toBeUndefined()
    expect(state.panes[1]!.span).toEqual({ columns: 12, rows: 1 })
  })
})

describe("a pane alone in the grid", () => {
  const tall = { span: { columns: 1, rows: 3 } }
  const box = { width: 1800, height: 900 }

  test("fills the row instead of keeping its resized shape", () => {
    const tiles = [spanInGrid(tall, 1)]
    const columns = gridColumns({ count: cellsWanted(tiles), ...box })
    expect(columns).toBe(1)
    const { placements, rows } = packTiles(tiles.map((tile) => effectiveSpan(tile, columns)), columns)
    expect(placements[0]).toEqual({ row: 0, column: 0, columns: 1, rows: 1 })
    expect(rows).toBe(1)
  })

  test("gets its size back once there is a second pane", () => {
    const tiles = [spanInGrid(tall, 2), spanInGrid({}, 2)]
    expect(tiles[0]).toEqual(tall)
    const columns = gridColumns({ count: cellsWanted(tiles), ...box })
    expect(effectiveSpan(tiles[0]!, columns).rows).toBe(3)
  })
})
