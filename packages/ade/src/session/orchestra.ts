/**
 * The decisions behind `ade-msg spawn` as an orchestration tool: what a
 * subagent is called, where it works, how deep the tree may grow, and which
 * options an agent may choose for the session it starts.
 *
 * Pure, like `mailbox.ts`, so each rule is tested rather than trusted.
 */

/** Longest name a session may be given. It is a title and a branch segment. */
export const MAX_NAME = 40

/** How deep sessions may start sessions, unless `ade.mailbox.maxDepth` says otherwise. */
export const DEFAULT_MAX_DEPTH = 2

/**
 * A name as the user will see it and type it, or an error.
 *
 * Refused rather than repaired: the agent that chose it is about to address
 * the session by it, and a name ADE quietly changed is one that agent cannot
 * find. Slashes are out because `progetto/nome` is how another project is
 * named; digits alone are out because a bare number is a position in the list.
 */
export function checkName(raw: string): { name: string } | { error: string } {
  const name = raw.trim()
  if (!name) return { error: "il nome è vuoto" }
  if (name.length > MAX_NAME) return { error: `il nome supera ${MAX_NAME} caratteri` }
  if (/^\d+$/.test(name)) return { error: "il nome non può essere solo un numero (i numeri sono le posizioni in ade-msg list)" }
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f"]/.test(name)) return { error: "il nome non può contenere / \\ \" o caratteri di controllo" }
  return { name }
}

/** A name another session already has is taken, whatever the case. */
export function nameTaken(titles: readonly string[], name: string): boolean {
  const wanted = name.trim().toLowerCase()
  return titles.some((title) => title.trim().toLowerCase() === wanted)
}

/** The name as a branch and folder segment: lowercase ASCII, digits and dashes. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME)
  return slug || "sessione"
}

/**
 * Where a `--worktree` session works: branch `ade/<slug>`, in a folder beside
 * the project named `<progetto>-worktrees/<slug>`.
 *
 * Beside and not inside, because a checkout inside the project is a directory
 * every search, watcher and `git status` of the main tree walks into. Beside
 * and not in a temp directory, because on this machine the agents cannot write
 * outside the user's folders, and because the user has to be able to find it.
 *
 * Not `<progetto>-ade`: that is the name people give their own ADE worktree,
 * and a spawn from `nikcli` put its checkout inside `nikcli-ade` (S24). The
 * caller still checks the folder is not inside another repository.
 */
export function worktreePlan(root: string, slug: string): { branch: string; path: string; container: string } {
  const trimmed = root.replace(/[\\/]+$/, "")
  const sep = trimmed.includes("\\") ? "\\" : "/"
  const container = `${trimmed}-worktrees`
  return { branch: `ade/${slug}`, path: `${container}${sep}${slug}`, container }
}

/** A branch or commit a worktree may start from: a git ref, never an option. */
export function isBaseRef(ref: string): boolean {
  return /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes("..") && !ref.endsWith(".lock")
}

/** `git worktree add` for a plan, from `base` when given (otherwise the project's HEAD). */
export function worktreeAddArgs(plan: { branch: string; path: string }, base?: string): string[] {
  return ["worktree", "add", "-b", plan.branch, plan.path, ...(base ? [base] : [])]
}

/**
 * How many `spawn`s separate a session from one the user started: 0 for the
 * user's own, 1 for their subagent, and so on. A cycle — which a hand-edited
 * store could hold — ends the count instead of hanging it.
 */
export function depthOf(paneId: string, parentOf: (paneId: string) => string | undefined): number {
  const seen = new Set<string>([paneId])
  let depth = 0
  let current = parentOf(paneId)
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    depth++
    current = parentOf(current)
  }
  return depth
}

/**
 * Every session below this one, children after their own children, so closing
 * them in order never leaves a session whose parent is already gone.
 */
export function descendants(paneId: string, parents: ReadonlyMap<string, string>): string[] {
  const out: string[] = []
  const visit = (id: string, seen: Set<string>) => {
    for (const [child, parent] of parents) {
      if (parent !== id || seen.has(child)) continue
      seen.add(child)
      visit(child, seen)
      out.push(child)
    }
  }
  visit(paneId, new Set([paneId]))
  return out
}

/**
 * The arguments that choose a model, for the agents whose flag is known.
 *
 * Only the model, and not arbitrary arguments: an agent choosing its
 * subagent's command line could just as well choose
 * `--dangerously-skip-permissions`, and a prompt injected into one session
 * would then run unconfirmed commands in another. The model is the choice
 * that matters for cost, and it cannot widen what a session may do.
 *
 *   claude  --model <m>
 *   codex   -m <m>
 *   agy     --model <m>   (ids from `agy models`)
 */
export function modelArgs(agentId: string, model: string): string[] | { error: string } {
  const value = model.trim()
  if (!/^[A-Za-z0-9._:\-/]{1,80}$/.test(value)) return { error: `modello non valido: ${model}` }
  switch (agentId) {
    case "claude-code":
    case "agy":
      return ["--model", value]
    case "codex":
      return ["-m", value]
    default:
      return { error: `ADE non sa come scegliere il modello per ${agentId}: avvialo senza --model` }
  }
}

