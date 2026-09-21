import { SyntaxStyle, RGBA, type TerminalColors } from "@opentui/core"
import path from "path"
import { createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { createSimpleContext } from "./helper"
import {
  BUILT_IN_THEME_IDS,
  FALLBACK_THEME,
  FALLBACK_THEME_ID,
  isBuiltInTheme,
  loadBuiltInTheme,
} from "./theme-catalog"
import { contrastFg, deriveSemanticTokens, tint, type SemanticTokens } from "./theme-tokens"
import {
  createComponentResolver,
  readComponentPatches,
  resolveComponents,
  type ComponentId,
  type ComponentPatchMap,
  type ResolvedComponents,
  type StyleOf,
} from "./component-tokens"
import { patchesForKey, sessionStyleKey } from "./session-style"
import { useRoute } from "./route"
import { useKV } from "./kv"
import { useRenderer } from "@opentui/solid"
import { createStore, produce } from "solid-js/store"
import { Global } from "@nikcli-ai/util/global"
import { Filesystem } from "@nikcli-ai/util/filesystem"

export { BUILT_IN_THEME_IDS } from "./theme-catalog"
export { tint, contrastFg, type SemanticTokens } from "./theme-tokens"

type ThemeColors = {
  primary: RGBA
  secondary: RGBA
  accent: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  selectedListItemText: RGBA
  background: RGBA
  backgroundPanel: RGBA
  backgroundElement: RGBA
  backgroundMenu: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
  diffAdded: RGBA
  diffRemoved: RGBA
  diffContext: RGBA
  diffHunkHeader: RGBA
  diffHighlightAdded: RGBA
  diffHighlightRemoved: RGBA
  diffAddedBg: RGBA
  diffRemovedBg: RGBA
  diffContextBg: RGBA
  diffLineNumber: RGBA
  diffAddedLineNumberBg: RGBA
  diffRemovedLineNumberBg: RGBA
  markdownText: RGBA
  markdownHeading: RGBA
  markdownLink: RGBA
  markdownLinkText: RGBA
  markdownCode: RGBA
  markdownBlockQuote: RGBA
  markdownEmph: RGBA
  markdownStrong: RGBA
  markdownHorizontalRule: RGBA
  markdownListItem: RGBA
  markdownListEnumeration: RGBA
  markdownImage: RGBA
  markdownImageText: RGBA
  markdownCodeBlock: RGBA
  syntaxComment: RGBA
  syntaxKeyword: RGBA
  syntaxFunction: RGBA
  syntaxVariable: RGBA
  syntaxString: RGBA
  syntaxNumber: RGBA
  syntaxType: RGBA
  syntaxOperator: RGBA
  syntaxPunctuation: RGBA
}

export type Theme = SemanticTokens & {
  _hasSelectedListItemText: boolean
}

export function selectedForeground(theme: Theme, bg?: RGBA): RGBA {
  if (bg) return contrastFg(bg)
  return theme.badge.fg
}

type HexColor = `#${string}`
type RefName = string
type Variant = {
  dark: HexColor | RefName
  light: HexColor | RefName
}
type ColorValue = HexColor | RefName | Variant | RGBA
type ThemeJson = {
  $schema?: string
  defs?: Record<string, HexColor | RefName>
  /** Optional structural overrides; see `component-tokens.ts`. Shape-checked, not parsed. */
  components?: unknown
  theme: Omit<Record<keyof ThemeColors, ColorValue>, "selectedListItemText" | "backgroundMenu"> & {
    selectedListItemText?: ColorValue
    backgroundMenu?: ColorValue
    thinkingOpacity?: number
  }
}

const extraThemes: Record<string, ThemeJson> = {}

/** When ThemeProvider calls reload(), it replaces store.themes with a copy, so it no longer tracks mutations to extraThemes. */
let syncPluginThemeToStore: ((name: string, data: ThemeJson) => void) | undefined

export function addTheme(name: string, data: unknown): void {
  if (!data || typeof data !== "object" || !("theme" in data)) return
  extraThemes[name] = data as ThemeJson
  syncPluginThemeToStore?.(name, data as ThemeJson)
}

export function hasTheme(name: string): boolean {
  return isBuiltInTheme(name) || name in extraThemes
}

export function reservedThemeNames(): string[] {
  return [...BUILT_IN_THEME_IDS, ...Object.keys(extraThemes), "system"]
}

/** Eagerly parsed fallback only. Built-in documents load on demand via `loadBuiltInTheme`. */
export const DEFAULT_THEMES: Record<string, ThemeJson> = {
  [FALLBACK_THEME_ID]: FALLBACK_THEME as ThemeJson,
}

/**
 * Builds the color resolver for one theme document.
 *
 * Hoisted out of `resolveTheme` so component tokens resolve through the exact
 * same grammar — `#rrggbb`, a key in `defs`, a reference to another theme key,
 * a `{dark, light}` variant — instead of a second implementation that would
 * drift from this one the first time the grammar grows.
 *
 * It throws on an unknown reference, which is right for a theme document: a
 * typo there should fail loudly at load. Callers resolving hand-edited
 * component patches catch that and fall back; see `component-tokens.ts`.
 */
function createColorResolver(theme: ThemeJson, mode: "dark" | "light"): (c: ColorValue) => RGBA {
  const defs = theme.defs ?? {}
  function resolveColor(c: ColorValue): RGBA {
    if (c instanceof RGBA) return c
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return RGBA.fromInts(0, 0, 0, 0)

      if (c.startsWith("#")) return RGBA.fromHex(c)

      if (defs[c] != null) {
        return resolveColor(defs[c])
      } else if (theme.theme[c as keyof ThemeColors] !== undefined) {
        return resolveColor(theme.theme[c as keyof ThemeColors]!)
      } else {
        throw new Error(`Color reference "${c}" not found in defs or theme`)
      }
    }
    if (typeof c === "number") {
      return ansiToRgba(c)
    }
    return resolveColor(c[mode])
  }
  return resolveColor
}

