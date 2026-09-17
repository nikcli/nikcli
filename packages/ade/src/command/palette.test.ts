import { describe, it, expect } from "bun:test"
import { type CommandHit } from "./registry"
/*
 * The real function, not a copy of it.
 *
 * This file used to define its own `groupHits` and test that, with a comment
 * explaining that `palette.tsx` could not be imported under bun test. That is
 * true, and the answer is to keep the function out of the component: it now
 * lives in `group-hits.ts`, which both the palette and this file import. A
 * regression in the palette's grouping now fails here, which is the only
 * reason to have this test at all.
 */
import { groupHits } from "./group-hits"

describe("groupHits", () => {
  it("groups hits sequentially, preserving relative order", () => {
    const hits: CommandHit[] = [
      { command: { id: "1", title: "A", group: "G1" }, score: 0, titleRanges: [], groupRanges: [] },
      { command: { id: "2", title: "B", group: "G2" }, score: 0, titleRanges: [], groupRanges: [] },
      { command: { id: "3", title: "C", group: "G1" }, score: 0, titleRanges: [], groupRanges: [] },
      { command: { id: "4", title: "D", group: "G3" }, score: 0, titleRanges: [], groupRanges: [] },
      { command: { id: "5", title: "E", group: "G2" }, score: 0, titleRanges: [], groupRanges: [] },
    ]
    
    const groups = groupHits(hits)
    
    expect(groups).toHaveLength(3)
    
    expect(groups[0].name).toBe("G1")
    expect(groups[0].hits.map(h => h.hit.command.id)).toEqual(["1", "3"])
    expect(groups[0].hits.map(h => h.index)).toEqual([0, 2])
    
    expect(groups[1].name).toBe("G2")
    expect(groups[1].hits.map(h => h.hit.command.id)).toEqual(["2", "5"])
    expect(groups[1].hits.map(h => h.index)).toEqual([1, 4])
    
    expect(groups[2].name).toBe("G3")
    expect(groups[2].hits.map(h => h.hit.command.id)).toEqual(["4"])
    expect(groups[2].hits.map(h => h.index)).toEqual([3])
  })
})

/*
 * What this file deliberately does not cover.
 *
 * Two defects in `palette.tsx` were reactive rather than computational: the
 * open effect read `props.commands`, which is rebuilt on every line an agent
 * prints, so `setQuery("")` wiped what the user was typing several times a
 * second; and the selection effect reran on the same signal, so ArrowDown
 * kept snapping back to the first row. Both are fixed with `on(query, …)`,
 * `on(() => props.open, …)` and an `untrack` around the initial list.
 *
 * Neither can be asserted here. The effects are declared inside the component,
 * and a `.tsx` has no automatic JSX runtime under `bun test` in this repo — so
 * the palette cannot be imported at all. The one way to "test" it would be to
 * re-declare the same effects over local signals and watch those, which is
 * what the old `groupHits` copy above did and what made 721 green tests miss
 * every one of these. The gap is named instead of faked; see the manual check
 * in the plan (type while an agent streams output, the query must survive).
 */
