/**
 * The bong, as brightness per pixel.
 *
 * It used to be three ellipses beside a dragon, and at 192×120 that came out
 * as a grey blob: the dragon was the subject and the bong only had to be
 * recognisable next to it. Now it is the whole picture, so it is drawn the
 * way the scene can actually carry detail — not as a silhouette but as
 * *tones*. The dither quantises everything to four levels, which is four
 * tones to spend, and glass is exactly the subject that needs them: a bright
 * edge where the light catches the rim, a dark interior you can see the
 * background through, water that is neither, and one highlight down the side
 * that says "round" better than any amount of outline.
 *
 * A function of the coordinate rather than a path to stroke, because the
 * scene is sampled per pixel — see `splash.tsx`. That also makes every part
 * of it testable without a canvas, which for a shape nobody can eyeball at
 * this size is the only way to know the downstem actually reaches the water.
 */

/** The bong stands in the middle of the scene. */
export const AXIS = 96

/**
 * Floor level: the bottom of the base sits here.
 *
 * Everything below is measured from this and from {@link NECK_TOP}, and the
 * tests read them from here rather than repeating the numbers — a piece that
 * gets moved or resized should not also need its tests rewritten.
 */
export const FLOOR = 134

// ── the beaker ─────────────────────────────────────────────────────────────
/** Where the base stops flaring and the neck begins. */
export const BASE_TOP = 100
/** Half-width at the floor, and at the shoulder. */
const BASE_FOOT_HALF = 27
const BASE_NECK_HALF = 9

// ── the neck ───────────────────────────────────────────────────────────────
/**
 * The top of the tube, and so the top of the whole piece.
 *
 * Low enough to leave the upper third of the frame empty, because that is
 * where the smoke goes: with the mouthpiece near the top edge the first puff
 * was already against the ceiling, and the smoke read as a banner across the
 * picture rather than as something rising out of the glass.
 */
export const NECK_TOP = 56
const NECK_HALF = 8
/** Where the ice pinch sits, and how far it squeezes the neck. */
export const PINCH_Y = 82
const PINCH_DEPTH = 4

// ── the mouthpiece ─────────────────────────────────────────────────────────
const LIP_HEIGHT = 6
const LIP_HALF = 12

// ── the water ──────────────────────────────────────────────────────────────
const WATER_TOP = 114

// ── the joint, downstem and bowl ───────────────────────────────────────────
/** Where the joint leaves the beaker, and where the downstem ends in it. */
const JOINT_OUT = { x: 122, y: 98 } as const
const STEM_END = { x: 100, y: 126 } as const
const BOWL_Y = 92

/**
 * Where the smoke leaves: the middle of the mouthpiece.
 *
 * Exported from here rather than from `scene.ts` because it is a fact about
 * the shape, and the shape is what decides it. A mouth that drifts off the
 * lip is the kind of thing nobody notices until the smoke is rising out of
 * the glass an inch to the left.
 */
export const BONG_MOUTH = { x: AXIS, y: NECK_TOP } as const

/** The tones the bong is drawn in, dark to light. */
export const TONE = {
  /** Seen-through glass: darker than the ground, so the body reads as empty. */
  glass: 0.1,
  /** Water in the beaker. */
  water: 0.42,
  /** The lit side of the glass. */
  highlight: 0.72,
  /** Rims, edges and the bowl: wherever the light catches an edge. */
  edge: 0.95,
} as const

/** Half-width of the beaker's outer wall at height `y`. */
function baseHalf(y: number): number {
  if (y < BASE_TOP || y > FLOOR) return 0
  const down = (y - BASE_TOP) / (FLOOR - BASE_TOP)
  // Flares as it descends. Squared, so the beaker has a shoulder rather than
  // being a plain cone.
  return BASE_NECK_HALF + (BASE_FOOT_HALF - BASE_NECK_HALF) * down ** 1.5
}

/** Half-width of the neck at height `y`, ice pinch included. */
function neckHalf(y: number): number {
  if (y < NECK_TOP || y > BASE_TOP) return 0
  const pinch = Math.abs(y - PINCH_Y) <= 1 ? PINCH_DEPTH : 0
  return NECK_HALF - pinch
}

