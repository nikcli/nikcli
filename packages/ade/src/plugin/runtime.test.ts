import { describe, expect, test } from "bun:test"
import { Plugin } from "@nikcli-ai/plugin/v2/ade"
import { createAdePluginRuntime, type RuntimeHost } from "./runtime"
import { clearPluginStorage } from "./storage"
import type { DiscoveryIO } from "./discovery"

function recordingHost() {
  const opened: string[] = []
  const closed: string[] = []
  const host: RuntimeHost = {
    data: {
      project: () => ({ name: "nikcli", root: "C:/repo" }),
      session: { list: () => [], get: () => undefined, focused: () => undefined },
    },
    showPalette: () => {},
    onPaneOpened: (pane) => {
      opened.push(pane.id)
    },
    onPaneClosed: (id) => {
      closed.push(id)
    },
  }
  return { host, opened, closed }
}

function io(files: Record<string, string>): DiscoveryIO {
  return {
    async exists(path) {
      return path.replace(/\\/g, "/") in files
    },
    async readTextFile(path) {
      const text = files[path.replace(/\\/g, "/")]
      if (text === undefined) throw new Error("ENOENT")
      return { text }
    },
  }
}

const configWith = (...specs: string[]) => JSON.stringify({ plugin: specs })

describe("the runtime", () => {
  test("internal plugins load and register, with no project and no host", async () => {
    clearPluginStorage()
    const { host } = recordingHost()
    const runtime = createAdePluginRuntime({
      host,
      internal: () => [
        Plugin.define({
          id: "built.in",
          setup: (context) => {
            context.ui.command.register({ id: "go", title: "Vai", run: () => {} })
          },
        }),
      ],
    })

    await runtime.start(undefined)
    expect(runtime.registry.commands().map((item) => item.key)).toEqual(["plugin:built.in:go"])
    expect(runtime.status()).toEqual([{ id: "built.in", spec: "built.in", source: "internal", active: true }])
  })

  test("the internal factory is given the runtime's own registry and status", async () => {
    clearPluginStorage()
    const { host } = recordingHost()
    let sawRegistry = false
    const runtime = createAdePluginRuntime({
      host,
      internal: ({ status, registry }) => {
        sawRegistry = typeof registry.commands === "function" && Array.isArray(status())
        return []
      },
    })
    await runtime.start()
    expect(sawRegistry).toBe(true)
  })

  test("a project plugin is discovered, imported and activated", async () => {
    clearPluginStorage()
    const { host } = recordingHost()
    const runtime = createAdePluginRuntime({
      host,
      io: io({ "C:/repo/.nikcli/tui.json": configWith("./p.js"), "C:/repo/p.js": "" }),
      load: async () => ({
        default: Plugin.define({
          id: "from.disk",
          setup: (context) => {
            context.ui.section.register({ name: "panel", title: "Pannello", render: () => "x" })
          },
        }),
      }),
    })

    await runtime.start("C:/repo")
    expect(runtime.registry.sections().map((item) => item.title)).toEqual(["Pannello"])
    expect(runtime.status()).toEqual([{ id: "from.disk", spec: "./p.js", source: "file", active: true }])
  })

  test("a project plugin the user has not trusted is never imported", async () => {
    clearPluginStorage()
    const { host } = recordingHost()
    let imported = false
    let asked: string[] = []
    const runtime = createAdePluginRuntime({
      host,
      io: io({ "C:/repo/.nikcli/tui.json": configWith("./p.js"), "C:/repo/p.js": "" }),
      load: async () => {
        imported = true
        return {}
      },
      trust: async (_root, plugins) => {
        asked = plugins.map((plugin) => plugin.spec)
        return false
      },
    })

    await runtime.start("C:/repo")
    expect(asked).toEqual(["./p.js"])
    expect(imported).toBe(false)
    expect(runtime.status()).toEqual([
      { id: "./p.js", spec: "./p.js", source: "file", active: false, error: "non autorizzato per questo progetto" },
    ])
  })

  test("the declared options reach the plugin", async () => {
    clearPluginStorage()
    const { host } = recordingHost()
    let seen: unknown
    const runtime = createAdePluginRuntime({
      host,
      io: io({
        "C:/repo/.nikcli/tui.json": JSON.stringify({ plugin: [["./p.js", { token: "abc" }]] }),
        "C:/repo/p.js": "",
      }),
      load: async () => ({
        default: Plugin.define({
          id: "from.disk",
          setup: (context) => {
            seen = context.options
          },
        }),
      }),
    })
    await runtime.start("C:/repo")
    expect(seen).toEqual({ token: "abc" })
  })

  /*
   * Each of these three is a different failure and each has to be visible in
   * the manager, keyed by the line the user actually wrote in their config —
   * a plugin that never loaded has no id to key it by.
   */
  test("an unresolvable spec, a bad module and a throwing setup are all reported", async () => {
    clearPluginStorage()
    const { host } = recordingHost()
    const runtime = createAdePluginRuntime({
      host,
      io: io({
        "C:/repo/.nikcli/tui.json": configWith("./gone.js", "./plain.js", "./boom.js"),
        "C:/repo/plain.js": "",
        "C:/repo/boom.js": "",
      }),
      load: async (entry) =>
        entry.endsWith("boom.js")
          ? {
              default: Plugin.define({
                id: "boom.plugin",
                setup: () => {
                  throw new Error("non parte")
                },
              }),
            }
          : { default: { notAPlugin: true } },
    })

    await runtime.start("C:/repo")
    const status = runtime.status()
    expect(status.find((item) => item.spec === "./gone.js")?.error).toContain("non esiste")
    expect(status.find((item) => item.spec === "./plain.js")?.error).toContain("non esporta un plugin v2")
    expect(status.find((item) => item.spec === "./boom.js")?.error).toBe("non parte")
    expect(status.every((item) => !item.active)).toBe(true)
    // Nothing a failed plugin registered before throwing survives.
    expect(runtime.registry.commands()).toHaveLength(0)
  })

  /*
   * A project plugin claiming a built-in's id is the case that matters: the
   * built-in keeps the id, the project one is rejected, and both rows are
   * visible — one active, one with a reason.
   */
  test("a second plugin claiming a loaded id is refused, not swapped in", async () => {
    clearPluginStorage()
    const { host } = recordingHost()
    let ran = 0
    const runtime = createAdePluginRuntime({
      host,
      internal: () => [
        Plugin.define({
          id: "same.id",
          setup: (context) => {
            context.ui.command.register({
              id: "go",
              title: "Built-in",
              run: () => {
                ran++
              },
            })
          },
        }),
      ],
      io: io({ "C:/repo/.nikcli/tui.json": configWith("./p.js"), "C:/repo/p.js": "" }),
      load: async () => ({
        default: Plugin.define({
          id: "same.id",
          setup: (context) => {
            context.ui.command.register({ id: "other", title: "Impostore", run: () => {} })
          },
        }),
      }),
    })

    await runtime.start("C:/repo")

    expect(
      runtime
        .status()
        .filter((item) => item.active)
        .map((item) => item.spec),
    ).toEqual(["same.id"])
    expect(runtime.status().find((item) => item.spec === "./p.js")?.error).toContain("già caricato")
    // The built-in keeps its registration, and the impostor gets none.
    expect(runtime.registry.commands().map((item) => item.commandId)).toEqual(["go"])
    runtime.registry.findCommand("plugin:same.id:go")!.run()
    expect(ran).toBe(1)
  })

  /*
   * `.nikcli/tui.json` belongs to the checkout, so the plugins of the project
   * being left have no business keeping a section in the sidebar of the one
   * being entered.
   */
  test("restarting for another project tears the previous generation down", async () => {
    clearPluginStorage()
    const { host, closed } = recordingHost()
    const runtime = createAdePluginRuntime({
      host,
      io: io({
        "C:/a/.nikcli/tui.json": configWith("./p.js"),
        "C:/a/p.js": "",
        "C:/b/.nikcli/tui.json": JSON.stringify({}),
      }),
      load: async () => ({
        default: Plugin.define({
          id: "from.disk",
          setup: (context) => {
            context.ui.pane.register({ name: "view", render: () => "x" })
            context.ui.pane.open({ name: "view" })
          },
        }),
      }),
    })

    await runtime.start("C:/a")
    expect(runtime.registry.open()).toHaveLength(1)

    await runtime.start("C:/b")
    expect(runtime.registry.panes()).toHaveLength(0)
    expect(runtime.status()).toHaveLength(0)
    // The workbench is told, so the tile leaves the grid too.
    expect(closed).toHaveLength(1)
  })

  test("with no loader, discovery still reports what it found but nothing activates", async () => {
    clearPluginStorage()
    const { host } = recordingHost()
    const runtime = createAdePluginRuntime({
      host,
      io: io({ "C:/repo/.nikcli/tui.json": configWith("./p.js", "nikcli-plugin-foo"), "C:/repo/p.js": "" }),
    })
    await runtime.start("C:/repo")
    expect(runtime.registry.commands()).toHaveLength(0)
    expect(runtime.status().map((item) => item.spec)).toEqual(["nikcli-plugin-foo"])
  })

  test("dispose runs every cleanup and empties the registry", async () => {
    clearPluginStorage()
    const { host } = recordingHost()
    const order: string[] = []
    const runtime = createAdePluginRuntime({
      host,
      internal: () => [
        Plugin.define({ id: "first", setup: () => () => void order.push("first") }),
        Plugin.define({ id: "second", setup: () => () => void order.push("second") }),
      ],
    })
    await runtime.start()
    await runtime.dispose()
    // Reverse of activation: a plugin that leans on an earlier one's
    // registrations is gone before they are.
    expect(order).toEqual(["second", "first"])
    expect(runtime.status()).toHaveLength(0)
  })
})
