import { TextareaRenderable } from "@opentui/core"
import { useTheme } from "../context/theme"
import { DialogHeader, useDialog, type DialogContext } from "./dialog"
import { useKeybind } from "@tui/context/keybind"
import { onMount, Show, type JSX } from "solid-js"
import { Spinner } from "../component/spinner"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  /** When true, Enter submits even if the field is blank. Needed for "clear this value". */
  allowEmpty?: boolean
  onConfirm?: (value: string) => void
  onCancel?: () => void
  /**
   * Re-opens the dialog this one was opened from, drawing `←` beside `esc`.
   *
   * Dialogs here do not stack — a nested flow replaces its parent, which
   * `specs/effect-tui/03-tui-lifecycle.md` records as load-bearing — so going
   * back is the caller handing over a closure that opens the parent again.
   * Several callers already keep one; this is what makes it visible.
   */
  back?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  let textarea: TextareaRenderable

  const submitKey = () => keybind.print("input_submit") || "enter"

  onMount(() => {
    dialog.setSize("medium")
    if (!textarea || textarea.isDestroyed) return
    textarea.gotoLineEnd()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <DialogHeader title={props.title} muted={props.busy} hint={props.busy ? "" : "esc"} back={props.back} />
      <box gap={1}>
        {props.description?.()}
        <Show
          when={!props.busy}
          fallback={
            <box height={3} flexDirection="row" alignItems="center" gap={1}>
              <Spinner>{props.busyText ?? "Processing…"}</Spinner>
            </box>
          }
        >
          <textarea
            onSubmit={() => {
              const val = textarea.plainText.trim()
              if (!val && !props.allowEmpty) {
                return
              }
              props.onConfirm?.(val)
            }}
            onKeyPress={(evt) => {
              if (props.busy) {
                evt.preventDefault()
                evt.stopPropagation()
              }
            }}
            height={3}
            focused={!props.busy}
            keyBindings={[{ name: "return", action: "submit" }]}
            ref={(val: TextareaRenderable) => (textarea = val)}
            initialValue={props.value}
            placeholder={props.placeholder ?? "Enter text"}
            textColor={theme.foreground.default}
            focusedTextColor={theme.foreground.default}
            cursorColor={theme.foreground.default}
          />
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={theme.foreground.muted}>Please wait…</text>}>
          <text fg={theme.foreground.default}>
            <span style={{ fg: theme.accent.fg }}>{submitKey()}</span>{" "}
            <span style={{ fg: theme.foreground.muted }}>submit</span>
          </text>
        </Show>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
