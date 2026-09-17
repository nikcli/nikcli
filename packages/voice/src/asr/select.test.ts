import { describe, expect, test } from "bun:test"
import { createTranscriberFor, describeBackends, type SelectTranscriberOptions } from "./select"
import { createVoiceEngine } from "../engine"
import { createFakeSpeaker } from "../tts/speaker"
import type { VoiceHost, PaneSummary } from "../bridge/host"

class SimpleHost implements VoiceHost {
  panes: PaneSummary[] = []
  async runCommand(): Promise<void> {}
  listPanes(): PaneSummary[] {
    return this.panes
  }
  focusPane(): void {}
  async sendPrompt(): Promise<void> {}
  async insertText(): Promise<void> {}
  async openFile(): Promise<void> {}
  async searchProject(): Promise<any[]> {
    return []
  }
  setPaneView(): void {}
  browserNavigate(): void {}
  reloadBrowser(): void {}
  clickBrowserCoordinate(): void {}
  pressBrowserKey(): void {}
  answerPermission(): void {}
  setColumns(): void {}
  setView(): void {}
  scrollTranscript(): void {}
  describeState(): any {
    return {
      totalSessions: 0,
      workingSessions: 0,
      waitingSessions: 0,
      doneSessions: 0,
      errorSessions: 0,
      currentView: "code",
      spokenSummary: "",
    }
  }
}

describe("asr/select", () => {
  test("describeBackends reports exact localized reasons for both backends when unavailable", () => {
    // The test runner has no OpenRouter key configured and no downloaded model
    const status = describeBackends({
      isModelDownloaded: false,
    })

    // 1. Parakeet
    expect(status.parakeet.usable).toBe(false)
    expect(status.parakeet.reason).toContain("non è ancora stato scaricato in locale")

    // 2. OpenRouter
    expect(status.openrouter.usable).toBe(false)
    expect(status.openrouter.reason).toContain("Chiave API OpenRouter mancante")
  })

  test("describeBackends reports usable when requirements are met", () => {
    const status = describeBackends({
      apiKey: "sk-or-valid-test-key",
      isModelDownloaded: true,
    })

    expect(status.parakeet.usable).toBe(true)
    expect(status.openrouter.usable).toBe(true)
  })

  test("describeBackends NEVER throws an exception even under malformed input", () => {
    expect(() => describeBackends(null as any)).not.toThrow()
    expect(() => describeBackends(undefined)).not.toThrow()
    expect(() => describeBackends({ openRouterOptions: null as any })).not.toThrow()

    const res = describeBackends(null as any)
    expect(res).toBeDefined()
    expect(res.parakeet).toBeDefined()
    expect(res.openrouter).toBeDefined()
  })

  test("createTranscriberFor instantiates the requested backend or throws clean error for unknown", () => {
    // Parakeet
    const parakeet = createTranscriberFor("parakeet", {
      parakeetOptions: {
        supportsLanguage: () => true,
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      },
    })
    expect(parakeet).toBeDefined()
    expect(typeof parakeet.start).toBe("function")

    // OpenRouter
    const openrouter = createTranscriberFor("openrouter", {
      apiKey: "test-key",
      openRouterOptions: {
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      },
    })
    expect(openrouter).toBeDefined()
    expect(typeof openrouter.start).toBe("function")

    // Unknown backend
    expect(() => createTranscriberFor("invalid-engine" as any)).toThrow(/Backend di trascrizione non riconosciuto/i)
  })

  test("createVoiceEngine automatically constructs transcriber when backend option is provided", () => {
    const host = new SimpleHost()
    const speaker = createFakeSpeaker()

    const engine = createVoiceEngine({
      host,
      speaker,
      now: () => 1000,
      backend: "openrouter",
      backendOptions: {
        apiKey: "test-key",
        openRouterOptions: {
          captureOptions: {
            mediaStream: { getTracks: () => [] } as any,
            isTypeSupported: () => true,
          },
        },
      },
      settings: { activation: "toggle" },
    })

    expect(engine).toBeDefined()
    expect(engine.status()).toBe("idle")
    expect(typeof engine.start).toBe("function")
  })
})
