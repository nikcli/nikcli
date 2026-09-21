import { TextAttributes, RGBA } from "@opentui/core"
import { createMemo, For, Show, Index } from "solid-js"
import { useTheme } from "../context/theme"
import type { Theme } from "../context/theme"

// ===== Color utilities =====

function vizRgb(r: number, g: number, b: number): RGBA {
  return RGBA.fromInts(r, g, b)
}

/**
 * Theme-aware fallback dataviz palette.
 *
 * Why this exists: the original chart palette was a set of hardcoded RGBA
 * values that ignored the active theme, so on, say, a light "github-light"
 * theme the chart would still paint bright cyan/orange that fought the
 * background. The new palette is derived from the theme's semantic tokens
 * (`primary`, `accent`, `success`, `warning`, `error`, `info`) with
 * luminance-shifted variants for the additional series, so charts stay
 * legible on any background while keeping enough hue variety to
 * distinguish multi-series line charts at a glance.
 */
function luminance(rgba: RGBA): number {
  // Standard ITU-R BT.601 weighting; used to decide if a derived color
  // needs lightening or darkening for legibility.
  return (0.299 * rgba.r + 0.587 * rgba.g + 0.114 * rgba.b) / 255
}

function shift(rgba: RGBA, dr: number, dg: number, db: number): RGBA {
  return RGBA.fromInts(
    Math.max(0, Math.min(255, Math.round(rgba.r * 255 + dr))),
    Math.max(0, Math.min(255, Math.round(rgba.g * 255 + dg))),
    Math.max(0, Math.min(255, Math.round(rgba.b * 255 + db))),
  )
}

// Linear blend of two colors. t=0 → a, t=1 → b.
function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return RGBA.fromInts(
    Math.round((a.r + (b.r - a.r) * t) * 255),
    Math.round((a.g + (b.g - a.g) * t) * 255),
    Math.round((a.b + (b.b - a.b) * t) * 255),
  )
}

/**
 * Derive an N-color categorical palette from a theme. The first 4 colors
 * mirror the semantic tokens (primary, success, warning, accent) so that
 * the most-used positions stay consistent with the rest of the UI; the
 * remaining slots are hue-rotated shifts of `primary` so each series
 * remains distinguishable on a chart with 5+ series.
 */
function themeSeriesPalette(theme: Theme): RGBA[] {
  // Hue rotation by mixing with rotated neighbors. Each rotation shifts
  // along the R→G→B ring so the resulting colors stay saturated.
  const primary = theme.accent.fg
  const rotated = (base: RGBA, steps: number): RGBA => {
    // 120° hue rotation via channel swap. Three steps covers the full ring.
    let r = base.r * 255
    let g = base.g * 255
    let b = base.b * 255
    const dir = steps > 0 ? 1 : -1
    for (let i = 0; i < Math.abs(steps); i++) {
      if (dir > 0) {
        const nr = g
        const ng = b
        const nb = r
        r = nr
        g = ng
        b = nb
      } else {
        const nr = b
        const ng = r
        const nb = g
        r = nr
        g = ng
        b = nb
      }
    }
    return RGBA.fromInts(Math.round(r), Math.round(g), Math.round(b))
  }

  // For the input/output/cache/reasoning semantic colors, derive from
  // theme tokens instead of hardcoding RGB. If the theme's tokens are very
  // close to the background, push them away for chart legibility.
  const isLow = (c: RGBA) => luminance(c) < 0.15
  const lift = (c: RGBA) => (isLow(c) ? shift(c, 60, 60, 60) : c)

  return [
    lift(theme.accent.fg), // 0 — primary
    lift(theme.status.success.fg), // 1 — success/positive
    lift(theme.status.warning.fg), // 2 — warning/cache
    lift(theme.accent.alt), // 3 — accent/reasoning
    rotated(primary, 1), // 4
    rotated(primary, 2), // 5
    rotated(primary, -1), // 6
    rotated(primary, -2), // 7
  ]
}

function themeSemanticColors(theme: Theme) {
  return {
    input: theme.accent.fg,
    output: theme.status.warning.fg,
    cache: theme.status.success.fg,
    cacheWrite: theme.status.info.fg,
    reasoning: theme.accent.alt,
    alert: theme.status.error.fg,
  }
}

/**
 * Chart colors used by the analytics panel. Derived from the active theme
 * so charts adapt to light/dark/sepia themes; falls back to a saturated
 * palette on themes whose tokens have very low luminance.
 */
export function getChartColors(theme: Theme): {
  series: RGBA[]
  input: RGBA
  output: RGBA
  cache: RGBA
  cacheWrite: RGBA
  reasoning: RGBA
  alert: RGBA
} {
  const series = themeSeriesPalette(theme)
  const sem = themeSemanticColors(theme)
  return {
    series,
    ...sem,
  }
}

// ===== Braille Encoding =====
// Each braille character (U+2800–U+28FF) encodes a 2×4 dot matrix:
//
// Dot layout:        Bit mapping:
// col 0  col 1       Bit 0 (0x01) → row 0, col 0
// ┌────┬────┐        Bit 1 (0x02) → row 1, col 0
// │ 1  │ 8  │ row 0  Bit 2 (0x04) → row 2, col 0
// │ 2  │ 16 │ row 1  Bit 3 (0x08) → row 0, col 1
// │ 4  │ 32 │ row 2  Bit 4 (0x10) → row 1, col 1
// │ 64 │ 128│ row 3  Bit 5 (0x20) → row 2, col 1
// └────┴────┘        Bit 6 (0x40) → row 3, col 0
//                    Bit 7 (0x80) → row 3, col 1

