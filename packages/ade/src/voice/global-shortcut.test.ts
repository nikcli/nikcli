import { describe, expect, test } from "bun:test"
import {
  globalVoiceAction,
  modeForGlobalChord,
  registerVoiceShortcuts,
  unknownChordMessage,
  parseGlobalChord,
  readGlobalVoicePayload,
  toTauriChord,
} from "./global-shortcut"

describe("toTauriChord", () => {
  test("mod resolves per platform on the native side", () => {
    expect(toTauriChord("mod+shift+k")).toBe("CommandOrControl+Shift+K")
  })

  test("an explicit ctrl or cmd is not folded into CommandOrControl", () => {
    expect(toTauriChord("ctrl+k")).toBe("Control+K")
    expect(toTauriChord("cmd+k")).toBe("Super+K")
  })

  test("named keys keep a spelling the crate parses", () => {
    expect(toTauriChord("mod+space")).toBe("CommandOrControl+SPACE")
    expect(toTauriChord("alt+arrowup")).toBe("Alt+ARROWUP")
    expect(toTauriChord("mod+alt+f9")).toBe("CommandOrControl+Alt+F9")
  })
})

describe("parseGlobalChord", () => {
  test("reads the crate's own print format", () => {
    expect(parseGlobalChord("shift+control+KeyK")).toEqual({
      key: "k",
      ctrl: true,
      meta: false,
      shift: true,
      alt: false,
    })
    expect(parseGlobalChord("control+Space")).toEqual({
      key: "space",
      ctrl: true,
      meta: false,
      shift: false,
      alt: false,
    })
    expect(parseGlobalChord("super+Digit1").meta).toBe(true)
  })
})

describe("modeForGlobalChord", () => {
  const settings = { agentChord: "mod+space", transcriptionChord: "mod+shift+j" }

  /*
   * The case that was broken: a chord with no "j" or "k" in it. The old
   * listener matched on those two letters and dropped everything else.
   */
  test("Ctrl+Space opens the agent when that is the configured chord", () => {
    expect(modeForGlobalChord("control+Space", settings, "other")).toBe("agent")
  })

  test("the transcription chord is told apart from the agent one", () => {
    expect(modeForGlobalChord("shift+control+KeyJ", settings, "other")).toBe("transcription")
  })

  test("mod is Command on a Mac and Control elsewhere", () => {
    expect(modeForGlobalChord("super+Space", settings, "mac")).toBe("agent")
    expect(modeForGlobalChord("control+Space", settings, "mac")).toBeUndefined()
    expect(modeForGlobalChord("super+Space", settings, "other")).toBeUndefined()
  })

  test("a chord that merely contains a letter of the default is not a match", () => {
    // "backspace" contains a "k": the old listener toggled the agent on it.
    expect(modeForGlobalChord("control+Backspace", settings, "other")).toBeUndefined()
    expect(modeForGlobalChord("", settings, "other")).toBeUndefined()
  })
})

describe("readGlobalVoicePayload", () => {
  test("understands the structured payload", () => {
    expect(readGlobalVoicePayload({ chord: "control+Space", state: "released" })).toEqual({
      chord: "control+Space",
      state: "released",
    })
  })

  test("still understands the bare string an older native build sends", () => {
    expect(readGlobalVoicePayload("control+Space")).toEqual({ chord: "control+Space", state: "pressed" })
  })

  test("rejects what is neither", () => {
    expect(readGlobalVoicePayload("")).toBeUndefined()
    expect(readGlobalVoicePayload({ state: "pressed" })).toBeUndefined()
    expect(readGlobalVoicePayload(42)).toBeUndefined()
  })
})

describe("registerVoiceShortcuts", () => {
  const settings = { agentChord: "mod+shift+k", transcriptionChord: "mod+space" }

  test("a chord another application holds does not take the other one down with it", async () => {
    const registered: string[] = []
    const said: string[] = []
    const result = await registerVoiceShortcuts(settings, {
      unregisterAll: async () => {},
      // Ctrl+Space is often already claimed: the dictation chord fails, the assistant's must not.
      register: async (chord) => {
        if (chord === "CommandOrControl+SPACE") throw new Error("HotKey already registered")
        registered.push(chord)
      },
      report: (message) => said.push(message),
    })

    expect(registered).toEqual(["CommandOrControl+Shift+K"])
    expect(result.registered).toEqual(["agent"])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ mode: "transcription", chord: "mod+space" })
    // Said in the interface, not only in the console.
    expect(said).toHaveLength(1)
    expect(said[0]).toContain("mod+space")
    expect(said[0]).toContain("dettatura")
  })

  test("both chords are claimed, the previous ones dropped first", async () => {
    const order: string[] = []
    const result = await registerVoiceShortcuts(settings, {
      unregisterAll: async () => void order.push("unregister"),
      register: async (chord) => void order.push(chord),
    })

    expect(order).toEqual(["unregister", "CommandOrControl+SPACE", "CommandOrControl+Shift+K"])
    expect(result.failed).toHaveLength(0)
  })

  test("the two chords of this user's settings are told apart on both sides", () => {
    // What the OS reports for each, as `global-hotkey` prints it.
    expect(modeForGlobalChord("shift+control+KeyK", settings, "other")).toBe("agent")
    expect(modeForGlobalChord("control+Space", settings, "other")).toBe("transcription")
  })
})

describe("globalVoiceAction", () => {
  const settings = { agentChord: "mod+shift+k", transcriptionChord: "mod+space" }

  test("each chord opens its own feature, on press", () => {
    expect(globalVoiceAction({ chord: "shift+control+KeyK", state: "pressed" }, settings, "other")).toEqual({
      kind: "press",
      mode: "agent",
    })
    expect(globalVoiceAction({ chord: "control+Space", state: "pressed" }, settings, "other")).toEqual({
      kind: "press",
      mode: "transcription",
    })
    expect(globalVoiceAction({ chord: "control+Space", state: "released" }, settings, "other")).toEqual({
      kind: "release",
    })
  })

  test("a chord ADE cannot place is said, never turned into dictation", () => {
    const action = globalVoiceAction({ chord: "control+F24", state: "pressed" }, settings, "other")
    expect(action).toEqual({ kind: "unknown", chord: "control+F24" })
    expect(unknownChordMessage("control+F24")).toContain("non riconosciuta")
    // The dangerous answer would be a mode: with the stored mode on dictation,
    // the assistant's chord would open the microphone for dictation instead.
    expect(action).not.toHaveProperty("mode")
  })

  test("a chord on a punctuation key is recognised: the recorder writes «,», the system says «Comma»", () => {
    const punctuation = { agentChord: "mod+,", transcriptionChord: "mod+." }
    expect(globalVoiceAction({ chord: "control+Comma", state: "pressed" }, punctuation, "other")).toEqual({
      kind: "press",
      mode: "agent",
    })
    expect(globalVoiceAction({ chord: "control+Period", state: "pressed" }, punctuation, "other")).toEqual({
      kind: "press",
      mode: "transcription",
    })
  })

  test("an empty or malformed payload does nothing at all", () => {
    expect(globalVoiceAction(undefined, settings, "other")).toEqual({ kind: "ignore" })
    expect(globalVoiceAction({ state: "pressed" }, settings, "other")).toEqual({ kind: "ignore" })
  })
})