/** Half-width of the flared mouthpiece at height `y`. */
function lipHalf(y: number): number {
  if (y < NECK_TOP - LIP_HEIGHT || y > NECK_TOP) return 0
  const up = (NECK_TOP - y) / LIP_HEIGHT
  return NECK_HALF + (LIP_HALF - NECK_HALF) * up ** 1.4
}

/** Distance from a point to the segment `a`–`b`. */
function toSegment(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length))
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t))
}

/**
 * How bright the bong is at this pixel, or `undefined` where it is not.
 *
 * `undefined` and not 0, because 0 is a colour: the background has to show
 * through everywhere the glass is not, and a shape that returned black would
 * punch a hole in it.
 */
export function bongShade(x: number, y: number): number | undefined {
  const dx = Math.abs(x - AXIS)

  // ── mouthpiece ──────────────────────────────────────────────────────────
  const lip = lipHalf(y)
  if (lip > 0) {
    /*
     * Two walls and nothing between them.
     *
     * Seen from the side a tube has no top — it has two rims, and the sky
     * between. Capping it, which is what this did first, drew a lid across
     * the mouthpiece: the smoke then rose out of a closed bottle.
     */
    return dx <= lip && dx >= lip - 2 ? TONE.edge : undefined
  }

  // ── neck ────────────────────────────────────────────────────────────────
  const neck = neckHalf(y)
  if (neck > 0 && dx <= neck) return wall(x, y, dx, neck)

  // ── beaker ──────────────────────────────────────────────────────────────
  const base = baseHalf(y)
  if (base > 0 && dx <= base) {
    // The foot is solid glass, and the thickest part of the piece.
    if (y >= FLOOR - 2) return TONE.edge
    const shade = wall(x, y, dx, base)
    if (shade !== TONE.glass) return shade
    // Inside the beaker: water below the line, air above it.
    if (y >= WATER_TOP) return y <= WATER_TOP + 1 ? TONE.highlight : TONE.water
    return TONE.glass
  }

  // ── joint and bowl, off to the right ────────────────────────────────────
  const bowlLip = BOWL_Y + 2
  if (y >= BOWL_Y - 3 && y <= bowlLip) {
    // A funnel: wide at the top, narrowing onto the joint.
    const half = 7 - ((y - (BOWL_Y - 3)) / 5) * 4
    const fromBowl = Math.abs(x - JOINT_OUT.x)
    if (fromBowl <= half) return fromBowl >= half - 1.5 || y <= BOWL_Y - 2 ? TONE.edge : TONE.glass
  }
  // The joint's own short tube, between the bowl and the beaker.
  if (y > bowlLip && y <= JOINT_OUT.y && Math.abs(x - JOINT_OUT.x) <= 2.5) return TONE.edge

  return undefined
}

/**
 * A wall seen edge-on: bright at the rim, dark through the middle, with one
 * highlight where the light is.
 */
function wall(x: number, y: number, dx: number, half: number): number {
  if (dx >= half - 1.2) return TONE.edge
  // The light comes from the upper left, so the highlight is a little inside
  // the left wall and nowhere else.
  if (x < AXIS && dx >= half - 4 && dx < half - 1.2) return TONE.highlight
  return TONE.glass
}

/**
 * The downstem, which is inside the glass and so is drawn over it.
 *
 * Separate from {@link bongShade} because it does not replace what is behind
 * it: a tube in water is still a tube seen *through* water, and drawing it as
 * another wall would make the beaker look like it had a slot cut in it.
 */
export function insideStem(x: number, y: number): boolean {
  return toSegment(x, y, JOINT_OUT, STEM_END) <= 1.6 && y >= JOINT_OUT.y && y <= STEM_END.y
}

/** Where the downstem ends, for the tests that check it reaches the water. */
export const STEM_TIP = STEM_END
/** The waterline, likewise. */
export const WATER_LINE = WATER_TOP
