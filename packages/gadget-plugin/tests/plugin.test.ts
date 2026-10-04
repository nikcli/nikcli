import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { Hooks, PluginInput } from "@nikcli-ai/plugin"
import { Gadget } from "@nikcli-ai/gadget"
import plugin from "../src/index.ts"
import { rejection, tempDir, until } from "./helpers.ts"

type Ask = { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }

interface Harness {
  input: PluginInput
  created: Array<{ title?: string; directory?: string }>
  prompts: Array<{ sessionID: string; text: string }>
  events: Array<Record<string, unknown>>
}

function harness(): Harness {
  const created: Harness["created"] = []
  const prompts: Harness["prompts"] = []
  const events: Harness["events"] = []
  const client = {
    session: {
      create: async (input: { title?: string; directory?: string }) => {
        created.push(input)
        return { data: { id: `ses_${created.length}` }, error: undefined }
      },
      promptAsync: async (input: { sessionID: string; parts: Array<{ text: string }> }) => {
        prompts.push({ sessionID: input.sessionID, text: input.parts[0]!.text })
        return { data: undefined, error: undefined }
      },
    },
    mod: {
      event: async (input: Record<string, unknown>) => {
        events.push(input)
        return { data: { handled: input.key === "ok" }, error: undefined }
      },
    },
  }
  const input = {
    client,
    project: { id: "p", worktree: "/work" },
    directory: "/work",
    worktree: "/work",
    serverUrl: new URL("http://localhost:4096"),
    $: undefined,
  } as unknown as PluginInput
  return { input, created, prompts, events }
}

function context(asks: Ask[], deny?: (ask: Ask) => boolean) {
  return {
    sessionID: "ses",
    messageID: "msg",
    callID: "call",
    agent: "build",
    abort: new AbortController().signal,
    metadata() {},
    async progress() {},
    async ask(input: Ask) {
      asks.push(input)
      if (deny?.(input)) throw new Error("permission denied")
    },
  }
}

type Execute = (
  args: Record<string, unknown>,
  ctx: ReturnType<typeof context>,
) => Promise<{ title?: string; output: string; metadata?: Record<string, unknown> }>

let temp: ReturnType<typeof tempDir>
let hooks: Hooks[] = []
let aborts: Array<() => void> = []
const saved = { state: process.env.NIKCLI_GADGET_STATE }

beforeEach(() => {
  temp = tempDir()
  process.env.NIKCLI_GADGET_STATE = path.join(temp.dir, "device")
})

afterEach(async () => {
  for (const abort of aborts) abort()
  aborts = []
  for (const hook of hooks) await hook.dispose?.()
  hooks = []
  temp.cleanup()
  if (saved.state === undefined) delete process.env.NIKCLI_GADGET_STATE
  else process.env.NIKCLI_GADGET_STATE = saved.state
})

async function load(h = harness(), options: Record<string, unknown> = {}) {
  const hook = await plugin.server(h.input, {
    port: 0,
    host: "127.0.0.1",
    file: path.join(temp.dir, "devices.json"),
    ...options,
  })
  hooks.push(hook)
  const execute = (hook.tool?.gadget as unknown as { execute: Execute } | undefined)?.execute
  return { h, hook, execute: execute! }
}

