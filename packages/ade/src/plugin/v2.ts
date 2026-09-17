/**
 * The ADE half of the v2 plugin contract: `adaptV2TuiPlugin`, for a desktop
 * surface instead of a terminal.
 *
 * It does the same three jobs as its TUI counterpart and does them in the same
 * order, so the two can be read side by side:
 *
 *   1. build a `Context` whose registration calls land on the host,
 *   2. track what was registered so a disposer drops exactly one thing once,
 *   3. run `setup`, check what it returned, and hand the cleanup to the host.
 *
 * The differences are all the ones the ADE context names — pages become panes,
 * slots become sidebar sections, commands exist — plus one this file owns
 * alone: **nothing a plugin supplies is trusted on the way in**. The TUI
 * adapter checks that a page name is non-empty and unique and stops there,
 * because in a terminal a route name is never a DOM id. Here it is. See
 * `./trust` for what is checked and why.
 */
import type { Context, Definition } from "@nikcli-ai/plugin/v2/ade/plugin"
import type { Data } from "@nikcli-ai/plugin/v2/ade/context"
import type { PluginRegistry } from "./registry"
import { pluginStorage } from "./storage"
import { assertIdentifier, safeKeywords, safeLabel, safePaneData } from "./trust"

/** What the adapter needs from the workbench to build a context. */
export interface AdePluginHost {
  readonly registry: PluginRegistry
  readonly data: Data
  /** Opens the command palette, the way `palette.open` does. */
  readonly showPalette: () => void
  /**
   * Mirrors a registry tile into the workbench so the grid draws it.
   *
   * Split out rather than done inside the registry because the workbench owns
   * pane focus, expansion and closing, and a registry that reached into that
   * signal would be a second writer to it.
   */
  readonly onPaneOpened: (pane: { id: string; pluginId: string; name: string; title: string }) => void
  readonly onPaneClosed: (paneId: string) => void
}

export interface LoadedV2Plugin {
  readonly id: string
  /** Tears down everything this plugin registered, once. */
  readonly dispose: () => Promise<void>
}

/**
 * Runs one v2 definition against the host and returns its teardown.
 *
 * Every disposer the plugin is handed is also recorded here, so tearing the
 * plugin down does not depend on the plugin having kept them — the TUI does
 * the same through `scope.track`, for the same reason: a plugin that throws
 * halfway through `setup` has already registered things, and those things have
 * to go.
 */