const BRAILLE_BASE = 0x2800
const BRAILLE_BITS: number[][] = [
  [0x01, 0x08], // row 0
  [0x02, 0x10], // row 1
  [0x04, 0x20], // row 2
  [0x40, 0x80], // row 3
]

// Render data points into a braille grid
function renderBrailleGrid(data: number[], charW: number, charH: number): string[] {
  const pixelW = charW * 2
  const pixelH = charH * 4

  if (data.length === 0) {
    return Array.from({ length: charH }, () => " ".repeat(charW))
  }

  // Normalize data to pixel coordinates
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1

  // Create pixel grid using Uint8Array for bitfield
  const grid: Uint8Array[] = Array.from({ length: pixelH }, () => new Uint8Array(Math.ceil(pixelW / 8)))

  function setPixel(x: number, y: number) {
    if (x >= 0 && x < pixelW && y >= 0 && y < pixelH) {
      const byteIdx = Math.floor(x / 8)
      const bitIdx = x % 8
      grid[y]![byteIdx] |= 1 << bitIdx
    }
  }

  function isPixelSet(x: number, y: number): boolean {
    if (x < 0 || x >= pixelW || y < 0 || y >= pixelH) return false
    const byteIdx = Math.floor(x / 8)
    const bitIdx = x % 8
    return (grid[y]![byteIdx] & (1 << bitIdx)) !== 0
  }

  function drawLine(g: Uint8Array[], x0: number, y0: number, x1: number, y1: number, w: number, h: number) {
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    let x = x0
    let y = y0
    while (true) {
      if (x >= 0 && x < w && y >= 0 && y < h) {
        const byteIdx = Math.floor(x / 8)
        const bitIdx = x % 8
        g[y]![byteIdx] |= 1 << bitIdx
      }
      if (x === x1 && y === y1) break
      const e2 = 2 * err
      if (e2 > -dy) {
        err -= dy
        x += sx
      }
      if (e2 < dx) {
        err += dx
        y += sy
      }
    }
  }

  // Map data to pixel coordinates
  const points: { x: number; y: number }[] = data.map((value, i) => {
    const x = data.length === 1 ? Math.floor(pixelW / 2) : Math.round((i / (data.length - 1)) * (pixelW - 1))
    const normalized = (value - min) / range
    const y = Math.round((1 - normalized) * (pixelH - 1))
    return {
      x: Math.max(0, Math.min(pixelW - 1, x)),
      y: Math.max(0, Math.min(pixelH - 1, y)),
    }
  })

  // Draw lines between consecutive points using Bresenham
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]!
    const p2 = points[i + 1]!
    drawLine(grid, p1.x, p1.y, p2.x, p2.y, pixelW, pixelH)
  }

  // Draw dots at data points
  for (const p of points) {
    setPixel(p.x, p.y)
    // Also set adjacent pixels for thicker dots
    if (p.x + 1 < pixelW) setPixel(p.x + 1, p.y)
    if (p.y + 1 < pixelH) setPixel(p.x, p.y + 1)
  }

  // Convert pixel grid to braille characters
  const lines: string[] = []
  for (let cy = 0; cy < charH; cy++) {
    let line = ""
    for (let cx = 0; cx < charW; cx++) {
      let mask = 0
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 2; px++) {
          const pixelX = cx * 2 + px
          const pixelY = cy * 4 + py
          if (isPixelSet(pixelX, pixelY)) {
            mask |= BRAILLE_BITS[py]![px]!
          }
        }
      }
      line += String.fromCharCode(BRAILLE_BASE + mask)
    }
    lines.push(line)
  }
  return lines
}

// Multi-series rendering: OR braille masks from multiple series
function renderMultiSeriesBraille(
  seriesData: number[][],
  charW: number,
  charH: number,
): { lines: string[]; seriesMask: number[][][] } {
  const pixelW = charW * 2
  const pixelH = charH * 4

  // Find global min/max across all series
  let globalMax = 1
  let globalMin = 0
  for (const data of seriesData) {
    for (const v of data) {
      globalMax = Math.max(globalMax, v)
      globalMin = Math.min(globalMin, v)
    }
  }
  const range = globalMax - globalMin || 1

  // Create pixel grid per series
  const seriesGrids: boolean[][][] = seriesData.map(() =>
    Array.from({ length: pixelH }, () => new Array(pixelW).fill(false)),
  )

  for (let s = 0; s < seriesData.length; s++) {
    const data = seriesData[s]!
    const grid = seriesGrids[s]!

    if (data.length === 0) continue

    const points: { x: number; y: number }[] = data.map((value, i) => {
      const x = data.length === 1 ? Math.floor(pixelW / 2) : Math.round((i / (data.length - 1)) * (pixelW - 1))
      const normalized = (value - globalMin) / range
      const y = Math.round((1 - normalized) * (pixelH - 1))
      return {
        x: Math.max(0, Math.min(pixelW - 1, x)),
        y: Math.max(0, Math.min(pixelH - 1, y)),
      }
    })

    // Bresenham for this series
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i]!
      const p2 = points[i + 1]!
      const dx = Math.abs(p2.x - p1.x)
      const dy = Math.abs(p2.y - p1.y)
      const sx = p1.x < p2.x ? 1 : -1
      const sy = p1.y < p2.y ? 1 : -1
      let err = dx - dy
      let x = p1.x
      let y = p1.y
      while (true) {
        if (x >= 0 && x < pixelW && y >= 0 && y < pixelH) grid[y]![x] = true
        if (x === p2.x && y === p2.y) break
        const e2 = 2 * err
        if (e2 > -dy) {
          err -= dy
          x += sx
        }
        if (e2 < dx) {
          err += dx
          y += sy
        }
      }
    }

    // Dots at data points
    for (const p of points) {
      if (p.x >= 0 && p.x < pixelW && p.y >= 0 && p.y < pixelH) grid[p.y]![p.x] = true
    }
  }

  // Determine dominant series per character cell
  const seriesMask: number[][][] = Array.from({ length: charH }, () =>
    Array.from({ length: charW }, () => [] as number[]),
  )

  // Build combined braille lines
  const lines: string[] = []
  for (let cy = 0; cy < charH; cy++) {
    let line = ""
    for (let cx = 0; cx < charW; cx++) {
      let mask = 0
      const contributing: number[] = []
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 2; px++) {
          const pixelX = cx * 2 + px
          const pixelY = cy * 4 + py
          if (pixelY < pixelH && pixelX < pixelW) {
            // Check all series for this pixel (last series wins for color)
            for (let s = seriesData.length - 1; s >= 0; s--) {
              if (seriesGrids[s]![pixelY]![pixelX]) {
                mask |= BRAILLE_BITS[py]![px]!
                if (!contributing.includes(s)) contributing.push(s)
                break
              }
            }
          }
        }
      }
      seriesMask[cy]![cx] = contributing
      line += String.fromCharCode(BRAILLE_BASE + mask)
    }
    lines.push(line)
  }

  return { lines, seriesMask }
}

