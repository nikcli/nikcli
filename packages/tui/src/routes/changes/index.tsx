import { useScrollAcceleration } from "@tui/util/scroll"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { DiffRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { formatPatch, structuredPatch } from "diff"
import path from "node:path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"
import { useTheme } from "@tui/context/theme"
import { useKV } from "@tui/context/kv"
import { useToast } from "@tui/ui/toast"
import { useDialog } from "@tui/ui/dialog"
import { useKeyboardCapture } from "@tui/routes/workspace/shell"
import { Identifier } from "@nikcli-ai/util/id"
import { LANGUAGE_EXTENSIONS } from "@nikcli-ai/util/language"
import { FileList, order } from "./file-list"
import { FileTree } from "./file-tree"
import { ChangesHelp } from "./help"
import {
  CommentDisplay,
  CommentInput,
  lineLabel,
  makeKey,
  type Comment,
  type CommentType,
  type DiffRow,
  type LineType,
} from "./comment-box"
import { Footer } from "./footer"
import { ChangesHeader } from "./header"
import { formatCommentsForAI, hasAnyComments, type CommentsByFile } from "./format-comments"

const SIDE_BAR_WIDTH = 40

function reviewFeedbackErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const o = error as Record<string, unknown>
    if (typeof o.message === "string" && o.message) return o.message
    if (typeof o.error === "string" && o.error) return o.error
    if (o.error && typeof o.error === "object" && o.error !== null && "message" in o.error) {
      const m = (o.error as { message: unknown }).message
      if (typeof m === "string") return m
    }
  }
  try {
    if (error && typeof error === "object") {
      return JSON.stringify(error)
    }
  } catch {
    // ignore
  }
  return "Failed to send feedback"
}

