import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as system from "../src/commands/system.ts"
import * as file from "../src/commands/file.ts"
import { collect } from "../src/commands/health.ts"
import type { CommandContext } from "../src/gadget.ts"

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 5_000,
    maxOutputBytes: 1024,
    callID: "c",
    env: process.env,
    log: () => undefined,
    ...overrides,
  }
}

describe("system.run", () => {
  test("captures stdout and the exit code", async () => {
    const result = await system.run({ argv: ["sh", "-c", "echo hi; exit 3"] }, ctx())
    expect(result).toMatchObject({ output: "hi\n", exitCode: 3, isError: true })
  })

  test("feeds stdin and labels stderr", async () => {
    const result = await system.run({ argv: ["sh", "-c", "cat; echo err >&2"], stdin: "in" }, ctx())
    expect(typeof result === "string" ? result : result.output).toBe("in\n[stderr]\nerr\n")
  })

  test("a missing program is exit 127, not a throw", async () => {
    const result = await system.run({ argv: ["/definitely/not/here"] }, ctx())
    expect(result).toMatchObject({ exitCode: 127, isError: true })
  })

  test("the limit counts bytes once, across stdout and stderr together", async () => {
    const script =
      "head -c 300 /dev/zero | tr '\\0' a; head -c 300 /dev/zero | tr '\\0' b >&2; head -c 300 /dev/zero | tr '\\0' c"
    const under = await system.run({ argv: ["sh", "-c", script] }, ctx({ maxOutputBytes: 1_000 }))
    const text = typeof under === "string" ? under : under.output
    expect(typeof under === "object" && under.truncated).toBe(false)
    // All 900 bytes arrive: the old check cut this near 630.
    expect(text.replace(/\[stderr\]\n/, "").replace(/\n/g, "").length).toBe(900)
    const over = await system.run({ argv: ["sh", "-c", script] }, ctx({ maxOutputBytes: 500 }))
    expect(typeof over === "object" && over.truncated).toBe(true)
    const kept = (typeof over === "string" ? over : over.output).replace(/\n\[output truncated at 500 bytes\]$/, "")
    expect(kept.replace(/\[stderr\]\n/, "").replace(/\n/g, "").length).toBe(500)
  })

  test("multi-byte output is counted in bytes and not split into garbage", async () => {
    const result = await system.run(
      { argv: ["sh", "-c", "printf 'é%.0s' 1 2 3 4 5 6 7 8 9 10"] },
      ctx({ maxOutputBytes: 10 }),
    )
    const text = typeof result === "string" ? result : result.output
    expect(text.startsWith("ééééé")).toBe(true)
    expect(text).not.toContain("\ufffd")
  })

  test("a program that never reads its stdin cannot kill the gadget", async () => {
    const big = "x".repeat(4 * 1024 * 1024)
    const closed = await system.run({ argv: ["true"], stdin: big }, ctx())
    expect(closed).toMatchObject({ exitCode: 0 })
    const missing = await system.run({ argv: ["/definitely/not/here"], stdin: big }, ctx())
    expect(missing).toMatchObject({ exitCode: 127, isError: true })
  })

  test("aborts at the signal", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await system.run({ argv: ["sleep", "5"] }, ctx({ signal: controller.signal }))
    expect(result).toMatchObject({ exitCode: 124 })
  })
})

describe("file.read / file.write", () => {
  test("writes in chunks, replaces on final, reads back with offsets", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nikcli-gadget-file-"))
    try {
      const target = path.join(dir, "out.txt")
      const write = file.write([dir])
      await write({ path: target, content: "hello ", final: false }, ctx())
      expect(await readFile(`${target}.nikcli-part`, "utf8")).toBe("hello ")
      const done = await write({ path: target, content: "world", append: true }, ctx())
      expect(JSON.parse((done as { output: string }).output)).toMatchObject({ size: 11, final: true })
      expect(await readFile(target, "utf8")).toBe("hello world")
      const read = file.read([dir])
      const first = JSON.parse(((await read({ path: target, length: 5 }, ctx())) as { output: string }).output)
      expect(first).toMatchObject({ content: "hello", next: 5, eof: false, size: 11 })
      const rest = JSON.parse(((await read({ path: target, offset: 5 }, ctx())) as { output: string }).output)
      expect(rest).toMatchObject({ content: " world", eof: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses paths outside the roots", async () => {
    const result = await file.read(["/nonexistent-root"])({ path: "/etc/hostname" }, ctx())
    expect(result).toMatchObject({ isError: true })
    expect((result as { output: string }).output).toMatch(/outside/)
  })
})

describe("device.health", () => {
  test("reports the fields the agent reads", async () => {
    const health = await collect()
    expect(health.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(health.load).toHaveLength(3)
    expect(health.memory.totalBytes).toBeGreaterThan(0)
  })
})
