import { describe, expect, test } from "bun:test"
import {
  type FileNode,
  collectDirectoryPaths,
  compareFileNodes,
  expandDirectoryParents,
  findFileNodeByPath,
  flattenFileTree,
  isDirectoryExpanded,
  sortFileNodes,
  toggleDirectoryExpansion,
} from "./file-tree"

const SAMPLE_TREE: FileNode[] = [
  { id: "f-root-1", name: "package.json", path: "package.json", kind: "file" },
  {
    id: "d-src",
    name: "src",
    path: "src",
    kind: "directory",
    children: [
      { id: "f-index", name: "index.ts", path: "src/index.ts", kind: "file" },
      {
        id: "d-grid",
        name: "grid",
        path: "src/grid",
        kind: "directory",
        children: [
          { id: "f-pane", name: "pane.tsx", path: "src/grid/pane.tsx", kind: "file" },
          { id: "f-layout", name: "layout.ts", path: "src/grid/layout.ts", kind: "file" },
        ],
      },
    ],
  },
  { id: "f-readme", name: "README.md", path: "README.md", kind: "file" },
]

describe("sortFileNodes", () => {
  test("places directories ahead of files and sorts alphabetically", () => {
    const unsorted: FileNode[] = [
      { id: "1", name: "zebra.txt", path: "zebra.txt", kind: "file" },
      { id: "2", name: "beta-dir", path: "beta-dir", kind: "directory" },
      { id: "3", name: "alpha-dir", path: "alpha-dir", kind: "directory" },
      { id: "4", name: "apple.txt", path: "apple.txt", kind: "file" },
    ]

    const sorted = sortFileNodes(unsorted)
    expect(sorted.map((n) => n.name)).toEqual(["alpha-dir", "beta-dir", "apple.txt", "zebra.txt"])
  })

  test("sorts recursively inside nested directories", () => {
    const tree: FileNode[] = [
      {
        id: "d1",
        name: "parent",
        path: "parent",
        kind: "directory",
        children: [
          { id: "f2", name: "b.txt", path: "parent/b.txt", kind: "file" },
          { id: "f1", name: "a.txt", path: "parent/a.txt", kind: "file" },
          { id: "d2", name: "sub", path: "parent/sub", kind: "directory" },
        ],
      },
    ]

    const sorted = sortFileNodes(tree)
    expect(sorted[0].children?.map((n) => n.name)).toEqual(["sub", "a.txt", "b.txt"])
  })
})

describe("toggleDirectoryExpansion and isDirectoryExpanded", () => {
  test("toggles expansion state immutably", () => {
    const initial = new Set(["src"])
    const added = toggleDirectoryExpansion(initial, "src/grid")
    expect(isDirectoryExpanded(added, "src/grid")).toBe(true)
    expect(isDirectoryExpanded(added, "src")).toBe(true)
    expect(isDirectoryExpanded(initial, "src/grid")).toBe(false)

    const removed = toggleDirectoryExpansion(added, "src")
    expect(isDirectoryExpanded(removed, "src")).toBe(false)
    expect(isDirectoryExpanded(removed, "src/grid")).toBe(true)
  })
})

describe("expandDirectoryParents", () => {
  test("expands all ancestor directories leading to a deeply nested file", () => {
    const initial = new Set<string>()
    const expanded = expandDirectoryParents("packages/ade/src/grid/pane.tsx", initial)

    expect(Array.from(expanded).sort()).toEqual([
      "packages",
      "packages/ade",
      "packages/ade/src",
      "packages/ade/src/grid",
    ])
  })

  test("does nothing for root-level files", () => {
    const initial = new Set(["existing"])
    const result = expandDirectoryParents("README.md", initial)
    expect(Array.from(result)).toEqual(["existing"])
  })

  /*
   * The tree holds whatever paths the host handed back, and outside this repo
   * those are absolute. Rebuilding the ancestors from `split().filter(Boolean)`
   * dropped the leading empty segment of a POSIX path and glued a drive letter
   * to the next name, so every path produced here was one the tree could never
   * contain — the reveal silently expanded nothing.
   */
  test("keeps the leading slash of an absolute POSIX path", () => {
    const expanded = expandDirectoryParents("/home/ale/progetti/ade/src/main.ts", new Set<string>())
    expect(Array.from(expanded).sort()).toEqual([
      "/home",
      "/home/ale",
      "/home/ale/progetti",
      "/home/ale/progetti/ade",
      "/home/ale/progetti/ade/src",
    ])
  })

  test("keeps the drive of a Windows path, and stops at its root", () => {
    const expanded = expandDirectoryParents("C:\\Users\\39349\\nikcli\\src\\main.ts", new Set<string>())
    expect(Array.from(expanded).sort()).toEqual([
      "C:/Users",
      "C:/Users/39349",
      "C:/Users/39349/nikcli",
      "C:/Users/39349/nikcli/src",
    ])
  })

  test("a file sitting directly on a root expands nothing", () => {
    expect(Array.from(expandDirectoryParents("/README.md", new Set<string>()))).toEqual([])
    expect(Array.from(expandDirectoryParents("C:\\README.md", new Set<string>()))).toEqual([])
  })
})

