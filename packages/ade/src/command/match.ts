/**
 * Subsequence fuzzy matching for the command palette.
 *
 * The scoring is tuned for short queries against short titles — the kind a
 * palette sees — not for file search or full-text retrieval. What matters most
 * is that "nse" sorts "Nuova Sessione" above "inserisci_segnalibro", because
 * the first hits two word boundaries and the second scatters across the middle.
 *
 * The algorithm is a single left-to-right greedy scan with look-ahead for word
 * boundaries. A DP approach would find the *optimal* alignment, but the greedy
 * version is fast enough to run on every keystroke without debouncing, and the
 * scoring heuristics matter more than global optimality at these lengths.
 */

export interface FuzzyResult {
  /** Higher is better. Comparable across calls with the same query. */
  score: number
  /**
   * Character ranges that matched, as `[start, end)` pairs.
   * Non-overlapping, ascending. Ready for highlight rendering.
   */
  ranges: [number, number][]
}

/** True when `c` starts a word: after a space, underscore, hyphen, or a case transition. */
function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]
  if (prev === " " || prev === "_" || prev === "-" || prev === "/") return true
  // camelCase boundary: lowercase followed by uppercase
  const cur = text[i]
  if (prev >= "a" && prev <= "z" && cur >= "A" && cur <= "Z") return true
  return false
}

/**
 * Try to match `query` as a subsequence of `text`, case-insensitively.
 *
 * Returns `undefined` when the subsequence is not found. An empty query
 * matches everything with a neutral score and no highlighted ranges — the
 * palette should show all commands when the input is blank.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | undefined {
  if (query.length === 0) {
    return { score: 0, ranges: [] }
  }

  if (query.length > text.length) return undefined

  const lowerQuery = query.toLowerCase()
  const lowerText = text.toLowerCase()

  // --- First pass: find the matched character indices ---
  // Greedy with word-boundary preference: at each query character, scan ahead
  // for a word-start hit before settling for the first available position.
  const indices: number[] = []
  let textPos = 0

  for (let qi = 0; qi < lowerQuery.length; qi++) {
    const qc = lowerQuery[qi]
    // Find the first available match
    let firstMatch = -1
    let wordMatch = -1

    for (let ti = textPos; ti < lowerText.length; ti++) {
      if (lowerText[ti] === qc) {
        if (firstMatch === -1) firstMatch = ti
        if (isWordStart(text, ti)) {
          wordMatch = ti
          break
        }
        // Don't look too far ahead — a distant word hit is worse than a close
        // non-word hit because the gap penalty would eat the bonus.
        if (ti - firstMatch > 8) break
      }
    }

    const chosen = wordMatch !== -1 ? wordMatch : firstMatch
    if (chosen === -1) return undefined

    indices.push(chosen)
    textPos = chosen + 1
  }

  // --- Scoring ---
  let score = 0
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]

    // Word-boundary bonus: the hit sits where the eye scans first.
    if (isWordStart(text, idx)) score += 10

    // Consecutive bonus: characters in a run read as a substring match.
    if (i > 0 && idx === indices[i - 1] + 1) score += 5

    // Gap penalty: each skipped character between consecutive hits costs a
    // point. The penalty is light so that a word-boundary hit at distance 4
    // still beats a non-boundary hit at distance 0.
    if (i > 0) {
      const gap = idx - indices[i - 1] - 1
      score -= gap
    }
  }

  // Length bonus: matching a larger fraction of the text is better.
  score += (indices.length / text.length) * 5

  // --- Build highlight ranges by merging consecutive indices ---
  const ranges: [number, number][] = []
  let rangeStart = indices[0]
  let rangeEnd = indices[0] + 1

  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === rangeEnd) {
      rangeEnd++
    } else {
      ranges.push([rangeStart, rangeEnd])
      rangeStart = indices[i]
      rangeEnd = indices[i] + 1
    }
  }
  ranges.push([rangeStart, rangeEnd])

  return { score, ranges }
}
