/**
 * Whether each runner is installed here, and signed in.
 *
 * The rules for reading the answers are in `runners.ts`; this only asks. The
 * status commands are quick and local — `claude auth status`, `codex login
 * status`, `nikcli auth list` read a credentials file and print — so they run
 * each time the Provider section opens, and nothing is cached that could say
 * "collegato" about an account the user has since signed out of.
 */

import { getHost } from "../host/shell"
import { readLoginStatus, type LoginState, type Runner } from "./runners"

export interface ProviderState {
  readonly installed: boolean
  /** Where the executable was found, when it was. */
  readonly path?: string
  readonly login: LoginState
}

/** How long a status command may take before it is reported as unknown. */
const STATUS_TIMEOUT_MS = 15_000

export async function providerState(runner: Runner): Promise<ProviderState> {
  const host = await getHost()
  if (!host) return { installed: false, login: { state: "unknown", detail: "Solo nell'app desktop." } }

  const path = await host.probe(runner.command, "--version").catch(() => null)
  if (path === null) return { installed: false, login: { state: "out", detail: "Non installato." } }
  const found = path.split("\n")[0]?.trim()
  const base = { installed: true, ...(found ? { path: found } : {}) }

  if (!runner.status) return { ...base, login: readLoginStatus(runner, "", null) }

  /*
   * Through a pty for every runner, nikcli included: `nikcliBot` runs only
   * the two commands the bot form needs, and the host is right to keep it so.
   */
  if (!host.spawn) return { ...base, login: { state: "unknown", detail: "Stato non disponibile." } }
  const lines: string[] = []
  const status = runner.status
  const login = await new Promise<LoginState>((resolve) => {
    let settled = false
    let kill: (() => void) | undefined
    const finish = (value: LoginState) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      kill?.()
      finish({ state: "unknown", detail: "Nessuna risposta dal comando di stato." })
    }, STATUS_TIMEOUT_MS)
    host
      .spawn({
        command: runner.command,
        args: [...status],
        cols: 200,
        rows: 50,
        onLine: (line) => lines.push(line),
        onExit: (code) => finish(readLoginStatus(runner, lines.join("\n"), code)),
      })
      .then((session) => {
        kill = () => session.kill()
        if (settled) session.kill()
      })
      .catch((error: unknown) => finish({ state: "unknown", detail: String(error) }))
  })
  return { ...base, login }
}
