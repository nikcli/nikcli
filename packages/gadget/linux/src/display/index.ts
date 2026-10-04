/**
 * Displays: a tree comes in, the panel shows it.
 *
 * The bridge sends a drawing tree (`protocol.ts`) and the device lays it out,
 * so a 20-column OLED and a 7-inch e-paper get the same frame and each shows
 * what fits. `layout` turns a tree into text lines; a driver puts those lines
 * on a surface. The two reference drivers draw to a terminal and to a Linux
 * framebuffer; an e-paper driver is `{ spec, draw }` over whatever its vendor
 * library exposes, and `layout` plus `rasterize` do the rest.
 */
import { openSync, writeSync, closeSync } from "node:fs"
import type { BitmapFrame, DisplaySpec, Tree, TreeNode } from "../protocol.ts"
import { CELL_HEIGHT, CELL_WIDTH, LIMITS } from "../protocol.ts"
import { FONT_5X7, GLYPH_WIDTH, GLYPH_HEIGHT } from "./font.ts"

export interface Viewport {
  readonly columns: number
  readonly rows: number
}

export interface Display {
  readonly spec: DisplaySpec
  /** A `tree` display draws what the bridge sends. */
  draw(tree: Tree, viewport: Viewport): Promise<void> | void
  /** A `bitmap` display receives a finished image instead; it must implement this. */
  drawBitmap?(bitmap: Bitmap): Promise<void> | void
  clear?(): Promise<void> | void
}

// ---------------------------------------------------------------------------
// Layout: tree → lines of text, each at most `columns` wide, at most `rows`.

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    for (const word of words) {
      if (line.length === 0) line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
      while (line.length > width) {
        out.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    out.push(line)
  }
  return out
}

/** The text of a `#`..`######` heading line, or undefined. Scanned, not matched: a line is untrusted input. */
function headingText(line: string): string | undefined {
  let hashes = 0
  while (hashes < line.length && line[hashes] === "#") hashes++
  if (hashes < 1 || hashes > 6) return undefined
  const next = line[hashes]
  if (next !== " " && next !== "\t") return undefined
  return line.slice(hashes + 1).trimStart()
}

/** The text of a `- `, `* ` or `+ ` list line, or undefined. */
function listItemText(line: string): string | undefined {
  const trimmed = line.trimStart()
  const marker = trimmed[0]
  if (marker !== "-" && marker !== "*" && marker !== "+") return undefined
  const next = trimmed[1]
  if (next !== " " && next !== "\t") return undefined
  return trimmed.slice(2).trimStart()
}

/** Markdown as a text panel shows it: headings upper-cased, lists bulleted, emphasis stripped. */
export function plainMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const inline = (text: string) =>
        text
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/[*_]{1}(.+?)[*_]{1}/g, "$1")
          .replace(/`(.+?)`/g, "$1")
      const heading = headingText(line)
      if (heading !== undefined) return inline(heading).toUpperCase()
      const item = listItemText(line)
      if (item !== undefined) return `• ${inline(item)}`
      return inline(line)
    })
    .join("\n")
}

function textOf(children: readonly TreeNode[], width: number): string {
  return children
    .map((child) => {
      if (child === null || child === undefined || child === false) return ""
      if (typeof child === "string" || typeof child === "number") return String(child)
      // A node nested in a Text takes the width the Text has; there is no "unbounded" width to give it.
      return render(child, width).join("\n")
    })
    .join("")
}

/** A Box's gap or padding, clamped: layout work is proportional to it, and a tree can come from anywhere. */
function spacing(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(0, Math.floor(value)), LIMITS.TREE_MAX_SPACING)
    : 0
}

