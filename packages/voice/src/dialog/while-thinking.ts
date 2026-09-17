/**
 * What a sentence heard while the assistant is still thinking should do.
 *
 * A new sentence used to stop the turn whatever it was, and with the mic open
 * that includes the television, whose sentences are long and which the
 * recogniser transcribes with full confidence. So neither length nor
 * confidence can tell it apart; what can is whether the sentence is one the
 * user gives on purpose. Only two things end a turn now: a stop word, and a
 * command the grammar knows. A free sentence is held — shown, and sent only
 * if the user asks for it — and a filler is simply left where it was heard.
 *
 * Typed text is always meant: nobody types the television.
 */

import { normalizeAccents } from "../intent/normalize"
import type { ParseResult } from "../intent/parse"

export type WhileThinking = { action: "stop" } | { action: "request" } | { action: "hold" } | { action: "ignore" }

/*
 * The stop word, and what people add to it: «annulla la richiesta», «fermati
 * pure», «basta così nik». Only those additions — an open tail would make
 * «basta con le tasse» from the television a stop.
 */
const STOP =
  /^(?:annulla|stop|basta|fermati|ferma|smetti|interrompi|lascia (?:stare|perdere))(?: (?:(?:la|questa|quella|l) )?(?:richiesta|domanda|risposta|ricerca)| tutto| pure| cosi| subito| grazie| per favore| adesso| ora| nik| stop)*$/

/* Sounds people make while listening; held, they would push a real sentence out. */
const FILLER = /^(?:ok(?:ay)?|si|no|mh+|m+|eh+|ah+|uh+|ehm|boh|gia|vabb?e|va bene|grazie|certo|perfetto|bene|ciao)$/

const NOT_COMMANDS = new Set(["dialog.confirm", "dialog.cancel", "dialog.repeat", "dictation.finish"])

/** «invia questa»: send the sentence held while thinking. */
const SEND_HELD = /^(?:invia|manda|mandala|inviala)(?: (?:questa|quella|questa frase|la frase))?$/

/** What was said, lowercased, without accents or punctuation. */
function plain(raw: string): string {
  return normalizeAccents(raw.toLowerCase())
    .replace(/[.,;:!?…"«»]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function isSendHeld(raw: string): boolean {
  const text = plain(raw)
  // A bare «invia» belongs to dictation; this needs the object, or the pronoun.
  return SEND_HELD.test(text) && text !== "invia" && text !== "manda"
}

/** The first words of a sentence, for a line that names it without quoting the room. */
export function firstWords(text: string, limit = 48): string {
  const clean = text.trim().replace(/\s+/g, " ")
  if (clean.length <= limit) return clean
  const cut = clean.slice(0, limit)
  const space = cut.lastIndexOf(" ")
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trim()}…`
}

export function triageWhileThinking(
  parsed: ParseResult,
  heard: {
    typed: boolean
    /**
     * Whether the sentence called the assistant by name, when the name is
     * being asked for. A command is an action — «chiudi il pannello due» from
     * a video would close a session — so while a turn is running it is obeyed
     * only when it was addressed to the assistant. Stopping is the exception
     * below: it undoes rather than does, and it is what someone says when
     * they need it now.
     */
    named?: boolean
  },
): WhileThinking {
  const text = plain(parsed.rawUtterance)
  const intent = parsed.outcome === "matched" ? parsed.intent?.intent : undefined

  if (STOP.test(text)) return { action: "stop" }
  if (heard.typed) return intent === "dialog.cancel" ? { action: "stop" } : { action: "request" }
  if (intent && !NOT_COMMANDS.has(intent)) return heard.named === false ? { action: "hold" } : { action: "request" }
  if (text.length === 0 || FILLER.test(text)) return { action: "ignore" }
  return { action: "hold" }
}
