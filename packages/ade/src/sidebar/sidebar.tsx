import { For, Show, createMemo, createSignal, onCleanup, createEffect, type JSX } from "solid-js"
import { Badge } from "../ui/layout"
import "./sidebar.css"
import { getHost } from "../host/shell"
import { every } from "../host/every"
import { discoverProject, type Project } from "../host/project"
import { toDisplayPath, basename, normalizePath } from "../host/path"
import { fuzzyMatch } from "../command/match"
import { formatDuration, elapsed } from "../session/metrics"
/*
 * `FilePreview` is deliberately not imported here.
 *
 * It was, and was never rendered — an import that made the sidebar look like
 * it had a preview pane while clicking a file opened the editor pane
 * instead. The component still exists and still works (its cancellation bug
 * is fixed), but nothing in the sidebar shows it, and an import that only
 * pulls code into the bundle is worse than an absent feature: it hides the
 * absence.
 */

import {
  type FileNode,
  type FlatFileNode,
  deriveDefaultExpandedDirs,
  expandDirectoryParents,
  flattenFileTree,
  toggleDirectoryExpansion,
} from "./file-tree"
import { writeDraggedPaths } from "./file-drag"
import { createKeyedList } from "./keyed"
import {
  STORAGE_KEY_EXPANDED_DIRS,
  STORAGE_KEY_EXPANDED_WORKSPACES,
  STORAGE_KEY_WIDTH,
  STORAGE_KEY_SECTIONS,
  STORAGE_KEY_SEARCH_KINDS,
  type EntryKind,
  deserializeKinds,
  toggleKind,
  deserializeSet,
  safeGetStorage,
  safeSetStorage,
  serializeSet,
} from "./storage"
import {
  countSessions,
  deserializeSections,
  scrollingSection,
  serializeSections,
  statPills,
  toggleSection,
  type SectionId,
} from "./sections"
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  calculateResize,
  parseSidebarWidth,
} from "./width"
import { beginResizeDrag } from "./sidebar-logic"
import { AgentMark } from "../session-new/agent-mark"
import {
  type FlatSessionChildRow,
  type FlatWorkspaceHeaderRow,
  type FlatWorkspaceRow,
  type Workspace,
  type SidebarSession,
  flattenWorkspaces,
  toggleWorkspaceExpansion,
  mapAgentStatus,
  normalizeAgentId,
} from "./workspace-tree"
import { mergeChildren, markDirectoryError } from "./fs-tree"
import { describeStats, type StatView } from "./system-stats"
import { t } from "../i18n"
import { activityLabel, isReadyActivity } from "../grid/activity"

export interface SidebarProps {
  workspaces: Workspace[]
  selectedSessionId?: string
  onSelectSession?: (id: string) => void
  /**
   * Opens the system's directory picker and adds what the user chooses.
   *
   * Absent in the browser harness, where there is no disk to pick from — and
   * then the button is not drawn at all, rather than drawn and refusing.
   */
  onAddProject?: () => void
  /** Opens the dialog that adds a Space on a host reached over ssh. */
  onAddRemote?: () => void
  /** Switches to a project already in the list. */
  onSelectProject?: (id: string) => void
  /** Launches a new agent session screen. */
  onNewSession?: () => void
  /**
   * A last section, under the file tree.
   *
   * Passed in rather than built here so the sidebar keeps knowing about
   * projects and files and nothing else — what currently goes in it is the
   * screenshot tray, which has its own reasons to exist and its own host.
   */
  bottom?: JSX.Element
  /**
   * Extra sections between the file tree and `bottom`.
   *
   * Passed in already rendered, for the same reason as `bottom`: what
   * currently fills it is whatever plugins have registered, and the sidebar
   * has no business knowing that plugins exist. Above `bottom` rather than
   * below it because the tray is picked up on the way out and these are
   * navigation, which belongs nearer the rest of the navigation.
   */
  sections?: JSX.Element
  /**
   * Opens the settings panel, from the gear at the foot of the column.
   *
   * The one place in ADE that answers "where are the settings". It sits at
   * the very bottom because settings are the last thing anybody looks for
   * and the first that has to always be in the same place — and outside the
   * scrolling area, so it is there whatever the tree is doing.
   */
  onOpenSettings?: () => void
  /**
   * The controls that sit beside the gear on the bottom strip.
   *
   * The theme toggle and the notification bell live here rather than in the
   * top bar: neither does anything to the project, and next to the buttons
   * that open panes and start sessions they were two switches in a row of
   * verbs. Down here they are what they are — the state of the window.
   *
   * Passed in rather than built here because both belong to the workbench:
   * the theme is its signal and the notices are its list.
   */
  footerActions?: JSX.Element
  /**
   * Something else in place of the header and the sections.
   *
   * The bot section puts its roster here: one column, not two lists side by
   * side competing for the same eye. The foot of the column stays as it is
   * everywhere — the screenshots a bot will be shown, and the way into
   * settings.
   */
  content?: JSX.Element
  files?: FileNode[]
  selectedFilePath?: string
  onSelectFile?: (path: string) => void
  /** The project whose files to show. Discovered from the host when absent. */
  project?: Project
  /**
   * Searches the whole project by path. Absent when there is no disk to walk,
   * and then the box says it is only filtering what is already open.
   */
  searchFiles?: (
    query: string,
    kinds: ReadonlySet<EntryKind>,
  ) => Promise<{ path: string; kind: EntryKind; rel: string; ranges: [number, number][] }[]>
  initialWidth?: number
  minWidth?: number
  maxWidth?: number
  storage?: Storage
}