function resolveTheme(theme: ThemeJson, mode: "dark" | "light"): Theme {
  const resolveColor = createColorResolver(theme, mode)

  const resolved = Object.fromEntries(
    Object.entries(theme.theme)
      .filter(([key]) => key !== "selectedListItemText" && key !== "backgroundMenu" && key !== "thinkingOpacity")
      .map(([key, value]) => {
        return [key, resolveColor(value as ColorValue)]
      }),
  ) as Partial<ThemeColors>

  // Handle selectedListItemText separately since it's optional
  const hasSelectedListItemText = theme.theme.selectedListItemText !== undefined
  if (hasSelectedListItemText) {
    resolved.selectedListItemText = resolveColor(theme.theme.selectedListItemText!)
  } else {
    // Backward compatibility: if selectedListItemText is not defined, use background color
    // This preserves the current behavior for all existing themes
    resolved.selectedListItemText = resolved.background
  }

  // Handle backgroundMenu - optional with fallback to backgroundElement
  if (theme.theme.backgroundMenu !== undefined) {
    resolved.backgroundMenu = resolveColor(theme.theme.backgroundMenu)
  } else {
    resolved.backgroundMenu = resolved.backgroundElement
  }

  // Presentation token: keep the historic 0.6 default rather than inventing a new opacity scale.
  const thinkingOpacity = theme.theme.thinkingOpacity ?? 0.6
  const colors = resolved as ThemeColors
  const semantic = deriveSemanticTokens(colors, {
    hasSelectedListItemText,
    thinkingOpacity,
    mode,
  })

  return {
    ...colors,
    ...semantic,
    _hasSelectedListItemText: hasSelectedListItemText,
  } as Theme
}

function ansiToRgba(code: number): RGBA {
  // Standard ANSI colors (0-15)
  if (code < 16) {
    const ansiColors = [
      "#000000", // Black
      "#800000", // Red
      "#008000", // Green
      "#808000", // Yellow
      "#000080", // Blue
      "#800080", // Magenta
      "#008080", // Cyan
      "#c0c0c0", // White
      "#808080", // Bright Black
      "#ff0000", // Bright Red
      "#00ff00", // Bright Green
      "#ffff00", // Bright Yellow
      "#0000ff", // Bright Blue
      "#ff00ff", // Bright Magenta
      "#00ffff", // Bright Cyan
      "#ffffff", // Bright White
    ]
    return RGBA.fromHex(ansiColors[code] ?? "#000000")
  }

  // 6x6x6 Color Cube (16-231)
  if (code < 232) {
    const index = code - 16
    const b = index % 6
    const g = Math.floor(index / 6) % 6
    const r = Math.floor(index / 36)

    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55)
    return RGBA.fromInts(val(r), val(g), val(b))
  }

  // Grayscale Ramp (232-255)
  if (code < 256) {
    const gray = (code - 232) * 10 + 8
    return RGBA.fromInts(gray, gray, gray)
  }

  // Fallback for invalid codes
  return RGBA.fromInts(0, 0, 0)
}

