/**
 * What a spoken plan is allowed to be.
 *
 * The planner turns a sentence into steps by asking a language model, which
 * means the steps arrive as whatever the model felt like emitting. This module
 * is the border: nothing reaches `VoiceHost` that has not been checked against
 * what this installation can actually do — a real agent, an open project, a
 * pane that exists, a count a person could plausibly have meant.
 *
 * Two deliberate omissions, both about blast radius:
 *
 * - There is no destructive step. Closing a pane and killing a process stay in
 *   the hand-written grammar, behind the spoken confirmation they already
 *   have. A model cannot be talked into destroying anything here because the
 *   vocabulary to do so does not exist in this file.
 * - There is a hard ceiling on steps. "Avvia quattro sessioni" misheard as
 *   "quaranta" is one vowel, and forty agent sessions is real money and a
 *   machine on its knees.
 */

export type PlanStep =
  | { action: "start_session"; agent: string; task?: string; project?: string }
  | { action: "open_project"; project: string }
  | { action: "run_command"; command: string }
  | { action: "focus_pane"; paneIndex: number }
  | { action: "send_prompt"; paneIndex: number; text: string }

export interface PlanContext {
  /** Agents this installation can start, as `listAgents` reports them. */
  agents: readonly { id: string; label: string; available: boolean }[]
  /** Projects reachable by name. */
  projects: readonly { name: string; root: string; isOpen: boolean }[]
  /** How many panes are open, so a pane index can be checked. */
  paneCount: number
  /** Command ids `runCommand` accepts. */
  commands: readonly string[]
  /** Recent dialogue turns for multi-turn conversational reasoning. */
  recentHistory?: readonly { role: "user" | "assistant" | "action"; text: string }[]
  /** Currently focused pane title or status summary. */
  focusedPaneTitle?: string
  /** Active project name or root path. */
  activeProjectName?: string
}

export interface ValidatedPlan {
  steps: PlanStep[]
  /**
   * What was dropped and why, in Italian, ready to be spoken.
   *
   * Reported rather than swallowed: a plan that silently loses half its steps
   * and then announces success is worse than one that says "di quattro ne ho
   * avviate tre, il progetto «pippo» non lo conosco".
   */
  refusals: string[]
  /**
   * Intelligent conversational response spoken by Jarvis, in Italian.
   * Present when the user asked a technical/contextual question, or when Jarvis
   * contextualizes the operations it is carrying out.
   */
  speech?: string
}

/**
 * The most steps one utterance may produce.
 *
 * Twelve is above anything a person says in one breath and far below the cost
 * of a misheard number.
 */
export const MAX_PLAN_STEPS = 12

/**
 * The command ids a plan may name.
 *
 * `VoiceHost.runCommand` accepts more than this — `pane.close` and
 * `process.kill` among them — and that is exactly why the list is written out
 * here instead of being taken from the host. Without it, the promise at the
 * top of this file would be a fiction: there is no destructive *step*, but a
 * destructive *command* would walk straight through `run_command` and end a
 * session the user never agreed to end.
 *
 * Those two stay in the hand-written grammar, which asks first.
 */
export const PLANNABLE_COMMANDS: readonly string[] = [
  "palette.open",
  "session.new",
  "browser.new",
  "view.toggle",
  "theme.toggle",
]

/** Comparison form for things a person said out loud. */
function key(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "")
}

/**
 * Finds the agent a spoken word meant, or `undefined`.
 *
 * Tolerant because the model is repeating what a person said: "claude",
 * "Claude Code" and "claude-code" are one agent, and an exact-id match would
 * reject two of the three spellings anybody actually uses.
 */
export function resolveAgent(
  spoken: string,
  agents: PlanContext["agents"],
): { id: string; label: string; available: boolean } | undefined {
  const wanted = key(spoken)
  if (!wanted) return undefined
  return (
    agents.find((agent) => key(agent.id) === wanted || key(agent.label) === wanted) ??
    // A prefix match catches "claude" against "claude-code", and is only
    // trusted when exactly one agent matches: with two it is a guess.
    singleMatch(agents.filter((agent) => key(agent.id).startsWith(wanted) || key(agent.label).startsWith(wanted)))
  )
}

/** Finds the project a spoken word meant, by name or by path. */
export function resolveProject(
  spoken: string,
  projects: PlanContext["projects"],
): { name: string; root: string; isOpen: boolean } | undefined {
  const wanted = key(spoken)
  if (!wanted) return undefined
  return (
    projects.find((project) => key(project.name) === wanted || key(project.root) === wanted) ??
    singleMatch(projects.filter((project) => key(project.name).startsWith(wanted)))
  )
}

