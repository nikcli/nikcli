import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Gadget, display, type PairingState } from "@nikcli-ai/gadget"
import {
  GadgetError,
  type DeviceEvent,
  type GadgetInfo,
  type InvokeResult,
  type Tree,
} from "@nikcli-ai/gadget/protocol"
import { Bridge, type BridgeHooks } from "../src/bridge.ts"
import { FakeFeed, rejection, tempDir, until } from "./helpers.ts"

interface Calls {
  messages: Array<{ device: string; text: string; sessionID?: string }>
  presses: Array<{ device: string; event: DeviceEvent }>
}

let bridge: Bridge
let calls: Calls
let temp: ReturnType<typeof tempDir>
let stop: Array<() => void> = []
const state = process.env.NIKCLI_GADGET_STATE

function hooks(): BridgeHooks {
  return {
    async message(device: GadgetInfo, text: string, sessionID?: string) {
      calls.messages.push({ device: device.id, text, sessionID })
      return sessionID ?? "ses_new"
    },
    async press(device: GadgetInfo, event: DeviceEvent) {
      calls.presses.push({ device: device.id, event })
      return { handled: event.key === "ok" }
    },
  }
}

beforeEach(() => {
  temp = tempDir()
  process.env.NIKCLI_GADGET_STATE = path.join(temp.dir, "device")
  calls = { messages: [], presses: [] }
  bridge = new Bridge({
    port: 0,
    host: "127.0.0.1",
    file: path.join(temp.dir, "devices.json"),
    hooks,
    log: () => undefined,
  })
  expect(bridge.start()).toBe(true)
})

afterEach(() => {
  for (const fn of stop.reverse()) fn()
  stop = []
  bridge.stop()
  temp.cleanup()
  if (state === undefined) delete process.env.NIKCLI_GADGET_STATE
  else process.env.NIKCLI_GADGET_STATE = state
})

function server() {
  return `http://127.0.0.1:${bridge.port}`
}

/** Pair an SDK gadget with the bridge and start serving its feed. */
async function connect(gadget: Gadget): Promise<{ pairing: PairingState; ended: Promise<unknown>; abort: () => void }> {
  const { code } = bridge.registry.openPairing()
  const pairing = await gadget.pair(server(), code)
  const controller = new AbortController()
  const ended = gadget.run({ signal: controller.signal, pairing }).catch((error) => error)
  stop.push(() => controller.abort())
  await until(() => bridge.registry.online(pairing.id))
  return { pairing, ended, abort: () => controller.abort() }
}

function plain(name = "pi-test") {
  return new Gadget({ name, log: () => undefined })
}

async function admin(pathname: string, init?: RequestInit, local = true) {
  return bridge.handle(new Request(`http://bridge${pathname}`, init), local)
}

