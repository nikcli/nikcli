/**
 * Messages between sessions: who a message is for, and how it lands.
 *
 * The transport is in `src-tauri/src/mailbox.rs` — `ade-msg` drops a file,
 * the workbench takes it. This module is the part with decisions in it, kept
 * pure so the decisions are tested.
 *
 * Four kinds, modelled on how Claude Code works with its subagents:
 *
 * - `send`  — a note, fire and forget;
 * - `ask`   — a request to an open session; the caller's `ade-msg ask` blocks
 *             until that session answers with `ade-msg reply`, and prints the
 *             answer as its own output, the way a Task tool call returns;
 * - `spawn` — the same, to a session ADE opens for the purpose with the agent
 *             the caller named: a subagent, in its own pane, on any CLI;
 * - `reply` — the answer to an `ask` or a `spawn`, by request id.
 *
 * The request line typed into the recipient carries the reply command, so an
 * agent that has never heard of `ade-msg` can still answer.
 */

export interface MailPane {
  id: string
  title: string
  agent?: string
  status?: string
  /** The project the session works in; sessions are listed and found by it. */
  project?: string
}

/** `token` is what proves `from`; see {@link verifySender}. */
export type Message = { from: string; token?: string; text: string } &
  /** `effort` on an ask is refused: a running session's effort is set at spawn or relaunch. */
  (| { kind: "send" | "ask"; to: string; effort?: string }
    /**
     * `autoClose`: closed once it has replied, unless it has work not yet
     * integrated. `name` titles it; `worktree` gives it its own checkout;
     * `model` picks the model where ADE knows the flag.
     */
    /** `fork`: starts from the sender's own conversation, so its prompt cache carries over. */
    | {
        kind: "spawn"
        agent: string
        autoClose: boolean
        name?: string
        worktree: boolean
        base?: string
        model?: string
        /** Reasoning effort, translated per agent (`effortArgs`). */
        effort?: string
        /** A class of work in `dispatch.json`, which supplies model and effort when not given. */
        profile?: string
        fork: boolean
      }
    /** The project's shared key-value store; `text` is the value for `set`, a note for `lock`. */
    | { kind: "kv"; op: KvOpName; key: string; ttl: number; force: boolean }
    /** The project's shared memory file; `type` for `add`, `text` is the entry. */
    | { kind: "memory"; op: "add" | "show"; type: string }
    /** Who owns the file named in `text`, from the team board (`owners.ts`). */
    | { kind: "whoowns" }
    | { kind: "reply"; ref: string }
    /**
     * Not an answer: the session is blocked or needs a decision. The waiter
     * wakes with it and the request stays open.
     */
    | { kind: "update"; ref: string; state: UpdateState }
    /** Closes a session the sender started with `spawn`, and the ones it started. `text` is empty. */
    | { kind: "close"; to: string; force: boolean }
    /**
     * Restarts a session the sender spawned, in the same pane and worktree:
     * its own conversation back unless `fresh`, on another model if `model`.
     */
    | { kind: "relaunch"; to: string; model?: string; effort?: string; fresh: boolean; note: string }
    /** Esc or Ctrl-C in a session, to stop what it is doing; the session stays open. `text` is empty. */
    | { kind: "interrupt"; to: string }
    /** Withdraws a request the sender made. `text` is empty. */
    | { kind: "cancel"; ref: string }
  )

export const KV_OPS = ["get", "set", "del", "list", "lock", "unlock"] as const
export type KvOpName = (typeof KV_OPS)[number]

/** What `ade-msg update` may say about a request that is not finished. */
export const UPDATE_STATES = ["bloccata", "decisione"] as const
export type UpdateState = (typeof UPDATE_STATES)[number]

/** Longest text delivered. Past this it is a file, and should be sent as a path. */
export const MAX_TEXT = 40_000

/** A request id names a file; the same shape `mailbox.rs` accepts. */
export function isRequestId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id)
}

export function parseMessage(body: string): Message | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(body.replace(/^\ufeff/, ""))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  const str = (key: string) => (typeof record[key] === "string" ? (record[key] as string).trim() : "")
  const from = str("from")
  const token = str("token") || undefined
  const text = typeof record.text === "string" ? record.text : ""
  const kind = str("kind") || "send"

  // The two that carry no text.
  if (kind === "close") {
    const to = str("to")
    return to ? { kind, from, token, to, force: record.force === true, text: "" } : undefined
  }
  if (kind === "relaunch") {
    const to = str("to")
    const model = str("model")
    const effort = str("effort")
    return to
      ? {
          kind,
          from,
          token,
          to,
          fresh: record.fresh === true,
          note: str("note"),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          text: "",
        }
      : undefined
  }
  if (kind === "interrupt") {
    const to = str("to")
    return to ? { kind, from, token, to, text: "" } : undefined
  }
  if (kind === "cancel") {
    const ref = str("ref")
    return isRequestId(ref) ? { kind, from, token, ref, text: "" } : undefined
  }
  if (kind === "kv") {
    const op = KV_OPS.find((known) => known === str("op"))
    const key = str("key")
    if (!op || (op !== "list" && !key)) return undefined
    const ttl = typeof record.ttl === "number" && Number.isFinite(record.ttl) ? Math.max(0, Math.floor(record.ttl)) : 0
    if (op === "set" && !text.trim()) return undefined
    return { kind, from, token, op, key, ttl, force: record.force === true, text }
  }
  if (kind === "whoowns") return text.trim() ? { kind, from, token, text: text.trim() } : undefined
  if (kind === "memory") {
    const op = str("op")
    if (op === "show") return { kind, from, token, op, type: "", text: "" }
    if (op === "add" && text.trim()) return { kind, from, token, op, type: str("type"), text }
    return undefined
  }

  if (!text.trim()) return undefined
  if (kind === "send" || kind === "ask") {
    const to = str("to")
    const effort = str("effort")
    return to ? { kind, from, token, to, text, ...(effort ? { effort } : {}) } : undefined
  }
  if (kind === "spawn") {
    const agent = str("agent")
    if (!agent) return undefined
    const name = str("name")
    const model = str("model")
    const base = str("base")
    const effort = str("effort")
    const profile = str("profile")
    return {
      kind,
      from,
      token,
      agent,
      autoClose: record.close === true,
      worktree: record.worktree === true,
      fork: record.fork === true,
      ...(name ? { name } : {}),
      ...(base ? { base } : {}),
      ...(effort ? { effort } : {}),
      ...(profile ? { profile } : {}),
      ...(model ? { model } : {}),
      text,
    }
  }
  if (kind === "reply") {
    const ref = str("ref")
    return isRequestId(ref) ? { kind, from, token, ref, text } : undefined
  }
  if (kind === "update") {
    const ref = str("ref")
    const state = UPDATE_STATES.find((known) => known === str("state"))
    return isRequestId(ref) && state ? { kind, from, token, ref, state, text } : undefined
  }
  return undefined
}

