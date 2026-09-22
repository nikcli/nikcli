import { useScrollAcceleration } from "@tui/util/scroll"
import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import path from "path"
import { mkdir } from "fs/promises"
import { createMemo, For, Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Global } from "@nikcli-ai/util/global"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import { reservedThemeNames, useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"

interface ColorDef {
  key: string
  label: string
  description: string
}

const COLOR_DEFS: ColorDef[] = [
  { key: "primary", label: "Primary", description: "Main accent color" },
  { key: "secondary", label: "Secondary", description: "Secondary accent" },
  { key: "accent", label: "Accent", description: "Extra accent" },
  { key: "error", label: "Error", description: "Error color" },
  { key: "warning", label: "Warning", description: "Warning color" },
  { key: "success", label: "Success", description: "Success color" },
  { key: "info", label: "Info", description: "Info color" },
  { key: "text", label: "Text", description: "Main text color" },
  { key: "textMuted", label: "Text Muted", description: "Muted text color" },
  { key: "background", label: "Background", description: "Main background" },
  { key: "backgroundPanel", label: "Panel", description: "Panel background" },
  { key: "backgroundElement", label: "Element", description: "Element background" },
  { key: "border", label: "Border", description: "Border color" },
  { key: "borderActive", label: "Border Active", description: "Active border" },
  { key: "borderSubtle", label: "Border Subtle", description: "Subtle border" },
]

const PRESET_COLORS = [
  "#6fa3ff",
  "#a78bfa",
  "#f472b6",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#14b8a6",
  "#6366f1",
  "#d45f5f",
  "#d9a14a",
  "#7fc08f",
  "#58a6b8",
  "#d2b56d",
  "#070707",
  "#121212",
  "#1b1b1b",
  "#242424",
  "#2e2e2e",
  "#3a3a3a",
  "#4a4a4a",
  "#5c5c5c",
  "#8bb4ff",
  "#9a9a9a",
  "#e6e6e6",
  "#f7f7f7",
  "#ededed",
  "#e2e2e2",
]

function rgbaToHex(rgba: RGBA): string {
  const r = Math.round(rgba.r * 255)
  const g = Math.round(rgba.g * 255)
  const b = Math.round(rgba.b * 255)
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}

function normalizeThemeName(input: string): { ok: true; value: string } | { ok: false; reason: string } {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, reason: "Theme name is required." }

  let slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")

  if (!slug) return { ok: false, reason: "Theme name must include letters or numbers." }
  if (slug.length > 64) slug = slug.slice(0, 64).replace(/-+$/, "")

  const reserved = new Set<string>(reservedThemeNames())
  if (reserved.has(slug)) {
    return { ok: false, reason: `"${slug}" is reserved. Choose a different name.` }
  }

  return { ok: true, value: slug }
}

