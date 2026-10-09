import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  DEFAULT_VOICE_SETTINGS,
  normalizeSettings,
  setShortcutActivationEnabledForTests,
  setWakeWordEnabledForTests,
} from "./settings/model"
import { createVoiceEngine, holdsToTalk } from "./engine"
import { FOLLOW_UP_MS, WAKE_WINDOW_MS } from "./effect/program"
import { firstWords } from "./dialog/while-thinking"
import { createFakeTranscriber } from "./asr/fake"
import { createFakeSpeaker } from "./tts/speaker"
import { VOCABULARY } from "./intent/vocabulary"
import type { AdeView, PaneSummary, VoiceHost, VoiceStateSnapshot } from "./bridge/host"

class MockVoiceHost implements VoiceHost {
  calls: { method: string; args: any[] }[] = []
  panes: PaneSummary[] = [
    {
      id: "pane-1",
      title: "Worker Process",
      status: "working",
      index: 1,
      hasLiveProcess: true,
      isBrowser: false,
      isFile: false,
    },
    {
      id: "pane-2",
      title: "Preview",
      status: "done",
      index: 2,
      hasLiveProcess: false,
      isBrowser: true,
      isFile: false,
    },
  ]

  async runCommand(id: string): Promise<void> {
    this.calls.push({ method: "runCommand", args: [id] })
  }

  releaseAgent(): void {
    this.calls.push({ method: "releaseAgent", args: [] })
  }

  listPanes(): PaneSummary[] {
    return this.panes
  }

  focusPane(paneId: string): void {
    this.calls.push({ method: "focusPane", args: [paneId] })
  }

  async sendPrompt(paneId: string, text: string): Promise<void> {
    this.calls.push({ method: "sendPrompt", args: [paneId, text] })
  }

  async insertText(paneId: string, text: string): Promise<void> {
    this.calls.push({ method: "insertText", args: [paneId, text] })
  }

  async openFile(path: string): Promise<void> {
    this.calls.push({ method: "openFile", args: [path] })
  }

  async searchProject(query: string): Promise<{ path: string; line?: number }[]> {
    this.calls.push({ method: "searchProject", args: [query] })
    return []
  }

  setPaneView(paneId: string, view: "transcript" | "diff"): void {
    this.calls.push({ method: "setPaneView", args: [paneId, view] })
  }

  browserNavigate(paneId: string, url: string): void {
    this.calls.push({ method: "browserNavigate", args: [paneId, url] })
  }

  answerPermission(paneId: string, answer: "allow" | "deny", what?: string): void {
    this.calls.push({
      method: "answerPermission",
      args: what === undefined ? [paneId, answer] : [paneId, answer, what],
    })
  }

  setColumns(columns?: number): void {
    this.calls.push({ method: "setColumns", args: [columns] })
  }

  setView(view: AdeView): void {
    this.calls.push({ method: "setView", args: [view] })
  }

  scrollTranscript(paneId: string, delta: number): void {
    this.calls.push({ method: "scrollTranscript", args: [paneId, delta] })
  }

  describeState(): VoiceStateSnapshot {
    return {
      totalSessions: 2,
      workingSessions: 1,
      waitingSessions: 0,
      doneSessions: 1,
      errorSessions: 0,
      currentView: "code",
      spokenSummary: "ADE ha 2 sessioni attive.",
    }
  }
}

