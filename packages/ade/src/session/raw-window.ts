/**
 * The last few lines an agent actually wrote, before anything tidied them.
 *
 * `detectPermission` and `isResolved` read a window of recent output to decide
 * whether a question is on screen. They used to read it from the pane's
 * transcript — which is the wrong copy, and became the wrong copy silently.
 *
 * The transcript is cleaned on the way in: `cleanTranscriptLine` truncates at
 * 400 characters and drops lines made only of frame glyphs. That is right for
 * something a person reads and wrong for something a regex searches, and the
 * case it breaks is exactly the one the detectors exist for — a full-screen
 * agent paints its permission prompt inside a frame far wider than 400
 * characters, so the question was cut off before the detector ever saw it.
 *
 * So the raw lines are kept separately, bounded, and only as many as the
 * detectors look at. Pure and in a `.ts`: a window that silently holds the
 * wrong thing is the bug this module exists to have prevented.
 */

/**
 * How many lines to keep per pane.
 *
 * The detectors read the last eight. Keeping more would cost memory for a
 * question nobody asks; keeping fewer would hide a prompt that a redraw has
 * pushed up by a line or two.
 */
export const RAW_WINDOW = 8

/** A bounded, per-pane window of raw output lines. */
export interface RawWindows {
  /** Records a line and returns the pane's current window, newest last. */
  push(paneId: string, line: string): string[]
  /** The pane's window, oldest first. Empty for a pane that has said nothing. */
  read(paneId: string): string[]
  /** Drops a pane's window. Called when the pane is closed. */
  forget(paneId: string): void
  /** How many panes are being tracked. For the test that this does not leak. */
  size(): number
}

export function createRawWindows(limit: number = RAW_WINDOW): RawWindows {
  const byPane = new Map<string, string[]>()

  return {
    push(paneId, line) {
      const window = byPane.get(paneId) ?? []
      window.push(line)
      /*
       * Trimmed from the front on every push rather than when it gets large.
       * A session that runs for an hour pushes tens of thousands of lines
       * through here, and a window that is only occasionally compacted is a
       * leak with a slow fuse.
       */
      if (window.length > limit) window.splice(0, window.length - limit)
      byPane.set(paneId, window)
      return window
    },

    read(paneId) {
      return byPane.get(paneId) ?? []
    },

    forget(paneId) {
      byPane.delete(paneId)
    },

    size() {
      return byPane.size
    },
  }
}
