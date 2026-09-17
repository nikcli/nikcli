import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  VOICE_API_KEY_STORAGE_KEY,
  VOICE_SETTINGS_STORAGE_KEY,
  clearVoiceSettings,
  exportVoiceSettings,
  loadVoiceSettings,
  resetVoiceSettings,
  saveVoiceSettings,
} from "./storage"
import { DEFAULT_VOICE_SETTINGS, setShortcutActivationEnabledForTests, setWakeWordEnabledForTests } from "./model"

class MemoryStorage implements Storage {
  private data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

class ThrowingStorage implements Storage {
  length = 0
  clear(): void {
    throw new Error("SecurityError: Access denied")
  }
  getItem(): string | null {
    throw new Error("SecurityError: Access denied")
  }
  key(): string | null {
    throw new Error("SecurityError: Access denied")
  }
  removeItem(): void {
    throw new Error("SecurityError: Access denied")
  }
  setItem(): void {
    throw new Error("QuotaExceededError")
  }
}

describe("settings/storage", () => {
  test("loads default settings when storage is empty", () => {
    const storage = new MemoryStorage()
    const settings = loadVoiceSettings(storage)
    expect(settings.mode).toBe(DEFAULT_VOICE_SETTINGS.mode)
    expect(settings.agentChord).toBe(DEFAULT_VOICE_SETTINGS.agentChord)
  })

  test("persists and reloads modified settings through normalizeSettings", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings(
      {
        mode: "transcription",
        transcriptionSend: "auto",
        language: "en",
      },
      storage,
    )

    const raw = storage.getItem(VOICE_SETTINGS_STORAGE_KEY)
    expect(raw).not.toBeNull()

    const loaded = loadVoiceSettings(storage)
    expect(loaded.mode).toBe("transcription")
    expect(loaded.transcriptionSend).toBe("auto")
    expect(loaded.language).toBe("en")
    expect(loaded.agentChord).toBe(DEFAULT_VOICE_SETTINGS.agentChord)
  })

  /*
   * "Survives a reload" is the whole promise of a rebindable shortcut, and it
   * is the one thing that cannot be seen in the panel. A second load from the
   * same store is what a fresh window does.
   */
  test("le scorciatoie riassegnate sopravvivono al riavvio", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ agentChord: "mod+alt+space", transcriptionChord: "alt+shift+f9" }, storage)

    const reopened = loadVoiceSettings(storage)
    expect(reopened.agentChord).toBe("mod+alt+space")
    expect(reopened.transcriptionChord).toBe("alt+shift+f9")
    expect(reopened.corrections).toHaveLength(0)
  })

  test("una scorciatoia pericolosa già presente nel profilo viene riparata al caricamento", () => {
    const storage = new MemoryStorage()
    // Not written by the panel: the recorder refuses this. A hand-edited or
    // copied profile is the only way it gets here.
    storage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, agentChord: "k" }))

    const loaded = loadVoiceSettings(storage)
    expect(loaded.agentChord).toBe(DEFAULT_VOICE_SETTINGS.agentChord)
    expect(loaded.corrections.some((c) => c.includes("Scorciatoia"))).toBe(true)
  })

  test("gracefully recovers when storage throws (private window / security restriction)", () => {
    const throwingStore = new ThrowingStorage()

    expect(() => loadVoiceSettings(throwingStore)).not.toThrow()
    const loaded = loadVoiceSettings(throwingStore)
    expect(loaded.mode).toBe("agent")

    expect(() => saveVoiceSettings({ mode: "transcription" }, throwingStore)).not.toThrow()
    const saved = saveVoiceSettings({ mode: "transcription" }, throwingStore)
    expect(saved.mode).toBe("transcription")
    expect(saved.corrections.length).toBeGreaterThan(0)
  })

  test("clears storage and restores defaults", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ mode: "transcription" }, storage)
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).not.toBeNull()

    clearVoiceSettings(storage)
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).toBeNull()

    const loaded = loadVoiceSettings(storage)
    expect(loaded.mode).toBe("agent")
  })
})

/*
 * La chiave OpenRouter era un campo come gli altri dentro `voice.settings`:
 * qualunque cosa toccasse le impostazioni toccava la credenziale. Un blob
 * copiato per una segnalazione, un dump nei log, una futura funzione di
 * esportazione — ognuno avrebbe portato con sé una chiave viva senza che
 * nessuno avesse deciso che dovesse.
 */
