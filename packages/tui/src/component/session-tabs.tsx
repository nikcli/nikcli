import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Show } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useKV } from "@tui/context/kv"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useSessionTabs, type SessionTabState } from "@tui/context/session-tabs"
import { useTheme } from "@tui/context/theme"
import { tabRows } from "@tui/context/component-tokens"
import { useKeybind } from "@tui/context/keybind"
import { Logo } from "@tui/component/logo"
import { borderCharsFor, SplitBorder } from "@tui/component/border"
import { DialogSessionLink } from "@tui/component/dialog-session-link"
import { sessionLinkOf } from "@tui/util/session-link"
import { bunUtils } from "@nikcli-ai/util/bun-utils"

const TAB_MIN_WIDTH = 12
const TAB_MAX_WIDTH = 28
const FIXED_CHROME_WIDTH = 17
const TAB_GAP = 1
const OVERFLOW_WIDTH = 6
// `+ new` and `× all` share one column, so the pair costs the width of a single button.
const CHROME_BUTTON_WIDTH = 8

export type SessionTabLayout = {
  ids: string[]
  hidden: number
  width: number
}

export function truncateTabTitle(title: string, width: number) {
  const clean = title.replace(/\s+/g, " ").trim() || "Untitled session"
  if (bunUtils.stringWidth(clean) <= width) return clean
  if (width <= 1) return "…"
  return `${bunUtils.sliceAnsi(clean, 0, width - 1)}…`
}

export function layoutSessionTabs(
  ids: string[],
  activeID: string | undefined,
  terminalWidth: number,
): SessionTabLayout {
  const available = Math.max(TAB_MIN_WIDTH, terminalWidth - FIXED_CHROME_WIDTH)
  const initialCapacity = Math.max(1, Math.floor((available + TAB_GAP) / (TAB_MIN_WIDTH + TAB_GAP)))
  const capacity =
    ids.length > initialCapacity
      ? Math.max(1, Math.floor((available - OVERFLOW_WIDTH + TAB_GAP) / (TAB_MIN_WIDTH + TAB_GAP)))
      : initialCapacity
  const visibleCount = Math.min(ids.length, capacity)
  let start = Math.max(0, ids.length - visibleCount)

  if (activeID) {
    const activeIndex = ids.indexOf(activeID)
    if (activeIndex >= 0 && activeIndex < start) start = activeIndex
  }

  const visible = ids.slice(start, start + visibleCount)
  const hidden = ids.length - visible.length
  const overflowWidth = hidden > 0 ? OVERFLOW_WIDTH : 0
  const gapsWidth = Math.max(0, visible.length - 1) * TAB_GAP
  // Subtract 1 to leave a one-cell margin between tabs and the chrome
  // edge. The previous formula returned off-by-one values that
  // overflowed the terminal in practice; the -1 keeps the rendered
  // tabs within bounds while respecting TAB_MIN_WIDTH as a floor.
  const width = Math.max(
    TAB_MIN_WIDTH,
    Math.min(TAB_MAX_WIDTH, Math.floor((available - overflowWidth - gapsWidth) / Math.max(1, visible.length)) - 1),
  )
  return { ids: visible, hidden, width }
}

