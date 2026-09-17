import { describe, it, expect } from "bun:test"
import { addRecent, removeRecent, serializeRecents, parseRecents, type RecentEntry } from "./recent"

const entry = (root: string, name?: string): Omit<RecentEntry, "openedAt"> => ({
  root,
  name: name ?? root.split("/").pop()!,
})

describe("addRecent", () => {
  it("adds to empty list", () => {
    const list = addRecent([], entry("C:/a"))
    expect(list).toHaveLength(1)
    expect(list[0].root).toBe("C:/a")
  })

  it("moves existing entry to front", () => {
    const old: RecentEntry[] = [
      { root: "C:/a", name: "a", openedAt: 1 },
      { root: "C:/b", name: "b", openedAt: 2 },
    ]
    const list = addRecent(old, entry("C:/b"))
    expect(list).toHaveLength(2)
    expect(list[0].root).toBe("C:/b")
  })

  it("deduplicates case-insensitively", () => {
    const old: RecentEntry[] = [{ root: "C:/Repo", name: "Repo", openedAt: 1 }]
    const list = addRecent(old, entry("c:/repo", "repo"))
    expect(list).toHaveLength(1)
  })

  /*
   * The doc said "normalised" and the code only lower-cased. On Windows the
   * same project opened once from the sidebar and once from a shell path
   * became two rows pointing at one directory, each with its own "last
   * opened" time.
   */
  it("deduplicates across separators and a trailing slash", () => {
    const old: RecentEntry[] = [{ root: "C:/Users/x/repo", name: "repo", openedAt: 1 }]
    expect(addRecent(old, entry("C:\\Users\\x\\repo", "repo"))).toHaveLength(1)
    expect(addRecent(old, entry("C:/Users/x/repo/", "repo"))).toHaveLength(1)
    expect(removeRecent(old, "C:\\Users\\x\\repo")).toHaveLength(0)
  })

  it("respects the limit", () => {
    const old: RecentEntry[] = Array.from({ length: 5 }, (_, i) => ({
      root: `C:/${i}`,
      name: `${i}`,
      openedAt: i,
    }))
    const list = addRecent(old, entry("C:/new"), 3)
    expect(list).toHaveLength(3)
    expect(list[0].root).toBe("C:/new")
  })
})

describe("removeRecent", () => {
  it("removes by root", () => {
    const old: RecentEntry[] = [
      { root: "C:/a", name: "a", openedAt: 1 },
      { root: "C:/b", name: "b", openedAt: 2 },
    ]
    expect(removeRecent(old, "C:/a")).toHaveLength(1)
  })

  it("is case-insensitive", () => {
    const old: RecentEntry[] = [{ root: "C:/Repo", name: "Repo", openedAt: 1 }]
    expect(removeRecent(old, "c:/repo")).toHaveLength(0)
  })
})

describe("serialize / parse round-trip", () => {
  it("survives a round-trip", () => {
    const list: RecentEntry[] = [{ root: "C:/a", name: "a", openedAt: 42 }]
    const json = serializeRecents(list)
    const back = parseRecents(json)
    expect(back).toEqual(list)
  })

  it("returns [] on corrupt JSON", () => {
    expect(parseRecents("not json")).toEqual([])
  })

  it("returns [] when JSON is valid but not an array", () => {
    expect(parseRecents('{"a":1}')).toEqual([])
  })

  it("filters out malformed entries", () => {
    const json = JSON.stringify([{ root: "C:/a", name: "a", openedAt: 1 }, { root: 123 }, null])
    const list = parseRecents(json)
    expect(list).toHaveLength(1)
    expect(list[0].root).toBe("C:/a")
  })
})
