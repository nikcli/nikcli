import { createSignal, Show, type JSX } from "solid-js"
import { IconButton } from "@nikcli-ai/ui/icon-button"
import { Button } from "@nikcli-ai/ui/button"
import type { InspectedElement } from "./inspector-bridge"

export interface PointPromptPopoverProps {
  element: InspectedElement
  onClose: () => void
  onSubmitPrompt: (promptText: string, element: InspectedElement) => void
  onQuickAction: (action: string, element: InspectedElement) => void
}

export function PointPromptPopover(props: PointPromptPopoverProps): JSX.Element {
  const [promptText, setPromptText] = createSignal("")

  const handleSubmit = (e?: Event) => {
    e?.preventDefault()
    const text = promptText().trim()
    if (!text) return
    props.onSubmitPrompt(text, props.element)
    setPromptText("")
  }

  const quickActions = [
    { label: "Make bigger", action: "make-bigger" },
    { label: "Center content", action: "center-content" },
    { label: "Add rounded corners", action: "add-rounded" },
    { label: "Add padding", action: "add-padding" },
    { label: "Swap color", action: "swap-color" },
    { label: "Delete / Remove", action: "delete" },
  ]

  // Calculate popover positioning near element
  const posTop = () =>
    Math.max(10, Math.min(window.innerHeight - 300, props.element.rect.top + props.element.rect.height + 8))
  const posLeft = () => Math.max(10, Math.min(window.innerWidth - 380, props.element.rect.left))

  return (
    <div
      class="fixed z-50 w-96 bg-surface-raised-stronger-non-alpha border border-border-base rounded-xl shadow-2xl p-3 flex flex-col gap-2.5 animate-in fade-in zoom-in-95 duration-150"
      style={{
        top: `${posTop()}px`,
        left: `${posLeft()}px`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header with element tag and class info */}
      <div class="flex items-center justify-between border-b border-border-weak-base pb-2">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="px-1.5 py-0.5 rounded bg-surface-brand-base/40 text-text-strong font-mono text-13-medium">
            &lt;{props.element.tagName}&gt;
          </span>
          <Show when={props.element.id}>
            <span class="text-11-regular text-text-weak font-mono truncate">#{props.element.id}</span>
          </Show>
          <Show when={props.element.className}>
            <span class="text-11-regular text-text-weak font-mono truncate max-w-36">
              .{props.element.className.split(" ")[0]}
            </span>
          </Show>
        </div>
        <IconButton icon="close-small" variant="ghost" class="h-5 w-5" onClick={props.onClose} aria-label="Close" />
      </div>

      {/* Text snippet preview */}
      <Show when={props.element.innerText}>
        <div class="text-13-regular text-text-weak italic line-clamp-1 bg-surface-base px-2 py-1 rounded">
          "{props.element.innerText}"
        </div>
      </Show>

      {/* Prompt Form */}
      <form onSubmit={handleSubmit} class="flex flex-col gap-2">
        <textarea
          class="w-full h-20 p-2 text-13-regular bg-background-base text-text-strong border border-border-weak-base rounded-lg focus:outline-none focus:border-border-base resize-none"
          placeholder="Point & prompt: Describe what to change on this element..."
          value={promptText()}
          onInput={(e) => setPromptText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              handleSubmit()
            }
          }}
          autofocus
        />

        <div class="flex items-center justify-between">
          <span class="text-11-regular text-text-weak">Ctrl+Enter to send</span>
          <Button
            type="submit"
            variant="primary"
            size="small"
            disabled={!promptText().trim()}
            class="flex items-center gap-1.5"
          >
            <span>Ask Agent</span>
          </Button>
        </div>
      </form>

      {/* Quick Actions */}
      <div class="pt-1 border-t border-border-weak-base flex flex-col gap-1">
        <span class="text-11-medium text-text-weak uppercase tracking-wider">Quick Suggestions</span>
        <div class="flex flex-wrap gap-1">
          {quickActions.map((qa) => (
            <button
              type="button"
              class="text-11-regular px-2 py-1 rounded bg-surface-base hover:bg-surface-base-hover hover:text-text-strong text-text-weak transition-colors cursor-pointer border border-border-weak-base"
              onClick={() => props.onQuickAction(qa.action, props.element)}
            >
              {qa.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
