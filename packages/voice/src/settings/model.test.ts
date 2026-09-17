import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_VOICE_SETTINGS,
  WAKE_PHRASE,
  WAKE_WORD_ENABLED,
  normalizeSettings,
  setShortcutActivationEnabledForTests,
  setWakeWordEnabledForTests,
  SHORTCUT_ACTIVATION_ENABLED,
} from "./model"

describe("settings/model - normalizeSettings", () => {
  // The wake word, on by default; set here so the block does not depend on the order it runs in.
  beforeAll(() => setWakeWordEnabledForTests(true))
  afterAll(() => setWakeWordEnabledForTests(true))
  test("handles null, undefined, primitive, and empty inputs without throwing", () => {
    const inputs = [null, undefined, 42, "string", true, [], {}]

    for (const input of inputs) {
      expect(() => normalizeSettings(input)).not.toThrow()
      const res = normalizeSettings(input)

      expect(res.version).toBe(CURRENT_SETTINGS_VERSION)
      expect(res.mode).toBe("agent")
      expect(res.activation).toBe("wake-word")
      expect(res.transcriptionSend).toBe("manual")
      expect(res.language).toBe("it")
      expect(res.wakeWord).toBe("nik")
      expect(res.agentChord).toBe("mod+shift+k")
      expect(res.transcriptionChord).toBe("mod+shift+j")
      expect(res.backend).toBe("openrouter")
      expect(res.parakeetBackend).toBe("auto")

      expect(res.corrections.length).toBeGreaterThan(0)
      // Allows destructuring { settings, corrections }
      expect(res.settings.mode).toBe("agent")
    }
  })

  test("resets out-of-domain values to defaults and records Italian explanations", () => {
    const corrupted = {
      version: 1,
      mode: "telepathic",
      activation: "always-on",
      transcriptionSend: "later",
      backend: "quantum-asr",
      parakeetBackend: "cuda",
      language: "",
      wakeWord: "   ",
      agentChord: "ctrl+shift", // Missing principal key!
      transcriptionChord: "+++", // Invalid chord!
    }

    const res = normalizeSettings(corrupted)

    expect(res.mode).toBe("agent")
    expect(res.activation).toBe("wake-word")
    expect(res.transcriptionSend).toBe("manual")
    expect(res.backend).toBe("openrouter")
    expect(res.parakeetBackend).toBe("auto")
    expect(res.language).toBe("it")
    expect(res.wakeWord).toBe("nik")
    expect(res.agentChord).toBe("mod+shift+k")
    expect(res.transcriptionChord).toBe("mod+shift+j")

    expect(res.corrections.some((c) => c.includes("Modalità"))).toBe(true)
    expect(res.corrections.some((c) => c.includes("Attivazione"))).toBe(true)
    expect(res.corrections.some((c) => c.includes("Backend"))).toBe(true)
    expect(res.corrections.some((c) => c.includes("Scorciatoia"))).toBe(true)
  })

  test("migrates legacy schema versions to CURRENT_SETTINGS_VERSION", () => {
    const legacy = {
      version: 0,
      mode: "transcription",
      activation: "push-to-talk",
      transcriptionSend: "auto",
      language: "en",
      wakeWord: "hey agent",
      agentChord: "mod+shift+k",
      transcriptionChord: "mod+shift+j",
      backend: "parakeet",
      parakeetBackend: "webgpu",
    }

    const res = normalizeSettings(legacy)

    expect(res.version).toBe(CURRENT_SETTINGS_VERSION)
    // The shortcut moves to the name, and with it the default mode to the agent's.
    expect(res.mode).toBe("agent")
    expect(res.activation).toBe("wake-word")
    expect(res.migrations).toContain("name-only")
    expect(res.transcriptionSend).toBe("auto")
    expect(res.language).toBe("en")
    // The phrase is fixed: a stored one is replaced.
    expect(res.wakeWord).toBe("nik")
    // A stored choice survives migration; only a missing or invalid one falls
    // back to the default, which is now the cloud engine.
    expect(res.backend).toBe("parakeet")
    expect(res.parakeetBackend).toBe("webgpu")
    // Moving to a newer version is not reported as a repair.
    expect(res.corrections.some((c) => c.includes("Migrata versione"))).toBe(false)
  })

  test("a profile written before the name was asked for is moved to it, once and only from toggle", () => {
    const old = { version: 1, activation: "toggle" as const }
    const moved = normalizeSettings(old)
    expect(moved.activation).toBe("wake-word")
    expect(moved.migrations).toEqual(["wake-word", "always-listen"])
    expect(moved.corrections.some((line) => line.includes("per nome"))).toBe(true)

    // Push-to-talk moves to the name too, since version 6.
    const heldKey = normalizeSettings({ version: 1, activation: "push-to-talk" })
    expect(heldKey.activation).toBe("wake-word")
    expect(heldKey.migrations).toEqual(["name-only"])
    // And a profile that chose toggle *after* this version keeps it.
    expect(normalizeSettings({ ...moved, activation: "toggle" }).activation).toBe("toggle")
  })

  test("the name is fixed to «nik», whatever was stored", () => {
    for (const wakeWord of ["hei nik", "nik", "jarvis", "", undefined]) {
      const res = normalizeSettings({ version: 2, activation: "wake-word" as const, wakeWord })
      expect(res.wakeWord).toBe(WAKE_PHRASE)
      // Replaced without a word: it is not the user's to set.
      expect(res.corrections.some((line) => line.includes("richiamo"))).toBe(false)
    }
    expect(WAKE_PHRASE).toBe("nik")
  })

  test("always-on listening is the default, and a profile on the wake word is told once", () => {
    expect(DEFAULT_VOICE_SETTINGS.alwaysListen).toBe(WAKE_WORD_ENABLED)
    const moved = normalizeSettings({ version: 2, mode: "agent", activation: "wake-word" as const, alwaysListen: true })
    expect(moved.alwaysListen).toBe(true)
    expect(moved.migrations).toEqual(["always-listen"])
    // Written back at version 3, it is not told again, and a choice of off is kept.
    expect(normalizeSettings({ ...moved.settings, alwaysListen: false }).migrations).toEqual([])
    expect(normalizeSettings({ ...moved.settings, alwaysListen: false }).alwaysListen).toBe(false)
    // Dictation on the wake word is not told anything.
    expect(normalizeSettings({ version: 2, mode: "transcription", activation: "wake-word" }).migrations).toEqual([])
    // Not a boolean: the default.
    expect(normalizeSettings({ version: 3, alwaysListen: "si" }).alwaysListen).toBe(DEFAULT_VOICE_SETTINGS.alwaysListen)
  })

  test("preserves valid configuration with zero corrections", () => {
    const valid = {
      version: CURRENT_SETTINGS_VERSION,
      mode: "transcription" as const,
      activation: "wake-word" as const,
      transcriptionSend: "auto" as const,
      language: "it",
      wakeWord: "hei nik",
      agentChord: "ctrl+shift+a",
      transcriptionChord: "ctrl+shift+t",
      backend: "openrouter" as const,
      openRouterApiKey: "sk-or-test-key",
      parakeetBackend: "wasm" as const,
    }

    const res = normalizeSettings(valid)

    expect(res.mode).toBe("transcription")
    expect(res.activation).toBe("wake-word")
    expect(res.openRouterApiKey).toBe("sk-or-test-key")
    expect(res.corrections).toHaveLength(0)
  })

  /*
   * Storage is reachable without the panel. A hand-edited profile, or one
   * copied from another machine, can carry a chord the recorder would never
   * have accepted — and it would arrive holding a key the user types with.
   */
  describe("scorciatoie pericolose salvate fuori dal pannello", () => {
    test("a bare printable key is repaired to the default and explained", () => {
      const res = normalizeSettings({
        ...DEFAULT_VOICE_SETTINGS,
        agentChord: "k",
        transcriptionChord: "shift+j",
      })

      expect(res.agentChord).toBe(DEFAULT_VOICE_SETTINGS.agentChord)
      expect(res.transcriptionChord).toBe(DEFAULT_VOICE_SETTINGS.transcriptionChord)
      expect(res.corrections.some((c) => c.includes("modalità agente"))).toBe(true)
      expect(res.corrections.some((c) => c.includes("scrivere"))).toBe(true)
    })

    test("a freely chosen chord that is safe is kept exactly as written", () => {
      const res = normalizeSettings({
        ...DEFAULT_VOICE_SETTINGS,
        agentChord: "mod+alt+space",
        transcriptionChord: "alt+shift+f9",
      })

      expect(res.agentChord).toBe("mod+alt+space")
      expect(res.transcriptionChord).toBe("alt+shift+f9")
      expect(res.corrections).toHaveLength(0)
    })
  })

  /*
   * The correction list rewrites what the user said before an agent reads it,
   * so what goes in it has to be exactly what they put there — nothing
   * seeded, nothing duplicated, nothing that is not a word.
   */
  describe("custom words", () => {
    test("nothing is assumed on the user's behalf", () => {
      expect(normalizeSettings({}).customWords).toEqual([])
    })

    test("the user's spelling is kept, trimmed, and blanks dropped", () => {
      const res = normalizeSettings({ customWords: ["  opencode ", "", "   ", "Tauri"] })
      expect(res.customWords).toEqual(["opencode", "Tauri"])
      // The other fields were absent and get their own corrections; trimming
      // and dropping blanks is not itself something to report.
      expect(res.corrections.some((c) => c.toLowerCase().includes("parole"))).toBe(false)
    })

    /*
     * Two spellings of the same word would both be candidates, and the
     * transcript would flip between them depending on which scored first.
     */
    test("duplicates are removed regardless of case", () => {
      expect(normalizeSettings({ customWords: ["NikCLI", "nikcli"] }).customWords).toEqual(["NikCLI"])
    })

    test("non-textual entries are dropped and reported", () => {
      const res = normalizeSettings({ customWords: ["opencode", 42, null, { a: 1 }] })
      expect(res.customWords).toEqual(["opencode"])
      expect(res.corrections.some((c) => c.includes("non testuali"))).toBe(true)
    })

    test("a list that is not a list empties it and says so", () => {
      const res = normalizeSettings({ customWords: "opencode" })
      expect(res.customWords).toEqual([])
      expect(res.corrections.some((c) => c.includes("non valido"))).toBe(true)
    })
  })
})

