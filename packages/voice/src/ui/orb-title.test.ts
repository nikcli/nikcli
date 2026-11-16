import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localePreference, setLocalePreference } from "@nikcli-ai/ade/i18n"
import { DEFAULT_VOICE_SETTINGS } from "../settings/model"
import { dictationHint, orbTitle } from "./orb-title"

describe("ui/orb-title", () => {
  test("«Microfono · <chord>», with the chord of the mode the orb opens", () => {
    const before = localePreference()
    setLocalePreference("it")
    const agent = {
      ...DEFAULT_VOICE_SETTINGS,
      mode: "agent" as const,
      agentChord: "mod+shift+k",
      transcriptionChord: "mod+shift+j",
    }
    expect(orbTitle(agent, "other").split("\n")[0]).toBe("Microfono · Ctrl+Shift+K")
    expect(orbTitle({ ...agent, mode: "transcription" }, "other").split("\n")[0]).toBe("Microfono · Ctrl+Shift+J")
    setLocalePreference("en")
    expect(orbTitle(agent, "other").split("\n")[0]).toBe("Microphone · Ctrl+Shift+K")
    setLocalePreference(before)
  })

  test("the orb's tooltip is that one; its accessible name keeps saying what the microphone is doing", () => {
    const orb = readFileSync(join(import.meta.dir, "voice-orb.tsx"), "utf8")
    expect(orb).toContain("aria-label={label()}")
    expect(orb).toContain("title={orbTitle(props.engine.settings(), getPlatform())}")
    expect(orb).not.toContain("title={label()}")
  })
})

/* Nothing said the dictation chord had to be held: pressed like a switch, it did nothing. */
describe("ui/orb-title: how the dictation chord opens", () => {
  const settings = { ...DEFAULT_VOICE_SETTINGS, transcriptionChord: "mod+shift+1" }

  test("the tooltip's second line says it, for whichever chord the user chose", () => {
    const before = localePreference()
    setLocalePreference("it")
    expect(orbTitle(settings, "other").split("\n")[1]).toBe("Dettatura: tieni premuto Ctrl+Shift+1 mentre parli")
    expect(dictationHint({ ...settings, dictationPress: "toggle" }, "other")).toBe(
      "Dettatura: Ctrl+Shift+1 la apre, Ctrl+Shift+1 di nuovo la chiude",
    )
    setLocalePreference("en")
    expect(dictationHint(settings, "other")).toBe("Dictation: hold Ctrl+Shift+1 while you speak")
    setLocalePreference(before)
  })

  test("lint: the settings offer the two ways, and describe the chord by the one chosen", () => {
    const panel = readFileSync(join(import.meta.dir, "voice-settings-panel.tsx"), "utf8")
    expect(panel).toContain('updateSettings({ dictationPress: "hold" })')
    expect(panel).toContain('updateSettings({ dictationPress: "toggle" })')
    expect(panel).toContain('"vui.shortcuts.transcription.desc.toggle"')
  })

  test("lint: a tap on a held dictation chord is said in ADE's notices, with the chord", () => {
    const workbench = readFileSync(join(import.meta.dir, "../../../ade/src/surface/workbench.tsx"), "utf8")
    expect(workbench).toContain("onDictationTap: () =>")
    expect(workbench).toContain(
      't("vui.dictation.tapHint", describeShortcut(voiceSettings().transcriptionChord, platform))',
    )
  })
})
