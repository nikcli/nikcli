/**
 * Grouping palette results by the section they belong to.
 *
 * Its own `.ts` module rather than a function inside `palette.tsx`, because a
 * `.tsx` cannot be imported by a test in this package: bun test has no
 * automatic JSX runtime here. The previous arrangement was a copy of this
 * function pasted into `palette.test.ts`, with a comment explaining why — so
 * the tests were green about a second implementation, and a regression in the
 * one the palette actually calls would not have failed anything.
 */
import type { CommandHit } from "./registry"

export interface GroupedHits {
  name: string
  hits: { hit: CommandHit; index: number }[]
}

/**
 * Groups hits by `command.group`, keeping both the order the groups first
 * appear in and the order of hits inside each one.
 *
 * `index` is the position in the original flat list, not in the group: it is
 * what the keyboard moves through and what `data-index` has to carry, so
 * renumbering per group would break the selection.
 */
export function groupHits(hits: CommandHit[]): GroupedHits[] {
  const result: GroupedHits[] = []
  const groupMap = new Map<string, number>()

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    const gName = hit.command.group
    let gIdx = groupMap.get(gName)
    if (gIdx === undefined) {
      gIdx = result.length
      groupMap.set(gName, gIdx)
      result.push({ name: gName, hits: [] })
    }
    result[gIdx].hits.push({ hit, index: i })
  }
  return result
}
