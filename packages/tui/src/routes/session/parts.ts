/**
 * Public surface of the session's message components.
 *
 * A file rather than `parts/index.ts` on purpose: `@nikcli-ai/tui` exports
 * `"./*": ["./src/*.ts", "./src/*.tsx"]`, a subpath pattern with no directory
 * or index resolution, so `@nikcli-ai/tui/routes/session/parts` reaches this
 * module and a directory barrel would not resolve at all from outside.
 *
 * This is the seam. Anything importing a session component from another package
 * — the storybook above all — goes through here, and anything reaching past it
 * into `parts/` has left the supported surface.
 */

export { PendingUserMessage } from "./parts/pending-user-message"
export { UserMessage, MIME_BADGE, type FileAttachment } from "./parts/user-message"
export { AssistantMessage } from "./parts/assistant-message"
export { TurnTokens } from "./parts/turn-tokens"
export { ReasoningHeader, ReasoningPart } from "./parts/reasoning-part"
export { RetryPart } from "./parts/retry-part"
export { SubtaskPart } from "./parts/subtask-part"
export { SyntheticPart } from "./parts/synthetic-part"
export { TextPart } from "./parts/text-part"
export { UnknownPart } from "./parts/unknown-part"

export {
  isPartOverridden,
  PART_MAPPING,
  partTypes,
  registerPart,
  resetPartOverrides,
  resolvePart,
  type PartComponent,
  type PartProps,
} from "./parts/registry"
