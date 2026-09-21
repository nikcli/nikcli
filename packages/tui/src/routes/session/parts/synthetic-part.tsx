import { useTheme } from "@tui/context/theme"
import { Show, createMemo } from "solid-js"
import type { ViewEntry } from "../view"

/** An auto-generated message the engine injected into the conversation. */
export function SyntheticPart(props: { entry: ViewEntry }) {
  const { component } = useTheme()
  const style = () => component("session.synthetic-part")
  const text = createMemo(() => String(props.entry.text ?? "").trim())
  return (
    <Show when={text()}>
      <box paddingLeft={style().box.paddingLeft} marginTop={style().box.marginTop} flexShrink={0}>
        <text fg={style().colors.text}>{text()}</text>
      </box>
    </Show>
  )
}
