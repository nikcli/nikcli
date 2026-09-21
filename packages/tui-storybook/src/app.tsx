import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { BUILT_IN_THEME_IDS, loadBuiltInTheme } from "@tui/context/theme-catalog"
import {
  BORDER_CHARSETS,
  chromeRows,
  COMPONENT_DEFAULTS,
  type BorderCharset,
  type ComponentId,
  type ComponentPatchMap,
} from "@tui/context/component-tokens"
import { Harness } from "./harness"
import { STORIES } from "./catalog"
import { clearComponent, readOverrides, setBoxField, setCharset, writeOverrides } from "./overrides"

/**
 * Three panes: the catalog, the component, and its tokens.
 *
 * Every theme is offered, not a curated few. A component-token layer only earns
 * trust if it survives the whole set, and the ones that break it are never the
 * ones a curator would have picked.
 */

const NUMERIC = [
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "marginTop",
  "marginBottom",
  "gap",
] as const
type NumericField = (typeof NUMERIC)[number]

/** `borderCharset` sits after the numbers as one extra, cycled rather than stepped. */
const FIELDS = [...NUMERIC, "borderCharset"] as const

const CHROME = {
  fg: RGBA.fromHex("#e6e6e6"),
  muted: RGBA.fromHex("#9a9a9a"),
  accent: RGBA.fromHex("#6fa3ff"),
  warn: RGBA.fromHex("#d9a14a"),
  panel: RGBA.fromHex("#121212"),
  base: RGBA.fromHex("#070707"),
}

