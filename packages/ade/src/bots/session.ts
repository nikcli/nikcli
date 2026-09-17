/**
 * One turn of a conversation, as a process.
 *
 * The host's `spawn` is the same one the grid uses for a session: a pty, with
 * the output handed back as raw chunks and as whole lines. Here the lines
 * are JSON events (see `talk.ts`) and the chunks are watched only for the
 * permission menu, which is drawn in place and may never end its line.
 *
 * `run` was not used for this: it is the host's git runner and refuses
 * anything else, and `nikcliBot` — the bots panel's own command — buffers
 * until exit, which for a turn that may take a minute is a minute of nothing
 * on screen.
 *
 * Wide, so a JSON event never wraps: a pty does not insert line breaks into
 * what a program writes, but nikcli's own formatted output does look at the
 * width, and a very wide terminal is the one that never surprises.
 */

import { getHost } from "../host/shell"
import type { AgentFile } from "./nikcli"
import { runnerById, turnCommand } from "./runners"
import { acquireTurn } from "./terms"

export interface TurnHandle {
  /** Keystrokes, exactly as given. Used to answer the permission menu. */
  readonly write: (keys: string) => void
  /** Ends the turn early. Safe to call more than once. */
  readonly kill: () => void
}

export interface TurnInput {
  readonly bot: AgentFile
  readonly message: string
  readonly sessionId?: string
  /** Where nikcli runs, so a project bot resolves. Absent: wherever the host starts processes. */
  readonly cwd?: string
  readonly onLine: (line: string) => void
  readonly onData: (chunk: string) => void
  readonly onExit: (code: number | null) => void
}

export type TurnStart =
  | { readonly ok: true; readonly handle: TurnHandle }
  | { readonly ok: false; readonly problem: string }

export async function startTurn(input: TurnInput): Promise<TurnStart> {
  const host = await getHost()
  if (!host?.spawn) return { ok: false, problem: "Nessun host: si parla con un bot solo nell'app desktop." }

  const runner = runnerById(input.bot.runner)
  const slot = acquireTurn(runner.id, runner.label)
  if ("problem" in slot) return { ok: false, problem: slot.problem }
  const { command, args } = turnCommand(runner, {
    bot: input.bot,
    message: input.message,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    // A bot's turn is ADE's, not the user's: no user MCP, settings or memory (S13).
    lean: true,
  })

  try {
    const session = await host.spawn({
      command,
      args,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      cols: 400,
      rows: 50,
      onData: input.onData,
      onLine: (line) => input.onLine(line),
      onExit: (code) => {
        slot.release()
        input.onExit(code)
      },
    })
    return { ok: true, handle: { write: (keys) => session.write(keys), kill: () => session.kill() } }
  } catch (error) {
    slot.release()
    const said = error instanceof Error ? error.message : String(error)
    return { ok: false, problem: `${runner.label} non si avvia: ${said}` }
  }
}
