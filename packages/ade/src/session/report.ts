/**
 * Resoconto sessione: legge token, costo, modello e attività corrente
 * dall'output dell'agente.
 *
 * Gli agenti CLI stampano i propri consumi nel transcript — "↓ 5.4k tokens",
 * "$0.42", "Ragionando…" — mescolati a tutto il resto. Questo modulo guarda
 * ogni riga nuova e accumula i numeri utili in un `SessionReport` corrente,
 * ignorando tutto ciò che non riconosce.
 *
 * Il parsing è volutamente conservativo: una riga non riconosciuta restituisce
 * il resoconto immutato, perché la maggior parte delle righe non dice niente e
 * un'ipotesi sbagliata è peggiore di un numero mancante. I contatori possono
 * solo avanzare: un flush parziale che ripete un valore più piccolo di quello
 * già noto viene scartato invece di far regredire il resoconto.
 */

import { stripAnsi } from "./stream"

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------

export interface SessionReport {
  /** Token totali consumati finora, se l'agente li ha detti. */
  tokens?: number
  /** Costo in dollari, se l'agente lo ha detto. */
  costUsd?: number
  /** Cosa sta facendo adesso, in una riga breve. */
  activity?: string
  /** Nome del modello in uso, se dichiarato. */
  model?: string
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/**
 * Numero + moltiplicatore opzionale + unità "token(s)".
 *
 * Il separatore (`.` o `,`) è accettato solo davanti a un moltiplicatore:
 * lì è sempre decimale ("3,4k" = 3400, non 34000). Senza moltiplicatore un
 * numero con separatore è ambiguo (decimale all'italiana o migliaia
 * all'inglese) e viene scartato invece che indovinato.
 */
const TOKEN_RE = /\b(\d+)(?:([.,])(\d+))?\s*([km])?\s*tokens?\b/i

const MULTIPLIER: Record<string, number> = { k: 1_000, m: 1_000_000 }

/** Primo conteggio di token nella riga, oppure `undefined` se non c'è. */
function parseTokens(line: string): number | undefined {
  const match = TOKEN_RE.exec(line)
  if (!match) return undefined

  const [, integer, separator, fraction, multiplier] = match

  // Separatore senza moltiplicatore: non si può sapere se è decimale o di
  // migliaia. Meglio niente che un numero sbagliato.
  if (separator && !multiplier) return undefined

  if (!separator) {
    const base = Number.parseInt(integer, 10)
    return multiplier ? base * MULTIPLIER[multiplier.toLowerCase()] : base
  }

  const decimal = Number.parseFloat(`${integer}.${fraction}`)
  return Math.round(decimal * MULTIPLIER[(multiplier ?? "").toLowerCase()])
}

// ---------------------------------------------------------------------------
// Costo
// ---------------------------------------------------------------------------

/**
 * Due ancore, entrambe con unità esplicita: simbolo `$` attaccato al numero,
 * oppure suffisso `USD`/`dollari`. Un numero senza una delle due non è un
 * costo — dimensioni di file e percentuali restano fuori.
 *
 * `$` attaccato a una cifra non basta però, ed è il punto:
 * `awk '{print $2}'`, `echo $1`, `cut -f $3` sono normalissimi nell'output di
 * un agente, e ognuno impostava il costo della sessione — `$2` diventava
 * «2,00 $». Il contatore è monotono, quindi il numero restava lì per tutta la
 * sessione, e non c'era modo di distinguerlo da una spesa vera.
 *
 * Quindi il simbolo da solo non basta più: o ci sono i decimali — nessuno
 * scrive `$2.50` per un parametro posizionale — oppure l'unità è scritta per
 * esteso. Un `$5` tondo e isolato viene perso, ed è la direzione giusta: un
 * costo mancato si nota guardando il pannello, uno inventato resta lì
 * indistinguibile da una spesa vera per tutta la sessione.
 */
const COST_DOLLAR_RE = /\$\s?(\d+[.,]\d+)/
const COST_USD_RE = /\b(\d+(?:[.,]\d+)?)\s*(?:usd|dollari)\b/i

/** Primo costo in dollari nella riga, oppure `undefined` se non c'è. */
function parseCost(line: string): number | undefined {
  const dollar = COST_DOLLAR_RE.exec(line)
  if (dollar) return parseDecimal(dollar[1])

  const usd = COST_USD_RE.exec(line)
  if (usd) return parseDecimal(usd[1])

  return undefined
}

/** `"0,18"` / `"1.05"` → numero; il separatore singolo è sempre decimale. */
function parseDecimal(raw: string): number {
  return Number.parseFloat(raw.replace(",", "."))
}

// ---------------------------------------------------------------------------
// Modello
// ---------------------------------------------------------------------------

const MODEL_RE = /\bmodel\s*[=:]\s*([A-Za-z][A-Za-z0-9._/-]*)/i

/**
 * Nome del modello dichiarato dalla riga, oppure `undefined`.
 *
 * Il nome deve contenere almeno un trattino, un punto, uno slash o una cifra:
 * i veri identificatori li hanno tutti, la prosa dopo "model:" ("model: is",
 * "model: the") no. Punteggiatura finale della frase viene tolta.
 */
function parseModel(line: string): string | undefined {
  const match = MODEL_RE.exec(line)
  if (!match) return undefined

  let name = match[1]
  name = name.replace(/\.+$/, "")
  if (!/[-./\d]/.test(name)) return undefined

  return name
}

// ---------------------------------------------------------------------------
// Attività
// ---------------------------------------------------------------------------

/** Lunghezza massima della riga di attività. */
const MAX_ACTIVITY_LENGTH = 40

/** Ellipsis tipografica e ASCII: gli agenti le usano entrambe. */
const ELLIPSIS_HEAVY = "…"
const ELLIPSIS_ASCII = "..."

/**
 * Verbi di stato in prima persona che gli agenti stampano come attività.
 * I gerundi (-ando/-endo/-ing) sono coperti dalla regola morfologica; questa
 * lista copre le forme come "Analizzo…", "Cerco…" che non finiscono in -ndo.
 */
const STATE_VERBS = new Set([
  "analizzo",
  "leggo",
  "scrivo",
  "riscrivo",
  "creo",
  "cerco",
  "eseguo",
  "modifico",
  "pianifico",
  "verifico",
  "compilo",
  "testo",
  "aspetto",
  "aggiorno",
  "rimuovo",
  "estraggo",
  "rivedo",
  "applico",
  "correggo",
  "ottimizzo",
  "esploro",
  "aggiungo",
  "elimino",
  "sposto",
  "rinomino",
  "controllo",
  "attendo",
  "costruisco",
  "implemento",
  "completo",
  "avvio",
  "salvo",
  "carico",
  "installo",
  "configuro",
  "rifattorizzo",
  "traduco",
  "riassumo",
  "organizzo",
  "preparo",
  "genero",
  "valido",
  "risolvo",
])

function isActivityVerb(word: string): boolean {
  if (STATE_VERBS.has(word)) return true
  // Gerundio italiano (-ando/-endo) o inglese (-ing); la lunghezza minima
  // scarta falsi amici corti tipo "undo".
  return word.length >= 5 && (word.endsWith("ando") || word.endsWith("endo") || word.endsWith("ing"))
}

/**
 * Tronca a `max` caratteri senza spezzare una parola: se serve tagliare,
 * si torna indietro fino all'ultimo spazio.
 */
function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(" ")
  return lastSpace > 0 ? cut.slice(0, lastSpace).trimEnd() : cut.trimEnd()
}