function WorkspaceHeaderRow(props: {
  row: FlatWorkspaceHeaderRow
  isActive?: boolean
  onToggle: (id: string) => void
}) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={1}
      data-slot="workspace-header"
      data-expanded={props.row.isExpanded ? "true" : undefined}
      data-active={props.isActive ? "true" : undefined}
      aria-expanded={props.row.isExpanded}
      onClick={() => props.onToggle(props.row.id)}
    >
      <svg
        data-slot="workspace-chevron"
        viewBox="0 0 12 12"
        width="12"
        height="12"
        aria-hidden="true"
      >
        <path
          d="M4.5 2.5l3.5 3.5-3.5 3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span data-slot="workspace-name" title={props.row.workspace.name}>
        {props.row.workspace.name}
      </span>
      <Show when={props.row.workspace.path?.startsWith("ssh://")}>
        <Badge tone="accent" data-slot="space-badge" title={props.row.workspace.path}>ssh</Badge>
      </Show>
      <Show when={props.isActive}>
        <Badge tone="waiting" data-slot="space-badge">{t("sidebar.active")}</Badge>
      </Show>
      <span data-slot="workspace-count" data-empty={props.row.sessionCount === 0 ? "true" : undefined}>
        {props.row.sessionCount}
      </span>
    </button>
  )
}

function highlightMatch(text: string, ranges?: [number, number][]) {
  if (!ranges || ranges.length === 0) return text
  const res = []
  let last = 0
  for (const [start, end] of ranges) {
    if (start > last) {
      res.push(text.slice(last, start))
    }
    res.push(<span class="highlight-match">{text.slice(start, end)}</span>)
    last = end
  }
  if (last < text.length) {
    res.push(text.slice(last))
  }
  return res
}

/** The part of `ranges` that falls inside `[start, end)`, shifted to start at 0. */
function rangesWithin(ranges: [number, number][], start: number, end: number): [number, number][] {
  const out: [number, number][] = []
  for (const [s, e] of ranges) {
    const from = Math.max(s, start)
    const to = Math.min(e, end)
    if (from < to) out.push([from - start, to - start])
  }
  return out
}

function SessionChildRow(props: {
  row: FlatSessionChildRow
  now: number
  onSelect?: (id: string) => void
}) {
  const displayStatus = () => mapAgentStatus(props.row.session.status)
  const folder = () => {
    if (props.row.session.cwd) {
      const base = basename(props.row.session.cwd)
      if (base && base !== "/" && base !== ".") return base
    }
    return props.row.session.workspaceId || props.row.workspaceId || t("sidebar.project")
  }
  const branch = () => props.row.session.branch

  return (
    <button
      type="button"
      role="treeitem"
      aria-level={2}
      data-slot="session-row"
      data-status={props.row.session.status}
      data-agent-status={displayStatus()}
      data-selected={props.row.isSelected ? "true" : undefined}
      aria-selected={props.row.isSelected}
      onClick={() => props.onSelect?.(props.row.id)}
      title={
        props.row.session.activity && !isReadyActivity(props.row.session.activity)
          ? `${props.row.session.title} — ${activityLabel(props.row.session.activity)}`
          : props.row.session.title
      }
    >
      <div data-slot="session-mark-wrap">
        <AgentMark id={normalizeAgentId(props.row.session.agent)} size={16} colored />
      </div>
      <div data-slot="session-main">
        <div data-slot="session-top">
          <span data-slot="session-title">
            {props.row.session.title}
          </span>
          <span
            data-slot="agent-status-dot"
            data-status={props.row.session.status}
            data-agent-status={displayStatus()}
            title={`Stato: ${displayStatus()}`}
            aria-label={`Stato: ${displayStatus()}`}
          />
        </div>
        <div data-slot="session-meta">
          <span data-slot="agent-card-loc">
            <svg data-slot="agent-card-icon" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
              <path d="M1.5 3.5C1.5 2.67 2.17 2 3 2H5.5L7 3.5H11C11.83 3.5 12.5 4.17 12.5 5V10.5C12.5 11.33 11.83 12 11 12H3C2.17 12 1.5 11.33 1.5 10.5V3.5Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
            <span data-slot="agent-card-folder" title={props.row.session.cwd || folder()}>{folder()}</span>
            <Show when={branch()}>
              <span data-slot="agent-card-sep">•</span>
              <svg data-slot="agent-card-icon" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
                <path d="M4 3.5a1.5 1.5 0 1 1 3 0v4a1.5 1.5 0 1 1-1.5 1.5V6a2 2 0 0 1 2-2h1.5M10.5 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span data-slot="agent-card-branch" title={branch()}>{branch()}</span>
            </Show>
          </span>
          <Show when={props.row.session.startTime}>
            <span data-slot="agent-card-time" title={t("sidebar.elapsed")}>
              {formatDuration(elapsed(props.row.session.startTime!, props.now))}
            </span>
          </Show>
        </div>
      </div>
    </button>
  )
}

function ActiveAgentRow(props: {
  session: SidebarSession
  workspaceName: string
  isSelected: boolean
  now: number
  onSelect?: (id: string) => void
}) {
  const displayStatus = () => mapAgentStatus(props.session.status)
  const folder = () => {
    if (props.session.cwd) {
      const base = basename(props.session.cwd)
      if (base && base !== "/" && base !== ".") return base
    }
    return props.workspaceName || props.session.workspaceId || t("sidebar.project")
  }
  const branch = () => props.session.branch

  return (
    <button
      type="button"
      role="listitem"
      data-slot="active-agent-card"
      data-status={props.session.status}
      data-agent-status={displayStatus()}
      data-selected={props.isSelected ? "true" : undefined}
      aria-selected={props.isSelected}
      onClick={() => props.onSelect?.(props.session.id)}
      title={
        props.session.activity && !isReadyActivity(props.session.activity)
          ? `${props.session.title} — ${activityLabel(props.session.activity)}`
          : props.session.title
      }
    >
      <div data-slot="active-agent-avatar">
        <AgentMark id={normalizeAgentId(props.session.agent)} size={16} colored />
      </div>
      <div data-slot="active-agent-body">
        <div data-slot="active-agent-top">
          <span data-slot="active-agent-title">
            {props.session.title}
          </span>
          <span
            data-slot="agent-status-dot"
            data-status={props.session.status}
            data-agent-status={displayStatus()}
            title={`Stato: ${displayStatus()}`}
            aria-label={`Stato: ${displayStatus()}`}
          />
        </div>
        <div data-slot="active-agent-meta">
          <span data-slot="agent-card-loc">
            <svg data-slot="agent-card-icon" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
              <path d="M1.5 3.5C1.5 2.67 2.17 2 3 2H5.5L7 3.5H11C11.83 3.5 12.5 4.17 12.5 5V10.5C12.5 11.33 11.83 12 11 12H3C2.17 12 1.5 11.33 1.5 10.5V3.5Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
            <span data-slot="agent-card-folder" title={props.session.cwd || folder()}>{folder()}</span>
            <Show when={branch()}>
              <span data-slot="agent-card-sep">•</span>
              <svg data-slot="agent-card-icon" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
                <path d="M4 3.5a1.5 1.5 0 1 1 3 0v4a1.5 1.5 0 1 1-1.5 1.5V6a2 2 0 0 1 2-2h1.5M10.5 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span data-slot="agent-card-branch" title={branch()}>{branch()}</span>
            </Show>
          </span>
          <Show when={props.session.startTime}>
            <span data-slot="agent-card-time" title={t("sidebar.elapsed")}>
              {formatDuration(elapsed(props.session.startTime!, props.now))}
            </span>
          </Show>
        </div>
      </div>
    </button>
  )
}

