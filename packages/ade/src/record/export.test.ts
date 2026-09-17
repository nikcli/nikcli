import { describe, expect, test } from "bun:test"
import { pickExportMime, quietWav, readEvents } from "./export"

describe("record/export", () => {
  test("MP4 when the webview can write it, WebM otherwise", () => {
    expect(pickExportMime(() => true).extension).toBe("mp4")
    expect(pickExportMime((type) => type.startsWith("video/webm")).extension).toBe("webm")
    expect(pickExportMime(() => false)).toEqual({ mimeType: "video/webm", extension: "webm" })
  })


  test("the bed under a take without audio outlasts the take and is never louder than a step", () => {
    const wav = new DataView(quietWav(2, () => 0.9))
    expect(wav.byteLength).toBe(44 + 3 * 8000 * 2)
    expect(wav.getInt16(44, true)).toBe(1)
    expect(new DataView(quietWav(Number.NaN, () => 0.1)).getInt16(44, true)).toBe(-1)
  })

  test("the events file is read line by line, and a broken line is skipped", () => {
    const text = ['{"kind":"frame","at":0,"width":10,"height":10,"dpr":1}', "{rotto", "", '{"kind":"click","at":5,"x":1,"y":2,"button":"left"}'].join("\n")
    expect(readEvents(text).map((event) => event.kind)).toEqual(["frame", "click"])
  })
})