export const {
  use: useTheme,
  provider: ThemeProvider,
  context: ThemeContext,
} = createSimpleContext({
  name: "Theme",
  init: (props: { mode: "dark" | "light" }) => {
    const sync = useSync()
    const kv = useKV()
    // `RouteProvider` sits above this one, so the session being looked at is
    // readable here. That is what scopes a studio preset: the tab strip and the
    // prompt live outside the session route but style the same session, and
    // asking the route is the only answer all three agree on.
    const route = useRoute()
    const [store, setStore] = createStore({
      themes: { ...DEFAULT_THEMES } as Record<string, ThemeJson>,
      mode: kv.get("theme_mode", props.mode),
      active: (sync.data.config.theme ?? kv.get("theme", FALLBACK_THEME_ID)) as string,
      ready: false,
      /** `.nikcli/components.json`, merged over whatever the active theme declares. */
      componentOverrides: {} as ComponentPatchMap,
    })

    function mergePluginThemeIntoStore(name: string, data: ThemeJson) {
      setStore(
        produce((draft) => {
          draft.themes[name] = data
        }),
      )
    }
    syncPluginThemeToStore = mergePluginThemeIntoStore
    // Plugin themes that loaded before the provider only lived on extraThemes.
    setStore(
      produce((draft) => {
        for (const [k, v] of Object.entries(extraThemes)) {
          draft.themes[k] = v
        }
      }),
    )
    onCleanup(() => {
      syncPluginThemeToStore = undefined
    })

    async function ensureLoaded(name: string) {
      if (!name || name === "system") return
      if (store.themes[name]) return
      if (extraThemes[name]) {
        setStore("themes", name, extraThemes[name])
        return
      }
      if (!isBuiltInTheme(name)) return
      const json = (await loadBuiltInTheme(name)) as ThemeJson | undefined
      if (!json) return
      setStore(
        produce((draft) => {
          draft.themes[name] = json
        }),
      )
    }

    void ensureLoaded(store.active)

    createEffect(
      on(
        () => sync.data.config.theme,
        (theme) => {
          if (theme) {
            setStore("active", theme)
            void ensureLoaded(theme)
          }
        },
        { defer: true },
      ),
    )

    async function reload() {
      resolveSystemTheme()
      const custom = await getCustomThemes().catch(() => ({}) as Record<string, ThemeJson>)
      // Independent of the theme: a component override survives a theme switch,
      // which is the point — it is the user's tweak, not the theme's opinion.
      const overrides = await getComponentOverrides().catch(() => ({}) as ComponentPatchMap)
      setStore("componentOverrides", overrides)
      const active = store.active
      let selected: ThemeJson | undefined
      if (active && active !== "system") {
        if (extraThemes[active]) selected = extraThemes[active]
        else if (custom[active]) selected = custom[active]
        else if (isBuiltInTheme(active)) selected = (await loadBuiltInTheme(active)) as ThemeJson | undefined
      }
      setStore(
        produce((draft) => {
          const systemTheme = draft.themes.system
          // Rebuild so deleted custom themes disappear. Do not re-parse every built-in.
          draft.themes = { ...DEFAULT_THEMES, ...extraThemes, ...custom }
          if (systemTheme) {
            draft.themes.system = systemTheme
          }
          if (selected) {
            draft.themes[active] = selected
          }
          if (draft.themes[draft.active] === undefined && draft.active !== "system") {
            draft.active = FALLBACK_THEME_ID
          }
        }),
      )

      if (store.active !== "system") {
        setStore("ready", true)
      }
    }

    onMount(() => {
      reload().catch(() => {
        setStore("active", FALLBACK_THEME_ID)
        setStore("ready", true)
      })
    })

    function resolveSystemTheme() {
      renderer
        .getPalette({
          size: 16,
        })
        .then((colors) => {
          if (!colors.palette[0]) {
            if (store.active === "system") {
              setStore(
                produce((draft) => {
                  draft.active = FALLBACK_THEME_ID
                  draft.ready = true
                }),
              )
            }
            return
          }
          setStore(
            produce((draft) => {
              draft.themes.system = generateSystem(colors, store.mode)
              if (store.active === "system") {
                draft.ready = true
              }
            }),
          )
        })
    }

    const renderer = useRenderer()
    process.on("SIGUSR2", async () => {
      renderer.clearPaletteCache()
      await reload()
    })

    const values = createMemo(() => {
      return resolveTheme(store.themes[store.active] ?? store.themes.nikcli, store.mode)
    })

    const syntax = createMemo(() => generateSyntax(values()))
    const subtleSyntax = createMemo(() => generateSubtleSyntax(values()))

    /**
     * Component styles for the active theme.
     *
     * One memo for the whole catalog rather than one per component: resolution
     * is a few dozen color lookups, and recomputing it as a unit keeps the
     * streaming parts' render path free of any merge at all. It re-runs only
     * when the theme document, the mode, or the user's overrides change.
     */
    /**
     * The studio preset for the session in view, as a stable key.
     *
     * A string, and separate from the resolution below, for one reason: the
     * catalog must not depend on the route. Reading `route.data` inside the
     * resolution subscribed it to every navigation, and since each run
     * allocates fresh style objects, switching session or tab re-ran the JSX
     * effects of every mounted part in the transcript — the whole thing, since
     * message virtualization is off by default. Nothing about the styles had
     * changed; only their identity had.
     *
     * Keyed by content, the common case (no recipe anywhere) is the empty
     * string before and after a navigation, so this memo does not notify and
     * the catalog is never rebuilt.
     */
    const presetKey = createMemo(() =>
      sessionStyleKey(kv, "sessionID" in route.data ? route.data.sessionID : undefined),
    )

    const preset = createMemo<ComponentPatchMap | undefined>(() => patchesForKey(presetKey()))

    const components = createMemo<ResolvedComponents>(() => resolve([]))

    /**
     * Resolves the catalog with extra patches layered on top of the live ones.
     *
     * Every caller goes through here, so there is exactly one merge order:
     * the theme document, the user's `components.json`, the studio preset for
     * the session in view, then whatever the caller adds. Later wins, and the
     * preset is late on purpose — it is the most recent and most specific thing
     * the user asked for, and it only names the fields it decides.
     */
    function resolve(extra: readonly ComponentPatchMap[]): ResolvedComponents {
      const document = store.themes[store.active] ?? store.themes.nikcli!
      const patches = preset()
      return resolveComponents(createComponentResolver(values(), createColorResolver(document, store.mode)), [
        readComponentPatches(document.components),
        store.componentOverrides,
        ...(patches ? [patches] : []),
        ...extra,
      ])
    }

    return {
      theme: new Proxy({} as Theme, {
        get(_target, prop) {
          // Solid reactivity: property reads must go through the memo. The
          // resolved object still carries flat document keys at runtime for
          // plugin `TuiThemeCurrent`; the Theme type is nested-only.
          // @ts-expect-error
          return values()[prop]
        },
      }),
      get selected() {
        return store.active
      },
      all() {
        return store.themes
      },
      names() {
        const names = new Set<string>(BUILT_IN_THEME_IDS)
        for (const k of Object.keys(store.themes)) names.add(k)
        for (const k of Object.keys(extraThemes)) names.add(k)
        return [...names]
      },
      syntax,
      subtleSyntax,
      /**
       * Resolved structural style for one component. Read it in the component
       * body, not inside a per-row or per-token memo: the object identity is
       * stable for as long as the theme is, so a plain read is already cheap.
       */
      component<Id extends ComponentId>(id: Id): StyleOf<Id> {
        return components().styles[id]
      },
      /** Every patch the active theme and the user's overrides got wrong. */
      componentWarnings() {
        return components().warnings
      },
      /**
       * The same resolution with one more patch layer on top, for an editor
       * previewing an unsaved change. It resolves through the live pipeline
       * rather than a preview-only copy, so what the sample shows is what
       * applying it produces.
       */
      previewComponents(patches: ComponentPatchMap): ResolvedComponents {
        return resolve([patches])
      },
      mode() {
        return store.mode
      },
      setMode(mode: "dark" | "light") {
        setStore("mode", mode)
        kv.set("theme_mode", mode)
      },
      set(theme: string) {
        setStore("active", theme)
        kv.set("theme", theme)
        void ensureLoaded(theme)
      },
      reload,
      get ready() {
        return store.ready
      },
    }
  },
})

