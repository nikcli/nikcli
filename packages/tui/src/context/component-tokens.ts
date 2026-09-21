import { RGBA } from "@opentui/core"

/**
 * Structural theming for the components the session renders.
 *
 * Colors were already themeable: every component reads `useTheme()`. Shape was
 * not — paddings, margins and borders were literals at the call site, so a
 * theme could recolor a message but never restyle one.
 *
 * Two rules keep this from becoming a second, drifting style system:
 *
 * 1. **Colors are references, never literals.** A component color names either
 *    a semantic token by its dotted path (`surface.panel`, `accent.bg`) or a
 *    key in the active theme document (or its `defs`), resolved by the theme's
 *    own resolver. Either way it is a pointer into the palette, so it cannot
 *    fall out of sync with it. A raw `#rrggbb` is accepted because the theme
 *    grammar accepts one, but a theme that uses them is opting out of its own
 *    palette, not extending it.
 *
 *    Both forms exist, and the catalog's own defaults use the path form
 *    exclusively. A flat key is resolved by the theme document's grammar, which
 *    consults `defs` *before* the theme's own colors — and several built-in
 *    themes define a `def` sharing a name with a theme key. `monokai` declares
 *    `backgroundPanel` in both places with different values, so the default
 *    `"backgroundPanel"` painted the user message with the wrong one on seven
 *    built-in themes. A semantic path reads the resolved theme directly and
 *    cannot be shadowed.
 *
 *    Some semantic tokens are derived and have no key at all — `accent.bg` is a
 *    tint of two document colors — so the path form is also the only way to
 *    name those. The flat form stays for theme authors patching with the
 *    vocabulary their document already speaks.
 * 2. **Structure is a closed whitelist.** Only the fields below, only within
 *    the stated bounds. Passing arbitrary renderable props through would make
 *    every layout bug a theme bug and freeze each component's internal box
 *    structure as public API.
 */

export type BorderSide = "top" | "right" | "bottom" | "left"

/** Named border character sets. Maps to the host's `customBorderChars` tables. */
/**
 * `"default"` leaves the renderer's own table in place; every other name picks
 * one of ours. It exists so a component whose border was never customised can
 * join the catalog without its glyphs changing.
 */
export type BorderCharset = "default" | "none" | "single" | "rounded" | "double" | "heavy" | "split"

const BORDER_SIDES: readonly BorderSide[] = ["top", "right", "bottom", "left"]
/** Exported so an editor can offer the set rather than hardcode a second copy of it. */
export const BORDER_CHARSETS: readonly BorderCharset[] = [
  "default",
  "none",
  "single",
  "rounded",
  "double",
  "heavy",
  "split",
]

/**
 * Spacing bounds. A negative pad is a renderer crash and a huge one is a blank
 * screen the user cannot undo without editing JSON by hand, so both ends clamp
 * rather than reject: a bad value degrades the component, never the session.
 */
const SPACING_MIN = 0
const SPACING_MAX = 8

export type BoxStyle = {
  readonly paddingTop: number
  readonly paddingBottom: number
  readonly paddingLeft: number
  readonly paddingRight: number
  readonly marginTop: number
  readonly marginBottom: number
  readonly gap: number
  /**
   * Mutable because the renderable's `border` prop takes a mutable array. Built
   * once per resolution and treated as frozen here.
   *
   * Call sites copy it. One array per resolution means one array shared by every
   * renderable reading that entry — every user message in the transcript holds
   * the same instance — and `Box` keeps the reference it is handed. Before this
   * layer each of those was its own literal, so copying is what keeps the
   * renderables independent the way they already were. The copy is made inside
   * a JSX attribute effect, which re-runs only when the style changes, not per
   * frame.
   */
  readonly borderSides: BorderSide[]
  readonly borderCharset: BorderCharset
}

const BOX_KEYS = [
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "marginTop",
  "marginBottom",
  "gap",
] as const satisfies readonly (keyof BoxStyle)[]

