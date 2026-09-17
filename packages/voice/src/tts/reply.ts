/**
 * Turning what an agent printed into something worth saying out loud.
 *
 * A coding agent's transcript is not speech. It is box-drawing rules, spinner
 * frames, shell echoes, diffs, and code — read verbatim it is unlistenable, and
 * a diff read aloud is actively hostile. What the user asked for when they
 * dictated a question is the *answer*, which is the prose at the end.
 *
 * So this keeps prose, drops everything that only makes sense on a screen, and
 * takes the tail rather than the head: an agent narrates its way to a
 * conclusion, and the conclusion is the part you would have read.
 */

/**
 * One transcript line, in the shape ADE's panes already store.
 *
 * Declared here rather than imported for the same reason `bridge/host.ts`
 * declares `PaneStatus`: the voice layer names ADE's concepts without taking a
 * dependency on ADE's modules.
 */
export interface SpeakableLine {
  kind: "step" | "shell" | "note" | "diff" | "error"
  text: string
}

export interface ReplySummaryOptions {
  /**
   * Roughly how much to say. Speech is slow — around 150 words a minute — so
   * 320 characters is already some twenty seconds of talking, which is about
   * as long as anyone wants to be read at before they look at the screen.
   */
  maxChars?: number
}

const DEFAULT_MAX_CHARS = 320

/*
 * Escape sequences should already be gone: ADE strips them per complete line
 * before a line ever reaches a transcript. This is here because the cost of
 * being wrong is the synthesiser pronouncing "ESC bracket zero m" at the user,
 * and one regex is cheaper than that.
 */
const ANSI = /\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g

/** A line that carries no letter or digit is a rule, a frame, or a spinner. */
const HAS_WORDS = /[\p{L}\p{N}]/u

/** Kinds whose content is for the eye only. */
const UNSPOKEN_KINDS = new Set<SpeakableLine["kind"]>(["shell", "diff"])

/**
 * What the session said, as a sentence or three — or `undefined` when it said
 * nothing a person would want read to them.
 *
 * `undefined` is a real answer, not a failure: an agent that only ran a build
 * and printed a diff has produced nothing to say, and the caller should say so
 * in its own words rather than read the diff.
 */
export function summariseForSpeech(
  lines: readonly SpeakableLine[],
  options: ReplySummaryOptions = {},
): string | undefined {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const kept: string[] = []
  let insideFence = false

  for (const line of lines) {
    const text = line.text.replace(ANSI, "")

    /*
     * Fences toggle even on lines that are dropped, so a fence opened inside a
     * `shell` line still hides the code after it. Checked before the kind
     * filter for exactly that reason.
     */
    if (text.trim().startsWith("```")) {
      insideFence = !insideFence
      continue
    }
    if (insideFence) continue
    if (UNSPOKEN_KINDS.has(line.kind)) continue

    // An indented block is code or output, whatever kind it arrived as.
    if (/^ {4,}|\t/.test(text)) continue

    const collapsed = text.replace(/\s+/g, " ").trim()
    if (!collapsed || !HAS_WORDS.test(collapsed)) continue

    kept.push(line.kind === "error" ? `Errore: ${collapsed}` : collapsed)
  }

  if (kept.length === 0) return undefined
  return lastSentencesWithin(kept.join(" "), maxChars)
}

/** Why a reply watch ended, as `VoiceHost.awaitReply` reports it. */
export type ReplyReason = "settled" | "error" | "silent" | "timeout" | "aborted" | "gone"

/**
 * What to say once the watch is over — including when there is no answer.
 *
 * Silence is the failure mode to avoid here. An assistant that says nothing
 * when the agent produced nothing is indistinguishable from one that is
 * broken, and the user is left listening to a room. Each ending gets its own
 * sentence because they mean different things: "nothing came back" is a
 * problem to look into, "still working" is not.
 *
 * `aborted` and `gone` are the two that stay silent on purpose — the user
 * moved on, or the pane did, and speaking over that would be noise.
 */
export function replySpeech(
  result: { lines: readonly SpeakableLine[]; reason: ReplyReason },
  options: ReplySummaryOptions = {},
): string | undefined {
  if (result.reason === "aborted" || result.reason === "gone") return undefined
  if (result.reason === "silent") return "Non ho ricevuto risposta."

  const summary = summariseForSpeech(result.lines, options)
  if (summary) {
    return result.reason === "timeout" ? `${summary} Sta ancora lavorando.` : summary
  }

  if (result.reason === "timeout") return "Sta ancora lavorando."
  if (result.reason === "error") return "La sessione ha segnalato un errore."
  return "Ha finito, ma non ha lasciato una risposta da leggere."
}

/**
 * The end of `text`, cut at a sentence boundary, within `maxChars`.
 *
 * Taking the tail is the point: the answer is the last thing said. Cutting on
 * a boundary is what keeps it from starting mid-clause — and when even the
 * final sentence is longer than the budget, a hard cut on a word boundary
 * beats saying nothing.
 */
function lastSentencesWithin(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  const tail = text.slice(text.length - maxChars)
  const boundary = tail.search(/(?<=[.!?…])\s+\p{Lu}/u)
  if (boundary !== -1) {
    const sentence = tail.slice(boundary).trim()
    if (sentence.length > 0) return sentence
  }

  const space = tail.indexOf(" ")
  return (space === -1 ? tail : tail.slice(space + 1)).trim()
}
