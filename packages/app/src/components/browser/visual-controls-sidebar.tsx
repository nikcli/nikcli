import { createEffect, createSignal, createMemo, For, on, Show, type JSX } from "solid-js"
import { IconButton } from "@nikcli-ai/ui/icon-button"
import { Button } from "@nikcli-ai/ui/button"
import type { InspectedElement } from "./inspector-bridge"

export interface VisualControlsSidebarProps {
  element: InspectedElement | null
  onApplyStyle: (property: string, value: string) => void
  onReorderElement: (direction: "up" | "down") => void
  onApplyToCode: (element: InspectedElement, changes: Record<string, string>) => void
  onClose: () => void
}

export function VisualControlsSidebar(props: VisualControlsSidebarProps): JSX.Element {
  const [activeTab, setActiveTab] = createSignal<"styles" | "layout" | "typography">("styles")
  const [stagedChanges, setStagedChanges] = createSignal<Record<string, string>>({})

  // The staged edits belong to one element. Without this they survive a click on
  // the next one, which then shows another element's values as its own and hands
  // them to the agent under the wrong selector.
  createEffect(
    on(
      () => props.element?.selector,
      () => setStagedChanges({}),
      { defer: true },
    ),
  )

  const handleStyleChange = (prop: string, val: string) => {
    setStagedChanges((prev) => ({ ...prev, [prop]: val }))
    props.onApplyStyle(prop, val)
  }

  const handleApplyToCode = () => {
    if (!props.element) return
    props.onApplyToCode(props.element, stagedChanges())
    setStagedChanges({})
  }

  const hasChanges = createMemo(() => Object.keys(stagedChanges()).length > 0)

  return (
    <aside class="w-80 h-full bg-surface-base border-l border-border-weak-base flex flex-col overflow-hidden select-none">
      {/* Header */}
      <div class="p-3 border-b border-border-weak-base flex items-center justify-between">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-13-medium text-text-strong">Visual Inspector</span>
          <Show when={props.element}>
            <span class="px-1.5 py-0.5 rounded bg-surface-brand-base/40 text-text-strong font-mono text-11-medium">
              &lt;{props.element?.tagName}&gt;
            </span>
          </Show>
        </div>
        <IconButton icon="close-small" variant="ghost" class="h-6 w-6" onClick={props.onClose} aria-label="Close" />
      </div>

      <Show
        when={props.element}
        fallback={
          <div class="flex-1 p-6 flex flex-col items-center justify-center text-center gap-3 text-text-weak">
            <span class="text-13-regular">Click any element in the browser preview to inspect and edit its visual styles.</span>
          </div>
        }
      >
        {/* Navigation Tabs */}
        <div class="flex border-b border-border-weak-base bg-surface-base">
          <button
            type="button"
            class="flex-1 py-2 text-13-medium text-center transition-colors cursor-pointer"
            classList={{
              "text-text-strong border-b-2 border-surface-brand-base font-semibold bg-surface-base": activeTab() === "styles",
              "text-text-weak hover:text-text-strong": activeTab() !== "styles",
            }}
            onClick={() => setActiveTab("styles")}
          >
            Style
          </button>
          <button
            type="button"
            class="flex-1 py-2 text-13-medium text-center transition-colors cursor-pointer"
            classList={{
              "text-text-strong border-b-2 border-surface-brand-base font-semibold bg-surface-base": activeTab() === "layout",
              "text-text-weak hover:text-text-strong": activeTab() !== "layout",
            }}
            onClick={() => setActiveTab("layout")}
          >
            Layout
          </button>
          <button
            type="button"
            class="flex-1 py-2 text-13-medium text-center transition-colors cursor-pointer"
            classList={{
              "text-text-strong border-b-2 border-surface-brand-base font-semibold bg-surface-base": activeTab() === "typography",
              "text-text-weak hover:text-text-strong": activeTab() !== "typography",
            }}
            onClick={() => setActiveTab("typography")}
          >
            Type
          </button>
        </div>

        {/* Controls Body */}
        <div class="flex-1 overflow-y-auto p-3 flex flex-col gap-4 text-13-regular text-text-strong">
          {/* Element Tree & Reorder */}
          <div class="flex flex-col gap-1.5 p-2 bg-surface-base rounded-lg border border-border-weak-base">
            <div class="flex items-center justify-between text-11-medium text-text-weak">
              <span>DOM ORDER</span>
              <div class="flex gap-1">
                <button
                  type="button"
                  class="px-2 py-0.5 rounded bg-surface-base hover:bg-surface-base-hover text-text-strong border border-border-weak-base cursor-pointer"
                  onClick={() => props.onReorderElement("up")}
                  title="Move element before sibling"
                >
                  ↑ Up
                </button>
                <button
                  type="button"
                  class="px-2 py-0.5 rounded bg-surface-base hover:bg-surface-base-hover text-text-strong border border-border-weak-base cursor-pointer"
                  onClick={() => props.onReorderElement("down")}
                  title="Move element after sibling"
                >
                  ↓ Down
                </button>
              </div>
            </div>
            <div class="font-mono text-11-regular text-text-weak truncate">
              {props.element?.selector}
            </div>
          </div>

          {/* STYLES TAB */}
          <Show when={activeTab() === "styles"}>
            <div class="flex flex-col gap-3">
              {/* Background Color */}
              <div class="flex flex-col gap-1">
                <label class="text-11-medium text-text-weak">Background Color</label>
                <div class="flex items-center gap-2">
                  <input
                    type="color"
                    class="w-8 h-8 rounded border border-border-weak-base cursor-pointer bg-transparent"
                    value={props.element?.styles.backgroundColor || "#ffffff"}
                    onInput={(e) => handleStyleChange("backgroundColor", e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    class="flex-1 px-2 py-1 bg-background-base border border-border-weak-base rounded text-13-regular font-mono"
                    value={stagedChanges()["backgroundColor"] || props.element?.styles.backgroundColor || ""}
                    placeholder="e.g. #3b82f6 or rgba(...)"
                    onInput={(e) => handleStyleChange("backgroundColor", e.currentTarget.value)}
                  />
                </div>
              </div>

              {/* Text Color */}
              <div class="flex flex-col gap-1">
                <label class="text-11-medium text-text-weak">Text Color</label>
                <div class="flex items-center gap-2">
                  <input
                    type="color"
                    class="w-8 h-8 rounded border border-border-weak-base cursor-pointer bg-transparent"
                    value={props.element?.styles.color || "#000000"}
                    onInput={(e) => handleStyleChange("color", e.currentTarget.value)}
                  />
                  <input
                    type="text"
                    class="flex-1 px-2 py-1 bg-background-base border border-border-weak-base rounded text-13-regular font-mono"
                    value={stagedChanges()["color"] || props.element?.styles.color || ""}
                    placeholder="e.g. #111827"
                    onInput={(e) => handleStyleChange("color", e.currentTarget.value)}
                  />
                </div>
              </div>

              {/* Border Radius */}
              <div class="flex flex-col gap-1">
                <div class="flex justify-between items-center text-11-medium text-text-weak">
                  <label>Corner Radius</label>
                  <span class="font-mono">{stagedChanges()["borderRadius"] || props.element?.styles.borderRadius || "0px"}</span>
                </div>
                <div class="grid grid-cols-4 gap-1">
                  {["0px", "6px", "12px", "9999px"].map((rad) => (
                    <button
                      type="button"
                      class="py-1 px-2 bg-surface-base hover:bg-surface-base-hover rounded border border-border-weak-base text-11-regular cursor-pointer text-center"
                      onClick={() => handleStyleChange("borderRadius", rad)}
                    >
                      {rad === "9999px" ? "Full" : rad}
                    </button>
                  ))}
                </div>
              </div>

              {/* Opacity */}
              <div class="flex flex-col gap-1">
                <div class="flex justify-between items-center text-11-medium text-text-weak">
                  <label>Opacity</label>
                  <span class="font-mono">{stagedChanges()["opacity"] || props.element?.styles.opacity || "1"}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={stagedChanges()["opacity"] || props.element?.styles.opacity || "1"}
                  onInput={(e) => handleStyleChange("opacity", e.currentTarget.value)}
                  class="w-full cursor-pointer accent-current"
                />
              </div>
            </div>
          </Show>

          {/* LAYOUT TAB */}
          <Show when={activeTab() === "layout"}>
            <div class="flex flex-col gap-3">
              {/* Display */}
              <div class="flex flex-col gap-1">
                <label class="text-11-medium text-text-weak">Display</label>
                <div class="grid grid-cols-3 gap-1">
                  {["flex", "grid", "block"].map((d) => (
                    <button
                      type="button"
                      class="py-1 px-2 rounded border text-11-regular cursor-pointer text-center"
                      classList={{
                        "bg-surface-brand-base/40 border-surface-brand-base text-text-strong font-semibold":
                          (stagedChanges()["display"] || props.element?.styles.display) === d,
                        "bg-surface-base border-border-weak-base hover:bg-surface-base-hover":
                          (stagedChanges()["display"] || props.element?.styles.display) !== d,
                      }}
                      onClick={() => handleStyleChange("display", d)}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {/* Flex Direction */}
              <div class="flex flex-col gap-1">
                <label class="text-11-medium text-text-weak">Direction</label>
                <div class="grid grid-cols-2 gap-1">
                  {["row", "column"].map((dir) => (
                    <button
                      type="button"
                      class="py-1 px-2 rounded border text-11-regular cursor-pointer text-center"
                      classList={{
                        "bg-surface-brand-base/40 border-surface-brand-base text-text-strong font-semibold":
                          (stagedChanges()["flexDirection"] || props.element?.styles.flexDirection) === dir,
                        "bg-surface-base border-border-weak-base hover:bg-surface-base-hover":
                          (stagedChanges()["flexDirection"] || props.element?.styles.flexDirection) !== dir,
                      }}
                      onClick={() => handleStyleChange("flexDirection", dir)}
                    >
                      {dir}
                    </button>
                  ))}
                </div>
              </div>

              {/* Gap */}
              <div class="flex flex-col gap-1">
                <label class="text-11-medium text-text-weak">Gap</label>
                <div class="grid grid-cols-4 gap-1">
                  {["0px", "8px", "16px", "24px"].map((g) => (
                    <button
                      type="button"
                      class="py-1 px-2 bg-surface-base hover:bg-surface-base-hover rounded border border-border-weak-base text-11-regular cursor-pointer text-center"
                      onClick={() => handleStyleChange("gap", g)}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>

              {/* Padding */}
              <div class="flex flex-col gap-1">
                <label class="text-11-medium text-text-weak">Padding</label>
                <input
                  type="text"
                  class="px-2 py-1 bg-background-base border border-border-weak-base rounded text-13-regular font-mono"
                  value={stagedChanges()["padding"] || props.element?.styles.padding || ""}
                  placeholder="e.g. 16px 24px"
                  onInput={(e) => handleStyleChange("padding", e.currentTarget.value)}
                />
              </div>

              {/* Margin */}
              <div class="flex flex-col gap-1">
                <label class="text-11-medium text-text-weak">Margin</label>
                <input
                  type="text"
                  class="px-2 py-1 bg-background-base border border-border-weak-base rounded text-13-regular font-mono"
                  value={stagedChanges()["margin"] || props.element?.styles.margin || ""}
                  placeholder="e.g. 0 auto"
                  onInput={(e) => handleStyleChange("margin", e.currentTarget.value)}
                />
              </div>
            </div>
          </Show>

          {/* TYPOGRAPHY TAB */}
          <Show when={activeTab() === "typography"}>
            <div class="flex flex-col gap-3">
              {/* Font Size */}
              <div class="flex flex-col gap-1">
                <label class="text-11-medium text-text-weak">Font Size</label>
                <div class="grid grid-cols-4 gap-1">
                  {["12px", "14px", "18px", "24px"].map((s) => (
                    <button
                      type="button"
                      class="py-1 px-2 bg-surface-base hover:bg-surface-base-hover rounded border border-border-weak-base text-11-regular cursor-pointer text-center"
                      onClick={() => handleStyleChange("fontSize", s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              {/* Font Weight */}
              <div class="flex flex-col gap-1">
                <label class="text-11-medium text-text-weak">Font Weight</label>
                <div class="grid grid-cols-3 gap-1">
                  {["400", "600", "700"].map((w) => (
                    <button
                      type="button"
                      class="py-1 px-2 bg-surface-base hover:bg-surface-base-hover rounded border border-border-weak-base text-11-regular cursor-pointer text-center"
                      onClick={() => handleStyleChange("fontWeight", w)}
                    >
                      {w === "400" ? "Normal" : w === "600" ? "Medium" : "Bold"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Text Align */}
              <div class="flex flex-col gap-1">
                <label class="text-11-medium text-text-weak">Align</label>
                <div class="grid grid-cols-3 gap-1">
                  {["left", "center", "right"].map((a) => (
                    <button
                      type="button"
                      class="py-1 px-2 bg-surface-base hover:bg-surface-base-hover rounded border border-border-weak-base text-11-regular cursor-pointer text-center capitalize"
                      onClick={() => handleStyleChange("textAlign", a)}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Show>
        </div>

        {/* Footer with Apply to Code button */}
        <div class="p-3 border-t border-border-weak-base bg-surface-base flex flex-col gap-2">
          <Button
            variant="primary"
            class="w-full justify-center"
            disabled={!hasChanges()}
            onClick={handleApplyToCode}
          >
            Apply Changes to Code
          </Button>
          <Show when={hasChanges()}>
            <span class="text-11-regular text-text-weak text-center">
              {Object.keys(stagedChanges()).length} pending visual modification(s)
            </span>
          </Show>
        </div>
      </Show>
    </aside>
  )
}
