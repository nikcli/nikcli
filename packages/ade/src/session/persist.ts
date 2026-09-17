/**
 * Workspace persistence: serialise and restore the workbench state across reloads.
 *
 * The model is deliberately conservative: every field has a defined fallback,
 * and a corrupted or partially-upgraded store must never prevent the app from
 * starting. `parseWorkspace` returns `undefined` for unrecoverable input
 * (garbage JSON, unsupported future version) and fills in defaults for missing
 * or mistyped fields.
 *
 * The `version` field is a monotonic integer. When the schema changes, a new
 * migration function is added to `MIGRATIONS` and the current version is
 * bumped. Each migration transforms version N to N+1, so restoring a v1 state
 * on a v3 app runs two migrations in sequence.
 */

import { restoreHistory } from "../browser/history"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** One saved transcript line. Mirrors `TranscriptLine` without importing a `.tsx`. */
export interface SavedLine {
  kind: string
  text: string
  repeat?: number
}

export interface PaneState {
  id: string
  title: string
  agent: string
  cwd: string
  branch: string
  /** "idle" | "running" | "paused" | "done" | "error" */
  status: string
  /**
   * What the session was asked to do.
   *
   * Without it a restored session is a title and nothing else: "Riprova"
   * relaunches the agent with an empty prompt, which is a different session
   * wearing the same name. It is also what makes restarting on open possible
   * at all, because it is the only record of the work.
   */
  task?: string
  /**
   * The tail of the transcript.
   *
   * The process cannot survive the app closing, let alone the machine
   * restarting, so what is worth keeping is what it said. Bounded by the
   * writer, not here: a reader must accept whatever it finds.
   */
  lines?: SavedLine[]
  /** The model label the pane showed, so the restored header is not blank. */
  model?: string
  /** Whether this session was live when the app went away, so it can be resumed. */
  wasRunning?: boolean
  /**
   * The agent's own conversation id, when the CLI let ADE choose one.
   *
   * This is what makes a restore a *resume* rather than a new session with
   * the old title: the agent is asked for this exact conversation back, with
   * everything it had worked out. Absent for the CLIs that will not take an
   * id — see `session-new/resume.ts`, which is where the difference lives.
   */
  resumeId?: string
  /** The project the pane belongs to; absent in states saved before panes of several projects were kept. */
  project?: string
  /** The worktree a spawned session works in. */
  worktree?: string
  /** Arguments chosen at spawn, replayed on every start. */
  spawnArgs?: string[]
  /**
   * The cells the user resized the pane to. Absent means the default size
   * of one cell.
   *
   * Added without a version bump, on purpose. The field is optional and every
   * reader skips what it does not know, while a reader handed a version newer
   * than its own refuses the whole store — and the autosave then writes an
   * empty workbench over it. Bumping for this would make going back to an
   * earlier build lose every open session to gain nothing.
   */
  span?: { columns: number; rows: number }
}

/**
 * A browser pane, saved apart from the sessions.
 *
 * Apart, because `panes` is read by everything that counts and resumes
 * sessions, and a browser pane is neither. Added without a version bump for
 * the reason given on `PaneState.span`: optional, and skipped by readers
 * that do not know it.
 */
export interface BrowserPaneState {
  id: string
  title: string
  url: string
  /** Back/forward list, see `browser/history.ts`. */
  history?: { entries: string[]; index: number }
  /** The session the pane is bound to, see `browser/binding.ts`. */
  owner?: { id: string; title: string }
  project?: string
  span?: { columns: number; rows: number }
}

export interface WorkspaceState {
  version: number
  panes: PaneState[]
  /** Absent in states saved before browser panes were kept. */
  browsers?: BrowserPaneState[]
  focusedPaneId: string | undefined
  pinnedColumns: number | undefined
  currentView: string
  sidebarWidth: number
  projectPath: string | undefined
}

/** The version this code writes. */
export const CURRENT_VERSION = 4

// ---------------------------------------------------------------------------
// Defaults — every field has one, so partial restores always produce a usable state
// ---------------------------------------------------------------------------

function defaultPane(): PaneState {
  return { id: "", title: "", agent: "", cwd: "", branch: "", status: "idle" }
}

