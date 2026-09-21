import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  chromeRows,
  COMPONENT_DEFAULTS,
  COMPONENT_IDS,
  createComponentResolver,
  resolveComponents,
  tabRows,
} from "@tui/context/component-tokens"
import {
  DEFAULT_SESSION_STYLE,
  hasSessionStyle,
  normalizeSessionStyle,
  readSessionStyle,
  recipeToPatches,
  sessionStylePatches,
  writeSessionStyle,
  type SessionStyleKV,
} from "@tui/context/session-style"

function rgb(r: number, g: number, b: number) {
  return RGBA.fromInts(r, g, b)
}

function kv(initial: Record<string, unknown> = {}): SessionStyleKV & { store: Record<string, unknown> } {
  const store = { ...initial }
  return {
    store,
    get(key) {
      return store[key]
    },
    set(key, value) {
      store[key] = value
    },
  }
}

/** The flat document keys the catalog's own defaults name. */
const PALETTE: Record<string, RGBA> = {
  backgroundPanel: rgb(18, 18, 18),
  backgroundElement: rgb(36, 36, 36),
  borderSubtle: rgb(58, 58, 58),
  accent: rgb(111, 163, 255),
  primary: rgb(111, 163, 255),
  text: rgb(230, 230, 230),
  textMuted: rgb(154, 154, 154),
  warning: rgb(217, 161, 74),
}

/** The derived tokens a recipe reaches by path. */
const SEMANTIC = {
  surface: { base: rgb(7, 7, 7), panel: rgb(18, 18, 18), offset: rgb(36, 36, 36) },
  accent: { fg: rgb(111, 163, 255), bg: rgb(40, 60, 90), border: rgb(90, 140, 220) },
  border: { subtle: rgb(58, 58, 58), active: rgb(111, 163, 255) },
}

const resolver = createComponentResolver(SEMANTIC, (ref) => {
  const found = PALETTE[ref]
  if (!found) throw new Error(`unknown ${ref}`)
  return found
})

const resolve = (patches: Parameters<typeof resolveComponents>[1]) => resolveComponents(resolver, patches)

describe("session style recipes", () => {
  it("falls back to the live default until the user applies a recipe", () => {
    const store = kv()
    expect(hasSessionStyle(store)).toBe(false)
    expect(hasSessionStyle(store, "ses_1")).toBe(false)
    expect(readSessionStyle(store)).toEqual({ ...DEFAULT_SESSION_STYLE })
    expect(sessionStylePatches(store, "ses_1")).toBeUndefined()
  })

  it("rejects unknown fields and versions instead of carrying them", () => {
    expect(normalizeSessionStyle({ version: 2, density: "compact", userSurface: "accent" })).toEqual({
      ...DEFAULT_SESSION_STYLE,
    })
    expect(
      normalizeSessionStyle({
        version: 1,
        density: "huge",
        userSurface: "neon",
        promptSurface: "glass",
        border: "dotted",
        extra: true,
      }),
    ).toEqual({ ...DEFAULT_SESSION_STYLE })
  })

  it("keeps a session override isolated from the global recipe", () => {
    const store = kv()
    writeSessionStyle(store, "global", { ...DEFAULT_SESSION_STYLE, density: "compact" })
    writeSessionStyle(
      store,
      { sessionID: "ses_a" },
      { ...DEFAULT_SESSION_STYLE, userSurface: "accent", border: "none" },
    )

    expect(hasSessionStyle(store)).toBe(true)
    expect(readSessionStyle(store).density).toBe("compact")
    expect(readSessionStyle(store, "ses_a").userSurface).toBe("accent")
    expect(readSessionStyle(store, "ses_b").density).toBe("compact")
  })

  it("inherits the global recipe after a session override is cleared", () => {
    const store = kv()
    writeSessionStyle(store, "global", { ...DEFAULT_SESSION_STYLE, promptSurface: "panel" })
    writeSessionStyle(store, { sessionID: "ses_a" }, { ...DEFAULT_SESSION_STYLE, density: "compact" })
    writeSessionStyle(store, { sessionID: "ses_a" }, null)

    expect(readSessionStyle(store, "ses_a").promptSurface).toBe("panel")
    expect(readSessionStyle(store, "ses_a").density).toBe("regular")
    expect(hasSessionStyle(store, "ses_a")).toBe(true)
  })

  it("refuses to write a session recipe without an id", () => {
    const store = kv()
    expect(() => writeSessionStyle(store, { sessionID: "  " }, { ...DEFAULT_SESSION_STYLE })).toThrow(
      "A session ID is required",
    )
  })
})

/**
 * The reason this file exists at all: a recipe is a patch layer, not a second
 * style system. Every assertion below is about that being literally true —
 * the recipe can only say things a hand-written `components.json` could say,
 * and it is resolved by the same merge.
 */
