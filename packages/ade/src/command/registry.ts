/**
 * Command palette model: registry, filtering, and selection navigation.
 *
 * The palette is the primary discovery surface for keyboard users. This module
 * owns the *data* side: what a command is, how to search through a list of
 * them, how to move a highlight cursor. The rendering lives elsewhere.
 *
 * Design choice: disabled commands stay in the filtered results, sorted to the
 * bottom. Removing them entirely makes the user think they typed wrong — they
 * can see the command but can't activate it, which is a much better signal
 * than "your command vanished because context changed while you were typing."
 */

import { fuzzyMatch } from "./match"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Command {
  id: string
  title: string
  group: string
  /** Searchable synonyms that don't appear in the title. */
  keywords?: string[]
  /** Pre-formatted shortcut shown beside the title ("Ctrl+K"). */
  shortcut?: string
  /** False when the command is unavailable in the current context. */
  enabled?: boolean
}

export interface CommandHit {
  command: Command
  score: number
  /** Highlight ranges in the title, `[start, end)` pairs. */
  titleRanges: [number, number][]
  /** Highlight ranges in the group name. */
  groupRanges: [number, number][]
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter and rank commands against a query.
 *
 * Empty query returns all commands in declaration order (enabled first).
 * Non-empty query matches against title, group, and keywords; the best score
 * across all fields wins. Disabled commands always sort after enabled ones,
 * and within each bucket the order is: score descending, then declaration
 * order — so the list never jumps while the user types.
 */
export function filterCommands(commands: Command[], query: string): CommandHit[] {
  const hits: CommandHit[] = []

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]

    if (query.length === 0) {
      hits.push({
        command: cmd,
        score: 0,
        titleRanges: [],
        groupRanges: [],
      })
      continue
    }

    // Try matching title, group, and each keyword; keep the best
    const titleHit = fuzzyMatch(query, cmd.title)
    const groupHit = fuzzyMatch(query, cmd.group)

    let bestKeywordScore = -Infinity
    if (cmd.keywords) {
      for (const kw of cmd.keywords) {
        const kwHit = fuzzyMatch(query, kw)
        if (kwHit && kwHit.score > bestKeywordScore) {
          bestKeywordScore = kwHit.score
        }
      }
    }

    // At least one field must match
    const titleScore = titleHit?.score ?? -Infinity
    const groupScore = groupHit?.score ?? -Infinity
    const bestScore = Math.max(titleScore, groupScore, bestKeywordScore)

    if (bestScore === -Infinity) continue

    hits.push({
      command: cmd,
      score: bestScore,
      titleRanges: titleHit?.ranges ?? [],
      groupRanges: groupHit?.ranges ?? [],
    })
  }

  // Stable sort: enabled first, then score descending, then declaration order.
  // Declaration order is preserved by the stability of Array.prototype.sort.
  hits.sort((a, b) => {
    const aEnabled = a.command.enabled !== false ? 1 : 0
    const bEnabled = b.command.enabled !== false ? 1 : 0
    if (aEnabled !== bEnabled) return bEnabled - aEnabled
    return b.score - a.score
  })

  return hits
}

// ---------------------------------------------------------------------------
// Selection movement
// ---------------------------------------------------------------------------

/**
 * Move the selection cursor within a list of hits.
 *
 * Skips disabled commands. Clamps at both ends rather than wrapping — wrapping
 * in a palette is disorienting because the list length changes with every
 * keystroke, so the wrap point is unpredictable.
 *
 * Returns the index of the newly selected hit, or -1 if the list is empty or
 * entirely disabled.
 */
export function moveSelection(hits: CommandHit[], current: number, delta: number): number {
  if (hits.length === 0) return -1

  // If current is out of bounds, start from the top (delta > 0) or bottom (delta < 0)
  let idx = current
  if (idx < 0 || idx >= hits.length) {
    idx = delta > 0 ? -1 : hits.length
  }

  // Step in the given direction, skipping disabled commands
  const step = delta > 0 ? 1 : -1
  const steps = Math.abs(delta)

  let moved = 0
  while (moved < steps) {
    let nextIdx = idx + step
    // Clamp at boundaries
    if (nextIdx < 0 || nextIdx >= hits.length) break
    // Find next enabled
    while (nextIdx >= 0 && nextIdx < hits.length && hits[nextIdx].command.enabled === false) {
      nextIdx += step
    }
    if (nextIdx < 0 || nextIdx >= hits.length) break
    idx = nextIdx
    moved++
  }

  // If we never moved and current points at a disabled command, find nearest enabled
  if (idx === current && idx >= 0 && idx < hits.length && hits[idx].command.enabled === false) {
    // Search forward first, then backward
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].command.enabled !== false) return i
    }
    return -1
  }

  // If idx is still out of bounds (e.g. started at -1 with delta 0), find first enabled
  if (idx < 0 || idx >= hits.length) {
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].command.enabled !== false) return i
    }
    return -1
  }

  return idx
}
