/**
 * Dialogue state machine for voice interaction in ADE.
 *
 * Implements a pure finite state machine: (state, event, now, ctx) -> { state, effects }.
 * Zero direct I/O, zero global variables, zero internal Date.now() calls.
 * All time is explicitly injected via the `now` parameter.
 *
 * Core behavioural guarantees:
 * 1. Destructive intents (process.kill, pane.close, permission rejection) NEVER execute directly.
 *    They enter 'confirming' and require explicit dialog.confirm ("si", "conferma").
 * 2. In 'dictating' mode, utterances are NOT parsed as commands; they accumulate into
 *    the prompt buffer until a closing phrase ("fine dettatura", "invia") completes the task.
 * 3. Pending permissions from agent CLIs take precedence, immediately entering 'confirming'.
 * 4. Wake/sleep toggling isolates workbench actions from casual room speech.
 */

import type { ParseContext } from "../intent/parse"
import { parseUtterance } from "../intent/parse"
import { normalizeUtterance } from "../intent/normalize"
import { VOCABULARY, type VoiceIntentSpec } from "../intent/vocabulary"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DialogStatus =
  | "asleep"
  | "idle"
  | "listening"
  | "confirming"
  | "dictating"
  | "executing"

export interface PendingAction {
  /** The parsed intent awaiting explicit confirmation. */
  intent: VoiceIntentSpec
  /** Extracted slots for execution. */
  slots: Record<string, any>
  /** Prompt phrase to speak when requesting confirmation. */
  confirmPrompt: string
  /** True when confirming an interactive agent CLI permission. */
  isPermission?: boolean
  /** Target pane ID for permissions. */
  paneId?: string
}

export interface DictationBuffer {
  /** Target pane ID to receive the finalized prompt. */
  paneId?: string
  /** Accumulated chunks of freeform spoken text. */
  chunks: string[]
}

export interface DialogState {
  /** Current state of the dialogue system. */
  status: DialogStatus
  /** Action held in escrow pending confirmation. */
  pendingAction?: PendingAction
  /** Ongoing prompt dictation buffer. */
  dictation?: DictationBuffer
  /** Timestamp (epoch ms) when the current confirmation timer expires. */
  timeoutAt?: number
  /** Last spoken Italian phrase emitted by the system, for dialog.repeat. */
  lastSpokenText?: string
}

export type DialogEffect =
  | { type: "speak"; text: string }
  | { type: "start_timer"; durationMs: number; timeoutAt: number }
  | { type: "cancel_timer" }
  | { type: "execute_intent"; intent: VoiceIntentSpec; slots: Record<string, any> }
  | { type: "answer_permission"; paneId: string; answer: "allow" | "deny" }
  | { type: "send_prompt"; paneId?: string; text: string }

export type DialogEvent =
  | { type: "wake" }
  | { type: "sleep" }
  | { type: "utterance"; text: string }
  | { type: "permission_requested"; paneId: string; what: string }
  | { type: "permission_resolved"; paneId: string }
  | { type: "command_success"; readback?: string }
  | { type: "command_failed"; error: string }
  | { type: "timeout" }
  | { type: "cancel" }

