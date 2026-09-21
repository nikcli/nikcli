import { liveMarkdown, splitLiveMarkdown, wrapDiagramsInFences } from "../diagram"
import { use } from "../session-context"
import { TuiImageList } from "@tui/component/tui-image"
import { useTheme } from "@tui/context/theme"
import { MessageMarkdown } from "@tui/feature-plugins/math/markdown"
import { Show, createMemo } from "solid-js"
import type { ViewEntry } from "../view"

/**
 * A text part.
 *
 * While the text is still arriving this renders what opencode's `TextPart`
 * renders and nothing more: one `<markdown>`, without a trailing trim. The
 * extra passes below — fencing ASCII diagrams, pulling image URLs out of the
 * prose — each walk the *whole* message, so on a live part they cost O(n) per
 * token and O(n²) over the message. They also cannot be right yet: a
 * half-written line holds one box character and reads as prose, then reads as
 * a diagram a character later, and the block it belongs to is rebuilt each
 * time it changes its mind.
 *
 * So they wait for the text to settle. The message is scanned once, when it is
 * finished, instead of once per token while it is being read.
 */
/**
 * Streams. The style is its own memo, so it recomputes when the theme changes
 * and never inside the per-delta memos below — a merge in that path is the
 * per-token cost this file has paid for before.
 */
export function TextPart(props: { last: boolean; streaming: boolean; entry: ViewEntry; sessionID: string }) {
  const ctx = use()
  const { theme, syntax, component } = useTheme()
  const style = () => component("session.text-part")
  const imagePreviewColumns = createMemo(() => Math.max(24, Math.min(180, ctx.width - 8)))
  const imagePreviewRows = createMemo(() => Math.max(4, Math.floor(ctx.height / 3)))
  const tight = createMemo(() => ctx.width < 84)
  const text = createMemo(() => liveMarkdown(String(props.entry.text ?? ""), props.streaming))
  const rendered = createMemo(() => (props.streaming ? text() : wrapDiagramsInFences(text())))
  const split = createMemo(() => (props.streaming ? splitLiveMarkdown(rendered()) : { settled: rendered(), live: "" }))
  const tableOptions = createMemo(() => ({
    widthMode: "full" as const,
    wrapMode: "word" as const,
    cellPadding: tight() ? 0 : 1,
    borders: true,
    outerBorder: !tight(),
    borderColor: theme.border.subtle,
  }))

  return (
    <Show when={text()}>
      <box
        id={"text-" + props.entry.id}
        paddingLeft={style().box.paddingLeft}
        marginTop={style().box.marginTop}
        flexShrink={0}
      >
        {/* Finished blocks render as settled markdown so they are never
            re-lexed and never re-highlighted; only the block still being
            written streams. See `splitLiveMarkdown`. */}
        <Show when={split().settled}>
          <MessageMarkdown
            streaming={false}
            syntaxStyle={syntax()}
            content={split().settled}
            conceal={ctx.conceal()}
            concealCode={false}
            fg={style().colors.text}
            tableOptions={tableOptions()}
          />
        </Show>
        <Show when={split().live}>
          <box marginTop={split().settled ? 1 : 0} flexShrink={0}>
            <MessageMarkdown
              streaming={props.streaming}
              syntaxStyle={syntax()}
              content={split().live}
              conceal={ctx.conceal()}
              concealCode={false}
              fg={style().colors.text}
              tableOptions={tableOptions()}
            />
          </box>
        </Show>
        <Show when={!props.streaming}>
          <TuiImageList text={text()} maxColumns={imagePreviewColumns()} maxRows={imagePreviewRows()} />
        </Show>
      </box>
    </Show>
  )
}
