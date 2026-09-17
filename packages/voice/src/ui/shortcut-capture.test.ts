import { describe, expect, test } from "bun:test"
import {
  captureKeyboardEvent,
  checkShortcutConflict,
  describeCommandId,
  formatMaskedApiKey,
  suggestClosestLanguage,
} from "./shortcut-capture"
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "../settings/model"
import { VOICE_COMMAND_AGENT, VOICE_COMMAND_TRANSCRIPTION } from "../settings/shortcuts"
import { matchesChord, parseChord } from "@nikcli-ai/ade/keyboard/keymap"
import { DEFAULT_BINDINGS } from "@nikcli-ai/ade/keyboard/bindings"

describe("ui/shortcut-capture", () => {
  describe("captureKeyboardEvent", () => {
    test("captures a valid key combination on other (Windows/Linux) platform", () => {
      const result = captureKeyboardEvent(
        {
          key: "k",
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
          metaKey: false,
        },
        "other"
      )

      expect(result.type).toBe("chord")
      if (result.type === "chord") {
        expect(result.chord).toBe("mod+shift+k")
        expect(result.display).toBe("Ctrl+Shift+K")
      }
    })

    test("captures a valid key combination on mac platform with Cmd", () => {
      const result = captureKeyboardEvent(
        {
          key: "k",
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
          metaKey: true,
        },
        "mac"
      )

      expect(result.type).toBe("chord")
      if (result.type === "chord") {
        expect(result.chord).toBe("mod+shift+k")
        expect(result.display).toBe("⇧⌘K")
      }
    })

    test("captures Alt+Shift+J correctly", () => {
      const result = captureKeyboardEvent(
        {
          key: "j",
          ctrlKey: false,
          shiftKey: true,
          altKey: true,
          metaKey: false,
        },
        "other"
      )

      expect(result.type).toBe("chord")
      if (result.type === "chord") {
        expect(result.chord).toBe("alt+shift+j")
        expect(result.display).toBe("Alt+Shift+J")
      }
    })

    test("handles space key as principal key", () => {
      const result = captureKeyboardEvent(
        {
          key: " ",
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          metaKey: false,
        },
        "other"
      )

      expect(result.type).toBe("chord")
      if (result.type === "chord") {
        expect(result.chord).toBe("mod+space")
        expect(result.display).toBe("Ctrl+Space")
      }
    })

    test("Escape cancels recording without modifying settings", () => {
      const result1 = captureKeyboardEvent(
        {
          key: "Escape",
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          metaKey: false,
        },
        "other"
      )
      expect(result1.type).toBe("cancel")

      const result2 = captureKeyboardEvent(
        {
          key: "Esc",
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          metaKey: false,
        },
        "mac"
      )
      expect(result2.type).toBe("cancel")
    })

    test("reports modifier_only when user presses standalone modifier keys", () => {
      const ctrlResult = captureKeyboardEvent(
        {
          key: "Control",
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          metaKey: false,
        },
        "other"
      )
      expect(ctrlResult.type).toBe("modifier_only")

      const shiftResult = captureKeyboardEvent(
        {
          key: "Shift",
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
          metaKey: false,
        },
        "mac"
      )
      expect(shiftResult.type).toBe("modifier_only")
    })

    test("ignores Tab key to permit focus movement", () => {
      const result = captureKeyboardEvent(
        {
          key: "Tab",
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          metaKey: false,
        },
        "other"
      )
      expect(result.type).toBe("ignored")
    })

    test("il tasto «+» viene registrato per nome, perché separa le parti di un accordo", () => {
      const result = captureKeyboardEvent(
        { key: "+", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
        "other"
      )

      expect(result.type).toBe("chord")
      if (result.type === "chord") {
        expect(result.chord).toBe("mod+plus")
        // Written by name, it survives the round trip back to the "+" key.
        expect(parseChord(result.chord, "other").key).toBe("+")
      }
    })
  })

  /*
   * The half nobody was testing: a recorded chord is only rebindable if the
   * runtime matcher later agrees it was pressed. Capturing and then matching
   * in one test is what catches a spelling that only one side understands.
   */
  describe("captured chord is honoured by the runtime matcher", () => {
    const press = (
      key: string,
      mods: Partial<Omit<Parameters<typeof captureKeyboardEvent>[0], "key">> = {},
    ) => ({
      key,
      ctrlKey: mods.ctrlKey ?? false,
      metaKey: mods.metaKey ?? false,
      shiftKey: mods.shiftKey ?? false,
      altKey: mods.altKey ?? false,
    })

    test.each([
      ["k", { ctrlKey: true, altKey: true }],
      [" ", { ctrlKey: true, shiftKey: true }],
      ["ArrowUp", { ctrlKey: true, altKey: true }],
      ["Enter", { altKey: true }],
      ["F9", { ctrlKey: true }],
      ["+", { ctrlKey: true }],
    ] as const)("%s fires again after being recorded", (key, mods) => {
      const captured = captureKeyboardEvent(press(key, mods), "other")
      expect(captured.type).toBe("chord")
      if (captured.type !== "chord") return

      const stored = parseChord(captured.chord, "other")
      expect(matchesChord(stored, press(key, mods))).toBe(true)
    })
  })

  describe("checkShortcutConflict", () => {
    test("detects conflict between agent chord and palette.open ADE shortcut", () => {
      const conflict = checkShortcutConflict(
        "mod+shift+p",
        VOICE_COMMAND_AGENT,
        DEFAULT_VOICE_SETTINGS,
        [],
        "other"
      )

      expect(conflict.hasConflict).toBe(true)
      expect(conflict.conflictingCommand).toBe("palette.open")
      expect(conflict.message).toContain("palette.open")
    })

    test("detects collision when agentChord is set identical to transcriptionChord", () => {
      const conflict = checkShortcutConflict(
        DEFAULT_VOICE_SETTINGS.transcriptionChord, // "mod+shift+j"
        VOICE_COMMAND_AGENT,
        DEFAULT_VOICE_SETTINGS,
        [],
        "other"
      )

      expect(conflict.hasConflict).toBe(true)
      expect(conflict.conflictingCommand).toBe(VOICE_COMMAND_TRANSCRIPTION)
      expect(conflict.message).toContain("Modalità trascrizione")
    })

    test("detects collision when transcriptionChord is set identical to agentChord", () => {
      const conflict = checkShortcutConflict(
        DEFAULT_VOICE_SETTINGS.agentChord, // "mod+shift+k"
        VOICE_COMMAND_TRANSCRIPTION,
        DEFAULT_VOICE_SETTINGS,
        [],
        "other"
      )

      expect(conflict.hasConflict).toBe(true)
      expect(conflict.conflictingCommand).toBe(VOICE_COMMAND_AGENT)
      expect(conflict.message).toContain("Modalità agente")
    })

    test("detects conflict with injected custom workbench bindings", () => {
      const customBindings = [
        {
          chord: parseChord("mod+alt+v", "other"),
          commandId: "custom.workbench.action",
        },
      ]

      const conflict = checkShortcutConflict(
        "mod+alt+v",
        VOICE_COMMAND_AGENT,
        DEFAULT_VOICE_SETTINGS,
        customBindings,
        "other"
      )

      expect(conflict.hasConflict).toBe(true)
      expect(conflict.conflictingCommand).toBe("custom.workbench.action")
    })

    test("allows distinct, non-conflicting chords", () => {
      const noConflict = checkShortcutConflict(
        "mod+alt+k",
        VOICE_COMMAND_AGENT,
        DEFAULT_VOICE_SETTINGS,
        [],
        "other"
      )

      expect(noConflict.hasConflict).toBe(false)
      expect(noConflict.conflictingCommand).toBeUndefined()
    })

    test("rejects invalid chord without principal key", () => {
      const modifierOnly = checkShortcutConflict(
        "mod+shift",
        VOICE_COMMAND_AGENT,
        DEFAULT_VOICE_SETTINGS,
        [],
        "other"
      )
      expect(modifierOnly.hasConflict).toBe(true)

      const empty = checkShortcutConflict(
        "",
        VOICE_COMMAND_AGENT,
        DEFAULT_VOICE_SETTINGS,
        [],
        "other"
      )
      expect(empty.hasConflict).toBe(true)
    })

    test("un tasto singolo che serve a scrivere viene rifiutato con la ragione", () => {
      const bare = checkShortcutConflict(
        "k",
        VOICE_COMMAND_AGENT,
        DEFAULT_VOICE_SETTINGS,
        [],
        "other"
      )
      expect(bare.hasConflict).toBe(true)
      expect(bare.message).toContain("scrivere")
      // Refused for what it is, not for who else holds it.
      expect(bare.conflictingCommand).toBeUndefined()

      const bareSpace = checkShortcutConflict(
        "space",
        VOICE_COMMAND_AGENT,
        DEFAULT_VOICE_SETTINGS,
        [],
        "other"
      )
      expect(bareSpace.hasConflict).toBe(true)
    })

    test("accetta un accordo rischioso ma lo spiega invece di bloccarlo", () => {
      const win = checkShortcutConflict(
        "meta+shift+y",
        VOICE_COMMAND_AGENT,
        DEFAULT_VOICE_SETTINGS,
        [],
        "other"
      )
      expect(win.hasConflict).toBe(false)
      expect(win.warning).toContain("Win")
    })

    test("un accordo sicuro non porta alcun avviso", () => {
      const clean = checkShortcutConflict(
        "mod+alt+y",
        VOICE_COMMAND_AGENT,
        DEFAULT_VOICE_SETTINGS,
        [],
        "other"
      )
      expect(clean.hasConflict).toBe(false)
      expect(clean.warning).toBeUndefined()
    })

    test("every ADE default binding is detected, named in Italian, and refused", () => {
      // The table is read from ADE rather than retyped here, so a binding added
      // to ADE tomorrow is covered by this test without anyone remembering to.
      for (const binding of DEFAULT_BINDINGS) {
        const conflict = checkShortcutConflict(
          binding.chord,
          VOICE_COMMAND_AGENT,
          DEFAULT_VOICE_SETTINGS,
          [],
          "other"
        )
        expect(conflict.hasConflict).toBe(true)
        expect(conflict.conflictingCommand).toBe(binding.commandId)
        // Never a bare command id: the user has to recognise what they hit.
        expect(conflict.message).toContain(describeCommandId(binding.commandId))
        expect(describeCommandId(binding.commandId)).not.toBe(binding.commandId)
      }
    })

    test("the chord already held by the other voice mode is refused", () => {
      const rebound: VoiceSettings = {
        ...DEFAULT_VOICE_SETTINGS,
        transcriptionChord: "mod+alt+d",
      }
      const conflict = checkShortcutConflict(
        "mod+alt+d",
        VOICE_COMMAND_AGENT,
        rebound,
        [],
        "other"
      )
      expect(conflict.hasConflict).toBe(true)
      expect(conflict.conflictingCommand).toBe(VOICE_COMMAND_TRANSCRIPTION)
    })

    test("lo stesso accordo scritto in un altro ordine vale come lo stesso accordo", () => {
      // Order, case and the KeyboardEvent.code spelling all reduce to one chord,
      // so none of them can be used to sneak past the collision check.
      for (const spelling of ["shift+mod+p", "MOD+SHIFT+P", "mod+shift+KeyP"]) {
        const conflict = checkShortcutConflict(
          spelling,
          VOICE_COMMAND_AGENT,
          DEFAULT_VOICE_SETTINGS,
          [],
          "other"
        )
        expect(conflict.hasConflict).toBe(true)
        expect(conflict.conflictingCommand).toBe("palette.open")
      }
    })
  })

  describe("suggestClosestLanguage", () => {
    const available = [
      { code: "it", label: "Italiano" },
      { code: "en", label: "English" },
      { code: "fr", label: "Français" },
    ]

    test("returns exact match when present", () => {
      const match = suggestClosestLanguage("fr", available)
      expect(match?.code).toBe("fr")
    })

    test("resolves regional locale to base code", () => {
      const match = suggestClosestLanguage("it-IT", available)
      expect(match?.code).toBe("it")
    })

    test("suggests Italian for unsupported Romance languages", () => {
      const match = suggestClosestLanguage("es", available)
      expect(match?.code).toBe("it")
    })

    test("suggests English for unsupported Germanic languages", () => {
      const match = suggestClosestLanguage("de", available)
      expect(match?.code).toBe("en")
    })

    test("returns undefined when available list is empty", () => {
      const match = suggestClosestLanguage("it", [])
      expect(match).toBeUndefined()
    })
  })

  describe("formatMaskedApiKey", () => {
    test("returns empty string on empty or undefined key", () => {
      expect(formatMaskedApiKey(undefined)).toBe("")
      expect(formatMaskedApiKey("")).toBe("")
      expect(formatMaskedApiKey("   ")).toBe("")
    })

    test("masks short keys without cleartext", () => {
      expect(formatMaskedApiKey("123")).toBe("••••")
      expect(formatMaskedApiKey("abcd")).toBe("••••")
    })

    test("masks standard OpenRouter keys displaying only last 4 chars", () => {
      const raw = "sk-or-v1-9876543210abcdef1234"
      const masked = formatMaskedApiKey(raw)

      expect(masked).toBe("•••• •••• •••• 1234")
      expect(masked.includes("sk-or")).toBe(false)
      expect(masked.includes("9876543210")).toBe(false)
    })
  })
})
