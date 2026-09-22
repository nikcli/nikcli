import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import {
  applyLiveCapabilities,
  chooseInlineImageRenderer,
  detectCapabilities,
  encodeKittyVirtual,
  kittyIdColor,
  kittyPlaceholderGrid,
  pickDecoder,
  renderImage,
  resize,
  type LiveCapabilities,
  type RendererKind,
} from "@nikcli-ai/tui-image"
import { cellSize } from "@tui/util/browser-frames"
import { fitOverlayCells, type CellMetrics } from "@tui/util/native-overlay"
import { useTheme } from "@tui/context/theme"
import { createPromiseCache } from "@tui/util/lru-cache"

/**
 * Image preview in the scrolling message list.
 *
 * Kitty / Ghostty: drawless virtual placement + placeholder cells that
 * scroll with the grid. Cursor / VS Code / everything else: truecolor
 * half-blocks through the grid. Sixel overlays stay on the WebView dialog
 * — they cannot live in this list without painting CSI over the composer.
 */
export { registerNativeOverlay } from "@tui/util/native-overlay"
export type { NativeOverlay } from "@tui/util/native-overlay"

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024
const MAX_PREVIEW_COLUMNS = 120
const MAX_PREVIEW_FALLBACK_ROWS = 36
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)(?:$|[?#])/i
const GITHUB_ATTACHMENT = new RegExp("^https://github\\.com/user-attachments/assets/", "i")
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0)

function cleanPreviewUrl(value: string) {
  return value
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/[),.;:!?]+$/, "")
}

function hostForUrl(value: string) {
  if (value.startsWith("data:image/")) return "attached image"
  if (value.startsWith("/")) return "local file"
  try {
    const url = new URL(value)
    if (url.protocol === "file:") return "local file"
    return url.hostname.replace(/^www\./, "") || value
  } catch {
    return value
  }
}

function isSupportedSource(value: string) {
  if (value.startsWith("data:image/")) return true
  if (value.startsWith("/")) return true
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:"
  } catch {
    return false
  }
}

function isImageCandidate(value: string, explicit: boolean) {
  if (!isSupportedSource(value)) return false
  if (explicit) return true
  if (IMAGE_EXTENSIONS.test(value)) return true
  return GITHUB_ATTACHMENT.test(value)
}

export function extractTuiImageUrls(text: string, limit = 2) {
  const urls: string[] = []
  const seen = new Set<string>()
  const add = (value: string, explicit: boolean) => {
    const url = cleanPreviewUrl(value)
    if (!url || seen.has(url)) return
    if (!isImageCandidate(url, explicit)) return
    seen.add(url)
    urls.push(url)
  }

  for (const match of text.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^)]+?))(?:\s+["'][^"']*["'])?\)/g)) {
    add(match[1] ?? match[2] ?? "", true)
    if (urls.length >= limit) return urls
  }
  for (const match of text.matchAll(/(?:https?:\/\/|file:\/\/)[^\s<>()\]]+/g)) {
    add(match[0], false)
    if (urls.length >= limit) return urls
  }
  for (const match of text.matchAll(/["'](\/[^"']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))["']/gi)) {
    add(match[1] ?? "", false)
    if (urls.length >= limit) return urls
  }
  for (const match of text.matchAll(/(?:^|\s)(\/[\w~./%+-]+\.(?:png|jpe?g|gif|webp|bmp|tiff?))(?:$|\s)/gi)) {
    add(match[1] ?? "", false)
    if (urls.length >= limit) return urls
  }
  return urls
}

