import { isAbsolute, resolve } from "node:path"
import type {
  Content,
  Diff,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk"

/**
 * Tool-name → ACP metadata conversion helpers.
 *
 * The nikcli tool registry uses lower-case names that map cleanly to a
 * small set of ACP `ToolKind`s. The mapping is intentionally permissive:
 * unknown tools degrade to `other` rather than throwing, so adding a new
 * tool never breaks the protocol bridge.
 */
export type ToolInput = Record<string, unknown>

export type ToolAttachment = {
  readonly mime?: string
  readonly url?: string
  readonly [key: string]: unknown
}

export type CompletedToolState = {
  readonly status: "completed"
  readonly input: ToolInput
  readonly output: string
  readonly metadata?: unknown
  readonly attachments?: ReadonlyArray<ToolAttachment>
}

export type RunningToolState = {
  readonly status: "running"
  readonly input: ToolInput
  readonly title?: string
}

export type ErrorToolState = {
  readonly status: "error"
  readonly input: ToolInput
  readonly error: string
  readonly metadata?: unknown
}

export type ImageAttachment = {
  readonly mimeType: string
  readonly data: string
}

/**
 * Map a nikcli tool name to the ACP `ToolKind` enum used by clients to pick
 * icons and behavior. The lookup is case-insensitive so that model-emitted
 * tool names like `Bash` or `EDIT` still resolve correctly.
 */
export function toToolKind(toolName: string): ToolKind {
  const tool = toolName.toLocaleLowerCase()

  switch (tool) {
    case "bash":
    case "shell":
    case "exec_code":
    case "code_mode":
      return "execute"

    case "webfetch":
    case "websearch":
    case "mcp-exa":
      return "fetch"

    case "edit":
    case "multiedit":
    case "apply_patch":
    case "patch":
    case "write":
    // Writes a plugin's code into its own folder.
    case "plugin":
      return "edit"

    case "grep":
    case "glob":
    case "codesearch":
    case "search_tools":
    case "memory_search":
    // The registry id is `list`; `ls` stays as an alias because models emit it.
    case "list":
    case "ls":
    case "tree":
    case "truncation":
    case "truncation-dir":
      return "search"

    case "read":
    case "context_collect":
    case "context_related":
    case "context_diagnostics":
      return "read"

    case "task":
    // `plan` and `goal` are the generic names; the registry splits each into
    // one id per operation, and those are what actually arrive here.
    case "plan":
    case "plan_enter":
    case "plan_exit":
    case "goal":
    case "create_goal":
    case "get_goal":
    case "update_goal":
    case "monitor":
    case "delegation":
    case "delegator":
      return "think"

    case "todowrite":
    case "todoread":
    case "todo":
    case "question":
    case "invalid":
    case "external-directory":
      return "other"

    default:
      return "other"
  }
}

/**
 * Compute the file locations affected by a tool call from its raw input.
 * This powers the ACP "follow-along" UX where the client highlights files
 * the agent is reading, editing, or searching.
 */
export function toLocations(toolName: string, input: ToolInput, cwd?: string): ToolCallLocation[] {
  const tool = toolName.toLocaleLowerCase()

  switch (tool) {
    case "bash":
    case "shell":
    case "exec_code":
    case "code_mode": {
      const workdir = shellWorkdir(input, cwd)
      return workdir ? [{ path: workdir }] : []
    }

    case "read":
    case "edit":
    case "multiedit":
    case "write":
    case "apply_patch":
    case "patch":
      return locationFrom(input.filePath ?? input.filepath ?? input.path)

    case "external-directory":
      return locationFrom(input.filePath ?? input.filepath, input.parentDir, input.directories)

    case "grep":
    case "glob":
    case "codesearch":
    case "list":
    case "ls":
    case "tree":
    case "search_tools":
      return locationFrom(input.path, input.pattern)

    default:
      return []
  }
}

/**
 * Build the canonical `ToolCall` payload for a `session/update` notification
 * when a tool is first observed in `pending` state.
 */
export function pendingToolCall(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: { readonly input: ToolInput; readonly title?: string }
  readonly cwd?: string
}): ToolCall {
  return {
    toolCallId: input.toolCallId,
    title: toolTitle(input.toolName, input.state.input, input.state.title),
    kind: toToolKind(input.toolName),
    status: "pending",
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
  }
}