describe("flattenFileTree", () => {
  test("returns top-level items when all directories are collapsed", () => {
    const flat = flattenFileTree(SAMPLE_TREE, new Set())
    // 1 directory (src) + 2 files (package.json, README.md) = 3 rows
    expect(flat.length).toBe(3)
    expect(flat[0].path).toBe("src")
    expect(flat[0].kind).toBe("directory")
    expect(flat[0].isExpanded).toBe(false)
    expect(flat[0].depth).toBe(0)
    expect(flat[1].path).toBe("package.json")
    expect(flat[2].path).toBe("README.md")
  })

  test("includes children at correct depth when directory is expanded", () => {
    const expanded = new Set(["src", "src/grid"])
    const flat = flattenFileTree(SAMPLE_TREE, expanded, "src/grid/pane.tsx")

    // Expected order:
    // src (dir, depth 0)
    //   grid (dir, depth 1)
    //     layout.ts (file, depth 2)
    //     pane.tsx (file, depth 2, selected: true)
    //   index.ts (file, depth 1)
    // package.json (file, depth 0)
    // README.md (file, depth 0)

    expect(flat.map((n) => ({ path: n.path, depth: n.depth }))).toEqual([
      { path: "src", depth: 0 },
      { path: "src/grid", depth: 1 },
      { path: "src/grid/layout.ts", depth: 2 },
      { path: "src/grid/pane.tsx", depth: 2 },
      { path: "src/index.ts", depth: 1 },
      { path: "package.json", depth: 0 },
      { path: "README.md", depth: 0 },
    ])

    const selectedNode = flat.find((n) => n.path === "src/grid/pane.tsx")
    expect(selectedNode?.isSelected).toBe(true)

    const unselectedNode = flat.find((n) => n.path === "src/grid/layout.ts")
    expect(unselectedNode?.isSelected).toBe(false)
  })

  test("handles empty tree cleanly", () => {
    expect(flattenFileTree([], new Set())).toEqual([])
  })
})

describe("Defect 3: flattenFileTree performance and shallow sorting", () => {
  test("Defect 3: does not sort collapsed subtrees and sorts visible levels only once", () => {
    let collapsedAccessCount = 0
    let expandedAccessCount = 0

    const tree: FileNode[] = [
      {
        id: "d-collapsed",
        name: "collapsed-dir",
        path: "collapsed-dir",
        kind: "directory",
        children: [
          {
            id: "f-c1",
            get name() {
              collapsedAccessCount++
              return "c1.txt"
            },
            path: "collapsed-dir/c1.txt",
            kind: "file",
          },
          {
            id: "f-c2",
            get name() {
              collapsedAccessCount++
              return "c2.txt"
            },
            path: "collapsed-dir/c2.txt",
            kind: "file",
          },
        ],
      },
      {
        id: "d-expanded",
        name: "expanded-dir",
        path: "expanded-dir",
        kind: "directory",
        children: [
          {
            id: "f-e1",
            get name() {
              expandedAccessCount++
              return "e1.txt"
            },
            path: "expanded-dir/e1.txt",
            kind: "file",
          },
          {
            id: "f-e2",
            get name() {
              expandedAccessCount++
              return "e2.txt"
            },
            path: "expanded-dir/e2.txt",
            kind: "file",
          },
        ],
      },
    ]

    // Flatten with only "expanded-dir" expanded
    const flat = flattenFileTree(tree, new Set(["expanded-dir"]))

    // Collapsed directory children must NEVER have been sorted/accessed
    expect(collapsedAccessCount).toBe(0)
    // Expanded directory children should be accessed for sorting at their own level
    expect(expandedAccessCount).toBeGreaterThan(0)
    expect(flat.map((n) => n.path)).toEqual([
      "collapsed-dir",
      "expanded-dir",
      "expanded-dir/e1.txt",
      "expanded-dir/e2.txt",
    ])
  })
})
// Defect 5: the pinned "en" locale cannot be observed by a pure I/O assertion on an English or
// Italian host, where unpinned collation agrees with "en". It can still be guarded: assert the
// comparator follows an explicit "en" collator for a pair whose order is locale-dependent. This
// passes here and fails on a runner whose system locale disagrees (Swedish, Turkish) - which is
// exactly the machine the pin exists to protect.
describe("Defect 5: sortFileNodes pinned locale", () => {
  const file = (name: string): FileNode => ({ id: name, name, path: name, kind: "file" })

  test("Defect 5: the pinned locale is not decorative - collations really do disagree", () => {
    // If this ever stops holding, the pin is pointless and the guard below is dead weight.
    expect(Math.sign("ä".localeCompare("z", "sv"))).not.toBe(Math.sign("ä".localeCompare("z", "en")))
  })

  test("Defect 5: compareFileNodes follows 'en' collation, not the host locale", () => {
    const expected = Math.sign("ä".localeCompare("z", "en"))
    expect(Math.sign(compareFileNodes(file("ä.txt"), file("z.txt")))).toBe(expected)
    expect(sortFileNodes([file("z.txt"), file("ä.txt")]).map((n) => n.name)).toEqual(["ä.txt", "z.txt"])
  })
})

