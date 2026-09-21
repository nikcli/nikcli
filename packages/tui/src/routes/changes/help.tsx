import { For } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { DialogHeader, useDialog } from "@tui/ui/dialog"

type Section = {
  title: string
  items: Array<{ keys: string; description: string }>
}

const SECTIONS: Section[] = [
  {
    title: "Files panel",
    items: [
      { keys: "j / k or ↑ / ↓", description: "Move selection" },
      { keys: "h / l or ← / →", description: "Collapse / expand directory" },
      { keys: "space / enter", description: "Toggle directory · select file" },
      { keys: "g / G", description: "Jump to first / last file" },
      { keys: "b", description: "Toggle tree ↔ flat view" },
      { keys: "/", description: "Filter files" },
      { keys: "tab", description: "Switch to diff pane" },
    ],
  },
  {
    title: "Diff pane",
    items: [
      { keys: "j / k or ↑ / ↓", description: "Move line" },
      { keys: "g / G", description: "Jump to top / bottom of file" },
      { keys: "] / [", description: "Next / previous file" },
      { keys: "n / N", description: "Next / previous review comment" },
      { keys: "c", description: "Comment on hovered line" },
      { keys: "m", description: "Mark current file reviewed" },
      { keys: "s", description: "Toggle split / unified view" },
      { keys: "w", description: "Toggle word wrap" },
      { keys: "r", description: "Toggle review panel" },
      { keys: "tab", description: "Switch back to files pane" },
    ],
  },
  {
    title: "General",
    items: [
      { keys: "esc", description: "Back to session" },
      { keys: "?", description: "This help" },
    ],
  },
]

export function ChangesHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()

  useKeyboard((evt) => {
    if (evt.name === "escape" || evt.name === "return" || evt.name === "?" || evt.name === "q") {
      evt.preventDefault()
      dialog.clear()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <DialogHeader title="Changes — keybindings" />
      <For each={SECTIONS}>
        {(section) => (
          <box gap={0}>
            <text fg={theme.accent.fg} attributes={TextAttributes.BOLD}>
              {section.title}
            </text>
            <For each={section.items}>
              {(item) => (
                <box flexDirection="row" gap={2}>
                  <box width={20} flexShrink={0}>
                    <text fg={theme.foreground.default}>{item.keys}</text>
                  </box>
                  <text fg={theme.foreground.muted}>{item.description}</text>
                </box>
              )}
            </For>
            <box height={1} />
          </box>
        )}
      </For>
    </box>
  )
}
