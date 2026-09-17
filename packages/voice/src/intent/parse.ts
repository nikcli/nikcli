/**
 * Voice intent parsing and slot extraction for ADE in Italian.
 *
 * Normalizes spoken input, searches candidate trigger phrases using ADE's
 * subsequence fuzzyMatcher, extracts domain slots (pane indexes, pane titles,
 * paths, URLs, dictation text), and evaluates ambiguity and confidence.
 */

import { fuzzyMatch } from "@nikcli-ai/ade/command/match"
import type { AdeView, PaneSummary } from "../bridge/host"
import { normalizeUtterance } from "./normalize"
import { VOCABULARY, type VoiceIntentSpec } from "./vocabulary"

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Minimum confidence score [0.0 - 1.0] required for an utterance to be considered
 * a valid intent match. Utterances scoring below this threshold are marked
 * as 'unknown' to avoid executing unintended commands on the workbench.
 */
export const MATCH_CONFIDENCE_THRESHOLD = 0.58

/**
 * Minimum confidence separation between the top match and the runner-up.
 * If (topCandidate.confidence - runnerUp.confidence) < AMBIGUITY_MARGIN and
 * both are above threshold, the parse result is classified as 'ambiguous' so
 * the dialogue manager can ask the user for clarification.
 */
export const AMBIGUITY_MARGIN = 0.10

/**
 * Added to intents that accept a `url` slot when the utterance carried one.
 * Sized to break a tie without letting a bare address trigger navigation on its
 * own: an intent that matched nothing still ends below the threshold.
 */
export const URL_SLOT_BONUS = 0.2

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParseContext {
  /** List of currently open panes in ADE, used for pane title and index resolution. */
  panes?: PaneSummary[]
  /** True when an agent CLI is waiting for interactive permission confirmation. */
  pendingPermission?: boolean
  /** ID of the pane holding the pending permission, if known. */
  pendingPermissionPaneId?: string
  /** Currently focused pane ID in ADE. */
  focusedPaneId?: string
  /** Active view mode in ADE. */
  currentView?: AdeView
}

export interface CandidateMatch {
  intent: VoiceIntentSpec
  confidence: number
  matchedPhrase: string
}

export interface ParseResult {
  /** High-level classification of the recognition result. */
  outcome: "matched" | "ambiguous" | "unknown"
  /** The winning intent specification, present when outcome is 'matched' or 'ambiguous'. */
  intent?: VoiceIntentSpec
  /** Extracted slots (paneIndex, paneTitle, text, path, url, columns). */
  slots: Record<string, any>
  /** Confidence score between 0.0 and 1.0. */
  confidence: number
  /** Ranked list of alternative candidate matches above threshold. */
  candidates: CandidateMatch[]
  /** Original spoken utterance as passed to the parser. */
  rawUtterance: string
  /** Normalized representation used for pattern matching. */
  normalizedUtterance: string
}

// ---------------------------------------------------------------------------
// Slot extraction helpers
// ---------------------------------------------------------------------------

interface ExtractedSlots {
  slots: Record<string, any>
  cleanedText: string
}

