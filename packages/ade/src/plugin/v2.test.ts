/**
 * The ADE adapter, exercised the way `packages/nikcli/test/tui/plugin-v2.test.ts`
 * exercises the TUI one: a real `Plugin.define` module, a real registry, and a
 * host that only records what it was told.
 */
import { describe, expect, test } from "bun:test"
import { Plugin } from "@nikcli-ai/plugin/v2/ade"
import type { Context } from "@nikcli-ai/plugin/v2/ade/context"
import { createPluginRegistry } from "./registry"
import { adaptV2AdePlugin, readV2AdePlugin, type AdePluginHost } from "./v2"
import { clearPluginStorage } from "./storage"

function host() {
  const opened: Array<{ id: string; pluginId: string; name: string; title: string }> = []
  const closed: string[] = []
  let palettes = 0

  const value: AdePluginHost = {
    registry: createPluginRegistry(),
    data: {
      project: () => ({ name: "nikcli", root: "C:/repo" }),
      session: {
        list: () => [],
        get: () => undefined,
        focused: () => undefined,
      },
    },
    showPalette: () => {
      palettes++
    },
    onPaneOpened: (pane) => {
      opened.push(pane)
    },
    onPaneClosed: (id) => {
      closed.push(id)
    },
  }

  return { value, opened, closed, palettes: () => palettes }
}

describe("adaptV2AdePlugin", () => {
  test("a definition owns a command, a pane and a section, and can tear each down", async () => {
    clearPluginStorage()
    const runtime = host()
    let context: Context | undefined
    let cleaned = 0
    let ran = 0
    let offCommand: (() => void) | undefined
    let offPane: (() => void) | undefined
    let offSection: (() => void) | undefined

    const definition = Plugin.define({
      id: "example.plugin",
      setup(input) {
        context = input
        offCommand = input.ui.command.register({
          id: "overview",
          title: "Mostra tutto",
          run: () => {
            ran++
          },
        })
        offPane = input.ui.pane.register({
          name: "settings",
          title: "Impostazioni",
          render: ({ data }) => `tab:${String(data?.tab)}`,
        })
        offSection = input.ui.section.register({ name: "panel", render: () => "panel" })
        return () => {
          cleaned++
        }
      },
    })

    const loaded = await adaptV2AdePlugin(definition, runtime.value, { enabled: true })
    expect(loaded.id).toBe("example.plugin")
    expect(context?.options).toEqual({ enabled: true })
    expect(context?.data.project()?.name).toBe("nikcli")

    // Commands reach the palette namespaced, so they cannot shadow ADE's own.
    expect(runtime.value.registry.commands().map((item) => item.key)).toEqual(["plugin:example.plugin:overview"])
    expect(runtime.value.registry.panes()).toHaveLength(1)
    expect(runtime.value.registry.sections()).toHaveLength(1)

    // An unlabelled group falls back to the plugin's own id, not to whatever
    // ADE group happens to sort first.
    expect(runtime.value.registry.commands()[0]!.group).toBe("example.plugin")

    context!.ui.command.run("overview")
    expect(ran).toBe(1)

    const paneId = context!.ui.pane.open({ name: "settings", data: { tab: "general" } })
    expect(paneId).toBeDefined()
    expect(runtime.opened).toEqual([
      { id: paneId!, pluginId: "example.plugin", name: "settings", title: "Impostazioni" },
    ])
    expect(context!.ui.pane.list()).toEqual([{ id: paneId!, name: "settings", data: { tab: "general" } }])
    expect(runtime.value.registry.definitionFor(paneId!)!.render({ data: { tab: "advanced" } })).toBe("tab:advanced")

    context!.ui.pane.close(paneId!)
    expect(runtime.closed).toEqual([paneId!])
    expect(context!.ui.pane.list()).toHaveLength(0)

    context!.ui.command.palette()
    expect(runtime.palettes()).toBe(1)

    offCommand!()
    offPane!()
    offSection!()
    expect(runtime.value.registry.commands()).toHaveLength(0)
    expect(runtime.value.registry.panes()).toHaveLength(0)
    expect(runtime.value.registry.sections()).toHaveLength(0)

    await loaded.dispose()
    expect(cleaned).toBe(1)
  })

  test("dispose runs the cleanup and removes everything the plugin left behind", async () => {
    clearPluginStorage()
    const runtime = host()
    const loaded = await adaptV2AdePlugin(
      Plugin.define({
        id: "example.plugin",
        setup(input) {
          input.ui.command.register({ id: "a", title: "A", run: () => {} })
          input.ui.pane.register({ name: "view", render: () => "view" })
          input.ui.section.register({ name: "panel", render: () => "panel" })
          input.ui.pane.open({ name: "view" })
        },
      }),
      runtime.value,
    )

    await loaded.dispose()
    expect(runtime.value.registry.commands()).toHaveLength(0)
    expect(runtime.value.registry.open()).toHaveLength(0)
    /*
     * The workbench has to be told, not just the registry. A tile left in the
     * grid with no definition behind it is a pane the user can see, focus,
     * and not close.
     */
    expect(runtime.closed).toHaveLength(1)
  })

  test("dispose is idempotent", async () => {
    clearPluginStorage()
    const runtime = host()
    let cleaned = 0
    const loaded = await adaptV2AdePlugin(
      Plugin.define({
        id: "example.plugin",
        setup: () => () => {
          cleaned++
        },
      }),
      runtime.value,
    )
    await loaded.dispose()
    await loaded.dispose()
    expect(cleaned).toBe(1)
  })

  /*
   * A plugin that threw halfway through setup has already registered things,
   * and there is no owner left to tidy up after it.
   */
  test("a setup that throws leaves nothing registered", async () => {
    clearPluginStorage()
    const runtime = host()
    await expect(
      adaptV2AdePlugin(
        Plugin.define({
          id: "example.plugin",
          setup(input) {
            input.ui.command.register({ id: "a", title: "A", run: () => {} })
            throw new Error("boom")
          },
        }),
        runtime.value,
      ),
    ).rejects.toThrow("boom")
    expect(runtime.value.registry.commands()).toHaveLength(0)
  })

  test("setup must return a cleanup or nothing", async () => {
    clearPluginStorage()
    const runtime = host()
    await expect(adaptV2AdePlugin({ id: "example.plugin", setup: () => 42 as never }, runtime.value)).rejects.toThrow(
      "must return a cleanup function or void",
    )
  })
})

