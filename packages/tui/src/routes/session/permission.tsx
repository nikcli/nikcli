import { useScrollAcceleration } from "@tui/util/scroll"
import { createStore } from "solid-js/store"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Portal, useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { useTheme, selectedForeground } from "../../context/theme"
import type { PermissionRequest } from "@nikcli-ai/sdk/httpapi"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../component/border"
import { useSync } from "../../context/sync"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import path from "path"
import { LANGUAGE_EXTENSIONS } from "@nikcli-ai/util/language"
import { Keybind } from "@tui/util/keybind"
import { Locale } from "@nikcli-ai/util/locale"
import { Global } from "@nikcli-ai/util/global"
import { formatPath } from "@tui/util/path-format"

type PermissionStage = "permission" | "always" | "reject"

/** Display spelling for a path in this prompt. See `util/path-format`. */
function normalizePath(input?: string) {
  return formatPath(input, { base: process.cwd(), home: Global.Path.home })
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function EditBody(props: { request: PermissionRequest; label?: string }) {
  const themeState = useTheme()
  const scrollAcceleration = useScrollAcceleration()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const sync = useSync()
  const dimensions = useTerminalDimensions()

  // The tools send `Snapshot.FileDiff` entries (`file` + `patch`); the
  // `filePath` + `diff` spelling is kept for requests built elsewhere.
  const files = createMemo(() =>
    (
      (props.request.metadata?.files as Array<{
        file?: string
        patch?: string
        filePath?: string
        diff?: string
      }>) ?? []
    ).map((entry) => ({ filePath: entry.file ?? entry.filePath ?? "", diff: entry.patch ?? entry.diff ?? "" })),
  )
  const singleFile = createMemo(() => (props.request.metadata?.filepath as string) ?? "")
  const singleDiff = createMemo(() => (props.request.metadata?.diff as string) ?? "")

  const filepath = createMemo(() => {
    if (files().length > 0) return files()[0]?.filePath ?? ""
    return singleFile()
  })

  const diff = createMemo(() => {
    if (files().length > 0) return files()[0]?.diff ?? ""
    return singleDiff()
  })

  const view = createMemo(() => {
    const diffStyle = sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filepath()))

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <text fg={theme.foreground.muted}>{"→"}</text>
        <text fg={theme.foreground.muted}>{props.label ?? `Edit ${normalizePath(filepath())}`}</text>
        <Show when={files().length > 1}>
          <text fg={theme.foreground.muted}>(+{files().length - 1} more)</text>
        </Show>
      </box>
      <Show when={diff()}>
        <scrollbox scrollAcceleration={scrollAcceleration()} height="100%">
          <Switch>
            <Match when={diff()}>
              <diff
                diff={diff()}
                view={view()}
                filetype={ft()}
                syntaxStyle={syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode="word"
                fg={theme.foreground.default}
                addedBg={theme.diff.addedBg}
                removedBg={theme.diff.removedBg}
                contextBg={theme.diff.contextBg}
                addedSignColor={theme.diff.highlightAdded}
                removedSignColor={theme.diff.highlightRemoved}
                lineNumberFg={theme.diff.lineNumber}
                lineNumberBg={theme.diff.contextBg}
                addedLineNumberBg={theme.diff.addedLineNumberBg}
                removedLineNumberBg={theme.diff.removedLineNumberBg}
              />
            </Match>
          </Switch>
        </scrollbox>
      </Show>
    </box>
  )
}

function TextBody(props: { title: string; description?: string; icon?: string }) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <Show when={props.icon}>
          <text fg={theme.foreground.muted} flexShrink={0}>
            {props.icon}
          </text>
        </Show>
        <text fg={theme.foreground.muted}>{props.title}</text>
      </box>
      <Show when={props.description}>
        <box paddingLeft={1}>
          <text fg={theme.foreground.default}>{props.description}</text>
        </box>
      </Show>
    </>
  )
}

/**
 * Auto mode hands a decision back to the user after repeated blocks; the
 * prompt says so, with the rule that blocked it, instead of a generic title.
 */
function autoModeTitle(metadata: PermissionRequest["metadata"] | undefined) {
  const auto = metadata?.["auto_mode"] as { rule?: string; reason?: string } | undefined
  if (!auto) return undefined
  return `Auto mode paused after repeated blocks · [${auto.rule ?? "Blocked"}] ${auto.reason ?? ""}`.trim()
}

