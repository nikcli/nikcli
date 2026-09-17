import { t } from "../i18n"
/**
 * The decisions register, as it is written to disk.
 *
 * One JSON object per line, appended and never rewritten: an event says what
 * happened to a decision — opened, answered, deferred, reopened, closed — and
 * the current state is computed from all of them by `state.ts`. This is the
 * shape firstmate settled on for the same problem ("a log of events, not the
 * current state"), and the reason is the one that bit Bearings: several
 * writers — Master from a shell, ADE from the panel — and a crash or a
 * restart in the middle. Appending a line cannot overwrite somebody else's
 * answer, and a file that stops halfway still holds every whole line.
 *
 * The user's answer is stored in their own words (`words`), not only as the
 * option it mapped to. A decision is an instruction, and "B, ma senza il
 * catalogo globale" executed as "B" is a different instruction.
 *
 * Plain `.ts`, no I/O: `store.ts` reads and appends through the host.
 */

/** The verbs of the register, in the order a decision usually meets them. */
export const DECISION_EVENT_TYPES = ["aperta", "risposta", "rimandata", "riaperta", "chiusa"] as const

export type DecisionEventType = (typeof DECISION_EVENT_TYPES)[number]

export interface DecisionOption {
  readonly label: string
  readonly detail?: string
}

interface EventBase {
  /** The decision's key, stable for its whole life: `D21`. */
  readonly k: string
  /** ISO timestamp of when it happened. */
  readonly at: string
  /** Who wrote it: a session title, "utente", "Master". */
  readonly by: string
}

export interface OpenedEvent extends EventBase {
  readonly type: "aperta"
  readonly title: string
  /** What the user needs to know to answer, in plain words. */
  readonly context?: string
  readonly options?: readonly DecisionOption[]
  /** The work waiting on it: `S16`, `S16 realizzazione`. */
  readonly unlocks?: string
  /** The spec that raised it, for grouping. */
  readonly spec?: string
  /** Lower comes first. Absent: after every ordered one, by time. */
  readonly order?: number
}

export interface AnsweredEvent extends EventBase {
  readonly type: "risposta"
  /** The option picked, when one was. */
  readonly choice?: string
  /** A note added to the choice. */
  readonly note?: string
  /** What the user said, exactly. Required: it is what gets executed. */
  readonly words: string
}

export interface DeferredEvent extends EventBase {
  readonly type: "rimandata"
  /** ISO date or timestamp; the decision is back in front of the user from then. */
  readonly until: string
  readonly reason?: string
}

export interface ReopenedEvent extends EventBase {
  readonly type: "riaperta"
  readonly reason?: string
}

export interface ClosedEvent extends EventBase {
  readonly type: "chiusa"
  /** What shows it was done: a commit, a release, a sentence. */
  readonly evidence?: string
}

export type DecisionEvent = OpenedEvent | AnsweredEvent | DeferredEvent | ReopenedEvent | ClosedEvent

/** A line that could not be read, kept so it can be shown rather than lost silently. */
export interface LogProblem {
  /** 1-based line number in the file. */
  readonly line: number
  readonly reason: string
}

export interface ParsedLog {
  readonly events: readonly DecisionEvent[]
  readonly problems: readonly LogProblem[]
}

/** A key: letters, digits and `-_.`, up to 40 characters. `D21`, `S16-mcp`. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

export function isDecisionKey(text: string): boolean {
  return KEY.test(text)
}

/**
 * Reads the whole file. Blank lines are skipped; a line that is not a valid
 * event becomes a problem, and the lines after it still count.
 */
export function parseDecisionLog(text: string): ParsedLog {
  const events: DecisionEvent[] = []
  const problems: LogProblem[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line.length === 0) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      // The last line of a file whose writer died mid-append: expected, and
      // not worth more than a note.
      problems.push({ line: index + 1, reason: t("decisions.log.json") })
      return
    }
    const checked = toEvent(value)
    if (typeof checked === "string") problems.push({ line: index + 1, reason: checked })
    else events.push(checked)
  })
  return { events, problems }
}

/** One line, newline included, ready to append. */
export function serializeDecisionEvent(event: DecisionEvent): string {
  const checked = toEvent(event)
  if (typeof checked === "string") throw new Error(t("decisions.log.invalid", checked))
  // JSON.stringify escapes line breaks inside strings, so the record is one line.
  return `${JSON.stringify(checked)}\n`
}

/** The event with only its known fields, or the reason it is not one. */
export function toEvent(value: unknown): DecisionEvent | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return t("decisions.log.notObject")
  const record = value as Record<string, unknown>
  const type = record.type
  if (typeof type !== "string" || !DECISION_EVENT_TYPES.includes(type as DecisionEventType))
    return t("decisions.log.type")
  const k = text(record.k)
  if (!k || !isDecisionKey(k)) return t("decisions.log.key")
  const at = text(record.at)
  if (!at || Number.isNaN(Date.parse(at))) return t("decisions.log.date")
  const by = text(record.by)
  if (!by) return t("decisions.log.author")
  const base = { k, at, by }

  switch (type as DecisionEventType) {
    case "aperta": {
      const title = text(record.title)
      if (!title) return t("decisions.log.title")
      const options = optionsOf(record.options)
      if (typeof options === "string") return options
      const order = record.order
      if (order !== undefined && (typeof order !== "number" || !Number.isFinite(order))) return t("decisions.log.order")
      return compact({
        type: "aperta",
        ...base,
        title,
        context: text(record.context),
        options: options.length > 0 ? options : undefined,
        unlocks: text(record.unlocks),
        spec: text(record.spec),
        order: order as number | undefined,
      }) as OpenedEvent
    }
    case "risposta": {
      const words = text(record.words)
      if (!words) return t("decisions.log.words")
      return compact({
        type: "risposta",
        ...base,
        words,
        choice: text(record.choice),
        note: text(record.note),
      }) as AnsweredEvent
    }
    case "rimandata": {
      const until = text(record.until)
      if (!until || Number.isNaN(Date.parse(until))) return t("decisions.log.until")
      return compact({ type: "rimandata", ...base, until, reason: text(record.reason) }) as DeferredEvent
    }
    case "riaperta":
      return compact({ type: "riaperta", ...base, reason: text(record.reason) }) as ReopenedEvent
    case "chiusa":
      return compact({ type: "chiusa", ...base, evidence: text(record.evidence) }) as ClosedEvent
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function optionsOf(value: unknown): DecisionOption[] | string {
  if (value === undefined) return []
  if (!Array.isArray(value)) return t("decisions.log.options")
  const options: DecisionOption[] = []
  for (const item of value) {
    const label = item && typeof item === "object" ? text((item as Record<string, unknown>).label) : text(item)
    if (!label) return t("decisions.log.optionLabel")
    const detail = item && typeof item === "object" ? text((item as Record<string, unknown>).detail) : undefined
    options.push(detail ? { label, detail } : { label })
  }
  return options
}

/** Drops undefined fields, so the line on disk holds only what was said. */
function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}