describe("the trust boundary, at the point a plugin crosses it", () => {
  test("an identifier that could escape an attribute is refused", async () => {
    clearPluginStorage()
    const runtime = host()
    for (const id of ['a"b', "a b", "a:b", ""]) {
      await expect(
        adaptV2AdePlugin(
          Plugin.define({
            id: "example.plugin",
            setup(input) {
              input.ui.command.register({ id, title: "X", run: () => {} })
            },
          }),
          runtime.value,
        ),
      ).rejects.toThrow(/invalid id/)
    }
  })

  test("a pane and a section are checked the same way", async () => {
    clearPluginStorage()
    const runtime = host()
    await expect(
      adaptV2AdePlugin(
        Plugin.define({
          id: "example.plugin",
          setup(input) {
            input.ui.pane.register({ name: "a/b", render: () => "x" })
          },
        }),
        runtime.value,
      ),
    ).rejects.toThrow(/invalid id/)

    await expect(
      adaptV2AdePlugin(
        Plugin.define({
          id: "example.plugin",
          setup(input) {
            input.ui.section.register({ name: "<script>", render: () => "x" })
          },
        }),
        runtime.value,
      ),
    ).rejects.toThrow(/invalid id/)
  })

  test("a plugin cannot close a pane it does not own", async () => {
    clearPluginStorage()
    const runtime = host()
    const registry = runtime.value.registry
    registry.addPane({ pluginId: "other.plugin", name: "view", title: "View", render: () => "x" })
    const stranger = registry.openPane("other.plugin", "view")!

    let context: Context | undefined
    await adaptV2AdePlugin(
      Plugin.define({
        id: "example.plugin",
        setup(input) {
          context = input
        },
      }),
      runtime.value,
    )

    context!.ui.pane.close(stranger)
    expect(registry.open().map((item) => item.id)).toEqual([stranger])
    expect(runtime.closed).toHaveLength(0)
  })

  test("a plugin cannot run another plugin's command through its own context", async () => {
    clearPluginStorage()
    const runtime = host()
    let ran = 0
    runtime.value.registry.addCommand({
      pluginId: "other.plugin",
      commandId: "secret",
      title: "Secret",
      group: "other",
      run: () => {
        ran++
      },
    })

    let context: Context | undefined
    await adaptV2AdePlugin(
      Plugin.define({ id: "example.plugin", setup: (input) => void (context = input) }),
      runtime.value,
    )

    context!.ui.command.run("secret")
    context!.ui.command.run("plugin:other.plugin:secret")
    expect(ran).toBe(0)
  })

  test("a title is clamped and a missing one falls back to the id", async () => {
    clearPluginStorage()
    const runtime = host()
    await adaptV2AdePlugin(
      Plugin.define({
        id: "example.plugin",
        setup(input) {
          input.ui.command.register({ id: "long", title: "x".repeat(400), run: () => {} })
          input.ui.command.register({ id: "bare", title: undefined as never, run: () => {} })
        },
      }),
      runtime.value,
    )
    const [long, bare] = runtime.value.registry.commands()
    expect(long!.title.length).toBe(120)
    expect(bare!.title).toBe("bare")
  })
})

describe("readV2AdePlugin", () => {
  test("reads a Plugin.define module", () => {
    const definition = Plugin.define({ id: "example.plugin", setup: () => {} })
    expect(readV2AdePlugin({ default: definition }, "file:///example.js")?.id).toBe("example.plugin")
  })

  /*
   * "Not a v2 plugin" and "a broken v2 plugin" are different answers, exactly
   * as in `readV2TuiPlugin`: the first means try another reader, the second
   * means report it.
   */
  test("a module that is not a plugin is not an error", () => {
    expect(readV2AdePlugin({ default: { hello: "world" } }, "x")).toBeUndefined()
    expect(readV2AdePlugin({}, "x")).toBeUndefined()
    expect(readV2AdePlugin({ default: null }, "x")).toBeUndefined()
    expect(readV2AdePlugin({ default: [1] }, "x")).toBeUndefined()
  })

  test("a malformed v2 definition is an error", () => {
    expect(() => readV2AdePlugin({ default: { id: "", setup() {} } }, "broken")).toThrow("non-empty id")
    expect(() => readV2AdePlugin({ default: { id: "broken", setup: true } }, "broken")).toThrow("invalid setup export")
    // Checked before any of the plugin's code has run, so an unusable id can
    // never become a registration key.
    expect(() => readV2AdePlugin({ default: { id: "bad id", setup() {} } }, "broken")).toThrow(/invalid id/)
  })
})
