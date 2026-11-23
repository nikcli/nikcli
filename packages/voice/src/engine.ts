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
import type { PermissionSpeechKind, VoiceHost } from "./bridge/host"
import type { DispatchOutcome } from "./bridge/dispatch"
import { createInitialDialogState, type DialogState, type DialogStatus } from "./dialog/session"
import type { ParseContext, ParseResult } from "./intent/parse"
import type { Transcriber } from "./asr/transcriber"
import type { Speaker } from "./tts/speaker"
import { playCue, type CueKind } from "./audio/cue"
import type { MicMeter } from "./audio/meter"
import { createTranscriberFor, type SelectTranscriberOptions, type TranscriberBackend } from "./asr/select"
import { CURRENT_SETTINGS_VERSION, normalizeSettings, type VoiceMode, type VoiceSettings } from "./settings/model"
import { matchesWakeWord } from "./settings/wake-word"
import { voiceStorage } from "./settings/storage"
import { createSpendTally, formatSpendCost, type DaySpend, type SpendTally } from "./settings/spend"
import { createHaltStore, type HaltStore } from "./settings/halt"
import { openRouterCreditLeft } from "./asr/openrouter"
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
import type { Completion } from "./plan/planner"
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
   * Injected by tests so the whole path runs without a model; left unset in
   * the app, where the host plans (`VoiceHost.plan`) on the agent's own runner.
   */
  plan?: Completion
  /** Overrides `DRAIN_TIMEOUT_MS`, for tests that exercise a stuck request. */
  drainTimeoutMs?: number
  /** Where a stop for spending is written down; the browser's storage by default. */
  readonly haltStore?: HaltStore
  /** How long what the key had left is believed, before asking again. */
  readonly creditCheckMs?: number
  /** How much credit is left on the key; asks OpenRouter by default. */
  readonly creditLeft?: (apiKey: string) => Promise<{ left: number } | { refused: true } | undefined>
  /** Where what listening spends is counted; the browser's storage by default. */
  readonly spendTally?: SpendTally
  /** Overrides `LOW_CREDIT_USD`, for tests. */
  readonly lowCreditUsd?: number
  /** Overrides the inactivity timeout, for tests. */
  readonly listenIdleMs?: number
  /** Overrides `LISTEN_REQUESTS_PER_HOUR`, for tests. */
  listenRequestsPerHour?: number
  /**
   * A tap on the dictation chord when it is held to speak: the tap closed it,
   * and the host says how it opens. Without this a tap was a microphone that
   * opened and closed before it could be seen — pressed, and nothing happened.
   */
  onDictationTap?: () => void
  /**
   * Where what the planning provider said goes when its call could not be
   * made — the notice strip, in the app. Takes the keys out of it first: the
   * provider quotes the key it refused, and this is not a place to write one.
   */
  onProviderError?: (detail: string) => void
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
  readonly isBusy: () => boolean
  /**
   * Whether the next sentence would be heard, not only recorded (D74).
   *
   * `isRunning` says the microphone is open, and with always-on listening it
   * always is: an orb reading it lit up while the next sentence, said without
   * the name, was about to be dropped. This is the program's own rule
   * (`nameGate`), true while the name, the button or an answer holds a
   * window, a question waits, a turn is at work or a key is held — and false
   * whenever the microphone is closed.
   */
  readonly hearing: () => boolean
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
   * Set when listening stopped by itself: past `LISTEN_REQUESTS_PER_HOUR`
   * sentences in an hour, or `LISTEN_IDLE_MS` without being called. Says why,
   * on screen, until listening starts again.
   */
  readonly listenWarning: () => string | undefined

  /** What listening has spent today: requests sent, and what they cost. */
  readonly listenSpend: () => DaySpend

  /**
   * Whether listening stopped itself and must not come back on its own.
   *
   * A pause for a locked PC ends at the unlock; a stop for spending does not,
   * or the cap and the idle timer would be a five-second interruption of the
   * same bill. Only the user starts it again.
   */
  readonly listenHalted: () => boolean
  /** Whether a tap is holding the microphone open until the next press. */
  readonly isLatched: () => boolean

  // Control methods
  /**
   * Opens the microphone. With a mode, opens it for that mode only.
   *
   * Opening it means "I am talking to you", so the first sentence needs no
   * name — unless `waitForName`, which is how ADE opens it by itself.
   */
  start(
    mode?: VoiceMode,
    options?: {
      waitForName?: boolean
      /**
       * Not the user: the guard bringing listening back, or ADE opening it at
       * launch. A start like that does not lift a stop for spending — only a
       * hand on the button or the shortcut does.
       */
      automatic?: boolean
    },
  ): Promise<void>
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
  handlePermissionRequest(
    paneId: string,
    what: string,
    options?: { silent?: boolean; kind?: PermissionSpeechKind },
  ): Promise<void>
  /** A request closed outside the voice: its question is no longer asked, and no yes can reach the next one. */
  handlePermissionResolved(paneId: string): Promise<void>
  /**
   * Asks for a spoken yes before a voice-agent `send` is delivered (rilievo
   * 20). Returns false when no program is running, so the host can refuse
   * rather than deliver unattended.
   */
  /** `lead` says who wants to do what («La voce vuole chiedere a»); a note sent by the voice when absent. */
  requestSendConfirmation(id: string, to: string, text: string, lead?: string): Promise<boolean>
  openResponseWindow(options?: {
    durationMs?: number
    rescheduleMs?: number
    permission?: { paneId: string; what: string; kind?: PermissionSpeechKind }
  }): Promise<void>
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
 * before it stops. Silence costs nothing — the capture only sends speech —
 * so this is a room that talks a lot: a television, a call. Each one is paid
 * for (about $0.000056 at the measured price), and the room is not talking to
 * the assistant: past the cap listening stops and says so, and the button
 * starts it again.
 */
