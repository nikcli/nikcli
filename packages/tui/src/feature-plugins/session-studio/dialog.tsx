import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onMount } from "solid-js"
import { useKV } from "../../context/kv"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import {
  DEFAULT_SESSION_STYLE,
  readSessionStyle,
  resolveSessionStyle,
  writeSessionStyle,
  type SessionStyleKV,
  type SessionStyleRecipe,
  type SessionStyleScope,
  type SessionStyleTheme,
} from "./settings"

const fields = [
  { key: "density", label: "Density", options: ["regular", "compact"] },
  {
    key: "userSurface",
    label: "User surface",
    options: ["panel", "accent", "base"],
  },
  {
    key: "promptSurface",
    label: "Prompt surface",
    options: ["panel", "offset", "base"],
  },
  { key: "border", label: "Border", options: ["subtle", "accent", "none"] },
] as const

export function SessionStudioDialog(props: { sessionID?: string }) {
  const kv = useKV()
  const { theme } = useTheme()
  const dialog = useDialog()
  onMount(() => dialog.setSize("full"))
  return <SessionStudioEditor kv={kv} theme={theme} sessionID={props.sessionID} onClose={() => dialog.clear()} />
}

export function SessionStudioEditor(props: {
  kv: SessionStyleKV & { readonly ready: boolean }
  theme: SessionStyleTheme
  sessionID?: string
  onClose: () => void
}) {
  const kv = props.kv
  const dimensions = useTerminalDimensions()
  const [draft, setDraft] = createSignal(readSessionStyle(kv, props.sessionID))
  const [selected, setSelected] = createSignal(0)
  const [inherit, setInherit] = createSignal(false)
  const [error, setError] = createSignal("")
  const style = createMemo(() => resolveSessionStyle(props.theme, draft()))
  const [initialized, setInitialized] = createSignal(kv.ready)
  createEffect(() => {
    if (initialized() || !kv.ready) return
    setDraft(readSessionStyle(kv, props.sessionID))
    setInitialized(true)
  })

  function change(index: number, direction = 1) {
    if (!kv.ready) return
    const field = fields[index]
    if (!field) return
    const options: readonly string[] = field.options
    const next = options[(options.indexOf(draft()[field.key]) + direction + options.length) % options.length]
    setDraft((value) => ({ ...value, [field.key]: next }) as SessionStyleRecipe)
    setInherit(false)
    setError("")
  }

  function reset() {
    if (!kv.ready) return
    setDraft(props.sessionID ? readSessionStyle(kv) : { ...DEFAULT_SESSION_STYLE })
    setInherit(true)
    setError("")
  }

  function apply(scope: SessionStyleScope) {
    if (!kv.ready) {
      setError("Settings are still loading. Try again when ready.")
      return
    }
    try {
      // Inherit removes only the selected target; applying globally from a
      // session copies its draft without silently removing that session override.
      const resetTarget = inherit() && (scope !== "global" || !props.sessionID)
      writeSessionStyle(kv, scope, resetTarget ? null : draft())
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save session style")
    }
  }

  const actions = () => [
    { label: "Apply global [g]", run: () => apply("global") },
    ...(props.sessionID
      ? [
          {
            label: "Apply session [s]",
            run: () => apply({ sessionID: props.sessionID! }),
          },
        ]
      : []),
    {
      label: props.sessionID ? "Inherit global [r]" : "Reset defaults [r]",
      run: reset,
    },
    { label: "Cancel [esc]", run: props.onClose },
  ]

  useKeyboard((event) => {
    if (event.defaultPrevented || event.ctrl || event.meta) return
    const count = fields.length + actions().length
    if (event.name === "escape") props.onClose()
    else if (event.name === "tab" || event.name === "down" || event.name === "up") {
      const delta = event.name === "up" || (event.name === "tab" && event.shift) ? -1 : 1
      setSelected((value) => (value + delta + count) % count)
    } else if (event.name === "left" || event.name === "right") {
      change(selected(), event.name === "left" ? -1 : 1)
    } else if (event.name === "return" || event.name === "space") {
      if (selected() < fields.length) change(selected())
      else actions()[selected() - fields.length]?.run()
    } else if (event.name === "g") apply("global")
    else if (event.name === "s" && props.sessionID) apply({ sessionID: props.sessionID })
    else if (event.name === "r") reset()
    else return
    event.preventDefault()
    event.stopPropagation()
  })

  return (
    <box height={Math.max(1, dimensions().height - 8)} gap={1}>
      <text fg={props.theme.foreground.default}>
        <b>Session studio</b> / Draft editor
      </text>
      <scrollbox flexGrow={1} minHeight={1}>
        <box gap={1}>
          <text fg={props.theme.foreground.muted}>
            {props.sessionID
              ? "Editing this session. Global applies to sessions without overrides."
              : "Editing the global default for sessions without overrides."}
          </text>
          <box flexDirection={dimensions().width >= 100 ? "row" : "column"} gap={2}>
            <box flexGrow={1} minWidth={24} gap={1}>
              <text fg={props.theme.accent.fg}>
                <b>Presentation</b>
              </text>
              <For each={fields}>
                {(field, index) => (
                  <box
                    backgroundColor={selected() === index() ? props.theme.accent.bg : props.theme.surface.panel}
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseUp={(event) => {
                      event.stopPropagation()
                      setSelected(index())
                      change(index())
                    }}
                  >
                    <text fg={props.theme.foreground.default}>
                      {selected() === index() ? "> " : "  "}
                      {field.label}: {draft()[field.key]}
                    </text>
                    <text fg={props.theme.foreground.muted}>{field.options.join(" / ")}</text>
                  </box>
                )}
              </For>
              <text fg={props.theme.foreground.muted}>
                {inherit()
                  ? "Reset staged. Apply to save; cancel to discard."
                  : "Unsaved draft. Changes appear in the sample only."}
              </text>
            </box>
            <box flexGrow={2} minWidth={24} gap={1}>
              <text fg={props.theme.accent.fg}>
                <b>Sample preview / current theme</b>
              </text>
              <box backgroundColor={props.theme.surface.base} padding={1} gap={style().messageGap}>
                <box
                  backgroundColor={style().user.backgroundColor}
                  border={style().user.border ? ["left"] : false}
                  borderColor={style().borderColor}
                  paddingLeft={style().user.paddingX}
                  paddingRight={style().user.paddingX}
                  paddingTop={style().user.paddingY}
                  paddingBottom={style().user.paddingY}
                >
                  <text fg={style().user.foreground}>You: Make this session easier to read.</text>
                </box>
                <box
                  paddingLeft={style().assistant.paddingX}
                  paddingTop={style().assistant.paddingY}
                  paddingBottom={style().assistant.paddingY}
                >
                  <text fg={style().assistant.foreground}>Assistant: Spacing and surfaces follow your theme.</text>
                  <text fg={props.theme.status.success.fg}>Sample tool result: 3 checks passed</text>
                </box>
                <box
                  backgroundColor={style().prompt.backgroundColor}
                  border={style().prompt.border ? ["left"] : false}
                  borderColor={style().borderColor}
                  paddingLeft={style().prompt.paddingX}
                  paddingRight={style().prompt.paddingX}
                  paddingTop={style().prompt.paddingY}
                  paddingBottom={style().prompt.paddingY}
                >
                  <text fg={style().prompt.foreground}>Ask a follow-up...</text>
                </box>
              </box>
              <text fg={props.theme.foreground.muted}>
                Static sample. No messages sent, tools run, or session mounted.
              </text>
            </box>
          </box>
        </box>
      </scrollbox>
      <text fg={error() ? props.theme.status.error.fg : props.theme.foreground.muted}>
        {error() ||
          (!kv.ready ? "Loading saved settings..." : "Tab/up/down: focus | left/right: change | enter: activate")}
      </text>
      <box flexDirection="row" flexWrap="wrap" gap={2} flexShrink={0}>
        <For each={actions()}>
          {(action, index) => (
            <text
              fg={selected() === fields.length + index() ? props.theme.accent.fg : props.theme.foreground.default}
              onMouseUp={(event) => {
                event.stopPropagation()
                action.run()
              }}
            >
              {selected() === fields.length + index() ? "> " : ""}
              {action.label}
            </text>
          )}
        </For>
      </box>
    </box>
  )
}