describe("engine/createVoiceEngine", () => {
  function setupEngine(initialTime = 10_000) {
    let currentTime = initialTime
    const host = new MockVoiceHost()
    const transcriber = createFakeTranscriber()
    const speaker = createFakeSpeaker()

    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker,
      getContext: () => ({ focusedPaneId: "pane-1" }),
      now: () => currentTime,
      settings: { activation: "toggle" },
    })

    return {
      engine,
      host,
      transcriber,
      speaker,
      advanceTime: (ms: number) => {
        currentTime += ms
      },
    }
  }

  test("full cycle: spoken phrase dispatches to VoiceHost cleanly without preset offline readback", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    await engine.start()
    expect(engine.isRunning()).toBe(true)
    expect(engine.status()).toBe("idle")

    // User speaks non-destructive command "nuova sessione"
    transcriber.emit("nuova sessione", true)

    // Allow async dispatch execution
    await new Promise((r) => setTimeout(r, 10))

    // Host should receive runCommand("session.new")
    expect(host.calls).toContainEqual({
      method: "runCommand",
      args: ["session.new"],
    })

    // Preset readbacks are removed: speaker must not speak canned offline phrase
    expect(speaker.spoken).not.toContain("Creo una nuova sessione")

    // Outcome and status should reflect completion
    expect(engine.lastOutcome()?.success).toBe(true)
    expect(engine.status()).toBe("idle")
  })

  test("turning the voice off lets the agent kept ready go", async () => {
    const { engine, host } = setupEngine()
    await engine.start()
    expect(host.calls.some((call) => call.method === "releaseAgent")).toBe(false)
    await engine.stop()
    expect(host.calls.some((call) => call.method === "releaseAgent")).toBe(true)
  })

  test("submitText allows keyboard or accessibility invocation", async () => {
    const { engine, host } = setupEngine()

    await engine.start()
    await engine.submitText("apri la tavolozza")

    expect(host.calls).toContainEqual({
      method: "runCommand",
      args: ["palette.open"],
    })
  })

  test("text typed with the microphone off still reaches the assistant, and opens no microphone", async () => {
    const { engine, host } = setupEngine()

    await engine.submitText("apri la tavolozza")
    await engine.submitText("apri la tavolozza")

    expect(host.calls.filter((call) => call.method === "runCommand")).toEqual([
      { method: "runCommand", args: ["palette.open"] },
      { method: "runCommand", args: ["palette.open"] },
    ])
    expect(engine.isRunning()).toBe(false)
    expect(engine.history().filter((entry) => entry.kind === "user")).toHaveLength(2)
  })

  describe("typed text with push-to-talk or a wake word", () => {
    function withActivation(activation: "push-to-talk" | "wake-word") {
      const host = new MockVoiceHost()
      const engine = createVoiceEngine({
        host,
        transcriber: createFakeTranscriber(),
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation, mode: "agent" },
      })
      const opened = () => host.calls.filter((call) => call.method === "runCommand").length
      return { engine, opened }
    }

    test("push-to-talk: nothing is held, and the typed sentence still runs", async () => {
      const { engine, opened } = withActivation("push-to-talk")
      await engine.submitText("apri la tavolozza")
      expect(opened()).toBe(1)
    })

    test("wake word: the sentence runs without it, and a leading one is dropped", async () => {
      const { engine, opened } = withActivation("wake-word")
      await engine.submitText("apri la tavolozza")
      await engine.submitText("hei nik apri la tavolozza")
      expect(opened()).toBe(2)
    })

    test("once the microphone's session is up, typed text runs once, through it", async () => {
      const { engine, opened } = withActivation("wake-word")
      await engine.submitText("apri la tavolozza")
      await engine.start()
      await engine.submitText("apri la tavolozza")
      expect(opened()).toBe(2)
      await engine.stop()
    })
  })

  /*
   * Starting is not instant. With the local backend it means downloading and
   * initialising a model — minutes, not milliseconds — and `isRunning()` was
   * only written at the end of it. Everything below happens inside that
   * window, and each case used to leave a microphone open that nothing could
   * close: two presses built two sessions and the first became unreachable; a
   * stop closed scopes that were still null and the session that landed
   * afterwards kept recording behind an interface saying it was off.
   */
  describe("avvio lento", () => {
    /** A transcriber whose `start()` resolves only when the test says so. */
    function slowTranscriber() {
      let release: (() => void) | undefined
      let starts = 0
      let stops = 0
      return {
        get starts() {
          return starts
        },
        get stops() {
          return stops
        },
        finish: () => release?.(),
        transcriber: {
          start: () => {
            starts += 1
            return new Promise<void>((resolve) => {
              release = resolve
            })
          },
          stop: () => {
            stops += 1
          },
          onPartial: () => {},
          onFinal: () => {},
          onError: () => {},
        },
      }
    }

    test("openResponseWindow does not attach to a start in flight", async () => {
      const slow = slowTranscriber()
      const engine = createVoiceEngine({
        host: new MockVoiceHost(),
        transcriber: slow.transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation: "toggle" },
      })

      const starting = engine.start("transcription")
      while (slow.starts < 1) await new Promise((resolve) => setTimeout(resolve, 0))
      let openingSettled = false
      const opening = engine.openResponseWindow({ durationMs: 30 }).then(() => {
        openingSettled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      const settledBeforeStart = openingSettled
      slow.finish()
      await Promise.all([starting, opening])

      expect(settledBeforeStart).toBe(true)
      expect(engine.activeMode()).toBe("transcription")
      expect(engine.followUp()).toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(engine.activeMode()).toBe("transcription")
      expect(engine.isRunning()).toBe(true)
      await engine.stop()
    })

    test("response-window startup yields to an in-flight dictation takeover", async () => {
      const slow = slowTranscriber()
      const engine = createVoiceEngine({
        host: new MockVoiceHost(),
        transcriber: slow.transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation: "toggle", mode: "agent" },
      })

      const opening = engine.openResponseWindow({ durationMs: 30 })
      while (slow.starts < 1) await new Promise((resolve) => setTimeout(resolve, 0))
      const takeover = engine.pressToTalk("transcription")
      await new Promise((resolve) => setTimeout(resolve, 10))
      slow.finish()
      await Promise.all([opening, takeover])

      expect(engine.activeMode()).toBe("transcription")
      expect(engine.followUp()).toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(engine.activeMode()).toBe("transcription")
      expect(engine.isRunning()).toBe(true)
      await engine.stop()
    })

    test("held response startup takeover returns to agent listening on release", async () => {
      const slow = slowTranscriber()
      const engine = createVoiceEngine({
        host: new MockVoiceHost(),
        transcriber: slow.transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation: "wake-word", alwaysListen: true, mode: "agent", agentEngine: "off" },
      })

      const opening = engine.openResponseWindow({ durationMs: 30 })
      while (slow.starts < 1) await new Promise((resolve) => setTimeout(resolve, 0))
      const held = engine.pressToTalk("transcription")
      await new Promise((resolve) => setTimeout(resolve, 10))
      slow.finish()
      await Promise.all([opening, held])

      expect(engine.activeMode()).toBe("transcription")
      expect(engine.followUp()).toBeUndefined()
      expect(engine.isRunning()).toBe(true)
      await engine.releaseToTalk()
      for (let i = 0; i < 50 && slow.starts < 2; i++) await new Promise((resolve) => setTimeout(resolve, 1))
      const restarted = slow.starts >= 2
      if (restarted) slow.finish()
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect(restarted).toBe(true)
      expect(engine.activeMode()).toBe("agent")
      expect(engine.isRunning()).toBe(true)
      await engine.stop()
    })

    test("a slow response startup yields to an in-flight transcription toggle", async () => {
      const slow = slowTranscriber()
      const engine = createVoiceEngine({
        host: new MockVoiceHost(),
        transcriber: slow.transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation: "toggle", mode: "agent" },
      })

      const opening = engine.openResponseWindow({ durationMs: 30 })
      while (slow.starts < 1) await new Promise((resolve) => setTimeout(resolve, 0))
      const takeover = engine.toggle("transcription")
      await new Promise((resolve) => setTimeout(resolve, 10))
      slow.finish()
      await Promise.all([opening, takeover])

      expect(engine.activeMode()).toBe("transcription")
      expect(engine.followUp()).toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(engine.activeMode()).toBe("transcription")
      expect(engine.isRunning()).toBe(true)
      await engine.stop()
    })

    test("due pressioni ravvicinate aprono una sessione sola", async () => {
      const slow = slowTranscriber()
      const engine = createVoiceEngine({
        host: new MockVoiceHost(),
        transcriber: slow.transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation: "toggle" },
      })

      const first = engine.start()
      const second = engine.start()
      slow.finish()
      await Promise.all([first, second])

      expect(slow.starts).toBe(1)
      expect(engine.isRunning()).toBe(true)
    })

    test("fermare durante l'avvio non lascia il microfono aperto", async () => {
      const slow = slowTranscriber()
      const engine = createVoiceEngine({
        host: new MockVoiceHost(),
        transcriber: slow.transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation: "toggle" },
      })

      const starting = engine.start()
      const stopping = engine.stop()
      slow.finish()
      await Promise.all([starting, stopping])

      // The session that landed after the stop was freed rather than
      // installed: not running, and the transcriber was told to let go.
      expect(engine.isRunning()).toBe(false)
      expect(slow.stops).toBeGreaterThanOrEqual(1)
    })

    test("stop wins while a settings restart is opening", async () => {
      const slow = slowTranscriber()
      const engine = createVoiceEngine({
        host: new MockVoiceHost(),
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation: "toggle", agentEngine: "off", backend: "openrouter", openRouterApiKey: "old" },
        creditLeft: async () => undefined,
        createTranscriber: () => slow.transcriber,
      })

      const starting = engine.start()
      slow.finish()
      await starting
      const restarting = engine.updateSettings({ openRouterApiKey: "new" })
      while (slow.starts < 2) await new Promise((resolve) => setTimeout(resolve, 0))
      const stopping = engine.stop()
      slow.finish()
      await Promise.all([restarting, stopping])

      expect(engine.isRunning()).toBe(false)
      expect(slow.stops).toBeGreaterThanOrEqual(1)
    })
  })

  test("changing an open microphone key restarts it; removing the key stops it", async () => {
    const keys: (string | undefined)[] = []
    const transcribers: ReturnType<typeof createFakeTranscriber>[] = []
    const engine = createVoiceEngine({
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      settings: { activation: "toggle", agentEngine: "off", backend: "openrouter", openRouterApiKey: "old" },
      creditLeft: async () => undefined,
      createTranscriber: (_backend, options) => {
        keys.push(options?.apiKey)
        const transcriber = createFakeTranscriber()
        transcribers.push(transcriber)
        return transcriber
      },
    })

    await engine.start()
    await engine.updateSettings({ openRouterApiKey: "new" })
    expect(keys).toEqual(["old", "new"])
    expect(transcribers[0]?.isStarted).toBe(false)
    expect(transcribers[1]?.isStarted).toBe(true)
    expect(engine.isRunning()).toBe(true)

    await engine.updateSettings({ openRouterApiKey: undefined })
    expect(keys).toEqual(["old", "new"])
    expect(transcribers[1]?.isStarted).toBe(false)
    expect(engine.isRunning()).toBe(false)
  })

  test("a settings restart opens the replacement transcriber with the new key", async () => {
    const keys: (string | undefined)[] = []
    const transcribers: ReturnType<typeof createFakeTranscriber>[] = []
    let releaseStart: (() => void) | undefined
    let created = 0
    const engine = createVoiceEngine({
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      settings: { activation: "toggle", agentEngine: "off", backend: "openrouter", openRouterApiKey: "old" },
      creditLeft: async () => undefined,
      createTranscriber: (_backend, options) => {
        keys.push(options?.apiKey)
        const transcriber = createFakeTranscriber()
        transcribers.push(transcriber)
        created++
        if (created === 2) {
          const start = transcriber.start.bind(transcriber)
          transcriber.start = () =>
            new Promise<void>((resolve) => {
              releaseStart = () => {
                start()
                resolve()
              }
            })
        }
        return transcriber
      },
    })

    await engine.start()
    const restarting = engine.updateSettings({ openRouterApiKey: "new" })
    while (!releaseStart) await new Promise((resolve) => setTimeout(resolve, 0))

    expect(keys).toEqual(["old", "new"])
    expect(transcribers[0]?.isStarted).toBe(false)
    expect(engine.isRunning()).toBe(false)
    releaseStart?.()
    await restarting

    expect(transcribers[1]?.isStarted).toBe(true)
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })

  test("destructive command requires explicit confirmation before executing", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    await engine.start()

    // "chiudi pannello" is a destructive intent
    transcriber.emit("chiudi pannello 1", true)
    await new Promise((r) => setTimeout(r, 10))

    // MUST NOT have executed yet
    expect(host.calls.filter((c) => c.method === "runCommand")).toHaveLength(0)

    // Engine must be in confirming state asking the user
    expect(engine.status()).toBe("confirming")
    // The prompt must read as a question about this specific action, and must
    // say how to answer. Asserting the behaviour, not one exact sentence.
    expect(speaker.lastSpoken).toContain("Chiudo il pannello")
    expect(speaker.lastSpoken).toContain("?")
    expect(speaker.lastSpoken!.toLowerCase()).toContain("sì o no")

    // User confirms with "conferma"
    transcriber.emit("conferma", true)
    await new Promise((r) => setTimeout(r, 10))

    // NOW the destructive command has executed
    expect(host.calls).toContainEqual({
      method: "runCommand",
      args: ["pane.close"],
    })
    expect(engine.status()).toBe("idle")
  })

  test("while a confirmation is pending, an unknown sentence is not handed to the agent", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()
    let asked = 0
    ;(host as VoiceHost).askAgent = async () => {
      asked++
      return { ok: true, text: "fatto" }
    }
    await engine.start()
    transcriber.emit("chiudi pannello 1", true)
    await new Promise((r) => setTimeout(r, 10))
    transcriber.emit("raccontami una barzelletta", true)
    await new Promise((r) => setTimeout(r, 10))

    expect(asked).toBe(0)
    expect(engine.status()).toBe("confirming")
    expect(speaker.lastSpoken!.toLowerCase()).toContain("sì")
    await engine.stop()
  })

  test("canceling destructive confirmation does not execute command", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    await engine.start()

    // Trigger destructive intent
    transcriber.emit("termina processo", true)
    await new Promise((r) => setTimeout(r, 10))

    expect(engine.status()).toBe("confirming")
    expect(host.calls.filter((c) => c.method === "runCommand")).toHaveLength(0)

    // User cancels
    transcriber.emit("annulla", true)
    await new Promise((r) => setTimeout(r, 10))

    // Must still NOT have executed
    expect(host.calls.filter((c) => c.method === "runCommand")).toHaveLength(0)
    expect(speaker.lastSpoken).toBe("Va bene, lascio stare.")
    expect(engine.status()).toBe("idle")
  })

  test("ambiguous utterance does not execute and queries user for clarification", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    await engine.start()

    // An utterance that really is ambiguous: "vai al" is the shared opening of
    // "vai al pannello" (pane.focus) and "vai al sito" (browser.navigate), and
    // nothing after it says which. Both score identically.
    transcriber.emit("vai al", true)
    await new Promise((r) => setTimeout(r, 10))

    // Nothing must be executed on the host
    expect(host.calls).toHaveLength(0)

    // Speaker should ask clarification question
    expect(speaker.lastSpoken).toContain("Comando ambiguo")

    // User chooses first option with "la prima"
    transcriber.emit("la prima", true)
    await new Promise((r) => setTimeout(r, 10))

    // Now one command was executed
    expect(host.calls.length).toBeGreaterThan(0)
  })

  test("unknown utterance does not speak offline fallback suggestions", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    await engine.start()

    // Completely unrecognized phrase
    transcriber.emit("vola sulla luna con un razzo", true)
    await new Promise((r) => setTimeout(r, 10))

    // Zero host calls
    expect(host.calls).toHaveLength(0)

    // Offline fallback prompt is removed: speaker stays silent
    expect(speaker.spoken).toHaveLength(0)
    expect(engine.lastError()).toBeDefined()
  })

  test("recognition error does not lock the engine into an unrecoverable state", async () => {
    const { engine, host, transcriber } = setupEngine()

    await engine.start()
    expect(engine.status()).toBe("idle")

    // Transcriber reports hardware / device error
    transcriber.emitError(new Error("Dispositivo microfono disconnesso"))

    // Error is captured in signal
    expect(engine.lastError()).toBe("Dispositivo microfono disconnesso")
    expect(engine.status()).toBe("idle")

    // Subsequent normal input works fine without needing a restart
    await engine.submitText("nuova sessione")
    expect(host.calls).toContainEqual({
      method: "runCommand",
      args: ["session.new"],
    })
  })

  test("handles pending permission request with priority", async () => {
    const { engine, host, transcriber, speaker, advanceTime } = setupEngine()
    const raw = "export API_KEY=secret-value && curl https://example.test/export"

    await engine.start()
    await engine.handlePermissionRequest("pane-1", raw, { kind: "shell" })

    expect(engine.status()).toBe("confirming")
    expect(engine.dialogState().pendingAction?.isPermission).toBe(true)
    const spoken = speaker.spoken.join(" ")
    expect(spoken).toContain("Worker Process")
    expect(spoken).toContain("un comando")
    expect(spoken).not.toContain(raw)
    expect(spoken).not.toContain("API_KEY")
    expect(spoken).not.toContain("secret-value")
    expect(spoken).not.toContain("export")

    advanceTime(15_000)
    transcriber.emit("consenti", true)
    await new Promise((r) => setTimeout(r, 10))

    expect(host.calls).toContainEqual({
      method: "answerPermission",
      args: ["pane-1", "allow", raw],
    })
    expect(engine.status()).toBe("idle")
  })

  test("proactive response window keeps the safe type and raw request separate", async () => {
    const { engine } = setupEngine()
    const raw = "cat C:/Users/private/API_KEY_SECRET"

    await engine.openResponseWindow({
      durationMs: 8_000,
      permission: { paneId: "pane-1", what: raw, kind: "write" },
    })

    const pending = engine.dialogState().pendingAction
    expect(pending?.confirmPrompt).toContain("Worker Process")
    expect(pending?.confirmPrompt).toContain("una modifica ai file")
    expect(pending?.confirmPrompt).not.toContain(raw)
    expect(pending?.confirmPrompt).not.toContain("API_KEY_SECRET")
    expect(pending?.what).toBe(raw)
    await engine.stop()
  })

  test("transcription mode never speaks: silently inserts transcribed text into pane", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    // Start specifically in transcription mode
    await engine.start("transcription")
    expect(engine.isRunning()).toBe(true)

    // User speaks arbitrary text to transcribe
    transcriber.emit("questo è un testo dettato per il composer", true)

    // Allow async dispatch execution
    await new Promise((r) => setTimeout(r, 20))

    // Host must have received insertText
    expect(host.calls).toContainEqual({
      method: "insertText",
      args: ["pane-1", "questo è un testo dettato per il composer"],
    })

    // Speaker MUST be completely silent: zero words spoken
    expect(speaker.spoken.length).toBe(0)
    expect(speaker.lastSpoken).toBeUndefined()
    expect(engine.dictated()).toContain("questo è un testo dettato per il composer")
  })

  test("entering transcription mode cancels any ongoing speech and remains silent on error", async () => {
    const { engine, host, transcriber, speaker } = setupEngine()

    // Simulate speaker talking
    await speaker.speak("Sto parlando di una risposta lunga...")
    expect(speaker.lastSpoken).toBe("Sto parlando di una risposta lunga...")

    // Switching/pressing transcription mode cancels TTS immediately
    let cancelled = false
    const origCancel = speaker.cancel
    speaker.cancel = () => {
      cancelled = true
      origCancel.call(speaker)
    }

    await engine.pressToTalk("transcription")
    expect(cancelled).toBe(true)

    // Simulate ASR error while in transcription mode
    transcriber.emitError(new Error("Network timeout on transcription backend"))
    await new Promise((r) => setTimeout(r, 20))

    // Error is reported to engine state, but speaker must NOT speak the error
    expect(engine.lastError()).toBeDefined()
    // Still only the old message from before transcription, no new speech added
    expect(speaker.spoken.length).toBe(1)
    expect(speaker.lastSpoken).toBe("Sto parlando di una risposta lunga...")
  })
})

describe("engine/stop delivers what was already heard", () => {
  function setup(drainTimeoutMs?: number) {
    const host = new MockVoiceHost()
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      getContext: () => ({ focusedPaneId: "pane-1" }),
      ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
      settings: { activation: "toggle" },
    })
    return { host, transcriber, engine }
  }

  test("a sentence still in flight when dictation is closed reaches the pane", async () => {
    const { host, transcriber, engine } = setup()
    await engine.start("transcription")

    // The request for the last sentence has left; the user closes dictation.
    transcriber.setHasInFlight(true)
    const stopped = engine.stop()
    expect(engine.isRunning()).toBe(false)

    // The answer comes back after the press, as it does over the network.
    await new Promise((r) => setTimeout(r, 40))
    transcriber.emit("aggiungi un test", true)
    transcriber.setHasInFlight(false)
    await stopped

    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-1", "aggiungi un test"] })
    expect(transcriber.isStarted).toBe(false)
  })

  test("the drained sentence is still dictation, not a command", async () => {
    const { host, transcriber, engine } = setup()
    await engine.start("transcription")

    transcriber.setHasInFlight(true)
    const stopped = engine.stop()
    await new Promise((r) => setTimeout(r, 30))
    transcriber.emit("nuova sessione", true)
    transcriber.setHasInFlight(false)
    await stopped

    expect(host.calls.some((c) => c.method === "runCommand")).toBe(false)
    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-1", "nuova sessione"] })
  })

  test("a request that never returns does not hold the stop forever", async () => {
    const { transcriber, engine } = setup(100)
    await engine.start("transcription")

    transcriber.setHasInFlight(true)
    await engine.stop()

    expect(engine.isRunning()).toBe(false)
    expect(transcriber.isStarted).toBe(false)
  })

  test("a start pressed during the drain waits for it instead of racing it", async () => {
    const { transcriber, engine } = setup()
    await engine.start("transcription")

    transcriber.setHasInFlight(true)
    const stopped = engine.stop()
    const restarted = engine.start("transcription")
    await new Promise((r) => setTimeout(r, 30))
    transcriber.setHasInFlight(false)
    await stopped
    await restarted

    expect(engine.isRunning()).toBe(true)
    expect(engine.activeMode()).toBe("transcription")
    await engine.stop()
  })

  test("dictation with no pane open says so instead of doing nothing", async () => {
    const { host, transcriber, engine } = setup()
    host.panes = []
    await engine.start("transcription")

    transcriber.emit("aggiungi un test", true)
    await new Promise((r) => setTimeout(r, 10))

    expect(engine.lastError()).toContain("Nessun pannello aperto")
    await engine.stop()
  })
})