describe("a gadget end to end", () => {
  test("pairs, says hello, and runs the four built-ins", async () => {
    const { pairing } = await connect(plain())
    const info = bridge.registry.get(pairing.id)
    expect(info.online).toBe(true)
    expect(info.commands.map((c) => c.name)).toEqual(["system.run", "file.read", "file.write", "device.health"])

    const run = await bridge.registry.invoke(pairing.id, {
      command: "system.run",
      args: { argv: ["sh", "-c", "echo hello; exit 3"] },
    })
    expect(run).toMatchObject({ output: "hello\n", exitCode: 3, isError: true })

    const dir = temp.dir
    const target = path.join(dir, "note.txt")
    await bridge.registry.invoke(pairing.id, {
      command: "file.write",
      args: { path: target, content: "from the agent" },
    })
    const read = await bridge.registry.invoke(pairing.id, { command: "file.read", args: { path: target } })
    expect(JSON.parse(read.output)).toMatchObject({ content: "from the agent", eof: true })

    const health = await bridge.registry.invoke(pairing.id, { command: "device.health" })
    expect(JSON.parse(health.output).memory.totalBytes).toBeGreaterThan(0)
  })

  test("a custom command and its failure travel as data", async () => {
    const gadget = new Gadget({
      name: "custom",
      builtins: false,
      log: () => undefined,
      commands: {
        "led.set": {
          description: "set the led",
          args: { type: "object", properties: { on: { type: "boolean" } } },
          async run({ on }: { on: boolean }) {
            if (on === undefined) throw new Error("on is required")
            return `led ${on ? "on" : "off"}`
          },
        },
      },
    })
    const { pairing } = await connect(gadget)
    expect((await bridge.registry.invoke(pairing.id, { command: "led.set", args: { on: true } })).output).toBe("led on")
    const failed = await bridge.registry.invoke(pairing.id, { command: "led.set", args: {} })
    expect(failed).toMatchObject({ isError: true, output: "on is required" })
  })

  test("a command past its deadline is aborted on the device and times out on the bridge", async () => {
    const gadget = new Gadget({
      name: "slow",
      builtins: false,
      log: () => undefined,
      commands: {
        "slow.wait": {
          description: "wait",
          args: { type: "object" },
          async run(_args, ctx) {
            await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }))
            return "aborted"
          },
        },
      },
    })
    const { pairing } = await connect(gadget)
    const error = await rejection(bridge.registry.invoke(pairing.id, { command: "slow.wait", timeoutMs: 150 }))
    expect((error as GadgetError).tag).toBe("Timeout")
    // The device is free again: the next command runs.
    const next = await bridge.registry
      .invoke(pairing.id, { command: "slow.wait", timeoutMs: 100 })
      .catch((e: GadgetError) => e)
    expect(next).toBeInstanceOf(GadgetError)
  })

  test("a message becomes a session, then continues it", async () => {
    const gadget = plain()
    const { pairing } = await connect(gadget)
    const first = await gadget.send("front door opened")
    expect(first.sessionID).toBe("ses_new")
    await gadget.send("and closed", first.sessionID)
    expect(calls.messages).toEqual([
      { device: pairing.id, text: "front door opened", sessionID: undefined },
      { device: pairing.id, text: "and closed", sessionID: "ses_new" },
    ])
  })

  test("a device cannot write into a session it did not start", async () => {
    const gadget = plain()
    await connect(gadget)
    const error = await rejection(gadget.send("hello", "ses_operators_own"))
    expect((error as GadgetError).tag).toBe("Denied")
    expect(calls.messages).toEqual([])
  })

  test("a button press reaches the host and says whether it was handled", async () => {
    const pressed: string[] = []
    const gadget = new Gadget({
      name: "buttons",
      builtins: false,
      log: () => undefined,
      buttons: {
        keys: ["ok", "next"],
        start: (onPress) => (setTimeout(() => (onPress("ok"), onPress("next")), 50), () => undefined),
      },
    })
    await connect(gadget)
    await until(() => calls.presses.length === 2)
    pressed.push(...calls.presses.map((p) => `${p.event.key}`))
    expect(pressed).toEqual(["ok", "next"])
  })

  test("a tree is drawn on the device's display", async () => {
    const drawn: Array<{ tree: Tree; columns: number }> = []
    const gadget = new Gadget({
      name: "panel",
      builtins: false,
      log: () => undefined,
      display: {
        spec: { columns: 12, rows: 3, depth: 1, format: "tree" },
        draw: (tree, viewport) => void drawn.push({ tree, columns: viewport.columns }),
      },
    })
    const { pairing } = await connect(gadget)
    bridge.registry.show(pairing.id, { type: "Markdown", props: { text: "# Build green" } })
    await until(() => drawn.length === 1)
    expect(drawn[0]).toMatchObject({ tree: { type: "Markdown" }, columns: 12 })
  })

  test("the terminal driver lays a tree out for the panel", async () => {
    let out = ""
    const stream = { write: (chunk: string) => ((out += chunk), true) } as unknown as NodeJS.WritableStream
    const gadget = new Gadget({
      name: "term",
      builtins: false,
      log: () => undefined,
      display: display.terminal({ columns: 10, rows: 2, stream }),
    })
    const { pairing } = await connect(gadget)
    bridge.registry.show(pairing.id, { type: "Text", props: {}, children: ["hello"] })
    await until(() => out.includes("hello"))
    expect(out).toContain("│hello     │")
  })

  test("a bitmap panel receives the pixels the bridge rendered", async () => {
    const frames: Array<{ width: number; height: number; ink: number }> = []
    const gadget = new Gadget({
      name: "epaper",
      builtins: false,
      log: () => undefined,
      display: display.bitmap({
        width: 64,
        height: 24,
        push: (bitmap) =>
          void frames.push({
            width: bitmap.width,
            height: bitmap.height,
            ink: bitmap.pixels.reduce((n, v) => n + v, 0),
          }),
      }),
    })
    const { pairing } = await connect(gadget)
    expect(bridge.registry.get(pairing.id).display).toMatchObject({
      format: "bitmap",
      width: 64,
      height: 24,
      columns: 10,
      rows: 3,
    })
    bridge.registry.show(pairing.id, { type: "Markdown", props: { text: "# Build green" } })
    await until(() => frames.length === 1)
    expect(frames[0]).toMatchObject({ width: 64, height: 24 })
    expect(frames[0]!.ink).toBeGreaterThan(20)
  })

  test("a display that cannot draw does not take the command channel down", async () => {
    const attempts: string[] = []
    const gadget = new Gadget({
      name: "broken-panel",
      log: () => undefined,
      display: {
        spec: { columns: 20, rows: 4, depth: 1, format: "tree" },
        draw() {
          attempts.push("draw")
          throw new Error("/dev/fb0 is not writable")
        },
      },
    })
    const { pairing } = await connect(gadget)
    bridge.registry.show(pairing.id, { type: "Text", props: {}, children: ["x"] })
    bridge.registry.tell(pairing.id, "and a message")
    await until(() => attempts.length === 2)
    // The feed is still up and commands still run.
    expect(bridge.registry.online(pairing.id)).toBe(true)
    const echoed = await bridge.registry.invoke(pairing.id, {
      command: "system.run",
      args: { argv: ["echo", "alive"] },
    })
    expect(echoed.output).toBe("alive\n")
  })

  test("a message sent to a bitmap panel is not drawn as a tree, and does not drop the feed", async () => {
    const frames: number[] = []
    const gadget = new Gadget({
      name: "epaper-msg",
      log: () => undefined,
      display: display.bitmap({ width: 64, height: 24, push: (bitmap) => void frames.push(bitmap.width) }),
    })
    const { pairing } = await connect(gadget)
    bridge.registry.tell(pairing.id, "hello panel")
    const echoed = await bridge.registry.invoke(pairing.id, {
      command: "system.run",
      args: { argv: ["echo", "still here"] },
    })
    expect(echoed.output).toBe("still here\n")
    expect(frames).toEqual([])
    expect(bridge.registry.online(pairing.id)).toBe(true)
  })

  test("a feed the bridge closed is reconnected after a delay, not at once", async () => {
    const lines: string[] = []
    const gadget = new Gadget({ name: "polite", builtins: false, log: (line) => void lines.push(line) })
    const { pairing } = await connect(gadget)
    const rival = new FakeFeed()
    // Another connection with the same token (a second process) evicts this one; two of them would otherwise loop at full speed.
    bridge.registry.attach(pairing.id, rival)
    await until(() => lines.some((line) => line.startsWith("feed closed by the bridge; reconnecting in")))
    await Bun.sleep(300)
    expect(rival.closed).toBeUndefined()
    await until(() => rival.closed !== undefined, 4_000)
    expect(rival.closed).toBe("replaced by a newer connection")
  })

  test("a silent connection is noticed by the transport", async () => {
    const { Transport } = await import("@nikcli-ai/gadget")
    const silent = Object.assign(
      async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
      { preconnect: () => undefined },
    ) as typeof fetch
    const transport = new Transport({ server: "http://silent.invalid", token: "nkg_x", fetch: silent })
    const error = await rejection(transport.feed("x", () => undefined, undefined, 80))
    expect(String(error)).toMatch(/went quiet/)
  })

  test("revoking unpairs the device and its next connect is refused", async () => {
    const gadget = plain()
    const { pairing, ended } = await connect(gadget)
    bridge.registry.revoke(pairing.id)
    const error = await ended
    expect(error).toBeInstanceOf(GadgetError)
    expect((error as GadgetError).tag).toBe("TokenRevoked")
  })
})

