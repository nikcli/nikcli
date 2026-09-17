/**
 * Voice control engine orchestrating recognition, dialogue management,
 * host dispatching, and speech synthesis.
 *
 * Exposes reactive Solid signals for ADE UI components and enforces
 * critical behavioral safety rules:
 * - Ambiguous outcomes never execute directly; they query the user for clarification.
 * - Unknown inputs offer real sample suggestions drawn strictly from VOCABULARY.
 * - Destructive operations are held in escrow pending explicit confirmation.
 * - Hardware and recognition errors never leave the engine in an unrecoverable state.
 * - All time reads rely on injected now(), with zero internal Date.now() coupling.
 *
 * Backend integration:
 * - Backed by an Effect runtime and Scope managing resource acquisition and release.
 * - Solid signals are strictly outside the boundary, Effect is inside.
 */

import { createSignal } from "solid-js"
import { Effect, Exit, Scope, Stream } from "effect"
import type { VoiceHost } from "./bridge/host"
import type { DispatchOutcome } from "./bridge/dispatch"
import { createInitialDialogState, type DialogState, type DialogStatus } from "./dialog/session"
import type { ParseContext, ParseResult } from "./intent/parse"
import type { Transcriber } from "./asr/transcriber"
import type { Speaker } from "./tts/speaker"
import { playCue, type CueKind } from "./audio/cue"
import type { MicMeter } from "./audio/meter"
import { createTranscriberFor, type SelectTranscriberOptions, type TranscriberBackend } from "./asr/select"
import { disposeParakeetModel, warmupParakeetModel, type ParakeetProgress } from "./asr/parakeet-local"
import { CURRENT_SETTINGS_VERSION, normalizeSettings, type VoiceMode, type VoiceSettings } from "./settings/model"
import { matchesWakeWord } from "./settings/wake-word"
import { firstWords } from "./dialog/while-thinking"

import { errorKind, HostActionFailed, spokenMessage, type VoiceErrorKind } from "./effect/errors"
import {
  Speaker as SpeakerTag,
  Transcriber as TranscriberTag,
  VoiceHostService,
  type SpeakerService,
  type TranscriberService,
} from "./effect/services"
import { bridgeTranscriber } from "./effect/layers"
import { makeVoiceProgram, type VoiceProgramHandle } from "./effect/program"
import { createOpenRouterCompletion, type Completion } from "./plan/planner"
import { appendEntry, type AgentEntry } from "./agent/log"
import { describeStep } from "./plan/execute"

// ---------------------------------------------------------------------------
// Engine Options & Interface
// ---------------------------------------------------------------------------

export interface VoiceEngineOptions {
  /** The ADE host interface providing workbench control. */
  host: VoiceHost
  /** Initial voice configuration settings. */
  settings?: Partial<VoiceSettings>
  /** Pre-constructed speech-to-text transcriber implementation. */
  transcriber?: Transcriber
  /** Factory hook for creating backend transcribers (defaults to createTranscriberFor). */
  createTranscriber?: (backend: TranscriberBackend, options?: SelectTranscriberOptions) => Transcriber
  /** Backend selector to instantiate automatically when transcriber is not provided. */
  backend?: TranscriberBackend
  /** Options for the automatically instantiated backend. */
  backendOptions?: SelectTranscriberOptions
  /** Text-to-speech speaker implementation. */
  speaker: Speaker
  /** Plays a short sound; Web Audio unless a test replaces it. */
  cue?: (kind: CueKind) => void
  /** Injected time provider (epoch ms). Mandatory for deterministic execution. */
  now: () => number
  /** Optional audio level meter for microphone activity rings. */
  micMeter?: MicMeter
  /** Dynamic context provider supplying focused pane or custom context. */
  getContext?: () => Partial<ParseContext>
  /**
   * Overrides the planner used for sentences the grammar cannot match.
   *
   * Injected by tests so the whole path runs without a network; left unset in
   * the app, where it is built from the OpenRouter key in settings.
   */
  plan?: Completion
  /** Overrides the planner model. */
  plannerModel?: string
  /** Overrides `DRAIN_TIMEOUT_MS`, for tests that exercise a stuck request. */
  drainTimeoutMs?: number
  /** Overrides `LISTEN_REQUESTS_PER_HOUR`, for tests. */
  listenRequestsPerHour?: number
}

export interface VoiceEngine {
  // Reactive Solid signals
  readonly status: () => DialogStatus
  readonly partialTranscript: () => string
  readonly lastSpoken: () => string
  readonly lastOutcome: () => DispatchOutcome | undefined
  readonly micLevel: () => number
  readonly lastError: () => string | undefined
  /**
   * Which kind of failure `lastError` is, for a UI that has to pick a colour.
   *
   * The message is a sentence and sentences get rewritten; a widget deciding
   * between amber and red by matching Italian prose would break the first time
   * anyone edited the copy. See `VoiceErrorKind`.
   */
  readonly lastErrorKind: () => VoiceErrorKind | undefined
  readonly dialogState: () => DialogState
  readonly lastParseResult: () => ParseResult | undefined
  readonly isRunning: () => boolean
  readonly settings: () => VoiceSettings
  /**
   * Which of the two the microphone is doing right now.
   *
   * The assistant and dictation are two features, not two positions of one
   * switch: both are always available, and what decides between them is which
   * control was pressed. `settings().mode` is only the default — what an
   * unqualified `start()` means — and pressing a control never rewrites it.
   *
   * Reading this rather than `settings().mode` is what lets a button say
   * whether *it* is the one listening.
   */
  readonly activeMode: () => VoiceMode
  /**
   * Everything said and done this session, oldest first.
   *
   * The other signals above are current values and answer "what is happening".
   * The agent console has to answer "what happened", which no amount of
   * reading `lastSpoken` can do: two identical answers in a row are one signal
   * write, and a value that changes between renders is simply missed.
   */
  readonly history: () => AgentEntry[]
  /**
   * Progress of the local model's first download, while one is happening.
   *
   * The engine owns this because the engine builds the transcriber: the panel
   * and the HUD have no other way to tell "warming up, 40% of 600 MB" from
   * "started and heard nothing", and those look identical to someone talking.
   */
  readonly parakeetProgress: () => ParakeetProgress | undefined
  /**
   * What dictation has heard this session, oldest first.
   *
   * Separate from `partialTranscript`, which streams and clears, and from the
   * dialogue machine's own dictation buffer, which only exists for the
   * *assistant's* "detta un prompt" intent. Transcription mode goes through
   * neither, so without this the widget had nothing to show and said "sto
   * ascoltando…" for the whole session while the words were already in the
   * pane.
   */
  readonly dictated: () => readonly string[]
  /**
   * A free sentence heard while the assistant was thinking, set aside rather
   * than allowed to stop the turn. Sent by submitting «invia questa»; `null`
   * when there is none.
   */
  readonly held: () => string | null
  /**
   * Always-on listening closed by `pauseListening` — the PC locked or asleep —
   * and waiting to be opened again. Cleared by any start or stop.
   */
  readonly listenPaused: () => boolean
  /** Until when the next sentence needs no name, after an answer; undefined otherwise. */
  readonly followUp: () => number | undefined
  /**
   * Set when always-on listening has sent more than `LISTEN_REQUESTS_PER_HOUR`
   * sentences to the cloud in the last hour: said on screen, and listening
   * goes on. At most once an hour.
   */
  readonly listenWarning: () => string | undefined

