/**
 * Which program a bot's turns run on.
 *
 * A bot is a nikcli agent file, and nikcli is still the default: its turns are
 * `nikcli run --agent`, with the providers `nikcli auth` knows. But the user's
 * subscriptions are not all reachable from there. An Anthropic subscription is
 * only usable through Claude Code — the Agent SDK is Claude Code as a library,
 * and `claude -p --output-format stream-json` is the same loop from the
 * command line, signed in with the user's own account. A ChatGPT subscription
 * is Codex's. So a bot names its runner, and
 * each runner gets its turn from the CLI the user already signed in to.
 *
 * The runner is ADE's own frontmatter key (`runner:`), like `avatar:`: nikcli
 * ignores keys it does not know, so the file still runs in nikcli's TUI.
 *
 * Every runner prints one JSON object per line, so every adapter here is the
 * same shape: the arguments for one turn, and a fold from an event to the
 * thread. Pure, in a `.ts`, and tested against lines the real CLIs printed.
 */

import { t } from "../i18n"
import { stripAnsi } from "../session/stream"
import type { AgentFile } from "./nikcli"
import { NIKCLI_COMMAND } from "./nikcli"
import { appendMessage, applyJsonLine, applyLine, attachOutput, errorText, runArgs, type Talk } from "./talk"

export type RunnerId = "nikcli" | "claude" | "codex"

export interface Runner {
  readonly id: RunnerId
  readonly label: string
  /** The executable, as the pty allowlist names it. */
  readonly command: string
  /**
   * Models to offer. Empty for nikcli, whose list is asked of nikcli itself.
   * The field stays free text for the others: these CLIs accept aliases and
   * new names long before a list here learns them.
   */
  readonly models: readonly string[]
  readonly efforts: readonly string[]
  /** How to sign in, run in a terminal pane. */
  readonly login: readonly string[]
  /** How to ask whether it is signed in, when the CLI can say. */
  readonly status?: readonly string[]
}

export const RUNNERS: readonly Runner[] = [
  {
    id: "nikcli",
    label: "nikcli",
    command: NIKCLI_COMMAND,
    models: [],
    efforts: ["minimal", "low", "medium", "high", "max"],
    login: ["auth", "login"],
    status: ["auth", "list"],
  },
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    models: [
      "fable",
      "opus",
      "sonnet",
      "haiku",
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    login: ["auth", "login"],
    status: ["auth", "status"],
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    models: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    login: ["login"],
    status: ["login", "status"],
  },
]

export function runnerAccount(id: RunnerId | string): string {
  switch (id) {
    case "claude":
      return t("bots.runner.account.claude")
    case "codex":
      return t("bots.runner.account.codex")
    default:
      return t("bots.runner.account.nikcli")
  }
}

export function runnerById(id: string | undefined): Runner {
  return RUNNERS.find((runner) => runner.id === id) ?? RUNNERS[0]!
}

export function isRunnerId(value: string | undefined): value is RunnerId {
  return RUNNERS.some((runner) => runner.id === value)
}

/* ── one turn ───────────────────────────────────────────────────────────── */

export interface TurnSpec {
  readonly bot: AgentFile
  readonly message: string
  readonly sessionId?: string
  /**
   * Claude Code without the user's MCP servers and settings files: a turn
   * measured at 9.3 s drops to 3.4 s, and the answer loses the connector
   * noise. The account still works, since the login is not a setting. Without
   * user settings `ade-msg` is no longer allowed, so it is allowed here by
   * pattern. Codex gains nothing measurable from the same, so it ignores it.
   *
   * Auto-memory is off too: a bot asked to remember a number wrote it into the
   * user's own Claude memory, where every other session then reads it.
   */
  readonly lean?: boolean
  /**
   * The folder `ade-msg` drops its messages in (`<mailbox>/outbox`), for a
   * turn that may not write but must still talk to ADE. Codex's read-only
   * sandbox refuses that write too, so such a turn runs in `workspace-write`
   * with this folder as its workspace instead of the project: `ade-msg` works
   * and the project stays out of reach.
   */
  readonly outbox?: string
  /** Claude Code sends the answer as it is written (`stream_event`), not only when each message is complete. */
  readonly partial?: boolean
  /**
   * Claude Code reads its messages from stdin, one JSON line each, and stays
   * up between them (`warm.ts`). `message` is then not passed.
   */
  readonly stdin?: boolean
}

