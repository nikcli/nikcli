/**
 * Bringing a session back, and not just a pane that looks like one.
 *
 * A pty is a child of this window: closing ADE kills every agent, and a
 * machine restart kills everything. What ADE restored until now was the pane
 * and the task — it started the agent again and typed the prompt in, which
 * opens a *new* conversation that happens to share a title. Everything the
 * agent had worked out was gone, and nothing said so.
 *
 * The agents themselves keep their conversations on disk and can be told to
 * pick one up again. Two different shapes, and the difference decides what
 * ADE can promise:
 *
 *   pinned  — ADE chooses the id before the agent starts, hands it over on
 *             the command line, writes it down, and asks for that exact
 *             conversation back. Two sessions in one directory stay two
 *             conversations.
 *   last    — the agent will only offer "the most recent one here". Good
 *             enough for the common case of one session per project, and
 *             wrong the moment there are two, so only the first pane in a
 *             directory may use it.
 *
 * The table below is read off `--help` of each CLI rather than remembered.
 * An agent that is not in it restores the way it always did: started fresh,
 * with the task typed in. That is a worse restore, not a broken one, and it
 * is what every agent gets until someone checks its flags.
 */

/** What one CLI offers. Absent fields mean "this CLI cannot do that". */
export interface ResumeRecipe {
  /**
   * Arguments that start a new conversation under an id ADE picked.
   *
   * Only declared where `byId` exists too: an id ADE cannot ask for again is
   * a value written down for nothing.
   */
  readonly start?: (id: string) => string[]
  /** Arguments that reopen exactly that conversation. */
  readonly byId?: (id: string) => string[]
  /** Arguments that reopen the most recent conversation in this directory. */
  readonly last?: () => string[]
  /**
   * Arguments that start a new conversation as a copy of `parent`, under
   * `child` where the CLI takes an id. The copy's prompt is the parent's, so a
   * forked subagent reads the parent's context from the cache instead of
   * paying for it again.
   *
   *   claude  --resume <parent> --fork-session --session-id <child>
   *   codex   fork <parent>
   */
  readonly fork?: (parent: string, child: string) => string[]
  /**
   * Where the CLI keeps the conversation `byId` would reopen.
   *
   * A pinned id is written down before the agent has said a word, and the CLI
   * only writes the conversation once there is something in it. A session
   * opened and closed without a message leaves an id that `--resume` answers
   * with "No conversation found" — and the CLI then opens a new conversation
   * under an id nobody recorded, so the next restore fails the same way.
   * Undefined when the location is not known: the id is then trusted.
   */
  readonly transcript?: (home: string, cwd: string, id: string) => string | undefined
  /**
   * A file where the CLI itself records the latest conversation per directory.
   *
   * The way to learn an id for a CLI that will not take one up front: read it
   * when the session starts, read it again while it runs, and an id that
   * appears in between is the one this session opened.
   */
  readonly latest?: {
    readonly path: (home: string) => string
    readonly read: (text: string, cwd: string) => string | undefined
  }
}

function joinHome(home: string, ...segments: string[]): string {
  const sep = home.includes("\\") ? "\\" : "/"
  return [home.replace(/[\\/]+$/, ""), ...segments].join(sep)
}

/** Windows hands the same directory back with either slash and any case. */
function sameDir(a: string, b: string): boolean {
  const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  return norm(a) === norm(b)
}

/**
 * agy's `cache/last_conversations.json`: `{ "<directory>": "<conversation id>" }`,
 * read off this machine. Conversations live in `conversations/<id>.db`.
 */
