import { FooterHint } from "@tui/ui/footer-hints"
import { useScrollAcceleration } from "@tui/util/scroll"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import {
  createContext,
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
  Switch,
  Match,
  ErrorBoundary,
  useContext,
  type Component,
  Index,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { useDialog } from "@tui/ui/dialog"
import { useTheme, type Theme } from "@tui/context/theme"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "@tui/ui/toast"
import { createTwoFilesPatch } from "diff"
import type {
  OpenTUIVizSpecType,
  VizComponent,
  VizColorToken,
  VizNumberFormat,
  VizSeverity,
  VizTreeNode,
  VizThreshold,
} from "@nikcli-ai/util/viz"

export type DialogOpenTUIVizProps = {
  spec: OpenTUIVizSpecType
  /** When true, the spec is still streaming in — shows a live indicator. */
  streaming?: boolean
}

// ──────────────────────────────────────────────────────────────────────────
// Discriminated extractors
// ──────────────────────────────────────────────────────────────────────────

type Of<T extends VizComponent["type"]> = Extract<VizComponent, { type: T }>

const TYPE_LABEL: Record<VizComponent["type"], string> = {
  text: "Text",
  markdown: "Notes",
  code: "Code",
  diff: "Diff",
  alert: "Alert",
  table: "Table",
  key_value: "Properties",
  tree: "Tree",
  stat: "Stat",
  stat_grid: "Metrics",
  bar_chart: "Bars",
  line_chart: "Trend",
  histogram: "Histogram",
  heatmap: "Heatmap",
  gauge: "Gauge",
  progress_bars: "Progress",
  timeline: "Timeline",
  status_grid: "Status",
  card: "Card",
  list: "List",
  accordion: "Accordion",
  compare: "Compare",
  sparkline_row: "Sparklines",
  section: "Section",
  grid: "Grid",
}

const TYPE_ICON: Record<VizComponent["type"], string> = {
  text: "¶",
  markdown: "M↓",
  code: "</>",
  diff: "±",
  alert: "!",
  table: "▦",
  key_value: "≡",
  tree: "⇲",
  stat: "▤",
  stat_grid: "▤▤",
  bar_chart: "▮",
  line_chart: "∿",
  histogram: "▥",
  heatmap: "▩",
  gauge: "◔",
  progress_bars: "▰",
  timeline: "⋮",
  status_grid: "⊞",
  card: "▣",
  list: "☰",
  accordion: "≡",
  compare: "⇔",
  sparkline_row: "▁",
  section: "§",
  grid: "▦▦",
}

function tabLabel(comp: VizComponent): string {
  const title = "title" in comp ? comp.title : undefined
  if (title) return title
  return TYPE_LABEL[comp.type] ?? comp.type
}

// ──────────────────────────────────────────────────────────────────────────
// Color resolver
// ──────────────────────────────────────────────────────────────────────────

function resolveColor(theme: Theme, token: VizColorToken | undefined): RGBA {
  switch (token) {
    case "primary":
      return theme.accent.fg
    case "secondary":
      return theme.accent.secondary
    case "accent":
      return theme.accent.alt
    case "success":
      return theme.status.success.fg
    case "warning":
      return theme.status.warning.fg
    case "error":
      return theme.status.error.fg
    case "info":
      return theme.status.info.fg
    case "muted":
      return theme.foreground.muted
    case "default":
    default:
      return theme.foreground.default
  }
}

function severityColor(theme: Theme, sev: VizSeverity): RGBA {
  switch (sev) {
    case "success":
      return theme.status.success.fg
    case "warning":
      return theme.status.warning.fg
    case "error":
      return theme.status.error.fg
    case "info":
      return theme.status.info.fg
  }
}

const SEVERITY_ICON: Record<VizSeverity, string> = {
  info: "ℹ",
  success: "✓",
  warning: "⚠",
  error: "✗",
}

// ──────────────────────────────────────────────────────────────────────────
// Number / sparkline helpers
// ──────────────────────────────────────────────────────────────────────────

const SPARK_CHARS = "▁▂▃▄▅▆▇█"

function sparkline(values: ReadonlyArray<number>): string {
  if (values.length === 0) return ""
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min || 1
  let out = ""
  for (const v of values) {
    const idx = Math.max(
      0,
      Math.min(SPARK_CHARS.length - 1, Math.floor(((v - min) / range) * (SPARK_CHARS.length - 1))),
    )
    out += SPARK_CHARS[idx]
  }
  return out
}

function formatCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e12) return (n / 1e12).toFixed(1) + "T"
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B"
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k"
  return abs < 1 && abs > 0 ? n.toPrecision(2) : n.toString()
}

function formatBytes(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + " TB"
  if (abs >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB"
  if (abs >= 1024 ** 2) return (n / 1024 ** 2).toFixed(2) + " MB"
  if (abs >= 1024) return (n / 1024).toFixed(1) + " KB"
  return n + " B"
}

function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 1) return ms.toFixed(2) + "ms"
  if (abs < 1000) return ms.toFixed(1) + "ms"
  if (abs < 60_000) return (ms / 1000).toFixed(2) + "s"
  if (abs < 3_600_000) return (ms / 60_000).toFixed(1) + "m"
  if (abs < 86_400_000) return (ms / 3_600_000).toFixed(1) + "h"
  return (ms / 86_400_000).toFixed(1) + "d"
}

function formatValue(value: string | number, format?: VizNumberFormat, unit?: string): string {
  if (typeof value === "string") return unit ? `${value}${unit}` : value
  const n = value
  let str: string
  switch (format) {
    case "compact":
      str = formatCompact(n)
      break
    case "percent":
      str = `${(n * 100).toFixed(Math.abs(n * 100) < 10 ? 1 : 0)}%`
      break
    case "currency":
      try {
        str = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
        }).format(n)
      } catch {
        str = `$${n.toFixed(2)}`
      }
      break
    case "bytes":
      str = formatBytes(n)
      break
    case "duration":
      str = formatDuration(n)
      break
    case "plain":
    default:
      str = Math.abs(n) >= 10_000 ? n.toLocaleString("en-US") : n.toString()
  }
  return unit && format !== "percent" && format !== "currency" && format !== "bytes" && format !== "duration"
    ? `${str}${unit}`
    : unit && (format === "percent" || format === "currency")
      ? str // unit already implicit
      : unit
        ? `${str} ${unit}`
        : str
}

