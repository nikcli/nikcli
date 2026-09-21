import { describe, expect, it } from "bun:test"
import { BUILT_IN_THEME_IDS, loadBuiltInTheme } from "@tui/context/theme-catalog"
import { createStandaloneTheme } from "@tui/context/theme"
import { chromeRows, COMPONENT_IDS } from "@tui/context/component-tokens"

/**
 * The component layer has to survive every theme, not a curated few.
 *
 * A component token is a reference into the palette, so it is only safe while
 * every theme document actually defines the key it names. Checking three themes
 * by hand would have proved nothing: the ones that break a reference are never
 * the ones a person would think to pick.
 *
 * This is also what the storybook does interactively. Running it here means a
 * theme that breaks the layer fails in CI rather than the next time somebody
 * happens to cycle onto it.
 */

const MODES = ["dark", "light"] as const

describe("component tokens resolve on every built-in theme", () => {
  it("covers the whole catalog", () => {
    // Guards the loop below against silently shrinking to nothing.
    expect(BUILT_IN_THEME_IDS.length).toBeGreaterThan(100)
  })

  for (const mode of MODES) {
    it(`resolves every component on every theme in ${mode} mode`, async () => {
      const broken: string[] = []

      for (const name of BUILT_IN_THEME_IDS) {
        const document = await loadBuiltInTheme(name)
        if (!document) {
          broken.push(`${name}: document did not load`)
          continue
        }
        try {
          const theme = createStandaloneTheme({ document, mode })
          for (const warning of theme.componentWarnings()) {
            broken.push(`${name}: ${warning.id}.${warning.field} — ${warning.reason}`)
          }
          for (const id of COMPONENT_IDS) {
            const style = theme.component(id)
            // A colour slot resolving to undefined reaches the renderer as a
            // missing prop and paints as whatever was there before, which is
            // exactly the kind of failure that never gets reported.
            for (const [slot, value] of Object.entries(style.colors)) {
              if (value === undefined) broken.push(`${name}: ${id}.colors.${slot} is undefined`)
            }
            if (!Number.isFinite(chromeRows(style.box))) broken.push(`${name}: ${id} chrome rows are not finite`)
          }
        } catch (error) {
          broken.push(`${name}: threw — ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      expect(broken).toEqual([])
    })
  }
})
