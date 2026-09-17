import { describe, it, expect } from "bun:test"
import { findByName, findInFiles } from "./find"
import type { Host, FileRead } from "../host/shell"

function createFakeHost(files: Record<string, string | Error | FileRead>): Host {
  return {
    probe: async () => null,
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    spawn: async () => ({ kill: () => {}, write: () => {}, resize: () => {} }),
    readDir: async () => [],
    readTextFile: async (path: string, _maxBytes?: number) => {
      const normalized = path.replace(/\\/g, "/")
      if (normalized in files) {
        const val = files[normalized]
        if (val instanceof Error) throw val
        if (typeof val === "string") {
          return { text: val, truncated: false, bytes: val.length }
        }
        return val
      }
      throw new Error(`File not found: ${path}`)
    },
    currentDir: async () => "C:/repo",
    homeDir: async () => "C:/Users/test",
    exists: async () => false,
    pickDirectory: async () => undefined,
  }
}

describe("findByName", () => {
  const paths = [
    "packages/ade/src/search/walk.ts",
    "packages/ade/src/search/find.ts",
    "packages/ade/src/host/shell.ts",
    "packages/ade/src/command/palette.tsx",
    "packages/ade/src/command/match.ts",
  ]

  it("returns all paths when query is empty", () => {
    const hits = findByName(paths, "")
    expect(hits).toHaveLength(paths.length)
    expect(hits[0].score).toBe(0)
    expect(hits[0].ranges).toEqual([])
    expect(hits.map((h) => h.path)).toEqual(paths)
  })

  it("limits results when query is empty and limit is specified", () => {
    const hits = findByName(paths, "", 2)
    expect(hits).toHaveLength(2)
  })

  it("matches paths by subsequence and ranks higher score first", () => {
    const hits = findByName(paths, "walk")
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].path).toBe("packages/ade/src/search/walk.ts")
    expect(hits[0].ranges.length).toBeGreaterThan(0)
  })

  it("returns empty array when query does not match any path", () => {
    const hits = findByName(paths, "nonexistentstring12345")
    expect(hits).toEqual([])
  })

  it("respects limit argument", () => {
    const hits = findByName(paths, "ts", 2)
    expect(hits).toHaveLength(2)
  })

  it("maintains stable sorting on equal scores", () => {
    const samePaths = ["pkg/a.ts", "pkg/b.ts", "pkg/c.ts"]
    const hits = findByName(samePaths, "pkg")
    expect(hits.map((h) => h.path)).toEqual(["pkg/a.ts", "pkg/b.ts", "pkg/c.ts"])
  })
})

