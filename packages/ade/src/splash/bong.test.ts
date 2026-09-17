import { describe, expect, test } from "bun:test"
import {
  AXIS,
  BASE_TOP,
  BONG_MOUTH,
  FLOOR,
  NECK_TOP,
  PINCH_Y,
  STEM_TIP,
  TONE,
  WATER_LINE,
  bongShade,
  insideStem,
} from "./bong"
import { SCENE_HEIGHT, SCENE_WIDTH } from "./scene"

/**
 * A shape drawn at 192×120 and then dithered is not something anyone can
 * check by looking at it: the grain hides a wall one pixel thick, a downstem
 * that stops an inch above the water, a mouthpiece that is solid instead of
 * open. So the parts are asserted here, by coordinate, and the picture is
 * only ever confirmation.
 */

/** The tones a whole column of the piece passes through, top to bottom. */
function column(x: number): (number | undefined)[] {
  return Array.from({ length: SCENE_HEIGHT }, (_, y) => bongShade(x, y))
}

/** Every y where this column is glass at all. */
function filled(x: number): number[] {
  return column(x).flatMap((shade, y) => (shade === undefined ? [] : [y]))
}

describe("where the bong is", () => {
  test("it stands in the scene, not off the edge of it", () => {
    for (let y = 0; y < SCENE_HEIGHT; y++) {
      for (let x = 0; x < SCENE_WIDTH; x++) {
        if (bongShade(x, y) !== undefined) {
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThan(SCENE_WIDTH)
          expect(y).toBeLessThan(SCENE_HEIGHT)
        }
      }
    }
  })

  test("the ground around it is left alone", () => {
    // The corners, where nothing should ever be.
    expect(bongShade(0, 0)).toBeUndefined()
    expect(bongShade(SCENE_WIDTH - 1, 0)).toBeUndefined()
    expect(bongShade(0, SCENE_HEIGHT - 1)).toBeUndefined()
  })

  test("it is the subject, so it fills a decent part of the frame", () => {
    let painted = 0
    for (let y = 0; y < SCENE_HEIGHT; y++) {
      for (let x = 0; x < SCENE_WIDTH; x++) if (bongShade(x, y) !== undefined) painted++
    }
    // Not a rule of composition, a guard: a geometry change that shrinks the
    // piece to a smudge or swells it past the frame fails here rather than
    // in a screenshot nobody takes.
    expect(painted).toBeGreaterThan(1200)
    expect(painted).toBeLessThan(4200)
  })
})

describe("the beaker", () => {
  test("is wider at the floor than at the shoulder", () => {
    const width = (y: number) =>
      Array.from({ length: SCENE_WIDTH }, (_, x) => bongShade(x, y)).filter((s) => s !== undefined).length
    expect(width(FLOOR - 4)).toBeGreaterThan(width(BASE_TOP + 8))
  })

  test("is hollow: two walls with something between them", () => {
    const row = Array.from({ length: SCENE_WIDTH }, (_, x) => bongShade(x, BASE_TOP + 8))
    const left = row.findIndex((shade) => shade !== undefined)
    const right = row.length - 1 - [...row].reverse().findIndex((shade) => shade !== undefined)
    expect(row[left]).toBe(TONE.edge)
    expect(row[right]).toBe(TONE.edge)
    // The middle is seen-through glass, not a fill.
    expect(row[AXIS]).toBe(TONE.glass)
  })

  test("holds water, below the line and not above it", () => {
    expect(bongShade(AXIS, WATER_LINE + 5)).toBe(TONE.water)
    expect(bongShade(AXIS, WATER_LINE - 5)).toBe(TONE.glass)
  })

  test("stands on a solid foot rather than an open pipe", () => {
    // The bottom rows are glass all the way across: a beaker whose floor is
    // hollow reads as a tube someone cut in half.
    expect(bongShade(AXIS, FLOOR - 1)).toBe(TONE.edge)
    expect(bongShade(AXIS - 10, FLOOR - 1)).toBe(TONE.edge)
  })
})