export function PermissionPrompt(props: { request: PermissionRequest }) {
  const sdk = useSDK()
  const sync = useSync()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
  })

  const session = createMemo(() => sync.data.session.find((s) => s.id === props.request.sessionID))

  const input = createMemo(() => {
    const tool = props.request.tool
    if (!tool) return {}
    const parts = sync.data.part[tool.messageID] ?? []
    for (const part of parts) {
      if (part.type === "tool" && part.callID === tool.callID && part.state.status !== "pending") {
        return part.state.input ?? {}
      }
    }
    return {}
  })

  const { theme } = useTheme()

  return (
    <Switch>
      <Match when={store.stage === "always"}>
        <Prompt
          title="Always allow"
          body={
            <Switch>
              <Match when={props.request.always.length === 1 && props.request.always[0] === "*"}>
                <TextBody title={"This will allow " + props.request.permission + " until Nikcli is restarted."} />
              </Match>
              <Match when={true}>
                <box paddingLeft={1} gap={1}>
                  <text fg={theme.foreground.muted}>
                    This will allow the following patterns until Nikcli is restarted
                  </text>
                  <box>
                    <For each={props.request.always}>
                      {(pattern) => (
                        <text fg={theme.foreground.default}>
                          {"- "}
                          {pattern}
                        </text>
                      )}
                    </For>
                  </box>
                </box>
              </Match>
            </Switch>
          }
          options={{ confirm: "Confirm", cancel: "Cancel" }}
          escapeKey="cancel"
          onSelect={(option) => {
            setStore("stage", "permission")
            if (option === "cancel") return
            sdk.client.permission.reply({
              reply: "always",
              requestID: props.request.id,
              workspace: session()?.workspaceID,
            })
          }}
        />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          onConfirm={(message) => {
            sdk.client.permission.reply({
              reply: "reject",
              requestID: props.request.id,
              message: message || undefined,
              workspace: session()?.workspaceID,
            })
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        {(() => {
          const body = (
            <Prompt
              title={autoModeTitle(props.request.metadata) ?? "Permission required"}
              body={
                <Switch>
                  <Match when={props.request.permission === "edit"}>
                    <EditBody request={props.request} />
                  </Match>
                  <Match when={props.request.permission === "read"}>
                    <TextBody icon="→" title={`Read ` + normalizePath(input().filePath as string)} />
                  </Match>
                  <Match when={props.request.permission === "glob"}>
                    <TextBody icon="✱" title={`Glob "` + (input().pattern ?? "") + `"`} />
                  </Match>
                  <Match when={props.request.permission === "grep"}>
                    <TextBody icon="✱" title={`Grep "` + (input().pattern ?? "") + `"`} />
                  </Match>
                  <Match when={props.request.permission === "list"}>
                    <TextBody icon="→" title={`List ` + normalizePath(input().path as string)} />
                  </Match>
                  <Match when={props.request.permission === "bash"}>
                    <TextBody
                      icon="#"
                      title={(input().description as string) ?? ""}
                      description={("$ " + input().command) as string}
                    />
                  </Match>
                  <Match when={props.request.permission === "task"}>
                    <TextBody
                      icon="#"
                      title={`${Locale.titlecase((input().subagent_type as string) ?? "Unknown")} Task`}
                      description={"◉ " + input().description}
                    />
                  </Match>
                  <Match when={props.request.permission === "webfetch"}>
                    <TextBody icon="%" title={`WebFetch ` + (input().url ?? "")} />
                  </Match>
                  <Match when={props.request.permission === "websearch"}>
                    <TextBody icon="◈" title={`Exa Web Search "` + (input().query ?? "") + `"`} />
                  </Match>
                  <Match when={props.request.permission === "codesearch"}>
                    <TextBody icon="◇" title={`Exa Code Search "` + (input().query ?? "") + `"`} />
                  </Match>
                  <Match when={props.request.permission === "external_directory"}>
                    {(() => {
                      const meta = props.request.metadata ?? {}
                      const parent = typeof meta["parentDir"] === "string" ? meta["parentDir"] : undefined
                      const filepath = typeof meta["filepath"] === "string" ? meta["filepath"] : undefined
                      const pattern = props.request.patterns?.[0]
                      const derived =
                        typeof pattern === "string"
                          ? pattern.includes("*")
                            ? path.dirname(pattern)
                            : pattern
                          : undefined

                      const raw = parent ?? filepath ?? derived
                      const dir = normalizePath(raw)

                      return <TextBody icon="←" title={`Access external directory ` + dir} />
                    })()}
                  </Match>
                  <Match when={props.request.permission === "plugin"}>
                    {(() => {
                      // The code is what the user is approving: once written, nikcli
                      // loads it in-process. Show it as a diff, not as a tool name.
                      const meta = props.request.metadata ?? {}
                      const action = typeof meta["action"] === "string" ? meta["action"] : "create"
                      const name = typeof meta["name"] === "string" ? meta["name"] : (props.request.patterns?.[0] ?? "")
                      const scope = typeof meta["scope"] === "string" ? meta["scope"] : "global"
                      const folder = typeof meta["folder"] === "string" ? normalizePath(meta["folder"]) : ""
                      if (action === "remove") {
                        return <TextBody icon="✕" title={`Remove plugin ${name} (${scope})`} description={folder} />
                      }
                      const deps = Object.keys((meta["dependencies"] as Record<string, string> | undefined) ?? {})
                      const label =
                        `${Locale.titlecase(action)} plugin ${name} (${scope})` +
                        (deps.length > 0 ? ` · installs ${deps.join(", ")}` : "")
                      return <EditBody request={props.request} label={label} />
                    })()}
                  </Match>
                  <Match when={props.request.permission === "doom_loop"}>
                    <TextBody icon="⟳" title="Continue after repeated failures" />
                  </Match>
                  <Match when={true}>
                    <TextBody icon="⚙" title={`Call tool ` + props.request.permission} />
                  </Match>
                </Switch>
              }
              options={{ once: "Allow once", always: "Allow always", reject: "Reject" }}
              escapeKey="reject"
              fullscreen
              onSelect={(option) => {
                if (option === "always") {
                  setStore("stage", "always")
                  return
                }
                if (option === "reject") {
                  if (session()?.parentID) {
                    setStore("stage", "reject")
                    return
                  }
                  sdk.client.permission.reply({
                    reply: "reject",
                    requestID: props.request.id,
                    workspace: session()?.workspaceID,
                  })
                  return
                }
                sdk.client.permission.reply({
                  reply: "once",
                  requestID: props.request.id,
                  workspace: session()?.workspaceID,
                })
              }}
            />
          )

          return body
        })()}
      </Match>
    </Switch>
  )
}

function RejectPrompt(props: { onConfirm: (message: string) => void; onCancel: () => void }) {
  let input: TextareaRenderable
  const { theme } = useTheme()
  const keybind = useKeybind()
  const textareaKeybindings = useTextareaKeybindings()
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)

  useKeyboard((evt) => {
    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      props.onCancel()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      props.onConfirm(input.plainText)
    }
  })

  return (
    <box
      backgroundColor={theme.surface.panel}
      border={["left"]}
      borderColor={theme.status.error.fg}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.status.error.fg}>{"△"}</text>
          <text fg={theme.foreground.default}>Reject permission</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.foreground.muted}>Tell Nikcli what to do differently</text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.surface.offset}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <textarea
          ref={(val: TextareaRenderable) => (input = val)}
          focused
          textColor={theme.foreground.default}
          focusedTextColor={theme.foreground.default}
          cursorColor={theme.accent.fg}
          keyBindings={textareaKeybindings()}
        />
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.foreground.default}>
            enter <span style={{ fg: theme.foreground.muted }}>confirm</span>
          </text>
          <text fg={theme.foreground.default}>
            esc <span style={{ fg: theme.foreground.muted }}>cancel</span>
          </text>
        </box>
      </box>
    </box>
  )
}

