import { describe, expect, test } from "bun:test"
import { createOpenRouterTranscriber, NAME_PROBE_MS, wavHead, type NameGate } from "./openrouter"
import { createMicCapture, encodeWav } from "../audio/capture"
import { matchesWakeWord } from "../settings/wake-word"

const wavOf = (ms: number) => encodeWav(new Float32Array(Math.round((16000 * ms) / 1000)).fill(0.1), 16000)

/** One transcriber whose service answers from `answers`, in order, and records how much audio each request carried. */
function setup(answers: string[], gate: Partial<NameGate> & { active?: () => boolean } = {}) {
  const sent: number[] = []
  const finals: string[] = []
  const rejected: string[] = []
  const accepted: boolean[] = []
  const fetch = async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body)
    sent.push(Buffer.from(body.input_audio.data, "base64").length - 44)
    return new Response(JSON.stringify({ text: answers.shift() ?? "" }), { status: 200 })
  }
  let segmentCb: any = null
  const capture = createMicCapture({ mediaStream: { getTracks: () => [] } as any, isTypeSupported: () => true })
  capture.onSegment = (cb: any) => {
    segmentCb = cb
  }
  const transcriber = createOpenRouterTranscriber({
    apiKey: "test-key",
    capture,
    fetch: fetch as any,
    onFinal: (event) => finals.push(event.text),
    nameGate: {
      active: gate.active ?? (() => true),
      accepts: (text) => matchesWakeWord(text, "ei nik").matched,
      onRejected: (text) => rejected.push(text),
      onAccepted: () => accepted.push(true),
    },
  })
  const hear = async (ms: number) => {
    await transcriber.start()
    await segmentCb({ blob: wavOf(ms), format: "wav", mimeType: "audio/wav", durationMs: ms })
  }
  return { sent, finals, rejected, hear, accepted }
}

const bytesFor = (ms: number) => Math.floor((16000 * ms) / 1000) * 2

describe("while it waits for the name, only the start of a sentence goes to the cloud", () => {
  test("a long sentence from the room costs one second and a half, and is shown as ignored", async () => {
    const { sent, finals, rejected, hear } = setup(["il governo ha approvato"])
    await hear(8_000)
    expect(sent).toEqual([bytesFor(NAME_PROBE_MS)])
    expect(finals).toEqual([])
    expect(rejected).toEqual(["il governo ha approvato"])
  })

  test("a long sentence that calls it is then sent whole", async () => {
    const { sent, finals, hear, accepted } = setup(["ehi nik raccontami", "ehi nik raccontami la storia di Roma"])
    await hear(6_000)
    // Said as soon as the start is heard, before the rest comes back.
    expect(accepted).toEqual([true])
    expect(sent).toEqual([bytesFor(NAME_PROBE_MS), bytesFor(6_000)])
    expect(finals).toEqual(["ehi nik raccontami la storia di Roma"])
  })

  test("a short sentence is sent whole at once: cutting it would save nothing", async () => {
    const { sent, finals, hear } = setup(["ei nik stop"])
    await hear(1_800)
    expect(sent).toEqual([bytesFor(1_800)])
    expect(finals).toEqual(["ei nik stop"])
  })

  test("when the name is not needed — awake, answering, at work — the sentence goes whole", async () => {
    const { sent, finals, hear } = setup(["sì, chiudilo pure, grazie"], { active: () => false })
    await hear(5_000)
    expect(sent).toEqual([bytesFor(5_000)])
    expect(finals).toEqual(["sì, chiudilo pure, grazie"])
  })
})

describe("wavHead", () => {
  test("keeps the header valid for the shorter audio", async () => {
    const head = (await wavHead(wavOf(4_000), 1_500))!
    const view = new DataView(await head.arrayBuffer())
    expect(head.size).toBe(44 + bytesFor(1_500))
    expect(view.getUint32(4, true)).toBe(36 + bytesFor(1_500))
    expect(view.getUint32(40, true)).toBe(bytesFor(1_500))
    expect(view.getUint32(24, true)).toBe(16000)
  })

  test("leaves alone what it cannot cut", async () => {
    expect(
      await wavHead(new Blob(["not a wav file at all, just some bytes long enough to pass the size check"]), 1_500),
    ).toBeUndefined()
    expect(await wavHead(wavOf(1_000), 1_500)).toBeUndefined()
  })
})

