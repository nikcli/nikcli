import { describe, expect, test } from "bun:test"
import type { RecordEvent } from "./recording"
import {
  cameraAt,
  CLICK_RING_MS,
  mappingFor,
  planShots,
  pointerAt,
  ringsAt,
  toVideo,
  ZOOM_EASE_MS,
  ZOOM_HOLD_MS,
  ZOOM_SCALE,
} from "./zoom"

const frame = (extra: Partial<Extract<RecordEvent, { kind: "frame" }>> = {}): RecordEvent => ({
  kind: "frame",
  at: 0,
  width: 1440,
  height: 900,
  dpr: 1.25,
  ...extra,
})
const click = (at: number, x: number, y: number): RecordEvent => ({ kind: "click", at, x, y, button: "left" })

describe("record/zoom mapping", () => {
  test("page pixels become video pixels through the device pixel ratio", () => {
    // The live take: a 1440x900 page at 125% is an 1800x1125 capture.
    const mapping = mappingFor([frame()], 1800, 1125)
    expect(toVideo(mapping, 100, 200)).toEqual({ x: 125, y: 250 })
  })

  test("a lighter take is shrunk once more, to the file's own size", () => {
    const mapping = mappingFor([frame()], 1280, 800)
    const point = toVideo(mapping, 1440, 900)
    expect(point.x).toBeCloseTo(1280)
    expect(point.y).toBeCloseTo(800)
  })

  test("a pane take moves the origin to the pane's corner", () => {
    const events = [frame({ cropX: 900, cropY: 0, cropWidth: 900, cropHeight: 1125 })]
    const mapping = mappingFor(events, 900, 1125)
    // The pane's left edge, 720 CSS px = 900 physical, is x 0 in the video.
    expect(toVideo(mapping, 720, 0)).toEqual({ x: 0, y: 0 })
  })

  test("without a frame event the events are taken as they are", () => {
    expect(toVideo(mappingFor([], 1920, 1080), 10, 20)).toEqual({ x: 10, y: 20 })
  })
})

describe("record/zoom shots", () => {
  const identity = mappingFor([], 1000, 1000)

  test("a click moves in before it happens, holds, and comes back out", () => {
    const shots = planShots([click(2000, 300, 400)], identity, 10_000)
    expect(shots).toEqual([{ start: 2000 - ZOOM_EASE_MS, end: 2000 + ZOOM_HOLD_MS + ZOOM_EASE_MS, x: 300, y: 400 }])
    expect(cameraAt(shots, 0, 1000, 1000).scale).toBe(1)
    expect(cameraAt(shots, 2000, 1000, 1000).scale).toBeCloseTo(ZOOM_SCALE)
    expect(cameraAt(shots, 2000 + ZOOM_HOLD_MS + ZOOM_EASE_MS + 1, 1000, 1000).scale).toBe(1)
    const halfway = cameraAt(shots, 2000 - ZOOM_EASE_MS / 2, 1000, 1000).scale
    expect(halfway).toBeGreaterThan(1)
    expect(halfway).toBeLessThan(ZOOM_SCALE)
  })

  test("clicks close together are one shot that follows them, not a bounce", () => {
    const shots = planShots([click(1000, 100, 100), click(2000, 800, 800)], identity, 10_000)
    expect(shots).toHaveLength(1)
    expect(shots[0]).toMatchObject({ x: 800, y: 800, end: 2000 + ZOOM_HOLD_MS + ZOOM_EASE_MS })
    const apart = planShots([click(1000, 100, 100), click(8000, 800, 800)], identity, 10_000)
    expect(apart).toHaveLength(2)
  })

  test("the camera never shows outside the frame, even for a click in a corner", () => {
    const shots = planShots([click(1000, 0, 0), click(6000, 1000, 1000)], identity, 10_000)
    const corner = cameraAt(shots, 1000, 1000, 1000)
    expect(corner).toMatchObject({ left: 0, top: 0 })
    const far = cameraAt(shots, 6000, 1000, 1000)
    expect(far.left + 1000 / far.scale).toBeCloseTo(1000)
    expect(far.top + 1000 / far.scale).toBeCloseTo(1000)
  })

  test("a shot never runs past the end of the take", () => {
    expect(planShots([click(9900, 1, 1)], identity, 10_000)[0]!.end).toBe(10_000)
  })
})

describe("record/zoom overlays", () => {
  const identity = mappingFor([], 1000, 1000)

  test("a click's ring grows from the click and is gone after its time", () => {
    const events = [click(1000, 50, 60)]
    expect(ringsAt(events, identity, 999)).toEqual([])
    expect(ringsAt(events, identity, 1000)).toEqual([{ x: 50, y: 60, progress: 0 }])
    expect(ringsAt(events, identity, 1000 + CLICK_RING_MS / 2)[0]!.progress).toBeCloseTo(0.5)
    expect(ringsAt(events, identity, 1001 + CLICK_RING_MS)).toEqual([])
  })

  test("the pointer is drawn where it last was", () => {
    const events: RecordEvent[] = [
      { kind: "pointer", at: 100, x: 1, y: 1 },
      { kind: "pointer", at: 200, x: 2, y: 2 },
      click(300, 3, 3),
    ]
    expect(pointerAt(events, identity, 50)).toBeUndefined()
    expect(pointerAt(events, identity, 250)).toEqual({ x: 2, y: 2 })
    expect(pointerAt(events, identity, 400)).toEqual({ x: 3, y: 3 })
  })
})
