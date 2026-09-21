import { Locale } from "@nikcli-ai/util/locale"
import { SessionTaskCard } from "@tui/component/session-task-card"
import { useLocal } from "@tui/context/local"
import { useTheme } from "@tui/context/theme"
import { createMemo } from "solid-js"
import type { ViewEntry } from "../view"

/**
 * A delegated sub-agent run.
 *
 * nikcli-specific — opencode has no equivalent entry — and the one row where
 * being invisible costs the most, because the work it stands for happened in
 * another session the reader cannot see from here.
 */
export function SubtaskPart(props: { entry: ViewEntry }) {
  const local = useLocal()
  const { component } = useTheme()
  const style = () => component("session.subtask-part")
  const agent = createMemo(() => String(props.entry.agent ?? ""))
  const description = createMemo(() => String(props.entry.description ?? "").trim())
  const background = createMemo(() => props.entry.background === true)
  const title = createMemo(() => Locale.titlecase(agent() || "task"))
  return (
    <box paddingLeft={style().box.paddingLeft} flexShrink={0}>
      <SessionTaskCard
        kind={background() ? "background" : "subtask"}
        color={local.agent.color(agent())}
        agent={agent()}
        title={title()}
        description={description() || undefined}
      />
    </box>
  )
}
