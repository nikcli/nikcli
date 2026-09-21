import type { JSX } from "@opentui/solid"
import {
  AssistantMessage,
  PendingUserMessage,
  RetryPart,
  SyntheticPart,
  UnknownPart,
  UserMessage,
} from "@tui/routes/session/parts"
import type { ComponentId, StyleOf } from "@tui/context/component-tokens"
import { FIXTURES } from "./fixtures"

/**
 * The stories.
 *
 * Every one renders a component imported from `@tui/routes/session/parts` — the
 * same module the running TUI renders. Copies here would look right and then
 * diverge within a week, so anything that cannot be imported from that barrel
 * has no story, and that gap is the useful signal rather than a reason to
 * duplicate the component.
 */

export type StoryContext = {
  /** Resolved style for the component this story is about, when it has one. */
  style: <Id extends ComponentId>(id: Id) => StyleOf<Id>
}

export type Story = {
  readonly id: string
  readonly title: string
  /** The catalog entry whose tokens the inspector edits while this story shows. */
  readonly styleId?: ComponentId
  readonly render: (context: StoryContext) => JSX.Element
}

export const STORIES: readonly Story[] = [
  {
    id: "user-message",
    title: "User message",
    styleId: "session.user-message",
    render: (context) => (
      <UserMessage
        turn={FIXTURES.userShort}
        index={0}
        pending={undefined}
        onMouseUp={() => {}}
        style={context.style("session.user-message")}
      />
    ),
  },
  {
    id: "user-message-files",
    title: "User message · attachments",
    styleId: "session.user-message",
    render: (context) => (
      <UserMessage
        turn={FIXTURES.userWithFiles}
        index={1}
        pending={undefined}
        onMouseUp={() => {}}
        style={context.style("session.user-message")}
      />
    ),
  },
  {
    id: "assistant-text",
    title: "Assistant · settled markdown",
    styleId: "session.text-part",
    render: () => <AssistantMessage turn={FIXTURES.assistantText} last={true} />,
  },
  {
    id: "assistant-streaming",
    title: "Assistant · streaming",
    styleId: "session.text-part",
    render: () => <AssistantMessage turn={FIXTURES.assistantStreaming} last={true} />,
  },
  {
    id: "reasoning",
    title: "Reasoning",
    styleId: "session.reasoning-part",
    render: () => <AssistantMessage turn={FIXTURES.reasoning} last={true} />,
  },
  {
    id: "retry",
    title: "Retry",
    styleId: "session.retry-part",
    render: () => <RetryPart entry={FIXTURES.retry.body[0]!} />,
  },
  {
    id: "synthetic",
    title: "Synthetic",
    render: () => <SyntheticPart entry={FIXTURES.synthetic.body[0]!} />,
  },
  {
    id: "unknown",
    title: "Unknown entry · the backstop",
    render: () => <UnknownPart entry={FIXTURES.unknown.body[0]!} />,
  },
  {
    id: "pending",
    title: "Pending input",
    render: () => (
      <PendingUserMessage
        pending={
          {
            id: "p1",
            sessionID: "storybook",
            parts: [{ type: "text", text: "queued while the turn finishes" }],
          } as never
        }
      />
    ),
  },
]
