import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onMount } from "solid-js"
import { useKV } from "../../context/kv"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import {
  DEFAULT_SESSION_STYLE,
  readSessionStyle,
  recipeToPatches,
  writeSessionStyle,
  type SessionStyleKV,
  type SessionStyleRecipe,
  type SessionStyleScope,
} from "../../context/session-style"
import type { ComponentPatchMap, ResolvedComponents } from "../../context/component-tokens"
import { borderCharsFor } from "../../component/border"
import type { Theme } from "../../context/theme"

/** The slice of the theme the dialog's own chrome paints with. */
export type SessionStyleTheme = Pick<Theme, "surface" | "foreground" | "accent" | "border" | "status">

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
  {
    key: "emphasis",
    label: "Text",
    options: ["regular", "quiet", "strong"],
  },
] as const

export function SessionStudioDialog(props: { sessionID?: string }) {
  const kv = useKV()
  const { theme, previewComponents } = useTheme()
  const dialog = useDialog()
  onMount(() => dialog.setSize("full"))
  return (
    <SessionStudioEditor
      kv={kv}
      theme={theme}
      preview={previewComponents}
      sessionID={props.sessionID}
      onClose={() => dialog.clear()}
    />
  )
}

export function SessionStudioEditor(props: {
  kv: SessionStyleKV & { readonly ready: boolean }
  theme: SessionStyleTheme
  /** Resolves the catalog with the draft layered on, through the live pipeline. */
  preview: (patches: ComponentPatchMap) => ResolvedComponents
  sessionID?: string
  onClose: () => void
}) {
  const kv = props.kv
  const dimensions = useTerminalDimensions()
  const [draft, setDraft] = createSignal(readSessionStyle(kv, props.sessionID))
  const [selected, setSelected] = createSignal(0)
  const [inherit, setInherit] = createSignal(false)
  const [error, setError] = createSignal("")
  /**
   * The sample is rendered from the same resolution the session would get, not
   * from a preview-only translation of the draft. A separate one would be a
   * second implementation of the recipe and would disagree with the real thing
   * exactly when it mattered — the first time a theme overrode one of these
   * fields itself.
   */
  const styles = createMemo(() => props.preview(recipeToPatches(draft())).styles)
  const user = createMemo(() => styles()["session.user-message"])
  const assistant = createMemo(() => styles()["session.text-part"])
  const prompt = createMemo(() => styles()["session.prompt"])
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
              <text fg={props.theme.foreground.muted} wrapMode="word">
                Text sets weight and dimming. The typeface is your terminal's.
              </text>
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
              <box backgroundColor={props.theme.surface.base} padding={1} gap={user().box.marginTop}>
                <box
                  backgroundColor={user().colors.background}
                  border={[...user().box.borderSides]}
                  customBorderChars={borderCharsFor(user().box.borderCharset)}
                  // The real message paints this edge with the agent's color,
                  // which a static sample has no agent to ask for. The accent
                  // stands in for it; everything else here is the real value.
                  borderColor={props.theme.accent.fg}
                  paddingLeft={user().box.paddingLeft}
                  paddingRight={user().box.paddingRight}
                  paddingTop={user().box.paddingTop}
                  paddingBottom={user().box.paddingBottom}
                >
                  <text fg={user().colors.text}>You: Make this session easier to read.</text>
                </box>
                <box paddingLeft={assistant().box.paddingLeft} marginTop={assistant().box.marginTop}>
                  <text fg={assistant().colors.text}>Assistant: Spacing and surfaces follow your theme.</text>
                  <text fg={props.theme.status.success.fg}>Sample tool result: 3 checks passed</text>
                </box>
                <box
                  backgroundColor={prompt().colors.background}
                  border={[...prompt().box.borderSides]}
                  customBorderChars={borderCharsFor(prompt().box.borderCharset)}
                  borderColor={props.theme.accent.fg}
                  paddingLeft={prompt().box.paddingLeft}
                  paddingRight={prompt().box.paddingRight}
                  paddingTop={prompt().box.paddingTop}
                  paddingBottom={prompt().box.paddingBottom}
                >
                  <text fg={props.theme.foreground.default}>Ask a follow-up...</text>
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
