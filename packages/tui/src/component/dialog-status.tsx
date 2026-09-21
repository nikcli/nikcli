import { TextAttributes } from "@opentui/core"
import { DialogHeader } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { useSync } from "@tui/context/sync"
import { For, Match, Switch, Show, createMemo } from "solid-js"
import { VERSION } from "@nikcli-ai/util/version"

export type DialogStatusProps = {}

export function DialogStatus() {
  const sync = useSync()
  const { theme } = useTheme()

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))

  const plugins = createMemo(() => {
    const list: Array<string | [string, unknown]> = sync.data.config.plugin ?? []
    const result = list.map((item) => {
      const value = typeof item === "string" ? item : item[0]
      if (value.startsWith("file://")) {
        const path = value.substring("file://".length)
        const parts = path.split("/")
        const filename = parts.pop() || path
        if (!filename.includes(".")) return { name: filename }
        const basename = filename.split(".")[0]
        if (basename === "index") {
          const dirname = parts.pop()
          const name = dirname || basename
          return { name }
        }
        return { name: basename }
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return { name: value, version: "latest" }
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return { name, version }
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <DialogHeader title="Status" />
      <text fg={theme.foreground.muted}>Nikcli v{VERSION}</text>
      <text fg={theme.foreground.muted}>a fork of opencode — github.com/anomalyco/opencode</text>
      <Show
        when={Object.keys(sync.data.mcp).length > 0}
        fallback={<text fg={theme.foreground.default}>No MCP Servers</text>}
      >
        <box>
          <text fg={theme.foreground.default}>{Object.keys(sync.data.mcp).length} MCP Servers</text>
          <For each={Object.entries(sync.data.mcp)}>
            {([key, item]) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: (
                      {
                        connected: theme.status.success.fg,
                        failed: theme.status.error.fg,
                        disabled: theme.foreground.muted,
                        needs_auth: theme.status.warning.fg,
                        needs_client_registration: theme.status.error.fg,
                      } as Record<string, typeof theme.status.success.fg>
                    )[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.foreground.default} wrapMode="word">
                  <b>{key}</b>{" "}
                  <span style={{ fg: theme.foreground.muted }}>
                    <Switch fallback={item.status}>
                      <Match when={item.status === "connected"}>Connected</Match>
                      <Match when={item.status === "failed" && item}>{(val) => val().error}</Match>
                      <Match when={item.status === "disabled"}>Disabled in configuration</Match>
                      <Match when={(item.status as string) === "needs_auth"}>
                        Needs authentication (run: nikcli mcp auth {key})
                      </Match>
                      <Match when={(item.status as string) === "needs_client_registration" && item}>
                        {(val) => (val() as { error: string }).error}
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      {sync.data.lsp.length > 0 && (
        <box>
          <text fg={theme.foreground.default}>{sync.data.lsp.length} LSP Servers</text>
          <For each={sync.data.lsp}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: {
                      connected: theme.status.success.fg,
                      error: theme.status.error.fg,
                    }[item.status],
                  }}
                >
                  •
                </text>
                <text fg={theme.foreground.default} wrapMode="word">
                  <b>{item.id}</b> <span style={{ fg: theme.foreground.muted }}>{item.root}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      )}
      <Show when={enabledFormatters().length > 0} fallback={<text fg={theme.foreground.default}>No Formatters</text>}>
        <box>
          <text fg={theme.foreground.default}>{enabledFormatters().length} Formatters</text>
          <For each={enabledFormatters()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.status.success.fg,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.foreground.default}>
                  <b>{item.name}</b>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={plugins().length > 0} fallback={<text fg={theme.foreground.default}>No Plugins</text>}>
        <box>
          <text fg={theme.foreground.default}>{plugins().length} Plugins</text>
          <For each={plugins()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: theme.status.success.fg,
                  }}
                >
                  •
                </text>
                <text wrapMode="word" fg={theme.foreground.default}>
                  <b>{item.name}</b>
                  {item.version && <span style={{ fg: theme.foreground.muted }}> @{item.version}</span>}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
