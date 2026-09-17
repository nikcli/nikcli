import { describe, expect, test } from "bun:test"
import {
  countSessions,
  defaultOpenSections,
  deserializeSections,
  scrollingSection,
  serializeSections,
  statPills,
  toggleSection,
  type SectionId,
} from "./sections"
import type { Workspace } from "./workspace-tree"

const open = (...ids: SectionId[]) => new Set<SectionId>(ids)

const ws = (...statuses: Workspace["sessions"][number]["status"][]): Workspace => ({
  id: "w",
  name: "w",
  sessions: statuses.map((status, i) => ({ id: `s${i}`, title: `s${i}`, status })),
})

describe("scrollingSection", () => {
  test("the file tree takes the squeeze when it is open", () => {
    expect(scrollingSection(open("progetti", "file"))).toBe("file")
    expect(scrollingSection(open("file"))).toBe("file")
  })

  test("the project list takes it only when the file tree is shut", () => {
    expect(scrollingSection(open("progetti"))).toBe("progetti")
  })

  test("with everything shut, nothing scrolls", () => {
    // The regression this guards is the reason the file exists: a section
    // holding height it is not using is what produced 400px of nothing
    // between the project list and the file tree.
    expect(scrollingSection(open())).toBeUndefined()
  })
})

describe("open/closed state", () => {
  test("all sections start open", () => {
    expect([...defaultOpenSections()].sort()).toEqual(["agenti", "file", "progetti"])
  })

  test("toggling is symmetric and does not mutate the input", () => {
    const before = open("progetti", "agenti", "file")
    const after = toggleSection(before, "file")
    expect(after.has("file")).toBe(false)
    expect(before.has("file")).toBe(true)
    expect(toggleSection(after, "file").has("file")).toBe(true)
  })

  test("a round trip through storage keeps the set", () => {
    const set = open("file", "agenti")
    expect(deserializeSections(serializeSections(set))).toEqual(set)
  })

  test("nothing stored means a first run, so all open", () => {
    expect([...deserializeSections(null)].sort()).toEqual(["agenti", "file", "progetti"])
    expect([...deserializeSections(undefined)].sort()).toEqual(["agenti", "file", "progetti"])
  })

  test("spaces is accepted as alias for progetti", () => {
    expect([...deserializeSections("spaces,file")].sort()).toEqual(["file", "progetti"])
  })

  test("an empty string means the user closed both, and stays that way", () => {
    // Distinct from "nothing stored". Conflating them makes the sidebar
    // reopen itself on every reload, undoing the user's choice silently.
    expect(deserializeSections("").size).toBe(0)
  })

  test("junk in storage is ignored rather than trusted", () => {
    expect([...deserializeSections("file,qualcosa,__proto__")]).toEqual(["file"])
  })
})

describe("countSessions", () => {
  test("counts provisioning as working, because it is", () => {
    expect(countSessions([ws("provisioning", "working")])).toEqual({ working: 2, waiting: 0, error: 0 })
  })

  test("done sessions are in no bucket", () => {
    expect(countSessions([ws("done", "done")])).toEqual({ working: 0, waiting: 0, error: 0 })
  })

  test("adds up across projects", () => {
    expect(countSessions([ws("working"), ws("waiting", "error")])).toEqual({ working: 1, waiting: 1, error: 1 })
  })

  test("no projects is all zero, not a crash", () => {
    expect(countSessions([])).toEqual({ working: 0, waiting: 0, error: 0 })
  })
})

describe("statPills", () => {
  test("a quiet workbench shows nothing at all", () => {
    // The old header spent a permanent row on three zeroes — a line of a
    // 260px column used to report the absence of news.
    expect(statPills({ working: 0, waiting: 0, error: 0 })).toEqual([])
  })

  test("only the non-zero counts appear, in severity order", () => {
    expect(statPills({ working: 2, waiting: 0, error: 1 }).map((p) => p.tone)).toEqual(["working", "error"])
  })

  test("each pill carries its count and a word", () => {
    const [pill] = statPills({ working: 3, waiting: 0, error: 0 })
    expect(pill.count).toBe(3)
    expect(pill.label).toBe("lavora")
  })
})