function generateGrayScale(bg: RGBA, isDark: boolean): Record<number, RGBA> {
  const grays: Record<number, RGBA> = {}
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255
  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  for (let i = 1; i <= 12; i++) {
    const factor = i / 12.0
    let newR: number, newG: number, newB: number

    if (isDark) {
      if (luminance < 10) {
        const grayValue = Math.floor(factor * 0.4 * 255)
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
        const grayValue = Math.floor(255 - factor * 0.4 * 255)
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
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255
  const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  let grayValue: number
  if (isDark) {
    grayValue = bgLum < 10 ? 180 : Math.min(Math.floor(160 + bgLum * 0.3), 200)
  } else {
    grayValue = bgLum > 245 ? 75 : Math.max(Math.floor(100 - (255 - bgLum) * 0.2), 60)
  }
  return RGBA.fromInts(grayValue, grayValue, grayValue)
}

export function DialogThemeCreate() {
  const themeCtx = useTheme()
  const scrollAcceleration = useScrollAcceleration()
  const { theme } = themeCtx
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  let nameInput: any

  const [store, setStore] = createStore({
    name: "",
    variant: "dark" as "dark" | "light",
    scope: "global" as "global" | "project",
    colors: {
      dark: {} as Record<string, string>,
      light: {} as Record<string, string>,
    },
    selectedColor: "__name__" as string | null,
    selectedIndex: -1,
    pickerIndex: 0,
    saving: false,
    overwriteArmed: false,
    status: "",
  })

  onMount(() => {
    dialog.setSize("large")
    setTimeout(() => nameInput?.focus?.(), 1)
  })

  const dialogWidth = createMemo(() => Math.min(80, Math.max(40, dimensions().width - 2)))
  const contentWidth = createMemo(() => Math.max(32, dialogWidth() - 8))

  const defaultBgHex = (variant: "dark" | "light") => (variant === "dark" ? "#070707" : "#f7f7f7")
  const defaultTextHex = (variant: "dark" | "light") => (variant === "dark" ? "#e6e6e6" : "#070707")
  const defaultAccentHex = "#6fa3ff"

  const bgHex = (variant: "dark" | "light") => store.colors[variant].background || defaultBgHex(variant)
  const accentHex = (variant: "dark" | "light") => store.colors[variant].primary || defaultAccentHex

  const grays = createMemo(() => {
    return {
      dark: generateGrayScale(RGBA.fromHex(bgHex("dark")), true),
      light: generateGrayScale(RGBA.fromHex(bgHex("light")), false),
    } as const
  })

  const textMuted = createMemo(() => {
    return {
      dark: generateMutedTextColor(RGBA.fromHex(bgHex("dark")), true),
      light: generateMutedTextColor(RGBA.fromHex(bgHex("light")), false),
    } as const
  })

  const selectedColorDef = createMemo(() => COLOR_DEFS.find((c) => c.key === store.selectedColor))

  const colorsPerRow = createMemo(() => {
    const width = contentWidth()
    if (width >= 72) return 5
    if (width >= 56) return 4
    return 3
  })

  const colorBoxWidth = createMemo(() => {
    const width = contentWidth()
    const padding = 4
    const gap = 1
    const perRow = colorsPerRow()
    return Math.floor((width - padding - gap * (perRow - 1)) / perRow)
  })

  const generatedTheme = createMemo(() => {
    const darkPrefix = "darkStep"
    const lightPrefix = "lightStep"

    return {
      $schema: "https://nikcli-ai.dev/theme.json",
      defs: {
        [`${darkPrefix}1`]: bgHex("dark"),
        [`${darkPrefix}2`]: rgbaToHex(grays().dark[2]!),
        [`${darkPrefix}3`]: rgbaToHex(grays().dark[3]!),
        [`${darkPrefix}4`]: rgbaToHex(grays().dark[4]!),
        [`${darkPrefix}5`]: rgbaToHex(grays().dark[5]!),
        [`${darkPrefix}6`]: rgbaToHex(grays().dark[6]!),
        [`${darkPrefix}7`]: rgbaToHex(grays().dark[7]!),
        [`${darkPrefix}8`]: rgbaToHex(grays().dark[8]!),
        [`${darkPrefix}9`]: accentHex("dark"),
        [`${darkPrefix}10`]: rgbaToHex(grays().dark[10]!),
        [`${darkPrefix}11`]: rgbaToHex(textMuted().dark),
        [`${darkPrefix}12`]: rgbaToHex(grays().dark[12]!),

        [`${lightPrefix}1`]: bgHex("light"),
        [`${lightPrefix}2`]: rgbaToHex(grays().light[2]!),
        [`${lightPrefix}3`]: rgbaToHex(grays().light[3]!),
        [`${lightPrefix}4`]: rgbaToHex(grays().light[4]!),
        [`${lightPrefix}5`]: rgbaToHex(grays().light[5]!),
        [`${lightPrefix}6`]: rgbaToHex(grays().light[6]!),
        [`${lightPrefix}7`]: rgbaToHex(grays().light[7]!),
        [`${lightPrefix}8`]: rgbaToHex(grays().light[8]!),
        [`${lightPrefix}9`]: accentHex("light"),
        [`${lightPrefix}10`]: rgbaToHex(grays().light[10]!),
        [`${lightPrefix}11`]: rgbaToHex(textMuted().light),
        [`${lightPrefix}12`]: rgbaToHex(grays().light[12]!),
      },
      theme: {
        primary: {
          dark: store.colors.dark.primary || `${darkPrefix}9`,
          light: store.colors.light.primary || `${lightPrefix}9`,
        },
        secondary: {
          dark: store.colors.dark.secondary || `${darkPrefix}9`,
          light: store.colors.light.secondary || `${lightPrefix}9`,
        },
        accent: {
          dark: store.colors.dark.accent || `${darkPrefix}9`,
          light: store.colors.light.accent || `${lightPrefix}9`,
        },
        error: { dark: store.colors.dark.error || "#d45f5f", light: store.colors.light.error || "#b42338" },
        warning: { dark: store.colors.dark.warning || "#d9a14a", light: store.colors.light.warning || "#7a4e00" },
        success: { dark: store.colors.dark.success || "#7fc08f", light: store.colors.light.success || "#2f9e44" },
        info: { dark: store.colors.dark.info || "#58a6b8", light: store.colors.light.info || "#0b7285" },

        text: {
          dark: store.colors.dark.text || `${darkPrefix}12`,
          light: store.colors.light.text || `${lightPrefix}12`,
        },
        textMuted: {
          dark: store.colors.dark.textMuted || `${darkPrefix}11`,
          light: store.colors.light.textMuted || `${lightPrefix}11`,
        },
        selectedListItemText: { dark: `${darkPrefix}1`, light: `${lightPrefix}1` },

        background: {
          dark: store.colors.dark.background || `${darkPrefix}1`,
          light: store.colors.light.background || `${lightPrefix}1`,
        },
        backgroundPanel: {
          dark: store.colors.dark.backgroundPanel || `${darkPrefix}2`,
          light: store.colors.light.backgroundPanel || `${lightPrefix}2`,
        },
        backgroundElement: {
          dark: store.colors.dark.backgroundElement || `${darkPrefix}3`,
          light: store.colors.light.backgroundElement || `${lightPrefix}3`,
        },
        backgroundMenu: {
          dark: store.colors.dark.backgroundElement || `${darkPrefix}3`,
          light: store.colors.light.backgroundElement || `${lightPrefix}3`,
        },

        borderSubtle: {
          dark: store.colors.dark.borderSubtle || `${darkPrefix}6`,
          light: store.colors.light.borderSubtle || `${lightPrefix}6`,
        },
        border: {
          dark: store.colors.dark.border || `${darkPrefix}7`,
          light: store.colors.light.border || `${lightPrefix}7`,
        },
        borderActive: {
          dark: store.colors.dark.borderActive || `${darkPrefix}8`,
          light: store.colors.light.borderActive || `${lightPrefix}8`,
        },

        diffAdded: { dark: "#4fd6be", light: "#1a8d78" },
        diffRemoved: { dark: "#c53b53", light: "#b42338" },
        diffContext: { dark: "#828bb8", light: "#5a6278" },
        diffHunkHeader: { dark: "#828bb8", light: "#5a6278" },
        diffHighlightAdded: { dark: "#b8db87", light: "#2e7d32" },
        diffHighlightRemoved: { dark: "#e26a75", light: "#b42338" },
        diffAddedBg: { dark: "#20303b", light: "#e6f4ea" },
        diffRemovedBg: { dark: "#37222c", light: "#fde7ea" },
        diffContextBg: { dark: `${darkPrefix}2`, light: `${lightPrefix}2` },
        diffLineNumber: { dark: `${darkPrefix}3`, light: `${lightPrefix}3` },
        diffAddedLineNumberBg: { dark: "#1b2b34", light: "#d7f3e3" },
        diffRemovedLineNumberBg: { dark: "#2d1f26", light: "#fbd5dc" },

        markdownText: { dark: `${darkPrefix}12`, light: `${lightPrefix}12` },
        markdownHeading: {
          dark: store.colors.dark.accent || `${darkPrefix}9`,
          light: store.colors.light.accent || `${lightPrefix}9`,
        },
        markdownLink: { dark: `${darkPrefix}9`, light: `${lightPrefix}9` },
        markdownLinkText: { dark: "#58a6b8", light: "#0b7285" },
        markdownCode: { dark: "#7fc08f", light: "#2f9e44" },
        markdownBlockQuote: { dark: "#d2b56d", light: "#8a6d3b" },
        markdownEmph: { dark: "#d2b56d", light: "#8a6d3b" },
        markdownStrong: { dark: "#d9a14a", light: "#7a4e00" },
        markdownHorizontalRule: { dark: `${darkPrefix}11`, light: `${lightPrefix}11` },
        markdownListItem: { dark: `${darkPrefix}9`, light: `${lightPrefix}9` },
        markdownListEnumeration: { dark: "#58a6b8", light: "#0b7285" },
        markdownImage: { dark: `${darkPrefix}9`, light: `${lightPrefix}9` },
        markdownImageText: { dark: "#58a6b8", light: "#0b7285" },
        markdownCodeBlock: { dark: `${darkPrefix}12`, light: `${lightPrefix}12` },

        syntaxComment: { dark: `${darkPrefix}11`, light: `${lightPrefix}11` },
        syntaxKeyword: {
          dark: store.colors.dark.accent || `${darkPrefix}9`,
          light: store.colors.light.accent || `${lightPrefix}9`,
        },
        syntaxFunction: { dark: `${darkPrefix}9`, light: `${lightPrefix}9` },
        syntaxVariable: { dark: "#d45f5f", light: "#b42338" },
        syntaxString: { dark: "#7fc08f", light: "#2f9e44" },
        syntaxNumber: { dark: "#d9a14a", light: "#7a4e00" },
        syntaxType: { dark: "#d2b56d", light: "#8a6d3b" },
        syntaxOperator: { dark: "#58a6b8", light: "#0b7285" },
        syntaxPunctuation: { dark: `${darkPrefix}12`, light: `${lightPrefix}12` },

        thinkingOpacity: 0.6,
      },
    }
  })

  const resetOverwriteArm = () => {
    if (store.overwriteArmed) setStore("overwriteArmed", false)
  }

  async function resolveThemesDir() {
    if (store.scope === "global") return path.join(Global.Path.config, "themes")
    const found = await Array.fromAsync(
      Filesystem.up({
        targets: [".nikcli"],
        start: process.cwd(),
      }),
    ).then((x) => x[0])
    const nikcliDir = found ?? path.join(process.cwd(), ".nikcli")
    return path.join(nikcliDir, "themes")
  }

  const handleSave = async () => {
    const normalized = normalizeThemeName(store.name)
    if (!normalized.ok) {
      setStore("status", normalized.reason)
      return
    }

    if (store.name.trim() !== normalized.value) {
      setStore("name", normalized.value)
    }

    setStore("saving", true)
    setStore("status", "")

    try {
      const themeName = normalized.value
      const themesDir = await resolveThemesDir()
      await mkdir(themesDir, { recursive: true })
      const filePath = path.join(themesDir, `${themeName}.json`)

      const exists = await Bun.file(filePath).exists()
      if (exists && !store.overwriteArmed) {
        setStore("saving", false)
        setStore("overwriteArmed", true)
        setStore("status", `Theme "${themeName}" already exists. Press Ctrl+S again to overwrite.`)
        return
      }

      await Bun.write(filePath, JSON.stringify(generatedTheme(), null, 2))
      await themeCtx.reload()
      themeCtx.set(themeName)
      dialog.clear()
    } catch (e) {
      setStore("saving", false)
      setStore("status", e instanceof Error ? e.message : "Failed to save theme.")
    }
  }

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "s" && !store.saving) {
      evt.preventDefault()
      evt.stopPropagation()
      handleSave()
      return
    }
    if (evt.name === "escape") {
      dialog.clear()
      return
    }

    if (evt.name === "tab") {
      if (store.selectedColor === "__name__") {
        setStore("selectedIndex", 0)
        setStore("selectedColor", COLOR_DEFS[0]!.key)
      } else {
        setStore("selectedIndex", -1)
        setStore("selectedColor", "__name__")
        setTimeout(() => nameInput?.focus?.(), 1)
      }
      return
    }

    if (evt.name === "v") {
      setStore("variant", store.variant === "dark" ? "light" : "dark")
      resetOverwriteArm()
      return
    }

    if (evt.name === "g") {
      setStore("scope", store.scope === "global" ? "project" : "global")
      resetOverwriteArm()
      return
    }

    const perRow = colorsPerRow()
    const totalColors = COLOR_DEFS.length

    if (evt.name === "down" || evt.name === "j") {
      const next = store.selectedIndex < 0 ? 0 : Math.min(store.selectedIndex + perRow, totalColors - 1)
      setStore("selectedIndex", next)
      setStore("selectedColor", COLOR_DEFS[next]!.key)
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      const next = store.selectedIndex < 0 ? 0 : Math.max(store.selectedIndex - perRow, 0)
      setStore("selectedIndex", next)
      setStore("selectedColor", COLOR_DEFS[next]!.key)
      return
    }
    if (evt.name === "left" || evt.name === "h") {
      const next = store.selectedIndex < 0 ? 0 : Math.max(store.selectedIndex - 1, 0)
      setStore("selectedIndex", next)
      setStore("selectedColor", COLOR_DEFS[next]!.key)
      return
    }
    if (evt.name === "right" || evt.name === "l") {
      const next = store.selectedIndex < 0 ? 0 : Math.min(store.selectedIndex + 1, totalColors - 1)
      setStore("selectedIndex", next)
      setStore("selectedColor", COLOR_DEFS[next]!.key)
      return
    }

    if (store.selectedColor && store.selectedColor !== "__name__") {
      const pickerTotal = PRESET_COLORS.length
      if (evt.name === "w" || evt.name === "W") {
        setStore("pickerIndex", Math.max(store.pickerIndex - 5, 0))
        return
      }
      if (evt.name === "s" || evt.name === "S") {
        setStore("pickerIndex", Math.min(store.pickerIndex + 5, pickerTotal - 1))
        return
      }
      if (evt.name === "a" || evt.name === "A" || evt.name === "p") {
        setStore("pickerIndex", Math.max(store.pickerIndex - 1, 0))
        return
      }
      if (evt.name === "d" || evt.name === "D" || evt.name === "n") {
        setStore("pickerIndex", Math.min(store.pickerIndex + 1, pickerTotal - 1))
        return
      }
      if (evt.name === "space" || evt.name === " ") {
        const color = PRESET_COLORS[store.pickerIndex]
        if (color && store.selectedColor) {
          setStore("colors", store.variant, store.selectedColor, color)
          resetOverwriteArm()
        }
        return
      }
    }
  })

  const colorList = createMemo(() => {
    return COLOR_DEFS.map((def, index) => {
      const value =
        store.colors[store.variant][def.key] ||
        (def.key === "primary"
          ? defaultAccentHex
          : def.key === "background"
            ? defaultBgHex(store.variant)
            : def.key === "text"
              ? defaultTextHex(store.variant)
              : defaultAccentHex)
      return { ...def, index, value }
    })
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.foreground.default}>
          Create Theme
        </text>
        <text fg={theme.foreground.muted}>tab focus · v variant · g scope · ctrl+s save</text>
      </box>

      <Show when={store.status}>
        <text fg={store.overwriteArmed ? theme.status.warning.fg : theme.foreground.muted} wrapMode="word">
          {store.status}
        </text>
      </Show>

      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={theme.foreground.muted}>Name:</text>
        <box
          width={25}
          border={["bottom"]}
          borderColor={store.selectedColor === "__name__" ? theme.accent.fg : theme.border.subtle}
          onMouseUp={() => {
            setStore("selectedColor", "__name__")
            setStore("selectedIndex", -1)
            setTimeout(() => nameInput?.focus?.(), 1)
          }}
        >
          <input
            value={store.name}
            onInput={(v) => {
              setStore("name", v)
              setStore("status", "")
              resetOverwriteArm()
            }}
            placeholder="my-theme"
            cursorColor={theme.accent.fg}
            focusedTextColor={theme.foreground.default}
            ref={(r) => {
              nameInput = r
            }}
          />
        </box>
      </box>

      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={theme.foreground.muted}>Variant:</text>
        <For each={["dark", "light"] as const}>
          {(variant) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={store.variant === variant ? theme.accent.fg : theme.surface.offset}
              onMouseUp={() => {
                setStore("variant", variant)
                resetOverwriteArm()
              }}
            >
              <text fg={store.variant === variant ? theme.badge.fg : theme.foreground.default}>{variant}</text>
            </box>
          )}
        </For>
      </box>

      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={theme.foreground.muted}>Scope:</text>
        <For each={["global", "project"] as const}>
          {(scope) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={store.scope === scope ? theme.accent.fg : theme.surface.offset}
              onMouseUp={() => {
                setStore("scope", scope)
                resetOverwriteArm()
              }}
            >
              <text fg={store.scope === scope ? theme.badge.fg : theme.foreground.default}>{scope}</text>
            </box>
          )}
        </For>
      </box>

      <box height={1} border={["top"]} borderColor={theme.border.subtle} />

      <scrollbox scrollAcceleration={scrollAcceleration()} maxHeight={18} scrollbarOptions={{ visible: false }}>
        <box flexDirection="row" flexWrap="wrap" gap={1}>
          <For each={colorList()}>
            {(item) => {
              const isSelected = store.selectedIndex === item.index
              return (
                <box
                  width={colorBoxWidth()}
                  backgroundColor={theme.surface.panel}
                  border={["top", "bottom", "left", "right"]}
                  borderColor={isSelected ? theme.accent.fg : theme.border.subtle}
                  onMouseUp={() => {
                    setStore("selectedIndex", item.index)
                    setStore("selectedColor", item.key)
                  }}
                >
                  <box paddingLeft={1} gap={0}>
                    <text
                      fg={isSelected ? theme.accent.fg : theme.foreground.default}
                      attributes={isSelected ? TextAttributes.BOLD : undefined}
                    >
                      {item.label}
                    </text>
                    <box flexDirection="row" gap={0} alignItems="center" paddingTop={1}>
                      <box width={3} height={1} backgroundColor={RGBA.fromHex(item.value)} />
                      <text fg={theme.foreground.muted} marginLeft={1}>
                        {item.value}
                      </text>
                    </box>
                  </box>
                </box>
              )
            }}
          </For>
        </box>
      </scrollbox>

      <Show when={store.selectedColor && store.selectedColor !== "__name__"}>
        <box
          backgroundColor={theme.surface.panel}
          border={["top", "bottom", "left", "right"]}
          borderColor={theme.border.default}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          gap={1}
        >
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD} fg={theme.foreground.default}>
              {selectedColorDef()?.label}: {selectedColorDef()?.description}
            </text>
          </box>
          <scrollbox scrollAcceleration={scrollAcceleration()} maxHeight={5} scrollbarOptions={{ visible: false }}>
            <box flexDirection="row" flexWrap="wrap" gap={1}>
              <For each={PRESET_COLORS}>
                {(color, i) => {
                  const isSelected = i() === store.pickerIndex
                  return (
                    <box
                      width={4}
                      height={1}
                      backgroundColor={RGBA.fromHex(color)}
                      border={["top", "bottom", "left", "right"]}
                      borderColor={isSelected ? theme.accent.fg : theme.border.subtle}
                      onMouseUp={() => {
                        setStore("pickerIndex", i())
                        if (store.selectedColor) {
                          setStore("colors", store.variant, store.selectedColor, color)
                          resetOverwriteArm()
                        }
                      }}
                    />
                  )
                }}
              </For>
            </box>
          </scrollbox>
        </box>
      </Show>

      <box height={1} border={["top"]} borderColor={theme.border.subtle} />

      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <box flexDirection="row" gap={1}>
          <box
            width={4}
            height={2}
            backgroundColor={RGBA.fromHex(store.colors[store.variant].primary || defaultAccentHex)}
            border={["top", "bottom", "left", "right"]}
            borderColor={theme.border.subtle}
          >
            <box paddingLeft={1} paddingTop={1}>
              <text fg={RGBA.fromHex(store.colors[store.variant].background || defaultBgHex(store.variant))}>Aa</text>
            </box>
          </box>
          <box
            width={4}
            height={2}
            backgroundColor={RGBA.fromHex(store.colors[store.variant].background || defaultBgHex(store.variant))}
            border={["top", "bottom", "left", "right"]}
            borderColor={theme.border.subtle}
            justifyContent="center"
            alignItems="center"
          >
            <text fg={RGBA.fromHex(store.colors[store.variant].text || defaultTextHex(store.variant))}>Text</text>
          </box>
        </box>

        <box flexDirection="row" gap={1}>
          <box paddingLeft={1} paddingRight={1} backgroundColor={theme.surface.offset} onMouseUp={() => dialog.clear()}>
            <text fg={theme.foreground.muted}>Cancel</text>
          </box>
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={
              store.name && !store.saving
                ? store.overwriteArmed
                  ? theme.status.warning.fg
                  : theme.accent.fg
                : theme.surface.offset
            }
            onMouseUp={() => store.name && !store.saving && handleSave()}
          >
            <text fg={store.name && !store.saving ? theme.badge.fg : theme.foreground.muted}>
              {store.saving ? "Saving..." : store.overwriteArmed ? "Overwrite Theme" : "Save Theme"}
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}
