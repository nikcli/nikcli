import { redactHistory, redactUrl, type BrowserHistory } from "../browser/history"
import { type Span, applyOrder } from "../grid/arrange"
import { focusAfterClose } from "../grid/focus"
import { normalizePath, pathEquals, isAbsolutePath } from "../host/path"
import { CURRENT_VERSION, type WorkspaceState, type PaneState } from "../session/persist"
import { boundPaneTranscript, boundWorkspaceTranscripts } from "../session/transcript-budget"
import { cleanTranscript } from "../session/transcript-line"
import type { TranscriptLine, PaneTree } from "../grid/pane"
import type { Workspace, SidebarSession } from "../sidebar"
import { t, translate } from "../i18n"

export type PaneStatus = "idle" | "provisioning" | "working" | "waiting" | "done" | "error"

/**
 * ADE's top-level sections.
 *
 * - `agent` — the voice assistant's console: what it was asked, what it did.
 * - `code`  — the grid of agent terminals. Called "plancia" until 2026-09-12.
 * - `chat`  — a conversation with a language model, with no terminal behind it.
 * - `bot`   — the roster of named, persistent bots, and the rooms they share.
 *
 * `chat` and `bot` are not the same thing and the difference is worth keeping:
 * a chat is one conversation with a model, thrown away when it stops being
 * useful. A bot is a *someone* — a name, a persona, a model it is pinned to,
 * and a memory of its own that outlives any one conversation — and several of
 * them can be put in a room together.
 *
 * Mirrored, not imported, by `@nikcli-ai/voice`: the voice package already
 * depends on this one, so importing the type back would close a cycle. Four
 * string literals are the cheaper price, which is the same trade that file
 * makes for `PaneStatus`.
 */
export type AdeView = "agent" | "code" | "chat" | "bot"

export const ADE_VIEWS: readonly AdeView[] = ["agent", "code", "chat", "bot"]

/**
 * The one place a section is named.
 *
 * The chrome, the palette and the voice readback all read from here, so a
 * rename cannot leave two of them disagreeing about what the user is looking
 * at — which is exactly how "plancia" survived in the palette long after the
 * design had stopped using the word.
 */
export const ADE_VIEW_LABELS: Record<AdeView, string> = {
  agent: "Agent",
  code: "Code",
  chat: "Chat",
  bot: "Bot",
}

/**
 * Whether Chat and Bot can be reached. The one switch for both (S40).
 *
 * They are hidden for now, not removed: the code, the tests and the stored
 * conversations all stay, and turning this back on brings back every way in —
 * the section bar, the palette, the section shortcut, the voice command and a
 * workbench restored into one of them. Nothing else in the app needs to change,
 * because everything that lists or opens a section asks `VISIBLE_VIEWS` or
 * `reachableView` rather than `ADE_VIEWS`.
 */
export const CHAT_AND_BOT_ENABLED = false

/**
 * The sections a person can get to: what the bar shows and the palette offers.
 *
 * Takes the switch as a parameter so the tests can check the "on" branch
 * too; the app only ever calls it with the constant, through `VISIBLE_VIEWS`.
 */
export function visibleViews(enabled: boolean = CHAT_AND_BOT_ENABLED): readonly AdeView[] {
  return ADE_VIEWS.filter((view) => enabled || (view !== "chat" && view !== "bot"))
}

export const VISIBLE_VIEWS: readonly AdeView[] = visibleViews()

export function isViewVisible(view: AdeView, views: readonly AdeView[] = VISIBLE_VIEWS): boolean {
  return views.includes(view)
}

/**
 * The section to actually show for `view`.
 *
 * A hidden one lands on `code`, the grid, which is where every other "no such
 * section" already goes. Applied where a view is set from outside the bar —
 * a restored workbench, the voice command — so a stored `"chat"` does not
 * open a section with no way back to it in the bar.
 */
export function reachableView(view: AdeView, views: readonly AdeView[] = VISIBLE_VIEWS): AdeView {
  return isViewVisible(view, views) ? view : "code"
}

