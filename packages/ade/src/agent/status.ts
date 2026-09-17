import { t } from "../i18n"
/**
 * How the agent console describes what the assistant is doing right now.
 *
 * Extracted from the component because the interesting part is the mapping,
 * not the markup, and a `.tsx` cannot be imported under `bun test` in this
 * repo. Both the component and the test read this file; neither copies it.
 */

/** Mirrors `DialogStatus` in `@nikcli-ai/voice`, plus the engine being off. */
export type AgentPresence = "off" | "asleep" | "idle" | "listening" | "confirming" | "dictating" | "executing"

export interface PresenceLabel {
  /** Short phrase for the status pill. */
  text: string
  /**
   * Which status colour to wear.
   *
   * Reuses the pane status ramp rather than inventing one: a user who has
   * learnt that amber means "working" in the grid should not have to learn a
   * second vocabulary one section to the left.
   */
  tone: "idle" | "working" | "waiting" | "done" | "error"
}

// Keys, not texts: the label is read in the language of the moment it is shown.
const LABELS = {
  off: { key: "presence.off", tone: "idle" },
  asleep: { key: "presence.asleep", tone: "idle" },
  idle: { key: "presence.idle", tone: "done" },
  listening: { key: "presence.listening", tone: "done" },
  confirming: { key: "presence.confirming", tone: "waiting" },
  dictating: { key: "presence.dictating", tone: "waiting" },
  executing: { key: "presence.executing", tone: "working" },
} as const satisfies Record<AgentPresence, { key: string; tone: PresenceLabel["tone"] }>

export function presenceLabel(presence: AgentPresence): PresenceLabel {
  const { key, tone } = LABELS[presence]
  return { text: t(key), tone }
}

/**
 * The engine's two facts — running, and what the dialogue is doing — folded
 * into the one thing the console shows.
 *
 * `running` wins: a dialogue state left over from the last session says
 * "listening" at a microphone that is closed, and that is the single most
 * misleading thing this panel could claim.
 */
export function presenceOf(input: { running: boolean; status: string }): AgentPresence {
  if (!input.running) return "off"
  return (input.status in LABELS ? input.status : "idle") as AgentPresence
}
