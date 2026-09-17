/**
 * Repairing the words a speech model has never heard.
 *
 * Every ASR model decodes into the vocabulary it was trained on, and the words
 * that matter most here are not in it: "nikcli", "opencode", "worktree",
 * "codex", "tauri", "xterm". They come back split ("open code"), respelled
 * ("nick cli"), or translated ("codice" for "codex") — and the result is
 * dictated into a coding agent's prompt, where a wrong identifier is not a
 * typo but a wrong instruction.
 *
 * The approach is the one Handy ships: a user-held list of words, and a
 * similarity threshold below which a spoken fragment is replaced by the word
 * it was almost certainly meant to be. What makes it work on the split case is
 * that comparison happens on a normalised form with the spaces removed, so
 * "open code" and "opencode" are the same string, not a near miss.
 *
 * Everything here is pure: the same text, words and threshold give the same
 * answer, with no model, no clock and no I/O.
 */

/**
 * How different a fragment may be and still be corrected, as a fraction of
 * the target word's length. Handy's default, and conservative on purpose:
 * at 0.18 a six-letter word tolerates one edit and a four-letter word
 * tolerates none, so short common words are never rewritten into jargon.
 */
export const DEFAULT_WORD_CORRECTION_THRESHOLD = 0.18

/**
 * How many consecutive spoken tokens may be joined into one candidate.
 *
 * Three, because that is what the splits actually look like: "open code",
 * "nick c l i", "work tree". Wider windows start matching whole phrases to
 * short words and cost quadratically more comparisons.
 */
const MAX_WINDOW = 3

/**
 * Strips a token to what the comparison is about: letters and digits, lower
 * case, accents folded. Punctuation and spacing are exactly the things the
 * model guesses at, so they must not count as differences.
 */
export function normalizeForMatch(text: string): string {
  // NFD splits "è" into "e" plus a combining mark, and the class below drops
  // the mark along with the punctuation — so no separate diacritic pass, and
  // no literal combining characters in this file to be mangled by an editor.
  return text
    .normalize("NFD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

/**
 * Levenshtein distance, two rows rather than a full matrix.
 *
 * Bounded by `limit`: once every cell in a row exceeds it the answer can only
 * grow, so the remaining rows are not worth computing. Candidates are rejected
 * far more often than accepted, and this makes rejection cheap.
 */
export function editDistance(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  if (Math.abs(a.length - b.length) > limit) return limit + 1

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  let current = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    let best = current[0]
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution)
      if (current[j] < best) best = current[j]
    }
    if (best > limit) return limit + 1
    const swap = previous
    previous = current
    current = swap
  }

  return previous[b.length]
}

export interface CustomWordCorrection {
  /** The spoken text that was replaced, as it appeared. */
  readonly heard: string
  /** The custom word it was replaced with, spelled as the user wrote it. */
  readonly wrote: string
}

export interface CustomWordResult {
  /** The transcript with every confident correction applied. */
  readonly text: string
  /** What was changed, in order, so the interface can say so. */
  readonly corrections: readonly CustomWordCorrection[]
}

interface Candidate {
  readonly word: string
  readonly normalized: string
}

/**
 * Rewrites a transcript so the user's own vocabulary comes out spelled right.
 *
 * Greedy and left-to-right: at each position the longest window that matches
 * some custom word closely enough wins, and the scan continues after it. A
 * window is preferred over a shorter one at the same position because the
 * splits are the case this exists for — matching "open" alone would leave a
 * stray "code" behind.
 *
 * Whitespace between tokens is preserved as it was found, so a transcript that
 * arrived with newlines keeps them.
 */
export function correctCustomWords(
  text: string,
  words: readonly string[],
  threshold: number = DEFAULT_WORD_CORRECTION_THRESHOLD,
): CustomWordResult {
  const candidates: Candidate[] = []
  for (const word of words) {
    const normalized = normalizeForMatch(word)
    // A word with nothing comparable in it ("...", "—") would match every
    // empty window, so it is not a candidate for anything.
    if (normalized.length === 0) continue
    candidates.push({ word: word.trim(), normalized })
  }
  if (candidates.length === 0 || text.length === 0) return { text, corrections: [] }

  // Tokens and the gaps between them, kept separate so the gaps survive.
  const pieces = text.split(/(\s+)/)
  const tokenIndices: number[] = []
  for (let i = 0; i < pieces.length; i += 1) {
    if (pieces[i].length > 0 && !/^\s+$/.test(pieces[i])) tokenIndices.push(i)
  }

  const corrections: CustomWordCorrection[] = []
  const out = [...pieces]
  let cursor = 0

  while (cursor < tokenIndices.length) {
    /*
     * Every window at this position is scored, and the *closest* match wins —
     * not the widest one that merely passes.
     *
     * Taking the widest passing window ate the word after a correction: in
     * "apri open code e poi", the three-token window "open code e" normalises
     * to "opencodee", which is one edit from "opencode" and therefore inside
     * the threshold, so "e" disappeared into the replacement. Scoring first
     * makes the exact two-token match beat it. Ties go to the wider window,
     * which is what recovers a split without leaving a fragment behind.
     */
    let choice: { size: number; heard: string; word: string; distance: number } | undefined

    for (let size = 1; size <= Math.min(MAX_WINDOW, tokenIndices.length - cursor); size += 1) {
      const first = tokenIndices[cursor]
      const last = tokenIndices[cursor + size - 1]
      const heard = pieces.slice(first, last + 1).join("")
      const normalized = normalizeForMatch(heard)
      if (normalized.length === 0) continue

      const match = closestWord(normalized, candidates, threshold)
      if (!match) continue
      if (!choice || match.distance <= choice.distance) {
        choice = { size, heard, word: match.word, distance: match.distance }
      }
    }

    if (!choice) {
      cursor += 1
      continue
    }

    const first = tokenIndices[cursor]
    const last = tokenIndices[cursor + choice.size - 1]

    // Already spelled the way the user writes it: nothing to report, and
    // nothing to change. Consuming the window anyway means a word that is
    // already right is not then re-examined piece by piece.
    if (choice.heard !== choice.word) {
      corrections.push({ heard: choice.heard, wrote: choice.word })
      out[first] = choice.word
      for (let i = first + 1; i <= last; i += 1) out[i] = ""
    }

    cursor += choice.size
  }

  return { text: out.join(""), corrections }
}

/**
 * The custom word closest to a normalised fragment, or undefined when none is
 * close enough. Distance is scored against the *word's* length rather than the
 * fragment's, so padding a fragment with extra syllables cannot buy tolerance.
 */
function closestWord(
  normalized: string,
  candidates: readonly Candidate[],
  threshold: number,
): { word: string; distance: number } | undefined {
  let best: { word: string; distance: number } | undefined

  for (const candidate of candidates) {
    const allowed = Math.floor(candidate.normalized.length * threshold)
    const distance = editDistance(normalized, candidate.normalized, allowed)
    if (distance > allowed) continue
    if (!best || distance < best.distance) best = { word: candidate.word, distance }
    if (distance === 0) break
  }

  return best
}