function WorkspaceTreeRow(props: {
  row: FlatWorkspaceRow
  now: number
  isActiveSpace?: boolean
  onToggleWorkspace: (id: string) => void
  onSelectSession?: (id: string) => void
}) {
  if (props.row.type === "workspace") {
    return (
      <WorkspaceHeaderRow
        row={props.row}
        isActive={props.isActiveSpace}
        onToggle={props.onToggleWorkspace}
      />
    )
  }
  return <SessionChildRow row={props.row} now={props.now} onSelect={props.onSelectSession} />
}

type FlatFileNodeWithRanges = FlatFileNode & { ranges?: [number, number][] }

function FileTreeRow(props: {
  item: FlatFileNodeWithRanges
  onToggleDir: (path: string) => void
  onSelectFile?: (path: string) => void
}) {
  const activate = () => {
    if (props.item.kind === "directory") {
      if (props.item.hasChildren) props.onToggleDir(props.item.path)
    } else {
      props.onSelectFile?.(props.item.path)
    }
  }

  return (
    /*
     * A div carrying the role, not a <button>.
     *
     * In Chromium a button swallows the press that would have started a drag,
     * so `draggable` on it is simply never honoured — the row looks draggable
     * and is not. The screenshot tray hit this first and solved it the same
     * way; the comment there records the symptom.
     *
     * Everything a button gave for free is therefore written out: the role,
     * the tab stop, and Enter/Space activation.
     */
    <div
      role="treeitem"
      tabindex={0}
      aria-level={props.item.depth + 1}
      data-slot="tree-row"
      data-kind={props.item.kind}
      data-expanded={props.item.isExpanded ? "true" : undefined}
      data-selected={props.item.isSelected ? "true" : undefined}
      aria-selected={props.item.isSelected}
      aria-expanded={props.item.kind === "directory" ? (props.item.hasChildren ? props.item.isExpanded : undefined) : undefined}
      /*
       * Both files and directories can be dragged onto a session.
       *
       * Directories used to be held back on the grounds that an agent cannot
       * read one. That premise was wrong: every agent CLI here takes a
       * directory perfectly well — "guarda in packages/ade/" is the most
       * ordinary instruction there is, and handing over the folder is how you
       * scope a task without listing its files.
       *
       * The path leaves with a trailing slash, which is what says "directory"
       * to the reader and to the agent, and which `formatDroppedPaths` keeps.
       */
      draggable={true}
      onDragStart={(event) => {
        if (!event.dataTransfer) return
        const path =
          props.item.kind === "directory" && !props.item.path.endsWith("/")
            ? `${props.item.path}/`
            : props.item.path
        writeDraggedPaths(event.dataTransfer, [path])
        event.dataTransfer.effectAllowed = "copy"
      }}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        // Space scrolls the tree otherwise, which is the opposite of selecting
        // the row the user is standing on.
        event.preventDefault()
        activate()
      }}
    >
      <Show when={props.item.depth > 0}>
        <div data-slot="tree-indent" aria-hidden="true">
          <For each={Array.from({ length: props.item.depth })}>
            {() => <span data-slot="tree-guide" />}
          </For>
        </div>
      </Show>

      <Show
        when={props.item.kind === "directory"}
        fallback={
          <>
            <span data-slot="tree-spacer" aria-hidden="true" />
            <svg
            data-slot="tree-icon"
            viewBox="0 0 14 14"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <path
              d="M3 1.5h5.5l3 3V12.5C11.5 13.05 11.05 13.5 10.5 13.5H3C2.45 13.5 2 13.05 2 12.5V2.5C2 1.95 2.45 1.5 3 1.5z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.1"
            />
            <path
              d="M8.5 1.5V4.5H11.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.1"
            />
          </svg>
          </>
        }
      >
        <Show
          when={props.item.hasChildren}
          fallback={<span data-slot="tree-spacer" aria-hidden="true" />}
        >
          <svg
            data-slot="tree-chevron"
            viewBox="0 0 12 12"
            width="12"
            height="12"
            aria-hidden="true"
          >
            <path
              d="M4.5 2.5l3.5 3.5-3.5 3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </Show>
        <svg
          data-slot="tree-icon"
          viewBox="0 0 14 14"
          width="14"
          height="14"
          aria-hidden="true"
        >
          <path
            d="M1.5 3.5C1.5 2.67 2.17 2 3 2h2.5c.4 0 .78.16 1.06.44l1 1c.28.28.66.44 1.06.44H11c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5v-7z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.1"
            stroke-linejoin="round"
          />
        </svg>
      </Show>

      <span data-slot="tree-label" title={props.item.name}>
        {highlightMatch(props.item.name, props.item.ranges)}
      </span>
      {/* The row is draggable and nothing said so. Two dots, lit only under
          the pointer: enough to answer "can I pick this up" without adding a
          mark to every row of a tree that is mostly read, not dragged. */}
      <span data-slot="row-grip" aria-hidden="true" />
    </div>
  )
}

