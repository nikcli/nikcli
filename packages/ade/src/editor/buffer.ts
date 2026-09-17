import { t } from "../i18n"
/**
 * Modello del buffer dell'editor.
 *
 * Mantiene lo stato di sincronizzazione tra il contenuto su disco (saved)
 * e quello in corso di modifica (draft), gestendo il flag dirty e
 * proteggendo file troncati in lettura da sovrascritture distruttive.
 */

export interface Buffer {
  path: string
  /** Contenuto salvato su disco l'ultima volta che lo abbiamo letto. */
  saved: string
  /** Contenuto corrente nell'editor. */
  draft: string
  /** True quando draft e saved divergono. */
  dirty: boolean
  /** Il file era troncato in lettura: salvarlo distruggerebbe il resto. */
  truncated: boolean
}

export interface Position {
  line: number
  column: number
}

/**
 * Inizializza un nuovo buffer a partire da un file letto da disco.
 */
export function openBuffer(input: { path: string; text: string; truncated: boolean }): Buffer {
  return {
    path: input.path,
    saved: input.text,
    draft: input.text,
    dirty: false,
    truncated: input.truncated,
  }
}

/**
 * Aggiorna il testo corrente in bozza e ricalcola se è stato modificato rispetto a disco.
 */
export function editBuffer(buffer: Buffer, draft: string): Buffer {
  return {
    ...buffer,
    draft,
    dirty: draft !== buffer.saved,
  }
}

/**
 * Registra l'avvenuto salvataggio su disco aggiornando il testo di riferimento.
 */
export function markSaved(buffer: Buffer, savedText: string): Buffer {
  return {
    ...buffer,
    saved: savedText,
    dirty: buffer.draft !== savedText,
  }
}

/**
 * Ripristina il contenuto della bozza all'ultimo testo salvato su disco.
 */
export function revertBuffer(buffer: Buffer): Buffer {
  return {
    ...buffer,
    draft: buffer.saved,
    dirty: false,
  }
}

/**
 * Restituisce il motivo per cui il salvataggio non è consentito, oppure undefined se è possibile procedere.
 * Regola fondamentale: un buffer troncato non può mai essere salvato per evitare perdite di dati.
 */
export function saveBlockedReason(buffer: Buffer): string | undefined {
  if (buffer.truncated) {
    return t("editor.truncatedSave")
  }
  if (!buffer.dirty) {
    return t("editor.nothingToSave")
  }
  return undefined
}

/**
 * Calcola il numero totale di righe nel testo.
 */
export function lineCount(text: string): number {
  return text.split("\n").length
}

/**
 * Calcola la posizione 1-based (riga e colonna) all'interno del testo dato un offset in caratteri.
 */
export function positionOf(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const slice = text.slice(0, clamped)
  const lines = slice.split("\n")
  const line = lines.length
  const lastLine = lines[lines.length - 1] ?? ""
  const column = lastLine.length + 1
  return { line, column }
}
