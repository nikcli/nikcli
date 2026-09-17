/**
 * A conversation with a bot, without a terminal.
 *
 * Talking to a bot used to mean opening its TUI in a pane. That is still
 * there — "Terminale" — but a conversation wants to be read as one: what you
 * said, what it said, what it did in between, and whether it is waiting on
 * you. nikcli has a mode that gives exactly that: `nikcli run --agent <name>
 * --format json "message"` runs one turn against the agent's file and prints
 * one JSON object per event — text, tool use, step, error — every one carrying
 * the session id, so the next turn is `--session <id>` and the model keeps its
 * context. This module is the translation between those lines and a thread.
 *
 * One process per turn, not one long-running one. A process that exits is a
 * turn that is over: there is nothing to detect and no spinner to time out.
 * The price is a few hundred milliseconds of startup per message, which a
 * conversation does not notice.
 *
 * The one thing `run` still asks through the terminal is permission. It draws
 * a menu — "Permission required: bash (…)", allow once / always / reject — and
 * waits on stdin. So the raw pty output is watched for that line, the thread
 * shows it as a question with three buttons, and the answer is keystrokes:
 * Enter for the first option, arrow-down before it for the others. See
 * `answerKeys`.
 *
 * Pure, in a `.ts`: a JSON line misread is a message lost, and a permission
 * prompt unnoticed is a turn that waits forever with nothing on screen.
 */

import { stripAnsi } from "../session/stream"
import { limitNotice, limitReached } from "./terms"

export type TalkStatus = "idle" | "working" | "waiting" | "error"

export type TalkRole = "user" | "bot" | "tool" | "error"

export interface TalkMessage {
  readonly id: string
  readonly role: TalkRole
  /** The words. For a tool: its title, what nikcli would print beside the name. */
  readonly text: string
  /** The tool's name, for `tool` messages. */
  readonly tool?: string
  /** What the tool printed, when nikcli included it (bash does). */
  readonly output?: string
  readonly at: number
}

export interface PendingPermission {
  readonly permission: string
  readonly patterns: string
  readonly askedAt: number
}

export interface Talk {
  /** nikcli's session id, once the first event has said it. */
  readonly sessionId?: string
  readonly messages: readonly TalkMessage[]
  readonly status: TalkStatus
  /** Summed over every step nikcli reported, for the card. */
  readonly tokens: number
  readonly costUsd: number
  /** When anything last happened, for the roster's clock. */
  readonly updatedAt?: number
  /** A question nikcli is waiting on. The thread shows it; `answerKeys` answers it. */
  readonly permission?: PendingPermission
  /** What went wrong starting or running the last turn, if anything. */
  readonly problem?: string
  /**
   * The start of a JSON event that has not ended yet.
   *
   * The process runs in a pty, and on Windows ConPTY re-renders what a
   * program writes at the terminal's width: an event longer than one row
   * arrives as several rows, each cut where the column ran out. The pieces
   * are kept here until they parse as one object again.
   */
  readonly partial?: string
  /**
   * The CLI has given its final event for the turn (Claude Code's `result`,
   * Codex's `turn.completed`). What follows is the process tidying up.
   */
  readonly ended?: boolean
  /**
   * The answer being written, before its message is complete: Claude Code's
   * text deltas, for a turn that asked for them. Gone once the whole message
   * arrives.
   */
  readonly streaming?: string
}

export function emptyTalk(): Talk {
  return { messages: [], status: "idle", tokens: 0, costUsd: 0 }
}

/**
 * The arguments for one turn.
 *
 * `--format json` before the message, and the message last: yargs takes
 * `run [message..]` as a variadic, and a message beginning with `-` would be
 * read as a flag anywhere else. `--session` only when there is one; `-c`
 * (continue the last session) is not used because "last" is whichever
 * session any process on this machine touched most recently, which is not
 * necessarily this bot's.
 */
export function runArgs(input: {
  readonly identifier: string
  readonly message: string
  readonly sessionId?: string
  readonly model?: string
  readonly effort?: string
}): string[] {
  // No identifier: nikcli's own default agent, for a turn that is not a bot's.
  const args = input.identifier ? ["run", "--agent", input.identifier, "--format", "json"] : ["run", "--format", "json"]
  if (input.model) args.push("--model", input.model)
  if (input.effort) args.push("--variant", input.effort)
  if (input.sessionId) args.push("--session", input.sessionId)
  args.push("--", input.message)
  return args
}

let sequence = 0
function nextId(prefix: string, at: number): string {
  return `${prefix}-${at}-${++sequence}`
}