/**
 * Whether the runner itself refuses what `disabledTools` turns off, rather
 * than only being asked to. nikcli takes its tools from the agent file, and a
 * turn has no way to hand it others without an environment the pty does not
 * pass, so a tool refused here would still run there.
 */
export function enforcesDisabledTools(id: RunnerId): boolean {
  return id !== "nikcli"
}

/**
 * nikcli's tool names, as Claude Code spells them. A bot with a tool turned
 * off in nikcli has it refused in Claude Code too.
 */
const CLAUDE_TOOLS: Record<string, readonly string[]> = {
  bash: ["Bash", "PowerShell"],
  edit: ["Edit", "NotebookEdit"],
  write: ["Write"],
  read: ["Read"],
  grep: ["Grep"],
  glob: ["Glob"],
  webfetch: ["WebFetch"],
  websearch: ["WebSearch"],
  task: ["Task"],
  todowrite: ["TodoWrite"],
}

function canWrite(bot: AgentFile): boolean {
  return !bot.disabledTools.includes("edit") && !bot.disabledTools.includes("write")
}

/** The bot's persona put before the first message, for a runner with no system prompt flag. */
export function withInstructions(bot: AgentFile, message: string): string {
  if (!bot.prompt.trim()) return message
  return `Istruzioni del bot "${bot.identifier}":\n${bot.prompt.trim()}\n\n---\n\n${message}`
}

export function turnCommand(
  runner: Runner,
  spec: TurnSpec,
): { readonly command: string; readonly args: string[]; readonly cwd?: string } {
  const { bot, message, sessionId } = spec
  switch (runner.id) {
    case "nikcli":
      return {
        command: runner.command,
        args: runArgs({
          identifier: bot.identifier,
          message,
          ...(sessionId ? { sessionId } : {}),
          ...(bot.model ? { model: bot.model } : {}),
          ...(bot.effort ? { effort: bot.effort } : {}),
        }),
      }
    case "claude": {
      /*
       * `-p` cannot ask for permission, so what the bot may do is decided up
       * front: its allowed tools pre-approved, edits accepted when it may
       * write, and anything else refused and reported in the result.
       */
      const args = ["-p", "--output-format", "stream-json", "--verbose"]
      if (spec.stdin) args.push("--input-format", "stream-json")
      if (spec.partial) args.push("--include-partial-messages")
      if (bot.model) args.push("--model", bot.model)
      if (bot.effort) args.push("--effort", bot.effort)
      if (bot.prompt.trim()) args.push("--append-system-prompt", bot.prompt.trim())
      if (sessionId) args.push("--resume", sessionId)
      /*
       * A lean turn without a shell keeps one: `ade-msg`, allowed by pattern.
       * Refusing Bash outright would refuse that too, since a refusal beats
       * any allow; left out of the allowed list instead, every other command
       * is one `-p` cannot ask about, so it is refused. For that to hold, no
       * settings file may pre-approve a command, the project's local one
       * included.
       */
      const adeMsgOnly = spec.lean === true && bot.disabledTools.includes("bash")
      if (spec.lean) {
        const sources = adeMsgOnly || !canWrite(bot) ? "" : "local"
        args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", sources)
        args.push("--settings", '{"autoMemoryEnabled":false}')
      }
      args.push("--permission-mode", canWrite(bot) ? "acceptEdits" : "default")
      const allowed = Object.entries(CLAUDE_TOOLS)
        .filter(([tool]) => !bot.disabledTools.includes(tool))
        .flatMap(([, names]) => names)
      if (spec.lean) allowed.push("Bash(ade-msg *)", "PowerShell(ade-msg *)")
      const disallowed = bot.disabledTools
        .filter((tool) => !(adeMsgOnly && tool === "bash"))
        .flatMap((tool) => CLAUDE_TOOLS[tool] ?? [])
      if (allowed.length > 0) args.push("--allowedTools", allowed.join(","))
      if (disallowed.length > 0) args.push("--disallowedTools", disallowed.join(","))
      if (!spec.stdin) args.push("--", message)
      return { command: runner.command, args }
    }
    case "codex": {
      /* `exec resume` has no `-s`; the sandbox goes through `-c`, which both take. */
      const inOutbox = !canWrite(bot) && spec.outbox !== undefined
      const sandbox = canWrite(bot) || inOutbox ? "workspace-write" : "read-only"
      const config = ["-c", `sandbox_mode="${sandbox}"`, "-c", 'approval_policy="never"']
      if (bot.effort) config.push("-c", `model_reasoning_effort="${bot.effort}"`)
      const model = bot.model ? ["-m", bot.model] : []
      const where = inOutbox ? { cwd: spec.outbox } : {}
      if (sessionId) {
        return {
          command: runner.command,
          args: ["exec", "resume", "--json", "--skip-git-repo-check", ...model, ...config, sessionId, message],
          ...where,
        }
      }
      return {
        command: runner.command,
        args: ["exec", "--json", "--skip-git-repo-check", ...model, ...config, "--", withInstructions(bot, message)],
        ...where,
      }
    }
  }
}

