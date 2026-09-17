import { describe, expect, test } from "bun:test"
import { BONG_MOUTH, MAX_PUFFS, PUFF_INTERVAL, createSmoke, puffOpacity, stepSmoke } from "./scene"

describe("stepSmoke", () => {
  test("releases a puff from the bong's mouth", () => {
    const smoke = stepSmoke(createSmoke(), 0.016)
    expect(smoke.puffs.length).toBe(1)
    // Within the jitter that stops every puff leaving from the same pixel.
    expect(Math.abs(smoke.puffs[0]!.x - BONG_MOUTH.x)).toBeLessThan(3)
    expect(smoke.puffs[0]!.text.length).toBeGreaterThan(5)
  })

  test("puffs rise", () => {
    const smoke = createSmoke()
    stepSmoke(smoke, 0.016)
    const started = smoke.puffs[0]!.y
    for (let i = 0; i < 30; i++) stepSmoke(smoke, 0.016)
    expect(smoke.puffs[0]!.y).toBeLessThan(started)
  })

  test("they die, so the scene does not fill up", () => {
    /*
     * The leak that shows up as a splash getting gradually slower — and only
     * on the launches slow enough for anyone to see it.
     */
    const smoke = createSmoke()
    for (let i = 0; i < 4000; i++) stepSmoke(smoke, 0.016)
    expect(smoke.puffs.length).toBeLessThanOrEqual(MAX_PUFFS)
    expect(smoke.released).toBeGreaterThan(20)
  })

  test("a tab that was asleep does not empty the scene", () => {
    /*
     * A backgrounded window hands back a `dt` of several seconds on its
     * first frame. Unclamped, that teleports every puff off the top and ages
     * it past death in one step: the animation appears to have stopped.
     */
    const smoke = createSmoke()
    for (let i = 0; i < 40; i++) stepSmoke(smoke, 0.05)
    const before = smoke.puffs.length
    expect(before).toBeGreaterThan(0)

    stepSmoke(smoke, 12)
    expect(smoke.puffs.length).toBeGreaterThan(0)
    expect(smoke.puffs.length).toBeLessThanOrEqual(before)
  })

  test("a negative or zero step changes nothing and crashes nothing", () => {
    const smoke = createSmoke()
    stepSmoke(smoke, 0.016)
    const y = smoke.puffs[0]!.y
    stepSmoke(smoke, -5)
    stepSmoke(smoke, 0)
    expect(smoke.puffs[0]!.y).toBe(y)
  })

  test("keeps the same array, because this runs sixty times a second", () => {
    const smoke = createSmoke()
    const puffs = smoke.puffs
    for (let i = 0; i < 200; i++) stepSmoke(smoke, 0.016)
    expect(smoke.puffs).toBe(puffs)
  })

  test("waits between puffs rather than emitting one per frame", () => {
    const smoke = createSmoke()
    stepSmoke(smoke, 0.016)
    stepSmoke(smoke, 0.016)
    expect(smoke.puffs.length).toBe(1)
    // Advanced in real frames: a single huge step is clamped, which is the
    // behaviour the sleeping-tab test above depends on.
    let waited = 0.032
    while (waited < PUFF_INTERVAL + 0.02) {
      stepSmoke(smoke, 0.016)
      waited += 0.016
    }
    expect(smoke.puffs.length).toBe(2)
  })
})

describe("puffOpacity", () => {
  const puff = (age: number) => ({ age }) as Parameters<typeof puffOpacity>[0]

  test("fades in, so a line does not appear at full strength on the mouth", () => {
    expect(puffOpacity(puff(0))).toBe(0)
    expect(puffOpacity(puff(0.06))).toBeCloseTo(0.5, 1)
    expect(puffOpacity(puff(0.12))).toBeCloseTo(1, 2)
  })

  test("fades out to nothing by the time it dies", () => {
    expect(puffOpacity(puff(0.5))).toBeGreaterThan(0)
    expect(puffOpacity(puff(1))).toBe(0)
    expect(puffOpacity(puff(1.4))).toBe(0)
  })
})
