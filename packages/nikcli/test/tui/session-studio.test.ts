import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import { chromeRows, COMPONENT_DEFAULTS, resolveComponents } from "@tui/context/component-tokens"
import {
  DEFAULT_SESSION_STYLE,
  hasSessionStyle,
  normalizeSessionStyle,
  readSessionStyle,
  resolveSessionStyle,
  resolveUserComponentStyle,
  writeSessionStyle,
  type SessionStyleKV,
  type SessionStyleTheme,
} from "@tui/feature-plugins/session-studio/settings"

function rgb(r: number, g: number, b: number) {
  return RGBA.fromInts(r, g, b)
}

function theme(
  overrides: Partial<{
    panel: RGBA
    offset: RGBA
    base: RGBA
    accentBg: RGBA
    accentBorder: RGBA
  }>,
): SessionStyleTheme {
  return {
    surface: {
      base: overrides.base ?? rgb(7, 7, 7),
      panel: overrides.panel ?? rgb(18, 18, 18),
      offset: overrides.offset ?? rgb(36, 36, 36),
      overlay: rgb(27, 27, 27),
    },
    foreground: {
      default: rgb(230, 230, 230),
      muted: rgb(154, 154, 154),
      subtle: rgb(90, 90, 90),
    },
    accent: {
      fg: rgb(111, 163, 255),
      bg: overrides.accentBg ?? rgb(40, 60, 90),
      border: overrides.accentBorder ?? rgb(90, 140, 220),
      alt: rgb(139, 180, 255),
      secondary: rgb(180, 140, 255),
    },
    border: {
      default: rgb(74, 74, 74),
      subtle: rgb(58, 58, 58),
      active: rgb(111, 163, 255),
      focus: rgb(90, 140, 220),
    },
    status: {
      error: { fg: rgb(255, 80, 80), bg: rgb(40, 16, 16) },
      warning: { fg: rgb(255, 180, 60), bg: rgb(40, 32, 8) },
      success: { fg: rgb(80, 200, 120), bg: rgb(20, 40, 24) },
      info: { fg: rgb(100, 180, 255), bg: rgb(16, 28, 48) },
    },
  }
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

const PALETTE: Record<string, RGBA> = {
  backgroundPanel: rgb(18, 18, 18),
  backgroundElement: rgb(36, 36, 36),
  text: rgb(230, 230, 230),
  textMuted: rgb(154, 154, 154),
  markdownText: rgb(230, 230, 230),
  warning: rgb(217, 161, 74),
}

describe("session studio recipes", () => {
  it("falls back to the live default until the user applies a recipe", () => {
    const store = kv()
    expect(hasSessionStyle(store)).toBe(false)
    expect(hasSessionStyle(store, "ses_1")).toBe(false)
    expect(readSessionStyle(store)).toEqual({ ...DEFAULT_SESSION_STYLE })
  })

  it("rejects unknown fields and versions instead of carrying them", () => {
    expect(
      normalizeSessionStyle({
        version: 2,
        density: "compact",
        userSurface: "accent",
      }),
    ).toEqual({ ...DEFAULT_SESSION_STYLE })
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
    writeSessionStyle(store, "global", {
      ...DEFAULT_SESSION_STYLE,
      density: "compact",
    })
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
    writeSessionStyle(store, "global", {
      ...DEFAULT_SESSION_STYLE,
      promptSurface: "panel",
    })
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

  it("resolves colors from the live theme, not stored hex", () => {
    const recipe = {
      ...DEFAULT_SESSION_STYLE,
      userSurface: "accent" as const,
      border: "accent" as const,
    }
    const dark = theme({
      accentBg: rgb(40, 60, 90),
      accentBorder: rgb(90, 140, 220),
    })
    const light = theme({
      accentBg: rgb(200, 220, 255),
      accentBorder: rgb(20, 80, 180),
    })

    const first = resolveSessionStyle(dark, recipe)
    const second = resolveSessionStyle(light, recipe)

    expect(first.user.backgroundColor).toEqual(dark.accent.bg)
    expect(first.borderColor).toEqual(dark.accent.border)
    expect(second.user.backgroundColor).toEqual(light.accent.bg)
    expect(second.borderColor).toEqual(light.accent.border)
    expect(first.prompt.backgroundColor).toEqual(dark.surface.offset)
  })

  it("compacts user-message chrome without changing the catalog default", () => {
    const { styles } = resolveComponents((ref) => {
      const found = PALETTE[ref]
      if (!found) throw new Error(ref)
      return found
    }, [])
    const base = styles["session.user-message"]
    expect(chromeRows(base.box)).toBe(3)

    const compact = resolveUserComponentStyle(base, theme({}), {
      ...DEFAULT_SESSION_STYLE,
      density: "compact",
      border: "none",
    })
    expect(compact.box.paddingTop).toBe(0)
    expect(compact.box.paddingLeft).toBe(1)
    expect(compact.box.borderSides).toEqual([])
    expect(chromeRows(compact.box)).toBe(0)
    expect(resolveUserComponentStyle(base, theme({}))).toBe(base)
    expect(COMPONENT_DEFAULTS["session.user-message"].box.paddingTop).toBe(1)
  })
})