/** What a component declares: its box, plus the palette keys it paints with. */
export type ComponentSpec = {
  readonly box: BoxStyle
  readonly colors: Readonly<Record<string, string>>
}

/** What a component receives: the same shape, with colors resolved to RGBA. */
export type ComponentStyle<Spec extends ComponentSpec = ComponentSpec> = {
  readonly box: BoxStyle
  readonly colors: { readonly [Key in keyof Spec["colors"]]: RGBA }
}

function box(input: Partial<BoxStyle>): BoxStyle {
  return {
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
    marginTop: 0,
    marginBottom: 0,
    gap: 0,
    borderSides: [],
    borderCharset: "none",
    ...input,
  }
}

/**
 * The catalog. Every entry reproduces what its component hardcodes today, so
 * adopting this layer is a no-op until a theme overrides something — the
 * migration is verifiable by capturing a frame before and after.
 */
export const COMPONENT_DEFAULTS = {
  /** `routes/session/parts/user-message.tsx` */
  "session.user-message": {
    box: box({
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      marginTop: 1,
      borderSides: ["left"],
      borderCharset: "split",
    }),
    colors: {
      background: "surface.panel",
      backgroundHover: "surface.offset",
      text: "foreground.default",
    },
  },
  /**
   * `TextPart`. The body is `foreground.default`, not `markdown.text`: the
   * markdown tokens apply inside the rendered document, while this is the plain
   * fallback the part paints when it is not rendering markdown.
   */
  "session.text-part": {
    box: box({ paddingLeft: 3, marginTop: 1 }),
    colors: {
      text: "foreground.default",
    },
  },
  /**
   * `ReasoningPart`. Box only. Its body is colored by `subtleSyntax`, a whole
   * derived palette rather than a slot, and exposing that as one overridable
   * color would let a theme set a value the renderer then ignores.
   */
  "session.reasoning-part": {
    box: box({ paddingLeft: 2, marginTop: 1, borderSides: ["left"], borderCharset: "split" }),
    colors: {
      heading: "status.warning.fg",
      border: "surface.offset",
    },
  },
  /** `RetryPart`. */
  "session.retry-part": {
    box: box({ paddingLeft: 3, marginTop: 1 }),
    colors: {
      icon: "status.warning.fg",
      text: "foreground.muted",
    },
  },
  /** `SyntheticPart`. */
  "session.synthetic-part": {
    box: box({ paddingLeft: 3, marginTop: 1 }),
    colors: {
      text: "foreground.muted",
    },
  },
  /**
   * `UnknownPart`. It has an entry for the same reason it exists at all: a row
   * standing in for something the renderer does not understand should be able
   * to look like one, rather than being the single row a theme cannot touch.
   */
  "session.unknown-part": {
    box: box({ paddingLeft: 3, marginTop: 1 }),
    colors: {
      text: "foreground.muted",
    },
  },
  /**
   * The prompt's input box (`component/prompt`).
   *
   * `paddingBottom` is 0 where the other three are not: the footer row below the
   * textarea supplies that gap itself, and padding here would double it.
   */
  "session.prompt": {
    box: box({
      paddingTop: 1,
      paddingBottom: 0,
      paddingLeft: 2,
      paddingRight: 2,
      // The space between the input and the agent/model footer. Its own field,
      // because the footer borrowing `paddingTop` tied two separate decisions
      // together: they happen to both be 1, so nothing looked wrong, and a
      // theme touching the box's top pad would have moved the footer with it.
      gap: 1,
      borderSides: ["left"],
      borderCharset: "split",
    }),
    colors: {
      background: "surface.offset",
    },
  },
  /**
   * The card for a delegated run (`component/session-task-card`).
   *
   * No border charset: the card supplies the rail glyph itself, because that
   * glyph is how a nested subtask and a parallel background job tell themselves
   * apart, and that is a distinction the card owns rather than the theme.
   */
  "session.task-card": {
    box: box({
      marginTop: 1,
      paddingLeft: 2,
      paddingRight: 1,
      borderSides: ["left"],
      borderCharset: "none",
    }),
    colors: {
      title: "foreground.default",
      detail: "foreground.muted",
      /** The trailing marker that says what a click will do. */
      marker: "foreground.subtle",
    },
  },
  /**
   * The rule under the prompt: a `▀` half-block tinted with the input's own
   * background, so the box reads as sitting above the transcript.
   *
   * It is its own entry rather than a flag on `session.prompt` because that is
   * how the catalog says "optional": an empty `borderSides` removes the row
   * entirely, and a theme that wants the prompt flush against the status line
   * sets it to `[]`. The default is what the prompt has always drawn.
   */
  "session.prompt-shadow": {
    box: box({ borderSides: ["bottom"], borderCharset: "none" }),
    colors: {
      fill: "surface.offset",
    },
  },
  /**
   * The session tab strip (`component/session-tabs`).
   *
   * Vertical padding here sets the strip's height through {@link tabRows}; the
   * strip has no `marginTop`, because it is the top of the screen.
   */
  "session.tabs": {
    box: box({
      paddingTop: 1,
      paddingBottom: 1,
      borderSides: ["bottom"],
      // The strip never passed a table; keeping that is what makes adopting the
      // catalog invisible here.
      borderCharset: "default",
    }),
    colors: {
      background: "surface.panel",
      border: "border.subtle",
      /**
       * The left edge of the selected tab.
       *
       * `accent.fg` is the token the strip painted this with. Worth naming the
       * trap: the flat `accent` key is a *different* color — it is what
       * `accent.alt` resolves to — and using it here recolored the selected tab
       * on every theme without failing anything.
       */
      activeBorder: "accent.fg",
      activeBackground: "surface.offset",
    },
  },
} as const satisfies Record<string, ComponentSpec>