async function readImageBytes(url: string, signal: AbortSignal) {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)?((?:;[^,]*)?),(.*)$/s)
    if (!match) throw new Error("invalid data URL")
    const mime = match[1]?.toLowerCase()
    if (mime && !mime.startsWith("image/")) throw new Error("data URL is not an image")
    const metadata = match[2] ?? ""
    const payload = match[3] ?? ""
    const bytes = metadata.includes(";base64")
      ? Uint8Array.fromBase64(payload)
      : new TextEncoder().encode(decodeURIComponent(payload))
    if (bytes.byteLength > MAX_PREVIEW_BYTES) throw new Error("image is too large")
    return bytes
  }

  if (url.startsWith("/") || url.startsWith("file://")) {
    const filename = url.startsWith("file://") ? new URL(url).pathname : url
    const file = Bun.file(decodeURIComponent(filename))
    if (!(await file.exists())) throw new Error("image not found")
    if (file.size > MAX_PREVIEW_BYTES) throw new Error("image is too large")
    return new Uint8Array(await file.arrayBuffer())
  }

  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "image/png,image/jpeg,image/gif,image/bmp,image/tiff,image/*;q=0.5,*/*;q=0.1",
    },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (contentType && !contentType.startsWith("image/")) throw new Error("URL is not an image")

  const contentLength = Number(response.headers.get("content-length") ?? 0)
  if (contentLength > MAX_PREVIEW_BYTES) throw new Error("image is too large")

  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_PREVIEW_BYTES) throw new Error("image is too large")
  return new Uint8Array(buffer)
}

type Cell = { char: string; fg: RGBA; bg: RGBA }

type TuiImageData = {
  url: string
  host: string
  width: number
  height: number
  columns: number
  rows: Cell[][]
  /**
   * Kitty virtual-placement transmission (`a=T,U=1,q=2…`). Drawless by
   * construction, so writing it to stdout is safe inside the TUI; written
   * once per cache entry (see `transmitted`).
   */
  nativeBytes?: Uint8Array | string
  /** Whether `nativeBytes` has already been written to the terminal. */
  transmitted?: boolean
  /** Placeholder cell rows the terminal composites the image over. */
  placeholder?: { rows: string[]; fg: RGBA }
  renderer: RendererKind
}

export interface TuiImageWriter {
  (bytes: string | Uint8Array): void
}

/**
 * Default writer — writes to `process.stdout`. Only ever used for drawless
 * kitty transmissions; kept injectable so the component can be unit-tested
 * without a live renderer.
 */
const defaultWriter: TuiImageWriter = (bytes) => {
  if (typeof process === "undefined" || !process.stdout) return
  try {
    if (typeof bytes === "string") {
      process.stdout.write(bytes)
    } else {
      process.stdout.write(Buffer.from(bytes))
    }
  } catch {
    // non-fatal
  }
}

// Virtual-placement image ids are per terminal session; offsetting by pid
// keeps concurrent / successive nikcli processes from overwriting each
// other's images in the same terminal.
let placeholderIdCounter = 0
const placeholderIdBase = (((typeof process !== "undefined" ? process.pid : 0) ?? 0) & 0xff) << 16

function nextPlaceholderId() {
  placeholderIdCounter = (placeholderIdCounter % 0xffff) + 1
  return placeholderIdBase + placeholderIdCounter
}

type TuiImageState =
  | { status: "loading" }
  | { status: "ready"; data: TuiImageData }
  | { status: "error"; message: string }

// Keyed by size as well as URL, so a resize is a new entry: bounded, or every
// resize would keep another full cell grid (and native payload) per image.
const previewCache = createPromiseCache<TuiImageData>({ maxEntries: 16 })

function previewBounds(maxColumns: number, maxRows: number) {
  return {
    columns: Math.max(1, Math.min(MAX_PREVIEW_COLUMNS, maxColumns)),
    rows: Math.max(1, Math.min(MAX_PREVIEW_FALLBACK_ROWS, maxRows)),
  }
}

function applySgr(sequence: string, current: { fg: RGBA; bg: RGBA }) {
  const codes = sequence.length > 0 ? sequence.split(";").map((part) => Number(part || 0)) : [0]
  let fg = current.fg
  let bg = current.bg
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index] ?? 0
    if (code === 0) {
      fg = TRANSPARENT
      bg = TRANSPARENT
      continue
    }
    if ((code === 38 || code === 48) && codes[index + 1] === 2) {
      const color = RGBA.fromInts(codes[index + 2] ?? 0, codes[index + 3] ?? 0, codes[index + 4] ?? 0, 255)
      if (code === 38) fg = color
      else bg = color
      index += 4
    }
  }
  return { fg, bg }
}

