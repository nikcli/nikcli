/**
 * What the Decisions window and panel share: the register, who an answer
 * goes to, whether it got there, and the drafts being written.
 *
 * Built once by the workbench. A pick or a note typed in the window is still
 * there in the panel, and the other way round, until the answer is written.
 */

import { createSignal } from "solid-js"
import { answerEvent, deferEvent, reopenEvent } from "./answer"
import type { DeliveryCandidate, DeliveryState, RecipientStatus } from "./delivery"
import type { AnsweredEvent } from "./log"
import type { DecisionsRegister } from "./register"
import type { Decision } from "./state"

export interface DecisionDraft {
  readonly picked?: number
  readonly note: string
}

export interface DecisionsHub {
  readonly register: DecisionsRegister
  /** Who the project's answers go to, as the user chose. */
  recipient: () => RecipientStatus
  /** The sessions the user can choose from, every project's. */
  sessions: () => readonly DeliveryCandidate[]
  /** Chooses the recipient by pane id; `undefined` chooses nobody. */
  choose: (id: string | undefined) => void
  delivery: (decision: Decision) => DeliveryState
  draft: (k: string) => DecisionDraft
  setDraft: (k: string, draft: DecisionDraft) => void
  busy: (k: string) => boolean
  problem: (k: string) => string | undefined
  /** Writes the answer from the draft; resolves true once it is in the register. */
  answer: (decision: Decision) => Promise<boolean>
  defer: (decision: Decision, until: string) => Promise<boolean>
  reopen: (decision: Decision) => Promise<boolean>
}

export function createDecisionsHub(deps: {
  register: DecisionsRegister
  recipient: () => RecipientStatus
  sessions: () => readonly DeliveryCandidate[]
  choose: (id: string | undefined) => void
  delivery: (decision: Decision) => DeliveryState
  /** Called after an answer is in the register, to queue the message. */
  onAnswered: (decision: Decision, event: AnsweredEvent) => void
}): DecisionsHub {
  const [drafts, setDrafts] = createSignal<Record<string, DecisionDraft>>({})
  const [busyKeys, setBusyKeys] = createSignal<ReadonlySet<string>>(new Set())
  const [problems, setProblems] = createSignal<Record<string, string | undefined>>({})

  const setProblem = (k: string, text: string | undefined) => setProblems((all) => ({ ...all, [k]: text }))
  const setBusy = (k: string, on: boolean) =>
    setBusyKeys((keys) => {
      const next = new Set(keys)
      if (on) next.add(k)
      else next.delete(k)
      return next
    })

  /** Runs one write for `k`, with its busy flag and its error shown on the card. */
  const write = async (k: string, run: () => Promise<void>): Promise<boolean> => {
    if (busyKeys().has(k)) return false
    setBusy(k, true)
    setProblem(k, undefined)
    try {
      await run()
      return true
    } catch (failure) {
      setProblem(k, failure instanceof Error ? failure.message : String(failure))
      return false
    } finally {
      setBusy(k, false)
    }
  }

  const draft = (k: string): DecisionDraft => drafts()[k] ?? { note: "" }
  const clearDraft = (k: string) =>
    setDrafts((all) => {
      const next = { ...all }
      delete next[k]
      return next
    })

  return {
    register: deps.register,
    recipient: deps.recipient,
    sessions: deps.sessions,
    choose: deps.choose,
    delivery: deps.delivery,
    draft,
    setDraft: (k, value) => {
      setDrafts((all) => ({ ...all, [k]: value }))
      if (problems()[k]) setProblem(k, undefined)
    },
    busy: (k) => busyKeys().has(k),
    problem: (k) => problems()[k],
    answer: (decision) => {
      const current = draft(decision.k)
      const event = answerEvent(decision, current.picked, current.note, new Date())
      if (typeof event === "string") {
        setProblem(decision.k, event)
        return Promise.resolve(false)
      }
      return write(decision.k, async () => {
        await deps.register.append(event)
        clearDraft(decision.k)
        deps.onAnswered(decision, event)
      })
    },
    defer: (decision, until) =>
      write(decision.k, () => deps.register.append(deferEvent(decision.k, until, new Date()))),
    reopen: (decision) => write(decision.k, () => deps.register.append(reopenEvent(decision.k, new Date()))),
  }
}
