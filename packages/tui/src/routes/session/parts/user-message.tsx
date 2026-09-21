import type { StyleOf } from "@tui/context/component-tokens"
import { use } from "../session-context"
import { Locale } from "@nikcli-ai/util/locale"
import { borderCharsFor } from "@tui/component/border"
import { TuiImageList } from "@tui/component/tui-image"
import { useLocal } from "@tui/context/local"
import { selectedForeground, useTheme } from "@tui/context/theme"
import { For, Show, createMemo, createSignal } from "solid-js"
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
  const [hover, setHover] = createSignal(false)
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
          border={style().box.borderSides}
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
            <Show when={text()}>{(value) => <text fg={style().colors.text}>{value()}</text>}</Show>
            <TuiImageList
              text={text() ?? ""}
              urls={imagePreviewUrls()}
              maxColumns={imagePreviewColumns()}
              maxRows={imagePreviewRows()}
            />
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return theme.accent.alt
                      if (file.mime === "application/pdf") return theme.accent.fg
                      return theme.accent.secondary
                    })
                    return (
                      <text fg={theme.foreground.default}>
                        <span style={{ bg: bg(), fg: theme.surface.base }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span
                          style={{
                            bg: theme.surface.offset,
                            fg: theme.foreground.muted,
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
                  <text fg={theme.foreground.muted}>
                    <span style={{ fg: theme.foreground.muted }}>
                      {Locale.todayTimeOrDateTime(props.turn.createdAt)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.foreground.muted}>
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
          borderColor={theme.border.active}
        />
      </Show>
    </>
  )
}
