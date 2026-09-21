import { friendlyErrorMessage } from "../../../util/error-message"
import { useTheme } from "@tui/context/theme"
import { createMemo } from "solid-js"
import type { ViewEntry } from "../view"

/** A request that failed and was retried. Shows the attempt and why. */
export function RetryPart(props: { entry: ViewEntry }) {
  const { component } = useTheme()
  const style = () => component("session.retry-part")
  const attempt = createMemo(() => {
    const value = props.entry.attempt
    return typeof value === "number" ? value : undefined
  })
  return (
    <box paddingLeft={style().box.paddingLeft} marginTop={style().box.marginTop} flexShrink={0}>
      <text>
        <span style={{ fg: style().colors.icon }}>⟳ </span>
        <span style={{ fg: style().colors.text }}>
          {attempt() === undefined ? "Retrying" : `Retry ${attempt()}`}
          {" · "}
          {friendlyErrorMessage(props.entry.error)}
        </span>
      </text>
    </box>
  )
}