/**
 * Build a streaming `ToolCallUpdate` for an in-progress tool call, optionally
 * carrying shell output as a `Content` block so the client can render the
 * live transcript.
 */
export function runningToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: RunningToolState
  readonly output?: string
  readonly cwd?: string
}): ToolCallUpdate {
  const content: ToolCallContent[] | undefined = input.output
    ? [
        {
          type: "content",
          content: {
            type: "text",
            text: input.output,
          },
        },
      ]
    : undefined

  return {
    toolCallId: input.toolCallId,
    status: "in_progress",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.state.input, input.state.title),
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
    ...(content ? { content } : undefined),
  }
}

/**
 * Build a duplicate-frame `ToolCallUpdate` for an in-progress tool call
 * where the snapshot did not change since the last emit. Clients use this
 * to throttle redundant shell output without losing the in_progress signal.
 */
export function duplicateRunningToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: RunningToolState
  readonly cwd?: string
}): ToolCallUpdate {
  return {
    toolCallId: input.toolCallId,
    status: "in_progress",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.state.input, input.state.title),
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
  }
}

/**
 * Build the final `ToolCallUpdate` for a completed tool call, with the
 * canonical content blocks (text + diff + image attachments).
 */
export function completedToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: CompletedToolState & { readonly title?: string }
  readonly cwd?: string
}): ToolCallUpdate {
  return {
    toolCallId: input.toolCallId,
    status: "completed",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.state.input, input.state.title),
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    content: completedToolContent(input.toolName, input.state),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
    rawOutput: completedToolRawOutput(input.state),
  }
}

/**
 * Build the `ToolCallUpdate` for a tool call that errored out. The error
 * string is surfaced as the only text content; metadata travels in
 * `rawOutput.error` so clients can render it however they want.
 */
export function errorToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: ErrorToolState
  readonly cwd?: string
}): ToolCallUpdate {
  return {
    toolCallId: input.toolCallId,
    status: "failed",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.state.input, undefined),
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: input.state.error,
        },
      },
    ],
    rawOutput: {
      error: input.state.error,
      metadata: input.state.metadata,
    },
  }
}

/**
 * Compose the canonical content blocks produced by a completed tool call:
 * - text output (or, for `read`, the display text from metadata)
 * - a `diff` block when the tool is an edit-class tool
 * - one `image` block per image attachment
 */
export function completedToolContent(toolName: string, state: CompletedToolState): ToolCallContent[] {
  const text =
    toolName.toLocaleLowerCase() === "read" ? (readDisplayText(state.metadata) ?? state.output) : state.output

  const content: ToolCallContent[] = [
    {
      type: "content",
      content: {
        type: "text",
        text,
      },
    },
  ]

  if (toToolKind(toolName) === "edit") {
    content.push(...diffContent(state.input))
  }

  content.push(...imageContents(state.attachments ?? []))
  return content
}

/**
 * Raw output envelope for a completed tool call. Mirrors opencode's shape:
 * - `output` is always present
 * - `metadata` is included when defined
 * - `attachments` only when there are any
 */
export function completedToolRawOutput(state: CompletedToolState) {
  return {
    output: state.output,
    ...(state.metadata !== undefined ? { metadata: state.metadata } : undefined),
    ...(state.attachments?.length ? { attachments: state.attachments } : undefined),
  }
}

/**
 * Convert tool attachments into image `ToolCallContent` blocks. Non-image
 * MIME types are skipped — clients receive them through `rawOutput` instead.
 */
export function imageContents(attachments: ReadonlyArray<ToolAttachment>): ToolCallContent[] {
  return extractImageAttachments(attachments).map(
    (attachment): ToolCallContent => ({
      type: "content",
      content: {
        type: "image",
        mimeType: attachment.mimeType,
        data: attachment.data,
      },
    }),
  )
}

export function extractImageAttachments(attachments: ReadonlyArray<ToolAttachment>): ImageAttachment[] {
  return attachments.flatMap((attachment): ImageAttachment[] => {
    const data = dataUrlImage(attachment)
    return data ? [data] : []
  })
}

/**
 * Extract a stable shell-output snapshot string from a running tool's
 * `metadata`. The string is compared across emits so we can throttle
 * duplicate frames without losing signal. Returns `undefined` when the
 * tool has no output yet.
 */
