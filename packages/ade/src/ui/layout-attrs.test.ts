import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LAYOUT_KEYS, badgeAttrs, layoutAttrs } from "./layout-attrs"

const css = readFileSync(join(import.meta.dir, "layout.css"), "utf8")

describe("layoutAttrs", () => {
  test("only what was asked for is set", () => {
    const attrs = layoutAttrs("row", { gap: 3, justify: "between", wrap: true })
    expect(Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined))).toEqual({
      "data-layout": "row",
      "data-gap": "3",
      "data-justify": "between",
      "data-wrap": "",
    })
  })

  test("every option has a key the primitives take out of the element props", () => {
    const options = {
      gap: 1,
      pad: 1,
      padX: 4,
      padY: 2,
      align: "start",
      justify: "end",
      border: "top",
      wrap: true,
      grow: true,
    } as const
    expect(Object.keys(options).sort()).toEqual([...LAYOUT_KEYS].sort())
  })

  test("badges: neutral carries no tone attribute", () => {
    expect(badgeAttrs()).toEqual({ "data-ui": "badge", "data-tone": undefined })
    expect(badgeAttrs("accent")["data-tone"]).toBe("accent")
  })
})

/*
 * The types promise a value; the stylesheet has to keep it. An attribute the
 * CSS does not match is a spacing that silently does nothing.
 */
describe("layout.css covers every value the types allow", () => {
  const has = (selector: string) => css.includes(selector)

  test("gap and pad steps 1-9", () => {
    for (let step = 1; step <= 9; step++) {
      expect(has(`[data-gap="${step}"]`)).toBe(true)
      expect(has(`[data-pad="${step}"]`)).toBe(true)
    }
  })

  test("inline and block padding, alignment, justification, borders, tones", () => {
    for (const step of [4, 5, 6, 7]) expect(has(`[data-pad-x="${step}"]`)).toBe(true)
    for (const step of [2, 3, 4, 5]) expect(has(`[data-pad-y="${step}"]`)).toBe(true)
    for (const value of ["start", "center", "end", "baseline", "stretch"])
      expect(has(`[data-align="${value}"]`)).toBe(true)
    for (const value of ["start", "center", "end", "between"]) expect(has(`[data-justify="${value}"]`)).toBe(true)
    for (const value of ["top", "bottom"]) expect(has(`[data-border="${value}"]`)).toBe(true)
    for (const tone of ["accent", "working", "waiting", "done", "error"])
      expect(has(`[data-tone="${tone}"]`)).toBe(true)
    for (const kind of ["stack", "row", "grid", "scroll", "overlay", "surface"])
      expect(has(`[data-layout="${kind}"]`)).toBe(true)
  })

  test("zero specificity, so a component's own rules always win", () => {
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@keyframes[\s\S]*?\n}\n/g, "")
      .split("}")
      .map((block) => block.split("{")[0]!.trim())
      .filter((selector) => selector.startsWith("[") || selector.startsWith(":"))
    expect(selectors.length).toBeGreaterThan(20)
    for (const selector of selectors) expect(selector.startsWith(":where(")).toBe(true)
  })
})