export const LISTEN_REQUESTS_PER_HOUR = 120
const HOUR_MS = 60 * 60_000

/**
 * How long listening waits, unused, before it stops by itself.
 *
 * An open microphone nobody has called costs money in a room with voices in
 * it and keeps a microphone open in a room without. Half an hour with nobody
 * saying the name is a room that forgot it was listening.
 */
export const LISTEN_IDLE_MS = 30 * 60_000
export const MANUAL_LISTEN_IDLE_MS = 30_000

/**
 * Below this much credit left, in dollars, the user is told before the voice
 * starts spending it. At the measured price it is some tens of thousands of
 * sentences, or a few days of a room with a television in it: enough warning
 * to top up before the voice stops mid-sentence.
 */
export const LOW_CREDIT_USD = 2

/**
 * How long what the key had left is believed.
 *
 * Asking at every opening of the microphone is a request to OpenRouter for
 * every sentence a push-to-talk user says. The number moves slowly, and the
 * failures that matter — a key refused, credit gone — arrive as errors on the
 * transcription itself, which asks again.
 */
export const CREDIT_CHECK_MS = 60 * 60_000

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

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * Writes the clipboard through the desktop host, once. False where there is no
 * host (the browser build, the tests): the text is then not in the clipboard,
 * and nothing says it is. The webview's own clipboard API is not used:
 * it was the second of two writes of every sentence (verdict of area 3, A4).
 */
