/**
 * Everything loaded plugins have put on ADE's surfaces, in one place.
 *
 * The TUI keeps three of these — `api.command`, `api.route`, `api.slots` —
 * each owned by a different module and each with its own disposal protocol.
 * ADE has one because the three lists are read by one component tree and torn
 * down at one moment; splitting them here would only mean three copies of the
 * same "register, remember the key, drop it exactly once" bookkeeping.
 *
 * A `.ts` module, not part of a component, because it is the thing the tests
 * drive: a test that imports `workbench.tsx` cannot run at all in this package
 * (no automatic JSX runtime under `bun test`), so any logic worth pinning has
 * to be reachable without it. Solid's `createSignal` is plain JavaScript and
 * works fine here.
 */
import { createSignal, type JSX } from "solid-js"
import { pluginPaneId, qualifiedCommandId } from "./trust"

export interface RegisteredCommand {
  /** The id the palette sees, already namespaced. Unique across all plugins. */
  readonly key: string
  readonly pluginId: string
  /** The id the plugin used, unqualified. */
  readonly commandId: string
  readonly title: string
  readonly group: string
  readonly keywords?: string[]
  readonly run: () => Promise<void> | void
}

export interface RegisteredPane {
  readonly key: string
  readonly pluginId: string
  readonly name: string
  readonly title: string
  readonly render: (input: { readonly data?: Record<string, unknown> }) => JSX.Element
}

export interface RegisteredSection {
  readonly key: string
  readonly pluginId: string
  readonly name: string
  readonly title: string
  readonly render: (props: Record<string, unknown>) => JSX.Element
}

/** One open tile of a registered pane. */
export interface OpenPluginPane {
  readonly id: string
  readonly pluginId: string
  readonly name: string
  readonly data?: Record<string, unknown>
}

export interface PluginRegistry {
  commands: () => RegisteredCommand[]
  panes: () => RegisteredPane[]
  sections: () => RegisteredSection[]
  open: () => OpenPluginPane[]

  addCommand(command: Omit<RegisteredCommand, "key">): () => void
  addPane(pane: Omit<RegisteredPane, "key">): () => void
  addSection(section: Omit<RegisteredSection, "key">): () => void

  /** The registered pane definition for an open tile, or `undefined`. */
  definitionFor(paneId: string): RegisteredPane | undefined
  openPane(pluginId: string, name: string, data?: Record<string, unknown>): string | undefined
  closePane(paneId: string): void
  /** The open tiles belonging to one plugin. */
  openFor(pluginId: string): OpenPluginPane[]

  findCommand(key: string): RegisteredCommand | undefined
  /** Everything one plugin registered, dropped at once. For teardown. */
  removePlugin(pluginId: string): void
}

/**
 * Duplicate registration is a throw, matching `adaptV2TuiPlugin`.
 *
 * The alternative — last one wins — hides the bug: two copies of a plugin
 * loaded from two config scopes would silently run, each disposing the other's
 * registration, and the symptom is a command that works every other time.
 */
function claim(keys: Set<string>, key: string, what: string) {
  if (keys.has(key)) throw new Error(`${what} already registered: ${key}`)
  keys.add(key)
}

export function createPluginRegistry(): PluginRegistry {
  const [commands, setCommands] = createSignal<RegisteredCommand[]>([])
  const [panes, setPanes] = createSignal<RegisteredPane[]>([])
  const [sections, setSections] = createSignal<RegisteredSection[]>([])
  const [open, setOpen] = createSignal<OpenPluginPane[]>([])

  const commandKeys = new Set<string>()
  const paneKeys = new Set<string>()
  const sectionKeys = new Set<string>()

  /*
   * Monotonic, never reset. Two tiles of the same plugin pane are two tiles —
   * the grid keys on the id, the terminal registry keys on the id, and
   * `closePane` removes exactly one. Reusing a number after a close would hand
   * the new tile the old one's identity, which is the bug `paneSequence` in
   * `workbench.tsx` exists to prevent for sessions.
   */
  let sequence = 0

  const addCommand: PluginRegistry["addCommand"] = (command) => {
    const key = qualifiedCommandId(command.pluginId, command.commandId)
    claim(commandKeys, key, "Command")
    const entry: RegisteredCommand = { ...command, key }
    setCommands((list) => [...list, entry])
    let active = true
    return () => {
      if (!active) return
      active = false
      commandKeys.delete(key)
      setCommands((list) => list.filter((item) => item !== entry))
    }
  }

  const addPane: PluginRegistry["addPane"] = (pane) => {
    const key = `${pane.pluginId}:${pane.name}`
    claim(paneKeys, key, "Pane")
    const entry: RegisteredPane = { ...pane, key }
    setPanes((list) => [...list, entry])
    let active = true
    return () => {
      if (!active) return
      active = false
      paneKeys.delete(key)
      setPanes((list) => list.filter((item) => item !== entry))
      // Tiles of a pane whose definition is gone have nothing left to draw.
      setOpen((list) => list.filter((item) => !(item.pluginId === pane.pluginId && item.name === pane.name)))
    }
  }

  const addSection: PluginRegistry["addSection"] = (section) => {
    const key = `${section.pluginId}:${section.name}`
    claim(sectionKeys, key, "Section")
    const entry: RegisteredSection = { ...section, key }
    setSections((list) => [...list, entry])
    let active = true
    return () => {
      if (!active) return
      active = false
      sectionKeys.delete(key)
      setSections((list) => list.filter((item) => item !== entry))
    }
  }

  return {
    commands,
    panes,
    sections,
    open,
    addCommand,
    addPane,
    addSection,

    definitionFor(paneId) {
      const tile = open().find((item) => item.id === paneId)
      if (!tile) return undefined
      return panes().find((item) => item.pluginId === tile.pluginId && item.name === tile.name)
    },

    openPane(pluginId, name, data) {
      const known = panes().some((item) => item.pluginId === pluginId && item.name === name)
      if (!known) return undefined
      sequence += 1
      const id = pluginPaneId(pluginId, name, sequence)
      setOpen((list) => [...list, { id, pluginId, name, data }])
      return id
    },

    closePane(paneId) {
      setOpen((list) => list.filter((item) => item.id !== paneId))
    },

    openFor(pluginId) {
      return open().filter((item) => item.pluginId === pluginId)
    },

    findCommand(key) {
      return commands().find((item) => item.key === key)
    },

    removePlugin(pluginId) {
      for (const item of commands()) if (item.pluginId === pluginId) commandKeys.delete(item.key)
      for (const item of panes()) if (item.pluginId === pluginId) paneKeys.delete(item.key)
      for (const item of sections()) if (item.pluginId === pluginId) sectionKeys.delete(item.key)
      setCommands((list) => list.filter((item) => item.pluginId !== pluginId))
      setPanes((list) => list.filter((item) => item.pluginId !== pluginId))
      setSections((list) => list.filter((item) => item.pluginId !== pluginId))
      setOpen((list) => list.filter((item) => item.pluginId !== pluginId))
    },
  }
}
