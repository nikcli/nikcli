/**
 * What the agent widget says, given where the dialogue has got to.
 *
 * Kept out of the component because it is the whole of the widget's judgement
 * and none of its markup: which of six engine states the user is in, whether
 * the line on screen is their words or the interface's, and which colour the
 * pill's edge takes. All of that is decidable from four strings, and a rule
 * that can be checked without a DOM should be.
 */

import type { AgentEntry } from "../agent/log"
import type { DialogStatus } from "../dialog/session"
import type { VoiceErrorKind } from "../effect/errors"
import type { OrbRim } from "./orb-mark"
import { t } from "@nikcli-ai/ade/i18n"

/** How urgent the widget looks. Maps to one hairline colour, nothing more. */
export type HudTone = "armed" | "listening" | "asking" | "working" | "done"

export interface OrbRimInput {
  /** Whether the microphone is open. */
  running: boolean
  /** The engine's last failure, if it has one that has not been superseded. */
  errorKind?: VoiceErrorKind
  /** Whether the local model is still being fetched and nothing can be heard. */
  preparing: boolean
}

/**
 * Which collar the widget's orb wears.
 *
 * Three answers to one question — is this thing hearing me? — and the order is
 * the whole rule. A failure wins over everything: after a start that failed
 * the microphone is shut, so a green ring would be the widget's own state
 * contradicting itself. Of the failures, a microphone that has not been
 * granted is called out separately because it is the only one the user fixes
 * from a browser prompt rather than from settings.
 *
 * The warm-up gets no ring at all. It is neither listening nor broken, and
 * inventing a fourth colour for "wait" would spend the vocabulary on the one
 * state the pill is already spelling out in words and a percentage.
 */
export function orbRim(input: OrbRimInput): OrbRim | undefined {
  if (input.errorKind === "mic-auth") return "mic-auth"
  if (input.errorKind === "failed") return "failed"
  if (input.preparing) return undefined
  return input.running ? "listening" : undefined
}

export interface HudState {
  tone: HudTone
  /** The short state word, shown above the line. */
  label: string
  /** The line the user reads. */
  line: string
  /**
   * Whether `line` is a transcript of the user rather than the widget talking.
   * Set in italics, because a widget that quoted the user in its own voice
   * would make a misheard word look like a decision the agent had taken.
   */
  quoted: boolean
}

export interface HudInput {
  status: DialogStatus
  /** What is being heard right now, still subject to revision. */
  partial: string
  /** The last thing heard in full. */
  spoken: string
  /** The readback of a matched intent, when the parse produced one. */
  readback?: string
  /** The phrase that wakes the agent, quoted back while it sleeps. */
  wakeWord: string
  /** The user's latest sentence, heard in full (see `latestExchange`). */
  utterance?: string
  /** What the assistant said in answer to `utterance`, once it has. */
  answer?: string
}

/**
 * The user's latest sentence and the assistant's answer to it, from the agent log.
 *
 * `spoken` alone cannot say which question it answers: during an agent turn it
 * still holds whatever the assistant said before ("Sono sveglio e in ascolto."),
 * and the HUD read that out as if it were about the request in progress. The
 * log has the order, so an answer only counts when it came after the sentence.
 */
export function latestExchange(history: readonly AgentEntry[]): { utterance?: string; answer?: string } {
  let answer: string | undefined
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!
    if (entry.kind === "user")
      return answer === undefined ? { utterance: entry.text } : { utterance: entry.text, answer }
    // The newest assistant line after the sentence is its answer.
    if (entry.kind === "assistant" && answer === undefined) answer = entry.text
  }
  return {}
}

/**
 * The agent widget's line.
 *
 * The order inside `listening`/`idle` is the point: a partial transcript wins
 * over a readback, because while new speech is arriving the readback belongs
 * to the *previous* command and showing it would report the wrong thing with
 * total confidence.
 */
export function agentHudState(input: HudInput): HudState {
  const { status, partial, spoken, readback, wakeWord, utterance, answer } = input

  switch (status) {
    case "asleep":
      return { tone: "armed", label: t("vui.hud.waiting"), line: t("vui.hud.say", wakeWord), quoted: false }

    case "confirming":
      return { tone: "asking", label: t("vui.hud.confirm"), line: readback ?? spoken, quoted: false }

    case "executing":
      /*
       * A matched command reads back what it does. A sentence the grammar did
       * not know goes to the agent and has no readback: then the line is the
       * sentence itself, quoted — never the previous thing the assistant said.
       */
      if (readback) return { tone: "working", label: t("vui.hud.doing"), line: readback, quoted: false }
      if (utterance) return { tone: "working", label: t("vui.hud.doing"), line: utterance, quoted: true }
      return { tone: "working", label: t("vui.hud.doing"), line: spoken, quoted: false }

    case "dictating":
      return { tone: "listening", label: t("vui.hud.dictated"), line: partial || spoken, quoted: true }

    case "listening":
    case "idle":
      if (partial.length > 0) {
        return { tone: "listening", label: t("vui.hud.hearing"), line: partial, quoted: true }
      }
      if (readback) {
        return { tone: "done", label: t("vui.hud.understood"), line: readback, quoted: false }
      }
      // An agent turn has no readback; its answer is what the user waited for.
      if (answer) {
        return { tone: "done", label: t("vui.hud.answer"), line: answer, quoted: false }
      }
      return { tone: "listening", label: t("vui.hud.hearing"), line: t("vui.hud.goAhead"), quoted: false }
  }
}

export interface HudPreparation {
  /** How far the download has got, when the server sent a total to divide by. */
  percent?: number
}

/**
 * What the widget says before either engine is able to hear anything.
 *
 * The local model is fetched on first use, and that is hundreds of megabytes:
 * long enough that a widget which only appears once the microphone is live
 * leaves the user talking into a window that shows nothing at all. Reporting
 * the wait — with its percentage when there is one — is the difference between
 * "still coming" and "broken", and those are the two readings of an empty
 * screen.
 */
export function preparingHudState(progress: HudPreparation): HudState {
  const known = typeof progress.percent === "number" && Number.isFinite(progress.percent)
  const percent = known ? Math.max(0, Math.min(100, Math.round(progress.percent!))) : undefined
  return {
    tone: "working",
    label: t("vui.hud.preparing"),
    line: percent === undefined ? t("vui.hud.model") : t("vui.hud.modelPercent", percent),
    quoted: false,
  }
}

/**
 * Fixed silhouette for the waveform.
 *
 * One amplitude drives every bar, so without a per-bar weight the row would
 * rise and fall as a single block. These weights give it the shape of a voice
 * without claiming to be a spectrum nobody measured.
 */
export const HUD_WAVE: readonly number[] = [0.32, 0.58, 0.86, 1, 0.72, 0.94, 0.66, 0.4, 0.78, 0.5]

/**
 * Height of one waveform bar, as a percentage of the row.
 *
 * The floor is the whole point of this function. An open microphone in a quiet
 * room reports a level of nearly zero, and bars drawn straight from that
 * collapse into a row of two-pixel dots — which reads as a widget that has
 * stopped working, at exactly the moment it is working and waiting. So silence
 * keeps a low uneven silhouette, and the level fills the range above it.
 */
export function waveBarHeight(weight: number, level: number, running: boolean): number {
  if (!running) return 20 + weight * 16
  // The weight is paid twice: once into the floor, so a silent room still has
  // a shape rather than a ruled line, and once into the part the level drives.
  return 18 + weight * 10 + Math.min(level * 2.2, 1) * weight * 72
}