/** Cycles forward through the sections a person can reach, wrapping at the end. */
export function nextView(current: AdeView, views: readonly AdeView[] = VISIBLE_VIEWS): AdeView {
  const index = views.indexOf(current)
  return views[(index + 1) % views.length] ?? "code"
}

/** The note every restore appends, in either language: the last launch may have used the other one. */
function isRestoreNote(text: string): boolean {
  return text.startsWith(translate("it", "restore.note")) || text.startsWith(translate("en", "restore.note"))
}

/**
 * Reads a persisted view name, tolerating one that no longer exists.
 *
 * Necessary rather than defensive: `ade.workspace` on machines that ran an
 * earlier build holds `"plancia"` or `"alberi"`, and a workbench restored
 * into a view that no branch renders is a blank window with working chrome —
 * the worst shape a bug can take, because nothing looks broken.
 *
 * Both retired names land on `code`. For "plancia" that is the same view
 * renamed; for "alberi" it is the closest thing left, since the worktree
 * board was removed rather than moved.
 */
export function restoreView(raw: unknown): AdeView {
  if (raw === "plancia" || raw === "alberi") return "code"
  return reachableView(ADE_VIEWS.find((view) => view === raw) ?? "code")
}

export interface Pane {
  id: string
  title: string
  status: PaneStatus
  activity?: string
  elapsed?: string
  tokens?: string
  model: string
  mode: string
  agent?: string
  lines: TranscriptLine[]
  browserUrl?: string
  /**
   * The browser pane's back/forward list; its current entry is `browserUrl`.
   *
   * Kept here and not in the pane component, because the component is
   * rebuilt whenever the pane is drawn again — switching project and back
   * rebuilt it on the URL the pane was opened with.
   */
  browserHistory?: BrowserHistory
  /**
   * The session a browser pane belongs to (S46): what the inspector sends
   * goes there. The title is the one it had when bound, for the chip once the
   * session is gone. See `browser/binding.ts`.
   */
  browserOwner?: { id: string; title: string }
  /**
   * The video panel's file, empty when the panel is open with nothing in it.
   *
   * Present rather than absent for an empty panel, because "" is what
   * distinguishes a video pane waiting for a file from a session pane, and
   * the two are laid out by different components.
   */
  videoPath?: string
  /** The 3D panel's model file; "" while the panel waits for one, like `videoPath`. */
  modelPath?: string
  /** The app simulator's dev server URL; "" while the panel waits for one. */
  appUrl?: string
  /** The simulator's device id, from `simulator/simulator.ts`. */
  appDevice?: string
  appLandscape?: boolean
  /** A desktop window's size, once the user has dragged it. */
  appWindow?: { width: number; height: number }
  cwd?: string
  tree?: PaneTree
  workspaceId: string
  /** Set when the pane holds a file being edited rather than a session. */
  filePath?: string
  /**
   * Set when the tile is drawn by a plugin.
   *
   * A plugin pane is a full member of the workbench — it is focused, expanded,
   * closed and laid out like any other — but it is not a session and not a
   * file, so everything that counts sessions or persists them has to skip it.
   * Kept as an object rather than a flag because closing the tile has to tell
   * the plugin registry which registration it belonged to.
   */
  plugin?: { pluginId: string; name: string }
  /**
   * What this session was asked to do, kept so a retry restarts the same work.
   * Without it "Riprova" relaunches the agent with an empty prompt, which is a
   * different session wearing the same title.
   */
  task?: string
  /**
   * The agent's own conversation id, when its CLI let ADE choose one.
   *
   * The difference between a session that comes back and a session that
   * starts again wearing the old name. See `session-new/resume.ts`.
   */
  resumeId?: string
  /** The git worktree this session works in, when `spawn --worktree` gave it one; its cwd on every start. */
  worktree?: string
  /** Arguments chosen at spawn (`--model`, agy's `--add-dir`), kept so a restart runs the same session. */
  spawnArgs?: string[]
  /** The cells the user resized this tile to; absent means the default size. See `grid/arrange.ts`. */
  span?: Span
}

/**
 * True for a pane that draws something other than an agent session.
 *
 * Asked by everything that counts, restores or messages sessions. The video
 * and 3D panels are recognised by their mode, not by their path: both open
 * with an empty path, and `!pane.videoPath` read "" as "no video here", so an
 * empty player was listed as a session and offered to be restarted as one.
 */
