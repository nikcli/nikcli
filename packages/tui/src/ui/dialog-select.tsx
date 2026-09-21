import { RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { entries, flatMap, groupBy, pipe } from "remeda"
import { batch, createEffect, createMemo, For, onCleanup, Show, type JSX, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import * as fuzzysort from "fuzzysort"
import { isDeepEqual } from "remeda"
import { DialogHeader, useDialog, type DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { Keybind } from "@tui/util/keybind"
import { Locale } from "@nikcli-ai/util/locale"
import { scrollChildIntoView, useScrollAcceleration } from "@tui/util/scroll"
import { moveSelection, reconcileSelection } from "./select-controller"
import { FooterHint, FooterHintGroup } from "./footer-hints"

export interface DialogSelectProps<T> {
  /**
   * Re-opens the dialog this one came from, drawing `←` beside `esc`.
   *
   * Dialogs here do not stack — a nested flow replaces its parent, which
   * `specs/effect-tui/03-tui-lifecycle.md` records as load-bearing — so going
   * back is the caller handing over a closure that opens the parent again.
   */
  back?: () => void
  title: string
  placeholder?: string
  options: DialogSelectOption<T>[]
  ref?: (ref: DialogSelectRef<T>) => void
  onMove?: (option: DialogSelectOption<T>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: DialogSelectOption<T>) => void
  skipFilter?: boolean
  getOptionKey?: (option: DialogSelectOption<T>, index: number) => string
  keybind?: DialogSelectKeybind<T>[]
  current?: T
}

/**
 * `allowEmpty` keybinds fire even with nothing selected, which is what actions
 * that change *which* options exist (a scope switch, a reload) need: without it
 * an empty result list is a dead end you cannot toggle out of.
 */
export type DialogSelectKeybind<T> =
  | {
      keybind?: Keybind.Info
      title: string
      disabled?: boolean
      allowEmpty?: false
      onTrigger: (option: DialogSelectOption<T>) => void
    }
  | {
      keybind?: Keybind.Info
      title: string
      disabled?: boolean
      allowEmpty: true
      onTrigger: (option: DialogSelectOption<T> | undefined) => void
    }

export interface DialogSelectOption<T = unknown> {
  title: string
  value: T
  description?: string
  searchText?: string
  footer?: JSX.Element | string
  category?: string
  disabled?: boolean
  bg?: RGBA
  gutter?: JSX.Element
  onSelect?: (ctx: DialogContext) => void
}

export type DialogSelectRef<T> = {
  filter: string
  filtered: DialogSelectOption<T>[]
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const scrollAcceleration = useScrollAcceleration()
  const [store, setStore] = createStore({
    selected: 0,
    filter: "",
    input: "keyboard" as "keyboard" | "mouse",
  })

  const filtered = createMemo(() => {
    const options = props.options.filter((x) => x.disabled !== true)
    if (props.skipFilter) return options
    const needle = store.filter.toLowerCase()
    if (!needle) return options
    return fuzzysort
      .go(needle, options, {
        keys: [
          (opt) => opt.title.toLowerCase(),
          (opt) => (opt.category ?? "").toLowerCase(),
          (opt) => (opt.searchText ?? "").toLowerCase(),
        ],
        scoreFn: (result) => result[0].score * 2 + result[1].score + result[2].score,
      })
      .map((x) => x.obj)
  })

  // When the filter changes due to how TUI works, the mousemove might still be triggered
  // via a synthetic event as the layout moves underneath the cursor. This is a workaround to make sure the input mode remains keyboard
  // that the mouseover event doesn't trigger when filtering.
  createEffect(
    on(
      () => filtered(),
      () => {
        setStore("input", "keyboard")
      },
      { defer: true },
    ),
  )

  const grouped = createMemo(() => {
    const result = pipe(
      filtered(),
      groupBy((x) => x.category ?? ""),
      entries(),
    )
    const seen = new Set<string>()
    return result.filter(([category]) => {
      if (seen.has(category)) return false
      seen.add(category)
      return true
    })
  })

  const flat = createMemo(() => {
    return pipe(
      grouped(),
      flatMap(([_, options]) => options),
    )
  })

  const groupedRows = createMemo(() => {
    let index = 0
    return grouped().map(([category, options]) => ({
      category,
      options: options.map((option) => ({ option, index: index++ })),
    }))
  })

  const dimensions = useTerminalDimensions()
  const height = createMemo(() =>
    Math.max(1, Math.min(flat().length + grouped().length * 2 - 1, Math.floor(dimensions().height / 2) - 6)),
  )

  const selected = createMemo(() => flat()[store.selected])

  const currentIndex = createMemo(() => {
    const current = props.current
    if (current === undefined) return -1
    const list = flat()
    const byRef = list.findIndex((opt) => opt.value === current)
    if (byRef >= 0) return byRef
    return list.findIndex((opt) => isDeepEqual(opt.value, current))
  })

  const optionIDs = createMemo(() =>
    flat().map((option, index) => {
      const key = props.getOptionKey?.(option, index)
      return key ? `dialog-select-option-${index}-${key}` : `dialog-select-option-${index}`
    }),
  )

  function optionID(index: number) {
    return optionIDs()[index] ?? `dialog-select-option-${index}`
  }

  function clampIndex(index: number) {
    return reconcileSelection(index, flat().length)
  }

  createEffect(() => {
    const next = reconcileSelection(store.selected, flat().length)
    if (next !== store.selected) setStore("selected", next)
  })

  createEffect(
    on([() => store.filter, currentIndex], ([filter, index]) => {
      const timer = setTimeout(() => {
        if (filter.length > 0) {
          moveTo(0, true)
        } else if (index >= 0) {
          moveTo(index, true)
        }
      }, 0)
      onCleanup(() => clearTimeout(timer))
    }),
  )

  function move(direction: number, wrap = true) {
    const count = flat().length
    if (count === 0) return
    moveTo(
      moveSelection(store.selected, {
        count,
        delta: direction,
        policy: wrap ? "wrap" : "clamp",
      }),
    )
  }

  function moveTo(next: number, center = false) {
    if (flat().length === 0) {
      setStore("selected", 0)
      return
    }
    const index = clampIndex(next)
    const option = flat()[index]
    if (!option) return
    setStore("selected", index)
    props.onMove?.(option)
    scrollChildIntoView(scroll, optionID(index), { center })
    if (!center && index === 0) scroll?.scrollTo(0)
  }

  const keybind = useKeybind()
  useKeyboard((evt) => {
    setStore("input", "keyboard")

    const handledNavigation =
      evt.name === "up" ||
      evt.name === "down" ||
      evt.name === "pageup" ||
      evt.name === "pagedown" ||
      evt.name === "home" ||
      evt.name === "end" ||
      (evt.ctrl && (evt.name === "p" || evt.name === "n"))

    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) move(-1)
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) move(1)
    if (evt.name === "pageup") move(-10, false)
    if (evt.name === "pagedown") move(10, false)
    if (evt.name === "home") moveTo(0)
    if (evt.name === "end") moveTo(flat().length - 1)

    if (handledNavigation) {
      evt.preventDefault()
      evt.stopPropagation()
    }

    if (evt.name === "return") {
      const option = selected()
      if (option) {
        evt.preventDefault()
        evt.stopPropagation()
        if (option.onSelect) option.onSelect(dialog)
        props.onSelect?.(option)
      }
    }

    const keybinds = props.keybind ?? []
    for (const item of keybinds) {
      if (item.disabled || !item.keybind) continue
      if (Keybind.match(item.keybind, keybind.parse(evt))) {
        const s = selected()
        if (!s && !item.allowEmpty) continue
        evt.preventDefault()
        evt.stopPropagation()
        item.onTrigger(s as DialogSelectOption<T>)
      }
    }
  })

  let scroll: ScrollBoxRenderable | undefined
  const ref: DialogSelectRef<T> = {
    get filter() {
      return store.filter
    },
    get filtered() {
      return filtered()
    },
  }
  props.ref?.(ref)

  const keybinds = createMemo(() => props.keybind?.filter((x) => !x.disabled && x.keybind) ?? [])

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4}>
        <DialogHeader title={props.title} back={props.back} />
        <box paddingTop={1} paddingBottom={1}>
          <input
            onInput={(e) => {
              batch(() => {
                setStore("filter", e)
                props.onFilter?.(e)
              })
            }}
            focused={true}
            focusedBackgroundColor={theme.surface.offset}
            cursorColor={theme.accent.fg}
            focusedTextColor={theme.foreground.muted}
            placeholder={props.placeholder ?? "Search"}
          />
        </box>
      </box>
      <Show
        when={groupedRows().length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={4} paddingTop={1}>
            <text fg={theme.foreground.muted}>No results matching "{store.filter}"</text>
          </box>
        }
      >
        <scrollbox
          paddingLeft={1}
          paddingRight={1}
          scrollbarOptions={{ visible: false }}
          viewportCulling={true}
          scrollAcceleration={scrollAcceleration()}
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          maxHeight={height()}
        >
          <For each={groupedRows()}>
            {(group, groupIndex) => (
              <>
                <Show when={group.category}>
                  <box paddingTop={groupIndex() > 0 ? 1 : 0} paddingLeft={3}>
                    <text fg={theme.accent.alt} attributes={TextAttributes.BOLD}>
                      {group.category}
                    </text>
                  </box>
                </Show>
                <For each={group.options}>
                  {(row) => {
                    const active = () => store.selected === row.index
                    const current = () => currentIndex() === row.index
                    return (
                      <box
                        id={optionID(row.index)}
                        flexDirection="row"
                        onMouseMove={() => setStore("input", "mouse")}
                        onMouseUp={() => {
                          row.option.onSelect?.(dialog)
                          props.onSelect?.(row.option)
                        }}
                        onMouseOver={() => {
                          if (store.input !== "mouse") return
                          moveTo(row.index)
                        }}
                        onMouseDown={() => moveTo(row.index)}
                        backgroundColor={active() ? (row.option.bg ?? theme.badge.bg) : RGBA.fromInts(0, 0, 0, 0)}
                        paddingLeft={current() || row.option.gutter ? 1 : 3}
                        paddingRight={3}
                        gap={1}
                      >
                        <Option
                          title={row.option.title}
                          footer={row.option.footer}
                          description={row.option.description !== group.category ? row.option.description : undefined}
                          active={active()}
                          current={current()}
                          gutter={row.option.gutter}
                        />
                      </box>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show
        when={keybinds().length}
        fallback={
          <box paddingRight={2} paddingLeft={4} flexShrink={0} paddingTop={1}>
            <FooterHintGroup>
              <FooterHint keys="↑↓" label="navigate" />
              <FooterHint keys="↵" label="select" />
              <FooterHint keys="esc" label="close" />
            </FooterHintGroup>
          </box>
        }
      >
        <box paddingRight={2} paddingLeft={4} flexDirection="row" gap={2} flexShrink={0} paddingTop={1}>
          <For each={keybinds()}>
            {(item) => (
              <box
                onMouseUp={() => {
                  const option = flat().at(store.selected)
                  if (option && item.onTrigger) {
                    item.onTrigger(option)
                  }
                }}
              >
                <text>
                  <span style={{ fg: theme.foreground.default }}>
                    <b>{item.title}</b>{" "}
                  </span>
                  <span style={{ fg: theme.accent.alt }}>{Keybind.toString(item.keybind)}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function Option(props: {
  title: string
  description?: string
  active?: boolean
  current?: boolean
  footer?: JSX.Element | string
  gutter?: JSX.Element
}) {
  const { theme } = useTheme()
  const fg = theme.badge.fg

  return (
    <>
      <Show when={props.current}>
        <text
          flexShrink={0}
          fg={props.active ? fg : props.current ? theme.accent.fg : theme.foreground.default}
          marginRight={0}
        >
          ●
        </text>
      </Show>
      <Show when={!props.current && props.gutter}>
        <box flexShrink={0} marginRight={0}>
          {props.gutter}
        </box>
      </Show>
      <text
        flexGrow={1}
        fg={props.active ? fg : props.current ? theme.accent.fg : theme.foreground.default}
        attributes={props.active ? TextAttributes.BOLD : undefined}
        overflow="hidden"
        wrapMode="none"
        paddingLeft={3}
      >
        {Locale.truncate(props.title, 61)}
        <Show when={props.description}>
          <span style={{ fg: props.active ? fg : theme.foreground.muted }}> {props.description}</span>
        </Show>
      </text>
      <Show when={props.footer}>
        <box flexShrink={0}>
          <text fg={props.active ? fg : theme.foreground.muted}>{props.footer}</text>
        </box>
      </Show>
    </>
  )
}