export function writeClipboard(
  text: string,
  win: unknown = typeof window !== "undefined" ? window : undefined,
): boolean {
  const tauri = win as
    | { __TAURI_INTERNALS__?: { invoke?: TauriInvoke }; __TAURI__?: { core?: { invoke?: TauriInvoke } } }
    | undefined
  const invoke = tauri?.__TAURI_INTERNALS__?.invoke ?? tauri?.__TAURI__?.core?.invoke
  if (!invoke) return false
  void invoke("write_clipboard", { text }).catch(() => {})
  return true
}

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
  const [hearing, setHearing] = createSignal<boolean>(false)
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
  /* A stop for spending outlives the app: see `settings/halt.ts`. */
  const halts = options.haltStore ?? createHaltStore(voiceStorage())
  const stored = halts.read()
  /* Said again on the next launch: the microphone is shut and this is why. */
  const [listenWarning, setListenWarning] = createSignal<string | undefined>(stored?.reason)
  const [listenHalted, setListenHalted] = createSignal(stored !== undefined)
  /*
   * What listening has cost today, kept where the settings are so it is still
   * there tomorrow morning — and so the user sees it before the bill does.
   */
  const spendTally = options.spendTally ?? createSpendTally(voiceStorage(), now())
  const [listenSpend, setListenSpend] = createSignal<DaySpend>(spendTally.today(now()))

  const record = (entry: AgentEntry) => setHistory((log) => appendEntry(log, entry))

  let engineScope: Scope.CloseableScope | null = null
  let transcriberScope: Scope.CloseableScope | null = null
  let programScope: Scope.CloseableScope | null = null
  let programHandle: VoiceProgramHandle | null = null

  /*
   * `hearing`, read again from the program.
   *
   * Every write of the gate raises a callback (`onNameGate`, or the state,
   * cue, follow-up and outcome ones); only a window running out does not, so
   * that one gets a single timer at its end. No polling.
   */
  let hearingTimer: ReturnType<typeof setTimeout> | undefined
  const refreshHearing = (): void => {
    if (hearingTimer !== undefined) clearTimeout(hearingTimer)
    hearingTimer = undefined
    const gate = isRunning() && programHandle ? programHandle.nameGate() : undefined
    setHearing(gate?.open === true)
    if (gate?.open && gate.until !== undefined) {
      hearingTimer = setTimeout(refreshHearing, Math.max(0, gate.until - now()) + 1)
    }
  }
  let activeTranscriber: Transcriber | null = null
  let hasOverriddenTranscriber = Boolean(options.transcriber)

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

  let sessionGeneration = 0
  let responseWindowToken = 0
  const takeSessionMode = (mode: VoiceMode): void => {
    if (mode !== activeMode()) {
      responseWindowToken++
      setFollowUp(undefined)
    }
    setSessionMode(mode)
  }
  let lifecycleTail: Promise<void> | null = null
  let startInFlight: Promise<void> | null = null
  let restartInFlight: Promise<void> | null = null

  const trackLifecycle = (result: Promise<unknown>): Promise<void> => {
    const tracked = result.then(
      () => undefined,
      () => undefined,
    )
    lifecycleTail = tracked
    void tracked.finally(() => {
      if (lifecycleTail === tracked) lifecycleTail = null
    })
    return tracked
  }

  const enqueueLifecycle = <T>(operation: (generation: number) => Promise<T>): Promise<T> => {
    const generation = ++sessionGeneration
    const previous = lifecycleTail
    const result = previous ? previous.then(() => operation(generation)) : operation(generation)
    trackLifecycle(result)
    return result
  }

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

  const discardSession = async (): Promise<void> => {
    await releaseSession()
    if (micMeter) micMeter.stop()
    setIsRunning(false)
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
  const isBusy = (): boolean => isRunning() || startInFlight !== null || restartInFlight !== null || stopping !== null

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
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Stops listening and says why; only the user starts it again.
   *
   * `listenHalted` is what keeps it stopped: the guard that brings listening
   * back after a locked PC would otherwise resume within five seconds, and
   * the cap on spending would stop nothing at all.
   */
  function stopListening(text: string): void {
    setListenWarning(text)
    record({ kind: "error", text, at: now() })
    setListenHalted(true)
    halts.write({ reason: text, at: now() })
    void (async () => {
      if (!isRunning()) return
      await stop()
      setListenPaused(true)
    })()
  }

  /*
   * Nobody has called it for a while: listening stops rather than waiting on
   * a microphone that costs money to hold open. Restarted by every sentence
   * that reaches the assistant, and by every start of listening.
   */
  function keepListeningAwake(): void {
    clearTimeout(idleTimer)
    idleTimer = undefined
    const alwaysListen = currentSettings().alwaysListen
    const after = options.listenIdleMs ?? (alwaysListen ? LISTEN_IDLE_MS : MANUAL_LISTEN_IDLE_MS)
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (!isRunning() || chordHeld) return
      const current = currentSettings()
      if (current.alwaysListen !== alwaysListen) return
      const busy =
        activeTranscriber?.hasInFlight === true ||
        dialogState().status === "executing" ||
        dialogState().status === "confirming" ||
        dialogState().status === "dictating"
      if (!current.alwaysListen && busy) {
        keepListeningAwake()
        return
      }
      const seconds = Math.max(1, Math.round(after / 1000))
      const idle =
        after < 60_000 ? `${seconds} ${seconds === 1 ? "secondo" : "secondi"}` : `${Math.round(after / 60_000)} minuti`
      stopListening(
        current.alwaysListen
          ? `Non ti sento da ${idle}, quindi ho smesso di ascoltare: tenere il microfono aperto costa. Premi «In ascolto» in alto per riprendere.`
          : `Non ho sentito una frase per ${idle}, quindi ho spento il microfono. Aprilo per riprovare.`,
      )
    }, after)
  }

  /* Requests counted while waiting for the name, whose cost has not come back yet. */
  let listenCostsDue = 0

  /*
   * What is left on the key, said once per start of the microphone.
   *
   * A key that is refused, or nearly spent, used to show up as a sentence
   * that got no answer: the user heard nothing and had to go and look at
   * their OpenRouter page to find out why.
   */
  let creditAskedAt: number | undefined
  let creditAskedFor: string | undefined

  async function warnAboutCredit(s: VoiceSettings): Promise<void> {
    const key = s.openRouterApiKey
    if (s.backend !== "openrouter" || !key) return
    const since = creditAskedAt === undefined ? Number.POSITIVE_INFINITY : now() - creditAskedAt
    if (creditAskedFor === key && since < (options.creditCheckMs ?? CREDIT_CHECK_MS)) return
    creditAskedAt = now()
    creditAskedFor = key
    const credit = await (options.creditLeft ?? ((apiKey: string) => openRouterCreditLeft(apiKey)))(key)
    if (!credit) return
    if ("refused" in credit) {
      setListenWarning(
        "La chiave OpenRouter non viene accettata: la voce non può trascrivere niente finché non la sistemi nelle impostazioni della voce.",
      )
      return
    }
    if (credit.left > (options.lowCreditUsd ?? LOW_CREDIT_USD)) return
    setListenWarning(
      credit.left <= 0
        ? "Il credito OpenRouter è finito: finché non lo ricarichi la voce non trascrive più niente."
        : // The sentence is Italian, so the sum in it is written the Italian way.
          // Without the locale the machine's own decided: «1,21 USD» here and
          // «$1.21» on CI, which is what turned this test red there and not here.
          `Sul credito OpenRouter restano ${formatSpendCost(credit.left, "it-IT")}: ricaricalo prima che la voce si fermi a metà frase.`,
    )
  }

  function countListenRequest(): void {
    const at = now()
    listenCostsDue++
    setListenSpend(spendTally.add(at, undefined))
    listenRequests = [...listenRequests.filter((t) => at - t < HOUR_MS), at]
    const cap = options.listenRequestsPerHour ?? LISTEN_REQUESTS_PER_HOUR
    if (listenRequests.length <= cap) return
    listenRequests = []
    stopListening(
      `Nell'ultima ora l'ascolto ha mandato al servizio di trascrizione più di ${cap} frasi, e ognuna si paga: c'è molto parlato intorno, per esempio la televisione. Ho smesso di ascoltare; premi «In ascolto» in alto per riprendere.`,
    )
  }

  /*
   * `keepAgent`: the microphone is about to reopen for the name (the end of a
   * dictation that took it over), so the agent kept ready stays. Released and
   * prepared again, it would start its process over for nothing.
   */
  const stop = (options?: { keepAgent?: boolean; drain?: boolean; releaseText?: boolean }): Promise<void> => {
    sessionGeneration++
    startInFlight = null
    restartInFlight = null
    setIsRunning(false)
    if (stopping) {
      if (options?.releaseText !== true) return stopping
      return Promise.all([stopping, releaseTextProgram()]).then(() => undefined)
    }
    const cleanup = enqueueLifecycle(async () => {
      await stopNow(options?.keepAgent === true, options?.drain !== false)
      if (options?.releaseText === true) await releaseTextProgram()
    })
    stopping = cleanup
    void cleanup.finally(() => {
      if (stopping === cleanup) stopping = null
    })
    return cleanup
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
      // Not a new start by hand: a stop that arrived meanwhile still holds.
      await startListening("agent", { waitForName: true, automatic: true })
    }
  }
  let startListening: (
    mode: VoiceMode,
    o: { waitForName: boolean; automatic?: boolean },
  ) => Promise<void> = async () => {}

  const stopNow = async (keepAgent = false, drain = true): Promise<void> => {
    clearPttTimers()
    setListenPaused(false)
    dictationInterruptedListening = false
    heldDictation = false

    setIsRunning(false)
    refreshHearing()
    setFollowUp(undefined)
    clearTimeout(idleTimer)
    if (!keepAgent) host.releaseAgent?.()

    /* Drained before the mode is forgotten: a dictated sentence read after
       `setSessionMode(undefined)` would be parsed as a command. */
    if (drain) await drainSession()

    setPartialTranscript("")
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
   * It is the host's, on the same runner and subscription as the agent: no key, no
   * per-call bill. Nothing is a working configuration: with the agent off, or a host
   * that cannot plan, an unmatched sentence gets what it always got, and the rest of
   * the voice stack keeps working. An injected `plan` wins, so tests never reach a model.
   */
  function resolvePlanner(): Completion | undefined {
    if (options.plan) return options.plan
    const plan = host.plan
    const settings = currentSettings()
    if (!plan || settings.agentEngine === "off") return undefined
    const { agentEngine: engine, agentSpeed: speed } = settings
    return (request) => plan.call(host, { ...request, engine, ...(speed ? { speed } : {}) })
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
        /*
         * What each request cost, as the service reports it, put against the
         * requests listening sent: they are answered one at a time, so the
         * cost that comes back belongs to the oldest one still owed.
         */
        onUsage: (usage: { cost?: number }, context: { gated: boolean } = { gated: false }) => {
          options.backendOptions?.openRouterOptions?.onUsage?.(usage, context)
          // A dictation is not listening: it costs the user what they asked for.
          if (!context.gated) return
          if (listenCostsDue <= 0 || typeof usage?.cost !== "number" || usage.cost <= 0) return
          listenCostsDue--
          setListenSpend(spendTally.addCost(now(), usage.cost))
        },
        nameGate: {
          active: (spokenAt: number) => programHandle?.waitingForName(spokenAt) ?? false,
          accepts: (text: string) => matchesWakeWord(text, currentSettings().wakeWord).matched,
          onRequest: countListenRequest,
          onAccepted: () => {
            keepListeningAwake()
            cancelSpeech()
          },
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
          /* A key that is refused or spent answers nothing, and listening
             would go on opening the microphone and asking for the rest of
             the day. It stops, and says so, until the user has seen it. */
          const tag = (err as { _tag?: string })?._tag
          if (tag === "ApiKeyInvalid" || tag === "QuotaExhausted") {
            // What it had left is no longer what it has: ask again next time.
            creditAskedAt = undefined
            stopListening(msg)
          }
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
    onStateChange: (state) => {
      setDialogState(state)
      refreshHearing()
    },
    onNameGate: () => refreshHearing(),
    onPartialTranscript: (text) => setPartialTranscript(text),
    onProviderError: options.onProviderError,
    onSpeaking: (text) => {
      if (activeMode() !== "transcription") setLastSpoken(text)
    },
    onFollowUp: (until) => {
      setFollowUp(until)
      refreshHearing()
    },
    onCue: (kind) => {
      refreshHearing()
      if (activeMode() !== "transcription") (options.cue ?? playCue)(kind)
    },
    onSpoken: (text) => {
      if (activeMode() === "transcription") return
      setLastSpoken(text)
      record({ kind: "assistant", text, at: now() })
    },
    onOutcome: (outcome) => {
      setLastOutcome(outcome)
      refreshHearing()
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
    /*
     * A dictation that did not reach a pane goes to the clipboard, once,
     * through the host (verdict of area 3, A4). It used to be written on
     * every sentence, twice (the host's and the webview's), whatever
     * happened, and the user's own copy was lost to each one.
     */
    onUndelivered: (text) => writeClipboard(text),
    onHeld: (text) => setHeld(text),
    onTranscribed: (text) => {
      setDictated((previous) => [...previous, text].slice(-DICTATION_MEMORY))
      record({ kind: "user", text, at: now() })
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
    resolvePlan: resolvePlanner,
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

  const startNow = async (
    mode: VoiceMode | undefined,
    startOptions: { waitForName?: boolean; automatic?: boolean } | undefined,
    generation: number,
  ): Promise<void> => {
    if (generation !== sessionGeneration) return
    if (mode !== undefined) setSessionMode(mode)
    if (activeMode() === "transcription") cancelSpeech()
    if (isRunning()) return
    if (startOptions?.automatic === true) {
      if (listenHalted()) return
    } else {
      setListenHalted(false)
      halts.clear()
      setListenWarning(undefined)
    }

    openedWithoutChord = !chordHeld

    try {
      if (micMeter && hasOverriddenTranscriber) {
        try {
          micMeter.setDevice(currentSettings().inputDeviceId)
          await micMeter.start()
        } catch {
          setMicLevel(0)
        }
      }
      if (generation !== sessionGeneration) {
        if (micMeter) micMeter.stop()
        return
      }

      engineScope = Effect.runSync(Scope.make())
      await startSession()
      if (generation !== sessionGeneration) {
        await discardSession()
        return
      }

      setIsRunning(true)
      clearError()
      setListenPaused(false)
      keepListeningAwake()
      void warnAboutCredit(currentSettings())
      const agentSettings = currentSettings()
      if (activeMode() === "agent" && agentSettings.agentEngine !== "off") {
        host.prepareAgent?.({ engine: agentSettings.agentEngine, speed: agentSettings.agentSpeed })
      }

      const waitForName = startOptions?.waitForName === true && activeMode() === "agent"
      if (waitForName && programHandle) {
        await Effect.runPromise(programHandle.listenForName)
      } else if (dialogState().status === "asleep") {
        if (programHandle) await Effect.runPromise(programHandle.wake)
      } else if (programHandle && activeMode() === "agent" && currentSettings().activation === "wake-word") {
        await Effect.runPromise(programHandle.wake)
      } else {
        setDialogState((prev) => ({ ...prev, status: "idle" }))
      }
      if (generation !== sessionGeneration) {
        await discardSession()
        return
      }
      refreshHearing()
    } catch (err: unknown) {
      await discardSession()
      if (generation !== sessionGeneration) return
      const message =
        typeof err === "string"
          ? err
          : spokenMessage(err) ||
            (err && typeof err === "object" && err instanceof Error
              ? err.message
              : "Non sono riuscito ad aprire il microfono: riprova.")
      noteError(err, message)
      await stopNow()
      if (!startOptions?.waitForName && activeMode() !== "transcription" && currentSettings().speakReplies !== false) {
        void Promise.resolve(speaker.speak(message)).catch(() => {})
      }
    }
  }

  const restartNow = async (normalized: VoiceSettings, previous: VoiceSettings, generation: number): Promise<void> => {
    if (generation !== sessionGeneration) {
      await discardSession()
      return
    }
    setIsRunning(false)
    refreshHearing()
    await releaseTextProgram()
    if (generation !== sessionGeneration) {
      await discardSession()
      return
    }
    hasOverriddenTranscriber = false

    try {
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
      if (generation !== sessionGeneration) {
        await discardSession()
        return
      }

      if (micMeter && normalized.inputDeviceId !== previous.inputDeviceId) {
        micMeter.stop()
        micMeter.setDevice(normalized.inputDeviceId)
        await micMeter.start()
        if (generation !== sessionGeneration) {
          await discardSession()
          return
        }
      }

      await startSession()
      if (generation !== sessionGeneration) {
        await discardSession()
        return
      }

      setIsRunning(true)
      clearError()
      setListenPaused(false)
      keepListeningAwake()
      void warnAboutCredit(currentSettings())
      refreshHearing()
    } catch (err: unknown) {
      await discardSession()
      if (generation !== sessionGeneration) return
      const message =
        typeof err === "string"
          ? err
          : spokenMessage(err) ||
            (err && typeof err === "object" && err instanceof Error
              ? err.message
              : "Le nuove impostazioni vocali non sono state applicate.")
      noteError(err, message)
      await stopNow()
    }
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
    isBusy,
    hearing,
    settings: currentSettings,
    activeMode,
    dictated,
    history,
    held,
    listenPaused,
    listenWarning,
    listenSpend,
    listenHalted,
    isLatched: () => latched,
    followUp,

    async start(mode?: VoiceMode, startOptions?: { waitForName?: boolean; automatic?: boolean }): Promise<void> {
      if (startInFlight) return startInFlight
      const result = enqueueLifecycle((generation) => startNow(mode, startOptions, generation))
      startInFlight = result
      try {
        await result
      } finally {
        if (startInFlight === result) startInFlight = null
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
        if (mode !== undefined && startInFlight !== null) {
          dictationInterruptedListening =
            mode === "transcription" && activeMode() === "agent" && currentSettings().alwaysListen
          takeSessionMode(mode)
        }
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
          await this.start("agent", { waitForName: true, automatic: true })
        }
        return
      }
      dictationInterruptedListening =
        mode === "transcription" && activeMode() === "agent" && currentSettings().alwaysListen
      takeSessionMode(mode)
      if (mode === "transcription") {
        cancelSpeech()
      }
    },

    async submitText(text: string): Promise<void> {
      setPartialTranscript("")
      const handle = programHandle ?? (await textProgram())
      await Effect.runPromise(handle.submitText(text))
    },

    async handlePermissionRequest(
      paneId: string,
      what: string,
      options?: { silent?: boolean; kind?: PermissionSpeechKind },
    ): Promise<void> {
      if (programHandle) {
        await Effect.runPromise(programHandle.handlePermissionRequest(paneId, what, options))
      }
    },

    async handlePermissionResolved(paneId: string): Promise<void> {
      if (programHandle) {
        await Effect.runPromise(programHandle.resolvePermission(paneId))
      }
    },

    async requestSendConfirmation(id: string, to: string, text: string, lead?: string): Promise<boolean> {
      if (!programHandle) return false
      await Effect.runPromise(programHandle.requestSendConfirmation(id, to, text, lead))
      return true
    },

    async openResponseWindow(options?: {
      durationMs?: number
      rescheduleMs?: number
      permission?: { paneId: string; what: string; kind?: PermissionSpeechKind }
    }): Promise<void> {
      if (isBusy()) return
      const durationMs = options?.durationMs ?? 8_000
      const rescheduleMs = options?.rescheduleMs ?? 1_000
      const generationBeforeStart = sessionGeneration
      const token = responseWindowToken
      const start = this.start("agent", { waitForName: false, automatic: true })
      const generation = sessionGeneration
      if (generation === generationBeforeStart) return
      await start
      if (generation !== sessionGeneration || token !== responseWindowToken || !isRunning()) return
      const until = now() + durationMs
      setFollowUp(until)
      if (options?.permission && programHandle) {
        await Effect.runPromise(
          programHandle.handlePermissionRequest(options.permission.paneId, options.permission.what, {
            silent: true,
            kind: options.permission.kind,
          }),
        )
      }
      const checkAndClose = () => {
        if (generation !== sessionGeneration || token !== responseWindowToken || !isRunning()) return
        const status = dialogState().status
        if (status === "executing" || status === "dictating") {
          setTimeout(checkAndClose, rescheduleMs)
          return
        }
        setFollowUp(undefined)
        const s = currentSettings()
        const keepAlwaysListening = s.alwaysListen && s.activation === "wake-word" && activeMode() === "agent"
        if (keepAlwaysListening && programHandle) {
          void Effect.runPromise(programHandle.listenForName)
        } else {
          void stop()
        }
      }
      setTimeout(checkAndClose, durationMs)
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
          takeSessionMode(mode)
          if (mode === "transcription") cancelSpeech()
          pressEndsLatch = true
          return
        }
        pressEndsLatch = true
        // A dictation switched on over always-on listening gives the microphone back to it.
        if (heldDictation) await endPress()
        else await stop()
        return
      }

      clearPttTimers()
      chordHeld = true
      pressedAt = now()
      if (currentSettings().activation !== "push-to-talk" && mode === "transcription") {
        /* Taken from always-on listening, it is given back on release. */
        if ((isRunning() || startInFlight !== null) && activeMode() === "agent" && currentSettings().alwaysListen) {
          dictationInterruptedListening = true
        }
        heldDictation = true
      }
      /* Holding the other chord hands the microphone over mid-session, the
         same way pressing the other button does. */
      if (mode !== undefined) takeSessionMode(mode)
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
      if (isRunning()) keepListeningAwake()

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
          activeTranscriber?.cancelSegment?.()
          /* As a switch, the tap opens it until the next one. */
          if (currentSettings().dictationPress === "toggle") {
            latched = true
            openedWithoutChord = true
            return
          }
          /* Held to speak, it never stays open by itself: a tap is nothing said,
             and the host says so rather than leave the press looking dead. */
          void endPress()
          options.onDictationTap?.()
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
       * body. Left out, changing the language while listening changed the label and
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
        normalized.language !== prev.language ||
        normalized.inputDeviceId !== prev.inputDeviceId

      /*
       * Turning listening on is the user's hand on the switch, and the only
       * place a stop for spending can be undone from the settings: without
       * this the switch moved and nothing opened, which reads as broken.
       */
      if (normalized.alwaysListen && !prev.alwaysListen) {
        setListenHalted(false)
        halts.clear()
        setListenWarning(undefined)
      }

      setCurrentSettings(normalized)
      // Mode and activation are half of the name gate.
      refreshHearing()

      const keyChanged = normalized.openRouterApiKey !== prev.openRouterApiKey
      const keyRemoved = keyChanged && !normalized.openRouterApiKey
      const sessionPending = isRunning() || startInFlight !== null || restartInFlight !== null
      if (keyRemoved) {
        await stop({ drain: false, releaseText: true })
        return
      }
      if (keyChanged || (sessionPending && backendChanged)) {
        const result = enqueueLifecycle(async (generation) => {
          if (generation !== sessionGeneration) return
          if (sessionPending && backendChanged) {
            await restartNow(normalized, prev, generation)
            return
          }
          await releaseTextProgram()
        })
        restartInFlight = result
        void result.finally(() => {
          if (restartInFlight === result) restartInFlight = null
        })
        await result
        return
      }
      if (isRunning()) keepListeningAwake()
    },
  }
  startListening = (mode, o) => engine.start(mode, o)
  return engine
}
