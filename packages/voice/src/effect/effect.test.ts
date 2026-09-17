import { DEFAULT_VOICE_SETTINGS } from "../settings/model"
import { describe, expect, test } from "bun:test"
import { Clock, Duration, Effect, Exit, Layer, Scope, TestClock, TestContext } from "effect"

import {
  ApiKeyInvalid,
  ApiKeyMissing,
  AudioFormatUnsupported,
  HostActionFailed,
  MicPermissionDenied,
  MicUnavailable,
  ModelLoadFailed,
  QuotaExhausted,
  RequestTimeout,
  SpeechRecognitionUnavailable,
  TranscriptionFailed,
  errorKind,
  spokenMessage,
} from "./errors"
import { Speaker, Transcriber, VoiceHostService } from "./services"
import { SpeakerFake, TranscriberFake, VoiceHostLive, bridgeTranscriber } from "./layers"
import { makeVoiceProgram } from "./program"
import { createFakeTranscriber } from "../asr/fake"
import { createFakeSpeaker } from "../tts/speaker"
import type { PaneSummary, VoiceHost, VoiceStateSnapshot, AdeView } from "../bridge/host"

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
  ]

  async runCommand(id: string): Promise<void> {
    this.calls.push({ method: "runCommand", args: [id] })
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
      totalSessions: 1,
      workingSessions: 1,
      waitingSessions: 0,
      doneSessions: 0,
      errorSessions: 0,
      currentView: "code",
      spokenSummary: "ADE ha 1 sessione attiva.",
    }
  }
}