describe("Defect 6: hasChildren computation", () => {
  test("Defect 6: computes hasChildren accurately for empty and non-empty directories", () => {
    const tree: FileNode[] = [
      {
        id: "d-empty",
        name: "empty-dir",
        path: "empty-dir",
        kind: "directory",
        children: [],
      },
      {
        id: "d-no-children-prop",
        name: "no-children-prop",
        path: "no-children-prop",
        kind: "directory",
      },
      {
        id: "d-with-children",
        name: "with-children",
        path: "with-children",
        kind: "directory",
        children: [{ id: "f1", name: "file.txt", path: "with-children/file.txt", kind: "file" }],
      },
      {
        id: "f-root",
        name: "root.txt",
        path: "root.txt",
        kind: "file",
      },
    ]

    const flat = flattenFileTree(tree, new Set(["empty-dir", "with-children"]))
    const emptyDir = flat.find((n) => n.id === "d-empty")
    const noChildrenDir = flat.find((n) => n.id === "d-no-children-prop")
    const withChildrenDir = flat.find((n) => n.id === "d-with-children")
    const rootFile = flat.find((n) => n.id === "f-root")

    expect(emptyDir?.hasChildren).toBe(false)
    // Not read yet, so it may hold anything: it has to stay expandable.
    expect(noChildrenDir?.hasChildren).toBe(true)
    expect(withChildrenDir?.hasChildren).toBe(true)
    expect(rootFile?.hasChildren).toBe(false)
  })
})

describe("Defect 8: expandDirectoryParents with Windows backslashes", () => {
  test("Defect 8: expands parent directories for Windows backslash and mixed separator paths", () => {
    const initial = new Set<string>()
    const windowsExpanded = expandDirectoryParents("packages\\ade\\src\\grid\\pane.tsx", initial)
    expect(Array.from(windowsExpanded).sort()).toEqual([
      "packages",
      "packages/ade",
      "packages/ade/src",
      "packages/ade/src/grid",
    ])

    const mixedExpanded = expandDirectoryParents("packages/ade\\src/grid\\pane.tsx", initial)
    expect(Array.from(mixedExpanded).sort()).toEqual([
      "packages",
      "packages/ade",
      "packages/ade/src",
      "packages/ade/src/grid",
    ])
  })
})

describe("findFileNodeByPath and collectDirectoryPaths", () => {
  test("finds nodes anywhere in the hierarchy", () => {
    expect(findFileNodeByPath(SAMPLE_TREE, "src/grid/pane.tsx")?.name).toBe("pane.tsx")
    expect(findFileNodeByPath(SAMPLE_TREE, "README.md")?.name).toBe("README.md")
    expect(findFileNodeByPath(SAMPLE_TREE, "non/existent.ts")).toBeUndefined()
  })

  test("collects all directory paths in the tree", () => {
    const dirs = collectDirectoryPaths(SAMPLE_TREE)
    expect(dirs.sort()).toEqual(["src", "src/grid"])
  })
})
