/**
 * The agents ADE can start, and how to start them.
 *
 * `command` is what gets executed, so this file is the single place that knows
 * an agent's CLI name. Whether it is installed is answered by looking that name
 * up on PATH rather than by trusting a hardcoded list that rots the moment the
 * user installs or removes one.
 *
 * There is deliberately no per-agent "how to run one task non-interactively"
 * any more. Every one of these is started bare, in a real terminal, exactly as
 * the user would start it themselves — which is the point: what happens next is
 * theirs to decide, not ADE's to script. A session that opens with a task types
 * that task in as the first thing the user would have typed, and one that opens
 * without simply waits, the way a terminal waits.
 */

export interface AgentOption {
  id: string
  label: string
  /** Executable name, resolved on PATH. */
  command: string
}

/*
 * No `glyph` here any more.
 *
 * Every entry used to carry one character — ✳ ◎ ✦ ◧ ◆ ◉ — described in its own
 * doc comment as a stand-in "until real icons are wired". They are wired now,
 * in `agent-mark.tsx`, and a placeholder left in the catalogue is a second
 * answer to "what does this agent look like" that nothing keeps in step with
 * the first.
 */
export const AGENTS: AgentOption[] = [
  { id: "claude-code", label: "Claude Code", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
  { id: "opencode", label: "OpenCode", command: "opencode" },
  { id: "nikcli", label: "nikcli", command: "nikcli" },
  { id: "agy", label: "agy", command: "agy" },
  { id: "kimi", label: "Kimi Code", command: "kimi" },
  { id: "prime", label: "Prime Agent", command: "prime" },
  { id: "pi", label: "pi", command: "pi" },
  { id: "ohmypi", label: "OhMyPi", command: "ohmypi" },
  { id: "hermes", label: "Hermes", command: "hermes" },
  {
    id: "terminal",
    label: "Terminal",
    // Not an agent: the shell a workbench preset drops into its second slot.
    command: systemShell(),
  },
]

/**
 * The shell this machine has, named the way PATH will find it.
 *
 * `terminal` used to carry an empty command while staying selectable in the
 * new-session form, and `startProcess` begins with `if (!agent.command) return`
 * — so choosing Terminal and pressing Avvia created a pane that sat at
 * "Inizializzazione" forever, with no error anywhere. A pane that never starts
 * is worse than one that fails.
 *
 * A constant rather than a probe: the one program every machine has is a
 * shell, and only its name differs. Kept in step with ALLOWED_SHELLS in
 * `src-tauri/src/pty.rs`, which decides what may actually be started.
 */
export function systemShell(): string {
  const agent = typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : ""
  if (/win/i.test(agent)) return "cmd"
  // macOS has shipped zsh as the login shell since Catalina; its `sh` is a
  // bash 3.2 that reads none of the user's profile, so the prompt came up as
  // `sh-3.2$` without the PATH anything in the terminal is installed on.
  if (/mac/i.test(agent)) return "zsh"
  return "sh"
}

export function agentById(id: string): AgentOption | undefined {
  return AGENTS.find((agent) => agent.id === id)
}

export function agentLabel(id: string): string {
  return agentById(id)?.label ?? id
}

/*
 * No brand colours here either.
 *
 * There was an `AGENT_BRANDS` table — colour, tint, border per agent — that
 * the launcher wrote into each tile as inline `--cli-*` variables. The same
 * variables are declared per `[data-agent-id]` in `session-new.css`, with
 * light and dark values and a glow the table never had; the inline copy won
 * on specificity and quietly overrode the file that looked authoritative.
 * Two tables of the same colours drift, and these had: the CSS said one teal
 * for Codex and the table another. The stylesheet is now the one place, next
 * to the rules that use the values, and `agent-mark.tsx` says which colours
 * are actually the vendors'.
 */
