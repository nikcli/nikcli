/**
 * A Claude Code process kept running between spoken turns.
 *
 * A turn started from nothing spends about a second and a half before the
 * model is even asked: the CLI boots, reads its configuration, and sends a
 * system prompt the service has not seen for a while. The voice pays that on
 * every sentence. Claude Code can instead read one user message per line on
 * stdin (`--input-format stream-json`) and answer each in turn, in the same
 * conversation, so a process started ahead waits for the next sentence and
 * answers it in well under a second.
 *
 * One process per project, for one configuration (model, effort,
 * instructions, refused tools), and at most `WARM_PROJECTS` projects. A turn
 * that asks for another configuration replaces its project's process. A
 * stopped or failed turn kills it, and the next one starts a new process that
 * resumes the same conversation. Each project keeps its own conversation:
 * back in a project, the voice goes on with what was said there. Left unused,
 * a process is closed.
 *
 * ```ts
 * const warm = createWarmClaude()
 * warm.prepare(request)            // when the microphone opens
 * const turn = warm.run(request)   // when the sentence arrives
 * ```
 */

import { getHost, type SpawnedSession } from "../host/shell"
import { registerSender, unregisterSender } from "../session/senders"
import type { AgentFile } from "./nikcli"
import { applyRunnerLine, finalText, runnerById, turnCommand } from "./runners"
import { applyExit, applyProblem, emptyTalk, sendMessage, type Talk } from "./talk"
import { acquireTurn } from "./terms"
import { markTurn, TURN_TIMEOUT_MS, timeoutProblem, type Turn, type TurnDeps, type TurnRequest, type TurnResult } from "./turn"

/** How long a process may wait for a sentence before it is closed. */
export const WARM_IDLE_MS = 10 * 60_000

/** How many projects keep a process waiting; the least recently used goes first. */
export const WARM_PROJECTS = 2

export interface WarmClaude {
  /** Starts a process for this configuration now, if none is ready. */
  prepare(request: TurnRequest): void
  /** One turn, on the process ready for this configuration or on a new one. */
  run(request: TurnRequest): Turn
  /** The next turn starts a new conversation. */
  forget(): void
  /** Closes the processes; one answering a turn is closed when the turn ends. */
  close(): void
}

/** What makes two requests need different processes. */
function configKey(request: TurnRequest): string {
  return JSON.stringify([
    request.cwd ?? "",
    request.model ?? "",
    request.effort ?? "",
    request.instructions ?? "",
    [...(request.disabledTools ?? [])].sort(),
    request.mailbox?.id ?? "",
    request.lean === true,
    request.partial === true,
  ])
}

/** The line Claude Code reads as one user message. */
export function userMessageLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } })
}

interface Live {
  readonly key: string
  session?: SpawnedSession
  starting: Promise<SpawnedSession | undefined>
  exited: boolean
  sessionId?: string
  /** The turn this process is answering, if any. */
  line?: (line: string) => void
  exit?: (code: number | null) => void
  token?: string
  mailbox?: string
  idle?: ReturnType<typeof setTimeout>
  /** Closed as soon as its turn ends: see `close`. */
  closeAfterTurn?: boolean
}

