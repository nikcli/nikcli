/**
 * Knowing when an agent has finished answering, so the reply can be spoken.
 *
 * There is no event for this. A dictated prompt goes into a pty and the answer
 * arrives as a stream of lines that stops — sometimes with the pane's status
 * changing, often not, because a TUI agent redraws its frame forever and never
 * tells anyone it is idle. So "finished" is decided the way a person watching
 * the pane would decide it: the output stopped and stayed stopped.
 *
 * Status is used where it is trustworthy (an `error` pane is finished now, and
 * waiting out the quiet period would only delay saying so) and ignored where
 * it is not.
 */

/** One transcript line. Mirrors `TranscriptLine` without importing a `.tsx`. */
export interface WatchedLine {
  kind: "step" | "shell" | "note" | "diff" | "error"
  text: string
}

export type WatchedStatus = "idle" | "provisioning" | "working" | "waiting" | "done" | "error"

export interface ReplyWatchDeps {
  /** The pane's transcript as it stands now, or `undefined` if it is gone. */
  linesOf: (paneId: string) => readonly WatchedLine[] | undefined
  /** The pane's status as it stands now. */
  statusOf: (paneId: string) => WatchedStatus | undefined
  /** Injected so tests do not wait in real time. */
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export interface ReplyWatchOptions {
  /** How long the transcript must stay unchanged before the answer is over. */
  quietMs?: number
  /** How long to wait for the *first* new line before concluding none is coming. */
  firstLineTimeoutMs?: number
  /** The hard ceiling. An agent can work for minutes; it should not hold the voice loop forever. */
  timeoutMs?: number
  /** Poll interval. */
  pollMs?: number
  /** Abort from the caller — a new utterance, a cancelled dialogue, a closed pane. */
  signal?: AbortSignal
}

export interface ReplyWatchResult {
  /** Everything the pane added after the prompt was sent. */
  lines: WatchedLine[]
  /**
   * Why the watch stopped. The caller says different things for each: an
   * answer that never started is not the same as one cut off by the ceiling,
   * and telling the user the difference is the whole value of reporting it.
   */
  reason: "settled" | "error" | "silent" | "timeout" | "aborted" | "gone"
}

const DEFAULTS = {
  quietMs: 1_500,
  firstLineTimeoutMs: 20_000,
  timeoutMs: 180_000,
  pollMs: 250,
}

/**
 * Waits for the pane to stop producing output, and returns what it produced.
 *
 * The mark is taken at call time, so a reply is whatever appeared *after* the
 * prompt — not the backlog already on screen, which is the previous
 * conversation and would be read out again on every question.
 */
export async function awaitPaneReply(
  deps: ReplyWatchDeps,
  paneId: string,
  options: ReplyWatchOptions = {},
): Promise<ReplyWatchResult> {
  const quietMs = options.quietMs ?? DEFAULTS.quietMs
  const firstLineTimeoutMs = options.firstLineTimeoutMs ?? DEFAULTS.firstLineTimeoutMs
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const pollMs = options.pollMs ?? DEFAULTS.pollMs

  const initial = deps.linesOf(paneId)
  if (!initial) return { lines: [], reason: "gone" }

  /*
   * The mark is the last line on screen, not a count.
   *
   * The workbench keeps a pane's last 200 lines and drops the oldest, so once
   * a transcript is full its length never changes again: counting made every
   * answer to a busy pane look like no answer at all ("silent" after twenty
   * seconds), and `slice(count)` returned nothing even when it had grown.
   * What follows that line is what is new — and when it has scrolled out,
   * everything is. Found by identity, and by text when a store has swapped
   * the objects: the workbench never pushes the same text twice in a row, so
   * the tail's text changes with every line that arrives.
   */
  const anchor = initial.at(-1)
  const anchorText = anchor?.text
  const startedAt = deps.now()
  let lastLength = initial.length
  let lastTailText = anchorText
  let lastChangeAt = startedAt
  let grew = false

  const newSince = (lines: readonly WatchedLine[]): WatchedLine[] => {
    if (!anchor) return [...lines]
    let at = lines.lastIndexOf(anchor)
    if (at < 0) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.text === anchorText) {
          at = i
          break
        }
      }
    }
    return at >= 0 ? lines.slice(at + 1) : [...lines]
  }
  const since = (): WatchedLine[] => newSince(deps.linesOf(paneId) ?? [])

  for (;;) {
    if (options.signal?.aborted) return { lines: since(), reason: "aborted" }

    const lines = deps.linesOf(paneId)
    if (!lines) return { lines: [], reason: "gone" }

    const at = deps.now()
    if (lines.length !== lastLength || lines.at(-1)?.text !== lastTailText) {
      lastLength = lines.length
      lastTailText = lines.at(-1)?.text
      lastChangeAt = at
      grew = true
    }

    /*
     * An errored pane is finished, whatever the transcript is doing. Sitting
     * out the quiet period here would only make the user wait to be told that
     * something went wrong.
     */
    if (deps.statusOf(paneId) === "error") {
      return { lines: since(), reason: "error" }
    }

    if (grew && at - lastChangeAt >= quietMs) {
      return { lines: since(), reason: "settled" }
    }

    if (!grew && at - startedAt >= firstLineTimeoutMs) {
      return { lines: [], reason: "silent" }
    }

    if (at - startedAt >= timeoutMs) {
      return { lines: since(), reason: "timeout" }
    }

    await deps.sleep(pollMs)
  }
}
