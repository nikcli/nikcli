import { describe, expect, it } from "bun:test"
import { BUILT_IN_THEME_IDS, loadBuiltInTheme } from "@tui/context/theme-catalog"
import { createStandaloneTheme } from "@tui/context/theme"
import { chromeRows, COMPONENT_IDS } from "@tui/context/component-tokens"
import type { RGBA } from "@opentui/core"
import type { Theme } from "@tui/context/theme"

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

/**
 * Every token resolves to the value its component used to read directly.
 *
 * This is the contract the catalog is built on — "each default reproduces what
 * the component hardcoded, so adopting the layer is a no-op" — and it was not
 * true. `session.tabs.activeBorder` named the flat `accent` key while the strip
 * had always painted that edge with `theme.accent.fg`, which derives from
 * `primary`. On every theme where those two differ, the selected tab quietly
 * changed color, and nothing failed.
 *
 * Asserting against the *semantic* expression rather than a fixture is what
 * makes this catch that: a flat key and the token it feeds can agree on one
 * theme and diverge on the next, so the check has to run on all of them.
 */
describe("component tokens equal the expressions they replaced", () => {
  /** Slot → the `theme.*` expression the component read before the catalog. */
  const EXPECTED: Record<string, Record<string, (t: Theme) => RGBA>> = {
    "session.user-message": {
      background: (t) => t.surface.panel,
      backgroundHover: (t) => t.surface.offset,
      text: (t) => t.foreground.default,
    },
    "session.text-part": { text: (t) => t.foreground.default },
    "session.reasoning-part": {
      heading: (t) => t.status.warning.fg,
      border: (t) => t.surface.offset,
    },
    "session.retry-part": {
      icon: (t) => t.status.warning.fg,
      text: (t) => t.foreground.muted,
    },
    "session.synthetic-part": { text: (t) => t.foreground.muted },
    "session.unknown-part": { text: (t) => t.foreground.muted },
    "session.task-card": {
      title: (t) => t.foreground.default,
      detail: (t) => t.foreground.muted,
      marker: (t) => t.foreground.subtle,
    },
    "session.prompt": { background: (t) => t.surface.offset },
    "session.prompt-shadow": { fill: (t) => t.surface.offset },
    "session.tabs": {
      background: (t) => t.surface.panel,
      border: (t) => t.border.subtle,
      activeBorder: (t) => t.accent.fg,
      activeBackground: (t) => t.surface.offset,
    },
  }

  it("names every component in the catalog, so a new entry cannot skip the check", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...COMPONENT_IDS].sort())
  })

  for (const mode of MODES) {
    it(`holds on every built-in theme in ${mode} mode`, async () => {
      const broken: string[] = []

      for (const name of BUILT_IN_THEME_IDS) {
        const document = await loadBuiltInTheme(name)
        if (!document) continue
        const resolved = createStandaloneTheme({ document, mode })
        for (const [id, slots] of Object.entries(EXPECTED)) {
          const style = resolved.component(id as (typeof COMPONENT_IDS)[number])
          for (const [slot, expected] of Object.entries(slots)) {
            const actual = (style.colors as Record<string, RGBA>)[slot]!
            const want = expected(resolved.theme)
            if (actual.r !== want.r || actual.g !== want.g || actual.b !== want.b || actual.a !== want.a) {
              broken.push(`${name}: ${id}.${slot} is ${describe_(actual)}, was ${describe_(want)}`)
            }
          }
        }
      }

      expect(broken).toEqual([])
    })
  }
})

function describe_(color: RGBA): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`
}
