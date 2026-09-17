/**
 * A cube, drawn with characters.
 *
 * Eight corners, twelve edges and four printed faces, projected through a
 * pinhole camera and stamped into a fixed character grid — the terminal's own
 * way of drawing a solid, and the right one for a mark that belongs to a
 * command-line tool.
 *
 * Pure, and in a `.ts` rather than in the component, for the usual reason in
 * this repo: a `.tsx` cannot be imported under `bun test` here, and the whole
 * of the drawing's judgement — which faces are turned towards us, which
 * character an edge takes from its slope, what happens when two edges cross —
 * is decidable from four numbers and worth checking.
 *
 * The grid is small on purpose. This ends up 30px wide in a title bar, where
 * every row costs four pixels; at eleven by seven the silhouette still reads
 * and the letter still lands on a face, and a finer grid would only buy detail
 * nobody can resolve.
 */

/**
 * The grid the mark is drawn on.
 *
 * Eleven by seven, and the ratio is not arbitrary: a monospace cell is about
 * six units wide to ten tall, so 11/7 ≈ 1.57 is very near the 1.67 that makes
 * a square of cells come out square on screen. Change one and change the
 * other, or the cube becomes a crate stood on end.
 */
export const ASCII_COLS = 11
export const ASCII_ROWS = 7

export interface AsciiCubeOptions {
  /** Grid width in characters. */
  cols: number
  /** Grid height in characters. */
  rows: number
  /** Rotation about the vertical axis, in radians. This is the turn. */
  angle: number
  /**
   * Fixed tilt towards the viewer, in radians.
   *
   * Shallow and constant, so a sliver of the lid stays in view and the cube
   * never flattens into a square when a face comes head-on.
   */
  tilt?: number
  /** What goes in the middle of each face that is turned towards us. */
  letter?: string
}

/** The eight corners of the unit cube, in the order the tables below expect. */
const CORNERS: readonly (readonly [number, number, number])[] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
]

const EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
]

/**
 * All six faces, and whether each one is printed.
 *
 * All six, because hidden-line removal needs to know about the lid and the
 * base: an edge is drawn only when a face it belongs to is turned towards us,
 * and two of every corner's three edges belong to one of those.
 *
 * Only four printed. A letter on the lid arrives upside down as the cube
 * turns, and a reversed N reads as a rendering fault rather than as the far
 * side of a solid — the same decision the CSS cube makes, for the same reason.
 */
const FACES: readonly {
  corners: readonly number[]
  normal: readonly [number, number, number]
  printed: boolean
}[] = [
  { corners: [4, 5, 6, 7], normal: [0, 0, 1], printed: true },
  { corners: [0, 1, 2, 3], normal: [0, 0, -1], printed: true },
  { corners: [1, 2, 6, 5], normal: [1, 0, 0], printed: true },
  { corners: [0, 3, 7, 4], normal: [-1, 0, 0], printed: true },
  { corners: [3, 2, 6, 7], normal: [0, 1, 0], printed: false },
  { corners: [0, 1, 5, 4], normal: [0, -1, 0], printed: false },
]

/**
 * The two faces each edge belongs to, in the same order as `EDGES`.
 *
 * This is what turns a wireframe into a solid. Drawn in full, the far edges
 * show through and the cube becomes a lattice — at eleven columns the back
 * face's two uprights land next to the front face's and the middle of the mark
 * reads as `|||`, which is noise, not depth. An edge with no face turned
 * towards us is behind the cube, and behind the cube is nothing to draw.
 */
const EDGE_FACES: readonly (readonly [number, number])[] = [
  [1, 5],
  [1, 2],
  [1, 4],
  [1, 3],
  [0, 5],
  [0, 2],
  [0, 4],
  [0, 3],
  [3, 5],
  [2, 5],
  [2, 4],
  [3, 4],
]

/** Distance from the eye to the cube's centre, in cube half-widths. */
const CAMERA = 4.2

interface Point {
  x: number
  y: number
  /** Depth after rotation; larger is nearer. Used to break ties between edges. */
  z: number
}

function rotate(point: readonly [number, number, number], angle: number, tilt: number): [number, number, number] {
  const [x0, y0, z0] = point

  // About the vertical axis first: this is the turn the eye reads.
  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)
  const x1 = x0 * cosA + z0 * sinA
  const z1 = -x0 * sinA + z0 * cosA

  // Then the fixed tilt, so the lid stays the lid however far round it has got.
  const cosT = Math.cos(tilt)
  const sinT = Math.sin(tilt)
  const y2 = y0 * cosT - z1 * sinT
  const z2 = y0 * sinT + z1 * cosT

  return [x1, y2, z2]
}

/**
 * Projects a rotated point into grid coordinates.
 *
 * The horizontal scale is the larger of the two because a monospace cell is
 * roughly six units wide to ten tall: drawn with equal scales the cube comes
 * out a tall box. The ratio here is what makes it read as a cube rather than
 * as a crate stood on end.
 */