/**
 * The message with `from` kept only if its token is that pane's.
 *
 * A pane id is public — `ade-msg list` prints every one — so without this
 * any session could sign as another, and answer a request made to it. An
 * unproven sender is not refused, only anonymous: a note still arrives, it
 * just cannot be answered, and a reply to a known request is refused.
 */
export function verifySender<M extends Message>(message: M, tokenOf: (paneId: string) => string | undefined): M {
  const expected = message.from ? tokenOf(message.from) : undefined
  const proven = expected !== undefined && message.token === expected
  return proven ? message : { ...message, from: "" }
}

/** `claude-code` answers to "claude"; ids are compared without that suffix. */
function agentName(agent: string | undefined): string {
  return (agent ?? "").toLowerCase().replace(/-code$/, "")
}

export type Resolution = { pane: MailPane } | { error: string }

const NO_PROJECT = "senza progetto"

function projectOf(pane: MailPane): string {
  return pane.project?.trim() || NO_PROJECT
}

/**
 * The panes with each project's sessions together, projects in the order they
 * first appear. The numbers `ade-msg list` prints are positions in this order,
 * so everything that numbers panes goes through it.
 */
export function byProject(panes: readonly MailPane[]): MailPane[] {
  const groups = new Map<string, MailPane[]>()
  for (const pane of panes) {
    const key = projectOf(pane)
    groups.set(key, [...(groups.get(key) ?? []), pane])
  }
  return [...groups.values()].flat()
}

/**
 * One pane for what the sender wrote, tried from most to least precise:
 * the pane id, its number in `ade-msg list`, its exact title, the agent's
 * name, a piece of the title.
 *
 * Sessions are found by project. `progetto/nome` looks only inside that
 * project (`progetto/2` is the second session there); a plain name matching
 * in several projects goes to the one in the sender's own project, which is
 * almost always the one meant — "claude" from a codex working on nikcli is
 * the claude working on nikcli. Ambiguity left after that is an error, never
 * a guess: a message delivered to the wrong session is worse than one refused.
 */