function singleMatch<T>(matches: T[]): T | undefined {
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Turns whatever the model produced into steps this host can run.
 *
 * `raw` is deliberately `unknown`: it comes from `JSON.parse` of generated
 * text, so every field is a claim, not a fact.
 */
export function validatePlan(raw: unknown, context: PlanContext): ValidatedPlan {
  const steps: PlanStep[] = []
  const refusals: string[] = []

  const speech =
    typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).speech === "string"
      ? ((raw as Record<string, unknown>).speech as string).trim() || undefined
      : undefined

  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { steps?: unknown }).steps)
      ? (raw as { steps: unknown[] }).steps
      : undefined

  // If there are no steps list and no speech was provided, it's unparseable
  if (!list && !speech) {
    return { steps, refusals: ["Non sono riuscito a costruire un piano da quella frase."] }
  }

  if (list) {
    let overflow = 0
    for (const entry of list) {
      if (steps.length >= MAX_PLAN_STEPS) {
        overflow += 1
        continue
      }
      const step = validateStep(entry, context, refusals)
      if (step) steps.push(step)
    }

    if (overflow > 0) {
      refusals.push(`Erano ${list.length} operazioni: mi fermo a ${MAX_PLAN_STEPS}, il resto dimmelo di nuovo.`)
    }
  }

  return { steps, refusals, ...(speech ? { speech } : {}) }
}

function validateStep(entry: unknown, context: PlanContext, refusals: string[]): PlanStep | undefined {
  if (typeof entry !== "object" || entry === null) {
    refusals.push("Ho ricevuto un'operazione che non so leggere.")
    return undefined
  }
  const raw = entry as Record<string, unknown>
  const action = typeof raw.action === "string" ? raw.action : ""

  switch (action) {
    case "start_session": {
      const spoken = typeof raw.agent === "string" ? raw.agent : ""
      const agent = resolveAgent(spoken, context.agents)
      if (!agent) {
        const known = context.agents.map((a) => a.label).join(", ")
        refusals.push(
          spoken
            ? `Non conosco l'agente «${spoken}». Posso avviare: ${known}.`
            : `Non ho capito quale agente avviare. Posso avviare: ${known}.`,
        )
        return undefined
      }
      /*
       * An unavailable agent is refused here rather than started and left to
       * fail, because a pane stuck on "Inizializzazione" says nothing, while
       * a sentence naming the missing CLI tells the user what to install.
       */
      if (!agent.available) {
        refusals.push(`${agent.label} non risulta installato.`)
        return undefined
      }

      const project = optionalProject(raw.project, context, refusals)
      if (project === "invalid") return undefined

      const task = typeof raw.task === "string" && raw.task.trim() ? raw.task.trim() : undefined
      return {
        action: "start_session",
        agent: agent.id,
        ...(task ? { task } : {}),
        ...(project ? { project: project.root } : {}),
      }
    }

    case "open_project": {
      const project = optionalProject(raw.project, context, refusals)
      if (project === "invalid" || !project) {
        if (project !== "invalid") refusals.push("Non ho capito quale progetto aprire.")
        return undefined
      }
      return { action: "open_project", project: project.root }
    }

    case "run_command": {
      const command = typeof raw.command === "string" ? raw.command.trim() : ""
      if (!context.commands.includes(command)) {
        refusals.push(`Il comando «${command || "senza nome"}» non esiste.`)
        return undefined
      }
      return { action: "run_command", command }
    }

    case "focus_pane": {
      const index = paneIndex(raw.paneIndex, context, refusals)
      return index === undefined ? undefined : { action: "focus_pane", paneIndex: index }
    }

    case "send_prompt": {
      const index = paneIndex(raw.paneIndex, context, refusals)
      if (index === undefined) return undefined
      const text = typeof raw.text === "string" ? raw.text.trim() : ""
      if (!text) {
        refusals.push("Un messaggio da inviare era vuoto.")
        return undefined
      }
      return { action: "send_prompt", paneIndex: index, text }
    }

    default:
      refusals.push(`Non so fare «${action || "operazione senza nome"}».`)
      return undefined
  }
}

/** `undefined` = not asked for; `"invalid"` = asked for and unknown. */
function optionalProject(
  value: unknown,
  context: PlanContext,
  refusals: string[],
): { name: string; root: string; isOpen: boolean } | undefined | "invalid" {
  if (typeof value !== "string" || !value.trim()) return undefined
  const project = resolveProject(value, context.projects)
  if (!project) {
    refusals.push(`Non conosco il progetto «${value.trim()}».`)
    return "invalid"
  }
  return project
}

function paneIndex(value: unknown, context: PlanContext, refusals: string[]): number | undefined {
  const index = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(index) || index < 1 || index > context.paneCount) {
    refusals.push(
      context.paneCount === 0
        ? "Non c'è nessun pannello aperto."
        : `Il pannello ${String(value)} non esiste: ce ne sono ${context.paneCount}.`,
    )
    return undefined
  }
  return index
}