/**
 * Skip one escape sequence starting at `i` (which points at ESC).
 * Returns the index of the last consumed character.
 */
function skipEscape(line: string, i: number): { end: number; sgr?: string } {
  const next = line[i + 1]
  if (next === "[") {
    for (let j = i + 2; j < line.length; j++) {
      const code = line.charCodeAt(j)
      if (code >= 0x40 && code <= 0x7e) {
        return { end: j, sgr: line[j] === "m" ? line.slice(i + 2, j) : undefined }
      }
    }
    return { end: line.length - 1 }
  }
  if (next === "]" || next === "_" || next === "P" || next === "^") {
    const st = line.indexOf("\x1b\\", i + 2)
    const bel = line.indexOf("\x07", i + 2)
    let end = line.length - 1
    if (st !== -1) end = st + 1
    if (bel !== -1 && bel < end) end = bel
    return { end }
  }
  return { end: Math.min(i + 1, line.length - 1) }
}

/**
 * Turn half-block ANSI into OpenTUI cells. Escape sequences are consumed,
 * never stored as characters — leftover CSI in a cell is what paints the
 * TUI with raw `\x1b[` junk.
 */
export function toCellGrid(text: string, columns: number): Cell[][] {
  const rows = text.split("\n")
  const out: Cell[][] = []
  for (const line of rows) {
    const cells: Cell[] = []
    let fg = TRANSPARENT
    let bg = TRANSPARENT
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (ch === "\x1b") {
        const skipped = skipEscape(line, i)
        if (skipped.sgr !== undefined) {
          const next = applySgr(skipped.sgr, { fg, bg })
          fg = next.fg
          bg = next.bg
        }
        i = skipped.end
        continue
      }
      if (ch.charCodeAt(0) < 0x20) continue
      cells.push({ char: ch, fg, bg })
    }
    while (cells.length < columns) cells.push({ char: " ", fg: TRANSPARENT, bg: TRANSPARENT })
    if (cells.length > columns) cells.length = columns
    out.push(cells)
  }
  return out
}

async function loadTuiImage(
  url: string,
  maxColumns: number,
  maxRows: number,
  live: LiveCapabilities | null,
  cell: CellMetrics,
  signal: AbortSignal,
): Promise<TuiImageData> {
  const bytes = await readImageBytes(url, signal)
  if (signal.aborted) throw new Error("aborted")
  const capabilities = applyLiveCapabilities(detectCapabilities(), live)
  const bounds = previewBounds(maxColumns, maxRows)
  const kind = chooseInlineImageRenderer(capabilities)

  if (kind === "kitty") {
    const decoder = await pickDecoder()
    const image = await decoder(bytes)
    if (image.width <= 0 || image.height <= 0) throw new Error("decoder produced a zero-sized image")
    const fitted = fitOverlayCells(image.width, image.height, bounds, cell)
    const target =
      image.width === fitted.pixelWidth && image.height === fitted.pixelHeight
        ? image
        : resize(image, fitted.pixelWidth, fitted.pixelHeight)
    const id = nextPlaceholderId()
    const color = kittyIdColor(id)
    return {
      url,
      host: hostForUrl(url),
      width: image.width,
      height: image.height,
      columns: fitted.columns,
      rows: [],
      nativeBytes: encodeKittyVirtual(target, { id, columns: fitted.columns, rows: fitted.rows }),
      placeholder: {
        rows: kittyPlaceholderGrid(fitted.columns, fitted.rows),
        fg: RGBA.fromInts(color.r, color.g, color.b, 255),
      },
      renderer: "kitty",
    }
  }

  const result = await renderImage({
    input: bytes,
    columns: bounds.columns,
    rows: bounds.rows,
    capabilities,
    renderer: "halfblock",
  })
  const fallback = result.output as string
  return {
    url,
    host: hostForUrl(url),
    width: 0,
    height: 0,
    columns: result.columns,
    rows: toCellGrid(fallback, result.columns),
    renderer: "halfblock",
  }
}