export function resolveTarget(panes: readonly MailPane[], to: string, fromId?: string): Resolution {
  const ordered = byProject(panes)
  const trimmed = to.trim().replace(/^#/, "")

  const byId = ordered.find((pane) => pane.id === trimmed)
  if (byId) return { pane: byId }

  const label = (pane: MailPane) => `${ordered.indexOf(pane) + 1} ${pane.title} [${projectOf(pane)}]`

  // `progetto/nome`: what comes before the last slash names a project.
  let scope = ordered
  let wanted = trimmed
  const slash = trimmed.lastIndexOf("/")
  if (slash > 0) {
    const name = trimmed.slice(0, slash).trim().toLowerCase()
    const inProject = ordered.filter((pane) => projectOf(pane).toLowerCase() === name)
    if (inProject.length === 0) {
      const projects = [...new Set(ordered.map(projectOf))].join(", ") || "nessuno"
      return { error: `nessun progetto "${trimmed.slice(0, slash)}". Progetti: ${projects}` }
    }
    scope = inProject
    wanted = trimmed
      .slice(slash + 1)
      .trim()
      .replace(/^#/, "")
  }
  const lower = wanted.toLowerCase()

  if (/^\d+$/.test(wanted)) {
    const pane = scope[Number(wanted) - 1]
    return pane ? { pane } : { error: `nessuna sessione numero ${wanted} (ce ne sono ${scope.length})` }
  }

  const home = ordered.find((pane) => pane.id === fromId)
  const pick = (matches: MailPane[], what: string): Resolution | undefined => {
    // The sender is never its own recipient by a loose match.
    let others = matches.filter((pane) => pane.id !== fromId)
    if (others.length > 1 && home) {
      const near = others.filter((pane) => projectOf(pane) === projectOf(home))
      if (near.length > 0) others = near
    }
    if (others.length === 1) return { pane: others[0]! }
    if (others.length > 1) {
      return {
        error: `"${wanted}" corrisponde a ${others.length} sessioni (${what}): ${others.map(label).join(", ")} — usa il numero o progetto/nome`,
      }
    }
    return undefined
  }

  return (
    pick(
      scope.filter((pane) => pane.title.toLowerCase() === lower),
      "titolo",
    ) ??
    pick(
      scope.filter((pane) => agentName(pane.agent) === agentName(wanted)),
      "agente",
    ) ??
    pick(
      scope.filter((pane) => pane.title.toLowerCase().includes(lower)),
      "titolo",
    ) ?? {
      error: `nessuna sessione "${trimmed}". Sessioni: ${ordered.map(label).join(", ") || "nessuna"}`,
    }
  )
}

/**
 * The agent a `spawn` names, among the ones ADE can start: by id, by id
 * without `-code`, or by label ("Claude Code", "codex", "claude").
 */
export function resolveAgent(
  agents: readonly { id: string; label: string }[],
  name: string,
): { id: string } | { error: string } {
  const wanted = name.trim().toLowerCase()
  const hit =
    agents.find((agent) => agent.id.toLowerCase() === wanted) ??
    agents.find((agent) => agentName(agent.id) === agentName(wanted)) ??
    agents.find((agent) => agent.label.toLowerCase() === wanted)
  return hit
    ? { id: hit.id }
    : { error: `nessun agente "${name}". Agenti: ${agents.map((agent) => agent.id).join(", ")}` }
}

/** Control characters out, line breaks to spaces, and a ceiling on length. */
function oneLine(text: string): string {
  const clean = text
    .replace(/\r?\n|\r/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}… [troncato]` : clean
}

function who(sender: MailPane | undefined): string {
  return sender ? `"${sender.title}"${sender.agent ? ` (${sender.agent})` : ""}` : "una sessione ADE"
}

/**
 * A note, typed into the recipient's terminal.
 *
 * Control characters are removed — an escape sequence in a message would be
 * a keystroke in somebody else's terminal — and line breaks become spaces,
 * because Enter is what submits the line and a message must arrive whole.
 */
export function formatDelivery(message: { text: string }, sender: MailPane | undefined): string {
  const reply = sender ? ` — per rispondere: ade-msg send ${sender.id} "<testo>"` : ""
  return `[Messaggio da ${who(sender)}]: ${oneLine(message.text)}${reply}`
}

/**
 * A request, typed into the session that has to do it.
 *
 * The reply command is the last thing on the line on purpose: it is what the
 * caller is blocked on, and an answer given in the conversation instead of
 * through `ade-msg reply` never reaches it.
 */
export function formatRequest(
  id: string,
  text: string,
  sender: MailPane | undefined,
  context: RequestContext = {},
): string {
  const where = context.worktree
    ? ` Lavori nella worktree ${context.worktree.path} (branch ${context.worktree.branch}): modifica solo lì, fai commit sul branch, non toccare il progetto principale.`
    : ""
  const results = context.resultsDir
    ? `${context.resultsDir}${context.resultsDir.includes("\\") ? "\\" : "/"}${id}.md`
    : undefined
  /*
   * The contract, and nothing the intro already says. This line is paid for
   * on every request, so the sender is named once and the "you may delegate"
   * sentence appears only where it changes something: at the last level.
   */
  const delegate =
    context.depth !== undefined && context.maxDepth !== undefined && context.depth >= context.maxDepth
      ? " Non avviare altre sessioni: sei all'ultimo livello consentito."
      : ""
  return (
    `[Richiesta ${id} da ${who(sender)}]: ${oneLine(text)} —${where}${delegate} ` +
    `Rispondi con ade-msg reply ${id} "<sintesi>" (max 15 righe: ESITO, FILE toccati, PROBLEMI, PROSSIMO PASSO` +
    (results ? `; dettagli in ${results}` : "") +
    `); se sei bloccata: ade-msg update ${id} bloccata|decisione "<motivo>".`
  )
}

export interface RequestContext {
  worktree?: { path: string; branch: string }
  /** Where detail that does not belong in the reply goes. */
  resultsDir?: string
  /** The answering session's level in the spawn tree, and the most allowed. */
  depth?: number
  maxDepth?: number
}

/** What a waiter prints when a request it waits on is not done but needs its caller. */
export function formatUpdate(id: string, state: UpdateState, text: string, replier: MailPane | undefined): string {
  const what = state === "bloccata" ? "è bloccata" : "chiede una decisione"
  return (
    `[Aggiornamento richiesta ${id}] ${who(replier)} ${what}: ${text.trim()}\n` +
    `La richiesta resta aperta. Rispondi alla sessione con ade-msg send ${replier?.id ?? "<sessione>"} "<risposta>", poi riprendi con ade-msg wait ${id}.`
  )
}

/** Typed into a session that went quiet with a request still unanswered. */
export function formatNudge(id: string, caller: MailPane | undefined): string {
  return `[Promemoria] ${who(caller)} aspetta la richiesta ${id}: ade-msg reply ${id} "<risultato o motivo>"`
}

// ---------------------------------------------------------------------------
// The inbox: long messages travel as files, and reading them is the receipt

/**
 * The longest line still typed into a terminal whole.
 *
 * A message is typed in as keystrokes, and a TUI takes a long run of them for
 * a paste: codex and agy lost the Enter after one (S17). Past this length the
 * text goes to `mailbox/inbox/<pane>/<name>.msg` and only a short bell is
 * typed; the session prints it with `ade-msg inbox`, which moves it to
 * `handled/`, and that move is the receipt. Short lines stay typed: a bell and
 * a command to read it would cost a tool call more than the message itself.
 */
export const INLINE_MAX = 600
/** A bell nobody answered, in a session free to answer, rings again after this long. */
export const REBELL_AFTER_MS = 120_000
/** Rings after the first; then the sender is told the message was not read. */
export const MAX_REBELLS = 3

export interface InboxEntry {
  /** The message or request id, as the sender knows it. */
  id: string
  paneId: string
  /** File name without `.msg`: ordered by time, safe as a path. */
  name: string
  /** The sending pane; empty when anonymous. */
  from: string
  kind: "send" | "ask" | "spawn" | "reply" | "update"
  /** Length of the message, repeated in each bell. */
  chars: number
  at: number
  ringAt: number
  rings: number
}

/** A file name for a message: its time first, so `ade-msg inbox` prints them in order. */
export function inboxName(id: string, at: number): string {
  return `${String(at).padStart(13, "0")}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 80)
}

/** Whether a line is too long to type, and goes to the inbox instead. */
export function goesToInbox(line: string): boolean {
  return line.length > INLINE_MAX
}

/** The short line typed in place of a long message. */
export function formatBell(
  entry: Pick<InboxEntry, "id" | "kind">,
  sender: MailPane | undefined,
  chars: number,
): string {
  const what =
    entry.kind === "ask" || entry.kind === "spawn"
      ? `Richiesta ${entry.id} da ${who(sender)}`
      : entry.kind === "reply"
        ? `Risposta alla richiesta ${entry.id} da ${who(sender)}`
        : entry.kind === "update"
          ? `Aggiornamento della richiesta ${entry.id} da ${who(sender)}`
          : `Messaggio da ${who(sender)}`
  return `[${what}, ${chars} caratteri] in attesa: leggilo con ade-msg inbox`
}

/**
 * What to do with a message not yet confirmed read.
 *
 * `done` once it was read or its session is gone (a request to a closed
 * session is settled by the request table). A bell rings again only in a
 * session free to act on it and after {@link REBELL_AFTER_MS}; after
 * {@link MAX_REBELLS} the sender is told, once, and the entry is dropped.
 */
export function inboxAction(
  entry: InboxEntry,
  target: { running: boolean; free: boolean; read: boolean },
  now: number,
): "done" | "wait" | "ring" | "warn" {
  if (target.read || !target.running) return "done"
  if (!target.free || now - entry.ringAt < REBELL_AFTER_MS) return "wait"
  return entry.rings < MAX_REBELLS ? "ring" : "warn"
}

/** Told to the sender when a long message was never read. */
export function formatUnread(entry: InboxEntry, reader: MailPane | undefined): string {
  const what = entry.kind === "ask" || entry.kind === "spawn" ? `la richiesta ${entry.id}` : "il tuo messaggio"
  return `[ade-msg] ${who(reader)} non ha letto ${what} dopo ${entry.rings + 1} avvisi: resta nella sua inbox; ricordaglielo o annulla la richiesta`
}

/** Entries restored from storage; anything malformed is dropped. */
export function parseInbox(raw: string | null): InboxEntry[] {
  try {
    const list: unknown = JSON.parse(raw ?? "[]")
    if (!Array.isArray(list)) return []
    return list.filter(
      (item): item is InboxEntry =>
        typeof item === "object" &&
        item !== null &&
        ["id", "paneId", "name", "from", "kind"].every(
          (key) => typeof (item as Record<string, unknown>)[key] === "string",
        ) &&
        ["chars", "at", "ringAt", "rings"].every((key) => typeof (item as Record<string, unknown>)[key] === "number"),
    )
  } catch {
    return []
  }
}

/** Typed into a session whose request was withdrawn. */
export function formatCancel(id: string, caller: MailPane | undefined): string {
  return `[Richiesta ${id} annullata da ${who(caller)}]: interrompi quel lavoro, non serve più rispondere`
}

// ---------------------------------------------------------------------------
// Requests in flight: what an orchestrating session is waiting on
// ---------------------------------------------------------------------------

export interface OpenRequest {
  id: string
  kind: "ask" | "spawn"
  /** The pane that asked; empty when the sender was not proven. */
  from: string
  /** The pane that has to answer. */
  to: string
  /** When it was delivered or the session was spawned, epoch ms. */
  at: number
  /** The first words of the request, for `ade-msg status`. */
  brief: string
  /** Close the answering session once it has replied (`spawn --close`). */
  autoClose?: boolean
  /** Reminders already typed, and when the last one was. */
  nudges?: number
  nudgedAt?: number
  /** The last `ade-msg update` about it, until the session replies or works again. */
  update?: { state: UpdateState; text: string; at: number }
  /** When the request line was typed (`ask`); a spawn's is typed by the opening, later. */
  deliveredAt?: number
  /** Extra Enters sent because the line never started a turn. */
  rings?: number
  /** Its caller was told the session may be stuck; said once. */
  wedgeWarned?: boolean
}

export type RequestState =
  | "in corso"
  | "attende un permesso"
  | "sessione chiusa"
  | "in avvio"
  | "inattiva senza risposta"
  | "forse bloccata"

/** Whether an agent is in a turn, from its CLI's own hooks. Absent means unknown, never idle. */
export interface Activity {
  state: "busy" | "idle"
  at: number
  /**
   * Where the agent is working, from the hook's own input: a session that
   * moved into another worktree reports it here, and its branch is that one's.
   */
  cwd?: string
}

/** Two paths the same directory, whatever the slashes, case (Windows) or trailing separator. */
export function sameDir(a: string, b: string): boolean {
  const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  return norm(a) === norm(b)
}

/**
 * The pane status a turn hook implies, or `undefined` to leave it alone.
 *
 * The status used to change only when the user pressed Enter in the pane, so
 * a session working on a request typed in by `ade-msg` stayed "Disponibile"
 * for its whole turn, in the sidebar and in `ade-msg list`. Where the CLI has
 * turn hooks they are the truth both ways. An idle written before the pane was
 * last set working is the previous turn's and does not end this one; a
 * permission question, an error or a pane still opening is not overridden.
 */
export function statusFromActivity(
  status: string,
  activity: Activity | undefined,
  workingSince: number | undefined,
): "working" | "idle" | undefined {
  if (!activity) return undefined
  if (status !== "idle" && status !== "working") return undefined
  if (activity.state === "busy") return status === "working" ? undefined : "working"
  if (status !== "working") return undefined
  return workingSince === undefined || activity.at >= workingSince ? "idle" : undefined
}

/** A CLI without turn hooks counts as free once it has printed nothing for this long. */
export const QUIET_FREE_MS = 4000
/**
 * A hooked session whose activity cannot be read (no turn yet, a file gone or
 * garbled, another conversation's) counts as free only after this much
 * silence: not knowing is not knowing it is idle, and a working TUI repaints.
 */
export const UNKNOWN_FREE_MS = 15_000
/** A "busy" older than this, from a session silent for a minute, is a Stop hook that never ran. */
export const STALE_BUSY_MS = 30 * 60_000

/**
 * Whether text can be typed into a session without interrupting it.
 *
 * Messages between sessions travel in the background: whatever is typed into
 * a session in the middle of a turn is read as the user speaking, pulls the
 * agent off its task and costs a turn. So everything waits for the turn to
 * end. With turn hooks the agent says so itself; without them (codex, agy) a
 * working TUI keeps repainting its spinner, and a few quiet seconds are the
 * end of the turn. A standing permission prompt would take the Enter as its
 * answer, so it is never free.
 */
export function isFree(
  target: { hooked: boolean; permissionPending: boolean; activity?: Activity; lastOutputAt?: number },
  now: number,
): boolean {
  if (target.permissionPending) return false
  const quietFor = target.lastOutputAt === undefined ? Infinity : now - target.lastOutputAt
  if (target.hooked) {
    // Nothing known at all, neither a turn nor a byte of output: not a reason to type.
    if (!target.activity) return target.lastOutputAt !== undefined && quietFor >= UNKNOWN_FREE_MS
    if (target.activity.state === "idle") return true
    return now - target.activity.at > STALE_BUSY_MS && quietFor > 60_000
  }
  return quietFor >= QUIET_FREE_MS
}

/**
 * The activity a hook wrote, if it is about this pane's conversation.
 *
 * A nested agent inherits the spawn's environment and its hook writes to the
 * same file; its turns are not the pane's. When the pane's conversation id is
 * known, only that conversation's turns count.
 */
export function parseActivity(text: string | null | undefined, sessionId?: string): Activity | undefined {
  if (!text) return undefined
  try {
    const raw = JSON.parse(text.replace(/^\ufeff/, "")) as Record<string, unknown>
    if ((raw.state !== "busy" && raw.state !== "idle") || typeof raw.at !== "number") return undefined
    if (sessionId && typeof raw.sessionId === "string" && raw.sessionId !== sessionId) return undefined
    return { state: raw.state, at: raw.at, ...(typeof raw.cwd === "string" && raw.cwd.trim() ? { cwd: raw.cwd } : {}) }
  } catch {
    return undefined
  }
}

/**
 * The activity to keep after a read: what was read, or, when nothing could be
 * read, a busy seen before. A read that fails mid-turn does not end the turn;
 * the stale-busy rule of `isFree` still frees a session whose Stop never came.
 * An old idle is dropped: it would let mail in mid-turn.
 */
export function keptActivity(previous: Activity | undefined, read: Activity | undefined): Activity | undefined {
  return read ?? (previous?.state === "busy" ? previous : undefined)
}

/** How long a freshly spawned session has to come up before "not running" means closed. */
export const SPAWN_GRACE_MS = 30_000

/** A turn this long, with no output and no change in its folder for as long, may be stuck. */
export const WEDGE_MS = 60 * 60_000

export function requestState(
  request: OpenRequest,
  target: {
    running: boolean
    permissionPending: boolean
    activity?: Activity
    lastOutputAt?: number
    /** When the session's folder was last seen to change; absent when never looked at. */
    lastWriteAt?: number
  },
  now: number,
): RequestState {
  if (!target.running) return now - request.at < SPAWN_GRACE_MS ? "in avvio" : "sessione chiusa"
  if (target.permissionPending) return "attende un permesso"
  // Its turn ended after the request reached it, and no reply came: it answered somewhere else, or forgot.
  const reached = request.deliveredAt ?? request.at
  if (target.activity?.state === "idle" && target.activity.at > reached && !request.update)
    return "inattiva senza risposta"
  /*
   * Working for an hour and neither printing nor changing a file: said, never
   * acted on. A long build prints and a long refactor writes; a session that
   * does neither is waiting on something nobody will answer.
   */
  const quiet = (at: number | undefined) => at === undefined || now - at >= WEDGE_MS
  if (
    target.activity?.state === "busy" &&
    now - target.activity.at >= WEDGE_MS &&
    quiet(target.lastOutputAt) &&
    quiet(target.lastWriteAt)
  ) {
    return "forse bloccata"
  }
  return "in corso"
}

/**
 * Why `ade-msg relaunch` is refused, or `undefined` when it may go ahead.
 *
 * Only the session that spawned the target may relaunch it, and only with a
 * note: the replacement starts from its brief and that note. Without one it
 * redoes the job, or resumes the loop that got it relaunched.
 */
export function relaunchRefusal(
  message: { from: string; note: string },
  target: { id: string; title: string },
  spawner: string | undefined,
): string | undefined {
  if (!message.from || spawner !== message.from) {
    return `errore: puoi riavviare solo le sessioni avviate da questa sessione con spawn ("${target.title}" non lo è)`
  }
  if (!message.note.trim()) {
    return `errore: relaunch richiede --note "<a che punto è e cosa fare adesso>": la sessione riparte da quella nota`
  }
  return undefined
}

/** Told once to the caller of a request whose session may be stuck. */
export function formatWedged(request: OpenRequest, answerer: MailPane | undefined, now: number): string {
  return (
    `[ade-msg] ${who(answerer)} lavora alla richiesta ${request.id} da ${age(now - (request.deliveredAt ?? request.at))} ` +
    `senza output né modifiche: forse bloccata. Guarda il suo pane, poi ade-msg interrupt ${answerer?.id ?? "<sessione>"} o relaunch --note.`
  )
}

/**
 * The keys that stop what an agent is doing without closing it.
 *
 * Esc for the CLIs that cancel a turn on it and keep the session (Claude
 * Code, codex, agy); Ctrl-C for the rest, which is what a shell expects.
 * Ctrl-C to Claude Code twice would quit it, so it is never sent there.
 */
export function interruptKeys(agentId: string | undefined): string {
  return agentId === "claude-code" || agentId === "codex" || agentId === "agy"
    ? String.fromCharCode(27)
    : String.fromCharCode(3)
}

/** A decision still waiting for an answer, from the specs' event logs. */
export interface OpenDecision {
  spec: string
  key: string
  session: string
  text: string
  at: string
}

const LOG_LINE = /^(\S+)\s+(.+?)\s+(decisione|risolta)\s+\[k=([^\]\s]+)\]\s*(.*)$/

