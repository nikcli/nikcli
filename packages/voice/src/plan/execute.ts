/**
 * Carrying out a validated plan, and saying what happened.
 *
 * Execution is deliberately plain: the interesting decisions were all made in
 * `schema.ts`, which is why nothing here has to wonder whether an agent is
 * real or a pane index is in range. What this adds is the part a plan cannot
 * have: what to do when step three fails after steps one and two already
 * happened, and how to describe the mixture out loud.
 *
 * Steps run in order and a failure does not stop the rest. Four sessions
 * where the second one's agent is missing should be three sessions and a
 * sentence about the fourth — not one session and silence.
 */

import type { VoiceHost } from "../bridge/host"
import type { PlanStep } from "./schema"

export interface PlanExecution {
  /** Steps that actually happened. */
  done: PlanStep[]
  /** Why a step did not, in Italian. */
  failures: string[]
  /** Pane ids created, in the order they were created. */
  openedPaneIds: string[]
}

export async function executePlan(
  steps: readonly PlanStep[],
  host: VoiceHost,
  options: { signal?: AbortSignal } = {},
): Promise<PlanExecution> {
  const done: PlanStep[] = []
  const failures: string[] = []
  const openedPaneIds: string[] = []

  for (const step of steps) {
    if (options.signal?.aborted) break
    try {
      await runStep(step, host, openedPaneIds)
      done.push(step)
    } catch (error) {
      failures.push(describeFailure(step, error))
    }
  }

  return { done, failures, openedPaneIds }
}

/**
 * One line naming what a step does, for the agent console.
 *
 * Separate from `announceExecution`, which writes a single sentence to be
 * *spoken* about the whole plan. This is per-step and meant to be read: the
 * console shows the plan as a checklist, and "Ho avviato due sessioni claude"
 * cannot be split back into its steps.
 */
export function describeStep(step: PlanStep): string {
  switch (step.action) {
    case "start_session":
      return step.task ? `Sessione ${step.agent}: ${step.task}` : `Sessione ${step.agent}`
    case "open_project":
      return `Apri il progetto ${step.project}`
    case "run_command":
      return `Esegui ${step.command}`
    case "focus_pane":
      return `Metti a fuoco il pannello ${step.paneIndex}`
    case "send_prompt":
      return `Scrivi al pannello ${step.paneIndex}: ${step.text}`
  }
}

async function runStep(step: PlanStep, host: VoiceHost, openedPaneIds: string[]): Promise<void> {
  switch (step.action) {
    case "start_session": {
      if (!host.startSession) {
        throw new Error("questa versione non sa avviare sessioni a voce")
      }
      const created = await host.startSession({
        agent: step.agent,
        ...(step.task ? { task: step.task } : {}),
        ...(step.project ? { project: step.project } : {}),
      })
      openedPaneIds.push(created.paneId)
      return
    }

    case "open_project":
      // The command surface already addresses a project by root; there is no
      // second route to invent here.
      await host.runCommand(`project.recent.${step.project}`)
      return

    case "run_command":
      await host.runCommand(step.command)
      return

    case "focus_pane": {
      host.focusPane(paneIdAt(host, step.paneIndex))
      return
    }

    case "send_prompt": {
      await host.sendPrompt(paneIdAt(host, step.paneIndex), step.text)
      return
    }
  }
}

/*
 * Resolved at execution time, not at validation time.
 *
 * A plan that opens two sessions and then talks to "pannello tre" is only
 * correct once those two exist. Reading the pane list again here is what
 * makes that ordinary instead of a race.
 */
function paneIdAt(host: VoiceHost, index: number): string {
  const panes = host.listPanes()
  const pane = panes[index - 1]
  if (!pane) throw new Error(`il pannello ${index} non esiste`)
  return pane.id
}

function describeFailure(step: PlanStep, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  switch (step.action) {
    case "start_session":
      return `Non sono riuscito ad avviare ${step.agent}: ${reason}.`
    case "open_project":
      return `Non sono riuscito ad aprire il progetto: ${reason}.`
    case "run_command":
      return `Il comando ${step.command} non è andato a buon fine: ${reason}.`
    case "focus_pane":
      return `Non sono riuscito a spostarmi sul pannello ${step.paneIndex}: ${reason}.`
    case "send_prompt":
      return `Non sono riuscito a scrivere al pannello ${step.paneIndex}: ${reason}.`
  }
}

/**
 * One sentence for what just happened, in Italian.
 *
 * Said *after* the fact, which is the shape the user asked for: no
 * confirmation to sit through, but never an action taken in silence either.
 * Sessions are counted rather than listed because "ho avviato quattro
 * sessioni Claude Code" is something you can follow while four titles read
 * one after another is not.
 */
export function announceExecution(input: {
  execution: PlanExecution
  refusals: readonly string[]
  agentLabel?: (id: string) => string
}): string {
  const label = input.agentLabel ?? ((id: string) => id)
  const parts: string[] = []

  const started = input.execution.done.filter(
    (step): step is Extract<PlanStep, { action: "start_session" }> => step.action === "start_session",
  )
  if (started.length > 0) {
    const byAgent = new Map<string, number>()
    for (const step of started) byAgent.set(step.agent, (byAgent.get(step.agent) ?? 0) + 1)
    const spoken = [...byAgent].map(([agent, count]) =>
      count === 1 ? `una sessione ${label(agent)}` : `${count} sessioni ${label(agent)}`,
    )
    parts.push(`Ho avviato ${joinItalian(spoken)}.`)
  }

  const others = input.execution.done.length - started.length
  if (others > 0) {
    parts.push(others === 1 ? "E ho eseguito un'altra operazione." : `E ho eseguito altre ${others} operazioni.`)
  }

  if (input.execution.done.length === 0 && input.refusals.length === 0 && input.execution.failures.length === 0) {
    return "Non ho trovato niente da fare in quella frase."
  }

  parts.push(...input.refusals, ...input.execution.failures)
  return parts.join(" ")
}

function joinItalian(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`
}