const CUSTOM_THEME_GLOB = new Bun.Glob("themes/*.json")
async function getCustomThemes() {
  const directories = [
    Global.Path.config,
    ...(await Array.fromAsync(
      Filesystem.up({
        targets: [".nikcli"],
        start: process.cwd(),
      }),
    )),
  ]

  const result: Record<string, ThemeJson> = {}
  for (const dir of directories) {
    for await (const item of CUSTOM_THEME_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const name = path.basename(item, ".json")
      result[name] = await Bun.file(item).json()
    }
  }
  return result
}

/**
 * Loads `components.json` from the global config and every `.nikcli` on the way
 * up from the working directory.
 *
 * Ordering differs from `getCustomThemes` on purpose. `Filesystem.up` yields
 * nearest-first, and a theme *name* collision is a naming accident where the
 * winner barely matters. A component override is a deliberate narrowing — the
 * repo refines the user's defaults, a sub-project refines the repo's — so the
 * nearest file has to win. Hence the reverse: merge outermost first, let each
 * closer directory overwrite, and the closest ends up on top.
 */
const COMPONENT_OVERRIDE_FILE = "components.json"
async function getComponentOverrides(): Promise<ComponentPatchMap> {
  const ancestors = await Array.fromAsync(
    Filesystem.up({
      targets: [".nikcli"],
      start: process.cwd(),
    }),
  )
  const directories = [Global.Path.config, ...ancestors.reverse()]

  const merged: Record<string, { box?: Record<string, unknown>; colors?: Record<string, unknown> }> = {}
  for (const dir of directories) {
    const file = Bun.file(path.join(dir, COMPONENT_OVERRIDE_FILE))
    // A missing file is the common case, not an error worth surfacing. A
    // malformed one is skipped per-file so one bad override does not discard
    // the valid ones above it in the chain.
    const document = await file.json().catch(() => undefined)
    if (document === undefined) continue
    for (const [id, patch] of Object.entries(readComponentPatches(document))) {
      const previous = merged[id]
      merged[id] = {
        box: { ...previous?.box, ...patch.box },
        colors: { ...previous?.colors, ...patch.colors },
      }
    }
  }
  return merged as ComponentPatchMap
}

