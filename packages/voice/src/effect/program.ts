/**
 * Effect-TS dialogue orchestration program.
 *
 * Implements the main voice cycle:
 * final transcription event -> parseUtterance (pure) -> transition (pure) ->
 * dispatch onto VoiceHost (Effect, can fail with HostActionFailed) -> Speaker.speak (Effect)
 *
 * Core guarantees:
 * - Pure functions (normalize, parse, session/transition) remain 100% pure and called directly.
 * - Dialogue timeouts use the Effect Clock / TestClock for deterministic, instant time travel in tests.
 * - Hardware, network, and host errors NEVER break the listening loop: every failure is caught,
 *   translated via `spokenMessage`, spoken to the user, and listening continues.
 */

import { markVoice } from "../timing"
import { Clock, Duration, Effect, Fiber, Scope, Stream } from "effect"

import type { VoiceHost } from "../bridge/host"
import { dispatch, type DispatchOutcome } from "../bridge/dispatch"
import {
  createInitialDialogState,
  transition,
  type DialogEffect,
  type DialogEvent,
  type DialogState,
  type DialogStatus,
} from "../dialog/session"
import { parseUtterance, type CandidateMatch, type ParseContext, type ParseResult } from "../intent/parse"
import { correctCustomWords } from "../asr/custom-words"
import { VOCABULARY } from "../intent/vocabulary"
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "../settings/model"
import { matchesWakeWord } from "../settings/wake-word"
import { replySpeech } from "../tts/reply"
import type { CueKind } from "../audio/cue"
import { announceExecution, executePlan, type PlanExecution } from "../plan/execute"
import { planUtterance, type Completion } from "../plan/planner"
import { firstWords, isSendHeld, triageWhileThinking } from "../dialog/while-thinking"
import { PLANNABLE_COMMANDS, type PlanStep } from "../plan/schema"

import { HostActionFailed, spokenMessage, type VoiceError } from "./errors"
import { Speaker, Transcriber, VoiceHostService, type SpeakerService, type TranscriberService } from "./services"

/** Intents whose result is information to hear, not an action to see. */
const SPOKEN_RESULTS = new Set(["pane.list", "state.describe", "help.list", "project.search"])

/**
 * Dispatches a transcribed utterance directly to the target pane composer or agent prompt,
 * completely bypassing intent parsing and command execution.
 */