function agyLatest(text: string, cwd: string): string | undefined {
  let map: unknown
  try {
    map = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined
  for (const [dir, id] of Object.entries(map)) {
    if (typeof id === "string" && id && sameDir(dir, cwd)) return id
  }
  return undefined
}

/**
 * Claude Code's project folder: every character that is not a letter or digit
 * becomes `-`. Past 200 characters it shortens the name with a hash this does
 * not reproduce, so a long path answers "unknown" rather than "missing".
 */
function claudeTranscript(home: string, cwd: string, id: string): string | undefined {
  const folder = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  if (folder.length > 200) return undefined
  return joinHome(home, ".claude", "projects", folder, `${id}.jsonl`)
}

/*
 * Read off `--help` of each installed CLI, not remembered:
 *
 *   claude    --session-id <uuid>   start under a given id
 *             -r, --resume <id>     reopen it
 *   pi        --session-id <id>     "use exact project session ID, creating
 *                                   it if missing" — the same trick
 *             --session <path|id>   reopen it
 *   codex     resume <SESSION_ID>   subcommand, not a flag; --last for the
 *                                   most recent
 *   hermes    -r, --resume <id>     / -c, --continue
 *   kimi      -S, --session <id>    / -c, --continue
 *   agy       --conversation <id>   / -c, --continue
 *   prime     -r, --resume <id>     / -c, --continue
 *   nikcli    -s, --session <id>    / -c, --continue
 *   opencode  -s, --session <id>    / -c, --continue
 *   gemini    -r, --resume <value>  takes "latest" or an index, never a uuid
 *
 * Two of them let ADE choose the id, and only those can promise the exact
 * conversation back. The rest can be resumed by an id ADE has no way to learn
 * — herdr solves that by installing a hook into each CLI's own config so the
 * CLI reports its id back, which is more capable and edits files ADE does not
 * own. Until that is a decision someone makes on purpose, those agents get
 * "the most recent one in this directory".
 *
 * gemini is the one that cannot be pinned at all: it will start under an id
 * and then refuse to take it back, so writing the id down would suggest a
 * precision ADE does not have.
 */
export const RESUME: Record<string, ResumeRecipe> = {
  "claude-code": {
    start: (id) => ["--session-id", id],
    byId: (id) => ["--resume", id],
    last: () => ["--continue"],
    fork: (parent, child) => ["--resume", parent, "--fork-session", "--session-id", child],
    transcript: claudeTranscript,
  },
  pi: {
    start: (id) => ["--session-id", id],
    byId: (id) => ["--session", id],
    last: () => ["--continue"],
  },
  codex: {
    byId: (id) => ["resume", id],
    last: () => ["resume", "--last"],
    fork: (parent) => ["fork", parent],
  },
  opencode: {
    byId: (id) => ["--session", id],
    last: () => ["--continue"],
  },
  nikcli: {
    byId: (id) => ["--session", id],
    last: () => ["--continue"],
  },
  hermes: {
    byId: (id) => ["--resume", id],
    last: () => ["--continue"],
  },
  kimi: {
    byId: (id) => ["--session", id],
    last: () => ["--continue"],
  },
  agy: {
    byId: (id) => ["--conversation", id],
    last: () => ["--continue"],
    transcript: (home, _cwd, id) => joinHome(home, ".gemini", "antigravity-cli", "conversations", `${id}.db`),
    latest: {
      path: (home) => joinHome(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json"),
      read: agyLatest,
    },
  },
  prime: {
    byId: (id) => ["--resume", id],
    last: () => ["--continue"],
  },
}

/** True when ADE can pick the conversation id for this agent. */
export function pinsSessionId(agentId: string): boolean {
  return RESUME[agentId]?.start !== undefined
}

/**
 * A conversation id, in the form every one of these CLIs asks for.
 *
 * `crypto.randomUUID` and not a counter: the id is handed to a program that
 * validates it as a UUID, and it has to stay unique across launches, which a
 * counter reset by a restart does not.
 */
export function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // A host without `crypto` is a test harness; the shape is what matters.
  const hex = (length: number) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("")
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`
}

export interface StartPlan {
  /** Arguments to add to the bare command. */
  readonly args: string[]
  /**
   * The id to write down on the pane, when there is one worth writing down.
   *
   * Absent means this agent cannot be asked for a specific conversation, so
   * a restore will fall back to "the most recent one here" or to starting
   * fresh — and the pane should not claim otherwise.
   */
  readonly resumeId?: string
}

/** How to start a brand-new session for this agent. */
export function planStart(agentId: string, id = newSessionId()): StartPlan {
  const recipe = RESUME[agentId]
  if (!recipe?.start) return { args: [] }
  return { args: recipe.start(id), resumeId: id }
}

/**
 * How to start a session as a fork of `parentId`, or why it cannot be one.
 *
 * `resumeId` is the child's own id when the CLI takes one (Claude); otherwise
 * the child's id arrives later from the CLI's hook, like any other session.
 */
export function planFork(
  agentId: string,
  parentId: string | undefined,
  childId = newSessionId(),
): { args: string[]; resumeId?: string } | { error: string } {
  const recipe = RESUME[agentId]
  if (!recipe?.fork) return { error: `${agentId} non sa biforcare una conversazione: avvia senza --fork` }
  if (!parentId) return { error: "questa sessione non ha ancora una conversazione salvata da cui partire" }
  return { args: recipe.fork(parentId, childId), ...(recipe.start ? { resumeId: childId } : {}) }
}

export interface ResumeRequest {
  readonly agentId: string
  /** The id recorded when the session started, if the agent supported one. */
  readonly resumeId?: string
  /**
   * Whether another pane being restored into the same directory has already
   * claimed "the most recent conversation here".
   *
   * The whole reason this argument exists: with two sessions restored into
   * one project, `--continue` on both reopens the same conversation twice,
   * and the two panes then race each other inside it.
   */
  readonly lastTaken?: boolean
  /**
   * The CLI never wrote the conversation `resumeId` names — see
   * `ResumeRecipe.transcript`. There is nothing to reopen, and falling back
   * to "the most recent one here" would hand the pane somebody else's thread.
   */
  readonly missing?: boolean
}

export type ResumePlan =
  /**
   * Reopen a conversation. `args` go after the bare command.
   *
   * `via` says which of the two promises was kept — the exact conversation,
   * or merely the most recent one in this directory — because they are not
   * equally true and the caller has to be able to tell the user which it got.
   */
  | { readonly kind: "resume"; readonly via: "id" | "last"; readonly args: string[] }
  /**
   * Nothing to reopen: start fresh and type the task, as ADE always did.
   *
   * `resumeId` is the id to start under again when the recorded one was never
   * used, so the pane keeps the id it already carries.
   */
  | { readonly kind: "fresh"; readonly resumeId?: string }

/** What to do with one session that was live when the app went away. */
export function planResume(request: ResumeRequest): ResumePlan {
  const recipe = RESUME[request.agentId]
  if (!recipe) return { kind: "fresh" }

  if (request.resumeId && request.missing) {
    return recipe.start ? { kind: "fresh", resumeId: request.resumeId } : { kind: "fresh" }
  }
  if (request.resumeId && recipe.byId) {
    return { kind: "resume", via: "id", args: recipe.byId(request.resumeId) }
  }
  if (recipe.last && !request.lastTaken) {
    return { kind: "resume", via: "last", args: recipe.last() }
  }
  return { kind: "fresh" }
}

/**
 * Plans a whole restore, so the "most recent" claim is handed out once.
 *
 * Sessions are given in the order they were saved, and the first one in a
 * directory that needs "the most recent conversation" gets it. The rest of
 * that directory start fresh rather than all reopening the same one.
 */
export function planRestore<T extends { agentId: string; cwd: string; resumeId?: string; missing?: boolean }>(
  sessions: readonly T[],
): { session: T; plan: ResumePlan }[] {
  const claimed = new Set<string>()
  return sessions.map((session) => {
    const key = `${session.agentId} ${session.cwd}`
    const plan = planResume({
      agentId: session.agentId,
      ...(session.resumeId !== undefined ? { resumeId: session.resumeId } : {}),
      lastTaken: claimed.has(key),
      ...(session.missing ? { missing: true } : {}),
    })
    // Claimed only when it was actually used: a session resumed by its own id
    // leaves "the most recent one" free for the next pane.
    if (plan.kind === "resume" && plan.via === "last") claimed.add(key)
    return { session, plan }
  })
}
