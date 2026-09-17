/**
 * One turn on a runner, outside the Bot view.
 *
 * For callers that want an answer rather than a thread on screen: the voice
 * agent hands over what the local grammar could not do, and reads the answer
 * aloud. Same runners and adapters as a bot conversation (`runners.ts`), so a
 * turn here is exactly a bot turn: Claude Code with the user's Anthropic
 * subscription, Codex with ChatGPT, nikcli with its providers.
 *
 * With `mailbox`, the process gets its own `ade-msg` identity for the length
 * of the turn (`session/senders.ts`), so it can list, ask, spawn and close
 * sessions. It has no terminal to be typed into, so answers must be awaited
 * with a blocking `ade-msg ask`; `instructions` is the place to say so.
 *
 * ```ts
 * const turn = runTurn({ runner: "claude", message: "apri una sessione codex sui test", mailbox: { id: "voce" } })
 * const { status, text } = await turn.result
 * ```
 */

import { getHost } from "../host/shell"
import { registerSender, unregisterSender } from "../session/senders"
import { acquireTurn } from "./terms"
import type { AgentFile } from "./nikcli"
import { applyRunnerLine, enforcesDisabledTools, finalText, runnerById, turnCommand, type RunnerId } from "./runners"
import { applyExit, applyProblem, emptyTalk, sendMessage, type Talk } from "./talk"

export interface TurnRequest {
  readonly runner: RunnerId
  readonly message: string
  /** System prompt: who the agent is and how to behave. Claude Code gets it as a system prompt, the others before the message. */
  readonly instructions?: string
  readonly model?: string
  readonly effort?: string
  /** The conversation to continue, from a previous result. */
  readonly sessionId?: string
  readonly cwd?: string
  /** nikcli only: the agent file to run as. Absent: nikcli's default agent. */
  readonly agent?: string
  /** Tools to refuse, as nikcli names them (`bash`, `edit`, `write`…). */
  readonly disabledTools?: readonly string[]
  /** Give the turn an `ade-msg` identity. `id` must be unique while the turn runs. */
  readonly mailbox?: { readonly id: string }
  /** Faster Claude Code turn: no MCP servers, no user settings files, ade-msg still allowed. See `TurnSpec.lean`. */
  readonly lean?: boolean
  /** Claude Code only: the answer as it is written, through `onUpdate` (`Talk.streaming`). */
  readonly partial?: boolean
  /** Every change to the turn as it happens: tool calls, partial text, a permission question. */
  readonly onUpdate?: (talk: Talk) => void
  /** How long the turn may run before it is stopped with its child processes; `TURN_TIMEOUT_MS` when absent. */
  readonly timeoutMs?: number
  /** How long the CLI may take to exit after its final event before it is killed; `TURN_EXIT_GRACE_MS` when absent. */
  readonly exitGraceMs?: number
}

/**
 * How long one turn may run.
 *
 * A turn waits on a CLI that can hang — a stuck network call, an `ade-msg ask`
 * whose session never answers (110 s each), a permission prompt nobody sees —
 * and whoever called it waits with it: the voice assistant stayed in
 * "executing" and kept one of the plan's parallel-turn slots (`terms.ts`).
 * Five minutes is above a turn that lists, asks and spawns, and below what a
 * person waits for a spoken answer before giving up on it.
 */
export const TURN_TIMEOUT_MS = 5 * 60_000

/**
 * How long a CLI may take to exit once its answer is complete.
 *
 * The turn ends at the final event, and the process is left to save and shut
 * down on its own, which takes under a second. One that hangs while closing
 * would stay alive with nobody waiting on it, so past this it is killed with
 * its children.
 */
export const TURN_EXIT_GRACE_MS = 10_000

/** What the caller is told when a turn ran out of time. */
export function timeoutProblem(label: string, timeoutMs: number): string {
  const minutes = timeoutMs / 60_000
  const span = Number.isInteger(minutes)
    ? `${minutes} ${minutes === 1 ? "minuto" : "minuti"}`
    : `${Math.max(1, Math.round(timeoutMs / 1000))} secondi`
  return `${label} non ha finito il turno in ${span}: l'ho fermato.`
}

/** What a turn needs from the app; the machine, passed in so a test can run one. */
export interface TurnDeps {
  readonly host?: () => ReturnType<typeof getHost>
}

export interface TurnResult {
  readonly status: "done" | "error" | "stopped"
  /** The agent's last answer, for reading aloud. Empty if it said nothing. */
  readonly text: string
  /** Pass back as `sessionId` to continue the conversation. */
  readonly sessionId?: string
  readonly tokens: number
  readonly costUsd: number
  /** Why it failed, when it did. */
  readonly problem?: string
  /** Everything that happened, message by message. */
  readonly talk: Talk
}

export interface Turn {
  readonly result: Promise<TurnResult>
  /** Ends the turn early; the result resolves as `stopped`. */
  readonly stop: () => void
}

/* See `@nikcli-ai/voice` `timing.ts`: a no-op unless a harness is measuring. */
export function markTurn(mark: string, detail?: string): void {
  const timeline = (globalThis as { __adeVoiceTimeline?: Array<{ at: number; mark: string; detail?: string }> }).__adeVoiceTimeline
  if (Array.isArray(timeline)) timeline.push({ at: Date.now(), mark, ...(detail ? { detail } : {}) })
}