async function pairDevice(execute: Execute, gadget: Gadget, asks: Ask[] = []) {
  const paired = await execute({ action: "pair" }, context(asks))
  const { code, url } = paired.metadata as { code: string; url: string }
  const pairing = await gadget.pair(url, code)
  const controller = new AbortController()
  void gadget.run({ signal: controller.signal, pairing }).catch(() => undefined)
  aborts.push(() => controller.abort())
  const started = Date.now()
  while (true) {
    const listed = await execute({ action: "list" }, context([]))
    if (listed.output.includes(`${pairing.id} (`) && listed.output.includes("— online")) break
    if (Date.now() - started > 3_000) throw new Error(`${pairing.id} did not come online`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return pairing
}

describe("the plugin", () => {
  test("is a v1 server plugin that registers the gadget tool", async () => {
    expect(plugin.id).toBe("nikcli:gadgets")
    const { hook } = await load()
    expect(Object.keys(hook.tool ?? {})).toEqual(["gadget"])
    expect(typeof hook.dispose).toBe("function")
  })

  test("enabled:false registers nothing and starts nothing", async () => {
    const { hook } = await load(harness(), { enabled: false })
    expect(hook).toEqual({})
  })

  test("project instances share one bridge; the last dispose stops it", async () => {
    const first = await load()
    const second = await load(harness())
    const ctx = context([])
    expect((await first.execute({ action: "list" }, ctx)).output).toBe("no gadgets are paired")
    await first.hook.dispose?.()
    expect((await second.execute({ action: "list" }, ctx)).output).toBe("no gadgets are paired")
    await second.hook.dispose?.()
    const error = await rejection(second.execute({ action: "list" }, ctx))
    expect((error as Error).message).toMatch(/stopped/)
  })

  test("a taken port is reported by the tool instead of crashing the plugin", async () => {
    const first = await load()
    const url = (await first.execute({ action: "pair" }, context([]))).metadata!.url as string
    const port = Number(new URL(url).port)
    const second = await load(harness(), { port })
    const error = await rejection(second.execute({ action: "list" }, context([])))
    expect((error as Error).message).toMatch(/could not start/)
  })
})

describe("the gadget tool", () => {
  test("pair asks, then returns a code and the command to run", async () => {
    const { execute } = await load()
    const asks: Ask[] = []
    const result = await execute({ action: "pair" }, context(asks))
    expect(asks).toEqual([{ permission: "gadget", patterns: ["pair"], always: [], metadata: { action: "pair" } }])
    expect(result.output).toMatch(/Code: \d{6}/)
    expect(result.output).toContain("nikcli-gadget pair --server http://127.0.0.1:")
  })

  test("a denied pairing opens no window", async () => {
    const { execute, hook } = await load()
    const error = await rejection(
      execute(
        { action: "pair" },
        context([], () => true),
      ),
    )
    expect((error as Error).message).toBe("permission denied")
    expect(hook.tool).toBeDefined()
  })

  test("run asks per device and command; health and list do not", async () => {
    const { execute } = await load()
    const pairing = await pairDevice(execute, new Gadget({ name: "pi", log: () => undefined }))
    const asks: Ask[] = []
    const ctx = context(asks)

    const listed = await execute({ action: "list" }, ctx)
    expect(listed.output).toContain(`${pairing.id} (pi) — online`)
    expect(listed.output).toContain("system.run")

    const health = await execute({ action: "health", device: pairing.id }, ctx)
    expect(health.output).toContain("ok")
    expect(JSON.parse(health.output.split("\n").slice(1).join("\n")).memory.totalBytes).toBeGreaterThan(0)
    const viaRun = await execute({ action: "run", device: pairing.id, command: "device.health" }, ctx)
    expect(viaRun.metadata?.isError).toBe(false)
    expect(asks).toHaveLength(0)

    const run = await execute(
      { action: "run", device: pairing.id, command: "system.run", args: { argv: ["echo", "hi"] } },
      ctx,
    )
    expect(asks).toEqual([
      {
        permission: "gadget",
        patterns: [`${pairing.id}:system.run`],
        // system.run takes any argv, so there is no "always allow" to offer for it.
        always: [],
        metadata: { action: "run", device: pairing.id, command: "system.run", args: { argv: ["echo", "hi"] } },
      },
    ])
    expect(run.output).toContain("hi\n")
    expect(run.metadata).toMatchObject({ exitCode: 0, isError: false })
  })

  test("a denied run never reaches the device", async () => {
    const { execute } = await load()
    const executed: string[] = []
    const gadget = new Gadget({
      name: "guarded",
      builtins: false,
      log: () => undefined,
      commands: {
        "door.open": {
          description: "open the door",
          args: { type: "object" },
          async run() {
            executed.push("door.open")
            return "open"
          },
        },
      },
    })
    const pairing = await pairDevice(execute, gadget)
    const error = await rejection(
      execute(
        { action: "run", device: pairing.id, command: "door.open" },
        context([], () => true),
      ),
    )
    expect((error as Error).message).toBe("permission denied")
    expect(executed).toEqual([])
    // The same call with permission goes through.
    expect((await execute({ action: "run", device: pairing.id, command: "door.open" }, context([]))).output).toContain(
      "open",
    )
    expect(executed).toEqual(["door.open"])
  })

  test("a command with a narrow purpose can be remembered; an open-ended one cannot", async () => {
    const { execute } = await load()
    const gadget = new Gadget({
      name: "lamp",
      log: () => undefined,
      commands: {
        "lamp.toggle": { description: "toggle the lamp", args: { type: "object" }, run: async () => "toggled" },
      },
    })
    const pairing = await pairDevice(execute, gadget)
    const asks: Ask[] = []
    const ctx = context(asks)
    await execute({ action: "run", device: pairing.id, command: "lamp.toggle" }, ctx)
    await execute({ action: "run", device: pairing.id, command: "system.run", args: { argv: ["true"] } }, ctx)
    await execute(
      { action: "run", device: pairing.id, command: "file.write", args: { path: "/tmp/x", content: "" } },
      ctx,
    )
    expect(asks.map((ask) => [ask.patterns[0], ask.always])).toEqual([
      [`${pairing.id}:lamp.toggle`, [`${pairing.id}:lamp.toggle`]],
      [`${pairing.id}:system.run`, []],
      [`${pairing.id}:file.write`, []],
    ])
  })

  test("typed failures reach the model by name", async () => {
    const { execute } = await load()
    const ctx = context([])
    const unknown = await rejection(execute({ action: "run", device: "ghost", command: "system.run" }, ctx))
    expect((unknown as Error).message).toMatch(/^GadgetError\.NotPaired:/)
    const pairing = await pairDevice(execute, new Gadget({ name: "pi", log: () => undefined }))
    const command = await rejection(execute({ action: "run", device: pairing.id, command: "nope.x" }, ctx))
    expect((command as Error).message).toMatch(/^GadgetError\.CommandUnknown:/)
    const missing = await rejection(execute({ action: "run", device: pairing.id }, ctx))
    expect((missing as Error).message).toBe("run needs command")
  })

  test("send reaches the device, show draws on it, revoke asks and unpairs", async () => {
    const { execute } = await load()
    const told: string[] = []
    const drawn: string[] = []
    const gadget = new Gadget({
      name: "panel",
      builtins: false,
      log: () => undefined,
      onMessage: (text) => void told.push(text),
      display: { spec: { columns: 20, rows: 4, depth: 1, format: "tree" }, draw: (tree) => void drawn.push(tree.type) },
    })
    const pairing = await pairDevice(execute, gadget)
    const ctx = context([])
    await execute({ action: "send", device: pairing.id, text: "deploy done" }, ctx)
    await execute({ action: "show", device: pairing.id, tree: { type: "Markdown", props: { text: "# ok" } } }, ctx)
    await until(() => told.length === 1 && drawn.length >= 1)
    expect(told).toEqual(["deploy done"])
    expect(drawn).toContain("Markdown")

    const asks: Ask[] = []
    await execute({ action: "revoke", device: pairing.id }, context(asks))
    expect(asks[0]).toMatchObject({ permission: "gadget", patterns: [`${pairing.id}:revoke`] })
    expect((await execute({ action: "list" }, ctx)).output).toBe("no gadgets are paired")
  })
})

describe("the host hooks", () => {
  test("a device message starts a session, tagged with the device, and continues one", async () => {
    const h = harness()
    const { execute } = await load(h)
    const gadget = new Gadget({ name: "door", log: () => undefined })
    const pairing = await pairDevice(execute, gadget)
    const first = await gadget.send("front door opened")
    expect(first.sessionID).toBe("ses_1")
    expect(h.created).toEqual([{ title: "Gadget: door", directory: "/work" }])
    await gadget.send("and closed", first.sessionID)
    expect(h.created).toHaveLength(1)
    expect(h.prompts).toEqual([
      { sessionID: "ses_1", text: `[gadget ${pairing.id}] front door opened` },
      { sessionID: "ses_1", text: `[gadget ${pairing.id}] and closed` },
    ])
  })

  test("a press becomes a Gadget ui event for the mods", async () => {
    const h = harness()
    const { execute } = await load(h)
    const gadget = new Gadget({
      name: "keys",
      builtins: false,
      log: () => undefined,
      buttons: { keys: ["ok"], start: (onPress) => (setTimeout(() => onPress("ok"), 80), () => undefined) },
    })
    const pairing = await pairDevice(execute, gadget)
    await until(() => h.events.length === 1)
    expect(h.events[0]).toEqual({
      kind: "press",
      key: "ok",
      component: "Gadget",
      requestId: pairing.id,
      directory: "/work",
    })
  })
})
