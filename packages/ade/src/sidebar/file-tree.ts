/**
 * Pure models, sorting, and tree-flattening for the IDE-style file browser.
 *
 * Directories and files are presented in standard IDE alphabetical hierarchy:
 * directories always sort before files, and children are indented with guide
 * lines when their parent directory is expanded.
 */

import { dirname, normalizePath } from "../host/path"

export type FileNodeKind = "file" | "directory"

export interface FileNode {
  id: string
  name: string
  path: string
  kind: FileNodeKind
  children?: FileNode[]
  size?: number
}

export interface FlatFileNode {
  id: string
  name: string
  path: string
  kind: FileNodeKind
  depth: number
  isExpanded: boolean
  hasChildren: boolean
  isSelected: boolean
  parentPath?: string
}

/**
 * Toggles a directory's expanded state, returning a new immutable Set.
 */
export function toggleDirectoryExpansion(expanded: ReadonlySet<string>, dirPath: string): Set<string> {
  const next = new Set(expanded)
  if (next.has(dirPath)) {
    next.delete(dirPath)
  } else {
    next.add(dirPath)
  }
  return next
}

/**
 * Checks whether a directory path is marked as expanded.
 */
export function isDirectoryExpanded(expanded: ReadonlySet<string>, dirPath: string): boolean {
  return expanded.has(dirPath)
}

/**
 * Ensures all parent directory paths leading to `targetPath` are added to the expanded set.
 *
 * Used when revealing an active or newly opened file in the tree so the user
 * can see where the selection sits inside the project hierarchy.
 * Handles both POSIX and Windows path separators.
 *
 * The ancestors are peeled off the normalised path with `dirname` rather than
 * rebuilt from its segments. Rebuilding dropped the root — `filter(Boolean)`
 * eats the empty first segment of `/home/x`, and a drive letter came back as
 * `C:` joined to the next name with a slash it never had — so the paths this
 * produced matched nothing in the tree, and `deriveDefaultExpandedDirs` sat
 * there expanding directories that did not exist.
 */
export function expandDirectoryParents(targetPath: string, expanded: ReadonlySet<string>): Set<string> {
  const next = new Set(expanded)
  let current = dirname(normalizePath(targetPath))

  // `dirname` is a fixed point at every root — `/`, `C:/`, `.` — which is what
  // ends the walk, and the root itself is not a directory the tree can expand.
  while (current !== "." && current !== "/" && !/^[A-Za-z]:\/$/.test(current)) {
    next.add(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return next
}

/**
 * Compares two file nodes using standard IDE ordering:
 * 1. Directories before files.
 * 2. Case-insensitive alphabetical sorting within the same kind using pinned "en" locale.
 */
export function compareFileNodes(a: FileNode, b: FileNode): number {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1
  }
  // Pin "en" locale for deterministic ordering across different machines/environments
  return a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true })
}

/**
 * Sorts file tree nodes using standard IDE ordering:
 * 1. Directories before files.
 * 2. Case-insensitive alphabetical sorting within the same kind.
 * Recursively sorts all nested children.
 */
export function sortFileNodes(nodes: readonly FileNode[]): FileNode[] {
  return [...nodes].sort(compareFileNodes).map((node) => {
    if (node.kind === "directory" && node.children) {
      return {
        ...node,
        children: sortFileNodes(node.children),
      }
    }
    return node
  })
}

/**
 * Flattens the hierarchical file tree into a 1D list of visible items based on
 * directory expansion state.
 *
 * Each item carries its nesting depth and parent reference, allowing the
 * component to render vertical indentation guide lines without recursive DOM.
 * Only visible levels are sorted shallowly, avoiding redundant sorting of collapsed subtrees.
 */
export function flattenFileTree(
  nodes: readonly FileNode[],
  expanded: ReadonlySet<string>,
  selectedPath?: string,
  depth = 0,
  parentPath?: string,
): FlatFileNode[] {
  // Sort only the immediate level shallowly; do not recurse into collapsed subtrees
  const sorted = [...nodes].sort(compareFileNodes)
  const result: FlatFileNode[] = []

  for (const node of sorted) {
    const isDir = node.kind === "directory"
    /*
     * A directory whose children were never read may hold anything.
     *
     * The tree is loaded one level at a time, so every subdirectory arrives
     * with `children` undefined. Counting that as "empty" hid the chevron and
     * made the click do nothing — no subfolder could ever be opened. Only a
     * directory that was read and found empty has nothing to expand.
     */
    const hasChildren = isDir && (node.children === undefined || node.children.length > 0)
    const isExpanded = isDir && expanded.has(node.path)
    const isSelected = node.path === selectedPath

    result.push({
      id: node.id,
      name: node.name,
      path: node.path,
      kind: node.kind,
      depth,
      isExpanded,
      hasChildren,
      isSelected,
      parentPath,
    })

    if (isDir && isExpanded && node.children && node.children.length > 0) {
      result.push(...flattenFileTree(node.children, expanded, selectedPath, depth + 1, node.path))
    }
  }

  return result
}

/**
 * Recursively locates a node by its full path.
 */
export function findFileNodeByPath(nodes: readonly FileNode[], targetPath: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.path === targetPath) return node
    if (node.kind === "directory" && node.children) {
      const found = findFileNodeByPath(node.children, targetPath)
      if (found) return found
    }
  }
  return undefined
}

/**
 * Collects all directory paths in the tree.
 */
export function collectDirectoryPaths(nodes: readonly FileNode[]): string[] {
  const paths: string[] = []
  for (const node of nodes) {
    if (node.kind === "directory") {
      paths.push(node.path)
      if (node.children) {
        paths.push(...collectDirectoryPaths(node.children))
      }
    }
  }
  return paths
}

/**
 * Derives default expanded directory paths from the provided file tree and selected path.
 *
 * Ensures that top-level directories and any ancestor directories leading to the
 * selected file are visible upon first launch when no stored preferences exist.
 */
export function deriveDefaultExpandedDirs(files?: readonly FileNode[], selectedFilePath?: string): string[] {
  const topDirs = (files ?? []).filter((f) => f.kind === "directory").map((f) => f.path)
  const fallback = topDirs.length > 0 ? topDirs : ["packages", "src"]
  const initial = new Set(fallback)

  if (selectedFilePath) {
    const revealed = expandDirectoryParents(selectedFilePath, initial)
    return Array.from(revealed)
  }

  return Array.from(initial)
}