describe("engine/push-to-talk tap latches", () => {
  function setup() {
    let clock = 50_000
    const host = new MockVoiceHost()
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => clock,
      settings: { activation: "push-to-talk", mode: "transcription" },
      getContext: () => ({ focusedPaneId: "pane-1" }),
    })
    return { host, transcriber, engine, advance: (ms: number) => (clock += ms) }
  }

  test("a quick press leaves dictation on: no grace stop, and it survives a delivered sentence", async () => {
    const { host, transcriber, engine, advance } = setup()
    await engine.pressToTalk("transcription")
    advance(120)
    await engine.releaseToTalk()

    // Past the old 250 ms grace, which closed a tap that recorded nothing.
    await new Promise((r) => setTimeout(r, 300))
    expect(engine.isRunning()).toBe(true)

    transcriber.emit("prima frase", true)
    await new Promise((r) => setTimeout(r, 20))
    transcriber.emit("seconda frase", true)
    await new Promise((r) => setTimeout(r, 20))

    expect(host.calls.filter((c) => c.method === "insertText").map((c) => c.args[1])).toEqual([
      "prima frase",
      "seconda frase",
    ])
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })

  test("the next press closes a latched session, and its release starts nothing", async () => {
    const { engine, advance } = setup()
    await engine.pressToTalk("transcription")
    advance(100)
    await engine.releaseToTalk()
    expect(engine.isRunning()).toBe(true)

    await engine.pressToTalk("transcription")
    expect(engine.isRunning()).toBe(false)
    advance(100)
    await engine.releaseToTalk()
    await new Promise((r) => setTimeout(r, 20))
    expect(engine.isRunning()).toBe(false)

    // And the one after that opens it again.
    await engine.pressToTalk("transcription")
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })

  test("a hold is still push-to-talk: the sentence is delivered and the session ends", async () => {
    const { host, transcriber, engine, advance } = setup()
    await engine.pressToTalk("transcription")
    advance(2_000)
    await engine.releaseToTalk()

    transcriber.emit("detto tenendo premuto", true)
    await new Promise((r) => setTimeout(r, 40))

    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-1", "detto tenendo premuto"] })
    expect(engine.isRunning()).toBe(false)
  })
})

describe("the planner is the host's, on the agent's own runner", () => {
  /* Any fetch at all is a request to a service billed per call: the planner must never make one. */
  const withFetchSpy = async (run: (fetched: string[]) => Promise<void>) => {
    const fetched: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: URL | RequestInfo) => {
      fetched.push(String(input instanceof Request ? input.url : input))
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    try {
      await run(fetched)
    } finally {
      globalThis.fetch = original
    }
  }

  function setup(settings: Record<string, unknown>, plan?: NonNullable<VoiceHost["plan"]>) {
    const host = new MockVoiceHost()
    if (plan) (host as VoiceHost).plan = plan
    const speaker = createFakeSpeaker()
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host,
      speaker,
      now: () => 10_000,
      transcriber: createFakeTranscriber(),
      settings: { activation: "toggle", backend: "openrouter", ...settings } as never,
    })
    return { engine, host, speaker }
  }

  test("an unmatched sentence is planned by the host, with the agent's engine and speed, and nothing is fetched", async () => {
    await withFetchSpy(async (fetched) => {
      const seen: { engine: string; speed?: string; system: string; user: string }[] = []
      const { engine } = setup(
        { agentEngine: "claude", agentSpeed: "fast", openRouterApiKey: "sk-or-key" },
        async (request) => {
          seen.push({ engine: request.engine, speed: request.speed, system: request.system, user: request.user })
          return '{"speech":"Apro il progetto nikcli.","steps":[{"action":"open_project","project":"nikcli"}]}'
        },
      )
      await engine.submitText("portami nel progetto dei test")
      expect(seen).toHaveLength(1)
      expect(seen[0].engine).toBe("claude")
      expect(seen[0].speed).toBe("fast")
      expect(seen[0].user).toContain("portami nel progetto dei test")
      expect(fetched).toEqual([])
    })
  })

  test("a key in the settings does not make the planner call a service: with no host planner, there is none", async () => {
    await withFetchSpy(async (fetched) => {
      const { engine } = setup({ agentEngine: "claude", openRouterApiKey: "sk-or-key" })
      await engine.submitText("raccontami una storia mai raccontata")
      expect(fetched).toEqual([])
      expect(engine.listenSpend()).toMatchObject({ calls: 0, cost: 0 })
    })
  })

  test("with the agent off there is no planner either: the user chose no model turns", async () => {
    let planned = 0
    const { engine } = setup({ agentEngine: "off" }, async () => {
      planned++
      return "[]"
    })
    await engine.submitText("raccontami una storia mai raccontata")
    expect(planned).toBe(0)
  })
})

