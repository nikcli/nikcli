import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bridge, type BridgeHooks } from "../src/bridge.ts"
import { hello as helloFixture, until } from "./helpers.ts"
import type { DeviceEvent, GadgetInfo } from "@nikcli-ai/gadget/protocol"

/**
 * The C client against the real bridge.
 *
 * The client is compiled with warnings as errors and AddressSanitizer plus
 * UndefinedBehaviorSanitizer, then driven as a separate process: it pairs,
 * says hello, serves the feed, runs commands, receives bitmap frames and
 * messages, reports presses and sends messages. Platform glue (Wi-Fi, GPIO,
 * libnx pads) is not exercised here; what the protocol code does is.
 */
const root = path.resolve(import.meta.dir, "../../gadget/c")
const compiler = Bun.which("cc") ?? Bun.which("gcc") ?? Bun.which("clang")
const built = mkdtempSync(path.join(os.tmpdir(), "nikcli-c-client-"))
const binary = path.join(built, "host_gadget")
let compiled = false

beforeAll(async () => {
  if (!compiler) return
  const result = Bun.spawnSync({
    cmd: [
      compiler,
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O1",
      "-g",
      "-fsanitize=address,undefined",
      "-fno-sanitize-recover=undefined",
      `-I${path.join(root, "include")}`,
      path.join(root, "src/nikcli_gadget.c"),
      path.join(root, "src/ng_json.c"),
      path.join(root, "platform/posix.c"),
      path.join(root, "examples/host_gadget.c"),
      "-o",
      binary,
    ],
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`the C client does not compile:\n${result.stderr.toString()}`)
  compiled = true
}, 60_000)

afterAll(() => rmSync(built, { recursive: true, force: true }))

const run = compiler ? test : test.skip

class Gadget {
  readonly out: string[] = []
  readonly err: string[] = []
  readonly exited: Promise<number>
  private readonly proc: ReturnType<typeof Bun.spawn>

  constructor(args: string[], env: Record<string, string> = {}) {
    this.proc = Bun.spawn({
      cmd: [binary, ...args],
      env: { ...process.env, ASAN_OPTIONS: "detect_leaks=1", ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.exited = this.proc.exited
    void collect(this.proc.stdout as ReadableStream<Uint8Array>, this.out)
    void collect(this.proc.stderr as ReadableStream<Uint8Array>, this.err)
  }

  write(line: string) {
    const stdin = this.proc.stdin as { write(data: string): number; flush(): void }
    stdin.write(line + "\n")
    stdin.flush()
  }

  async line(match: RegExp | string, ms = 5_000): Promise<string> {
    const test = (text: string) => (typeof match === "string" ? text.startsWith(match) : match.test(text))
    await until(() => this.out.some(test), ms)
    return this.out.find(test)!
  }

  kill(signal: "SIGKILL" | "SIGTERM" = "SIGKILL") {
    this.proc.kill(signal)
  }
}

async function collect(stream: ReadableStream<Uint8Array>, into: string[]) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = pending.indexOf("\n")) >= 0) {
      into.push(pending.slice(0, nl))
      pending = pending.slice(nl + 1)
    }
  }
  if (pending) into.push(pending)
}

let bridge: Bridge
let messages: Array<{ device: string; text: string; sessionID?: string }>
let presses: Array<{ device: string; event: DeviceEvent }>
let running: Gadget[] = []

beforeEach(() => {
  messages = []
  presses = []
  const hooks: BridgeHooks = {
    async message(device: GadgetInfo, text: string, sessionID?: string) {
      messages.push({ device: device.id, text, sessionID })
      return sessionID ?? "ses_c"
    },
    async press(device: GadgetInfo, event: DeviceEvent) {
      presses.push({ device: device.id, event })
      return { handled: event.key === "ok" }
    },
  }
  bridge = new Bridge({ port: 0, host: "127.0.0.1", hooks: () => hooks, log: () => undefined })
  expect(bridge.start()).toBe(true)
})

afterEach(() => {
  for (const gadget of running) gadget.kill()
  running = []
  bridge.stop()
})

function start(name: string, env: Record<string, string> = {}, fingerprint = `${name}-0123456789abcdef`) {
  const { code } = bridge.registry.openPairing()
  const gadget = new Gadget([`http://127.0.0.1:${bridge.port}`, code, name, fingerprint], env)
  running.push(gadget)
  return gadget
}

async function online(gadget: Gadget, name: string) {
  await gadget.line(`PAIRED ${name}`)
  await until(() => bridge.registry.online(name))
}

