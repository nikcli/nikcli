/**
 * Render-facing shapes for the tool parts the session view knows how to draw.
 *
 * These are deliberately *not* derived from the backend tool definitions. The view renders
 * whatever the wire happens to carry — tools it has never heard of, payloads from a server that
 * is older or newer than it, and half-streamed arguments that are still being written — so every
 * field is optional and every renderer already treats the values as best effort.
 *
 * Importing `@/tool/*` bought exact types at the price of pinning the terminal app to the
 * server's module graph, which is the coupling `specs/effect-tui/08-host-plugins-startup.md` exists to remove. The
 * types were erased at build anyway: they described the wire, not the implementation.
 *
 * Keep a field here only while a renderer reads it. If one drifts from the server, the renderer
 * shows a blank rather than crashing, which is the behavior we want from a view of a remote
 * process.
 */

/** LSP diagnostic, narrowed to what the file-editing renderers show. */
export type Diagnostic = {
  severity?: number
  range: { start: { line: number; character: number } }
  /** LSP allows a marked-up form; both spellings appear on the wire. */
  message: string | { value: string }
}

/** Mirrors `LSP.Diagnostic.message`, so rendering a diagnostic needs no server import. */
export function diagnosticMessage(diagnostic: Diagnostic): string {
  return typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value
}

/** Diagnostics arrive keyed by normalized file path. */
export type DiagnosticsByPath = Record<string, Diagnostic[]>

/** A single file's change, as `apply_patch` reports it. */
export type PatchedFile = {
  type: string
  relativePath: string
  filePath: string
  deletions: number
  diff: string
}

export type TodoEntry = {
  status: "pending" | "in_progress" | "completed" | "cancelled"
  content: string
}

export type AskedQuestion = {
  question: string
}

/**
 * What a renderer receives. `input` is the model's arguments — possibly partial, because it is
 * streamed — and `metadata` is what the tool reported while and after running.
 */
export type ToolShape<Input = Record<string, unknown>, Metadata = Record<string, unknown>> = {
  input: Input
  metadata: Metadata
}

export type ReadShape = ToolShape<{ filePath?: string; offset?: number; limit?: number }>

export type WriteShape = ToolShape<{ filePath?: string; content?: string }, { diagnostics?: DiagnosticsByPath }>

export type EditShape = ToolShape<
  { filePath?: string; replaceAll?: boolean },
  { diff?: string; diagnostics?: DiagnosticsByPath }
>

export type ApplyPatchShape = ToolShape<Record<string, unknown>, { files?: PatchedFile[] }>

/** `plugin`: create/update report the entry file and its diff; every action reports what is loaded. */
export type PluginShape = ToolShape<
  { action?: string; name?: string; scope?: string },
  {
    action?: string
    name?: string
    folder?: string
    filepath?: string
    diff?: string
    loaded?: boolean
    plugins?: { name: string; error?: string }[]
  }
>

/** `command` and `description` also arrive as metadata, published when execution starts. */
export type BashShape = ToolShape<
  { command?: string; description?: string; workdir?: string },
  { output?: string; command?: string; description?: string }
>

export type GlobShape = ToolShape<{ pattern?: string; path?: string }, { count?: number }>

export type GrepShape = ToolShape<{ pattern?: string; path?: string; include?: string }, { matches?: number }>

export type ListShape = ToolShape<{ path?: string }>

export type TodoWriteShape = ToolShape<{ todos?: TodoEntry[] }, { todos?: TodoEntry[] }>

export type QuestionShape = ToolShape<{ questions?: AskedQuestion[] }, { answers?: readonly (readonly string[])[] }>

export type BrowserControlShape = ToolShape<{ action?: string }, { action?: string; name?: string }>

export type ComputerShape = ToolShape<{ action?: string }, { mode?: string; liveUrl?: string }>

export type ArtifactPublishedMeta = {
  title?: string
  url?: string
  viewerUrl?: string
  viewKey?: string
}

export type ArtifactShape = ToolShape<
  { title?: string },
  ArtifactPublishedMeta & { kind?: string; version?: string | number }
>

/**
 * Link shown on the published-artifact card.
 *
 * Prefer any candidate that already carries `?key=` (viewerUrl, url, a URL
 * reconstructed from `viewKey`, or a capability link in the tool output).
 * Older tool results stored the login-gated page as `url` and omitted
 * `viewerUrl`; without this, the card prints a dead link.
 */
export function artifactPublishedHref(meta: ArtifactPublishedMeta, output?: string): string | undefined {
  const reconstructed =
    meta.url && meta.viewKey && !hasCapabilityKey(meta.url) ? appendCapabilityKey(meta.url, meta.viewKey) : undefined
  return (
    firstKeyed(meta.viewerUrl, meta.url, reconstructed, keyedUrlInText(output)) ??
    reconstructed ??
    meta.viewerUrl ??
    meta.url
  )
}

function hasCapabilityKey(value: string): boolean {
  try {
    return Boolean(new URL(value).searchParams.get("key"))
  } catch {
    return /[?&]key=[^&\s]+/.test(value)
  }
}

function appendCapabilityKey(value: string, key: string): string | undefined {
  try {
    const url = new URL(value)
    url.searchParams.set("key", key)
    return url.toString()
  } catch {
    return undefined
  }
}

function firstKeyed(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value && hasCapabilityKey(value))
}

function keyedUrlInText(text?: string): string | undefined {
  if (!text) return undefined
  for (const token of text.split(/\s+/)) {
    const trimmed = token.replace(/[.,;:)\]>]+$/g, "")
    if (hasCapabilityKey(trimmed)) return trimmed
  }
}