export type ComponentId = keyof typeof COMPONENT_DEFAULTS

export type StyleOf<Id extends ComponentId> = ComponentStyle<(typeof COMPONENT_DEFAULTS)[Id]>

export const COMPONENT_IDS = Object.keys(COMPONENT_DEFAULTS) as ComponentId[]

/**
 * A patch as it appears in a theme document's `components` section or in a
 * user's `components.json`. Every field is optional and untrusted: this is
 * hand-edited JSON, so it is validated field by field rather than parsed.
 */
export type ComponentPatch = {
  readonly box?: Partial<Record<keyof BoxStyle, unknown>>
  readonly colors?: Readonly<Record<string, unknown>>
}

export type ComponentPatchMap = Readonly<Record<string, ComponentPatch>>

/**
 * Resolves one color reference, or reports why it could not.
 *
 * The theme's own resolver throws on an unknown reference — correct for a theme
 * document, where a typo should surface loudly at load. It is wrong here: these
 * patches arrive from files the user edits by hand, and one typo must not take
 * the palette, and with it the whole TUI, down with it. So the resolver is
 * passed in and its failure is caught by the caller below.
 */
export type ColorResolver = (ref: string) => RGBA

export type ComponentWarning = {
  readonly id: string
  readonly field: string
  readonly reason: string
}

function clampSpacing(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.min(SPACING_MAX, Math.max(SPACING_MIN, Math.round(value)))
}

/**
 * Reads a border-side list, reporting each entry it could not use.
 *
 * Reporting matters more here than anywhere else in this file: a mistyped side
 * does not degrade the border, it *removes* it — `["lefy"]` reads as "no
 * border at all" — and a border disappearing is indistinguishable from a theme
 * that meant to remove it. Every other malformed field in this module is
 * announced; this one used to be the exception.
 */
function readBorderSides(value: unknown, id: string, warn: ComponentWarning[]): BorderSide[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sides: BorderSide[] = []
  for (const entry of value) {
    if (typeof entry === "string" && BORDER_SIDES.includes(entry as BorderSide)) {
      const side = entry as BorderSide
      if (!sides.includes(side)) sides.push(side)
      continue
    }
    warn.push({
      id,
      field: "box.borderSides",
      reason: `${JSON.stringify(entry)} is not one of ${BORDER_SIDES.join(", ")}`,
    })
  }
  return sides
}

