import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { EmptyBorder } from "@tui/component/border"
import { tint, useTheme } from "@tui/context/theme"
import { DISCLOSURE } from "@tui/component/disclosure"

/**
 * Visual language for the two kinds of delegated work in a session transcript.
 *
 * They used to share one ◆ row plus a muted " · background" suffix, so a nested
 * subtask and a parallel background job looked the same. The chrome below is
 * the whole distinction: glyph, badge, rail, hint, and how the card sits in
 * the turn. Keep the tokens here so tests can pin the difference without
 * mounting the session route.
 */
export type SessionTaskKind = "subtask" | "background"

export const sessionTaskVisual = {
  subtask: {
    kind: "subtask" as const,
    glyph: "◆",
    badge: "SUBTASK",
    rail: "┃",
    hint: "nested in this turn",
  },
  background: {
    kind: "background" as const,
    glyph: "◐",
    badge: "BG",
    rail: "╎",
    hint: "running in parallel",
  },
} as const

export function sessionTaskChrome(kind: SessionTaskKind) {
  return sessionTaskVisual[kind]
}

/**
 * In-session card for a delegated run.
 *
 * One row, and one signal for the one bit it has to convey. The rail (`┃` solid
 * against `╎` dashed), the glyph and the tint all already say nested-or-
 * parallel; an inverse-video SUBTASK chip beside them said it a fourth time, in
 * the loudest register on the line, for nine columns. The card used to spend
 * eight rows on a single delegation — three of padding, one for a description
 * that fits inline, one for a sentence explaining the rail — and collapsing
 * that onto one line while keeping the chip would have moved the noise rather
 * than removed it.
 *
 * So the collapsed row reads like the tool rows it sits among: glyph, title,
 * description, and a marker. The kind's *name* appears in the detail, where
 * somebody who could not read the glyph goes looking.
 *
 * Every card answers a click, and the marker says what the click does, in the
 * session's one disclosure grammar (`component/disclosure.ts`): `→` opens the
 * run, `▸`/`▾` reveals the detail here. Which one depends on whether the caller
 * knows a session to open — the tool view does, the transcript's own `subtask`
 * entry carries no id to follow.
 */
export function SessionTaskCard(props: {
  kind: SessionTaskKind
  /** Agent colour; the session route reads it from `useLocal().agent.color(...)`. */
  color: RGBA
  agent: string
  title: string
  description?: string
  /** Opens the run. Given one, the card navigates instead of expanding. */
  onClick?: () => void
  children?: JSX.Element
}) {
  const { theme, component } = useTheme()
  const renderer = useRenderer()
  const style = () => component("session.task-card")
  const [expanded, setExpanded] = createSignal(false)
  const chrome = createMemo(() => sessionTaskChrome(props.kind))
  const accent = createMemo(() => (props.kind === "background" ? theme.status.info.fg : props.color))
  /**
   * The description, unless it is the title again.
   *
   * The task tool derives both from the same field often enough that the
   * collapsed row read `Explore TUI architecture · @explore — Explore TUI
   * architecture`. Comparing case-insensitively because one of the two has
   * usually been through `titlecase`.
   */
  const description = createMemo(() => {
    const value = props.description?.trim()
    if (!value || value.toLowerCase() === props.title.trim().toLowerCase()) return undefined
    return value
  })
  const opens = createMemo(() => props.onClick !== undefined)
  const open = createMemo(() => !opens() && expanded())
  const panel = createMemo(() => tint(theme.surface.panel, accent(), props.kind === "background" ? 0.1 : 0.08))

  return (
    <box
      border={[...style().box.borderSides]}
      borderColor={accent()}
      customBorderChars={{
        ...EmptyBorder,
        vertical: chrome().rail,
      }}
      marginTop={style().box.marginTop}
      // The kind's own offsets, not the theme's: they place the card relative to
      // the turn — inside it or beside it — which is the distinction itself.
      marginLeft={props.kind === "background" ? 1 : 0}
      paddingLeft={props.kind === "subtask" ? 1 : 0}
      flexShrink={0}
      onMouseUp={() => {
        // A drag that ends here was somebody selecting the description, not
        // asking to leave the session. Every other clickable surface in the
        // transcript checks this; the card navigates, so it needed it most.
        if (renderer.getSelection()?.getSelectedText()) return
        if (props.onClick) return props.onClick()
        setExpanded((value) => !value)
      }}
    >
      <box
        paddingLeft={style().box.paddingLeft}
        paddingRight={style().box.paddingRight}
        backgroundColor={panel()}
        flexShrink={0}
        overflow="hidden"
      >
        {/* `wrapMode="none"` against the clip above: a long description is cut
            short rather than reflowing the card back into a paragraph. */}
        <text wrapMode="none">
          <span style={{ fg: accent() }}>{chrome().glyph} </span>
          <span style={{ fg: style().colors.title, attributes: TextAttributes.BOLD }}>{props.title}</span>
          <Show when={props.agent && props.agent !== props.title}>
            <span style={{ fg: style().colors.detail }}> · @{props.agent}</span>
          </Show>
          <Show when={description() && !open()}>
            <span style={{ fg: style().colors.detail }}> — {description()}</span>
          </Show>
          <span style={{ fg: style().colors.marker }}>
            {" "}
            {opens() ? DISCLOSURE.follow : open() ? DISCLOSURE.open : DISCLOSURE.closed}
          </span>
        </text>
        <Show when={open()}>
          <Show when={description()}>
            {(value) => (
              <text fg={style().colors.detail} paddingTop={1}>
                {value()}
              </text>
            )}
          </Show>
          {/* Where the kind says its name: below the fold, for the reader the
              glyph did not reach. */}
          <text fg={style().colors.marker}>
            {chrome().badge} · {chrome().hint}
          </text>
        </Show>
        {props.children}
      </box>
    </box>
  )
}