/* ── what comes back ────────────────────────────────────────────────────── */

export function applyRunnerLine(runner: Runner, talk: Talk, line: string, at: number): Talk {
  switch (runner.id) {
    case "nikcli":
      return applyLine(talk, line, at)
    case "claude":
      return applyJsonLine(talk, line, at, applyClaudeEvent)
    case "codex":
      return applyJsonLine(talk, line, at, applyCodexEvent)
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const rec = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function withSession(talk: Talk, id: unknown): Talk {
  const sessionId = str(id)
  return sessionId && !talk.sessionId ? { ...talk, sessionId } : talk
}

/** A tool's input in one line: the command, the path, or the object. */
function describeInput(input: unknown): string {
  const record = rec(input)
  if (!record) return typeof input === "string" ? input : ""
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = str(record[key])
    if (value) return value
  }
  return Object.keys(record).length > 0 ? JSON.stringify(record) : ""
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  return list(content)
    .map((part) => str(rec(part)?.["text"]) ?? "")
    .filter(Boolean)
    .join("\n")
}

/** Only the counters a bill counts; Claude's usage also carries tiers and nested diagnostics. */
function claudeTokens(usage: unknown): number {
  const record = rec(usage)
  if (!record) return 0
  let total = 0
  for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) total += value
  }
  return total
}

/**
 * Claude Code's stream: `system/init` names the session, `assistant` messages
 * carry text and tool calls, `user` messages carry the tools' results, and
 * `result` closes the turn with its cost and whatever was refused.
 */
