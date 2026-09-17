/**
 * Where every decision stands, computed from the register's events.
 *
 * The register is a log (`log.ts`); nothing on disk says "D21 is answered".
 * This function reads the events in the order they were written and applies
 * the rules of the ROADMAP ("Decisioni: regole"):
 *
 *  - a decision is closed only by an answer in the user's own words, or by a
 *    close that carries evidence — never by being forgotten;
 *  - "più tardi" is `rimandata` until a date, not a close, and on that date it
 *    is back in front of the user without anyone writing anything;
 *  - an answer can be changed until Master has closed the decision, and not
 *    after.
 *
 * An event that breaks a rule is not applied and is reported, with the reason,
 * so a hand-written line that answers a decision nobody opened shows up as a
 * problem instead of as a silent no-op.
 */

import { asOneLine } from "../session/typing"
import type { DecisionEvent, DecisionOption, LogProblem } from "./log"
import { t } from "../i18n"

export type DecisionStatus = "aperta" | "risposta" | "rimandata" | "chiusa"

export interface DecisionAnswer {
  readonly choice?: string
  readonly note?: string
  readonly words: string
  readonly at: string
  readonly by: string
}

export interface Decision {
  readonly k: string
  readonly title: string
  readonly context?: string
  readonly options: readonly DecisionOption[]
  readonly unlocks?: string
  readonly spec?: string
  readonly order?: number
  /** Who opened it, and when. */
  readonly raisedBy: string
  readonly openedAt: string
  readonly status: DecisionStatus
  /** The answer standing now; the previous ones are in `history`. */
  readonly answer?: DecisionAnswer
  /** Set while `rimandata`. */
  readonly deferredUntil?: string
  readonly closedAt?: string
  readonly evidence?: string
  /** Every event applied to it, oldest first. */
  readonly history: readonly DecisionEvent[]
}

/** An event that was read but not applied. */
export interface RejectedEvent {
  readonly event: DecisionEvent
  readonly reason: string
}

export interface DecisionsState {
  /** In the order they were opened. */
  readonly decisions: readonly Decision[]
  readonly rejected: readonly RejectedEvent[]
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Applies `events` in order. `now` decides whether a deferral has run out:
 * a decision deferred until a date that has passed reads as `aperta`.
 */
export function foldDecisions(events: readonly DecisionEvent[], now: Date = new Date()): DecisionsState {
  const byKey = new Map<string, Mutable<Decision>>()
  const rejected: RejectedEvent[] = []
  const reject = (event: DecisionEvent, reason: string) => rejected.push({ event, reason })

  for (const event of events) {
    const current = byKey.get(event.k)

    if (event.type === "aperta") {
      if (current) {
        reject(event, t("decisions.rule.exists", event.k))
        continue
      }
      byKey.set(event.k, {
        k: event.k,
        title: event.title,
        context: event.context,
        options: event.options ?? [],
        unlocks: event.unlocks,
        spec: event.spec,
        order: event.order,
        raisedBy: event.by,
        openedAt: event.at,
        status: "aperta",
        history: [event],
      })
      continue
    }

    if (!current) {
      reject(event, t("decisions.rule.neverOpened", event.k))
      continue
    }
    const status = effectiveStatus(current, now)
    if (status === "chiusa") {
      reject(event, t("decisions.rule.closed", event.k))
      continue
    }

    switch (event.type) {
      case "risposta":
        if (status === "risposta") {
          // A second answer without a reopen is almost always two writers
          // racing. The first one stands; the user can change it on purpose.
          reject(event, t("decisions.rule.answered", event.k))
          continue
        }
        current.answer = { choice: event.choice, note: event.note, words: event.words, at: event.at, by: event.by }
        current.status = "risposta"
        current.deferredUntil = undefined
        break
      case "rimandata":
        if (status !== "aperta") {
          reject(event, t("decisions.rule.deferOpen", event.k, t(`decisions.status.${status}`)))
          continue
        }
        current.status = "rimandata"
        current.deferredUntil = event.until
        break
      case "riaperta":
        if (status === "aperta") {
          reject(event, t("decisions.rule.open", event.k))
          continue
        }
        current.status = "aperta"
        current.answer = undefined
        current.deferredUntil = undefined
        break
      case "chiusa":
        if (status !== "risposta" && !event.evidence) {
          reject(event, t("decisions.rule.close", event.k))
          continue
        }
        current.status = "chiusa"
        current.closedAt = event.at
        current.evidence = event.evidence
        current.deferredUntil = undefined
        break
    }
    current.history = [...current.history, event]
  }

  const decisions = [...byKey.values()].map((decision) => ({ ...decision, status: effectiveStatus(decision, now) }))
  return { decisions, rejected }
}

/** `rimandata` whose date has passed is `aperta` again. */
function effectiveStatus(decision: Pick<Decision, "status" | "deferredUntil">, now: Date): DecisionStatus {
  if (decision.status !== "rimandata" || !decision.deferredUntil) return decision.status
  return Date.parse(decision.deferredUntil) <= now.getTime() ? "aperta" : "rimandata"
}

/**
 * The order the user meets open decisions in: by `order` when given, then by
 * when they were opened. Stable, so two decisions with the same order keep
 * the order they were raised in.
 */
export function compareDecisions(a: Decision, b: Decision): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY
  const bo = b.order ?? Number.POSITIVE_INFINITY
  if (ao !== bo) return ao < bo ? -1 : 1
  return Date.parse(a.openedAt) - Date.parse(b.openedAt)
}