describe("engine/agent answers what the grammar does not know", () => {
  function setup(agentEngine: "auto" | "off", answer: { ok: boolean; text: string }) {
    const host = new MockVoiceHost()
    const asked: { text: string; engine: string }[] = []
    ;(host as VoiceHost).askAgent = async (request) => {
      asked.push({ text: request.text, engine: request.engine })
      return answer
    }
    const speaker = createFakeSpeaker()
    const engine = createVoiceEngine({
      host,
      transcriber: createFakeTranscriber(),
      speaker,
      now: () => 10_000,
      settings: { activation: "toggle", agentEngine },
    })
    return { host, asked, speaker, engine }
  }

  test("an unmatched sentence goes to the agent and its answer is spoken", async () => {
    const { asked, speaker, engine } = setup("auto", { ok: true, text: "Ho chiesto alla sessione due: ha finito." })
    await engine.start()
    await engine.submitText("chiedi alla sessione dei test se ha finito e dimmi cosa ha trovato")
    await new Promise((r) => setTimeout(r, 20))

    expect(asked).toEqual([
      { text: "chiedi alla sessione dei test se ha finito e dimmi cosa ha trovato", engine: "auto" },
    ])
    expect(speaker.lastSpoken).toBe("Ho chiesto alla sessione due: ha finito.")
    expect(engine.status()).toBe("idle")
    await engine.stop()
  })

  describe("a sentence while the agent is still thinking", () => {
    function busy() {
      const host = new MockVoiceHost()
      const asked: string[] = []
      let aborted = 0
      ;(host as VoiceHost).askAgent = (request) =>
        new Promise((resolve) => {
          asked.push(request.text)
          request.signal?.addEventListener("abort", () => {
            aborted++
            resolve({ ok: false, text: "" })
          })
        })
      const speaker = createFakeSpeaker()
      const engine = createVoiceEngine({
        host,
        transcriber: createFakeTranscriber(),
        speaker,
        now: () => 10_000,
        settings: { activation: "toggle", agentEngine: "auto" },
      })
      return { host, asked, speaker, engine, aborted: () => aborted }
    }

    test("a known command is carried out instead of vanishing, and the turn is stopped", async () => {
      const { host, asked, engine, aborted } = busy()
      void engine.submitText("raccontami la storia di Roma in tre frasi")
      await new Promise((r) => setTimeout(r, 20))
      expect(engine.status()).toBe("executing")

      await engine.submitText("apri la tavolozza")
      await new Promise((r) => setTimeout(r, 20))

      expect(asked).toEqual(["raccontami la storia di Roma in tre frasi"])
      expect(aborted()).toBe(1)
      expect(host.calls).toContainEqual({ method: "runCommand", args: ["palette.open"] })
      expect(engine.status()).toBe("idle")
      expect(
        engine
          .history()
          .some((entry) => entry.kind === "action" && entry.label.startsWith("Richiesta precedente interrotta")),
      ).toBe(true)
    })

    test("«annulla» stops the turn and says so", async () => {
      const { host, engine, aborted } = busy()
      void engine.submitText("raccontami la storia di Roma in tre frasi")
      await new Promise((r) => setTimeout(r, 20))

      await engine.submitText("annulla")
      await new Promise((r) => setTimeout(r, 20))

      expect(aborted()).toBe(1)
      expect(engine.status()).toBe("idle")
      expect(engine.lastSpoken()).toBe("Ho fermato la richiesta precedente.")
      expect(host.calls.filter((call) => call.method === "runCommand")).toHaveLength(0)
    })
  })

  describe("heard while the agent is thinking: only a stop or a known command ends the turn", () => {
    async function thinking() {
      const host = new MockVoiceHost()
      const asked: string[] = []
      const answers: ((text: string) => void)[] = []
      let aborted = 0
      ;(host as VoiceHost).askAgent = (request) =>
        new Promise((resolve) => {
          asked.push(request.text)
          answers.push((text) => resolve({ ok: true, text, ran: true }))
          request.signal?.addEventListener("abort", () => {
            aborted++
            resolve({ ok: false, text: "", ran: true })
          })
        })
      const transcriber = createFakeTranscriber()
      const engine = createVoiceEngine({
        host,
        transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation: "toggle", agentEngine: "auto" },
      })
      await engine.start()
      transcriber.emit("raccontami la storia di Roma in tre frasi", true)
      await new Promise((r) => setTimeout(r, 20))
      expect(engine.status()).toBe("executing")
      const hear = async (text: string) => {
        transcriber.emit(text, true)
        await new Promise((r) => setTimeout(r, 20))
      }
      const answer = async (text: string) => {
        answers.shift()!(text)
        await new Promise((r) => setTimeout(r, 20))
      }
      return { host, asked, engine, hear, answer, aborted: () => aborted }
    }

    const TV = "il governo ha approvato la legge di bilancio nella notte"

    test("a long free sentence from the room does not stop the turn: it is held and shown, and fillers are left alone", async () => {
      const { asked, engine, hear, answer, aborted } = await thinking()
      await hear("ok")
      await hear(TV)

      expect(aborted()).toBe(0)
      expect(engine.status()).toBe("executing")
      expect(engine.held()).toBe(TV)
      // The console names the sentence by its first words, it does not quote the room.
      expect(
        engine
          .history()
          .some(
            (entry) => entry.kind === "action" && entry.label.startsWith(`Sentito mentre pensavo: «${firstWords(TV)}»`),
          ),
      ).toBe(true)

      // Not confirmed: the turn answers and the held sentence is never asked.
      await answer("Roma fu fondata nel 753 a.C.")
      expect(asked).toEqual(["raccontami la storia di Roma in tre frasi"])
      expect(engine.lastSpoken()).toBe("Roma fu fondata nel 753 a.C.")
      await engine.stop()
    })

    test("«invia questa» during the turn sends the held sentence once the turn is over", async () => {
      const { asked, engine, hear, answer, aborted } = await thinking()
      await hear(TV)
      await hear("invia questa")
      expect(aborted()).toBe(0)
      expect(asked).toHaveLength(1)

      await answer("Fatto.")
      expect(asked).toEqual(["raccontami la storia di Roma in tre frasi", TV])
      expect(engine.held()).toBeNull()
      await engine.stop()
    })

    test("«invia questa» after the turn, as the console's button does, sends it at once", async () => {
      const { asked, engine, hear, answer } = await thinking()
      await hear(TV)
      await answer("Fatto.")
      expect(engine.held()).toBe(TV)

      void engine.submitText("invia questa")
      await new Promise((r) => setTimeout(r, 20))
      expect(asked).toEqual(["raccontami la storia di Roma in tre frasi", TV])
      await engine.stop()
    })

    test("a stopped turn that ends late does not send what was held for the turn that replaced it", async () => {
      const host = new MockVoiceHost()
      const asked: string[] = []
      ;(host as VoiceHost).askAgent = (request) =>
        new Promise((resolve) => {
          asked.push(request.text)
          // A real CLI takes a while to die: the stopped turn reports well after the stop.
          request.signal?.addEventListener("abort", () =>
            setTimeout(() => resolve({ ok: false, text: "", ran: true }), 80),
          )
        })
      const transcriber = createFakeTranscriber()
      const engine = createVoiceEngine({
        host,
        transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { activation: "toggle", agentEngine: "auto" },
      })
      await engine.start()
      void engine.submitText("raccontami la storia di Roma")
      await new Promise((r) => setTimeout(r, 20))
      void engine.submitText("e invece dimmi quella di Atene")
      await new Promise((r) => setTimeout(r, 20))
      transcriber.emit(TV, true)
      await new Promise((r) => setTimeout(r, 20))
      transcriber.emit("invia questa", true)
      await new Promise((r) => setTimeout(r, 150))

      // Atene is still thinking: the held sentence waits for it, not for the stopped Roma.
      expect(asked).toEqual(["raccontami la storia di Roma", "e invece dimmi quella di Atene"])
      expect(engine.held()).toBe(TV)
      await engine.stop()
    })

    test("«annulla la richiesta» said while thinking stops the turn", async () => {
      const { engine, hear, aborted } = await thinking()
      await hear("annulla la richiesta")
      expect(aborted()).toBe(1)
      expect(engine.status()).toBe("idle")
      await engine.stop()
    })

    test("another sentence drops the held one", async () => {
      const { asked, engine, hear, answer } = await thinking()
      await hear(TV)
      await answer("Fatto.")
      await engine.submitText("apri la tavolozza")
      await new Promise((r) => setTimeout(r, 20))
      expect(engine.held()).toBeNull()
      await engine.submitText("invia questa")
      await new Promise((r) => setTimeout(r, 20))
      expect(asked).not.toContain(TV)
      await engine.stop()
    })

    test("closing the microphone mid-turn stops the turn instead of waiting for it", async () => {
      const { engine, aborted } = await thinking()
      const started = Date.now()
      await engine.stop()
      expect(aborted()).toBe(1)
      expect(Date.now() - started).toBeLessThan(1000)
    })

    test("«annulla» said aloud stops the turn at once, not after the answer", async () => {
      const { host, engine, hear, aborted } = await thinking()
      await hear("annulla")

      expect(aborted()).toBe(1)
      expect(engine.status()).toBe("idle")
      expect(engine.lastSpoken()).toBe("Ho fermato la richiesta precedente.")
      expect(host.calls.filter((call) => call.method === "runCommand")).toHaveLength(0)
      await engine.stop()
    })

    test("a real request stops the turn and is carried out", async () => {
      const { host, engine, hear, aborted } = await thinking()
      await hear("apri la tavolozza")

      expect(aborted()).toBe(1)
      expect(host.calls).toContainEqual({ method: "runCommand", args: ["palette.open"] })
      await engine.stop()
    })
  })

  test("a command that cannot be carried out is said once, without an error code", async () => {
    const { engine } = setup("auto", { ok: true, text: "no" })
    await engine.start()
    await engine.submitText("annulla")
    await new Promise((r) => setTimeout(r, 20))

    const lines = engine.history().filter((entry) => entry.kind !== "user")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: "assistant", text: "Non c'è niente da annullare." })
    await engine.stop()
  })

  /*
   * V1-bis, ALTO 7: the end of the voice agent's turn wrote idle over the
   * confirmation of the note the agent sent in it. The question was gone,
   * its timer ignored, and the note stayed pending for a yes to something else.
   */
  test("the note the voice agent sent in its turn is still being asked when the turn ends", async () => {
    const host = new MockVoiceHost()
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      settings: { activation: "toggle", agentEngine: "auto" },
    })
    ;(host as VoiceHost).askAgent = async () => {
      await engine.requestSendConfirmation("m1", "Alfa", "cancella dist")
      return { ok: true, text: "Ho chiesto conferma dell'invio.", ran: true }
    }
    await engine.start()
    await engine.submitText("scrivi ad alfa di cancellare dist")
    await new Promise((r) => setTimeout(r, 20))
    expect(engine.status()).toBe("confirming")
    await engine.stop()
  })

  test("with the microphone closed, typed text is still answered: a command and a question", async () => {
    const { asked, engine } = setup("auto", { ok: true, text: "3 per 3 fa 9." })
    await engine.start()
    await engine.stop()
    expect(engine.status()).toBe("asleep")

    await engine.submitText("elenca pannelli")
    await new Promise((r) => setTimeout(r, 20))
    expect(engine.lastSpoken()).toContain("pannell")
    expect(asked).toHaveLength(0)

    await engine.submitText("quanto fa 3 per 3?")
    await new Promise((r) => setTimeout(r, 20))
    expect(asked.map((request) => request.text)).toEqual(["quanto fa 3 per 3?"])
    expect(engine.lastSpoken()).toBe("3 per 3 fa 9.")
  })

  describe("at rest the assistant answers only when it is called by name", () => {
    beforeAll(() => setWakeWordEnabledForTests(true))
    afterAll(() => setWakeWordEnabledForTests(true))
    function calling() {
      const host = new MockVoiceHost()
      const asked: string[] = []
      ;(host as VoiceHost).askAgent = async (request) => {
        asked.push(request.text)
        return { ok: true, text: "Fatto.", ran: true }
      }
      const transcriber = createFakeTranscriber()
      let clock = 10_000
      // No `activation` here: this is the default a new installation gets.
      const engine = createVoiceEngine({
        host,
        transcriber,
        speaker: createFakeSpeaker(),
        now: () => clock,
        settings: { agentEngine: "auto", activation: "wake-word", alwaysListen: true },
      })
      const hear = async (text: string) => {
        transcriber.emit(text, true)
        await new Promise((r) => setTimeout(r, 20))
      }
      const advance = (ms: number) => {
        clock += ms
      }
      return { host, asked, engine, hear, advance }
    }

    test("a sentence without the name is shown as ignored, and costs nothing", async () => {
      const { host, asked, engine, hear } = calling()
      await engine.start("agent", { waitForName: true })
      await hear("il governo ha approvato la legge di bilancio nella notte")
      await hear("apri la tavolozza")
      // Only the greeting may come before the name.
      await hear("senti nik apri la tavolozza")

      expect(asked).toHaveLength(0)
      expect(host.calls.some((call) => call.method === "runCommand")).toBe(false)
      const ignored = engine
        .history()
        .filter((entry) => entry.kind === "action" && entry.label.startsWith("Ignorata, non inizia con «nik»"))
      expect(ignored).toHaveLength(3)
      await engine.stop()
    })

    test("called by name, with or without a greeting, it answers", async () => {
      const { host, asked, engine, hear } = calling()
      await engine.start()
      await hear("ei nik apri la tavolozza")
      expect(host.calls).toContainEqual({ method: "runCommand", args: ["palette.open"] })

      await hear("ehi nick quante sessioni ci sono")
      expect(engine.lastSpoken()).toContain("session")

      await hear("hey nick, raccontami la storia di Roma")
      // What is left after the name, as the recogniser's own normalisation leaves it.
      expect(asked).toEqual(["raccontami la storia di roma"])
      await engine.stop()
    })

    /*
     * V1-bis, ALTO 5: from idle, a permission opened the name gate for its 30
     * s, and the «va bene» of a television granted it. A question the user did
     * not start is answered with the name.
     */
    test("an agent's permission does not open the gate: the room's «va bene» grants nothing, the name and a yes do", async () => {
      const { host, engine, hear, advance } = calling()
      await engine.start("agent", { waitForName: true })
      await engine.handlePermissionRequest("pane-1", "rm -rf build")
      expect(engine.status()).toBe("confirming")

      await hear("va bene")
      expect(host.calls.some((call) => call.method === "answerPermission")).toBe(false)

      advance(15_000)
      await hear("ehi nik sì")
      expect(host.calls.find((call) => call.method === "answerPermission")?.args.slice(0, 2)).toEqual([
        "pane-1",
        "allow",
      ])
      await engine.stop()
    })

    test("typed text never needs the name", async () => {
      const { host, engine } = calling()
      await engine.start()
      await engine.submitText("apri la tavolozza")
      await new Promise((r) => setTimeout(r, 20))
      expect(host.calls).toContainEqual({ method: "runCommand", args: ["palette.open"] })
      await engine.stop()
    })

    test("while it is thinking, a command from the room is held: only one addressed by name is carried out", async () => {
      const host = new MockVoiceHost()
      ;(host as VoiceHost).askAgent = (request) =>
        new Promise((resolve) => {
          request.signal?.addEventListener("abort", () => resolve({ ok: false, text: "", ran: true }))
        })
      const transcriber = createFakeTranscriber()
      const engine = createVoiceEngine({
        host,
        transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { agentEngine: "auto", activation: "wake-word", alwaysListen: true },
      })
      await engine.start("agent", { waitForName: true })
      transcriber.emit("ei nik raccontami la storia di Roma in tre frasi", true)
      await new Promise((r) => setTimeout(r, 20))

      // A video saying a command out loud must not close anything.
      transcriber.emit("chiudi il pannello due", true)
      await new Promise((r) => setTimeout(r, 20))
      expect(host.calls.some((call) => call.method === "runCommand")).toBe(false)
      expect(engine.held()).toBe("chiudi il pannello due")
      expect(engine.status()).toBe("executing")

      transcriber.emit("ehi nik apri la tavolozza", true)
      await new Promise((r) => setTimeout(r, 20))
      expect(host.calls).toContainEqual({ method: "runCommand", args: ["palette.open"] })
      await engine.stop()
    })

    test("while it is thinking the name is not required: «annulla» stops the turn, the room is still held", async () => {
      const host = new MockVoiceHost()
      let aborted = 0
      ;(host as VoiceHost).askAgent = (request) =>
        new Promise((resolve) => {
          void request
          request.signal?.addEventListener("abort", () => {
            aborted++
            resolve({ ok: false, text: "", ran: true })
          })
        })
      const transcriber = createFakeTranscriber()
      const engine = createVoiceEngine({
        host,
        transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { agentEngine: "auto", activation: "wake-word", alwaysListen: true },
      })
      await engine.start()
      transcriber.emit("ei nik raccontami la storia di Roma in tre frasi", true)
      await new Promise((r) => setTimeout(r, 20))
      expect(engine.status()).toBe("executing")

      transcriber.emit("il governo ha approvato la legge di bilancio nella notte", true)
      await new Promise((r) => setTimeout(r, 20))
      expect(aborted).toBe(0)
      expect(engine.held()).toBe("il governo ha approvato la legge di bilancio nella notte")
      // Named by its first words in the console, not quoted whole.
      expect(
        engine
          .history()
          .some(
            (entry) =>
              entry.kind === "action" &&
              entry.label.startsWith("Sentito mentre pensavo: «il governo ha approvato la legge di bilancio…»"),
          ),
      ).toBe(true)

      transcriber.emit("annulla", true)
      await new Promise((r) => setTimeout(r, 20))
      expect(aborted).toBe(1)
      expect(engine.lastSpoken()).toBe("Ho fermato la richiesta precedente.")
      await engine.stop()
    })
  })

  test("a known command never reaches the agent", async () => {
    const { host, asked, engine } = setup("auto", { ok: true, text: "no" })
    await engine.start()
    await engine.submitText("nuova sessione")
    await new Promise((r) => setTimeout(r, 20))

    expect(asked).toHaveLength(0)
    expect(host.calls).toContainEqual({ method: "runCommand", args: ["session.new"] })
    await engine.stop()
  })

  test("with the agent off, an unmatched sentence is not handed over", async () => {
    const { asked, engine } = setup("off", { ok: true, text: "no" })
    await engine.start()
    await engine.submitText("chiedi alla sessione dei test se ha finito")
    await new Promise((r) => setTimeout(r, 20))

    expect(asked).toHaveLength(0)
    await engine.stop()
  })

  test("a failed turn is shown as an error and said", async () => {
    const { speaker, engine } = setup("auto", { ok: false, text: "claude non si avvia" })
    await engine.start()
    await engine.submitText("chiedi alla sessione dei test se ha finito")
    await new Promise((r) => setTimeout(r, 20))

    expect(engine.lastError()).toBe("claude non si avvia")
    expect(speaker.lastSpoken).toBe("claude non si avvia")
    await engine.stop()
  })

  test("a turn stopped by the plan's limit is said once and not handed over again", async () => {
    const notice =
      "Claude Code ha raggiunto il limite del tuo piano. ADE non riprova e non cambia account: attendi il reset indicato dalla CLI oppure usa una chiave API."
    const { asked, speaker, engine } = setup("auto", { ok: false, text: notice })
    await engine.start()
    await engine.submitText("chiedi alla sessione dei test se ha finito")
    await new Promise((r) => setTimeout(r, 50))

    expect(asked).toHaveLength(1)
    expect(engine.lastError()).toBe(notice)
    expect(speaker.lastSpoken).toBe(notice)
    await engine.stop()
  })
})