describe("the routes", () => {
  test("the root says what it is and whether pairing is open", async () => {
    const closed = await (await admin("/")).json()
    expect(closed).toMatchObject({ name: "nikcli-gadgets", protocol: 1, pairing: false })
    bridge.registry.openPairing()
    expect(await (await admin("/")).json()).toMatchObject({ pairing: true })
  })

  test("device routes need a token, and a token only opens its own device", async () => {
    const none = await admin("/devices/x/hello", { method: "PUT", body: "{}" })
    expect(none.status).toBe(404)
    expect(((await none.json()) as { error: { tag: string } }).error.tag).toBe("NotPaired")

    const { pairing } = await connect(plain("one"))
    // A second machine: two gadgets on one machine share a fingerprint and are one device.
    const other = bridge.registry.pair({
      code: bridge.registry.openPairing().code,
      name: "two",
      platform: { os: "linux", arch: "arm64" },
      fingerprint: "another-machine-0123456789",
      button: false,
    })
    expect(other.id).not.toBe(pairing.id)
    const crossed = await admin(`/devices/${pairing.id}/message`, {
      method: "POST",
      headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    })
    expect(crossed.status).toBe(403)
  })

  test("a device that has not pressed its button reaches nothing", async () => {
    const paired = bridge.registry.pair({
      code: bridge.registry.openPairing().code,
      name: "needs-button",
      platform: { os: "linux", arch: "arm64" },
      fingerprint: "button-device-0123456789",
      button: true,
    })
    expect(paired.confirm).toBe(true)
    const post = (path: string, body: unknown) =>
      admin(`/devices/${paired.id}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    for (const [path, body] of [
      ["/message", { text: "inject this" }],
      ["/event", { kind: "press", key: "ok" }],
      ["/result", { callID: "x", output: "" }],
    ] as const) {
      const refused = await post(path, body)
      expect(refused.status).toBe(409)
      expect(((await refused.json()) as { error: { tag: string } }).error.tag).toBe("Unconfirmed")
    }
    expect(calls.messages).toEqual([])
    // Pressing the button is what opens the door.
    const confirmed = await admin("/pair/confirm", {
      method: "POST",
      headers: { authorization: `Bearer ${paired.token}` },
      body: "{}",
    })
    expect(confirmed.status).toBe(200)
    expect((await post("/message", { text: "now it may" })).status).toBe(202)
  })

  test("admin routes refuse what a browser sends", async () => {
    const get = (headers: Record<string, string>) => admin("/admin/devices", { headers })
    const tag = async (response: Response) => ((await response.json()) as { error: { tag: string } }).error.tag
    const withOrigin = await get({ origin: "http://evil.example" })
    expect(withOrigin.status).toBe(403)
    expect(await tag(withOrigin)).toBe("Denied")
    const rebound = await get({ host: "evil.example:4097" })
    expect(rebound.status).toBe(403)
    const textPlain = await admin("/admin/pair", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "2" },
      body: "{}",
    })
    expect(textPlain.status).toBe(400)
    // What the TUI and the CLI send is still welcome.
    for (const host of ["127.0.0.1:4097", "localhost:4097", "[::1]:4097", "localhost"]) {
      expect((await get({ host })).status).toBe(200)
    }
    const json = await admin("/admin/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(json.status).toBe(200)
  })

  test("admin routes answer this machine only", async () => {
    const remote = await admin("/admin/devices", undefined, false)
    expect(remote.status).toBe(403)
    expect(((await remote.json()) as { error: { tag: string } }).error.tag).toBe("Denied")
    const local = await admin("/admin/devices")
    expect(local.status).toBe(200)
    expect(await local.json()).toEqual([])
  })

  test("a request that went through a proxy is not local", async () => {
    const response = await fetch(`${server()}/admin/devices`, { headers: { "x-forwarded-for": "10.0.0.9" } })
    expect(response.status).toBe(403)
    expect((await fetch(`${server()}/admin/devices`)).status).toBe(200)
  })

  test("admin can pair, list, ask for health, tell and revoke", async () => {
    const window = (await (await admin("/admin/pair", { method: "POST" })).json()) as { code: string; url: string }
    expect(window.code).toMatch(/^\d{6}$/)
    expect(window.url).toBe(`http://127.0.0.1:${bridge.port}`)
    const gadget = plain("admin-one")
    const pairing = await gadget.pair(server(), window.code)
    const controller = new AbortController()
    void gadget.run({ signal: controller.signal, pairing }).catch(() => undefined)
    stop.push(() => controller.abort())
    await until(() => bridge.registry.online(pairing.id))

    const list = (await (await admin("/admin/devices")).json()) as GadgetInfo[]
    expect(list.map((d) => d.id)).toEqual(["admin-one"])
    // Running a command or drawing is the agent's `gadget` tool, which asks first. Over HTTP, any local process could do it
    // without asking (the agent's own shell included), so these routes do not exist.
    for (const action of ["invoke", "show"]) {
      const refused = await admin(`/admin/devices/${pairing.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "system.run", args: { argv: ["echo", "hi"] }, tree: {} }),
      })
      expect(refused.status).toBe(400)
    }
    const health = (await (await admin(`/admin/devices/${pairing.id}/health`)).json()) as { uptimeSec: number }
    expect(health.uptimeSec).toBeGreaterThanOrEqual(0)
    const told = await admin(`/admin/devices/${pairing.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    })
    expect(told.status).toBe(200)
    const gone = await admin(`/admin/devices/${pairing.id}`, { method: "DELETE" })
    expect(gone.status).toBe(200)
    expect(((await (await admin("/admin/devices")).json()) as unknown[]).length).toBe(0)
  })

  test("typed failures carry their status and tag", async () => {
    const closed = await admin("/pair", { method: "POST", body: JSON.stringify({ code: "000000" }) })
    expect(closed.status).toBe(410)
    expect(((await closed.json()) as { error: { tag: string } }).error.tag).toBe("PairingClosed")
    const invalid = await admin("/pair", { method: "POST", body: "{not json" })
    expect(invalid.status).toBe(400)
    const huge = await admin("/pair", {
      method: "POST",
      body: JSON.stringify({ pad: "x".repeat(4 * 1024 * 1024 + 300 * 1024) }),
    })
    expect(huge.status).toBe(413)
    const missing = await admin("/nowhere")
    expect(missing.status).toBe(404)
  })

  test("a message with no host instance ready is Offline, not a crash", async () => {
    const idle = new Bridge({ port: 0, host: "127.0.0.1", log: () => undefined })
    idle.start()
    try {
      const { code } = idle.registry.openPairing()
      const gadget = plain("no-host")
      const pairing = await gadget.pair(`http://127.0.0.1:${idle.port}`, code)
      const controller = new AbortController()
      void gadget.run({ signal: controller.signal, pairing }).catch(() => undefined)
      await until(() => idle.registry.online(pairing.id))
      const error = await rejection(gadget.send("hello"))
      expect((error as GadgetError).tag).toBe("Offline")
      controller.abort()
    } finally {
      idle.stop()
    }
  })
})

describe("the listener", () => {
  test("a port that is taken is reported, not thrown", () => {
    const second = new Bridge({ port: bridge.port, host: "127.0.0.1", log: () => undefined })
    expect(second.start()).toBe(false)
    expect(second.listening).toBe(false)
    expect(second.problem).toBeTruthy()
  })

  test("stopping closes feeds so devices see the bridge go", async () => {
    const { pairing } = await connect(plain())
    bridge.stop()
    expect(bridge.registry.online(pairing.id)).toBe(false)
    expect(bridge.listening).toBe(false)
  })
})

describe("the pairing address", () => {
  const nic = (family: string, address: string, internal = false) => [{ family, address, internal }] as never
  test("is a physical interface's address, not docker0's", async () => {
    const { lanAddress } = await import("../src/bridge.ts")
    expect(
      lanAddress({
        docker0: nic("IPv4", "172.17.0.1"),
        eth0: nic("IPv4", "192.168.1.5"),
        lo: nic("IPv4", "127.0.0.1", true),
      }),
    ).toBe("192.168.1.5")
    expect(lanAddress({ "br-1a2b": nic("IPv4", "172.20.0.1"), wlan0: nic("IPv4", "10.0.0.7") })).toBe("10.0.0.7")
    expect(lanAddress({ docker0: nic("IPv4", "172.17.0.1") })).toBe("172.17.0.1")
    expect(lanAddress({ lo: nic("IPv4", "127.0.0.1", true) })).toBe("127.0.0.1")
  })

  test("brackets an IPv6 host", () => {
    expect(new Bridge({ port: 4097, host: "::1" }).url).toBe("http://[::1]:4097")
    expect(new Bridge({ port: 4097, host: "192.168.1.9" }).url).toBe("http://192.168.1.9:4097")
  })
})
