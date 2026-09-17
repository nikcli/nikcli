import type { DirEntry } from "../host/shell"
import { normalizePath, pathEquals } from "../host/path"
import { type FileNode, compareFileNodes } from "./file-tree"

const DEFAULT_IGNORES = new Set(["node_modules", ".git", "dist", "target", ".ade-trees"])

export interface FsTreeState {
  rootNode?: FileNode
  showHidden: boolean
}

export function isHidden(name: string): boolean {
  return DEFAULT_IGNORES.has(name)
}

export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) {
      return a.is_dir ? -1 : 1
    }
    return a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true })
  })
}

export function filterEntries(entries: DirEntry[], showHidden: boolean): DirEntry[] {
  if (showHidden) return entries
  return entries.filter((e) => !isHidden(e.name))
}

export function dirEntriesToNodes(entries: DirEntry[], showHidden: boolean): FileNode[] {
  const filtered = filterEntries(entries, showHidden)
  const sorted = sortEntries(filtered)
  return sorted.map((e) => {
    const p = normalizePath(e.path)
    return {
      id: p,
      name: e.name,
      path: p,
      kind: e.is_dir ? "directory" : "file",
      size: e.size,
    }
  })
}

export function mergeChildren(root: FileNode, parentPath: string, entries: DirEntry[], showHidden: boolean): FileNode {
  if (pathEquals(root.path, parentPath)) {
    // Merge keeping existing children (if already expanded) to preserve their expanded state
    const newChildrenNodes = dirEntriesToNodes(entries, showHidden)
    const existingChildrenMap = new Map(root.children?.map((c) => [normalizePath(c.path).toLowerCase(), c]))

    const mergedChildren = newChildrenNodes.map((newNode) => {
      const existing = existingChildrenMap.get(newNode.path.toLowerCase())
      if (existing) {
        return {
          ...newNode,
          children: existing.children,
        }
      }
      return newNode
    })

    return {
      ...root,
      children: mergedChildren,
    }
  }

  if (root.kind === "directory" && root.children) {
    let changed = false
    const newChildren = root.children.map((child) => {
      if (child.kind === "directory") {
        const newChild = mergeChildren(child, parentPath, entries, showHidden)
        if (newChild !== child) {
          changed = true
          return newChild
        }
      }
      return child
    })
    if (changed) {
      return { ...root, children: newChildren }
    }
  }

  return root
}

export function markDirectoryError(root: FileNode, parentPath: string): FileNode {
  if (pathEquals(root.path, parentPath)) {
    // If it's an error, we can just mark it empty to stop loading
    return { ...root, children: [] }
  }

  if (root.kind === "directory" && root.children) {
    let changed = false
    const newChildren = root.children.map((child) => {
      if (child.kind === "directory") {
        const newChild = markDirectoryError(child, parentPath)
        if (newChild !== child) {
          changed = true
          return newChild
        }
      }
      return child
    })
    if (changed) {
      return { ...root, children: newChildren }
    }
  }

  return root
}
