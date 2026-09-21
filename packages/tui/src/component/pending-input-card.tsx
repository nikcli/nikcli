import { createMemo, For, Show } from "solid-js"
import type { RGBA } from "@opentui/core"
import { borderCharsFor } from "@tui/component/border"
import { selectedForeground, useTheme } from "@tui/context/theme"

/**
 * The card shown for input that is admitted but not yet sent.
 *
 * Split out of the session route so it can be rendered from fixtures. Everything it needs arrives as
 * props — in particular the agent colour, which the route resolves through `useLocal()`; keeping that
 * lookup on the caller is what lets a story draw this without an SDK, a server, or a busy session.
 *
 * The distinction it draws is the one users get wrong: **queued** input waits for the next safe step,
 * **steering** interrupts and sends now. Both live in `session_pending` until promotion — see
 * `specs/v2/durable-pending-input.md`.
 */
export type PendingInputFile = {
  readonly filename?: string
  readonly mime: string
}

export function PendingInputCard(props: {
  id: string
  /** Agent colour; the session route reads it from `useLocal().agent.color(...)`. */
  color: RGBA
  text: string
  files: ReadonlyArray<PendingInputFile>
  delivery: "queue" | "steer"
}) {
  const { theme, component } = useTheme()
  const style = () => component("session.pending-input")
  const badgeFg = createMemo(() => selectedForeground(theme, props.color))

  return (
    <box
      id={props.id}
      border={[...style().box.borderSides]}
      borderColor={props.color}
      customBorderChars={borderCharsFor(style().box.borderCharset)}
      marginTop={style().box.marginTop}
    >
      <box
        paddingTop={style().box.paddingTop}
        paddingBottom={style().box.paddingBottom}
        paddingLeft={style().box.paddingLeft}
        backgroundColor={style().colors.background}
        flexShrink={0}
      >
        <Show when={props.text}>{(value) => <text fg={style().colors.text}>{value()}</text>}</Show>
        <Show when={props.files.length > 0}>
          <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
            <For each={props.files}>
              {(file) => (
                <text fg={theme.foreground.default}>
                  <span style={{ bg: theme.accent.secondary, fg: theme.surface.base }}> file </span>
                  <span style={{ bg: theme.surface.offset, fg: theme.foreground.muted }}>
                    {" "}
                    {file.filename ?? file.mime}{" "}
                  </span>
                </text>
              )}
            </For>
          </box>
        </Show>
        <text fg={style().colors.detail}>
          <Show
            when={props.delivery === "queue"}
            fallback={
              <>
                <span style={{ bg: props.color, fg: badgeFg(), bold: true }}> STEERING </span>
                <span> interrupts and sends now</span>
              </>
            }
          >
            <span style={{ bg: props.color, fg: badgeFg(), bold: true }}> QUEUED </span>
            <span> sends at the next safe step</span>
          </Show>
        </text>
      </box>
    </box>
  )
}