export function Sidebar(props: SidebarProps) {
  const storage = props.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined)

  const initialWidth = parseSidebarWidth(
    safeGetStorage(storage, STORAGE_KEY_WIDTH),
    props.initialWidth ?? DEFAULT_SIDEBAR_WIDTH,
    props.minWidth ?? MIN_SIDEBAR_WIDTH,
    props.maxWidth ?? MAX_SIDEBAR_WIDTH,
  )
  const [width, setWidth] = createSignal(initialWidth)
  const [isResizing, setIsResizing] = createSignal(false)

  /*
   * Which sections are open, and nothing about how tall they are.
   *
   * The stored pixel height and its drag handle are gone on purpose: a
   * section told to be 320px tall stays 320px tall holding one row, which is
   * where the column's empty middle came from. Height is the content's
   * business, and `scrollingSection` decides which one gives way when the
   * content does not fit — no section is ever made taller than what it holds.
   */
  const [openSections, setOpenSections] = createSignal(
    deserializeSections(safeGetStorage(storage, STORAGE_KEY_SECTIONS)),
  )
  const isOpen = (id: SectionId) => openSections().has(id)
  const scrolls = createMemo(() => scrollingSection(openSections()))

  const toggleOpen = (id: SectionId) => {
    const next = toggleSection(openSections(), id)
    setOpenSections(next)
    safeSetStorage(storage, STORAGE_KEY_SECTIONS, serializeSections(next))
  }

  const pills = createMemo(() => statPills(countSessions(props.workspaces)))

  const initialExpandedWorkspaces = deserializeSet(
    safeGetStorage(storage, STORAGE_KEY_EXPANDED_WORKSPACES),
    props.workspaces.map((w) => w.id),
  )
  const [expandedWorkspaces, setExpandedWorkspaces] = createSignal<Set<string>>(
    initialExpandedWorkspaces,
  )

  const initialExpandedDirs = deserializeSet(
    safeGetStorage(storage, STORAGE_KEY_EXPANDED_DIRS),
    deriveDefaultExpandedDirs(props.files, props.selectedFilePath),
  )
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(initialExpandedDirs)

  const [project, setProject] = createSignal<Project | undefined>()
  const [rootNode, setRootNode] = createSignal<FileNode | undefined>()
  const [searchQuery, setSearchQuery] = createSignal("")
  const [now, setNow] = createSignal(Date.now())

  // The clock the "2m ago" labels read. Nobody reads them in a hidden window.
  createEffect(() => {
    onCleanup(every(1000, () => setNow(Date.now())))
  })

  const loadDir = async (dirPath: string) => {
    const host = await getHost()
    if (!host?.readDir) return
    try {
      const entries = await host.readDir(dirPath)
      setRootNode(prev => {
        if (!prev) return prev
        return mergeChildren(prev, dirPath, entries, false)
      })
      /*
       * The folders that were left open last time, opened again.
       *
       * The expanded set is remembered across launches but the tree is read
       * one level at a time, so a folder remembered as open came back showing
       * a chevron pointing down over nothing. Reading each such child as its
       * parent arrives walks the tree back to where the user left it.
       */
      const open = expandedDirs()
      for (const entry of entries) {
        if (!entry.is_dir) continue
        const path = normalizePath(entry.path)
        if (open.has(path)) void loadDir(path)
      }
    } catch {
      setRootNode(prev => {
        if (!prev) return prev
        return markDirectoryError(prev, dirPath)
      })
    }
  }

  /*
   * CPU, RAM and ADE's memory, every three seconds while the window is shown.
   *
   * Absent in the browser, where there is no host to ask: the strip then
   * simply shows the three buttons. A failed read keeps the last numbers
   * rather than blinking the row away. Reading the machine's process table is
   * the most expensive thing ADE does on a timer, so it stops while hidden.
   */
  const [stats, setStats] = createSignal<StatView | undefined>()
  createEffect(() => {
    onCleanup(
      every(
        3000,
        async () => {
          const host = await getHost()
          if (!host?.systemStats) return
          setStats(describeStats(await host.systemStats()))
        },
        { immediate: true },
      ),
    )
  })

  const [home, setHome] = createSignal("")

  createEffect(() => {
    void getHost().then((host) => host?.homeDir?.().then(setHome))
  })

  /*
   * The project comes from the caller when it has one. Discovering it here as
   * well would give the shell two answers to the same question, and the moment
   * the user opened a second project the sidebar would still be showing the
   * first one's files.
   */
  createEffect(() => {
    const given = props.project
    /*
     * A cancellation flag, because this effect has a slow branch.
     *
     * At mount `props.project` is undefined, so discovery from the working
     * directory starts. A moment later the workbench passes down the project
     * it restored from `ade.workspace` — which need not be the working
     * directory — and this effect runs again and sets the right one. Then the
     * first promise resolves and overwrites it. The result was the file tree
     * of one project beside the grid and the ProjectBar of another, with
     * nothing on screen to explain the mismatch.
     */
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })

    const show = (p: Project) => {
      if (cancelled) return
      setProject(p)
      setRootNode({ id: p.root, name: p.name, path: p.root, kind: "directory" })
      void loadDir(p.root)
    }

    if (given) {
      show(given)
      return
    }

    void getHost().then(async (host) => {
      if (cancelled || !host?.currentDir) return
      const discovered = await discoverProject(host, await host.currentDir())
      show(discovered)
    })
  })

  const toggleWorkspace = (workspaceId: string) => {
    const next = toggleWorkspaceExpansion(expandedWorkspaces(), workspaceId)
    setExpandedWorkspaces(next)
    safeSetStorage(storage, STORAGE_KEY_EXPANDED_WORKSPACES, serializeSet(next))
  }

  const toggleDir = (dirPath: string) => {
    const next = toggleDirectoryExpansion(expandedDirs(), dirPath)
    setExpandedDirs(next)
    safeSetStorage(storage, STORAGE_KEY_EXPANDED_DIRS, serializeSet(next))
    if (next.has(dirPath)) {
      loadDir(dirPath)
    }
  }

  const flatWorkspaces = createMemo(() =>
    flattenWorkspaces(props.workspaces, expandedWorkspaces(), props.selectedSessionId),
  )
  const keyedWorkspaces = createKeyedList(flatWorkspaces, (row) => `${row.type}:${row.id}`)

  const allSessions = createMemo(() => {
    const list: Array<{ session: SidebarSession; workspaceName: string; isSelected: boolean }> = []
    for (const ws of props.workspaces) {
      for (const session of ws.sessions) {
        list.push({
          session: {
            ...session,
            branch: session.branch || ws.branch || (props.project?.name === ws.name ? props.project?.branch : undefined),
          },
          workspaceName: ws.name,
          isSelected: session.id === props.selectedSessionId,
        })
      }
    }
    return list
  })

  const isWorkspaceActive = (wsId: string, wsPath?: string, wsName?: string) => {
    const currentRoot = project()?.root ?? props.project?.root
    const currentName = project()?.name ?? props.project?.name
    return Boolean(
      (currentRoot && (wsId === currentRoot || (wsPath && wsPath === currentRoot))) ||
      (currentName && wsName === currentName),
    )
  }

  const flatFiles = createMemo(() =>
    flattenFileTree(rootNode() ? [rootNode()!] : (props.files ?? []), expandedDirs(), props.selectedFilePath),
  )

  const searchFilteredFiles = createMemo(() => {
    const query = searchQuery()
    const all = flatFiles()
    if (!query) return all
    const wanted = kinds()

    const matches = new Map<string, [number, number][]>()
    const parentsToKeep = new Set<string>()

    for (const node of all) {
      if (!wanted.has(node.kind)) continue
      const match = fuzzyMatch(query, node.name)
      if (match) {
        matches.set(node.path, match.ranges)
        let parentPath = node.parentPath
        while (parentPath) {
          parentsToKeep.add(parentPath)
          const p = all.find(n => n.path === parentPath)
          parentPath = p?.parentPath
        }
      }
    }

    return all.filter(node => matches.has(node.path) || parentsToKeep.has(node.path)).map(node => ({
      ...node,
      ranges: matches.get(node.path)
    }))
  })

  const keyedFiles = createKeyedList(searchFilteredFiles, (item) => item.path)

  /*
   * Searching the whole project, not only what happens to be expanded.
   *
   * The loaded tree is a handful of directories the user clicked open; a
   * repository is tens of thousands of files. Filtering the first and calling
   * it search is the kind of half-truth that makes people stop trusting the
   * box. The walk is asked for once per query, debounced, and its results
   * replace the tree while the query stands.
   */
  const [projectHits, setProjectHits] = createSignal<
    { path: string; kind: EntryKind; rel: string; ranges: [number, number][] }[]
  >([])
  const [searching, setSearching] = createSignal(false)
  const [activeHit, setActiveHit] = createSignal(0)

  /*
   * Files, folders, or both — remembered, because whoever looks only for
   * folders does so every time.
   */
  const [kinds, setKinds] = createSignal<Set<EntryKind>>(
    deserializeKinds(safeGetStorage(storage, STORAGE_KEY_SEARCH_KINDS)),
  )
  const flipKind = (kind: EntryKind) => {
    const next = toggleKind(kinds(), kind)
    setKinds(next)
    safeSetStorage(storage, STORAGE_KEY_SEARCH_KINDS, Array.from(next).join(","))
  }

  createEffect(() => {
    const query = searchQuery().trim()
    const search = props.searchFiles
    const wanted = kinds()
    if (!search || query.length < 1) {
      setProjectHits([])
      setSearching(false)
      return
    }

    setSearching(true)
    // A result list from an older query is thrown away when it lands late.
    let stale = false
    const timer = setTimeout(async () => {
      try {
        const hits = await search(query, wanted)
        if (stale) return
        setProjectHits(hits)
        setActiveHit(0)
      } catch {
        if (!stale) setProjectHits([])
      } finally {
        if (!stale) setSearching(false)
      }
    }, 80)
    onCleanup(() => {
      stale = true
      clearTimeout(timer)
    })
  })

  /*
   * A folder picked from the results is shown where it lives, open.
   *
   * Opening a folder "as a file" has no meaning, and dropping the user back
   * into a closed tree would lose the thing they searched for. So its
   * ancestors and itself are expanded, the search is cleared, and the tree
   * reads its way down to it.
   */
  const revealDirectory = (path: string) => {
    const root = rootNode()
    const rootKey = root ? normalizePath(root.path).toLowerCase() : ""
    // Only the folders inside the project: `C:/Users` has no row to open.
    const chain = [...expandDirectoryParents(`${normalizePath(path)}/x`, new Set())].filter((dir) =>
      dir.toLowerCase().startsWith(`${rootKey}/`),
    )
    const next = new Set([...expandedDirs(), ...chain, ...(root ? [root.path] : [])])
    setExpandedDirs(next)
    safeSetStorage(storage, STORAGE_KEY_EXPANDED_DIRS, serializeSet(next))
    setSearchQuery("")
    if (root) void loadDir(root.path)
  }

  const pickHit = (hit: { path: string; kind: EntryKind }) => {
    if (hit.kind === "directory") revealDirectory(hit.path)
    else props.onSelectFile?.(hit.path)
  }

  let activeResizeCleanup: (() => void) | undefined

  onCleanup(() => {
    activeResizeCleanup?.()
  })

  /*
   * Both drags run through `beginResizeDrag` in `sidebar-logic.ts`.
   *
   * The gesture lifecycle — capture the pointer, listen on the handle rather
   * than on `window`, tear down exactly once — was written out twice here and
   * could not be tested, because this file is a `.tsx` and bun test has no
   * automatic JSX runtime in this package. It now lives in a plain `.ts`
   * module that both this component and `sidebar-logic.test.ts` import; the
   * reasoning about pointer capture and the iframe moved there with it.
   */
  const onResizePointerDown = (event: PointerEvent) => {
    event.preventDefault()
    activeResizeCleanup?.()

    const handle = event.currentTarget as HTMLElement | null
    const startX = event.clientX
    const startWidth = width()
    setIsResizing(true)

    activeResizeCleanup = beginResizeDrag({
      handle,
      pointerId: event.pointerId,
      coordinate: (e) => e.clientX,
      onMove: (clientX) => {
        setWidth(calculateResize(startX, clientX, startWidth, props.minWidth ?? MIN_SIDEBAR_WIDTH, props.maxWidth ?? MAX_SIDEBAR_WIDTH))
      },
      onEnd: () => {
        setIsResizing(false)
        activeResizeCleanup = undefined
      },
      onCommit: () => safeSetStorage(storage, STORAGE_KEY_WIDTH, String(width())),
    })
  }

  const onSearchInput = (e: Event) => {
    setSearchQuery((e.target as HTMLInputElement).value)
  }

  const onSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setSearchQuery("")
      return
    }
    const hits = projectHits()
    if (hits.length === 0) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const step = e.key === "ArrowDown" ? 1 : -1
      setActiveHit((i) => (i + step + hits.length) % hits.length)
      document
        .querySelector(`[data-component="file-results"] [data-index="${activeHit()}"]`)
        ?.scrollIntoView({ block: "nearest" })
    } else if (e.key === "Enter") {
      e.preventDefault()
      const hit = hits[activeHit()]
      if (hit) pickHit(hit)
    }
  }

  return (
    <aside
      data-component="ade-sidebar"
      data-resizing={isResizing() ? "true" : undefined}
      style={{ width: `${width()}px` }}
    >
      <Show when={props.content}>
        <div data-slot="sidebar-content">{props.content}</div>
      </Show>

      {/*
        The whole header, and not only its contents, is behind the guard.
        It used to be mounted always with a `<Show>` inside it, so with no
        project open the column opened on an empty raised card — which at the
        top of a sidebar reads as a search field that will not take text.
        Nothing to say, nothing drawn.
      */}
      <Show when={project() && !props.content}>
        <header data-slot="sidebar-header-project">
          <div data-slot="project-name">
            <span data-slot="project-name-text" title={project()!.name}>{project()!.name}</span>
            <Show when={project()!.branch}>
              {/* Truncated at the end rather than the start, and given the
                  whole leftover width: a branch called
                  `feat/browser-visual-editor-cursor` overflows 260px, and the
                  half that identifies it is the half that was being cut. */}
              <span data-slot="project-branch" title={project()!.branch}>{project()!.branch}</span>
            </Show>
          </div>
          <span data-slot="project-path" title={project()!.root}>
            {toDisplayPath(project()!.root, home())}
          </span>

          {/* Only what is actually happening. Three permanent zeroes used to
              own a full row of a 260px column to report the absence of news. */}
          <Show when={pills().length > 0}>
            <div data-slot="sidebar-pills">
              <For each={pills()}>
                {(pill) => (
                  <span data-slot="sidebar-pill" data-tone={pill.tone}>
                    <i data-slot="sidebar-pill-dot" />
                    {pill.count} {pill.label}
                  </span>
                )}
              </For>
            </div>
          </Show>
        </header>
      </Show>

      <div data-slot="sidebar-sections" hidden={props.content !== undefined}>
        {/*
          Sized to its content, never to a stored pixel height and never to
          the leftover space. `data-scrolls` marks the one section allowed to
          shrink and scroll inside itself when the column runs out of room,
          which `scrollingSection` decides — see the note there.
        */}
        <section
          data-slot="sidebar-section"
          data-section="progetti"
          data-open={isOpen("progetti") ? "true" : undefined}
          data-scrolls={scrolls() === "progetti" ? "true" : undefined}
        >
          {/*
            The header is a row, not a button: adding a project and collapsing
            the list are two different actions, and one button cannot be both.
            The collapse keeps the whole width it had, so the hit target does not
            shrink to the width of the word.
          */}
          <div data-slot="section-header-row">
            <button
              type="button"
              data-slot="section-header"
              aria-expanded={isOpen("progetti")}
              onClick={() => toggleOpen("progetti")}
            >
              <svg data-slot="section-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                <path d="M2.5 4.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span data-slot="section-label">{t("sidebar.spaces")}</span>
              <span data-slot="section-count">{props.workspaces.length}</span>
            </button>
            <div data-slot="section-actions">
            <Show when={props.onAddProject}>
              <button
                type="button"
                data-slot="section-add"
                aria-label={t("sidebar.addSpace")}
                title={t("sidebar.addSpace")}
                onClick={() => props.onAddProject?.()}
              >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path d="M6 2v8M2 6h8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                </svg>
              </button>
            </Show>
            <Show when={props.onAddRemote}>
              <button
                type="button"
                data-slot="section-add"
                aria-label={t("sidebar.addRemote")}
                title={t("sidebar.addRemote")}
                onClick={() => props.onAddRemote?.()}
              >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <rect x="1.5" y="2" width="9" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.1" />
                  <path d="M3.5 4l1.3 1-1.3 1M6 6h2M4 10h4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </Show>
            </div>
          </div>

          <Show when={isOpen("progetti")}>
            <div data-slot="section-content" data-component="workspace-tree" role="tree">
              {/* An empty box teaches nothing. The list says what would be in it. */}
              <Show
                when={keyedWorkspaces().length > 0}
                fallback={<p data-slot="section-empty">{t("sidebar.noSpaces")}</p>}
              >
                <For each={keyedWorkspaces()}>
                  {(entry) => {
                    /*
                     * Read inside the props, not once above them. The keyed
                     * list keeps a row's component and swaps its data, and a
                     * `const row = entry.data()` here ran once, untracked: a
                     * session's status, a count or the active space never
                     * reached a row that already existed.
                     */
                    const isActive = () => {
                      const row = entry.data()
                      return row.type === "workspace"
                        ? isWorkspaceActive(row.id, row.workspace.path, row.workspace.name)
                        : undefined
                    }
                    return (
                      <WorkspaceTreeRow
                        row={entry.data()}
                        now={now()}
                        isActiveSpace={isActive()}
                        /* Pressing a project both opens its row and makes it the
                           one being worked in: the two are the same intent, and
                           asking for a separate click to switch would be asking
                           the user to say it twice. */
                        onToggleWorkspace={(id) => {
                          props.onSelectProject?.(id)
                          toggleWorkspace(id)
                        }}
                        onSelectSession={props.onSelectSession}
                      />
                    )
                  }}
                </For>
              </Show>
            </div>
          </Show>
        </section>

        <section
          data-slot="sidebar-section"
          data-section="agenti"
          data-open={isOpen("agenti") ? "true" : undefined}
          data-scrolls={scrolls() === "agenti" ? "true" : undefined}
        >
          <div data-slot="section-header-row">
            <button
              type="button"
              data-slot="section-header"
              aria-expanded={isOpen("agenti")}
              onClick={() => toggleOpen("agenti")}
            >
              <svg data-slot="section-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                <path d="M2.5 4.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span data-slot="section-label">{t("sidebar.agents")}</span>
              <span data-slot="section-count">{allSessions().length}</span>
            </button>
            <div data-slot="section-actions">
            <Show when={props.onNewSession}>
              <button
                type="button"
                data-slot="section-add"
                aria-label={t("sidebar.newAgentSession")}
                title={t("sidebar.newAgentSession")}
                onClick={() => props.onNewSession?.()}
              >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path d="M6 2v8M2 6h8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                </svg>
              </button>
            </Show>
            </div>
          </div>

          <Show when={isOpen("agenti")}>
            <div data-slot="section-content" data-component="active-agents" role="list">
              <Show
                when={allSessions().length > 0}
                fallback={
                  <div data-slot="active-agents-empty">
                    <p data-slot="section-empty">{t("sidebar.noAgents")}</p>
                    <Show when={props.onNewSession}>
                      <button
                        type="button"
                        data-slot="empty-action-btn"
                        onClick={() => props.onNewSession?.()}
                      >
                        {t("sidebar.startAgent")}
                      </button>
                    </Show>
                  </div>
                }
              >
                <div data-slot="active-agents-list">
                  <For each={allSessions()}>
                    {(item) => (
                      <ActiveAgentRow
                        session={item.session}
                        workspaceName={item.workspaceName}
                        isSelected={item.isSelected}
                        now={now()}
                        onSelect={props.onSelectSession}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
        </section>

        <section
          data-slot="sidebar-section"
          data-section="file"
          data-open={isOpen("file") ? "true" : undefined}
          data-scrolls={scrolls() === "file" ? "true" : undefined}
        >
          <div data-slot="section-header-row">
            <button
              type="button"
              data-slot="section-header"
              aria-expanded={isOpen("file")}
              onClick={() => toggleOpen("file")}
            >
              <svg data-slot="section-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                <path d="M2.5 4.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span data-slot="section-label">{t("sidebar.files")}</span>
            </button>
            <div data-slot="section-actions" />
          </div>

          <Show when={isOpen("file")}>

          <div data-slot="search-box">
            {/* The input sits inside a field rather than being one: on a card
                a bare input has no edge of its own, and the focus ring has
                nothing to sit on. The magnifier is what makes it read as
                search before the placeholder is read. */}
            <div data-slot="search-field">
              <svg
                data-slot="search-leading"
                viewBox="0 0 16 16"
                width="12"
                height="12"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
              >
                <circle cx="7" cy="7" r="4.2" />
                <path d="M10.2 10.2L14 14" stroke-linecap="round" />
              </svg>
              <input
                type="text"
                data-slot="search-input"
                placeholder={props.searchFiles ? t("sidebar.search.project") : t("sidebar.search.open")}
                title={t("sidebar.search.help")}
                value={searchQuery()}
                onInput={onSearchInput}
                onKeyDown={onSearchKeyDown}
              />
              <Show when={searchQuery()}>
                <button
                  type="button"
                  data-slot="search-clear"
                  aria-label={t("sidebar.search.clear")}
                  onClick={() => setSearchQuery("")}
                >
                  ×
                </button>
              </Show>
            </div>
            {/* Two chips that cannot both be off: turning off the last one
                turns the other on (`toggleKind`). */}
            <div data-slot="search-kinds" role="group" aria-label={t("sidebar.search.show")}>
              <button
                type="button"
                data-slot="search-kind"
                aria-pressed={kinds().has("file")}
                data-active={kinds().has("file") ? "true" : undefined}
                onClick={() => flipKind("file")}
              >
                {t("sidebar.search.files")}
              </button>
              <button
                type="button"
                data-slot="search-kind"
                aria-pressed={kinds().has("directory")}
                data-active={kinds().has("directory") ? "true" : undefined}
                onClick={() => flipKind("directory")}
              >
                {t("sidebar.search.folders")}
              </button>
              <Show when={props.searchFiles && searchQuery().trim() && !searching()}>
                <span data-slot="search-count">
                  {projectHits().length >= 200 ? "200+" : projectHits().length}
                </span>
              </Show>
            </div>
          </div>

          {/* While a project-wide query stands, its results take the tree's
              place: showing both would make the same file appear twice with
              two different meanings. */}
          <Show when={props.searchFiles && searchQuery().trim().length >= 1}>
            <div data-slot="section-content" data-component="file-results" role="listbox">
              <Show
                when={projectHits().length > 0}
                fallback={
                  <p data-slot="section-empty">
                    {searching()
                      ? t("sidebar.search.searching")
                      : kinds().size === 2
                        ? t("sidebar.search.noMatch")
                        : kinds().has("file")
                          ? t("sidebar.search.noFile")
                          : t("sidebar.search.noFolder")}
                  </p>
                }
              >
                <For each={projectHits()}>
                  {(hit, index) => {
                    const nameStart = hit.rel.lastIndexOf("/") + 1
                    const name = hit.rel.slice(nameStart)
                    const folder = hit.rel.slice(0, Math.max(0, nameStart - 1))
                    const isDir = hit.kind === "directory"
                    return (
                      <div
                        role="option"
                        tabindex={-1}
                        data-slot="file-result"
                        data-kind={hit.kind}
                        data-index={index()}
                        data-active={activeHit() === index() ? "true" : undefined}
                        aria-selected={activeHit() === index()}
                        data-selected={props.selectedFilePath === hit.path ? "true" : undefined}
                        title={hit.path}
                        draggable={true}
                        onDragStart={(event) => {
                          if (!event.dataTransfer) return
                          // A folder leaves with its trailing slash, as from the tree.
                          writeDraggedPaths(event.dataTransfer, [isDir ? `${hit.path.replace(/[/\\]+$/, "")}/` : hit.path])
                          event.dataTransfer.effectAllowed = "copy"
                        }}
                        onPointerEnter={() => setActiveHit(index())}
                        onClick={() => pickHit(hit)}
                      >
                        <span data-slot="file-result-icon" aria-hidden="true">
                          <Show
                            when={isDir}
                            fallback={
                              <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.1">
                                <path d="M3 1.5h5.5l3 3V12.5C11.5 13.05 11.05 13.5 10.5 13.5H3C2.45 13.5 2 13.05 2 12.5V2.5C2 1.95 2.45 1.5 3 1.5z" />
                                <path d="M8.5 1.5V4.5H11.5" />
                              </svg>
                            }
                          >
                            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round">
                              <path d="M1.5 3.5C1.5 2.67 2.17 2 3 2h2.5c.4 0 .78.16 1.06.44l1 1c.28.28.66.44 1.06.44H11c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5v-7z" />
                            </svg>
                          </Show>
                        </span>
                        <span data-slot="file-result-name">
                          {highlightMatch(name, rangesWithin(hit.ranges, nameStart, hit.rel.length))}
                        </span>
                        <Show when={folder}>
                          <span data-slot="file-result-path">
                            {/* Isolated LTR inside the RTL box: the box truncates from the
                                left, the path still reads left to right. */}
                            <bdi dir="ltr">{highlightMatch(folder, rangesWithin(hit.ranges, 0, folder.length))}</bdi>
                          </span>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </Show>
            </div>
          </Show>

          <div
            data-slot="section-content"
            data-component="file-tree"
            role="tree"
            data-hidden={props.searchFiles && searchQuery().trim().length >= 1 ? "true" : undefined}
          >
            <Show
              when={keyedFiles().length > 0}
              fallback={
                <p data-slot="section-empty">
                  {/* Two different absences: nothing matched, or there is no
                      disk to read at all. Saying "vuoto" for both is a lie. */}
                  {searchQuery()
                    ? t("sidebar.search.noFile")
                    : t("sidebar.files.noProject")}
                </p>
              }
            >
              <For each={keyedFiles()}>
                {(entry) => (
                  <FileTreeRow
                    item={entry.data()}
                    onToggleDir={toggleDir}
                    onSelectFile={props.onSelectFile}
                  />
                )}
              </For>
            </Show>
          </div>
          </Show>
        </section>

        <Show when={props.sections}>
          <div data-slot="sidebar-section-extra">{props.sections}</div>
        </Show>
      </div>

      {/*
       * The foot of the column: the screenshots, and the way into settings.
       *
       * Outside the scrolling area on purpose. The tray used to be the last
       * card inside it, which meant that with a project open and the file
       * tree scrolled down it was not on screen — and a screenshot you have
       * to go looking for is one you screenshot again. The strip is reserved
       * for it, so it is always in the same place.
       */}
      <div data-slot="sidebar-footer">
        <div data-slot="sidebar-shots">{props.bottom}</div>
        {/*
         * Settings on their own strip under the screenshots, not tucked in
         * beside them.
         *
         * Sharing the row made the gear look like a control *of* the tray —
         * the thing you press to configure screenshots — and it cost the
         * thumbnails 26px of a column that has none to spare. On its own
         * line it is what it is: the way out of the sidebar and into the
         * application's settings.
         */}
        <Show when={props.onOpenSettings ?? props.footerActions}>
          <div data-slot="sidebar-settings-strip">
            {/* Gear, theme and bell as one tight group on the left; what the
                machine is spending fills the rest of the row. */}
            <div data-slot="sidebar-footer-group">
            <Show when={props.onOpenSettings}>
            <button
              type="button"
              data-slot="sidebar-settings"
              onClick={() => props.onOpenSettings?.()}
              aria-label={t("sidebar.settings")}
              title={t("sidebar.settings")}
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span data-slot="sidebar-settings-label">{t("sidebar.settings")}</span>
            </button>
            </Show>
            <Show when={props.footerActions}>
              <div data-slot="sidebar-footer-actions">{props.footerActions}</div>
            </Show>
            </div>
            <Show when={stats()}>
              {(view) => (
                <div data-slot="sidebar-stats" aria-label={t("sidebar.stats")}>
                  {/* Marks instead of words: three labels were most of the
                      row's width. The words stay in the tooltip and in
                      aria-label for whoever does not read the marks. */}
                  <span data-slot="sidebar-stat" data-load={view().cpu.load} title={view().cpu.title} aria-label={view().cpu.title}>
                    <svg data-slot="sidebar-stat-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="4" y="4" width="8" height="8" rx="1.2" />
                      <rect x="6.5" y="6.5" width="3" height="3" rx="0.4" />
                      <path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" />
                    </svg>
                    {view().cpu.text}
                  </span>
                  <span data-slot="sidebar-stat" data-load={view().ram.load} title={view().ram.title} aria-label={view().ram.title}>
                    <svg data-slot="sidebar-stat-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="1.5" y="4.5" width="13" height="6" rx="1" />
                      <path d="M4.5 6.8v1.4M7 6.8v1.4M9.5 6.8v1.4M12 6.8v1.4M3.5 10.5v2M6.5 10.5v2M9.5 10.5v2M12.5 10.5v2" />
                    </svg>
                    {view().ram.text}
                  </span>
                  <span data-slot="sidebar-stat" data-load={view().mem.load} title={view().mem.title} aria-label={view().mem.title}>
                    <svg data-slot="sidebar-stat-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="8" cy="8" r="6" />
                      <path d="M8 2v6h6" />
                    </svg>
                    {view().mem.text}
                  </span>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>

      <div
        data-slot="sidebar-resize-handle"
        onPointerDown={onResizePointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("sidebar.resize")}
      />
    </aside>
  )
}