/**
 * The `decisione [k=…]` lines no `risolta [k=…]` has answered yet.
 *
 * Each spec logs its events in `status/<spec>.log`, one line each:
 * `2026-09-15T16:40 <sessione> <verbo> [k=<chiave>] <testo>`. A key is
 * answered by any later `risolta` with the same key in the same log.
 */
export function openDecisions(logs: readonly { spec: string; text: string }[]): OpenDecision[] {
  const open: OpenDecision[] = []
  for (const log of logs) {
    const pending = new Map<string, OpenDecision>()
    for (const line of log.text.split(/\r?\n/)) {
      const match = LOG_LINE.exec(line.trim())
      if (!match) continue
      const [, at, session, verb, key, text] = match
      if (verb === "decisione")
        pending.set(key!, { spec: log.spec, key: key!, session: session!, text: text!, at: at! })
      else pending.delete(key!)
    }
    open.push(...pending.values())
  }
  return open
}

/** After an agent's turn ends without a reply, how long before it is reminded. */
export const IDLE_NUDGE_MS = 20_000
/** How long a typed request may go without starting a turn before Enter is sent again. */
export const RERING_AFTER_MS = 20_000
/** The same for a spawn, whose request is typed only once the new session has settled. */
export const RERING_SPAWN_AFTER_MS = 60_000

