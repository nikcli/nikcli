/**
 * Zoom and click highlights, decided from the events file at export (S36).
 *
 * A promo video is watched on a phone as often as on a monitor, and a whole
 * ADE window at that size is a grid of unreadable text. What makes it
 * watchable is the camera: it moves in where something happens — a click —
 * holds long enough to read, and comes back out. Screen Studio and Cap do the
 * same; like them, nothing here touches the recording, so a take can be cut
 * again with different choices.
 *
 * Everything is in the video's own pixels. Events are written in the page's
 * CSS pixels, so the `frame` event at the start of the take says how the two
 * relate (device pixel ratio, and the pane's offset for a pane take).
 */

import type { RecordEvent } from "./recording"

/** How far in the camera goes on a click. */
export const ZOOM_SCALE = 1.8
/** Time to move in, and to move back out. */
export const ZOOM_EASE_MS = 450
/** How long the camera stays in after the last click that kept it there. */
export const ZOOM_HOLD_MS = 1800
/** How long a click's ring is drawn. */
export const CLICK_RING_MS = 550

export interface Shot {
  /** When the camera starts moving in. */
  readonly start: number
  /** When it is back out. */
  readonly end: number
  /** The point it centres on, in video pixels. */
  readonly x: number
  readonly y: number
}

export interface Camera {
  readonly scale: number
  /** Top-left of the visible part, in video pixels. */
  readonly left: number
  readonly top: number
}

export interface Ring {
  readonly x: number
  readonly y: number
  /** 0 at the click, 1 when the ring is gone. */
  readonly progress: number
}

/** How page coordinates become video coordinates for this take. */
export interface Mapping {
  readonly scaleX: number
  readonly scaleY: number
  readonly offsetX: number
  readonly offsetY: number
}

/**
 * The mapping from the `frame` event and the video's real size.
 *
 * The video can be smaller than what was captured (a lighter quality), so the
 * scale is measured against the capture, then shrunk to the file.
 */
export function mappingFor(events: readonly RecordEvent[], videoWidth: number, videoHeight: number): Mapping {
  const frame = events.find((event) => event.kind === "frame")
  if (!frame || frame.kind !== "frame" || frame.width <= 0 || frame.height <= 0) {
    return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 }
  }
  const capturedWidth = frame.cropWidth ?? frame.width * frame.dpr
  const capturedHeight = frame.cropHeight ?? frame.height * frame.dpr
  const shrinkX = videoWidth / capturedWidth
  const shrinkY = videoHeight / capturedHeight
  return {
    scaleX: frame.dpr * shrinkX,
    scaleY: frame.dpr * shrinkY,
    offsetX: -(frame.cropX ?? 0) * shrinkX,
    offsetY: -(frame.cropY ?? 0) * shrinkY,
  }
}

export function toVideo(mapping: Mapping, x: number, y: number): { x: number; y: number } {
  return { x: x * mapping.scaleX + mapping.offsetX, y: y * mapping.scaleY + mapping.offsetY }
}

/**
 * One shot per burst of clicks.
 *
 * A click while the camera is already in extends the shot and moves its
 * centre to the new click, instead of zooming out and back in: that bounce is
 * the thing that makes automatic zoom look automatic.
 */
export function planShots(events: readonly RecordEvent[], mapping: Mapping, durationMs: number): Shot[] {
  const shots: { start: number; end: number; x: number; y: number }[] = []
  for (const event of events) {
    if (event.kind !== "click") continue
    const point = toVideo(mapping, event.x, event.y)
    const start = Math.max(0, event.at - ZOOM_EASE_MS)
    const end = Math.min(durationMs, event.at + ZOOM_HOLD_MS + ZOOM_EASE_MS)
    const last = shots.at(-1)
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
      last.x = point.x
      last.y = point.y
    } else {
      shots.push({ start, end, x: point.x, y: point.y })
    }
  }
  return shots
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/** Where the camera is at `t`, kept inside the frame. */
export function cameraAt(shots: readonly Shot[], t: number, width: number, height: number): Camera {
  const shot = shots.find((candidate) => t >= candidate.start && t <= candidate.end)
  if (!shot) return { scale: 1, left: 0, top: 0 }
  const into = Math.min(1, (t - shot.start) / ZOOM_EASE_MS)
  const out = Math.min(1, (shot.end - t) / ZOOM_EASE_MS)
  const amount = ease(Math.max(0, Math.min(into, out)))
  const scale = 1 + (ZOOM_SCALE - 1) * amount
  const visibleWidth = width / scale
  const visibleHeight = height / scale
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value))
  return {
    scale,
    left: clamp(shot.x - visibleWidth / 2, width - visibleWidth),
    top: clamp(shot.y - visibleHeight / 2, height - visibleHeight),
  }
}

/** The click rings visible at `t`. */
export function ringsAt(events: readonly RecordEvent[], mapping: Mapping, t: number): Ring[] {
  const rings: Ring[] = []
  for (const event of events) {
    if (event.kind !== "click") continue
    const age = t - event.at
    if (age < 0 || age > CLICK_RING_MS) continue
    const point = toVideo(mapping, event.x, event.y)
    rings.push({ ...point, progress: age / CLICK_RING_MS })
  }
  return rings
}

/** Where the pointer was at `t`, for drawing it: the last position before. */
export function pointerAt(
  events: readonly RecordEvent[],
  mapping: Mapping,
  t: number,
): { x: number; y: number } | undefined {
  let found: { x: number; y: number } | undefined
  for (const event of events) {
    if (event.at > t) break
    if (event.kind === "pointer" || event.kind === "click") found = toVideo(mapping, event.x, event.y)
  }
  return found
}
