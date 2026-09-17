import { describe, expect, test } from "bun:test"
import { parseRequest } from "../panels/protocol"
import { runVideoCommand, type VideoController } from "./commands"
import type { VideoState } from "./video"

/**
 * A video element's behaviour, reduced to what the commands can see.
 *
 * It clamps like a real one and it ignores a seek past the end the same way,
 * because the bug the commands exist to prevent is reporting a seek that did
 * not happen.
 */
function controller(initial: Partial<VideoState> = {}) {
  let state: VideoState = {
    source: "out/demo.mp4",
    playing: false,
    position: 0,
    duration: 60,
    rate: 1,
    ...initial,
  }
  const calls: string[] = []
  let playRejects: Error | undefined
  let captureRejects: Error | undefined

  const api: VideoController & {
    calls: string[]
    rejectPlay: (error: Error) => void
    rejectCapture: (error: Error) => void
  } = {
    calls,
    rejectPlay: (error) => (playRejects = error),
    rejectCapture: (error) => (captureRejects = error),
    state: () => state,
    open: async (path) => {
      calls.push(`open ${path}`)
      state = { ...state, source: path, position: 0, playing: false }
      return path
    },
    play: async () => {
      calls.push("play")
      if (playRejects) throw playRejects
      state = { ...state, playing: true }
    },
    pause: () => {
      calls.push("pause")
      state = { ...state, playing: false }
    },
    seek: async (seconds) => {
      calls.push(`seek ${seconds}`)
      const landed = Math.min(Math.max(seconds, 0), state.duration)
      state = { ...state, position: landed }
      return landed
    },
    setRate: (rate) => {
      calls.push(`rate ${rate}`)
      state = { ...state, rate }
    },
    capture: async () => {
      calls.push("capture")
      if (captureRejects) throw captureRejects
      return "C:/shots/demo-0-00-0.png"
    },
  }
  return api
}

const ask = (text: string) => parseRequest(text)!

describe("open", () => {
  test("opens a playable file and says which", async () => {
    const video = controller({ source: undefined })
    const outcome = await runVideoCommand(video, ask("@ade video open out/demo.mp4"))
    expect(outcome).toEqual({ ok: true, detail: "aperto out/demo.mp4" })
    expect(video.calls).toEqual(["open out/demo.mp4"])
  })

  /*
   * Named formats, not just a refusal: an agent told only "non riproducibile"
   * tries the same file again with a different verb.
   */
  test("a container the engine cannot play is refused by name", async () => {
    const outcome = await runVideoCommand(controller(), ask("@ade video open film.mkv"))
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toInclude("mp4")
  })

  test("no path is a reason, not a crash", async () => {
    const outcome = await runVideoCommand(controller(), ask("@ade video open"))
    expect(outcome).toEqual({ ok: false, reason: "manca il percorso del file" })
  })

  test("a host that refuses says why", async () => {
    const video = controller()
    video.open = async () => {
      throw new Error("file non trovato")
    }
    const outcome = await runVideoCommand(video, ask("@ade video open a.mp4"))
    expect(outcome).toEqual({ ok: false, reason: "file non trovato" })
  })
})

describe("play and pause", () => {
  test("play reports the state it reached", async () => {
    const outcome = await runVideoCommand(controller(), ask("@ade video play"))
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.detail).toInclude("in riproduzione")
  })

  /*
   * A webview refuses autoplay by rejecting, not by staying still. Reported
   * as a success, the agent would capture frames that never move.
   */
  test("a refused autoplay is a failure, not a success", async () => {
    const video = controller()
    video.rejectPlay(new Error("NotAllowedError: play() richiede un gesto"))
    const outcome = await runVideoCommand(video, ask("@ade video play"))
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toInclude("NotAllowedError")
  })

  test("pause reports the state it reached", async () => {
    const outcome = await runVideoCommand(controller({ playing: true }), ask("@ade video pause"))
    expect(outcome.ok && outcome.detail).toInclude("in pausa")
  })

  test("with nothing open, every verb says so instead of pretending", async () => {
    const empty = controller({ source: undefined })
    for (const verb of ["play", "pause", "seek 5", "step 1", "rate 2", "capture"]) {
      const outcome = await runVideoCommand(empty, ask(`@ade video ${verb}`))
      expect(outcome).toEqual({ ok: false, reason: "nessun video aperto" })
    }
    expect(empty.calls).toEqual([])
  })
})

