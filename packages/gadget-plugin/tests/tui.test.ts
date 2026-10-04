import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { parseManifest } from "@nikcli-ai/plugin/v2/manifest"
import tui, { setup } from "../src/tui.tsx"
import { Bridge } from "../src/bridge.ts"
import { Gadget } from "@nikcli-ai/gadget"
import type { Context } from "@nikcli-ai/plugin/v2/tui/context"
import { tempDir, until } from "./helpers.ts"

interface Seen {
  commands: Array<{
    name: string
    slash?: { name: string; aliases?: string[]; arguments?: boolean }
    run: (input?: string) => void
  }>
  dialogs: Array<{ title: string; message: string }>
  toasts: Array<{ variant?: string; message: string; title?: string }>
  disposed: string[]
  slots: string[]
}

function context(url: string): { context: Context; seen: Seen } {
  const seen: Seen = { commands: [], dialogs: [], toasts: [], disposed: [], slots: [] }
  const ui = {
    command: (command: Seen["commands"][number]) => {
      seen.commands.push(command)
      return () => void seen.disposed.push(command.name)
    },
    dialog: {
      replace: (render: () => unknown) => void render(),
      clear: () => undefined,
    },
    DialogAlert: (props: { title: string; message: string }) => {
      seen.dialogs.push({ title: props.title, message: props.message })
      return undefined
    },
    toast: (input: Seen["toasts"][number]) => void seen.toasts.push(input),
    slot: (name: string) => {
      seen.slots.push(name)
      return () => void seen.disposed.push(`slot:${name}`)
    },
  }
  return { context: { options: { url }, ui } as unknown as Context, seen }
}

let temp: ReturnType<typeof tempDir>
let bridge: Bridge
let aborts: Array<() => void> = []
const saved = process.env.NIKCLI_GADGET_STATE

beforeEach(() => {
  temp = tempDir()
  process.env.NIKCLI_GADGET_STATE = path.join(temp.dir, "device")
  bridge = new Bridge({ port: 0, host: "127.0.0.1", file: path.join(temp.dir, "devices.json"), log: () => undefined })
  bridge.start()
})

afterEach(() => {
  for (const abort of aborts) abort()
  aborts = []
  bridge.stop()
  temp.cleanup()
  if (saved === undefined) delete process.env.NIKCLI_GADGET_STATE
  else process.env.NIKCLI_GADGET_STATE = saved
})

const url = () => `http://127.0.0.1:${bridge.port}`

async function paired(name = "pi"): Promise<string> {
  const gadget = new Gadget({ name, log: () => undefined })
  const pairing = await gadget.pair(url(), bridge.registry.openPairing().code)
  const controller = new AbortController()
  void gadget.run({ signal: controller.signal, pairing }).catch(() => undefined)
  aborts.push(() => controller.abort())
  await until(() => bridge.registry.online(pairing.id))
  return pairing.id
}

function slash(seen: Seen) {
  return seen.commands.find((command) => command.slash?.name === "gadget")!
}

describe("the TUI plugin", () => {
  test("its manifest is valid and asks only for what the TUI host supplies", () => {
    const manifest = parseManifest(tui.manifest, "nikcli:gadgets")
    expect(manifest.capabilities).toEqual(["commands", "routes"])
    expect(tui.id).toBe(manifest.id)
  })

  test("registers /gadget with arguments, a palette entry and the sidebar slot, and unregisters all three", () => {
    const { context: ctx, seen } = context(url())
    const dispose = setup(ctx)
    expect(seen.commands.map((c) => c.name)).toEqual(["gadget", "gadget.pair"])
    expect(slash(seen).slash).toEqual({ name: "gadget", aliases: ["gadgets"], arguments: true })
    dispose()
    expect(seen.slots).toEqual(["sidebar.content"])
    expect(seen.disposed).toEqual(["gadget", "gadget.pair", "slot:sidebar.content"])
  })

  test("/gadget lists what is paired, or says how to pair", async () => {
    const { context: ctx, seen } = context(url())
    setup(ctx)
    slash(seen).run("")
    await until(() => seen.dialogs.length === 1)
    expect(seen.dialogs[0]!.message).toContain("No gadgets are paired")
    const id = await paired()
    slash(seen).run("list")
    await until(() => seen.dialogs.length === 2)
    expect(seen.dialogs[1]!.message).toContain(id)
    expect(seen.dialogs[1]!.message).toContain("online")
  })

  test("/gadget pair shows a code that really pairs", async () => {
    const { context: ctx, seen } = context(url())
    setup(ctx)
    seen.commands.find((c) => c.name === "gadget.pair")!.run()
    await until(() => seen.dialogs.length === 1)
    const code = /Code: (\d{6})/.exec(seen.dialogs[0]!.message)![1]!
    expect(seen.dialogs[0]!.message).toContain(`--code ${code}`)
    const gadget = new Gadget({ name: "from-tui", log: () => undefined })
    expect((await gadget.pair(url(), code)).id).toBe("from-tui")
  })

  test("health, send and revoke act on a device", async () => {
    const id = await paired()
    const { context: ctx, seen } = context(url())
    setup(ctx)
    slash(seen).run(`health ${id}`)
    await until(() => seen.dialogs.length === 1)
    expect(seen.dialogs[0]!.message).toMatch(/uptime .*\nload .*\nmemory /)
    slash(seen).run(`send ${id} hello there`)
    await until(() => seen.toasts.length === 1)
    expect(seen.toasts[0]).toMatchObject({ variant: "success", message: `sent to ${id}` })
    slash(seen).run(`revoke ${id}`)
    await until(() => seen.toasts.length === 2)
    expect(seen.toasts[1]).toMatchObject({ variant: "success", message: `${id} unpaired` })
    expect(bridge.registry.list()).toHaveLength(0)
  })

  test("mistakes and failures become error toasts, never a crash", async () => {
    const { context: ctx, seen } = context(url())
    setup(ctx)
    slash(seen).run("health")
    slash(seen).run("frobnicate")
    slash(seen).run("revoke ghost")
    await until(() => seen.toasts.length === 3)
    const messages = seen.toasts.map((t) => t.message)
    expect(messages).toContain("usage: /gadget health <id>")
    expect(messages.some((m) => m.startsWith("unknown /gadget action frobnicate"))).toBe(true)
    expect(messages.some((m) => m.startsWith("GadgetError.NotPaired"))).toBe(true)
    expect(seen.toasts.every((t) => t.variant === "error")).toBe(true)
  })

  test("a bridge that is not running is explained", async () => {
    const dead = new Bridge({ port: 0, host: "127.0.0.1", log: () => undefined })
    dead.start()
    const gone = `http://127.0.0.1:${dead.port}`
    dead.stop()
    const { context: ctx, seen } = context(gone)
    setup(ctx)
    slash(seen).run("list")
    await until(() => seen.toasts.length === 1)
    expect(seen.toasts[0]!.message).toContain("not reachable")
  })
})