function render(node: Tree, requested: number): string[] {
  const width = Math.max(1, Math.min(Math.floor(requested) || 1, 1024))
  switch (node.type) {
    case "Text":
      return wrap(textOf(node.children, width), width)
    case "Markdown":
      return wrap(plainMarkdown(node.props.text), width)
    case "Code":
      return node.props.text.split("\n").map((line) => line.slice(0, width))
    case "Button":
      return [`[${node.props.label}]`.slice(0, width)]
    case "Box": {
      const padding = spacing(node.props.padding)
      const border = node.props.borderStyle ? 1 : 0
      const inner = Math.max(1, width - 2 * (padding + border))
      const gap = spacing(node.props.gap)
      const parts = node.children
        .filter((child): child is Tree | string | number => child !== null && child !== undefined && child !== false)
        .map((child) => (typeof child === "object" ? render(child, inner) : wrap(String(child), inner)))
      let lines: string[]
      if (node.props.direction === "row") {
        const columns = parts.map((part) => Math.max(0, ...part.map((line) => line.length)))
        const height = Math.max(0, ...parts.map((part) => part.length))
        lines = []
        for (let row = 0; row < height; row++) {
          lines.push(
            parts
              .map((part, index) => (part[row] ?? "").padEnd(columns[index] ?? 0))
              .join(" ".repeat(gap))
              .slice(0, inner),
          )
        }
      } else {
        lines = []
        parts.forEach((part, index) => {
          if (index > 0) for (let g = 0; g < gap; g++) lines.push("")
          lines.push(...part)
        })
      }
      if (node.props.justifyContent === "center") lines = lines.map((line) => centre(line, inner))
      if (node.props.justifyContent === "flex-end") lines = lines.map((line) => line.padStart(inner))
      const padded = lines.map((line) => " ".repeat(padding) + line.padEnd(inner) + " ".repeat(padding))
      for (let p = 0; p < padding; p++) {
        padded.unshift(" ".repeat(inner + 2 * padding))
        padded.push(" ".repeat(inner + 2 * padding))
      }
      if (!border) return padded
      const chars = BORDERS[node.props.borderStyle ?? "single"]
      const w = inner + 2 * padding
      return [
        chars.tl + chars.h.repeat(w) + chars.tr,
        ...padded.map((line) => chars.v + line + chars.v),
        chars.bl + chars.h.repeat(w) + chars.br,
      ]
    }
  }
}

const BORDERS = {
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  bold: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
} as const

function centre(line: string, width: number): string {
  const left = Math.max(0, Math.floor((width - line.length) / 2))
  return " ".repeat(left) + line
}

/** Lay a tree out for a viewport. Always exactly `rows` lines of at most `columns` characters. */
export function layout(tree: Tree, viewport: Viewport): string[] {
  const lines = render(tree, viewport.columns).slice(0, viewport.rows)
  while (lines.length < viewport.rows) lines.push("")
  return lines.map((line) => line.slice(0, viewport.columns))
}

// ---------------------------------------------------------------------------
// Rasterization: lines → 1-bit pixels, for panels that take a bitmap.

export interface Bitmap {
  readonly width: number
  readonly height: number
  /** Row-major, one byte per pixel, 0 = background, 1 = ink. */
  readonly pixels: Uint8Array
}

export function rasterize(
  lines: readonly string[],
  options: { width: number; height: number; scale?: number },
): Bitmap {
  const scale = Math.max(1, Math.floor(options.scale ?? 1))
  const pixels = new Uint8Array(options.width * options.height)
  const cellW = (GLYPH_WIDTH + 1) * scale
  const cellH = (GLYPH_HEIGHT + 1) * scale
  lines.forEach((line, row) => {
    for (let col = 0; col < line.length; col++) {
      const code = line.charCodeAt(col)
      const glyph = FONT_5X7[code >= 32 && code < 127 ? code - 32 : 0]!
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        const column = glyph[gx]!
        for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
          if (!((column >> gy) & 1)) continue
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const x = col * cellW + gx * scale + sx
              const y = row * cellH + gy * scale + sy
              if (x < options.width && y < options.height) pixels[y * options.width + x] = 1
            }
          }
        }
      }
    }
  })
  return { width: options.width, height: options.height, pixels }
}

/** How many character cells a panel of `width × height` pixels holds at `scale`. */
export function cellsFor(width: number, height: number, scale = 1): Viewport {
  return {
    columns: Math.max(1, Math.floor(width / (CELL_WIDTH * scale))),
    rows: Math.max(1, Math.floor(height / (CELL_HEIGHT * scale))),
  }
}

// ---------------------------------------------------------------------------
// Bitmap frames: what the bridge sends to a panel that has no layout engine.

/** Pack a bitmap to 1 bit per pixel, rows padded to whole bytes, most significant bit first. */
export function packBitmap(bitmap: Bitmap): BitmapFrame {
  const stride = Math.ceil(bitmap.width / 8)
  const bytes = new Uint8Array(stride * bitmap.height)
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      if (bitmap.pixels[y * bitmap.width + x]) bytes[y * stride + (x >> 3)]! |= 0x80 >> (x & 7)
    }
  }
  return { width: bitmap.width, height: bitmap.height, format: "1bpp", data: Buffer.from(bytes).toString("base64") }
}

/** The inverse of `packBitmap`. Throws when the data is not the size the dimensions say. */
export function unpackBitmap(frame: BitmapFrame): Bitmap {
  if (frame.format !== "1bpp") throw new Error(`unsupported bitmap format ${String(frame.format)}`)
  const stride = Math.ceil(frame.width / 8)
  const bytes = Buffer.from(frame.data, "base64")
  if (bytes.byteLength !== stride * frame.height) {
    throw new Error(
      `bitmap is ${bytes.byteLength} bytes, expected ${stride * frame.height} for ${frame.width}x${frame.height}`,
    )
  }
  const pixels = new Uint8Array(frame.width * frame.height)
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      if (bytes[y * stride + (x >> 3)]! & (0x80 >> (x & 7))) pixels[y * frame.width + x] = 1
    }
  }
  return { width: frame.width, height: frame.height, pixels }
}