  // Control methods
  /**
   * Opens the microphone. With a mode, opens it for that mode only.
   *
   * Opening it means "I am talking to you", so the first sentence needs no
   * name — unless `waitForName`, which is how ADE opens it by itself.
   */
  start(mode?: VoiceMode, options?: { waitForName?: boolean }): Promise<void>
  stop(): Promise<void>
  /** Closes the microphone because nobody can be talking to it, and remembers to open it again. */
  pauseListening(): Promise<void>
  /**
   * What one of the two controls does when pressed.
   *
   * Without a mode this is the old toggle. With one it is the button's own
   * question — "am *I* the one listening?" — and there are three answers:
   * not listening at all, so start in that mode; listening in that mode, so
   * this is the second press and it stops; listening in the *other* mode, so
   * hand the microphone over without closing it. The last case is the reason
   * this is not two independent toggles: there is one microphone.
   */
  toggle(mode?: VoiceMode): Promise<void>
  submitText(text: string): Promise<void>
  handlePermissionRequest(paneId: string, what: string): Promise<void>
  cancel(): Promise<void>
  /**
   * A tap while the assistant talks or works: it stops, and the next sentence
   * needs no name. Listening that is not always on is only cancelled.
   */
  interrupt(): Promise<void>
  pressToTalk(mode?: VoiceMode): Promise<void>
  releaseToTalk(): Promise<void>
  updateSettings(next: Partial<VoiceSettings>): Promise<void>
}

// ---------------------------------------------------------------------------
// Engine Factory
// ---------------------------------------------------------------------------

/** How many dictated sentences the widget keeps in view. */
const DICTATION_MEMORY = 6

/**
 * Longest a stop waits for speech already sent to come back.
 *
 * Just above the cloud backend's own 30 s request timeout, so a slow answer
 * still arrives and a hung one ends as that backend's timeout error.
 */
export const DRAIN_TIMEOUT_MS = 32_000

/**
 * How many sentences always-on listening may send to the cloud in an hour
 * before the user is told. Silence costs nothing — the capture only sends
 * speech — so this is a room that talks a lot: a television, a call. Past it
 * listening goes on, and the screen says why the bill may grow.
 */
export const LISTEN_REQUESTS_PER_HOUR = 120
const HOUR_MS = 60 * 60_000

/**
 * A push-to-talk press shorter than this is a tap, and a tap latches.
 *
 * Long enough for a deliberate press-and-let-go, short enough that nobody has
 * said a word in it.
 */
export const PTT_TAP_MS = 350

/**
 * Whether this shortcut is held while speaking, rather than pressed once.
 *
 * The assistant's shortcut follows the activation. Dictation is always held:
 * with the name as the way in, a pressed-once dictation stayed open with no
 * filter after the key came up, and sent whatever the room said to the pane.
 */
export function holdsToTalk(settings: Pick<VoiceSettings, "activation">, mode: VoiceMode): boolean {
  return settings.activation === "push-to-talk" || mode === "transcription"
}
const DRAIN_POLL_MS = 25

