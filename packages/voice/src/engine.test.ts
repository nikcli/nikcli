import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { setShortcutActivationEnabledForTests, setWakeWordEnabledForTests } from "./settings/model"
import { createVoiceEngine, holdsToTalk } from "./engine"
import { FOLLOW_UP_MS } from "./effect/program"
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

  answerPermission(paneId: string, answer: "allow" | "deny"): void {
    this.calls.push({ method: "answerPermission", args: [paneId, answer] })
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
      await engine.stop()
      slow.finish()
      await starting

      // The session that landed after the stop was freed rather than
      // installed: not running, and the transcriber was told to let go.
      expect(engine.isRunning()).toBe(false)
      expect(slow.stops).toBeGreaterThanOrEqual(1)
    })
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
    const { engine, host, transcriber } = setupEngine()

    await engine.start()

    // Host alerts engine that pane-1 needs permission
    await engine.handlePermissionRequest("pane-1", "esecuzione di npm install")

    expect(engine.status()).toBe("confirming")
    expect(engine.dialogState().pendingAction?.isPermission).toBe(true)

    // User grants permission
    transcriber.emit("consenti", true)
    await new Promise((r) => setTimeout(r, 10))

    expect(host.calls).toContainEqual({
      method: "answerPermission",
      args: ["pane-1", "allow"],
    })
    expect(engine.status()).toBe("idle")
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
      // No `activation` here: this is the default a new installation gets.
      const engine = createVoiceEngine({
        host,
        transcriber,
        speaker: createFakeSpeaker(),
        now: () => 10_000,
        settings: { agentEngine: "auto", activation: "wake-word" },
      })
      const hear = async (text: string) => {
        transcriber.emit(text, true)
        await new Promise((r) => setTimeout(r, 20))
      }
      return { host, asked, engine, hear }
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
        settings: { agentEngine: "auto", activation: "wake-word" },
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
        settings: { agentEngine: "auto", activation: "wake-word" },
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

  test("past the hourly limit of cloud requests it warns once, on screen, and keeps listening", async () => {
    let clock = 0
    let gate: any
    const engine = createVoiceEngine({
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
    gate.onRequest()
    const warning = engine.listenWarning()
    expect(warning).toContain("più di 3 frasi")
    expect(engine.history().at(-1)).toMatchObject({ kind: "error", text: warning })
    expect(engine.isRunning()).toBe(true)

    // Not repeated within the hour...
    gate.onRequest()
    expect(engine.history().filter((entry) => entry.kind === "error")).toHaveLength(1)
    // ...and the window slides: an hour later, a quiet room says nothing.
    clock += 61 * 60_000
    gate.onRequest()
    expect(engine.history().filter((entry) => entry.kind === "error")).toHaveLength(1)
    await engine.stop()
  })

  test("the cloud transcriber is told when only the start of a sentence is needed", async () => {
    let gate: any
    const transcriber = createFakeTranscriber()
    const engine = createVoiceEngine({
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
      settings: { agentEngine: "auto" },
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
      settings: { agentEngine: "auto" },
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
      settings: { agentEngine: "auto" },
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
      settings: { agentEngine: "auto" },
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
  function talking(settings: Record<string, unknown> = {}) {
    let clock = 10_000
    const host = new MockVoiceHost()
    const asked: string[] = []
    ;(host as VoiceHost).askAgent = async (request) => {
      asked.push(request.text)
      return { ok: true, text: "Fatto.", ran: true }
    }
    const transcriber = createFakeTranscriber()
    const cues: string[] = []
    const engine = createVoiceEngine({
      host,
      transcriber,
      speaker: createFakeSpeaker(),
      cue: (kind) => cues.push(kind),
      now: () => clock,
      settings: { agentEngine: "auto", ...settings },
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
    // One follow-up only: its answer does not open another window.
    expect(engine.followUp()).toBeUndefined()
    await hear("il telegiornale di stasera")
    expect(asked).toHaveLength(2)
    await engine.stop()
    expect(engine.followUp()).toBeUndefined()
  })

  test("a sentence ignored for lack of the name opens nothing", async () => {
    const { engine, cues, hear } = talking()
    await engine.start("agent", { waitForName: true })
    await hear("il telegiornale di stasera")
    expect(engine.followUp()).toBeUndefined()
    expect(cues).toEqual([])
    await engine.stop()
  })

  test("a typed question opens nothing, and typing closes an open window", async () => {
    const { engine, asked, hear } = talking()
    await engine.start("agent", { waitForName: true })
    await engine.submitText("qual è la capitale della Francia")
    expect(engine.followUp()).toBeUndefined()
    await hear("nik e quella della Spagna")
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
      host,
      speaker,
      now: () => 10_000,
      settings: { agentEngine: "auto", backend: "openrouter", openRouterApiKey: "k" },
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
      host,
      speaker: createFakeSpeaker(),
      now: () => clock,
      settings: { agentEngine: "auto", backend: "openrouter", openRouterApiKey: "k" },
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
      settings: { agentEngine: "auto" },
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