export interface DecisionBuckets {
  /** Waiting on the user, in order. */
  readonly forYou: readonly Decision[]
  /** Answered, waiting for a session to act and close. */
  readonly answered: readonly Decision[]
  /** Deferred to a date still ahead: the ROADMAP's "Prossimo". */
  readonly later: readonly Decision[]
  readonly closed: readonly Decision[]
}

/** Each decision in exactly one bucket. */
export function bucketDecisions(decisions: readonly Decision[]): DecisionBuckets {
  const sorted = [...decisions].sort(compareDecisions)
  return {
    forYou: sorted.filter((d) => d.status === "aperta"),
    answered: sorted.filter((d) => d.status === "risposta"),
    later: sorted
      .filter((d) => d.status === "rimandata")
      .sort((a, b) => Date.parse(a.deferredUntil ?? "") - Date.parse(b.deferredUntil ?? "")),
    closed: sorted.filter((d) => d.status === "chiusa"),
  }
}

/**
 * The line that tells Master a decision was answered.
 *
 * Starts with the protocol's verb and key, so it reads like every other status
 * line; one line, because it is typed into a terminal where a line break
 * submits. The user's words are quoted as they were said.
 */
export function resolvedMessage(decision: Decision): string {
  const answer = decision.answer
  if (!answer) throw new Error(`${decision.k} non ha una risposta`)
  const parts = [`risolta [k=${decision.k}] ${decision.title}`]
  if (answer.choice) parts.push(`scelta: ${answer.choice}`)
  if (answer.note) parts.push(`nota: ${answer.note}`)
  parts.push(`parole: "${answer.words}"`)
  if (decision.unlocks) parts.push(`sblocca ${decision.unlocks}`)
  return asOneLine(parts.join(" — "))
}

/**
 * The next free key in the `D<n>` series: one past the highest number used,
 * so a key is never reused even after its decision is closed.
 */
export function nextDecisionKey(decisions: readonly Pick<Decision, "k">[], prefix = "D"): string {
  let highest = 0
  for (const { k } of decisions) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(k)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `${prefix}${highest + 1}`
}

/** What to show about a register that could not be read cleanly. */
export function describeProblems(problems: readonly LogProblem[], rejected: readonly RejectedEvent[]): string[] {
  return [
    ...problems.map((problem) => t("decisions.problem.line", problem.line, problem.reason)),
    ...rejected.map((item) => `${item.event.type} ${item.event.k}: ${item.reason}`),
  ]
}