export function Changes() {
  const routeData = useRouteData("changes")
  const route = useRoute()
  const scrollAcceleration = useScrollAcceleration()
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const toast = useToast()
  const themeState = useTheme()
  const kv = useKV()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  const [diffRef, setDiffRef] = createSignal<DiffRenderable>()
  const [commentsByFile, setCommentsByFile] = createSignal<CommentsByFile>(new Map())
  const dialog = useDialog()
  const [wrap, setWrap] = kv.signal<"word" | "none">("changes_diff_wrap_mode", "word")
  const [viewMode, setViewMode] = kv.signal<"unified" | "split">("changes_diff_view_mode", "unified")
  const [treeMode, setTreeMode] = kv.signal<"tree" | "flat">("changes_files_mode", "tree")
  const [reviewed, setReviewed] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [filterText, setFilterText] = createSignal("")
  const [filterActive, setFilterActive] = createSignal(false)

  // While the filter box has the keyboard, the shell must not read `1`-`5`.
  useKeyboardCapture(filterActive)
  const [reviewPanelOpen, setReviewPanelOpen] = createSignal(true)
  const [store, setStore] = createStore({
    pane: "list" as "list" | "diff",
    selectedFile: 0,
    selectedLine: 0,
    focusedComment: null as string | null,
  })

  const files = createMemo(() => sync.data.session_diff[routeData.sessionID] ?? [])
  const ordered = createMemo(() => order(files()))
  const selectedFile = createMemo(() => ordered()[store.selectedFile])
  const currentFileKey = createMemo(() => selectedFile()?.file ?? "__none__")
  const currentComments = createMemo(() => commentsByFile().get(currentFileKey()) ?? new Map())
  const commentItems = createMemo(() => Array.from(currentComments().entries()).sort(([, a], [, b]) => a.line - b.line))
  const commentCounts = createMemo(() => {
    const result = new Map<string, number>()
    for (const [file, comments] of commentsByFile()) result.set(file, comments.size)
    return result
  })
  const hasComments = createMemo(() => hasAnyComments(commentsByFile()))
  const reviewPanelVisible = createMemo(() => reviewPanelOpen() && commentItems().length > 0)
  const reviewInline = createMemo(() => dimensions().width >= 112)
  const reviewWidth = createMemo(() => Math.min(46, Math.max(34, Math.floor(dimensions().width * 0.3))))
  const contentWidth = createMemo(() => dimensions().width - (store.pane === "list" ? SIDE_BAR_WIDTH + 1 : 0))

  const filetype = createMemo(() => {
    const file = selectedFile()
    if (!file) return "none"
    const language = LANGUAGE_EXTENSIONS[path.extname(file.file)]
    if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
    return language ?? "none"
  })

  const fullDiff = createMemo(() => {
    const file = selectedFile()
    if (!file) return ""
    return formatPatch(structuredPatch(file.file, file.file, file.before, file.after, "old", "new", { context: 3 }))
  })
  const diffRows = createMemo(() => parseDiffRows(fullDiff()))
  const selectedRow = createMemo(() => diffRows()[store.selectedLine])

  const view = createMemo(() => {
    if (viewMode() === "split" && dimensions().width >= 112) return "split"
    return "unified"
  })

  const stats = createMemo(() => {
    const totalFiles = files().length
    let totalAdditions = 0
    let totalDeletions = 0
    for (const file of files()) {
      totalAdditions += file.additions ?? 0
      totalDeletions += file.deletions ?? 0
    }
    let totalComments = 0
    for (const comments of commentsByFile().values()) {
      totalComments += comments.size
    }
    return { totalFiles, totalAdditions, totalDeletions, totalComments }
  })

  const sessionMeta = createMemo(() => sync.data.session.find((s) => s.id === routeData.sessionID))
  const sessionTitleDisplay = createMemo(() => sessionMeta()?.title?.trim() ?? "")
  const sessionDirectoryLabel = createMemo(() => {
    const dir = sessionMeta()?.directory
    if (!dir) {
      const d = sync.data.path.directory
      return d ? path.basename(d) || d : undefined
    }
    try {
      return path.basename(dir) || dir
    } catch {
      return dir
    }
  })

  function backToSession() {
    route.navigate({
      type: "session",
      sessionID: routeData.sessionID,
      workspaceID: routeData.workspaceID ?? sync.session.get(routeData.sessionID)?.workspaceID,
    })
  }

  function selectLine(index: number) {
    const rows = diffRows()
    if (rows.length === 0) return
    const next = (index + rows.length) % rows.length
    setStore("selectedLine", next)
    const row = rows[next]
    scroll()?.scrollTo(Math.max(0, row.visualLine - 2))
  }

  function rowFromComment(comment: Comment): DiffRow {
    return (
      diffRows().find((row) => row.anchor === comment.anchor) ?? {
        visualLine: comment.line,
        lineType: comment.lineType,
        anchor: comment.anchor,
        label: comment.label,
        text: "",
      }
    )
  }

  function closeCommentDialog() {
    dialog.clear()
  }

  function applyLineComment(text: string, type: CommentType, row: DiffRow, editingKey: string | undefined) {
    const key = editingKey ?? makeKey(row.anchor)
    const comment: Comment = {
      id: currentComments().get(key)?.id ?? `${key}-${Date.now()}`,
      line: row.visualLine,
      anchor: row.anchor,
      lineType: row.lineType,
      label: lineLabel(row),
      text,
      type,
    }
    setCommentsByFile((prev) => {
      const next = new Map(prev)
      const fileComments = new Map(next.get(currentFileKey()) ?? new Map())
      fileComments.set(key, comment)
      next.set(currentFileKey(), fileComments)
      return next
    })
    setStore("focusedComment", key)
    setReviewPanelOpen(true)
  }

  function openCommentDialogForRow(
    row: DiffRow,
    editingKey: string | undefined,
    initial?: { text: string; type: CommentType },
  ) {
    renderer.currentFocusedRenderable?.blur()
    dialog.replace(
      () => (
        <CommentInput
          row={row}
          initialValue={initial?.text}
          initialType={initial?.type}
          onSubmit={(t, ty) => {
            applyLineComment(t, ty, row, editingKey)
            closeCommentDialog()
          }}
          onCancel={closeCommentDialog}
        />
      ),
      () => {},
    )
    dialog.setSize("large")
    setStore("focusedComment", null)
  }

  function openComment(row = selectedRow()) {
    if (!row) return
    renderer.currentFocusedRenderable?.blur()
    const key = makeKey(row.anchor)
    if (currentComments().has(key)) {
      setStore("focusedComment", key)
      return
    }
    openCommentDialogForRow(row, undefined)
  }

  function editComment(key: string) {
    const comment = currentComments().get(key)
    if (!comment) return
    const row = rowFromComment(comment)
    openCommentDialogForRow(row, key, { text: comment.text, type: comment.type })
  }

  function deleteComment(key: string) {
    setCommentsByFile((prev) => {
      const next = new Map(prev)
      const fileComments = new Map(next.get(currentFileKey()) ?? new Map())
      fileComments.delete(key)
      if (fileComments.size === 0) next.delete(currentFileKey())
      else next.set(currentFileKey(), fileComments)
      return next
    })
    setStore("focusedComment", null)
  }

  function submitFeedback() {
    if (!hasComments()) return
    const selectedModel = local.model.current()
    if (!selectedModel) {
      toast.show({ variant: "warning", message: "Select a model before submitting review feedback" })
      return
    }

    const feedback = formatCommentsForAI(commentsByFile()).trim()
    if (!feedback) {
      toast.show({ variant: "warning", message: "No review text to send" })
      return
    }
    const agentName = local.agent.current()?.name
    const sessionInfo = sync.session.get(routeData.sessionID)
    const directory = sessionInfo?.directory
    // prompt_async returns immediately; sync /session/{id}/message can hang until the full model loop finishes (timeouts).
    sdk.client.session
      .promptAsync(
        {
          sessionID: routeData.sessionID,
          ...selectedModel,
          messageID: Identifier.ascending("message"),
          ...(agentName ? { agent: agentName } : {}),
          model: selectedModel,
          variant: local.model.variant.current(),
          ...(directory ? { directory } : {}),
          ...(routeData.workspaceID ? { workspace: routeData.workspaceID } : {}),
          parts: [
            {
              id: Identifier.ascending("part"),
              type: "text",
              text: feedback,
            },
          ],
        },
        { throwOnError: true },
      )
      .then(() => {
        setCommentsByFile(new Map())
        toast.show({ variant: "success", message: "Review feedback sent" })
        backToSession()
      })
      .catch((error) => {
        toast.show({ variant: "error", message: reviewFeedbackErrorMessage(error) })
      })
  }

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (store.pane === "diff" && evt.name === "s" && (evt.ctrl || evt.super)) {
      evt.preventDefault()
      submitFeedback()
      return
    }
    if (
      (evt.ctrl || evt.meta || evt.super) &&
      (evt.name === "return" || evt.name === "enter") &&
      store.pane === "diff"
    ) {
      evt.preventDefault()
      submitFeedback()
      return
    }

    if (evt.name === "escape") {
      evt.preventDefault()
      if (store.pane === "list" && filterText().length > 0) {
        setFilterActive(false)
        setFilterText("")
        return
      }
      backToSession()
      return
    }

    if (evt.name === "left") {
      evt.preventDefault()
      if (dialog.stack.length) dialog.clear()
      setStore("pane", "list")
      return
    }
    if (evt.name === "right") {
      evt.preventDefault()
      if (dialog.stack.length) dialog.clear()
      setStore("pane", "diff")
      return
    }

    if (evt.name === "/") {
      evt.preventDefault()
      setFilterActive(true)
      setFilterText("")
      return
    }

    if (store.pane === "list") {
      if (filterActive()) return
    }

    if (store.pane !== "diff") return

    if (evt.name === "j" || evt.name === "down") {
      evt.preventDefault()
      selectLine(store.selectedLine + 1)
      return
    }
    if (evt.name === "k" || evt.name === "up") {
      evt.preventDefault()
      selectLine(store.selectedLine - 1)
      return
    }
    if (evt.name === "c" || evt.name === "return") {
      evt.preventDefault()
      openComment()
      return
    }
    if (evt.name === "w") {
      evt.preventDefault()
      setWrap((prev) => (prev === "word" ? "none" : "word"))
      return
    }
    if (evt.name === "s") {
      evt.preventDefault()
      setViewMode((prev) => (prev === "unified" ? "split" : "unified"))
      return
    }
    if (evt.name === "r") {
      evt.preventDefault()
      setReviewPanelOpen((open) => !open)
      return
    }
    if (evt.name === "b" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      setTreeMode((prev) => (prev === "tree" ? "flat" : "tree"))
      return
    }
    if (evt.name === "m" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      const file = selectedFile()
      if (!file) return
      setReviewed((prev) => {
        const next = new Set(prev)
        if (next.has(file.file)) next.delete(file.file)
        else next.add(file.file)
        return next
      })
      return
    }
    if (evt.name === "]" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      const total = ordered().length
      if (total === 0) return
      setStore("selectedFile", (store.selectedFile + 1) % total)
      return
    }
    if (evt.name === "[" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      const total = ordered().length
      if (total === 0) return
      setStore("selectedFile", (store.selectedFile - 1 + total) % total)
      return
    }
    if (evt.name === "?" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      dialog.replace(() => <ChangesHelp />)
      return
    }
    if (evt.name === "g" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      selectLine(0)
      return
    }
    if (evt.name === "G" && !evt.ctrl && !evt.meta && !evt.super) {
      evt.preventDefault()
      selectLine(Math.max(0, diffRows().length - 1))
      return
    }
    if (evt.name === "n" || evt.name === "N") {
      evt.preventDefault()
      const direction = evt.name === "n" ? 1 : -1
      const allComments: { fileKey: string; key: string; comment: Comment; row: DiffRow }[] = []
      for (const [fileKey, comments] of commentsByFile().entries()) {
        for (const [key, comment] of comments.entries()) {
          const row = rowFromComment(comment)
          allComments.push({ fileKey, key, comment, row })
        }
      }
      if (allComments.length === 0) return
      allComments.sort((a, b) => a.comment.line - b.comment.line)
      const currentIndex = allComments.findIndex(
        (c) => c.key === store.focusedComment && c.fileKey === currentFileKey(),
      )
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + allComments.length) % allComments.length
      const next = allComments[nextIndex]
      const fileIndex = ordered().findIndex((f) => f.file === next.fileKey)
      if (fileIndex !== -1) setStore("selectedFile", fileIndex)
      setStore("focusedComment", next.key)
      scroll()?.scrollTo(Math.max(0, next.row.visualLine - 2))
      return
    }
  })

  onMount(() => {
    renderer.currentFocusedRenderable?.blur()
    if (routeData.sessionID) {
      void sync.session.refreshDiff(routeData.sessionID)
    }
  })

  createEffect(
    on(
      () => routeData.sessionID,
      (sessionID) => {
        if (sessionID) void sync.session.refreshDiff(sessionID)
      },
      { defer: true },
    ),
  )

  // Only react to the selected file, not to dialog.stack — otherwise opening the comment
  // dialog updates the stack, retriggers this effect, and dialog.clear() closes it immediately.
  createEffect(
    on(currentFileKey, () => {
      if (dialog.stack.length) dialog.clear()
      setStore("selectedLine", 0)
      setStore("focusedComment", null)
      scroll()?.scrollTo(0)
    }),
  )

  createEffect(() => {
    if (store.selectedLine < diffRows().length) return
    setStore("selectedLine", Math.max(0, diffRows().length - 1))
  })

  createEffect(() => {
    const diff = diffRef()
    if (!diff) return
    diff.clearAllLineColors()
    const row = selectedRow()
    if (!row) return
    diff.setLineColor(row.visualLine, {
      gutter: themeState.theme.accent.fg,
      content: themeState.theme.surface.offset,
    })
  })

  onCleanup(() => diffRef()?.clearAllLineColors())

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={themeState.theme.surface.base} gap={0}>
      <ChangesHeader
        sessionTitle={sessionTitleDisplay()}
        sessionId={routeData.sessionID}
        directory={sessionDirectoryLabel()}
        pane={store.pane}
        totalFiles={stats().totalFiles}
        totalAdditions={stats().totalAdditions}
        totalDeletions={stats().totalDeletions}
        currentFile={store.pane === "diff" ? selectedFile()?.file : undefined}
        lineHint={store.pane === "diff" && selectedRow() ? lineLabel(selectedRow()!) : undefined}
      />
      <box flexGrow={1} flexDirection="row">
        <Show when={store.pane === "list"}>
          <Show
            when={treeMode() === "tree"}
            fallback={
              <FileList
                files={ordered()}
                selected={store.selectedFile}
                comments={commentCounts()}
                onSelect={(index) => setStore("selectedFile", index)}
                onSwitch={() => setStore("pane", "diff")}
                width={SIDE_BAR_WIDTH}
                focused={store.pane === "list"}
                filterText={filterText()}
                filterActive={filterActive()}
                onFilterChange={(text) => setFilterText(text)}
                onFilterDeactivate={() => setFilterActive(false)}
              />
            }
          >
            <FileTree
              files={ordered()}
              selected={store.selectedFile}
              comments={commentCounts()}
              onSelect={(index) => setStore("selectedFile", index)}
              onSwitch={() => setStore("pane", "diff")}
              width={SIDE_BAR_WIDTH}
              focused={store.pane === "list"}
              filterText={filterText()}
              filterActive={filterActive()}
              onFilterChange={(text) => setFilterText(text)}
              onFilterDeactivate={() => setFilterActive(false)}
              reviewed={reviewed()}
            />
          </Show>
        </Show>

        <Show
          when={ordered().length > 0}
          fallback={
            <box width={contentWidth()} height="100%" paddingLeft={2} paddingTop={2}>
              <text fg={themeState.theme.foreground.muted}>No changes to display</text>
            </box>
          }
        >
          <box flexGrow={1} flexDirection={reviewInline() ? "row" : "column"}>
            <scrollbox
              scrollAcceleration={scrollAcceleration()}
              ref={setScroll}
              flexGrow={1}
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              backgroundColor={themeState.theme.diff.contextBg}
              scrollbarOptions={{ visible: false }}
            >
              <diff
                ref={(value: DiffRenderable) => setDiffRef(value)}
                diff={fullDiff()}
                view={view()}
                filetype={filetype()}
                syntaxStyle={themeState.syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode={wrap()}
                fg={themeState.theme.foreground.default}
                addedBg={themeState.theme.diff.addedBg}
                removedBg={themeState.theme.diff.removedBg}
                contextBg={themeState.theme.diff.contextBg}
                addedSignColor={themeState.theme.diff.highlightAdded}
                removedSignColor={themeState.theme.diff.highlightRemoved}
                lineNumberFg={themeState.theme.diff.lineNumber}
                lineNumberBg={themeState.theme.diff.contextBg}
                addedLineNumberBg={themeState.theme.diff.addedLineNumberBg}
                removedLineNumberBg={themeState.theme.diff.removedLineNumberBg}
              />
            </scrollbox>

            <Show when={reviewPanelVisible()}>
              <box
                width={reviewInline() ? reviewWidth() : "100%"}
                height={reviewInline() ? "100%" : 14}
                border={[reviewInline() ? "left" : "top"]}
                borderColor={themeState.theme.border.subtle}
              >
                <scrollbox
                  scrollAcceleration={scrollAcceleration()}
                  flexGrow={1}
                  paddingLeft={1}
                  paddingRight={1}
                  paddingTop={1}
                  scrollbarOptions={{ visible: false }}
                >
                  <Show when={commentItems().length > 0}>
                    <box gap={1} paddingTop={0}>
                      <text fg={themeState.theme.foreground.default}>
                        <b>Review Comments</b> {`(${commentItems().length})`}
                      </text>
                      <For each={commentItems()}>
                        {([key, comment]) => (
                          <CommentDisplay
                            comment={comment}
                            focused={store.focusedComment === key}
                            onFocus={() => setStore("focusedComment", key)}
                            onEdit={() => editComment(key)}
                            onDelete={() => deleteComment(key)}
                          />
                        )}
                      </For>
                    </box>
                  </Show>
                </scrollbox>
              </box>
            </Show>
          </box>
        </Show>
      </box>
      <Footer
        mode={store.pane}
        hasComments={hasComments()}
        inputOpen={dialog.stack.length > 0}
        totalFiles={stats().totalFiles}
        totalAdditions={stats().totalAdditions}
        totalDeletions={stats().totalDeletions}
        totalComments={stats().totalComments}
        viewMode={viewMode()}
        filterActive={filterActive()}
        filterHasText={filterText().length > 0}
        reviewPanelOpen={reviewPanelOpen()}
        reviewSubmitKeys={process.platform === "darwin" ? "cmd+s" : "ctrl+s"}
      />
    </box>
  )
}

function parseDiffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  const lines = diff.split("\n")
  let oldLine: number | undefined
  let newLine: number | undefined

  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10)
      newLine = Number.parseInt(hunk[2], 10)
      continue
    }
    if (oldLine === undefined || newLine === undefined) continue
    if (!text || text.startsWith("\\ No newline")) continue

    if (text.startsWith("+") && !text.startsWith("+++")) {
      rows.push(createRow(index, "add", undefined, newLine, text.slice(1)))
      newLine++
      continue
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      rows.push(createRow(index, "remove", oldLine, undefined, text.slice(1)))
      oldLine++
      continue
    }
    if (text.startsWith(" ")) {
      rows.push(createRow(index, "context", oldLine, newLine, text.slice(1)))
      oldLine++
      newLine++
    }
  }

  return rows
}

function createRow(
  visualLine: number,
  lineType: LineType,
  oldLine: number | undefined,
  newLine: number | undefined,
  text: string,
): DiffRow {
  const anchor = lineType === "remove" && oldLine !== undefined ? `old:${oldLine}` : `new:${newLine ?? visualLine + 1}`
  const label =
    lineType === "remove" && oldLine !== undefined ? `old line ${oldLine}` : `new line ${newLine ?? visualLine + 1}`
  return {
    visualLine,
    oldLine,
    newLine,
    lineType,
    anchor,
    label,
    text,
  }
}
