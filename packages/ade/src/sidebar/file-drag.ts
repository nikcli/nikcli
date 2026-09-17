/**
 * Dragging a file out of the tree and into a session.
 *
 * The gesture answers a question the interface kept asking the user to answer
 * twice: the file is right there in the sidebar, the agent is right there in
 * the grid, and telling the agent about the file meant reading the path off
 * one and typing it into the other.
 *
 * What actually crosses the gap is a path, as text. Both ends of a drag are
 * in the same window, so this could have been a module-level variable — but a
 * `DataTransfer` is what the platform gives a drop target, it survives a drag
 * that starts in ADE and ends somewhere else entirely, and it means a path
 * dragged from Explorer or from VS Code lands here too.
 *
 * Pure and separate from the components, because a Solid `.tsx` cannot be
 * imported under `bun test` in this repo.
 */

import { normalizePath } from "../host/path"

/**
 * ADE's own type, checked before the generic ones.
 *
 * A private type is what distinguishes "a path from this project's tree"
 * from "some text that happens to be selected", and the drop target reacts
 * differently to the two: only the first is offered as a file.
 */
export const ADE_FILE_MIME = "application/x-ade-file"

/** How many paths one drag may carry. Beyond this the drop is a mistake. */
const MAX_DRAGGED_PATHS = 50

/** The minimal slice of `DataTransfer` these functions need. */
export interface DragData {
  getData(format: string): string
  setData?(format: string, data: string): void
  types?: readonly string[]
}

/**
 * Writes one or more paths into a drag.
 *
 * Three formats, most specific first: ADE's own, then `text/uri-list` so a
 * drop onto another application receives something it understands, then
 * `text/plain` so a drop into any text field types the path.
 */
export function writeDraggedPaths(data: DragData, paths: readonly string[]): void {
  const clean = paths.map((path) => path.trim()).filter((path) => path.length > 0)
  if (clean.length === 0 || !data.setData) return

  data.setData("text/plain", clean.join(" "))
  data.setData(ADE_FILE_MIME, clean.join("\n"))
  // `text/uri-list` is CRLF-separated by spec, and a `#` line is a comment.
  data.setData("text/uri-list", clean.map(toFileUri).join("\r\n"))
}

/**
 * Reads the paths out of a drop, or an empty array when there are none.
 *
 * ADE's own type wins because it is unambiguous. `text/uri-list` comes next:
 * a file dragged from Explorer or Finder arrives that way. Plain text is
 * last and is only accepted when it actually looks like a path — otherwise
 * dropping a selected sentence onto a pane would insert it as if it were a
 * filename.
 */
export function readDraggedPaths(data: DragData): string[] {
  const own = safeGet(data, ADE_FILE_MIME)
  if (own) return dedupe(own.split(/\r?\n/).map(normalizeDropped))

  const uris = safeGet(data, "text/uri-list")
  if (uris) {
    const paths = uris
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map(fromFileUri)
      .filter((path): path is string => path !== undefined)
    if (paths.length > 0) return dedupe(paths)
  }

  const files = (data as { files?: ArrayLike<{ path?: string; name?: string }> }).files
  if (files && files.length > 0) {
    const filePaths = Array.from(files)
      .map((f) => f.path || f.name)
      .filter((p): p is string => Boolean(p && p.trim().length > 0))
    if (filePaths.length > 0) return dedupe(filePaths.map(normalizeDropped))
  }

  const plain = safeGet(data, "text/plain")
  if (plain && looksLikePath(plain)) return dedupe([normalizeDropped(plain)])

  return []
}

/** True when a drag carries something this pane should accept. */
export function dragCarriesPaths(data: DragData): boolean {
  const types = data.types
  if (!types) return true
  const list = Array.from(types)
  return (
    list.includes(ADE_FILE_MIME) ||
    list.includes("text/uri-list") ||
    list.includes("text/plain") ||
    list.includes("Files")
  )
}

/**
 * How dropped paths read once they are in the prompt.
 *
 * Relative to the project when they are inside it, because that is how a
 * person refers to a file in their own repository and how every agent
 * reports one back. Absolute paths survive only when the file really is
 * elsewhere, where an absolute path is the only thing that identifies it.
 *
 * Quoted when a path contains a space, because the text is going to a
 * terminal where an unquoted space is an argument boundary.
 */
export function formatDroppedPaths(paths: readonly string[], projectRoot?: string): string {
  return paths
    .slice(0, MAX_DRAGGED_PATHS)
    .map((path) => quoteIfNeeded(relativize(path, projectRoot)))
    .join(" ")
}

function relativize(path: string, projectRoot?: string): string {
  if (!projectRoot) return path
  const root = normalizePath(projectRoot).replace(/\/+$/, "")
  const trailing = path.endsWith("/") ? "/" : ""
  const full = normalizePath(path)
  // Case-insensitive, because Windows paths reach here spelled either way and
  // a drive letter's case is not a difference the user made.
  if (full.toLowerCase() === root.toLowerCase()) {
    // The project root itself, dragged. Relative to itself it is the empty
    // string, which would reach the agent as nothing at all; "." is how a
    // person and every CLI name the directory they are standing in.
    return "."
  }
  if (!full.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return full + trailing
  return full.slice(root.length + 1) + trailing
}

function quoteIfNeeded(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

/**
 * Normalises a dropped path, keeping a trailing slash the sender meant.
 *
 * `normalizePath` strips trailing slashes by design, and for a file path that
 * is right. For a dragged folder it is not: the slash is the only thing in
 * the string that says "directory", and it is what makes `packages/ade/` read
 * as a scope rather than as a file somebody forgot the extension of.
 */
function normalizeDropped(raw: string): string {
  const trimmed = raw.trim()
  const normalized = normalizePath(trimmed)
  const wasDirectory = /[/\\]$/.test(trimmed)
  return wasDirectory && !normalized.endsWith("/") ? `${normalized}/` : normalized
}

function safeGet(data: DragData, format: string): string {
  try {
    return data.getData(format).trim()
  } catch {
    // Reading a format the drag does not carry throws in some engines.
    return ""
  }
}

function dedupe(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    if (path.length === 0 || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out.slice(0, MAX_DRAGGED_PATHS)
}

function toFileUri(path: string): string {
  const normalized = normalizePath(path)
  // A Windows path gets the third slash; a POSIX one already starts with one.
  const prefix = normalized.startsWith("/") ? "file://" : "file:///"
  return prefix + normalized.split("/").map(encodeURIComponent).join("/")
}

function fromFileUri(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("file:")) {
    return looksLikePath(trimmed) ? normalizeDropped(trimmed) : undefined
  }
  try {
    const decoded = decodeURIComponent(trimmed.replace(/^file:\/\/\/?/, ""))
    return normalizeDropped(decoded)
  } catch {
    return undefined
  }
}

/**
 * Whether a plain-text drag is a path rather than prose.
 *
 * Deliberately strict: a false positive here inserts a sentence into an
 * agent's prompt as though it were a filename. A separator and no newline
 * is the minimum, which is what every real path has and what a dragged
 * paragraph does not.
 */
function looksLikePath(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 4096) return false
  if (/[\r\n]/.test(trimmed)) return false
  return /[/\\]/.test(trimmed)
}