function extractSlotsFromUtterance(
  normalized: string,
  ctx: ParseContext
): ExtractedSlots {
  const slots: Record<string, any> = {}
  let cleaned = normalized

  // 1. Columns extraction: e.g. "imposta 3 colonne", "colonne 4"
  const colMatch = cleaned.match(/\b(?:a|su)?\s*(\d+)\s+colonn[ea]\b/i) ||
                    cleaned.match(/\bcolonn[ea]\s+(\d+)\b/i)
  if (colMatch) {
    slots.columns = parseInt(colMatch[1], 10)
    cleaned = cleaned.replace(colMatch[0], "colonne").trim()
  }

  // 2. File path extraction: e.g. "apri file src/bridge/host.ts"
  //
  // Not after "cerca": "cerca file parser" is a search, and taking "parser"
  // as a path here left step 7 with no query, so the search ran on nothing.
  const fileMatch = cleaned.match(/(?<!\b(?:cerca|trova|ricerca)\s(?:(?:il|un|i|dei|del|lo)\s)?)\bfile\s+([^\s]+)/i)
  if (fileMatch) {
    slots.path = fileMatch[1]
    cleaned = cleaned.replace(fileMatch[0], "").replace(/\s+/g, " ").trim()
  }

  // 3. URL extraction: e.g. "http://localhost:3000", "localhost:5173", "www.example.com"
  const explicitUrl = cleaned.match(/\b(?:https?:\/\/[^\s]+|localhost:[0-9]+|www\.[^\s]+)\b/i)
  if (explicitUrl) {
    slots.url = explicitUrl[0]
    cleaned = cleaned.replace(explicitUrl[0], "").replace(/\s+/g, " ").trim()
  } else {
    const namedUrl = cleaned.match(/\b(?:indirizzo|sito|url)\s+([^\s]+)\b/i)
    if (namedUrl) {
      slots.url = namedUrl[1]
      cleaned = cleaned.replace(namedUrl[1], "").replace(/\s+/g, " ").trim()
    }
  }

  // 4. Pane index extraction: e.g. "pannello 2", "scheda 1", "sessione 3"
  // Italian puts the ordinal before the noun ("il terzo pannello") and the
  // cardinal after it ("pannello tre"). Both are normal speech, so both are read.
  const paneIdxMatch =
    cleaned.match(/\b(?:pannello|sessione|scheda)\s+(\d+)\b/i) ||
    cleaned.match(/\b(\d+)\s+(?:pannello|sessione|scheda)\b/i)
  if (paneIdxMatch) {
    slots.paneIndex = parseInt(paneIdxMatch[1], 10)
    cleaned = cleaned.replace(paneIdxMatch[0], "pannello").trim()
  } else {
    // Check if there is an isolated trailing number at the end
    const loneNumMatch = cleaned.match(/\b(\d+)\b$/)
    if (loneNumMatch) {
      slots.paneIndex = parseInt(loneNumMatch[1], 10)
      cleaned = cleaned.replace(loneNumMatch[0], "").trim()
    }
  }

  // 5. Pane title resolution using current context panes: e.g. "vai su Bastelli", "chiudi test runner"
  if (ctx.panes && ctx.panes.length > 0) {
    for (const pane of ctx.panes) {
      const normPaneTitle = normalizeUtterance(pane.title)
      if (normPaneTitle.length > 2) {
        const hit = fuzzyMatch(normPaneTitle, cleaned)
        if (hit && hit.score > 15) {
          slots.paneTitle = pane.title
          if (!slots.paneIndex) {
            slots.paneIndex = pane.index
          }
          cleaned = cleaned.replace(normPaneTitle, "").trim()
          break
        }
      }
    }
  }

  // 6. Dictation and prompt text extraction: e.g. "invia all'agente crea un componente"
  const promptMatch = cleaned.match(
    /\b(invia prompt|invia messaggio|detta compito|invia all agente|scrivi al pannello|manda compito|invia istruzione)\s+(.+)$/i
  )
  if (promptMatch) {
    slots.text = promptMatch[2].trim()
    cleaned = promptMatch[1].trim()
  }

  // 7. Search query extraction: e.g. "cerca nel progetto parseUtterance"
  const searchMatch = cleaned.match(
    /\b(cerca nel progetto|trova nel progetto|cerca (?:(?:il|un|i|dei|del|lo)\s)?file|ricerca nel progetto|trova simbolo)\s+(.+)$/i
  )
  if (searchMatch) {
    slots.text = searchMatch[2].trim()
    cleaned = searchMatch[1].trim()
  }

  // 8. Transcript scroll direction and 9. view target.
  //
  // Whole words only. A substring test reads "su" inside "succedendo" and
  // "sul", so "cosa sta succedendo" used to arrive carrying a scroll direction.
  // These slots are also only set when nothing has claimed `text` already:
  // dictation and search queries are the real content and must not be
  // overwritten by a word that happens to appear inside them.
  if (slots.text === undefined) {
    const word = (w: string) => new RegExp(`(^|\\s)${w}(\\s|$)`, "i").test(cleaned)

    /*
     * The three sections, plus the words people actually say for them.
     * "plancia" is kept as an alias for `code`: it was the name of that view
     * for the whole life of the app, and someone who says it means the grid.
     */
    if (word("agent") || word("agente") || word("assistente")) slots.text = "agent"
    else if (word("code") || word("codice") || word("terminali") || word("plancia")) slots.text = "code"
    else if (word("chat")) slots.text = "chat"
    else if (word("alberi")) slots.text = "alberi"
    else if (word("diff") || word("differenze")) slots.text = "diff"
    else if (word("trascrizione")) slots.text = "transcript"
    // «tema chiaro» names the theme it wants; without this it only flipped it.
    else if (word("chiaro") || word("chiara") || word("light")) slots.text = "light"
    else if (word("scuro") || word("scura") || word("dark")) slots.text = "dark"
    else if (/\b(scorri|scorrere|scrolla|sposta|risali|torna)\b/i.test(cleaned)) {
      // A direction only means a direction next to a verb of movement. Without
      // this guard "vai su Bastelli" arrives carrying a scroll instruction.
      if (word("su") || word("alto") || word("sopra")) slots.text = "up"
      else if (word("giu") || word("basso") || word("sotto")) slots.text = "down"
    }
  }

  return { slots, cleanedText: cleaned }
}

