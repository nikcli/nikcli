import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { codeOf } from "../test-support/source-text"
import { refusalsOf, registerVoiceShortcuts } from "./global-shortcut"

/*
 * A chord another application already holds cannot be registered, and the only
 * word of it was a notice at startup. Coming back later to find out why the
 * chord does nothing, the voice settings showed it exactly like one that works.
 */
describe("a chord the system refuses", () => {
  const settings = { agentChord: "mod+shift+k", transcriptionChord: "mod+shift+j" }

  test("is named beside that chord, and only that one", async () => {
    const result = await registerVoiceShortcuts(settings, {
      unregisterAll: async () => {},
      register: async (chord) => {
        if (chord.endsWith("+J")) throw new Error("HotKey already registered")
      },
    })
    const refusals = refusalsOf(result.failed)
    expect(Object.keys(refusals)).toEqual(["transcription"])
    expect(refusals.transcription).toContain("mod+shift+j")
    expect(refusals.transcription).toContain("dettatura")
  })

  test("a registration that claims both leaves nothing to show", async () => {
    const result = await registerVoiceShortcuts(settings, { unregisterAll: async () => {}, register: async () => {} })
    expect(refusalsOf(result.failed)).toEqual({})
  })
})

/*
 * The key table that keeps punctuation out of the system-wide hotkeys is the Windows crate's: on macOS the crate takes physical key codes, so
 * `mod+shift+,` registers there and must not be refused before it is tried.
 */
describe("a chord on punctuation", () => {
  const settings = { agentChord: "mod+shift+,", transcriptionChord: "mod+shift+;" }

  test("is registered off Windows", async () => {
    const windows = false
    const claimed: string[] = []
    const result = await registerVoiceShortcuts(settings, {
      unregisterAll: async () => {},
      register: async (chord) => void claimed.push(chord),
      windows,
    })
    expect(result.failed).toEqual([])
    expect(result.registered.sort()).toEqual(["agent", "transcription"])
    expect(claimed.sort()).toEqual(["CommandOrControl+Shift+,", "CommandOrControl+Shift+;"])
    expect(refusalsOf(result.failed, windows)).toEqual({})
  })

  test("is refused on Windows, and never handed to the system", async () => {
    const claimed: string[] = []
    const result = await registerVoiceShortcuts(settings, {
      unregisterAll: async () => {},
      register: async (chord) => void claimed.push(chord),
      windows: true,
    })
    expect(claimed).toEqual([])
    expect(result.registered).toEqual([])
    expect(result.failed.map((failure) => failure.problem)).toEqual(["not a system-wide key", "not a system-wide key"])
    expect(refusalsOf(result.failed, true).agent).toContain("solo con ADE in primo piano")
  })

  test("a refusal from the system off Windows is the busy one, not the key-table one", async () => {
    const result = await registerVoiceShortcuts(settings, {
      unregisterAll: async () => {},
      register: async () => {
        throw new Error("HotKey already registered")
      },
      windows: false,
    })
    expect(result.failed).toHaveLength(2)
    expect(refusalsOf(result.failed, false).agent).not.toContain("solo con ADE in primo piano")
  })
})

describe("lint: the refusal reaches the voice settings", () => {
  const workbench = codeOf(readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8"))
  const panel = codeOf(readFileSync(new URL("../../../voice/src/ui/voice-settings-panel.tsx", import.meta.url), "utf8"))

  test("the workbench keeps what the last registration refused, and hands it to the panel", () => {
    expect(workbench).toContain(codeOf("setShortcutRefusals(refusalsOf(failed))"))
    expect(workbench).toContain(codeOf("shortcutRefusals={shortcutRefusals()}"))
  })

  test("the panel shows it where it shows the chord's other problems", () => {
    expect(panel).toContain(codeOf("props.shortcutRefusals?.[field]"))
  })
})