/**
 * Whether to press Enter again for a request that never started a turn.
 *
 * The one way a typed line is lost is to stay in the input box: a TUI took the
 * text and its Enter for a paste. With turn hooks that is visible — the line
 * went in and no turn began — and a second Enter is the fix. Only with hooks:
 * without them nothing distinguishes a stuck line from a slow start, and an
 * Enter at the wrong moment answers whatever the agent asks next. Once.
 */
export function shouldRering(
  request: OpenRequest,
  target: { running: boolean; permissionPending: boolean; activity?: Activity; hooked: boolean },
  now: number,
): boolean {
  if (!target.hooked || !target.running || target.permissionPending || (request.rings ?? 0) >= 1) return false
  const since = request.deliveredAt ?? request.at
  const wait = request.deliveredAt !== undefined ? RERING_AFTER_MS : RERING_SPAWN_AFTER_MS
  if (now - since < wait) return false
  // Still in a turn that began before: the line is queued behind it, not stuck.
  if (target.activity?.state === "busy") return false
  return !target.activity || target.activity.at < since
}

/** A request older than this, in a session silent for {@link NUDGE_QUIET_MS}, gets a reminder. */
export const NUDGE_AFTER_MS = 60_000
export const NUDGE_QUIET_MS = 45_000
export const NUDGE_GAP_MS = 120_000
export const MAX_NUDGES = 2