export function shellOutputSnapshot(state: { readonly metadata?: unknown }): string | undefined {
  if (!state.metadata || typeof state.metadata !== "object") return undefined
  return stringValue((state.metadata as Record<string, unknown>).output)
}

/**
 * Render a `read` tool's display text from its metadata when available
 * (file listing, line range, etc). Falls back to raw output.
 */
function readDisplayText(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const display = (metadata as Record<string, unknown>).display
  if (!display || typeof display !== "object") return undefined
  const info = display as Record<string, unknown>
  if (info.type === "file") return stringValue(info.text)
  if (info.type === "directory" && Array.isArray(info.entries)) {
    return info.entries.filter((item): item is string => typeof item === "string").join("\n")
  }
  return undefined
}

function dataUrlImage(attachment: ToolAttachment): ImageAttachment | undefined {
  const match = stringValue(attachment.url)?.match(/^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/)
  const mime = match?.[1] ?? stringValue(attachment.mime)
  if (!mime?.startsWith("image/")) return undefined

  const data = match?.[2]
  if (data === undefined) return undefined
  return { mimeType: mime, data }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * Resolve the title shown for a tool call. Shell tools surface the actual
 * command so the user sees what's running before output lands; other tools
 * keep their model-provided title.
 */
function toolTitle(toolName: string, input: ToolInput, fallback: string | undefined): string {
  if (isShell(toolName)) return shellCommand(input) ?? stringValue(input.description) ?? fallback ?? toolName
  return fallback || toolName
}

/**
 * Enrich shell `rawInput` with the resolved working directory so clients
 * can show *where* the command runs, unless the model already specified
 * one. Keeps the rest of the rawInput untouched.
 */
function rawInput(toolName: string, input: ToolInput, cwd?: string): ToolInput {
  if (!isShell(toolName)) return input
  if (input.cwd || input.workdir) return input
  const workdir = shellWorkdir(input, cwd)
  return workdir ? { ...input, cwd: workdir } : input
}

function shellWorkdir(input: ToolInput, cwd?: string): string | undefined {
  const explicit = stringValue(input.workdir) ?? stringValue(input.cwd)
  return resolvePath(explicit, cwd) ?? cwd
}

function resolvePath(value: string | undefined, cwd?: string): string | undefined {
  if (!value) return undefined
  if (isAbsolute(value)) return value
  return resolve(cwd ?? process.cwd(), value)
}

function shellCommand(input: ToolInput): string | undefined {
  return stringValue(input.command) ?? stringValue(input.cmd)
}

function isShell(toolName: string): boolean {
  const tool = toolName.toLocaleLowerCase()
  return tool === "bash" || tool === "shell" || tool === "exec_code" || tool === "code_mode"
}

function locationFrom(...values: unknown[]): ToolCallLocation[] {
  return Array.from(
    new Set(
      values.flatMap((value): string[] => {
        if (Array.isArray(value)) {
          return value.filter((item): item is string => typeof item === "string" && item.length > 0)
        }
        const path = stringValue(value)
        return path ? [path] : []
      }),
    ),
    (path) => ({ path }),
  )
}

function diffContent(input: ToolInput): ToolCallContent[] {
  const oldText = stringValue(input.oldString)
  const newText = stringValue(input.newString) ?? stringValue(input.content)
  if (oldText === undefined || newText === undefined) return []

  const diff: Diff = {
    path: stringValue(input.filePath) ?? stringValue(input.path) ?? "",
    oldText,
    newText,
  }

  return [{ type: "diff", ...diff }]
}

// Re-export the canonical content type so consumers can type their own
// helpers without reaching into the SDK.
export type { Content, Diff, ToolCall, ToolCallContent, ToolCallLocation, ToolCallUpdate, ToolKind }

// Named exports keep parity with opencode's `tool.ts` for easy grepping.
export const mapToolKind = toToolKind
export const extractLocations = toLocations
export const buildCompletedToolContent = completedToolContent
export const buildCompletedRawOutput = completedToolRawOutput
export const extractShellOutputSnapshot = shellOutputSnapshot
export const buildPendingToolCall = pendingToolCall
export const buildRunningToolUpdate = runningToolUpdate
export const buildDuplicateRunningToolUpdate = duplicateRunningToolUpdate
export const buildCompletedToolUpdate = completedToolUpdate
export const buildErrorToolUpdate = errorToolUpdate

export * as ACPTool from "./tool"
