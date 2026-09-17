import { describe, expect, test } from "bun:test"
import { GRID_GAP, MIN_PANE_WIDTH, gridColumns, gridRows, paneSlot } from "./layout"

/** A container with room for exactly `n` columns at the minimum width. */
const widthFor = (n: number) => MIN_PANE_WIDTH * n + GRID_GAP * (n - 1)

const LAPTOP = { width: 1440, height: 780 }
const DESKTOP = { width: 1800, height: 900 }
const WIDE = { width: 2560, height: 1200 }

const columnsOn = (box: { width: number; height: number }, count: number) => gridColumns({ count, ...box })

const paneWidth = (width: number, columns: number) => (width - GRID_GAP * (columns - 1)) / columns

describe("gridColumns", () => {
  describe("guards", () => {
    test("never returns zero, whatever it is handed", () => {
      expect(gridColumns({ count: 0, width: 4000, height: 900 })).toBe(1)
      expect(gridColumns({ count: 3, width: 0, height: 0 })).toBe(1)
      expect(gridColumns({ count: 3, width: -1, height: -1 })).toBe(1)
    })

    test("one pane occupies one column however wide the window is", () => {
      expect(columnsOn(WIDE, 1)).toBe(1)
    })
  })

  describe("readability", () => {
    test("never makes a pane narrower than a wrapped shell command", () => {
      for (let count = 1; count <= 16; count++) {
        for (const box of [LAPTOP, DESKTOP, WIDE, { width: 900, height: 800 }]) {
          const columns = columnsOn(box, count)
          if (columns === 1) continue
          expect(paneWidth(box.width, columns)).toBeGreaterThanOrEqual(MIN_PANE_WIDTH)
        }
      }
    })

    test("falls back to one column rather than refusing when nothing fits", () => {
      // Narrower than a single pane's minimum. One unreadable pane still beats
      // two, and beats rendering nothing at all.
      expect(gridColumns({ count: 4, width: MIN_PANE_WIDTH - 100, height: 800 })).toBe(1)
    })

    test("a narrowing window never widens the grid", () => {
      let previous = Number.POSITIVE_INFINITY
      for (let width = widthFor(6); width >= 200; width -= 25) {
        const columns = gridColumns({ count: 8, width, height: 900 })
        expect(columns).toBeLessThanOrEqual(previous)
        previous = columns
      }
    })
  })

  describe("shape", () => {
    test("two panes sit side by side rather than stacked", () => {
      // The linear-scored version of this preferred one full-width column on a
      // wide container, because "too wide" is unbounded while "too narrow"
      // saturates at zero. Scoring the ratio in log space is what fixes it.
      expect(columnsOn(WIDE, 2)).toBe(2)
      expect(columnsOn(DESKTOP, 2)).toBe(2)
    })

    test("does not lay everything out in a single row", () => {
      // "Fewest rows" as an objective degenerates to exactly this: one row of
      // tall slivers, each at the minimum width.
      expect(gridRows(9, columnsOn(WIDE, 9))).toBeGreaterThan(1)
      expect(gridRows(6, columnsOn(WIDE, 6))).toBeGreaterThan(1)
    })

    test("does not collapse to a single full-width column", () => {
      // "Largest pane area" degenerates the other way, for the same reason.
      for (let count = 2; count <= 9; count++) {
        expect(columnsOn(DESKTOP, count)).toBeGreaterThan(1)
      }
    })

    test("nine panes make a square", () => {
      expect(columnsOn(DESKTOP, 9)).toBe(3)
      expect(gridRows(9, 3)).toBe(3)
    })
  })

  describe("holes", () => {
    test("four panes make a square, not a row of three with an orphan", () => {
      // Three columns puts a pane closer to the target shape than two does, so
      // on shape alone three wins and leaves a hole. This is the assertion the
      // waste term exists for: drop it and every one of these becomes 3.
      expect(columnsOn(LAPTOP, 4)).toBe(2)
      expect(columnsOn(DESKTOP, 4)).toBe(2)
      expect(columnsOn(WIDE, 4)).toBe(2)
    })

    test("prefers a full grid when one is available at a similar shape", () => {
      // Six over three columns is exactly full; six over four leaves two holes.
      expect(columnsOn(DESKTOP, 6)).toBe(3)
      expect(gridRows(6, 3) * 3 - 6).toBe(0)
    })

    test("still accepts a hole when the alternative is badly off-shape", () => {
      // Five cannot tile without a hole below four columns, and the term is a
      // penalty rather than a veto.
      expect(columnsOn(DESKTOP, 5)).toBe(3)
      expect(gridRows(5, 3) * 3 - 5).toBe(1)
    })
  })

  describe("container height", () => {
    test("a shorter container spreads panes wider rather than deeper", () => {
      // Height is half of what the pane shape is scored on, so it has to move
      // the answer. A short, wide container wants more columns; a tall one can
      // afford fewer and larger.
      const short = gridColumns({ count: 12, width: 2560, height: 400 })
      const tall = gridColumns({ count: 12, width: 2560, height: 1600 })
      expect(short).toBeGreaterThan(tall)
      expect(gridRows(12, short)).toBeLessThan(gridRows(12, tall))
    })

    test("keeps panes readable rather than adding columns to avoid a scrollbar", () => {
      const columns = gridColumns({ count: 12, width: 1440, height: 300 })
      expect(paneWidth(1440, columns)).toBeGreaterThanOrEqual(MIN_PANE_WIDTH)
    })
  })

  describe("how the two terms are scaled", () => {
    test("the hole penalty is proportional to the grid, not a count of cells", () => {
      // Three panes over two columns leaves one hole. Scored as an absolute
      // cell count that is a full penalty unit, which is enough to push this
      // container down to a single column and stack all three. Scored as a
      // fraction of the grid it is a third of one, and the split survives.
      expect(gridColumns({ count: 3, width: 780, height: 640 })).toBe(2)
    })

    test("the gutter counts against the height as well as the width", () => {
      // Two panes stacked in 500px are not 250px each — the gutter between them
      // comes out of the same budget. Dropping it from the height makes a
      // stacked layout look better shaped than it is, and this container flips
      // to one column.
      expect(gridColumns({ count: 2, width: 800, height: 500 })).toBe(2)
    })
  })

  describe("a pinned column count", () => {
    test("is honoured when the panes still fit", () => {
      expect(gridColumns({ count: 6, ...DESKTOP, pinned: 2 })).toBe(2)
      expect(gridColumns({ count: 6, ...DESKTOP, pinned: 4 })).toBe(4)
    })

    test("is clamped rather than obeyed into unreadability", () => {
      expect(gridColumns({ count: 6, width: widthFor(2), height: 900, pinned: 6 })).toBe(2)
    })

    test("never goes below one", () => {
      expect(gridColumns({ count: 4, ...DESKTOP, pinned: 0 })).toBe(1)
      expect(gridColumns({ count: 4, ...DESKTOP, pinned: -3 })).toBe(1)
    })

    test("overrides the automatic choice, in both directions", () => {
      const automatic = columnsOn(DESKTOP, 6)
      expect(gridColumns({ count: 6, ...DESKTOP, pinned: automatic - 1 })).not.toBe(automatic)
      expect(gridColumns({ count: 6, ...DESKTOP, pinned: automatic + 1 })).not.toBe(automatic)
    })
  })
})

