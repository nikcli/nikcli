import "@opentui/solid/runtime-plugin-support"
import {
  type TuiDispose,
  type TuiPlugin,
  type TuiPluginApi,
  type TuiPluginInstallResult,
  type TuiPluginModule,
  type TuiPluginMeta,
  type TuiPluginStatus,
  type TuiTheme,
} from "@nikcli-ai/plugin/tui"
import path from "path"
import { fileURLToPath } from "url"

import { pluginOptions, pluginSpecifier, type PluginOptions, type PluginSpec } from "@nikcli-ai/util/plugin-spec"
import { pluginHost, type PluginConfigInfo, type PluginConfigMeta } from "./host"
import { Log } from "@nikcli-ai/util/log"
import { errorData, errorMessage } from "@nikcli-ai/util/error-format"
import { isRecord } from "@nikcli-ai/util/record"
import {
  checkPluginCompatibility,
  getPluginIdFromPackage,
  isDeprecatedPlugin,
  parsePluginSpecifier,
  pluginSource,
  readPluginId,
  readV1Plugin,
  resolvePluginEntrypoint,
  resolvePluginId,
  resolvePluginTarget,
  type PluginSource,
} from "@nikcli-ai/util/plugin-shared"
import { PluginMeta } from "@nikcli-ai/util/plugin-meta"
import {
  installPlugin as installModulePlugin,
  patchPluginConfig,
  readPluginManifest,
} from "@nikcli-ai/util/plugin-install"
import { addTheme, hasTheme } from "../context/theme"
import { createKeymapApi } from "./keymap"
import { Global } from "@nikcli-ai/util/global"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import { Process } from "@nikcli-ai/util/process"
import { Flag } from "@nikcli-ai/util/flag"
import { VERSION } from "@nikcli-ai/util/version"
import { INTERNAL_TUI_PLUGINS, type InternalTuiPlugin } from "./internal"
import { clearSlotErrors, setupSlots, Slot as View } from "./slots"
import type { HostPluginApi, HostSlots } from "./slots"
import { adaptV2TuiPlugin, readV2TuiPlugin } from "./v2"
import { pluginStorage } from "./storage"
import { createSourceWatcher, entrypointMtime, freshSpecifier, type SourceWatcher } from "./reload"
import { dbg } from "../feature-plugins/background/__debug"

type PluginLoad = {
  item?: PluginSpec
  spec: string
  target: string
  /** Resolved module entrypoint. Local sources are re-imported from it on edit. */
  entry: string
  /**
   * Import identity. For local sources this is the mtime-busted specifier, so
   * an unchanged version means an identical module; npm and internal plugins
   * use their entrypoint, which never changes within a session.
   */
  version: string
  /** Config metadata, kept so a hot reload can re-resolve with the same scope. */
  config_meta?: PluginConfigMeta
  /**
   * Where this plugin came from. Only `config` entries follow the config file:
   * a plugin added at runtime is not removed when it is absent from `tui.json`.
   */
  origin: "config" | "runtime" | "internal"
  retry: boolean
  source: PluginSource | "internal"
  id: string
  module: TuiPluginModule
  install_theme: TuiTheme["install"]
}

type Api = HostPluginApi

type PluginScope = {
  lifecycle: TuiPluginApi["lifecycle"]
  track: (fn: (() => void) | undefined) => () => void
  /** `deadline` is an epoch-ms budget shared across scopes disposed together. */
  dispose: (deadline?: number) => Promise<void>
}

type PluginEntry = {
  id: string
  load: PluginLoad
  meta: TuiPluginMeta
  plugin: TuiPlugin
  options: PluginOptions | undefined
  enabled: boolean
  scope?: PluginScope
}

type ServerPluginEntry = {
  id: string
  spec: string
  source: PluginSource | "internal"
}

type RuntimeState = {
  directory: string
  api: Api
  slots: HostSlots
  plugins: PluginEntry[]
  plugins_by_id: Map<string, PluginEntry>
  serverPlugins: ServerPluginEntry[]
  pending: Map<
    string,
    {
      item: PluginSpec
      meta: PluginConfigMeta
    }
  >
  watcher?: SourceWatcher
  /** Last reported reload failure per plugin id, so repeat reconciles stay silent. */
  failures: Map<string, string>
}

const log = Log.create({ service: "tui.plugin" })
const DISPOSE_TIMEOUT_MS = 5000

/**
 * How long shutting the runtime down may wait on plugin cleanups, in total.
 *
 * `DISPOSE_TIMEOUT_MS` bounds one plugin. Plugins are disposed one after the
 * other, so on its own that made exit wait up to five seconds *per* wedged
 * plugin. `specs/effect-tui/08-host-plugins-startup.md` requirement 7 asks for an
 * aggregate budget as well; this is its candidate value. Once it is spent the
 * remaining plugins are still disposed — every cleanup is still invoked, and the
 * synchronous host deregistrations still complete — they are only no longer
 * waited on. Timed-out cleanups are reported, never claimed as terminated.
 */
const SHUTDOWN_BUDGET_MS = 5000
const KV_KEY = "plugin_enabled"

function fail(message: string, data: Record<string, unknown>) {
  if (!("error" in data)) {
    log.error(message, data)
    console.error(`[tui.plugin] ${message}`, data)
    return
  }

  const text = `${message}: ${errorMessage(data.error)}`
  const next = { ...data, error: errorData(data.error) }
  log.error(text, next)
  console.error(`[tui.plugin] ${text}`, next)
}

type CleanupResult = { type: "ok" } | { type: "error"; error: unknown } | { type: "timeout" }

function runCleanup(fn: () => unknown, ms: number): Promise<CleanupResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ type: "timeout" })
    }, ms)

    Promise.resolve()
      .then(fn)
      .then(
        () => {
          resolve({ type: "ok" })
        },
        (error) => {
          resolve({ type: "error", error })
        },
      )
      .finally(() => {
        clearTimeout(timer)
      })
  })
}

