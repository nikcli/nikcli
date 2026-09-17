/**
 * When to type the opening task into a session that has just started.
 *
 * The task is typed, not passed as an argument — that is deliberate and it is
 * what makes one code path work for eleven different CLIs. But it used to be
 * typed on a fixed timer: 900 ms after spawn, whatever was on screen. Measured
 * on this machine, five of the nine installed agents take longer than that to
 * answer `--version`, which is the cheapest thing they can possibly do — no
 * TUI, no model catalogue, no auth refresh:
 *
 *     claude 60ms · pi 493 · agy 664 · codex 683 · opencode 1093
 *     kimi 1377 · nikcli 1912 · gemini 2398 · hermes 22954
 *
 * So for most of the catalogue the text landed in a buffer nobody was reading
 * yet, or — worse — the carriage return answered the first question the CLI
 * asked. "Do you trust the files in this folder?" is a yes/no prompt, and an
 * opening task ending in Enter is an answer to it.
 *
 * What replaces the timer is not a longer timer. A CLI is ready when it has
 * said something and then stopped saying things; the only complication is that
 * a CLI with an animated prompt never stops, so there are two ways to be
 * ready and a session takes whichever comes first.
 */

/** How long the output must stay quiet before the screen counts as drawn. */
export const OPENING_QUIET_MS = 400

/**
 * How long after the first byte to give up on waiting for quiet.
 *
 * Ink and ratatui prompts animate — a spinner repaints every ~80 ms and never
 * goes quiet at all — so quiescence alone would wait forever for exactly the
 * agents this is for. Past this point the screen is as drawn as it is going
 * to get.
 */
export const OPENING_SETTLE_MS = 2_500

/**
 * How long to wait for the very first byte before giving up entirely.
 *
 * Generous because one installed agent takes 23 seconds to print its version.
 * A session that produces nothing at all inside this window is not slow, it is
 * broken, and typing into it would only hide that.
 */
export const OPENING_TIMEOUT_MS = 60_000

export interface OpeningInput {
  /** When the process was spawned. */
  startedAt: number
  /** When the first byte arrived, if any has. */
  firstByteAt?: number
  /** When the most recent byte arrived, if any has. */
  lastByteAt?: number
  /** Now. */
  now: number
  /** True while the session is holding a question the user has not answered. */
  permissionPending: boolean
  quietMs?: number
  settleMs?: number
  timeoutMs?: number
}

/**
 * `wait` — not yet; ask again later.
 * `send` — the screen has settled, type it.
 * `abandon` — nothing came, or nothing settled; do not type, and say so.
 */
export type OpeningDecision = "wait" | "send" | "abandon"

export function decideOpening(input: OpeningInput): OpeningDecision {
  const quietMs = input.quietMs ?? OPENING_QUIET_MS
  const settleMs = input.settleMs ?? OPENING_SETTLE_MS
  const timeoutMs = input.timeoutMs ?? OPENING_TIMEOUT_MS

  const waitedFromSpawn = input.now - input.startedAt
  if (input.firstByteAt === undefined) {
    // Silence from a process that has not spoken once. It is starting, or it
    // has already failed; either way there is nothing to type into.
    return waitedFromSpawn >= timeoutMs ? "abandon" : "wait"
  }

  /*
   * Never type into a question.
   *
   * This is the failure the fixed timer actually produced, and it is the one
   * worth being stubborn about: a pending permission means the cursor is
   * sitting on a yes/no prompt, and the first character of an opening task
   * would answer it. Waiting past the deadline and abandoning is right —
   * the user is being asked something and gets to answer it themselves.
   */
  if (input.permissionPending) {
    return waitedFromSpawn >= timeoutMs ? "abandon" : "wait"
  }

  const sinceLastByte = input.now - (input.lastByteAt ?? input.firstByteAt)
  if (sinceLastByte >= quietMs) return "send"

  // Still painting. An animated prompt never stops, so it gets sent anyway
  // once it has had long enough to have drawn whatever it is going to draw.
  if (input.now - input.firstByteAt >= settleMs) return "send"

  return waitedFromSpawn >= timeoutMs ? "abandon" : "wait"
}