function defaultWorkspace(): WorkspaceState {
  return {
    version: CURRENT_VERSION,
    panes: [],
    focusedPaneId: undefined,
    pinnedColumns: undefined,
    currentView: "grid",
    sidebarWidth: 260,
    projectPath: undefined,
  }
}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

/** Serialise the workspace state to a JSON string. */
export function serializeWorkspace(state: WorkspaceState): string {
  return JSON.stringify({ ...state, version: CURRENT_VERSION })
}

// ---------------------------------------------------------------------------
// Parse (tolerant)
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/**
 * The kinds a transcript line may claim to be.
 *
 * Checked rather than trusted because the value reaches the DOM as a CSS
 * class and a style hook: an unknown kind renders unstyled, and a crafted one
 * would be a selector written by whatever wrote the store.
 */
const LINE_KINDS = new Set(["step", "shell", "note", "diff", "error"])

function sanitiseLines(raw: unknown): SavedLine[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const lines: SavedLine[] = []
  for (const entry of raw) {
    if (!isObject(entry)) continue
    if (typeof entry.text !== "string") continue
    const kind = asString(entry.kind, "note")
    const repeat = asOptionalNumber(entry.repeat)
    lines.push({
      kind: LINE_KINDS.has(kind) ? kind : "note",
      text: entry.text,
      ...(repeat !== undefined && repeat > 1 ? { repeat: Math.floor(repeat) } : {}),
    })
  }
  return lines
}

