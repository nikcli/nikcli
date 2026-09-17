import type { Host, DirEntry } from "../host/shell"
import { normalizePath, joinPath, dirname } from "../host/path"

/**
 * Directories skipped by default during project traversal.
 * Heavy build artifacts, metadata, and dependencies that should not clutter search.
 */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".ade-trees",
  ".next",
  ".turbo",
  "coverage",
  ".cargo-ade",
  ".ade-webview",
  ".scratch",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".output",
  ".nuxt",
  ".svelte-kit",
  "out",
  ".parcel-cache",
  ".idea",
  ".vscode",
  "tmp",
  "temp",
])

export const DEFAULT_WALK_LIMIT = 20_000

export interface WalkOptions {
  /** Directory da non aprire mai. */
  skipDirs?: ReadonlySet<string>
  /** Numero massimo di file da restituire prima di fermarsi. */
  limit?: number
  /** Profondità massima, contando la radice come 0. */
  maxDepth?: number
}

export interface WalkResult {
  files: string[]
  dirs?: string[]
  /** Vero quando la camminata si è fermata per un limite, non perché finita. */
  stopped: boolean
}

/**
 * Traverses a project directory tree in breadth-first order (BFS).
 * Files close to the root are discovered first as they are most frequently targeted.
 */
export async function walkProject(input: { host: Host; root: string; options?: WalkOptions }): Promise<WalkResult> {
  const host = input.host
  const root = normalizePath(input.root)
  const limit = input.options?.limit ?? DEFAULT_WALK_LIMIT
  const maxDepth = input.options?.maxDepth
  const skipDirs = input.options?.skipDirs ?? DEFAULT_SKIP_DIRS

  if (limit <= 0) {
    return { files: [], dirs: [], stopped: true }
  }

  // Fast path: use git ls-files if available and not explicitly using custom skipDirs/maxDepth
  if (host.run && !input.options?.skipDirs && maxDepth === undefined) {
    try {
      const res = await host.run("git", ["ls-files", "-co", "--exclude-standard"], root)
      if (res.code === 0 && res.stdout.trim().length > 0) {
        const rawLines = res.stdout.split(/\r?\n/)
        const files: string[] = []
        const dirSet = new Set<string>()
        for (const line of rawLines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const filePath = joinPath(root, trimmed)
          files.push(filePath)

          // Collect all ancestor directories under root
          let d = dirname(filePath)
          while (d && d !== root && d.length >= root.length && !dirSet.has(d)) {
            dirSet.add(d)
            const parent = dirname(d)
            if (parent === d) break
            d = parent
          }

          if (files.length >= limit) {
            return { files, dirs: Array.from(dirSet), stopped: true }
          }
        }
        if (files.length > 0) {
          return { files, dirs: Array.from(dirSet), stopped: false }
        }
      }
    } catch {
      // Fall through to filesystem walk
    }
  }

  if (!host.readDir) {
    return { files: [], dirs: [], stopped: false }
  }

  const files: string[] = []
  const dirs: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  /*
   * Every directory already walked, so a cycle terminates.
   *
   * On Windows a junction pointing at one of its own ancestors is an
   * ordinary directory entry — `is_dir` is true and nothing distinguishes
   * it — so the walk went round it again and again. The only thing that
   * stopped it was the file limit, which means a cycle containing *no files*
   * did not stop it at all: the search hung with no output and no error, and
   * the queue grew until the renderer ran out of memory.
   *
   * Keyed on the normalised path, because the same directory reached two
   * ways must count as one.
   */
  const visited = new Set<string>([root])

  while (queue.length > 0) {
    const current = queue.shift()!

    let entries: DirEntry[]
    try {
      entries = await host.readDir(current.dir)
    } catch {
      // Individual directory read errors (permissions, broken symlinks) are skipped gracefully
      continue
    }

    if (!Array.isArray(entries)) {
      continue
    }

    // Sort entries alphabetically by name for deterministic traversal order
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
    const subdirs: string[] = []

    for (const entry of sorted) {
      if (entry.is_dir) {
        if (
          !skipDirs.has(entry.name) &&
          !(entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".nikcli")
        ) {
          const dirPath = entry.path ? normalizePath(entry.path) : joinPath(current.dir, entry.name)
          subdirs.push(dirPath)
          dirs.push(dirPath)
        }
      } else {
        const filePath = entry.path ? normalizePath(entry.path) : joinPath(current.dir, entry.name)
        files.push(filePath)
        if (files.length >= limit) {
          return { files, dirs, stopped: true }
        }
      }
    }

    // Enqueue subdirectories if depth limit has not been reached
    if (maxDepth === undefined || current.depth < maxDepth) {
      for (const subdir of subdirs) {
        if (visited.has(subdir)) continue
        visited.add(subdir)
        queue.push({ dir: subdir, depth: current.depth + 1 })
      }
    }
  }

  return { files, dirs, stopped: false }
}
