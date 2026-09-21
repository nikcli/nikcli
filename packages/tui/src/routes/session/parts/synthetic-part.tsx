import { useTheme } from "@tui/context/theme"
import { Show, createMemo } from "solid-js"
import type { ViewEntry } from "../view"

/** An auto-generated message the engine injected into the conversation. */
export function SyntheticPart(props: { entry: ViewEntry }) {
  const { theme } = useTheme()
  const text = createMemo(() => String(props.entry.text ?? "").trim())
  return (
    <Show when={text()}>
      <box paddingLeft={3} marginTop={1} flexShrink={0}>
        <text fg={theme.foreground.muted}>{text()}</text>
      </box>
    </Show>
  )
}