export function isPanelPane(
  pane: Pick<Pane, "mode" | "browserUrl" | "filePath" | "videoPath" | "modelPath" | "appUrl" | "plugin">,
): boolean {
  return Boolean(
    pane.browserUrl ||
    pane.filePath ||
    pane.videoPath ||
    pane.modelPath ||
    pane.appUrl ||
    pane.plugin ||
    pane.mode === "video" ||
    pane.mode === "model" ||
    pane.mode === "app" ||
    pane.mode === "decisions",
  )
}

export interface Workbench {
  panes: Pane[]
  focusedId?: string
  pinnedColumns?: number
  expandedId?: string
  view: AdeView
  sidebarWidth: number
  projectPath?: string
}

export function createWorkbench(): Workbench {
  return {
    panes: [],
    // The terminals, because that is what ADE is for. `agent` and `chat` are
    // where you go on purpose; `code` is where you already were.
    view: "code",
    sidebarWidth: 260,
  }
}

export function addPane(workbench: Workbench, pane: Pane): Workbench {
  return {
    ...workbench,
    panes: [...workbench.panes, pane],
    focusedId: pane.id,
  }
}

export function closePane(workbench: Workbench, paneId: string): Workbench {
  const nextFocused = focusAfterClose({
    panes: workbench.panes.map((p) => p.id),
    focused: workbench.focusedId,
    closing: paneId,
  })

  return {
    ...workbench,
    panes: workbench.panes.filter((p) => p.id !== paneId),
    focusedId: nextFocused,
    expandedId: workbench.expandedId === paneId ? undefined : workbench.expandedId,
  }
}

export function updatePane(workbench: Workbench, paneId: string, updates: Partial<Pane>): Workbench {
  return {
    ...workbench,
    panes: workbench.panes.map((p) => (p.id === paneId ? { ...p, ...updates } : p)),
  }
}

export function expandPane(workbench: Workbench, paneId: string): Workbench {
  return {
    ...workbench,
    focusedId: paneId,
    expandedId: workbench.expandedId === paneId ? undefined : paneId,
  }
}

export function setColumns(workbench: Workbench, columns?: number): Workbench {
  return {
    ...workbench,
    pinnedColumns: columns,
    expandedId: undefined,
  }
}

/**
 * The grid's panes in a new order, as the user dragged them.
 *
 * `order` is the visible panes only; the other projects' panes keep their
 * places. The order of `panes` is what is saved, so this is also what makes
 * the arrangement survive a restart.
 */
export function reorderPanes(workbench: Workbench, order: readonly string[]): Workbench {
  return { ...workbench, panes: applyOrder(workbench.panes, order) }
}

/**
 * The size the user chose for a pane, or `undefined` to give it back its
 * default. Once set it is kept, and survives restarts and layout changes,
 * clamped to the grid but never rewritten by it.
 */
export function resizePane(workbench: Workbench, paneId: string, span: Span | undefined): Workbench {
  return {
    ...workbench,
    panes: workbench.panes.map((p) => {
      if (p.id !== paneId) return p
      const { span: _previous, ...rest } = p
      return span ? { ...rest, span: { columns: span.columns, rows: span.rows } } : rest
    }),
  }
}

/**
 * The projects to list, with their sessions nested under them.
 *
 * `known` is every project the user has opened, so one they opened and have not
 * started an agent in yet still appears. Derived from the panes alone, a project
 * would vanish the moment its last session closed — which makes the list a
 * report on what is running rather than the place you switch projects from.
 */
function inferAgent(model: string, title: string): string {
  const t = (title + " " + model).toLowerCase()
  if (t.includes("claude")) return "claude-code"
  if (t.includes("codex") || t.includes("openai")) return "codex"
  if (t.includes("opencode")) return "opencode"
  if (t.includes("agy") || t.includes("antigravity")) return "agy"
  if (t.includes("hermes") || t.includes("nous")) return "hermes"
  if (t.includes("kimi") || t.includes("moonshot")) return "kimi"
  if (t.includes("prime")) return "prime"
  if (t.includes("ohmypi")) return "ohmypi"
  if (t.includes("pi")) return "pi"
  if (t.includes("shell") || t.includes("term") || t.includes("bash") || t.includes("zsh") || t.includes("powershell"))
    return "terminal"
  return "nikcli"
}