describe("what the gate counts", () => {
  test("every request sent while it waits for the name, and none otherwise", async () => {
    let counted = 0
    const make = (active: boolean, answers: string[]) => {
      let segmentCb: any = null
      const capture = createMicCapture({ mediaStream: { getTracks: () => [] } as any, isTypeSupported: () => true })
      capture.onSegment = (cb: any) => {
        segmentCb = cb
      }
      const transcriber = createOpenRouterTranscriber({
        apiKey: "k",
        capture,
        fetch: (async () => new Response(JSON.stringify({ text: answers.shift() ?? "" }), { status: 200 })) as any,
        nameGate: {
          active: () => active,
          accepts: (text) => matchesWakeWord(text, "ei nik").matched,
          onRequest: () => counted++,
        },
      })
      return async (ms: number) => {
        await transcriber.start()
        await segmentCb({ blob: wavOf(ms), format: "wav", mimeType: "audio/wav", durationMs: ms })
      }
    }
    await make(true, ["la televisione"])(6_000) // one probe
    expect(counted).toBe(1)
    await make(true, ["ei nik apri", "ei nik apri il browser"])(6_000) // probe and whole
    expect(counted).toBe(3)
    await make(true, ["ok"])(1_000) // short, whole
    expect(counted).toBe(4)
    await make(false, ["sì"])(6_000) // not waiting: not counted
    expect(counted).toBe(4)
  })
})

describe("what cannot be cut, and when the sentence was said", () => {
  test("a long sentence that cannot be cut is not sent while it waits for the name", async () => {
    let uncut = 0
    let requests = 0
    let segmentCb: any = null
    const capture = createMicCapture({ mediaStream: { getTracks: () => [] } as any, isTypeSupported: () => true })
    capture.onSegment = (cb: any) => {
      segmentCb = cb
    }
    const transcriber = createOpenRouterTranscriber({
      apiKey: "k",
      capture,
      fetch: (async () => {
        requests++
        return new Response(JSON.stringify({ text: "x" }), { status: 200 })
      }) as any,
      nameGate: { active: () => true, accepts: () => true, onUncut: () => uncut++ },
    })
    await transcriber.start()
    await segmentCb({ blob: new Blob(["webm bytes"]), format: "webm", mimeType: "audio/webm", durationMs: 5_000 })
    expect(requests).toBe(0)
    expect(uncut).toBe(1)
    // Short, it goes whole whatever it is.
    await segmentCb({ blob: new Blob(["webm bytes"]), format: "webm", mimeType: "audio/webm", durationMs: 1_000 })
    expect(requests).toBe(1)
  })

  test("the gate is asked about the moment the sentence began, and the event carries it", async () => {
    const asked: number[] = []
    const events: any[] = []
    let segmentCb: any = null
    const capture = createMicCapture({ mediaStream: { getTracks: () => [] } as any, isTypeSupported: () => true })
    capture.onSegment = (cb: any) => {
      segmentCb = cb
    }
    const transcriber = createOpenRouterTranscriber({
      apiKey: "k",
      capture,
      now: () => 100_000,
      onFinal: (event) => events.push(event),
      fetch: (async () => new Response(JSON.stringify({ text: "annulla" }), { status: 200 })) as any,
      nameGate: { active: (at) => (asked.push(at), false), accepts: () => true },
    })
    await transcriber.start()
    await segmentCb({ blob: wavOf(6_000), format: "wav", mimeType: "audio/wav", durationMs: 6_000 })
    expect(asked).toEqual([94_000])
    expect(events[0]).toMatchObject({ text: "annulla", spokenAt: 94_000 })
  })
})

describe("the start of a long sentence is heard before it ends", () => {
  test("sent once, while the speaker goes on, and not again when the sentence closes", async () => {
    let clock = 10_000
    const sent: { bytes: number; at: number }[] = []
    const answers = ["ei nik raccontami", "ei nik raccontami la storia di Roma"]
    const finals: string[] = []
    const capture = createMicCapture({
      now: () => clock,
      preferredFormat: "wav",
      mediaStream: { getTracks: () => [] } as any,
      isTypeSupported: () => true,
      speechDetectorConfig: { silenceDurationMs: 800 },
    })
    const transcriber = createOpenRouterTranscriber({
      apiKey: "k",
      capture,
      now: () => clock,
      fetch: (async (_url: unknown, init: any) => {
        sent.push({ bytes: Buffer.from(JSON.parse(init.body).input_audio.data, "base64").length - 44, at: clock })
        return new Response(JSON.stringify({ text: answers.shift() ?? "" }), { status: 200 })
      }) as any,
      onFinal: (event) => finals.push(event.text),
      nameGate: { active: () => true, accepts: (text) => matchesWakeWord(text, "ei nik").matched },
    })
    await transcriber.start()
    const frame = (level: number) => {
      clock += 20
      capture.processAudioFrame(new Float32Array(320).fill(level))
    }
    for (let i = 0; i < 150; i++) frame(0.2) // three seconds of speech
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.bytes).toBe(bytesFor(NAME_PROBE_MS))
    for (let i = 0; i < 50; i++) frame(0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(sent).toHaveLength(2)
    expect(sent[1]!.bytes).toBeGreaterThan(bytesFor(NAME_PROBE_MS))
    expect(finals).toEqual(["ei nik raccontami la storia di Roma"])
  })
})