function isTheme(value: unknown) {
  if (!isRecord(value)) return false
  if (!("theme" in value)) return false
  if (!isRecord(value.theme)) return false
  return true
}

function resolveRoot(root: string) {
  if (root.startsWith("file://")) {
    const file = fileURLToPath(root)
    if (root.endsWith("/")) return file
    return path.dirname(file)
  }
  if (path.isAbsolute(root)) return root
  return path.resolve(process.cwd(), root)
}

function createThemeInstaller(meta: PluginConfigMeta, root: string, spec: string): TuiTheme["install"] {
  return async (file) => {
    const raw = file.startsWith("file://") ? fileURLToPath(file) : file
    const src = path.isAbsolute(raw) ? raw : path.resolve(root, raw)
    const theme = path.basename(src, path.extname(src))
    if (hasTheme(theme)) return

    const text = await Filesystem.readText(src).catch((error) => {
      log.warn("failed to read tui plugin theme", {
        path: spec,
        theme: src,
        error,
      })
      return
    })
    if (text === undefined) return

    const fail = Symbol()
    const data = await Promise.resolve(text)
      .then((x) => JSON.parse(x))
      .catch((error) => {
        log.warn("failed to parse tui plugin theme", {
          path: spec,
          theme: src,
          error,
        })
        return fail
      })
    if (data === fail) return

    if (!isTheme(data)) {
      log.warn("invalid tui plugin theme", { path: spec, theme: src })
      return
    }

    const source_dir = path.dirname(meta.source)
    const local_dir =
      path.basename(source_dir) === ".nikcli"
        ? path.join(source_dir, "themes")
        : path.join(source_dir, ".nikcli", "themes")
    const dest_dir = meta.scope === "local" ? local_dir : path.join(Global.Path.config, "themes")
    const dest = path.join(dest_dir, `${theme}.json`)
    if (!(await Filesystem.exists(dest))) {
      await Filesystem.write(dest, text).catch((error) => {
        log.warn("failed to persist tui plugin theme", {
          path: spec,
          theme: src,
          dest,
          error,
        })
      })
    }

    addTheme(theme, data)
  }
}

type LoadHooks = {
  /** Receives the first error that stopped this load, for user-facing reporting. */
  onFail?: (error: unknown) => void
  origin?: PluginLoad["origin"]
}

async function loadExternalPlugin(
  item: PluginSpec,
  meta: PluginConfigMeta | undefined,
  retry = false,
  hooks?: LoadHooks,
): Promise<PluginLoad | undefined> {
  const spec = pluginSpecifier(item)
  if (isDeprecatedPlugin(spec)) return
  log.info("loading tui plugin", { path: spec, retry })
  const resolved = await resolvePluginTarget(spec).catch((error) => {
    fail("failed to resolve tui plugin", { path: spec, retry, error })
    hooks?.onFail?.(error)
    return
  })
  if (!resolved) return

  const source = pluginSource(spec)
  if (source === "npm") {
    const ok = await checkPluginCompatibility(resolved, VERSION)
      .then(() => true)
      .catch((error) => {
        fail("tui plugin incompatible", { path: spec, retry, error })
        hooks?.onFail?.(error)
        return false
      })
    if (!ok) return
  }

  const target = resolved
  if (!meta) {
    fail("missing tui plugin metadata", {
      path: spec,
      retry,
    })
    hooks?.onFail?.(new Error("missing plugin metadata"))
    return
  }

  const root = resolveRoot(source === "file" ? spec : target)
  const install_theme = createThemeInstaller(meta, root, spec)
  const entry = await resolvePluginEntrypoint(spec, target, "tui").catch((error) => {
    fail("failed to resolve tui plugin entry", {
      path: spec,
      target,
      retry,
      error,
    })
    hooks?.onFail?.(error)
    return
  })
  if (!entry) return

  // Local sources are imported through an mtime-busted specifier so an edited
  // file re-imports fresh instead of resolving to the stale ESM-cached module.
  const mtime = source === "file" ? entrypointMtime(entry) : undefined
  const version = mtime === undefined ? entry : freshSpecifier(entry, mtime)

  const mod = await import(version)
    .then((raw) => {
      const value = raw as Record<string, unknown>
      // v1 wins the detection race; a module that is not v1-shaped falls
      // through to the v2 reader. `specs/effect-tui/14-plugin-v2-architecture.md`
      // replaces this ordering with an explicit manifest check.
      return (readV1Plugin(value, spec, "tui", "detect") as TuiPluginModule | undefined) ?? readV2TuiPlugin(value, spec)
    })
    .catch((error) => {
      fail("failed to load tui plugin", {
        path: spec,
        target: entry,
        retry,
        error,
      })
      hooks?.onFail?.(error)
      return
    })
  if (!mod) return

  const id = await resolvePluginId(source, spec, target, readPluginId(mod.id, spec)).catch((error) => {
    fail("failed to load tui plugin", { path: spec, target, retry, error })
    hooks?.onFail?.(error)
    return
  })
  if (!id) return

  return {
    item,
    spec,
    target,
    entry,
    version,
    config_meta: meta,
    origin: hooks?.origin ?? "config",
    retry,
    source,
    id,
    module: mod,
    install_theme,
  }
}

function createMeta(
  source: PluginLoad["source"],
  spec: string,
  target: string,
  meta: { state: PluginMeta.State; entry: PluginMeta.Entry } | undefined,
  id?: string,
): TuiPluginMeta {
  if (meta) {
    return {
      state: meta.state,
      ...meta.entry,
    }
  }

  const now = Date.now()
  return {
    state: source === "internal" ? "same" : "first",
    id: id ?? spec,
    source,
    spec,
    target,
    first_time: now,
    last_time: now,
    time_changed: now,
    load_count: 1,
    fingerprint: target,
  }
}

