/**
 * Short sounds that say what the assistant is doing when it is not talking.
 *
 * A spoken reply that takes three seconds to start is three seconds in which
 * the user cannot tell a slow answer from a sentence that was never heard.
 * These are synthesised on the spot (no files to ship), quiet, and under a
 * quarter of a second: a sign, not a jingle.
 */

export type CueKind =
  /** The request is being worked on and nothing is ready to say yet. */
  | "thinking"
  /** The assistant is listening for a follow-up, without the name. */
  | "listening"
  /** The follow-up window has closed: the name is needed again. */
  | "closed"

/** Frequencies in Hz, one note after the other. */
const NOTES: Record<CueKind, readonly number[]> = {
  thinking: [587, 587],
  listening: [523, 784],
  closed: [659, 440],
}
const NOTE_S = 0.07
const GAP_S = 0.03
const VOLUME = 0.05

type AudioContextLike = {
  readonly currentTime: number
  readonly destination: unknown
  readonly state?: string
  resume?: () => Promise<void>
  createOscillator(): {
    type: string
    frequency: { setValueAtTime(value: number, at: number): void }
    connect(node: unknown): void
    start(at: number): void
    stop(at: number): void
  }
  createGain(): {
    gain: { setValueAtTime(value: number, at: number): void; linearRampToValueAtTime(value: number, at: number): void }
    connect(node: unknown): void
  }
}

let context: AudioContextLike | undefined

/** Plays a cue. Silent where there is no Web Audio, as in tests. */
export function playCue(kind: CueKind): void {
  const Ctor = (globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext
  if (!Ctor) return
  try {
    context ??= new Ctor()
    const ctx = context
    if (ctx.state === "suspended") void ctx.resume?.().catch(() => {})
    let at = ctx.currentTime + 0.01
    for (const frequency of NOTES[kind]) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.setValueAtTime(frequency, at)
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(VOLUME, at + 0.01)
      gain.gain.linearRampToValueAtTime(0, at + NOTE_S)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(at)
      osc.stop(at + NOTE_S)
      at += NOTE_S + GAP_S
    }
  } catch {
    // A cue is a courtesy: never an error.
  }
}
