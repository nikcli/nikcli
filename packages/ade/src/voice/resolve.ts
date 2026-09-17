/**
 * Turning what a person said into something ADE can look up.
 *
 * A spoken plan names an agent as "claude", "Claude Code" or "claude code",
 * and a project as "nikcli" or by a path the user read out — never as the ids
 * the catalogue keeps. Matching that loosely is the whole job here, and it is
 * also the part most likely to be wrong, so it lives in its own module with
 * its own tests rather than inside a Solid component that `bun test` cannot
 * even import.
 *
 * Every failure is an exception carrying the valid options, in Italian. The
 * alternative — returning a default agent, or silently doing nothing — is how
 * "avvia quattro sessioni di copilot" ends with the assistant reporting
 * success over four Claude sessions nobody asked for.
 */

import type { AgentOption } from "../session-new/agents"
import { basename, normalizePath, pathEquals } from "../host/path"

/**
 * The comparable form of a spoken name.
 *
 * Case, spaces, hyphens, underscores and dots all carry no meaning here: a
 * transcriber writes "Claude Code", the catalogue writes "claude-code", and a
 * user says "claudecode". Accents are folded too, because Italian dictation
 * puts them where a product name does not have them.
 */
export function spokenKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s._\-]+/g, "")
}

/** The agent whose id, label or command the spoken words name. */
export function resolveAgentId(spoken: string, agents: readonly AgentOption[]): string {
  const key = spokenKey(spoken)
  if (key.length === 0) throw unknownAgent(spoken, agents)

  const names = (agent: AgentOption) => [agent.id, agent.label, agent.command]

  const exact = agents.find((agent) => names(agent).some((name) => spokenKey(name) === key))
  if (exact) return exact.id

  /*
   * Then the partial match, in both directions: "claude" is a prefix of
   * "claude-code" (the id), and "gemini cli 2" starts with "gemini". Only a
   * single candidate is accepted — "code" matching both Codex and OpenCode is
   * a question to refuse, not a coin to flip.
   */
  const candidates = agents.filter((agent) =>
    names(agent).some((name) => {
      const other = spokenKey(name)
      return other.length > 0 && (other.startsWith(key) || key.startsWith(other))
    }),
  )
  const unique = new Set(candidates.map((agent) => agent.id))
  if (unique.size === 1) return candidates[0]!.id

  throw unknownAgent(spoken, agents)
}

function unknownAgent(spoken: string, agents: readonly AgentOption[]): Error {
  const options = agents.map((agent) => agent.label).join(", ")
  return new Error(
    `Non conosco l'agente «${spoken.trim()}». Posso avviare: ${options}.`,
  )
}

export interface VoiceProject {
  name: string
  root: string
  isOpen: boolean
}

/**
 * The projects a plan may name: the open one, then the recents.
 *
 * Deduplicated by normalised root, because the same directory reaches the
 * recents list spelled `C:\Users\x\repo` from a shell and `C:/Users/x/repo`
 * from the sidebar. The open project is pushed first so that when the same
 * root appears twice it is the open spelling that survives — otherwise
 * `isOpen` would land on the copy nobody is looking at.
 */
export function listProjectsFrom(
  recents: readonly { root: string; name: string }[],
  open: { root: string; name: string } | undefined,
): VoiceProject[] {
  const seen = new Set<string>()
  const out: VoiceProject[] = []

  const push = (entry: { root: string; name: string }, isOpen: boolean) => {
    const key = normalizePath(entry.root).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ name: entry.name, root: entry.root, isOpen })
  }

  if (open) push(open, true)
  for (const entry of recents) push(entry, false)
  return out
}

/** The project the spoken words name, by name or by root. */
export function resolveProject<T extends { name: string; root: string }>(
  spoken: string,
  projects: readonly T[],
): T {
  const key = spokenKey(spoken)
  if (key.length === 0) throw unknownProject(spoken, projects)

  // A root first, and compared as a path: separators and case are not the
  // user's mistake to pay for.
  const byRoot = projects.find((project) => pathEquals(project.root, spoken))
  if (byRoot) return byRoot

  const names = (project: T) => [project.name, basename(project.root)]

  const exact = projects.find((project) => names(project).some((name) => spokenKey(name) === key))
  if (exact) return exact

  const candidates = projects.filter((project) =>
    names(project).some((name) => {
      const other = spokenKey(name)
      return other.length > 0 && (other.startsWith(key) || key.startsWith(other))
    }),
  )
  const unique = new Set(candidates.map((project) => normalizePath(project.root).toLowerCase()))
  if (unique.size === 1) return candidates[0]!

  throw unknownProject(spoken, projects)
}

function unknownProject(spoken: string, projects: readonly { name: string }[]): Error {
  const said = spoken.trim()
  if (projects.length === 0) {
    return new Error(`Non conosco il progetto «${said}»: non ho nessun progetto in elenco.`)
  }
  const options = projects.map((project) => project.name).join(", ")
  return new Error(`Non conosco il progetto «${said}». Ho in elenco: ${options}.`)
}
