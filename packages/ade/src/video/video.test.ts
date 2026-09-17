import { describe, expect, test } from "bun:test"
import {
  clampSeek,
  describeState,
  formatTimecode,
  frameFileName,
  isPlayable,
  MAX_RATE,
  mediaUrl,
  MIN_RATE,
  parseRate,
  parseTimecode,
  VIDEO_VERBS,
} from "./video"

describe("isPlayable", () => {
  test("accepts what a webview will actually play", () => {
    expect(isPlayable("demo.mp4")).toBe(true)
    expect(isPlayable("C:/repo/out/run.webm")).toBe(true)
    expect(isPlayable("REGISTRAZIONE.MOV")).toBe(true)
  })

  /*
   * Refusing these is the point. An `.mkv` opened into a video element is a
   * black rectangle with no error, which reads as a broken panel rather than
   * as a container the engine does not support.
   */
  test("refuses a container the engine cannot open", () => {
    expect(isPlayable("film.mkv")).toBe(false)
    expect(isPlayable("clip.avi")).toBe(false)
  })

  test("a path with no extension is not a video", () => {
    expect(isPlayable("README")).toBe(false)
    expect(isPlayable("")).toBe(false)
    expect(isPlayable("   ")).toBe(false)
  })
})

describe("parseTimecode", () => {
  test("reads seconds", () => {
    expect(parseTimecode("12")).toBe(12)
    expect(parseTimecode("12.5")).toBe(12.5)
    expect(parseTimecode("0")).toBe(0)
  })

  test("reads minutes and seconds", () => {
    expect(parseTimecode("1:03")).toBe(63)
    expect(parseTimecode("10:00")).toBe(600)
  })

  test("reads hours, minutes and seconds, tenths included", () => {
    expect(parseTimecode("01:02:03")).toBe(3723)
    expect(parseTimecode("1:00:00.5")).toBe(3600.5)
  })

  /*
   * `1:75` is a typo, not a time. Reading it as 135 s guesses which half the
   * agent got wrong, and a wrong seek reported as a success is worse than a
   * refusal it can correct.
   */
  test("a field above 59 is a typo and is refused", () => {
    expect(parseTimecode("1:75")).toBeUndefined()
    expect(parseTimecode("1:00:99")).toBeUndefined()
  })

  test("anything that is not a time is not read as zero", () => {
    expect(parseTimecode("inizio")).toBeUndefined()
    expect(parseTimecode("")).toBeUndefined()
    expect(parseTimecode("-5")).toBeUndefined()
    expect(parseTimecode("1:2:3:4")).toBeUndefined()
  })
})

describe("formatTimecode", () => {
  test("minutes and seconds with tenths", () => {
    expect(formatTimecode(0)).toBe("0:00.0")
    expect(formatTimecode(63)).toBe("1:03.0")
    expect(formatTimecode(12.54)).toBe("0:12.5")
  })

  test("hours appear only when there are any", () => {
    expect(formatTimecode(3723)).toBe("1:02:03.0")
    expect(formatTimecode(599)).toBe("9:59.0")
  })

  test("a duration the element has not reported yet reads as zero", () => {
    expect(formatTimecode(Number.NaN)).toBe("0:00.0")
    expect(formatTimecode(-1)).toBe("0:00.0")
  })

  test("round trips with parseTimecode", () => {
    for (const seconds of [0, 7, 63, 600, 3723]) {
      expect(parseTimecode(formatTimecode(seconds))).toBe(seconds)
    }
  })
})

describe("clampSeek", () => {
  /*
   * A video element ignores a seek past its end without complaining. Told
   * the raw target, the agent would be informed it had moved somewhere it
   * had not.
   */
  test("a seek past the end lands on the end, and says so", () => {
    expect(clampSeek(500, 30)).toBe(30)
  })

  test("a negative seek lands at the start", () => {
    expect(clampSeek(-10, 30)).toBe(0)
  })

  test("within the video it is left alone", () => {
    expect(clampSeek(12.5, 30)).toBe(12.5)
  })

  test("before the duration is known, only the floor applies", () => {
    expect(clampSeek(12, Number.NaN)).toBe(12)
    expect(clampSeek(-3, Number.NaN)).toBe(0)
  })
})

describe("parseRate", () => {
  test("accepts a rate inside the range", () => {
    expect(parseRate("2")).toBe(2)
    expect(parseRate("0.5")).toBe(0.5)
    // An Italian agent writes the decimal with a comma.
    expect(parseRate("1,5")).toBe(1.5)
  })

  test("refuses one that would appear to work and would not", () => {
    expect(parseRate("0")).toBeUndefined()
    expect(parseRate("10")).toBeUndefined()
    expect(parseRate("veloce")).toBeUndefined()
  })

  test("the ends of the range are inside it", () => {
    expect(parseRate(String(MIN_RATE))).toBe(MIN_RATE)
    expect(parseRate(String(MAX_RATE))).toBe(MAX_RATE)
  })
})

describe("frameFileName", () => {
  test("names the frame after the video and the instant", () => {
    expect(frameFileName("C:/repo/out/demo.mp4", 63)).toBe("demo-1-03-0.png")
  })

  test("survives a windows path and a space", () => {
    expect(frameFileName("C:\\repo\\clip finale.mp4", 0)).toBe("clip-finale-0-00-0.png")
  })

  test("a name with nothing usable in it still produces a file", () => {
    expect(frameFileName("!!!.mp4", 0)).toBe("video-0-00-0.png")
  })

  test("no colon, because Windows has no such filename", () => {
    expect(frameFileName("demo.mp4", 3723)).not.toInclude(":")
  })
})

describe("describeState", () => {
  test("says the file, where it is, and what it is doing", () => {
    expect(describeState({ source: "out/demo.mp4", playing: true, position: 12.5, duration: 60, rate: 1 })).toBe(
      "out/demo.mp4 — 0:12.5 di 1:00.0, in riproduzione",
    )
  })

  test("mentions the rate only when it is not the ordinary one", () => {
    const base = { source: "a.mp4", playing: false, position: 0, duration: 10 }
    expect(describeState({ ...base, rate: 1 })).not.toInclude("×")
    expect(describeState({ ...base, rate: 2 })).toInclude("2×")
  })

  test("an empty panel says so rather than describing nothing", () => {
    expect(describeState({ playing: false, position: 0, duration: 0, rate: 1 })).toBe("nessun video aperto")
  })
})

describe("VIDEO_VERBS", () => {
  /*
   * The list is what the agent is told it can do. A verb documented and not
   * implemented is a turn the agent spends discovering a lie, so the two
   * come from one place — this guards the shape of that place.
   */
  test("every verb has a usage that starts with its own name", () => {
    for (const verb of VIDEO_VERBS) {
      expect(verb.usage).toStartWith(verb.name)
      expect(verb.summary.length).toBeGreaterThan(0)
    }
  })

  test("no verb is listed twice", () => {
    expect(new Set(VIDEO_VERBS.map((verb) => verb.name)).size).toBe(VIDEO_VERBS.length)
  })
})

describe("mediaUrl", () => {
  const path = "C:\\Video\\ADE 1.mp4"

  test("uses the http form WebView2 answers on Windows", () => {
    expect(mediaUrl(path, true)).toBe("http://ade-media.localhost/C%3A/Video/ADE%201.mp4")
  })

  test("uses the scheme form elsewhere", () => {
    expect(mediaUrl(path, false)).toBe("ade-media://localhost/C%3A/Video/ADE%201.mp4")
  })
})
