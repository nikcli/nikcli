import { describe, expect, test } from "bun:test"
import { describeCapabilities, formatReply, panelsHelp, parseRequest, REPLY_PREFIX, REQUEST_PREFIX } from "./protocol"
import { VIDEO_VERBS } from "../video/video"
import { MODEL_VERBS } from "../model3d/model"
import { SIMULATOR_VERBS } from "../simulator/simulator"

describe("parseRequest", () => {
  test("reads a panel, a verb and no arguments", () => {
    expect(parseRequest("@ade video play")).toEqual({
      panel: "video",
      verb: "play",
      args: [],
      raw: "@ade video play",
    })
  })

  test("reads arguments after the verb", () => {
    expect(parseRequest("@ade video seek 00:12.5")?.args).toEqual(["00:12.5"])
    expect(parseRequest("@ade video open src/demo.mp4")?.args).toEqual(["src/demo.mp4"])
  })

  /*
   * A path with a space is the ordinary case, not the exotic one: it is the
   * reason dropped paths are quoted on the way in.
   */
  test("a quoted argument survives its spaces", () => {
    expect(parseRequest('@ade video open "clip finale.mp4"')?.args).toEqual(["clip finale.mp4"])
    expect(parseRequest('@ade video open "a b" c')?.args).toEqual(["a b", "c"])
  })

  test("the line may be indented, as agent output usually is", () => {
    expect(parseRequest("   @ade video pause  ")?.verb).toBe("pause")
  })

  test("the panel and the verb are read case-insensitively", () => {
    expect(parseRequest("@ade VIDEO Play")).toMatchObject({ panel: "video", verb: "play" })
  })

  /*
   * The false positive that would matter. An agent explaining the protocol,
   * or quoting it back in a plan, must not thereby start the video: the
   * sentinel has to open the line and nothing may precede it.
   */
  test("prose that merely mentions the syntax is not a request", () => {
    expect(parseRequest("puoi scrivere @ade video play per avviare")).toBeUndefined()
    expect(parseRequest("> @ade video play")).toBeUndefined()
    expect(parseRequest("1. @ade video play")).toBeUndefined()
  })

  /*
   * The terminal echoes what ADE types. Reading a reply as a request would
   * answer it, and answer the answer.
   */
  test("ADE's own reply is never read as a request", () => {
    expect(parseRequest(`${REPLY_PREFIX} video play ok — in riproduzione`)).toBeUndefined()
  })

  test("the sentinel alone, or with only a panel, is not a request", () => {
    expect(parseRequest("@ade")).toBeUndefined()
    expect(parseRequest("@ade video")).toBeUndefined()
    expect(parseRequest("@ade ")).toBeUndefined()
  })

  test("a panel or verb that is not an identifier is prose", () => {
    expect(parseRequest("@ade video, play")).toBeUndefined()
    expect(parseRequest("@ade video play!")).toBeUndefined()
  })

  // The 3D panel's name starts with a digit, and refusing it would cost an
  // agent a turn to find that out.
  test("a panel name may start with a digit", () => {
    expect(parseRequest("@ade 3d rotate 90")).toMatchObject({ panel: "3d", verb: "rotate" })
  })

  // Tolerated rather than required: an agent that quotes the panel name
  // means the same thing, and refusing it is pedantry that costs a turn.
  test("quoting the panel name is forgiven", () => {
    expect(parseRequest('@ade "video" play')).toMatchObject({ panel: "video", verb: "play" })
  })

  test("a word that merely starts with the sentinel is not it", () => {
    expect(parseRequest("@adexvideo play")).toBeUndefined()
  })

  test("an absurdly long argument is cut rather than carried", () => {
    const long = "x".repeat(5000)
    expect(parseRequest(`@ade video open ${long}`)?.args[0]).toHaveLength(512)
  })
})

describe("formatReply", () => {
  const request = parseRequest("@ade video seek 12")!

  test("says what happened, on one line, prefixed", () => {
    const reply = formatReply(request, { ok: true, detail: "a 12,0 s" })
    expect(reply).toBe(`${REPLY_PREFIX} video seek ok — a 12,0 s`)
    expect(reply).not.toInclude("\n")
  })

  test("a failure says why, not just that", () => {
    expect(formatReply(request, { ok: false, reason: "nessun video aperto" })).toBe(
      `${REPLY_PREFIX} video seek errore — nessun video aperto`,
    )
  })

  test("a reply cannot be parsed back as a request", () => {
    expect(parseRequest(formatReply(request, { ok: true, detail: "fatto" }))).toBeUndefined()
  })
})

describe("describeCapabilities", () => {
  const verbs = [
    { name: "play", usage: "play", summary: "avvia la riproduzione" },
    { name: "seek", usage: "seek <tempo>", summary: "salta a un istante" },
  ]

  test("tells the agent the panel exists, the shape, and every verb", () => {
    const lines = describeCapabilities("video", verbs)
    expect(lines.join("\n")).toInclude(`${REQUEST_PREFIX} video seek <tempo>`)
    expect(lines.join("\n")).toInclude("salta a un istante")
    expect(lines[0]).toInclude("video")
  })

  /*
   * Every line is typed into a pty separately, because a line break there is
   * a submit. One of these carrying an embedded newline would send half a
   * sentence as a prompt.
   */
  test("no line carries a break of its own", () => {
    for (const line of describeCapabilities("video", verbs)) expect(line).not.toInclude("\n")
  })

  test("every line is marked as ADE's, so none reads as a request", () => {
    for (const line of describeCapabilities("video", verbs)) expect(parseRequest(line)).toBeUndefined()
  })

  test("a panel with nothing to offer says nothing", () => {
    expect(describeCapabilities("video", [])).toEqual([])
  })
})

describe("panelsHelp", () => {
  const help = panelsHelp([
    { panel: "video", verbs: VIDEO_VERBS },
    { panel: "model", verbs: MODEL_VERBS },
    { panel: "app", verbs: SIMULATOR_VERBS },
  ])

  test("one line per panel, with every command", () => {
    const lines = help.trimEnd().split("\n")
    expect(lines.filter((line) => /^ {2}(video|model|app): /.test(line))).toHaveLength(3)
    for (const verb of MODEL_VERBS) expect(help).toInclude(verb.usage)
    expect(help).toInclude(`${REQUEST_PREFIX} <pannello> <comando>`)
  })

  /*
   * `ade-msg help` prints in the agent's own output, and `onLine` reads it.
   * A pane that wraps a line where the sentinel starts would hand it over
   * from there, so no cut at any sentinel may be a request.
   */
  test("no line, cut at any sentinel, reads as a request", () => {
    for (const line of help.split("\n")) {
      for (let at = line.indexOf(REQUEST_PREFIX); at !== -1; at = line.indexOf(REQUEST_PREFIX, at + 1)) {
        expect(parseRequest(line.slice(at))).toBeUndefined()
      }
      expect(parseRequest(line)).toBeUndefined()
    }
  })
})
