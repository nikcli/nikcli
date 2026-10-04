import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Gadget } from "../src/gadget.ts"
import { readFrames } from "../src/transport.ts"
import type { Frame } from "../src/protocol.ts"

describe("Gadget.invoke", () => {
  const gadget = new Gadget({
    name: "test",
    builtins: false,
    log: () => undefined,
    commands: {
      "echo.say": {
        description: "echo",
        args: { type: "object", properties: { text: { type: "string" } } },
        maxOutputBytes: 16,
        async run({ text }: { text: string }) {
          return text
        },
      },
      "slow.wait": {
        description: "wait",
        args: { type: "object" },
        async run(_args, ctx) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5_000)
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer)
              reject(new Error("aborted"))
            })
          })
          return "done"
        },
      },
    },
  })

  test("runs a command and returns its output", async () => {
    const result = await gadget.invoke({
      type: "invoke",
      callID: "c1",
      command: "echo.say",
      args: { text: "hi" },
      timeoutMs: 1000,
    })
    expect(result).toEqual({ output: "hi" })
  })

  test("truncates at the spec's maxOutputBytes and says so", async () => {
    const result = await gadget.invoke({
      type: "invoke",
      callID: "c2",
      command: "echo.say",
      args: { text: "x".repeat(40) },
      timeoutMs: 1000,
    })
    expect(result.truncated).toBe(true)
    expect(result.output.startsWith("x".repeat(16))).toBe(true)
    expect(result.output).toMatch(/truncated at 16 bytes/)
  })

  test("aborts the handler at the deadline", async () => {
    const started = Date.now()
    const result = await gadget.invoke({
      type: "invoke",
      callID: "c3",
      command: "slow.wait",
      args: {},
      timeoutMs: 50,
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result.isError).toBe(true)
    expect(result.exitCode).toBe(124)
  })

  test("an unknown command is an error result, not a throw", async () => {
    const result = await gadget.invoke({
      type: "invoke",
      callID: "c4",
      command: "nope.x",
      args: {},
      timeoutMs: 1000,
    })
    expect(result).toEqual({ output: "unknown command nope.x", isError: true })
  })

  test("the hello declares the commands and validates itself", () => {
    const hello = gadget.hello()
    expect(hello.commands.map((c) => c.name)).toEqual(["echo.say", "slow.wait"])
    expect(
      () =>
        new Gadget({
          builtins: false,
          commands: { "Bad Name": { description: "x", args: { type: "object" }, run: async () => "" } },
        }),
    ).toThrow(/commands\[0\]\.name/)
  })

  test("builtins are on by default", () => {
    const names = new Gadget({ name: "b", log: () => undefined }).hello().commands.map((c) => c.name)
    expect(names).toEqual(["system.run", "file.read", "file.write", "device.health"])
  })
})

describe("a feed that goes silent", () => {
  test("is reported once no byte arrives within the idle window", async () => {
    const silent = new ReadableStream<Uint8Array>({ start() {} })
    const started = Date.now()
    let error: unknown
    try {
      for await (const _ of readFrames(silent, undefined, 60)) void _
    } catch (caught) {
      error = caught
    }
    expect(String(error)).toMatch(/went quiet/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("is not reported while frames keep arriving", async () => {
    const encoder = new TextEncoder()
    let n = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (n++ < 5) controller.enqueue(encoder.encode(`data: {"type":"ping","time":${n}}\n\n`))
        else controller.close()
      },
    })
    const frames: Frame[] = []
    for await (const frame of readFrames(stream, undefined, 100)) frames.push(frame)
    expect(frames).toHaveLength(5)
  })
})

describe("trimTrailingSlashes", () => {
  test("trims any number of slashes in linear time and leaves the rest alone", async () => {
    const { trimTrailingSlashes } = await import("../src/transport.ts")
    const started = Date.now()
    expect(trimTrailingSlashes("http://h:1" + "/".repeat(200_000))).toBe("http://h:1")
    expect(Date.now() - started).toBeLessThan(500)
    expect(trimTrailingSlashes("http://h:1/a/b")).toBe("http://h:1/a/b")
    expect(trimTrailingSlashes("///")).toBe("")
  })
})

describe("readFrames", () => {
  test("parses data lines split across chunks and skips junk", async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"type":"pi',
      'ng","time":1}\n\n:comment\n\ndata: not json\n\ndata: {"type":"bye","reason":"x"}\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const frames: Frame[] = []
    for await (const frame of readFrames(stream)) frames.push(frame)
    expect(frames).toEqual([
      { type: "ping", time: 1 },
      { type: "bye", reason: "x" },
    ])
  })
})

describe("fingerprint", () => {
  const saved = process.env.NIKCLI_GADGET_STATE
  const dirs: string[] = []
  const fresh = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nikcli-gadget-identity-"))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    if (saved === undefined) delete process.env.NIKCLI_GADGET_STATE
    else process.env.NIKCLI_GADGET_STATE = saved
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test("is a random per-install value, stable in one state directory and distinct across them", async () => {
    const { fingerprint } = await import("../src/state.ts")
    process.env.NIKCLI_GADGET_STATE = fresh()
    const first = fingerprint()
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(fingerprint()).toBe(first)
    process.env.NIKCLI_GADGET_STATE = fresh()
    // Two installs on one host, or two clones of one SD card that pair on their own, must not look like one device.
    expect(fingerprint()).not.toBe(first)
  })

  test("is kept in a private file and survives unpairing", async () => {
    const { fingerprint, clearPairing, writePairing } = await import("../src/state.ts")
    const dir = fresh()
    process.env.NIKCLI_GADGET_STATE = dir
    const value = fingerprint()
    expect(statSync(path.join(dir, "identity")).mode & 0o777).toBe(0o600)
    writePairing({ server: "http://x", id: "a", token: "nkg_x", name: "a", confirmed: true, pairedAt: 1 })
    clearPairing()
    expect(fingerprint()).toBe(value)
  })

  test("falls back to the machine's own identifiers when the state directory cannot be written", async () => {
    const { fingerprint } = await import("../src/state.ts")
    process.env.NIKCLI_GADGET_STATE = "/dev/null/not-a-directory"
    expect(fingerprint()).toMatch(/^[0-9a-f]{32}$/)
    expect(fingerprint()).toBe(fingerprint())
  })

  test("constructing a Gadget does not create an identity", () => {
    const dir = fresh()
    process.env.NIKCLI_GADGET_STATE = path.join(dir, "state")
    new Gadget({ name: "quiet", builtins: false, log: () => undefined })
    expect(existsSync(path.join(dir, "state"))).toBe(false)
  })
})
