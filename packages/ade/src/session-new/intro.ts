/**
 * Telling each agent, as it starts, that it can talk to the other sessions.
 *
 * `ade-msg` is on every session's PATH (`src-tauri/src/mailbox.rs`), and an
 * agent that does not know about it never uses it. The notice goes where the
 * CLI keeps its instructions, not into the conversation: typed as a first
 * message it would cost a turn, answer with a greeting, and land in every
 * session whether or not the user ever wants two agents to talk.
 *
 * Where the flag was read off `--help`:
 *
 *   claude   --append-system-prompt <prompt>
 *   prime    --append-system-prompt <text>
 *   pi       --append-system-prompt <text>
 *   codex    -c developer_instructions=<toml string>   (key present in 0.154)
 *
 * agy, opencode, nikcli, kimi and hermes have no such flag. For them the
 * notice rides in front of the opening task when there is one; a session
 * started with no task learns it from the first message it receives, which
 * carries the reply command.
 *
 * The text avoids `" & | < > ^ %`: on Windows these CLIs are `.cmd` shims, and
 * an argument crosses cmd.exe on its way to the program.
 */

/*
 * Short on purpose: it rides in every session's system prompt, including the
 * many that never message anyone, and each request repeats the reply contract
 * anyway. What is rarely needed (kv, memory, fork, stats, close) is one
 * `ade-msg help` away rather than paid for up front.
 *
 * The one habit worth its words is not polling. A reply that nobody is
 * waiting for is typed into the caller by ADE, so `--no-wait` and carrying on
 * costs nothing, while every `wait` that times out is a whole model turn
 * re-reading the context.
 */
export const INTRO_TEXT =
  "Sei una sessione dentro ADE, con altre sessioni di agenti. Dalla shell usa ade-msg: " +
  "ade-msg list per le sessioni aperte; ade-msg ask SESSIONE TESTO per una richiesta; " +
  "ade-msg spawn AGENTE COMPITO per aprire una sessione nuova (--name NOME, --worktree se deve modificare file, --model ID per compiti semplici); " +
  "ade-msg send SESSIONE TESTO per una nota. SESSIONE e numero, id, titolo o agente. " +
  "Non fare polling: con --no-wait continua il tuo lavoro o chiudi il turno, la risposta ti arriva da sola come [Risposta alla richiesta ...]; " +
  "usa ade-msg wait ID solo se ti serve subito, e non ripeterlo in ciclo. " +
  "Delega compiti grandi, non piccoli, e chiedi sintesi brevi con i dettagli su file. " +
  "A ogni [Richiesta ID ...] rispondi con ade-msg reply ID seguito dalla sintesi; se sei bloccata usa ade-msg update ID bloccata seguito dal motivo. " +
  "Se esiste .ade/memory.md del progetto leggilo prima di esplorare. Un avviso che dice ade-msg inbox si legge con quel comando. Tutti gli altri comandi: ade-msg help. " +
  "Usalo quando l'utente lo chiede o quando coordinarti serve al compito."

/** Arguments that put the notice in the CLI's instructions, or none. */
export function introArgs(agentId: string, text = INTRO_TEXT): string[] {
  switch (agentId) {
    case "claude-code":
    case "prime":
    case "pi":
      return ["--append-system-prompt", text]
    case "codex":
      // A TOML basic string; JSON's escaping is a subset of it.
      return ["-c", `developer_instructions=${JSON.stringify(text)}`]
    default:
      return []
  }
}

/**
 * The opening task, with the notice in front for a CLI that has no flag.
 *
 * Empty stays empty: typing the notice alone would start a turn nobody asked
 * for.
 */
export function withIntro(agentId: string, task: string, text = INTRO_TEXT): string {
  if (!task.trim() || introArgs(agentId, text).length > 0) return task
  return `(${text}) ${task}`
}

/** The command line as the transcript shows it: the notice folded to a mark. */
export function displayArgs(args: readonly string[], text = INTRO_TEXT): string[] {
  return args.map((arg) => arg.replace(text, "…ade-msg…").replace(JSON.stringify("…ade-msg…"), "…ade-msg…"))
}
