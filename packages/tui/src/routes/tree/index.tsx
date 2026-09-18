import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { TextAttributes, type MouseEvent, type Renderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import path from "node:path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useKeybind } from "@tui/context/keybind"
import { useDialog } from "@tui/ui/dialog"
import { usePromptRef } from "@tui/context/prompt"
import { useKeyboardCapture } from "@tui/routes/workspace/shell"
import { SessionTreeColumnHeaders, SessionTreeHeader } from "./header"
import { SessionTreeFooter } from "./footer"
import { sessionTreeActivityDisplay } from "./session-activity-line"
import { DialogTimeline } from "../session/dialog-timeline"
import { flattenTreeRows, listUserMessagePreviews, treeLinePrefix } from "./tree-rows"
import { clampSelectionToWindow, scrollWindowStart, windowStartFor } from "./tree-window"

type SyncContext = ReturnType<typeof useSync>
type SessionInfo = SyncContext["data"]["session"][number]

export function SessionTree() {
  const routeData = useRouteData("tree")
  const route = useRoute()
  const sync = useSync()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dialog = useDialog()
  const promptRef = usePromptRef()
  const dimensions = useTerminalDimensions()
  const timelineKeyHint = createMemo(() => {
    const p = keybind.print("session_timeline")
    return p && p.length > 0 ? `t · ${p}` : "t"
  })
  const [selected, setSelected] = createSignal(0)
  const [open, setOpen] = createSignal<Set<string>>(new Set())
  const [messageTimelineOpen, setMessageTimelineOpen] = createSignal<Set<string>>(new Set())
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [filterText, setFilterText] = createSignal("")

  // While the filter box has the keyboard, the shell must not read `1`-`5`.
  useKeyboardCapture(filterOpen)

  // MCP and LSP counts for footer
  const mcpCount = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lspCount = createMemo(() => Object.keys(sync.data.lsp).length)
  const statusLabelMaxChars = createMemo(() => Math.max(24, Math.min(120, Math.floor(dimensions().width * 0.28))))

  const sessions = createMemo(() => {
    const all = sync.data.session
      .filter((session) => !routeData.workspaceID || session.workspaceID === routeData.workspaceID)
      .toSorted((a, b) => a.time.created - b.time.created)

    // Apply filter if active
    const filter = filterText().toLowerCase().trim()
    if (filter && filter.length > 0) {
      return all.filter(
        (session) => session.title.toLowerCase().includes(filter) || session.id.toLowerCase().includes(filter),
      )
    }
    return all
  })
  const byID = createMemo(() => new Map(sessions().map((session) => [session.id, session])))
  const childrenByParent = createMemo(() => {
    const result = new Map<string, SessionInfo[]>()
    for (const session of sessions()) {
      if (!session.parentID) continue
      const group = result.get(session.parentID) ?? []
      group.push(session)
      result.set(session.parentID, group)
    }
    for (const group of result.values()) group.sort((a, b) => a.time.created - b.time.created)
    return result
  })
  const roots = createMemo(() => sessions().filter((session) => !session.parentID || !byID().has(session.parentID)))
  const currentRoot = createMemo(() => {
    if (!routeData.sessionID) return undefined
    let cursor = byID().get(routeData.sessionID)
    while (cursor?.parentID && byID().has(cursor.parentID)) cursor = byID().get(cursor.parentID)
    return cursor
  })
  const currentSession = createMemo(() => (routeData.sessionID ? byID().get(routeData.sessionID) : undefined))
  const visibleRoots = createMemo(() => {
    const root = currentRoot()
    return root ? [root] : roots()
  })
  const ancestorIDs = createMemo(() => {
    const result: string[] = []
    let cursor = routeData.sessionID ? byID().get(routeData.sessionID) : undefined
    while (cursor) {
      result.push(cursor.id)
      cursor = cursor.parentID ? byID().get(cursor.parentID) : undefined
    }
    return result
  })
  const rows = createMemo(() =>
    flattenTreeRows(visibleRoots(), childrenByParent(), open(), messageTimelineOpen(), sync.data),
  )
  const selectedRow = createMemo(() => rows()[selected()])

  /**
   * Only the rows that fit on screen are mounted. Every row is exactly one
   * terminal line, so the window is plain arithmetic — no height bookkeeping.
   * Without this a tree with a few hundred roots mounts thousands of
   * renderables and every sync event re-reconciles all of them, which is what
   * made the panel lock up on a large project.
   */
  const [viewportRows, setViewportRows] = createSignal(20)
  const [windowStart, setWindowStart] = createSignal(0)
  let listRef: Renderable | undefined

  // Layout sizes are not reactive, so re-measure whenever the chrome around
  // the list can have changed; a timeout puts the read after the next layout.
  createEffect(() => {
    dimensions()
    filterOpen()
    filterText()
    const timer = setTimeout(() => {
      const height = listRef?.height
      if (typeof height !== "number" || height <= 0) return
      setViewportRows(Math.max(1, Math.floor(height)))
    }, 0)
    onCleanup(() => clearTimeout(timer))
  })

  // The selection drives the window: keep it inside, and never scroll past the
  // end when rows disappear (collapse, filter).
  createEffect(() => {
    const height = viewportRows()
    const selectedIndex = selected()
    const count = rows().length
    setWindowStart((previous) => windowStartFor({ previous, selected: selectedIndex, count, height }))
  })

  const visibleRows = createMemo(() => rows().slice(windowStart(), windowStart() + viewportRows()))

  function scrollBy(delta: number) {
    const height = viewportRows()
    const next = scrollWindowStart({ start: windowStart(), delta, count: rows().length, height })
    if (next === windowStart()) return
    setWindowStart(next)
    // Drag the selection along so it stays on a mounted row.
    setSelected((index) => clampSelectionToWindow({ selected: index, start: next, height }))
  }

  const workspaceLabel = createMemo(() => {
    const id = routeData.workspaceID
    if (!id) return undefined
    const w = sync.data.workspaceList.find((x) => x.id === id)
    if (!w) return id
    if (w.branch) return w.branch
    const cfg = w.config
    const dir = "directory" in cfg ? cfg.directory : ""
    try {
      return dir ? path.basename(dir) : w.id
    } catch {
      return w.id
    }
  })

  const currentSessionTitle = createMemo(() => {
    const s = currentSession()
    return s ? displayTitle(s) : undefined
  })

  createEffect(() => {
    const ids = ancestorIDs()
    if (ids.length === 0) return
    setOpen((prev) => new Set([...prev, ...ids]))
  })

  createEffect(() => {
    const sessionID = routeData.sessionID
    if (!sessionID) return
    const list = rows()
    const index = list.findIndex((row) => row.kind === "session" && row.session.id === sessionID)
    if (index >= 0) setSelected(index)
  })

  createEffect(() => {
    if (selected() < rows().length) return
    setSelected(Math.max(0, rows().length - 1))
  })

  function navigateBack() {
    if (routeData.sessionID) {
      route.navigate({
        type: "session",
        sessionID: routeData.sessionID,
        workspaceID: routeData.workspaceID ?? sync.session.get(routeData.sessionID)?.workspaceID,
      })
      return
    }
    route.navigate({ type: "home", workspaceID: routeData.workspaceID })
  }

  function toggle(sessionID: string, force?: boolean) {
    setOpen((prev) => {
      const next = new Set(prev)
      const shouldOpen = force ?? !next.has(sessionID)
      if (shouldOpen) next.add(sessionID)
      else next.delete(sessionID)
      return next
    })
  }

  function selectDelta(delta: number) {
    const list = rows()
    if (list.length === 0) return
    setSelected((index) => (index + delta + list.length) % list.length)
  }

  function openSelected() {
    const row = selectedRow()
    if (!row) return
    if (row.kind === "user_message") {
      route.navigate({
        type: "session",
        sessionID: row.parentSession.id,
        workspaceID: row.parentSession.workspaceID,
      })
      return
    }
    route.navigate({ type: "session", sessionID: row.session.id, workspaceID: row.session.workspaceID })
  }

  function expandAll() {
    setOpen((prev) => {
      const next = new Set(prev)
      for (const session of sessions()) {
        if (childrenByParent().get(session.id)?.length) {
          next.add(session.id)
        }
      }
      return next
    })
    setMessageTimelineOpen((prev) => {
      const next = new Set(prev)
      for (const session of sessions()) {
        if (listUserMessagePreviews(sync.data, session.id).length > 0) {
          next.add(session.id)
        }
      }
      return next
    })
  }

  function collapseAll() {
    setOpen(new Set<string>())
    setMessageTimelineOpen(new Set<string>())
    setSelected(0)
  }

  function toggleMessageTimeline(sessionId: string) {
    setMessageTimelineOpen((p) => {
      const n = new Set(p)
      if (n.has(sessionId)) n.delete(sessionId)
      else n.add(sessionId)
      return n
    })
  }

  function openTimelineForSelected() {
    const row = selectedRow()
    if (!row) return
    const sessionID = row.kind === "session" ? row.session.id : row.parentSession.id
    dialog.replace(() => (
      <DialogTimeline
        sessionID={sessionID}
        onMove={() => {}}
        setPrompt={(p) => {
          const ref = promptRef.current
          if (ref) ref.set(p)
        }}
      />
    ))
  }

  useKeyboard((evt) => {
    if (filterOpen()) {
      if (evt.name === "escape") {
        evt.preventDefault()
        setFilterOpen(false)
        setFilterText("")
        return
      }
      if (evt.name === "return") {
        evt.preventDefault()
        setFilterOpen(false)
        return
      }
      if (evt.name === "backspace") {
        evt.preventDefault()
        setFilterText((t) => t.slice(0, -1))
        return
      }
      if (evt.name === "space" || evt.name === " ") {
        evt.preventDefault()
        setFilterText((t) => `${t} `)
        return
      }
      if (!evt.ctrl && !evt.meta && !evt.super && evt.name && evt.name.length === 1) {
        evt.preventDefault()
        setFilterText((t) => t + evt.name)
        return
      }
      return
    }

    if (evt.name === "escape") {
      evt.preventDefault()
      if (filterText().length > 0) {
        setFilterText("")
        return
      }
      navigateBack()
      return
    }

    if (evt.name === "j" || evt.name === "down") {
      evt.preventDefault()
      selectDelta(1)
      return
    }
    if (evt.name === "k" || evt.name === "up") {
      evt.preventDefault()
      selectDelta(-1)
      return
    }
    if (evt.name === "return" || evt.name === "o") {
      evt.preventDefault()
      openSelected()
      return
    }
    if (evt.name === "l" || evt.name === "right") {
      evt.preventDefault()
      const row = selectedRow()
      if (!row) return
      if (row.kind === "user_message") {
        openSelected()
        return
      }
      if (row.hasUserMessages && !row.messageTimelineOpen) {
        toggleMessageTimeline(row.session.id)
        return
      }
      if (row.hasChildSessions && !row.childSessionsOpen) {
        toggle(row.session.id, true)
        return
      }
      openSelected()
      return
    }
    if (evt.name === "h" || evt.name === "left") {
      evt.preventDefault()
      const row = selectedRow()
      if (!row) return
      if (row.kind === "user_message") {
        const p = rows().findIndex((r) => r.kind === "session" && r.session.id === row.parentSession.id)
        if (p >= 0) setSelected(p)
        return
      }
      if (row.messageTimelineOpen) {
        toggleMessageTimeline(row.session.id)
        return
      }
      if (row.childSessionsOpen) {
        toggle(row.session.id, false)
        return
      }
      const parentID = row.session.parentID
      if (!parentID) return
      const parentIndex = rows().findIndex((r) => r.kind === "session" && r.session.id === parentID)
      if (parentIndex >= 0) setSelected(parentIndex)
      return
    }
    if (evt.name === "m" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      const row = selectedRow()
      if (!row) return
      const id = row.kind === "session" ? row.session.id : row.parentSession.id
      toggleMessageTimeline(id)
      return
    }
    if (evt.name === "/") {
      evt.preventDefault()
      setFilterOpen(true)
      setFilterText("")
      return
    }
    if (evt.name === "f") {
      evt.preventDefault()
      setFilterOpen(true)
      return
    }
    if (evt.name === "a") {
      evt.preventDefault()
      expandAll()
      return
    }
    if (evt.name === "x") {
      evt.preventDefault()
      collapseAll()
      return
    }
    if (evt.name === "g" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      setSelected(0)
      return
    }
    if (evt.name === "G" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      setSelected(Math.max(0, rows().length - 1))
      return
    }
    if (keybind.match("session_timeline", evt)) {
      evt.preventDefault()
      openTimelineForSelected()
      return
    }
    if (evt.name === "t" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      openTimelineForSelected()
      return
    }
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.surface.base}
      flexDirection="column"
    >
      <SessionTreeHeader
        workspaceLabel={workspaceLabel()}
        focusedSessionId={routeData.sessionID}
        rootsCount={visibleRoots().length}
        sessionsCount={sessions().length}
        currentSessionTitle={currentSessionTitle()}
      />

      <box
        backgroundColor={theme.surface.panel}
        border={["bottom"]}
        borderColor={theme.border.subtle}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <SessionTreeColumnHeaders />
      </box>

      {/* Filter Bar */}
      <Show when={filterOpen() || filterText().length > 0}>
        <box
          backgroundColor={theme.surface.overlay ?? theme.surface.offset}
          border={["bottom"]}
          borderColor={theme.border.subtle}
          paddingLeft={0}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="row"
          gap={0}
          alignItems="center"
        >
          <box width={1} minWidth={1} backgroundColor={theme.accent.fg} flexShrink={0} />
          <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} paddingLeft={2} gap={0} alignItems="center">
            <text fg={theme.accent.fg} attributes={TextAttributes.BOLD} wrapMode="none">
              /
            </text>
            <text fg={theme.foreground.default} wrapMode="none" flexGrow={1} flexShrink={1}>
              {filterOpen() ? `${filterText()}▊` : filterText()}
            </text>
          </box>
          <box flexDirection="row" gap={0} flexShrink={0} alignItems="center" paddingLeft={1}>
            <Show when={filterOpen()}>
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                {`return done · `}
              </text>
            </Show>
            <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="none">
              esc
            </text>
            <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
              {filterOpen() ? " clear" : " clear search"}
            </text>
          </box>
        </box>
      </Show>

      {/* Session List */}
      <Show
        when={rows().length > 0}
        fallback={
          <box
            flexGrow={1}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={2}
            paddingBottom={2}
            flexDirection="column"
            gap={1}
            justifyContent="center"
            alignItems="center"
            backgroundColor={theme.surface.base}
          >
            <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="word">
              No sessions
            </text>
            <Show when={filterText().length > 0}>
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="word">
                {`No match for /${filterText()}`}
              </text>
            </Show>
            <Show when={filterText().length > 0}>
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="word">
                esc clears search
              </text>
            </Show>
          </box>
        }
      >
        <box
          ref={(el: Renderable) => (listRef = el)}
          flexDirection="column"
          flexGrow={1}
          minHeight={0}
          paddingLeft={1}
          paddingRight={2}
          paddingTop={0}
          paddingBottom={1}
          onMouseScroll={(event: MouseEvent) => {
            const scroll = event.scroll
            if (!scroll) return
            const magnitude = Math.max(1, scroll.delta || 1)
            if (scroll.direction === "up") scrollBy(-magnitude)
            if (scroll.direction === "down") scrollBy(magnitude)
          }}
        >
          <For each={visibleRows()}>
            {(row, offset) => {
              const index = () => windowStart() + offset()
              const isSelected = () => selected() === index()
              const isCurrent = () => {
                if (row.kind === "user_message") return routeData.sessionID === row.parentSession.id
                return routeData.sessionID === row.session.id
              }
              const rowBg = () => {
                if (isSelected()) return theme.surface.offset
                if (isCurrent()) return theme.surface.overlay ?? theme.surface.offset
                return undefined
              }
              const maxMsg = () => statusLabelMaxChars()
              return (
                <box
                  flexDirection="row"
                  width="100%"
                  justifyContent="space-between"
                  alignItems="stretch"
                  gap={0}
                  backgroundColor={rowBg()}
                  paddingLeft={0}
                  paddingRight={0}
                  paddingTop={0}
                  paddingBottom={0}
                  onMouseDown={() => setSelected(index())}
                >
                  <box
                    width={1}
                    minWidth={1}
                    backgroundColor={isSelected() ? theme.accent.fg : undefined}
                    flexShrink={0}
                  />
                  <box
                    flexDirection="row"
                    flexGrow={1}
                    minWidth={0}
                    justifyContent="space-between"
                    gap={2}
                    paddingLeft={isSelected() ? 1 : 2}
                    paddingRight={1}
                    paddingTop={0}
                    paddingBottom={0}
                  >
                    {row.kind === "session" ? (
                      <box
                        flexDirection="row"
                        flexGrow={1}
                        minWidth={0}
                        width="100%"
                        justifyContent="space-between"
                        gap={2}
                      >
                        <box flexDirection="row" gap={1} flexShrink={1} minWidth={0} alignItems="center">
                          <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                            {treeLinePrefix(row)}
                          </text>
                          <text
                            fg={row.hasChildren ? theme.accent.fg : theme.foreground.muted}
                            attributes={row.hasChildren ? TextAttributes.BOLD : TextAttributes.DIM}
                            wrapMode="none"
                            minWidth={2}
                          >
                            {row.hasChildren ? (row.messageTimelineOpen || row.childSessionsOpen ? "▾" : "▶") : "·"}
                          </text>
                          <text
                            fg={isCurrent() ? theme.accent.fg : theme.foreground.default}
                            attributes={isCurrent() ? TextAttributes.BOLD : undefined}
                            wrapMode="none"
                            flexShrink={1}
                            minWidth={12}
                          >
                            {displayTitle(row.session)}
                          </text>
                        </box>
                        <box
                          flexDirection="row"
                          gap={2}
                          flexShrink={1}
                          minWidth={0}
                          alignItems="center"
                          paddingLeft={1}
                        >
                          <Show when={row.session.summary}>{(summary) => <TreeChangeSummary parts={summary()} />}</Show>
                          <Show when={!row.session.summary}>
                            <text
                              fg={theme.foreground.muted}
                              attributes={TextAttributes.DIM}
                              minWidth={14}
                              wrapMode="none"
                            >
                              —
                            </text>
                          </Show>
                          <box flexGrow={1} minWidth={20} minHeight={0} flexShrink={1} alignItems="center">
                            {(() => {
                              const st = sessionTreeActivityDisplay(
                                sync.data,
                                row.session.id,
                                {
                                  text: theme.foreground.default,
                                  textMuted: theme.foreground.muted,
                                  info: theme.status.info.fg,
                                  warning: theme.status.warning.fg,
                                },
                                { maxMessageChars: maxMsg() },
                              )
                              return (
                                <text fg={st.fg} wrapMode="none" attributes={st.attributes} minWidth={0} flexGrow={1}>
                                  {st.label}
                                </text>
                              )
                            })()}
                          </box>
                          <text
                            fg={theme.foreground.muted}
                            attributes={TextAttributes.DIM}
                            minWidth={10}
                            wrapMode="none"
                          >
                            {formatTime(row.session.time.updated)}
                          </text>
                          <text fg={theme.border.subtle} attributes={TextAttributes.DIM} minWidth={8} wrapMode="none">
                            {shortID(row.session.id)}
                          </text>
                        </box>
                      </box>
                    ) : (
                      <box
                        flexDirection="row"
                        flexGrow={1}
                        minWidth={0}
                        width="100%"
                        justifyContent="space-between"
                        gap={2}
                      >
                        <box flexDirection="row" gap={1} flexShrink={1} minWidth={0} alignItems="center">
                          <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                            {treeLinePrefix(row)}
                          </text>
                          <text fg={theme.status.info.fg} attributes={TextAttributes.DIM} wrapMode="none" minWidth={2}>
                            ↳
                          </text>
                          <text
                            fg={theme.foreground.default}
                            attributes={TextAttributes.DIM}
                            wrapMode="none"
                            flexShrink={1}
                            minWidth={12}
                          >
                            {row.preview.length > maxMsg() ? `${row.preview.slice(0, maxMsg() - 1)}…` : row.preview}
                          </text>
                        </box>
                        <box
                          flexDirection="row"
                          gap={2}
                          flexShrink={1}
                          minWidth={0}
                          alignItems="center"
                          paddingLeft={1}
                        >
                          <text
                            fg={theme.foreground.muted}
                            attributes={TextAttributes.DIM}
                            minWidth={14}
                            wrapMode="none"
                          >
                            —
                          </text>
                          <box flexGrow={1} minWidth={20} minHeight={0} flexShrink={1} alignItems="center">
                            <text
                              fg={theme.foreground.muted}
                              attributes={TextAttributes.DIM}
                              wrapMode="none"
                              minWidth={0}
                              flexGrow={1}
                            >
                              {row.preview.length > maxMsg() ? `${row.preview.slice(0, maxMsg() - 1)}…` : row.preview}
                            </text>
                          </box>
                          <text
                            fg={theme.foreground.muted}
                            attributes={TextAttributes.DIM}
                            minWidth={10}
                            wrapMode="none"
                          >
                            {formatTime(row.time)}
                          </text>
                          <text fg={theme.border.subtle} attributes={TextAttributes.DIM} minWidth={8} wrapMode="none">
                            {shortID(row.messageId)}
                          </text>
                        </box>
                      </box>
                    )}
                  </box>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      <SessionTreeFooter
        selectedIndex={selected()}
        totalRows={rows().length}
        lspCount={lspCount()}
        mcpCount={mcpCount()}
        mcpError={mcpError()}
        filterOpen={filterOpen()}
        filterHasText={filterText().length > 0}
        timelineKeyHint={timelineKeyHint()}
      />
    </box>
  )
}

function TreeChangeSummary(props: { parts: { files: number; additions: number; deletions: number } }) {
  const { theme } = useTheme()
  const s = props.parts
  return (
    <box flexDirection="row" gap={0} minWidth={14} flexShrink={0} alignItems="center">
      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
        {`${s.files}f `}
      </text>
      <text fg={theme.diff.added} wrapMode="none">
        {`+${s.additions}`}
      </text>
      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
        /
      </text>
      <text fg={theme.diff.removed} wrapMode="none">
        {`-${s.deletions}`}
      </text>
    </box>
  )
}

function displayTitle(session: SessionInfo) {
  const title = session.title.trim()
  if (!title || title.startsWith("New session - ") || title.startsWith("Child session - ")) return "Untitled session"
  return title.length > 72 ? `${title.slice(0, 69)}...` : title
}

function shortID(id: string) {
  return id.slice(-8)
}

function formatTime(time: number) {
  const date = new Date(time)
  const now = Date.now()
  const diff = Math.max(0, now - time)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return "now"
  if (diff < hour) return `${Math.floor(diff / minute)}m`
  if (diff < day) return `${Math.floor(diff / hour)}h`
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