export function SessionTabs() {
  const route = useRoute()
  const sync = useSync()
  const kv = useKV()
  const dialog = useDialog()
  const { theme, component } = useTheme()
  const dimensions = useTerminalDimensions()
  const tabs = useSessionTabs()
  const keybind = useKeybind()

  function openLinkDialog(id: string) {
    dialog.replace(() => <DialogSessionLink sessionID={id} />)
  }

  const activeID = tabs.active
  const style = () => component("session.tabs")
  // Height is derived from the strip's own padding rather than chosen beside
  // it, so a theme that tightens the strip cannot leave the row taller than
  // what it holds — the gap that reads as a misaligned tab bar.
  const contentHeight = createMemo(() => tabRows(style().box))
  const bordered = createMemo(() => style().box.borderSides.length > 0)
  const byID = createMemo(() => new Map(tabs.list().map((tab) => [tab.id, tab])))
  const layout = createMemo(() => layoutSessionTabs(tabs.ids(), activeID(), dimensions().width))

  useKeyboard((event) => {
    // A modal owns the keyboard while it is up. Without this the tab shortcuts
    // still fired underneath it, so ctrl+tab inside a dialog switched the
    // session behind the dialog and left it open over the wrong one.
    if (dialog.stack.length > 0) return
    if (event.ctrl && event.name === "tab") {
      event.preventDefault()
      tabs.cycle(event.shift ? -1 : 1)
      return
    }
    // Routed through the keybind config rather than matched by hand, so both directions are
    // rebindable and show up in the help dialog. Forward defaults to a leader chord because the
    // editor-conventional Ctrl-I is encoded by terminals as ASCII TAB — it would arrive
    // indistinguishable from the Ctrl+Tab above and silently cycle instead of stepping forward.
    if (keybind.match("session_tab_back", event)) {
      event.preventDefault()
      tabs.back()
      return
    }
    if (keybind.match("session_tab_forward", event)) {
      event.preventDefault()
      tabs.forward()
    }
  })

  return (
    <box
      flexShrink={0}
      height={contentHeight() + (bordered() ? 1 : 0)}
      width="100%"
      flexDirection="row"
      alignItems="center"
      backgroundColor={style().colors.background}
      border={style().box.borderSides}
      customBorderChars={borderCharsFor(style().box.borderCharset)}
      borderColor={style().colors.border}
      overflow="hidden"
    >
      <box
        width={9}
        height={contentHeight()}
        flexShrink={0}
        paddingTop={style().box.paddingTop}
        paddingBottom={style().box.paddingBottom}
        paddingLeft={1}
        flexDirection="column"
      >
        <Logo compact idle={false} />
      </box>
      <box flexDirection="row" flexGrow={1} minWidth={0} height={contentHeight()} gap={TAB_GAP} overflow="hidden">
        <For each={layout().ids}>
          {(id) => {
            const state = createMemo<SessionTabState | undefined>(() => byID().get(id))
            const selected = () => state()?.active === true
            const session = createMemo(() => sync.session.get(id))
            const status = createMemo(() => sync.data.session_status[id]?.type ?? "idle")
            // Semantic precedence: what blocks the user outranks what is merely running, which
            // outranks work they have not looked at yet. Only one marker fits in a tab.
            const marker = createMemo(() => {
              if (state()?.attention) return { glyph: "◆", color: theme.status.warning.fg }
              if (state()?.busy || status() === "busy") return { glyph: "●", color: theme.status.info.fg }
              if (status() === "retry") return { glyph: "●", color: theme.status.warning.fg }
              if (state()?.unread) return { glyph: "●", color: theme.accent.fg }
              return { glyph: "·", color: theme.foreground.muted }
            })
            const linkedID = createMemo(() => sessionLinkOf(kv, id))
            const title = () =>
              truncateTabTitle(
                session()?.title ?? state()?.title ?? `Session ${id.slice(-5)}`,
                layout().width - 8 - (linkedID() ? 3 : 0),
              )
            return (
              <box
                width={layout().width}
                minWidth={TAB_MIN_WIDTH}
                flexShrink={0}
                height={contentHeight()}
                flexDirection="row"
                paddingTop={style().box.paddingTop}
                paddingBottom={style().box.paddingBottom}
                overflow="hidden"
                onMouseDown={() => tabs.open(id)}
                backgroundColor={selected() ? style().colors.activeBackground : undefined}
                border={selected() && bordered() ? ["left"] : undefined}
                borderColor={selected() ? style().colors.activeBorder : undefined}
                customBorderChars={selected() ? SplitBorder.customBorderChars : undefined}
              >
                <text fg={marker().color} wrapMode="none">
                  {` ${marker().glyph} `}
                </text>
                <Show when={linkedID()}>
                  <text
                    fg={theme.status.info.fg}
                    onMouseDown={(event) => {
                      event.stopPropagation()
                      openLinkDialog(id)
                    }}
                    wrapMode="none"
                  >
                    {"⇄ "}
                  </text>
                </Show>
                <text
                  fg={selected() ? theme.foreground.default : theme.foreground.muted}
                  attributes={selected() ? TextAttributes.BOLD : TextAttributes.DIM}
                  wrapMode="none"
                  flexGrow={1}
                >
                  {title()}
                </text>
                <Show when={selected()}>
                  <Show when={!linkedID()}>
                    <text
                      fg={theme.foreground.muted}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        openLinkDialog(id)
                      }}
                      wrapMode="none"
                    >
                      {" ⇄ "}
                    </text>
                  </Show>
                  <text
                    fg={theme.foreground.muted}
                    onMouseDown={(event) => {
                      event.stopPropagation()
                      tabs.close(id)
                    }}
                    wrapMode="none"
                  >
                    {" × "}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
        <Show when={layout().hidden > 0}>
          <box
            width={6}
            height={contentHeight()}
            flexShrink={0}
            paddingTop={style().box.paddingTop}
            paddingBottom={style().box.paddingBottom}
            flexDirection="column"
          >
            <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
              {` ·· +${layout().hidden}`}
            </text>
          </box>
        </Show>
      </box>
      {/*
        Stacked, one row each, so the close-all action costs no horizontal cells: the strip's
        reserved chrome stays exactly the width of `+ new` and the tabs keep every column they had.
      */}
      <box
        width={CHROME_BUTTON_WIDTH}
        height={contentHeight()}
        flexShrink={0}
        flexDirection="column"
        justifyContent="center"
      >
        <box
          height={1}
          flexDirection="row"
          justifyContent="center"
          onMouseDown={tabs.createSession}
          backgroundColor={route.data.type === "home" ? theme.surface.offset : undefined}
          border={route.data.type === "home" ? ["left"] : undefined}
          borderColor={route.data.type === "home" ? theme.accent.fg : undefined}
          customBorderChars={route.data.type === "home" ? SplitBorder.customBorderChars : undefined}
        >
          <text
            fg={route.data.type === "home" ? theme.accent.fg : theme.foreground.muted}
            attributes={route.data.type === "home" ? TextAttributes.BOLD : undefined}
            wrapMode="none"
          >
            {" + new"}
          </text>
        </box>
        <box
          height={1}
          flexDirection="row"
          justifyContent="center"
          onMouseDown={tabs.closeAll}
          backgroundColor={theme.surface.offset}
          border={["left"]}
          borderColor={theme.status.error.fg}
          customBorderChars={SplitBorder.customBorderChars}
        >
          <text fg={theme.status.error.fg} attributes={TextAttributes.BOLD} wrapMode="none">
            {" × all"}
          </text>
        </box>
      </box>
    </box>
  )
}