describe("always-on listening", () => {
  beforeAll(() => setWakeWordEnabledForTests(true))
  afterAll(() => setWakeWordEnabledForTests(true))
  const settle = () => new Promise((r) => setTimeout(r, 20))

  function listening(settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    const host = new MockVoiceHost()
    const transcriber = createFakeTranscriber()
    const speaker = createFakeSpeaker()
    let clock = 10_000
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host,
      transcriber,
      speaker,
      now: () => clock,
      settings: { agentEngine: "off", activation: "wake-word", alwaysListen: true, ...settings },
      ...extra,
    })
    const hear = async (text: string) => {
      transcriber.emit(text, true)
      await settle()
    }
    // Past the few seconds after an answer in which no name is needed.
    const later = () => (clock += FOLLOW_UP_MS + 1)
    return { host, engine, hear, speaker, later }
  }
  const ran = (host: MockVoiceHost) => host.calls.filter((call) => call.method === "runCommand")

  test("opened by ADE, it says nothing and waits for the phrase, even after an earlier session", async () => {
    const { host, engine, hear } = listening()
    // A session opened and closed by hand leaves the dialogue asleep; the next
    // start from the button would take the first sentence without the name.
    await engine.start()
    await engine.stop()

    await engine.start("agent", { waitForName: true })
    expect(engine.isRunning()).toBe(true)
    expect(engine.lastSpoken()).not.toContain("sveglio")
    await hear("apri la tavolozza")
    expect(ran(host)).toHaveLength(0)
    await hear("ei nik apri la tavolozza")
    expect(ran(host)).toEqual([{ method: "runCommand", args: ["palette.open"] }])
    await engine.stop()
  })

  test("the button and the shortcut call it rather than closing the microphone", async () => {
    const { host, engine, hear, later } = listening()
    await engine.start("agent", { waitForName: true })
    await engine.toggle()
    expect(engine.isRunning()).toBe(true)
    await hear("apri la tavolozza")
    expect(ran(host)).toEqual([{ method: "runCommand", args: ["palette.open"] }])
    // Back to waiting for the phrase after answering.
    later()
    await hear("apri la tavolozza")
    expect(ran(host)).toHaveLength(1)
    await engine.stop()
    expect(engine.isRunning()).toBe(false)
  })

  test("closing dictation goes back to waiting for the phrase, after the dictation is delivered", async () => {
    const { host, engine, hear } = listening()
    await engine.start("agent", { waitForName: true })
    await engine.toggle("transcription")
    expect(engine.activeMode()).toBe("transcription")
    await engine.toggle("transcription")
    expect(engine.isRunning()).toBe(true)
    expect(engine.activeMode()).toBe("agent")
    await hear("apri la tavolozza")
    expect(ran(host)).toHaveLength(0)
    await engine.stop()
  })

  test("ending a dictation that took over listening keeps the agent ready; closing the microphone lets it go", async () => {
    const { host, engine } = listening()
    const released = () => host.calls.filter((call) => call.method === "releaseAgent").length
    await engine.start("agent", { waitForName: true })
    await engine.toggle("transcription")
    await engine.toggle("transcription")
    expect(engine.activeMode()).toBe("agent")
    expect(released()).toBe(0)

    // Held, not toggled: released at once, it ends there.
    await engine.pressToTalk("transcription")
    expect(engine.activeMode()).toBe("transcription")
    await engine.releaseToTalk()
    await settle()
    expect(engine.isRunning()).toBe(true)
    expect(engine.activeMode()).toBe("agent")
    expect(released()).toBe(0)

    await engine.stop()
    expect(released()).toBe(1)
  })

  test("dictation opened with the microphone closed does not reopen listening when it ends", async () => {
    const { engine } = listening()
    await engine.toggle("transcription")
    expect(engine.activeMode()).toBe("transcription")
    await engine.toggle("transcription")
    expect(engine.isRunning()).toBe(false)
  })

  test("the name alone, or the button, holds for ten seconds, judged when the sentence began", async () => {
    let clock = 0
    let gate: any
    const transcriber = createFakeTranscriber()
    const host = new MockVoiceHost()
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host,
      speaker: createFakeSpeaker(),
      now: () => clock,
      settings: {
        agentEngine: "off",
        activation: "wake-word",
        alwaysListen: true,
        backend: "openrouter",
        openRouterApiKey: "k",
      },
      createTranscriber: (_backend, options) => {
        gate = options?.openRouterOptions?.nameGate
        return transcriber
      },
    })
    const hear = async (text: string) => {
      transcriber.emit(text, true)
      await settle()
    }
    await engine.start("agent", { waitForName: true })
    await engine.toggle()
    // Within the window the next sentence needs no name, and goes whole.
    expect(gate.active(clock + 9_000)).toBe(false)
    // A sentence begun after it is filtered again: a television minutes later is not the request.
    expect(gate.active(clock + 11_000)).toBe(true)
    clock += 60_000
    await hear("apri la tavolozza")
    expect(ran(host)).toHaveLength(0)

    await hear("ei nik")
    expect(gate.active(clock + 5_000)).toBe(false)
    clock += 30_000
    await hear("apri la tavolozza")
    expect(ran(host)).toHaveLength(0)
    await engine.stop()
  })

  test("while a turn is at work, sentences still have to call it", async () => {
    let gate: any
    const host = new MockVoiceHost()
    ;(host as VoiceHost).askAgent = (request) =>
      new Promise((resolve) =>
        request.signal?.addEventListener("abort", () => resolve({ ok: false, text: "", ran: true })),
      )
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host,
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      settings: {
        agentEngine: "auto",
        activation: "wake-word",
        alwaysListen: true,
        backend: "openrouter",
        openRouterApiKey: "k",
      },
      createTranscriber: (_backend, options) => {
        gate = options?.openRouterOptions?.nameGate
        return transcriber
      },
    })
    await engine.start("agent", { waitForName: true })
    transcriber.emit("ei nik raccontami la storia di Roma", true)
    await settle()
    expect(engine.status()).toBe("executing")
    expect(gate.active(10_000)).toBe(true)
    // A short «annulla» goes whole anyway, and stops it.
    transcriber.emit("annulla", true)
    await settle()
    expect(engine.status()).not.toBe("executing")
    await engine.stop()
  })

  test("a question answered by typing does not leave it awake: the room hours later is ignored", async () => {
    const { host, engine, hear, later } = listening()
    await engine.start("agent", { waitForName: true })
    // The name alone, then the command: the path that held it awake.
    await hear("ei nik")
    await hear("chiudi pannello 1")
    expect(engine.status()).toBe("confirming")
    await engine.submitText("sì")
    await settle()
    expect(engine.status()).not.toBe("confirming")
    const before = ran(host).length
    later()
    await hear("apri la tavolozza")
    expect(ran(host)).toHaveLength(before)
    expect(engine.history().at(-1)).toMatchObject({ kind: "action", label: expect.stringContaining("Ignorata") })
    await engine.stop()
  })

  test("switched off, the button closes the microphone as before", async () => {
    const { engine } = listening({ alwaysListen: false })
    await engine.start()
    await engine.toggle()
    expect(engine.isRunning()).toBe(false)
  })

  test("opened by hand without a phrase, it closes after the short idle timeout", async () => {
    const { engine } = listening({ alwaysListen: false }, { listenIdleMs: 20 })
    await engine.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(engine.isRunning()).toBe(false)
    expect(engine.listenHalted()).toBe(true)
    expect(engine.listenWarning()).toContain("Non ho sentito una frase per 1 secondo")
  })

  test("a latched manual microphone starts the idle timeout again when the key is released", async () => {
    const { engine } = listening({ activation: "push-to-talk", alwaysListen: false }, { listenIdleMs: 20 })
    await engine.pressToTalk()
    await engine.releaseToTalk()
    expect(engine.isRunning()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(engine.isRunning()).toBe(false)
    expect(engine.listenHalted()).toBe(true)
  })

  test("it never pauses by itself: a long silence leaves it listening", async () => {
    const { engine } = listening()
    await engine.start("agent", { waitForName: true })
    await new Promise((r) => setTimeout(r, 60))
    expect(engine.isRunning()).toBe(true)
    expect(engine.listenPaused()).toBe(false)
    await engine.stop()
  })

  test("paused for a locked PC, it says so; a start clears it, and a pause with nothing open does nothing", async () => {
    const { engine } = listening()
    await engine.pauseListening()
    expect(engine.listenPaused()).toBe(false)

    await engine.start("agent", { waitForName: true })
    await engine.pauseListening()
    expect(engine.isRunning()).toBe(false)
    expect(engine.listenPaused()).toBe(true)

    await engine.start("agent", { waitForName: true })
    expect(engine.listenPaused()).toBe(false)
    await engine.stop()
    expect(engine.listenPaused()).toBe(false)
  })

  test("past the hourly limit of paid requests it stops listening and says why", async () => {
    let clock = 0
    let gate: any
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      now: () => clock,
      settings: {
        agentEngine: "off",
        activation: "wake-word",
        alwaysListen: true,
        backend: "openrouter",
        openRouterApiKey: "k",
      },
      listenRequestsPerHour: 3,
      createTranscriber: (_backend, options) => {
        gate = options?.openRouterOptions?.nameGate
        return createFakeTranscriber()
      },
    })
    await engine.start("agent", { waitForName: true })
    for (let i = 0; i < 3; i++) gate.onRequest()
    expect(engine.listenWarning()).toBeUndefined()
    expect(engine.isRunning()).toBe(true)

    gate.onRequest()
    const warning = engine.listenWarning()
    expect(warning).toContain("più di 3 frasi")
    expect(engine.history().at(-1)).toMatchObject({ kind: "error", text: warning })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(engine.isRunning()).toBe(false)
    expect(engine.listenPaused()).toBe(true)
    // Held stopped: the guard that brings listening back after a lock must not.
    expect(engine.listenHalted()).toBe(true)

    // Started again by hand, the halt is lifted and the count starts from nothing.
    await engine.start("agent", { waitForName: true })
    expect(engine.listenPaused()).toBe(false)
    expect(engine.listenHalted()).toBe(false)
    for (let i = 0; i < 3; i++) gate.onRequest()
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })

  test("what listening spent today is counted, with the cost the service reports", async () => {
    let clock = new Date(2026, 8, 17, 9, 0, 0).getTime()
    let gate: any
    let usage: ((u: { cost?: number }, context: { gated: boolean }) => void) | undefined
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      now: () => clock,
      settings: {
        agentEngine: "off",
        activation: "wake-word",
        alwaysListen: true,
        backend: "openrouter",
        openRouterApiKey: "k",
      },
      createTranscriber: (_backend, options) => {
        gate = options?.openRouterOptions?.nameGate
        usage = options?.openRouterOptions?.onUsage
        return createFakeTranscriber()
      },
    })
    await engine.start("agent", { waitForName: true })
    expect(engine.listenSpend()).toMatchObject({ calls: 0, cost: 0 })
    gate.onRequest()
    gate.onRequest()
    usage?.({ cost: 0.0000556 }, { gated: true })
    usage?.({ cost: 0.0000556 }, { gated: true })
    // A sentence the user dictated is theirs, not listening's, however many are owed.
    usage?.({ cost: 0.5 }, { gated: false })
    // And a third answer to two requests is not counted either.
    usage?.({ cost: 0.5 }, { gated: true })
    expect(engine.listenSpend().calls).toBe(2)
    expect(engine.listenSpend().cost).toBeCloseTo(0.0001112, 8)

    // Tomorrow starts from nothing.
    clock += 24 * 60 * 60_000
    gate.onRequest()
    expect(engine.listenSpend().calls).toBe(1)
    await engine.stop()
  })

  test("nobody has called it for a while: it stops rather than hold the microphone open", async () => {
    const engine = createVoiceEngine({
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      transcriber: createFakeTranscriber(),
      now: () => Date.now(),
      settings: { agentEngine: "off", activation: "wake-word", alwaysListen: true },
      listenIdleMs: 100,
    })
    await engine.start("agent", { waitForName: true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(engine.isRunning()).toBe(false)
    expect(engine.listenPaused()).toBe(true)
    expect(engine.listenHalted()).toBe(true)
    expect(engine.listenWarning()).toContain("smesso di ascoltare")
  })

  test("a stop for spending is still there after ADE is closed and opened", async () => {
    const halt = { current: undefined as { reason: string; at: number } | undefined }
    const haltStore = {
      read: () => halt.current,
      write: (next: { reason: string; at: number }) => void (halt.current = next),
      clear: () => void (halt.current = undefined),
    }
    const settings = {
      agentEngine: "off" as const,
      activation: "wake-word" as const,
      alwaysListen: true,
      backend: "openrouter" as const,
      openRouterApiKey: "k",
    }
    let gate: any
    const first = createVoiceEngine({
      creditLeft: async () => undefined,
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      now: () => Date.now(),
      settings,
      haltStore,
      listenRequestsPerHour: 1,
      createTranscriber: (_backend, options) => {
        gate = options?.openRouterOptions?.nameGate
        return createFakeTranscriber()
      },
    })
    await first.start("agent", { waitForName: true })
    gate.onRequest()
    gate.onRequest()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(first.listenHalted()).toBe(true)
    expect(halt.current?.reason).toContain("smesso di ascoltare")

    // ADE closed and opened: the microphone stays shut, and says why.
    const next = createVoiceEngine({
      creditLeft: async () => undefined,
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      transcriber: createFakeTranscriber(),
      now: () => Date.now(),
      settings,
      haltStore,
    })
    expect(next.listenHalted()).toBe(true)
    expect(next.listenWarning()).toContain("smesso di ascoltare")
    // ADE opening it by itself does not lift it.
    await next.start("agent", { waitForName: true, automatic: true })
    expect(next.isRunning()).toBe(false)
    expect(next.listenHalted()).toBe(true)

    // The user's own hand does, and it is not there on the launch after that.
    await next.start("agent", { waitForName: true })
    expect(next.isRunning()).toBe(true)
    expect(next.listenHalted()).toBe(false)
    expect(next.listenWarning()).toBeUndefined()
    expect(halt.current).toBeUndefined()
    await next.stop()
  })

  test("the switch in the settings lifts a stop for spending; a dictation coming back does not", async () => {
    const halt = { current: undefined as { reason: string; at: number } | undefined }
    const haltStore = {
      read: () => halt.current,
      write: (next: { reason: string; at: number }) => void (halt.current = next),
      clear: () => void (halt.current = undefined),
    }
    let gate: any
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      now: () => Date.now(),
      settings: {
        agentEngine: "off",
        activation: "wake-word",
        alwaysListen: true,
        backend: "openrouter",
        openRouterApiKey: "k",
      },
      haltStore,
      listenRequestsPerHour: 1,
      createTranscriber: (_backend, options) => {
        gate = options?.openRouterOptions?.nameGate
        return createFakeTranscriber()
      },
    })
    await engine.start("agent", { waitForName: true })
    gate.onRequest()
    gate.onRequest()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(engine.listenHalted()).toBe(true)

    // Off and on again on the switch: the user asking for it, so the stop goes.
    await engine.updateSettings({ alwaysListen: false })
    expect(engine.listenHalted()).toBe(true)
    await engine.updateSettings({ alwaysListen: true })
    expect(engine.listenHalted()).toBe(false)
    expect(engine.listenWarning()).toBeUndefined()
    expect(halt.current).toBeUndefined()
    await engine.stop()

    // A dictation handing the microphone back is not a hand on the switch:
    // a stop that arrived while dictating still holds when it ends.
    const back = createVoiceEngine({
      creditLeft: async () => undefined,
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      now: () => Date.now(),
      settings: {
        agentEngine: "off",
        activation: "wake-word",
        alwaysListen: true,
        backend: "openrouter",
        openRouterApiKey: "k",
      },
      haltStore,
      listenRequestsPerHour: 1,
      createTranscriber: (_backend, options) => {
        gate = options?.openRouterOptions?.nameGate
        return createFakeTranscriber()
      },
    })
    await back.start("agent", { waitForName: true })
    // Dictation takes the microphone over: no new start, so nothing is lifted.
    await back.pressToTalk("transcription")
    expect(back.activeMode()).toBe("transcription")
    gate.onRequest()
    gate.onRequest()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(back.listenHalted()).toBe(true)

    await back.releaseToTalk()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(back.isRunning()).toBe(false)
    expect(back.listenHalted()).toBe(true)
    expect(halt.current?.reason).toContain("smesso di ascoltare")
  })

  test("what is left on the key is said when the microphone opens, and a refused key stops listening", async () => {
    const asked: string[] = []
    const engineWith = (credit: { left: number } | { refused: true } | undefined) =>
      createVoiceEngine({
        host: new MockVoiceHost(),
        speaker: createFakeSpeaker(),
        transcriber: createFakeTranscriber(),
        now: () => Date.now(),
        settings: {
          agentEngine: "off",
          activation: "wake-word",
          alwaysListen: true,
          backend: "openrouter",
          openRouterApiKey: "k",
        },
        creditLeft: async (key) => {
          asked.push(key)
          return credit
        },
      })

    const plenty = engineWith({ left: 40 })
    await plenty.start("agent", { waitForName: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toEqual(["k"])
    expect(plenty.listenWarning()).toBeUndefined()
    await plenty.stop()

    const nearly = engineWith({ left: 1.21 })
    await nearly.start("agent", { waitForName: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(nearly.listenWarning()).toContain("1,21")
    await nearly.stop()

    const refused = engineWith({ refused: true })
    await refused.start("agent", { waitForName: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refused.listenWarning()).toContain("non viene accettata")
    await refused.stop()

    // Not knowing is not a reason to warn.
    const unknown = engineWith(undefined)
    await unknown.start("agent", { waitForName: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(unknown.listenWarning()).toBeUndefined()
    await unknown.stop()
  })

  test("the key is not asked about at every opening of the microphone", async () => {
    let clock = 10_000
    const asked: number[] = []
    const engine = createVoiceEngine({
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      transcriber: createFakeTranscriber(),
      now: () => clock,
      settings: {
        agentEngine: "off",
        activation: "wake-word",
        alwaysListen: true,
        backend: "openrouter",
        openRouterApiKey: "k",
      },
      creditCheckMs: 60_000,
      creditLeft: async () => {
        asked.push(clock)
        return { left: 40 }
      },
    })
    const openAndClose = async () => {
      await engine.start("agent", { waitForName: true })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await engine.stop()
    }
    await openAndClose()
    await openAndClose()
    await openAndClose()
    expect(asked).toHaveLength(1)

    // Later, it asks again.
    clock += 61_000
    await openAndClose()
    expect(asked).toHaveLength(2)
  })

  test("the cloud transcriber is told when only the start of a sentence is needed", async () => {
    let gate: any
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host: new MockVoiceHost(),
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      settings: {
        agentEngine: "off",
        activation: "wake-word",
        alwaysListen: true,
        backend: "openrouter",
        openRouterApiKey: "k",
      },
      createTranscriber: (_backend, options) => {
        gate = options?.openRouterOptions?.nameGate
        return transcriber
      },
    })
    await engine.start("agent", { waitForName: true })
    expect(gate.active()).toBe(true)
    expect(gate.accepts("ehi nick apri")).toBe(true)
    expect(gate.accepts("nik apri")).toBe(true)
    expect(gate.accepts("eh nik, apri")).toBe(true)
    expect(gate.accepts("eh nik apri")).toBe(false)
    expect(gate.accepts("ok nik apri")).toBe(false)
    expect(gate.accepts("nì")).toBe(false)
    expect(gate.accepts("Nike apri")).toBe(false)

    gate.onRejected("il governo ha approvato la legge di bilancio nella notte fonda")
    expect(engine.history().at(-1)).toMatchObject({
      kind: "action",
      label: expect.stringContaining("Ignorata, non inizia con «nik»: «il governo"),
    })

    // Called by the button: the next sentence is meant, and has to go whole.
    await engine.toggle()
    expect(gate.active()).toBe(false)
    await engine.stop()
  })
})

describe("0.7.0: only the shortcut starts the assistant", () => {
  // The 0.7.0 world, kept behind the switches: the wake word off, the shortcut the way in.
  beforeAll(() => {
    setWakeWordEnabledForTests(false)
    setShortcutActivationEnabledForTests(true)
  })
  afterAll(() => {
    setWakeWordEnabledForTests(true)
    setShortcutActivationEnabledForTests(false)
  })
  const settle = () => new Promise((r) => setTimeout(r, 30))

  function shortcut() {
    let clock = 0
    const host = new MockVoiceHost()
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => clock,
      // What a new installation, or a profile moved off the wake word, has.
      settings: { agentEngine: "off", activation: "push-to-talk", alwaysListen: false },
    })
    const tap = async () => {
      await engine.pressToTalk("agent")
      clock += 10
      await engine.releaseToTalk()
    }
    return { host, transcriber, engine, tap }
  }
  const ran = (host: MockVoiceHost) => host.calls.filter((call) => call.method === "runCommand")

  test("on the shortcut, nothing opens the microphone by itself", () => {
    const { engine } = shortcut()
    expect(engine.settings().activation).toBe("push-to-talk")
    expect(engine.isRunning()).toBe(false)
  })

  test("a tap opens it for one request, without a name, and it closes when the answer is done", async () => {
    const { host, transcriber, engine, tap } = shortcut()
    await tap()
    expect(engine.isRunning()).toBe(true)
    transcriber.emit("apri la tavolozza", true)
    await settle()
    expect(ran(host)).toEqual([{ method: "runCommand", args: ["palette.open"] }])
    await settle()
    expect(engine.isRunning()).toBe(false)
  })

  test("a second tap closes it before anything is said", async () => {
    const { engine, tap } = shortcut()
    await tap()
    await tap()
    await settle()
    expect(engine.isRunning()).toBe(false)
  })

  test("the button at the top does the same", async () => {
    const { host, transcriber, engine } = shortcut()
    await engine.toggle()
    expect(engine.isRunning()).toBe(true)
    transcriber.emit("apri la tavolozza", true)
    await settle()
    await settle()
    expect(ran(host)).toHaveLength(1)
    expect(engine.isRunning()).toBe(false)
  })

  function slowVoice(ms: number) {
    const said: string[] = []
    let speaking = 0
    return {
      said,
      get speaking() {
        return speaking
      },
      speak(text: string) {
        said.push(text)
        speaking++
        return new Promise<void>((resolve) => setTimeout(() => (speaking--, resolve()), ms))
      },
      cancel() {},
    }
  }

  function withAgent(voice = slowVoice(0)) {
    let clock = 0
    const host = new MockVoiceHost()
    const asked: string[] = []
    ;(host as VoiceHost).askAgent = async (request) => {
      asked.push(request.text)
      await new Promise((r) => setTimeout(r, 30))
      return { ok: true, text: "Ecco la storia di Roma in breve.", ran: true }
    }
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: voice,
      now: () => clock,
      settings: { agentEngine: "auto", activation: "push-to-talk", alwaysListen: false },
    })
    const tap = async () => {
      await engine.pressToTalk("agent")
      clock += 10
      await engine.releaseToTalk()
    }
    return { host, asked, transcriber, engine, tap, voice }
  }

  test("a tap, then a question for the agent: open while it thinks and speaks, closed after, the room is not heard", async () => {
    const { asked, transcriber, engine, tap, voice } = withAgent(slowVoice(120))
    await tap()
    transcriber.emit("raccontami la storia di Roma", true)
    await new Promise((r) => setTimeout(r, 60))
    expect(asked).toHaveLength(1)
    expect(engine.isRunning()).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
    expect(voice.said.some((line) => line.includes("storia di Roma"))).toBe(true)
    expect(engine.isRunning()).toBe(false)
    // The room after the answer: nothing listens, nothing runs.
    transcriber.emit("raccontami un'altra cosa", true)
    await settle()
    expect(asked).toHaveLength(1)
  })

  test("a tap, then a command answered aloud by a slow voice: closed only once the voice is done", async () => {
    const voice = slowVoice(300)
    const { transcriber, engine, tap } = withAgent(voice)
    await tap()
    transcriber.emit("quanti pannelli ci sono", true)
    await new Promise((r) => setTimeout(r, 100))
    expect(voice.speaking).toBe(1)
    expect(engine.isRunning()).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
    expect(voice.speaking).toBe(0)
    expect(engine.isRunning()).toBe(false)
  })

  test("the button, then a question for the agent: closed after the answer", async () => {
    const { asked, transcriber, engine } = withAgent(slowVoice(50))
    await engine.toggle()
    transcriber.emit("raccontami la storia di Roma", true)
    await new Promise((r) => setTimeout(r, 400))
    expect(asked).toHaveLength(1)
    expect(engine.isRunning()).toBe(false)
  })

  test("a sentence it does not understand, or a failure, also ends the turn", async () => {
    const { transcriber, engine, tap } = shortcut()
    await tap()
    transcriber.emit("blablabla zorp", true)
    await settle()
    await settle()
    expect(engine.isRunning()).toBe(false)

    await tap()
    transcriber.emitError(new Error("rete giù"))
    await settle()
    await settle()
    expect(engine.isRunning()).toBe(false)
  })

  test("a typed request with the microphone open closes it when done", async () => {
    const { host, engine, tap } = shortcut()
    await tap()
    await engine.submitText("apri la tavolozza")
    await settle()
    expect(ran(host)).toHaveLength(1)
    expect(engine.isRunning()).toBe(false)
  })

  test("a question keeps it open for the answer, and the answer closes it", async () => {
    const { host, transcriber, engine, tap } = shortcut()
    await tap()
    transcriber.emit("chiudi pannello 1", true)
    await settle()
    expect(engine.status()).toBe("confirming")
    expect(engine.isRunning()).toBe(true)
    transcriber.emit("sì", true)
    await settle()
    await settle()
    expect(ran(host).length).toBeGreaterThan(0)
    expect(engine.isRunning()).toBe(false)
  })
})

