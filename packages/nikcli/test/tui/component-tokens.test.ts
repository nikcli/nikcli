import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  chromeRows,
  COMPONENT_DEFAULTS,
  createComponentResolver,
  readComponentPatches,
  resolveComponents,
  type ComponentPatchMap,
} from "@tui/context/component-tokens"

/**
 * Stands in for the theme's resolver: known palette keys resolve, anything else
 * throws exactly as `createColorResolver` does on an unknown reference.
 */
const PALETTE: Record<string, RGBA> = {
  backgroundPanel: RGBA.fromInts(18, 18, 18),
  backgroundElement: RGBA.fromInts(36, 36, 36),
  text: RGBA.fromInts(230, 230, 230),
  textMuted: RGBA.fromInts(154, 154, 154),
  markdownText: RGBA.fromInts(230, 230, 230),
  warning: RGBA.fromInts(217, 161, 74),
  primary: RGBA.fromInts(111, 163, 255),
  borderSubtle: RGBA.fromInts(58, 58, 58),
  accent: RGBA.fromInts(111, 163, 255),
}

/** The derived tokens the catalog's defaults name. */
const SEMANTIC = {
  surface: { base: RGBA.fromInts(7, 7, 7), panel: PALETTE.backgroundPanel!, offset: PALETTE.backgroundElement! },
  foreground: { default: PALETTE.text!, muted: PALETTE.textMuted! },
  accent: { fg: PALETTE.primary!, bg: RGBA.fromInts(40, 60, 90), border: RGBA.fromInts(90, 140, 220) },
  border: { subtle: RGBA.fromInts(58, 58, 58) },
  status: { warning: { fg: PALETTE.warning! } },
}

/**
 * Stands in for the theme: semantic paths first, then the document's flat keys,
 * which is the order the real resolver uses.
 */
const resolve = createComponentResolver(SEMANTIC, (ref: string): RGBA => {
  if (ref.startsWith("#")) return RGBA.fromHex(ref)
  const found = PALETTE[ref]
  if (!found) throw new Error(`Color reference "${ref}" not found in defs or theme`)
  return found
})

function patches(map: Record<string, unknown>): ComponentPatchMap {
  return map as ComponentPatchMap
}