describe("a recipe is nothing but component patches", () => {
  it("only names components the catalog declares, and slots they own", () => {
    for (const recipe of [
      { ...DEFAULT_SESSION_STYLE },
      { ...DEFAULT_SESSION_STYLE, density: "compact" as const, userSurface: "accent" as const },
      { ...DEFAULT_SESSION_STYLE, border: "none" as const, promptSurface: "base" as const },
      { ...DEFAULT_SESSION_STYLE, border: "accent" as const, userSurface: "base" as const },
    ]) {
      const patches = recipeToPatches(recipe)
      for (const id of Object.keys(patches)) expect(COMPONENT_IDS).toContain(id as never)
      // A warning is how the resolver reports a patch it had to drop. None
      // means every field and every color reference landed somewhere real.
      expect(resolve([patches]).warnings).toEqual([])
    }
  })

  it("resolves surfaces through the live theme rather than storing colors", () => {
    const accent = resolve([recipeToPatches({ ...DEFAULT_SESSION_STYLE, userSurface: "accent", border: "accent" })])
    expect(accent.styles["session.user-message"].colors.background).toEqual(SEMANTIC.accent.bg)
    expect(accent.styles["session.tabs"].colors.border).toEqual(SEMANTIC.accent.border)
    expect(accent.styles["session.tabs"].colors.activeBorder).toEqual(SEMANTIC.accent.border)

    const base = resolve([recipeToPatches({ ...DEFAULT_SESSION_STYLE, userSurface: "base" })])
    expect(base.styles["session.user-message"].colors.background).toEqual(SEMANTIC.surface.base)
  })

  it("compacts every surface at once, and the estimator follows", () => {
    const stock = resolve([])
    expect(chromeRows(stock.styles["session.user-message"].box)).toBe(3)
    expect(tabRows(stock.styles["session.tabs"].box)).toBe(3)

    const compact = resolve([recipeToPatches({ ...DEFAULT_SESSION_STYLE, density: "compact", border: "none" })])
    const message = compact.styles["session.user-message"]
    expect(message.box.paddingTop).toBe(0)
    expect(message.box.paddingLeft).toBe(1)
    expect(message.box.borderSides).toEqual([])
    expect(chromeRows(message.box)).toBe(0)
    expect(compact.styles["session.prompt"].box.borderSides).toEqual([])
    // Floored at 2: the strip's right-hand chrome stacks two one-row buttons,
    // and a one-row strip clips the second with nothing to show it was there.
    expect(tabRows(compact.styles["session.tabs"].box)).toBe(2)
  })

  it("leaves the catalog default untouched, so a recipe is removable", () => {
    resolve([recipeToPatches({ ...DEFAULT_SESSION_STYLE, density: "compact" })])
    expect(COMPONENT_DEFAULTS["session.user-message"].box.paddingTop).toBe(1)
    expect(resolve([]).styles["session.user-message"].box.paddingTop).toBe(1)
  })

  it("does not disturb the rows it says nothing about", () => {
    // The reasoning block and the text part have no knob in the studio. A
    // preset that silently restyled them would be the old failure — two
    // systems disagreeing — wearing the new layer's clothes.
    const stock = resolve([])
    const compact = resolve([recipeToPatches({ ...DEFAULT_SESSION_STYLE, density: "compact", border: "none" })])
    for (const id of ["session.text-part", "session.reasoning-part", "session.retry-part"] as const) {
      expect(compact.styles[id].box).toEqual(stock.styles[id].box)
    }
  })

  it("loses to nothing, and wins over a hand-written patch on the same field", () => {
    // Order is theme document, then `components.json`, then the preset. The
    // user's file keeps every field the preset does not mention.
    const byHand = { "session.user-message": { box: { paddingLeft: 7, marginBottom: 2 } } }
    const merged = resolve([byHand, recipeToPatches({ ...DEFAULT_SESSION_STYLE, density: "compact" })])
    expect(merged.styles["session.user-message"].box.paddingLeft).toBe(1)
    expect(merged.styles["session.user-message"].box.marginBottom).toBe(2)
  })
})

describe("component color references", () => {
  it("reaches a derived token by path and a document color by key", () => {
    expect(resolver("accent.bg")).toEqual(SEMANTIC.accent.bg)
    expect(resolver("backgroundPanel")).toEqual(PALETTE.backgroundPanel!)
  })

  it("hands an unknown path to the document resolver, so one typo reports once", () => {
    expect(() => resolver("accent.invented")).toThrow("unknown accent.invented")
    expect(() => resolver("surface.nope.deeper")).toThrow("unknown surface.nope.deeper")
  })
})
