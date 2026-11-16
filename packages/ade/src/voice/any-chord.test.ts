import { describe, expect, test } from "bun:test"
import { DEFAULT_VOICE_SETTINGS } from "@nikcli-ai/voice/core"
import { modeForGlobalChord, refusalsOf, registerVoiceShortcuts, toTauriChord } from "./global-shortcut"
import { resolveVoiceOrAdeKey } from "./shortcuts"

/*
 * The user changed the dictation chord, and it did nothing. A chord is stored
 * as the character the layout makes, and the system-wide hotkey wants a key:
 * on an Italian keyboard Ctrl+Shift+1 was stored as «!», which the hotkey
 * table cannot name, and a punctuation key was registered on a different key.
 * Whatever chord the recorder accepts has to work in the window and outside it.
 */

/*
 * What `toTauriChord` hands the native side, and what the `global-hotkey` crate
 * prints back when that hotkey fires. The same table is checked against the
 * real crate in `src-tauri/src/lib.rs` (`voice_chord_tests`).
 */
const ROUND_TRIP: [chord: string, registered: string, reported: string][] = [
  ["mod+shift+j", "CommandOrControl+Shift+J", "shift+control+KeyJ"],
  ["mod+shift+1", "CommandOrControl+Shift+1", "shift+control+Digit1"],
  ["mod+alt+numpad1", "CommandOrControl+Alt+NUMPAD1", "control+alt+Numpad1"],
  ["mod+shift+f5", "CommandOrControl+Shift+F5", "shift+control+F5"],
  ["mod+shift+arrowup", "CommandOrControl+Shift+ARROWUP", "shift+control+ArrowUp"],
  ["mod+shift+space", "CommandOrControl+Shift+SPACE", "shift+control+Space"],
  ["mod+shift+pageup", "CommandOrControl+Shift+PAGEUP", "shift+control+PageUp"],
]

describe("any chord the recorder accepts works outside the window", () => {
  test.each(ROUND_TRIP)(
    "%s is registered as %s, and the hotkey it fires is recognised",
    (chord, registered, reported) => {
      expect(toTauriChord(chord)).toBe(registered)
      const settings = { agentChord: "mod+shift+k", transcriptionChord: chord }
      expect(modeForGlobalChord(reported, settings, "other")).toBe("transcription")
    },
  )

  // On Windows only: the table that leaves punctuation out is the Windows crate's (see `isSystemChord`).
  test("on Windows a punctuation key is not claimed from the system, and the refusal says why", async () => {
    const claimed: string[] = []
    const result = await registerVoiceShortcuts(
      { agentChord: "mod+shift+k", transcriptionChord: "mod+shift+," },
      { unregisterAll: async () => {}, register: async (chord) => void claimed.push(chord), windows: true },
    )
    expect(claimed).toEqual(["CommandOrControl+Shift+K"])
    expect(result.failed.map((f) => f.mode)).toEqual(["transcription"])
    expect(refusalsOf(result.failed, true).transcription).toContain("solo con ADE in primo piano")
  })
})

describe("in the window, a chord recorded from the physical key", () => {
  const settings = { ...DEFAULT_VOICE_SETTINGS, transcriptionChord: "mod+shift+1" }
  const press = (key: string, code: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey", boolean>>) => ({
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  })

  test("answers the key an Italian keyboard reports as «!»", () => {
    const event = press("!", "Digit1", { ctrlKey: true, shiftKey: true })
    expect(resolveVoiceOrAdeKey([], settings, event, "other").type).toBe("voice-transcription")
  })

  test("AltGr's character and the keypad answer too", () => {
    const altGr = { ...DEFAULT_VOICE_SETTINGS, transcriptionChord: "mod+alt+e" }
    expect(resolveVoiceOrAdeKey([], altGr, press("€", "KeyE", { ctrlKey: true, altKey: true }), "other").type).toBe(
      "voice-transcription",
    )
    const keypad = { ...DEFAULT_VOICE_SETTINGS, transcriptionChord: "mod+alt+numpad1" }
    expect(resolveVoiceOrAdeKey([], keypad, press("1", "Numpad1", { ctrlKey: true, altKey: true }), "other").type).toBe(
      "voice-transcription",
    )
  })

  test("on a layout that moves the letters, the chord still answers one key, not two", () => {
    // AZERTY: the key that types «q» sits where QWERTY has A.
    const a = { ...DEFAULT_VOICE_SETTINGS, transcriptionChord: "mod+shift+a" }
    expect(resolveVoiceOrAdeKey([], a, press("Q", "KeyA", { ctrlKey: true, shiftKey: true }), "other").type).toBe(
      "none",
    )
    expect(resolveVoiceOrAdeKey([], a, press("A", "KeyQ", { ctrlKey: true, shiftKey: true }), "other").type).toBe(
      "voice-transcription",
    )
  })
})
