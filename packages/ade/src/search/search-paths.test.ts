import { describe, expect, test } from "bun:test"
import { searchPaths } from "./find"
import { deserializeKinds, toggleKind } from "../sidebar/storage"

const ROOT = "C:/Users/me/Favorites/nikcli"
const entries = [
  { path: `${ROOT}/packages/ade/src/grid`, kind: "directory" as const },
  { path: `${ROOT}/packages/ade/src/grid/pane.tsx`, kind: "file" as const },
  { path: `${ROOT}/packages/ade/src/surface/pane-renderer.tsx`, kind: "file" as const },
  { path: `${ROOT}/packages/ade/src/sidebar/sidebar.tsx`, kind: "file" as const },
  { path: `${ROOT}/packages/ade/src/sidebar`, kind: "directory" as const },
  { path: `${ROOT}/README.md`, kind: "file" as const },
]

describe("searchPaths", () => {
  test("the project's own folders above the root never match", () => {
    // "users" is in every absolute path; relative to the project it is nowhere.
    expect(searchPaths(entries, "users", { root: ROOT })).toEqual([])
  })

  test("an exact name comes first and the match is highlighted inside it", () => {
    const hits = searchPaths(entries, "pane", { root: ROOT })
    expect(hits[0]!.rel).toBe("packages/ade/src/grid/pane.tsx")
    const [start, end] = hits[0]!.ranges.at(-1)!
    expect(hits[0]!.rel.slice(start, end)).toBe("pane")
  })

  test("every word has to match, in any order", () => {
    expect(searchPaths(entries, "tsx sidebar", { root: ROOT }).map((h) => h.rel)).toEqual([
      "packages/ade/src/sidebar/sidebar.tsx",
    ])
  })

  test("a word with a slash is matched against the path", () => {
    expect(searchPaths(entries, "grid/pane", { root: ROOT }).map((h) => h.rel)).toEqual([
      "packages/ade/src/grid/pane.tsx",
    ])
  })

  test("folders are found, and the filter keeps only the kinds asked for", () => {
    const dirs = searchPaths(entries, "sidebar", { root: ROOT, kinds: new Set(["directory"]) })
    expect(dirs.map((h) => [h.rel, h.kind])).toEqual([["packages/ade/src/sidebar", "directory"]])
    const files = searchPaths(entries, "sidebar", { root: ROOT, kinds: new Set(["file"]) })
    expect(files.every((h) => h.kind === "file")).toBe(true)
  })

  test("Windows separators in the root still make the path relative", () => {
    expect(searchPaths(entries, "readme", { root: "C:\\Users\\me\\Favorites\\nikcli\\" })[0]!.rel).toBe("README.md")
  })
})

describe("search kinds", () => {
  test("both kinds by default, and garbage reads as the default", () => {
    expect([...deserializeKinds(null)].sort()).toEqual(["directory", "file"])
    expect([...deserializeKinds("nonsense")].sort()).toEqual(["directory", "file"])
    expect([...deserializeKinds("directory")]).toEqual(["directory"])
  })

  test("the last chip cannot be turned off: the other one comes on instead", () => {
    expect([...toggleKind(new Set(["file", "directory"]), "file")]).toEqual(["directory"])
    expect([...toggleKind(new Set(["directory"]), "directory")]).toEqual(["file"])
  })
})