describe("findInFiles", () => {
  it("finds case-insensitive literal matches across files with 1-based line numbers", async () => {
    const host = createFakeHost({
      "C:/repo/a.ts": "const name = 'ADE'\nconst age = 42\nexport default name",
      "C:/repo/b.ts": "import { name } from './a'\nconsole.log(NAME)",
    })

    const { hits, truncated } = await findInFiles({
      host,
      paths: ["C:/repo/a.ts", "C:/repo/b.ts"],
      query: "name",
    })

    expect(truncated).toBe(false)
    expect(hits).toHaveLength(4)

    expect(hits[0]).toEqual({
      path: "C:/repo/a.ts",
      line: 1,
      text: "const name = 'ADE'",
      ranges: [[6, 10]],
    })

    expect(hits[1]).toEqual({
      path: "C:/repo/a.ts",
      line: 3,
      text: "export default name",
      ranges: [[15, 19]],
    })

    expect(hits[2]).toEqual({
      path: "C:/repo/b.ts",
      line: 1,
      text: "import { name } from './a'",
      ranges: [[9, 13]],
    })

    expect(hits[3]).toEqual({
      path: "C:/repo/b.ts",
      line: 2,
      text: "console.log(NAME)",
      ranges: [[12, 16]],
    })
  })

  it("handles multiple occurrences on the same line", async () => {
    const host = createFakeHost({
      "C:/repo/test.txt": "foo bar foo baz foo",
    })

    const { hits } = await findInFiles({
      host,
      paths: ["C:/repo/test.txt"],
      query: "foo",
    })

    expect(hits).toHaveLength(1)
    expect(hits[0].line).toBe(1)
    expect(hits[0].ranges).toEqual([
      [0, 3],
      [8, 11],
      [16, 19],
    ])
  })

  it("returns empty hits and truncated false for empty query", async () => {
    const host = createFakeHost({
      "C:/repo/a.ts": "some content",
    })

    const res = await findInFiles({
      host,
      paths: ["C:/repo/a.ts"],
      query: "",
    })

    expect(res).toEqual({ hits: [], truncated: false })
  })

  it("returns empty hits and truncated false when no matches exist", async () => {
    const host = createFakeHost({
      "C:/repo/a.ts": "hello world",
    })

    const res = await findInFiles({
      host,
      paths: ["C:/repo/a.ts"],
      query: "goodbye",
    })

    expect(res).toEqual({ hits: [], truncated: false })
  })

  it("stops and sets truncated to true when limit is reached", async () => {
    const host = createFakeHost({
      "C:/repo/a.ts": "match 1\nmatch 2\nmatch 3\nmatch 4",
      "C:/repo/b.ts": "match 5\nmatch 6",
    })

    const { hits, truncated } = await findInFiles({
      host,
      paths: ["C:/repo/a.ts", "C:/repo/b.ts"],
      query: "match",
      limit: 3,
    })

    expect(truncated).toBe(true)
    expect(hits).toHaveLength(3)
    expect(hits.map((h) => h.text)).toEqual(["match 1", "match 2", "match 3"])
  })

  it("centers long lines around the match and trims to <= 200 characters", async () => {
    const prefix = "a".repeat(150)
    const suffix = "z".repeat(150)
    const line = `${prefix}TARGET_WORD${suffix}` // 311 chars total

    const host = createFakeHost({
      "C:/repo/long.txt": line,
    })

    const { hits } = await findInFiles({
      host,
      paths: ["C:/repo/long.txt"],
      query: "TARGET_WORD",
    })

    expect(hits).toHaveLength(1)
    expect(hits[0].text.length).toBeLessThanOrEqual(200)

    const [start, end] = hits[0].ranges[0]
    expect(hits[0].text.slice(start, end)).toBe("TARGET_WORD")
  })

  it("skips binary files throwing an error like 'file binario'", async () => {
    const host = createFakeHost({
      "C:/repo/binary.bin": new Error("file binario"),
      "C:/repo/good.txt": "valid text with match",
    })

    const { hits } = await findInFiles({
      host,
      paths: ["C:/repo/binary.bin", "C:/repo/good.txt"],
      query: "match",
    })

    expect(hits).toHaveLength(1)
    expect(hits[0].path).toBe("C:/repo/good.txt")
  })

  it("skips files containing null bytes (binary content)", async () => {
    const host = createFakeHost({
      "C:/repo/corrupt.bin": "start\0match in binary\0end",
      "C:/repo/plain.txt": "plain match",
    })

    const { hits } = await findInFiles({
      host,
      paths: ["C:/repo/corrupt.bin", "C:/repo/plain.txt"],
      query: "match",
    })

    expect(hits).toHaveLength(1)
    expect(hits[0].path).toBe("C:/repo/plain.txt")
  })

  it("skips unreadable or missing files gracefully", async () => {
    const host = createFakeHost({
      "C:/repo/locked.ts": new Error("EACCES: permission denied"),
      "C:/repo/ok.ts": "find me",
    })

    const { hits } = await findInFiles({
      host,
      paths: ["C:/repo/locked.ts", "C:/repo/missing.ts", "C:/repo/ok.ts"],
      query: "find me",
    })

    expect(hits).toHaveLength(1)
    expect(hits[0].path).toBe("C:/repo/ok.ts")
  })

  it("passes maxBytes parameter to host.readTextFile", async () => {
    let receivedMaxBytes: number | undefined
    const host: Host = {
      probe: async () => null,
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      spawn: async () => ({ kill: () => {}, write: () => {}, resize: () => {} }),
      readTextFile: async (_path, maxBytes) => {
        receivedMaxBytes = maxBytes
        return { text: "target string", truncated: false, bytes: 13 }
      },
    }

    await findInFiles({
      host,
      paths: ["C:/repo/file.txt"],
      query: "target",
      maxBytes: 12345,
    })

    expect(receivedMaxBytes).toBe(12345)
  })

  it("returns empty result if host lacks readTextFile capability", async () => {
    const host: Host = {
      probe: async () => null,
      run: async () => ({ code: 1, stdout: "", stderr: "" }),
      spawn: async () => ({ kill: () => {}, write: () => {}, resize: () => {} }),
    }

    const res = await findInFiles({
      host,
      paths: ["C:/repo/file.txt"],
      query: "target",
    })

    expect(res).toEqual({ hits: [], truncated: false })
  })
})
