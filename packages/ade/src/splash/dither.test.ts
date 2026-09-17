import { describe, expect, test } from "bun:test"
import { BAYER_8, BAYER_SIZE, ditherThreshold, quantize } from "./dither"

describe("the Bayer matrix", () => {
  test("is a permutation of 0…63, which is what makes it a dither", () => {
    // Transposing or mistyping one entry still dithers — just with a visible
    // diagonal bias that nobody notices until the animation is running.
    expect(BAYER_8.length).toBe(BAYER_SIZE * BAYER_SIZE)
    expect([...BAYER_8].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 64 }, (_, i) => i),
    )
  })

  test("thresholds sit strictly inside 0…1", () => {
    // Not at the ends: a threshold of exactly 0 leaves one pixel in eight
    // lit on pure black, and one of exactly 1 leaves one dead on pure white.
    for (let y = 0; y < BAYER_SIZE; y++) {
      for (let x = 0; x < BAYER_SIZE; x++) {
        const threshold = ditherThreshold(x, y)
        expect(threshold).toBeGreaterThan(0)
        expect(threshold).toBeLessThan(1)
      }
    }
  })

  test("tiles, including to the left of the origin", () => {
    // A `%` that can return a negative is exactly the bug that puts a seam
    // down the left edge of the picture.
    expect(ditherThreshold(-1, -1)).toBe(ditherThreshold(BAYER_SIZE - 1, BAYER_SIZE - 1))
    expect(ditherThreshold(-8, -8)).toBe(ditherThreshold(0, 0))
    expect(ditherThreshold(100, 250)).toBe(ditherThreshold(100 % 8, 250 % 8))
  })
})

describe("quantize", () => {
  test("black and white survive whatever the threshold says", () => {
    for (let y = 0; y < BAYER_SIZE; y++) {
      for (let x = 0; x < BAYER_SIZE; x++) {
        expect(quantize(0, x, y, 4)).toBe(0)
        expect(quantize(1, x, y, 4)).toBe(1)
      }
    }
  })

  test("values outside the range are clamped rather than wrapped", () => {
    expect(quantize(-3, 0, 0, 4)).toBe(0)
    expect(quantize(9, 0, 0, 4)).toBe(1)
  })

  test("every result lands exactly on a step", () => {
    const steps = new Set<number>()
    for (let y = 0; y < BAYER_SIZE; y++) {
      for (let x = 0; x < BAYER_SIZE; x++) {
        for (const value of [0.1, 0.3, 0.5, 0.7, 0.9]) steps.add(quantize(value, x, y, 4))
      }
    }
    expect([...steps].sort((a, b) => a - b)).toEqual([0, 1 / 3, 2 / 3, 1])
  })

  test("a flat mid-grey comes out as the right mix over one tile", () => {
    /*
     * The property the whole effect rests on: half brightness must light
     * half the pixels in a tile. A matrix that is merely "some numbers"
     * passes the tests above and fails this one.
     */
    let lit = 0
    for (let y = 0; y < BAYER_SIZE; y++) {
      for (let x = 0; x < BAYER_SIZE; x++) {
        if (quantize(0.5, x, y, 2) === 1) lit++
      }
    }
    expect(lit).toBe(32)
  })

  test("fewer than two levels is still two, not a division by zero", () => {
    expect(quantize(0.5, 0, 0, 1)).toBeOneOf([0, 1])
    expect(quantize(0.5, 0, 0, 0)).toBeOneOf([0, 1])
  })
})
