/**
 * How an agent tells ADE which conversation it just opened.
 *
 * `resume.ts` covers the CLIs that let ADE *choose* the id up front. Most do
 * not — codex has no `--session-id` and no `--name` — and for those the only
 * thing that knows the id is the CLI itself. Every one of them can run a
 * command when a session starts, so the id can come back the other way: ADE
 * puts a hook in the CLI's own config, the hook writes one small file, ADE
 * reads it.
 *
 * ## Why a file and not a socket
 *
 * herdr, which solved this first, has a daemon and a command-line client, so
 * its hook calls `herdr pane report-agent-session …` over an RPC socket. ADE
 * has neither. Standing up a listener would mean a port, a lifetime, and an
 * authentication story for a message that is four fields long — while a file
 * drop needs nothing that is not already in every shell: write text, exit.
 *
 * ## Why the nonce
 *
 * The hook learns which pane it belongs to from the environment, and an agent
 * that starts another agent passes that environment down. Without a nonce the
 * child's `SessionStart` would overwrite the parent's id under the parent's
 * pane, and the pane would then be resumed into a conversation it never had.
 * ADE mints a nonce per spawn and refuses a report that does not carry it —
 * which throws away a file left behind by a previous run of the same pane id.
 *
 * The nonce alone does not stop a nested agent: the child inherits it along
 * with the pane id. What stops the child is order and reason — the first
 * report is the CLI ADE started, which reaches `SessionStart` before it can
 * start anything, and after that only a `resume` or `clear` moves the pane
 * ({@link acceptsLaterReport}).
 *
 * In a `.ts` and free of any host, because this is the part that decides
 * whether a report is believed — and the part that decides how long to wait
 * for one, which is the only thing the user ever notices going wrong.
 */

/** The directory a hook drops its report into. */
export const LINK_DIR_ENV = "ADE_SESSION_DIR"

/**
 * What the report is called inside that directory.
 *
 * Named after the nonce and not after the pane, which makes the stale-file
 * problem disappear rather than be checked for: a new spawn is a new nonce is
 * a new filename, so a report left behind by a previous run of the same pane
 * can never be picked up by mistake. Hex, so it is a legal filename
 * everywhere without any escaping in the script that writes it.
 */
export function reportFile(nonce: string): string {
  return `${nonce}.json`
}

/** Which pane the agent about to start belongs to. */
export const PANE_ENV = "ADE_PANE_ID"

/** This spawn, so a report from a different one is refused. */
export const NONCE_ENV = "ADE_SPAWN_NONCE"

/** What a hook writes. Everything else in the file is ignored. */
export interface LinkReport {
  /** The pane the hook was told it belonged to. */
  readonly pane: string
  /** The spawn it belonged to. */
  readonly nonce: string
  /** Which CLI wrote it: "claude", "codex", … */
  readonly agent: string
  /** The CLI's own conversation id. */
  readonly sessionId: string
  /** When the hook ran, epoch milliseconds. Advisory. */
  readonly at?: number
  /**
   * Why the session started, as the CLI says it: Claude Code sends
   * `startup`, `resume`, `clear` or `compact`. Absent from older scripts and
   * from CLIs that do not say.
   */
  readonly source?: string
}

/** Ids longer than this are not ids. Matches herdr's own ceiling. */
const MAX_SESSION_ID = 512

/**
 * Reads a report, or nothing.
 *
 * Tolerant on purpose: the file is written by a shell script on the far side
 * of a hook system, and a half-written or truncated one must read as "no
 * report yet" rather than as a crash during session restore.
 */
export function parseReport(text: string): LinkReport | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isTable(parsed)) return undefined
  const raw = parsed

  const pane = asId(raw.pane)
  const nonce = asId(raw.nonce)
  const agent = asId(raw.agent)
  const sessionId = asId(raw.sessionId)
  if (!pane || !nonce || !agent || !sessionId) return undefined

  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : undefined
  const source = asId(raw.source)
  return { pane, nonce, agent, sessionId, ...(at !== undefined ? { at } : {}), ...(source ? { source } : {}) }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function asId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_SESSION_ID) return undefined
  return trimmed
}

/**
 * Whether this report is about the session ADE is waiting on.
 *
 * Both halves matter. The pane alone would accept a report left on disk by
 * the previous run that used the same pane id; the nonce alone would accept
 * one about a different pane. Together they identify one spawn.
 */
export function acceptsReport(
  report: LinkReport,
  expected: { pane: string; nonce: string },
): boolean {
  return report.pane === expected.pane && report.nonce === expected.nonce
}

/**
 * A nonce for one spawn.
 *
 * Not a UUID: it is compared for equality and never parsed, and it travels
 * through an environment variable into a shell script, so the fewer
 * characters that mean something to a shell the better.
 */
/** How long to keep asking whether the hook has run. */
export const WATCH_WINDOW_MS = 90_000

