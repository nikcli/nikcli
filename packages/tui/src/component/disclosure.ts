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

/**
 * Rows a body will occupy, counting the wrap.
 *
 * Counting newlines was not the same question. A pasted blob with no line
 * breaks at all is one "line" and thirty rows on screen, and it was the one
 * shape the rule let through — the shape most worth collapsing. Same arithmetic
 * as `estimateTurnHeight`: hard breaks, then width.
 */
export function bodyRows(text: string, columns: number): number {
  const width = Math.max(1, Math.floor(columns) || 1)
  let rows = 0
  for (const line of text.split("\n")) rows += Math.max(1, Math.ceil(line.length / width))
  return rows
}

/** Whether a body is tall enough that hiding it serves the reader. */
export function worthCollapsing(text: string, columns: number): boolean {
  return bodyRows(text, columns) > DISCLOSURE_THRESHOLD
}

/**
 * Rows hidden behind the mark.
 *
 * Measured from the summary line rather than from the top, because leading
 * blanks are not something the reader is being offered — machine-written bodies
 * usually start with some.
 */
export function hiddenRows(text: string, columns: number): number {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.trim().length > 0)
  if (start < 0) return 0
  return Math.max(0, bodyRows(lines.slice(start).join("\n"), columns) - 1)
}

/**
 * The word beside an open mark. One word, everywhere.
 *
 * It was "collapse" on a message and "less" on three tool views, which is two
 * vocabularies for the one thing a reader does most often.
 */
export const LESS = "less"

/**
 * The label beside a closed mark: how much is behind it, and of what.
 *
 * `N more rows`, `N more lines`, or just `N more` where the unit is obvious
 * from what is above it. A count with no noun reads as "three more of these",
 * which is exactly right for a list and wrong for a body — hence the noun.
 */
export function more(count: number, noun?: string): string {
  return noun ? `${count} more ${noun}` : `${count} more`
}
