import { describe, expect, test } from "bun:test"
import { setWakeWordEnabledForTests } from "./model"
import { createVoiceEngine } from "../engine"
import { createFakeTranscriber, type FakeTranscriber } from "../asr/fake"
import { createFakeSpeaker } from "../tts/speaker"
import { PTT_TAP_MS } from "../engine"

/*
 * These tests are about a held chord. A press released at once is a tap,
 * which latches the microphone instead; the clock is moved past the tap
 * threshold before each release so the hold is what is tested.
 */
let skew = 0
const heldClock = () => Date.now() + skew
const holdChord = () => {
  skew += PTT_TAP_MS + 1
}

import type { AdeView, PaneSummary, VoiceHost, VoiceStateSnapshot } from "../bridge/host"
import type { TranscriberBackend } from "../asr/select"
import type {
  FinalTranscriptCallback,
  PartialTranscriptCallback,
  Transcriber,
  TranscriberErrorCallback,
} from "../asr/transcriber"

class TestVoiceHost implements VoiceHost {
  calls: { method: string; args: any[] }[] = []
  panes: PaneSummary[] = [
    {
      id: "pane-1",
      title: "Agent Workspace",
      status: "idle" as any,
      index: 1,
      hasLiveProcess: false,
      isBrowser: false,
      isFile: false,
    },
    {
      id: "pane-2",
      title: "Second Pane",
      status: "working" as any,
      index: 2,
      hasLiveProcess: true,
      isBrowser: false,
      isFile: false,
    },
  ]

  async runCommand(id: string): Promise<void> {
    this.calls.push({ method: "runCommand", args: [id] })
  }

  listPanes(): PaneSummary[] {
    this.calls.push({ method: "listPanes", args: [] })
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
      totalSessions: 1,
      workingSessions: 1,
      waitingSessions: 0,
      doneSessions: 0,
      errorSessions: 0,
      currentView: "code",
      spokenSummary: "Stato attivo",
    }
  }
}

/**
 * A sentence the microphone heard. Typed text (`submitText`) needs no wake word
 * and no held key, so gating is tested through the transcriber.
 */