describe("after 0.7.0: only the name starts the assistant", () => {
  test("a new installation listens for the name; a sentence without it starts nothing", async () => {
    const host = new MockVoiceHost()
    const asked: string[] = []
    ;(host as VoiceHost).askAgent = async (request) => {
      asked.push(request.text)
      return { ok: true, text: "Fatto.", ran: true }
    }
    const transcriber = createFakeTranscriber()
    let clock = 10_000
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => clock,
      settings: { agentEngine: "auto", alwaysListen: true },
    })
    expect(engine.settings().activation).toBe("wake-word")
    expect(engine.settings().alwaysListen).toBe(true)
    await engine.start("agent", { waitForName: true })
    const hear = async (text: string) => {
      transcriber.emit(text, true)
      await new Promise((r) => setTimeout(r, 20))
    }
    await hear("raccontami la storia di Roma")
    await hear("senti nik raccontami la storia di Roma")
    await hear("ok nik raccontami la storia di Roma")
    // «nì» alone is not the name, and the sentence after it is still the room's.
    await hear("nì")
    await hear("raccontami la storia di Roma")
    await hear("niko raccontami la storia di Roma")
    expect(asked).toHaveLength(0)
    await hear("nik raccontami la storia di Roma")
    await hear("ei nik raccontami la storia di Grecia")
    expect(asked).toHaveLength(2)
    // After the answers and the few seconds that follow them, the room is ignored again.
    clock += FOLLOW_UP_MS + 1
    await hear("raccontami un'altra cosa")
    expect(asked).toHaveLength(2)
    await engine.stop()
  })
})

