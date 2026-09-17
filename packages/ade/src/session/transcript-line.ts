/**
 * What is worth keeping in a session's transcript.
 *
 * The transcript is the second reading of the pty, and it is the only one that
 * survives the app closing: while a session is live the pane shows a real
 * terminal, so nobody looks at these lines, and the moment anybody does — a
 * restored session, whose process is gone and whose terminal went with it —
 * they are all there is. That asymmetry is why this was never noticed.
 *
 * What a full-screen agent actually writes is frames. It positions the cursor,
 * paints a border, paints a spinner, positions the cursor again. `stripAnsi`
 * removes the positioning, correctly, and what is left of a frame is its
 * glyphs with nothing to place them: a row of box-drawing characters, a
 * thousand braille spinner frames run together, a banner flattened into one
 * line. None of it is anything the agent said.
 *
 * So this module answers one question per line — is there a word in it — and
 * nothing else. It does not try to reconstruct the screen: that is what the
 * terminal emulator in the pane is for, and it cannot be done from lines that
 * have already lost their cursor moves.
 *
 * Pure, in a `.ts`, because a `.tsx` cannot be imported under `bun test` here.
 */

/**
 * How long a transcript line may be.
 *
 * A real line of agent output is a sentence or a path. Anything past this is a
 * frame that lost its line breaks — the saved state held single "lines" of
 * several thousand characters, which is also how a 46-line transcript came to
 * occupy 29 KB of `localStorage`.
 */
export const MAX_TRANSCRIPT_LINE = 400

/** Appended where a line was cut, so the loss is visible rather than implied. */
export const TRUNCATION_MARK = "…"

/*
 * Characters that draw rather than say.
 *
 * Box drawing, block elements, geometric shapes, and the braille range every
 * spinner in every CLI is built from. A line made only of these and whitespace
 * is a piece of a frame.
 */
const DRAWING_ONLY = /^[\s─-▟■-◿⠀-⣿←-⇿·•.\-=_~+|/\\]*$/u

/** C0 controls that survive stripping, minus tab. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g

/**
 * The line to show, or nothing when it carries no information.
 *
 * Returning `undefined` rather than an empty string is deliberate: a blank
 * transcript row and a dropped one look the same on screen but not in the
 * list, and the caller has to be able to tell "keep, it is blank" from "do
 * not keep at all".
 */
export function cleanTranscriptLine(raw: string): string | undefined {
  // Frames are padded to the terminal's width, which is where most of the
  // saved bytes went; the padding is never meaningful.
  const text = raw.replace(CONTROLS, "").replace(/\s+$/u, "")
  if (text.trim().length === 0) return undefined
  if (DRAWING_ONLY.test(text)) return undefined

  return text.length > MAX_TRANSCRIPT_LINE
    ? text.slice(0, MAX_TRANSCRIPT_LINE - TRUNCATION_MARK.length) + TRUNCATION_MARK
    : text
}

/**
 * Cleans a whole saved transcript, dropping what is left of the frames.
 *
 * Used on restore as well as on capture, because the transcripts already in
 * `localStorage` were written before any of this existed and are exactly the
 * ones the user is looking at.
 */
export function cleanTranscript<T extends { text: string }>(lines: readonly T[]): T[] {
  const out: T[] = []
  for (const line of lines) {
    const text = cleanTranscriptLine(line.text)
    if (text === undefined) continue
    /*
     * A frame redrawn ten times produces ten identical lines. Collapsing them
     * against the previous one is enough — they arrive consecutively, and
     * comparing against the whole transcript would remove a command the user
     * genuinely ran twice.
     */
    const previous = out.at(-1)
    if (previous?.text === text) continue
    out.push(text === line.text ? line : { ...line, text })
  }
  return out
}