describe("settings/model agentEngine", () => {
  test("absent is the default without a correction; unknown is repaired aloud", () => {
    const absent = normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, agentEngine: undefined } as never)
    expect(absent.settings.agentEngine).toBe("auto")
    expect(absent.corrections.some((c) => c.includes("Motore"))).toBe(false)

    const unknown = normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, agentEngine: "gemini" } as never)
    expect(unknown.settings.agentEngine).toBe("auto")
    expect(unknown.corrections.some((c) => c.includes("gemini"))).toBe(true)

    expect(normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, agentEngine: "codex" }).settings.agentEngine).toBe("codex")
  })
})

describe("settings/model replyVoice", () => {
  test("Ugo by default, an unknown voice repaired to Ugo, a known one kept", () => {
    expect(DEFAULT_VOICE_SETTINGS.replyVoice).toBe("ugo")
    const absent = normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, replyVoice: undefined } as never)
    expect(absent.settings.replyVoice).toBe("ugo")
    expect(absent.corrections).toEqual([])
    // Giorgio was offered before D19 kept only Ugo and Paola.
    expect(normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, replyVoice: "giorgio" } as never).settings.replyVoice).toBe("ugo")
    expect(normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, replyVoice: "paola" }).settings.replyVoice).toBe("paola")
    const unknown = normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, replyVoice: "kokoro" } as never)
    expect(unknown.settings.replyVoice).toBe("ugo")
    expect(unknown.corrections.join()).toContain("kokoro")
    expect(normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, replyVoice: "system" }).settings.replyVoice).toBe("system")
  })
})

