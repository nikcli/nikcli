/**
 * What the Decisions window and panel do with a key, a click and a date.
 *
 * Plain `.ts`: the keyboard rules, the event an answer becomes and the
 * dates a deferral offers are tested here, not through the DOM.
 */

import type { AnsweredEvent, DeferredEvent, ReopenedEvent } from "./log"
import type { Decision } from "./state"
import { locale, t } from "../i18n"

/** Who answers from ADE: the user, in the register's own word for them. */
export const USER = "utente"

export type SheetKey =
  | { readonly kind: "pick"; readonly index: number }
  | { readonly kind: "submit" }
  /** Enter with nothing chosen: nothing is recorded, the window says what to do. */
  | { readonly kind: "need-choice" }
  | { readonly kind: "close" }
  | { readonly kind: "next" }
  | { readonly kind: "previous" }

/**
 * A key pressed in the window. `inText` is true while the note has focus:
 * there digits and arrows are typing, Enter is a new line, and only
 * Ctrl/⌘+Enter submits.
 *
 * `picked` is whether the user chose an option in this window. A plain Enter
 * records only then: a stray Enter on a freshly opened window must not answer
 * a decision nobody looked at.
 */
export function sheetKey(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  optionCount: number,
  inText: boolean,
  picked: boolean,
): SheetKey | undefined {
  if (event.key === "Escape") return { kind: "close" }
  if (event.key === "Enter") {
    if (event.ctrlKey || event.metaKey) return { kind: "submit" }
    if (inText) return undefined
    return picked ? { kind: "submit" } : { kind: "need-choice" }
  }
  if (inText || event.ctrlKey || event.metaKey || event.altKey) return undefined
  if (/^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1
    return index < optionCount ? { kind: "pick", index } : undefined
  }
  if (event.key === "ArrowRight") return { kind: "next" }
  if (event.key === "ArrowLeft") return { kind: "previous" }
  return undefined
}

/**
 * The event an answer becomes, or why it cannot be one yet.
 *
 * The user's words are what they picked and what they wrote, together: in
 * the panel there is nothing more exact than that, and a note that changes
 * the option ("B, ma senza il globale") must travel with it.
 */
export function answerEvent(
  decision: Pick<Decision, "k" | "options">,
  picked: number | undefined,
  note: string,
  at: Date,
): AnsweredEvent | string {
  const choice = picked === undefined ? undefined : decision.options[picked]?.label
  const trimmed = note.trim()
  if (!choice && !trimmed) return t("decisions.needAnswer")
  const words = [choice, trimmed].filter(Boolean).join(" — ")
  return {
    type: "risposta",
    k: decision.k,
    at: at.toISOString(),
    by: USER,
    words,
    ...(choice ? { choice } : {}),
    ...(trimmed ? { note: trimmed } : {}),
  }
}

export function reopenEvent(k: string, at: Date, reason?: string): ReopenedEvent {
  return { type: "riaperta", k, at: at.toISOString(), by: USER, ...(reason ? { reason } : {}) }
}

export function deferEvent(k: string, until: string, at: Date): DeferredEvent {
  return { type: "rimandata", k, at: at.toISOString(), by: USER, until }
}

/** A local calendar day as `YYYY-MM-DD`, the form a date input reads and writes. */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * The deferral offered by one click: tomorrow, in three days, next Monday.
 * Each is the start of that local day, so "domani" is back tomorrow morning,
 * not in exactly twenty-four hours.
 */
export function deferPresets(now: Date): { label: string; until: string }[] {
  const day = (offset: number) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    return date.toISOString()
  }
  const toMonday = (8 - now.getDay()) % 7 || 7
  return [
    { label: t("date.tomorrow"), until: day(1) },
    { label: t("date.inDays", 3), until: day(3) },
    { label: t("date.monday"), until: day(toMonday) },
  ]
}

/** A date typed in the input (`YYYY-MM-DD`), as the start of that local day; undefined if not in the future. */
export function deferFromInput(value: string, now: Date): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.getTime() > now.getTime() ? date.toISOString() : undefined
}

const MONTHS_IT = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const month = (index: number) => (locale() === "en" ? MONTHS_EN : MONTHS_IT)[index]

/** "20 set", "20 set 2027" when not this year; "oggi"/"domani" when close. */
export function formatDay(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  )
  if (days === 0) return t("date.today")
  if (days === 1) return t("date.tomorrow")
  const base = `${date.getDate()} ${month(date.getMonth())}`
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`
}

/** "15:21" today, "14 set 15:21" another day. */
export function formatMoment(ms: number, now: Date): string {
  const date = new Date(ms)
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  const sameDay = localDay(date) === localDay(now)
  return sameDay ? time : `${date.getDate()} ${month(date.getMonth())} ${time}`
}

/** The badge's words. */
export function countLabel(count: number): string {
  return t("decisions.count", count)
}