export function createVoiceEngine(options: VoiceEngineOptions): VoiceEngine {
  const { host, speaker, micMeter, now } = options
  const drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS
  const transcriberFactory = options.createTranscriber ?? createTranscriberFor

  // Settings handed over in code are a current choice, not an old profile to migrate.
  const initialSettings = normalizeSettings({
    version: CURRENT_SETTINGS_VERSION,
    ...(options.backend ? { backend: options.backend } : {}),
    ...options.settings,
  }).settings

  const [currentSettings, setCurrentSettings] = createSignal<VoiceSettings>(initialSettings)

  /*
   * The mode this particular session was opened for, if it was opened for one.
   *
   * Before this, the two controls reached the same place by *writing* the
   * stored mode: pressing "detta" saved `mode: "transcription"`, so the next
   * time the assistant was summoned it dictated instead, and the setting the
   * user chose in the panel had been silently replaced by the last button they
   * touched. They are two features; the microphone is the only thing they
   * share. So the choice lives here, for the length of one session, and the
   * stored setting stays what it always was: the default.
   *
   * Read through `effectiveSettings` on every utterance, which is what makes
   * handing the microphone from one to the other take effect on the next word
   * rather than needing the session torn down and rebuilt.
   */
  const [sessionMode, setSessionMode] = createSignal<VoiceMode | undefined>(undefined)

  const activeMode = (): VoiceMode => sessionMode() ?? currentSettings().mode

  const effectiveSettings = (): VoiceSettings => {
    const stored = currentSettings()
    const chosen = sessionMode()
    return chosen === undefined || chosen === stored.mode ? stored : { ...stored, mode: chosen }
  }

  // Solid signals for UI state
  const [dialogState, setDialogState] = createSignal<DialogState>(createInitialDialogState("idle"))
  const [partialTranscript, setPartialTranscript] = createSignal<string>("")
  const [lastSpoken, setLastSpoken] = createSignal<string>("")
  const [lastOutcome, setLastOutcome] = createSignal<DispatchOutcome | undefined>(undefined)
  const [micLevel, setMicLevel] = createSignal<number>(0)
  const [lastError, setLastError] = createSignal<string | undefined>(undefined)
  const [lastErrorKind, setLastErrorKind] = createSignal<VoiceErrorKind | undefined>(undefined)

  /**
   * The message and its kind, written together and cleared together.
   *
   * Two signals that must never disagree, so nothing sets one of them: an
   * error whose kind said `mic-auth` while its text talked about an API key
   * would put an amber ring around the wrong sentence.
   */
  const noteError = (error: unknown, message: string | undefined) => {
    setLastError(message)
    setLastErrorKind(message === undefined ? undefined : errorKind(error))
  }
  const clearError = () => noteError(undefined, undefined)

  const [lastParseResult, setLastParseResult] = createSignal<ParseResult | undefined>(undefined)
  const [isRunning, setIsRunning] = createSignal<boolean>(false)
  const [parakeetProgress, setParakeetProgress] = createSignal<ParakeetProgress | undefined>(undefined)
  /*
   * The last few dictated sentences, newest last.
   *
   * A few rather than all of them: this feeds one line in a small widget, and
   * a dictation session that runs for ten minutes would otherwise accumulate
   * everything the user said into a string the interface has to re-render on
   * every word. What is kept is enough to read back the current thought.
   */
  const [dictated, setDictated] = createSignal<string[]>([])
  const [history, setHistory] = createSignal<AgentEntry[]>([])
  const [held, setHeld] = createSignal<string | null>(null)
  const [listenPaused, setListenPaused] = createSignal(false)
  const [followUp, setFollowUp] = createSignal<number | undefined>(undefined)
  const [listenWarning, setListenWarning] = createSignal<string | undefined>(undefined)

  const record = (entry: AgentEntry) => setHistory((log) => appendEntry(log, entry))

  let engineScope: Scope.CloseableScope | null = null
  let transcriberScope: Scope.CloseableScope | null = null
  let programScope: Scope.CloseableScope | null = null
  let programHandle: VoiceProgramHandle | null = null
  let activeTranscriber: Transcriber | null = null
  let hasOverriddenTranscriber = Boolean(options.transcriber)

  // If Parakeet is configured and already downloaded, warm it up in the background so activation is instant.
  if (initialSettings.backend === "parakeet" && !hasOverriddenTranscriber) {
    void warmupParakeetModel({
      executionBackend: initialSettings.parakeetBackend,
      language: initialSettings.language,
      onlyIfDownloaded: true,
    }).catch(() => {})
  }

  /*
   * Whether the microphone is being held open by a key, and whether it was
   * opened by something that is not a key at all.
   *
   * The second flag exists because push-to-talk describes a shortcut, not the
   * whole feature. Someone whose activation is push-to-talk can still press the
   * toolbar button or run the command, and until now that opened the microphone
   * and then discarded every word it heard, because the program only accepts
   * speech while the chord is down. An open mic nobody asked to be deaf.
   */
  let chordHeld = false
  let openedWithoutChord = false
  /* When the chord went down, to tell a tap from a hold on release. */
  let pressedAt: number | undefined
  /* A tap opened this session and it stays open until the next press. */
  let latched = false
  /* The press that ended a latch; its release must not start anything. */
  let pressEndsLatch = false
  /* Dictation held on its key while the assistant is called by name. */
  let heldDictation = false
  /* Whether the key being held is the thing that ends this session. */
  const pressHolds = (): boolean => currentSettings().activation === "push-to-talk" || heldDictation

  let pttGraceTimer: ReturnType<typeof setTimeout> | undefined
  let pttWatchdogTimer: ReturnType<typeof setTimeout> | undefined

  function clearPttTimers(): void {
    if (pttGraceTimer !== undefined) {
      clearTimeout(pttGraceTimer)
      pttGraceTimer = undefined
    }
    if (pttWatchdogTimer !== undefined) {
      clearTimeout(pttWatchdogTimer)
      pttWatchdogTimer = undefined
    }
  }

  /**
   * Which session is the current one, and whether one is being opened.
   *
   * `isRunning()` was the only guard, and it is written *after* `startSession()`
   * resolves — which for the local model is a multi-minute download. Two presses
   * inside that window both passed the guard, both built a session, and the
   * second overwrote the first's scopes: a microphone, an audio graph and a
   * recognition fibre with nothing left pointing at them, for the rest of the
   * run. The mirror case was worse — `stop()` during that window set the flag
   * to false and closed scopes that were still null, and the session that
   * landed afterwards kept the microphone open with the whole interface saying
   * it was off.
   *
   * So the truth is a counter, taken before the await and checked after it.
   * Anything that ends a session bumps it, and a start that comes back to find
   * its number stale tears down what it built instead of installing it. The
   * promise beside it makes a second press wait for the first rather than
   * racing it.
   */
  let sessionGeneration = 0
  let startInFlight: Promise<void> | null = null

  /**
   * Closes one scope, and says so when it will not close.
   *
   * These used to be three identical `catch {}` blocks. A finalizer that throws
   * is exactly the case worth hearing about — it is the microphone that did not
   * let go, or the inference session that did not release its memory — and the
   * scope reference is dropped either way, so silence here is how a leak
   * becomes permanent without a trace.
   */
  const closeScope = async (scope: Scope.CloseableScope, what: string): Promise<void> => {
    try {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    } catch (err) {
      noteError(err, `Chiusura non riuscita (${what}). Se il microfono resta acceso, riavvia ADE.`)
    }
  }

  /**
   * Everything one session holds, released.
   *
   * Shared by `stop()` and by a start that discovers it has been superseded,
   * because those two must free the same things: a start that only returned
   * early would leave behind precisely the session nobody can reach.
   */
  const releaseSession = async (): Promise<void> => {
    if (programScope) {
      const scope = programScope
      programScope = null
      programHandle = null
      await closeScope(scope, "programma")
    }

    if (transcriberScope) {
      const scope = transcriberScope
      transcriberScope = null
      activeTranscriber = null
      await closeScope(scope, "trascrittore")
    }

    if (engineScope) {
      const scope = engineScope
      engineScope = null
      await closeScope(scope, "motore")
    }
  }

  /**
   * Lets the words already heard reach their pane before the session goes.
   *
   * Without this, closing dictation right after speaking — which is how
   * anyone ends it — sent the last sentence to the service, paid for it, and
   * then closed the scope the answer was coming back to. The recording only
   * splits itself after most of a second of silence, so a press that came
   * sooner lost everything said since the previous pause.
   *
   * The microphone stops taking audio at once; only the wait is long. Bounded,
   * because a request that never returns must not keep a stop from finishing.
   */
  const drainSession = async (): Promise<void> => {
    const transcriber = activeTranscriber
    const handle = programHandle
    if (!transcriber || !handle) return

    if (transcriber.finish) transcriber.finish()
    else transcriber.commit?.()

    const settled = async () => !transcriber.hasInFlight && (await Effect.runPromise(handle.isIdle))

    /*
     * Settled twice, one macrotask apart: a final transcript can sit between
     * leaving the queue and the loop starting on it, and a single look taken
     * in that instant would call it done.
     */
    let waited = 0
    for (;;) {
      if (await settled()) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (await settled()) return
      }
      if (waited >= drainTimeoutMs) return
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS))
      waited += DRAIN_POLL_MS
    }
  }

  /*
   * The stop in progress. A second stop joins it rather than starting over —
   * the dictation path itself calls `stop()` once a push-to-talk sentence is
   * delivered, which is while the first stop is still waiting on that very
   * sentence.
   */
  let stopping: Promise<void> | null = null

  /*
   * The assistant opened by a tap of its shortcut, or by the button, closes
   * when its turn is over, as a held one does on release. Looked at once the
   * outcome has settled: a line said while it still thinks, or a question it
   * is waiting on, is not the end of the turn.
   */
  /*
   * Which sessions last one turn: the shortcut's, and a microphone opened by
   * hand when the assistant is not meant to listen by itself. Always-on
   * listening stays open and goes back to waiting for the name.
   */
  function closesAfterTurn(): boolean {
    const s = currentSettings()
    return s.activation === "push-to-talk" || (s.activation === "wake-word" && !s.alwaysListen)
  }

  function closeAfterTurn(): void {
    const generation = sessionGeneration
    setTimeout(() => {
      if (generation !== sessionGeneration || !isRunning() || chordHeld) return
      if (!closesAfterTurn() || activeMode() !== "agent") return
      const status = dialogState().status
      if (status === "executing" || status === "confirming" || status === "dictating") return
      clearPttTimers()
      void stop()
    }, 0)
  }
  /* Dictation took the microphone from always-on listening, which it gives back on close. */
  let dictationInterruptedListening = false

  /*
   * Requests sent while waiting for the name, over the last hour, and when
   * the user was last told there were too many.
   */
  let listenRequests: number[] = []
  let listenWarnedAt: number | undefined
  function countListenRequest(): void {
    const at = now()
    listenRequests = [...listenRequests.filter((t) => at - t < HOUR_MS), at]
    const cap = options.listenRequestsPerHour ?? LISTEN_REQUESTS_PER_HOUR
    if (listenRequests.length <= cap) return
    if (listenWarnedAt !== undefined && at - listenWarnedAt < HOUR_MS) return
    listenWarnedAt = at
    const text = `Nell'ultima ora l'ascolto sempre attivo ha mandato al servizio di trascrizione più di ${cap} frasi: c'è molto parlato intorno, per esempio la televisione. Continua ad ascoltare; per fermarlo premi «In ascolto» in alto.`
    setListenWarning(text)
    record({ kind: "error", text, at })
  }

  /*
   * `keepAgent`: the microphone is about to reopen for the name (the end of a
   * dictation that took it over), so the agent kept ready stays. Released and
   * prepared again, it would start its process over for nothing.
   */
  const stop = (options?: { keepAgent?: boolean }): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      try {
        await stopNow(options?.keepAgent === true)
      } finally {
        stopping = null
      }
    })()
    return stopping
  }

  /*
   * The end of a held press. A dictation held over always-on listening gives
   * the microphone back to it, waiting for the name again.
   */
  const endPress = async (): Promise<void> => {
    const back = heldDictation && dictationInterruptedListening
    const s = currentSettings()
    const listenAgain = back && s.alwaysListen && s.activation === "wake-word" && s.mode === "agent"
    await stop({ keepAgent: listenAgain })
    if (listenAgain) {
      await startListening("agent", { waitForName: true })
    }
  }
  let startListening: (mode: VoiceMode, o: { waitForName: boolean }) => Promise<void> = async () => {}

  const stopNow = async (keepAgent = false): Promise<void> => {
    /* Before anything else: a start still in flight must find its number
       stale and free what it has built rather than install it. */
    sessionGeneration++
    clearPttTimers()
    setListenPaused(false)
    dictationInterruptedListening = false
    heldDictation = false

    setIsRunning(false)
    setFollowUp(undefined)
    if (!keepAgent) host.releaseAgent?.()

    /* Drained before the mode is forgotten: a dictated sentence read after
       `setSessionMode(undefined)` would be parsed as a command. */
    await drainSession()

    setPartialTranscript("")
    setParakeetProgress(undefined)
    setDictated([])
    chordHeld = false
    openedWithoutChord = false
    latched = false
    pressedAt = undefined
    /* The next session is judged on its own: whatever opens it says what
       it is for, and if nothing says, the stored default decides. */
    setSessionMode(undefined)

    if (micMeter) {
      micMeter.stop()
    }

    cancelSpeech()

    await releaseSession()

    setDialogState((prev) => ({ ...prev, status: "asleep" }))
  }

  // Wire up mic meter if provided
  if (micMeter) {
    micMeter.onLevel((lvl: number) => {
      setMicLevel(lvl)
    })
  }

  /**
   * The planner, or nothing.
   *
   * Nothing is a working configuration: with no key, an unmatched sentence
   * gets the suggestions it always got, and the rest of the voice stack —
   * which is entirely offline once the transcriber is local — keeps working.
   * An injected `plan` wins, so tests never reach the network.
   */
  function resolvePlanner(): Completion | undefined {
    if (options.plan) return options.plan
    const key = currentSettings().openRouterApiKey
    if (!key) return undefined
    return createOpenRouterCompletion({
      apiKey: key,
      ...(options.plannerModel ? { model: options.plannerModel } : {}),
    })
  }

  function resolveTranscriber(s: VoiceSettings): Transcriber {
    if (hasOverriddenTranscriber && options.transcriber) {
      return options.transcriber
    }
    /*
     * The chosen microphone, for both backends and for both streams.
     *
     * `ideal` rather than `exact`: a stored id names a device that may not be
     * plugged in this morning, and `exact` answers that with an
     * `OverconstrainedError` — a voice control that stops working because a
     * headset is in the other room. Ideal falls back to the system default,
     * which is what the user would have chosen anyway.
     */
    const captureOptions = s.inputDeviceId ? { deviceId: s.inputDeviceId } : {}

    return transcriberFactory(s.backend, {
      ...options.backendOptions,
      apiKey: s.openRouterApiKey ?? options.backendOptions?.apiKey,
      // The panel's language choice, which until now also went nowhere: both
      // backends asked for Italian whatever the picker said.
      language: s.language,
      openRouterOptions: {
        now,
        nameGate: {
          active: (spokenAt: number) => programHandle?.waitingForName(spokenAt) ?? false,
          accepts: (text: string) => matchesWakeWord(text, currentSettings().wakeWord).matched,
          onRequest: countListenRequest,
          onAccepted: () => cancelSpeech(),
          onUncut: () =>
            record({
              kind: "action",
              label: "Ignorata una frase lunga: non se ne poteva mandare solo l'inizio.",
              ok: true,
              at: now(),
            }),
          onRejected: (text: string) =>
            record({
              kind: "action",
              label: `Ignorata, non inizia con «${currentSettings().wakeWord}»: «${firstWords(text).replace(/…$/, "")}…».`,
              ok: true,
              at: now(),
            }),
        },
        ...options.backendOptions?.openRouterOptions,
        captureOptions: {
          ...options.backendOptions?.openRouterOptions?.captureOptions,
          ...captureOptions,
          onLevel: (lvl: number) => {
            setMicLevel(lvl)
            options.backendOptions?.openRouterOptions?.captureOptions?.onLevel?.(lvl)
          },
        },
      },
      parakeetOptions: {
        ...options.backendOptions?.parakeetOptions,
        // The panel's acceleration choice, which until now went nowhere.
        executionBackend: s.parakeetBackend,
        captureOptions: {
          ...options.backendOptions?.parakeetOptions?.captureOptions,
          ...captureOptions,
          onLevel: (lvl: number) => {
            setMicLevel(lvl)
            options.backendOptions?.parakeetOptions?.captureOptions?.onLevel?.(lvl)
          },
        },
        /*
         * Reported as it arrives, and cleared only when the session is up.
         *
         * It used to be cleared the moment a file reached 100%, and a download
         * is three or four files fetched one after another: the bar vanished
         * when the encoder finished and the user watched nothing at all while
         * the decoder, the vocabulary and the runtime compile went on. The end
         * of the download is not a percentage, it is the session starting.
         */
        onProgress: (progress) => {
          setParakeetProgress(progress)
          options.backendOptions?.parakeetOptions?.onProgress?.(progress)
        },
      },
    })
  }

  async function startSession(): Promise<void> {
    const s = currentSettings()
    const transcriber = resolveTranscriber(s)
    activeTranscriber = transcriber

    transcriberScope = Effect.runSync(Scope.make())

    const transcriberService = await Effect.runPromise(
      Scope.extend(
        bridgeTranscriber(transcriber, undefined, (err) => {
          const msg = spokenMessage(err) || err.message
          noteError(err, msg)
          setPartialTranscript("")
          if (dialogState().status === "executing") {
            setDialogState((prev) => ({ ...prev, status: "idle" }))
          }
        }),
        transcriberScope,
      ),
    )

    programScope = Effect.runSync(Scope.make())

    programHandle = await Effect.runPromise(
      Scope.extend(makeVoiceProgram(programOptions()), programScope).pipe(
        Effect.provideService(TranscriberTag, transcriberService),
        Effect.provideService(SpeakerTag, speakerService),
        Effect.provideService(VoiceHostService, host),
      ),
    )
    await releaseTextProgram()
  }

  /*
   * A reply read in pieces: each piece waits for the one before it, and a
   * cancel drops whatever is still queued.
   */
  let speechGeneration = 0
  let speechTail: Promise<void> = Promise.resolve()
  function cancelSpeech(): void {
    speechGeneration++
    speechTail = Promise.resolve()
    speaker.cancel()
  }
  function appendSpeech(text: string): Promise<void> {
    if (!text.trim()) return speechTail
    const mine = speechGeneration
    speaker.prefetch?.(text)
    const turn = speechTail.then(() => (mine === speechGeneration ? speaker.speak(text) : undefined))
    speechTail = turn.catch(() => {})
    return turn
  }

  /** What the program says through: nothing in pure transcription mode. */
  const speakerService: SpeakerService = {
    speak: (text: string) => {
      // Pure transcription mode must NEVER speak: it is strictly a silent speech-to-text bridge.
      if (activeMode() === "transcription") {
        return Effect.void
      }
      return Effect.tryPromise({
        try: () => {
          // A whole reply replaces whatever was queued.
          speechGeneration++
          speechTail = Promise.resolve()
          return Promise.resolve(speaker.speak(text))
        },
        catch: (err) =>
          new HostActionFailed({
            action: "speak",
            cause: err,
            message: "Errore durante la sintesi vocale.",
          }),
      })
    },
    cancel: Effect.sync(() => cancelSpeech()),
    append: (text: string) => {
      if (activeMode() === "transcription") return Effect.void
      return Effect.tryPromise({
        try: () => appendSpeech(text),
        catch: (err) =>
          new HostActionFailed({
            action: "speak",
            cause: err,
            message: "Errore durante la sintesi vocale.",
          }),
      })
    },
  }

  const programOptions = (): Parameters<typeof makeVoiceProgram>[0] => ({
    initialStatus: dialogState().status === "asleep" ? "asleep" : "idle",
    now,
    getContext: options.getContext,
    getSettings: effectiveSettings,
    getHistory: () => history(),
    isPushToTalkActive: () => chordHeld || openedWithoutChord,
    onStateChange: (state) => setDialogState(state),
    onPartialTranscript: (text) => setPartialTranscript(text),
    onSpeaking: (text) => {
      if (activeMode() !== "transcription") setLastSpoken(text)
    },
    onFollowUp: (until) => setFollowUp(until),
    onCue: (kind) => {
      if (activeMode() !== "transcription") (options.cue ?? playCue)(kind)
    },
    onSpoken: (text) => {
      if (activeMode() === "transcription") return
      setLastSpoken(text)
      record({ kind: "assistant", text, at: now() })
    },
    onOutcome: (outcome) => {
      setLastOutcome(outcome)
      /*
       * Only outcomes that say something are worth a line. A successful
       * action whose `spoken` is empty has already been announced by the
       * intent's readback, and logging it again would double every turn.
       */
      const label = outcome.spoken || outcome.error
      if (label) {
        record({
          kind: "action",
          label,
          ok: outcome.success,
          ...(outcome.success ? {} : outcome.error ? { detail: outcome.error } : {}),
          at: now(),
        })
      }
      // The assistant closes at the end of the turn, after its voice: see `onTurnEnd`.
      if (activeMode() !== "agent" && pressHolds() && !chordHeld && !openedWithoutChord) {
        clearPttTimers()
        if (dialogState().status !== "confirming") {
          void endPress()
        }
      }
    },
    onTurnEnd: () => {
      if (closesAfterTurn() && activeMode() === "agent") closeAfterTurn()
    },
    onUtterance: (text) => record({ kind: "user", text, at: now() }),
    onHeld: (text) => setHeld(text),
    onTranscribed: (text) => {
      setDictated((previous) => [...previous, text].slice(-DICTATION_MEMORY))
      record({ kind: "user", text, at: now() })
      if (typeof window !== "undefined") {
        const win = window as unknown as {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
          __TAURI__?: { core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }
        }
        const invoke = win.__TAURI_INTERNALS__?.invoke ?? win.__TAURI__?.core?.invoke
        if (invoke) {
          void invoke("write_clipboard", { text }).catch(() => {})
        }
      }
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {})
      }
      if (pressHolds() && !chordHeld && !openedWithoutChord) {
        clearPttTimers()
        void endPress()
      }
    },
    onPlan: (result) => {
      record({
        kind: "plan",
        /*
         * Both halves, in the order the reader needs them: what ran,
         * then why the rest did not. `failures` is already phrased as a
         * sentence, so it is shown as-is rather than re-described.
         */
        steps: [...result.execution.done.map(describeStep), ...result.execution.failures],
        ok: result.execution.done.length,
        failed: result.execution.failures.length,
        at: now(),
      })
    },
    onError: (err: unknown) => {
      const message =
        typeof err === "string"
          ? err
          : spokenMessage(err) || (err && typeof err === "object" && err instanceof Error ? err.message : undefined)
      noteError(err, message)
      if (message) record({ kind: "error", text: message, at: now() })
      if (activeMode() !== "agent" && pressHolds() && !chordHeld && !openedWithoutChord) {
        clearPttTimers()
        void endPress()
      }
    },
    onParseResult: (res) => setLastParseResult(res),
    /*
     * Resolved per run, not captured once: the key and the model live
     * in settings the user can change while the app is open, and a
     * planner pinned at construction would keep using the old ones.
     */
    plan: resolvePlanner(),
  })

  /*
   * A transcriber that never hears anything, for text typed with the
   * microphone off.
   */
  const silentTranscriber: TranscriberService = {
    start: Effect.void,
    stop: Effect.void,
    finals: Stream.never,
    partials: Stream.never,
    stream: Stream.never,
    events: Stream.never,
    idle: Effect.succeed(true),
  }

  let textHandle: Promise<VoiceProgramHandle> | null = null
  let textScope: Scope.CloseableScope | null = null

  /** Once the microphone's program is up it takes typed text too, so the text-only one goes. */
  const releaseTextProgram = async (): Promise<void> => {
    const scope = textScope
    textHandle = null
    textScope = null
    if (scope) await closeScope(scope, "programma testuale")
  }

  /**
   * The program that answers typed text while the microphone is off.
   *
   * The agent console says "talk to the assistant or write to it", and writing
   * used to do nothing at all until the microphone was opened: the text was
   * cleared from the box and never reached anyone. Built once, on the first
   * sentence typed, with no microphone behind it; a session opened later
   * takes the text over, since it is the one the user is also speaking to.
   */
  const textProgram = (): Promise<VoiceProgramHandle> => {
    if (!textHandle) {
      const scope = Effect.runSync(Scope.make())
      textScope = scope
      textHandle = Effect.runPromise(
        Scope.extend(makeVoiceProgram(programOptions()), scope).pipe(
          Effect.provideService(TranscriberTag, silentTranscriber),
          Effect.provideService(SpeakerTag, speakerService),
          Effect.provideService(VoiceHostService, host),
        ),
      )
      textHandle.catch(() => {
        textHandle = null
        textScope = null
        void closeScope(scope, "programma testuale")
      })
    }
    return textHandle
  }

  const engine: VoiceEngine = {
    status: () => dialogState().status,
    partialTranscript,
    lastSpoken,
    lastOutcome,
    micLevel,
    lastError,
    lastErrorKind,
    dialogState,
    lastParseResult,
    isRunning,
    settings: currentSettings,
    activeMode,
    parakeetProgress,
    dictated,
    history,
    held,
    listenPaused,
    listenWarning,
    followUp,

    async start(mode?: VoiceMode, startOptions?: { waitForName?: boolean }): Promise<void> {
      /* A session still delivering its last sentence owns the scopes this
         start would overwrite; and the stop resets the mode, so wait first. */
      if (stopping) await stopping
      if (mode !== undefined) setSessionMode(mode)
      if (activeMode() === "transcription") {
        cancelSpeech()
      }
      if (isRunning()) return
      /*
       * Someone is already opening it. Waiting for them is the whole fix: the
       * second press gets the session the first one is building instead of
       * building a second one on top of it.
       */
      if (startInFlight) {
        await startInFlight
        return
      }

      // A start that did not come through pressToTalk came from a button, a
      // command or the palette, and those mean "listen", not "listen while I
      // keep holding something I am not holding".
      openedWithoutChord = !chordHeld

      const generation = ++sessionGeneration

      const attempt = async (): Promise<void> => {
        try {
          if (micMeter && hasOverriddenTranscriber) {
            // Built-in transcribers already stream onLevel from their single hardware capture.
            // Only start external micMeter when transcriber is overridden (e.g. test doubles).
            try {
              micMeter.setDevice(currentSettings().inputDeviceId)
              await micMeter.start()
            } catch {
              // Level meter is visual only; do not abort voice session on meter failure
            }
          }

          engineScope = Effect.runSync(Scope.make())
          await startSession()

          /*
           * Stopped while we were loading. Everything just built is already
           * orphaned — nothing else holds a reference to these scopes — so it
           * is freed here rather than installed; the alternative is a live
           * microphone behind an interface that says the session is closed.
           */
          if (generation !== sessionGeneration) {
            await releaseSession()
            if (micMeter) micMeter.stop()
            return
          }

          setIsRunning(true)
          clearError()
          /* The model is loaded by the time the session is up. Cleared here,
             rather than when a file reports 100%, because a download is three
             or four files and the first one finishing is not the end of it. */
          setParakeetProgress(undefined)

          setListenPaused(false)
          // The agent starts now, so the first sentence does not wait for it.
          const agentSettings = currentSettings()
          if (activeMode() === "agent" && agentSettings.agentEngine !== "off") {
            host.prepareAgent?.({ engine: agentSettings.agentEngine, speed: agentSettings.agentSpeed })
          }
          const waitForName = startOptions?.waitForName === true && activeMode() === "agent"
          if (waitForName && programHandle) {
            await Effect.runPromise(programHandle.listenForName)
          } else if (dialogState().status === "asleep") {
            if (programHandle) {
              await Effect.runPromise(programHandle.wake)
            }
          } else if (programHandle && activeMode() === "agent" && currentSettings().activation === "wake-word") {
            /* Opened by hand is called: the first sentence needs no name,
               the first time as much as after a stop. */
            await Effect.runPromise(programHandle.wake)
          } else {
            setDialogState((prev) => ({ ...prev, status: "idle" }))
          }
        } catch (err: unknown) {
          const message =
            typeof err === "string"
              ? err
              : spokenMessage(err) ||
                (err && typeof err === "object" && err instanceof Error
                  ? err.message
                  : "Non sono riuscito ad aprire il microfono: riprova.")
          noteError(err, message)
          await stop()
          /* Said as well as written, when someone asked for the microphone:
             whoever is not looking would otherwise hear nothing at all. */
          if (
            !startOptions?.waitForName &&
            activeMode() !== "transcription" &&
            currentSettings().speakReplies !== false
          ) {
            void Promise.resolve(speaker.speak(message)).catch(() => {})
          }
        }
      }

      startInFlight = attempt()
      try {
        await startInFlight
      } finally {
        startInFlight = null
      }
    },

    stop,

    async pauseListening(): Promise<void> {
      if (!isRunning()) return
      await stop()
      setListenPaused(true)
    },

    async toggle(mode?: VoiceMode): Promise<void> {
      if (!isRunning()) {
        await this.start(mode)
        return
      }
      /*
       * Always listening and waiting for the name: the button and the
       * shortcut are another way of calling it, not a way of closing a
       * microphone the user did not open. Closing it is the indicator's job.
       */
      if (
        currentSettings().alwaysListen &&
        currentSettings().activation === "wake-word" &&
        (mode === undefined || mode === "agent") &&
        activeMode() === "agent" &&
        programHandle
      ) {
        // Over its voice too: it stops talking and takes the next sentence.
        cancelSpeech()
        await Effect.runPromise(programHandle.wake)
        return
      }
      /*
       * Pressing the control that is already listening closes the microphone;
       * pressing the other one takes it over. Taking it over deliberately does
       * not stop and restart: the transcriber, the meter and the Effect scope
       * are the same hardware either way, and tearing them down would cost a
       * second of dead air for a decision that only changes where the next
       * sentence goes.
       */
      if (mode === undefined || mode === activeMode()) {
        /* Closing dictation is not closing the house's microphone: once what
           was dictated has been delivered, it goes back to waiting for the
           phrase — if that is what dictation took over, and not a
           microphone the user had closed. */
        const backToListening = dictationInterruptedListening && activeMode() === "transcription"
        const s = currentSettings()
        const listenAgain = backToListening && s.alwaysListen && s.activation === "wake-word" && s.mode === "agent"
        await stop({ keepAgent: listenAgain })
        if (listenAgain) {
          await this.start("agent", { waitForName: true })
        }
        return
      }
      dictationInterruptedListening =
        mode === "transcription" && activeMode() === "agent" && currentSettings().alwaysListen
      setSessionMode(mode)
      if (mode === "transcription") {
        cancelSpeech()
      }
    },

    async submitText(text: string): Promise<void> {
      setPartialTranscript("")
      const handle = programHandle ?? (await textProgram())
      await Effect.runPromise(handle.submitText(text))
    },

    async handlePermissionRequest(paneId: string, what: string): Promise<void> {
      if (programHandle) {
        await Effect.runPromise(programHandle.handlePermissionRequest(paneId, what))
      }
    },

    async cancel(): Promise<void> {
      setPartialTranscript("")
      cancelSpeech()
      if (programHandle) {
        await Effect.runPromise(programHandle.cancel)
      }
    },

    async interrupt(): Promise<void> {
      await this.cancel()
      const s = currentSettings()
      if (isRunning() && programHandle && activeMode() === "agent" && s.alwaysListen && s.activation === "wake-word") {
        await Effect.runPromise(programHandle.wake)
      }
    },

    async pressToTalk(mode?: VoiceMode): Promise<void> {
      // Before touching the chord flags: the stop being joined resets them.
      if (stopping) await stopping

      /* A press while a tap is holding the microphone open: this is the
         "press again to close". The other feature's chord hands over instead,
         as it does everywhere else. */
      if (latched && isRunning()) {
        if (mode !== undefined && mode !== activeMode()) {
          setSessionMode(mode)
          if (mode === "transcription") cancelSpeech()
          pressEndsLatch = true
          return
        }
        pressEndsLatch = true
        await stop()
        return
      }

      clearPttTimers()
      chordHeld = true
      pressedAt = now()
      if (currentSettings().activation !== "push-to-talk" && mode === "transcription") {
        /* Taken from always-on listening, it is given back on release. */
        if (isRunning() && activeMode() === "agent" && currentSettings().alwaysListen) {
          dictationInterruptedListening = true
        }
        heldDictation = true
      }
      /* Holding the other chord hands the microphone over mid-session, the
         same way pressing the other button does. */
      if (mode !== undefined) setSessionMode(mode)
      if (activeMode() === "transcription") {
        cancelSpeech()
      }
      if (!isRunning()) {
        await this.start(mode)
      }
      /* Released as a tap while the microphone was still opening: the
         release has already made this session a latched one. */
      if (latched) return
      // The chord is now the thing holding the mic open, so a session that
      // began as a button press stops being one — releasing the key ends it.
      openedWithoutChord = false
      activeTranscriber?.startSegment?.()
      if (programHandle) {
        await Effect.runPromise(programHandle.pressToTalk)
      }
    },

    async releaseToTalk(): Promise<void> {
      chordHeld = false
      // The release of the press that closed or handed over a latched session.
      if (pressEndsLatch) {
        pressEndsLatch = false
        return
      }
      if (programHandle) {
        await Effect.runPromise(programHandle.releaseToTalk)
      }

      if (pressHolds() && !openedWithoutChord) {
        clearPttTimers()

        /*
         * A tap, not a hold: leave the microphone on until the next press.
         *
         * Push-to-talk used to treat a quick press like any other release —
         * commit, then a 12 s watchdog — so someone who pressed the chord the
         * way one presses a switch watched the widget open, listen, and close
         * itself twelve seconds later with nothing asked of them. Holding
         * still works exactly as before; only a press too short to have been
         * spoken through becomes a latch. The half-second of segment the tap
         * started is dropped, not sent: it is the sound of the key.
         */
        const held = pressedAt === undefined ? Number.POSITIVE_INFINITY : now() - pressedAt
        pressedAt = undefined
        if (held < PTT_TAP_MS && heldDictation) {
          /* A held dictation never stays open by itself: a tap is nothing said. */
          activeTranscriber?.cancelSegment?.()
          void endPress()
          return
        }
        if (held < PTT_TAP_MS) {
          latched = true
          openedWithoutChord = true
          activeTranscriber?.cancelSegment?.()
          return
        }

        const committed = activeTranscriber?.commit?.() ?? false

        // Grace period for brief taps without speech: if no segment was committed,
        // no transcription is in flight, and no command is executing, stop after grace period.
        pttGraceTimer = setTimeout(() => {
          pttGraceTimer = undefined
          if (!chordHeld && !openedWithoutChord && isRunning()) {
            const hasInFlight = activeTranscriber?.hasInFlight ?? false
            const isExecuting = dialogState().status === "executing"
            if (!committed && !hasInFlight && !isExecuting) {
              void endPress()
            }
          }
        }, 250)

        // Safety watchdog: stops the session if a network request or transcriber hangs indefinitely.
        // Will NOT interrupt active command execution.
        pttWatchdogTimer = setTimeout(() => {
          pttWatchdogTimer = undefined
          if (!chordHeld && !openedWithoutChord && isRunning()) {
            const isExecuting = dialogState().status === "executing"
            if (!isExecuting) {
              void endPress()
            }
          }
        }, 12_000)
      }
    },

    async updateSettings(next: Partial<VoiceSettings>): Promise<void> {
      const prev = currentSettings()
      const normalized = normalizeSettings({ ...prev, ...next }).settings
      /*
       * The language belongs in this list because it is baked into the
       * transcriber at construction: OpenRouter sends it in every request
       * body, and Parakeet checks the model's coverage of it before loading.
       * Left out, changing the language while listening changed the label and
       * nothing else, and only stopping and starting again applied it.
       */
      /*
       * The microphone belongs in this list for the same reason the language
       * does: `deviceId` is baked into the `MediaStream` at `getUserMedia`
       * time, so changing it while listening changed the label in the panel
       * and went on recording the old device.
       */
      const backendChanged =
        normalized.backend !== prev.backend ||
        normalized.openRouterApiKey !== prev.openRouterApiKey ||
        normalized.parakeetBackend !== prev.parakeetBackend ||
        normalized.language !== prev.language ||
        normalized.inputDeviceId !== prev.inputDeviceId

      setCurrentSettings(normalized)

      if (backendChanged) {
        if (prev.backend === "parakeet" && normalized.backend !== "parakeet") {
          void disposeParakeetModel().catch(() => {})
        } else if (normalized.backend === "parakeet" && !hasOverriddenTranscriber) {
          void warmupParakeetModel({
            executionBackend: normalized.parakeetBackend,
            language: normalized.language,
            onlyIfDownloaded: true,
          }).catch(() => {})
        }
      }

      if (isRunning() && backendChanged) {
        hasOverriddenTranscriber = false

        try {
          // Release old program and transcriber strictly through Scope before acquiring new one
          if (programScope) {
            const scope = programScope
            programScope = null
            programHandle = null
            await closeScope(scope, "programma")
          }

          if (transcriberScope) {
            const scope = transcriberScope
            transcriberScope = null
            await closeScope(scope, "trascrittore")
          }

          /*
           * The meter opens its own stream, so it has its own device to
           * change. Left alone, the ring animated off the old microphone
           * while recognition ran on the new one — two devices, one interface
           * claiming to show one.
           */
          if (micMeter && normalized.inputDeviceId !== prev.inputDeviceId) {
            micMeter.stop()
            micMeter.setDevice(normalized.inputDeviceId)
            await micMeter.start()
          }

          await startSession()
        } catch (err: unknown) {
          /*
           * A rejection here used to travel out into the settings panel's
           * change handler, which has nowhere to put it: the engine was left
           * with `isRunning()` true and no program at all — the orb lit, the
           * microphone shut, and no way back except reloading the window.
           */
          const message =
            typeof err === "string"
              ? err
              : spokenMessage(err) ||
                (err instanceof Error ? err.message : "Le nuove impostazioni vocali non sono state applicate.")
          noteError(err, message)
          await this.stop()
        }
      }
    },
  }
  startListening = (mode, o) => engine.start(mode, o)
  return engine
}