function project(rotated: readonly [number, number, number], cols: number, rows: number): Point {
  const [x, y, z] = rotated
  const scale = CAMERA / (CAMERA - z)
  /* 0.34 of the grid, which leaves the far corners inside it at every angle:
     turned to 45° the silhouette is the diagonal, about 1.41 wide. */
  return {
    x: (cols - 1) / 2 + x * scale * cols * 0.24,
    y: (rows - 1) / 2 - y * scale * rows * 0.26,
    z,
  }
}

/**
 * Which character an edge is made of, from the direction it runs on screen.
 *
 * Four slopes and four glyphs, which is the whole alphabet a terminal has for
 * drawing a line. The thresholds are generous towards `-` and `|`: a cube's
 * edges spend most of a turn near one of the two axes, and a near-horizontal
 * run made of slashes looks like a dashed line rather than an edge.
 */
export function edgeChar(dx: number, dy: number): string {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ay < ax * 0.45) return "-"
  if (ax < ay * 0.45) return "|"
  return dx * dy < 0 ? "/" : "\\"
}

/**
 * Draws a line of characters between two grid points.
 *
 * Sampled rather than stepped: a Bresenham walk on a grid this small leaves
 * gaps on the shallow diagonals, because one of the two axes advances by less
 * than a cell per step. Taking enough samples to cover the longer axis twice
 * over costs nothing at this size and closes them.
 */
function stroke(cells: (string | undefined)[][], from: Point, to: Point, glyph: string): void {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const steps = Math.max(2, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2))

  for (let step = 0; step <= steps; step++) {
    const t = step / steps
    const col = Math.round(from.x + dx * t)
    const row = Math.round(from.y + dy * t)
    const line = cells[row]
    if (!line || col < 0 || col >= line.length) continue
    /*
     * Corners win. Where two edges meet, the second one overwrites the first
     * and the join becomes whichever edge was drawn last — which changes as
     * the cube turns, so the corners flicker between `-` and `|`. A `+` says
     * "two edges meet here" and stays put.
     */
    const existing = line[col]
    line[col] = existing === undefined || existing === glyph ? glyph : "+"
  }
}

/**
 * The cube, as `rows` lines of `cols` characters.
 *
 * Order matters: edges first, then the letters, so a letter is never cut in
 * half by an edge drawn over it.
 */
export function renderAsciiCube(options: AsciiCubeOptions): string {
  const { cols, rows, angle } = options
  /* Positive looks down on the cube: the lid is the face a logo should show,
     and a mark seen from underneath reads as a mistake in the projection. */
  const tilt = options.tilt ?? 0.34
  const letter = options.letter ?? "N"

  const cells: (string | undefined)[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => undefined),
  )

  const rotated = CORNERS.map((corner) => rotate(corner, angle, tilt))
  const points = centre(
    rotated.map((corner) => project(corner, cols, rows)),
    cols,
    rows,
  )

  /* How far towards us each face is turned. Positive is visible. */
  const facing = FACES.map((face) => rotate(face.normal, angle, tilt)[2])

  EDGES.forEach(([a, b], index) => {
    const [faceA, faceB] = EDGE_FACES[index]
    if (facing[faceA] <= 0 && facing[faceB] <= 0) return
    const from = points[a]
    const to = points[b]
    stroke(cells, from, to, edgeChar(to.x - from.x, to.y - from.y))
  })

  FACES.forEach((face, index) => {
    /*
     * Printed, facing us, and not edge-on.
     *
     * The threshold is what stops a letter appearing on a face that has turned
     * so far away it is a two-character sliver — where it would sit on top of
     * the face's own edge and read as a stray character beside the cube.
     */
    if (!face.printed || facing[index] <= 0.3) return

    let x = 0
    let y = 0
    for (const corner of face.corners) {
      x += points[corner].x
      y += points[corner].y
    }
    const col = Math.round(x / face.corners.length)
    const row = Math.round(y / face.corners.length)
    const line = cells[row]
    if (line && col >= 0 && col < line.length) line[col] = letter
  })

  return cells.map((line) => line.map((cell) => cell ?? " ").join("")).join("\n")
}

/**
 * Slides the drawing so its own bounding box sits in the middle of the grid.
 *
 * Projection centres the cube's *centre*, which is not the same thing under
 * perspective: the near face is magnified, so with the lid tilted into view
 * the whole silhouette rides upwards and leaves a blank row along the bottom.
 * On a seven-row grid one blank row is a seventh of the mark. Framing the box
 * rather than the origin keeps it planted at every angle.
 */
function centre(points: readonly Point[], cols: number, rows: number): Point[] {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  const shiftX = (cols - 1) / 2 - (minX + maxX) / 2
  const shiftY = (rows - 1) / 2 - (minY + maxY) / 2
  return points.map((point) => ({ x: point.x + shiftX, y: point.y + shiftY, z: point.z }))
}