export function dispatchTranscription(
  text: string,
  host: VoiceHost,
  sendMode: "manual" | "auto",
  focusedPaneId?: string,
): Effect.Effect<void, HostActionFailed> {
  return Effect.tryPromise({
    try: async () => {
      const panes = host.listPanes()
      const targetPane = focusedPaneId ? (panes.find((p) => p.id === focusedPaneId)?.id ?? panes[0]?.id) : panes[0]?.id

      /*
       * Said, not skipped. With no pane open this used to return quietly: the
       * request was paid for, the text went to the clipboard, and nothing on
       * screen said so — dictation looked broken to someone who had simply
       * not opened a session yet.
       */
      if (!targetPane) {
        throw new Error("Nessun pannello aperto: il testo dettato è negli appunti.")
      }

      if (sendMode === "auto") {
        await host.sendPrompt(targetPane, text)
      } else {
        await host.insertText(targetPane, text)
      }
    },
    catch: (err) =>
      new HostActionFailed({
        action: sendMode === "auto" ? "sendPrompt" : "insertText",
        cause: err,
        // The host's own sentence when it has one: "the pane has no process
        // listening" tells the user what to do, a generic failure does not.
        message:
          err instanceof Error && err.message
            ? err.message
            : "Errore durante l'inserimento del testo trascritto nel pannello.",
      }),
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkDisambiguationChoice(text: string): number | null {
  const t = text.trim().toLowerCase()
  if (
    t === "la prima" ||
    t === "il primo" ||
    t === "prima" ||
    t === "primo" ||
    t === "1" ||
    t === "uno" ||
    t === "opzione 1" ||
    t === "opzione uno"
  ) {
    return 0
  }
  if (
    t === "la seconda" ||
    t === "il secondo" ||
    t === "seconda" ||
    t === "secondo" ||
    t === "2" ||
    t === "due" ||
    t === "opzione 2" ||
    t === "opzione due"
  ) {
    return 1
  }
  return null
}

// ---------------------------------------------------------------------------
// Program Options & Handle
// ---------------------------------------------------------------------------

export interface VoiceProgramOptions {
  /** Initial dialog status (default: 'idle'). */
  initialStatus?: DialogStatus
  /** Optional custom time provider. If omitted, uses Effect Clock.currentTimeMillis. */
  now?: () => number
  /** Dynamic context provider supplying focused pane or custom context. */
  getContext?: () => Partial<ParseContext>
  /** Dynamic settings provider returning active VoiceSettings. */
  getSettings?: () => VoiceSettings
  /** External push-to-talk query provider. */
  isPushToTalkActive?: () => boolean
  /** Notification hook fired when dialogue state changes. */
  onStateChange?: (state: DialogState) => void
  /** Notification hook fired on partial transcript stream update. */
  onPartialTranscript?: (text: string) => void
  /** Notification hook fired when speech is synthesized. */
  onSpoken?: (text: string) => void
  /**
   * What is being said so far of a reply read in pieces, for the widget.
   * `onSpoken` still comes once, with the whole reply, when it is complete.
   */
  onSpeaking?: (text: string) => void
  /** A short sound: see `audio/cue.ts`. */
  onCue?: (kind: CueKind) => void
  /** Until when a sentence needs no name after an answer, or undefined once that is over. */
  onFollowUp?: (until: number | undefined) => void
  /** Notification hook fired when an ADE action finishes dispatching. */
  onOutcome?: (outcome: DispatchOutcome) => void
  /** Notification hook fired when an error occurs. */
  onError?: (error: string) => void
  /** Notification hook fired with each parsed utterance result. */
  onParseResult?: (result: ParseResult) => void
  /**
   * Fired with the command the user actually gave, wake word already removed.
   *
   * Distinct from `onPartialTranscript`, which streams and then clears: this
   * fires once, with the final text, and is what the agent console records as
   * the user's half of the conversation.
   */
  onUtterance?: (text: string) => void
  /**
   * Fired with each finished sentence in transcription mode.
   *
   * Dictation used to leave no trace anywhere the interface could see. It does
   * not go through the dialogue machine — text on its way into a pane is not a
   * turn of conversation — so the widget's "what I have heard so far" line,
   * which reads the machine's dictation buffer, stayed empty for the whole
   * session; and the cloud backend emits no partials at all, so the other
   * source was empty too. The result was a pill that said "sto ascoltando…"
   * forever while the words were already landing in the pane. This is the
   * missing channel: one call per sentence, with the text as sent.
   */
  onTranscribed?: (text: string) => void
  /**
   * Nothing heard is still being handled: the last sentence has been dealt
   * with, whatever the outcome, and whatever it said has been said — the
   * reply read from a session included. Where a microphone opened for one
   * turn is closed; closing it earlier cuts the voice off.
   */
  onTurnEnd?: () => void
  /**
   * The language model that plans what the grammar could not match.
   *
   * Optional, and its absence is a working configuration: without it an
   * unmatched sentence gets the same "non ho capito" it always did. With it,
   * "avvia quattro sessioni claude, una sul parser e una sui test" becomes a
   * plan — which no list of phrases can do, because the count, the agent, the
   * project and a free-text task per session are four open dimensions at once.
   *
   * Injected rather than built here so the whole path is testable without a
   * network, and so the key stays in the layer that owns it.
   */
  plan?: Completion
  /**
   * The sentence heard while the assistant was thinking and set aside, or
   * `null` once it is sent or dropped. The console offers it with a button
   * that submits «invia questa».
   */
  onHeld?: (text: string | null) => void
  /** Fired with the plan that ran, for the transcript and for tests. */
  onPlan?: (result: { steps: PlanStep[]; execution: PlanExecution }) => void
  /** Provider returning recent conversation history entries for multi-turn reasoning. */
  getHistory?: () => readonly { kind: string; text?: string; label?: string }[]
}

export interface VoiceProgramHandle {
  readonly submitText: (text: string) => Effect.Effect<void>
  readonly handlePermissionRequest: (paneId: string, what: string) => Effect.Effect<void>
  readonly cancel: Effect.Effect<void>
  readonly wake: Effect.Effect<void>
  /** Listening, silently, for a sentence that calls it: what an open microphone nobody pressed means. */
  readonly listenForName: Effect.Effect<void>
  readonly sleep: Effect.Effect<void>
  readonly getDialogState: Effect.Effect<DialogState>
  readonly pressToTalk: Effect.Effect<void>
  readonly releaseToTalk: Effect.Effect<void>
  /**
   * True when no transcriber event is waiting and none is being handled.
   *
   * A dictated sentence is only delivered once the loop has put it in the
   * pane, which is an await or two after the transcriber reported it; closing
   * the scope in between drops it just as surely as closing it before the
   * request came back.
   */
  readonly isIdle: Effect.Effect<boolean>
  /**
   * Whether the next sentence is ignored unless it calls the assistant.
   *
   * False while it is awake (for `WAKE_WINDOW_MS` after the name or the
   * button, judged at `spokenAt`), waiting for an answer, or held by a key:
   * those sentences are meant for it without the name, so the transcriber
   * sends them whole. A turn at work does not count: see `waitingForName`.
   */
  readonly waitingForName: (spokenAt?: number) => boolean
}

export type ExternalCommand =
  | { readonly _tag: "submitText"; readonly text: string }
  | { readonly _tag: "permission"; readonly paneId: string; readonly what: string }
  | { readonly _tag: "cancel" }
  | { readonly _tag: "wake" }
  | { readonly _tag: "sleep" }
  | { readonly _tag: "pressToTalk" }
  | { readonly _tag: "releaseToTalk" }

// ---------------------------------------------------------------------------
// Program Constructor
// ---------------------------------------------------------------------------

/** How long the name said on its own, or the button, keeps the assistant listening without it. */
export const WAKE_WINDOW_MS = 10_000

/**
 * How long, after the assistant has finished speaking, the next sentence is
 * taken without the name: a conversation, not a series of calls. Only what
 * starts inside it goes whole to the cloud; outside it the 1.5 s name check
 * applies as before.
 */
export const FOLLOW_UP_MS = 8_000

/**
 * Creates and forks the resilient voice interaction loop inside the environment's Scope.
 * Returns a handle allowing external events (text submission, permissions, cancellations).
 */
/** How long an agent may work before a sound says the request was taken. */
export const AGENT_CUE_MS = 1_500

/**
 * Where the finished sentences of a reply still being written end.
 *
 * A sentence is finished when its stop is followed by a space, so "3.5" and a
 * stop that may still become "..." are not; a blank line ends one too.
 */
export function finishedUpTo(text: string): number {
  let end = 0
  for (const match of text.matchAll(/[.!?;…]["»”’')\]]*(?=\s)|\n\s*\n/g)) {
    end = (match.index ?? 0) + match[0].length
  }
  return end
}

/** The shortest opening clause worth saying on its own; see `firstPieceUpTo`. */
export const FIRST_PIECE_MIN_LENGTH = 24

/**
 * Where the first piece of a reply ends: its first sentence, or, while that
 * is still being written, its first clause of some length.
 *
 * Only the first piece: the user is waiting in silence for it, and a clause
 * is said half a second sooner than a sentence. Later pieces are cut at
 * sentences, which sound better.
 */
export function firstPieceUpTo(text: string): number {
  const end = finishedUpTo(text)
  if (end > 0) return end
  for (const match of text.matchAll(/[,:–—]["»”’')\]]*(?=\s)/g)) {
    const at = (match.index ?? 0) + match[0].length
    if (text.slice(0, at).trim().length >= FIRST_PIECE_MIN_LENGTH) return at
  }
  return 0
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim()

export function makeVoiceProgram(
  options: VoiceProgramOptions = {},
): Effect.Effect<VoiceProgramHandle, VoiceError, TranscriberService | SpeakerService | VoiceHost | Scope.Scope> {
  return Effect.gen(function* () {
    const transcriber = yield* Transcriber
    const speakerService = yield* Speaker
    /* How many times speech was cut, so a reply still arriving knows it was. */
    let hushed = 0
    const speaker: typeof speakerService = {
      ...speakerService,
      cancel: Effect.zipRight(
        Effect.sync(() => {
          hushed++
        }),
        speakerService.cancel,
      ),
    }
    const host = yield* VoiceHostService
    const programScope = yield* Effect.scope

    let currentState: DialogState = createInitialDialogState(options.initialStatus ?? "idle")
    /*
     * Cosa si stava chiedendo quando la domanda è rimasta in sospeso.
     *
     * Prima erano solo i candidati. Gli slot estratti dalla frase originale
     * — «chiudi il pannello due» → `{paneIndex: 2}` — venivano buttati, e la
     * risposta «la prima» eseguiva l'intento con `slots: {}`. Il numero che
     * l'utente aveva appena detto spariva, e il bersaglio tornava a essere
     * indovinato dal ripiego.
     */
    let pendingDisambiguation: { candidates: CandidateMatch[]; slots: Record<string, any> } | null = null
    let activeTimerFiber: Fiber.RuntimeFiber<void, unknown> | null = null

    const getNowMs: Effect.Effect<number> = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis

    function getCombinedContext(): ParseContext {
      const extra = options.getContext ? options.getContext() : {}
      const panes = host.listPanes()
      const isPendingPerm = currentState.status === "confirming" && Boolean(currentState.pendingAction?.isPermission)
      const pendingPermPaneId = currentState.pendingAction?.paneId

      return {
        panes,
        pendingPermission: isPendingPerm,
        pendingPermissionPaneId: pendingPermPaneId,
        ...extra,
      }
    }

    const cancelActiveTimer: Effect.Effect<void> = Effect.gen(function* () {
      if (activeTimerFiber !== null) {
        yield* Fiber.interrupt(activeTimerFiber)
        activeTimerFiber = null
      }
    })

    yield* Scope.addFinalizer(programScope, cancelActiveTimer)

    function startTimer(durationMs: number): Effect.Effect<void> {
      return Effect.gen(function* () {
        yield* cancelActiveTimer
        const timerEffect = Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(durationMs))
          activeTimerFiber = null
          yield* applyDialogEvent({ type: "timeout" })
        })
        activeTimerFiber = yield* Effect.fork(timerEffect)
      })
    }

    function applyDialogEvent(event: DialogEvent): Effect.Effect<void> {
      return Effect.gen(function* () {
        const now = yield* getNowMs
        const ctx = getCombinedContext()
        const result = transition(currentState, event, now, ctx)
        currentState = result.state
        options.onStateChange?.(currentState)
        yield* executeEffects(result.effects)
      })
    }

    /*
     * The half of a conversation that was missing.
     *
     * `sendPrompt` submits and returns, so until now the assistant said "l'ho
     * inviato" and then went quiet for good: the answer — the thing the user
     * asked for — appeared on a screen they may not be looking at. There is no
     * event to hang this on, which is why the host watches the pane and this
     * only decides what to say about the result.
     *
     * Forked, because a coding agent takes minutes and the dialogue loop has
     * to keep hearing the user in the meantime. One watch at a time: asking a
     * second question means the first answer is no longer the one wanted, and
     * two voices over each other are worse than either.
     */
    let replyWatchFiber: Fiber.RuntimeFiber<void, never> | null = null
    let replyWatchAbort: AbortController | null = null

    /* Reported once nothing is left: no sentence in hand, no reply being read. */
    const turnEnded: Effect.Effect<void> = Effect.gen(function* () {
      if (handling > 0) return
      const watching = replyWatchFiber
      if (watching) yield* Fiber.await(watching)
      if (handling > 0 || (replyWatchFiber !== null && replyWatchFiber !== watching)) return
      if (followUpDue) {
        followUpDue = false
        openFollowUp()
      }
      options.onTurnEnd?.()
    })

    function watchForReply(paneId: string): Effect.Effect<void> {
      return Effect.gen(function* () {
        const awaitReply = host.awaitReply
        if (!awaitReply) return

        const settings = options.getSettings ? options.getSettings() : DEFAULT_VOICE_SETTINGS
        if (settings.speakReplies === false) return

        if (replyWatchFiber !== null) {
          replyWatchAbort?.abort()
          yield* Fiber.interrupt(replyWatchFiber)
          replyWatchFiber = null
        }

        const abort = new AbortController()
        replyWatchAbort = abort

        const watch = Effect.gen(function* () {
          const result = yield* Effect.tryPromise({
            try: () => awaitReply.call(host, paneId, { signal: abort.signal }),
            catch: (err) => new HostActionFailed({ action: "awaitReply", cause: err }),
          })
          if (abort.signal.aborted) return
          const text = replySpeech(result)
          if (!text) return
          options.onSpoken?.(text)
          yield* speaker.speak(text)
        }).pipe(Effect.catchAll((err) => Effect.sync(() => options.onError?.(spokenMessage(err)))))

        replyWatchFiber = yield* Effect.fork(watch)
      })
    }

    yield* Scope.addFinalizer(
      programScope,
      Effect.sync(() => replyWatchAbort?.abort()),
    )

    function executeEffects(effects: DialogEffect[]): Effect.Effect<void> {
      return Effect.gen(function* () {
        for (const effect of effects) {
          switch (effect.type) {
            case "speak": {
              // Preset readback removal: do NOT speak canned static readbacks with the offline voice.
              // We only want the agent's real voice (Jarvis planner speech, replies, or explicit safety confirm prompts).
              const isPresetReadback = VOCABULARY.some((v) => v.readback === effect.text)
              if (isPresetReadback) {
                break
              }
              options.onSpoken?.(effect.text)
              yield* speaker.speak(effect.text).pipe(
                Effect.catchAll((err) =>
                  Effect.sync(() => {
                    options.onError?.(spokenMessage(err))
                  }),
                ),
              )
              break
            }

            case "start_timer": {
              yield* startTimer(effect.durationMs)
              break
            }

            case "cancel_timer": {
              yield* cancelActiveTimer
              break
            }

            case "execute_intent": {
              const focusedPaneId = options.getContext?.().focusedPaneId
              const dispatchOp = Effect.tryPromise({
                try: () =>
                  dispatch(
                    {
                      outcome: "matched",
                      intent: effect.intent,
                      slots: effect.slots,
                      confidence: 1.0,
                      candidates: [],
                      rawUtterance: "",
                      normalizedUtterance: "",
                    },
                    host,
                    { focusedPaneId },
                  ),
                catch: (err) =>
                  new HostActionFailed({
                    action: effect.intent.intent,
                    cause: err,
                    message: "Errore durante l'esecuzione del comando sul VoiceHost.",
                  }),
              })

              const outcomeResult = yield* dispatchOp.pipe(Effect.either)

              if (outcomeResult._tag === "Right") {
                const outcome = outcomeResult.right
                /*
                 * An answer, not a confirmation. Readbacks stay unspoken — the
                 * panel opening is the confirmation — but «elenca pannelli» or
                 * «cosa sta succedendo» have nothing to show but what they say,
                 * and a user talking without looking at the console heard
                 * nothing at all. Said, and so not logged a second time.
                 */
                const answers = outcome.success && Boolean(outcome.spoken) && SPOKEN_RESULTS.has(effect.intent.intent)
                /*
                 * A failure is said by the dialogue just below, and a line for it
                 * here as well printed the same sentence twice, the second time
                 * with the internal error code under it.
                 */
                const saidBelow = answers || (!outcome.success && Boolean(outcome.spoken))
                options.onOutcome?.(saidBelow ? { ...outcome, spoken: "", error: undefined } : outcome)
                if (answers) yield* say(outcome.spoken)
                if (outcome.success) {
                  yield* applyDialogEvent({
                    type: "command_success",
                    readback: outcome.spoken,
                  })
                } else {
                  yield* applyDialogEvent({
                    type: "command_failed",
                    error: outcome.spoken,
                  })
                }
              } else {
                const vError = outcomeResult.left
                const msg = spokenMessage(vError)
                // Said once, by the dialogue below: an error line and an action
                // line with the same sentence made three copies of it.
                options.onOutcome?.({ success: false, spoken: "" })
                yield* applyDialogEvent({
                  type: "command_failed",
                  error: msg,
                })
              }
              break
            }

            case "answer_permission": {
              yield* Effect.try({
                try: () => host.answerPermission(effect.paneId, effect.answer),
                catch: (err) =>
                  new HostActionFailed({
                    action: "answerPermission",
                    cause: err,
                  }),
              }).pipe(
                Effect.catchAll((err) =>
                  Effect.sync(() => {
                    options.onError?.(spokenMessage(err))
                  }),
                ),
              )
              break
            }

            case "send_prompt": {
              /*
               * «inizia dettatura pannello 2» stores the number that was said,
               * not a pane id; and with no pane named, the text went to the
               * first pane instead of the focused one. With no pane at all it
               * went nowhere and nothing said so.
               */
              const panes = host.listPanes()
              const focused = options.getContext?.().focusedPaneId
              const target = effect.paneId
                ? (panes.find((p) => p.id === effect.paneId) ?? panes.find((p) => String(p.index) === effect.paneId))
                : (panes.find((p) => p.id === focused) ?? panes[0])
              if (!target) {
                const missing = effect.paneId
                  ? `Non trovo il pannello ${effect.paneId}: la dettatura non è stata inviata.`
                  : "Nessun pannello aperto: la dettatura non è stata inviata."
                options.onError?.(missing)
                yield* say(missing)
                break
              }
              const sent = yield* Effect.tryPromise({
                try: async () => {
                  await host.sendPrompt(target.id, effect.text)
                  return target.id
                },
                catch: (err) =>
                  new HostActionFailed({
                    action: "sendPrompt",
                    cause: err,
                  }),
              }).pipe(
                Effect.catchAll((err) =>
                  Effect.sync(() => {
                    options.onError?.(spokenMessage(err))
                    return undefined
                  }),
                ),
              )

              if (sent) yield* watchForReply(sent)
              break
            }
          }
        }
      })
    }

    /**
     * Plans an unmatched sentence, carries it out, and says what happened.
     *
     * Returns whether it handled the utterance. `false` means the planner had
     * nothing — the sentence described no operation, or the model could not be
     * reached — and the caller falls through to the suggestions it always gave.
     *
     * Executed immediately, announced afterwards: that is the shape the user
     * asked for. The safety that replaces a confirmation is structural rather
     * than conversational — `PLANNABLE_COMMANDS` and the step union in
     * `plan/schema.ts` contain nothing that can close, kill, or delete, so the
     * worst a misheard sentence can do is open sessions and cost tokens.
     * Closing and killing stay in the grammar, which still asks.
     */
    /*
     * What a turn came to: `false` not taken, `true` taken and finished,
     * `"stopped"` ended by another sentence or a cancel — whose own handling
     * owns what comes next, the held sentence included.
     */
    type Handled = boolean | "stopped"

    /* The agent turn or plan in progress, so cancelling the dialogue can end it. */
    let agentAbort: AbortController | null = null

    /* A free sentence heard while thinking, and whether the user asked for it to go out. */
    let held: string | null = null
    let sendHeldAfterTurn = false

    function clearHeld(): void {
      if (held === null) return
      held = null
      sendHeldAfterTurn = false
      options.onHeld?.(null)
    }

    /** How long a held sentence is still offered once the turn is over. */
    const HELD_OFFER = Duration.seconds(60)

    /**
     * A turn ended on its own: send what the user asked to send, or leave the
     * held sentence on offer a little longer and then drop it. A turn stopped
     * by another sentence has already cleared it.
     */
    function afterTurn(): Effect.Effect<void> {
      return Effect.gen(function* () {
        if (held === null) return
        if (sendHeldAfterTurn) {
          const text = held
          clearHeld()
          yield* executeAgentUtterance(text, { typed: true })
          return
        }
        const offered = held
        yield* Effect.forkIn(
          Effect.sleep(HELD_OFFER).pipe(Effect.andThen(Effect.sync(() => held === offered && clearHeld()))),
          programScope,
        )
      })
    }

    function runPlan(utterance: string): Effect.Effect<Handled> {
      return Effect.gen(function* () {
        const complete = options.plan
        if (!complete) return false

        /*
         * Held where a new sentence or «annulla» looks for the turn in
         * progress: without it the plan could not be stopped, and a sentence
         * said while it ran was dropped by the "executing" dialogue.
         */
        agentAbort?.abort()
        const abort = new AbortController()
        agentAbort = abort

        currentState = { ...currentState, status: "executing" }
        options.onStateChange?.(currentState)

        const historyEntries = options.getHistory?.() ?? []
        const recentHistory = historyEntries
          .slice(-6)
          .map((e) => {
            if (e.kind === "user" && e.text) return { role: "user" as const, text: e.text }
            if (e.kind === "assistant" && e.text) return { role: "assistant" as const, text: e.text }
            if (e.kind === "action" && e.label) return { role: "action" as const, text: e.label }
            return undefined
          })
          .filter((e): e is { role: "user" | "assistant" | "action"; text: string } => e !== undefined)

        const panes = host.listPanes()
        const focusedId = options.getContext?.().focusedPaneId
        const focusedPane = panes.find((p) => p.id === focusedId)

        const context = {
          agents: host.listAgents?.() ?? [],
          projects: host.listProjects?.() ?? [],
          paneCount: panes.length,
          commands: PLANNABLE_COMMANDS,
          recentHistory,
          focusedPaneTitle: focusedPane?.title,
          activeProjectName: host.describeState?.().activeProject,
        }

        const planned = yield* Effect.promise((interrupted) => {
          interrupted.addEventListener("abort", () => abort.abort(), { once: true })
          return planUtterance(utterance, context, complete, { signal: abort.signal })
        })
        // Stopped while the model thought: whoever stopped it speaks next.
        if (abort.signal.aborted) return "stopped"

        /*
         * A failure to reach the model is not "non ho capito": one is the
         * sentence's fault and the other is the network's, and telling the
         * user which is the difference between rephrasing and checking the
         * key. Handing it back as unhandled would print the wrong one.
         */
        if (planned.failure) {
          if (agentAbort === abort) agentAbort = null
          currentState = { ...currentState, status: "idle" }
          options.onStateChange?.(currentState)
          yield* say(planned.failure)
          return true
        }

        if (planned.steps.length === 0 && planned.refusals.length === 0 && !planned.speech) {
          if (agentAbort === abort) agentAbort = null
          currentState = { ...currentState, status: "idle" }
          options.onStateChange?.(currentState)
          return false
        }

        if (agentAbort === abort) agentAbort = null
        const execution = yield* Effect.promise(() => executePlan(planned.steps, host))
        options.onPlan?.({ steps: planned.steps, execution })

        currentState = { ...currentState, status: "idle" }
        options.onStateChange?.(currentState)

        if (planned.speech) {
          // What the plan refused is as much news as what failed: «copilot» not
          // started was silently dropped whenever the model also said something.
          const problems = [...planned.refusals, ...execution.failures]
          const failures = problems.length > 0 ? ` Nota: ${problems.join(" ")}` : ""
          yield* say(`${planned.speech}${failures}`)
        } else {
          const labels = new Map(context.agents.map((agent) => [agent.id, agent.label]))
          yield* say(
            announceExecution({
              execution,
              refusals: planned.refusals,
              agentLabel: (id) => labels.get(id) ?? id,
            }),
          )
        }
        return true
      })
    }

    /**
     * Hands an unmatched sentence to the coding agent, and says its answer.
     *
     * Returns whether the agent took it. `false` means there is no agent —
     * the host cannot run one or the user turned it off — and the caller
     * falls through to the planner and then to "non ho capito".
     *
     * Ahead of the planner on purpose: the agent can do everything the
     * planner can, and what the planner cannot (ask a session, wait for it,
     * close it), with the subscription the user already pays for rather than
     * a key billed per request.
     */
    function runAgent(utterance: string): Effect.Effect<Handled> {
      return Effect.gen(function* () {
        const askAgent = host.askAgent
        const settings = options.getSettings ? options.getSettings() : DEFAULT_VOICE_SETTINGS
        const engine = settings.agentEngine
        if (!askAgent || engine === "off") return false

        agentAbort?.abort()
        const abort = new AbortController()
        agentAbort = abort
        markVoice("agent-asked", utterance)

        currentState = { ...currentState, status: "executing" }
        options.onStateChange?.(currentState)

        /*
         * The answer is read as it is written: each finished sentence goes to
         * the voice at once, and the rest follows it. Waiting for the whole
         * turn kept the user in silence for the length of the answer.
         */
        const hushedAtStart = hushed
        const quiet = () => abort.signal.aborted || hushed !== hushedAtStart
        const append = speaker.append
        let soFar = ""
        let saidUpTo = 0
        let streamed = false
        const cue = setTimeout(() => {
          if (!streamed && !quiet()) options.onCue?.("thinking")
        }, AGENT_CUE_MS)
        const onText = append
          ? (text: string) => {
              if (quiet()) return
              soFar = text
              const end = saidUpTo === 0 ? firstPieceUpTo(text) : finishedUpTo(text)
              if (end <= saidUpTo) return
              const piece = text.slice(saidUpTo, end).trim()
              saidUpTo = end
              if (!piece) return
              if (!streamed) markVoice("agent-first-sentence", piece)
              streamed = true
              options.onSpeaking?.(text.slice(0, end).trim())
              Effect.runFork(
                append(piece).pipe(Effect.catchAll((err) => Effect.sync(() => options.onError?.(spokenMessage(err))))),
              )
            }
          : undefined

        const answer: { ok: boolean; text: string; ran?: boolean } = yield* Effect.tryPromise({
          /*
           * Interruption aborts the turn too. Without it, stopping the engine
           * mid-turn waited for an answer that the stopped engine would never
           * say, and `stop()` hung until the CLI finished on its own.
           */
          try: (interrupted) => {
            interrupted.addEventListener("abort", () => abort.abort(), { once: true })
            return askAgent.call(host, {
              text: utterance,
              engine,
              speed: settings.agentSpeed,
              signal: abort.signal,
              ...(onText ? { onText } : {}),
            })
          },
          catch: (err) => new HostActionFailed({ action: "askAgent", cause: err }),
        }).pipe(
          Effect.catchAll((err) =>
            Effect.succeed({
              ok: false,
              text: err.cause instanceof Error && err.cause.message ? err.cause.message : spokenMessage(err),
              ran: true,
            }),
          ),
        )
        if (agentAbort === abort) agentAbort = null
        clearTimeout(cue)

        // Cancelled while it worked: the user has moved on, so nothing is said.
        if (abort.signal.aborted) return "stopped"

        currentState = { ...currentState, status: "idle" }
        options.onStateChange?.(currentState)

        if (!answer.ok) {
          options.onError?.(answer.text)
          /*
           * The agent could not take it — no CLI installed, a plan's limit, a
           * crash — and the planner may still. Returning true here meant the
           * planner never ran in ADE, whose host always offers an agent: with
           * a key set and no Claude Code, every sentence ended in «mi serve
           * Claude Code o Codex». The problem stays on screen either way.
           */
          // Only when no turn ran: one that started may already have opened
          // sessions before its error or timeout, and the planner would open them again.
          if (options.plan && answer.ran === false) return false
        }
        if (streamed && append) {
          const said = squash(soFar.slice(0, saidUpTo))
          const whole = squash(answer.text)
          // What is left after what was already said; the whole of it if the two disagree.
          const rest = !answer.ok ? whole : whole.startsWith(said) ? whole.slice(said.length).trim() : whole
          options.onSpoken?.(answer.ok ? whole : `${said} ${whole}`)
          yield* append(quiet() ? "" : rest).pipe(
            Effect.catchAll((err) => Effect.sync(() => options.onError?.(spokenMessage(err)))),
          )
          return true
        }
        yield* say(answer.text)
        return true
      })
    }

    yield* Scope.addFinalizer(
      programScope,
      Effect.sync(() => {
        agentAbort?.abort()
        closeFollowUp()
      }),
    )

    /** Speak, and never let the synthesiser's failure become the program's. */
    function say(text: string): Effect.Effect<void> {
      return Effect.gen(function* () {
        if (!text) return
        options.onSpoken?.(text)
        yield* speaker
          .speak(text)
          .pipe(Effect.catchAll((err) => Effect.sync(() => options.onError?.(spokenMessage(err)))))
      })
    }

    let isWakeWordAwake = false
    /*
     * Until when the name, said on its own or replaced by the button, holds.
     * It used to hold until the next sentence whenever that came, so a
     * television speaking minutes later was taken as the request.
     */
    let wakeUntil: number | undefined
    const clockMs = () => (options.now ? options.now() : Date.now())
    const awakeAt = (at: number) => isWakeWordAwake && (wakeUntil === undefined || at <= wakeUntil)
    const wakeFor = () => {
      closeFollowUp()
      inFollowUp = false
      isWakeWordAwake = true
      wakeUntil = clockMs() + WAKE_WINDOW_MS
      options.onCue?.("listening")
    }

    /* A spoken request was handled: once its answer has been said, the next sentence needs no name. */
    let followUpDue = false
    /*
     * Whether the assistant is awake only because of a window. A sentence
     * taken that way does not open another: one follow-up, then the name.
     * Otherwise a television talking on kept the window open for ever.
     */
    let inFollowUp = false
    let followUpTimer: ReturnType<typeof setTimeout> | undefined
    function openFollowUp(): void {
      const settings = options.getSettings ? options.getSettings() : DEFAULT_VOICE_SETTINGS
      if (settings.mode !== "agent" || settings.activation !== "wake-word" || !settings.alwaysListen) return
      if (currentState.status === "asleep") return
      closeFollowUp()
      const until = clockMs() + FOLLOW_UP_MS
      isWakeWordAwake = true
      wakeUntil = until
      inFollowUp = true
      options.onFollowUp?.(until)
      options.onCue?.("listening")
      followUpTimer = setTimeout(() => {
        followUpTimer = undefined
        if (wakeUntil !== until) return
        isWakeWordAwake = false
        wakeUntil = undefined
        options.onFollowUp?.(undefined)
        options.onCue?.("closed")
      }, FOLLOW_UP_MS)
    }
    /* Ends the window without a sound: used up by a sentence, or dropped by a stop. */
    function closeFollowUp(): void {
      if (followUpTimer === undefined) return
      clearTimeout(followUpTimer)
      followUpTimer = undefined
      isWakeWordAwake = false
      wakeUntil = undefined
      options.onFollowUp?.(undefined)
    }
    let isPushToTalkPressed = false

    function executeAgentUtterance(
      trimmed: string,
      heard: { typed: boolean; confidence?: number; named?: boolean } = { typed: false },
    ): Effect.Effect<void> {
      return Effect.gen(function* () {
        /*
         * Announced here, and only here, so the console sees what the agent
         * saw. Every agent-mode path converges on this function *after* the
         * wake word has been stripped, so what is reported is the command
         * itself rather than "ehi nik apri il pannello". Dictation never
         * reaches this point, which is correct: text on its way into a pane
         * is not a turn of conversation with the assistant.
         */
        options.onUtterance?.(trimmed)

        // 1. Check if user is resolving a pending disambiguation question ("la prima" / "la seconda")
        if (pendingDisambiguation && pendingDisambiguation.candidates.length >= 2) {
          const choice = checkDisambiguationChoice(trimmed)
          if (choice !== null && pendingDisambiguation.candidates[choice]) {
            const chosen = pendingDisambiguation.candidates[choice]
            const carriedSlots = pendingDisambiguation.slots
            pendingDisambiguation = null

            if (chosen.intent.destructive) {
              /*
               * Qui gli slot si perdono comunque, e non è un difetto nascosto.
               *
               * Il ramo distruttivo rientra nella macchina a stati del dialogo
               * passando la frase dell'intento, che viene ri-analizzata: il
               * «due» dell'utente non sopravvive. Portarlo fin dentro la
               * conferma vorrebbe dire far accettare slot a `DialogEvent`,
               * un cambio molto più largo di questo.
               *
               * Non viene chiuso il pannello sbagliato, però: da quando
               * `resolveTargetPane` rifiuta di indovinare per le azioni
               * distruttive, l'esito è che l'assistente richiede su quale
               * pannello. Un giro in più, non un danno.
               */
              yield* applyDialogEvent({
                type: "utterance",
                text: chosen.matchedPhrase,
              })
              return
            }

            // Execute non-destructive candidate directly - silently without canned offline readbacks
            currentState = { ...currentState, status: "executing" }
            options.onStateChange?.(currentState)
            yield* executeEffects([
              {
                type: "execute_intent",
                intent: chosen.intent,
                // Gli slot della frase originale, non un oggetto vuoto: «la
                // prima» sceglie fra due intenti, non ritratta il «due» che
                // l'utente aveva già detto.
                slots: carriedSlots,
              },
            ])
            return
          }
          pendingDisambiguation = null
        }

        const thinking = currentState.status === "executing" && agentAbort !== null

        /*
         * «invia questa»: the sentence held while thinking goes out — now if
         * the turn is over, as soon as it ends if not. Checked before the
         * grammar, whose «invia» belongs to dictation.
         */
        if (held !== null && isSendHeld(trimmed)) {
          if (thinking) {
            sendHeldAfterTurn = true
            options.onOutcome?.({ success: true, spoken: `La mando appena finisco: «${held}».` })
            return
          }
          const text = held
          clearHeld()
          yield* executeAgentUtterance(text, { typed: true })
          return
        }

        // 2. Parse utterance using pure parseUtterance
        const ctx = getCombinedContext()
        const parsed = parseUtterance(trimmed, ctx)
        options.onParseResult?.(parsed)

        /*
         * 2b. A sentence while the agent is still thinking about the last one.
         *
         * The dialogue ignores every utterance while it is "executing", so a
         * command typed or said during a turn was never answered. A stop word
         * or a known command stops the turn and is handled as if idle; a free
         * sentence heard from the room — the television, a call — does not
         * get to end a question the user is waiting on: it is held, and sent
         * only if they ask (`while-thinking.ts`).
         */
        if (thinking && agentAbort) {
          const triage = triageWhileThinking(parsed, heard)
          if (triage.action === "ignore") return
          if (triage.action === "hold") {
            held = trimmed
            sendHeldAfterTurn = false
            options.onHeld?.(trimmed)
            options.onOutcome?.({
              success: true,
              // The first words only: what the room says is not the console's business.
              spoken: `Sentito mentre pensavo: «${firstWords(trimmed)}». Di' «invia questa» per mandarla dopo, o lasciala: si scarta.`,
            })
            return
          }
          clearHeld()
          agentAbort.abort()
          agentAbort = null
          yield* speaker.cancel
          currentState = { ...currentState, status: "idle" }
          options.onStateChange?.(currentState)
          if (triage.action === "stop") {
            options.onSpoken?.("Ho fermato la richiesta precedente.")
            return
          }
          // Said on screen, not aloud: the answer to the new sentence is what should be heard.
          options.onOutcome?.({ success: true, spoken: "Richiesta precedente interrotta: passo alla nuova." })
        }

        // 3. Ambiguous outcome: query user for clarification, never execute
        if (parsed.outcome === "ambiguous") {
          pendingDisambiguation = { candidates: parsed.candidates, slots: parsed.slots }
          yield* applyDialogEvent({ type: "utterance", text: trimmed })
          return
        }

        /*
         * 3b. The grammar did not recognise it — so try to plan it.
         *
         * This is the seam of the hybrid, and the order is the point: the
         * hand-written vocabulary answers what people say often, instantly and
         * offline, and only what it rejects costs a network round trip. Put
         * the planner first and "chiudi il pannello due" would take two
         * seconds and stop working on a train.
         */
        /*
         * Asleep, a sentence is not for the assistant until «svegliati»; while
         * a confirmation is pending, the only answers are yes and no. Both
         * used to be handed to the agent anyway — a turn, its cost and its
         * actions after «vai a dormire», or in place of the answer awaited.
         * The dialogue keeps them, and says what it expects.
         */
        const openToModels =
          currentState.status !== "dictating" && currentState.status !== "asleep" && currentState.status !== "confirming"

        if (!thinking) clearHeld()

        if (parsed.outcome === "unknown" && openToModels) {
          const handled = yield* runAgent(trimmed)
          if (handled) {
            if (handled !== "stopped") yield* afterTurn()
            return
          }
        }

        if (parsed.outcome === "unknown" && openToModels && options.plan) {
          const handled = yield* runPlan(trimmed)
          if (handled) {
            if (handled !== "stopped") yield* afterTurn()
            return
          }
        }

        // 4. Unknown outcome: do NOT speak offline fallback suggestions.
        if (parsed.outcome === "unknown" && openToModels) {
          options.onError?.("Comando non riconosciuto.")
          return
        }

        // 5. Normal utterance flow through dialogue state machine
        yield* applyDialogEvent({ type: "utterance", text: trimmed })
      })
    }

    function handleTranscriptionUtterance(text: string): Effect.Effect<void> {
      return Effect.gen(function* () {
        const settings = options.getSettings ? options.getSettings() : DEFAULT_VOICE_SETTINGS
        const focusedPaneId = options.getContext?.().focusedPaneId
        // In transcription mode, speech is strictly silenced: cancel any active TTS immediately
        yield* speaker.cancel
        // Announced before the dispatch, not after: the point of the line is to
        // show the user that they were heard, and that is worth saying even if
        // the delivery into the pane then fails and says so itself.
        options.onTranscribed?.(text)
        yield* dispatchTranscription(text, host, settings.transcriptionSend, focusedPaneId).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              // `spokenMessage` turns every HostActionFailed into one generic
              // sentence; dictation is silent, so the specific one can be shown.
              options.onError?.(err.message || spokenMessage(err))
            }),
          ),
        )
      })
    }

    /**
     * `typed` is text the user wrote rather than said. Writing is its own
     * deliberate act: it needs no held key and no wake word, and asking for
     * either would drop every sentence typed with push-to-talk or wake-word
     * activation, since nothing is held and nobody said the word.
     */
    function processUtterance(
      rawText: string,
      fromAsr = false,
      typed = false,
      confidence?: number,
      spokenAt?: number,
    ): Effect.Effect<void> {
      return Effect.gen(function* () {
        const heard = { typed, confidence }
        const awake = awakeAt(spokenAt ?? clockMs())
        const currentSettings = options.getSettings ? options.getSettings() : DEFAULT_VOICE_SETTINGS

        /*
         * The user's own vocabulary, repaired before anything else reads it.
         *
         * Here rather than in either branch because both need it: dictation
         * puts the text straight into an agent's prompt, where "open code" is
         * the wrong program, and a command like "apri open code" has to match
         * the same way whichever mode heard it.
         *
         * The list is empty unless the user filled it, so by default this
         * returns the text unchanged.
         */
        const trimmed = correctCustomWords(rawText, currentSettings.customWords).text.trim()
        const isPtt = typed || (options.isPushToTalkActive !== undefined ? options.isPushToTalkActive() : isPushToTalkPressed)

        if (!trimmed) {
          if (currentSettings.activation === "push-to-talk" && !isPtt) {
            options.onOutcome?.({ success: true, spoken: "" })
          }
          return
        }

        if (currentSettings.activation === "push-to-talk" && !isPtt && !fromAsr) {
          return
        }

        /*
         * Typed text is addressed to the assistant, asleep or not. Closing the
         * microphone puts the dialogue to sleep, and the text-only program
         * starts from there, so everything typed afterwards reached a dialogue
         * that ignores utterances while asleep: no answer, no error, nothing.
         */
        if (typed && currentState.status === "asleep") {
          currentState = { ...currentState, status: "idle" }
          options.onStateChange?.(currentState)
        }

        // Mode separation: in transcription mode, utterance NEVER passes through parseUtterance
        if (currentSettings.mode === "transcription") {
          yield* handleTranscriptionUtterance(trimmed)
          return
        }

        // Typed text is addressed to the assistant already; a leading wake word is only dropped.
        if (typed && currentSettings.activation === "wake-word") {
          // Typing is not the conversation the window was left open for.
          closeFollowUp()
          const match = matchesWakeWord(trimmed, currentSettings.wakeWord)
          yield* executeAgentUtterance(match.matched && match.remainder.length > 0 ? match.remainder : trimmed, { typed: true })
          return
        }

        // Agent mode: wake-word activation
        if (currentSettings.activation === "wake-word") {
          /*
           * Una domanda in sospeso tiene sveglio l'assistente.
           *
           * Ogni intento distruttivo chiede conferma — «Vuoi davvero chiudere
           * il pannello?» — ma `executeAgentUtterance` rimetteva subito
           * `isWakeWordAwake` a falso. Il «sì» dell'utente arrivava quindi a
           * un assistente di nuovo sordo e veniva scartato: in modalità
           * wake-word *nessuna* azione distruttiva poteva essere confermata a
           * voce, e la domanda restava lì senza che niente spiegasse perché.
           *
           * Lo stesso vale per la disambiguazione: se il dialogo sta
           * aspettando quale dei due pannelli si intendeva, la risposta è
           * parte di quello scambio, non un comando nuovo.
           */
          const awaitingAnswer = currentState.status === "confirming" || pendingDisambiguation !== null

          /*
           * A turn already running is its own conversation: «annulla» said
           * while the assistant thinks is meant for it, and the name would be
           * a strange thing to require of someone stopping what they just
           * asked for. What may end a turn is decided in `while-thinking.ts`,
           * which holds a free sentence rather than obeying it.
           */
          const thinking = currentState.status === "executing" && agentAbort !== null

          if (!awake && !awaitingAnswer && !thinking) {
            const match = matchesWakeWord(trimmed, currentSettings.wakeWord)
            if (!match.matched) {
              /*
               * Shown, not obeyed and not silently dropped: a sentence that
               * vanishes looks like a microphone that has stopped working, and
               * the reason has to be readable — it is the whole rule.
               */
              options.onOutcome?.({
                success: true,
                spoken: `Ignorata, non inizia con «${currentSettings.wakeWord}»: «${firstWords(trimmed)}».`,
              })
              return
            }
            // Called over its own voice: it stops talking and listens.
            yield* speaker.cancel
            if (match.remainder.length > 0) {
              // Spoke wake-word and command together in one breath
              yield* executeAgentUtterance(match.remainder, heard)
              followUpDue = !typed
              return
            } else {
              // Spoke only the wake-phrase
              wakeFor()
              yield* applyDialogEvent({ type: "wake" })
              return
            }
          } else {
            // Awake, answering, or already at work on the last sentence.
            const match = matchesWakeWord(trimmed, currentSettings.wakeWord)
            const commandText = match.matched && match.remainder.length > 0 ? match.remainder : trimmed
            const followingUp = inFollowUp && !match.matched
            inFollowUp = false
            closeFollowUp()
            if (match.matched && !thinking) yield* speaker.cancel
            /* While a turn runs the name is not required to be heard, but a
               command is only carried out when it was addressed: see the
               `named` note in `while-thinking.ts`. */
            yield* executeAgentUtterance(commandText, {
              ...heard,
              named: match.matched || awake || awaitingAnswer,
            })
            /*
             * The sentence spent the name. A question left open still gets its
             * answer: `awaitingAnswer` is read afresh for every sentence. Held
             * awake here instead, a question answered by typing or by a button
             * left the assistant awake for good, and the room's next sentence,
             * hours later, was a request.
             */
            isWakeWordAwake = false
            wakeUntil = undefined
            // A conversation goes on: the answer to this one opens the next window.
            followUpDue = !typed && !thinking && !followingUp
            return
          }
        }

        // Standard agent mode (toggle)
        yield* executeAgentUtterance(trimmed, heard)
      })
    }

    /* Events taken off the stream whose handling has not finished; see `isIdle`. */
    let handling = 0
    /* The heard sentence being handled, so the next one can wait its turn. */
    let utteranceFiber: Fiber.RuntimeFiber<void, never> | null = null

    // Stream consumption loop for continuous speech recognition events
    const recognitionLoop = Stream.runForEach(transcriber.events, (ev) =>
      Effect.gen(function* () {
        handling++
        const currentSettings = options.getSettings ? options.getSettings() : DEFAULT_VOICE_SETTINGS
        const isPtt = options.isPushToTalkActive !== undefined ? options.isPushToTalkActive() : isPushToTalkPressed

        switch (ev._tag) {
          case "partial": {
            if (currentSettings.activation === "push-to-talk" && !isPtt) {
              break
            }
            // Barge-in: user started speaking, cancel any active or queued speech synthesis immediately
            if (ev.text.trim().length > 0) {
              yield* speaker.cancel
            }
            options.onPartialTranscript?.(ev.text)
            break
          }
          case "final": {
            options.onPartialTranscript?.("")
            const text = (ev.event?.text || "").trim()
            if (!text) {
              if (currentSettings.activation === "push-to-talk" && !isPtt) {
                options.onOutcome?.({
                  success: true,
                  spoken: "",
                })
              }
              break
            }
            /*
             * Forked, so a turn does not hold the microphone hostage. Handled
             * in line, a sentence said while the agent thought waited for the
             * whole turn: «annulla» arrived after the answer, and whatever the
             * television said in the meantime was run as the next request.
             * Order is kept — the next sentence waits for the one before —
             * except while that one is thinking, which is exactly when a
             * sentence must be looked at straight away.
             */
            const previous = utteranceFiber
            /*
             * The one before may only be talking. Called by name over its
             * voice, the voice stops, rather than the sentence waiting for
             * the end of an answer nobody is listening to any more.
             */
            if (
              previous &&
              currentSettings.mode === "agent" &&
              currentSettings.activation === "wake-word" &&
              matchesWakeWord(text, currentSettings.wakeWord).matched
            ) {
              yield* speaker.cancel
            }
            if (previous && !(currentState.status === "executing" && agentAbort)) yield* Fiber.await(previous)
            handling++
            utteranceFiber = yield* Effect.forkIn(
              processUtterance(ev.event.text, true, false, ev.event.confidence, ev.event.spokenAt).pipe(
                Effect.catchAll((err) => Effect.sync(() => options.onError?.(spokenMessage(err)))),
                Effect.ensuring(
                  Effect.gen(function* () {
                    handling--
                    yield* turnEnded
                  }),
                ),
              ),
              programScope,
            )
            break
          }
          case "error": {
            // Critical requirement: recognition error must NOT terminate listening loop.
            options.onPartialTranscript?.("")
            // Written as it is said: the browser's own words mean nothing to the user.
            const rawMsg = spokenMessage(ev.error)
            options.onError?.(rawMsg)
            if (currentState.status === "executing") {
              currentState = { ...currentState, status: "idle" }
              options.onStateChange?.(currentState)
            }
            // In transcription mode, speech is strictly forbidden: errors are visual only.
            if (currentSettings.mode !== "transcription") {
              yield* speaker.speak(spokenMessage(ev.error)).pipe(Effect.catchAll(() => Effect.void))
            }
            break
          }
        }
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            options.onError?.(spokenMessage(err))
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            handling--
            /* Whichever finishes last reports it: a quick sentence can be
               done before this loop lets go of its event. Forked, so a reply
               being read does not hold up the next event. A partial is
               speech still going on. */
            if (ev._tag !== "partial") yield* Effect.forkIn(turnEnded, programScope)
          }),
        ),
      ),
    )

    // Fork recognition loop bound to the active Scope
    yield* Effect.forkScoped(recognitionLoop)

    return {
      submitText: (text: string) => processUtterance(text, false, true).pipe(Effect.ensuring(turnEnded)),

      handlePermissionRequest: (paneId: string, what: string) =>
        applyDialogEvent({ type: "permission_requested", paneId, what }),

      cancel: Effect.gen(function* () {
        yield* cancelActiveTimer
        clearHeld()
        agentAbort?.abort()
        agentAbort = null
        pendingDisambiguation = null
        isWakeWordAwake = false
        followUpDue = false
        closeFollowUp()
        options.onPartialTranscript?.("")
        yield* speaker.cancel
        /* A press that only cut the voice is not an operation to cancel: said
           «nessuna operazione da annullare» over the silence it asked for. */
        if (currentState.status === "idle" || currentState.status === "listening") return
        yield* applyDialogEvent({ type: "cancel" })
      }),

      wake: Effect.gen(function* () {
        wakeFor()
        yield* applyDialogEvent({ type: "wake" })
      }),

      listenForName: Effect.sync(() => {
        isWakeWordAwake = false
        followUpDue = false
        closeFollowUp()
        if (currentState.status === "asleep") {
          currentState = { ...currentState, status: "idle" }
          options.onStateChange?.(currentState)
        }
      }),

      sleep: Effect.gen(function* () {
        isWakeWordAwake = false
        followUpDue = false
        closeFollowUp()
        yield* applyDialogEvent({ type: "sleep" })
      }),

      getDialogState: Effect.sync(() => currentState),

      pressToTalk: Effect.gen(function* () {
        isPushToTalkPressed = true
        yield* speaker.cancel
      }),

      releaseToTalk: Effect.sync(() => {
        isPushToTalkPressed = false
      }),

      waitingForName: (spokenAt?: number) => {
        const settings = options.getSettings ? options.getSettings() : DEFAULT_VOICE_SETTINGS
        if (settings.mode !== "agent" || settings.activation !== "wake-word") return false
        if (awakeAt(spokenAt ?? clockMs()) || isPushToTalkPressed) return false
        // A question is answered without the name. A turn at work is not: a
        // stop is short enough to go whole, and the rest has to call it.
        return !(currentState.status === "confirming" || pendingDisambiguation !== null)
      },

      isIdle: Effect.gen(function* () {
        /*
         * An agent turn or a plan in progress is not words still on their way:
         * a stop that waited for it held the microphone open for up to the
         * whole drain limit, and then left the turn running. Closing the
         * program's scope stops it instead.
         */
        if (handling > 0 && !(currentState.status === "executing" && agentAbort)) return false
        return transcriber.idle ? yield* transcriber.idle : true
      }),
    }
  })
}