/** Stop a gadget the way an operator would and check it left cleanly: exit 0 and no sanitizer report. */
async function quit(gadget: Gadget, how: "stdin" | "SIGTERM" = "stdin") {
  // stdin is read while the feed is open; between retries the only way to stop it is a signal.
  if (how === "stdin") gadget.write("quit")
  else gadget.kill("SIGTERM")
  const code = await Promise.race([
    gadget.exited,
    new Promise<number>((resolve) => setTimeout(() => resolve(-999), 5_000)),
  ])
  expect(gadget.err.join("\n")).not.toMatch(/AddressSanitizer|LeakSanitizer|runtime error/)
  expect(code).toBe(0)
}

describe("the C client", () => {
  run("pairs with a button, declares itself, and serves commands", async () => {
    expect(compiled).toBe(true)
    const gadget = start("c-pi")
    await gadget.line("NEEDS_CONFIRM")
    // Until the button is pressed the bridge accepts no hello.
    expect(bridge.registry.get("c-pi").confirmed).toBe(false)
    gadget.write("confirm")
    await gadget.line("CONFIRMED")
    await online(gadget, "c-pi")

    const info = bridge.registry.get("c-pi")
    expect(info.commands.map((c) => c.name)).toEqual(["device.health", "echo.say", "test.big", "test.wait"])
    expect(info.display).toMatchObject({ format: "bitmap", width: 64, height: 24 })
    expect(info.buttons).toEqual(["ok", "next"])
    expect(info.platform).toEqual({ os: "linux", arch: "host", machine: "c-pi-0123456789abcdef" })

    const text = 'héllo "quoted" \\ back\nline two\t\u0001'
    const echoed = await bridge.registry.invoke("c-pi", { command: "echo.say", args: { text } })
    expect(echoed).toMatchObject({ output: text, exitCode: 0, isError: false })

    const health = await bridge.registry.invoke("c-pi", { command: "device.health" })
    const parsed = JSON.parse(health.output)
    expect(parsed.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(parsed.memory.totalBytes).toBeGreaterThan(0)

    const failed = await bridge.registry.invoke("c-pi", { command: "echo.say", args: {} })
    expect(failed).toMatchObject({ isError: true, exitCode: 2 })
    await quit(gadget)
  })

  run("marks output that filled the buffer as truncated", async () => {
    const gadget = start("c-big", { HOST_GADGET_NO_BUTTON: "1" })
    await online(gadget, "c-big")
    const big = await bridge.registry.invoke("c-big", { command: "test.big" })
    expect(big.truncated).toBe(true)
    expect(big.output).toHaveLength(511)
    await quit(gadget)
  })

  run("gives the handler the time the bridge allowed, on its own clock", async () => {
    const gadget = start("c-wait", { HOST_GADGET_NO_BUTTON: "1" })
    await online(gadget, "c-wait")
    const started = Date.now()
    const waited = await bridge.registry.invoke("c-wait", { command: "test.wait", timeoutMs: 1_000 })
    expect(waited).toMatchObject({ output: "stopped at the deadline", exitCode: 124, isError: true })
    // It stopped before the bridge's own timer, not at it.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(Date.now() - started).toBeGreaterThan(500)
    await quit(gadget)
  })

  run("receives bitmap frames the bridge rendered, including ones that span many reads", async () => {
    const gadget = start("c-panel", { HOST_GADGET_NO_BUTTON: "1", HOST_GADGET_WIDTH: "296", HOST_GADGET_HEIGHT: "128" })
    await online(gadget, "c-panel")
    expect(bridge.registry.get("c-panel").display).toMatchObject({ width: 296, height: 128 })
    bridge.registry.show("c-panel", {
      type: "Markdown",
      props: { text: "# Build green\n- tests pass\n- deploy ready" },
    })
    const painted = await gadget.line(/^BITMAP 296x128 bytes=4736 ink=\d+$/)
    expect(Number(/ink=(\d+)/.exec(painted)![1])).toBeGreaterThan(100)
    await quit(gadget)
  })

  run("is never sent a frame bigger than its buffer: the bridge refuses, naming the sizes", async () => {
    const gadget = start("c-small", {
      HOST_GADGET_NO_BUTTON: "1",
      HOST_GADGET_WIDTH: "296",
      HOST_GADGET_HEIGHT: "128",
      HOST_GADGET_FRAME_CAP: "1024",
    })
    await online(gadget, "c-small")
    const error = (() => {
      try {
        bridge.registry.show("c-small", { type: "Text", props: {}, children: ["too big for the buffer"] })
      } catch (caught) {
        return caught as { tag: string; message: string }
      }
      throw new Error("show should have been refused")
    })()
    expect(error.tag).toBe("PayloadTooLarge")
    expect(error.message).toMatch(/takes frames up to 1024 bytes.*needs \d+/)
    expect(gadget.out.some((line) => line.startsWith("BITMAP"))).toBe(false)
    const echoed = await bridge.registry.invoke("c-small", { command: "echo.say", args: { text: "still alive" } })
    expect(echoed.output).toBe("still alive")
    await quit(gadget)
  })

  run("answers a call that is too big for its buffer with an error instead of leaving it to time out", async () => {
    const gadget = start("c-tight", { HOST_GADGET_NO_BUTTON: "1", HOST_GADGET_FRAME_CAP: "1024" })
    await online(gadget, "c-tight")
    // A bridge that does not honour the declared limit (an older one, or a bug): lift it from the registry's side.
    bridge.registry.hello(
      "c-tight",
      helloFixture({
        platform: { os: "linux", arch: "host", machine: "c-tight-0123456789abcdef" },
        commands: [{ name: "echo.say", description: "echo", args: { type: "object" } }],
      }),
    )
    const started = Date.now()
    const result = await bridge.registry.invoke("c-tight", {
      command: "echo.say",
      args: { text: "x".repeat(3_000) },
      timeoutMs: 20_000,
    })
    expect(result).toMatchObject({ isError: true, output: "this call is larger than the device's frame buffer" })
    expect(Date.now() - started).toBeLessThan(3_000)
    await until(() => gadget.err.some((line) => line.includes("was dropped")))
    const after = await bridge.registry.invoke("c-tight", { command: "echo.say", args: { text: "next" } })
    expect(after.output).toBe("next")
    await quit(gadget)
  })

  run("answers a call with more arguments than it can parse", async () => {
    const gadget = start("c-tokens", { HOST_GADGET_NO_BUTTON: "1" })
    await online(gadget, "c-tokens")
    const result = await bridge.registry.invoke("c-tokens", {
      command: "echo.say",
      args: { text: "hi", list: Array.from({ length: 400 }, (_, i) => i) },
      timeoutMs: 20_000,
    })
    expect(result).toMatchObject({ isError: true, output: "this device cannot parse a call with that many arguments" })
    await quit(gadget)
  })

  run("sizes its buffer for a big panel on its own and declares it", async () => {
    // 400x300 pixels is 15,000 bytes, about 20 KB as base64: more than the default buffer.
    const gadget = start("c-big-panel", {
      HOST_GADGET_NO_BUTTON: "1",
      HOST_GADGET_WIDTH: "400",
      HOST_GADGET_HEIGHT: "300",
    })
    await online(gadget, "c-big-panel")
    bridge.registry.show("c-big-panel", { type: "Markdown", props: { text: "# Build green\n- tests pass" } })
    await gadget.line(/^BITMAP 400x300 bytes=15000 ink=\d+$/)
    await quit(gadget)
  })

  run("receives messages, reports presses, and sends messages into a session", async () => {
    const gadget = start("c-io")
    await gadget.line("NEEDS_CONFIRM")
    gadget.write("confirm")
    await online(gadget, "c-io")

    bridge.registry.tell("c-io", "deploy finished")
    await gadget.line("MESSAGE deploy finished")

    gadget.write("press ok")
    gadget.write("press next")
    await until(() => presses.length === 2)
    expect(presses.map((p) => p.event.key)).toEqual(["ok", "next"])

    gadget.write("send front door opened")
    expect(await gadget.line(/^SESSION /)).toBe("SESSION ses_c")
    expect(messages).toEqual([{ device: "c-io", text: "front door opened", sessionID: undefined }])
    await quit(gadget)
  })

  run(
    "is told when the code is wrong, and when it is revoked",
    async () => {
      const wrong = new Gadget([`http://127.0.0.1:${bridge.port}`, "000000", "c-wrong", "c-wrong-0123456789ab"], {
        HOST_GADGET_NO_BUTTON: "1",
      })
      running.push(wrong)
      expect(await wrong.line("PAIR_FAILED")).toMatch(/PAIR_FAILED -2 .*(pairing|code)/)
      expect(await wrong.exited).toBe(1)

      const gadget = start("c-revoked", { HOST_GADGET_NO_BUTTON: "1" })
      await online(gadget, "c-revoked")
      bridge.registry.revoke("c-revoked")
      // -5 is NG_ERR_REVOKED: it stops retrying and says to pair again.
      await gadget.line(/^END -5 /, 15_000)
      expect(await gadget.exited).toBe(1)
      expect(gadget.err.join("\n")).toMatch(/pair again/)
    },
    30_000,
  )

  run(
    "finds nothing to talk to and keeps retrying until stopped",
    async () => {
      const gadget = start("c-retry", { HOST_GADGET_NO_BUTTON: "1" })
      await online(gadget, "c-retry")
      bridge.stop()
      await until(() => gadget.err.some((line) => /retrying in/.test(line)), 15_000)
      await quit(gadget, "SIGTERM")
    },
    30_000,
  )
})
