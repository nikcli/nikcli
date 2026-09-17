/**
 * The assistant's voice as a track of its own (S36).
 *
 * Every sentence the assistant says is a WAV that ADE itself synthesised
 * (Piper, `tts.rs`), so there is nothing to capture from the sound card: the
 * clips are kept as they are played, with the moment each one started, and
 * laid end to end on one silent timeline when the take stops. That is a clean
 * track — no room noise, no system sounds, no music the user had on — which is
 * exactly what an editor wants for a voice-over.
 *
 * 16-bit PCM only, because that is what Piper writes. A clip in any other
 * shape is left out and counted, rather than guessed at.
 */

export interface Pcm {
  readonly sampleRate: number
  readonly channels: number
  /** Interleaved 16-bit samples. */
  readonly samples: Int16Array
}

export interface VoiceClip {
  /** Milliseconds from the start of the take. */
  readonly at: number
  readonly wav: ArrayBuffer
}

const ascii = (view: DataView, offset: number, length: number) =>
  String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)))

/** Reads a 16-bit PCM WAV, or nothing when it is not one. */
export function readWav(wav: ArrayBuffer): Pcm | undefined {
  if (wav.byteLength < 44) return undefined
  const view = new DataView(wav)
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") return undefined

  let offset = 12
  let format: { channels: number; sampleRate: number; bits: number; code: number } | undefined
  while (offset + 8 <= wav.byteLength) {
    const id = ascii(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === "fmt ") {
      format = {
        code: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    } else if (id === "data") {
      if (!format || format.code !== 1 || format.bits !== 16 || format.channels < 1) return undefined
      // A streamed WAV can declare more data than it holds: read what is there.
      const available = Math.min(size, wav.byteLength - body)
      const count = Math.floor(available / 2)
      const samples = new Int16Array(count)
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(body + i * 2, true)
      return { sampleRate: format.sampleRate, channels: format.channels, samples }
    }
    offset = body + size + (size % 2)
  }
  return undefined
}

/** A 16-bit PCM WAV around `pcm`. */
export function writeWav(pcm: Pcm): ArrayBuffer {
  const bytes = pcm.samples.length * 2
  const buffer = new ArrayBuffer(44 + bytes)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, "RIFF")
  view.setUint32(4, 36 + bytes, true)
  text(8, "WAVE")
  text(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, pcm.channels, true)
  view.setUint32(24, pcm.sampleRate, true)
  view.setUint32(28, pcm.sampleRate * pcm.channels * 2, true)
  view.setUint16(32, pcm.channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, bytes, true)
  for (let i = 0; i < pcm.samples.length; i++) view.setInt16(44 + i * 2, pcm.samples[i]!, true)
  return buffer
}

export interface VoiceTrack {
  readonly wav: ArrayBuffer
  /** Clips that were not 16-bit PCM in the track's own format. */
  readonly skipped: number
}

/**
 * The clips on one timeline as long as the take, silence between them.
 *
 * The first readable clip sets the format. Two sentences that overlap — a new
 * one started before the old one was stopped — are summed and clipped, as the
 * listener heard them. Nothing at all to lay out gives no track.
 */
export function buildVoiceTrack(clips: readonly VoiceClip[], durationMs: number): VoiceTrack | undefined {
  const read = clips.map((clip) => ({ at: clip.at, pcm: readWav(clip.wav) }))
  const first = read.find((clip) => clip.pcm)?.pcm
  if (!first) return undefined

  const { sampleRate, channels } = first
  const frames = Math.max(0, Math.round((durationMs / 1000) * sampleRate))
  const out = new Int16Array(frames * channels)
  let skipped = 0
  for (const clip of read) {
    if (!clip.pcm || clip.pcm.sampleRate !== sampleRate || clip.pcm.channels !== channels) {
      skipped++
      continue
    }
    const start = Math.max(0, Math.round((clip.at / 1000) * sampleRate)) * channels
    const room = Math.max(0, out.length - start)
    const length = Math.min(clip.pcm.samples.length, room)
    for (let i = 0; i < length; i++) {
      const sum = out[start + i]! + clip.pcm.samples[i]!
      out[start + i] = Math.max(-32768, Math.min(32767, sum))
    }
  }
  return { wav: writeWav({ sampleRate, channels, samples: out }), skipped }
}