export function deriveWorkspaces(
  panes: Pane[],
  known: ReadonlyArray<{ root: string; name: string; branch?: string }> = [],
): Workspace[] {
  const workspaces: Record<string, Workspace> = {}

  for (const project of known) {
    workspaces[project.name] = {
      id: project.name,
      name: project.name,
      path: project.root,
      branch: project.branch,
      sessions: [],
    }
  }

  for (const pane of panes) {
    // Neither a browser nor a plugin tile is a session, and the sidebar is a
    // list of sessions: counting them there would make "3 sessioni" mean
    // something different from the number of agents running.
    if (isPanelPane(pane)) continue

    if (!workspaces[pane.workspaceId]) {
      workspaces[pane.workspaceId] = {
        id: pane.workspaceId,
        name: pane.workspaceId,
        sessions: [],
      }
    }

    const ws = workspaces[pane.workspaceId]
    const branch = pane.tree?.branch || ws?.branch

    workspaces[pane.workspaceId].sessions.push({
      id: pane.id,
      title: pane.title,
      status: pane.status,
      workspaceId: pane.workspaceId,
      activity: pane.activity,
      agent: pane.agent ?? (pane.model ? inferAgent(pane.model, pane.title) : undefined),
      branch,
      cwd: pane.cwd || ws?.path,
    })
  }

  return Object.values(workspaces)
}

/** The project's name, as the folder it lives in calls it. */
function lastSegment(path: string | undefined): string | undefined {
  if (!path) return undefined
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1]
}

/**
 * A session that was alive when the app went away, and can be started again.
 *
 * "Alive" is not "not finished": a session that errored has nothing to
 * resume, and one still provisioning never got as far as a process. Both of
 * the live states qualify — a pane that was waiting on a permission prompt
 * was mid-work, and the work is the thing being resumed.
 *
 * Either a task or a conversation id is required, because one of the two is
 * what makes the restart a continuation. With a `resumeId` the agent is
 * handed back its own conversation and needs nothing typed; without one the
 * task is all there is, and restarting an agent with an empty prompt is not
 * resuming a session, it is opening a new one that happens to share a name.
 */
export function isResumable(
  pane: Pick<
    Pane,
    | "status"
    | "task"
    | "resumeId"
    | "mode"
    | "browserUrl"
    | "filePath"
    | "videoPath"
    | "modelPath"
    | "appUrl"
    | "plugin"
  >,
): boolean {
  if (isPanelPane(pane)) return false
  const hasTask = (pane.task ?? "").trim().length > 0
  const hasConversation = (pane.resumeId ?? "").trim().length > 0
  if (!hasTask && !hasConversation) return false
  return pane.status === "working" || pane.status === "waiting" || pane.status === "idle"
}

