/**
 * How loud the assistant's voice is, moment by moment, while it speaks.
 *
 * S33: the agent's orb moves with the voice. The level is read from the WAV
 * Piper already returned, not from an audio graph: routing the `<audio>`
 * element through a Web Audio analyser would take its output away from
 * `setSinkId`, and the user's chosen output device with it. The WAV is in
 * hand before a sample plays, so its loudness is measured once, a frame every
 * 20 ms, and read back at the element's `currentTime` while it plays.
 *
 * The system voice (Web Speech) exposes no samples at all. While it speaks the
 * meter reports a syllable-like pulse instead, so the orb still reads as
 * speaking rather than freezing on the one voice that cannot be measured.
 */

import { createSignal, type Accessor } from "solid-js"

export interface Envelope {
  /** Loudness per frame, 0–1, relative to the loudest frame of the clip. */
  readonly frames: Float32Array
  /** Length of one frame in seconds. */
  readonly frameSeconds: number
}

const EMPTY: Envelope = { frames: new Float32Array(0), frameSeconds: 0.02 }

/**
 * Loudness frames of a PCM WAV (8, 16, 24 or 32-bit integer, any channel
 * count). Anything else — a compressed or broken file — gives an empty
 * envelope, which reads as silence rather than as an error.
 */
export function wavEnvelope(wav: ArrayBuffer, frameSeconds = 0.02): Envelope {
  const view = new DataView(wav)
  if (wav.byteLength < 12 || text(view, 0, 4) !== "RIFF" || text(view, 8, 4) !== "WAVE") return EMPTY

  let channels = 0
  let sampleRate = 0
  let bits = 0
  let format = 0
  let dataOffset = -1
  let dataLength = 0
  for (let offset = 12; offset + 8 <= wav.byteLength; ) {
    const id = text(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === "fmt " && body + 16 <= wav.byteLength) {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === "data") {
      dataOffset = body
      // Piper streams its header before it knows the length; trust the file over the field.
      dataLength = Math.min(size, wav.byteLength - body)
      break
    }
    offset = body + size + (size % 2)
  }

  const bytes = bits / 8
  if (format !== 1 || channels < 1 || sampleRate < 1 || ![1, 2, 3, 4].includes(bytes) || dataOffset < 0) return EMPTY

  const samplesPerFrame = Math.max(1, Math.round(sampleRate * frameSeconds))
  const blockAlign = bytes * channels
  const totalSamples = Math.floor(dataLength / blockAlign)
  const frames = new Float32Array(Math.ceil(totalSamples / samplesPerFrame))
  const full = 2 ** (bits - 1)

  let peak = 0
  for (let f = 0; f < frames.length; f++) {
    const start = f * samplesPerFrame
    const end = Math.min(totalSamples, start + samplesPerFrame)
    let sum = 0
    for (let s = start; s < end; s++) {
      const at = dataOffset + s * blockAlign
      let mixed = 0
      for (let c = 0; c < channels; c++) mixed += sample(view, at + c * bytes, bytes) / full
      mixed /= channels
      sum += mixed * mixed
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start))
    frames[f] = rms
    if (rms > peak) peak = rms
  }
  if (peak > 0) for (let f = 0; f < frames.length; f++) frames[f] = Math.sqrt(frames[f]! / peak)
  return { frames, frameSeconds }
}

/** The envelope's value at `seconds`, 0 outside the clip. */
export function levelAt(envelope: Envelope, seconds: number): number {
  if (!(seconds >= 0)) return 0
  const index = Math.floor(seconds / envelope.frameSeconds)
  return envelope.frames[index] ?? 0
}

/**
 * A pulse with the rhythm of speech: syllables at about five a second, and a
 * short gap now and then where a word ends. For the voice that has no samples.
 */
export function syntheticSpeechLevel(seconds: number): number {
  const word = Math.sin(seconds * 1.7) + Math.sin(seconds * 0.63 + 1.3) * 0.8
  if (word < -0.9) return 0.05
  const syllable = Math.max(0, Math.sin(seconds * 31)) ** 0.6
  return 0.35 + 0.55 * syllable * (0.6 + 0.4 * Math.sin(seconds * 7.3))
}

export interface PlaybackMeter {
  /**
   * True while a reply is being spoken: from its first sound to its end, the
   * pauses between its sentences included. Reactive.
   */
  readonly speaking: Accessor<boolean>
  /** Loudness now, 0–1. Read every frame by whoever draws; not reactive. */
  level(): number
  /** A measured clip is playing; `position` is its current time in seconds. Returns the stop. */
  track(envelope: Envelope, position: () => number): () => void
  /** A voice without samples is speaking. Returns the stop. */
  pulse(): () => void
  /**
   * True from the moment a reply is handed to the speaker until it has been
   * spoken, including the synthesis before the first sentence and the gaps
   * between sentences. Reactive.
   */
  readonly replying: Accessor<boolean>
  /** A reply is on its way to the speaker. Returns the stop. */
  reply(): () => void
}

export function createPlaybackMeter(now: () => number = () => performance.now() / 1000): PlaybackMeter {
  const [sounding, setSounding] = createSignal(false)
  let source: (() => number) | undefined
  let generation = 0
  const [replies, setReplies] = createSignal(0)
  /** The reply now under way has already made a sound: its pauses are still speech. */
  const [sounded, setSounded] = createSignal(false)

  const begin = (read: () => number) => {
    const mine = ++generation
    source = read
    setSounding(true)
    if (replies() > 0) setSounded(true)
    return () => {
      if (mine !== generation) return
      source = undefined
      setSounding(false)
    }
  }

  return {
    speaking: () => sounding() || (replies() > 0 && sounded()),
    level: () => (source ? Math.max(0, Math.min(1, source())) : 0),
    track: (envelope, position) => begin(() => levelAt(envelope, position())),
    pulse: () => {
      const started = now()
      return begin(() => syntheticSpeechLevel(now() - started))
    },
    replying: () => replies() > 0,
    reply: () => {
      setReplies((count) => count + 1)
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        setReplies((count) => count - 1)
        if (replies() === 0) setSounded(false)
      }
    },
  }
}

function text(view: DataView, offset: number, length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i))
  return out
}

function sample(view: DataView, at: number, bytes: number): number {
  if (bytes === 1) return view.getUint8(at) - 128
  if (bytes === 2) return view.getInt16(at, true)
  if (bytes === 3) {
    const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
    return value & 0x800000 ? value - 0x1000000 : value
  }
  return view.getInt32(at, true)
}