function cachedTuiImage(
  url: string,
  maxColumns: number,
  maxRows: number,
  live: LiveCapabilities | null,
  cell: CellMetrics,
  signal: AbortSignal,
) {
  const bounds = previewBounds(maxColumns, maxRows)
  const key = `${bounds.columns}x${bounds.rows}\n${Math.round(cell.width)}x${Math.round(cell.height)}\n${live ? "live" : "env"}\n${url}`
  return previewCache.load(
    key,
    (loadSignal) => loadTuiImage(url, bounds.columns, bounds.rows, live, cell, loadSignal),
    signal,
  )
}

function TuiImage(props: { url: string; maxColumns: number; maxRows: number; writer?: TuiImageWriter }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [state, setState] = createSignal<TuiImageState>({ status: "loading" })

  createEffect(() => {
    const controller = new AbortController()
    const url = props.url
    setState({ status: "loading" })
    const live = (renderer.capabilities ?? null) as LiveCapabilities | null
    const cell = cellSize(renderer.resolution, renderer.terminalWidth, renderer.terminalHeight)
    void cachedTuiImage(url, props.maxColumns, props.maxRows, live, cell, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          if (data.nativeBytes !== undefined && !data.transmitted) {
            data.transmitted = true
            const writer = props.writer ?? defaultWriter
            writer(data.nativeBytes)
          }
          setState({ status: "ready", data })
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      })
    onCleanup(() => controller.abort())
  })

  return (
    <box
      marginTop={1}
      paddingLeft={1}
      border={["left"]}
      borderColor={theme.border.default}
      flexDirection="column"
      flexShrink={0}
    >
      <Switch>
        <Match when={state().status === "loading"}>
          <text fg={theme.foreground.muted}>Loading image preview...</text>
        </Match>
        <Match when={state().status === "error" ? (state() as { status: "error"; message: string }) : undefined}>
          {(error) => <text fg={theme.foreground.muted}>Image preview unavailable: {error().message}</text>}
        </Match>
        <Match
          when={state().status === "ready" ? (state() as { status: "ready"; data: TuiImageData }).data : undefined}
        >
          {(data) => (
            <>
              <text fg={theme.foreground.muted}>
                image | {data().host} | {data().renderer}
                {data().placeholder ? " (native)" : ""}
              </text>
              <Show when={data().placeholder}>
                {(placeholder) => (
                  <box marginTop={1} flexDirection="column" flexShrink={0}>
                    <For each={placeholder().rows}>{(row) => <text fg={placeholder().fg}>{row}</text>}</For>
                  </box>
                )}
              </Show>
              <Show when={data().rows.length > 0}>
                <box marginTop={1} flexDirection="column" flexShrink={0}>
                  <For each={data().rows}>
                    {(row) => (
                      <text>
                        <For each={row}>{(cell) => <span style={{ fg: cell.fg, bg: cell.bg }}>{cell.char}</span>}</For>
                      </text>
                    )}
                  </For>
                </box>
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </box>
  )
}

export function TuiImageList(props: {
  text?: string
  urls?: string[]
  maxColumns: number
  maxRows: number
  limit?: number
  writer?: TuiImageWriter
}) {
  const urls = createMemo(() => {
    const limit = props.limit ?? 2
    const seen = new Set<string>()
    const result: string[] = []
    const add = (value: string, explicit: boolean) => {
      const url = cleanPreviewUrl(value)
      if (!url || seen.has(url)) return
      if (!isImageCandidate(url, explicit)) return
      seen.add(url)
      result.push(url)
    }
    for (const url of props.urls ?? []) {
      add(url, true)
      if (result.length >= limit) return result
    }
    for (const url of extractTuiImageUrls(props.text ?? "", limit)) {
      add(url, false)
      if (result.length >= limit) return result
    }
    return result
  })

  return (
    <Show when={urls().length > 0}>
      <box flexDirection="column" flexShrink={0}>
        <For each={urls()}>
          {(url) => <TuiImage url={url} maxColumns={props.maxColumns} maxRows={props.maxRows} writer={props.writer} />}
        </For>
      </box>
    </Show>
  )
}