/**
 * The effort levels each agent takes at start, and how it is told.
 *
 * Read off each CLI's `--help` and checked in the transcripts (2026-09-15):
 *
 *   claude   --effort <low|medium|high|xhigh|max>; the transcript records it
 *            for sonnet and opus, and nothing for haiku, which ignores it
 *   codex    -c model_reasoning_effort="<level>"   (no flag of its own)
 *   agy      the effort is part of the model id (`gemini-3.8-flash-high`):
 *            its `--effort` flag logs "not supported for model" and the
 *            session runs at the model's own level
 *
 * nikcli's TUI has no effort flag: its effort is the agent's `variant`. An
 * effort that would be ignored is refused, never passed while the caller
 * believes it took.
 */
const EFFORTS: Record<string, readonly string[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max"],
  agy: ["low", "medium", "high"],
}

export function effortArgs(agentId: string, effort: string, model?: string): string[] | { error: string } {
  const value = effort.trim().toLowerCase()
  const levels = EFFORTS[agentId]
  if (!levels) {
    return {
      error:
        agentId === "nikcli"
          ? "nikcli non ha un flag per l'effort all'avvio: si imposta nel variant dell'agente; avvialo senza --effort"
          : `ADE non sa come scegliere l'effort per ${agentId}: avvialo senza --effort`,
    }
  }
  if (!levels.includes(value)) return { error: `effort "${effort}" non valido per ${agentId}: ${levels.join(", ")}` }
  if (agentId === "agy") {
    const suffix = /-(low|medium|high)$/.exec(model?.trim() ?? "")?.[1]
    if (!model) return { error: `per agy l'effort è nel nome del modello: usa --model, per esempio gemini-3.8-flash-${value}` }
    if (!suffix) return { error: `il modello ${model} di agy non ha livelli di effort: togli --effort` }
    if (suffix !== value) return { error: `per agy l'effort è nel nome del modello: usa ${model.replace(/-(low|medium|high)$/, `-${value}`)}` }
    return []
  }
  if (agentId === "claude-code" && /haiku/i.test(model ?? "")) {
    return { error: `${model} ignora l'effort: togli --effort o scegli sonnet o opus` }
  }
  return agentId === "codex" ? ["-c", `model_reasoning_effort="${value}"`] : ["--effort", value]
}

/** Spawn arguments with any effort choice taken out, so another can be put in. */
export function withoutEffort(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1]
    if (args[i] === "--effort" && next !== undefined) {
      i++
      continue
    }
    if (args[i] === "-c" && next?.startsWith("model_reasoning_effort=")) {
      i++
      continue
    }
    out.push(args[i]!)
  }
  return out
}

export interface DispatchChoice {
  model?: string
  effort?: string
  why?: string
}

/**
 * The model and effort a dispatch profile names for `agentId`.
 *
 * `dispatch.json` (the team board's folder) lists classes of work, each with
 * candidates `{agent, model, effort, why}`. The caller still names the agent:
 * a profile picks how that agent runs, it does not pick a different one.
 */
export function dispatchChoice(json: string, profile: string, agentId: string): DispatchChoice | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return { error: "dispatch.json non è JSON valido" }
  }
  const classes = (data as { classes?: unknown }).classes
  if (!Array.isArray(classes)) return { error: "dispatch.json non ha classes" }
  const named = classes.find((entry) => entry && typeof entry === "object" && (entry as { when?: unknown }).when === profile) as
    | { candidates?: unknown }
    | undefined
  if (!named) {
    const names = classes.map((entry) => (entry as { when?: unknown })?.when).filter((name) => typeof name === "string")
    return { error: `profilo "${profile}" non trovato in dispatch.json: ${names.join(", ")}` }
  }
  const candidates = Array.isArray(named.candidates) ? (named.candidates as Record<string, unknown>[]) : []
  const hit = candidates.find((candidate) => candidate?.agent === agentId)
  if (!hit) {
    const agents = candidates.map((candidate) => candidate?.agent).filter((agent) => typeof agent === "string")
    return { error: `il profilo "${profile}" non prevede ${agentId}: candidati ${agents.join(", ") || "nessuno"}` }
  }
  const text = (key: string) => (typeof hit[key] === "string" && (hit[key] as string).trim() ? (hit[key] as string).trim() : undefined)
  const model = text("model")
  const effort = text("effort")
  const why = text("why")
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(why ? { why } : {}) }
}

/** The model named in spawn arguments, if any. */
export function modelIn(args: readonly string[]): string | undefined {
  const at = args.findIndex((arg) => arg === "--model" || arg === "-m")
  return at >= 0 ? args[at + 1] : undefined
}

/** Spawn arguments with any model choice taken out, so another can be put in. */
export function withoutModel(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--model" || args[i] === "-m") && i + 1 < args.length) {
      i++
      continue
    }
    out.push(args[i]!)
  }
  return out
}

/**
 * Arguments a session in a worktree needs to stay in it.
 *
 * agy resolves its workspace to the repository root rather than to the
 * directory it starts in, so from a worktree it reads and edits the main
 * checkout unless the worktree is added explicitly.
 */
export function worktreeArgs(agentId: string, path: string): string[] {
  return agentId === "agy" ? ["--add-dir", path] : []
}

/** Where a subagent writes what does not fit in its reply. */
export function resultsDir(cwd: string): string {
  const sep = cwd.includes("\\") ? "\\" : "/"
  return `${cwd.replace(/[\\/]+$/, "")}${sep}.ade${sep}results`
}

/** The line `.git/info/exclude` needs so results never show up in `git status`, if it is missing. */
export function excludeWithAde(current: string): string | undefined {
  const lines = current.split(/\r?\n/)
  if (lines.some((line) => line.trim() === ".ade/" || line.trim() === ".ade")) return undefined
  const base = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`
  return `${base}# ADE: risultati dei subagent\n.ade/\n`
}