function thresholdColor(
  theme: Theme,
  pctOrValue: number,
  thresholds: ReadonlyArray<VizThreshold> | undefined,
  defaultColor: RGBA,
): RGBA {
  if (!thresholds || thresholds.length === 0) return defaultColor
  const sorted = [...thresholds].sort((a, b) => a.at - b.at)
  let color = defaultColor
  for (const t of sorted) {
    if (pctOrValue >= t.at) color = resolveColor(theme, t.color)
  }
  return color
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Text
// ──────────────────────────────────────────────────────────────────────────

function Title(props: { title?: string }) {
  const { theme } = useTheme()
  return (
    <Show when={props.title}>
      <text fg={theme.accent.secondary} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
    </Show>
  )
}

function TextRenderer(props: { comp: Of<"text"> }) {
  const { theme, syntax } = useTheme()
  const fg = createMemo(() => {
    switch (props.comp.style) {
      case "success":
        return theme.status.success.fg
      case "warning":
        return theme.status.warning.fg
      case "error":
        return theme.status.error.fg
      case "info":
        return theme.accent.fg
      case "muted":
        return theme.foreground.muted
      default:
        return theme.foreground.default
    }
  })
  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <Show
        when={props.comp.style === "code"}
        fallback={
          <text fg={fg()} wrapMode="word">
            {props.comp.content}
          </text>
        }
      >
        <markdown
          content={"```\n" + props.comp.content + "\n```"}
          syntaxStyle={syntax()}
          fg={theme.foreground.default}
          conceal={false}
          concealCode={false}
        />
      </Show>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Markdown
// ──────────────────────────────────────────────────────────────────────────

function MarkdownRenderer(props: { comp: Of<"markdown"> }) {
  const { theme, syntax } = useTheme()
  const dims = useTerminalDimensions()
  const tight = createMemo(() => dims().width < 84)
  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <markdown
        content={props.comp.content}
        syntaxStyle={syntax()}
        fg={theme.foreground.default}
        conceal={true}
        concealCode={false}
        tableOptions={{
          widthMode: "full",
          wrapMode: "word",
          cellPadding: tight() ? 0 : 1,
          borders: true,
          outerBorder: !tight(),
          borderColor: theme.border.subtle,
        }}
      />
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Code
// ──────────────────────────────────────────────────────────────────────────

function CodeRenderer(props: { comp: Of<"code"> }) {
  const { theme, syntax } = useTheme()
  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <Show
        when={props.comp.showLineNumbers}
        fallback={
          <code
            content={props.comp.content}
            filetype={props.comp.filetype}
            syntaxStyle={syntax()}
            fg={theme.foreground.default}
            conceal={false}
          />
        }
      >
        <line_number fg={theme.foreground.muted} minWidth={3} paddingRight={1}>
          <code
            content={props.comp.content}
            filetype={props.comp.filetype}
            syntaxStyle={syntax()}
            fg={theme.foreground.default}
            conceal={false}
          />
        </line_number>
      </Show>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Diff
// ──────────────────────────────────────────────────────────────────────────

function DiffRenderer(props: { comp: Of<"diff"> }) {
  const { theme, syntax } = useTheme()
  const dims = useTerminalDimensions()
  const patch = createMemo(() =>
    createTwoFilesPatch(
      props.comp.title ?? "before",
      props.comp.title ?? "after",
      props.comp.before,
      props.comp.after,
      "",
      "",
      { context: 3 },
    ),
  )
  const view = createMemo<"unified" | "split">(() => {
    const mode = props.comp.mode
    if (mode === "split") return dims().width >= 100 ? "split" : "unified"
    return mode ?? "unified"
  })
  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <diff
        diff={patch()}
        view={view()}
        filetype={props.comp.filetype ?? "diff"}
        syntaxStyle={syntax()}
        fg={theme.foreground.default}
        wrapMode="word"
        showLineNumbers={true}
        addedBg={theme.diff.addedBg}
        removedBg={theme.diff.removedBg}
        contextBg={theme.diff.contextBg}
        addedSignColor={theme.diff.added}
        removedSignColor={theme.diff.removed}
        lineNumberFg={theme.diff.lineNumber}
      />
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Alert
// ──────────────────────────────────────────────────────────────────────────

function AlertRenderer(props: { comp: Of<"alert"> }) {
  const { theme } = useTheme()
  const color = createMemo(() => severityColor(theme, props.comp.severity))
  return (
    <box
      border
      borderColor={color()}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      flexDirection="column"
    >
      <box flexDirection="row" gap={1}>
        <text fg={color()} attributes={TextAttributes.BOLD}>
          {SEVERITY_ICON[props.comp.severity]}
        </text>
        <Show
          when={props.comp.title}
          fallback={
            <text fg={theme.foreground.default} wrapMode="word" flexGrow={1}>
              {props.comp.message}
            </text>
          }
        >
          <text fg={color()} attributes={TextAttributes.BOLD}>
            {props.comp.title}
          </text>
        </Show>
      </box>
      <Show when={props.comp.title}>
        <text fg={theme.foreground.default} wrapMode="word">
          {props.comp.message}
        </text>
      </Show>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Table
// ──────────────────────────────────────────────────────────────────────────

function statusToColor(theme: Theme, status: VizColorToken | undefined): RGBA {
  return resolveColor(theme, status)
}

function TableRenderer(props: { comp: Of<"table"> }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const align = createMemo(() => props.comp.align ?? [])
  const colCount = createMemo(() => props.comp.headers.length)
  const tight = createMemo(() => dims().width < 84)

  // Per-column max content width
  const colWidths = createMemo(() => {
    const widths: number[] = props.comp.headers.map((h) => h.length)
    for (const row of props.comp.rows) {
      for (let i = 0; i < colCount(); i++) {
        const cell = (row[i] ?? "").toString()
        if (cell.length > widths[i]) widths[i] = cell.length
      }
    }
    if (props.comp.totals) {
      for (let i = 0; i < colCount(); i++) {
        const cell = (props.comp.totals[i] ?? "").toString()
        if (cell.length > widths[i]) widths[i] = cell.length
      }
    }
    return widths
  })

  function padCell(value: string, idx: number): string {
    const width = colWidths()[idx] ?? value.length
    const a = align()[idx] ?? "left"
    if (a === "right") return value.padStart(width)
    if (a === "center") {
      const total = width - value.length
      const left = Math.floor(total / 2)
      const right = total - left
      return " ".repeat(Math.max(0, left)) + value + " ".repeat(Math.max(0, right))
    }
    return value.padEnd(width)
  }

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      {/* Header row */}
      <box flexDirection="row" gap={tight() ? 1 : 2}>
        <For each={props.comp.headers}>
          {(h, i) => (
            <text fg={theme.accent.secondary} attributes={TextAttributes.BOLD} flexShrink={0}>
              {padCell(h, i())}
            </text>
          )}
        </For>
      </box>
      {/* Separator */}
      <box flexDirection="row" gap={tight() ? 1 : 2}>
        <For each={props.comp.headers}>
          {(_, i) => (
            <text fg={theme.border.subtle} flexShrink={0}>
              {"─".repeat(colWidths()[i()] ?? 3)}
            </text>
          )}
        </For>
      </box>
      {/* Rows */}
      <For each={props.comp.rows}>
        {(row, rIdx) => {
          const rowColor = createMemo(() => {
            const tok = props.comp.rowColors?.[rIdx()]
            return tok ? statusToColor(theme, tok) : theme.foreground.default
          })
          return (
            <box flexDirection="row" gap={tight() ? 1 : 2}>
              <For each={row}>
                {(cell, cIdx) => (
                  <text fg={rowColor()} flexShrink={0}>
                    {padCell(cell, cIdx())}
                  </text>
                )}
              </For>
            </box>
          )
        }}
      </For>
      {/* Totals row */}
      <Show when={props.comp.totals}>
        <box flexDirection="row" gap={tight() ? 1 : 2}>
          <For each={props.comp.headers}>
            {(_, i) => (
              <text fg={theme.border.subtle} flexShrink={0}>
                {"═".repeat(colWidths()[i()] ?? 3)}
              </text>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={tight() ? 1 : 2}>
          <For each={props.comp.totals}>
            {(cell, i) => (
              <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} flexShrink={0}>
                {padCell(cell, i())}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: KeyValue
// ──────────────────────────────────────────────────────────────────────────

function KeyValueRenderer(props: { comp: Of<"key_value"> }) {
  const { theme } = useTheme()
  const keyWidth = createMemo(() => Math.max(...props.comp.items.map((i) => i.key.length), 8))

  function valueColor(status?: string): RGBA {
    switch (status) {
      case "success":
        return theme.status.success.fg
      case "warning":
        return theme.status.warning.fg
      case "error":
        return theme.status.error.fg
      case "info":
        return theme.accent.fg
      default:
        return theme.foreground.default
    }
  }

  // Group items by `group`
  const grouped = createMemo(() => {
    const result: Array<{ group?: string; items: typeof props.comp.items }> = []
    for (const item of props.comp.items) {
      const last = result[result.length - 1]
      if (last && last.group === item.group) {
        last.items = [...last.items, item]
      } else {
        result.push({ group: item.group, items: [item] })
      }
    }
    return result
  })

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <For each={grouped()}>
        {(grp) => (
          <box gap={0} marginTop={grp.group ? 1 : 0}>
            <Show when={grp.group}>
              <text fg={theme.foreground.muted} attributes={TextAttributes.BOLD}>
                ── {grp.group} ──
              </text>
            </Show>
            <For each={grp.items}>
              {(item) => (
                <box flexDirection="row" gap={2}>
                  <text fg={theme.foreground.muted} flexShrink={0}>
                    {item.key.padEnd(keyWidth(), " ")}
                  </text>
                  <text fg={valueColor(item.status)} wrapMode="word" flexGrow={1}>
                    {item.value}
                  </text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Tree
// ──────────────────────────────────────────────────────────────────────────

function TreeRenderer(props: { comp: Of<"tree"> }) {
  const { theme } = useTheme()

  function renderNodes(nodes: ReadonlyArray<VizTreeNode>, prefix: string, isRoot: boolean) {
    return (
      <For each={nodes}>
        {(node, idx) => {
          const last = idx() === nodes.length - 1
          const connector = isRoot ? "" : last ? "└─ " : "├─ "
          const nextPrefix = isRoot ? "" : prefix + (last ? "   " : "│  ")
          const statusColor = node.status ? severityColor(theme, node.status) : theme.foreground.default
          return (
            <box gap={0}>
              <box flexDirection="row" gap={1}>
                <text fg={theme.border.subtle} flexShrink={0}>
                  {prefix + connector}
                </text>
                <text fg={statusColor} flexShrink={0}>
                  {node.label}
                </text>
                <Show when={node.value}>
                  <text fg={theme.foreground.muted} flexGrow={1}>
                    {" " + node.value}
                  </text>
                </Show>
              </box>
              <Show when={node.children && node.children.length > 0}>
                {renderNodes(node.children!, nextPrefix, false)}
              </Show>
            </box>
          )
        }}
      </For>
    )
  }

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      {renderNodes(props.comp.nodes, "", true)}
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Stat (KPI tile)
// ──────────────────────────────────────────────────────────────────────────

type StatLike = Of<"stat"> | Of<"stat_grid">["items"][number]

function isStatComp(s: StatLike): s is Of<"stat"> {
  return (s as Of<"stat">).type === "stat"
}

function StatTile(props: { stat: StatLike; compact?: boolean }) {
  const { theme } = useTheme()
  const valueText = createMemo(() => formatValue(props.stat.value, props.stat.format, props.stat.unit))
  const valueColor = createMemo(() => resolveColor(theme, props.stat.color))
  const deltaText = createMemo(() => {
    if (props.stat.delta === undefined) return undefined
    const sign = props.stat.delta > 0 ? "+" : props.stat.delta < 0 ? "−" : ""
    const abs = Math.abs(props.stat.delta)
    const num = props.stat.format === "percent" ? `${(abs * 100).toFixed(1)}` : formatCompact(abs)
    return `${sign}${num}${props.stat.deltaUnit ?? ""}`
  })
  const trendArrow = createMemo(() =>
    props.stat.trend === "up" ? "▲" : props.stat.trend === "down" ? "▼" : props.stat.trend === "flat" ? "▬" : "",
  )
  const trendColor = createMemo<RGBA>(() => {
    const t = props.stat.trend
    if (!t) return theme.foreground.muted
    const good = props.stat.trendIsGood !== false // default true
    if (t === "flat") return theme.foreground.muted
    const positiveIsUp = t === "up"
    return positiveIsUp === good ? theme.status.success.fg : theme.status.error.fg
  })

  return (
    <box
      border={!props.compact}
      borderColor={theme.border.subtle}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={props.compact ? 0 : 1}
      paddingBottom={props.compact ? 0 : 1}
      flexDirection="column"
      gap={0}
      flexGrow={1}
      flexShrink={1}
      minWidth={20}
    >
      <text fg={theme.foreground.muted}>{props.stat.label}</text>
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={valueColor()} attributes={TextAttributes.BOLD}>
          {valueText()}
        </text>
        <Show when={props.stat.trend}>
          <text fg={trendColor()}>{trendArrow()}</text>
        </Show>
        <Show when={deltaText()}>
          <text fg={trendColor()}>{deltaText()}</text>
        </Show>
      </box>
      <Show when={props.stat.sparkline && props.stat.sparkline.length > 0}>
        <text fg={resolveColor(theme, props.stat.color ?? "primary")}>{sparkline(props.stat.sparkline!)}</text>
      </Show>
      <Show when={props.stat.hint}>
        <text fg={theme.foreground.muted}>{props.stat.hint}</text>
      </Show>
    </box>
  )
}

function StatRenderer(props: { comp: Of<"stat"> }) {
  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <StatTile stat={props.comp} />
    </box>
  )
}

function StatGridRenderer(props: { comp: Of<"stat_grid"> }) {
  const dims = useTerminalDimensions()
  const columns = createMemo(() => {
    if (props.comp.columns) return props.comp.columns
    const w = dims().width
    if (w >= 130) return 4
    if (w >= 96) return 3
    if (w >= 60) return 2
    return 1
  })

  const rows = createMemo(() => {
    const c = columns()
    const out: Array<typeof props.comp.items> = []
    for (let i = 0; i < props.comp.items.length; i += c) {
      out.push(props.comp.items.slice(i, i + c) as typeof props.comp.items)
    }
    return out
  })

  return (
    <box gap={1}>
      <Title title={props.comp.title} />
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row" gap={1}>
            <For each={row}>{(item) => <StatTile stat={item} />}</For>
          </box>
        )}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: BarChart
// ──────────────────────────────────────────────────────────────────────────

function BarChartRenderer(props: { comp: Of<"bar_chart"> }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const orientation = createMemo(() => props.comp.orientation ?? "horizontal")
  const items = () => props.comp.items
  const maxVal = createMemo(() => {
    if (props.comp.maxValue != null) return props.comp.maxValue
    return Math.max(...items().map((i) => i.value), 1)
  })
  const labelWidth = createMemo(() => Math.max(...items().map((i) => i.label.length), 4))

  const horizontalBarWidth = createMemo(() => {
    if (props.comp.barWidth) return props.comp.barWidth
    const w = dims().width - labelWidth() - 28
    return Math.max(10, Math.min(60, w))
  })

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <Switch>
        <Match when={orientation() === "horizontal"}>
          <For each={items()}>
            {(item) => {
              const pct = createMemo(() => Math.min(item.value / maxVal(), 1))
              const filled = createMemo(() => Math.round(pct() * horizontalBarWidth()))
              const empty = createMemo(() => horizontalBarWidth() - filled())
              const bar = createMemo(() => "█".repeat(filled()) + "░".repeat(empty()))
              const color = createMemo(() => resolveColor(theme, item.color ?? "primary"))
              const suffix = createMemo(() => {
                const parts: string[] = []
                if (props.comp.showValues !== false) {
                  parts.push(`${item.value}${item.unit ?? ""}`)
                }
                if (props.comp.showPercentages) {
                  parts.push(`(${Math.round(pct() * 100)}%)`)
                }
                return parts.join(" ")
              })
              return (
                <box flexDirection="row" gap={1}>
                  <text fg={theme.foreground.muted} flexShrink={0}>
                    {item.label.padEnd(labelWidth(), " ")}
                  </text>
                  <text fg={color()} flexShrink={0}>
                    {bar()}
                  </text>
                  <text fg={theme.foreground.default} flexShrink={0}>
                    {suffix()}
                  </text>
                </box>
              )
            }}
          </For>
        </Match>
        <Match when={orientation() === "vertical"}>
          <VerticalBarChart comp={props.comp} maxVal={maxVal()} />
        </Match>
      </Switch>
    </box>
  )
}

function VerticalBarChart(props: { comp: Of<"bar_chart">; maxVal: number }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const height = createMemo(() => Math.max(4, Math.min(14, Math.floor(dims().height / 5))))
  const cellWidth = createMemo(() => {
    const labels = props.comp.items.map((i) => i.label.length)
    return Math.max(...labels, 3) + 2
  })

  // For each row (top to bottom), emit a cell per item
  const rows = createMemo(() => {
    const h = height()
    const rs: string[][] = []
    for (let r = 0; r < h; r++) {
      const row: string[] = []
      for (const item of props.comp.items) {
        const norm = Math.min(item.value / props.maxVal, 1)
        const filledRows = Math.round(norm * h)
        // r=0 is top
        const filled = h - 1 - r < filledRows
        row.push(filled ? "█".repeat(cellWidth() - 1) : " ".repeat(cellWidth() - 1))
      }
      rs.push(row)
    }
    return rs
  })

  return (
    <box gap={0}>
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row" gap={1}>
            <For each={row}>
              {(seg, i) => {
                const color = createMemo(() => resolveColor(theme, props.comp.items[i()].color ?? "primary"))
                return (
                  <text fg={color()} flexShrink={0}>
                    {seg}
                  </text>
                )
              }}
            </For>
          </box>
        )}
      </For>
      {/* Baseline */}
      <box flexDirection="row" gap={1}>
        <For each={props.comp.items}>
          {() => (
            <text fg={theme.border.subtle} flexShrink={0}>
              {"─".repeat(cellWidth() - 1)}
            </text>
          )}
        </For>
      </box>
      {/* Labels */}
      <box flexDirection="row" gap={1}>
        <For each={props.comp.items}>
          {(item) => (
            <text fg={theme.foreground.muted} flexShrink={0}>
              {item.label.padEnd(cellWidth() - 1).slice(0, cellWidth() - 1)}
            </text>
          )}
        </For>
      </box>
      {/* Values */}
      <Show when={props.comp.showValues !== false}>
        <box flexDirection="row" gap={1}>
          <For each={props.comp.items}>
            {(item) => (
              <text fg={theme.foreground.default} flexShrink={0}>
                {`${item.value}${item.unit ?? ""}`.padEnd(cellWidth() - 1).slice(0, cellWidth() - 1)}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: LineChart
// ──────────────────────────────────────────────────────────────────────────

function resample(values: ReadonlyArray<number>, targetLen: number): number[] {
  if (values.length === 0) return Array(targetLen).fill(0)
  if (values.length === targetLen) return [...values]
  const out: number[] = new Array(targetLen)
  for (let i = 0; i < targetLen; i++) {
    const t = (i / Math.max(1, targetLen - 1)) * (values.length - 1)
    const lo = Math.floor(t)
    const hi = Math.min(values.length - 1, Math.ceil(t))
    const frac = t - lo
    out[i] = values[lo] * (1 - frac) + values[hi] * frac
  }
  return out
}

const LINE_MARKERS = ["●", "■", "▲", "◆", "◉", "★"]

function LineChartRenderer(props: { comp: Of<"line_chart"> }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const height = createMemo(() => props.comp.height ?? 8)

  const allValues = createMemo(() => props.comp.series.flatMap((s) => s.values))
  const yMin = createMemo(() => props.comp.yMin ?? Math.min(...allValues()))
  const yMax = createMemo(() => {
    const m = props.comp.yMax ?? Math.max(...allValues())
    return m === yMin() ? m + 1 : m
  })
  const axisWidth = 8

  const width = createMemo(() => {
    return Math.max(20, Math.min(140, dims().width - axisWidth - 6))
  })

  const seriesSamples = createMemo(() =>
    props.comp.series.map((s, idx) => ({
      ...s,
      colorToken: s.color ?? defaultSeriesColorToken(idx),
      marker: LINE_MARKERS[idx % LINE_MARKERS.length],
      sampled: resample(s.values, width()),
    })),
  )

  type Cell = { ch: string; color: VizColorToken | undefined } | null
  const grid = createMemo<Cell[][]>(() => {
    const h = height()
    const w = width()
    const g: Cell[][] = Array.from({ length: h }, () => Array(w).fill(null))
    const min = yMin()
    const max = yMax()
    const range = max - min || 1
    for (const s of seriesSamples()) {
      const prev = { y: -1 }
      for (let x = 0; x < w; x++) {
        const v = s.sampled[x]
        const norm = (v - min) / range
        const y = Math.max(0, Math.min(h - 1, h - 1 - Math.round(norm * (h - 1))))
        // connect with vertical glyphs between prev.y and y
        if (prev.y !== -1 && Math.abs(prev.y - y) > 1) {
          const [from, to] = prev.y < y ? [prev.y + 1, y - 1] : [y + 1, prev.y - 1]
          for (let yi = from; yi <= to; yi++) {
            if (g[yi][x - 1] === null) g[yi][x - 1] = { ch: "│", color: s.colorToken }
          }
        }
        g[y][x] = { ch: s.marker, color: s.colorToken }
        prev.y = y
      }
    }
    return g
  })

  // Collapse same-color runs in a row into <text> spans
  function rowRuns(row: Cell[]): Array<{ text: string; color: RGBA }> {
    const runs: Array<{ text: string; color: RGBA }> = []
    let current: { text: string; color: RGBA } | null = null
    for (const cell of row) {
      const ch = cell?.ch ?? " "
      const color = cell ? resolveColor(theme, cell.color) : theme.foreground.default
      if (current && current.color.r === color.r && current.color.g === color.g && current.color.b === color.b) {
        current.text += ch
      } else {
        current = { text: ch, color }
        runs.push(current)
      }
    }
    return runs
  }

  function axisLabel(rowIdx: number): string {
    const h = height()
    if (rowIdx === 0) return formatYTick(yMax(), props.comp.yUnit).padStart(axisWidth - 1)
    if (rowIdx === h - 1) return formatYTick(yMin(), props.comp.yUnit).padStart(axisWidth - 1)
    if (rowIdx === Math.floor((h - 1) / 2))
      return formatYTick((yMin() + yMax()) / 2, props.comp.yUnit).padStart(axisWidth - 1)
    return " ".repeat(axisWidth - 1)
  }

  const showLegend = createMemo(() => props.comp.showLegend ?? props.comp.series.length > 1)
  const showAxis = createMemo(() => props.comp.showAxis !== false)

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <For each={grid()}>
        {(row, rIdx) => (
          <box flexDirection="row" gap={0} flexShrink={0}>
            <Show when={showAxis()}>
              <text fg={theme.foreground.muted} flexShrink={0}>
                {axisLabel(rIdx())}
              </text>
              <text fg={theme.border.subtle} flexShrink={0}>
                {rIdx() === height() - 1 ? "└" : "│"}
              </text>
            </Show>
            <For each={rowRuns(row)}>
              {(run) => (
                <text fg={run.color} flexShrink={0}>
                  {run.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
      {/* X axis labels */}
      <Show when={showAxis() && props.comp.labels && props.comp.labels.length > 0}>
        <box flexDirection="row" gap={0} flexShrink={0}>
          <text fg={theme.foreground.muted} flexShrink={0}>
            {" ".repeat(axisWidth)}
          </text>
          <text fg={theme.foreground.muted} flexShrink={0}>
            {sparseAxisLabels(props.comp.labels!, width())}
          </text>
        </box>
      </Show>
      {/* Legend */}
      <Show when={showLegend()}>
        <box flexDirection="row" gap={2} flexWrap="wrap" marginTop={1}>
          {/* Positional and rebuilt on every resample, so `Index` keeps the
              legend rows mounted instead of replacing them. */}
          <Index each={seriesSamples()}>
            {(s) => (
              <box flexDirection="row" gap={1}>
                <text fg={resolveColor(theme, s().colorToken)}>{s().marker}</text>
                <text fg={theme.foreground.default}>{s().name}</text>
              </box>
            )}
          </Index>
        </box>
      </Show>
    </box>
  )
}

function defaultSeriesColorToken(idx: number): VizColorToken {
  const tokens: VizColorToken[] = ["primary", "accent", "secondary", "info", "warning", "success"]
  return tokens[idx % tokens.length]
}

function formatYTick(v: number, unit?: string): string {
  const s = Math.abs(v) >= 1000 ? formatCompact(v) : Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1)
  return unit ? `${s}${unit}` : s
}

function sparseAxisLabels(labels: ReadonlyArray<string>, width: number): string {
  if (labels.length === 0 || width <= 0) return ""
  const stride = Math.max(1, Math.ceil(labels.length / Math.floor(width / 8)))
  let out = ""
  for (let i = 0; i < labels.length; i += stride) {
    const pos = Math.floor((i / Math.max(1, labels.length - 1)) * (width - 1))
    while (out.length < pos) out += " "
    out += labels[i]
  }
  return out.slice(0, width)
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Histogram
// ──────────────────────────────────────────────────────────────────────────

function HistogramRenderer(props: { comp: Of<"histogram"> }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const maxCount = createMemo(() => Math.max(...props.comp.bins.map((b) => b.count), 1))
  const labelWidth = createMemo(() => Math.max(...props.comp.bins.map((b) => b.label.length), 4))
  const barWidth = createMemo(() => Math.max(10, Math.min(60, dims().width - labelWidth() - 18)))

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <For each={props.comp.bins}>
        {(bin) => {
          const filled = createMemo(() => Math.round((bin.count / maxCount()) * barWidth()))
          const empty = createMemo(() => barWidth() - filled())
          const bar = createMemo(() => "▆".repeat(filled()) + "·".repeat(empty()))
          return (
            <box flexDirection="row" gap={1}>
              <text fg={theme.foreground.muted} flexShrink={0}>
                {bin.label.padEnd(labelWidth(), " ")}
              </text>
              <text fg={theme.accent.secondary} flexShrink={0}>
                {bar()}
              </text>
              <text fg={theme.foreground.default} flexShrink={0}>
                {bin.count}
                {props.comp.unit ? ` ${props.comp.unit}` : ""}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Heatmap
// ──────────────────────────────────────────────────────────────────────────

function lerpColor(a: RGBA, b: RGBA, t: number): RGBA {
  return RGBA.fromValues(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, 1)
}

function heatmapColor(theme: Theme, t: number, scale: "mono" | "diverge" | "traffic"): RGBA {
  const clamped = Math.max(0, Math.min(1, t))
  if (scale === "mono") {
    return lerpColor(theme.surface.offset, theme.accent.fg, clamped)
  }
  if (scale === "diverge") {
    // -1..0..1 mapped from 0..0.5..1
    if (clamped < 0.5) return lerpColor(theme.status.info.fg, theme.surface.offset, clamped * 2)
    return lerpColor(theme.surface.offset, theme.status.error.fg, (clamped - 0.5) * 2)
  }
  // traffic: green → yellow → red
  if (clamped < 0.5) return lerpColor(theme.status.success.fg, theme.status.warning.fg, clamped * 2)
  return lerpColor(theme.status.warning.fg, theme.status.error.fg, (clamped - 0.5) * 2)
}

function HeatmapRenderer(props: { comp: Of<"heatmap"> }) {
  const { theme } = useTheme()
  const scale = createMemo(() => props.comp.colorScale ?? "mono")
  const flat = createMemo(() => props.comp.values.flat())
  const min = createMemo(() => props.comp.min ?? Math.min(...flat()))
  const max = createMemo(() => {
    const m = props.comp.max ?? Math.max(...flat())
    return m === min() ? m + 1 : m
  })
  const cellWidth = 6
  const rowLabelW = createMemo(() => Math.max(...props.comp.rowLabels.map((l) => l.length), 4))

  function colorFor(value: number): RGBA {
    const norm = (value - min()) / (max() - min())
    return heatmapColor(theme, norm, scale())
  }

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      {/* Column headers */}
      <box flexDirection="row" gap={0}>
        <text fg={theme.foreground.muted} flexShrink={0}>
          {" ".repeat(rowLabelW() + 1)}
        </text>
        <For each={props.comp.colLabels}>
          {(c) => (
            <text fg={theme.foreground.muted} flexShrink={0}>
              {c.slice(0, cellWidth).padStart(cellWidth)}
            </text>
          )}
        </For>
      </box>
      {/* Rows */}
      <For each={props.comp.rowLabels}>
        {(rowLabel, rIdx) => (
          <box flexDirection="row" gap={0} flexShrink={0}>
            <text fg={theme.foreground.default} flexShrink={0}>
              {rowLabel.padEnd(rowLabelW(), " ") + " "}
            </text>
            <For each={props.comp.colLabels}>
              {(_c, cIdx) => {
                const v = createMemo(() => props.comp.values[rIdx()]?.[cIdx()] ?? 0)
                const bg = createMemo(() => colorFor(v()))
                const luminance = createMemo(() => 0.299 * bg().r + 0.587 * bg().g + 0.114 * bg().b)
                const fg = createMemo(() =>
                  luminance() > 0.55 ? RGBA.fromInts(0, 0, 0) : RGBA.fromInts(255, 255, 255),
                )
                const txt = createMemo(() => {
                  const n = v()
                  const s = Math.abs(n) >= 100 ? Math.round(n).toString() : n.toFixed(1)
                  return s.padStart(cellWidth - 1).slice(0, cellWidth - 1) + " "
                })
                return (
                  <box backgroundColor={bg()} flexShrink={0}>
                    <text fg={fg()}>{txt()}</text>
                  </box>
                )
              }}
            </For>
          </box>
        )}
      </For>
      {/* Legend */}
      <box flexDirection="row" gap={1} marginTop={1}>
        <text fg={theme.foreground.muted}>
          {props.comp.unit ? `${formatCompact(min())} ${props.comp.unit}` : formatCompact(min())}
        </text>
        <For each={Array.from({ length: 10 })}>
          {(_, i) => {
            const t = i() / 9
            return (
              <box backgroundColor={heatmapColor(theme, t, scale())}>
                <text fg={theme.foreground.muted}> </text>
              </box>
            )
          }}
        </For>
        <text fg={theme.foreground.muted}>
          {props.comp.unit ? `${formatCompact(max())} ${props.comp.unit}` : formatCompact(max())}
        </text>
      </box>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Gauge
// ──────────────────────────────────────────────────────────────────────────

function GaugeRenderer(props: { comp: Of<"gauge"> }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const min = createMemo(() => props.comp.min ?? 0)
  const max = createMemo(() => props.comp.max)
  const range = createMemo(() => max() - min() || 1)
  const pct = createMemo(() => Math.max(0, Math.min(1, (props.comp.value - min()) / range())))
  const pctNum = createMemo(() => pct() * 100)
  const barWidth = createMemo(() => Math.max(20, Math.min(60, dims().width - 28)))
  const filled = createMemo(() => Math.round(pct() * barWidth()))
  const empty = createMemo(() => barWidth() - filled())
  const color = createMemo(() => thresholdColor(theme, pctNum(), props.comp.thresholds, theme.accent.fg))

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <text fg={theme.foreground.muted}>{props.comp.label}</text>
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={color()} attributes={TextAttributes.BOLD}>
          {"█".repeat(filled())}
        </text>
        <text fg={theme.border.subtle}>{"░".repeat(empty())}</text>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={color()} attributes={TextAttributes.BOLD}>
          {`${props.comp.value}${props.comp.unit ?? ""} / ${props.comp.max}${props.comp.unit ?? ""}`}
        </text>
        <text fg={theme.foreground.muted}>{`(${pctNum().toFixed(1)}%)`}</text>
      </box>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: ProgressBars
// ──────────────────────────────────────────────────────────────────────────

function ProgressBarsRenderer(props: { comp: Of<"progress_bars"> }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const labelWidth = createMemo(() => Math.max(...props.comp.items.map((i) => i.label.length), 4))
  const barWidth = createMemo(() => {
    if (props.comp.barWidth) return props.comp.barWidth
    return Math.max(15, Math.min(50, dims().width - labelWidth() - 28))
  })

  function defaultColor(pct: number): RGBA {
    if (pct >= 0.9) return theme.status.error.fg
    if (pct >= 0.7) return theme.status.warning.fg
    return theme.status.success.fg
  }

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <For each={props.comp.items}>
        {(item) => {
          const pct = createMemo(() => Math.min(item.value / item.max, 1))
          const pctNum = createMemo(() => pct() * 100)
          const filled = createMemo(() => Math.round(pct() * barWidth()))
          const empty = createMemo(() => barWidth() - filled())
          const bar = createMemo(() => "█".repeat(filled()) + "░".repeat(empty()))
          const color = createMemo(() => thresholdColor(theme, pctNum(), props.comp.thresholds, defaultColor(pct())))
          return (
            <box flexDirection="row" gap={1}>
              <text fg={theme.foreground.muted} flexShrink={0}>
                {item.label.padEnd(labelWidth(), " ")}
              </text>
              <text fg={color()} flexShrink={0}>
                {bar()}
              </text>
              <text fg={theme.foreground.muted} flexShrink={0}>
                {`${Math.round(pctNum())}%`.padStart(4)}
              </text>
              <text fg={theme.foreground.default} flexShrink={0}>
                {`${item.value}/${item.max}${item.unit ?? ""}`}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Timeline
// ──────────────────────────────────────────────────────────────────────────

const TIMELINE_ICON = {
  done: "✓",
  active: "●",
  pending: "○",
  error: "✗",
  skipped: "∅",
} as const

function TimelineRenderer(props: { comp: Of<"timeline"> }) {
  const { theme } = useTheme()

  function iconColor(status: keyof typeof TIMELINE_ICON): RGBA {
    switch (status) {
      case "done":
        return theme.status.success.fg
      case "active":
        return theme.accent.fg
      case "pending":
        return theme.foreground.muted
      case "error":
        return theme.status.error.fg
      case "skipped":
        return theme.foreground.muted
    }
  }

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <For each={props.comp.events}>
        {(event, idx) => {
          const last = idx() === props.comp.events.length - 1
          return (
            <box gap={0}>
              <box flexDirection="row" gap={1}>
                <text fg={iconColor(event.status)} flexShrink={0}>
                  {TIMELINE_ICON[event.status]}
                </text>
                <text
                  fg={
                    event.status === "active" || event.status === "error"
                      ? theme.foreground.default
                      : theme.foreground.muted
                  }
                  attributes={event.status === "active" ? TextAttributes.BOLD : undefined}
                  wrapMode="word"
                  flexGrow={1}
                >
                  {event.label}
                </text>
                <Show when={event.duration}>
                  <text fg={theme.accent.secondary} flexShrink={0}>
                    {event.duration}
                  </text>
                </Show>
                <Show when={event.time}>
                  <text fg={theme.foreground.muted} flexShrink={0}>
                    {event.time}
                  </text>
                </Show>
              </box>
              <Show when={event.detail}>
                <box flexDirection="row" gap={1}>
                  <text fg={theme.border.subtle} flexShrink={0}>
                    {last ? "  " : "│ "}
                  </text>
                  <text fg={theme.foreground.muted} wrapMode="word">
                    {event.detail}
                  </text>
                </box>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: StatusGrid
// ──────────────────────────────────────────────────────────────────────────

function StatusGridRenderer(props: { comp: Of<"status_grid"> }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const columns = createMemo(() => {
    if (props.comp.columns) return props.comp.columns
    const w = dims().width
    if (w >= 130) return 4
    if (w >= 96) return 3
    if (w >= 60) return 2
    return 1
  })

  const rows = createMemo(() => {
    const c = columns()
    const out: Array<typeof props.comp.items> = []
    for (let i = 0; i < props.comp.items.length; i += c) {
      out.push(props.comp.items.slice(i, i + c) as typeof props.comp.items)
    }
    return out
  })

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row" gap={1} flexShrink={0}>
            <For each={row}>
              {(item) => {
                const color = createMemo(() => severityColor(theme, item.status))
                return (
                  <box
                    border
                    borderColor={color()}
                    paddingLeft={1}
                    paddingRight={1}
                    flexDirection="column"
                    flexGrow={1}
                    flexShrink={1}
                    minWidth={18}
                  >
                    <box flexDirection="row" gap={1}>
                      <text fg={color()} attributes={TextAttributes.BOLD}>
                        {SEVERITY_ICON[item.status]}
                      </text>
                      <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} flexGrow={1}>
                        {item.label}
                      </text>
                    </box>
                    <Show when={item.detail}>
                      <text fg={theme.foreground.muted} wrapMode="word">
                        {item.detail}
                      </text>
                    </Show>
                  </box>
                )
              }}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Card
// ──────────────────────────────────────────────────────────────────────────

function statusKindFg(theme: Theme, status?: string): RGBA {
  switch (status) {
    case "success":
      return theme.status.success.fg
    case "warning":
      return theme.status.warning.fg
    case "error":
      return theme.status.error.fg
    case "info":
      return theme.status.info.fg
    default:
      return theme.foreground.default
  }
}

function CardRenderer(props: { comp: Of<"card"> }) {
  const { theme } = useTheme()
  const badgeColor = createMemo(() =>
    props.comp.badge ? severityColor(theme, props.comp.badge.status) : theme.accent.fg,
  )
  return (
    <box border borderColor={theme.border.active} paddingLeft={1} paddingRight={1} gap={1} flexDirection="column">
      <box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Show when={props.comp.title}>
          <text fg={theme.accent.alt} attributes={TextAttributes.BOLD} flexGrow={1}>
            {props.comp.title}
          </text>
        </Show>
        <Show when={props.comp.badge}>
          <text fg={badgeColor()} attributes={TextAttributes.BOLD}>
            [{props.comp.badge!.label}]
          </text>
        </Show>
      </box>
      <Show when={props.comp.subtitle}>
        <text fg={theme.foreground.muted}>{props.comp.subtitle}</text>
      </Show>
      <Show when={props.comp.body}>
        <text fg={theme.foreground.default} wrapMode="word">
          {props.comp.body}
        </text>
      </Show>
      <Show when={props.comp.metrics && props.comp.metrics.length > 0}>
        <box flexDirection="row" gap={2} flexWrap="wrap">
          <For each={props.comp.metrics}>
            {(m) => (
              <box flexDirection="column" gap={0} minWidth={14}>
                <text fg={theme.foreground.muted}>{m.label}</text>
                <text fg={statusKindFg(theme, m.status)} attributes={TextAttributes.BOLD}>
                  {formatValue(m.value, m.format, m.unit)}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={props.comp.footer}>
        <text fg={theme.foreground.muted} wrapMode="word">
          ─ {props.comp.footer}
        </text>
      </Show>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: List
// ──────────────────────────────────────────────────────────────────────────

function ListRenderer(props: { comp: Of<"list"> }) {
  const { theme } = useTheme()
  const gap = () => (props.comp.dense ? 0 : 1)
  return (
    <box gap={gap()}>
      <Title title={props.comp.title} />
      <For each={props.comp.items}>
        {(item, idx) => {
          const bullet = createMemo(() => {
            if (item.icon) return item.icon
            return props.comp.ordered ? `${idx() + 1}.` : "•"
          })
          return (
            <box gap={0} flexDirection="column">
              <box flexDirection="row" gap={1}>
                <text fg={statusKindFg(theme, item.status)} flexShrink={0}>
                  {bullet()}
                </text>
                <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="word" flexGrow={1}>
                  {item.primary}
                </text>
              </box>
              <Show when={item.secondary}>
                <box flexDirection="row" gap={1}>
                  <text fg={theme.border.subtle} flexShrink={0}>
                    {" ".repeat(2)}
                  </text>
                  <text fg={theme.foreground.muted} wrapMode="word" flexGrow={1}>
                    {item.secondary}
                  </text>
                </box>
              </Show>
              <Show when={item.tertiary}>
                <box flexDirection="row" gap={1}>
                  <text fg={theme.border.subtle} flexShrink={0}>
                    {" ".repeat(2)}
                  </text>
                  <text fg={theme.accent.secondary} wrapMode="word" flexGrow={1}>
                    {item.tertiary}
                  </text>
                </box>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Accordion
// ──────────────────────────────────────────────────────────────────────────

function AccordionRenderer(props: { comp: Of<"accordion"> }) {
  const { theme } = useTheme()
  const [expanded, setExpanded] = createSignal(props.comp.sections.map((s) => s.open === true))

  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = [...prev]
      next[i] = !next[i]
      return next
    })
  }

  return (
    <box gap={1}>
      <Title title={props.comp.title} />
      <For each={props.comp.sections}>
        {(section, i) => {
          const isOpen = createMemo(() => expanded()[i()] === true)
          return (
            <box border borderColor={theme.border.subtle} gap={0} flexDirection="column">
              <box flexDirection="row" gap={1} onMouseUp={() => toggle(i())}>
                <text fg={theme.accent.fg} flexShrink={0}>
                  {isOpen() ? "▼" : "▶"}
                </text>
                <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} flexGrow={1}>
                  {section.title}
                </text>
                <Show when={section.subtitle}>
                  <text fg={theme.foreground.muted} flexShrink={0}>
                    {section.subtitle}
                  </text>
                </Show>
              </box>
              <Show when={isOpen()}>
                <box paddingLeft={2} gap={0} flexDirection="column">
                  <Show when={section.content}>
                    <text fg={theme.foreground.default} wrapMode="word">
                      {section.content}
                    </text>
                  </Show>
                  <For each={section.items ?? []}>
                    {(row) => (
                      <box flexDirection="row" gap={2}>
                        <text fg={theme.foreground.muted} flexShrink={0}>
                          {row.key}
                        </text>
                        <text fg={statusKindFg(theme, row.status)} wrapMode="word" flexGrow={1}>
                          {row.value}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: Compare
// ──────────────────────────────────────────────────────────────────────────

function CompareRenderer(props: { comp: Of<"compare"> }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const labelW = createMemo(() => Math.max(...props.comp.rows.map((r) => r.label.length), 6))
  const colW = createMemo(() => Math.max(12, Math.floor((dims().width - labelW() - 8) / 2)))

  function clip(s: string, w: number) {
    if (s.length <= w) return s.padEnd(w)
    return s.slice(0, Math.max(0, w - 1)) + "…"
  }

  function winnerFg(side: "left" | "right", winner?: string): RGBA {
    if (!winner || winner === "none" || winner === "tie") return theme.foreground.default
    if (winner === "tie") return theme.foreground.muted
    return winner === side ? theme.status.success.fg : theme.foreground.muted
  }

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <box flexDirection="row" gap={2} marginBottom={1}>
        <text fg={theme.foreground.muted} flexShrink={0}>
          {" ".repeat(labelW() + 2)}
        </text>
        <text fg={theme.accent.alt} attributes={TextAttributes.BOLD} flexShrink={0}>
          {clip(props.comp.leftLabel, colW())}
        </text>
        <text fg={theme.accent.alt} attributes={TextAttributes.BOLD} flexShrink={0}>
          {clip(props.comp.rightLabel, colW())}
        </text>
      </box>
      <For each={props.comp.rows}>
        {(row) => (
          <box gap={0} flexDirection="column">
            <box flexDirection="row" gap={2}>
              <text fg={theme.foreground.muted} flexShrink={0}>
                {row.label.padEnd(labelW(), " ")}
              </text>
              <text fg={winnerFg("left", row.winner)} flexShrink={0}>
                {clip(row.left, colW())}
              </text>
              <text fg={winnerFg("right", row.winner)} flexShrink={0}>
                {clip(row.right, colW())}
              </text>
            </box>
            <Show when={row.note}>
              <text fg={theme.foreground.muted} wrapMode="word">
                {" ".repeat(labelW() + 2)}
                {row.note}
              </text>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer: SparklineRow
// ──────────────────────────────────────────────────────────────────────────

function SparklineRowRenderer(props: { comp: Of<"sparkline_row"> }) {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const labelW = createMemo(() => Math.max(...props.comp.rows.map((r) => r.label.length), 6))
  const sparkW = createMemo(() => Math.max(12, Math.min(48, dims().width - labelW() - 24)))

  return (
    <box gap={0}>
      <Title title={props.comp.title} />
      <For each={props.comp.rows}>
        {(row) => {
          const sampled = createMemo(() => {
            const v = row.values
            if (v.length <= sparkW()) return v
            const out: number[] = []
            for (let i = 0; i < sparkW(); i++) {
              const t = (i / Math.max(1, sparkW() - 1)) * (v.length - 1)
              const lo = Math.floor(t)
              const hi = Math.min(v.length - 1, Math.ceil(t))
              const frac = t - lo
              out.push(v[lo]! * (1 - frac) + v[hi]! * frac)
            }
            return out
          })
          const latest = createMemo(() => {
            if (row.current !== undefined) return formatValue(row.current, row.format, row.unit)
            const last = row.values[row.values.length - 1]
            return formatValue(last, row.format, row.unit)
          })
          const deltaText = createMemo(() => {
            if (row.delta === undefined) return undefined
            const sign = row.delta > 0 ? "+" : row.delta < 0 ? "−" : ""
            return `${sign}${Math.abs(row.delta)}${row.deltaUnit ?? ""}`
          })
          const color = createMemo(() => resolveColor(theme, row.color ?? "primary"))
          return (
            <box flexDirection="row" gap={1}>
              <text fg={theme.foreground.muted} flexShrink={0}>
                {row.label.padEnd(labelW(), " ")}
              </text>
              <text fg={color()} flexShrink={0}>
                {sparkline(sampled())}
              </text>
              <Show when={props.comp.showValues !== false}>
                <text fg={theme.foreground.default} flexShrink={0}>
                  {latest()}
                </text>
              </Show>
              <Show when={deltaText()}>
                <text fg={theme.accent.secondary} flexShrink={0}>
                  {deltaText()}
                </text>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Container renderers
// ──────────────────────────────────────────────────────────────────────────

function SectionRenderer(props: { comp: Of<"section"> }) {
  const { theme } = useTheme()
  return (
    <box
      gap={1}
      border
      borderColor={theme.border.subtle}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      flexDirection="column"
    >
      <Show when={props.comp.title}>
        <text fg={theme.accent.alt} attributes={TextAttributes.BOLD}>
          {props.comp.title}
        </text>
      </Show>
      <Show when={props.comp.description}>
        <text fg={theme.foreground.muted} wrapMode="word">
          {props.comp.description}
        </text>
      </Show>
      <For each={props.comp.children}>{(child) => <ComponentRenderer component={child} />}</For>
    </box>
  )
}

function GridRenderer(props: { comp: Of<"grid"> }) {
  const dims = useTerminalDimensions()
  const columns = createMemo(() => {
    if (props.comp.columns) return props.comp.columns
    const w = dims().width
    if (w >= 130) return Math.min(props.comp.children.length, 3)
    if (w >= 96) return Math.min(props.comp.children.length, 2)
    return 1
  })

  const rows = createMemo(() => {
    const c = columns()
    const out: Array<typeof props.comp.children> = []
    for (let i = 0; i < props.comp.children.length; i += c) {
      out.push(props.comp.children.slice(i, i + c) as typeof props.comp.children)
    }
    return out
  })

  return (
    <box gap={1}>
      <Title title={props.comp.title} />
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row" gap={2} flexShrink={0}>
            <For each={row}>
              {(child) => (
                <box flexGrow={1} flexShrink={1} minWidth={0}>
                  <ComponentRenderer component={child} />
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Registry — json-render's catalog→component map, for OpenTUI
// ──────────────────────────────────────────────────────────────────────────

/** Props every component renderer receives (json-render: `ComponentRenderProps`). */
export type VizComponentProps<T extends VizComponent["type"]> = { comp: Of<T> }

/**
 * Maps each catalog component `type` to the OpenTUI Solid component that renders
 * it — nikcli's analogue to json-render's `Registry`. Supply a partial override
 * to `createVizRenderer` / `<Renderer>` to swap or extend renderers without
 * touching the dispatcher.
 */
export type VizRegistry = {
  [K in VizComponent["type"]]: Component<VizComponentProps<K>>
}

/** The built-in registry covering every catalog component one-to-one. */
export const defaultVizRegistry: VizRegistry = {
  text: TextRenderer,
  markdown: MarkdownRenderer,
  code: CodeRenderer,
  diff: DiffRenderer,
  alert: AlertRenderer,
  table: TableRenderer,
  key_value: KeyValueRenderer,
  tree: TreeRenderer,
  stat: StatRenderer,
  stat_grid: StatGridRenderer,
  bar_chart: BarChartRenderer,
  line_chart: LineChartRenderer,
  histogram: HistogramRenderer,
  heatmap: HeatmapRenderer,
  gauge: GaugeRenderer,
  progress_bars: ProgressBarsRenderer,
  timeline: TimelineRenderer,
  status_grid: StatusGridRenderer,
  card: CardRenderer,
  list: ListRenderer,
  accordion: AccordionRenderer,
  compare: CompareRenderer,
  sparkline_row: SparklineRowRenderer,
  section: SectionRenderer,
  grid: GridRenderer,
}

// Threaded through context so nested containers (section/grid) inherit the
// active registry without prop-drilling — exactly how json-render's <Renderer>
// makes its registry available to the whole subtree.
const VizRegistryContext = createContext<VizRegistry>(defaultVizRegistry)

// ──────────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────────

export function ComponentRenderer(props: { component: VizComponent }) {
  const { theme } = useTheme()
  const registry = useContext(VizRegistryContext)
  const renderer = createMemo(() => registry[props.component.type] as Component<{ comp: VizComponent }> | undefined)
  // Generative specs can stream in half-formed or cross-field-inconsistent
  // (e.g. a table whose rows are shorter than its headers mid-stream). A render
  // throw must degrade to a placeholder, not trip the app-level ErrorBoundary
  // and crash the whole TUI.
  return (
    <ErrorBoundary
      fallback={(err) => (
        <text fg={theme.foreground.muted}>
          ⚠ {props.component.type} unavailable
          {err?.message ? ` — ${String(err.message).slice(0, 60)}` : ""}
        </text>
      )}
    >
      <Show when={renderer()} fallback={<text fg={theme.foreground.muted}>⚠ {props.component.type} unavailable</text>}>
        {(comp) => <Dynamic component={comp()} comp={props.component} />}
      </Show>
    </ErrorBoundary>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer — json-render's <Renderer spec registry loading />, for OpenTUI
// ──────────────────────────────────────────────────────────────────────────

export type VizRendererProps = {
  /** The render-safe spec (any object exposing `components`). */
  spec: { components: ReadonlyArray<VizComponent> }
  /** Swap or extend the component map. Defaults to {@link defaultVizRegistry}. */
  registry?: VizRegistry
  /** Mark the spec as still streaming (drives the optional trailing indicator). */
  loading?: boolean
}

/**
 * Walk a spec's components through a registry — nikcli's `<Renderer>`. Provides
 * the registry on context so nested `section`/`grid` containers resolve their
 * children against the same map. Mirrors `@json-render/solid`'s `Renderer`.
 */
export function Renderer(props: VizRendererProps) {
  const { theme } = useTheme()
  return (
    <VizRegistryContext.Provider value={props.registry ?? defaultVizRegistry}>
      <box gap={1} flexDirection="column">
        <For each={props.spec.components}>{(comp) => <ComponentRenderer component={comp} />}</For>
        <Show when={props.loading}>
          <text fg={theme.status.warning.fg ?? theme.accent.alt}>● streaming…</text>
        </Show>
      </box>
    </VizRegistryContext.Provider>
  )
}

/**
 * Bind a (possibly partial) registry once and return a ready `<Renderer>` — the
 * OpenTUI analogue to json-render's `createRenderer(catalog, components)`.
 */
export function createVizRenderer(overrides: Partial<VizRegistry> = {}) {
  const registry: VizRegistry = { ...defaultVizRegistry, ...overrides }
  return (props: Omit<VizRendererProps, "registry">) => <Renderer {...props} registry={registry} />
}

// ──────────────────────────────────────────────────────────────────────────
// Dialog shell
// ──────────────────────────────────────────────────────────────────────────

function specToMarkdown(spec: OpenTUIVizSpecType): string {
  const lines: string[] = []
  lines.push(`# ${spec.title}`)
  if (spec.subtitle) lines.push(`_${spec.subtitle}_`)
  lines.push("")
  for (const c of spec.components) componentToMarkdown(c, lines)
  return lines.join("\n").trim() + "\n"
}

function componentToMarkdown(c: VizComponent, lines: string[]): void {
  const title = "title" in c ? c.title : undefined
  if (title) {
    lines.push(`## ${title}`)
    lines.push("")
  }
  switch (c.type) {
    case "text":
      lines.push(c.content)
      break
    case "markdown":
      lines.push(c.content)
      break
    case "code":
      lines.push("```" + c.filetype)
      lines.push(c.content)
      lines.push("```")
      break
    case "diff":
      lines.push("```diff")
      lines.push(createTwoFilesPatch(c.title ?? "before", c.title ?? "after", c.before, c.after, "", ""))
      lines.push("```")
      break
    case "alert":
      lines.push(`> **[${c.severity.toUpperCase()}]${c.title ? " " + c.title : ""}** — ${c.message}`)
      break
    case "table":
      lines.push(`| ${c.headers.join(" | ")} |`)
      lines.push(`| ${c.headers.map(() => "---").join(" | ")} |`)
      for (const row of c.rows) lines.push(`| ${row.map((x) => x.replace(/\|/g, "\\|")).join(" | ")} |`)
      if (c.totals) lines.push(`| ${c.totals.map((x) => `**${x}**`).join(" | ")} |`)
      break
    case "key_value":
      for (const item of c.items) lines.push(`- **${item.key}**: ${item.value}`)
      break
    case "stat":
      lines.push(`**${c.label}** ${formatValue(c.value, c.format, c.unit)}`)
      break
    case "stat_grid":
      for (const it of c.items) lines.push(`- **${it.label}**: ${formatValue(it.value, it.format, it.unit)}`)
      break
    case "section":
      if (c.description) lines.push(`_${c.description}_`)
      lines.push("")
      for (const child of c.children) componentToMarkdown(child, lines)
      break
    case "grid":
      for (const child of c.children) componentToMarkdown(child, lines)
      break
    case "card":
      if (c.subtitle) lines.push(`_${c.subtitle}_`)
      if (c.body) lines.push(c.body)
      if (c.metrics)
        for (const m of c.metrics) lines.push(`- **${m.label}**: ${formatValue(m.value, m.format, m.unit)}`)
      if (c.footer) lines.push(`_${c.footer}_`)
      break
    case "list":
      c.items.forEach((item, i) => {
        const pre = c.ordered ? `${i + 1}.` : "-"
        lines.push(`${pre} **${item.primary}**${item.secondary ? ` — ${item.secondary}` : ""}`)
      })
      break
    case "accordion":
      for (const s of c.sections) {
        lines.push(`### ${s.title}`)
        if (s.content) lines.push(s.content)
        if (s.items) for (const it of s.items) lines.push(`- **${it.key}**: ${it.value}`)
      }
      break
    case "compare":
      lines.push(`| | ${c.leftLabel} | ${c.rightLabel} |`)
      for (const r of c.rows) lines.push(`| ${r.label} | ${r.left} | ${r.right} |`)
      break
    case "sparkline_row":
      for (const r of c.rows) {
        const last = r.current ?? r.values[r.values.length - 1]
        lines.push(`- **${r.label}**: ${formatValue(last as string | number, r.format, r.unit)} ${sparkline(r.values)}`)
      }
      break
    default:
      lines.push(`_(${TYPE_LABEL[c.type]} component)_`)
  }
  lines.push("")
}

export function DialogOpenTUIViz(props: DialogOpenTUIVizProps) {
  const dialog = useDialog()
  const scrollAcceleration = useScrollAcceleration()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [activeIdx, setActiveIdx] = createSignal(0)
  const [showHelp, setShowHelp] = createSignal(false)

  const components = createMemo(() => props.spec.components)
  const active = createMemo(() => components()[activeIdx()] ?? components()[0]!)
  const multiTab = createMemo(() => components().length > 1)

  const contentHeight = createMemo(() => {
    const h = dimensions().height
    const reserved = multiTab() ? 11 : 9
    return Math.max(12, Math.min(h - reserved, Math.floor(h * 0.78)))
  })

  onMount(() => {
    dialog.setSize("xlarge")
  })

  useKeyboard((evt) => {
    // Number keys 1-9 → tabs 1-9; 0 → tab 10 (index 9)
    if (multiTab() && /^[0-9]$/.test(evt.name)) {
      const target = evt.name === "0" ? 9 : parseInt(evt.name, 10) - 1
      if (target >= 0 && target < components().length) {
        setActiveIdx(target)
        evt.preventDefault()
        evt.stopPropagation()
      }
      return
    }
    if (evt.name === "tab" && !evt.shift && multiTab()) {
      setActiveIdx((i) => (i + 1) % components().length)
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "tab" && evt.shift && multiTab()) {
      setActiveIdx((i) => (i - 1 + components().length) % components().length)
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "e" && !evt.ctrl && !evt.shift && !evt.meta) {
      const md = specToMarkdown(props.spec)
      void Clipboard.copy(md)
        .then(() =>
          toast.show({
            variant: "success",
            message: "Visualization exported as markdown",
          }),
        )
        .catch(toast.error)
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "?" || (evt.name === "h" && evt.shift)) {
      setShowHelp((v) => !v)
      evt.preventDefault()
      evt.stopPropagation()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <box flexDirection="column" gap={0}>
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={theme.accent.alt} attributes={TextAttributes.BOLD}>
              ◈ {props.spec.title}
            </text>
            <Show when={props.streaming}>
              <text fg={theme.status.warning.fg ?? theme.accent.alt}>● live</text>
            </Show>
          </box>
          <Show when={props.spec.subtitle}>
            <text fg={theme.foreground.muted}>{props.spec.subtitle}</text>
          </Show>
        </box>
        <text fg={theme.foreground.muted}>esc · ? help</text>
      </box>

      <Show when={multiTab()}>
        <box flexDirection="row" gap={1} flexShrink={0} flexWrap="wrap">
          <For each={components()}>
            {(comp, i) => {
              const label = tabLabel(comp)
              const icon = TYPE_ICON[comp.type] ?? "•"
              const isActive = createMemo(() => i() === activeIdx())
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isActive() ? theme.surface.offset : undefined}
                  borderColor={isActive() ? theme.border.active : undefined}
                  onMouseUp={() => setActiveIdx(i())}
                >
                  <text
                    fg={isActive() ? theme.accent.fg : theme.foreground.muted}
                    attributes={isActive() ? TextAttributes.BOLD : undefined}
                  >
                    {i() + 1} {icon} {label}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      <box border borderColor={theme.border.default} height={contentHeight()} flexShrink={0}>
        <scrollbox scrollAcceleration={scrollAcceleration()} height={contentHeight() - 2} focused={true}>
          <box paddingTop={1} paddingBottom={1} paddingLeft={1} paddingRight={1} gap={1}>
            {/* `keyed` remounts on tab change so a per-component ErrorBoundary that
                latched on one tab doesn't stay stuck when switching to another. */}
            <Show when={active()} keyed>
              {(comp) => <ComponentRenderer component={comp} />}
            </Show>
          </box>
        </scrollbox>
      </box>

      <Show
        when={showHelp()}
        fallback={
          <box flexDirection="row" gap={2} flexShrink={0}>
            <text fg={theme.foreground.muted}>j/k scroll</text>
            <Show when={multiTab()}>
              <text fg={theme.foreground.muted}>tab · 1-9 · 0 (tab 10)</text>
            </Show>
            <text fg={theme.foreground.muted}>e export</text>
            <text fg={theme.foreground.muted}>? help</text>
          </box>
        }
      >
        <box
          border
          borderColor={theme.border.subtle}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
          flexShrink={0}
        >
          <text fg={theme.accent.secondary} attributes={TextAttributes.BOLD}>
            Keybinds
          </text>
          <text fg={theme.foreground.muted}>j / k or arrows · scroll content</text>
          <Show when={multiTab()}>
            <FooterHint keys="tab / shift+tab" label="next / prev tab" />
            <FooterHint keys="1-9 · 0" label="tabs 1-10 (tab cycles 11-30)" />
          </Show>
          <FooterHint keys="e" label="copy visualization as markdown" />
          <FooterHint keys="?" label="toggle this help" />
          <FooterHint keys="esc" label="close" />
        </box>
      </Show>
    </box>
  )
}