/** What the user just typed, put on the thread and the turn marked as started. */
export function sendMessage(talk: Talk, text: string, at: number): Talk {
  return {
    ...talk,
    messages: [...talk.messages, { id: nextId("u", at), role: "user", text, at }],
    status: "working",
    updatedAt: at,
    problem: undefined,
    permission: undefined,
    ended: undefined,
  }
}

/* ── the JSON events ────────────────────────────────────────────────────── */

interface RunEvent {
  readonly type: string
  readonly timestamp?: number
  readonly sessionID?: string
  readonly part?: {
    readonly type?: string
    readonly text?: string
    readonly tool?: string
    readonly state?: { readonly title?: string; readonly output?: string; readonly input?: unknown; readonly status?: string }
    readonly tokens?: unknown
    readonly cost?: unknown
  }
  readonly error?: unknown
}

/** How much of a broken event is kept before giving up on it. */
const MAX_PARTIAL = 256 * 1024

/** nikcli's token record is `{input, output, reasoning, cache: {read, write}}`; the sum is what a bill counts. */
function sumTokens(tokens: unknown): number {
  if (!tokens || typeof tokens !== "object") return 0
  let total = 0
  for (const value of Object.values(tokens as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) total += value
    else if (value && typeof value === "object") total += sumTokens(value)
  }
  return total
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; data?: { message?: unknown }; name?: unknown }
    if (typeof record.message === "string") return record.message
    if (record.data && typeof record.data.message === "string") return record.data.message
    if (typeof record.name === "string") return record.name
  }
  return "Errore sconosciuto."
}

/**
 * Matches the menu `run` draws for a permission, once its colours are gone.
 * The patterns are whatever the tool asked for — a command, a path.
 */
const PERMISSION_RE = /Permission required:\s*([^\s(]+)\s*\(([^)]*)\)/

/**
 * One line of the process's output, folded into the conversation.
 *
 * A JSON line is an event; any other line is looked at only for the
 * permission menu, and otherwise ignored — nikcli's own logging, a stray
 * warning, the frame of the menu after the question.
 */
export function applyLine(talk: Talk, line: string, at: number): Talk {
  return applyJsonLine(talk, line, at, (current, parsed, when) => {
    if (typeof (parsed as unknown as RunEvent).type !== "string") return current
    return applyEvent(current, parsed as unknown as RunEvent, when)
  }, noticePermission)
}

/**
 * One line of a process that prints one JSON object per line, folded in by
 * `onEvent`. Shared by every runner: the reassembly of an event ConPTY cut
 * into rows is the same whoever wrote it. `onOther` sees the lines that are
 * not JSON (nikcli uses it for its permission menu).
 */
export function applyJsonLine(
  talk: Talk,
  line: string,
  at: number,
  onEvent: (talk: Talk, event: Record<string, unknown>, at: number) => Talk,
  onOther: (talk: Talk, line: string, at: number) => Talk = (current) => current,
): Talk {
  const clean = stripAnsi(line)

  /*
   * A piece of an event, or the rest of one.
   *
   * A row that opens an object but does not close it is the first piece; the
   * rows after it are glued on until the whole parses. Anything else while
   * pieces are pending is glued on too — a JSON string can contain any text —
   * up to a limit, past which the pieces were never going to be one event.
   */
  if (talk.partial !== undefined) {
    const joined = talk.partial + clean
    const event = parseObject(joined)
    if (event) return onEvent({ ...talk, partial: undefined }, event, at)
    if (joined.length > MAX_PARTIAL) return { ...talk, partial: undefined }
    return { ...talk, partial: joined }
  }
  const opening = clean.trimStart()
  if (opening.startsWith("{") && !parseObject(clean)) {
    return { ...talk, partial: clean }
  }

  const event = parseObject(clean)
  if (!event) return onOther(talk, line, at)
  return onEvent(talk, event, at)
}

