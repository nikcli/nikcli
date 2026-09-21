import { useTheme } from "@tui/context/theme"
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
  const { theme } = useTheme()
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text fg={theme.foreground.muted}>◌ {props.entry.type}</text>
    </box>
  )
}