// ---------------------------------------------------------------------------
// Scoring and Matching
// ---------------------------------------------------------------------------

/**
 * Italian function words that speech adds freely and that carry no command
 * meaning: "chiudi **il** pannello" is the same order as "chiudi pannello".
 *
 * They are only ever ignored as *surplus* in the utterance. A trigger phrase is
 * still matched token for token, so "vai su" and "cerca nel progetto" — phrases
 * that are largely made of these words — keep working.
 */
const FILLER_TOKENS = new Set([
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una",
  "al", "allo", "alla", "ai", "agli", "alle",
  "del", "dello", "della", "dei", "degli", "delle",
  "questo", "questa", "quel", "quello", "quella",
  "mi", "ti", "ci", "si", "che", "e",
])

/** Cost applied to each content word of the utterance the phrase does not explain. */
const SURPLUS_TOKEN_PENALTY = 0.15

/** Shortest token for which a prefix match is trusted; below this, typos are indistinguishable. */
const MIN_PREFIX_LEN = 4

/**
 * Articulated prepositions collapsed to their bare form.
 *
 * Italian fuses preposition and article — "su" + "il" becomes "sul" — so a
 * phrase written "fuoco su pannello" never meets the "sul" a person actually
 * says. These are too short for the prefix rule to catch.
 */
const PREPOSITION_FORMS: Record<string, string> = {
  sul: "su", sullo: "su", sulla: "su", sui: "su", sugli: "su", sulle: "su",
  nel: "in", nello: "in", nella: "in", nei: "in", negli: "in", nelle: "in",
  dal: "da", dallo: "da", dalla: "da", dai: "da", dagli: "da", dalle: "da",
  col: "con", coi: "con",
}

/** True when an utterance token is the phrase token, allowing for speech-recognition slips. */
function tokensMatch(phraseToken: string, spokenRaw: string): boolean {
  const spoken = PREPOSITION_FORMS[spokenRaw] ?? spokenRaw
  if (phraseToken === spoken) return true

  const shorter = phraseToken.length <= spoken.length ? phraseToken : spoken
  const longer = shorter === phraseToken ? spoken : phraseToken
  if (shorter.length >= MIN_PREFIX_LEN && longer.startsWith(shorter)) return true

  // Speech recognition drops and swaps letters. fuzzyMatch tolerates that, but
  // only accept it when the two words are close in length — otherwise "su"
  // matches inside "successo" and every sentence hits every short phrase.
  if (shorter.length < MIN_PREFIX_LEN) return false
  if (shorter.length / longer.length < 0.75) return false
  return !!fuzzyMatch(shorter, longer)
}

/**
 * Score how well a spoken utterance matches one trigger phrase, in [0, 1].
 *
 * Token coverage rather than character similarity. An Italian voice command is
 * a verb plus a noun, and what decides the intent is whether *those words* are
 * present and in order — not how the two strings line up letter by letter. The
 * previous character-based formula normalised against a hand-reconstructed
 * maximum of `fuzzyMatch`'s internal scoring, which made short phrases score
 * absurdly high against long sentences: "chiudi il pannello due" resolved to
 * `pane.focus` instead of `pane.close`.
 */
function scoreUtteranceAgainstPhrase(utterance: string, phrase: string): number {
  if (utterance.length === 0 || phrase.length === 0) return 0.0
  if (utterance === phrase) return 1.0

  const spokenTokens = utterance.split(/\s+/).filter(Boolean)
  const phraseTokens = phrase.split(/\s+/).filter(Boolean)
  if (phraseTokens.length === 0 || spokenTokens.length === 0) return 0.0

  // Walk the phrase left to right, consuming utterance tokens in order. Order
  // matters: "apri il browser" and "browser apri" are not equally likely, and a
  // bag-of-words score would rate them the same.
  const consumed = new Set<number>()
  let matched = 0
  let cursor = 0

  for (const phraseToken of phraseTokens) {
    for (let i = cursor; i < spokenTokens.length; i++) {
      if (tokensMatch(phraseToken, spokenTokens[i])) {
        consumed.add(i)
        matched++
        cursor = i + 1
        break
      }
    }
  }

  const coverage = matched / phraseTokens.length
  if (coverage === 0) return 0.0

  // Every content word the phrase leaves unexplained is evidence the user meant
  // something else. Filler words are free — they are why this rewrite exists.
  let surplus = 0
  for (let i = 0; i < spokenTokens.length; i++) {
    if (consumed.has(i)) continue
    if (FILLER_TOKENS.has(spokenTokens[i])) continue
    surplus++
  }

  return Math.max(0, Math.min(1, coverage * (1 - SURPLUS_TOKEN_PENALTY * surplus)))
}

