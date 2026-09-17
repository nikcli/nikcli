/**
 * Text on its way into a pseudo-terminal.
 *
 * Whatever ADE types on the user's behalf reaches the agent as keystrokes, and
 * a terminal in canonical mode submits a line the moment it sees a carriage
 * return: ICRNL maps CR to NL before the program ever reads it. So a string
 * with a CR in the middle is not one message that happens to wrap. It is two
 * things typed, and the user only ever saw the first.
 *
 * That matters because the text is not always the user's. The browser pane
 * builds its prompt out of attributes read from a page it did not write, and a
 * page that answered with a carriage return inside a style property was writing
 * the second half straight into an agent's stdin, to be submitted by the same
 * keypress that sent the first.
 *
 * Kept as its own module, and as plain `.ts`, so the rule lives in one place
 * and can be tested without mounting anything.
 */

/**
 * Everything a terminal or a line discipline can read as "the line ends here",
 * collapsed to a single space.
 *
 * Beyond CR and LF: vertical tab and form feed are submitted on by some
 * readline implementations, U+0085 is the single-character newline of the C1
 * set, and U+2028 / U+2029 are line breaks that a JavaScript-side split would
 * honour even where a tty would not.
 *
 * Built from a string rather than written as a literal so the file itself
 * holds no invisible control characters: a regex whose character class you
 * cannot read is one nobody can review.
 */
const LINE_BREAKS = new RegExp("[\\r\\n\\v\\f\\u0085\\u2028\\u2029]+", "g")

/** `text` with every line break turned into a space, ready to be typed. */
export function asOneLine(text: string): string {
  return text.replace(LINE_BREAKS, " ")
}

/**
 * `text` as a single line, terminated so the agent actually receives it.
 *
 * The terminator is not decoration: without it the characters sit in the
 * agent's input buffer, unread, while ADE's own interface moves on and reports
 * the message as sent.
 */
export function asSubmittedLine(text: string): string {
  return `${asOneLine(text)}\r`
}

/** How long a TUI must stay quiet after taking in a paste before Enter is a keystroke. */
export const PASTE_QUIET_MS = 300
/** Enter goes anyway after this long: a session drawing a spinner is never quiet. */
export const PASTE_SETTLE_MAX_MS = 8000

/**
 * Whether a bracketed paste has been taken in, so the Enter after it submits.
 *
 * A fixed wait is wrong both ways. Under ConPTY, codex and agy take in a long
 * paste slowly and say nothing until they have: 1,500 characters were still
 * arriving after 600 ms, and the Enter folded into the paste, leaving the text
 * in the input box. A short line is drawn at once. So the Enter waits for the
 * program to redraw after the paste, then for that redraw to go quiet.
 */
export function pasteSettled(input: { typedAt: number; lastOutputAt?: number; now: number }): boolean {
  const { typedAt, lastOutputAt, now } = input
  if (now - typedAt >= PASTE_SETTLE_MAX_MS) return true
  return lastOutputAt !== undefined && lastOutputAt > typedAt && now - lastOutputAt >= PASTE_QUIET_MS
}