describe("after 0.7.0: opened by hand, with listening by itself turned off", () => {
  test("the button opens it for one turn, and it closes when the answer is done", async () => {
    const host = new MockVoiceHost()
    const asked: string[] = []
    ;(host as VoiceHost).askAgent = async (request) => {
      asked.push(request.text)
      return { ok: true, text: "Fatto.", ran: true }
    }
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      settings: { agentEngine: "auto", activation: "wake-word", alwaysListen: false },
    })
    await engine.toggle()
    expect(engine.isRunning()).toBe(true)
    transcriber.emit("raccontami la storia di Roma", true)
    await new Promise((r) => setTimeout(r, 60))
    expect(asked).toHaveLength(1)
    expect(engine.isRunning()).toBe(false)
  })

  test("listening by itself, the answer leaves it open and waiting for the name", async () => {
    const host = new MockVoiceHost()
    ;(host as VoiceHost).askAgent = async () => ({ ok: true, text: "Fatto.", ran: true })
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      settings: { agentEngine: "auto", alwaysListen: true },
    })
    await engine.start("agent", { waitForName: true })
    transcriber.emit("nik raccontami la storia di Roma", true)
    await new Promise((r) => setTimeout(r, 60))
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })
})

describe("after 0.7.0: dictation is held on its key", () => {
  function listening() {
    let clock = 10_000
    const host = new MockVoiceHost()
    const asked: string[] = []
    ;(host as VoiceHost).askAgent = async (request) => {
      asked.push(request.text)
      return { ok: true, text: "Fatto.", ran: true }
    }
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => clock,
      settings: { agentEngine: "auto", alwaysListen: true },
      getContext: () => ({ focusedPaneId: "pane-1" }),
    })
    const settle = () => new Promise((r) => setTimeout(r, 40))
    return { host, asked, transcriber, engine, settle, advance: (ms: number) => (clock += ms) }
  }

  test("the dictation key is held, whatever the activation", () => {
    expect(holdsToTalk({ activation: "wake-word" }, "transcription")).toBe(true)
    expect(holdsToTalk({ activation: "wake-word" }, "agent")).toBe(false)
    expect(holdsToTalk({ activation: "push-to-talk" }, "agent")).toBe(true)
  })

  test("held over always-on listening: what is said is dictated, and on release it goes back to waiting for the name", async () => {
    const { host, asked, transcriber, engine, settle, advance } = listening()
    await engine.start("agent", { waitForName: true })
    await engine.pressToTalk("transcription")
    expect(engine.activeMode()).toBe("transcription")
    advance(2_000)
    transcriber.setCommitResult(true)
    await engine.releaseToTalk()
    // The sentence comes back after the key is up.
    transcriber.emit("questo va nel pannello", true)
    await settle()
    expect(host.calls.some((c) => JSON.stringify(c).includes("questo va nel pannello"))).toBe(true)
    expect(engine.isRunning()).toBe(true)
    expect(engine.activeMode()).toBe("agent")
    // The room is not dictated, and not asked either.
    transcriber.emit("il telegiornale di stasera", true)
    await settle()
    expect(engine.dictated()).toEqual([])
    expect(asked).toHaveLength(0)
    await engine.stop()
  })

  test("a tap on the dictation key does not leave dictation open", async () => {
    const { transcriber, engine, settle, advance } = listening()
    await engine.start("agent", { waitForName: true })
    await engine.pressToTalk("transcription")
    advance(10)
    await engine.releaseToTalk()
    await settle()
    expect(engine.activeMode()).toBe("agent")
    transcriber.emit("il telegiornale di stasera", true)
    await settle()
    expect(engine.dictated()).toEqual([])
    await engine.stop()
  })

  test("held with the microphone closed: it closes again on release", async () => {
    const { transcriber, engine, settle, advance } = listening()
    await engine.pressToTalk("transcription")
    advance(2_000)
    transcriber.setCommitResult(true)
    await engine.releaseToTalk()
    // The sentence comes back after the key is up.
    transcriber.emit("una nota", true)
    await settle()
    expect(engine.isRunning()).toBe(false)
  })
})

/*
 * The user pressed the dictation chord the way one presses a switch, and nothing
 * happened: held to speak, a tap opens and closes the microphone before it can
 * be seen. It is now said, and the chord can be a switch instead (2026-09-28).
 */
describe("the dictation chord: held to speak, or a switch", () => {
  function dictation(dictationPress: "hold" | "toggle", alwaysListen = false) {
    let clock = 10_000
    const host = new MockVoiceHost()
    const transcriber = createFakeTranscriber()
    const taps: number[] = []
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => clock,
      settings: { alwaysListen, dictationPress },
      getContext: () => ({ focusedPaneId: "pane-1" }),
      onDictationTap: () => taps.push(clock),
    })
    const settle = () => new Promise((r) => setTimeout(r, 40))
    const tap = async () => {
      await engine.pressToTalk("transcription")
      clock += 100
      await engine.releaseToTalk()
      await settle()
    }
    return { host, transcriber, engine, settle, tap, taps, advance: (ms: number) => (clock += ms) }
  }

  test("held to speak, the default: a tap closes it and says how it opens", async () => {
    const { engine, tap, taps } = dictation("hold")
    expect(engine.settings().dictationPress).toBe("hold")
    await tap()
    expect(engine.isRunning()).toBe(false)
    expect(taps).toHaveLength(1)
  })

  test("a hold says nothing: it is how it opens", async () => {
    const { host, engine, transcriber, settle, taps, advance } = dictation("hold")
    await engine.pressToTalk("transcription")
    advance(2_000)
    transcriber.setCommitResult(true)
    await engine.releaseToTalk()
    transcriber.emit("tenuto premuto", true)
    await settle()
    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-1", "tenuto premuto"] })
    expect(taps).toEqual([])
    await engine.stop()
  })

  test("as a switch: a tap opens dictation and keeps it open, the next tap closes it", async () => {
    const { host, engine, transcriber, settle, tap, taps } = dictation("toggle")
    await tap()
    expect(engine.isRunning()).toBe(true)
    expect(engine.activeMode()).toBe("transcription")
    expect(engine.isLatched()).toBe(true)
    transcriber.emit("detto a microfono aperto", true)
    await settle()
    expect(host.calls).toContainEqual({ method: "insertText", args: ["pane-1", "detto a microfono aperto"] })
    expect(engine.isRunning()).toBe(true)

    await tap()
    expect(engine.isRunning()).toBe(false)
    expect(engine.isLatched()).toBe(false)
    expect(taps).toEqual([])
  })

  test("as a switch over always-on listening: closing it gives the microphone back to the name", async () => {
    const { engine, tap } = dictation("toggle", true)
    await engine.start("agent", { waitForName: true })
    await tap()
    expect(engine.activeMode()).toBe("transcription")
    await tap()
    expect(engine.isRunning()).toBe(true)
    expect(engine.activeMode()).toBe("agent")
    await engine.stop()
  })

  test("a profile from before the choice is held to speak, without a note", async () => {
    const { settings, corrections } = normalizeSettings({ ...DEFAULT_VOICE_SETTINGS, dictationPress: undefined })
    expect(settings.dictationPress).toBe("hold")
    expect(corrections).toEqual([])
  })
})

describe("the agent's answer is read as it is written", () => {
  function agentWith(askAgent: VoiceHost["askAgent"]) {
    const host = new MockVoiceHost()
    ;(host as VoiceHost).askAgent = askAgent
    const speaker = createFakeSpeaker()
    const cues: string[] = []
    const engine = createVoiceEngine({
      host,
      transcriber: createFakeTranscriber(),
      speaker,
      cue: (kind) => cues.push(kind),
      now: () => 10_000,
      settings: { agentEngine: "auto", alwaysListen: true },
    })
    return { engine, speaker, cues }
  }
  const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms))

  test("the first sentence is said before the turn ends, and nothing is said twice", async () => {
    let finish!: () => void
    const { engine, speaker, cues } = agentWith(async ({ onText }) => {
      onText?.("La capitale")
      onText?.("La capitale è Canberra. Non Syd")
      await new Promise<void>((r) => (finish = r))
      onText?.("La capitale è Canberra. Non Sydney, come si pensa.")
      return { ok: true, text: "La capitale è Canberra. Non Sydney, come si pensa. Fine", ran: true }
    })
    const done = engine.submitText("qual è la capitale dell'Australia?")
    await settle()
    expect(speaker.spoken).toEqual(["La capitale è Canberra."])
    expect(engine.lastSpoken()).toBe("La capitale è Canberra.")
    finish()
    await done
    // The last sentence had no space after it yet: it goes with the rest.
    expect(speaker.spoken).toEqual(["La capitale è Canberra.", "Non Sydney, come si pensa. Fine"])
    // The console gets the answer once, whole.
    expect(
      engine
        .history()
        .filter((e) => e.kind === "assistant")
        .map((e) => (e as { text: string }).text),
    ).toEqual(["La capitale è Canberra. Non Sydney, come si pensa. Fine"])
    expect(cues).toEqual([])
  })

  test("a sound says the request was taken when nothing is ready after a second and a half", async () => {
    const { engine, speaker, cues } = agentWith(async () => {
      await settle(1_700)
      return { ok: true, text: "Fatto adesso.", ran: true }
    })
    await engine.submitText("controlla le sessioni")
    expect(cues).toEqual(["thinking"])
    expect(speaker.spoken).toEqual(["Fatto adesso."])
  })

  test("a quick answer makes no sound", async () => {
    const { engine, cues } = agentWith(async () => ({ ok: true, text: "Subito.", ran: true }))
    await engine.submitText("ciao")
    await settle(1_600)
    expect(cues).toEqual([])
  })

  test("a failure after the first sentence is said after it", async () => {
    const { engine, speaker } = agentWith(async ({ onText }) => {
      onText?.("Apro la sessione. ")
      return { ok: false, text: "Claude Code non ha finito in tempo.", ran: true }
    })
    await engine.submitText("raccontami la storia di Roma")
    expect(speaker.spoken).toEqual(["Apro la sessione.", "Claude Code non ha finito in tempo."])
  })
})