function parseObject(line: string): Record<string, unknown> | undefined {
  const trimmed = stripAnsi(line).trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** A message put on the thread, with an id of its kind. Used by the runners' adapters. */
export function appendMessage(
  talk: Talk,
  message: { readonly role: TalkRole; readonly text: string; readonly tool?: string; readonly output?: string; readonly id?: string },
  at: number,
): Talk {
  const prefix = message.role === "user" ? "u" : message.role === "bot" ? "b" : message.role === "tool" ? "t" : "e"
  const { id, ...rest } = message
  return {
    ...talk,
    messages: [...talk.messages, { ...rest, id: id ?? nextId(prefix, at), at }],
    updatedAt: at,
  }
}

/** Adds what a tool printed to the tool message with that id, when it is on the thread. */
export function attachOutput(talk: Talk, id: string, output: string): Talk {
  if (output.trim().length === 0) return talk
  const index = talk.messages.findIndex((message) => message.id === id)
  if (index < 0) return talk
  const messages = talk.messages.slice()
  messages[index] = { ...messages[index]!, output }
  return { ...talk, messages }
}

export { sumTokens, errorText }

function applyEvent(talk: Talk, event: RunEvent, at: number): Talk {
  const when = typeof event.timestamp === "number" ? event.timestamp : at
  const withSession = event.sessionID && !talk.sessionId ? { ...talk, sessionId: event.sessionID } : talk

  switch (event.type) {
    case "text": {
      const text = event.part?.text ?? ""
      if (text.trim().length === 0) return withSession
      return {
        ...withSession,
        messages: [...withSession.messages, { id: nextId("b", when), role: "bot", text, at: when }],
        updatedAt: when,
      }
    }
    case "tool_use": {
      const tool = event.part?.tool ?? "tool"
      const state = event.part?.state
      const title =
        state?.title ||
        (state?.input && typeof state.input === "object" && Object.keys(state.input as object).length > 0
          ? JSON.stringify(state.input)
          : tool)
      const output = typeof state?.output === "string" && state.output.trim().length > 0 ? state.output : undefined
      return {
        ...withSession,
        messages: [
          ...withSession.messages,
          { id: nextId("t", when), role: "tool", tool, text: title, ...(output ? { output } : {}), at: when },
        ],
        updatedAt: when,
      }
    }
    case "step_finish": {
      const tokens = sumTokens(event.part?.tokens)
      const cost = typeof event.part?.cost === "number" ? event.part.cost : 0
      return { ...withSession, tokens: withSession.tokens + tokens, costUsd: withSession.costUsd + cost }
    }
    case "error": {
      const text = errorText(event.error)
      return {
        ...withSession,
        status: "error",
        messages: [...withSession.messages, { id: nextId("e", when), role: "error", text, at: when }],
        updatedAt: when,
      }
    }
    default:
      return withSession
  }
}

/**
 * The permission menu, seen in the raw output.
 *
 * Called on whole lines and on raw chunks alike: the menu is drawn by a
 * prompt library that repaints in place and may never end its line.
 */
export function noticePermission(talk: Talk, raw: string, at: number): Talk {
  if (talk.permission) return talk
  const match = PERMISSION_RE.exec(stripAnsi(raw))
  if (!match) return talk
  return {
    ...talk,
    status: "waiting",
    permission: { permission: match[1] ?? "", patterns: match[2] ?? "", askedAt: at },
    updatedAt: at,
  }
}

export type PermissionAnswer = "once" | "always" | "reject"

/**
 * The keystrokes that pick an answer in the menu.
 *
 * The menu starts on "Allow once"; "Always" is one arrow-down below it and
 * "Reject" two. Arrow-down is the CSI sequence a terminal sends for the key.
 */
export function answerKeys(answer: PermissionAnswer): string {
  const down = "[B"
  const steps = answer === "once" ? 0 : answer === "always" ? 1 : 2
  return down.repeat(steps) + "\r"
}

/** After the keystrokes are sent: the question is gone, the turn goes on. */
export function permissionAnswered(talk: Talk, at: number): Talk {
  return { ...talk, permission: undefined, status: "working", updatedAt: at }
}

/**
 * The process is gone. A clean exit ends the turn; anything else, with no
 * error already on the thread, is said once so the silence has a reason.
 */
export function applyExit(talk: Talk, code: number | null, at: number, program = "nikcli"): Talk {
  const limited = withLimitNotice(talk, code, at, program)
  if (limited) return limited
  if (code === 0 || code === null) {
    return { ...talk, status: talk.status === "error" ? "error" : "idle", permission: undefined, updatedAt: at }
  }
  const alreadySaid = talk.messages.at(-1)?.role === "error"
  return {
    ...talk,
    status: "error",
    permission: undefined,
    updatedAt: at,
    messages: alreadySaid
      ? talk.messages
      : [...talk.messages, { id: nextId("e", at), role: "error", text: `${program} è uscito con codice ${code}.`, at }],
  }
}

/**
 * A turn that ended on the plan's limit says so, and that nothing will retry it.
 *
 * Looked for in what the CLI said since the user's last message, so an old
 * limit already answered does not come back.
 */
function withLimitNotice(talk: Talk, code: number | null, at: number, program: string): Talk | undefined {
  if (talk.status !== "error" && (code === 0 || code === null)) return undefined
  const lastUser = talk.messages.findLastIndex((message) => message.role === "user")
  const said = talk.messages.slice(lastUser + 1)
  if (!said.some((message) => limitReached(message.text)) && !limitReached(talk.problem ?? "")) return undefined
  const notice = limitNotice(program)
  return {
    ...talk,
    status: "error",
    permission: undefined,
    updatedAt: at,
    messages: said.some((message) => message.text === notice)
      ? talk.messages
      : [...talk.messages, { id: nextId("e", at), role: "error", text: notice, at }],
  }
}

/** Something went wrong before the process even spoke. */
export function applyProblem(talk: Talk, problem: string, at: number): Talk {
  return { ...talk, status: "error", problem, updatedAt: at }
}

/* ── what the roster shows ──────────────────────────────────────────────── */

/**
 * The line under the bot's name: the last thing said or done, by whoever.
 *
 * A tool call reads as what it did — "bash: bun test" — because a bot whose
 * last act was running the tests is better described by that than by the
 * sentence it wrote before. An error is shown as such. Nothing yet is the
 * bot's own description, which is what a contact with no history has.
 */
export function lastLine(talk: Talk, fallback: string): string {
  if (talk.status === "waiting" && talk.permission) return `Chiede il permesso: ${talk.permission.permission}`
  const last = talk.messages.at(-1)
  if (!last) return fallback
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
  switch (last.role) {
    case "user":
      return `Tu: ${oneLine(last.text)}`
    case "tool":
      return `${last.tool}: ${oneLine(last.text)}`
    case "error":
      return oneLine(last.text)
    default:
      return oneLine(last.text)
  }
}

/**
 * When, as a contact list says it: the time today, "ieri", the weekday within
 * the week, the date beyond it. Under a minute is "ora", because the roster
 * is where a bot that just answered should look alive.
 */
export function formatWhen(at: number | undefined, now: number): string {
  if (at === undefined) return ""
  const diff = now - at
  if (diff < 60_000 && diff > -60_000) return "ora"
  const date = new Date(at)
  const today = new Date(now)
  const sameDay = date.toDateString() === today.toDateString()
  if (sameDay) return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  const yesterday = new Date(now - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return "ieri"
  if (diff < 6 * 86_400_000 && diff > 0) return ["dom", "lun", "mar", "mer", "gio", "ven", "sab"][date.getDay()] ?? ""
  const months = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]
  return `${date.getDate()} ${months[date.getMonth()] ?? ""}`
}

/**
 * Which bot a message is for, when it names one.
 *
 * `@tester confermi?` is for tester. The name must be a whole word right
 * after the `@`, and must be a bot that exists; `@` inside an email or a
 * decorator is left alone. Returns the identifier and the text without it.
 */
export function mentionIn(
  text: string,
  identifiers: readonly string[],
): { readonly identifier: string; readonly rest: string } | undefined {
  const match = /(^|\s)@([\w.-]+)/.exec(text)
  if (!match) return undefined
  const named = match[2] ?? ""
  const identifier = identifiers.find((candidate) => candidate.toLowerCase() === named.toLowerCase())
  if (!identifier) return undefined
  const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/\s+/g, " ").trim()
  return { identifier, rest }
}

