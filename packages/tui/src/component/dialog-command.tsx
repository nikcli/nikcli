import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import {
  createContext,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  useContext,
  type Accessor,
  type Owner,
  type ParentProps,
} from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { useRoute } from "@tui/context/route"
import { settingsCommandOptions } from "./dialog-settings"

const globalCommands: Accessor<CommandOption[]>[] = []

type Context = ReturnType<typeof init>
const ctx = createContext<Context>()

export type Slash = {
  name: string
  aliases?: string[]
}

export type CommandOption = DialogSelectOption<string> & {
  keybind?: string
  suggested?: boolean
  slash?: Slash
  hidden?: boolean
  enabled?: boolean
}

function init() {
  const [registrations, setRegistrations] = createSignal<Accessor<CommandOption[]>[]>([])
  const [suspendCount, setSuspendCount] = createSignal(0)
  const owner: Owner | null = getOwner()
  const dialog = useDialog()
  const keybind = useKeybind()
  const route = useRoute()

  const entries = createMemo(() => {
    const registered = registrations().flatMap((x) => x())
    const global = globalCommands.flatMap((x) => x())
    const all = [...registered, ...global]
    const seen = new Set<string>()
    const unique: typeof all = []
    for (const item of all) {
      const key = `${item.category ?? ""}|${item.value}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(item)
    }
    return unique.map((x) => ({
      ...x,
      footer: x.keybind ? keybind.print(x.keybind) : undefined,
    }))
  })

  const isEnabled = (option: CommandOption) => option.enabled !== false
  const isVisible = (option: CommandOption) => isEnabled(option) && !option.hidden

  const visibleOptions = createMemo(() => entries().filter((option) => isVisible(option)))
  const suggestedOptions = createMemo(() =>
    visibleOptions()
      .filter((option) => option.suggested)
      .map((option) => ({
        ...option,
        value: `suggested:${option.value}`,
        category: "Suggested",
      })),
  )
  const suspended = () => suspendCount() > 0

  useKeyboard((evt) => {
    if (suspended()) return
    if (dialog.stack.length > 0) return
    if (route.data.type === "changes") {
      if (
        keybind.match("agent_cycle", evt) ||
        keybind.match("agent_cycle_reverse", evt) ||
        keybind.match("permission_mode", evt)
      ) {
        return
      }
    }
    for (const option of entries()) {
      if (!isEnabled(option)) continue
      if (option.keybind && keybind.match(option.keybind, evt)) {
        evt.preventDefault()
        try {
          option.onSelect?.(dialog)
        } catch (err) {
          console.error("[command]", option.value, err instanceof Error ? err.message : err)
        }
        return
      }
    }
  })

  const result = {
    trigger(name: string) {
      for (const option of entries()) {
        if (option.value === name) {
          if (!isEnabled(option)) return
          option.onSelect?.(dialog)
          return
        }
      }
    },
    slashes() {
      return visibleOptions().flatMap((option) => {
        const slash = option.slash
        if (!slash) return []
        return {
          display: "/" + slash.name,
          description: option.description ?? option.title,
          aliases: slash.aliases?.map((alias) => "/" + alias),
          onSelect: () => result.trigger(option.value),
        }
      })
    },
    keybinds(enabled: boolean) {
      setSuspendCount((count) => count + (enabled ? -1 : 1))
    },
    suspended,
    /**
     * Every registered command, enabled or not.
     *
     * The palette shows what you can *run*; this is for asking a different
     * question of the same knowledge — the keybinding sheet needs the ones with
     * a binding, including any the palette hides.
     */
    all: entries,
    show() {
      dialog.replace(() => <DialogCommand options={visibleOptions()} suggestedOptions={suggestedOptions()} />)
    },
    register(cb: () => CommandOption[]) {
      let results: Accessor<CommandOption[]>
      runWithOwner(owner, () => {
        results = createMemo(cb)
        setRegistrations((arr) => [results!, ...arr])
        onCleanup(() => {
          setRegistrations((arr) => arr.filter((x) => x !== results))
        })
      })
      return () => {
        setRegistrations((arr) => arr.filter((x) => x !== results))
      }
    },
  }
  return result
}

export function registerGlobalCommand(accessor: Accessor<CommandOption[]>): () => void {
  globalCommands.push(accessor)
  return () => {
    const idx = globalCommands.indexOf(accessor)
    if (idx !== -1) globalCommands.splice(idx, 1)
  }
}

export function useCommandDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useCommandDialog must be used within a CommandProvider")
  }
  return value
}

export function CommandProvider(props: ParentProps) {
  const value = init()
  const dialog = useDialog()
  const keybind = useKeybind()

  useKeyboard((evt) => {
    if (value.suspended()) return
    if (dialog.stack.length > 0) return
    if (evt.defaultPrevented) return
    if (keybind.match("command_list", evt)) {
      evt.preventDefault()
      value.show()
      return
    }
  })

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

function DialogCommand(props: { options: CommandOption[]; suggestedOptions: CommandOption[] }) {
  const [filter, setFilter] = createSignal("")
  const list = createMemo(() => {
    const all = filter()
      ? [...props.options, ...settingsCommandOptions()]
      : [...props.suggestedOptions, ...props.options]
    const seen = new Map<string, number>()
    const unique: typeof all = []
    for (const item of all) {
      const key = `${item.category ?? ""}|${item.value}`
      if (seen.has(key)) continue
      seen.set(key, unique.length)
      unique.push(item)
    }
    return unique
  })
  return <DialogSelect title="Commands" options={list()} onFilter={setFilter} />
}
