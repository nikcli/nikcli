/**
 * The one disclosure grammar the session uses.
 *
 * Several surfaces carry more than a row of detail — a delegated run, a wake
 * message a background job queued, a pasted wall of text — and each used to
 * decide for itself whether to show all of it. The transcript ended up mixing
 * rows that were one line with rows that were thirty, and nothing told the
 * reader which was which or that anything could be done about it.
 *
 * So there is one rule and one mark. A surface shows its first line; if there
 * is more, the mark says so and a click reveals it. A surface that leads
 * somewhere better than its own detail — a subtask has a session to open —
 * shows `follow` instead, and the mark is the only thing that differs between
 * them.
 */
export const DISCLOSURE = {
  /** More detail here, hidden. */
  closed: "▸",
  /** Detail shown; click to put it away. */
  open: "▾",
  /** Not detail but a destination: this opens something. */
  follow: "→",
} as const

/**
 * Lines a body may occupy before collapsing is the better default.
 *
 * Six rather than one or two: a short message read in full is why the
 * transcript is worth reading at all, and collapsing those would trade the
 * reading for the scrolling. This is the height at which a body stops being
 * something you read in passing and starts being something you scroll past.
 */
export const DISCLOSURE_THRESHOLD = 6

/** The first non-empty line, which is what a collapsed body shows. */
export function summaryLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ""
}

/** Whether a body is long enough that hiding it serves the reader. */
export function worthCollapsing(text: string): boolean {
  return text.split("\n").length > DISCLOSURE_THRESHOLD
}
