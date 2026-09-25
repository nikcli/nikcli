import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { preserveTestEnv } from "../helpers/env"

// Private home before any nikcli module is imported: the path singletons read
// it once, and the global config dir under it is where plugins are written.
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-plugin-tool-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG"])

const { Effect } = await import("effect")
const { Config } = await import("@/config/config")
const { Plugin } = await import("@/plugin")
const { PluginTool, PluginScaffold } = await import("@/tool/plugin")
const { Instance } = await import("@/project/instance")
const { Global } = await import("@nikcli-ai/util/global")
const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
const { makeToolContext, withProjectDirectory } = await import("../helpers/tool-context")

type Probe = { events: string[]; disposed: string[] }
const probe: Probe = { events: [], disposed: [] }
;(globalThis as { __pluginToolProbe?: Probe }).__pluginToolProbe = probe

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-plugin-tool-project-")))

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {})
  await fs.rm(testHome, { recursive: true, force: true }).catch(() => {})
})

/** A plugin that records its version on every event and on dispose. */
function source(version: string, extra = "") {
  return `
const probe = globalThis.__pluginToolProbe
${extra}
export const Probe = async () => ({
  event: async ({ event }) => { if (event.type === "plugin.test.ping") probe.events.push(${JSON.stringify(version)}) },
  tool: {
    probe_version: {
      description: "Report the plugin version",
      args: {},
      async execute() { return ${JSON.stringify(version)} },
    },
  },
  dispose: async () => { probe.disposed.push(${JSON.stringify(version)}) },
})
`
}

function status() {
  return runPromiseWithLayer(
    Plugin.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        return yield* plugin.status()
      }),
    ),
  )
}

function hooks() {
  return runPromiseWithLayer(
    Plugin.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        return yield* plugin.list()
      }),
    ),
  )
}

async function ping() {
  await Plugin.runEventHooks(await hooks(), { event: { type: "plugin.test.ping", properties: {} } } as never)
}