/**
 * Riga di attività ("Ragionando…"), oppure `undefined` se non è attività.
 *
 * L'ellipsis fa parte dell'attività: dice "in corso". Viene tolta solo per
 * validare il verbo iniziale e poi rimessa, prima del troncamento.
 */
function parseActivity(line: string): string | undefined {
  const trimmed = line.trim()

  let stem: string
  let ellipsis: string
  if (trimmed.endsWith(ELLIPSIS_HEAVY)) {
    stem = trimmed.slice(0, -ELLIPSIS_HEAVY.length).trimEnd()
    ellipsis = ELLIPSIS_HEAVY
  } else if (trimmed.endsWith(ELLIPSIS_ASCII)) {
    stem = trimmed.slice(0, -ELLIPSIS_ASCII.length).trimEnd()
    ellipsis = ELLIPSIS_ASCII
  } else {
    return undefined
  }

  if (!stem) return undefined

  const firstWord = stem.split(/\s+/)[0].toLowerCase()
  if (!isActivityVerb(firstWord)) return undefined

  return truncateAtWord(stem + ellipsis, MAX_ACTIVITY_LENGTH)
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** Tolleranza per il confronto dei costi in virgola mobile. */
const EPSILON = 1e-9

/**
 * Aggiorna il resoconto con una riga nuova di output.
 *
 * Ritorna il resoconto invariato (stesso riferimento) quando la riga non dice
 * niente di utile: la maggior parte delle righe non dice niente, ed è il caso
 * normale. Token e costo possono solo crescere; modello e attività seguono
 * l'ultima dichiarazione. L'input non viene mai mutato.
 */
export function readReportLine(current: SessionReport, line: string): SessionReport {
  const clean = stripAnsi(line)

  let next = current

  const tokens = parseTokens(clean)
  if (tokens !== undefined && (next.tokens === undefined || tokens > next.tokens)) {
    next = { ...next, tokens }
  }

  const costUsd = parseCost(clean)
  if (costUsd !== undefined && (next.costUsd === undefined || costUsd > next.costUsd + EPSILON)) {
    next = { ...next, costUsd }
  }

  const model = parseModel(clean)
  if (model !== undefined && model !== next.model) {
    next = { ...next, model }
  }

  const activity = parseActivity(clean)
  if (activity !== undefined && activity !== next.activity) {
    next = { ...next, activity }
  }

  return next
}
