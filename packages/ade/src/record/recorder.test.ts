import { describe, expect, test } from "bun:test"
import { createRecorder, eventsPathFor } from "./recorder"
import type { RecordState, RecordTarget } from "./recording"

const T0 = new Date(2026, 8, 16, 9, 5, 3).getTime()

function setup(
  overrides: {
    start?: () => Promise<{ path: string | null }>
    stop?: () => Promise<{ path: string | null }>
    dir?: () => string | undefined
  } = {},
) {
  const started: { target: RecordTarget; dir: string; name: string }[] = []
  const written: { path: string; text: string }[] = []
  const states: RecordState[] = []
  let now = T0
  const recorder = createRecorder({
    start: overrides.start
      ? (target, dir, name) => {
          started.push({ target, dir, name })
          return overrides.start!()
        }
      : async (target, dir, name) => {
          started.push({ target, dir, name })
          return { path: `${dir}/${name}.mp4` }
        },
    stop: overrides.stop ?? (async () => ({ path: "C:/video/ADE 2026-09-16 09.05.03.mp4" })),
    writeText: async (path, text) => {
      written.push({ path, text })
    },
    dir: overrides.dir ?? (() => "C:/video"),
    now: () => now,
    onState: (state) => states.push(state),
  })
  return { recorder, started, written, states, advance: (ms: number) => (now += ms) }
}

describe("record/recorder", () => {
  test("a take writes the events beside the video, and only what was noted", async () => {
    const { recorder, started, written, advance } = setup()

    expect(await recorder.start({ kind: "window" })).toBeUndefined()
    expect(started[0]).toEqual({ target: { kind: "window" }, dir: "C:/video", name: "ADE 2026-09-16 09.05.03" })

    advance(500)
    recorder.note({ kind: "click", at: T0 + 500, x: 12, y: 34, button: "left" })
    recorder.note({ kind: "command", at: T0 + 700, id: "session.new" })
    expect(await recorder.stop()).toBeUndefined()

    expect(written).toHaveLength(1)
    expect(written[0]!.path).toBe("C:/video/ADE 2026-09-16 09.05.03.events.jsonl")
    expect(written[0]!.text.trimEnd().split("\n")).toHaveLength(2)
    expect(recorder.state()).toEqual({ status: "idle" })
  })

  test("nothing noted, no events file: an empty one would read as an empty take", async () => {
    const { recorder, written } = setup()
    await recorder.start({ kind: "window" })
    await recorder.stop()
    expect(written).toEqual([])
  })

  test("a second take is refused while one runs, and notes outside a take are dropped", async () => {
    const { recorder, started, written } = setup()
    await recorder.start({ kind: "window" })
    expect(await recorder.start({ kind: "window" })).toContain("già in corso")
    expect(started).toHaveLength(1)

    await recorder.stop()
    recorder.note({ kind: "click", at: T0 + 10, x: 1, y: 1, button: "left" })
    await recorder.stop()
    expect(written).toEqual([])
  })

  test("without a folder nothing is started, and the user is told which one to pick", async () => {
    const { recorder, started } = setup({ dir: () => undefined })
    expect(await recorder.start({ kind: "window" })).toContain("cartella")
    expect(started).toEqual([])
    expect(recorder.state()).toEqual({ status: "idle" })
  })

  test("a capture that fails to start leaves ADE idle, with the reason", async () => {
    const { recorder, states } = setup({ start: async () => Promise.reject(new Error("Windows 10 1809 non basta")) })
    expect(await recorder.start({ kind: "window" })).toBe("Windows 10 1809 non basta")
    expect(recorder.state()).toEqual({ status: "idle" })
    expect(states).toEqual([])
  })

  test("a capture that fails to close still saves the events, next to where the video was going", async () => {
    const { recorder, written } = setup({ stop: async () => Promise.reject(new Error("file non chiuso")) })
    await recorder.start({ kind: "window" })
    recorder.note({ kind: "said", at: T0 + 10, text: "Fatto." })
    expect(await recorder.stop()).toBe("file non chiuso")
    expect(written[0]!.path).toBe("C:/video/ADE 2026-09-16 09.05.03.events.jsonl")
    expect(recorder.state()).toEqual({ status: "idle" })
  })

  test("the events file is the video's name, whatever the video is called", () => {
    expect(eventsPathFor("C:/video/ADE 2026.mp4")).toBe("C:/video/ADE 2026.events.jsonl")
    expect(eventsPathFor("C:/video/ADE 2026.MP4")).toBe("C:/video/ADE 2026.events.jsonl")
  })
})