export function createWarmClaude(deps: TurnDeps & { idleMs?: number } = {}): WarmClaude {
  const runner = runnerById("claude")
  /* By project, least recently used first. */
  const lives = new Map<string, Live>()
  /*
   * The conversation to resume when a project's process has to be replaced.
   * By project: Claude Code keeps conversations per folder, and `--resume`
   * with another folder's fails the turn.
   */
  const resumes = new Map<string, string>()
  const cwdOf = (request: TurnRequest) => request.cwd ?? ""

  function kill(target: Live | undefined): void {
    if (!target) return
    clearTimeout(target.idle)
    target.exited = true
    if (target.mailbox && target.token) unregisterSender(target.mailbox, target.token)
    target.session?.kill({ tree: true })
    void target.starting.then((session) => session?.kill({ tree: true }))
    for (const [cwd, other] of lives) if (other === target) lives.delete(cwd)
  }

  function idleFrom(target: Live): void {
    clearTimeout(target.idle)
    if (target.exited) return
    target.idle = setTimeout(() => kill(target), deps.idleMs ?? WARM_IDLE_MS)
  }

  function start(request: TurnRequest): Live {
    const key = configKey(request)
    const target: Live = { key, exited: false, starting: Promise.resolve(undefined) }
    target.starting = (async () => {
      const host = await (deps.host ?? getHost)()
      if (!host?.spawn || target.exited) return undefined
      const bot: AgentFile = {
        identifier: "",
        path: "",
        scope: "global",
        description: "",
        mode: "primary",
        prompt: request.instructions ?? "",
        disabledTools: request.disabledTools ?? [],
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        runner: "claude",
      }
      const mailbox = request.mailbox ? await host.mailboxDir?.().catch(() => undefined) : undefined
      const outbox = mailbox ? `${mailbox.replace(/[\\/]+$/, "")}/outbox` : undefined
      const resumeId = resumes.get(cwdOf(request))
      const { command, args } = turnCommand(runner, {
        bot,
        message: "",
        stdin: true,
        ...(resumeId ? { sessionId: resumeId } : {}),
        ...(request.lean ? { lean: true } : {}),
        ...(request.partial ? { partial: true } : {}),
        ...(outbox ? { outbox } : {}),
      })
      if (request.mailbox) {
        target.token = crypto.randomUUID()
        target.mailbox = request.mailbox.id
        registerSender(request.mailbox.id, target.token)
      }
      const session = await host.spawn({
        command,
        args,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        cols: 400,
        rows: 50,
        pipe: true,
        ...(request.mailbox && target.token ? { pane: request.mailbox.id, paneToken: target.token } : {}),
        onLine: (line) => target.line?.(line),
        onExit: (code) => {
          const wasLive = !target.exited
          kill(target)
          if (wasLive) target.exit?.(code)
        },
      })
      target.session = session
      if (target.exited) session.kill({ tree: true })
      return session
    })().catch(() => {
      kill(target)
      return undefined
    })
    idleFrom(target)
    return target
  }

  function ready(request: TurnRequest): Live {
    const key = configKey(request)
    const cwd = cwdOf(request)
    let live = lives.get(cwd)
    if (live && (live.key !== key || live.exited)) {
      markTurn("cli-replaced", live.exited ? "uscito" : `${live.key} -> ${key}`)
      kill(live)
      live = undefined
    }
    if (!live) {
      markTurn("cli-started")
      live = start(request)
    }
    live.closeAfterTurn = false
    // Most recently used last; the oldest idle one makes room.
    lives.delete(cwd)
    lives.set(cwd, live)
    for (const other of [...lives.values()]) {
      if (lives.size <= WARM_PROJECTS) break
      if (other !== live && !other.line) kill(other)
    }
    return live
  }

  return {
    prepare(request) {
      const busy = lives.get(cwdOf(request))
      if (busy?.line) {
        // Wanted again: kept after its turn, whatever a close asked before.
        busy.closeAfterTurn = false
        return
      }
      ready(request)
    },

    run(request) {
      let stopped = false
      let stopTarget: (() => void) | undefined
      const result = (async (): Promise<TurnResult> => {
        let talk: Talk = sendMessage(emptyTalk(), request.message, Date.now())
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

        const slot = acquireTurn(runner.id, runner.label)
        if ("problem" in slot) {
          update(applyProblem(talk, slot.problem, Date.now()))
          return finish("error", slot.problem)
        }
        // A process busy with another turn is not this turn's to share.
        for (const busy of [...lives.values()]) if (busy.line) kill(busy)
        const target = ready(request)
        clearTimeout(target.idle)
        const timeoutMs = request.timeoutMs ?? TURN_TIMEOUT_MS
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const outcome = await new Promise<"done" | "exit" | "timeout" | "stopped" | "nohost">((resolve) => {
            stopTarget = () => {
              kill(target)
              resolve("stopped")
            }
            if (stopped) return stopTarget()
            timer = setTimeout(() => {
              kill(target)
              resolve("timeout")
            }, timeoutMs)
            target.exit = (code) => {
              update(applyExit(talk, code, Date.now(), runner.label))
              resolve("exit")
            }
            target.line = (line) => {
              const before = talk
              update(applyRunnerLine(runner, talk, line, Date.now()))
              if (!before.sessionId && talk.sessionId) markTurn("cli-init")
              if (!before.streaming && talk.streaming) markTurn("cli-first-text")
              if (talk.ended) {
                markTurn("cli-result")
                resolve("done")
              }
            }
            void target.starting.then((session) => {
              if (!session) return resolve(target.exited ? "exit" : "nohost")
              if (target.exited) return
              markTurn("cli-sent")
              session.write(`${userMessageLine(request.message)}\n`)
            })
          })
          target.line = undefined
          target.exit = undefined
          if (talk.sessionId) {
            target.sessionId = talk.sessionId
            resumes.set(cwdOf(request), talk.sessionId)
          } else if (talk.status === "error") {
            // Claude Code no longer has the conversation (see `applyClaudeEvent`).
            resumes.delete(cwdOf(request))
          }
          if (target.closeAfterTurn) kill(target)
          switch (outcome) {
            case "stopped":
              return finish("stopped")
            case "timeout": {
              const problem = timeoutProblem(runner.label, timeoutMs)
              update(applyProblem(talk, problem, Date.now()))
              return finish("error", problem)
            }
            case "nohost": {
              const problem = "Nessun host: un turno si esegue solo nell'app desktop."
              update(applyProblem(talk, problem, Date.now()))
              return finish("error", problem)
            }
            case "exit":
              if (talk.status !== "error") {
                update(applyProblem(talk, `${runner.label} si è chiuso prima di rispondere.`, Date.now()))
              }
              return finish("error", talk.problem ?? talk.messages.at(-1)?.text)
            case "done":
              idleFrom(target)
              if (talk.status === "error") {
                // A failed turn may leave the process in any state: the next one starts clean.
                kill(target)
                return finish("error", talk.messages.at(-1)?.text)
              }
              return finish("done")
          }
        } finally {
          clearTimeout(timer)
          slot.release()
        }
      })()
      return {
        result,
        stop: () => {
          stopped = true
          stopTarget?.()
        },
      }
    },

    forget() {
      resumes.clear()
      for (const live of [...lives.values()]) kill(live)
    },

    close() {
      for (const live of [...lives.values()]) {
        if (live.line) live.closeAfterTurn = true
        else kill(live)
      }
    },
  }
}