async function heard(transcriber: ReturnType<typeof createFakeTranscriber>, text: string): Promise<void> {
  transcriber.emit(text, true)
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("Voice Modes & Settings Interaction", () => {
  test("transcription mode vs agent mode: commands are never executed and route directly to insertText", async () => {
    const host = new TestVoiceHost()
    const speaker = createFakeSpeaker()
    const transcriber = createFakeTranscriber()

    const engine = createVoiceEngine({
      host,
      speaker,
      transcriber,
      now: () => Date.now(),
      settings: { activation: "toggle", mode: "transcription", transcriptionSend: "manual" },
    })

    await engine.start()

    // "chiudi il pannello 2" would execute pane.close in agent mode.
    // In transcription mode, it MUST NOT execute any host command!
    await engine.submitText("chiudi il pannello due")

    const runCommandCalls = host.calls.filter((c) => c.method === "runCommand")
    expect(runCommandCalls).toHaveLength(0)

    const insertTextCalls = host.calls.filter((c) => c.method === "insertText")
    expect(insertTextCalls).toHaveLength(1)
    expect(insertTextCalls[0].args[0]).toBe("pane-1")
    expect(insertTextCalls[0].args[1]).toBe("chiudi il pannello due")

    await engine.stop()
  })

  test("transcription mode: auto-send routes to sendPrompt while manual-send routes to insertText", async () => {
    const host = new TestVoiceHost()
    const speaker = createFakeSpeaker()
    const transcriber = createFakeTranscriber()

    const engine = createVoiceEngine({
      host,
      speaker,
      transcriber,
      now: () => Date.now(),
      settings: { activation: "toggle", mode: "transcription", transcriptionSend: "auto" },
    })

    await engine.start()

    await engine.submitText("implementa la funzione di ricerca")

    const sendPromptCalls = host.calls.filter((c) => c.method === "sendPrompt")
    expect(sendPromptCalls).toHaveLength(1)
    expect(sendPromptCalls[0].args[1]).toBe("implementa la funzione di ricerca")

    const insertTextCalls = host.calls.filter((c) => c.method === "insertText")
    expect(insertTextCalls).toHaveLength(0)

    // Switch to manual delivery via updateSettings
    await engine.updateSettings({ transcriptionSend: "manual" })

    await engine.submitText("aggiungi anche i test unitari")

    const insertCallsAfter = host.calls.filter((c) => c.method === "insertText")
    expect(insertCallsAfter).toHaveLength(1)
    expect(insertCallsAfter[0].args[1]).toBe("aggiungi anche i test unitari")

    await engine.stop()
  })

  test("agent mode with wake-word: stays deaf until wake word is heard, then parses single-shot command", async () => {
    setWakeWordEnabledForTests(true)
    const host = new TestVoiceHost()
    const speaker = createFakeSpeaker()
    const transcriber = createFakeTranscriber()

    const engine = createVoiceEngine({
      host,
      speaker,
      transcriber,
      now: () => Date.now(),
      settings: {
        mode: "agent",
        activation: "wake-word",
        wakeWord: "hei nik",
      },
    })

    // Opened the way ADE opens it: listening, waiting to be called.
    await engine.start("agent", { waitForName: true })

    // 1. Spoken without wake word -> ignored completely
    await heard(transcriber, "nuova sessione")
    expect(host.calls.filter((c) => c.method === "runCommand")).toHaveLength(0)

    // 2. Spoken with wake word (and ASR variation 'ehi nick') -> executes command immediately
    await heard(transcriber, "ehi nick nuova sessione")
    const newSessionCalls = host.calls.filter((c) => c.method === "runCommand" && c.args[0] === "session.new")
    expect(newSessionCalls).toHaveLength(1)

    await engine.stop()
    setWakeWordEnabledForTests(true)
  })

  test("push to talk: typed text runs whether or not the key is held", async () => {
    const host = new TestVoiceHost()
    const speaker = createFakeSpeaker()
    const transcriber = createFakeTranscriber()

    const engine = createVoiceEngine({
      host,
      speaker,
      transcriber,
      now: heldClock,
      settings: {
        mode: "agent",
        activation: "push-to-talk",
      },
    })
    const palette = () => host.calls.filter((c) => c.method === "runCommand" && c.args[0] === "palette.open")

    // Held: accepted
    await engine.pressToTalk()
    await engine.submitText("nuova sessione")
    expect(host.calls.filter((c) => c.method === "runCommand" && c.args[0] === "session.new")).toHaveLength(1)

    // Released: writing is its own deliberate act, and still runs
    holdChord()
    await engine.releaseToTalk()
    await engine.submitText("apri tavolozza")
    expect(palette()).toHaveLength(1)

    // Held again: accepted again
    await engine.pressToTalk()
    await engine.submitText("apri tavolozza")
    expect(palette()).toHaveLength(2)

    await engine.stop()
  })

  /*
   * Push-to-talk names a shortcut, not the whole feature. The toolbar button,
   * the palette and voice.toggle all reach start() directly, and a mic opened
   * that way used to hear everything and act on none of it — no error, no
   * transcript, just a widget saying "ascolto" to someone talking.
   */
  test("push to talk: a session opened by button listens without a chord held", async () => {
    const host = new TestVoiceHost()
    const speaker = createFakeSpeaker()
    const transcriber = createFakeTranscriber()

    const engine = createVoiceEngine({
      host,
      speaker,
      transcriber,
      now: () => Date.now(),
      settings: {
        mode: "agent",
        activation: "push-to-talk",
      },
    })

    await engine.start()
    await engine.submitText("nuova sessione")

    expect(host.calls.filter((c) => c.method === "runCommand" && c.args[0] === "session.new")).toHaveLength(1)

    // And stopping ends it: the next start is judged on its own.
    await engine.stop()
  })

  test("push to talk: releasing chord automatically deactivates after outcome is delivered", async () => {
    const host = new TestVoiceHost()
    const speaker = createFakeSpeaker()
    const transcriber = createFakeTranscriber()

    const engine = createVoiceEngine({
      host,
      speaker,
      transcriber,
      now: heldClock,
      settings: {
        mode: "agent",
        activation: "push-to-talk",
      },
    })

    await engine.pressToTalk()
    expect(engine.isRunning()).toBe(true)

    // User released chord:
    holdChord()
    await engine.releaseToTalk()

    // ASR completes and emits final transcript:
    transcriber.emit("nuova sessione", true)

    // Allow Effect loop to settle
    await new Promise((r) => setTimeout(r, 50))

    expect(host.calls.filter((c) => c.method === "runCommand" && c.args[0] === "session.new")).toHaveLength(1)

    // Engine must automatically stop / deactivate
    expect(engine.isRunning()).toBe(false)
  })

  test("push to talk: releasing without speech automatically stops after grace period", async () => {
    const host = new TestVoiceHost()
    const speaker = createFakeSpeaker()
    const transcriber = createFakeTranscriber()

    const engine = createVoiceEngine({
      host,
      speaker,
      transcriber,
      now: heldClock,
      settings: {
        mode: "agent",
        activation: "push-to-talk",
      },
    })

    await engine.pressToTalk()
    expect(engine.isRunning()).toBe(true)

    holdChord()
    await engine.releaseToTalk()

    // Wait for the 250ms grace timeout
    await new Promise((r) => setTimeout(r, 300))

    // Engine must be stopped and inactive
    expect(engine.isRunning()).toBe(false)
  })

  /*
   * The assistant and dictation are two features sharing one microphone.
   *
   * They used to be two positions of one switch: the control did whatever
   * `settings.mode` said, and every way of reaching the other one wrote that
   * setting — so summoning the assistant left the next press dictating, and
   * the choice made in the panel was silently replaced by the last button
   * pressed. These four tests are the shape that replaced it.
   */
  describe("i due controlli, sullo stesso microfono", () => {
    const makeEngine = (transcriber: FakeTranscriber, host: TestVoiceHost, mode: "agent" | "transcription") =>
      createVoiceEngine({
        host,
        speaker: createFakeSpeaker(),
        transcriber,
        now: () => Date.now(),
        settings: { activation: "toggle", mode, transcriptionSend: "manual" },
      })

    test("il controllo premuto decide, e la preferenza salvata non cambia", async () => {
      const host = new TestVoiceHost()
      const engine = makeEngine(createFakeTranscriber(), host, "agent")

      await engine.start("transcription")

      expect(engine.activeMode()).toBe("transcription")
      // The stored default is what the panel shows, and nobody wrote to it.
      expect(engine.settings().mode).toBe("agent")

      await engine.submitText("chiudi il pannello due")
      expect(host.calls.filter((c) => c.method === "runCommand")).toHaveLength(0)
      expect(host.calls.filter((c) => c.method === "insertText")).toHaveLength(1)

      await engine.stop()
    })

    test("premere l'altro controllo passa il microfono senza chiuderlo", async () => {
      const host = new TestVoiceHost()
      const engine = makeEngine(createFakeTranscriber(), host, "agent")

      await engine.toggle("agent")
      expect(engine.isRunning()).toBe(true)
      expect(engine.activeMode()).toBe("agent")

      await engine.toggle("transcription")
      // Still one open microphone — the session was handed over, not restarted.
      expect(engine.isRunning()).toBe(true)
      expect(engine.activeMode()).toBe("transcription")

      // And it takes effect on the next word, with no restart in between.
      await engine.submitText("nuova sessione")
      expect(host.calls.filter((c) => c.method === "runCommand")).toHaveLength(0)
      expect(host.calls.filter((c) => c.method === "insertText")).toHaveLength(1)

      await engine.stop()
    })

    test("ripremere lo stesso controllo chiude il microfono", async () => {
      const host = new TestVoiceHost()
      const engine = makeEngine(createFakeTranscriber(), host, "agent")

      await engine.toggle("transcription")
      expect(engine.isRunning()).toBe(true)

      await engine.toggle("transcription")
      expect(engine.isRunning()).toBe(false)
    })

    test("chiusa la sessione, torna a decidere la preferenza salvata", async () => {
      const host = new TestVoiceHost()
      const engine = makeEngine(createFakeTranscriber(), host, "agent")

      await engine.toggle("transcription")
      await engine.stop()

      expect(engine.activeMode()).toBe("agent")

      await engine.start()
      expect(engine.activeMode()).toBe("agent")

      await engine.submitText("nuova sessione")
      expect(host.calls.filter((c) => c.method === "runCommand" && c.args[0] === "session.new")).toHaveLength(1)

      await engine.stop()
    })
  })

  test("updateSettings changing backend: releases old transcriber BEFORE the new transcriber starts", async () => {
    const host = new TestVoiceHost()
    const speaker = createFakeSpeaker()

    const eventOrder: string[] = []

    class TrackedTranscriber implements Transcriber {
      constructor(public name: string) {}
      onPartial(_cb: PartialTranscriptCallback): void {}
      onFinal(_cb: FinalTranscriptCallback): void {}
      onError(_cb: TranscriberErrorCallback): void {}
      async start(): Promise<void> {
        eventOrder.push(`${this.name}.start`)
      }
      async stop(): Promise<void> {
        eventOrder.push(`${this.name}.stop`)
      }
    }

    const transcriberA = new TrackedTranscriber("transcriberA")
    const transcriberB = new TrackedTranscriber("transcriberB")

    let callCount = 0
    const mockTranscriberFactory = (backend: TranscriberBackend): Transcriber => {
      callCount++
      return backend === "openrouter" ? transcriberA : transcriberB
    }

    const engine = createVoiceEngine({
      host,
      speaker,
      createTranscriber: mockTranscriberFactory,
      now: () => Date.now(),
      settings: { activation: "toggle", backend: "openrouter" },
    })

    await engine.start()
    expect(eventOrder).toEqual(["transcriberA.start"])

    // Updating settings WITHOUT changing backend does not stop/start the transcriber
    await engine.updateSettings({ mode: "transcription", transcriptionSend: "auto" })
    expect(eventOrder).toEqual(["transcriberA.start"])

    // Now change backend from "openrouter" to "parakeet"
    await engine.updateSettings({ backend: "parakeet" })

    // Verify order: transcriberA.stop MUST come before transcriberB.start!
    expect(eventOrder).toEqual(["transcriberA.start", "transcriberA.stop", "transcriberB.start"])

    await engine.stop()
    expect(eventOrder).toEqual(["transcriberA.start", "transcriberA.stop", "transcriberB.start", "transcriberB.stop"])
  })

  test("push to talk: rapid re-press cancels previous release timers and preserves new session", async () => {
    const host = new TestVoiceHost()
    const speaker = createFakeSpeaker()
    const transcriber = createFakeTranscriber()

    const engine = createVoiceEngine({
      host,
      speaker,
      transcriber,
      now: heldClock,
      settings: {
        mode: "agent",
        activation: "push-to-talk",
      },
    })

    // Press 1
    await engine.pressToTalk()
    expect(engine.isRunning()).toBe(true)

    // Release 1 (schedules grace timer)
    holdChord()
    await engine.releaseToTalk()

    // Rapid Press 2 (before grace timer fires)
    await new Promise((r) => setTimeout(r, 50))
    await engine.pressToTalk()

    // Wait past the 250ms grace timer of Press 1
    await new Promise((r) => setTimeout(r, 260))

    // Engine must STILL be running for Press 2!
    expect(engine.isRunning()).toBe(true)

    // Second utterance completes
    transcriber.emit("nuova sessione", true)
    await new Promise((r) => setTimeout(r, 50))

    // Now after release, it can stop
    holdChord()
    await engine.releaseToTalk()
    await new Promise((r) => setTimeout(r, 300))
    expect(engine.isRunning()).toBe(false)
  })

  test("push to talk: empty speech finalization cleanly deactivates session without waiting for watchdog", async () => {
    const host = new TestVoiceHost()
    const speaker = createFakeSpeaker()
    const transcriber = createFakeTranscriber()

    const engine = createVoiceEngine({
      host,
      speaker,
      transcriber,
      now: heldClock,
      settings: {
        mode: "agent",
        activation: "push-to-talk",
      },
    })

    await engine.pressToTalk()
    expect(engine.isRunning()).toBe(true)

    holdChord()
    await engine.releaseToTalk()

    // Transcriber finishes and emits empty text
    transcriber.emit("", true)
    await new Promise((r) => setTimeout(r, 50))

    // Session must cleanly stop immediately without waiting 12 seconds
    expect(engine.isRunning()).toBe(false)
  })
})
