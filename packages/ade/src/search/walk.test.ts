import { describe, it, expect } from "bun:test"
import { walkProject, DEFAULT_SKIP_DIRS } from "./walk"
import type { Host, DirEntry } from "../host/shell"

const dir = (name: string, path: string): DirEntry => ({
  name,
  path,
  is_dir: true,
  size: 0,
  modified_ms: 0,
})

const file = (name: string, path: string): DirEntry => ({
  name,
  path,
  is_dir: false,
  size: 1,
  modified_ms: 0,
})

function createFakeHost(fileSystem: Record<string, DirEntry[]>): Host {
  return {
    probe: async () => null,
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    spawn: async () => ({ kill: () => {}, write: () => {}, resize: () => {} }),
    readDir: async (path: string) => {
      const normalized = path.replace(/\\/g, "/")
      if (normalized in fileSystem) {
        return fileSystem[normalized]
      }
      throw new Error(`Directory not found: ${path}`)
    },
    readTextFile: async () => ({ text: "", truncated: false, bytes: 0 }),
    currentDir: async () => "C:/repo",
    homeDir: async () => "C:/Users/test",
    exists: async () => false,
    pickDirectory: async () => undefined,
  }
}

describe("walkProject", () => {
  it("traverses files in breadth-first order (root files before nested)", async () => {
    const fs: Record<string, DirEntry[]> = {
      "C:/repo": [
        { name: "README.md", path: "C:/repo/README.md", is_dir: false, size: 100, modified_ms: 0 },
        { name: "package.json", path: "C:/repo/package.json", is_dir: false, size: 200, modified_ms: 0 },
        { name: "src", path: "C:/repo/src", is_dir: true, size: 0, modified_ms: 0 },
      ],
      "C:/repo/src": [
        { name: "index.ts", path: "C:/repo/src/index.ts", is_dir: false, size: 300, modified_ms: 0 },
        { name: "components", path: "C:/repo/src/components", is_dir: true, size: 0, modified_ms: 0 },
      ],
      "C:/repo/src/components": [
        { name: "button.tsx", path: "C:/repo/src/components/button.tsx", is_dir: false, size: 400, modified_ms: 0 },
      ],
    }

    const host = createFakeHost(fs)
    const result = await walkProject({ host, root: "C:/repo" })

    expect(result.stopped).toBe(false)
    expect(result.files).toEqual([
      "C:/repo/package.json",
      "C:/repo/README.md",
      "C:/repo/src/index.ts",
      "C:/repo/src/components/button.tsx",
    ])
  })

  it("skips default ignored directories like node_modules and .git", async () => {
    const fs: Record<string, DirEntry[]> = {
      "C:/repo": [
        { name: "index.ts", path: "C:/repo/index.ts", is_dir: false, size: 100, modified_ms: 0 },
        { name: "node_modules", path: "C:/repo/node_modules", is_dir: true, size: 0, modified_ms: 0 },
        { name: ".git", path: "C:/repo/.git", is_dir: true, size: 0, modified_ms: 0 },
        { name: "dist", path: "C:/repo/dist", is_dir: true, size: 0, modified_ms: 0 },
        { name: ".ade-trees", path: "C:/repo/.ade-trees", is_dir: true, size: 0, modified_ms: 0 },
      ],
      "C:/repo/node_modules": [
        { name: "bad.js", path: "C:/repo/node_modules/bad.js", is_dir: false, size: 50, modified_ms: 0 },
      ],
      "C:/repo/.git": [{ name: "HEAD", path: "C:/repo/.git/HEAD", is_dir: false, size: 20, modified_ms: 0 }],
    }

    const host = createFakeHost(fs)
    const result = await walkProject({ host, root: "C:/repo" })

    expect(result.files).toEqual(["C:/repo/index.ts"])
    expect(result.stopped).toBe(false)
  })

  it("supports custom skipDirs", async () => {
    const fs: Record<string, DirEntry[]> = {
      "C:/repo": [
        { name: "keep.ts", path: "C:/repo/keep.ts", is_dir: false, size: 100, modified_ms: 0 },
        { name: "vendor", path: "C:/repo/vendor", is_dir: true, size: 0, modified_ms: 0 },
      ],
      "C:/repo/vendor": [{ name: "dep.js", path: "C:/repo/vendor/dep.js", is_dir: false, size: 200, modified_ms: 0 }],
    }

    const host = createFakeHost(fs)
    const result = await walkProject({
      host,
      root: "C:/repo",
      options: { skipDirs: new Set(["vendor"]) },
    })

    expect(result.files).toEqual(["C:/repo/keep.ts"])
  })

  it("respects maxDepth 0 (root only)", async () => {
    const fs: Record<string, DirEntry[]> = {
      "C:/repo": [
        { name: "root.ts", path: "C:/repo/root.ts", is_dir: false, size: 10, modified_ms: 0 },
        { name: "nested", path: "C:/repo/nested", is_dir: true, size: 0, modified_ms: 0 },
      ],
      "C:/repo/nested": [
        { name: "child.ts", path: "C:/repo/nested/child.ts", is_dir: false, size: 20, modified_ms: 0 },
      ],
    }

    const host = createFakeHost(fs)
    const result = await walkProject({
      host,
      root: "C:/repo",
      options: { maxDepth: 0 },
    })

    expect(result.files).toEqual(["C:/repo/root.ts"])
  })

  it("respects maxDepth 1 (root and direct subdirectories)", async () => {
    const fs: Record<string, DirEntry[]> = {
      "C:/repo": [
        { name: "root.ts", path: "C:/repo/root.ts", is_dir: false, size: 10, modified_ms: 0 },
        { name: "level1", path: "C:/repo/level1", is_dir: true, size: 0, modified_ms: 0 },
      ],
      "C:/repo/level1": [
        { name: "l1.ts", path: "C:/repo/level1/l1.ts", is_dir: false, size: 20, modified_ms: 0 },
        { name: "level2", path: "C:/repo/level1/level2", is_dir: true, size: 0, modified_ms: 0 },
      ],
      "C:/repo/level1/level2": [
        { name: "l2.ts", path: "C:/repo/level1/level2/l2.ts", is_dir: false, size: 30, modified_ms: 0 },
      ],
    }

    const host = createFakeHost(fs)
    const result = await walkProject({
      host,
      root: "C:/repo",
      options: { maxDepth: 1 },
    })

    expect(result.files).toEqual(["C:/repo/root.ts", "C:/repo/level1/l1.ts"])
  })

  it("stops when file limit is reached and sets stopped to true", async () => {
    const fs: Record<string, DirEntry[]> = {
      "C:/repo": [
        { name: "a.ts", path: "C:/repo/a.ts", is_dir: false, size: 10, modified_ms: 0 },
        { name: "b.ts", path: "C:/repo/b.ts", is_dir: false, size: 10, modified_ms: 0 },
        { name: "c.ts", path: "C:/repo/c.ts", is_dir: false, size: 10, modified_ms: 0 },
        { name: "d.ts", path: "C:/repo/d.ts", is_dir: false, size: 10, modified_ms: 0 },
      ],
    }

    const host = createFakeHost(fs)
    const result = await walkProject({
      host,
      root: "C:/repo",
      options: { limit: 2 },
    })

    expect(result.stopped).toBe(true)
    expect(result.files).toHaveLength(2)
    expect(result.files).toEqual(["C:/repo/a.ts", "C:/repo/b.ts"])
  })

  it("handles limit <= 0 gracefully", async () => {
    const fs: Record<string, DirEntry[]> = {
      "C:/repo": [{ name: "a.ts", path: "C:/repo/a.ts", is_dir: false, size: 10, modified_ms: 0 }],
    }
    const host = createFakeHost(fs)
    const result = await walkProject({
      host,
      root: "C:/repo",
      options: { limit: 0 },
    })

    expect(result.stopped).toBe(true)
    expect(result.files).toEqual([])
  })

  it("gracefully skips unreadable directories without throwing", async () => {
    const fs: Record<string, DirEntry[]> = {
      "C:/repo": [
        { name: "good.ts", path: "C:/repo/good.ts", is_dir: false, size: 10, modified_ms: 0 },
        { name: "locked", path: "C:/repo/locked", is_dir: true, size: 0, modified_ms: 0 },
        { name: "other", path: "C:/repo/other", is_dir: true, size: 0, modified_ms: 0 },
      ],
      // "C:/repo/locked" is missing from fs map, so readDir will throw
      "C:/repo/other": [{ name: "other.ts", path: "C:/repo/other/other.ts", is_dir: false, size: 20, modified_ms: 0 }],
    }

    const host = createFakeHost(fs)
    const result = await walkProject({ host, root: "C:/repo" })

    expect(result.files).toEqual(["C:/repo/good.ts", "C:/repo/other/other.ts"])
    expect(result.stopped).toBe(false)
  })

  it("returns empty result when host has no readDir capability", async () => {
    const host: Host = {
      probe: async () => null,
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      spawn: async () => ({ kill: () => {}, write: () => {}, resize: () => {} }),
    }

    const result = await walkProject({ host, root: "C:/repo" })
    expect(result.files).toEqual([])
    expect(result.stopped).toBe(false)
  })

  /*
   * On Windows a junction pointing at one of its own ancestors is an
   * ordinary directory entry: `is_dir` is true and nothing marks it. The
   * walk went round it forever, and because only the *file* limit stopped
   * the loop, a cycle with no files in it did not stop it at all — the
   * search hung with no output and no error while the queue ate the heap.
   */
  it("terminates on a junction pointing back at an ancestor", async () => {
    const host: Host = {
      probe: async () => null,
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      spawn: async () => ({ kill: () => {}, write: () => {}, resize: () => {} }),
      readDir: async (path: string) => {
        if (path === "C:/repo") return [dir("src", "C:/repo/src")]
        // `loop` is a junction back to the root, and there is not one file
        // anywhere in the cycle.
        if (path === "C:/repo/src") return [dir("loop", "C:/repo")]
        return []
      },
    }

    const result = await walkProject({ host, root: "C:/repo" })
    expect(result.files).toEqual([])
    expect(result.stopped).toBe(false)
  })

  it("visits a directory once even when two paths reach it", async () => {
    const host: Host = {
      probe: async () => null,
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      spawn: async () => ({ kill: () => {}, write: () => {}, resize: () => {} }),
      readDir: async (path: string) => {
        if (path === "C:/repo") return [dir("a", "C:/repo/shared"), dir("b", "C:/repo/shared")]
        if (path === "C:/repo/shared") return [file("f.ts", "C:/repo/shared/f.ts")]
        return []
      },
    }

    const result = await walkProject({ host, root: "C:/repo" })
    expect(result.files).toEqual(["C:/repo/shared/f.ts"])
  })

  it("exports standard DEFAULT_SKIP_DIRS", () => {
    expect(DEFAULT_SKIP_DIRS.has("node_modules")).toBe(true)
    expect(DEFAULT_SKIP_DIRS.has(".git")).toBe(true)
    expect(DEFAULT_SKIP_DIRS.has("dist")).toBe(true)
    expect(DEFAULT_SKIP_DIRS.has("build")).toBe(true)
    expect(DEFAULT_SKIP_DIRS.has("target")).toBe(true)
    expect(DEFAULT_SKIP_DIRS.has(".ade-trees")).toBe(true)
    expect(DEFAULT_SKIP_DIRS.has(".next")).toBe(true)
    expect(DEFAULT_SKIP_DIRS.has(".turbo")).toBe(true)
    expect(DEFAULT_SKIP_DIRS.has("coverage")).toBe(true)
  })
})
