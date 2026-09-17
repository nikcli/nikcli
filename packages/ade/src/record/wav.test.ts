import { describe, expect, test } from "bun:test"
import { buildVoiceTrack, readWav, writeWav } from "./wav"

const tone = (sampleRate: number, values: number[], channels = 1) =>
  writeWav({ sampleRate, channels, samples: Int16Array.from(values) })

describe("record/wav", () => {
  test("a WAV reads back as the samples written", () => {
    const pcm = readWav(tone(22050, [0, 1000, -1000, 32767]))
    expect(pcm?.sampleRate).toBe(22050)
    expect(pcm?.channels).toBe(1)
    expect(Array.from(pcm!.samples)).toEqual([0, 1000, -1000, 32767])
  })

  test("anything that is not 16-bit PCM is refused, not guessed at", () => {
    expect(readWav(new ArrayBuffer(10))).toBeUndefined()
    const float = tone(22050, [1, 2])
    new DataView(float).setUint16(20, 3, true) // IEEE float
    expect(readWav(float)).toBeUndefined()
    const text = new TextEncoder().encode("RIFF....WAVEnope, not a wav at all.......").buffer as ArrayBuffer
    expect(readWav(text)).toBeUndefined()
  })

  test("clips land on one timeline at the moment they were said, silence between", () => {
    // 10 samples a second makes the arithmetic readable: 100 ms is one sample.
    const track = buildVoiceTrack(
      [
        { at: 0, wav: tone(10, [5, 5]) },
        { at: 500, wav: tone(10, [7]) },
      ],
      1000,
    )
    expect(track?.skipped).toBe(0)
    expect(Array.from(readWav(track!.wav)!.samples)).toEqual([5, 5, 0, 0, 0, 7, 0, 0, 0, 0])
  })

  test("overlapping sentences are summed and clipped, as they were heard", () => {
    const track = buildVoiceTrack(
      [
        { at: 0, wav: tone(10, [30000, 100]) },
        { at: 0, wav: tone(10, [30000, 100]) },
      ],
      200,
    )
    expect(Array.from(readWav(track!.wav)!.samples)).toEqual([32767, 200])
  })

  test("a clip in another format is left out and counted; a clip past the end is cut", () => {
    const track = buildVoiceTrack(
      [
        { at: 0, wav: tone(10, [1]) },
        { at: 100, wav: tone(20, [9, 9]) },
        { at: 300, wav: tone(10, [4, 4, 4, 4]) },
      ],
      500,
    )
    expect(track?.skipped).toBe(1)
    expect(Array.from(readWav(track!.wav)!.samples)).toEqual([1, 0, 0, 4, 4])
  })

  test("no voice at all gives no track", () => {
    expect(buildVoiceTrack([], 1000)).toBeUndefined()
    expect(buildVoiceTrack([{ at: 0, wav: new ArrayBuffer(4) }], 1000)).toBeUndefined()
  })
})