function loadInternalPlugin(item: InternalTuiPlugin): PluginLoad {
  const spec = item.id
  const target = spec
  const module: TuiPluginModule =
    "setup" in item
      ? {
          id: item.id,
          tui: adaptV2TuiPlugin(item),
        }
      : item

  return {
    spec,
    target,
    entry: target,
    version: target,
    origin: "internal",
    retry: false,
    source: "internal",
    id: item.id,
    module,
    install_theme: createThemeInstaller(
      {
        scope: "global",
        source: target,
      },
      process.cwd(),
      spec,
    ),
  }
}

/**
 * Exported for `test/tui/plugin-dispose.test.ts`: dispose ordering is only
 * observable from inside the scope, and the regression it guards (one hung
 * callback stranding the host deregistrations behind it) cannot be reached
 * through `TuiPluginRuntime.init`.
 */
export function createPluginScope(load: PluginLoad, id: string, timeoutMs = DISPOSE_TIMEOUT_MS) {
  const ctrl = new AbortController()
  let list: { key: symbol; fn: TuiDispose }[] = []
  let done = false

  const onDispose = (fn: TuiDispose) => {
    if (done) return () => {}
    const key = Symbol()
    list.push({ key, fn })
    let drop = false
    return () => {
      if (drop) return
      drop = true
      list = list.filter((x) => x.key !== key)
    }
  }

  const track = (fn: (() => void) | undefined) => {
    if (!fn) return () => {}
    let drop = false
    let off = () => {}
    const wrapped = () => {
      if (drop) return
      drop = true
      off()
      fn()
    }
    off = onDispose(wrapped)
    return wrapped
  }

  const lifecycle: TuiPluginApi["lifecycle"] = {
    signal: ctrl.signal,
    onDispose,
  }

  /**
   * `deadline` (epoch ms) is a budget shared with other scopes being disposed in
   * the same pass: this scope waits no longer than its own `timeoutMs`, and no
   * later than the deadline.
   */
  const dispose = async (deadline?: number) => {
    if (done) return
    done = true
    ctrl.abort()
    const queue = [...list].reverse()
    list = []
    const until = Math.min(Date.now() + timeoutMs, deadline ?? Number.POSITIVE_INFINITY)
    // The queue holds the host's own deregistrations (commands, routes, event
    // listeners, the plugin host entry) alongside the plugin's callbacks, and
    // it is walked newest-first — so stopping at the first hung or throwing
    // callback left the plugin registered in the TUI after it was disposed.
    // Every entry runs; the budget only decides whether we still wait for one.
    let reported = false
    for (const item of queue) {
      const left = until - Date.now()
      const out = await runCleanup(item.fn, Math.max(0, left))
      if (out.type === "ok") continue
      if (out.type === "timeout") {
        if (!reported) {
          reported = true
          fail("timed out cleaning up tui plugin", {
            path: load.spec,
            id,
            timeout: timeoutMs,
          })
        }
        continue
      }

      if (out.type === "error") {
        fail("failed to clean up tui plugin", {
          path: load.spec,
          id,
          error: out.error,
        })
      }
    }
  }

  return {
    lifecycle,
    track,
    dispose,
  }
}

function readPluginEnabledMap(value: unknown) {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((item): item is [string, boolean] => typeof item[1] === "boolean"),
  )
}

function pluginEnabledState(state: RuntimeState, config: PluginConfigInfo) {
  return {
    ...readPluginEnabledMap(config.plugin_enabled),
    ...readPluginEnabledMap(state.api.kv.get(KV_KEY, {})),
  }
}

function writePluginEnabledState(api: Api, id: string, enabled: boolean) {
  api.kv.set(KV_KEY, {
    ...readPluginEnabledMap(api.kv.get(KV_KEY, {})),
    [id]: enabled,
  })
}

function listPluginStatus(state: RuntimeState): TuiPluginStatus[] {
  const seen = new Set<string>()
  const tuiPlugins: TuiPluginStatus[] = []

  for (const plugin of state.plugins) {
    if (seen.has(plugin.id)) continue
    seen.add(plugin.id)
    tuiPlugins.push({
      id: plugin.id,
      source: plugin.meta.source,
      spec: plugin.meta.spec,
      target: plugin.meta.target,
      enabled: plugin.enabled,
      active: plugin.scope !== undefined,
    })
  }

  for (const sp of state.serverPlugins) {
    if (seen.has(sp.id)) continue
    seen.add(sp.id)
    tuiPlugins.push({
      id: sp.id,
      source: sp.source,
      spec: sp.spec,
      target: "server",
      enabled: true,
      active: false,
    })
  }

  return tuiPlugins
}

export async function deactivatePluginEntry(
  state: RuntimeState,
  plugin: PluginEntry,
  persist: boolean,
  deadline?: number,
) {
  plugin.enabled = false
  if (persist) writePluginEnabledState(state.api, plugin.id, false)
  if (!plugin.scope) return true
  const scope = plugin.scope
  plugin.scope = undefined
  await scope.dispose(deadline)
  return true
}

/**
 * How long startup waits for one plugin to activate before moving on.
 *
 * Not a cancellation: the activation keeps running and still registers when it
 * finishes. What the budget bounds is how long *startup* is willing to block on
 * it, because a plugin that is merely slow and a plugin that is wedged look
 * identical from here, and only one of them should be able to stop the terminal
 * from opening. `specs/effect-tui/14-plugin-v2-architecture.md` gives cleanup
 * the same treatment for the same reason.
 */
const ACTIVATION_BUDGET_MS = 5_000

/**
 * Activate a plugin, logging which one and giving up the *wait* (not the work)
 * after the budget.
 */
