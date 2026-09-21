import type { StyleOf } from "../../context/component-tokens"
import type { Theme } from "../../context/theme"

export type SessionStyleRecipe = {
  version: 1
  density: "regular" | "compact"
  userSurface: "panel" | "accent" | "base"
  promptSurface: "panel" | "offset" | "base"
  border: "subtle" | "accent" | "none"
}

export type SessionStyleKV = {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export type SessionStyleScope = "global" | { sessionID: string }

export type SessionStyleTheme = Pick<Theme, "surface" | "foreground" | "accent" | "border" | "status">

export const DEFAULT_SESSION_STYLE: Readonly<SessionStyleRecipe> = Object.freeze({
  version: 1,
  density: "regular",
  userSurface: "panel",
  promptSurface: "offset",
  border: "subtle",
})

const globalKey = "session-studio.style.v1.global"
const sessionKey = (sessionID: string) => `session-studio.style.v1.session.${encodeURIComponent(sessionID)}`

function isRecipe(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && "version" in value && value.version === 1
}

export function hasSessionStyle(kv: Pick<SessionStyleKV, "get">, sessionID?: string): boolean {
  return (sessionID ? isRecipe(kv.get(sessionKey(sessionID))) : false) || isRecipe(kv.get(globalKey))
}

export function normalizeSessionStyle(input: unknown): SessionStyleRecipe {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...DEFAULT_SESSION_STYLE }
  const value = input as Record<string, unknown>
  if (value.version !== 1) return { ...DEFAULT_SESSION_STYLE }
  return {
    version: 1,
    density: value.density === "compact" ? "compact" : "regular",
    userSurface: value.userSurface === "accent" || value.userSurface === "base" ? value.userSurface : "panel",
    promptSurface: value.promptSurface === "panel" || value.promptSurface === "base" ? value.promptSurface : "offset",
    border: value.border === "accent" || value.border === "none" ? value.border : "subtle",
  }
}

export function readSessionStyle(kv: Pick<SessionStyleKV, "get">, sessionID?: string): SessionStyleRecipe {
  const local = sessionID ? kv.get(sessionKey(sessionID)) : undefined
  if (isRecipe(local)) return normalizeSessionStyle(local)
  return normalizeSessionStyle(kv.get(globalKey))
}

export function writeSessionStyle(
  kv: Pick<SessionStyleKV, "set">,
  scope: SessionStyleScope,
  recipe: SessionStyleRecipe | null,
): void {
  if (scope !== "global" && !scope.sessionID.trim()) throw new Error("A session ID is required")
  kv.set(
    scope === "global" ? globalKey : sessionKey(scope.sessionID),
    recipe === null ? null : normalizeSessionStyle(recipe),
  )
}

export function resolveSessionStyle(theme: SessionStyleTheme, recipe: SessionStyleRecipe) {
  const value = normalizeSessionStyle(recipe)
  const paddingY = value.density === "compact" ? 0 : 1
  const paddingX = value.density === "compact" ? 1 : 2
  const borderColor = value.border === "accent" ? theme.accent.border : theme.border.subtle
  return {
    messageGap: paddingY,
    borderColor,
    user: {
      backgroundColor: value.userSurface === "accent" ? theme.accent.bg : theme.surface[value.userSurface],
      hoverBackgroundColor: theme.surface.offset,
      foreground: theme.foreground.default,
      paddingX,
      paddingY,
      border: value.border !== "none",
    },
    prompt: {
      backgroundColor: theme.surface[value.promptSurface],
      foreground: theme.foreground.default,
      paddingX,
      paddingY,
      border: value.border !== "none",
    },
    assistant: { foreground: theme.foreground.default, paddingX, paddingY },
  }
}

export type ResolvedSessionStyle = ReturnType<typeof resolveSessionStyle>

export function resolveUserComponentStyle(
  base: StyleOf<"session.user-message">,
  theme: SessionStyleTheme,
  recipe?: SessionStyleRecipe,
): StyleOf<"session.user-message"> {
  if (!recipe) return base
  const style = resolveSessionStyle(theme, recipe)
  return {
    box: {
      ...base.box,
      paddingTop: style.user.paddingY,
      paddingBottom: style.user.paddingY,
      paddingLeft: style.user.paddingX,
      paddingRight: style.user.paddingX,
      marginTop: style.messageGap,
      borderSides: style.user.border ? ["left"] : [],
      borderCharset: "split",
    },
    colors: {
      background: style.user.backgroundColor,
      backgroundHover: style.user.hoverBackgroundColor,
      text: style.user.foreground,
    },
  }
}
