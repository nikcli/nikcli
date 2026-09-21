import { createMemo } from "solid-js"
import { allCommands, type CommandOption } from "../dialog-command"
import { useKeybind } from "@tui/context/keybind"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogSettings } from "./index"

/**
 * Every key the TUI answers to, in one place.
 *
 * Built from the command registry rather than from the config, because the
 * registry is the only side that knows what a binding *does*: the config is a
 * map of names to keys, and `session_timeline` tells a reader nothing it did
 * not already suspect. The registry carries the title and the category the
 * command palette already shows, so this is that same knowledge asked a
 * different question — not "what can I run" but "what does this key do".
 *
 * Two things deliberately absent. It does not offer to rebind: writing a
 * keybind means writing config, and a reference sheet that can silently change
 * behaviour is a worse thing than one that cannot. And it does not list
 * commands without a binding, which is what the palette is for.
 */
export function DialogSettingsKeybinds() {
  const dialog = useDialog()
  const keybind = useKeybind()
  const sync = useSync()

  const options = createMemo((): DialogSelectOption<string>[] => {
    const bound = allCommands()
      .filter((option: CommandOption) => option.keybind)
      .map((option: CommandOption) => ({
        title: String(option.title),
        value: `command:${option.value}`,
        category: option.category ?? "General",
        footer: keybind.print(option.keybind!),
      }))

    /**
     * The leader, which no command owns.
     *
     * It is the prefix half of every `<leader>x` binding above, so a sheet that
     * lists those without it explains nothing.
     */
    const leader = sync.data.config.keybinds?.leader
    const prefix = leader
      ? [
          {
            title: "Leader",
            description: () => "Prefix for the bindings written <leader>…",
            value: "keybind:leader",
            category: "General",
            footer: leader,
          },
        ]
      : []

    return [...prefix, ...bound].sort((a, b) =>
      a.category === b.category ? a.title.localeCompare(b.title) : a.category.localeCompare(b.category),
    )
  })

  return (
    <DialogSelect
      title="Keybindings"
      placeholder="Search keys and commands"
      options={options()}
      back={() => dialog.replace(() => <DialogSettings />)}
    />
  )
}