function readCharset(value: unknown): BorderCharset | undefined {
  if (typeof value !== "string") return undefined
  return BORDER_CHARSETS.includes(value as BorderCharset) ? (value as BorderCharset) : undefined
}

function mergeBox(base: BoxStyle, patch: ComponentPatch["box"], id: string, warn: ComponentWarning[]): BoxStyle {
  if (!patch) return base
  const next: Record<string, unknown> = { ...base }

  for (const key of BOX_KEYS) {
    if (!(key in patch)) continue
    const raw = patch[key]
    const value = clampSpacing(raw)
    if (value === undefined) {
      warn.push({ id, field: `box.${key}`, reason: "expected a finite number" })
      continue
    }
    // Clamping keeps the session usable, but it also means the theme did not
    // get what it asked for. Saying so is the difference between a degraded
    // value and a silent one, which this module refuses everywhere else.
    if (value !== raw) {
      warn.push({ id, field: `box.${key}`, reason: `${raw} is outside ${SPACING_MIN}..${SPACING_MAX}, using ${value}` })
    }
    next[key] = value
  }

  if ("borderSides" in patch) {
    const sides = readBorderSides(patch.borderSides, id, warn)
    if (sides === undefined) warn.push({ id, field: "box.borderSides", reason: "expected an array of sides" })
    else next.borderSides = sides
  }

  if ("borderCharset" in patch) {
    const charset = readCharset(patch.borderCharset)
    if (charset === undefined)
      warn.push({ id, field: "box.borderCharset", reason: `expected one of ${BORDER_CHARSETS.join(", ")}` })
    else next.borderCharset = charset
  }

  return next as BoxStyle
}

/**
 * Merges color references, then resolves them.
 *
 * A patch may only override a slot the component declares. Adding an unknown
 * slot is dropped with a warning rather than carried: a component reads its
 * slots by name, so an invented one would silently do nothing, and a silent
 * no-op is the worst outcome for someone editing a theme by hand.
 */
function mergeColors(
  base: Readonly<Record<string, string>>,
  patch: ComponentPatch["colors"],
  resolve: ColorResolver,
  id: string,
  warn: ComponentWarning[],
): Record<string, RGBA> {
  const refs: Record<string, string> = { ...base }

  if (patch) {
    for (const [slot, value] of Object.entries(patch)) {
      if (!(slot in base)) {
        warn.push({ id, field: `colors.${slot}`, reason: "unknown color slot for this component" })
        continue
      }
      if (typeof value !== "string" || value.length === 0) {
        warn.push({ id, field: `colors.${slot}`, reason: "expected a color reference or #rrggbb" })
        continue
      }
      refs[slot] = value
    }
  }

  const resolved: Record<string, RGBA> = {}
  for (const [slot, ref] of Object.entries(refs)) {
    try {
      resolved[slot] = resolve(ref)
    } catch {
      // The override named something the active theme does not define. Fall
      // back to the component's own default, which the catalog guarantees is a
      // key every theme carries. If even that fails the theme itself is broken,
      // and letting it throw here is right — that is a load error, not a patch.
      warn.push({ id, field: `colors.${slot}`, reason: `unresolved color reference "${ref}"` })
      resolved[slot] = resolve(base[slot]!)
    }
  }
  return resolved
}

export type ResolvedComponents = {
  readonly styles: { readonly [Id in ComponentId]: StyleOf<Id> }
  readonly warnings: readonly ComponentWarning[]
}

/**
 * Builds every component style for one theme.
 *
 * Runs once per (theme, mode, overrides) change, never per frame and never per
 * token: the session's streaming parts re-render on every delta, and a merge in
 * that path is exactly the per-token cost this repo has paid for before.
 *
 * Patches apply in order, each overriding the last: the theme document first,
 * then the user's `components.json`, then any plugin override.
 */
