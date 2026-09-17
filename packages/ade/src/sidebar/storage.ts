/**
 * Resilient storage serialization and retrieval for sidebar layout state.
 *
 * All functions are defensive against disabled storage, SSR environments,
 * quota exceptions, and corrupted JSON payload structures.
 */

export const STORAGE_KEY_WIDTH = "ade:sidebar:width"

/**
 * Which sections are open, as a comma-separated list.
 *
 * Replaces `sessions-height` and `sessions-collapsed`, which between them
 * stored a pixel height that no longer exists — sections are sized to their
 * content now. A new key rather than a reused one, so an old value cannot be
 * read as a new one; the two old keys are simply left behind in storage and
 * ignored.
 */
export const STORAGE_KEY_SECTIONS = "ade:sidebar:sections"
export const STORAGE_KEY_EXPANDED_WORKSPACES = "ade:sidebar:expanded-workspaces"
export const STORAGE_KEY_EXPANDED_DIRS = "ade:sidebar:expanded-dirs"
export const STORAGE_KEY_SEARCH_KINDS = "ade:sidebar:search-kinds"

export type EntryKind = "file" | "directory"

/** Which kinds the file search shows. Never empty: a filter that hides everything is a broken box. */
export function deserializeKinds(raw: string | null | undefined): Set<EntryKind> {
  const kinds = new Set<EntryKind>()
  for (const part of (raw ?? "").split(",")) {
    if (part === "file" || part === "directory") kinds.add(part)
  }
  return kinds.size > 0 ? kinds : new Set<EntryKind>(["file", "directory"])
}

/**
 * Turns one kind on or off. Turning off the last one turns the other on
 * instead, so the two chips behave like a pair that can never both be off.
 */
export function toggleKind(kinds: ReadonlySet<EntryKind>, kind: EntryKind): Set<EntryKind> {
  const next = new Set(kinds)
  if (next.has(kind)) next.delete(kind)
  else next.add(kind)
  if (next.size === 0) next.add(kind === "file" ? "directory" : "file")
  return next
}
export const STORAGE_KEY_TAB = "ade:sidebar:tab"

export type SidebarTab = "sessions" | "files"

/**
 * Serializes a Set of string keys to a JSON array string.
 */
export function serializeSet(set: ReadonlySet<string>): string {
  return JSON.stringify(Array.from(set))
}

/**
 * Parses a serialized Set of string keys from storage.
 *
 * Non-string elements or invalid JSON structures are discarded rather than
 * throwing, preventing a corrupted localStorage entry from breaking sidebar
 * rendering.
 */
export function deserializeSet(
  raw: string | null | undefined,
  fallback: readonly string[] = [],
): Set<string> {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return new Set(fallback)
  }

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return new Set(fallback)
    }

    const validStrings = parsed.filter((item): item is string => typeof item === "string")
    return new Set(validStrings)
  } catch {
    return new Set(fallback)
  }
}

/**
 * Validates and parses the active sidebar tab mode.
 */
export function parseSidebarTab(
  raw: string | null | undefined,
  fallback: SidebarTab = "sessions",
): SidebarTab {
  if (raw === "sessions" || raw === "files") {
    return raw
  }
  return fallback
}

/**
 * Safely reads a key from storage without throwing in locked or non-browser environments.
 */
export function safeGetStorage(storage: Storage | undefined, key: string): string | null {
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Safely writes a key to storage, absorbing QuotaExceededError or security exceptions.
 */
export function safeSetStorage(storage: Storage | undefined, key: string, value: string): void {
  if (!storage) return
  try {
    storage.setItem(key, value)
  } catch {
    // Quota exceeded or private browsing security restrictions; degrade gracefully to in-memory state
  }
}