describe("plugin folder discovery", () => {
  it("names a folder plugin after its folder, and keeps flat-file names", () => {
    expect(Config.getPluginName("file:///cfg/plugins/desktop-notify/index.ts")).toBe("desktop-notify")
    expect(Config.getPluginName("file:///cfg/plugin/foo/src/main.js")).toBe("foo")
    expect(Config.getPluginName("file:///path/to/plugin/foo.js")).toBe("foo")
    expect(Config.getPluginName("file:///home/plugins/proj/.nikcli/plugins/bar.ts")).toBe("bar")
    expect(Config.getPluginName("@scope/pkg@1.0.0")).toBe("@scope/pkg")
  })

  it("does not collapse two folder plugins whose entries are both index.ts", () => {
    const specs = ["file:///cfg/plugins/a/index.ts", "file:///cfg/plugins/b/index.ts"]
    expect(Config.deduplicatePlugins(specs)).toEqual(specs)
  })

  it("resolves the entry from package.json main, then index.ts, and skips tui and escaping mains", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-plugin-entry-"))
    try {
      const withMain = path.join(root, "plugins", "with-main")
      await fs.mkdir(path.join(withMain, "src"), { recursive: true })
      await Bun.write(path.join(withMain, "package.json"), JSON.stringify({ main: "src/main.ts" }))
      await Bun.write(path.join(withMain, "src", "main.ts"), "export {}")
      expect(await Config.pluginFolderEntry(withMain)).toBe(path.join(withMain, "src", "main.ts"))

      const indexOnly = path.join(root, "plugins", "index-only")
      await fs.mkdir(indexOnly, { recursive: true })
      await Bun.write(path.join(indexOnly, "index.ts"), "export {}")
      expect(await Config.pluginFolderEntry(indexOnly)).toBe(path.join(indexOnly, "index.ts"))

      const escaping = path.join(root, "plugins", "escaping")
      await fs.mkdir(escaping, { recursive: true })
      await Bun.write(path.join(escaping, "package.json"), JSON.stringify({ main: "../../outside.ts" }))
      await Bun.write(path.join(root, "outside.ts"), "export {}")
      expect(await Config.pluginFolderEntry(escaping)).toBeUndefined()

      const tui = path.join(root, "plugins", "tui")
      await fs.mkdir(tui, { recursive: true })
      await Bun.write(path.join(tui, "index.ts"), "export {}")
      expect(await Config.pluginFolderEntry(tui)).toBeUndefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("installs a config dir's dependencies when node_modules is missing, never twice for a local build", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-plugin-needs-install-"))
    try {
      expect(await Config.needsInstall(dir)).toBe(true)
      await fs.mkdir(path.join(dir, "node_modules"))
      // A local build installs `latest`; there is no version to compare against.
      expect(await Config.needsInstall(dir)).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("keeps a folder plugin's helpers inside its source root", () => {
    const entry = path.join("/cfg", "plugins", "notify", "src", "index.ts")
    expect(Plugin.sourceRoot(entry)).toBe(path.join("/cfg", "plugins", "notify"))
    const flat = path.join("/cfg", "plugins", "notify.ts")
    expect(Plugin.sourceRoot(flat)).toBe(flat)
  })
})

describe("PluginScaffold", () => {
  it("accepts kebab-case names and rejects everything else", () => {
    expect(PluginScaffold.validateName("desktop-notify")).toBe("desktop-notify")
    expect(() => PluginScaffold.validateName(undefined)).toThrow("required")
    expect(() => PluginScaffold.validateName("Desktop")).toThrow("kebab-case")
    expect(() => PluginScaffold.validateName("../escape")).toThrow("kebab-case")
    expect(() => PluginScaffold.validateName("tui")).toThrow("reserved")
  })

  it("rejects source that does not parse or exports nothing, before writing", () => {
    expect(() => PluginScaffold.checkSource("export const X = async () => ({")).toThrow("does not parse")
    expect(() => PluginScaffold.checkSource("const x = 1")).toThrow("exports nothing")
    expect(PluginScaffold.checkSource("export const X = async () => ({})")).toContain("export")
  })

  it("keeps the version and merges dependencies on update", () => {
    const first = PluginScaffold.manifest("x", undefined, { description: "d", dependencies: { a: "1" } })
    expect(first).toMatchObject({ name: "nikcli-plugin-x", version: "0.1.0", main: "index.ts", type: "module" })
    const next = PluginScaffold.manifest("x", { ...first, version: "0.2.0" }, { dependencies: { b: "2" } })
    expect(next).toMatchObject({ version: "0.2.0", description: "d", dependencies: { a: "1", b: "2" } })
  })
})

describe("plugin tool: create, hot reload, update, remove", () => {
  const folder = () => path.join(Global.Path.config, "plugins", "probe")

  it("creates a plugin, asks permission, and loads it without a restart", async () => {
    await withProjectDirectory(projectDir, async () => {
      // Plugin state exists before the plugin does, like a running TUI.
      expect((await status()).some((plugin) => plugin.name === "probe")).toBe(false)

      const def = await PluginTool.init()
      const { ctx, asked } = makeToolContext()
      const result = await def.executeAsync({ action: "create", name: "probe", source: source("v1") }, ctx)

      expect(asked.map((ask) => ask.permission)).toEqual(["plugin"])
      expect(result.metadata.loaded).toBe(true)
      expect(result.output).toContain("probe_version")
      const pkg = await Bun.file(path.join(folder(), "package.json")).json()
      expect(pkg).toMatchObject({ name: "nikcli-plugin-probe", main: "index.ts" })

      await ping()
      expect(probe.events).toEqual(["v1"])
    })
  })

  it("refuses to create over an existing plugin", async () => {
    await withProjectDirectory(projectDir, async () => {
      const def = await PluginTool.init()
      const { ctx } = makeToolContext()
      await expect(def.executeAsync({ action: "create", name: "probe", source: source("v1") }, ctx)).rejects.toThrow(
        "already exists",
      )
    })
  })

  it("updates in place: the old version is disposed and the new one handles events", async () => {
    await withProjectDirectory(projectDir, async () => {
      const def = await PluginTool.init()
      const { ctx } = makeToolContext()
      const result = await def.executeAsync({ action: "update", name: "probe", source: source("v2") }, ctx)
      expect(result.metadata.loaded).toBe(true)
      expect(probe.disposed).toEqual(["v1"])

      probe.events.length = 0
      await ping()
      expect(probe.events).toEqual(["v2"])
    })
  })

  it("reports a plugin that throws on load without taking the others down", async () => {
    await withProjectDirectory(projectDir, async () => {
      const def = await PluginTool.init()
      const { ctx } = makeToolContext()
      const broken = await def.executeAsync(
        {
          action: "create",
          name: "broken",
          source: `export const Broken = async () => { throw new Error("boom at init") }`,
        },
        ctx,
      )
      expect(broken.metadata.loaded).toBe(false)
      expect(broken.output).toContain("boom at init")

      const plugins = await status()
      expect(plugins.find((plugin) => plugin.name === "broken")?.error).toContain("boom at init")
      expect(plugins.find((plugin) => plugin.name === "probe")?.error).toBeUndefined()

      probe.events.length = 0
      await ping()
      expect(probe.events).toEqual(["v2"])

      const fixed = await def.executeAsync(
        { action: "update", name: "broken", source: `export const Broken = async () => ({})` },
        ctx,
      )
      expect(fixed.metadata.loaded).toBe(true)
    })
  })

  it("leaves unchanged plugins running across a reload", async () => {
    await withProjectDirectory(projectDir, async () => {
      const def = await PluginTool.init()
      const { ctx } = makeToolContext()
      probe.disposed.length = 0
      const result = await def.executeAsync({ action: "reload" }, ctx)
      expect(result.output).toContain("probe — loaded")
      expect(probe.disposed).toEqual([])
    })
  })

  it("picks up an edit to a helper module of a folder plugin", async () => {
    await withProjectDirectory(projectDir, async () => {
      const def = await PluginTool.init()
      const { ctx } = makeToolContext()
      await Bun.write(path.join(folder(), "version.ts"), `export const version = "helper-1"`)
      await def.executeAsync(
        {
          action: "update",
          name: "probe",
          source: `import { version } from "./version"\n${source("v3").replace('"v3"', "version")}`,
        },
        ctx,
      )
      probe.events.length = 0
      await ping()
      expect(probe.events).toEqual(["helper-1"])

      // Only the helper changes; the fingerprint covers the folder, and the
      // module cache is evicted for it, so the new value is what runs.
      await Bun.sleep(5)
      await Bun.write(path.join(folder(), "version.ts"), `export const version = "helper-2"`)
      await def.executeAsync({ action: "reload" }, ctx)
      probe.events.length = 0
      await ping()
      expect(probe.events).toEqual(["helper-2"])
    })
  })

  it("does not write anything when permission is denied", async () => {
    await withProjectDirectory(projectDir, async () => {
      const def = await PluginTool.init()
      const { ctx } = makeToolContext({ denyAsk: true })
      await expect(def.executeAsync({ action: "create", name: "denied", source: source("x") }, ctx)).rejects.toThrow(
        "Permission denied",
      )
      expect(await Bun.file(path.join(Global.Path.config, "plugins", "denied", "index.ts")).exists()).toBe(false)
    })
  })

  it("removes a plugin: disposed, unloaded, folder gone", async () => {
    await withProjectDirectory(projectDir, async () => {
      const def = await PluginTool.init()
      const { ctx } = makeToolContext()
      probe.disposed.length = 0
      const result = await def.executeAsync({ action: "remove", name: "probe" }, ctx)
      expect(result.title).toBe("Removed plugin probe")
      expect(probe.disposed.length).toBe(1)
      expect(await Bun.file(path.join(folder(), "index.ts")).exists()).toBe(false)
      expect(
        (await status()).some((plugin) => plugin.spec === pathToFileURL(path.join(folder(), "index.ts")).href),
      ).toBe(false)

      probe.events.length = 0
      await ping()
      expect(probe.events).toEqual([])
    })
  })

  it("retries a failed local plugin on reload when what broke it lives outside its folder", async () => {
    await withProjectDirectory(projectDir, async () => {
      const def = await PluginTool.init()
      const { ctx } = makeToolContext()
      // Resolved from the config dir, outside the plugin's own folder, so the
      // plugin's fingerprint does not change when it appears.
      const helper = path.join(Global.Path.config, "late-helper.ts")
      const created = await def.executeAsync(
        {
          action: "create",
          name: "late-dep",
          source: `import { value } from "../../late-helper"\nexport const LateDep = async () => ({ tool: { late_value: { description: value, args: {}, async execute() { return value } } } })`,
        },
        ctx,
      )
      expect(created.metadata.loaded).toBe(false)

      await Bun.write(helper, `export const value = "now resolvable"`)
      const reloaded = await def.executeAsync({ action: "reload" }, ctx)
      expect(reloaded.output).toContain("late-dep — loaded")
      expect((await status()).find((plugin) => plugin.name === "late-dep")?.tools).toEqual(["late_value"])
    })
  })
})
