import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ReadTool } from "@/tool/read"
import { Instance } from "@/project/instance"
import { makeToolContext, withProjectDirectory } from "../helpers/tool-context"

describe("ReadTool", () => {
  let projectDir: string
  let def: Awaited<ReturnType<typeof ReadTool.init>>

  beforeAll(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-read-test-"))
    def = await withProjectDirectory(projectDir, () => ReadTool.init())
  })

  afterAll(async () => {
    await Instance.disposeAll().catch(() => undefined)
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {})
  })

  it("reads file contents and records a read permission ask", async () => {
    const filePath = path.join(projectDir, "hello.txt")
    await fs.writeFile(filePath, "line1\nline2\n")
    const { ctx, asked } = makeToolContext()
    const result = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath }, ctx))
    expect(result.output).toContain("line1")
    expect(result.output).toContain("line2")
    expect(asked.some((a) => a.permission === "read")).toBe(true)
  })

  it("resolves a relative path against the instance, not the process cwd", async () => {
    // The background service runs every project from one process, so its
    // cwd belongs to none of them.
    await fs.writeFile(path.join(projectDir, "relative.txt"), "from the instance\n")
    expect(process.cwd()).not.toBe(projectDir)
    const { ctx } = makeToolContext()
    const result = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath: "relative.txt" }, ctx))
    expect(result.output).toContain("from the instance")
  })

  it("respects offset and limit", async () => {
    const filePath = path.join(projectDir, "numbered.txt")
    await fs.writeFile(filePath, "a\nb\nc\nd\ne\n")
    const { ctx } = makeToolContext()
    const result = await withProjectDirectory(projectDir, () =>
      def.executeAsync({ filePath, offset: 2, limit: 2 }, ctx),
    )
    expect(result.output).toContain("b")
    expect(result.output).toContain("c")
    expect(result.output).not.toMatch(/^\d+: a$/m)
    expect(result.output).not.toMatch(/^\d+: e$/m)
    expect(result.output).toContain("2: b")
    expect(result.output).toContain("3: c")
  })

  it("lists directories with stable paging", async () => {
    const directory = path.join(projectDir, "listing")
    await fs.mkdir(path.join(directory, "nested"), { recursive: true })
    await fs.writeFile(path.join(directory, "alpha.txt"), "alpha")
    await fs.writeFile(path.join(directory, "beta.txt"), "beta")
    const { ctx } = makeToolContext()

    const first = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath: directory, limit: 2 }, ctx))
    expect(first.output).toContain("entries 1-2")
    expect(first.output).toContain(`nested${path.sep}`)
    expect(first.output).toContain("alpha.txt")
    expect(first.output).toContain("Continue reading with offset: 3")
    expect(first.metadata.truncated).toBe(true)

    const second = await withProjectDirectory(projectDir, () =>
      def.executeAsync({ filePath: directory, offset: 3, limit: 2 }, ctx),
    )
    expect(second.output).toContain("beta.txt")
    expect(second.metadata.truncated).toBe(false)
  })

  it("bounds directory output by bytes", async () => {
    const directory = path.join(projectDir, "large-listing")
    await fs.mkdir(directory)
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        fs.writeFile(path.join(directory, `${String(index).padStart(3, "0")}-${"x".repeat(180)}.txt`), ""),
      ),
    )
    const { ctx } = makeToolContext()

    const result = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath: directory }, ctx))
    expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(50 * 1024)
    expect(result.output).toContain("Continue reading with offset:")
    expect(result.metadata.truncated).toBe(true)
  })

  it("rejects oversized media before ingestion", async () => {
    const filePath = path.join(projectDir, "oversized.png")
    await fs.writeFile(filePath, "")
    await fs.truncate(filePath, 20 * 1024 * 1024 + 1)
    const { ctx } = makeToolContext()

    await expect(withProjectDirectory(projectDir, () => def.executeAsync({ filePath }, ctx))).rejects.toThrow(
      /Media exceeds 20971520 byte ingestion limit/,
    )
  })

  it("bounds long lines while continuing to later lines", async () => {
    const filePath = path.join(projectDir, "long-line.txt")
    await fs.writeFile(filePath, `${"x".repeat(10_000)}\nsecond\n`)
    const { ctx } = makeToolContext()

    const result = await withProjectDirectory(projectDir, () => def.executeAsync({ filePath }, ctx))
    expect(result.output).toContain(`1: ${"x".repeat(2_000)}...`)
    expect(result.output).toContain("2: second")
    expect(result.output).not.toContain("x".repeat(2_001))
  })

  it("rejects offset less than 1", async () => {
    const filePath = path.join(projectDir, "x.txt")
    await fs.writeFile(filePath, "x\n")
    const { ctx } = makeToolContext()
    await expect(
      withProjectDirectory(projectDir, () => def.executeAsync({ filePath, offset: 0 }, ctx)),
    ).rejects.toThrow(/offset must be/)
  })

  it("rejects fractional pagination values", async () => {
    const filePath = path.join(projectDir, "fractional.txt")
    await fs.writeFile(filePath, "one\ntwo\n")
    const { ctx } = makeToolContext()

    await expect(
      withProjectDirectory(projectDir, () => def.executeAsync({ filePath, offset: 1.5 }, ctx)),
    ).rejects.toThrow(/offset must be a positive integer/)
    await expect(
      withProjectDirectory(projectDir, () => def.executeAsync({ filePath, limit: 0.5 }, ctx)),
    ).rejects.toThrow(/limit must be a positive integer/)
  })

  it("throws File not found for missing paths", async () => {
    const filePath = path.join(projectDir, "missing-unique-xyz.txt")
    const { ctx } = makeToolContext()
    await expect(withProjectDirectory(projectDir, () => def.executeAsync({ filePath }, ctx))).rejects.toThrow(
      /File not found/,
    )
  })

  it("reports the requested path when its parent directory is missing too", async () => {
    const filePath = path.join(projectDir, "no-such-dir", "nested", "file.txt")
    const { ctx } = makeToolContext()
    // Listing the parent for "did you mean" suggestions must not surface its own
    // ENOENT — the model asked about the file, not the directory.
    await expect(withProjectDirectory(projectDir, () => def.executeAsync({ filePath }, ctx))).rejects.toThrow(
      `File not found: ${filePath}`,
    )
  })
})