describe("la chiave API sta fuori dal blob delle impostazioni", () => {
  test("viene salvata in una voce sua, e il blob non la contiene", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ openRouterApiKey: "sk-or-segreta" }, storage)

    expect(storage.getItem(VOICE_API_KEY_STORAGE_KEY)).toBe("sk-or-segreta")
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).not.toContain("sk-or-segreta")
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).not.toContain("openRouterApiKey")
  })

  test("rileggendo, la chiave torna al suo posto", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ openRouterApiKey: "sk-or-segreta", mode: "transcription" }, storage)

    const loaded = loadVoiceSettings(storage)
    expect(loaded.openRouterApiKey).toBe("sk-or-segreta")
    expect(loaded.mode).toBe("transcription")
  })

  /*
   * Un profilo scritto prima della separazione ha ancora la chiave dentro il
   * blob: leggerla da lì tiene l'utente collegato, e il primo salvataggio la
   * sposta fuori per sempre.
   */
  test("una chiave scritta dalla versione precedente viene recuperata e poi migrata", () => {
    const storage = new MemoryStorage()
    storage.setItem(
      VOICE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, openRouterApiKey: "sk-or-vecchia" }),
    )

    expect(loadVoiceSettings(storage).openRouterApiKey).toBe("sk-or-vecchia")

    saveVoiceSettings({}, storage)
    expect(storage.getItem(VOICE_SETTINGS_STORAGE_KEY)).not.toContain("sk-or-vecchia")
    expect(storage.getItem(VOICE_API_KEY_STORAGE_KEY)).toBe("sk-or-vecchia")
  })

  test("togliere la chiave la rimuove davvero dal disco", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ openRouterApiKey: "sk-or-segreta" }, storage)
    saveVoiceSettings({ openRouterApiKey: "" }, storage)

    expect(storage.getItem(VOICE_API_KEY_STORAGE_KEY)).toBeNull()
    expect(loadVoiceSettings(storage).openRouterApiKey).toBeUndefined()
  })

  test("«reset» non lascia dietro una chiave API", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ openRouterApiKey: "sk-or-segreta" }, storage)

    resetVoiceSettings(storage)

    expect(storage.getItem(VOICE_API_KEY_STORAGE_KEY)).toBeNull()
    expect(loadVoiceSettings(storage).openRouterApiKey).toBeUndefined()
  })

  test("l'export non può portarla fuori per distrazione", () => {
    const storage = new MemoryStorage()
    saveVoiceSettings({ openRouterApiKey: "sk-or-segreta", language: "en" }, storage)

    const exported = exportVoiceSettings(storage)
    expect(JSON.stringify(exported)).not.toContain("sk-or-segreta")
    expect("openRouterApiKey" in exported).toBe(false)
    // E resta utile: il resto delle impostazioni c'è.
    expect(exported.language).toBe("en")
  })
})

describe("the migration to the wake word happens once", () => {
  // The wake word, on by default; set here so the block does not depend on the order it runs in.
  beforeAll(() => setWakeWordEnabledForTests(true))
  afterAll(() => setWakeWordEnabledForTests(true))
  test("a profile is written back with the new version, so the notice is not shown at every start", () => {
    const store = new MemoryStorage()
    store.setItem("voice.settings", JSON.stringify({ version: 1, activation: "toggle", mode: "agent" }))

    const first = loadVoiceSettings(store)
    expect(first.settings.activation).toBe("wake-word")
    expect(first.migrations).toEqual(["wake-word", "always-listen"])

    const second = loadVoiceSettings(store)
    expect(second.settings.activation).toBe("wake-word")
    expect(second.migrations).toEqual([])
  })

  test("a stored name is rewritten to the fixed phrase in the profile", () => {
    const store = new MemoryStorage()
    store.setItem("voice.settings", JSON.stringify({ version: 2, activation: "wake-word", wakeWord: "hei nik" }))

    expect(loadVoiceSettings(store).settings.wakeWord).toBe("nik")
    expect(JSON.parse(store.getItem("voice.settings") ?? "{}").wakeWord).toBe("nik")
    expect(loadVoiceSettings(store).migrations).toEqual([])
  })
})

describe("0.7.0: a profile saved on the wake word", () => {
  // The 0.7.0 world, kept behind the switches: the wake word off, the shortcut the way in.
  beforeAll(() => {
    setWakeWordEnabledForTests(false)
    setShortcutActivationEnabledForTests(true)
  })
  afterAll(() => {
    setWakeWordEnabledForTests(true)
    setShortcutActivationEnabledForTests(false)
  })
  test("is written back on the shortcut, and told only the first time", () => {
    const store = new MemoryStorage()
    store.setItem(
      "voice.settings",
      JSON.stringify({ version: 3, activation: "wake-word", alwaysListen: true, mode: "agent" }),
    )
    const first = loadVoiceSettings(store)
    expect(first.settings.activation).toBe("push-to-talk")
    expect(first.migrations).toEqual(["shortcut-only"])
    expect(JSON.parse(store.getItem("voice.settings") ?? "{}").activation).toBe("push-to-talk")
    expect(loadVoiceSettings(store).migrations).toEqual([])
  })
})

describe("after 0.7.0: a profile saved on the shortcut", () => {
  test("is written back listening for the name, and told only the first time", () => {
    const store = new MemoryStorage()
    store.setItem(
      "voice.settings",
      JSON.stringify({ version: 5, activation: "push-to-talk", alwaysListen: false, mode: "agent" }),
    )
    const first = loadVoiceSettings(store)
    expect(first.settings.activation).toBe("wake-word")
    expect(first.settings.alwaysListen).toBe(true)
    expect(first.migrations).toEqual(["name-only"])
    expect(JSON.parse(store.getItem("voice.settings") ?? "{}").activation).toBe("wake-word")
    expect(loadVoiceSettings(store).migrations).toEqual([])
  })
})