export function resolveComponents(resolve: ColorResolver, patches: readonly ComponentPatchMap[]): ResolvedComponents {
  const warnings: ComponentWarning[] = []
  const styles = {} as Record<ComponentId, ComponentStyle>

  for (const id of COMPONENT_IDS) {
    const spec = COMPONENT_DEFAULTS[id] as ComponentSpec
    let boxStyle = spec.box
    let colorRefs: Record<string, unknown> = {}

    for (const map of patches) {
      const patch = map[id]
      if (!patch) continue
      boxStyle = mergeBox(boxStyle, patch.box, id, warnings)
      if (patch.colors) colorRefs = { ...colorRefs, ...patch.colors }
    }

    styles[id] = {
      box: boxStyle,
      colors: mergeColors(spec.colors, colorRefs, resolve, id, warnings),
    }
  }

  return { styles: styles as ResolvedComponents["styles"], warnings }
}

/**
 * Vertical rows a turn spends on chrome rather than content.
 *
 * `estimateTurnHeight` hardcoded this as 3 — the user message's own
 * `paddingTop + paddingBottom + marginTop`, duplicated as a constant in another
 * file. That duplication was harmless only while both were literals. The moment
 * a theme can change the padding, the estimator starts lying, the virtualizer
 * mis-reserves, and the scroll offset drifts — a bug that would read as a
 * renderer fault, not a theming one. Deriving it from the same style closes
 * that gap by construction.
 */
export function chromeRows(style: Pick<BoxStyle, "paddingTop" | "paddingBottom" | "marginTop" | "marginBottom">) {
  return style.paddingTop + style.paddingBottom + style.marginTop + style.marginBottom
}

/**
 * Rows the tab strip occupies, derived from its own style.
 *
 * One row of text plus its vertical padding, with the border counted separately
 * by the caller. The floor is 2 rather than 1 because the strip's right-hand
 * chrome stacks two one-row buttons (`+ new` and close-all): at a single row the
 * second one is clipped by `overflow: hidden` and the user loses an action with
 * no way to tell it was ever there.
 */
export function tabRows(style: Pick<BoxStyle, "paddingTop" | "paddingBottom">) {
  return Math.max(2, 1 + style.paddingTop + style.paddingBottom)
}

/**
 * The resolver component colors are resolved through.
 *
 * Tries the dotted semantic path first, then hands anything else to the theme
 * document's own resolver. Ordering matters only in that a document key can
 * never contain a dot, so the two namespaces cannot collide.
 *
 * `semantic` is the resolved theme, structurally: typing it as `Theme` would
 * make this module import `theme.tsx`, which imports this one.
 */
export function createComponentResolver(semantic: object, document: ColorResolver): ColorResolver {
  return (ref) => {
    if (!ref.includes(".")) return document(ref)
    let node: unknown = semantic
    for (const key of ref.split(".")) {
      if (typeof node !== "object" || node === null) return document(ref)
      node = (node as Record<string, unknown>)[key]
    }
    if (node instanceof RGBA) return node
    // Not a color, or not there at all. Falling through to the document
    // resolver means the failure is reported in one place, with one message,
    // whichever namespace the author meant.
    return document(ref)
  }
}

/** Reads a `components` section off an untrusted document. Shape only. */
export function readComponentPatches(value: unknown): ComponentPatchMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const out: Record<string, ComponentPatch> = {}
  for (const [id, patch] of Object.entries(value as Record<string, unknown>)) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) continue
    const entry = patch as Record<string, unknown>
    const box = typeof entry.box === "object" && entry.box !== null ? (entry.box as ComponentPatch["box"]) : undefined
    const colors =
      typeof entry.colors === "object" && entry.colors !== null ? (entry.colors as ComponentPatch["colors"]) : undefined
    if (!box && !colors) continue
    out[id] = { box, colors }
  }
  return out
}