describe("paneSlot", () => {
  test("fills in reading order", () => {
    expect(paneSlot(0, 3)).toEqual({ row: 0, column: 0 })
    expect(paneSlot(2, 3)).toEqual({ row: 0, column: 2 })
    expect(paneSlot(3, 3)).toEqual({ row: 1, column: 0 })
    expect(paneSlot(7, 3)).toEqual({ row: 2, column: 1 })
  })

  test("survives a zero column count rather than dividing by it", () => {
    expect(paneSlot(3, 0)).toEqual({ row: 3, column: 0 })
  })

  test("leaves a short last row short instead of stretching it", () => {
    // Five over three columns: the last row holds two, in columns 0 and 1, and
    // column 2 stays empty. A pane's width must not depend on how many other
    // sessions happen to be open.
    expect(paneSlot(3, 3)).toEqual({ row: 1, column: 0 })
    expect(paneSlot(4, 3)).toEqual({ row: 1, column: 1 })
  })
})

describe("gridRows", () => {
  test("counts the partial last row", () => {
    expect(gridRows(5, 3)).toBe(2)
    expect(gridRows(6, 3)).toBe(2)
    expect(gridRows(7, 3)).toBe(3)
  })

  test("an empty grid has no rows", () => {
    expect(gridRows(0, 3)).toBe(0)
  })
})