/** The first gap between polls, before the backoff widens it. */
export const WATCH_FIRST_GAP_MS = 250

/** The widest that gap gets. */
export const WATCH_MAX_GAP_MS = 2_000

/** Everything {@link watchForReport} needs, so none of it is a real host. */
export interface LinkWatch {
  readonly pane: string
  readonly nonce: string
  /** The drop file's contents, or null when the hook has not run yet. */
  readonly read: (nonce: string) => Promise<string | null>
  /** Called once the report has been taken, so it is not read twice. */
  readonly clear: (nonce: string) => Promise<void>
  /** True once the pane has gone and nobody is waiting any more. */
  readonly cancelled?: () => boolean
  readonly windowMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

/**
 * Waits for the CLI to say which conversation it opened.
 *
 * Polling rather than a watcher because the thing being watched is one file
 * that appears once: a filesystem watcher for that is a thread, a channel and
 * a lifetime to get wrong, and the cost of polling is a `stat` at a widening
 * interval for a minute and a half.
 *
 * The window is long because the wait is not for the hook — that runs in
 * milliseconds — but for the CLI to get to its own `SessionStart`, and a cold
 * start of Claude Code on Windows behind a virus scanner is measured in tens
 * of seconds. Giving up early would silently downgrade those sessions to
 * resuming by "last conversation", which is the behaviour with no hook at all.
 *
 * The backoff is the other half of that: the first few polls are close
 * together because a warm CLI answers almost at once, and the later ones are
 * far apart because by then the answer is probably never coming.
 */
export async function watchForReport(watch: LinkWatch): Promise<LinkReport | undefined> {
  const now = watch.now ?? (() => Date.now())
  const sleep = watch.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + (watch.windowMs ?? WATCH_WINDOW_MS)

  let gap = WATCH_FIRST_GAP_MS
  while (now() < deadline) {
    if (watch.cancelled?.()) return undefined

    const text = await watch.read(watch.nonce)
    if (text !== null) {
      const report = parseReport(text)
      /*
       * Cleared on any complete read, believed or not.
       *
       * A report that parses but is not ours cannot become ours later, and
       * leaving it would mean re-reading the same rejected file every 250 ms
       * for the rest of the window.
       */
      if (report !== undefined) {
        await watch.clear(watch.nonce)
        return acceptsReport(report, watch) ? report : undefined
      }
    }

    await sleep(gap)
    gap = Math.min(WATCH_MAX_GAP_MS, Math.round(gap * 1.4))
  }
  return undefined
}

/**
 * The reasons a session may change conversation after its first report.
 *
 * Both are the user acting inside the CLI — `/resume` another conversation,
 * `/clear` into a new one — and the pane has to follow, or a restore brings
 * back the conversation they left. `startup` is deliberately not here: after
 * the first report, a `startup` with this spawn's nonce is an agent the
 * session started itself (`claude -p` from its own shell inherits the
 * environment, nonce included), and taking its id would resume the pane into
 * a conversation it never had. `compact` keeps the id, so it has nothing to
 * say.
 */
const LATER_SOURCES: ReadonlySet<string> = new Set(["resume", "clear"])

/** Whether a report after the first one moves the pane to a new conversation. */
export function acceptsLaterReport(report: LinkReport, current: string): boolean {
  return report.source !== undefined && LATER_SOURCES.has(report.source) && report.sessionId !== current
}

export interface LinkFollow extends LinkWatch {
  /** Every conversation the pane moves to, the first one included. */
  readonly onReport: (report: LinkReport) => void
}

/**
 * {@link watchForReport}, and then the rest of the session's life.
 *
 * The first report is taken whatever its source, within the usual window. After
 * it the drop file is checked every {@link WATCH_MAX_GAP_MS} — a `stat` per pane
 * every two seconds — for as long as the pane runs, and only a report that
 * {@link acceptsLaterReport} moves the pane. Stopping after the first report,
 * as this used to, is why the hook's `resume|clear` matcher never did anything:
 * the hook wrote the new id, and nobody was reading any more.
 *
 * Without `cancelled` there is no end to wait for, so it stops after the first
 * window.
 */
export async function followReports(follow: LinkFollow): Promise<void> {
  const sleep = follow.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const first = await watchForReport(follow)
  let current = first?.sessionId
  if (first) follow.onReport(first)
  if (!follow.cancelled) return

  while (!follow.cancelled()) {
    await sleep(WATCH_MAX_GAP_MS)
    if (follow.cancelled()) return
    const text = await follow.read(follow.nonce)
    if (text === null) continue
    const report = parseReport(text)
    if (report === undefined) continue
    await follow.clear(follow.nonce)
    if (!acceptsReport(report, follow)) continue
    if (current !== undefined && !acceptsLaterReport(report, current)) continue
    current = report.sessionId
    follow.onReport(report)
  }
}

export function newNonce(): string {
  const bytes = new Uint8Array(12)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
