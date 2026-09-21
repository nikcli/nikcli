import type { ComponentPatchMap } from "./component-tokens"

/**
 * The presentation preset `/studio` edits, and its translation into component
 * patches.
 *
 * This is deliberately *not* a second style system. A recipe is four knobs that
 * compile down to the same {@link ComponentPatchMap} a theme document and a
 * user's `components.json` produce, and it is applied as the last layer of the
 * same merge. So a recipe cannot reach anything a hand-written patch could not,
 * every surface it touches is one the catalog already declares, and what the
 * user sees is always one resolution of one catalog.
 *
 * It lives in `context/` rather than beside the dialog because the theme
 * resolves it: `feature-plugins/session-studio` owns the editor, not the
 * vocabulary. A component never learns that recipes exist — it reads
 * `component(id)` and gets the merged answer.
 */

export type SessionStyleRecipe = {
  version: 1
  density: "regular" | "compact"
  userSurface: "panel" | "accent" | "base"
  promptSurface: "panel" | "offset" | "base"
  border: "subtle" | "accent" | "none"
  /**
   * How the words are set.
   *
   * The only part of "which font" a terminal yields: the typeface is the
   * emulator's and nothing here can reach it, but weight and dimming are ours.
   * `quiet` steps the transcript back, `strong` brings the titles forward.
   */
  emphasis: "regular" | "quiet" | "strong"
}

export type SessionStyleKV = {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export type SessionStyleScope = "global" | { sessionID: string }

export const DEFAULT_SESSION_STYLE: Readonly<SessionStyleRecipe> = Object.freeze({
  version: 1,
  density: "regular",
  userSurface: "panel",
  promptSurface: "offset",
  border: "subtle",
  emphasis: "regular",
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
    emphasis: value.emphasis === "quiet" || value.emphasis === "strong" ? value.emphasis : "regular",
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

/**
 * Surfaces, as semantic token paths.
 *
 * `accent.bg` is the reason component colors accept a dotted path at all: it is
 * derived from two document colors and has no key of its own, so a patch that
 * wants the accent fill has no other way to name it.
 */
const SURFACE = {
  panel: "surface.panel",
  offset: "surface.offset",
  base: "surface.base",
  accent: "accent.bg",
} as const

const BORDER = {
  subtle: "border.subtle",
  accent: "accent.border",
} as const

/** What one density step means, in rows and columns. */
function spacing(density: SessionStyleRecipe["density"]) {
  return density === "compact" ? { y: 0, x: 1 } : { y: 1, x: 2 }
}

/**
 * Compiles a recipe into patches for the three surfaces it governs.
 *
 * Only the fields the recipe actually decides are emitted. Everything else —
 * the reasoning block's border, the text part's left pad, the user message's
 * hover fill — is left to the layers underneath, so applying a preset does not
 * quietly discard a theme's opinion about the rows it never mentions.
 */
export function recipeToPatches(input: SessionStyleRecipe): ComponentPatchMap {
  const recipe = normalizeSessionStyle(input)
  const { x, y } = spacing(recipe.density)
  const borderColor = recipe.border === "none" ? undefined : BORDER[recipe.border]

  // `quiet` dims the body and its metadata; `strong` bolds what titles things.
  // Both leave the assistant's prose alone — markdown carries its own emphasis,
  // and dimming a rendered document fights the syntax colours inside it.
  const emphasis =
    recipe.emphasis === "quiet"
      ? { body: { dim: true }, detail: { dim: true }, title: { bold: false } }
      : recipe.emphasis === "strong"
        ? { body: { bold: true }, detail: { dim: false }, title: { bold: true } }
        : { body: { bold: false, dim: false }, detail: { dim: false }, title: { bold: true } }

  return {
    "session.task-card": {
      text: { title: emphasis.title, detail: emphasis.detail },
    },
    "session.user-message": {
      box: {
        paddingTop: y,
        paddingBottom: y,
        paddingLeft: x,
        paddingRight: x,
        // The gap between messages is the same step as the padding inside one:
        // a compact transcript that kept a blank row between turns would not
        // read as compact.
        marginTop: y,
        borderSides: recipe.border === "none" ? [] : ["left"],
      },
      colors: { background: SURFACE[recipe.userSurface] },
      text: { body: emphasis.body, detail: emphasis.detail },
    },
    "session.prompt": {
      box: {
        paddingTop: y,
        paddingBottom: y,
        paddingLeft: x,
        paddingRight: x,
        borderSides: recipe.border === "none" ? [] : ["left"],
      },
      colors: { background: SURFACE[recipe.promptSurface] },
    },
    "session.tabs": {
      box: {
        paddingTop: y,
        paddingBottom: y,
        borderSides: recipe.border === "none" ? [] : ["bottom"],
      },
      // A recipe that names a border names *the* border: the strip's underline
      // and the selected tab's edge stop being two decisions the moment the
      // user has made one.
      colors: borderColor ? { border: borderColor, activeBorder: borderColor } : {},
    },
  }
}

/**
 * The preset that applies to one session, as a value that compares by content.
 *
 * The theme keys its patch layer on this rather than on the session id, and the
 * distinction is the whole point. Keyed by id, the component catalog depends on
 * the route: every navigation rebuilds it, every rebuild allocates fresh style
 * objects, and every mounted part reacts to an identity change that means
 * nothing. That shipped in 1.380; this exists so it cannot come back.
 *
 * The empty string means "no preset anywhere" — the state of every session
 * until somebody opens the studio — so on the default path two different
 * sessions produce the same key and nothing downstream is invalidated.
 */
export function sessionStyleKey(kv: Pick<SessionStyleKV, "get">, sessionID?: string): string {
  if (!hasSessionStyle(kv, sessionID)) return ""
  return JSON.stringify(normalizeSessionStyle(readSessionStyle(kv, sessionID)))
}

/** The patch layer for a key from {@link sessionStyleKey}, or nothing when it is empty. */
export function patchesForKey(key: string): ComponentPatchMap | undefined {
  return key ? recipeToPatches(JSON.parse(key) as SessionStyleRecipe) : undefined
}