describe("resolveComponents", () => {
  it("reproduces the values the components hardcoded, with no patches", () => {
    const { styles, warnings } = resolveComponents(resolve, [])
    expect(warnings).toEqual([])

    // The prompt and the tab strip joined the catalog when the studio stopped
    // styling them behind it, so their defaults are asserted here for the same
    // reason the message's are: the entry has to reproduce what the component
    // used to hardcode, or adopting the layer is a visible change.
    const prompt = styles["session.prompt"]
    expect(prompt.box.paddingLeft).toBe(2)
    expect(prompt.box.paddingRight).toBe(2)
    expect(prompt.box.paddingTop).toBe(1)
    expect(prompt.box.paddingBottom).toBe(0)
    expect(prompt.box.gap).toBe(1)
    expect(prompt.box.borderSides).toEqual(["left"])
    expect(prompt.colors.background).toEqual(SEMANTIC.surface.offset)

    const tabs = styles["session.tabs"]
    expect(tabs.box.paddingTop).toBe(1)
    expect(tabs.box.paddingBottom).toBe(1)
    expect(tabs.box.borderSides).toEqual(["bottom"])
    expect(tabs.box.borderCharset).toBe("default")
    expect(tabs.colors.background).toEqual(SEMANTIC.surface.panel)
    expect(tabs.colors.border).toEqual(SEMANTIC.border.subtle)
    // `primary`, because the strip painted this with `theme.accent.fg`, which
    // derives from `primary` and not from the flat `accent` key.
    expect(tabs.colors.activeBorder).toEqual(SEMANTIC.accent.fg)

    const message = styles["session.user-message"]
    expect(message.box.paddingTop).toBe(1)
    expect(message.box.paddingBottom).toBe(1)
    expect(message.box.paddingLeft).toBe(2)
    expect(message.box.marginTop).toBe(1)
    expect(message.box.borderSides).toEqual(["left"])
    expect(message.box.borderCharset).toBe("split")
    expect(message.colors.background).toEqual(PALETTE.backgroundPanel!)
    expect(message.colors.backgroundHover).toEqual(PALETTE.backgroundElement!)
  })

  it("keeps the height estimator's chrome constant honest", () => {
    // The literal `estimateTurnHeight` used to carry. If a change to the
    // default style moves this, the estimator must move with it — that is the
    // whole reason the figure is derived rather than duplicated.
    const { styles } = resolveComponents(resolve, [])
    expect(chromeRows(styles["session.user-message"].box)).toBe(3)
  })

  it("applies a patch and reports nothing when it is well formed", () => {
    const { styles, warnings } = resolveComponents(resolve, [
      patches({
        "session.user-message": { box: { paddingLeft: 4, borderCharset: "heavy" }, colors: { text: "primary" } },
      }),
    ])
    expect(warnings).toEqual([])
    expect(styles["session.user-message"].box.paddingLeft).toBe(4)
    expect(styles["session.user-message"].box.borderCharset).toBe("heavy")
    expect(styles["session.user-message"].colors.text).toEqual(PALETTE.primary!)
    // Untouched fields keep the default rather than resetting.
    expect(styles["session.user-message"].box.paddingTop).toBe(1)
  })

  it("lets a later patch override an earlier one, field by field", () => {
    const { styles } = resolveComponents(resolve, [
      patches({ "session.user-message": { box: { paddingLeft: 4, paddingTop: 2 } } }),
      patches({ "session.user-message": { box: { paddingLeft: 6 } } }),
    ])
    expect(styles["session.user-message"].box.paddingLeft).toBe(6)
    expect(styles["session.user-message"].box.paddingTop).toBe(2)
  })

  it("clamps spacing instead of rejecting it, so a bad value degrades one box", () => {
    const { styles } = resolveComponents(resolve, [
      patches({ "session.user-message": { box: { paddingLeft: -5, paddingTop: 999, gap: 2.6 } } }),
    ])
    expect(styles["session.user-message"].box.paddingLeft).toBe(0)
    expect(styles["session.user-message"].box.paddingTop).toBe(8)
    expect(styles["session.user-message"].box.gap).toBe(3)
  })

  it("warns and keeps the default for a non-numeric spacing value", () => {
    const { styles, warnings } = resolveComponents(resolve, [
      patches({ "session.user-message": { box: { paddingLeft: "wide" } } }),
    ])
    expect(styles["session.user-message"].box.paddingLeft).toBe(2)
    expect(warnings).toContainEqual({
      id: "session.user-message",
      field: "box.paddingLeft",
      reason: "expected a finite number",
    })
  })

  it("drops an unknown color slot rather than carrying one that does nothing", () => {
    const { styles, warnings } = resolveComponents(resolve, [
      patches({ "session.user-message": { colors: { bacgkround: "primary" } } }),
    ])
    expect("bacgkround" in styles["session.user-message"].colors).toBe(false)
    expect(styles["session.user-message"].colors.background).toEqual(PALETTE.backgroundPanel!)
    expect(warnings[0]?.field).toBe("colors.bacgkround")
  })

  it("survives an unresolvable color reference instead of taking the theme down", () => {
    // The theme's own resolver throws here. If that escaped, one typo in a
    // hand-edited components.json would blank the entire TUI.
    const { styles, warnings } = resolveComponents(resolve, [
      patches({ "session.user-message": { colors: { background: "nope" } } }),
    ])
    expect(styles["session.user-message"].colors.background).toEqual(PALETTE.backgroundPanel!)
    expect(warnings).toContainEqual({
      id: "session.user-message",
      field: "colors.background",
      reason: 'unresolved color reference "nope"',
    })
  })

  it("accepts a raw hex, since the theme grammar does", () => {
    const { styles, warnings } = resolveComponents(resolve, [
      patches({ "session.user-message": { colors: { background: "#102030" } } }),
    ])
    expect(warnings).toEqual([])
    expect(styles["session.user-message"].colors.background).toEqual(RGBA.fromHex("#102030"))
  })

  it("rejects an unknown border charset and an unknown side", () => {
    const { styles, warnings } = resolveComponents(resolve, [
      patches({ "session.user-message": { box: { borderCharset: "dashed", borderSides: ["left", "sideways"] } } }),
    ])
    expect(styles["session.user-message"].box.borderCharset).toBe("split")
    expect(styles["session.user-message"].box.borderSides).toEqual(["left"])
    expect(warnings.map((w) => w.field)).toContain("box.borderCharset")
  })

  it("ignores a patch aimed at a component that does not exist", () => {
    const { styles } = resolveComponents(resolve, [patches({ "session.invented": { box: { paddingLeft: 9 } } })])
    expect(Object.keys(styles)).toEqual(Object.keys(COMPONENT_DEFAULTS))
  })
})

describe("readComponentPatches", () => {
  it("returns an empty map for anything that is not an object", () => {
    expect(readComponentPatches(undefined)).toEqual({})
    expect(readComponentPatches(null)).toEqual({})
    expect(readComponentPatches("components")).toEqual({})
    expect(readComponentPatches([{ box: {} }])).toEqual({})
  })

  it("keeps only entries that carry a box or colors object", () => {
    const result = readComponentPatches({
      "session.user-message": { box: { paddingLeft: 4 } },
      "session.text-part": { colors: { text: "primary" } },
      "session.retry-part": { nonsense: true },
      "session.reasoning-part": "nope",
    })
    expect(Object.keys(result).sort()).toEqual(["session.text-part", "session.user-message"])
    expect(result["session.user-message"]?.box).toEqual({ paddingLeft: 4 })
  })
})