function Prompt<const T extends Record<string, string>>(props: {
  title: string
  body: JSX.Element
  options: T
  escapeKey?: keyof T
  fullscreen?: boolean
  onSelect: (option: keyof T) => void
}) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dimensions = useTerminalDimensions()
  const keys = Object.keys(props.options) as (keyof T)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const diffKey = Keybind.parse("ctrl+f")[0]
  const narrow = createMemo(() => dimensions().width < 80)

  useKeyboard((evt) => {
    if (evt.name === "left" || evt.name == "h") {
      evt.preventDefault()
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx - 1 + keys.length) % keys.length]
      setStore("selected", next)
    }

    if (evt.name === "right" || evt.name == "l") {
      evt.preventDefault()
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx + 1) % keys.length]
      setStore("selected", next)
    }

    if (evt.name === "return") {
      evt.preventDefault()
      props.onSelect(store.selected)
    }

    if (props.escapeKey && (evt.name === "escape" || keybind.match("app_exit", evt))) {
      evt.preventDefault()
      props.onSelect(props.escapeKey)
    }

    if (props.fullscreen && diffKey && Keybind.match(diffKey, keybind.parse(evt))) {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("expanded", (v) => !v)
    }
  })

  const hint = createMemo(() => (store.expanded ? "minimize" : "fullscreen"))
  const renderer = useRenderer()

  const content = () => (
    <box
      backgroundColor={theme.surface.panel}
      border={["left"]}
      borderColor={theme.status.warning.fg}
      customBorderChars={SplitBorder.customBorderChars}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
          <text fg={theme.status.warning.fg}>{"△"}</text>
          <text fg={theme.foreground.default}>{props.title}</text>
        </box>
        {props.body}
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.surface.offset}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={keys}>
            {(option) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={option === store.selected ? theme.status.warning.fg : theme.surface.overlay}
                onMouseOver={() => setStore("selected", option)}
                onMouseUp={() => {
                  setStore("selected", option)
                  props.onSelect(option)
                }}
              >
                <text
                  fg={
                    option === store.selected
                      ? selectedForeground(theme, theme.status.warning.fg)
                      : theme.foreground.muted
                  }
                >
                  {props.options[option]}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={props.fullscreen}>
            <text fg={theme.foreground.default}>
              {"ctrl+f"} <span style={{ fg: theme.foreground.muted }}>{hint()}</span>
            </text>
          </Show>
          <text fg={theme.foreground.default}>
            {"⇆"} <span style={{ fg: theme.foreground.muted }}>select</span>
          </text>
          <text fg={theme.foreground.default}>
            enter <span style={{ fg: theme.foreground.muted }}>confirm</span>
          </text>
        </box>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
