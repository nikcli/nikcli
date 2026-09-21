import { useTheme } from "@tui/context/theme"
import { createMemo } from "solid-js"
import type { ViewEntry } from "../view"

/**
 * The backstop for an entry type this table does not know.
 *
 * Deliberately dumb — a marker and the type name, no field guessing. Its job is
 * to make the gap visible in the transcript instead of hiding it, so the next
 * entry type added to `SessionEntry` shows up as an obviously unfinished row
 * rather than as silence.
 */
export function UnknownPart(props: { entry: ViewEntry }) {
  const { component } = useTheme()
  const style = createMemo(() => component("session.unknown-part"))
  return (
    <box paddingLeft={style().box.paddingLeft} marginTop={style().box.marginTop} flexShrink={0}>
      <text fg={style().colors.text}>◌ {props.entry.type}</text>
    </box>
  )
}