function StorybookApp() {
  const dimensions = useTerminalDimensions()
  const [storyIndex, setStoryIndex] = createSignal(0)
  const [themeIndex, setThemeIndex] = createSignal(Math.max(0, BUILT_IN_THEME_IDS.indexOf("nikcli")))
  const [mode, setMode] = createSignal<"dark" | "light">("dark")
  const [fieldIndex, setFieldIndex] = createSignal(2)
  const [overrides, setOverrides] = createSignal<ComponentPatchMap>({})
  const [status, setStatus] = createSignal("")

  void readOverrides().then(setOverrides)

  const themeName = createMemo(() => BUILT_IN_THEME_IDS[themeIndex()] ?? "nikcli")
  const [document] = createResource(themeName, (name) => loadBuiltInTheme(name))

  const story = createMemo(() => STORIES[storyIndex()]!)
  const styleId = createMemo<ComponentId | undefined>(() => story().styleId)
  const field = createMemo(() => FIELDS[fieldIndex()]!)

  /** The value the theme alone would give, i.e. what an override departs from. */
  function themeDefault(id: ComponentId, name: (typeof FIELDS)[number]) {
    const box = COMPONENT_DEFAULTS[id].box
    return box[name as keyof typeof box]
  }

  function adjust(delta: number) {
    const id = styleId()
    if (!id) return
    const name = field()
    if (name === "borderCharset") {
      const current = (overrides()[id]?.box?.borderCharset as BorderCharset) ?? COMPONENT_DEFAULTS[id].box.borderCharset
      const next =
        BORDER_CHARSETS[(BORDER_CHARSETS.indexOf(current) + delta + BORDER_CHARSETS.length) % BORDER_CHARSETS.length]!
      setOverrides((current) => setCharset(current, id, next, COMPONENT_DEFAULTS[id].box.borderCharset))
      return
    }
    const fallback = themeDefault(id, name) as number
    const current = (overrides()[id]?.box?.[name] as number) ?? fallback
    setOverrides((patches) => setBoxField(patches, id, name as NumericField, current + delta, fallback))
  }

  useKeyboard((key) => {
    setStatus("")
    switch (key.name) {
      case "down":
      case "j":
        return setStoryIndex((index) => (index + 1) % STORIES.length)
      case "up":
      case "k":
        return setStoryIndex((index) => (index - 1 + STORIES.length) % STORIES.length)
      case "right":
      case "l":
        return setFieldIndex((index) => (index + 1) % FIELDS.length)
      case "left":
      case "h":
        return setFieldIndex((index) => (index - 1 + FIELDS.length) % FIELDS.length)
      case "t":
        return setThemeIndex((index) =>
          key.shift
            ? (index - 1 + BUILT_IN_THEME_IDS.length) % BUILT_IN_THEME_IDS.length
            : (index + 1) % BUILT_IN_THEME_IDS.length,
        )
      case "m":
        return setMode((current) => (current === "dark" ? "light" : "dark"))
      case "=":
      case "+":
        return adjust(1)
      case "-":
        return adjust(-1)
      case "r": {
        const id = styleId()
        if (id) setOverrides((patches) => clearComponent(patches, id))
        return setStatus("reset")
      }
      case "w":
        return void writeOverrides(overrides()).then((where) => setStatus(`wrote ${where}`))
      case "q":
        return process.exit(0)
    }
  })

  const previewWidth = createMemo(() => Math.max(30, dimensions().width - 56))

  return (
    <box flexDirection="row" width="100%" height="100%" backgroundColor={CHROME.base}>
      <box width={26} flexDirection="column" padding={1} backgroundColor={CHROME.panel}>
        <text fg={CHROME.accent}>stories</text>
        <For each={STORIES}>
          {(entry, index) => (
            <text fg={index() === storyIndex() ? CHROME.accent : CHROME.muted} wrapMode="none">
              {index() === storyIndex() ? "▸ " : "  "}
              {entry.title}
            </text>
          )}
        </For>
      </box>

      <box flexGrow={1} flexDirection="column" padding={1}>
        <text fg={CHROME.muted} wrapMode="none">
          {themeName()} · {mode()} · {String(themeIndex() + 1)}/{String(BUILT_IN_THEME_IDS.length)}
        </text>
        <Show when={document()} fallback={<text fg={CHROME.muted}>loading theme…</text>}>
          {(value) => (
            <Harness
              document={value()}
              mode={mode()}
              overrides={overrides()}
              width={previewWidth()}
              height={dimensions().height - 6}
            >
              {story().render({ style: (id) => styleFor(id) })}
            </Harness>
          )}
        </Show>
      </box>

      <box width={30} flexDirection="column" padding={1} backgroundColor={CHROME.panel}>
        <text fg={CHROME.accent}>tokens</text>
        <Show when={styleId()} fallback={<text fg={CHROME.muted}>no tokens for this story</text>}>
          {(id) => (
            <>
              <text fg={CHROME.muted} wrapMode="none">
                {id()}
              </text>
              <For each={FIELDS}>
                {(name, index) => {
                  const value =
                    (overrides()[id()]?.box?.[name] as number | string | undefined) ?? themeDefault(id(), name)
                  const overridden = overrides()[id()]?.box?.[name] !== undefined
                  return (
                    <text fg={index() === fieldIndex() ? CHROME.accent : overridden ? CHROME.warn : CHROME.muted}>
                      {index() === fieldIndex() ? "▸ " : "  "}
                      {name} {String(value)}
                      {overridden ? " *" : ""}
                    </text>
                  )
                }}
              </For>
              <text fg={CHROME.muted}>chrome rows {String(chromeRows(resolvedBox(id())))}</text>
            </>
          )}
        </Show>
        <text fg={CHROME.muted}>↑↓ story ←→ field</text>
        <text fg={CHROME.muted}>+/- value · t theme · m mode</text>
        <text fg={CHROME.muted}>w write · r reset · q quit</text>
        <Show when={status()}>
          <text fg={CHROME.warn} wrapMode="none">
            {status()}
          </text>
        </Show>
      </box>
    </box>
  )

  /** The box as the preview will resolve it, for the chrome-rows readout. */
  function resolvedBox(id: ComponentId) {
    const patch = overrides()[id]?.box ?? {}
    return { ...COMPONENT_DEFAULTS[id].box, ...(patch as Record<string, number>) }
  }

  /**
   * Resolved style for a story that takes one as a prop.
   *
   * Reaches the same numbers the harness resolves; a story only needs it
   * because `UserMessage` takes its style from the parent rather than reading
   * the context itself.
   */
  function styleFor(id: ComponentId) {
    return { box: resolvedBox(id), colors: {} } as never
  }
}

export async function runStorybook(): Promise<number> {
  try {
    await render(() => <StorybookApp />, {
      targetFps: 30,
      exitOnCtrlC: true,
      consoleMode: "disabled",
    })
  } catch (error) {
    console.error("FATAL:", error)
    return 1
  }
  return 0
}