export function toWorkspaceState(workbench: Workbench): WorkspaceState {
  /*
   * Plugin tiles are not saved, and that is deliberate rather than an
   * oversight. What would be restored is a tile belonging to a plugin that
   * may not be declared any more, may have been renamed, or may simply have
   * failed to load — and an empty pane with a plugin's name on it is a worse
   * answer than no pane. The plugin opens its own tiles when it loads.
   */
  const saved = workbench.panes
    .filter((p) => !isPanelPane(p))
    .map((p) => ({
      id: p.id,
      title: p.title,
      agent: p.agent ?? p.model ?? "",
      cwd: p.cwd ?? "",
      branch: p.tree?.branch ?? "",
      status: p.status,
      ...(p.task ? { task: p.task } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.resumeId ? { resumeId: p.resumeId } : {}),
      // The project each pane belongs to: the workbench holds every project's sessions, not only the open one's.
      ...(p.workspaceId ? { project: p.workspaceId } : {}),
      ...(p.worktree ? { worktree: p.worktree } : {}),
      ...(p.spawnArgs?.length ? { spawnArgs: [...p.spawnArgs] } : {}),
      ...(p.span ? { span: { columns: p.span.columns, rows: p.span.rows } } : {}),
      /*
       * Recorded at save time, not derived at restore time.
       *
       * By the time the state is read back the status has been rewritten to
       * something truthful about a process that no longer exists, so the one
       * moment this can be known is while the session is still running.
       */
      wasRunning: isResumable(p),
      // Cleaned before it is bounded: the budget should be spent on lines
      // somebody will read, not on the frame that was redrawn under them.
      lines: boundPaneTranscript(cleanTranscript(p.lines.map((line) => ({ ...line })))),
    }))

  /*
   * Browser panes are saved as the page they show, so a restart reopens the
   * same page rather than dropping the pane. A plugin tile is never one.
   */
  const browsers = workbench.panes
    .filter((p) => p.browserUrl && !p.plugin)
    .map((p) => ({
      id: p.id,
      title: p.title,
      // Saved without the parameters that carry credentials: see `redactUrl`.
      url: redactUrl(p.browserUrl!),
      ...(p.browserHistory ? { history: redactHistory(p.browserHistory) } : {}),
      ...(p.browserOwner ? { owner: { id: p.browserOwner.id, title: p.browserOwner.title } } : {}),
      ...(p.workspaceId ? { project: p.workspaceId } : {}),
      ...(p.span ? { span: { columns: p.span.columns, rows: p.span.rows } } : {}),
    }))

  return {
    version: CURRENT_VERSION,
    panes: boundWorkspaceTranscripts(saved, workbench.focusedId),
    ...(browsers.length ? { browsers } : {}),
    focusedPaneId: workbench.focusedId,
    pinnedColumns: workbench.pinnedColumns,
    currentView: workbench.view,
    sidebarWidth: workbench.sidebarWidth,
    projectPath: workbench.projectPath,
  }
}

/**
 * Rebuilds a workbench from what was saved.
 *
 * `projectName` is the project those panes belonged to. It matters because the
 * grid shows one project's sessions at a time: a restored pane filed under a
 * placeholder name belongs to no project, so it would be listed in the sidebar
 * and then shown by nothing. The saved state records the project's path, and
 * its last segment is the name every live pane is filed under.
 */
const PANE_STATUSES: PaneStatus[] = ["idle", "provisioning", "working", "waiting", "done", "error"]

const LINE_KINDS: TranscriptLine["kind"][] = ["step", "shell", "note", "diff", "error"]

/** Anything the store cannot vouch for reads as a plain note. */
function toLineKind(kind: string): TranscriptLine["kind"] {
  return LINE_KINDS.find((known) => known === kind) ?? "note"
}

/**
 * The status a restored pane should actually show.
 *
 * The saved value is copied only where it still describes something true. A
 * session saved as "working" has no process behind it once the app has been
 * closed — whether by the user or by the machine shutting down — so showing
 * "working" is a claim about a pid that does not exist, and the grid's own
 * liveness sweep animates under it. Anything that was live becomes "done",
 * which is what it is: over, with its transcript intact. "error" is kept,
 * because how a session ended survives the app that ran it.
 */
export function restoredStatus(saved: string): PaneStatus {
  if (saved === "error") return "error"
  if (!PANE_STATUSES.includes(saved as PaneStatus)) return "done"
  if (saved === "working" || saved === "waiting" || saved === "provisioning" || saved === "idle") return "done"
  return saved as PaneStatus
}

/** Windows hands the same directory back with either slash and any case. */
function samePath(a: string, b: string): boolean {
  const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  return norm(a) === norm(b)
}