describe("a conversation: after an answer the name is not needed for a few seconds", () => {
  function talking(settings: Record<string, unknown> = {}, customAskAgent?: VoiceHost["askAgent"]) {
    let clock = 10_000
    const host = new MockVoiceHost()
    const asked: string[] = []
    ;(host as VoiceHost).askAgent =
      customAskAgent ??
      (async (request) => {
        asked.push(request.text)
        return { ok: true, text: "Fatto.", ran: true }
      })
    const transcriber = createFakeTranscriber()
    const cues: string[] = []
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      cue: (kind) => cues.push(kind),
      now: () => clock,
      settings: { agentEngine: "auto", alwaysListen: true, ...settings },
    })
    const hear = async (text: string) => {
      transcriber.emit(text, true)
      await new Promise((r) => setTimeout(r, 30))
    }
    return { engine, asked, cues, hear, advance: (ms: number) => (clock += ms) }
  }

  test("the next sentence is taken without the name, and the one after the window is not", async () => {
    const { engine, asked, cues, hear, advance } = talking()
    await engine.start("agent", { waitForName: true })
    await hear("nik qual è la capitale della Francia")
    expect(asked).toHaveLength(1)
    expect(engine.followUp()).toBe(10_000 + FOLLOW_UP_MS)
    expect(cues).toEqual(["listening"])
    advance(3_000)
    await hear("e quella della Spagna")
    expect(asked).toHaveLength(2)
    advance(FOLLOW_UP_MS + 100)
    await hear("e quella dell'Italia")
    // Past the window, without the name: ignored.
    expect(asked).toHaveLength(2)
    await engine.stop()
  })

  test("a sentence ignored for lack of the name opens nothing", async () => {
    const { engine, asked, hear } = talking()
    await engine.start("agent", { waitForName: true })
    await hear("qual è la capitale della Francia")
    expect(asked).toHaveLength(0)
    expect(engine.followUp()).toBeUndefined()
    await engine.stop()
  })

  test("a typed question opens nothing, and typing closes an open window", async () => {
    const { engine, asked, hear } = talking()
    await engine.start("agent", { waitForName: true })
    await engine.submitText("uno")
    expect(asked).toHaveLength(1)
    expect(engine.followUp()).toBeUndefined()
    await hear("nik due")
    expect(asked).toHaveLength(2)
    expect(engine.followUp()).toBeDefined()
    await engine.submitText("grazie")
    expect(engine.followUp()).toBeUndefined()
    await hear("il telegiornale di stasera")
    expect(asked).toHaveLength(3)
    await engine.stop()
  })

  test("with listening by itself turned off, there is no window", async () => {
    const { engine, hear } = talking({ activation: "wake-word", alwaysListen: false })
    await engine.start("agent", { waitForName: true })
    await hear("nik qual è la capitale della Francia")
    expect(engine.followUp()).toBeUndefined()
    await engine.stop()
  })

  test("openResponseWindow starts in agent mode, sets followUp, and closes on timeout", async () => {
    const { engine } = talking({ activation: "push-to-talk", alwaysListen: false })
    await engine.openResponseWindow({
      durationMs: 50,
      permission: { paneId: "pane-1", what: "npm test", kind: "shell" },
    })
    expect(engine.isRunning()).toBe(true)
    expect(engine.followUp()).toBeDefined()
    expect(engine.dialogState().status).toBe("confirming")
    expect(engine.dialogState().pendingAction?.paneId).toBe("pane-1")

    await new Promise((r) => setTimeout(r, 80))
    expect(engine.isRunning()).toBe(false)
    expect(engine.followUp()).toBeUndefined()
  })

  test("openResponseWindow leaves an already-running dictation untouched", async () => {
    const { engine } = talking({ activation: "push-to-talk", alwaysListen: false })
    await engine.start("transcription")

    await engine.openResponseWindow({ durationMs: 30 })
    expect(engine.activeMode()).toBe("transcription")
    expect(engine.followUp()).toBeUndefined()
    expect(engine.isRunning()).toBe(true)

    await new Promise((r) => setTimeout(r, 60))
    expect(engine.activeMode()).toBe("transcription")
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })

  test("an old response-window timer does not close a restarted session", async () => {
    const { engine } = talking({ activation: "push-to-talk", alwaysListen: false })
    await engine.openResponseWindow({ durationMs: 30 })

    await engine.stop()
    await engine.start("agent", { waitForName: true })
    await new Promise((r) => setTimeout(r, 60))

    expect(engine.activeMode()).toBe("agent")
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })

  test("a response-window timer is invalidated by a mode takeover", async () => {
    const { engine } = talking({ activation: "wake-word", alwaysListen: true })
    await engine.openResponseWindow({ durationMs: 30 })
    await engine.toggle("transcription")

    await new Promise((r) => setTimeout(r, 60))
    expect(engine.activeMode()).toBe("transcription")
    expect(engine.followUp()).toBeUndefined()
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })

  test("openResponseWindow reschedules timer when executing and closes after execution finishes", async () => {
    let resolveTurn: () => void = () => {}
    const { engine, hear } = talking({ activation: "wake-word", alwaysListen: false }, async () => {
      await new Promise<void>((r) => {
        resolveTurn = r
      })
      return { ok: true, text: "Fatto.", ran: true }
    })

    await engine.openResponseWindow({ durationMs: 200, rescheduleMs: 50 })
    expect(engine.isRunning()).toBe(true)

    void hear("nik raccontami la storia di Roma")
    await new Promise((r) => setTimeout(r, 60))
    expect(engine.dialogState().status).toBe("executing")

    // Past initial 200ms duration: still executing, so mic is NOT closed
    await new Promise((r) => setTimeout(r, 200))
    expect(engine.isRunning()).toBe(true)

    // Turn completes -> state returns to idle -> next reschedule check closes the mic
    resolveTurn()
    await new Promise((r) => setTimeout(r, 120))
    expect(engine.isRunning()).toBe(false)
    expect(engine.followUp()).toBeUndefined()
  })

  test("openResponseWindow with alwaysListen keeps continuous listening open for wake word instead of stopping", async () => {
    const { engine } = talking({ activation: "wake-word", alwaysListen: true })
    await engine.openResponseWindow({ durationMs: 40 })
    expect(engine.isRunning()).toBe(true)
    expect(engine.followUp()).toBeDefined()

    await new Promise((r) => setTimeout(r, 60))
    // Engine remains running for always-on wake word
    expect(engine.isRunning()).toBe(true)
    expect(engine.followUp()).toBeUndefined()
    expect(engine.dialogState().status).toBe("idle")
    await engine.stop()
  })
})

describe("interrupted while it talks", () => {
  function talkingSlowly() {
    const host = new MockVoiceHost()
    const asked: string[] = []
    ;(host as VoiceHost).askAgent = async (request) => {
      asked.push(request.text)
      return { ok: true, text: "Una risposta lunga che non finisce mai.", ran: true }
    }
    const events: string[] = []
    let release: (() => void) | undefined
    const speaker = {
      speak: (text: string) => {
        events.push(`speak:${text}`)
        return new Promise<void>((r) => (release = r))
      },
      cancel: () => {
        events.push("cancel")
        release?.()
      },
    }
    const transcriber = createFakeTranscriber()
    let gate: any
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host,
      speaker,
      now: () => 10_000,
      settings: { agentEngine: "auto", alwaysListen: true, backend: "openrouter", openRouterApiKey: "k" },
      createTranscriber: (_backend, options) => {
        gate = options?.openRouterOptions?.nameGate
        return transcriber
      },
    })
    const hear = async (text: string) => {
      transcriber.emit(text, true)
      await new Promise((r) => setTimeout(r, 30))
    }
    return { host, asked, events, engine, hear, gate: () => gate, finish: () => release?.() }
  }
  const ran = (host: MockVoiceHost) => host.calls.filter((call) => call.method === "runCommand")

  test("its name over its voice stops the voice and the sentence is carried out", async () => {
    const { host, events, engine, hear } = talkingSlowly()
    await engine.start("agent", { waitForName: true })
    await hear("nik raccontami una storia")
    expect(events.at(-1)).toBe("speak:Una risposta lunga che non finisce mai.")
    await hear("nik apri la tavolozza")
    expect(events.slice(-1)).toEqual(["cancel"])
    expect(ran(host)).toEqual([{ method: "runCommand", args: ["palette.open"] }])
    await engine.stop()
  })

  test("the name heard at the start of a long sentence stops the voice before the rest is back", async () => {
    const { events, engine, gate } = talkingSlowly()
    await engine.start("agent", { waitForName: true })
    const before = events.length
    gate().onAccepted()
    expect(events.slice(before)).toEqual(["cancel"])
    await engine.stop()
  })

  test("a sentence from the room over its voice changes nothing", async () => {
    const { events, engine, hear, finish } = talkingSlowly()
    await engine.start("agent", { waitForName: true })
    await hear("nik raccontami una storia")
    const before = events.length
    await hear("il telegiornale di stasera")
    expect(events.slice(before)).toEqual([])
    finish()
    await engine.stop()
  })

  test("a tap stops the voice and the next sentence needs no name", async () => {
    for (const tap of ["toggle", "interrupt"] as const) {
      const { host, events, engine, hear } = talkingSlowly()
      await engine.start("agent", { waitForName: true })
      await hear("nik raccontami una storia")
      await engine[tap]()
      expect(events).toContain("cancel")
      expect(engine.isRunning()).toBe(true)
      await hear("apri la tavolozza")
      expect(ran(host)).toEqual([{ method: "runCommand", args: ["palette.open"] }])
      // Cut short, it says nothing about it.
      expect(events.filter((e) => e.startsWith("speak:"))).not.toContain("speak:Non c'è niente da fermare.")
      await engine.stop()
    }
  })
})

describe("a television talking on does not keep the window open", () => {
  test("five sentences in a row after one call: only the first reaches the agent", async () => {
    const host = new MockVoiceHost()
    const asked: string[] = []
    ;(host as VoiceHost).askAgent = async (request) => {
      asked.push(request.text)
      return { ok: true, text: "Fatto.", ran: true }
    }
    const transcriber = createFakeTranscriber()
    let gate: any
    let clock = 10_000
    const engine = createVoiceEngine({
      creditLeft: async () => undefined,
      host,
      speaker: createFakeSpeaker(),
      now: () => clock,
      settings: { agentEngine: "auto", alwaysListen: true, backend: "openrouter", openRouterApiKey: "k" },
      createTranscriber: (_backend, options) => {
        gate = options?.openRouterOptions?.nameGate
        return transcriber
      },
    })
    const hear = async (text: string) => {
      clock += 1_000
      transcriber.emit(text, true)
      await new Promise((r) => setTimeout(r, 30))
    }
    await engine.start("agent", { waitForName: true })
    await hear("nik qual è la capitale della Francia")
    const room = [
      "il governo ha approvato",
      "e domani pioggia al nord",
      "la partita finisce due a uno",
      "in borsa oggi",
      "e adesso la pubblicità",
    ]
    const wholeToCloud: boolean[] = []
    for (const sentence of room) {
      wholeToCloud.push(!gate.active(clock + 1_000))
      await hear(sentence)
    }
    // The first sentence after the answer is the follow-up; the rest need the name again.
    expect(asked).toHaveLength(2)
    expect(wholeToCloud).toEqual([true, false, false, false, false])
    expect(engine.followUp()).toBeUndefined()
    await engine.stop()
  })

  test("the name, or the button, opens a new one", async () => {
    const host = new MockVoiceHost()
    const asked: string[] = []
    ;(host as VoiceHost).askAgent = async (request) => {
      asked.push(request.text)
      return { ok: true, text: "Fatto.", ran: true }
    }
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      now: () => 10_000,
      settings: { agentEngine: "auto", alwaysListen: true },
    })
    const hear = async (text: string) => {
      transcriber.emit(text, true)
      await new Promise((r) => setTimeout(r, 30))
    }
    await engine.start("agent", { waitForName: true })
    await hear("nik qual è la capitale della Francia")
    await hear("e quella della Spagna")
    expect(engine.followUp()).toBeUndefined()
    await hear("nik e quella del Portogallo")
    expect(engine.followUp()).toBeDefined()
    await hear("e della Grecia")
    await engine.toggle()
    await hear("e di Malta")
    expect(engine.followUp()).toBeDefined()
    expect(asked).toHaveLength(5)
    await engine.stop()
  })
})

describe("hearing: the orb lights only when the next sentence would be taken (D74)", () => {
  beforeAll(() => setWakeWordEnabledForTests(true))
  afterAll(() => setWakeWordEnabledForTests(true))

  function listening() {
    let clock = 10_000
    const host = new MockVoiceHost()
    ;(host as VoiceHost).askAgent = async () => ({ ok: true, text: "Fatto.", ran: true })
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      cue: () => {},
      now: () => clock,
      settings: { agentEngine: "auto", alwaysListen: true, activation: "wake-word", mode: "agent" },
    })
    const hear = async (text: string) => {
      transcriber.emit(text, true)
      await new Promise((r) => setTimeout(r, 30))
    }
    return { engine, hear, advance: (ms: number) => (clock += ms) }
  }

  test("always listening at rest: the microphone is open, the orb is not lit", async () => {
    const { engine } = listening()
    await engine.start("agent", { waitForName: true })
    expect(engine.isRunning()).toBe(true)
    expect(engine.hearing()).toBe(false)
    await engine.stop()
  })

  test("the button calls it: lit for the window, dark once it runs out, with one timer and no polling", async () => {
    const { engine, advance } = listening()
    await engine.start("agent", { waitForName: true })
    const real = globalThis.setTimeout
    const timers: { fn: () => void; ms: number }[] = []
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      timers.push({ fn, ms: ms ?? 0 })
      return real(fn, ms, ...rest)
    }) as typeof setTimeout
    try {
      await engine.toggle()
    } finally {
      globalThis.setTimeout = real
    }
    expect(engine.hearing()).toBe(true)
    const end = timers.filter((timer) => timer.ms === WAKE_WINDOW_MS + 1)
    expect(end.length).toBeGreaterThan(0)
    advance(WAKE_WINDOW_MS + 1)
    end.at(-1)?.fn()
    expect(engine.hearing()).toBe(false)
    expect(engine.isRunning()).toBe(true)
    await engine.stop()
  })

  test("an answer keeps it lit for the follow-up", async () => {
    const { engine, hear } = listening()
    await engine.start("agent", { waitForName: true })
    await hear("nik qual è la capitale della Francia")
    expect(engine.followUp()).toBe(10_000 + FOLLOW_UP_MS)
    expect(engine.hearing()).toBe(true)
    await engine.stop()
  })

  test("a sentence dropped for lack of the name leaves it dark", async () => {
    const { engine, hear } = listening()
    await engine.start("agent", { waitForName: true })
    await hear("qual è la capitale della Francia")
    expect(engine.lastOutcome()?.spoken).toStartWith("Ignorata")
    expect(engine.hearing()).toBe(false)
    await engine.stop()
  })

  test("closing the microphone puts it out, whatever held it", async () => {
    const { engine } = listening()
    await engine.start("agent", { waitForName: true })
    await engine.toggle()
    expect(engine.hearing()).toBe(true)
    await engine.stop()
    expect(engine.hearing()).toBe(false)
  })

  test("outside always-on listening by name, an open microphone is heard", async () => {
    const { engine } = listening()
    await engine.updateSettings({ activation: "push-to-talk" })
    await engine.start("agent")
    expect(engine.hearing()).toBe(true)
    await engine.stop()
  })
})