export function applyClaudeEvent(talk: Talk, event: Record<string, unknown>, at: number): Talk {
  let next = withSession(talk, event["session_id"])
  const message = rec(event["message"])
  switch (event["type"]) {
    case "stream_event": {
      // A subagent's text is not the answer.
      if (event["parent_tool_use_id"]) return next
      const inner = rec(event["event"])
      if (inner?.["type"] === "content_block_start") return { ...next, streaming: "" }
      const delta = rec(inner?.["delta"])
      if (inner?.["type"] !== "content_block_delta" || delta?.["type"] !== "text_delta") return next
      return { ...next, streaming: (next.streaming ?? "") + (str(delta["text"]) ?? "") }
    }
    case "assistant": {
      if (!event["parent_tool_use_id"]) next = { ...next, streaming: undefined }
      for (const raw of list(message?.["content"])) {
        const part = rec(raw)
        if (!part) continue
        if (part["type"] === "text") {
          const text = str(part["text"]) ?? ""
          if (text.trim()) next = appendMessage(next, { role: "bot", text }, at)
        } else if (part["type"] === "tool_use") {
          const tool = str(part["name"]) ?? "tool"
          const id = str(part["id"])
          next = appendMessage(
            next,
            { role: "tool", tool, text: describeInput(part["input"]) || tool, ...(id ? { id: `t-${id}` } : {}) },
            at,
          )
        }
      }
      return next
    }
    case "user": {
      for (const raw of list(message?.["content"])) {
        const part = rec(raw)
        if (part?.["type"] !== "tool_result") continue
        const id = str(part["tool_use_id"])
        if (id) next = attachOutput(next, `t-${id}`, contentText(part["content"]))
      }
      return next
    }
    case "result": {
      const cost = typeof event["total_cost_usd"] === "number" ? (event["total_cost_usd"] as number) : 0
      next = { ...next, tokens: next.tokens + claudeTokens(event["usage"]), costUsd: next.costUsd + cost, ended: true }
      const denials = list(event["permission_denials"])
      if (denials.length > 0) {
        const names = [...new Set(denials.map((d) => str(rec(d)?.["tool_name"]) ?? "tool"))].join(", ")
        next = appendMessage(
          next,
          {
            role: "error",
            text: `Claude Code non ha avuto il permesso per: ${names}. Abilita lo strumento nella scheda del bot.`,
          },
          at,
        )
      }
      if (event["is_error"] === true) {
        const errors = list(event["errors"]).map(str).filter(Boolean).join("\n")
        /*
         * A conversation Claude Code no longer has — its transcript deleted,
         * or never written — cannot be resumed, and every later turn would
         * fail the same way. The id goes, so the next message starts afresh.
         */
        if (/No conversation found/i.test(errors)) {
          const { sessionId: _gone, ...rest } = next
          return {
            ...appendMessage(
              rest,
              {
                role: "error",
                text: "Claude Code non ha più questa conversazione: il prossimo messaggio ne apre una nuova.",
              },
              at,
            ),
            status: "error",
          }
        }
        const text = str(event["result"]) || errors || str(event["subtype"]) || "Claude Code ha concluso con un errore."
        next = { ...appendMessage(next, { role: "error", text }, at), status: "error" }
      }
      return next
    }
    default:
      return next
  }
}

function codexTokens(usage: unknown): number {
  const record = rec(usage)
  if (!record) return 0
  const input = typeof record["input_tokens"] === "number" ? (record["input_tokens"] as number) : 0
  const output = typeof record["output_tokens"] === "number" ? (record["output_tokens"] as number) : 0
  return input + output
}

/**
 * Codex's `exec --json`: `thread.started` names the thread, completed items
 * are the agent's messages and the commands and edits it made, and
 * `turn.completed` carries the usage.
 */