describe("seek", () => {
  test("seeks and reports where it landed", async () => {
    const outcome = await runVideoCommand(controller(), ask("@ade video seek 1:03"))
    expect(outcome).toEqual({ ok: true, detail: "a 1:00.0 (fine del video)" })
  })

  test("a seek inside the video has no note attached", async () => {
    const outcome = await runVideoCommand(controller(), ask("@ade video seek 12.5"))
    expect(outcome).toEqual({ ok: true, detail: "a 0:12.5" })
  })

  test("a time that is not a time is refused with the form it wanted", async () => {
    const outcome = await runVideoCommand(controller(), ask("@ade video seek inizio"))
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toInclude("1:03")
  })

  test("no time at all is a reason", async () => {
    const outcome = await runVideoCommand(controller(), ask("@ade video seek"))
    expect(outcome.ok).toBe(false)
  })
})

describe("step", () => {
  test("moves forward from where it is", async () => {
    const outcome = await runVideoCommand(controller({ position: 10 }), ask("@ade video step 2.5"))
    expect(outcome).toEqual({ ok: true, detail: "a 0:12.5" })
  })

  test("moves backwards, and stops at the start", async () => {
    const outcome = await runVideoCommand(controller({ position: 1 }), ask("@ade video step -5"))
    expect(outcome).toEqual({ ok: true, detail: "a 0:00.0" })
  })

  test("a comma decimal is read, because that is how it will be written", async () => {
    const outcome = await runVideoCommand(controller({ position: 0 }), ask("@ade video step 1,5"))
    expect(outcome).toEqual({ ok: true, detail: "a 0:01.5" })
  })

  test("something that is not a number is refused", async () => {
    const outcome = await runVideoCommand(controller(), ask("@ade video step avanti"))
    expect(outcome.ok).toBe(false)
  })
})

describe("rate", () => {
  test("sets the rate and reports what the panel actually holds", async () => {
    const outcome = await runVideoCommand(controller(), ask("@ade video rate 2"))
    expect(outcome).toEqual({ ok: true, detail: "velocità 2×" })
  })

  test("a rate the engine would not honour is refused", async () => {
    const video = controller()
    const outcome = await runVideoCommand(video, ask("@ade video rate 10"))
    expect(outcome.ok).toBe(false)
    expect(video.calls).toEqual([])
  })
})

describe("capture", () => {
  /*
   * The path and the instant. The agent is about to read the file, and which
   * frame it is holding is the one thing the image cannot tell it.
   */
  test("gives back the path and which frame it is", async () => {
    const outcome = await runVideoCommand(controller({ position: 12.5 }), ask("@ade video capture"))
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.detail).toInclude("C:/shots/demo-0-00-0.png")
    expect(outcome.ok && outcome.detail).toInclude("0:12.5")
  })

  test("a capture that fails says why", async () => {
    const video = controller()
    video.rejectCapture(new Error("tainted canvas"))
    const outcome = await runVideoCommand(video, ask("@ade video capture"))
    expect(outcome).toEqual({ ok: false, reason: "tainted canvas" })
  })
})

describe("state and the unknown", () => {
  test("state describes the panel without changing it", async () => {
    const video = controller({ position: 5, playing: true })
    const outcome = await runVideoCommand(video, ask("@ade video state"))
    expect(outcome.ok && outcome.detail).toInclude("out/demo.mp4")
    expect(video.calls).toEqual([])
  })

  /*
   * An unknown verb lists the real ones, so the agent's next line is right
   * rather than another guess.
   */
  test("an unknown verb answers with the verbs that exist", async () => {
    const outcome = await runVideoCommand(controller(), ask("@ade video riavvolgi"))
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toInclude("seek")
    expect(outcome.ok === false && outcome.reason).toInclude("capture")
  })
})
