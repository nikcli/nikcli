/**
 * The voice agent's conversation, as a list rather than a set of last-values.
 *
 * The engine already exposes `lastSpoken`, `lastOutcome` and `lastParseResult`,
 * and every one of them is a *current value*: it answers "what is happening"
 * and cannot answer "what happened". A console that shows what the assistant
 * has been asked and what it did for us needs the second question, so the log
 * is accumulated here instead of being reconstructed by the UI from signals it
 * might miss between renders.
 *
 * Pure on purpose: `appendEntry` is a reducer over a frozen list, so the
 * dedupe and cap rules below are testable without a microphone, a network or a
 * Solid root. The engine owns the signal; this file owns the rules.
 */

/** What the user said, once the transcriber called it final. */
export interface AgentUserEntry {
  kind: "user"
  text: string
  at: number
}

/** What the assistant said back, as spoken. */
export interface AgentAssistantEntry {
  kind: "assistant"
  text: string
  at: number
}

/** A single workbench action the assistant carried out for us. */
export interface AgentActionEntry {
  kind: "action"
  /** Human phrasing of the action, taken from the outcome's spoken form. */
  label: string
  ok: boolean
  /** Present only when the action failed, and only when it said why. */
  detail?: string
  at: number
}

/** A multi-step plan the language model produced and the engine executed. */
export interface AgentPlanEntry {
  kind: "plan"
  steps: string[]
  ok: number
  failed: number
  at: number
}

/** Something went wrong outside an action — hardware, recognition, network. */
export interface AgentErrorEntry {
  kind: "error"
  text: string
  at: number
}

export type AgentEntry = AgentUserEntry | AgentAssistantEntry | AgentActionEntry | AgentPlanEntry | AgentErrorEntry

/**
 * How many entries the console keeps.
 *
 * A voice session is open for hours and every partial re-render walks this
 * list, so it is bounded. The oldest go first, which matches how the console
 * is read: it is scrolled to the bottom.
 */
export const MAX_AGENT_ENTRIES = 400

function sameText(a: AgentEntry, b: AgentEntry): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "assistant" && b.kind === "assistant") return a.text === b.text
  if (a.kind === "user" && b.kind === "user") return a.text === b.text
  if (a.kind === "error" && b.kind === "error") return a.text === b.text
  if (a.kind === "action" && b.kind === "action") return a.label === b.label && a.ok === b.ok
  return false
}

/**
 * Append one entry, dropping an immediate repeat and capping the length.
 *
 * The repeat rule is not cosmetic. `onSpoken` fires from two places in the
 * program — the dialogue's `speak` effect and the direct `say` helper — and
 * "Non ho capito, puoi ripetere?" twice in a row means the assistant answered
 * twice, which is true but unreadable. Only *consecutive* duplicates collapse:
 * the same sentence said again after something else happened is a real second
 * answer and stays.
 */
export function appendEntry(
  log: readonly AgentEntry[],
  entry: AgentEntry,
  options: { max?: number } = {},
): AgentEntry[] {
  const max = options.max ?? MAX_AGENT_ENTRIES
  const previous = log[log.length - 1]
  if (previous && sameText(previous, entry)) return log as AgentEntry[]

  const next = [...log, entry]
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * Group consecutive entries into turns, so the console can draw a conversation
 * instead of a flat feed.
 *
 * A turn starts at every user entry; everything the assistant said or did
 * before the next user entry belongs to it. Entries that arrive before the
 * first user entry — a startup greeting, an early error — form a leading turn
 * with no prompt, which the UI renders without a user bubble rather than
 * hiding.
 */
export interface AgentTurn {
  /** Undefined for the leading turn, when the assistant spoke first. */
  prompt?: AgentUserEntry
  replies: Exclude<AgentEntry, AgentUserEntry>[]
}

export function groupIntoTurns(log: readonly AgentEntry[]): AgentTurn[] {
  const turns: AgentTurn[] = []
  for (const entry of log) {
    if (entry.kind === "user") {
      turns.push({ prompt: entry, replies: [] })
      continue
    }
    let current = turns[turns.length - 1]
    if (!current) {
      current = { replies: [] }
      turns.push(current)
    }
    current.replies.push(entry)
  }
  return turns
}
