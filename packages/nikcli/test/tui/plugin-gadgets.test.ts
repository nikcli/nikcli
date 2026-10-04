import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { TuiKeymapCommand, TuiKeymapLayer, TuiPluginApi } from "@nikcli-ai/plugin/tui"
import { readV2TuiPlugin } from "@tui/plugin/v2"

/**
 * The gadgets TUI plugin through the real v2 host validation.
 *
 * `packages/gadget-plugin` tests its commands against a fake context; this one
 * proves the TUI host accepts the module as it ships — manifest, capabilities,
 * the `/gadget` slash mapping — and that running the command reaches a live
 * bridge and shows its answer in a dialog.
 */
const pluginDir = path.resolve(import.meta.dir, "../../../gadget-plugin")
const tui = (await import(path.join(pluginDir, "src", "tui.tsx"))).default
const { Bridge } = await import(path.join(pluginDir, "src", "bridge.ts"))

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-gadgets-tui-"))
afterAll(() => fs.rm(dir, { recursive: true, force: true }))

function host(url: string) {
  const layers: Array<() => TuiKeymapLayer> = []
  const dialogs: Array<{ title: string; message: string }> = []
  const toasts: string[] = []
  const slotNames: string[] = []
  const api = {
    client: {},
    data: {},
    storage: {},
    keymap: {
      registerLayer(layer: () => TuiKeymapLayer) {
        layers.push(layer)
        return () => undefined
      },
    },
    ui: {
      dialog: { replace: (render: () => unknown) => void render(), clear() {} },
      DialogAlert: (props: { title: string; message: string }) => void dialogs.push(props),
      toast: (input: { message: string }) => void toasts.push(input.message),
    },
    slots: {
      registerDisposable: (plugin: { slots: Record<string, unknown> }) => (
        slotNames.push(...Object.keys(plugin.slots)),
        () => undefined
      ),
    },
    lifecycle: { onDispose: () => () => undefined },
  } as unknown as TuiPluginApi
  const commands = (): TuiKeymapCommand[] => layers.flatMap((layer) => layer().commands as TuiKeymapCommand[])
  return { api, commands, dialogs, toasts, slotNames, url }
}

describe("gadgets TUI plugin", () => {
  it("is accepted by the v2 host and registers /gadget and the palette entry", async () => {
    const loaded = readV2TuiPlugin({ default: tui }, "file:///gadgets/tui.ts")!
    expect(loaded.id).toBe("nikcli:gadgets")
    const { api, commands, slotNames } = host("http://127.0.0.1:1")
    await loaded.tui(api, undefined, {} as never)
    expect(slotNames).toEqual(["sidebar.content"])
    const all = commands()
    expect(all.map((command) => command.name)).toEqual(["gadget", "gadget.pair"])
    expect(all[0]).toMatchObject({
      slashName: "gadget",
      slashAliases: ["gadgets"],
      slashArguments: true,
      namespace: "Gadgets",
    })
  })

  it("runs /gadget pair against a live bridge and shows a code that the bridge issued", async () => {
    const bridge = new Bridge({
      port: 0,
      host: "127.0.0.1",
      file: path.join(dir, "devices.json"),
      log: () => undefined,
    })
    expect(bridge.start()).toBe(true)
    try {
      const loaded = readV2TuiPlugin({ default: tui }, "file:///gadgets/tui.ts")!
      const { api, commands, dialogs } = host(`http://127.0.0.1:${bridge.port}`)
      await loaded.tui(api, { url: `http://127.0.0.1:${bridge.port}` }, {} as never)
      commands()
        .find((command) => command.name === "gadget")!
        .run("pair")
      const started = Date.now()
      while (dialogs.length === 0) {
        if (Date.now() - started > 3_000) throw new Error("no dialog was shown")
        await Bun.sleep(10)
      }
      const code = /Code: (\d{6})/.exec(dialogs[0]!.message)![1]!
      expect(bridge.registry.pairing.open).toBe(true)
      const paired = bridge.registry.pair({
        code,
        name: "from-tui-test",
        platform: { os: "linux", arch: "x64" },
        fingerprint: "tui-test-0123456789",
        button: false,
      })
      expect(paired.id).toBe("from-tui-test")
    } finally {
      bridge.stop()
    }
  })
})
