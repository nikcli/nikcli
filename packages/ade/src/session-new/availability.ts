/**
 * Which agents are actually installed on this machine.
 *
 * The catalogue in `agents.ts` says what ADE knows how to start; this says what
 * can be started here and now. Keeping them apart matters: an agent the user
 * has not installed should be visible and refused with a reason, not silently
 * missing from the list — a list that changes shape between machines is one
 * nobody can be told about.
 *
 * Nothing here runs a process. The host passes in a probe, so the same logic
 * covers the desktop shell (which can execute) and the browser harness (which
 * cannot), and the tests need neither.
 */
import { AGENTS, type AgentOption } from "./agents"

export type Availability = "presente" | "assente" | "sconosciuto"

export interface AgentStatus {
  agent: AgentOption
  availability: Availability
  /**
   * Where the binary was found, when it was. Shown as the button's tooltip:
   * with eleven agents and several installed twice over — an npm shim and a
   * native build of the same name — which one a session will actually start is
   * worth being able to check without leaving the form.
   */
  path?: string
}

/**
 * Resolves `command` to its path on PATH, or null when it is not installed.
 *
 * A lookup rather than a run. Asking eleven CLIs for their version costs a
 * visible pause on the new-session form, wakes whatever update check each of
 * them does at startup, and answers a question nobody asked — the form wants to
 * know whether the agent exists, not what release it is.
 */
export type Probe = (command: string, arg: string) => Promise<string | null>

/**
 * Whether this entry has a command worth looking up.
 *
 * `terminal` now names a real shell (`agents.ts`), so it is probed like the
 * rest — a shell that PATH cannot find is worth knowing about before the user
 * presses Avvia. An entry with no command at all is still treated as present
 * rather than absent: there is nothing to look for, and claiming it is missing
 * would be a stronger statement than the evidence supports.
 */
export function isProbeable(agent: AgentOption): boolean {
  return agent.command.length > 0
}

export async function detectAgents(probe: Probe | undefined): Promise<AgentStatus[]> {
  if (!probe) {
    // No way to ask: claim nothing. "sconosciuto" reads differently from
    // "assente" in the interface, and pretending otherwise would tell the user
    // an agent is missing when it may well be installed.
    return AGENTS.map((agent) => ({
      agent,
      availability: isProbeable(agent) ? ("sconosciuto" as const) : ("presente" as const),
    }))
  }

  return Promise.all(
    AGENTS.map(async (agent) => {
      if (!isProbeable(agent)) return { agent, availability: "presente" as const }
      const answer = await probe(agent.command, "--version").catch(() => null)
      if (answer === null) return { agent, availability: "assente" as const }
      return { agent, availability: "presente" as const, path: firstLine(answer) }
    }),
  )
}

function firstLine(text: string): string | undefined {
  const line = text.split("\n")[0]?.trim()
  return line && line.length > 0 ? line : undefined
}

/** The agents that can be started, in catalogue order. */
export function startable(statuses: AgentStatus[]): AgentStatus[] {
  return statuses.filter((status) => status.availability !== "assente")
}

/**
 * The agent to preselect: the first installed one, or the first of the list
 * when nothing is known yet. Never an agent known to be absent — preselecting
 * one guarantees the first launch fails.
 */
export function defaultAgentId(statuses: AgentStatus[]): string | undefined {
  const present = statuses.find(
    (status) => status.availability === "presente" && isProbeable(status.agent),
  )
  if (present) return present.agent.id
  const unknown = statuses.find(
    (status) => status.availability === "sconosciuto" && isProbeable(status.agent),
  )
  return unknown?.agent.id
}