export function fromWorkspaceState(state: WorkspaceState, projectName?: string): Workbench {
  const owner = projectName ?? lastSegment(state.projectPath) ?? "ws-restored"
  return {
    panes: state.panes
      .map((p): Pane => {
        /*
         * The transcript comes back with the process's death appended, rather
         * than replacing it. Before, every restored pane held exactly one line
         * saying the process was gone — which is true, and is also the only
         * thing a user could no longer check, because the output that would
         * have told them what the agent had done was discarded with it.
         */
        /*
         * Cleaned on the way back in, not only on the way out.
         *
         * The transcripts already on disk were captured before anything
         * filtered them, and they are the ones being looked at right now: a
         * restored nikcli session opened on a thousand braille spinner frames,
         * a flattened banner and a stray `+q4d73Gi=…` from a DCS reply. Doing
         * it here means they read correctly on the next launch rather than on
         * the next session.
         */
        const history = cleanTranscript(
          (p.lines ?? [])
            // The note below is appended on every launch; the previous launches'
            // copies say nothing the new one does not.
            .filter((line) => !(line.kind === "note" && isRestoreNote(line.text)))
            .map(
              (line): TranscriptLine => ({
                // Narrowed here as well as in the store's sanitiser: the kind reaches
                // the DOM as a class name, and the type that says so should not rest
                // on an assertion about what some other module promised to check.
                kind: toLineKind(line.kind),
                text: line.text,
                ...(line.repeat !== undefined ? { repeat: line.repeat } : {}),
              }),
            ),
        )

        return {
          id: p.id,
          title: p.title,
          status: restoredStatus(p.status),
          activity: p.wasRunning ? "toResume" : "restored",
          model: p.model ?? p.agent,
          mode: "auto",
          agent: p.agent,
          cwd: p.cwd,
          task: p.task,
          lines: [
            ...history,
            {
              kind: "note",
              /*
               * Three sentences, because three things can have happened and
               * telling them apart is the whole point. Reopening the agent's
               * own conversation is not the same as running the task again,
               * and a line that said "riprendo il compito" for both left the
               * user unable to tell which one they got.
               */
              text: !p.agent
                ? `${t("restore.note")} ${t("restore.note.gone")}`
                : p.resumeId
                  ? `${t("restore.note")} ${t("restore.note.reopen")}`
                  : `${t("restore.note")} ${t("restore.note.rerun")}`,
            },
          ],
          workspaceId: p.project || owner,
          ...(p.worktree ? { worktree: p.worktree } : {}),
          ...(p.spawnArgs?.length ? { spawnArgs: [...p.spawnArgs] } : {}),
          ...(p.span ? { span: { columns: p.span.columns, rows: p.span.rows } } : {}),
          /*
           * Sessions run in the project itself, or in the worktree `spawn
           * --worktree` made for them; only a pane saved from one of the old
           * per-session worktrees is a tree that may be behind.
           */
          tree: p.branch
            ? {
                branch: p.branch,
                fidelity: p.worktree
                  ? "full"
                  : p.cwd && state.projectPath && !p.project && samePath(p.cwd, state.projectPath) === false
                    ? "stale"
                    : "project",
                note: t("activity.restored"),
              }
            : undefined,
        }
      })
      .concat(
        (state.browsers ?? []).map(
          (b): Pane => ({
            id: b.id,
            title: b.title,
            // As `browser.new` creates it: a page is never a finished session.
            status: "working",
            model: "—",
            mode: "browser",
            browserUrl: b.url,
            ...(b.history ? { browserHistory: { entries: [...b.history.entries], index: b.history.index } } : {}),
            ...(b.owner ? { browserOwner: { id: b.owner.id, title: b.owner.title } } : {}),
            workspaceId: b.project || owner,
            ...(b.span ? { span: { columns: b.span.columns, rows: b.span.rows } } : {}),
            lines: [],
          }),
        ),
      ),
    focusedId: state.focusedPaneId,
    pinnedColumns: state.pinnedColumns,
    expandedId: undefined,
    view: restoreView(state.currentView),
    sidebarWidth: state.sidebarWidth,
    projectPath: state.projectPath,
  }
}

/**
 * The sessions a restore should start again, in the order they were saved.
 *
 * Read from the saved state rather than from the restored panes, because the
 * restored panes have deliberately forgotten they were running — that is the
 * point of `restoredStatus`.
 */
export function sessionsToResume(state: WorkspaceState): PaneState[] {
  return state.panes.filter(
    (pane) =>
      pane.wasRunning === true &&
      // Either half is enough: the conversation id reopens the session with
      // everything in it, and the task is what is typed when there is none.
      ((pane.task ?? "").trim().length > 0 || (pane.resumeId ?? "").trim().length > 0),
  )
}