function generateSystem(colors: TerminalColors, mode: "dark" | "light"): ThemeJson {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0]!)
  const fg = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7]!)
  const isDark = mode == "dark"

  const col = (i: number) => {
    const value = colors.palette[i]
    if (value) return RGBA.fromHex(value)
    return ansiToRgba(i)
  }

  // Generate gray scale based on terminal background
  const grays = generateGrayScale(bg, isDark)
  const textMuted = generateMutedTextColor(bg, isDark)

  // ANSI color references
  const ansiColors = {
    black: col(0),
    red: col(1),
    green: col(2),
    yellow: col(3),
    blue: col(4),
    magenta: col(5),
    cyan: col(6),
    white: col(7),
    redBright: col(9),
    greenBright: col(10),
  }

  const diffAlpha = isDark ? 0.22 : 0.14
  const diffAddedBg = tint(bg, ansiColors.green, diffAlpha)
  const diffRemovedBg = tint(bg, ansiColors.red, diffAlpha)
  const diffAddedLineNumberBg = tint(grays[3], ansiColors.green, diffAlpha)
  const diffRemovedLineNumberBg = tint(grays[3], ansiColors.red, diffAlpha)

  return {
    theme: {
      // Primary colors using ANSI
      primary: ansiColors.cyan,
      secondary: ansiColors.magenta,
      accent: ansiColors.cyan,

      // Status colors using ANSI
      error: ansiColors.red,
      warning: ansiColors.yellow,
      success: ansiColors.green,
      info: ansiColors.cyan,

      // Text colors
      text: fg,
      textMuted,
      selectedListItemText: bg,

      // Background colors
      background: bg,
      backgroundPanel: grays[2],
      backgroundElement: grays[3],
      backgroundMenu: grays[3],

      // Border colors
      borderSubtle: grays[6],
      border: grays[7],
      borderActive: grays[8],

      // Diff colors
      diffAdded: ansiColors.green,
      diffRemoved: ansiColors.red,
      diffContext: grays[7],
      diffHunkHeader: grays[7],
      diffHighlightAdded: ansiColors.greenBright,
      diffHighlightRemoved: ansiColors.redBright,
      diffAddedBg,
      diffRemovedBg,
      diffContextBg: grays[1],
      diffLineNumber: grays[6],
      diffAddedLineNumberBg,
      diffRemovedLineNumberBg,

      // Markdown colors
      markdownText: fg,
      markdownHeading: fg,
      markdownLink: ansiColors.blue,
      markdownLinkText: ansiColors.cyan,
      markdownCode: ansiColors.green,
      markdownBlockQuote: ansiColors.yellow,
      markdownEmph: ansiColors.yellow,
      markdownStrong: fg,
      markdownHorizontalRule: grays[7],
      markdownListItem: ansiColors.blue,
      markdownListEnumeration: ansiColors.cyan,
      markdownImage: ansiColors.blue,
      markdownImageText: ansiColors.cyan,
      markdownCodeBlock: fg,

      // Syntax colors
      syntaxComment: textMuted,
      syntaxKeyword: ansiColors.magenta,
      syntaxFunction: ansiColors.blue,
      syntaxVariable: fg,
      syntaxString: ansiColors.green,
      syntaxNumber: ansiColors.yellow,
      syntaxType: ansiColors.cyan,
      syntaxOperator: ansiColors.cyan,
      syntaxPunctuation: fg,
    },
  }
}