describe("repairs and warnings follow the language", () => {
  test("a repaired setting and a risky shortcut are described in English under English", async () => {
    const { resetLocaleForTests } = await import("@nikcli-ai/ade/i18n")
    const { describeChordRisk } = await import("./shortcuts")
    resetLocaleForTests("en")
    try {
      const { corrections } = normalizeSettings({ version: CURRENT_SETTINGS_VERSION, mode: "boh" })
      expect(corrections).toContain(`Unknown mode 'boh': restored '${DEFAULT_VOICE_SETTINGS.mode}'.`)
      expect(describeChordRisk("Ctrl+Shift").message).toBe("Invalid shortcut: a main key is missing.")
    } finally {
      resetLocaleForTests("it")
    }
  })
})

describe("after 0.7.0: only the name starts the assistant", () => {
  test("switched on, and a new profile listens for the name, always", () => {
    expect(WAKE_WORD_ENABLED).toBe(true)
    expect(SHORTCUT_ACTIVATION_ENABLED).toBe(false)
    const fresh = normalizeSettings({})
    expect(fresh.activation).toBe("wake-word")
    expect(fresh.alwaysListen).toBe(true)
    expect(fresh.wakeWord).toBe("nik")
  })

  test("a 0.7.0 profile on the shortcut moves to the name once, told and without an error", () => {
    const saved = { ...DEFAULT_VOICE_SETTINGS, version: 5, mode: "transcription", activation: "push-to-talk", alwaysListen: false }
    const moved = normalizeSettings(saved)
    expect(moved.activation).toBe("wake-word")
    expect(moved.alwaysListen).toBe(true)
    expect(moved.mode).toBe("agent")
    expect(moved.migrations).toEqual(["name-only"])
    expect(moved.corrections).toEqual([])
    // Written back, it is not moved or told again, and turning always-on off is kept.
    expect(normalizeSettings(moved.settings).migrations).toEqual([])
    expect(normalizeSettings({ ...moved.settings, alwaysListen: false }).alwaysListen).toBe(false)
    // Toggle, and a profile with no version, too.
    expect(normalizeSettings({ ...saved, activation: "toggle" }).activation).toBe("wake-word")
    expect(normalizeSettings({ activation: "push-to-talk" }).migrations).toEqual(["name-only"])
    // A caller stating the current version keeps what it asked for.
    expect(normalizeSettings({ version: CURRENT_SETTINGS_VERSION, activation: "push-to-talk" }).activation).toBe("push-to-talk")
  })
})

