/**
 * Loading, activating and tearing down ADE's v2 plugins.
 *
 * The TUI's `TuiPluginRuntime` is a thousand lines because it also owns hot
 * reload, per-plugin enable/disable persisted in KV, npm installation, theme
 * installation, plugin metadata tracking and a config watcher. None of that is
 * skipped here out of haste — each one needs something the webview has not
 * got (a file watcher, a package manager, a state directory), and a stub that
 * looked like it had them would be worse than the absence. What is left is the
 * part that is actually the same: a list of definitions, run in order, each
 * with a scope that can be disposed on its own.
 *
 * Sequential activation, like the TUI's: registration order decides palette
 * grouping and sidebar section order, and `Promise.all` would make both depend
 * on which plugin's `setup` happened to await first.
 */
import { createSignal } from "solid-js"
import type { Definition } from "@nikcli-ai/plugin/v2/ade/plugin"
import { createPluginRegistry, type PluginRegistry } from "./registry"
import { adaptV2AdePlugin, readV2AdePlugin, type AdePluginHost, type LoadedV2Plugin } from "./v2"
import { discoverPlugins, type DiscoveryIO, type ResolvedPlugin } from "./discovery"
import { clearPluginStorage } from "./storage"

export interface PluginStatus {
  readonly id: string
  /** How it was declared. Internal plugins carry their own id here. */
  readonly spec: string
  readonly source: "internal" | "file"
  readonly active: boolean
  /** Why it is not active. Italian — it reaches the plugin manager. */
  readonly error?: string
}

export type InternalAdePlugin = Definition

/** What the runtime needs from the workbench. `registry` it makes itself. */
export type RuntimeHost = Omit<AdePluginHost, "registry">

export interface AdePluginRuntime {
  readonly registry: PluginRegistry
  readonly status: () => PluginStatus[]
  /**
   * Loads the internal plugins, then whatever the project declares.
   *
   * Safe to call again when the project changes: the previous generation is
   * disposed first, so a plugin declared by the project being left does not
   * keep a sidebar section in the project being entered.
   */
  readonly start: (projectRoot?: string) => Promise<void>
  readonly dispose: () => Promise<void>
}

export interface RuntimeOptions {
  readonly host: RuntimeHost
  /** Absent in the browser harness, and then only internal plugins load. */
  readonly io?: DiscoveryIO
  /** Imports an entry URL. Injected so tests never touch a module loader. */
  readonly load?: (entry: string) => Promise<Record<string, unknown>>
  /**
   * ADE's own built-in plugins, as a factory over the runtime's own status.
   *
   * Passed in rather than imported here, and the reason is mechanical: the
   * built-ins render, so they are `.tsx`, and a `.tsx` cannot be imported
   * under `bun test` in this package. A default import would make this whole
   * module — and every test of it — unloadable. `workbench.tsx` supplies the
   * list, which is also where every other component-shaped decision is made.
   */
  readonly internal?: (runtime: { status: () => PluginStatus[]; registry: PluginRegistry }) => InternalAdePlugin[]
  /**
   * Whether the user lets this project run these plugins.
   *
   * A plugin is code, and `.nikcli/tui.json` arrives with whatever repository
   * was just cloned: opening a folder must not be enough to run what it
   * declares. Asked before anything is imported; absent means the host has
   * already decided (the tests, which load nothing real).
   */
  readonly trust?: (projectRoot: string, plugins: readonly ResolvedPlugin[]) => Promise<boolean>
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function createAdePluginRuntime(options: RuntimeOptions): AdePluginRuntime {
  const registry = createPluginRegistry()
  const [status, setStatus] = createSignal<PluginStatus[]>([])
  const host: AdePluginHost = { ...options.host, registry }

  let loaded: LoadedV2Plugin[] = []
  /** Serializes starts, so switching project twice quickly cannot interleave. */
  let queue: Promise<void> = Promise.resolve()

  /*
   * Status rows are keyed by `spec`, not by `id`.
   *
   * The id is the plugin's claim about itself, and the interesting failure is
   * precisely two plugins making the same claim. Keyed by id, the second one's
   * "already loaded" row overwrote the first one's "active" row and the
   * manager showed one broken plugin where there was one working and one
   * rejected. The spec is what the user wrote — a config line, or an internal
   * plugin's own name — and it is unique by construction.
   */
  const note = (entry: PluginStatus) => {
    setStatus((list) => [...list.filter((item) => item.spec !== entry.spec), entry])
  }

  const activate = async (
    definition: Definition,
    source: PluginStatus["source"],
    spec: string,
    pluginOptions?: Record<string, unknown>,
  ) => {
    if (loaded.some((item) => item.id === definition.id)) {
      note({ id: definition.id, spec, source, active: false, error: "un plugin con questo id è già caricato" })
      return
    }
    try {
      loaded.push(await adaptV2AdePlugin(definition, host, pluginOptions))
      note({ id: definition.id, spec, source, active: true })
    } catch (error) {
      // The adapter has already rolled back whatever this plugin registered.
      note({ id: definition.id, spec, source, active: false, error: message(error) })
    }
  }

  const teardown = async () => {
    // Reverse order, so a plugin that depends on an earlier one's registrations
    // is gone before they are.
    const pending = [...loaded].reverse()
    loaded = []
    for (const plugin of pending) {
      await plugin.dispose().catch(() => undefined)
    }
    setStatus([])
  }

  const run = async (projectRoot?: string) => {
    await teardown()

    const internal = options.internal?.({ status, registry }) ?? []
    for (const definition of internal) {
      await activate(definition, "internal", definition.id)
    }

    if (!options.io || !projectRoot) return
    const found = await discoverPlugins(projectRoot, options.io).catch(() => undefined)
    if (!found) return

    for (const rejection of found.rejected) {
      // A plugin that never loaded has no id, so the spec stands in for one:
      // it is the line the user wrote, which is what they have to go and fix.
      note({ id: rejection.spec, spec: rejection.spec, source: "file", active: false, error: rejection.reason })
    }

    const load = options.load
    if (!load || found.resolved.length === 0) return

    const trusted = options.trust ? await options.trust(projectRoot, found.resolved).catch(() => false) : true
    if (!trusted) {
      for (const plugin of found.resolved) {
        note({ id: plugin.spec, spec: plugin.spec, source: "file", active: false, error: "non autorizzato per questo progetto" })
      }
      return
    }

    for (const plugin of found.resolved) {
      let definition: Definition | undefined
      try {
        const module = await load(plugin.entry)
        definition = readV2AdePlugin(module, plugin.spec)
      } catch (error) {
        note({ id: plugin.spec, spec: plugin.spec, source: "file", active: false, error: message(error) })
        continue
      }
      if (!definition) {
        note({
          id: plugin.spec,
          spec: plugin.spec,
          source: "file",
          active: false,
          error: "il modulo non esporta un plugin v2 (manca l'export default con id e setup)",
        })
        continue
      }
      await activate(definition, "file", plugin.spec, plugin.options)
    }
  }

  return {
    registry,
    status,
    start(projectRoot) {
      queue = queue.catch(() => undefined).then(() => run(projectRoot))
      return queue
    },
    async dispose() {
      queue = queue.catch(() => undefined).then(async () => {
        await teardown()
        clearPluginStorage()
      })
      await queue
    },
  }
}