function generateGrayScale(bg: RGBA, isDark: boolean): Record<number, RGBA> {
  const grays: Record<number, RGBA> = {}

  // RGBA stores floats in range 0-1, convert to 0-255
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255

  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  for (let i = 1; i <= 12; i++) {
    const factor = i / 12.0

    let grayValue: number
    let newR: number
    let newG: number
    let newB: number

    if (isDark) {
      if (luminance < 10) {
        grayValue = Math.floor(factor * 0.4 * 255)
        newR = grayValue
        newG = grayValue
        newB = grayValue
      } else {
        const newLum = luminance + (255 - luminance) * factor * 0.4

        const ratio = newLum / luminance
        newR = Math.min(bgR * ratio, 255)
        newG = Math.min(bgG * ratio, 255)
        newB = Math.min(bgB * ratio, 255)
      }
    } else {
      if (luminance > 245) {
        grayValue = Math.floor(255 - factor * 0.4 * 255)
        newR = grayValue
        newG = grayValue
        newB = grayValue
      } else {
        const newLum = luminance * (1 - factor * 0.4)

        const ratio = newLum / luminance
        newR = Math.max(bgR * ratio, 0)
        newG = Math.max(bgG * ratio, 0)
        newB = Math.max(bgB * ratio, 0)
      }
    }

    grays[i] = RGBA.fromInts(Math.floor(newR), Math.floor(newG), Math.floor(newB))
  }

  return grays
}

function generateMutedTextColor(bg: RGBA, isDark: boolean): RGBA {
  // RGBA stores floats in range 0-1, convert to 0-255
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255

  const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  let grayValue: number

  if (isDark) {
    if (bgLum < 10) {
      // Very dark/black background
      grayValue = 180 // #b4b4b4
    } else {
      // Scale up for lighter dark backgrounds
      grayValue = Math.min(Math.floor(160 + bgLum * 0.3), 200)
    }
  } else {
    if (bgLum > 245) {
      // Very light/white background
      grayValue = 75 // #4b4b4b
    } else {
      // Scale down for darker light backgrounds
      grayValue = Math.max(Math.floor(100 - (255 - bgLum) * 0.2), 60)
    }
  }

  return RGBA.fromInts(grayValue, grayValue, grayValue)
}

function generateSyntax(theme: Theme) {
  return SyntaxStyle.fromTheme(getSyntaxRules(theme))
}

function generateSubtleSyntax(theme: Theme) {
  const rules = getSyntaxRules(theme)
  return SyntaxStyle.fromTheme(
    rules.map((rule) => {
      if (rule.style.foreground) {
        const fg = rule.style.foreground
        return {
          ...rule,
          style: {
            ...rule.style,
            foreground: RGBA.fromInts(
              Math.round(fg.r * 255),
              Math.round(fg.g * 255),
              Math.round(fg.b * 255),
              Math.round(theme.thinkingOpacity * 255),
            ),
          },
        }
      }
      return rule
    }),
  )
}