describe("the neck and the mouthpiece", () => {
  test("the neck runs from the beaker up to the lip without a gap", () => {
    const ys = filled(AXIS)
    expect(ys.length).toBeGreaterThan(60)
    // No break anywhere in the column: a hole in the middle of the neck is
    // the classic off-by-one between two half-width functions.
    const gaps = ys.slice(1).map((y, i) => y - (ys[i] ?? 0))
    expect(gaps.every((gap) => gap === 1)).toBe(true)
  })

  test("the ice pinch narrows the neck and only there", () => {
    const width = (y: number) =>
      Array.from({ length: SCENE_WIDTH }, (_, x) => bongShade(x, y)).filter((s) => s !== undefined).length
    const pinched = width(PINCH_Y)
    expect(pinched).toBeLessThan(width(PINCH_Y - 6))
    expect(pinched).toBeLessThan(width(PINCH_Y + 10))
  })

  test("the mouthpiece flares, and is open", () => {
    const lip = Array.from({ length: SCENE_WIDTH }, (_, x) => bongShade(x, BONG_MOUTH.y - 1))
    const solid = lip.filter((shade) => shade !== undefined).length
    expect(solid).toBeGreaterThan(0)
    // An opening in the middle: you can see down the tube.
    expect(bongShade(AXIS, BONG_MOUTH.y - 3)).toBeUndefined()
  })

  test("the smoke leaves from the middle of the opening", () => {
    expect(BONG_MOUTH.x).toBe(AXIS)
    expect(BONG_MOUTH.y).toBe(NECK_TOP)
    // And from the top of the piece, not out of its side.
    const highest = filled(AXIS)[0]
    expect(Math.abs(BONG_MOUTH.y - (highest ?? 0))).toBeLessThanOrEqual(2)
  })

  test("there is sky above the mouthpiece for the smoke to rise into", () => {
    /*
     * The composition, as a check rather than as a hope. With the piece
     * drawn tall enough to reach the top of the frame the first puff was
     * already against the ceiling and the smoke came out sideways, reading
     * as a banner across the picture. A third of the height, kept clear.
     */
    expect(BONG_MOUTH.y).toBeGreaterThan(SCENE_HEIGHT / 3)
    for (let y = 0; y < BONG_MOUTH.y - 8; y++) {
      for (let x = 0; x < SCENE_WIDTH; x++) expect(bongShade(x, y)).toBeUndefined()
    }
  })
})

describe("the downstem and the bowl", () => {
  test("the downstem reaches under the water", () => {
    // The whole point of the piece. A stem that stops above the line is a
    // bong that does not work, and at this size it looks fine.
    expect(STEM_TIP.y).toBeGreaterThan(WATER_LINE)
    expect(insideStem(STEM_TIP.x, STEM_TIP.y - 1)).toBe(true)
  })

  test("it is continuous from the joint to its tip", () => {
    let found = 0
    for (let y = 0; y < SCENE_HEIGHT; y++) {
      for (let x = 0; x < SCENE_WIDTH; x++) if (insideStem(x, y)) found++
    }
    expect(found).toBeGreaterThan(50)
  })

  test("the bowl sits outside the glass, where a bowl goes", () => {
    // Somewhere to the right of the neck and above the waterline.
    const bowl: { x: number; y: number }[] = []
    for (let y = 0; y < SCENE_HEIGHT; y++) {
      for (let x = AXIS + 15; x < SCENE_WIDTH; x++) if (bongShade(x, y) !== undefined) bowl.push({ x, y })
    }
    expect(bowl.length).toBeGreaterThan(20)
    expect(Math.min(...bowl.map((p) => p.y))).toBeLessThan(WATER_LINE)
  })
})

describe("the tones", () => {
  test("are four, and in the order light falls on glass", () => {
    expect(TONE.glass).toBeLessThan(TONE.water)
    expect(TONE.water).toBeLessThan(TONE.highlight)
    expect(TONE.highlight).toBeLessThan(TONE.edge)
    expect(new Set(Object.values(TONE)).size).toBe(4)
  })

  test("every tone the shape returns is one of them", () => {
    const used = new Set<number>()
    for (let y = 0; y < SCENE_HEIGHT; y++) {
      for (let x = 0; x < SCENE_WIDTH; x++) {
        const shade = bongShade(x, y)
        if (shade !== undefined) used.add(shade)
      }
    }
    const known = new Set<number>(Object.values(TONE))
    for (const shade of used) expect(known.has(shade)).toBe(true)
    // And all four are actually on screen — a tone nobody uses is a tone
    // that was meant to do something.
    expect(used.size).toBe(4)
  })

  test("the highlight is on one side only, so the glass reads as round", () => {
    let left = 0
    let right = 0
    for (let y = 0; y < SCENE_HEIGHT; y++) {
      for (let x = 0; x < SCENE_WIDTH; x++) {
        if (bongShade(x, y) !== TONE.highlight) continue
        if (x < AXIS) left++
        else if (x > AXIS) right++
      }
    }
    expect(left).toBeGreaterThan(0)
    expect(right).toBeLessThan(left)
  })
})
