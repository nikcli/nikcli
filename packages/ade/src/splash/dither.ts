/**
 * Ordered dithering, which is what makes the splash look drawn rather than
 * rendered.
 *
 * The scene is computed as continuous brightness and then thrown away: every
 * pixel is forced to one of a handful of levels, and the error is hidden in a
 * fixed pattern rather than in a gradient. That is the whole effect — the
 * grain is a *decision*, repeatable frame to frame, so the animation shimmers
 * along the shapes instead of boiling like noise.
 *
 * Ordered and not Floyd–Steinberg on purpose. Error diffusion is serial: each
 * pixel depends on its neighbours, so a shape that moves one pixel redraws the
 * whole field differently and the image crawls. A threshold matrix depends on
 * nothing but the coordinate, which is why this one is stable under motion and
 * also why it can be computed per pixel with no buffer.
 */

/**
 * The 8×8 Bayer matrix, as the integers 0…63 in dispersion order.
 *
 * Written out rather than generated, because the recursive construction is a
 * line of code that is easy to get subtly wrong and impossible to eyeball:
 * a transposed matrix still dithers, just with a visible diagonal bias.
 */
export const BAYER_8: readonly number[] = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
]

export const BAYER_SIZE = 8

/**
 * The threshold for one pixel, in 0…1.
 *
 * Negative or huge coordinates are fine: the matrix tiles, and a modulo that
 * can go negative is exactly the bug that puts a seam down the left edge.
 */
export function ditherThreshold(x: number, y: number): number {
  const column = ((Math.trunc(x) % BAYER_SIZE) + BAYER_SIZE) % BAYER_SIZE
  const row = ((Math.trunc(y) % BAYER_SIZE) + BAYER_SIZE) % BAYER_SIZE
  // +0.5 centres each threshold in its slot, so a flat 0 is always off and a
  // flat 1 is always on. Without it pure white keeps one dead pixel in eight.
  return ((BAYER_8[row * BAYER_SIZE + column] ?? 0) + 0.5) / (BAYER_SIZE * BAYER_SIZE)
}

/**
 * Snaps a brightness to one of `levels` steps, dithered at this coordinate.
 *
 * Returns 0…1, always exactly on a step. `levels` is the number of distinct
 * values, so 2 is pure black and white — the 1-bit look — and 4 is what the
 * scene uses, because a dragon in two tones loses its edge against the
 * background.
 */
export function quantize(value: number, x: number, y: number, levels = 2): number {
  const steps = Math.max(2, Math.trunc(levels)) - 1
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value
  const scaled = clamped * steps
  const floor = Math.floor(scaled)
  // The fractional part decides against the threshold: at 0.25 into a step,
  // a quarter of the pixels in the tile round up.
  const up = scaled - floor > ditherThreshold(x, y) ? 1 : 0
  return Math.min(steps, floor + up) / steps
}
