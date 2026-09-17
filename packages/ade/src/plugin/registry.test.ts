import { describe, expect, test } from "bun:test"
import { createPluginRegistry } from "./registry"

const noop = () => {}
const body = () => "body"

function command(pluginId: string, commandId: string) {
  return { pluginId, commandId, title: commandId, group: pluginId, run: noop }
}

describe("plugin registry", () => {
  test("a registered command is listed under its namespaced key", () => {
    const registry = createPluginRegistry()
    registry.addCommand(command("alpha", "run"))
    expect(registry.commands().map((item) => item.key)).toEqual(["plugin:alpha:run"])
    expect(registry.findCommand("plugin:alpha:run")?.commandId).toBe("run")
  })

  test("the disposer drops exactly one registration, and only once", () => {
    const registry = createPluginRegistry()
    const off = registry.addCommand(command("alpha", "run"))
    registry.addCommand(command("alpha", "other"))
    off()
    off()
    expect(registry.commands().map((item) => item.commandId)).toEqual(["other"])
  })

  /*
   * Two plugins with the same id loaded from two config scopes is the real
   * case. Silently letting the second win means each one's disposer tears down
   * the other's registration, and the symptom is a command that works every
   * other time.
   */
  test("a duplicate registration throws rather than replacing", () => {
    const registry = createPluginRegistry()
    registry.addCommand(command("alpha", "run"))
    expect(() => registry.addCommand(command("alpha", "run"))).toThrow(/already registered/)
  })

  test("the same command id from two different plugins is not a duplicate", () => {
    const registry = createPluginRegistry()
    registry.addCommand(command("alpha", "run"))
    registry.addCommand(command("beta", "run"))
    expect(registry.commands()).toHaveLength(2)
  })

  test("a disposed key can be claimed again", () => {
    const registry = createPluginRegistry()
    const off = registry.addCommand(command("alpha", "run"))
    off()
    expect(() => registry.addCommand(command("alpha", "run"))).not.toThrow()
  })
})

describe("plugin panes", () => {
  test("opening an unregistered pane answers with nothing", () => {
    const registry = createPluginRegistry()
    expect(registry.openPane("alpha", "missing")).toBeUndefined()
    expect(registry.open()).toHaveLength(0)
  })

  test("two tiles of the same pane are two tiles", () => {
    const registry = createPluginRegistry()
    registry.addPane({ pluginId: "alpha", name: "view", title: "View", render: body })
    const first = registry.openPane("alpha", "view")
    const second = registry.openPane("alpha", "view")
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
    expect(registry.open()).toHaveLength(2)
  })

  /*
   * Reusing a sequence number after a close would hand a new tile the closed
   * one's identity — the grid, the pane cache and the terminal registry all
   * key on it, which is the bug `paneSequence` exists to prevent for sessions.
   */
  test("a closed tile's id is never handed out again", () => {
    const registry = createPluginRegistry()
    registry.addPane({ pluginId: "alpha", name: "view", title: "View", render: body })
    const first = registry.openPane("alpha", "view")!
    registry.closePane(first)
    const second = registry.openPane("alpha", "view")!
    expect(second).not.toBe(first)
  })

  test("an open tile resolves back to the definition that draws it", () => {
    const registry = createPluginRegistry()
    registry.addPane({ pluginId: "alpha", name: "view", title: "View", render: body })
    const id = registry.openPane("alpha", "view", { tab: "general" })!
    expect(registry.definitionFor(id)?.title).toBe("View")
    expect(registry.open().find((item) => item.id === id)?.data).toEqual({ tab: "general" })
  })

  test("disposing a pane definition takes its open tiles with it", () => {
    const registry = createPluginRegistry()
    const off = registry.addPane({ pluginId: "alpha", name: "view", title: "View", render: body })
    const id = registry.openPane("alpha", "view")!
    off()
    expect(registry.open()).toHaveLength(0)
    expect(registry.definitionFor(id)).toBeUndefined()
  })

  test("openFor answers for one plugin only", () => {
    const registry = createPluginRegistry()
    registry.addPane({ pluginId: "alpha", name: "view", title: "View", render: body })
    registry.addPane({ pluginId: "beta", name: "view", title: "View", render: body })
    registry.openPane("alpha", "view")
    registry.openPane("beta", "view")
    expect(registry.openFor("alpha")).toHaveLength(1)
    expect(registry.openFor("alpha")[0]!.pluginId).toBe("alpha")
  })
})

describe("removing a plugin", () => {
  test("everything it put anywhere goes, and its keys become free", () => {
    const registry = createPluginRegistry()
    registry.addCommand(command("alpha", "run"))
    registry.addPane({ pluginId: "alpha", name: "view", title: "View", render: body })
    registry.addSection({ pluginId: "alpha", name: "panel", title: "Panel", render: body })
    registry.openPane("alpha", "view")
    registry.addCommand(command("beta", "run"))

    registry.removePlugin("alpha")

    expect(registry.commands().map((item) => item.pluginId)).toEqual(["beta"])
    expect(registry.panes()).toHaveLength(0)
    expect(registry.sections()).toHaveLength(0)
    expect(registry.open()).toHaveLength(0)
    // Freeing the keys is what lets the same plugin be loaded again after a
    // project switch, which is the only reason `removePlugin` exists.
    expect(() => registry.addCommand(command("alpha", "run"))).not.toThrow()
  })
})