describe("Effect-TS Voice Backend", () => {
  /*
   * The widget colours a ring by this, not by reading the sentence.
   *
   * The two mic failures are one kind because from the user's side they are
   * one situation — the hardware is not yours yet and the fix is outside this
   * window — and everything else is the other, because there is nothing to be
   * done about it from a ring.
   */
  test("errorKind separates a microphone that is not ours from everything else", () => {
    expect(errorKind(new MicPermissionDenied({}))).toBe("mic-auth")
    expect(errorKind(new MicUnavailable({}))).toBe("mic-auth")
    expect(errorKind(new ApiKeyMissing({}))).toBe("failed")
    expect(errorKind(new ModelLoadFailed({ backend: "parakeet" }))).toBe("failed")
    expect(errorKind(new Error("boom"))).toBe("failed")
    expect(errorKind(undefined)).toBe("failed")
  })

  /*
   * Errors reach the engine wrapped in a FiberFailure, which is why
   * `findTagged` digs rather than reading the outermost object. If the kind
   * were read off the top level, every failure in the app would be red.
   */
  test("errorKind digs the tag out of a wrapped cause", () => {
    const wrapped = new Error("qualcosa è andato storto", {
      cause: new MicPermissionDenied({}),
    })
    expect(errorKind(wrapped)).toBe("mic-auth")
  })

  test("every tagged error has a distinct Italian phrase and never leaks API keys", () => {
    const fakeKey = "sk-or-v1-secret-deadbeef-99999-super-secret-token"

    const allErrors = [
      new MicPermissionDenied({ message: `Denied ${fakeKey}` }),
      new MicUnavailable({ message: `No mic ${fakeKey}` }),
      new AudioFormatUnsupported({
        attemptedFormats: ["audio/webm;codecs=opus", "audio/mp4"],
        message: `Format error with ${fakeKey}`,
      }),
      new SpeechRecognitionUnavailable({ message: `Missing API ${fakeKey}` }),
      new ModelLoadFailed({ backend: "parakeet", message: `Fail ${fakeKey}` }),
      new TranscriptionFailed({
        cause: new Error(`Failed with ${fakeKey}`),
        message: `Trans failed ${fakeKey}`,
      }),
      new ApiKeyMissing({ message: `Missing key ${fakeKey}` }),
      new ApiKeyInvalid({ message: `Invalid key ${fakeKey}` }),
      new QuotaExhausted({ message: `Quota error with ${fakeKey}` }),
      new RequestTimeout({ timeoutMs: 30000, message: `Timeout ${fakeKey}` }),
      new HostActionFailed({
        action: "command.exec",
        message: `Action failed ${fakeKey}`,
      }),
    ]

    const spokenPhrases = allErrors.map((err) => spokenMessage(err))

    // 1. Each error has a distinct non-empty message
    expect(new Set(spokenPhrases).size).toBe(allErrors.length)
    for (const phrase of spokenPhrases) {
      expect(typeof phrase).toBe("string")
      expect(phrase.trim().length).toBeGreaterThan(10)
    }

    // 2. Strict security: zero leakage of API keys in spoken output
    for (const phrase of spokenPhrases) {
      expect(phrase.includes(fakeKey)).toBe(false)
      expect(phrase.includes("sk-or-v1")).toBe(false)
      expect(phrase.includes("secret")).toBe(false)
    }
  })

  /*
   * The regression this covers: an error that has crossed the Effect boundary
   * arrives wrapped, and reading only the outermost object found no tag on
   * anything. Every actionable cause reached the user as the same shrug.
   */
  test("spokenMessage finds the typed error inside whatever wrapped it", async () => {
    const missing = new ApiKeyMissing({ message: "Chiave assente" })
    const expected = spokenMessage(missing)

    // Plain Error chaining
    expect(spokenMessage(new Error("wrapped", { cause: missing }))).toBe(expected)

    // Two levels of it, as a Cause tree nests
    expect(spokenMessage({ _tag: "Fail", cause: { _tag: "Die", error: missing } })).toBe(expected)

    // What Effect.runPromise actually rejects with
    const failure = await Effect.runPromise(Effect.fail(missing)).catch((err: unknown) => err)
    expect(spokenMessage(failure)).toBe(expected)

    // And an untagged failure still gets the generic rather than a crash
    expect(spokenMessage(new Error("qualcosa"))).toContain("non ha funzionato")
    expect(spokenMessage(undefined)).toContain("non ha funzionato")
  })

  test("Layers compose cleanly: Transcriber + Speaker + VoiceHostService execute full roundtrip", async () => {
    const fakeTranscriber = createFakeTranscriber()
    const fakeSpeaker = createFakeSpeaker()
    const mockHost = new MockVoiceHost()

    const appLayer = Layer.mergeAll(TranscriberFake(fakeTranscriber), SpeakerFake(fakeSpeaker), VoiceHostLive(mockHost))

    const testProgram = Effect.gen(function* () {
      const handle = yield* makeVoiceProgram({
        getSettings: () => ({ ...DEFAULT_VOICE_SETTINGS, activation: "toggle" }),
      })
      // Emit recognized command
      fakeTranscriber.emit("nuova sessione", true)
      yield* Effect.sleep(Duration.millis(30))
      return handle
    })

    await Effect.runPromise(Effect.scoped(testProgram.pipe(Effect.provide(appLayer))))

    expect(mockHost.calls).toContainEqual({
      method: "runCommand",
      args: ["session.new"],
    })
    expect(fakeSpeaker.spoken).not.toContain("Creo una nuova sessione")
  })

  test("resource release guarantee: closed Scope releases microphone even on midway failure", async () => {
    let micAcquisitions = 0
    let micReleases = 0

    const mockHardwareMic = {
      start() {
        micAcquisitions++
      },
      stop() {
        micReleases++
      },
    }

    // A program that acquires the mic resource and then encounters a catastrophic failure
    const failingProgram = Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => mockHardwareMic.start()),
        () => Effect.sync(() => mockHardwareMic.stop()),
      )
      // Catastrophic failure halfway through
      yield* Effect.fail(new TranscriptionFailed({ cause: new Error("Hardware fault") }))
    })

    const scope = Effect.runSync(Scope.make())

    // Run program inside scope; it should fail
    const result = await Effect.runPromise(Scope.extend(failingProgram, scope).pipe(Effect.either))
    expect(result._tag).toBe("Left")
    expect(micAcquisitions).toBe(1)

    // Close scope
    await Effect.runPromise(Scope.close(scope, Exit.void))

    // Hardware microphone release is guaranteed
    expect(micReleases).toBe(1)
    expect(micAcquisitions).toBe(micReleases)
  })

  test("transcription error is spoken and listening continues for subsequent utterances", async () => {
    const fakeTranscriber = createFakeTranscriber()
    const fakeSpeaker = createFakeSpeaker()
    const mockHost = new MockVoiceHost()

    const appLayer = Layer.mergeAll(TranscriberFake(fakeTranscriber), SpeakerFake(fakeSpeaker), VoiceHostLive(mockHost))

    const program = Effect.gen(function* () {
      yield* makeVoiceProgram({ getSettings: () => ({ ...DEFAULT_VOICE_SETTINGS, activation: "toggle" }) })

      // 1. Emit an error from the transcriber
      fakeTranscriber.emitError(new Error("Errore di rete temporaneo"))
      yield* Effect.sleep(Duration.millis(30))

      // Verify speaker spoke the translated error
      expect(fakeSpeaker.spoken.length).toBeGreaterThan(0)
      const lastSpoken = fakeSpeaker.spoken[fakeSpeaker.spoken.length - 1]
      // Said in plain words: a network problem is called that.
      expect(lastSpoken).toBe("Non ho rete in questo momento: ti sento appena torna.")

      // 2. Transcriber emits another spoken phrase after the error
      fakeTranscriber.emit("nuova sessione", true)
      yield* Effect.sleep(Duration.millis(30))

      // Verify ADE host still received the command
      expect(mockHost.calls).toContainEqual({
        method: "runCommand",
        args: ["session.new"],
      })
    })

    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(appLayer))))
  })

  test("dialogue timeouts advance deterministically via TestClock with zero real waiting", async () => {
    const fakeTranscriber = createFakeTranscriber()
    const fakeSpeaker = createFakeSpeaker()
    const mockHost = new MockVoiceHost()

    const appLayer = Layer.mergeAll(TranscriberFake(fakeTranscriber), SpeakerFake(fakeSpeaker), VoiceHostLive(mockHost))

    const startTime = Date.now()

    const testProgram = Effect.gen(function* () {
      const handle = yield* makeVoiceProgram({
        getSettings: () => ({ ...DEFAULT_VOICE_SETTINGS, activation: "toggle" }),
      })

      // "termina processo" is a destructive command requiring confirmation
      yield* handle.submitText("termina processo")

      const stateBefore = yield* handle.getDialogState
      expect(stateBefore.status).toBe("confirming")
      expect(mockHost.calls).toHaveLength(0)

      // Fast-forward 15 seconds instantly using TestClock
      yield* TestClock.adjust(Duration.seconds(15))
      yield* Effect.yieldNow()
      yield* Effect.yieldNow()

      const stateAfter = yield* handle.getDialogState
      expect(stateAfter.status).toBe("idle")

      // Destructive command was never executed
      expect(mockHost.calls).toHaveLength(0)
      // Expiration announcement spoken
      expect(fakeSpeaker.spoken).toContain("Non ho sentito risposta: lascio stare.")
    })

    await Effect.runPromise(
      Effect.scoped(testProgram.pipe(Effect.provide(appLayer), Effect.provide(TestContext.TestContext))),
    )

    const elapsedTime = Date.now() - startTime
    // Verified: zero real waiting (15s simulated in < 150ms)
    expect(elapsedTime).toBeLessThan(1000)
  })
})

describe("problems said in plain words", () => {
  test("the browser's and the service's own words become a sentence with the remedy", async () => {
    const { plainProblem } = await import("./errors")
    expect(spokenMessage(new TranscriptionFailed({ cause: "x", message: "Could not start audio source" }))).toBe(
      "Il microfono è usato da un'altra app: chiudila e riprova.",
    )
    expect(plainProblem("TypeError: Failed to fetch")).toBe("Non ho rete in questo momento: ti sento appena torna.")
    expect(plainProblem("qualcosa di nuovo")).toBeUndefined()
  })
})
