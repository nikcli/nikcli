import { rng, smokeLine } from "./anagram"
import { BONG_MOUTH } from "./bong"

/**
 * The moving part of the splash: the smoke.
 *
 * Pure arithmetic, in a `.ts`, for the usual reason — a `.tsx` cannot be
 * imported under `bun test` here — and for a better one: an animation is the
 * hardest kind of code to check by looking at it. A puff that never dies
 * leaks for as long as the window is open and shows up as a splash that gets
 * gradually slower, which is invisible in the first five seconds and is all
 * anyone ever watches.
 *
 * The bong itself does not move, so it lives in `bong.ts`.
 */

/**
 * The drawing surface everything below is measured in.
 *
 * 4:3 rather than the 8:5 it started at. The subject is a tall object with
 * something rising out of the top of it, and in a wide frame the two had to
 * share the same rows: either the glass was small or the smoke was clipped.
 * Must match `aspect-ratio` in `splash.css`.
 */
export const SCENE_WIDTH = 192
export const SCENE_HEIGHT = 144

// Re-exported because the smoke starts at the mouthpiece, and everything that
// deals with the smoke reaches for it here.
export { BONG_MOUTH }

/** One rising line of smoke. */
export interface Puff {
  /** The anagrammed line this puff draws. */
  text: string
  x: number
  y: number
  /** Scene pixels per second. */
  vx: number
  vy: number
  /** 0 at birth, 1 when it should be forgotten. */
  age: number
  /** How long this puff lives, in seconds. */
  life: number
  /** Radians; small, so the text looks like it is curling. */
  tilt: number
  spin: number
}

/** How many puffs may exist at once. */
export const MAX_PUFFS = 14

/** Seconds between puffs leaving the bong. */
export const PUFF_INTERVAL = 0.42

export interface Smoke {
  puffs: Puff[]
  /** Seconds since the last puff was released. */
  since: number
  /** How many have been released, which picks the line and seeds the shuffle. */
  released: number
}

export function createSmoke(): Smoke {
  return { puffs: [], since: PUFF_INTERVAL, released: 0 }
}

/**
 * Advances the smoke by `dt` seconds.
 *
 * Mutates, and returns the same object: this runs once per animation frame,
 * and a fresh array and fourteen fresh objects per frame is garbage the
 * splash does not need to make while the app behind it is starting.
 *
 * `dt` is clamped. A tab left in the background hands back a `dt` of several
 * seconds on the first frame after it wakes, which teleports every puff off
 * the top and empties the scene — the animation appears to have stopped.
 */
export function stepSmoke(smoke: Smoke, dt: number, seed = 1): Smoke {
  const step = Math.min(Math.max(dt, 0), 0.1)

  for (const puff of smoke.puffs) {
    puff.x += puff.vx * step
    puff.y += puff.vy * step
    puff.tilt += puff.spin * step
    // Slows as it rises and spreads sideways, the way smoke does when it
    // stops being a jet and becomes a cloud.
    puff.vy *= 1 - 0.6 * step
    puff.vx *= 1 - 0.3 * step
    puff.age += step / puff.life
  }

  // Filtered in place rather than with `filter`, to keep the array identity.
  let kept = 0
  for (const puff of smoke.puffs) {
    if (puff.age < 1) smoke.puffs[kept++] = puff
  }
  smoke.puffs.length = kept

  smoke.since += step
  if (smoke.since >= PUFF_INTERVAL && smoke.puffs.length < MAX_PUFFS) {
    smoke.since = 0
    smoke.puffs.push(bornPuff(smoke.released, seed))
    smoke.released++
  }

  return smoke
}

function bornPuff(index: number, seed: number): Puff {
  const next = rng(seed * 7919 + index * 104729)
  return {
    text: smokeLine(index, seed + index),
    x: BONG_MOUTH.x + (next() - 0.5) * 4,
    y: BONG_MOUTH.y,
    // Symmetric, and gentler than it was: smoke that all leans one way reads
    // as wind, and the plume walked off the right of the frame.
    vx: (next() - 0.5) * 5,
    vy: -(13 + next() * 9),
    age: 0,
    life: 3.4 + next() * 1.8,
    tilt: (next() - 0.5) * 0.3,
    spin: (next() - 0.5) * 0.22,
  }
}

/**
 * How solid a puff is right now, 0…1.
 *
 * Fades in as well as out: a line of text appearing at full strength on the
 * bong's mouth reads as a label, not as smoke.
 */
export function puffOpacity(puff: Puff): number {
  if (puff.age <= 0.12) return puff.age / 0.12
  return Math.max(0, 1 - (puff.age - 0.12) / 0.88)
}
