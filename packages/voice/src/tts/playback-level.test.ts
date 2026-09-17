import { describe, expect, test } from "bun:test"
import { createPlaybackMeter, levelAt, syntheticSpeechLevel, wavEnvelope } from "./playback-level"

/** A mono 16-bit WAV: `silent` seconds of silence, then `loud` seconds of a sine at `amplitude`. */
function wav(silent: number, loud: number, amplitude = 0.5, sampleRate = 8000, streamedHeader = false): ArrayBuffer {
  const samples = Math.round((silent + loud) * sampleRate)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const write = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  write(0, "RIFF")
  view.setUint32(4, 36 + samples * 2, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, streamedHeader ? 0xffffffff : samples * 2, true)
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate
    const value = t < silent ? 0 : Math.sin(2 * Math.PI * 220 * t) * amplitude
    view.setInt16(44 + i * 2, Math.round(value * 32767), true)
  }
  return buffer
}

describe("tts/playback-level", () => {
  test("a WAV's envelope is silent where it is silent and full where it is loudest", () => {
    const envelope = wavEnvelope(wav(0.2, 0.2))
    expect(envelope.frames.length).toBe(20)
    expect(levelAt(envelope, 0.1)).toBe(0)
    expect(levelAt(envelope, 0.3)).toBeGreaterThan(0.95)
    expect(levelAt(envelope, 5)).toBe(0)
    expect(levelAt(envelope, Number.NaN)).toBe(0)
  })

  test("quieter speech reads lower, relative to the clip's own peak", () => {
    const buffer = wav(0, 0.2, 0.5)
    const view = new DataView(buffer)
    // Halve the second half.
    for (let i = 44 + 800; i < buffer.byteLength; i += 2) view.setInt16(i, Math.round(view.getInt16(i, true) / 4), true)
    const envelope = wavEnvelope(buffer)
    expect(levelAt(envelope, 0.15)).toBeLessThan(levelAt(envelope, 0.05))
  })

  test("a header written before the length was known still reads the samples that are there", () => {
    expect(wavEnvelope(wav(0, 0.1, 0.5, 8000, true)).frames.length).toBe(5)
  })

  test("anything that is not PCM WAV is silence, not an error", () => {
    expect(wavEnvelope(new ArrayBuffer(0)).frames.length).toBe(0)
    expect(wavEnvelope(new TextEncoder().encode("not a wav at all, really").buffer as ArrayBuffer).frames.length).toBe(0)
  })

  test("the meter speaks while a clip is tracked, follows its position, and a stale stop does nothing", () => {
    const meter = createPlaybackMeter()
    const envelope = wavEnvelope(wav(0.2, 0.2))
    let position = 0.1
    expect(meter.speaking()).toBe(false)

    const stopFirst = meter.track(envelope, () => position)
    expect(meter.speaking()).toBe(true)
    expect(meter.level()).toBe(0)
    position = 0.3
    expect(meter.level()).toBeGreaterThan(0.95)

    // The next sentence starts before the first one's stop arrives.
    const stopSecond = meter.track(envelope, () => 0.3)
    stopFirst()
    expect(meter.speaking()).toBe(true)
    stopSecond()
    expect(meter.speaking()).toBe(false)
    expect(meter.level()).toBe(0)
  })

  test("a reply counts from its synthesis to its last sentence, and each stop counts once", () => {
    const meter = createPlaybackMeter()
    expect(meter.replying()).toBe(false)
    const first = meter.reply()
    const second = meter.reply()
    expect(meter.replying()).toBe(true)
    expect(meter.speaking()).toBe(false)
    first()
    first()
    expect(meter.replying()).toBe(true)
    second()
    expect(meter.replying()).toBe(false)
  })

  test("the pause between two sentences of a reply is still speaking; the end of the reply is not", () => {
    const meter = createPlaybackMeter()
    const envelope = wavEnvelope(wav(0.2, 0.2))
    const done = meter.reply()
    expect(meter.speaking()).toBe(false)
    meter.track(envelope, () => 0.3)()
    expect(meter.speaking()).toBe(true)
    expect(meter.level()).toBe(0)
    done()
    expect(meter.speaking()).toBe(false)
    // The next reply starts silent again, until its own first sound.
    const next = meter.reply()
    expect(meter.speaking()).toBe(false)
    next()
  })

  test("the system voice pulses between a floor and a ceiling", () => {
    let clock = 0
    const meter = createPlaybackMeter(() => clock)
    const stop = meter.pulse()
    const seen: number[] = []
    for (clock = 0; clock < 4; clock += 0.013) seen.push(meter.level())
    stop()
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...seen)).toBeLessThanOrEqual(1)
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.4)
    for (let s = 0; s < 10; s += 0.1) expect(syntheticSpeechLevel(s)).toBeLessThanOrEqual(0.9)
  })
})
