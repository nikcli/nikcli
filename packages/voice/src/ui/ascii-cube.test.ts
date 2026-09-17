import { describe, expect, test } from "bun:test"
import { ASCII_COLS, ASCII_ROWS, edgeChar, renderAsciiCube } from "./ascii-cube"

const frame = (angle: number) => renderAsciiCube({ cols: ASCII_COLS, rows: ASCII_ROWS, angle })

const lines = (angle: number) => frame(angle).split("\n")

/** Every angle of one full turn, a degree apart. */
const WHOLE_TURN = Array.from({ length: 360 }, (_, degree) => (degree * Math.PI) / 180)

describe("edgeChar", () => {
  test("picks the glyph from the direction the edge runs", () => {
    expect(edgeChar(10, 0)).toBe("-")
    expect(edgeChar(-10, 1)).toBe("-")
    expect(edgeChar(0, 10)).toBe("|")
    expect(edgeChar(1, -10)).toBe("|")
    // Screen y grows downward, so right-and-down is a backslash.
    expect(edgeChar(6, 6)).toBe("\\")
    expect(edgeChar(6, -6)).toBe("/")
  })
})

describe("renderAsciiCube", () => {
  test("fills the grid it was asked for, exactly", () => {
    const rows = lines(0.7)
    expect(rows).toHaveLength(ASCII_ROWS)
    for (const row of rows) expect(row).toHaveLength(ASCII_COLS)
  })

  /*
   * The framing guarantee. Projection centres the cube's centre, which under
   * perspective is not the middle of what you see: the near face is magnified
   * and the silhouette rides off towards it. On a seven-row grid that shows up
   * as the mark sitting against one edge with a blank row at the other, and it
   * changes through the turn — a logo that wanders inside its own box.
   */
  test("stays inside its box at every angle of the turn", () => {
    for (const angle of WHOLE_TURN) {
      for (const row of lines(angle)) {
        expect(row).toHaveLength(ASCII_COLS)
      }
    }
  })

  test("never leaves the grid empty", () => {
    for (const angle of WHOLE_TURN) {
      expect(frame(angle).trim().length).toBeGreaterThan(8)
    }
  })

  /*
   * At least one face is always turned towards the viewer, so the mark always
   * carries its letter. A frame with no N is a frame where the logo is an
   * anonymous box.
   */
  test("always shows the letter", () => {
    for (const angle of WHOLE_TURN) {
      expect(frame(angle)).toContain("N")
    }
  })

  test("shows at most the two faces that can be seen at once", () => {
    for (const angle of WHOLE_TURN) {
      const count = frame(angle).split("N").length - 1
      expect(count).toBeGreaterThanOrEqual(1)
      expect(count).toBeLessThanOrEqual(2)
    }
  })

  /*
   * Hidden-line removal, checked by its consequence.
   *
   * Drawn as a full wireframe, the back face's two uprights land beside the
   * front face's and the middle of the mark reads `|||` — noise that made the
   * cube a lattice rather than a solid.
   *
   * Only away from edge-on. Within about twenty degrees of square-on a side
   * face is genuinely two or three columns wide, so its own two uprights sit
   * next to the outline and `|||` is the correct drawing of a real sliver, not
   * a far edge leaking through. The bug this guards showed at exactly the
   * angles tested here, where there is a whole face between the two.
   */
  test("draws a solid, not a lattice", () => {
    for (const degree of [0, 30, 45, 60, 120, 135, 150, 210, 225, 240, 300, 315, 330]) {
      expect(frame((degree * Math.PI) / 180)).not.toContain("|||")
    }
  })

  test("takes the letter it is given", () => {
    const drawn = renderAsciiCube({ cols: ASCII_COLS, rows: ASCII_ROWS, angle: 0.8, letter: "K" })
    expect(drawn).toContain("K")
    expect(drawn).not.toContain("N")
  })

  /* The animation loops on this, so the turn has to actually close. */
  test("comes back to where it started after a full turn", () => {
    expect(frame(0.4 + Math.PI * 2)).toBe(frame(0.4))
  })

  /*
   * A cube with the same letter on all four sides is its own symmetry every
   * quarter turn — the drawing at 100° is the drawing at 10°, and there is
   * nothing to fix about that. It is worth pinning: it means the *visible*
   * period is a quarter of `seconds`, so anyone reading the component's
   * fourteen-second default and expecting fourteen seconds of distinct frames
   * finds the reason here rather than in a stopwatch.
   */
  test("a quarter turn is the same drawing, because a cube is", () => {
    expect(frame(0.4 + Math.PI / 2)).toBe(frame(0.4))
    expect(frame(0.4 + Math.PI / 4)).not.toBe(frame(0.4))
  })
})