/**
 * Render a tree for a `bitmap` display: lay it out for the cells the panel
 * holds at its scale, rasterize with the built-in font, pack. This runs on the
 * bridge, so the device needs no font, no layout and no tree parser.
 */
export function renderBitmap(tree: Tree, spec: DisplaySpec): BitmapFrame {
  if (spec.format !== "bitmap" || spec.width === undefined || spec.height === undefined) {
    throw new Error("renderBitmap needs a bitmap display with width and height")
  }
  const scale = spec.scale ?? 1
  const cells = cellsFor(spec.width, spec.height, scale)
  const lines = layout(tree, cells)
  return packBitmap(rasterize(lines, { width: spec.width, height: spec.height, scale }))
}

// ---------------------------------------------------------------------------
// Reference drivers

/** Draws to a terminal: the preview driver, and what a headless gadget uses to log frames. */
export function terminal(options: { columns?: number; rows?: number; stream?: NodeJS.WritableStream } = {}): Display {
  const columns = options.columns ?? 40
  const rows = options.rows ?? 12
  const stream = options.stream ?? process.stdout
  return {
    spec: { columns, rows, depth: 8, format: "tree" },
    draw(tree, viewport) {
      const lines = layout(tree, { columns: Math.min(columns, viewport.columns), rows: Math.min(rows, viewport.rows) })
      const bar = "─".repeat(Math.min(columns, viewport.columns))
      stream.write(`┌${bar}┐\n${lines.map((line) => `│${line.padEnd(bar.length)}│`).join("\n")}\n└${bar}┘\n`)
    },
    clear() {
      stream.write("\n")
    },
  }
}

export interface FramebufferOptions {
  /** `/dev/fb0` on a Pi with a small SPI/HDMI panel. */
  readonly device?: string
  readonly width: number
  readonly height: number
  /** Bytes per pixel the framebuffer expects: 2 (RGB565) or 4 (XRGB8888). */
  readonly bytesPerPixel?: 2 | 4
  readonly scale?: number
  readonly invert?: boolean
}

/**
 * Draws to a Linux framebuffer with the built-in 5×7 font. The simplest way
 * to put the agent's words on a cheap HDMI or SPI screen: no X, no browser.
 */
export function framebuffer(options: FramebufferOptions): Display {
  const device = options.device ?? "/dev/fb0"
  const bpp = options.bytesPerPixel ?? 4
  const scale = options.scale ?? 2
  const cells = cellsFor(options.width, options.height, scale)
  const paint = (bitmap: Bitmap) => {
    const buffer = Buffer.alloc(bitmap.width * bitmap.height * bpp)
    for (let i = 0; i < bitmap.pixels.length; i++) {
      const ink = bitmap.pixels[i] === 1 ? !options.invert : !!options.invert
      if (bpp === 2) buffer.writeUInt16LE(ink ? 0xffff : 0x0000, i * 2)
      else buffer.writeUInt32LE(ink ? 0x00ffffff : 0x00000000, i * 4)
    }
    const fd = openSync(device, "w")
    try {
      writeSync(fd, buffer, 0, buffer.length, 0)
    } finally {
      closeSync(fd)
    }
  }
  return {
    spec: { columns: cells.columns, rows: cells.rows, depth: 1, format: "tree" },
    draw(tree, viewport) {
      const lines = layout(tree, {
        columns: Math.min(cells.columns, viewport.columns),
        rows: Math.min(cells.rows, viewport.rows),
      })
      paint(rasterize(lines, { width: options.width, height: options.height, scale }))
    },
    clear() {
      paint({ width: options.width, height: options.height, pixels: new Uint8Array(options.width * options.height) })
    },
  }
}

export interface BitmapOptions {
  readonly width: number
  readonly height: number
  readonly scale?: number
  /** Called with each finished frame: push it to the panel with the vendor's library. */
  readonly push: (bitmap: Bitmap) => Promise<void> | void
  readonly clear?: () => Promise<void> | void
}

/**
 * A panel that takes a finished 1-bit image — an e-paper board, an OLED over
 * I²C. The bridge lays the tree out and rasterizes it; `push` only has to put
 * the pixels on the glass.
 */
export function bitmap(options: BitmapOptions): Display {
  const scale = options.scale ?? 1
  const cells = cellsFor(options.width, options.height, scale)
  return {
    spec: {
      columns: cells.columns,
      rows: cells.rows,
      depth: 1,
      format: "bitmap",
      width: options.width,
      height: options.height,
      ...(scale === 1 ? {} : { scale }),
    },
    draw() {
      throw new Error("a bitmap display is sent finished images, not trees")
    },
    drawBitmap: (frame) => options.push(frame),
    clear: options.clear,
  }
}