async function activateWithBudget(state: RuntimeState, plugin: PluginEntry) {
  log.debug("activating tui plugin", { id: plugin.id })
  const started = Date.now()

  const activation = activatePluginEntry(state, plugin, false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ACTIVATION_BUDGET_MS)
    timer.unref?.()
  })

  try {
    const outcome = await Promise.race([activation.then(() => "done" as const), budget])
    if (outcome === "timeout") {
      log.warn("tui plugin is still activating; continuing startup without it", {
        id: plugin.id,
        afterMs: ACTIVATION_BUDGET_MS,
      })
      // Keep the failure observable when it eventually lands, rather than
      // leaving an unhandled rejection behind.
      void activation.catch((error) => log.error("tui plugin activation failed", { id: plugin.id, error }))
      return
    }
    log.debug("activated tui plugin", {
      id: plugin.id,
      ms: Date.now() - started,
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function activatePluginEntry(state: RuntimeState, plugin: PluginEntry, persist: boolean) {
  plugin.enabled = true
  if (persist) writePluginEnabledState(state.api, plugin.id, true)
  if (plugin.scope) return true

  const scope = createPluginScope(plugin.load, plugin.id)
  const api = pluginApi(state, plugin.load, scope, plugin.id)
  const ok = await Promise.resolve()
    .then(async () => {
      await plugin.plugin(api, plugin.options, plugin.meta)
      return true
    })
    .catch((error) => {
      fail("failed to initialize tui plugin", {
        path: plugin.load.spec,
        id: plugin.id,
        error,
      })
      return false
    })

  if (!ok) {
    await scope.dispose()
    return false
  }

  if (!plugin.enabled) {
    await scope.dispose()
    return true
  }

  plugin.scope = scope
  return true
}

async function activatePluginById(state: RuntimeState | undefined, id: string, persist: boolean) {
  if (!state) return false
  const plugin = state.plugins_by_id.get(id)
  if (!plugin) return false
  return activatePluginEntry(state, plugin, persist)
}

async function deactivatePluginById(state: RuntimeState | undefined, id: string, persist: boolean) {
  if (!state) return false
  const plugin = state.plugins_by_id.get(id)
  if (!plugin) return false
  return deactivatePluginEntry(state, plugin, persist)
}

function pluginApi(runtime: RuntimeState, load: PluginLoad, scope: PluginScope, base: string): TuiPluginApi {
  const api = runtime.api
  const host = runtime.slots
  const command: TuiPluginApi["command"] = {
    register(cb) {
      return scope.track(api.command.register(cb))
    },
    trigger(value) {
      api.command.trigger(value)
    },
    show() {
      api.command.show()
    },
  }
  const keymap = createKeymapApi(command)

  const route: TuiPluginApi["route"] = {
    register(list) {
      return scope.track(api.route.register(list))
    },
    navigate(name, params) {
      api.route.navigate(name, params)
    },
    get current() {
      return api.route.current
    },
  }

  const theme: TuiPluginApi["theme"] = Object.assign(Object.create(api.theme), {
    install: load.install_theme,
  })

  const event: TuiPluginApi["event"] = {
    on(type, handler) {
      return scope.track(api.event.on(type, handler))
    },
    listen(handler) {
      return scope.track(api.event.listen(handler))
    },
  }

  let count = 0

  const registerSlot = (plugin: Parameters<TuiPluginApi["slots"]["register"]>[0]) => {
    const id = count ? `${base}:${count}` : base
    count += 1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispose = scope.track(host.register({ ...plugin, id } as any))
    return { id, dispose }
  }

  const slots: TuiPluginApi["slots"] = {
    register(plugin) {
      return registerSlot(plugin).id
    },
    registerDisposable(plugin) {
      return registerSlot(plugin).dispose
    },
  }

  return {
    app: api.app,
    command,
    keymap,
    route,
    ui: api.ui,
    keybind: api.keybind,
    tuiConfig: api.tuiConfig,
    kv: api.kv,
    storage: pluginStorage(base),
    state: api.state,
    data: api.data,
    theme,
    get client() {
      return api.client
    },
    event,
    renderer: api.renderer,
    slots,
    plugins: {
      list() {
        return listPluginStatus(runtime)
      },
      activate(id) {
        return activatePluginById(runtime, id, true)
      },
      deactivate(id) {
        return deactivatePluginById(runtime, id, true)
      },
      add(spec) {
        return addPluginBySpec(runtime, spec)
      },
      install(spec, options) {
        return installPluginBySpec(runtime, spec, options?.global)
      },
    },
    lifecycle: scope.lifecycle,
  }
}

function collectPluginEntries(load: PluginLoad, meta: TuiPluginMeta): PluginEntry[] {
  if (!load.module.tui) return []
  const options = load.item ? pluginOptions(load.item) : undefined
  return [
    {
      id: load.id,
      load,
      meta,
      plugin: load.module.tui,
      options,
      enabled: true,
    },
  ]
}

function addPluginEntry(state: RuntimeState, plugin: PluginEntry) {
  if (state.plugins_by_id.has(plugin.id)) {
    fail("duplicate tui plugin id", {
      id: plugin.id,
      path: plugin.load.spec,
    })
    return false
  }

  state.plugins_by_id.set(plugin.id, plugin)
  state.plugins.push(plugin)
  return true
}

/**
 * Reports a reload failure once. Repeat reconciles with the same error stay
 * silent, so a broken file being saved over and over shows one toast.
 */
function reportReloadFailure(state: RuntimeState, id: string, message: string) {
  if (state.failures.get(id) === message) return
  state.failures.set(id, message)
  state.api.ui.toast({ variant: "error", title: "Plugin", message })
}

/** Re-arms watches for every local plugin source currently loaded. */
function watchLocalSources(state: RuntimeState) {
  const watcher = state.watcher
  if (!watcher) return
  for (const plugin of state.plugins) {
    if (plugin.load.source !== "file") continue
    watcher.add(plugin.load.entry)
  }
}

/**
 * Watches the TUI config files and the plugin discovery directories, so adding
 * or removing a plugin entry — or dropping a file into `plugin/tui` — reaches
 * the running TUI. Config files are watched by name even when absent: creating
 * `tui.json` later is exactly the case that has to work.
 */
async function watchConfigSources(state: RuntimeState) {
  const watcher = state.watcher
  if (!watcher) return
  const sources = await pluginHost()
    .sources(state.directory)
    .catch((error) => {
      log.warn("failed to resolve tui config sources", { error })
      return undefined
    })
  if (!sources) return
  for (const file of sources.files) watcher.addFile(file)
  // addPath, not addDirectory: a discovery directory that does not exist yet
  // is watched through its nearest existing ancestor, so creating it later
  // still reaches the running TUI.
  for (const dir of sources.directories) watcher.addPath(dir)
}

/**
 * Replaces one running plugin with a freshly imported version of itself.
 *
 * The swap is in place: the entry keeps its position in `state.plugins`, which
 * slot ordering (`replace` mode takes the last registration) and command
 * precedence depend on. Only this plugin is torn down; every other plugin,
 * including internal ones, is untouched.
 */
async function swapPluginEntry(state: RuntimeState, previous: PluginEntry, load: PluginLoad, meta: TuiPluginMeta) {
  const index = state.plugins.indexOf(previous)
  if (index < 0) return false

  const [next] = collectPluginEntries(load, meta)
  if (!next) {
    reportReloadFailure(state, previous.id, `${load.spec}: reloaded module has no tui export (previous version kept)`)
    return false
  }
  if (next.id !== previous.id && state.plugins_by_id.has(next.id)) {
    reportReloadFailure(
      state,
      previous.id,
      `${load.spec}: plugin id ${next.id} is already loaded (previous version kept)`,
    )
    return false
  }

  const enabled = previous.enabled
  await deactivatePluginEntry(state, previous, false)

  state.plugins[index] = next
  state.plugins_by_id.delete(previous.id)
  state.plugins_by_id.set(next.id, next)
  next.enabled = enabled
  state.failures.delete(previous.id)
  state.failures.delete(next.id)
  // The fresh version gets to report its own render failures.
  clearSlotErrors(previous.id)
  clearSlotErrors(next.id)

  log.info("hot reloaded tui plugin", { path: load.spec, id: next.id })
  // `enabled` is the persisted desired state: a manually deactivated plugin
  // stays off, and a plugin whose setup threw gets another chance once fixed.
  if (!enabled) return true
  return activatePluginEntry(state, next, false)
}

/**
 * Reloads one local plugin when its entrypoint changed on disk.
 *
 * A failed import keeps the previous version running (`keep-last-good`) and
 * only reports; fixing the file swaps the fix in on the next event.
 */
async function reloadPluginEntry(
  state: RuntimeState,
  plugin: PluginEntry,
  override?: {
    /** Re-declared config entry, when the reload is driven by a config change. */
    item?: PluginSpec
    meta?: PluginConfigMeta
    /** Reload even when the source is byte-identical (changed options). */
    force?: boolean
  },
) {
  const item = override?.item ?? plugin.load.item
  if (!item) return false

  if (!override?.force) {
    const mtime = entrypointMtime(plugin.load.entry)
    // The source vanished (rename in flight, or deleted): keep it running.
    if (mtime === undefined) return false
    if (freshSpecifier(plugin.load.entry, mtime) === plugin.load.version) return false
  }

  let error: unknown
  const load = await loadExternalPlugin(item, override?.meta ?? plugin.load.config_meta, false, {
    origin: plugin.load.origin,
    onFail: (value) => {
      error ??= value
    },
  })
  if (!load) {
    reportReloadFailure(
      state,
      plugin.id,
      `${plugin.load.spec}: ${errorMessage(error ?? new Error("failed to load"))} (previous version still active)`,
    )
    return false
  }
  if (!override?.force && load.version === plugin.load.version) return false

  const hit = await PluginMeta.touchMany([{ spec: load.spec, target: load.target, id: load.id }])
    .then((rows) => rows?.[0])
    .catch((error) => {
      log.warn("failed to track tui plugin", { path: load.spec, error })
      return undefined
    })

  return swapPluginEntry(state, plugin, load, createMeta(load.source, load.spec, load.target, hit, load.id))
}

function sameOptions(left: PluginOptions | undefined, right: PluginOptions | undefined) {
  return Bun.deepEquals(left ?? null, right ?? null)
}

/** Tears a plugin down and drops it from the runtime. */
async function removePluginEntry(state: RuntimeState, plugin: PluginEntry) {
  await deactivatePluginEntry(state, plugin, false)
  const index = state.plugins.indexOf(plugin)
  if (index >= 0) state.plugins.splice(index, 1)
  if (state.plugins_by_id.get(plugin.id) === plugin) state.plugins_by_id.delete(plugin.id)
  state.failures.delete(plugin.id)
  clearSlotErrors(plugin.id)
  log.info("removed tui plugin", { path: plugin.load.spec, id: plugin.id })
}

/**
 * Re-reads the TUI config (including directory-discovered plugins) and brings
 * the running set in line with it: entries added to `tui.json` load, removed
 * entries are torn down, and changed options restart their plugin.
 *
 * Only config-owned plugins are touched. Internal plugins and plugins added
 * through `api.plugins.add(...)` never appear in the config and are left alone.
 * New plugins are appended rather than rebuilding the whole set, so untouched
 * plugins keep their registration order.
 */
async function reconcileConfiguredPlugins(state: RuntimeState) {
  if (Flag.NIKCLI_PURE) return

  const config = await pluginHost()
    .reload(state.directory)
    .catch((error) => {
      log.warn("failed to reload tui config", { error })
      return undefined
    })
  if (!config) return

  const desired = new Map<string, PluginSpec>()
  for (const item of config.plugin ?? []) desired.set(pluginSpecifier(item), item)
  const meta = (spec: string) => config.plugin_meta?.[spec]
  // Config `plugin_enabled` merged with the KV overrides, exactly as at startup:
  // a manual toggle from the plugin manager still wins over the config value.
  const enabledState = pluginEnabledState(state, config)

  for (const plugin of [...state.plugins]) {
    if (plugin.load.origin !== "config") continue
    if (desired.has(plugin.load.spec)) continue
    await removePluginEntry(state, plugin)
  }

  for (const [spec, item] of desired) {
    const existing = state.plugins.find((plugin) => plugin.load.spec === spec)
    if (existing) {
      if (existing.load.origin !== "config") continue
      const options = pluginOptions(item)
      if (sameOptions(existing.options, options)) continue
      log.info("tui plugin options changed", { path: spec, id: existing.id })
      await reloadPluginEntry(state, existing, {
        item,
        meta: meta(spec),
        force: true,
      })
      continue
    }

    let error: unknown
    const load = await loadExternalPlugin(item, meta(spec), false, {
      origin: "config",
      onFail: (value) => {
        error ??= value
      },
    })
    if (!load) {
      reportReloadFailure(state, spec, `${spec}: ${errorMessage(error ?? new Error("failed to load"))}`)
      continue
    }
    if (state.plugins_by_id.has(load.id)) {
      reportReloadFailure(state, spec, `${spec}: plugin id ${load.id} is already loaded`)
      continue
    }

    const out = await addExternalPluginEntries(state, [load])
    for (const plugin of out.plugins) {
      state.failures.delete(spec)
      log.info("loaded tui plugin from config", { path: spec, id: plugin.id })
      // A plugin the user disabled (config or KV) loads dormant, exactly as it
      // would have on the next startup.
      plugin.enabled = enabledState[plugin.id] ?? true
      if (!plugin.enabled) continue
      await activatePluginEntry(state, plugin, false)
    }
  }

  // Flipping `plugin_enabled` in the config takes effect too: a plugin turned
  // off there is disposed, one turned back on is initialized. Internal plugins
  // are included — the config keys them by id, like the plugin manager does.
  for (const plugin of [...state.plugins]) {
    const enabled = enabledState[plugin.id]
    if (enabled === undefined || enabled === plugin.enabled) continue
    log.info("tui plugin enable state changed", { id: plugin.id, enabled })
    if (enabled) await activatePluginEntry(state, plugin, false)
    else await deactivatePluginEntry(state, plugin, false)
  }
}

/**
 * Reconcile pass: bring the plugin set in line with the config, then re-import
 * every local plugin whose source changed, one at a time so registration side
 * effects stay ordered. Unchanged plugins cost one stat, so spurious watch
 * events are nearly free.
 */
async function reloadLocalPlugins(state: RuntimeState) {
  // No instance wrapper: every host call below takes its own directory.
  {
    await reconcileConfiguredPlugins(state).catch((error) => {
      fail("failed to reconcile configured tui plugins", {
        directory: state.directory,
        error,
      })
    })

    for (const plugin of state.plugins.filter((item) => item.load.source === "file" && item.load.item)) {
      await reloadPluginEntry(state, plugin).catch((error) => {
        fail("failed to hot reload tui plugin", {
          path: plugin.load.spec,
          id: plugin.id,
          error,
        })
      })
    }
  }
  // A plugin whose id changed, or one added at runtime, needs its own watch;
  // so do config files and plugin directories that appeared since the last pass.
  watchLocalSources(state)
  await watchConfigSources(state)
}

function applyInitialPluginEnabledState(state: RuntimeState, config: PluginConfigInfo) {
  const map = pluginEnabledState(state, config)
  for (const plugin of state.plugins) {
    const enabled = map[plugin.id]
    if (enabled === undefined) continue
    plugin.enabled = enabled
  }
}

async function resolveExternalPlugins(
  list: PluginSpec[],
  wait: () => Promise<void>,
  meta: (item: PluginSpec) => PluginConfigMeta | undefined,
  origin: PluginLoad["origin"] = "config",
) {
  const loaded = await Promise.all(list.map((item) => loadExternalPlugin(item, meta(item), false, { origin })))
  const ready: PluginLoad[] = []
  let deps: Promise<void> | undefined

  for (let i = 0; i < list.length; i++) {
    let entry = loaded[i]
    if (!entry) {
      const item = list[i]
      if (!item) continue
      const spec = pluginSpecifier(item)
      if (pluginSource(spec) !== "file") continue
      deps ??= wait().catch((error) => {
        log.warn("failed waiting for tui plugin dependencies", { error })
      })
      await deps
      entry = await loadExternalPlugin(item, meta(item), true, { origin })
    }
    if (!entry) continue
    ready.push(entry)
  }

  return ready
}

async function loadAllPluginInfo(list: PluginSpec[]) {
  const results: ServerPluginEntry[] = []
  const seen = new Set<string>()

  for (const item of list) {
    const spec = pluginSpecifier(item)
    if (seen.has(spec)) continue
    seen.add(spec)

    if (isDeprecatedPlugin(spec)) continue

    try {
      const source = pluginSource(spec)
      const id = await getPluginIdFromPackage(spec, spec)
      if (id) {
        results.push({ id, spec, source })
      } else {
        // Fallback: use the package name as id
        const parsed = parsePluginSpecifier(spec)
        results.push({ id: parsed.pkg, spec, source })
      }
    } catch {
      // Fallback: use the package name as id
      const parsed = parsePluginSpecifier(spec)
      results.push({ id: parsed.pkg, spec, source: pluginSource(spec) })
    }
  }

  return results
}

async function addExternalPluginEntries(state: RuntimeState, ready: PluginLoad[]) {
  if (!ready.length) return { plugins: [] as PluginEntry[], ok: true }

  const meta = await PluginMeta.touchMany(
    ready.map((item) => ({
      spec: item.spec,
      target: item.target,
      id: item.id,
    })),
  ).catch((error) => {
    log.warn("failed to track tui plugins", { error })
    return undefined
  })

  const plugins: PluginEntry[] = []
  let ok = true
  for (let i = 0; i < ready.length; i++) {
    const entry = ready[i]
    if (!entry) continue
    const hit = meta?.[i]
    if (hit && hit.state !== "same") {
      log.info("tui plugin metadata updated", {
        path: entry.spec,
        retry: entry.retry,
        state: hit.state,
        source: hit.entry.source,
        version: hit.entry.version,
        modified: hit.entry.modified,
      })
    }

    const row = createMeta(entry.source, entry.spec, entry.target, hit, entry.id)
    for (const plugin of collectPluginEntries(entry, row)) {
      if (!addPluginEntry(state, plugin)) {
        ok = false
        continue
      }
      plugins.push(plugin)
    }
  }

  return { plugins, ok }
}

function defaultPluginMeta(state: RuntimeState): PluginConfigMeta {
  return {
    scope: "local",
    source: state.api.state.path.config || path.join(state.directory, ".nikcli", "tui.json"),
  }
}

function installCause(err: unknown) {
  if (!err || typeof err !== "object") return
  if (!("cause" in err)) return
  return (err as { cause?: unknown }).cause
}

function installDetail(err: unknown) {
  const hit = installCause(err) ?? err
  if (!(hit instanceof Process.RunFailedError)) {
    return {
      message: errorMessage(hit),
      missing: false,
    }
  }

  const lines = hit.stderr
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const errs = lines.filter((line) => line.startsWith("error:")).map((line) => line.replace(/^error:\s*/, ""))
  return {
    message: errs[0] ?? lines.at(-1) ?? errorMessage(hit),
    missing: lines.some((line) => line.includes("No version matching")),
  }
}

async function addPluginBySpec(state: RuntimeState | undefined, raw: string) {
  if (!state) return false
  const spec = raw.trim()
  if (!spec) return false

  const pending = state.pending.get(spec)
  const item = pending?.item ?? spec
  const nextSpec = pluginSpecifier(item)
  if (state.plugins.some((plugin) => plugin.load.spec === nextSpec)) {
    state.pending.delete(spec)
    return true
  }

  const meta = pending?.meta ?? defaultPluginMeta(state)

  const ready = await resolveExternalPlugins(
    [item],
    () => pluginHost().waitForDependencies(state.directory),
    () => meta,
    "runtime",
  ).catch((error) => {
    fail("failed to add tui plugin", { path: nextSpec, error })
    return [] as PluginLoad[]
  })
  if (!ready.length) {
    fail("failed to add tui plugin", { path: nextSpec })
    return false
  }

  const first = ready[0]
  if (!first) {
    fail("failed to add tui plugin", { path: nextSpec })
    return false
  }
  if (state.plugins_by_id.has(first.id)) {
    state.pending.delete(spec)
    return true
  }

  const out = await addExternalPluginEntries(state, [first])
  let ok = out.ok && out.plugins.length > 0
  for (const plugin of out.plugins) {
    const active = await activatePluginEntry(state, plugin, false)
    if (!active) ok = false
  }

  if (ok) {
    state.pending.delete(spec)
    // A plugin added at runtime hot-reloads like a configured one.
    watchLocalSources(state)
  }
  if (!ok) {
    fail("failed to add tui plugin", { path: nextSpec })
  }
  return ok
}

async function installPluginBySpec(
  state: RuntimeState | undefined,
  raw: string,
  global = false,
): Promise<TuiPluginInstallResult> {
  if (!state) {
    return {
      ok: false,
      message: "Plugin runtime is not ready.",
    }
  }

  const spec = raw.trim()
  if (!spec) {
    return {
      ok: false,
      message: "Plugin package name is required",
    }
  }

  const dir = state.api.state.path
  if (!dir.directory) {
    return {
      ok: false,
      message: "Paths are still syncing. Try again in a moment.",
    }
  }

  const install = await installModulePlugin(spec)
  if (!install.ok) {
    const out = installDetail(install.error)
    return {
      ok: false,
      message: out.message,
      missing: out.missing,
    }
  }

  const manifest = await readPluginManifest(install.target)
  if (!manifest.ok) {
    if (manifest.code === "manifest_no_targets") {
      return {
        ok: false,
        message: `"${spec}" does not declare supported targets in package.json`,
      }
    }

    return {
      ok: false,
      message: `Installed "${spec}" but failed to read ${manifest.file}`,
    }
  }

  const patch = await patchPluginConfig({
    spec,
    targets: manifest.targets,
    global,
    vcs: dir.worktree && dir.worktree !== "/" ? "git" : undefined,
    worktree: dir.worktree,
    directory: dir.directory,
  })
  if (!patch.ok) {
    if (patch.code === "invalid_json") {
      return {
        ok: false,
        message: `Invalid JSON in ${patch.file} (${patch.parse} at line ${patch.line}, column ${patch.col})`,
      }
    }

    return {
      ok: false,
      message: errorMessage(patch.error),
    }
  }

  const tui = manifest.targets.find((item) => item.kind === "tui")
  if (tui) {
    const file = patch.items.find((item) => item.kind === "tui")?.file
    state.pending.set(spec, {
      item: tui.opts ? [spec, tui.opts] : spec,
      meta: {
        scope: global ? "global" : "local",
        source: (file ?? dir.config) || path.join(patch.dir, "tui.json"),
      },
    })
  }

  return {
    ok: true,
    dir: patch.dir,
    tui: Boolean(tui),
  }
}

export namespace TuiPluginRuntime {
  let dir = ""
  let loaded: Promise<void> | undefined
  let runtime: RuntimeState | undefined
  /** Serializes reload passes so overlapping watch events cannot interleave swaps. */
  let reloading: Promise<void> = Promise.resolve()
  export const Slot = View

  export async function init(api: HostPluginApi) {
    const cwd = process.cwd()
    if (loaded) {
      if (dir !== cwd) {
        throw new Error(`TuiPluginRuntime.init() called with a different working directory. expected=${dir} got=${cwd}`)
      }
      return loaded
    }

    dir = cwd
    loaded = load(api)
    return loaded
  }

  export function list() {
    if (!runtime) return []
    return listPluginStatus(runtime)
  }

  export async function activatePlugin(id: string) {
    return activatePluginById(runtime, id, true)
  }

  export async function deactivatePlugin(id: string) {
    return deactivatePluginById(runtime, id, true)
  }

  export async function addPlugin(spec: string) {
    return addPluginBySpec(runtime, spec)
  }

  export async function installPlugin(spec: string, options?: { global?: boolean }) {
    return installPluginBySpec(runtime, spec, options?.global)
  }

  /** Runs a reload pass now. Only for tests; the watcher drives this normally. */
  export async function reload() {
    const state = runtime
    if (!state) return
    await schedule(state)
  }

  export async function dispose() {
    const task = loaded
    loaded = undefined
    dir = ""
    if (task) await task
    const state = runtime
    runtime = undefined
    if (!state) return
    state.watcher?.dispose()
    state.watcher = undefined
    await reloading.catch(() => undefined)
    const queue = [...state.plugins].reverse()
    const deadline = Date.now() + SHUTDOWN_BUDGET_MS
    for (const plugin of queue) {
      await deactivatePluginEntry(state, plugin, false, deadline)
    }
    if (Date.now() > deadline) {
      log.warn("tui plugin shutdown exceeded its budget; remaining cleanups were not waited on", {
        budget: SHUTDOWN_BUDGET_MS,
      })
    }
  }

  function schedule(state: RuntimeState) {
    reloading = reloading.catch(() => undefined).then(() => reloadLocalPlugins(state))
    // Observe failures immediately: a plugin cleanup that throws would otherwise
    // surface as an unhandled rejection until the next watch event.
    void reloading.catch((error) => {
      fail("failed to reload tui plugins", {
        directory: state.directory,
        error,
      })
    })
    return reloading
  }

  async function load(api: Api) {
    dbg("load() start")
    const cwd = process.cwd()
    const slots = setupSlots(api)
    const next: RuntimeState = {
      directory: cwd,
      api,
      slots,
      plugins: [],
      plugins_by_id: new Map(),
      serverPlugins: [],
      pending: new Map(),
      failures: new Map(),
    }
    runtime = next

    // The instance wrapper this replaced also caught: a plugin that throws on
    // load must not take the whole terminal down with it.
    try {
      {
        const config = await pluginHost().get(cwd)
        const plugins = Flag.NIKCLI_PURE ? [] : (config.plugin ?? [])
        if (Flag.NIKCLI_PURE && config.plugin?.length) {
          log.info("skipping external tui plugins in pure mode", {
            count: config.plugin.length,
          })
        }

        dbg("runtime: internal plugins", INTERNAL_TUI_PLUGINS.map((x) => x.id).join(","))
        for (const item of INTERNAL_TUI_PLUGINS) {
          log.info("loading internal tui plugin", { id: item.id })
          const entry = loadInternalPlugin(item)
          const meta = createMeta(entry.source, entry.spec, entry.target, undefined, entry.id)
          for (const plugin of collectPluginEntries(entry, meta)) {
            addPluginEntry(next, plugin)
          }
        }

        const ready = await resolveExternalPlugins(
          plugins,
          () => pluginHost().waitForDependencies(cwd),
          (item) => config.plugin_meta?.[pluginSpecifier(item)],
        )
        await addExternalPluginEntries(next, ready)

        for (const entry of ready) {
          if (!next.serverPlugins.some((p) => p.id === entry.id)) {
            next.serverPlugins.push({
              id: entry.id,
              spec: entry.spec,
              source: entry.source,
            })
          }
        }

        const allPluginInfo = await loadAllPluginInfo(plugins)
        for (const info of allPluginInfo) {
          if (!next.serverPlugins.some((p) => p.id === info.id)) {
            next.serverPlugins.push(info)
          }
        }

        applyInitialPluginEnabledState(next, config)
        for (const plugin of next.plugins) {
          if (!plugin.enabled) continue
          // Keep plugin execution sequential for deterministic side effects:
          // command registration order affects keybind/command precedence,
          // route registration is last-wins when ids collide,
          // and hook chains rely on stable plugin ordering.
          //
          // Sequential also means one plugin whose `setup` never settles holds
          // every plugin after it, and the whole startup with them: the footer
          // sits on "Loading plugins..." forever because `init` never resolves.
          // There was no per-plugin log here, so the only evidence was the id
          // of the last plugin to be *listed*, which is not the one that hung.
          await activateWithBudget(next, plugin)
        }
      }
    } catch (error) {
      dbg("load() failed", String(error))
      fail("failed to load tui plugins", { directory: cwd, error })
    }

    // Hot reload: watch local plugin sources so editing one swaps that plugin
    // in place, without restarting the TUI or any other plugin. npm packages
    // resolve into the package cache and are immutable for the session.
    if (!Flag.NIKCLI_PURE && !Flag.NIKCLI_DISABLE_PLUGIN_RELOAD) {
      next.watcher = createSourceWatcher({
        onChange: () => {
          if (runtime !== next) return
          void schedule(next)
        },
      })
      watchLocalSources(next)
      await watchConfigSources(next)
    }
  }
}