// ===== Format helpers =====

function formatTokens(n: number): string {
  if (n < 1_000) return n.toString()
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// ===== COMPONENTS =====

/**
 * Multi-series line chart with per-character color segmentation.
 *
 * Earlier revisions colored each row by its dominant series — meaning a
 * 3-series chart looked like a single line in one color, defeating the
 * purpose of having multiple series. This version splits each row into
 * runs of characters that share the same dominant series and emits one
 * <text> per run with the matching color, so crossovers between two
 * series render in their own distinct hues.
 *
 * Concretely: the 30-day token-usage chart with Input (primary),
 * Output (warning) and Cache (success) now shows a primary-blue bulk
 * with orange and green segments where Output or Cache cross above
 * Input — making trends per category visible at a glance.
 */
export function BrailleLineChart(props: {
  series: { label: string; data: number[]; color: RGBA }[]
  width: number
  height: number
  yFormat?: (v: number) => string
  /** One label per data point (e.g. dates). First/mid/last are shown on the
   *  X axis; falls back to numeric indices when omitted. */
  xLabels?: string[]
  showGrid?: boolean
  showLegend?: boolean
  showAxis?: boolean
}) {
  const { theme } = useTheme()

  const yFmt = () => props.yFormat ?? formatTokens

  const chart = createMemo(() => {
    const series = props.series
    if (series.length === 0 || series.every((s) => s.data.length === 0)) {
      return {
        lines: [],
        axisLine: "",
        xLabelRow: "",
        yLabels: [],
        legend: [],
        rowSegments: [] as Array<Array<{ text: string; color: RGBA }>>,
      }
    }

    const chartW = props.width - (props.showAxis !== false ? 7 : 0)
    const chartH = props.height

    if (chartW <= 0 || chartH <= 0) {
      return {
        lines: [],
        axisLine: "",
        xLabelRow: "",
        yLabels: [],
        legend: [],
        rowSegments: [] as Array<Array<{ text: string; color: RGBA }>>,
      }
    }

    // Render multi-series braille
    const seriesData = series.map((s) => s.data)
    const { lines, seriesMask } = renderMultiSeriesBraille(seriesData, chartW, chartH)

    // Find global max for Y-axis labels
    let globalMax = 1
    for (const s of series) {
      for (const v of s.data) {
        globalMax = Math.max(globalMax, v)
      }
    }

    // Y-axis labels
    const yLabels: { pos: number; label: string }[] = []
    const numLabels = Math.min(3, chartH)
    for (let i = 0; i < numLabels; i++) {
      const value = (globalMax * (numLabels - 1 - i)) / (numLabels - 1)
      const y = Math.round((i / (numLabels - 1)) * (chartH - 1))
      yLabels.push({ pos: y, label: yFmt()(value) })
    }

    // X-axis labels (first, middle, last) — use caller-supplied labels
    // (dates) when available, else numeric indices. Composed into a single
    // chartW-wide row so the labels sit exactly under their data points.
    const firstSeries = series.find((s) => s.data.length > 0)
    const n = firstSeries?.data.length ?? 0
    const labelAt = (i: number) => props.xLabels?.[i] ?? String(i)
    const axisLine = "─".repeat(Math.max(0, chartW))
    let xLabelRow = ""
    if (n >= 1) {
      const slots = " ".repeat(Math.max(0, chartW)).split("")
      const place = (text: string, pos: number, align: "left" | "center" | "right") => {
        let start = pos
        if (align === "center") start = pos - Math.floor(text.length / 2)
        else if (align === "right") start = pos - text.length + 1
        for (let k = 0; k < text.length; k++) {
          const idx = start + k
          if (idx >= 0 && idx < slots.length) slots[idx] = text[k]!
        }
      }
      place(labelAt(0), 0, "left")
      if (n >= 3) place(labelAt(Math.floor((n - 1) / 2)), Math.floor(chartW / 2), "center")
      if (n >= 2) place(labelAt(n - 1), chartW - 1, "right")
      xLabelRow = slots.join("")
    }

    // Per-row color segmentation: walk each row left-to-right, accumulate
    // runs of characters with the same dominant series, and emit one
    // segment per run. Empty cells (no series) are rendered in
    // `textMuted` so the grid keeps its background tone.
    const rowSegments: Array<Array<{ text: string; color: RGBA }>> = []
    for (let cy = 0; cy < lines.length; cy++) {
      const row = lines[cy]!
      const rowMask = seriesMask[cy] ?? []
      const segments: Array<{ text: string; color: RGBA }> = []
      let runText = ""
      let runColor: RGBA | null = null
      const flush = () => {
        if (runText) {
          segments.push({ text: runText, color: runColor ?? theme.foreground.default })
        }
        runText = ""
        runColor = null
      }
      for (let cx = 0; cx < row.length; cx++) {
        const contributing = rowMask[cx] ?? []
        let color: RGBA
        if (contributing.length === 0) {
          color = theme.foreground.muted
        } else {
          // Pick the highest-indexed contributing series (matches the
          // pixel-order used during render so segment colors line up
          // with which line is "on top" at that character).
          const idx = contributing[contributing.length - 1]!
          color = series[idx]?.color ?? theme.foreground.default
        }
        if (runColor && colorsEqual(runColor, color)) {
          runText += row[cx]
        } else {
          flush()
          runText = row[cx] ?? ""
          runColor = color
        }
      }
      flush()
      rowSegments.push(segments)
    }

    return {
      lines,
      axisLine,
      xLabelRow,
      yLabels,
      seriesMask,
      rowSegments,
      legend: series.map((s) => ({ label: s.label, color: s.color })),
    }
  })

  return (
    <box gap={0}>
      {/* Legend */}
      <Show when={props.showLegend !== false && chart().legend.length > 0}>
        <box flexDirection="row" gap={3} paddingBottom={1} flexWrap="wrap">
          <For each={chart().legend}>
            {(item) => (
              <box flexDirection="row" gap={1} alignItems="center">
                <text fg={item.color} wrapMode="none">
                  ■
                </text>
                <text fg={theme.foreground.muted}>{item.label}</text>
              </box>
            )}
          </For>
        </box>
      </Show>

      {/* One physical row per chart row keeps Y labels and the axis aligned
          with the braille plot at every chart height. */}
      <box flexDirection="column" gap={0}>
        <For each={chart().rowSegments}>
          {(segments, row) => {
            const yLabel = () => chart().yLabels.find((label) => label.pos === row())?.label ?? ""
            return (
              <box flexDirection="row" gap={0}>
                <Show when={props.showAxis !== false}>
                  <text fg={theme.foreground.muted} width={6} wrapMode="none">
                    {yLabel().padStart(6)}
                  </text>
                  <text fg={theme.border.default} wrapMode="none">
                    │
                  </text>
                </Show>
                <For each={segments}>
                  {(seg) => (
                    <text fg={seg.color} wrapMode="none">
                      {seg.text}
                    </text>
                  )}
                </For>
              </box>
            )
          }}
        </For>
      </box>

      {/* X axis: baseline + first/mid/last labels, indented to line up with
          the chart area (past the y-label gutter + axis line). */}
      <Show when={props.showAxis !== false && chart().axisLine.length > 0}>
        <box flexDirection="row" gap={0}>
          <text wrapMode="none">{" ".repeat(7)}</text>
          <text fg={theme.border.default} wrapMode="none">
            {chart().axisLine}
          </text>
        </box>
        <Show when={chart().xLabelRow.trim().length > 0}>
          <box flexDirection="row" gap={0}>
            <text wrapMode="none">{" ".repeat(7)}</text>
            <text fg={theme.foreground.muted} wrapMode="none">
              {chart().xLabelRow}
            </text>
          </box>
        </Show>
      </Show>
    </box>
  )
}

/**
 * Compare two RGBA values for equality. RGBA from @opentui/core uses r/g/b
 * as 0..1 floats; for chart-segmentation purposes exact equality is
 * sufficient because we never mutate the color mid-segment.
 */
function colorsEqual(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && (a.a ?? 1) === (b.a ?? 1)
}

// Braille Area Chart - filled area below the line
export function BrailleAreaChart(props: {
  data: number[]
  width: number
  height: number
  color: RGBA
  yFormat?: (v: number) => string
}) {
  const lines = createMemo(() => {
    if (props.data.length === 0) return []

    const pixelW = props.width * 2
    const pixelH = props.height * 4

    const max = Math.max(...props.data, 1)
    const min = Math.min(...props.data, 0)
    const range = max - min || 1

    // Create pixel grid
    const grid: boolean[][] = Array.from({ length: pixelH }, () => new Array(pixelW).fill(false))

    // Map data to pixel coords and draw filled area
    const points: { x: number; y: number }[] = props.data.map((value, i) => {
      const x =
        props.data.length === 1 ? Math.floor(pixelW / 2) : Math.round((i / (props.data.length - 1)) * (pixelW - 1))
      const normalized = (value - min) / range
      const y = Math.round((1 - normalized) * (pixelH - 1))
      return {
        x: Math.max(0, Math.min(pixelW - 1, x)),
        y: Math.max(0, Math.min(pixelH - 1, y)),
      }
    })

    // Fill area below each point
    for (const p of points) {
      for (let y = p.y; y < pixelH; y++) {
        grid[y]![p.x] = true
      }
    }

    // Draw line on top
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i]!
      const p2 = points[i + 1]!
      const dx = Math.abs(p2.x - p1.x)
      const dy = Math.abs(p2.y - p1.y)
      const sx = p1.x < p2.x ? 1 : -1
      const sy = p1.y < p2.y ? 1 : -1
      let err = dx - dy
      let x = p1.x
      let y = p1.y
      while (true) {
        if (x >= 0 && x < pixelW && y >= 0 && y < pixelH) grid[y]![x] = true
        if (x === p2.x && y === p2.y) break
        const e2 = 2 * err
        if (e2 > -dy) {
          err -= dy
          x += sx
        }
        if (e2 < dx) {
          err += dx
          y += sy
        }
      }
    }

    // Convert to braille
    const result: string[] = []
    for (let cy = 0; cy < props.height; cy++) {
      let line = ""
      for (let cx = 0; cx < props.width; cx++) {
        let mask = 0
        for (let py = 0; py < 4; py++) {
          for (let px = 0; px < 2; px++) {
            const pixelX = cx * 2 + px
            const pixelY = cy * 4 + py
            if (pixelY < pixelH && pixelX < pixelW && grid[pixelY]![pixelX]) {
              mask |= BRAILLE_BITS[py]![px]!
            }
          }
        }
        line += String.fromCharCode(BRAILLE_BASE + mask)
      }
      result.push(line)
    }
    return result
  })

  return (
    <box flexDirection="column" gap={0}>
      <For each={lines()}>
        {(line) => (
          <text fg={props.color} wrapMode="none">
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

// Braille Sparkline - compact inline chart using braille
export function BrailleSparkline(props: { data: number[]; width: number; color: RGBA }) {
  const lines = createMemo(() => {
    if (props.data.length === 0) return [" ".repeat(props.width)]

    const chartH = 2 // 2 rows of braille = 8 pixel rows
    return renderBrailleGrid(props.data, props.width, chartH)
  })

  return (
    <box flexDirection="column" gap={0}>
      <For each={lines()}>
        {(line) => (
          <text fg={props.color} wrapMode="none">
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

// Stacked Bar Chart with 8-level Unicode blocks
export function StackedBarChartV2(props: {
  segments: { label: string; value: number; color: RGBA }[]
  width: number
  showLabels?: boolean
}) {
  const { theme } = useTheme()
  const total = createMemo(() => props.segments.reduce((sum, s) => sum + s.value, 0))
  const bars = createMemo(() => {
    const t = total()
    if (t === 0)
      return props.segments.map((s) => ({
        ...s,
        width: 0,
        pct: 0,
      }))

    // Two-pass allotment so every non-zero segment is visible (≥1 cell) while
    // zero segments take none, and the widths still sum to exactly `width`.
    // Pass 1: floor + guarantee ≥1 for non-zero. Pass 2: hand leftover cells
    // to the largest segments by fractional remainder.
    const raw = props.segments.map((s) => ({
      seg: s,
      exact: (s.value / t) * props.width,
    }))
    let used = 0
    const widths = raw.map((r) => {
      const w = r.seg.value <= 0 ? 0 : Math.max(1, Math.floor(r.exact))
      used += w
      return w
    })
    let leftover = props.width - used
    if (leftover !== 0) {
      const order = raw
        .map((r, i) => ({
          i,
          frac: r.exact - Math.floor(r.exact),
          nonZero: r.seg.value > 0,
        }))
        .filter((o) => o.nonZero)
        .sort((a, b) => b.frac - a.frac)
      let k = 0
      while (leftover > 0 && order.length > 0) {
        widths[order[k % order.length]!.i]! += 1
        leftover--
        k++
      }
      while (leftover < 0) {
        // Over-allotted (many tiny segments forced to 1): shave from the widest.
        let widestIdx = -1
        let widest = 1
        for (let i = 0; i < widths.length; i++) if (widths[i]! > widest) ((widest = widths[i]!), (widestIdx = i))
        if (widestIdx < 0) break
        widths[widestIdx]! -= 1
        leftover++
      }
    }
    return props.segments.map((s, i) => ({
      ...s,
      width: widths[i] ?? 0,
      pct: (s.value / t) * 100,
    }))
  })

  return (
    <box flexDirection="column" gap={0}>
      {/* Bar */}
      <box flexDirection="row" gap={0}>
        <Show
          when={total() > 0}
          fallback={
            <text fg={theme.border.subtle} wrapMode="none">
              {"░".repeat(Math.max(0, props.width))}
            </text>
          }
        >
          <For each={bars()}>
            {(seg) => (
              <Show when={seg.width > 0}>
                <text fg={seg.color} wrapMode="none">
                  {"█".repeat(seg.width)}
                </text>
              </Show>
            )}
          </For>
        </Show>
      </box>
      <Show when={props.showLabels}>
        <box flexDirection="row" gap={3} flexWrap="wrap">
          <For each={bars()}>
            {(seg) => (
              <box flexDirection="row" gap={1} alignItems="center">
                <text fg={seg.color} wrapMode="none">
                  ■
                </text>
                <text fg={theme.foreground.default} wrapMode="none">
                  {seg.label}
                </text>
                <text fg={theme.foreground.muted} wrapMode="none">
                  {formatTokens(seg.value)} ({seg.pct.toFixed(0)}%)
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

// Horizontal bar with 8-level precision (▏▎▍▌▋▊▉█)
export function HBarPrecision(props: {
  label: string
  value: number
  max: number
  width: number
  color: RGBA
  showPct?: boolean
}) {
  const { theme } = useTheme()
  const filled = createMemo(() => {
    if (props.max <= 0 || !Number.isFinite(props.max)) return 0
    return Math.min(props.width, Math.max(0, (props.value / props.max) * props.width))
  })
  const fullBlocks = createMemo(() => Math.floor(filled()))
  const partial = createMemo(() => {
    const frac = filled() - fullBlocks()
    const chars = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
    const idx = Math.round(frac * 8)
    return chars[Math.min(idx, 7)] ?? ""
  })
  const pct = createMemo(() => (props.max > 0 ? Math.round((props.value / props.max) * 100) : 0))

  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <text fg={theme.foreground.muted} width={10} wrapMode="none">
        {props.label.padEnd(10)}
      </text>
      <text fg={props.color} wrapMode="none">
        {"█".repeat(fullBlocks())}
        {partial()}
      </text>
      <text fg={theme.border.subtle} wrapMode="none">
        {"░".repeat(Math.max(0, props.width - fullBlocks() - (partial() ? 1 : 0)))}
      </text>
      <text fg={theme.foreground.muted}>{formatTokens(props.value)}</text>
      <Show when={props.showPct}>
        <text fg={props.color}>({pct()}%)</text>
      </Show>
    </box>
  )
}

// KPI Card with box-drawing border, optional sparkline + delta indicator.
//
// The card is laid out as a 2×2 grid:
//   ┌─────────────┐
//   │ LABEL       │ ← muted, top
//   │ VALUE       │ ← bold, theme color
//   │ SUBTITLE    │ ← muted
//   │ ▁▂▃▅▆▇ +12% │ ← sparkline + delta (when provided)
//   └────────────┘
//
// The sparkline fills the full card width and is rendered with 2 rows of
// braille (8 pixel rows), giving readable trend shapes in a compact space.
// The delta indicator uses `theme.status.success.fg` for "good" and `theme.status.error.fg` for
// "bad"; pass `deltaInverse` to flip the polarity (e.g. cost, error rate).
export function KPICard(props: {
  label: string
  value: string
  color: RGBA
  subtitle?: string
  sparkline?: number[]
  /** Pct change vs the comparable preceding period. ±Infinity = "new" baseline. */
  delta?: { pct: number; inverse?: boolean }
  /** When true, the card uses `borderActive` instead of `border` (e.g. on hover). */
  active?: boolean
  /** Fixed card width (columns). Enables right-aligned delta + full-width
   *  sparkline. Falls back to content-sized when omitted. */
  width?: number
}) {
  const { theme } = useTheme()
  const innerW = () => Math.max(6, (props.width ?? Math.max(props.value.length, props.label.length) + 4) - 2)

  const deltaInfo = createMemo(() => {
    const d = props.delta
    if (!d) return undefined
    if (!Number.isFinite(d.pct)) {
      if (d.pct === 0) return undefined
      const good = d.pct > 0 ? !d.inverse : d.inverse
      return { text: d.pct > 0 ? "new" : "−new", good }
    }
    if (d.pct === 0) return { text: "—", good: null as boolean | null }
    const arrow = d.pct > 0 ? "↑" : "↓"
    const text = `${arrow} ${Math.abs(d.pct).toFixed(1)}%`
    const good = d.pct > 0 ? !d.inverse : d.inverse
    return { text, good: good as boolean | null }
  })

  const deltaColor = createMemo<RGBA>(() => {
    const info = deltaInfo()
    if (!info || info.good === null) return theme.foreground.muted
    return info.good ? theme.status.success.fg : theme.status.error.fg
  })

  return (
    <box
      flexDirection="column"
      gap={0}
      border
      borderColor={props.active ? theme.border.active : theme.border.default}
      width={props.width}
      flexShrink={0}
    >
      {/* Header: label (left) + delta (right) */}
      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} gap={1}>
        <text fg={theme.foreground.muted} wrapMode="none">
          {props.label}
        </text>
        <Show when={deltaInfo()}>
          <text fg={deltaColor()} wrapMode="none">
            {deltaInfo()!.text}
          </text>
        </Show>
      </box>
      <text fg={props.color} attributes={TextAttributes.BOLD} paddingLeft={1} paddingRight={1} wrapMode="none">
        {props.value}
      </text>
      <Show when={props.subtitle}>
        <text fg={theme.foreground.muted} paddingLeft={1} paddingRight={1} wrapMode="none">
          {props.subtitle}
        </text>
      </Show>
      <Show when={props.sparkline && props.sparkline.length > 0}>
        <box paddingLeft={1} paddingRight={1}>
          <BrailleSparkline data={props.sparkline!} width={innerW()} color={props.color} />
        </box>
      </Show>
    </box>
  )
}

// One labeled token-breakdown row inside a ModelCard: "Label ████░░ 1.2M".
// Bars are scaled against the card's own max so the dominant category fills
// the track; the faint track keeps every row the same length for alignment.
function ModelBar(props: { label: string; value: number; max: number; width: number; color: RGBA }) {
  const { theme } = useTheme()
  const filled = createMemo(() => {
    if (props.max <= 0) return 0
    return Math.max(0, Math.min(props.width, Math.round((props.value / props.max) * props.width)))
  })
  const track = createMemo<RGBA>(() => mix(props.color, theme.surface.offset, 0.82))
  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <text fg={theme.foreground.muted} width={8} wrapMode="none">
        {props.label.padEnd(8)}
      </text>
      <text fg={props.color} wrapMode="none">
        {"█".repeat(filled())}
      </text>
      <text fg={track()} wrapMode="none">
        {"█".repeat(Math.max(0, props.width - filled()))}
      </text>
      <text fg={theme.foreground.muted} wrapMode="none">
        {formatTokens(props.value)}
      </text>
    </box>
  )
}

// Model Card — header + request count + a labeled bar per token category
// (input / output / reasoning / cache read / cache write). Categories with no
// tokens are hidden so the card stays compact for simple models while still
// surfacing cache & reasoning usage for the models that have it.
export function ModelCard(props: {
  name: string
  provider: string
  requests: number
  avgResponseTime?: number
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  color: RGBA
  barWidth?: number
}) {
  const { theme } = useTheme()
  const viz = createMemo(() => getChartColors(theme))
  const barWidth = () => Math.max(4, props.barWidth ?? 20)

  // Scale every bar against the largest category on THIS card so the breakdown
  // is readable per-model (cache reads often dwarf input/output).
  const localMax = createMemo(() =>
    Math.max(
      1,
      props.inputTokens,
      props.outputTokens,
      props.reasoningTokens ?? 0,
      props.cacheReadTokens ?? 0,
      props.cacheWriteTokens ?? 0,
    ),
  )

  const rows = createMemo(() =>
    [
      { label: "Input", value: props.inputTokens, color: viz().input },
      { label: "Output", value: props.outputTokens, color: viz().output },
      {
        label: "Reason",
        value: props.reasoningTokens ?? 0,
        color: viz().reasoning,
      },
      {
        label: "Cache R",
        value: props.cacheReadTokens ?? 0,
        color: viz().cache,
      },
      {
        label: "Cache W",
        value: props.cacheWriteTokens ?? 0,
        color: viz().cacheWrite,
      },
    ].filter((r) => r.value > 0),
  )

  return (
    <box flexDirection="column" gap={0} border borderColor={theme.border.subtle} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
        <text fg={theme.foreground.default} attributes={TextAttributes.BOLD}>
          {props.name}
        </text>
        <text fg={theme.foreground.muted}>{props.provider}</text>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={theme.foreground.muted}>Requests:</text>
        <text fg={theme.foreground.default}>{props.requests}</text>
        <Show when={props.avgResponseTime != null}>
          <text fg={theme.foreground.muted}>Avg:</text>
          <text fg={theme.foreground.default}>{props.avgResponseTime}ms</text>
        </Show>
      </box>
      <For each={rows()}>
        {(r) => <ModelBar label={r.label} value={r.value} max={localMax()} width={barWidth()} color={r.color} />}
      </For>
    </box>
  )
}

/**
 * Horizontal gauge — a single value as a fraction of `max`, drawn as a
 * filled/empty block bar with a percentage and `value / max` caption.
 *
 * Mirrors the gauge renderer in the OpenTUI dashboard so analytics gauges
 * read identically to the generated visualizations. `thresholds` (in pct)
 * recolor the bar to warning/error as the value climbs, which is handy for
 * "danger" metrics like context-window pressure or budget burn.
 */
export function Gauge(props: {
  label: string
  value: number
  max: number
  width?: number
  color?: RGBA
  format?: (v: number) => string
  unit?: string
  /** [warnPct, dangerPct] in 0..100; recolors the bar above each step. */
  thresholds?: [number, number]
}) {
  const { theme } = useTheme()
  const width = () => Math.max(6, props.width ?? 24)
  const pct = createMemo(() => (props.max > 0 ? Math.max(0, Math.min(1, props.value / props.max)) : 0))
  const pctNum = createMemo(() => pct() * 100)
  const filled = createMemo(() => Math.round(pct() * width()))
  const fmt = () => props.format ?? formatTokens
  const color = createMemo<RGBA>(() => {
    const t = props.thresholds
    if (t) {
      if (pctNum() >= t[1]) return theme.status.error.fg
      if (pctNum() >= t[0]) return theme.status.warning.fg
    }
    return props.color ?? theme.accent.fg
  })
  // Unfilled track: a faint tint of the bar color (toward the panel bg) so the
  // gauge reads as one cohesive object instead of "colored bar + gray gap".
  const track = createMemo<RGBA>(() => mix(color(), theme.surface.offset, 0.82))
  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme.foreground.muted} wrapMode="none">
        {props.label}
      </text>
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={color()} wrapMode="none">
          {"█".repeat(filled())}
        </text>
        <text fg={track()} wrapMode="none">
          {"█".repeat(Math.max(0, width() - filled()))}
        </text>
        <text fg={color()} attributes={TextAttributes.BOLD} wrapMode="none">
          {pctNum().toFixed(0)}%
        </text>
      </box>
      <text fg={theme.foreground.muted} wrapMode="none">
        {fmt()(props.value)}
        {props.unit ?? ""} / {fmt()(props.max)}
        {props.unit ?? ""}
      </text>
    </box>
  )
}

// Vertical-eighth blocks: empty → full. Index = number of filled eighths.
const VBLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/**
 * Vertical bar (column) chart drawn with 1/8-precision block glyphs.
 *
 * Each bar is one character wide and `height` rows tall; the top cell of a
 * bar can be a partial block so short differences between adjacent days stay
 * visible. Renders top-to-bottom (highest row first) so it reads like a
 * normal histogram. The peak bar is highlighted when `highlightMax` is set.
 *
 * Complements the braille line/area charts: where those show a continuous
 * trend, this gives a discrete day-by-day "volume" silhouette that's easier
 * to scan for spikes — matching the bar_chart visuals in the generated
 * OpenTUI dashboards.
 */
export function VerticalBarChart(props: {
  bars: { label?: string; value: number; color?: RGBA }[]
  height?: number
  color?: RGBA
  yFormat?: (v: number) => string
  highlightMax?: boolean
  /** Show first/peak/last captions under the columns. */
  showAxis?: boolean
}) {
  const { theme } = useTheme()
  const height = () => Math.max(2, props.height ?? 6)
  const fmt = () => props.yFormat ?? formatTokens
  const max = createMemo(() => Math.max(1, ...props.bars.map((b) => b.value)))

  // For each column, precompute the glyph for every row (index 0 = top row).
  const cols = createMemo(() =>
    props.bars.map((b) => {
      const eighths = Math.round((b.value / max()) * height() * 8)
      const chars: string[] = []
      for (let row = height() - 1; row >= 0; row--) {
        const e = Math.max(0, Math.min(8, eighths - row * 8))
        chars.push(VBLOCKS[e] ?? " ")
      }
      const isMax = b.value > 0 && b.value === max()
      const color = b.color ?? (props.highlightMax && isMax ? theme.accent.fg : (props.color ?? theme.accent.fg))
      return { chars, color, value: b.value, label: b.label }
    }),
  )

  return (
    <box flexDirection="column" gap={0}>
      <For each={Array.from({ length: height() })}>
        {(_, rowIdx) => (
          <box flexDirection="row" gap={0}>
            {/* `Index`, not `For`: the memo rebuilds a column object per bar on
                every data change, and `For` reconciles by reference — so a live
                chart tore down and remounted every column each time it moved.
                The list is positional, which is what `Index` is for. */}
            <Index each={cols()}>
              {(c) => (
                <text fg={c().color} wrapMode="none">
                  {c().chars[rowIdx()] ?? " "}
                </text>
              )}
            </Index>
          </box>
        )}
      </For>
      {/* Baseline */}
      <text fg={theme.border.subtle} wrapMode="none">
        {"▔".repeat(cols().length)}
      </text>
      {/* Compact single-line caption — first → last · peak. Avoids the label
          overlap that a space-between row produced on narrow (7/14-day)
          ranges where the columns are only a few characters wide. */}
      <Show when={props.showAxis !== false && cols().length > 1}>
        <text fg={theme.foreground.muted} wrapMode="none">
          {cols()[0]?.label ?? "0"} → {cols()[cols().length - 1]?.label ?? ""} · peak {fmt()(max())}
        </text>
      </Show>
    </box>
  )
}

/**
 * Compact horizontal bar list for ranked data.
 *
 * Each row shows: `name │ ████░░ │ value` with sub-cell precision (▏▎▍▌▋▊▉).
 * `name` is truncated to `nameWidth` characters with a trailing ellipsis
 * when needed, and the bar length is computed from `value / maxValue * barWidth`.
 *
 * Used for "Top Tools", "Top Agents" and any other ranked-list view in the
 * analytics panel. Replaces the previous tools-tab implementation that
 * used a `█`.repeat(barWidth) bar with no fractional precision and a 1/20
 * step granularity.
 */
export function RankedBarList(props: {
  items: { name: string; value: number; subValue?: string; color?: RGBA }[]
  maxValue?: number
  nameWidth?: number
  barWidth?: number
  /** When set, bars for the first `highlight` items are rendered in the
   *  provided color; the rest use `theme.foreground.muted`. */
  highlight?: number
  /** When set, the value column is formatted with this function. */
  formatValue?: (v: number) => string
}) {
  const { theme } = useTheme()
  const nameWidth = () => props.nameWidth ?? 18
  const barWidth = () => props.barWidth ?? 18
  const max = createMemo(() => {
    if (props.maxValue !== undefined) return Math.max(1, props.maxValue)
    let m = 1
    for (const it of props.items) if (it.value > m) m = it.value
    return m
  })
  const fmt = () => props.formatValue ?? formatTokens

  return (
    <box flexDirection="column" gap={0}>
      <For each={props.items}>
        {(item, idx) => {
          const isHi = () => props.highlight === undefined || idx() < props.highlight!
          const color = (): RGBA => {
            if (item.color) return item.color
            return isHi() ? theme.accent.fg : theme.foreground.muted
          }
          // 1/8 precision per cell — same encoding as HBarPrecision
          const filled = () => Math.min(barWidth(), Math.max(0, (item.value / max()) * barWidth()))
          const full = () => Math.floor(filled())
          const frac = () => {
            const f = filled() - full()
            const chars = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
            const i = Math.round(f * 8)
            return chars[Math.min(i, 7)] ?? ""
          }
          const displayName = () => {
            const n = item.name
            if (n.length <= nameWidth()) return n.padEnd(nameWidth())
            return n.slice(0, nameWidth() - 1) + "…"
          }
          return (
            <box flexDirection="row" gap={1} alignItems="center">
              <text fg={theme.foreground.default} width={nameWidth()} wrapMode="none">
                {displayName()}
              </text>
              <text fg={color()} wrapMode="none">
                {"█".repeat(full())}
                {frac()}
              </text>
              <text fg={theme.border.subtle} wrapMode="none">
                {"░".repeat(Math.max(0, barWidth() - full() - (frac() ? 1 : 0)))}
              </text>
              <text fg={theme.foreground.muted} wrapMode="none">
                {fmt()(item.value)}
                {item.subValue ? ` ${item.subValue}` : ""}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}
