/**
 * Italian utterance normalization for voice intent matching.
 *
 * Transforms spoken Italian transcripts into a clean canonical string:
 * - Lowercase and whitespace normalization
 * - Strip punctuation while preserving path characters (/, ., :) inside tokens
 * - Normalize diacritics / accents into a stable form (e.g. "perché" / "perche'" -> "perche")
 * - Remove conversational filler words ("ehm", "cioè", "per favore", "dai", "allora")
 * - Convert words representing cardinal numbers (0-50) and ordinals (1st-20th) to numeric digits
 *
 * All functions are pure with zero side-effects.
 */

const FILLER_PHRASES: readonly string[] = ["per favore", "per piacere", "per cortesia"]

const FILLER_WORDS: readonly string[] = ["ehm", "uhm", "em", "um", "cioe", "dai", "allora", "dunque"]

const ORDINALS_MAP: Readonly<Record<string, number>> = {
  primo: 1,
  prima: 1,
  secondo: 2,
  seconda: 2,
  terzo: 3,
  terza: 3,
  quarto: 4,
  quarta: 4,
  quinto: 5,
  quinta: 5,
  sesto: 6,
  sesta: 6,
  settimo: 7,
  settima: 7,
  ottavo: 8,
  ottava: 8,
  nono: 9,
  nona: 9,
  decimo: 10,
  decima: 10,
  undicesimo: 11,
  undicesima: 11,
  dodicesimo: 12,
  dodicesima: 12,
  tredicesimo: 13,
  tredicesima: 13,
  quattordicesimo: 14,
  quattordicesima: 14,
  quindicesimo: 15,
  quindicesima: 15,
  sedicesimo: 16,
  sedicesima: 16,
  diciassettesimo: 17,
  diciassettesima: 17,
  diciottesimo: 18,
  diciottesima: 18,
  diciannovesimo: 19,
  diciannovesima: 19,
  ventesimo: 20,
  ventesima: 20,
}

const CARDINALS_MAP: Readonly<Record<string, number>> = {
  zero: 0,
  uno: 1,
  due: 2,
  tre: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
  undici: 11,
  dodici: 12,
  tredici: 13,
  quattordici: 14,
  quindici: 15,
  sedici: 16,
  diciassette: 17,
  diciotto: 18,
  diciannove: 19,
  venti: 20,
  ventuno: 21,
  ventidue: 22,
  ventitre: 23,
  ventiquattro: 24,
  venticinque: 25,
  ventisei: 26,
  ventisette: 27,
  ventotto: 28,
  ventinove: 29,
  trenta: 30,
  trentuno: 31,
  trentadue: 32,
  trentatre: 33,
  trentaquattro: 34,
  trentacinque: 35,
  trentasei: 36,
  trentasette: 37,
  trentotto: 38,
  trentanove: 39,
  quaranta: 40,
  quarantuno: 41,
  quarantadue: 42,
  quarantatre: 43,
  quarantaquattro: 44,
  quarantacinque: 45,
  quarantasei: 46,
  quarantasette: 47,
  quarantotto: 48,
  quarantanove: 49,
  cinquanta: 50,
}

/**
 * Normalizes accents and apostrophes to a canonical unaccented form.
 * e.g. "perché" -> "perche", "cioè" -> "cioe", "e'" -> "e", "sì" -> "si"
 */
export function normalizeAccents(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([aeiou])['’]/gi, "$1")
}

/**
 * Replaces Italian numbers written in words (both cardinal and ordinal)
 * with their decimal string representations.
 */
export function wordsToNumbers(text: string): string {
  const tokens = text.split(/\s+/)
  const converted = tokens.map((token) => {
    const clean = token.toLowerCase()
    if (ORDINALS_MAP[clean] !== undefined) {
      return String(ORDINALS_MAP[clean])
    }
    if (CARDINALS_MAP[clean] !== undefined) {
      return String(CARDINALS_MAP[clean])
    }
    return token
  })
  return converted.join(" ")
}

/**
 * Strips conversational filler phrases and isolated filler words.
 */
export function stripFillers(text: string): string {
  let cleaned = text

  for (const phrase of FILLER_PHRASES) {
    const regex = new RegExp(`\\b${phrase}\\b`, "gi")
    cleaned = cleaned.replace(regex, " ")
  }

  for (const word of FILLER_WORDS) {
    const regex = new RegExp(`\\b${word}\\b`, "gi")
    cleaned = cleaned.replace(regex, " ")
  }

  return cleaned.replace(/\s+/g, " ").trim()
}

/**
 * Primary normalization entrypoint.
 *
 * Turns arbitrary Italian user speech into a clean, predictable string
 * ready for fuzzy matching against vocabulary patterns.
 */
export function normalizeUtterance(raw: string): string {
  if (!raw || raw.trim().length === 0) return ""

  // 1. Lowercase and trim
  let text = raw.toLowerCase().trim()

  // 2. Canonical accent and diacritic folding
  text = normalizeAccents(text)

  // 3. Remove quotes and sentence apostrophes
  text = text.replace(/["“”'’`]/g, " ")

  // 4. Remove sentence punctuation (commas, exclamation, question marks, brackets)
  text = text.replace(/[,?!;()«»"—–~#$%\^&*]/g, " ")

  // 5. Remove trailing periods or colons (preserving intra-token . and : like host.ts or http://)
  text = text.replace(/(?:^|\s)\.+(?:\s|$)/g, " ")
  text = text.replace(/\.+(\s|$)/g, "$1")
  text = text.replace(/:+(\s|$)/g, "$1")

  // 6. Strip conversational fillers
  text = stripFillers(text)

  // 7. Convert written words to numeric digits
  text = wordsToNumbers(text)

  // 8. Compact extra whitespace
  return text.replace(/\s+/g, " ").trim()
}
