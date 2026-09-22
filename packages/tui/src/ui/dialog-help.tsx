import { useScrollAcceleration } from "@tui/util/scroll"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { DialogHeader, useDialog } from "./dialog"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { For, createMemo, onMount } from "solid-js"

const SHORTCUTS: Array<{ key: string; description: string }> = [
  { key: "command_list", description: "Open the command palette" },
  { key: "app_support", description: "Open the support assistant" },
  { key: "session_list", description: "List all sessions" },
  { key: "session_new", description: "Create a new session" },
  {
    key: "session_tab_back",
    description: "Go back through session tab history",
  },
  {
    key: "session_tab_forward",
    description: "Go forward through session tab history",
  },
  { key: "theme_list", description: "Switch theme" },
  { key: "status_view", description: "View status & usage" },
  {
    key: "sync_view",
    description: "View sync status (hub remote, outbox, recent events)",
  },
  { key: "model_favorite_toggle", description: "Cycle favorite models" },
  { key: "sidebar_toggle", description: "Toggle the sidebar" },
  { key: "app_exit", description: "Exit nikcli" },
]

const SLASH_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "/help", description: "Show this dialog" },
  { name: "/support", description: "Chat with the support assistant" },
  { name: "/sessions", description: "Browse past sessions" },
  { name: "/models", description: "Pick a model" },
  { name: "/agents", description: "Pick an agent" },
  { name: "/skills", description: "Browse skills" },
  { name: "/mcps", description: "Manage MCP servers" },
  { name: "/themes", description: "Switch theme" },
  { name: "/status", description: "View runtime status" },
  {
    name: "/sync",
    description: "View sync status (hub remote, outbox, recent events)",
  },
  { name: "/usage", description: "View token & cost usage" },
  { name: "/config", description: "Open configuration" },
  { name: "/auth", description: "Manage auth providers" },
  { name: "/connect", description: "Connect a provider" },
  { name: "/workspace", description: "Switch workspace" },
]

const CLI_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "nikcli", description: "Open the TUI" },
  { name: "nikcli run <prompt>", description: "Run a one-shot prompt" },
  { name: "nikcli auth login", description: "Connect a provider" },
  { name: "nikcli models", description: "List configured models" },
  { name: "nikcli agent list", description: "List configured agents" },
  { name: "nikcli session", description: "Manage sessions" },
  { name: "nikcli upgrade", description: "Self-upgrade" },
  { name: "nikcli --help", description: "Show all CLI commands" },
]

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dimensions = useTerminalDimensions()
  const scrollAcceleration = useScrollAcceleration()

  // Reserve rows for header (2) + footer hint (2) + OK button (2) + outer
  // gaps/padding (~3) so the body never pushes the footer off-screen.
  // Floor at 6 so the columns are at least partially visible; cap so very
  // tall terminals still get a bounded panel.
  const bodyHeight = createMemo(() => Math.max(6, Math.min(22, dimensions().height - 9)))

  onMount(() => {
    // Default dialog width is `medium` = 60 cols, way too narrow for the
    // three columns side by side. Bump to `large` (88) or `xlarge` (116)
    // based on the actual terminal width so the columns fit (or overflow
    // gracefully into horizontal scroll inside the scrollbox).
    dialog.setSize(dimensions().width >= 100 ? "xlarge" : "large")
  })

  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      dialog.clear()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1} flexDirection="column">
      <DialogHeader title="Help" hint="esc/enter to close · ↑↓ scroll" />

      {/* Scrollable body — keeps the footer and OK button anchored on
          screen even when the 31 rows of content don't fit vertically.
          `focused={true}` so ↑↓/PageUp/PageDown/mouse-wheel scroll without
          having to click first. `wrapMode="none"` on each row prevents
          descriptions like "Open configuration" from wrapping mid-line and
          bleeding into the next column's layout. */}
      <scrollbox
        height={bodyHeight()}
        focused={true}
        viewportCulling={true}
        scrollAcceleration={scrollAcceleration()}
        scrollbarOptions={{ visible: true }}
      >
        <box flexDirection="row" gap={3}>
          <box flexDirection="column" gap={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.accent.fg}>
              Shortcuts
            </text>
            <For each={SHORTCUTS}>
              {(item) => (
                <box flexDirection="row" gap={1}>
                  <text fg={theme.accent.alt} wrapMode="none">
                    {keybind.print(item.key)}
                  </text>
                  <text fg={theme.foreground.muted} wrapMode="none">
                    — {item.description}
                  </text>
                </box>
              )}
            </For>
          </box>

          <box flexDirection="column" gap={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.accent.fg}>
              Slash commands
            </text>
            <For each={SLASH_COMMANDS}>
              {(item) => (
                <box flexDirection="row" gap={1}>
                  <text fg={theme.accent.alt} wrapMode="none">
                    {item.name}
                  </text>
                  <text fg={theme.foreground.muted} wrapMode="none">
                    — {item.description}
                  </text>
                </box>
              )}
            </For>
          </box>

          <box flexDirection="column" gap={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.accent.fg}>
              CLI
            </text>
            <For each={CLI_COMMANDS}>
              {(item) => (
                <box flexDirection="row" gap={1}>
                  <text fg={theme.accent.alt} wrapMode="none">
                    {item.name}
                  </text>
                  <text fg={theme.foreground.muted} wrapMode="none">
                    — {item.description}
                  </text>
                </box>
              )}
            </For>
          </box>
        </box>
      </scrollbox>

      <box paddingTop={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.foreground.muted}>
          Need more? See <span style={{ fg: theme.accent.alt }}>https://nikcli-ai.dev/docs</span>
        </text>
        <text fg={theme.foreground.muted}>Press {keybind.print("command_list")} to open the command palette</text>
      </box>

      <box flexDirection="row" justifyContent="flex-end" paddingTop={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.accent.fg} onMouseUp={() => dialog.clear()}>
          <text fg={theme.badge.fg}>OK</text>
        </box>
      </box>
    </box>
  )
}
