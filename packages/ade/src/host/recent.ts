/**
 * Most-recently-used project list.
 *
 * Pure functions over a plain array — no I/O, no signals, no side effects.
 * Serialisation is JSON-based and intentionally tolerant: corrupt or outdated
 * data produces an empty list rather than an exception, so the app always
 * starts even if localStorage was wiped or the schema changed.
 */

import { normalizePath } from "./path"

export interface RecentEntry {
  root: string
  name: string
  /** Epoch-ms of last access — most recent first. */
  openedAt: number
}

/**
 * Adds (or moves to front) a project in the MRU list.
 * Deduplicates on `root` (case-insensitive, normalised).
 */
export function addRecent(
  list: readonly RecentEntry[],
  entry: Omit<RecentEntry, "openedAt">,
  limit = 20,
): RecentEntry[] {
  const key = recentKey(entry.root)
  const next: RecentEntry[] = [
    { root: entry.root, name: entry.name, openedAt: Date.now() },
    ...list.filter((e) => recentKey(e.root) !== key),
  ]
  return next.slice(0, limit)
}

/** Removes a project by root (case-insensitive). */
export function removeRecent(list: readonly RecentEntry[], root: string): RecentEntry[] {
  const key = recentKey(root)
  return list.filter((e) => recentKey(e.root) !== key)
}

/**
 * The identity of a project root, for deduplication.
 *
 * The doc above says "normalised" and the code only lower-cased, so on
 * Windows the same project opened once from the sidebar (`C:/Users/x/repo`)
 * and once from a shell path (`C:\Users\x\repo`) became two entries in the
 * list, pointing at the same directory, with two different "last opened"
 * times. A trailing separator did the same.
 */
function recentKey(root: string): string {
  return normalizePath(root).replace(/\/+$/, "").toLowerCase()
}

/** Serialises the list to a JSON string. */
export function serializeRecents(list: readonly RecentEntry[]): string {
  return JSON.stringify(list)
}

/**
 * Parses a JSON string into a list of recent entries.
 * Returns an empty array on any error — corrupt data must never prevent
 * the app from starting.
 */
export function parseRecents(json: string): RecentEntry[] {
  try {
    const raw = JSON.parse(json)
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is RecentEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof e.root === "string" &&
        typeof e.name === "string" &&
        typeof e.openedAt === "number",
    )
  } catch {
    return []
  }
}
