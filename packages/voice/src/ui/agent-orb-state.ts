/**
 * What the voice agent's orb shows, and the sphere it draws — without a DOM.
 *
 * S33, proposal B chosen by the user: the agent no longer borrows the
 * dictation pill. While it thinks or speaks, a sphere of particles rises to the
 * middle of the workspace at 280 px and the panels behind it dim; the rest of
 * the time it is the orb in the bar. Pure here so the rules can be tested under
 * `bun test`, where a `.tsx` cannot be loaded.
 */

import type { DialogStatus } from "../dialog/session"
import type { VoiceMode } from "../settings/model"

export type OrbPhase = "idle" | "listen" | "think" | "speak"

export interface OrbPhaseInput {
  readonly running: boolean
  readonly mode: VoiceMode
  readonly status: DialogStatus
  readonly speaking: boolean
  /** A reply is being synthesised or is between two sentences. */
  readonly replying?: boolean
}

/**
 * Speaking wins over everything: a reply is being heard, whatever the dialogue
 * says. Dictation never has an orb phase of its own — the pill is its widget,
 * and a sphere rising over the panels mid-dictation would cover the text being
 * written into them.
 */
export function orbPhase(input: OrbPhaseInput): OrbPhase {
  if (input.mode === "transcription") return "idle"
  if (input.speaking) return "speak"
  // Piper can take seconds over a long first sentence: still thinking, not done.
  if (input.status === "executing" || input.replying) return "think"
  if (input.running && input.status !== "asleep") return "listen"
  return "idle"
}

/** Only thinking and speaking take the middle of the window. */
export function orbCentered(phase: OrbPhase): boolean {
  return phase === "think" || phase === "speak"
}

/** What `escapeStopsOrb` needs to know about a key press, so it can be tested without a DOM. */
export interface EscapeInput {
  readonly key: string
  readonly defaultPrevented: boolean
  /** The focused element, or anything with `closest` standing in for it. */
  readonly target: { closest?(selector: string): unknown } | null
  /** Whether a modal dialog is open anywhere in the window. */
  readonly modalOpen: boolean
}

/** Where Escape belongs to someone else: a field being edited, or a dialog. */
export const ESCAPE_OWNERS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"], [role="alertdialog"], [data-layout="overlay"]'

/**
 * Escape stops the agent only when nobody else wants it. Taking it from a
 * dialog or a field would close the reply instead of the palette, or eat the
 * key an editor uses to leave a mode.
 */
export function escapeStopsOrb(input: EscapeInput): boolean {
  if (input.key !== "Escape" || input.defaultPrevented || input.modalOpen) return false
  return !input.target?.closest?.(ESCAPE_OWNERS)
}

/** The size of the centred sphere, and of the docked one it flies from. */
export const ORB_CENTER_SIZE = 280
export const ORB_DOCK_SIZE = 28

export interface SpherePoint {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly lat: number
  readonly lon: number
}

/** Evenly spread points on a unit sphere (Fibonacci lattice). */
export function spherePoints(count: number): SpherePoint[] {
  const points: SpherePoint[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = count === 1 ? 0 : 1 - (i / (count - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const lon = golden * i
    points.push({ x: Math.cos(lon) * r, y, z: Math.sin(lon) * r, lat: Math.asin(y), lon })
  }
  return points
}

export interface Projected {
  /** Offset from the centre, in radii. */
  readonly x: number
  readonly y: number
  /** 0 at the back of the sphere, 1 at the front. */
  readonly depth: number
}

/** How far a point may be pushed out by the loudest syllable, in radii. */
export const MAX_PUSH = 0.22

/**
 * Where one point is drawn at `seconds`, for a phase and a voice level.
 *
 * Speaking pushes points out in waves that travel over the sphere with the
 * level; thinking slides them along latitude bands; listening is still here,
 * because in this proposal listening happens in the bar. With reduced motion
 * nothing turns or travels: the whole sphere only swells with the level.
 */
export function projectPoint(point: SpherePoint, seconds: number, phase: OrbPhase, level: number, reduced: boolean): Projected {
  const amp = Math.max(0, Math.min(1, level))
  let push = 1
  if (phase === "speak") {
    push += reduced ? amp * 0.15 : amp * MAX_PUSH * Math.sin(point.lat * 6 - seconds * 9) * Math.sin(point.lon * 3 + seconds * 2)
  }

  let { x, z } = point
  let y = point.y
  if (phase === "think" && !reduced) {
    const band = Math.sin(point.lat * 8 + seconds * 2) * 0.12
    ;[x, z] = [x * Math.cos(band) - z * Math.sin(band), x * Math.sin(band) + z * Math.cos(band)]
  }

  const spin = reduced || phase === "idle" ? 0.6 : 0.6 + seconds * (phase === "think" ? 0.55 : 0.25)
  ;[x, z] = [x * Math.cos(spin) - z * Math.sin(spin), x * Math.sin(spin) + z * Math.cos(spin)]
  const tilt = 0.35
  ;[y, z] = [y * Math.cos(tilt) - z * Math.sin(tilt), y * Math.sin(tilt) + z * Math.cos(tilt)]

  return { x: x * push, y: y * push, depth: (z + 1) / 2 }
}

/** The sphere's colour per phase, as the dark theme's accent and waiting tokens. */
export function orbColor(phase: OrbPhase): readonly [number, number, number] {
  return phase === "think" ? [125, 169, 228] : [127, 214, 196]
}