// ---------------------------------------------------------------------------
// Public Parser API
// ---------------------------------------------------------------------------

/**
 * Parse an Italian voice utterance against the ADE intent catalog.
 *
 * Reuses ADE's fuzzyMatch for subsequence and typo tolerance. Extracts slots,
 * considers context (e.g. pending permissions, pane titles), and reports
 * confidence and alternative candidates.
 */
export function parseUtterance(rawText: string, ctx: ParseContext = {}): ParseResult {
  const normalized = normalizeUtterance(rawText)

  if (normalized.length === 0) {
    return {
      outcome: "unknown",
      slots: {},
      confidence: 0.0,
      candidates: [],
      rawUtterance: rawText,
      normalizedUtterance: normalized,
    }
  }

  // 1. Context-aware short-circuits for confirmations
  if (ctx.pendingPermission) {
    if (
      normalized === "si" ||
      normalized === "conferma" ||
      normalized === "confermo" ||
      normalized === "consenti" ||
      normalized === "approva" ||
      normalized === "procedi"
    ) {
      const spec = VOCABULARY.find((v) => v.intent === "permission.allow")!
      return {
        outcome: "matched",
        intent: spec,
        slots: ctx.pendingPermissionPaneId ? { paneId: ctx.pendingPermissionPaneId } : {},
        confidence: 1.0,
        candidates: [{ intent: spec, confidence: 1.0, matchedPhrase: normalized }],
        rawUtterance: rawText,
        normalizedUtterance: normalized,
      }
    }

    if (
      normalized === "no" ||
      normalized === "annulla" ||
      normalized === "nega" ||
      normalized === "rifiuta" ||
      normalized === "blocca"
    ) {
      const spec = VOCABULARY.find((v) => v.intent === "permission.deny")!
      return {
        outcome: "matched",
        intent: spec,
        slots: ctx.pendingPermissionPaneId ? { paneId: ctx.pendingPermissionPaneId } : {},
        confidence: 1.0,
        candidates: [{ intent: spec, confidence: 1.0, matchedPhrase: normalized }],
        rawUtterance: rawText,
        normalizedUtterance: normalized,
      }
    }
  }

  // 2. Extract domain slots
  const { slots, cleanedText } = extractSlotsFromUtterance(normalized, ctx)

  // 3. Search and rank candidates across VOCABULARY
  const candidateList: CandidateMatch[] = []

  for (const spec of VOCABULARY) {
    let bestSpecConfidence = 0.0
    let bestMatchedPhrase = ""

    for (const phrase of spec.phrases) {
      const normPhrase = normalizeUtterance(phrase)

      // Compare against both normalized utterance and cleaned utterance
      const conf1 = scoreUtteranceAgainstPhrase(normalized, normPhrase)
      const conf2 = scoreUtteranceAgainstPhrase(cleanedText, normPhrase)
      let conf = Math.max(conf1, conf2)

      // An address in the utterance is strong evidence on its own. "vai su
      // localhost:3000" and "vai su Bastelli" are the same words; only the
      // extracted url separates navigating from focusing a pane.
      if (slots.url !== undefined && spec.slots.includes("url")) {
        conf = Math.min(1, conf + URL_SLOT_BONUS)
      }

      if (conf > bestSpecConfidence) {
        bestSpecConfidence = conf
        bestMatchedPhrase = phrase
      }
    }

    if (bestSpecConfidence >= MATCH_CONFIDENCE_THRESHOLD) {
      candidateList.push({
        intent: spec,
        confidence: bestSpecConfidence,
        matchedPhrase: bestMatchedPhrase,
      })
    }
  }

  // Sort candidates by confidence descending
  candidateList.sort((a, b) => b.confidence - a.confidence)

  // 4. Evaluate outcome
  if (candidateList.length === 0) {
    return {
      outcome: "unknown",
      slots,
      confidence: 0.0,
      candidates: [],
      rawUtterance: rawText,
      normalizedUtterance: normalized,
    }
  }

  const top = candidateList[0]

  if (candidateList.length > 1) {
    const runnerUp = candidateList[1]
    if (
      top.confidence - runnerUp.confidence < AMBIGUITY_MARGIN &&
      top.intent.intent !== runnerUp.intent.intent
    ) {
      return {
        outcome: "ambiguous",
        intent: top.intent,
        slots,
        confidence: top.confidence,
        candidates: candidateList,
        rawUtterance: rawText,
        normalizedUtterance: normalized,
      }
    }
  }

  return {
    outcome: "matched",
    intent: top.intent,
    slots,
    confidence: top.confidence,
    candidates: candidateList,
    rawUtterance: rawText,
    normalizedUtterance: normalized,
  }
}
