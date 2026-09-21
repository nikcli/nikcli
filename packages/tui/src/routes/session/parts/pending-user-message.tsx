import { PendingInputCard } from "@tui/component/pending-input-card"
import { useLocal } from "@tui/context/local"
import { createMemo } from "solid-js"
import type { SessionPendingInput2 } from "@nikcli-ai/sdk/httpapi"

/**
 * Session-route adapter for {@link PendingInputCard}.
 *
 * The card itself is presentational and lives in `component/pending-input-card.tsx` so fixtures can
 * render it; this resolves the parts and the agent colour that only the live session knows.
 */
export function PendingUserMessage(props: { pending: SessionPendingInput2 }) {
  const local = useLocal()
  const text = createMemo(() =>
    props.pending.data.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n"),
  )
  const files = createMemo(() => props.pending.data.parts.filter((part) => part.type === "file"))
  const color = createMemo(() => local.agent.color(props.pending.data.agent ?? ""))

  return (
    <PendingInputCard
      id={props.pending.messageID}
      color={color()}
      text={text()}
      files={files()}
      delivery={props.pending.delivery === "queue" ? "queue" : "steer"}
    />
  )
}