describe("0.7.0: the assistant starts only from its shortcut", () => {
  // The 0.7.0 world, kept behind the switches: the wake word off, the shortcut the way in.
  beforeAll(() => {
    setWakeWordEnabledForTests(false)
    setShortcutActivationEnabledForTests(true)
  })
  afterAll(() => {
    setWakeWordEnabledForTests(true)
    setShortcutActivationEnabledForTests(false)
  })

  test("a saved wake word, always-on or not, goes back to the shortcut once, told and without an error", () => {
    // A whole profile, as the app writes it.
    const saved = { ...DEFAULT_VOICE_SETTINGS, version: 3, mode: "agent", activation: "wake-word", alwaysListen: true, wakeWord: "ei nik" }
    const moved = normalizeSettings(saved)
    expect(moved.activation).toBe("push-to-talk")
    expect(moved.migrations).toEqual(["shortcut-only"])
    // Nothing to warn about at startup.
    expect(moved.corrections).toEqual([])
    // Written back, it is not told again.
    expect(normalizeSettings(moved.settings).migrations).toEqual([])
    // The shortcut is left as it was.
    expect(normalizeSettings({ version: 3, activation: "push-to-talk" }).migrations).toEqual([])
  })

  test("a profile with no version and toggle goes back to the shortcut as well", () => {
    const moved = normalizeSettings({ mode: "agent", activation: "toggle" })
    expect(moved.activation).toBe("push-to-talk")
    expect(moved.migrations).toEqual(["shortcut-only"])
    expect(normalizeSettings(moved.settings).activation).toBe("push-to-talk")
    // A caller that states the current version keeps what it asked for.
    expect(normalizeSettings({ version: CURRENT_SETTINGS_VERSION, activation: "toggle" }).activation).toBe("toggle")
  })

  test("a saved toggle goes back to the shortcut too, never to the wake word", () => {
    for (const version of [1, 2, 3, 4]) {
      const moved = normalizeSettings({ version, activation: "toggle" })
      expect(moved.activation).toBe("push-to-talk")
      expect(moved.migrations).toEqual(["shortcut-only"])
      expect(normalizeSettings(moved.settings).migrations).toEqual([])
    }
  })
})

describe("the agent's speed", () => {
  test("fast by default and for older profiles; an unknown value is repaired aloud", () => {
    expect(normalizeSettings({}).settings.agentSpeed).toBe("fast")
    expect(normalizeSettings({ version: 5 }).settings.agentSpeed).toBe("fast")
    expect(normalizeSettings({ agentSpeed: "cli" }).settings.agentSpeed).toBe("cli")
    const odd = normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, agentSpeed: "lampo" })
    expect(odd.settings.agentSpeed).toBe("fast")
    expect(odd.corrections).toEqual([expect.stringContaining("lampo")])
  })
})
