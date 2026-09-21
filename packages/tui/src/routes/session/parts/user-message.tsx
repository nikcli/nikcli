import { bodyColumns, type StyleOf } from "@tui/context/component-tokens"
import { use } from "../session-context"
import { Locale } from "@nikcli-ai/util/locale"
import { borderCharsFor } from "@tui/component/border"
import { DISCLOSURE, hiddenRows, summaryLine, worthCollapsing } from "@tui/component/disclosure"
import { TuiImageList } from "@tui/component/tui-image"
import { useLocal } from "@tui/context/local"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { Turn } from "../view"

export type FileAttachment = {
  readonly mime: string
  readonly filename?: string
  readonly url?: string
  readonly source?: { readonly type?: string; readonly path?: string }
}

export const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

export function UserMessage(props: {
  turn: Turn
  onMouseUp: () => void
  index: number
  pending?: string
  style: StyleOf<"session.user-message">
}) {
  const ctx = use()
  const local = useLocal()
  /** A user turn is exactly one entry: its text plus what it carried. */
  const entry = createMemo(() => props.turn.body[0])
  const text = createMemo(() => {
    const value = entry()?.text
    return typeof value === "string" && value.length > 0 ? value : undefined
  })
  const files = createMemo(() => (entry()?.files ?? []) as FileAttachment[])
  const { theme } = useTheme()
  // A plain accessor: `props.style` is already a tracked getter from the
  // parent's memo, so wrapping it bought nothing and cost a reactive node on
  // every message in the transcript.
  const style = () => props.style
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  /**
   * A body long enough that showing it whole costs more than it gives.
   *
   * The case that forced this: a background job finishing queues a wake message
   * whose text is the job's entire result — thirty rows of machine output
   * landing in the transcript as if the reader had typed it. The rule is not
   * about that message, though; it is about any body of that height, a pasted
   * file included.
   */
  /** The same figure the height estimator uses, from the same function. */
  const columns = createMemo(() => bodyColumns(style().box, ctx.width))
  const collapsible = createMemo(() => worthCollapsing(text() ?? "", columns()))
  const collapsed = createMemo(() => collapsible() && !expanded())
  const hidden = createMemo(() => hiddenRows(text() ?? "", columns()))
  const queued = createMemo(() => props.pending && props.turn.messageID > props.pending)
  const color = createMemo(() => local.agent.color(props.turn.request?.agent ?? ""))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())
  const imagePreviewColumns = createMemo(() => Math.max(24, Math.min(180, ctx.width - 8)))
  const imagePreviewRows = createMemo(() => Math.max(4, Math.floor(ctx.height / 3)))
  const imagePreviewUrls = createMemo(() =>
    files()
      .filter((file) => file.mime.startsWith("image/") && file.mime !== "image/svg+xml")
      .flatMap((file) =>
        file.url ? [file.url] : file.source?.type === "file" && file.source.path ? [file.source.path] : [],
      ),
  )

  return (
    <>
      <Show when={text() || files().length > 0}>
        <box
          id={props.turn.messageID}
          border={[...style().box.borderSides]}
          borderColor={color()}
          customBorderChars={borderCharsFor(style().box.borderCharset)}
          // The first turn keeps its margin collapsed whatever the theme says:
          // a gap above the very first message is a gap against the top of the
          // transcript, not between two messages.
          marginTop={props.index === 0 ? 0 : style().box.marginTop}
          marginBottom={style().box.marginBottom}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={style().box.paddingTop}
            paddingBottom={style().box.paddingBottom}
            paddingLeft={style().box.paddingLeft}
            paddingRight={style().box.paddingRight}
            backgroundColor={hover() ? style().colors.backgroundHover : style().colors.background}
            flexShrink={0}
          >
            <Show when={text()}>
              {(value) => (
                <Show
                  when={collapsed()}
                  fallback={
                    <>
                      <text fg={style().colors.text}>{value()}</text>
                      <Show when={collapsible()}>
                        {/* The handler sits on the mark, never on the body: a
                            click inside the text is a selection, and stealing it
                            to fold the message away would make the transcript
                            unreadable exactly when someone is trying to read
                            it. */}
                        <text
                          fg={style().colors.detail}
                          onMouseUp={(event) => {
                            if (renderer.getSelection()?.getSelectedText()) return
                            event.stopPropagation()
                            setExpanded(false)
                          }}
                        >
                          {DISCLOSURE.open} collapse
                        </text>
                      </Show>
                    </>
                  }
                >
                  {/* Clipped, not wrapped: a summary line longer than the
                      message is wide would otherwise make the collapsed form
                      taller than the thing it is standing in for. */}
                  <box overflow="hidden" flexShrink={0}>
                    <text
                      fg={style().colors.text}
                      wrapMode="none"
                      onMouseUp={(event) => {
                        // Releasing here after a drag is a selection ending on
                        // the summary line, not a request to unfold it.
                        if (renderer.getSelection()?.getSelectedText()) return
                        event.stopPropagation()
                        setExpanded(true)
                      }}
                    >
                      {summaryLine(value())}
                      <span style={{ fg: style().colors.detail }}>
                        {" "}
                        {DISCLOSURE.closed} {hidden()} more rows
                      </span>
                    </text>
                  </box>
                </Show>
              )}
            </Show>
            <Show when={!collapsed()}>
              <TuiImageList
                text={text() ?? ""}
                urls={imagePreviewUrls()}
                maxColumns={imagePreviewColumns()}
                maxRows={imagePreviewRows()}
              />
            </Show>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return style().colors.attachmentImage
                      if (file.mime === "application/pdf") return style().colors.attachmentDocument
                      return style().colors.attachmentOther
                    })
                    return (
                      <text fg={style().colors.text}>
                        <span style={{ bg: bg(), fg: style().colors.attachmentText }}>
                          {" "}
                          {MIME_BADGE[file.mime] ?? file.mime}{" "}
                        </span>
                        <span
                          style={{
                            bg: style().colors.attachmentLabel,
                            fg: style().colors.detail,
                          }}
                        >
                          {" "}
                          {file.filename}{" "}
                        </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={style().colors.detail}>
                    <span style={{ fg: style().colors.detail }}>
                      {Locale.todayTimeOrDateTime(props.turn.createdAt)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={style().colors.detail}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={props.turn.compacted}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={style().colors.compaction}
        />
      </Show>
    </>
  )
}