function sanitisePane(raw: unknown): PaneState {
  if (!isObject(raw)) return defaultPane()
  const def = defaultPane()
  const task = asOptionalString(raw.task)
  const model = asOptionalString(raw.model)
  const resumeId = asOptionalString(raw.resumeId)
  const lines = sanitiseLines(raw.lines)
  const span = sanitiseSpan(raw.span)
  return {
    id: asString(raw.id, def.id),
    title: asString(raw.title, def.title),
    agent: asString(raw.agent, def.agent),
    cwd: asString(raw.cwd, def.cwd),
    branch: asString(raw.branch, def.branch),
    status: asString(raw.status, def.status),
    ...(task !== undefined ? { task } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(resumeId !== undefined ? { resumeId } : {}),
    ...(lines !== undefined ? { lines } : {}),
    ...(typeof raw.wasRunning === "boolean" ? { wasRunning: raw.wasRunning } : {}),
    ...(asOptionalString(raw.project) ? { project: raw.project as string } : {}),
    ...(asOptionalString(raw.worktree) ? { worktree: raw.worktree as string } : {}),
    ...(Array.isArray(raw.spawnArgs) && raw.spawnArgs.every((arg) => typeof arg === "string")
      ? { spawnArgs: raw.spawnArgs as string[] }
      : {}),
    ...(span ? { span } : {}),
  }
}

/**
 * A span is two small whole numbers or nothing.
 *
 * Nothing rather than a repaired value: a pane whose stored size cannot be
 * read gets the default size, which is the size it had before it was resized.
 */
function sanitiseSpan(raw: unknown): { columns: number; rows: number } | undefined {
  if (!isObject(raw)) return undefined
  const columns = asOptionalNumber(raw.columns)
  const rows = asOptionalNumber(raw.rows)
  if (columns === undefined || rows === undefined) return undefined
  const whole = (n: number) => Math.min(12, Math.max(1, Math.round(n)))
  return { columns: whole(columns), rows: whole(rows) }
}

/** A browser pane needs an id and a URL; without either there is nothing to reopen. */
function sanitiseBrowsers(raw: unknown): BrowserPaneState[] {
  if (!Array.isArray(raw)) return []
  const browsers: BrowserPaneState[] = []
  for (const entry of raw) {
    if (!isObject(entry)) continue
    const id = asOptionalString(entry.id)
    const url = asOptionalString(entry.url)
    if (!id || !url) continue
    const history = isObject(entry.history) ? restoreHistory(url, entry.history) : undefined
    const span = sanitiseSpan(entry.span)
    const project = asOptionalString(entry.project)
    const ownerId = isObject(entry.owner) ? asOptionalString(entry.owner.id) : undefined
    const owner = ownerId && isObject(entry.owner) ? { id: ownerId, title: asString(entry.owner.title, "") } : undefined
    browsers.push({
      id,
      title: asString(entry.title, ""),
      url,
      ...(history ? { history } : {}),
      ...(owner ? { owner } : {}),
      ...(project ? { project } : {}),
      ...(span ? { span } : {}),
    })
  }
  return browsers
}

function sanitisePanes(raw: unknown): PaneState[] {
  if (!Array.isArray(raw)) return []
  return raw.map(sanitisePane)
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>

/**
 * v1 → v2: added `projectPath` and `currentView`.
 *
 * v1 stored the active view in a `view` field and had no project tracking.
 * Renames the field and fills the new one.
 */
const migrateV1toV2: Migration = (raw) => {
  const out: Record<string, unknown> = { ...raw, version: 2 }
  // Rename `view` → `currentView` if the old name was used
  if ("view" in raw && !("currentView" in raw)) {
    out.currentView = raw.view
    delete out.view
  }
  // Fill missing fields introduced in v2
  if (!("projectPath" in out)) out.projectPath = undefined
  if (!("sidebarWidth" in out)) out.sidebarWidth = 260
  return out
}

/**
 * v2 → v3: panes carry their task, their transcript and whether they were live.
 *
 * Nothing to rename and nothing to compute: a v2 store simply has no record
 * of what any session was asked to do. Those panes restore as they always
 * did — visible, inert, and not restarted, because restarting a session
 * whose task is unknown would launch an agent with an empty prompt.
 */
const migrateV2toV3: Migration = (raw) => ({ ...raw, version: 3 })

/**
 * v3 → v4: panes carry the agent's own conversation id.
 *
 * Nothing to compute. A v3 store has no record of any conversation, so its
 * sessions restore the way they always did — the agent started again and the
 * task typed in — and the ones that can be resumed properly are the ones
 * started after this version.
 */
const migrateV3toV4: Migration = (raw) => ({ ...raw, version: 4 })

const MIGRATIONS: Record<number, Migration> = {
  1: migrateV1toV2,
  2: migrateV2toV3,
  3: migrateV3toV4,
}

/** Apply all migrations from `fromVersion` up to `CURRENT_VERSION`. */
export function migrateWorkspace(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  let version = typeof raw.version === "number" ? raw.version : 0
  let state = { ...raw }

  while (version < CURRENT_VERSION) {
    const migrate = MIGRATIONS[version]
    if (!migrate) return undefined // unknown gap — can't bridge
    state = migrate(state)
    version = typeof state.version === "number" ? state.version : version + 1
  }

  return state
}

// ---------------------------------------------------------------------------
// Parse entry point
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string into a `WorkspaceState`, tolerating every kind of damage.
 *
 * Returns `undefined` only when nothing useful can be recovered: invalid JSON
 * or a version from the future that has no migration path. Partial or mistyped
 * fields are silently replaced with defaults — the app starts with a degraded
 * but functional state rather than crashing.
 */
export function parseWorkspace(json: string): WorkspaceState | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }

  if (!isObject(parsed)) return undefined

  // Prototype pollution guard — work on a clean copy as Record<string, unknown>
  const raw: Record<string, unknown> = { ...parsed }
  delete raw["__proto__"]
  delete raw["constructor"]
  delete raw["prototype"]

  const version = typeof raw.version === "number" ? raw.version : 0

  // Future version with no migration path — don't guess
  if (version > CURRENT_VERSION) return undefined

  // Migrate if needed
  let data: Record<string, unknown> = raw
  if (version < CURRENT_VERSION) {
    const migrated = migrateWorkspace(data)
    if (!migrated) return undefined
    data = migrated
  }

  const def = defaultWorkspace()
  return {
    version: CURRENT_VERSION,
    panes: sanitisePanes(data.panes),
    browsers: sanitiseBrowsers(data.browsers),
    focusedPaneId: asOptionalString(data.focusedPaneId),
    pinnedColumns: asOptionalNumber(data.pinnedColumns),
    currentView: asString(data.currentView, def.currentView),
    sidebarWidth: asNumber(data.sidebarWidth, def.sidebarWidth),
    projectPath: asOptionalString(data.projectPath),
  }
}