describe("record/recorder tracks", () => {
  const wav = (values: number[]) => {
    const samples = Int16Array.from(values)
    const buffer = new ArrayBuffer(44 + samples.length * 2)
    const view = new DataView(buffer)
    const text = (offset: number, value: string) =>
      [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
    text(0, "RIFF")
    view.setUint32(4, 36 + samples.length * 2, true)
    text(8, "WAVE")
    text(12, "fmt ")
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 10, true)
    view.setUint32(28, 20, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    text(36, "data")
    view.setUint32(40, samples.length * 2, true)
    samples.forEach((s, i) => view.setInt16(44 + i * 2, s, true))
    return buffer
  }

  function withTracks(mic?: { extension: string; bytes?: Uint8Array; refuse?: boolean }) {
    const bytes: { path: string; size: number }[] = []
    const texts: { path: string; text: string }[] = []
    let now = T0
    const recorder = createRecorder({
      start: async (_target, dir, name) => ({ path: `${dir}/${name}.mp4` }),
      stop: async () => ({ path: "C:/video/ADE.mp4" }),
      writeText: async (path, text) => {
        texts.push({ path, text })
      },
      writeBytes: async (path, data) => {
        bytes.push({ path, size: data.length })
      },
      startMic: mic
        ? async () =>
            mic.refuse ? Promise.reject(new Error("negato")) : { extension: mic.extension, stop: async () => mic.bytes }
        : undefined,
      frame: () => ({ width: 1440, height: 900, dpr: 1.25 }),
      dir: () => "C:/video",
      now: () => now,
      onState: () => {},
    })
    return { recorder, bytes, texts, advance: (ms: number) => (now += ms) }
  }

  test("the voice, the microphone and the events each get a file beside the video", async () => {
    const { recorder, bytes, texts, advance } = withTracks({ extension: "webm", bytes: new Uint8Array([1, 2, 3]) })
    await recorder.start({ kind: "window" }, { mic: true })
    advance(200)
    recorder.noteVoice(wav([100, 100]), "Ci sono due sessioni.")
    advance(800)
    expect(await recorder.stop()).toBeUndefined()

    expect(bytes.map((file) => file.path)).toEqual(["C:/video/ADE.voce.wav", "C:/video/ADE.microfono.webm"])
    expect(bytes[1]!.size).toBe(3)
    const lines = texts[0]!.text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
    // The frame comes first, so the export can map page pixels to the video.
    expect(lines[0]).toMatchObject({ kind: "frame", at: 0, width: 1440, dpr: 1.25 })
    expect(lines[1]).toEqual({ kind: "said", at: 200, text: "Ci sono due sessioni." })
    // 1 s at 10 samples a second: the voice track lasts as long as the take.
    expect(bytes[0]!.size).toBe(44 + 10 * 2)
  })

  test("a refused microphone records the take anyway, without that track", async () => {
    const { recorder, bytes } = withTracks({ extension: "webm", refuse: true })
    expect(await recorder.start({ kind: "window" }, { mic: true })).toBeUndefined()
    expect(recorder.state().status).toBe("recording")
    await recorder.stop()
    expect(bytes).toEqual([])
  })

  test("the state says whether the microphone is being recorded", async () => {
    const { recorder } = withTracks({ extension: "webm", bytes: new Uint8Array([1]) })
    await recorder.start({ kind: "window" }, { mic: true })
    const on = recorder.state()
    expect(on.status === "recording" && on.recording.mic).toBe(true)
    await recorder.stop()
    await recorder.start({ kind: "window" })
    const off = recorder.state()
    expect(off.status === "recording" && off.recording.mic).toBe(false)
    await recorder.stop()
  })

  test("the microphone stays closed unless the take asked for it", async () => {
    let opened = 0
    const recorder = createRecorder({
      start: async (_target, dir, name) => ({ path: `${dir}/${name}.mp4` }),
      stop: async () => ({ path: "C:/video/ADE.mp4" }),
      writeText: async () => {},
      writeBytes: async () => {},
      startMic: async () => {
        opened++
        return { extension: "webm", stop: async () => new Uint8Array([1]) }
      },
      dir: () => "C:/video",
      now: () => T0,
      onState: () => {},
    })
    await recorder.start({ kind: "window" })
    await recorder.stop()
    await recorder.start({ kind: "window" }, { mic: false })
    await recorder.stop()
    expect(opened).toBe(0)
  })

  test("a voice clip said outside a take is not kept for the next one", async () => {
    const { recorder, bytes } = withTracks()
    recorder.noteVoice(wav([1]))
    await recorder.start({ kind: "window" })
    await recorder.stop()
    expect(bytes).toEqual([])
  })
})