/**
 * Whether to remind a session that someone is blocked on it.
 *
 * The one way a request is lost for good is an agent that answers in its own
 * conversation instead of with `ade-msg reply`: it finishes, goes quiet, and
 * the caller waits for a timeout. A TUI at work repaints constantly, so a
 * session with no output for 45 s is one that has stopped — that is when a
 * reminder costs nothing and saves the request. Never while a permission
 * prompt stands (Enter would answer it), and at most twice.
 */
export function shouldNudge(
  request: OpenRequest,
  target: {
    running: boolean
    permissionPending: boolean
    lastOutputAt?: number
    activity?: Activity
    /**
     * The target has requests of its own still open. It is quiet because it
     * is waiting on them, the way an orchestrator should, and a reminder
     * would only cost it a turn.
     */
    waitingOnOthers?: boolean
  },
  now: number,
): boolean {
  if (!target.running || target.permissionPending) return false
  if (target.waitingOnOthers) return false
  // A session that said it is blocked is waiting on its caller, not forgetting to answer.
  if (request.update) return false
  if ((request.nudges ?? 0) >= MAX_NUDGES) return false
  if (request.nudgedAt !== undefined && now - request.nudgedAt < NUDGE_GAP_MS) return false
  // With turn hooks the agent's own word decides: working is never nudged, and a turn that ended is.
  if (target.activity?.state === "busy") return false
  const reached = request.deliveredAt ?? request.at
  if (target.activity?.state === "idle" && target.activity.at > reached)
    return now - target.activity.at >= IDLE_NUDGE_MS
  if (now - request.at < NUDGE_AFTER_MS) return false
  return target.lastOutputAt === undefined || now - target.lastOutputAt >= NUDGE_QUIET_MS
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
      : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`
}

/** What `ade-msg status` prints: every request still waiting for an answer. */
export function requestsTable(
  requests: readonly OpenRequest[],
  panes: readonly MailPane[],
  stateOf: (request: OpenRequest) => RequestState,
  now: number,
  decisions: readonly OpenDecision[] = [],
): string {
  const pending = decisions.length
    ? `\ndecisioni aperte:\n${decisions.map((d) => `  ${d.spec} [k=${d.key}] ${d.session}: ${briefOf(d.text, 80)}`).join("\n")}\n`
    : ""
  if (requests.length === 0) return `nessuna richiesta in corso\n${pending}`
  const title = (id: string) => (id ? (panes.find((pane) => pane.id === id)?.title ?? id) : "anonima")
  const rows = requests.map((request) => [
    request.id,
    request.kind + (request.autoClose ? "+close" : ""),
    age(now - request.at),
    request.update && stateOf(request) === "in corso"
      ? `${request.update.state}: ${briefOf(request.update.text, 40)}`
      : stateOf(request),
    `${title(request.from)} → ${title(request.to)}`,
    request.brief,
  ])
  const widths = [0, 1, 2, 3].map((col) => Math.max(...rows.map((row) => row[col]!.length)))
  const lines = rows.map((row) => row.map((cell, col) => (col < 4 ? cell.padEnd(widths[col]!) : cell)).join("  "))
  return `${lines.join("\n")}\n\nattendi: ade-msg wait <id> [<id>...] [--any]   annulla: ade-msg cancel <id>\n${pending}`
}

/** Requests as saved across a restart; anything malformed is dropped. */
export function parseOpenRequests(text: string | null | undefined): OpenRequest[] {
  if (!text) return []
  try {
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (entry): entry is OpenRequest =>
        !!entry &&
        typeof entry === "object" &&
        isRequestId((entry as OpenRequest).id) &&
        ((entry as OpenRequest).kind === "ask" || (entry as OpenRequest).kind === "spawn") &&
        typeof (entry as OpenRequest).from === "string" &&
        typeof (entry as OpenRequest).to === "string" &&
        typeof (entry as OpenRequest).at === "number",
    )
  } catch {
    return []
  }
}

/** How many sessions `spawn` may keep open at once, unless the user set another number. */
export const DEFAULT_MAX_SPAWNED = 6

/** The first words of a text, on one line. */
export function briefOf(text: string, length = 60): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > length ? `${flat.slice(0, length)}…` : flat
}

/** The answer to a request, typed into the caller when nothing was waiting for it any more. */
export function formatLateReply(ref: string, text: string, replier: MailPane | undefined): string {
  return `[Risposta alla richiesta ${ref} da ${who(replier)}]: ${oneLine(text)}`
}

/**
 * What `ade-msg list` prints: a heading per project, and under it each
 * session's number, id, agent, state and title. The number is global, so it
 * means the same session whichever project the caller is in.
 */
export function sessionsTable(panes: readonly MailPane[]): string {
  if (panes.length === 0) return "nessuna sessione aperta\n"
  const ordered = byProject(panes)
  const rows = ordered.map((pane, i) => [String(i + 1), pane.id, pane.agent ?? "-", pane.status ?? "-", pane.title])
  const widths = [0, 1, 2, 3].map((col) => Math.max(...rows.map((row) => row[col]!.length)))
  const out: string[] = []
  let current: string | undefined
  ordered.forEach((pane, i) => {
    const project = projectOf(pane)
    if (project !== current) {
      const count = ordered.filter((other) => projectOf(other) === project).length
      if (current !== undefined) out.push("")
      out.push(`progetto ${project} (${count} ${count === 1 ? "sessione" : "sessioni"})`)
      current = project
    }
    out.push(`  ${rows[i]!.map((cell, col) => (col < 4 ? cell.padEnd(widths[col]!) : cell)).join("  ")}`)
  })
  /* The full help is ~800 tokens; `list` is called often and needs none of it. */
  return `${out.join("\n")}\n\naltri comandi: ade-msg help\n`
}

/** What `ade-msg agents` prints: the CLIs a `spawn` can start. */
export function agentsTable(agents: readonly { id: string; label: string }[]): string {
  return `${agents.map((agent) => `${agent.id.padEnd(14)}${agent.label}`).join("\n")}\n\nuso: ade-msg spawn <agente> "<compito>" [--no-wait] [--close]\n`
}

export const USAGE =
  "uso:\n" +
  '  ade-msg send   <sessione> "<testo>"       nota, non aspetta risposta\n' +
  '  ade-msg ask    <sessione> "<richiesta>"   aspetta la risposta e la stampa\n' +
  '  ade-msg spawn  <agente> "<compito>"       nuova sessione (subagent), aspetta il risultato\n' +
  '  ade-msg reply  <id> "<risultato>"         risponde a una richiesta ricevuta\n' +
  '  ade-msg update <id> bloccata|decisione "<motivo>"  non è una risposta: sveglia chi aspetta, la richiesta resta aperta\n' +
  "  ade-msg wait   <id> [<id>...] [--any]     aspetta le risposte (tutte, o la prima con --any)\n" +
  "  ade-msg status                          richieste in corso\n" +
  "  ade-msg cancel <id>                     annulla una tua richiesta\n" +
  "  ade-msg close  <sessione> [--force]     chiude una sessione avviata da te con spawn e le sue figlie;\n" +
  "                                          rifiuta se una worktree ha lavoro non integrato, salvo --force\n" +
  '  ade-msg relaunch <sessione> --note "<a che punto è>" [--model <id>] [--fresh]\n' +
  "                                          riavvia una sessione avviata da te, stesso pane e worktree:\n" +
  "                                          riprende la sua conversazione (o da zero con --fresh) e riceve la nota\n" +
  "  ade-msg interrupt <sessione>            ferma quello che sta facendo (Esc o Ctrl-C), la sessione resta aperta\n" +
  '  ade-msg memory add decisione|fatto|trappola|todo "<testo>"\n' +
  "                                          aggiunge una voce a .ade/memory.md, la memoria condivisa del progetto\n" +
  "  ade-msg memory show                     stampa la memoria condivisa\n" +
  '  ade-msg kv set <chiave> "<valore>" | get <chiave> | del <chiave> | list [<prefisso>]\n' +
  "                                          stato condiviso tra le sessioni del progetto\n" +
  '  ade-msg kv lock <chiave> [--ttl <sec>] ["<nota>"] | unlock <chiave> [--force]\n' +
  "                                          lock con scadenza (predefinita 600s): chi lo tiene lo rilascia\n" +
  "  ade-msg stats                           token per sessione e quota letta dalla cache\n" +
  "  ade-msg who-owns <file>                chi possiede il file secondo la bacheca del team (TEAM.md)\n" +
  "  ade-msg inbox                          stampa i messaggi lunghi arrivati per te e li segna come letti\n" +
  "  ade-msg agents | whoami\n" +
  "opzioni:\n" +
  "  --no-wait        ask/spawn: stampa subito l'id, poi usa wait (per lanciare in parallelo)\n" +
  "  --name <nome>    spawn: nome della sessione, usabile poi come destinatario\n" +
  "  --worktree       spawn: lavora in una git worktree sul branch ade/<nome>, accanto al progetto\n" +
  "  --model <id>     spawn: modello (claude, codex, agy)\n" +
  "  --effort <liv>   spawn, relaunch: low|medium|high|xhigh|max (claude), low..high (agy), minimal..max (codex)\n" +
  "  --profile <nome> spawn: modello ed effort dalla classe di lavoro in dispatch.json della bacheca\n" +
  "  --base <branch>  spawn --worktree: branch o commit da cui parte (predefinito: il branch della sessione che chiama)\n" +
  "  --fork           spawn: parte dalla tua conversazione e ne riusa la cache (claude, codex;\n" +
  "                   stesso agente e modello, non con --worktree)\n" +
  "  --close          spawn: chiude la sessione dopo la risposta, se non ha lavoro da integrare\n" +
  "                   (di norma resta aperta: serve per i seguiti)\n" +
  "  --file <perc>    ask/spawn/send/reply: il testo è il contenuto del file\n" +
  "  --timeout <sec>  ask/spawn/wait: quanto aspettare (predefinito 110)\n" +
  "<sessione> = numero, id, titolo o nome dell'agente; progetto/nome cerca solo in quel progetto,\n" +
  "  un nome da solo preferisce le sessioni del tuo progetto.\n"

/**
 * How long a session without turn hooks is believed to be still working on a
 * request it has not answered.
 *
 * Long on purpose. It is not a guess at how long the work takes — it is how
 * long the "still working" claim may go unchecked before ADE stops making it.
 * Thirty minutes matches `STALE_BUSY_MS`, which is where a hooked session's
 * unclosed turn is given up on for the same reason.
 */
export const ANSWER_HOLD_MS = STALE_BUSY_MS

/**
 * Whether a quiet session is still in the turn a request opened.
 *
 * Silence ends a turn only for a session that owes nobody an answer. Without
 * turn hooks (agy, and Codex until it installs its own) the end of a turn is
 * read from the terminal going quiet for a couple of seconds — which a long
 * tool call, a wait on the network or a model thinking also look like. For
 * work the user started that is a harmless flicker; for work another session
 * asked for it it is a wrong answer to a question somebody is acting on: the
 * sidebar, the header bar and `ade-msg list` all say the session is free while
 * it is still working, so the caller stops waiting and asks someone else.
 *
 * This is about what the state *says*. Delivery is decided separately, by
 * `isFree`, which for a session without hooks still goes by the quiet
 * terminal alone: holding the state here does not keep the mailbox from
 * typing into it.
 *
 * The turn ends when the answer goes out — the request is no longer open —
 * or when the hold expires, so a session that dies without answering does not
 * stay "at work" forever.
 */
export function holdsForAnswer(
  requests: readonly Pick<OpenRequest, "to" | "at" | "deliveredAt">[],
  paneId: string,
  now: number,
): boolean {
  return requests.some((request) => {
    if (request.to !== paneId) return false
    const reached = request.deliveredAt ?? request.at
    return now - reached < ANSWER_HOLD_MS
  })
}

/** What a couple of seconds of silence mean for a pane marked working. */
export type QuietOutcome =
  /** The turn is over: the pane goes back to available. */
  | "settle"
  /** The turn is not over, and something else — a hook's Stop — will end it. */
  | "wait"
  /**
   * The turn is not over, and nothing else will end it: ask again after the
   * next quiet spell. Without this the pane is left held with no timer and no
   * output coming, so an expired hold is never noticed and the session stays
   * "at work" for good.
   */
  | "recheck"

export function quietOutcome(pane: { hooked: boolean; busy: boolean; owesAnswer: boolean }): QuietOutcome {
  // With turn hooks silence is not the end of a turn (a long tool call is
  // silent): the hook says when, and its `idle` settles the pane on its own.
  if (pane.hooked) return pane.busy ? "wait" : "settle"
  return pane.owesAnswer ? "recheck" : "settle"
}