export function runTurn(request: TurnRequest, deps: TurnDeps = {}): Turn {
  const runner = runnerById(request.runner)
  let stopped = false
  let kill: (() => void) | undefined
  /*
   * Ends the wait for the exit. A killed session unlistens before it could
   * report one, so a stopped or timed-out turn resolved here or never.
   */
  let settle: ((code: number | null) => void) | undefined

  const result = (async (): Promise<TurnResult> => {
    let talk = sendMessage(emptyTalk(), request.message, Date.now())
    const update = (next: Talk) => {
      talk = next
      request.onUpdate?.(talk)
    }
    const finish = (status: TurnResult["status"], problem?: string): TurnResult => ({
      status,
      text: finalText(talk),
      ...(talk.sessionId ? { sessionId: talk.sessionId } : {}),
      tokens: talk.tokens,
      costUsd: talk.costUsd,
      ...(problem ? { problem } : {}),
      talk,
    })

    const host = await (deps.host ?? getHost)()
    if (!host?.spawn) {
      update(applyProblem(talk, "Nessun host: un turno si esegue solo nell'app desktop.", Date.now()))
      return finish("error", talk.problem)
    }

    const bot: AgentFile = {
      identifier: request.agent ?? "",
      path: "",
      scope: "global",
      description: "",
      mode: "primary",
      prompt: request.instructions ?? "",
      disabledTools: request.disabledTools ?? [],
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      runner: runner.id,
    }
    if (bot.disabledTools.length > 0 && !enforcesDisabledTools(runner.id)) {
      const problem = `${runner.label} non può rifiutare gli strumenti che questo turno esclude.`
      update(applyProblem(talk, problem, Date.now()))
      return finish("error", problem)
    }
    // The same mailbox mailbox.rs uses, per worktree in ADE Test (`ADE_MAILBOX_ROOT`).
    const mailbox = request.mailbox ? await host.mailboxDir?.().catch(() => undefined) : undefined
    const outbox = mailbox ? `${mailbox.replace(/[\\/]+$/, "")}/outbox` : undefined
    const { command, args, cwd } = turnCommand(runner, {
      bot,
      message: request.message,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.lean ? { lean: true } : {}),
      ...(request.partial ? { partial: true } : {}),
      ...(outbox ? { outbox } : {}),
    })
    const spawnCwd = cwd ?? request.cwd

    const slot = acquireTurn(runner.id, runner.label)
    if ("problem" in slot) {
      update(applyProblem(talk, slot.problem, Date.now()))
      return finish("error", slot.problem)
    }

    const token = request.mailbox ? crypto.randomUUID() : undefined
    if (request.mailbox && token) registerSender(request.mailbox.id, token)
    const timeoutMs = request.timeoutMs ?? TURN_TIMEOUT_MS
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let exited = false
    let lingering: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        settle = resolve
        timer = setTimeout(() => {
          timedOut = true
          kill?.()
          resolve(null)
        }, timeoutMs)
        host
          .spawn({
            command,
            args,
            ...(spawnCwd ? { cwd: spawnCwd } : {}),
            cols: 400,
            rows: 50,
            ...(request.mailbox && token ? { pane: request.mailbox.id, paneToken: token } : {}),
            onLine: (line) => {
              const before = talk
              update(applyRunnerLine(runner, talk, line, Date.now()))
              if (!before.sessionId && talk.sessionId) markTurn("cli-init")
              if (!before.streaming && talk.streaming) markTurn("cli-first-text")
              if (!before.ended && talk.ended) markTurn("cli-result")
              /*
               * The answer is complete at the CLI's final event. Waiting for the
               * process to exit as well cost ~0.7 s of saving and shutting down
               * on every spoken reply; the exit, when it comes, finds the wait
               * already over.
               */
              if (talk.ended && !lingering && !exited) {
                resolve(0)
                // Outlives the turn on purpose: see `TURN_EXIT_GRACE_MS`.
                lingering = setTimeout(() => {
                  if (!exited) kill?.()
                }, request.exitGraceMs ?? TURN_EXIT_GRACE_MS)
              }
            },
            onExit: (code) => {
              exited = true
              clearTimeout(lingering)
              resolve(code)
            },
          })
          .then((session) => {
            markTurn("cli-spawned")
            kill = () => session.kill({ tree: true })
            if (stopped || timedOut) {
              kill()
              resolve(null)
            }
          })
          .catch(reject)
      })
      if (timedOut) {
        const problem = timeoutProblem(runner.label, timeoutMs)
        update(applyProblem(talk, problem, Date.now()))
        return finish("error", problem)
      }
      update(applyExit(talk, code, Date.now(), runner.label))
      if (stopped) return finish("stopped")
      return talk.status === "error" ? finish("error", talk.messages.at(-1)?.text) : finish("done")
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error)
      update(applyProblem(talk, `${runner.label} non si avvia: ${said}`, Date.now()))
      return finish("error", talk.problem)
    } finally {
      clearTimeout(timer)
      settle = undefined
      slot.release()
      if (request.mailbox && token) unregisterSender(request.mailbox.id, token)
    }
  })()

  return {
    result,
    stop: () => {
      stopped = true
      kill?.()
      settle?.(null)
    },
  }
}