export function applyCodexEvent(talk: Talk, event: Record<string, unknown>, at: number): Talk {
  const next = withSession(talk, event["thread_id"])
  switch (event["type"]) {
    case "item.completed": {
      const item = rec(event["item"])
      if (!item) return next
      switch (item["type"]) {
        case "agent_message": {
          const text = str(item["text"]) ?? ""
          return text.trim() ? appendMessage(next, { role: "bot", text }, at) : next
        }
        case "command_execution": {
          const output = str(item["aggregated_output"])
          return appendMessage(
            next,
            {
              role: "tool",
              tool: "shell",
              text: str(item["command"]) ?? "comando",
              ...(output?.trim() ? { output } : {}),
            },
            at,
          )
        }
        case "file_change": {
          const paths = list(item["changes"])
            .map((c) => str(rec(c)?.["path"]))
            .filter(Boolean)
            .join(", ")
          return appendMessage(next, { role: "tool", tool: "edit", text: paths || "modifica" }, at)
        }
        case "mcp_tool_call": {
          const tool = [str(item["server"]), str(item["tool"])].filter(Boolean).join(".") || "mcp"
          return appendMessage(next, { role: "tool", tool, text: describeInput(item["arguments"]) || tool }, at)
        }
        case "web_search":
          return appendMessage(next, { role: "tool", tool: "web", text: str(item["query"]) ?? "ricerca" }, at)
        default:
          return next
      }
    }
    case "turn.completed":
      /* `cached_input_tokens` is part of `input_tokens`, not on top of it. */
      return { ...next, tokens: next.tokens + codexTokens(event["usage"]), ended: true }
    case "turn.failed":
    case "error": {
      const text = errorText(event["error"] ?? event["message"] ?? event)
      return {
        ...appendMessage(next, { role: "error", text }, at),
        status: "error",
        ...(event["type"] === "turn.failed" ? { ended: true } : {}),
      }
    }
    default:
      return next
  }
}

/**
 * The answer a turn gave, for a caller that wants words rather than a thread:
 * the bot's messages after the last thing the user said, joined. Tool calls
 * and errors are not the answer.
 */
export function finalText(talk: Talk): string {
  const lastUser = talk.messages.map((message) => message.role).lastIndexOf("user")
  return talk.messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "bot")
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

/**
 * The answer so far, while it is being written: `finalText` and the message
 * still arriving. Each call extends the last one, until a message is complete.
 */
export function answerSoFar(talk: Talk): string {
  const done = finalText(talk)
  const writing = talk.streaming?.trim() ? talk.streaming.trimStart() : ""
  if (!writing) return done
  return done ? `${done}\n\n${writing}` : writing
}

/* ── signed in or not ───────────────────────────────────────────────────── */

export interface LoginState {
  readonly state: "in" | "out" | "unknown"
  readonly detail: string
}

/** What a runner's status command printed, read as signed in or not. */
export function readLoginStatus(runner: Runner, output: string, code: number | null): LoginState {
  const text = stripAnsi(output).split(String.fromCharCode(13)).join("").trim()
  const first = text.split("\n")[0]?.trim() ?? ""
  switch (runner.id) {
    case "claude": {
      try {
        const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>
        if (parsed["loggedIn"] === true) {
          const method = str(parsed["authMethod"])
          return {
            state: "in",
            detail: method === "claude.ai" ? "Abbonamento Claude" : method ? `Accesso: ${method}` : "Accesso eseguito",
          }
        }
        return { state: "out", detail: "Non collegato" }
      } catch {
        return { state: "unknown", detail: first || "Stato non leggibile" }
      }
    }
    case "codex": {
      const line = text.split("\n").find((l) => /logged in/i.test(l))
      if (line && !/not logged in/i.test(line)) {
        return { state: "in", detail: line.trim().replace(/^Logged in using /i, "Accesso con ") }
      }
      return { state: line ? "out" : code === 0 ? "unknown" : "out", detail: first || "Non collegato" }
    }
    case "nikcli": {
      const providers = text
        .split("\n")
        .map((l) => l.replace(/[│┌└●○◇◆]/g, "").trim())
        .filter((l) => /\s(oauth|api|wellknown)\s*$/i.test(l))
        .map((l) => l.replace(/\s+(oauth|api|wellknown)\s*$/i, "").trim())
        .filter(Boolean)
      if (providers.length > 0) return { state: "in", detail: providers.join(", ") }
      /* "0 credentials" is an answer; a crash before the list is not one. */
      if (/\b0 credentials\b/i.test(text)) return { state: "out", detail: "Nessun provider collegato" }
      return { state: "unknown", detail: first || "Stato non leggibile" }
    }
  }
}