/* ── surviving a reload ─────────────────────────────────────────────────── */

const SAVED_MESSAGES = 200

/** The thread as text for storage. Trimmed, and never mid-turn: a reload ends whatever was running. */
export function serializeTalk(talk: Talk): string {
  return JSON.stringify({
    sessionId: talk.sessionId,
    messages: talk.messages.slice(-SAVED_MESSAGES),
    tokens: talk.tokens,
    costUsd: talk.costUsd,
    updatedAt: talk.updatedAt,
  })
}

/** The stored thread, tolerating anything: an unreadable one is an empty one. */
export function parseTalk(raw: string | null | undefined): Talk {
  if (!raw) return emptyTalk()
  try {
    const parsed = JSON.parse(raw) as Partial<Talk> & { messages?: unknown }
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.filter(
          (m): m is TalkMessage =>
            !!m &&
            typeof m === "object" &&
            typeof (m as TalkMessage).id === "string" &&
            typeof (m as TalkMessage).text === "string" &&
            typeof (m as TalkMessage).at === "number" &&
            ["user", "bot", "tool", "error"].includes((m as TalkMessage).role),
        )
      : []
    return {
      ...emptyTalk(),
      ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
      messages,
      tokens: typeof parsed.tokens === "number" ? parsed.tokens : 0,
      costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : 0,
      ...(typeof parsed.updatedAt === "number" ? { updatedAt: parsed.updatedAt } : {}),
    }
  } catch {
    return emptyTalk()
  }
}

/** Where a bot's thread is kept. The path, because the identifier repeats across scopes. */
export function talkKey(path: string): string {
  return `ade.bots.talk:${path}`
}
