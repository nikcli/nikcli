import { createMemo, Show, type JSX } from "solid-js"
import type { RGBA } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { EmptyBorder } from "@tui/component/border"
import { selectedForeground, tint, useTheme } from "@tui/context/theme"

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
 * Nested subtasks sit inside the turn (solid rail, SUBTASK chip). Background
 * jobs sit beside it (dashed rail, BG chip, info tint) so they read as a
 * sidecar rather than another child of the same message. Everything the card
 * needs arrives as props — same rule as `pending-input-card.tsx` — so both
 * kinds can be drawn without an SDK.
 */
export function SessionTaskCard(props: {
  kind: SessionTaskKind
  /** Agent colour; the session route reads it from `useLocal().agent.color(...)`. */
  color: RGBA
  agent: string
  title: string
  description?: string
  onClick?: () => void
  children?: JSX.Element
}) {
  const { theme } = useTheme()
  const chrome = createMemo(() => sessionTaskChrome(props.kind))
  const badgeBg = createMemo(() => (props.kind === "background" ? theme.status.info.fg : props.color))
  const badgeFg = createMemo(() => selectedForeground(theme, badgeBg()))
  const railColor = createMemo(() => (props.kind === "background" ? theme.status.info.fg : props.color))
  const panel = createMemo(() => {
    const base = theme.surface.panel
    if (props.kind === "background") return tint(base, theme.status.info.fg, 0.1)
    return tint(base, props.color, 0.08)
  })

  return (
    <box
      border={["left"]}
      borderColor={railColor()}
      customBorderChars={{
        ...EmptyBorder,
        vertical: chrome().rail,
      }}
      marginTop={1}
      marginLeft={props.kind === "background" ? 1 : 0}
      paddingLeft={props.kind === "subtask" ? 1 : 0}
      flexShrink={0}
      onMouseUp={() => props.onClick?.()}
    >
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={1} backgroundColor={panel()} flexShrink={0}>
        <text wrapMode="none">
          <span style={{ bg: badgeBg(), fg: badgeFg(), bold: true }}> {chrome().badge} </span>
          <span style={{ fg: railColor() }}> {chrome().glyph} </span>
          <span
            style={{
              fg: theme.foreground.default,
              attributes: TextAttributes.BOLD,
            }}
          >
            {props.title}
          </span>
          <Show when={props.agent && props.agent !== props.title}>
            <span style={{ fg: theme.foreground.muted }}> · @{props.agent}</span>
          </Show>
        </text>
        <Show when={props.description}>
          {(value) => (
            <text fg={theme.foreground.muted} paddingTop={1}>
              {value()}
            </text>
          )}
        </Show>
        {props.children}
        <text fg={theme.foreground.muted} paddingTop={1}>
          {chrome().hint}
        </text>
      </box>
    </box>
  )
}
