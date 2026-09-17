/**
 * Deciding how much transcript is worth keeping across a restart.
 *
 * The transcript is the only part of a session that can outlive it: the
 * process cannot survive the app closing, and certainly not the machine
 * restarting, so what the agent said is what there is. But it is kept in
 * `localStorage`, which is a handful of megabytes shared with everything else
 * ADE stores, and a single long-running agent prints more than that in an
 * afternoon.
 *
 * So: the tail, bounded twice — by line count and by characters — and the
 * whole workspace bounded again across panes, because six sessions each
 * within budget are collectively not. Overflowing the quota throws on write,
 * and a write that throws saves nothing at all, which is the one outcome
 * worse than saving less.
 *
 * Pure, and separate from the components, so the arithmetic can be tested
 * without a DOM. (Solid `.tsx` has no JSX runtime under `bun test` here.)
 */

import type { SavedLine } from "./persist"

/** Lines kept per pane. Enough to see how the session ended and why. */
export const MAX_LINES_PER_PANE = 300

/** Characters kept per pane, which is the bound that actually binds. */
export const MAX_CHARS_PER_PANE = 60_000

/**
 * Characters kept across every pane together.
 *
 * Well under a typical 5 MB origin quota, because the workspace is not the
 * only thing in it and `localStorage` holds UTF-16: the real cost is about
 * twice the character count, plus JSON's quoting and escaping.
 */
export const MAX_CHARS_TOTAL = 400_000

/** A single line longer than this is truncated rather than dropped. */
const MAX_CHARS_PER_LINE = 4_000

const ELLIPSIS = "…"

function clampLine(line: SavedLine): SavedLine {
  if (line.text.length <= MAX_CHARS_PER_LINE) return line
  // The head, not the tail: a very long line is almost always a wrapped
  // command or a pasted blob, and its beginning is what identifies it.
  return { ...line, text: line.text.slice(0, MAX_CHARS_PER_LINE - 1) + ELLIPSIS }
}

/**
 * The tail of one pane's transcript, within both per-pane bounds.
 *
 * Walks backwards so the newest lines are the ones kept: what a user looks
 * for after a restart is how the session ended, not how it began.
 */
export function boundPaneTranscript(
  lines: readonly SavedLine[],
  maxLines: number = MAX_LINES_PER_PANE,
  maxChars: number = MAX_CHARS_PER_PANE,
): SavedLine[] {
  const kept: SavedLine[] = []
  let chars = 0

  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i -= 1) {
    const line = clampLine(lines[i])
    // Always keep one line, even an oversized one: a pane whose transcript is
    // a single huge line would otherwise restore completely empty.
    if (chars + line.text.length > maxChars && kept.length > 0) break
    kept.push(line)
    chars += line.text.length
  }

  return kept.reverse()
}

/**
 * Trims a whole workspace's transcripts to the shared budget.
 *
 * Panes are shortened from the *front* of the list rather than dropped, and
 * the focused pane is spared first, so the session the user was looking at
 * keeps its history when the budget is tight. A pane always keeps at least
 * its last line, so nothing restores as a nameless empty box.
 */
export function boundWorkspaceTranscripts<T extends { id: string; lines?: SavedLine[] }>(
  panes: readonly T[],
  focusedId?: string,
  maxCharsTotal: number = MAX_CHARS_TOTAL,
): T[] {
  const out = panes.map((pane) => ({ ...pane }))
  const total = () => out.reduce((sum, pane) => sum + charsIn(pane.lines), 0)

  // Least valuable first: oldest panes before newer ones, focused pane last.
  const order = out
    .map((pane, index) => ({ pane, index }))
    .sort((a, b) => {
      const aFocused = a.pane.id === focusedId ? 1 : 0
      const bFocused = b.pane.id === focusedId ? 1 : 0
      if (aFocused !== bFocused) return aFocused - bFocused
      return a.index - b.index
    })

  for (const { pane } of order) {
    if (total() <= maxCharsTotal) break
    if (!pane.lines || pane.lines.length <= 1) continue

    const excess = total() - maxCharsTotal
    let dropped = 0
    let cut = 0
    while (cut < pane.lines.length - 1 && dropped < excess) {
      dropped += pane.lines[cut].text.length
      cut += 1
    }
    pane.lines = pane.lines.slice(cut)
  }

  return out
}

function charsIn(lines: SavedLine[] | undefined): number {
  if (!lines) return 0
  let total = 0
  for (const line of lines) total += line.text.length
  return total
}