export async function adaptV2AdePlugin(
  definition: Definition,
  host: AdePluginHost,
  options?: Record<string, unknown>,
): Promise<LoadedV2Plugin> {
  const id = assertIdentifier(definition.id || "<anonymous>", "itself", definition.id)

  const disposers: Array<() => void> = []
  /**
   * Wraps a disposer so it runs at most once and stops being tracked when it
   * does. Without the untracking, a plugin that disposes a pane and then gets
   * torn down would have the registry asked to drop the same key twice — and
   * the second drop would silently hit whatever had claimed the key since.
   */
  const track = (off: () => void) => {
    let active = true
    const wrapped = () => {
      if (!active) return
      active = false
      const index = disposers.indexOf(wrapped)
      if (index >= 0) disposers.splice(index, 1)
      off()
    }
    disposers.push(wrapped)
    return wrapped
  }

  const context: Context = {
    options: options ?? {},
    data: host.data,
    storage: pluginStorage(id),
    ui: {
      command: {
        register(command) {
          const commandId = assertIdentifier(id, "a command", command.id)
          if (typeof command.run !== "function") {
            throw new TypeError(`V2 ADE plugin ${id} registered command ${commandId} without a run function`)
          }
          return track(
            host.registry.addCommand({
              pluginId: id,
              commandId,
              title: safeLabel(command.title, commandId),
              // The plugin's own id is the default section, so an unlabelled
              // command is filed under something the user can recognise
              // instead of landing in whichever ADE group sorts first.
              group: safeLabel(command.group, id),
              keywords: safeKeywords(command.keywords),
              run: command.run,
            }),
          )
        },
        run(commandId) {
          // Only this plugin's own commands: `run` taking a qualified id would
          // be a way to invoke another plugin's handler, or ADE's.
          const entry = host.registry.commands().find((item) => item.pluginId === id && item.commandId === commandId)
          if (!entry) return
          void entry.run()
        },
        palette() {
          host.showPalette()
        },
      },

      pane: {
        register(pane) {
          const name = assertIdentifier(id, "a pane", pane.name)
          if (typeof pane.render !== "function") {
            throw new TypeError(`V2 ADE plugin ${id} registered pane ${name} without a render function`)
          }
          return track(
            host.registry.addPane({
              pluginId: id,
              name,
              title: safeLabel(pane.title, name),
              render: pane.render,
            }),
          )
        },
        open(input) {
          const name = typeof input?.name === "string" ? input.name : ""
          // Not asserted: opening is usually a click handler, and a bad name
          // here is the plugin's bug to find, not a reason to break the click.
          // `openPane` refuses anything unregistered anyway.
          const data = safePaneData(input?.data)
          const paneId = host.registry.openPane(id, name, data)
          if (!paneId) return undefined
          const registered = host.registry.panes().find((item) => item.pluginId === id && item.name === name)
          host.onPaneOpened({ id: paneId, pluginId: id, name, title: registered?.title ?? name })
          return paneId
        },
        close(paneId) {
          // Ownership is checked, not assumed: `close` takes an id, and an id
          // is a string the plugin could have made up.
          if (!host.registry.openFor(id).some((item) => item.id === paneId)) return
          host.registry.closePane(paneId)
          host.onPaneClosed(paneId)
        },
        list() {
          return host.registry.openFor(id).map((item) => ({ id: item.id, name: item.name, data: item.data }))
        },
      },

      section: {
        register(section) {
          const name = assertIdentifier(id, "a section", section.name)
          if (typeof section.render !== "function") {
            throw new TypeError(`V2 ADE plugin ${id} registered section ${name} without a render function`)
          }
          return track(
            host.registry.addSection({
              pluginId: id,
              name,
              title: safeLabel(section.title, name),
              render: section.render,
            }),
          )
        },
      },
    },
  }

  let cleanup: (() => Promise<void> | void) | undefined
  try {
    const result = await definition.setup(context)
    if (result !== undefined && typeof result !== "function") {
      throw new TypeError(`V2 ADE plugin ${id} setup() must return a cleanup function or void`)
    }
    cleanup = result ?? undefined
  } catch (error) {
    // Registrations made before the throw are rolled back here rather than
    // left for whoever catches this: a plugin that failed to set up has no
    // owner left to tidy up after it.
    host.registry.removePlugin(id)
    throw error
  }

  let disposed = false
  return {
    id,
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        await cleanup?.()
      } finally {
        /*
         * The workbench is told about every tile before the registry forgets
         * it. `removePlugin` drops them from the registry alone, and a tile
         * left in the grid with no definition behind it is a pane the user
         * can see, focus and not close — which is what happened the first
         * time this only called `removePlugin`.
         */
        for (const tile of host.registry.openFor(id)) host.onPaneClosed(tile.id)
        // Reverse order, like the TUI's scope: a plugin that registered a pane
        // and then a command that opens it expects the command to go first.
        for (const off of [...disposers].reverse()) off()
        // Belt and braces. `track` covers everything handed out through the
        // context; this covers anything the registry still holds because a
        // disposer threw, or because the plugin stashed one and lost it.
        host.registry.removePlugin(id)
      }
    },
  }
}

/**
 * Reads a module's default export as a v2 ADE definition, or `undefined` when
 * it is not one.
 *
 * Mirrors `readV2TuiPlugin`, including its split between "not a v2 plugin"
 * (return) and "a broken v2 plugin" (throw). The distinction matters at the
 * call site: the first means try another reader, the second means report.
 */
export function readV2AdePlugin(raw: Record<string, unknown>, spec: string): Definition | undefined {
  const value = raw.default
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  if (!("setup" in value)) return undefined

  const candidate = value as { id?: unknown; setup?: unknown }
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    throw new TypeError(`V2 ADE plugin ${spec} must define a non-empty id`)
  }
  if (typeof candidate.setup !== "function") {
    throw new TypeError(`V2 ADE plugin ${spec} has an invalid setup export`)
  }
  // The charset check happens here rather than at registration so a plugin
  // with an unusable id is rejected before any of its code has run.
  assertIdentifier(spec, "itself", candidate.id.trim())

  return value as unknown as Definition
}
