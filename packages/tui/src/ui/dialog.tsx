import { useKeyboard, useRenderer, useTerminalDimensions, useTimeline } from "@opentui/solid"
import {
  batch,
  createContext,
  createSignal,
  onCleanup,
  onMount,
  Show,
  useContext,
  type JSX,
  type ParentProps,
} from "solid-js"
import { useTheme } from "@tui/context/theme"
import { Renderable, RGBA, TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { Clipboard } from "@tui/util/clipboard"
import { scheduleOverlayRepaint } from "@tui/util/repaint"
import { useToast } from "./toast"

/**
 * Gap convention for dialog layouts:
 * - Container gap: 2 (between major sections)
 * - List rows gap: 1 (between items)
 * - Button spacing: gap=2 for grouped buttons
 */
export type DialogSize = "small" | "medium" | "large" | "xlarge" | "full"
type DialogElement = JSX.Element | (() => JSX.Element)
type DialogEntry = {
  element: DialogElement
  onClose?: () => void
}

export function Dialog(
  props: ParentProps<{
    size?: DialogSize
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const timeline = useTimeline()

  const [opacity, setOpacity] = createSignal(0)

  onMount(() => {
    timeline.add(
      { opacity: 0 },
      { opacity: 1, duration: 150, ease: "outQuad", onUpdate: (a) => setOpacity(a.targets[0].opacity) },
    )
    // Opening a dialog is the largest frame the app draws: backdrop, panel and
    // content all change at once. That is the frame Windows consoles truncate,
    // and the cells that get lost keep showing the view *behind* the dialog —
    // permanently, because the renderer only writes what changed. Repaint once
    // the fade has settled so the panel covers what it is supposed to cover.
    onCleanup(scheduleOverlayRepaint(renderer, 200))
  })

  const width = () => {
    const dims = dimensions()
    // `full` is for dialogs whose *content* is the window — the browser
    // surface, where every column is a pixel of horizontal resolution and a
    // 120-column cap is a cap on how much page you can see.
    if (props.size === "full") return Math.max(1, dims.width - 4)
    if (props.size === "xlarge") return Math.min(120, Math.max(1, dims.width - 8))
    if (props.size === "large") return Math.min(88, Math.max(1, dims.width - 6))
    if (props.size === "small") return Math.min(42, Math.max(1, dims.width - 4))
    return Math.min(60, Math.max(1, dims.width - 4))
  }

  // Backdrop click-to-dismiss must not fire for a press that started on the
  // panel (the WebView button, the page, …). A live `full` dialog also paints
  // Sixel past the panel edge — those clicks look like backdrop hits.
  let pressOnBackdrop = false

  return (
    <box
      onMouseDown={() => {
        pressOnBackdrop = true
      }}
      onMouseUp={async () => {
        const dismiss = pressOnBackdrop
        pressOnBackdrop = false
        if (props.size === "full") return
        if (!dismiss) return
        if (renderer.getSelection()) return
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      justifyContent="center"
      position="absolute"
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, Math.round(150 * opacity()))}
    >
      <box
        onMouseDown={() => {
          pressOnBackdrop = false
        }}
        onMouseUp={async (e) => {
          pressOnBackdrop = false
          if (renderer.getSelection()) return
          e.stopPropagation()
        }}
        width={width()}
        maxWidth={Math.max(1, dimensions().width - 4)}
        // A dialog taller than the terminal does not scroll: it draws past the
        // last row, and the rows that fall off are the ones with the buttons.
        // Two rows of breathing room top and bottom keeps the frame visible on
        // an 80x24 terminal, which is the floor we support.
        maxHeight={Math.max(1, dimensions().height - 4)}
        backgroundColor={theme.surface.overlay}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        {props.children}
      </box>
    </box>
  )
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as DialogEntry[],
    size: "medium" as DialogSize,
  })

  function closeCallbacks() {
    return store.stack.map((item) => item.onClose).filter((callback): callback is () => void => Boolean(callback))
  }

  function runCloseCallbacks(callbacks: (() => void)[]) {
    for (const callback of callbacks) {
      callback()
    }
  }

  function closeTop() {
    const current = store.stack.at(-1)
    if (!current) return
    const next = store.stack.slice(0, -1)
    batch(() => {
      if (next.length === 0) setStore("size", "medium")
      setStore("stack", next)
    })
    current.onClose?.()
    refocus()
  }

  const renderer = useRenderer()

  useKeyboard((evt) => {
    // Escape closes only the top dialog
    if (evt.name === "escape" && store.stack.length > 0) {
      closeTop()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    // Ctrl+C closes entire stack if in non-interactive top-level dialog
    // (e.g., alert, confirm), otherwise propagate to interrupt AI response
    if (evt.ctrl && evt.name === "c") {
      if (store.stack.length > 0) {
        // Is a text editor focused inside the dialog? Ask the renderer.
        //
        // This used to stringify the stack entry and look for "textarea" in the
        // result, then check `document.activeElement`. Neither clause worked.
        //
        // The entry is the wrapper arrow (`() => <DialogFoo />`), whose source
        // never mentions what the component renders, so the `includes` test was
        // false for every dialog in the tree — and it is the clause that
        // decided the outcome.
        //
        // The DOM probe was inert rather than fatal. Under the CLI host
        // `nikcli/src/util/document-shim` defines a `document` carrying only
        // `createElement`, so `document.activeElement?.tagName` is `undefined`
        // and the comparison is always true; in the standalone host, where no
        // shim is loaded, it would have thrown — but only if the first clause
        // had ever matched, which it could not.
        //
        // Net effect either way: `isInteractive` was always false and Ctrl+C
        // cleared the whole stack, including the dialogs this branch exists to
        // protect.
        //
        // `currentFocusedEditor` is non-null exactly when an EditBuffer has
        // focus, and `TextareaRenderable` extends it.
        const isInteractive = renderer.currentFocusedEditor !== null

        if (!isInteractive) {
          // Clear entire stack for non-interactive dialogs
          const callbacks = closeCallbacks()
          batch(() => {
            setStore("size", "medium")
            setStore("stack", [])
          })
          runCloseCallbacks(callbacks)
          evt.preventDefault()
          evt.stopPropagation()
        }
        // Otherwise, let the event propagate (e.g., to interrupt AI)
      }
    }
  })

  let focus: Renderable | null
  let refocusTimer: ReturnType<typeof setTimeout> | undefined
  let reclaimTimer: ReturnType<typeof setTimeout> | undefined
  /** Bumped by every stack change, so an in-flight restore knows it is stale. */
  let refocusGeneration = 0

  /**
   * Both halves of the restore are cancellable.
   *
   * The 30ms reclaim used to run untracked: opening a new dialog inside that
   * window (a `replace` from an OAuth callback, a command that chains dialogs)
   * left a pending timer that then focused the composer *underneath* the dialog
   * that had just opened — the keystrokes went to the prompt, not the modal.
   */
  function cancelRefocus() {
    refocusGeneration++
    if (refocusTimer) clearTimeout(refocusTimer)
    if (reclaimTimer) clearTimeout(reclaimTimer)
    refocusTimer = undefined
    reclaimTimer = undefined
  }

  onCleanup(cancelRefocus)

  function refocus() {
    cancelRefocus()
    const generation = refocusGeneration
    // A restore is only correct while the stack stayed empty: anything still on
    // it owns the keyboard.
    const stale = () => generation !== refocusGeneration || store.stack.length > 0
    refocusTimer = setTimeout(() => {
      refocusTimer = undefined
      if (stale()) return
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
      // Second pass: some dialogs unmount asynchronously; reclaim once more.
      reclaimTimer = setTimeout(() => {
        reclaimTimer = undefined
        if (stale()) return
        if (!focus || focus.isDestroyed) return
        if (!focus.focused) focus.focus()
      }, 30)
    }, 1)
  }

  return {
    clear() {
      // Collect onClose callbacks BEFORE updating store to avoid recursion
      const callbacks = closeCallbacks()
      batch(() => {
        setStore("size", "medium")
        setStore("stack", [])
      })
      // Call onClose callbacks AFTER store update to prevent recursive loops
      runCloseCallbacks(callbacks)
      refocus()
    },
    replace(input: DialogElement, onClose?: () => void) {
      // Collect onClose callbacks BEFORE updating store to avoid recursion
      const callbacks = closeCallbacks()
      // A restore queued by the dialog this one replaces must not land later.
      cancelRefocus()
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      batch(() => {
        setStore("size", "medium")
        setStore("stack", [
          {
            element: input,
            onClose,
          },
        ])
      })
      // Call onClose callbacks AFTER store update to prevent recursive loops
      runCloseCallbacks(callbacks)
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    setSize(size: DialogSize) {
      setStore("size", size)
    },
  }
}

function DialogContent(props: { entry: DialogEntry }) {
  return <>{typeof props.entry.element === "function" ? props.entry.element() : props.entry.element}</>
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        onMouseUp={async () => {
          const text = renderer.getSelection()?.getSelectedText()
          if (text && text.length > 0) {
            await Clipboard.copy(text)
              .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
              .catch(toast.error)
            renderer.clearSelection()
          }
        }}
      >
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.clear()} size={value.size}>
            <DialogContent entry={value.stack.at(-1)!} />
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}

/**
 * Title row shared by alert / confirm / prompt / select / help.
 *
 * The hint doubles as the close button: every dialog that hand-rolled this row
 * hung `dialog.clear()` off it, and a header that only *reads* "esc" takes that
 * affordance away from anyone driving the TUI with a mouse. Pass `hint=""` for
 * a dialog that must not be dismissed from the header — a prompt mid-submit,
 * say — and the handler goes away with the text.
 */
/**
 * The mark for "there is a screen behind this one".
 *
 * Deliberately *not* wired to escape, and deliberately not a stack. Dialogs here
 * do not nest: `replace` sets a one-entry stack and a nested flow unmounts its
 * parent, which `specs/effect-tui/03-tui-lifecycle.md` records as load-bearing —
 * every dialog's lifecycle guards assume it, and misreading it cost two reverts.
 * Going back is therefore a dialog re-opening its parent, which several already
 * do by hand; this only gives that the affordance it never had. `esc` keeps
 * meaning "close", and `←` means "the screen I came from".
 */
export const DIALOG_BACK = "←"

export function DialogHeader(props: {
  title: string
  subtitle?: string
  hint?: string
  muted?: boolean
  onClose?: () => void
  /** Re-opens the dialog this one was opened from. Draws {@link DIALOG_BACK}. */
  back?: () => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const hint = () => props.hint ?? "esc"
  return (
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="row" gap={1}>
        <text attributes={TextAttributes.BOLD} fg={props.muted ? theme.foreground.muted : theme.foreground.default}>
          {props.title}
        </text>
        <Show when={props.subtitle}>
          <text fg={theme.foreground.muted}>{props.subtitle}</text>
        </Show>
      </box>
      <box flexDirection="row" gap={1}>
        <Show when={props.back}>
          {(back) => (
            <text fg={theme.foreground.muted} onMouseUp={() => back()()}>
              {DIALOG_BACK}
            </text>
          )}
        </Show>
        <text
          fg={theme.foreground.muted}
          onMouseUp={hint() ? () => (props.onClose ? props.onClose() : dialog.clear()) : undefined}
        >
          {hint()}
        </text>
      </box>
    </box>
  )
}
