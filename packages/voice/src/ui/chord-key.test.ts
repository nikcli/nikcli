import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { captureKeyboardEvent, checkShortcutConflict } from "./shortcut-capture"
import { DEFAULT_VOICE_SETTINGS } from "../settings/model"
import { VOICE_COMMAND_TRANSCRIPTION, isSystemChord } from "../settings/shortcuts"

/*
 * The recorder wrote the character the layout makes, and the system-wide
 * hotkey wants a key: on an Italian keyboard Ctrl+Shift+1 was stored as «!»,
 * which could not be registered, so the chord did nothing outside ADE.
 */
const event = (key: string, code: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey", boolean>>) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

const recorded = (e: ReturnType<typeof event>) => {
  const result = captureKeyboardEvent(e, "other")
  return result.type === "chord" ? result.chord : result.type
}

describe("the recorder writes the key, not the character", () => {
  test("a digit with Shift, on an Italian keyboard", () => {
    expect(recorded(event("!", "Digit1", { ctrlKey: true, shiftKey: true }))).toBe("mod+shift+1")
  })

  test("a letter AltGr turned into a symbol", () => {
    expect(recorded(event("€", "KeyE", { ctrlKey: true, altKey: true }))).toBe("mod+alt+e")
  })

  test("the keypad is its own key", () => {
    expect(recorded(event("1", "Numpad1", { ctrlKey: true, altKey: true }))).toBe("mod+alt+numpad1")
  })

  test("a letter keeps the layout's letter: AZERTY's «a» is not QWERTY's", () => {
    expect(recorded(event("a", "KeyQ", { ctrlKey: true, shiftKey: true }))).toBe("mod+shift+a")
  })
})

describe("on Windows, a key the system cannot hold is refused when it is recorded", () => {
  test.each(["mod+shift+ò", "mod+shift+,", "mod+shift+;", "mod+alt+€"])("%s", (chord) => {
    expect(isSystemChord(chord, true)).toBe(false)
    const check = checkShortcutConflict(chord, VOICE_COMMAND_TRANSCRIPTION, DEFAULT_VOICE_SETTINGS, [], "other", true)
    expect(check.hasConflict).toBe(true)
    expect(check.message).toContain("fuori da ADE")
  })

  test.each(["mod+shift+j", "mod+shift+1", "mod+alt+numpad1", "mod+shift+f5", "mod+shift+space", "mod+shift+arrowup"])(
    "%s is accepted",
    (chord) => {
      expect(isSystemChord(chord, true)).toBe(true)
      expect(
        checkShortcutConflict(chord, VOICE_COMMAND_TRANSCRIPTION, DEFAULT_VOICE_SETTINGS, [], "other", true).hasConflict,
      ).toBe(false)
    },
  )
})

/*
 * The table is the Windows crate's. On macOS the crate takes physical key codes, so a chord on punctuation registers on the key it was
 * recorded on, and refusing it there took a working global shortcut away.
 */
describe("off Windows, the key table does not limit the chord", () => {
  test.each([
    ["mac", "mod+shift+,"],
    ["mac", "mod+shift+;"],
    ["other", "mod+shift+,"],
    ["other", "mod+alt+ò"],
  ] as const)("%s: %s is accepted", (platform, chord) => {
    expect(isSystemChord(chord, false)).toBe(true)
    expect(
      checkShortcutConflict(chord, VOICE_COMMAND_TRANSCRIPTION, DEFAULT_VOICE_SETTINGS, [], platform, false).hasConflict,
    ).toBe(false)
  })

  test("a chord the keymap cannot read is still refused", () => {
    expect(isSystemChord("", false)).toBe(false)
  })
})

test("lint: the settings hand the recorder the physical key too", () => {
  const panel = readFileSync(join(import.meta.dir, "voice-settings-panel.tsx"), "utf8")
  expect(panel).toContain("code: e.code,")
})