function getSyntaxRules(theme: Theme) {
  return [
    {
      scope: ["default"],
      style: {
        foreground: theme.foreground.default,
      },
    },
    {
      scope: ["prompt"],
      style: {
        foreground: theme.accent.fg,
      },
    },
    {
      scope: ["extmark.file"],
      style: {
        foreground: theme.status.warning.fg,
        bold: true,
      },
    },
    {
      scope: ["extmark.agent"],
      style: {
        foreground: theme.accent.secondary,
        bold: true,
      },
    },
    {
      scope: ["extmark.paste"],
      style: {
        foreground: theme.surface.base,
        background: theme.status.warning.fg,
        bold: true,
      },
    },
    {
      scope: ["comment"],
      style: {
        foreground: theme.syntax.comment,
        italic: true,
      },
    },
    {
      scope: ["comment.documentation"],
      style: {
        foreground: theme.syntax.comment,
        italic: true,
      },
    },
    {
      scope: ["string", "symbol"],
      style: {
        foreground: theme.syntax.string,
      },
    },
    {
      scope: ["number", "boolean"],
      style: {
        foreground: theme.syntax.number,
      },
    },
    {
      scope: ["character.special"],
      style: {
        foreground: theme.syntax.string,
      },
    },
    {
      scope: ["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"],
      style: {
        foreground: theme.syntax.keyword,
        italic: true,
      },
    },
    {
      scope: ["keyword.type"],
      style: {
        foreground: theme.syntax.type,
        bold: true,
        italic: true,
      },
    },
    {
      scope: ["keyword.function", "function.method"],
      style: {
        foreground: theme.syntax.function,
      },
    },
    {
      scope: ["keyword"],
      style: {
        foreground: theme.syntax.keyword,
        italic: true,
      },
    },
    {
      scope: ["keyword.import"],
      style: {
        foreground: theme.syntax.keyword,
      },
    },
    {
      scope: ["operator", "keyword.operator", "punctuation.delimiter"],
      style: {
        foreground: theme.syntax.operator,
      },
    },
    {
      scope: ["keyword.conditional.ternary"],
      style: {
        foreground: theme.syntax.operator,
      },
    },
    {
      scope: ["variable", "variable.parameter", "function.method.call", "function.call"],
      style: {
        foreground: theme.syntax.variable,
      },
    },
    {
      scope: ["variable.member", "function", "constructor"],
      style: {
        foreground: theme.syntax.function,
      },
    },
    {
      scope: ["type", "module"],
      style: {
        foreground: theme.syntax.type,
      },
    },
    {
      scope: ["constant"],
      style: {
        foreground: theme.syntax.number,
      },
    },
    {
      scope: ["property"],
      style: {
        foreground: theme.syntax.variable,
      },
    },
    {
      scope: ["class"],
      style: {
        foreground: theme.syntax.type,
      },
    },
    {
      scope: ["parameter"],
      style: {
        foreground: theme.syntax.variable,
      },
    },
    {
      scope: ["punctuation", "punctuation.bracket"],
      style: {
        foreground: theme.syntax.punctuation,
      },
    },
    {
      scope: ["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin"],
      style: {
        foreground: theme.status.error.fg,
      },
    },
    {
      scope: ["variable.super"],
      style: {
        foreground: theme.status.error.fg,
      },
    },
    {
      scope: ["string.escape", "string.regexp"],
      style: {
        foreground: theme.syntax.keyword,
      },
    },
    {
      scope: ["keyword.directive"],
      style: {
        foreground: theme.syntax.keyword,
        italic: true,
      },
    },
    {
      scope: ["punctuation.special"],
      style: {
        foreground: theme.syntax.operator,
      },
    },
    {
      scope: ["keyword.modifier"],
      style: {
        foreground: theme.syntax.keyword,
        italic: true,
      },
    },
    {
      scope: ["keyword.exception"],
      style: {
        foreground: theme.syntax.keyword,
        italic: true,
      },
    },
    // Markdown specific styles
    {
      scope: ["markup.heading"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.1"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.2"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.3"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.4"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.5"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.heading.6"],
      style: {
        foreground: theme.markdown.heading,
        bold: true,
      },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: {
        foreground: theme.markdown.strong,
        bold: true,
      },
    },
    {
      scope: ["markup.italic"],
      style: {
        foreground: theme.markdown.emph,
        italic: true,
      },
    },
    {
      scope: ["markup.list"],
      style: {
        foreground: theme.markdown.listItem,
      },
    },
    {
      scope: ["markup.quote"],
      style: {
        foreground: theme.markdown.blockQuote,
        italic: true,
      },
    },
    {
      scope: ["markup.raw", "markup.raw.block"],
      style: {
        foreground: theme.markdown.code,
      },
    },
    {
      scope: ["markup.raw.inline"],
      style: {
        foreground: theme.markdown.code,
        background: theme.surface.base,
      },
    },
    {
      scope: ["markup.link"],
      style: {
        foreground: theme.markdown.link,
        underline: true,
      },
    },
    {
      scope: ["markup.link.label"],
      style: {
        foreground: theme.markdown.linkText,
        underline: true,
      },
    },
    {
      scope: ["markup.link.url"],
      style: {
        foreground: theme.markdown.link,
        underline: true,
      },
    },
    {
      scope: ["label"],
      style: {
        foreground: theme.markdown.linkText,
      },
    },
    {
      scope: ["spell", "nospell"],
      style: {
        foreground: theme.foreground.default,
      },
    },
    {
      scope: ["conceal"],
      style: {
        foreground: theme.foreground.muted,
      },
    },
    // Additional common highlight groups
    {
      scope: ["string.special", "string.special.url"],
      style: {
        foreground: theme.markdown.link,
        underline: true,
      },
    },
    {
      scope: ["character"],
      style: {
        foreground: theme.syntax.string,
      },
    },
    {
      scope: ["float"],
      style: {
        foreground: theme.syntax.number,
      },
    },
    {
      scope: ["comment.error"],
      style: {
        foreground: theme.status.error.fg,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["comment.warning"],
      style: {
        foreground: theme.status.warning.fg,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["comment.todo", "comment.note"],
      style: {
        foreground: theme.status.info.fg,
        italic: true,
        bold: true,
      },
    },
    {
      scope: ["namespace"],
      style: {
        foreground: theme.syntax.type,
      },
    },
    {
      scope: ["field"],
      style: {
        foreground: theme.syntax.variable,
      },
    },
    {
      scope: ["type.definition"],
      style: {
        foreground: theme.syntax.type,
        bold: true,
      },
    },
    {
      scope: ["keyword.export"],
      style: {
        foreground: theme.syntax.keyword,
      },
    },
    {
      scope: ["attribute", "annotation"],
      style: {
        foreground: theme.status.warning.fg,
      },
    },
    {
      scope: ["tag"],
      style: {
        foreground: theme.status.error.fg,
      },
    },
    {
      scope: ["tag.attribute"],
      style: {
        foreground: theme.syntax.keyword,
      },
    },
    {
      scope: ["tag.delimiter"],
      style: {
        foreground: theme.syntax.operator,
      },
    },
    {
      scope: ["markup.strikethrough"],
      style: {
        foreground: theme.foreground.muted,
      },
    },
    {
      scope: ["markup.underline"],
      style: {
        foreground: theme.foreground.default,
        underline: true,
      },
    },
    {
      scope: ["markup.list.checked"],
      style: {
        foreground: theme.status.success.fg,
      },
    },
    {
      scope: ["markup.list.unchecked"],
      style: {
        foreground: theme.foreground.muted,
      },
    },
    {
      scope: ["diff.plus"],
      style: {
        foreground: theme.diff.added,
        background: theme.diff.addedBg,
      },
    },
    {
      scope: ["diff.minus"],
      style: {
        foreground: theme.diff.removed,
        background: theme.diff.removedBg,
      },
    },
    {
      scope: ["diff.delta"],
      style: {
        foreground: theme.diff.context,
        background: theme.diff.contextBg,
      },
    },
    {
      scope: ["error"],
      style: {
        foreground: theme.status.error.fg,
        bold: true,
      },
    },
    {
      scope: ["warning"],
      style: {
        foreground: theme.status.warning.fg,
        bold: true,
      },
    },
    {
      scope: ["info"],
      style: {
        foreground: theme.status.info.fg,
      },
    },
    {
      scope: ["debug"],
      style: {
        foreground: theme.foreground.muted,
      },
    },
  ]
}

/**
 * A theme value built from a document, with no Sync, KV or renderer behind it.
 *
 * `ThemeProvider` resolves the active theme from the server config, the user's
 * `kv.json` and the terminal palette. That is right in the app and unusable
 * anywhere a component is rendered against fixtures — a storybook, a snapshot
 * test — where the point is to drive the theme, not discover it.
 *
 * It returns the same shape `useTheme()` does, from the same `resolveTheme` and
 * `resolveComponents`, so a component rendered through it exercises the real
 * resolution rather than a lookalike. Mutating operations are absent by design:
 * there is no store to write back to, and a silent no-op `set()` would read as
 * a bug in whatever called it.
 */
export function createStandaloneTheme(input: {
  document: unknown
  mode: "dark" | "light"
  overrides?: ComponentPatchMap
}) {
  const document = input.document as ThemeJson
  const resolved = resolveTheme(document, input.mode)
  const components = resolveComponents(createComponentResolver(resolved, createColorResolver(document, input.mode)), [
    readComponentPatches(document.components),
    input.overrides ?? {},
  ])
  const syntax = generateSyntax(resolved)
  const subtleSyntax = generateSubtleSyntax(resolved)

  return {
    theme: resolved,
    syntax: () => syntax,
    subtleSyntax: () => subtleSyntax,
    component<Id extends ComponentId>(id: Id): StyleOf<Id> {
      return components.styles[id]
    },
    componentWarnings() {
      return components.warnings
    },
    mode() {
      return input.mode
    },
    ready: true,
  }
}
