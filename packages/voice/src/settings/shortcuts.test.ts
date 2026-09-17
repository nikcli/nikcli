import { describe, expect, test } from "bun:test"
import {
  VOICE_COMMAND_AGENT,
  VOICE_COMMAND_TRANSCRIPTION,
  buildVoiceBindings,
  describeChordRisk,
  describeCommandId,
  describeShortcut,
  findVoiceShortcutConflicts,
  isChordUsable,
  summarizeVoiceShortcutConflicts,
} from "./shortcuts"
import { DEFAULT_VOICE_SETTINGS } from "./model"
import { parseChord } from "@nikcli-ai/ade/keyboard/keymap"

describe("settings/shortcuts", () => {
  test("constructs ADE keymap bindings for agent and transcription chords", () => {
    const bindings = buildVoiceBindings(DEFAULT_VOICE_SETTINGS, "other")

    expect(bindings).toHaveLength(2)
    expect(bindings[0].commandId).toBe(VOICE_COMMAND_AGENT)
    expect(bindings[0].chord.key).toBe("k")
    expect(bindings[0].chord.ctrl).toBe(true)
    expect(bindings[0].chord.shift).toBe(true)

    expect(bindings[1].commandId).toBe(VOICE_COMMAND_TRANSCRIPTION)
    expect(bindings[1].chord.key).toBe("j")
    expect(bindings[1].chord.ctrl).toBe(true)
    expect(bindings[1].chord.shift).toBe(true)
  })

  test("formats shortcuts cleanly for the specified platform", () => {
    expect(describeShortcut("mod+shift+k", "other")).toBe("Ctrl+Shift+K")
    expect(describeShortcut("mod+shift+k", "mac")).toBe("⇧⌘K")
    expect(describeShortcut("mod+shift+j", "other")).toBe("Ctrl+Shift+J")
    expect(describeShortcut("mod+shift+j", "mac")).toBe("⇧⌘J")

    const parsed = parseChord("ctrl+p", "other")
    expect(describeShortcut(parsed, "other")).toBe("Ctrl+P")
  })

  test("detects conflicts when chords collide with existing bindings", () => {
    const existing = [
      {
        chord: parseChord("mod+shift+k", "other"),
        commandId: "workbench.custom.action",
      },
    ]

    const conflicts = findVoiceShortcutConflicts(DEFAULT_VOICE_SETTINGS, existing, "other")
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].commandIds).toContain(VOICE_COMMAND_AGENT)
    expect(conflicts[0].commandIds).toContain("workbench.custom.action")
  })

  test("reports no conflicts when all chords are distinct", () => {
    const existing = [
      {
        chord: parseChord("mod+p", "other"),
        commandId: "palette.open",
      },
    ]

    const conflicts = findVoiceShortcutConflicts(DEFAULT_VOICE_SETTINGS, existing, "other")
    expect(conflicts).toHaveLength(0)
  })
})

describe("settings/shortcuts — summarizeVoiceShortcutConflicts", () => {
  const ade = [
    { chord: parseChord("mod+shift+p", "other"), commandId: "palette.open" },
    { chord: parseChord("mod+shift+m", "other"), commandId: "pane.expand" },
  ]

  test("says nothing when every voice chord is free", () => {
    expect(summarizeVoiceShortcutConflicts(DEFAULT_VOICE_SETTINGS, ade, "other")).toBeUndefined()
  })

  test("names the shortcut, the command holding it, and who wins", () => {
    const shadowed = {
      ...DEFAULT_VOICE_SETTINGS,
      agentChord: "mod+shift+m",
    }

    const summary = summarizeVoiceShortcutConflicts(shadowed, ade, "other")
    expect(summary).toBeDefined()
    expect(summary).toContain("Modalità agente")
    expect(summary).toContain("Ctrl+Shift+M")
    expect(summary).toContain(describeCommandId("pane.expand"))
    expect(summary).toContain("precedenza")
  })

  test("reports the two voice modes shadowing each other as neither winning", () => {
    const doubled = {
      ...DEFAULT_VOICE_SETTINGS,
      transcriptionChord: DEFAULT_VOICE_SETTINGS.agentChord,
    }

    const summary = summarizeVoiceShortcutConflicts(doubled, ade, "other")
    expect(summary).toContain("nessuna delle due si attiva")
  })
})

describe("settings/shortcuts — describeChordRisk", () => {
  test("i tasti predefiniti sono utilizzabili su entrambe le piattaforme", () => {
    for (const platform of ["other", "mac"] as const) {
      expect(describeChordRisk(DEFAULT_VOICE_SETTINGS.agentChord, platform).level).toBe("ok")
      expect(describeChordRisk(DEFAULT_VOICE_SETTINGS.transcriptionChord, platform).level).toBe("ok")
    }
  })

  test("refuses a bare printable key, which would take the letter away from typing", () => {
    const risk = describeChordRisk("k", "other")
    expect(risk.level).toBe("refuse")
    expect(risk.message).toContain("scrivere")
    expect(isChordUsable("k", "other")).toBe(false)
  })

  test("refuses shift plus a printable key: shift is how a capital is typed", () => {
    expect(describeChordRisk("shift+k", "other").level).toBe("refuse")
    expect(describeChordRisk("shift+1", "other").level).toBe("refuse")
  })

  test("refuses bare editing and navigation keys", () => {
    for (const chord of ["space", "enter", "backspace", "delete", "arrowup", "home", "pagedown"]) {
      expect(describeChordRisk(chord, "other").level).toBe("refuse")
    }
  })

  test("accepts those same keys once a real modifier lifts them out of typing", () => {
    expect(describeChordRisk("mod+shift+space", "other").level).toBe("ok")
    expect(describeChordRisk("alt+enter", "other").level).toBe("ok")
    expect(describeChordRisk("mod+arrowup", "other").level).toBe("ok")
  })

  test("refuses a chord with no principal key at all", () => {
    expect(describeChordRisk("mod+shift", "other").level).toBe("refuse")
    expect(describeChordRisk("", "other").level).toBe("refuse")
    expect(describeChordRisk("+++", "other").level).toBe("refuse")
  })

  test("refuses keys that name a keyboard state rather than a key", () => {
    // The first half of an accented character, and what an IME reports while
    // composing: neither can be pressed again on purpose.
    expect(describeChordRisk("mod+dead", "other").level).toBe("refuse")
    expect(describeChordRisk("mod+unidentified", "other").level).toBe("refuse")
    expect(describeChordRisk("mod+process", "other").level).toBe("refuse")
  })

  test("a bare function key is fine: it is not used to write anything", () => {
    expect(describeChordRisk("f5", "other").level).toBe("ok")
  })

  test("warns without refusing when the OS is likely to take the chord first", () => {
    const win = describeChordRisk("meta+shift+k", "other")
    expect(win.level).toBe("warn")
    expect(win.message).toContain("Win")
    expect(isChordUsable("meta+shift+k", "other")).toBe(true)

    const altLetter = describeChordRisk("alt+f", "other")
    expect(altLetter.level).toBe("warn")
    expect(altLetter.message).toContain("AltGr")

    // On a Mac, Cmd is the ordinary shortcut modifier and nothing is warned about.
    expect(describeChordRisk("mod+shift+k", "mac").level).toBe("ok")
  })
})