export interface TransitionResult {
  state: DialogState
  effects: DialogEffect[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 15_000
export const DEFAULT_PERMISSION_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createInitialDialogState(status: DialogStatus = "idle"): DialogState {
  return {
    status,
  }
}

function isDictationFinishPhrase(text: string): boolean {
  const norm = normalizeUtterance(text)
  return (
    norm === "fine dettatura" ||
    norm === "termina dettatura" ||
    norm === "invia dettatura" ||
    norm === "concludi dettatura" ||
    norm === "invia"
  )
}

// ---------------------------------------------------------------------------
// State Machine Transition Function
// ---------------------------------------------------------------------------

/**
 * Pure state machine transition function.
 *
 * @param state Previous dialogue state
 * @param event Input event received
 * @param now Injected current timestamp (epoch ms)
 * @param ctx Contextual ADE workbench state for intent resolution
 */
export function transition(
  state: DialogState,
  event: DialogEvent,
  now: number,
  ctx: ParseContext = {}
): TransitionResult {
  const effects: DialogEffect[] = []

  const withSpoken = (nextState: DialogState, text: string): TransitionResult => {
    effects.push({ type: "speak", text })
    return {
      state: {
        ...nextState,
        lastSpokenText: text,
      },
      effects,
    }
  }

  // 1. Agent permission request preempts current interactive state
  if (event.type === "permission_requested") {
    effects.push({ type: "cancel_timer" })
    const timeoutAt = now + DEFAULT_PERMISSION_TIMEOUT_MS
    effects.push({
      type: "start_timer",
      durationMs: DEFAULT_PERMISSION_TIMEOUT_MS,
      timeoutAt,
    })

    const permAllowSpec = VOCABULARY.find((v) => v.intent === "permission.allow")!
    const prompt = `L'agente richiede il permesso per: ${event.what}. Vuoi consentire?`

    return withSpoken(
      {
        ...state,
        status: "confirming",
        timeoutAt,
        pendingAction: {
          intent: permAllowSpec,
          slots: { paneId: event.paneId },
          confirmPrompt: prompt,
          isPermission: true,
          paneId: event.paneId,
        },
      },
      prompt
    )
  }

  // 2. State: ASLEEP
  if (state.status === "asleep") {
    if (event.type === "wake") {
      return withSpoken({ ...state, status: "idle" }, "Sono sveglio e in ascolto.")
    }

    if (event.type === "utterance") {
      const parsed = parseUtterance(event.text, ctx)
      if (parsed.outcome === "matched" && parsed.intent?.intent === "voice.wake") {
        return withSpoken({ ...state, status: "idle" }, "Sono sveglio e in ascolto.")
      }
    }

    // Ignore all other inputs while asleep
    return { state, effects: [] }
  }

  // 3. State: DICTATING
  if (state.status === "dictating") {
    if (event.type === "cancel") {
      return withSpoken(
        { ...state, status: "idle", dictation: undefined },
        "Dettatura annullata."
      )
    }

    if (event.type === "utterance") {
      if (isDictationFinishPhrase(event.text)) {
        const fullPrompt = (state.dictation?.chunks ?? []).join(" ").trim()
        const targetPane = state.dictation?.paneId

        if (fullPrompt.length > 0) {
          effects.push({
            type: "send_prompt",
            paneId: targetPane,
            text: fullPrompt,
          })
          return withSpoken(
            { ...state, status: "idle", dictation: undefined },
            "Dettatura completata e inviata all'agente."
          )
        } else {
          return withSpoken(
            { ...state, status: "idle", dictation: undefined },
            "Dettatura vuota, nessun messaggio inviato."
          )
        }
      }

      // In dictation mode: accumulate speech chunks, NEVER parse as commands
      const updatedChunks = [...(state.dictation?.chunks ?? []), event.text.trim()]
      return {
        state: {
          ...state,
          dictation: {
            paneId: state.dictation?.paneId,
            chunks: updatedChunks,
          },
        },
        effects: [],
      }
    }

    return { state, effects: [] }
  }

  // 4. State: CONFIRMING
  if (state.status === "confirming") {
    if (event.type === "timeout") {
      effects.push({ type: "cancel_timer" })
      return withSpoken(
        {
          ...state,
          status: "idle",
          pendingAction: undefined,
          timeoutAt: undefined,
        },
        "Non ho sentito risposta: lascio stare."
      )
    }

    if (event.type === "cancel") {
      effects.push({ type: "cancel_timer" })
      return withSpoken(
        {
          ...state,
          status: "idle",
          pendingAction: undefined,
          timeoutAt: undefined,
        },
        "Va bene, lascio stare."
      )
    }

    if (event.type === "utterance") {
      const parsed = parseUtterance(event.text, {
        ...ctx,
        pendingPermission: state.pendingAction?.isPermission,
      })

      // Confirmation positive
      if (
        parsed.intent?.intent === "dialog.confirm" ||
        parsed.intent?.intent === "permission.allow"
      ) {
        effects.push({ type: "cancel_timer" })
        const action = state.pendingAction!

        if (action.isPermission && action.paneId) {
          effects.push({
            type: "answer_permission",
            paneId: action.paneId,
            answer: "allow",
          })
          return withSpoken(
            {
              ...state,
              status: "idle",
              pendingAction: undefined,
              timeoutAt: undefined,
            },
            "Permesso accordato."
          )
        } else {
          effects.push({
            type: "execute_intent",
            intent: action.intent,
            slots: action.slots,
          })
          return withSpoken(
            {
              ...state,
              status: "executing",
              pendingAction: undefined,
              timeoutAt: undefined,
            },
            action.intent.readback
          )
        }
      }

      // Confirmation negative / cancellation
      if (
        parsed.intent?.intent === "dialog.cancel" ||
        parsed.intent?.intent === "permission.deny"
      ) {
        effects.push({ type: "cancel_timer" })
        const action = state.pendingAction!

        if (action.isPermission && action.paneId) {
          effects.push({
            type: "answer_permission",
            paneId: action.paneId,
            answer: "deny",
          })
          return withSpoken(
            {
              ...state,
              status: "idle",
              pendingAction: undefined,
              timeoutAt: undefined,
            },
            "Permesso negato."
          )
        } else {
          return withSpoken(
            {
              ...state,
              status: "idle",
              pendingAction: undefined,
              timeoutAt: undefined,
            },
            "Va bene, lascio stare."
          )
        }
      }

      // Unrecognized confirmation answer
      return withSpoken(
        state,
        "Sì o no?"
      )
    }

    return { state, effects: [] }
  }

  // 5. State: EXECUTING
  if (state.status === "executing") {
    if (event.type === "command_success") {
      return {
        state: { ...state, status: "idle" },
        effects,
      }
    }

    if (event.type === "command_failed") {
      // The dispatcher's sentence already says what went wrong, to the user:
      // «Errore durante l'esecuzione: Non c'è niente da annullare» said it twice.
      return withSpoken({ ...state, status: "idle" }, event.error)
    }

    return { state, effects: [] }
  }

  // 6. State: IDLE / LISTENING
  if (state.status === "idle" || state.status === "listening") {
    if (event.type === "sleep") {
      return withSpoken({ ...state, status: "asleep" }, "Vado a dormire.")
    }

    if (event.type === "cancel") {
      return withSpoken(state, "Non c'è niente da fermare.")
    }

    if (event.type === "utterance") {
      const parsed = parseUtterance(event.text, ctx)

      if (parsed.outcome === "unknown") {
        return withSpoken(state, "Non ho capito, puoi ripetere?")
      }

      if (parsed.outcome === "ambiguous") {
        const first = parsed.candidates[0]?.intent.readback ?? "prima opzione"
        const second = parsed.candidates[1]?.intent.readback ?? "seconda opzione"
        return withSpoken(
          state,
          `Comando ambiguo. Intendi ${first.toLowerCase()} oppure ${second.toLowerCase()}?`
        )
      }

      const intent = parsed.intent!

      // Dialog controls
      if (intent.intent === "voice.sleep") {
        return withSpoken({ ...state, status: "asleep" }, "Vado a dormire.")
      }

      if (intent.intent === "dialog.repeat") {
        const textToRepeat =
          state.lastSpokenText ?? "Nessun messaggio precedente da ripetere."
        return withSpoken(state, textToRepeat)
      }

      // Dictation mode initiation
      if (intent.intent === "dictation.start") {
        const targetPane = parsed.slots.paneIndex ? String(parsed.slots.paneIndex) : undefined
        return withSpoken(
          {
            ...state,
            status: "dictating",
            dictation: {
              paneId: targetPane,
              chunks: [],
            },
          },
          intent.readback
        )
      }

      // Destructive intents require explicit confirmation
      if (intent.destructive) {
        const timeoutAt = now + DEFAULT_CONFIRMATION_TIMEOUT_MS
        effects.push({
          type: "start_timer",
          durationMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
          timeoutAt,
        })

        // The intent carries its own question. The fallback stays generic on
        // purpose: a wrong-sounding sentence at a destructive prompt is worse
        // than a plain one, and the readback is not a question.
        const question = intent.confirmPrompt ?? "Lo faccio, va bene?"
        const prompt = `${question} Dimmi sì o no.`

        return withSpoken(
          {
            ...state,
            status: "confirming",
            timeoutAt,
            pendingAction: {
              intent,
              slots: parsed.slots,
              confirmPrompt: prompt,
              isPermission: false,
            },
          },
          prompt
        )
      }

      // Non-destructive intents execute directly
      effects.push({
        type: "execute_intent",
        intent,
        slots: parsed.slots,
      })

      return withSpoken(
        {
          ...state,
          status: "executing",
        },
        intent.readback
      )
    }
  }

  return { state, effects: [] }
}
