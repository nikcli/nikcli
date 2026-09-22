import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { RGBA } from "@opentui/core"
import { pickDecoder, resize } from "@nikcli-ai/tui-image"
import { useTheme } from "@tui/context/theme"
import { createPromiseCache } from "@tui/util/lru-cache"

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024
const MAX_PREVIEW_COLUMNS = 60
const MAX_PREVIEW_BRAILLE_ROWS = 16
const BRAILLE_DOT_WIDTH = 2
const BRAILLE_DOT_HEIGHT = 4
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)(?:$|[?#])/i
const GITHUB_ATTACHMENT = /^https:\/\/github\.com\/user-attachments\/assets\//i
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0)

const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

type PixelColor = [r: number, g: number, b: number, a: number]

type ImagePreviewCell = {
  char: string
  fg: RGBA
  bg: RGBA
}

type ImagePreviewData = {
  url: string
  host: string
  width: number
  height: number
  columns: number
  rows: ImagePreviewCell[][]
}

type ImagePreviewState =
  | { status: "loading" }
  | { status: "ready"; data: ImagePreviewData }
  | { status: "error"; message: string }

// Keyed by width as well as URL, so a resize is a new entry: bounded, or every
// resize would keep another braille grid per image.
const previewCache = createPromiseCache<ImagePreviewData>({ maxEntries: 16 })

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

export function extractImagePreviewUrls(text: string, limit = 2) {
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

function pixelAt(data: Uint8Array, width: number, x: number, y: number): PixelColor {
  const index = (y * width + x) * 4
  return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0, data[index + 3] ?? 255]
}

function pixelToRgba(color: PixelColor) {
  return RGBA.fromInts(Math.round(color[0]), Math.round(color[1]), Math.round(color[2]), Math.round(color[3]))
}

function averageColor(colors: PixelColor[], indexes?: number[]) {
  const source = indexes ?? colors.map((_, index) => index)
  if (source.length === 0) return [0, 0, 0, 0] satisfies PixelColor
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  for (const index of source) {
    const color = colors[index]
    if (!color) continue
    r += color[0]
    g += color[1]
    b += color[2]
    a += color[3]
  }
  return [r / source.length, g / source.length, b / source.length, a / source.length] satisfies PixelColor
}

function colorDistanceSq(a: PixelColor, b: PixelColor) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  const da = a[3] - b[3]
  return dr * dr + dg * dg + db * db + da * da
}

function luminance(color: PixelColor) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]
}

function solidCell(colors: PixelColor[]): ImagePreviewCell {
  const bg = pixelToRgba(averageColor(colors))
  return { char: "⠀", fg: TRANSPARENT, bg }
}

function brailleCell(colors: PixelColor[]): ImagePreviewCell {
  let darkest = 0
  let brightest = 0
  for (let index = 1; index < colors.length; index++) {
    if (luminance(colors[index]) < luminance(colors[darkest])) darkest = index
    if (luminance(colors[index]) > luminance(colors[brightest])) brightest = index
  }

  if (colorDistanceSq(colors[darkest], colors[brightest]) < 24 * 24 * 3) return solidCell(colors)

  let centers: [PixelColor, PixelColor] = [colors[darkest], colors[brightest]]
  let groups: [number[], number[]] = [[], []]
  for (let iteration = 0; iteration < 4; iteration++) {
    groups = [[], []]
    for (let index = 0; index < colors.length; index++) {
      const group = colorDistanceSq(colors[index], centers[0]) <= colorDistanceSq(colors[index], centers[1]) ? 0 : 1
      groups[group].push(index)
    }
    if (groups[0].length === 0 || groups[1].length === 0) return solidCell(colors)
    centers = [averageColor(colors, groups[0]), averageColor(colors, groups[1])]
  }

  const fgGroup = groups[0].length <= groups[1].length ? 0 : 1
  const bgGroup = fgGroup === 0 ? 1 : 0
  let mask = 0
  for (const index of groups[fgGroup]) {
    const x = index % BRAILLE_DOT_WIDTH
    const y = Math.floor(index / BRAILLE_DOT_WIDTH)
    mask |= BRAILLE_BITS[y]?.[x] ?? 0
  }

  return {
    char: String.fromCharCode(0x2800 + mask),
    fg: pixelToRgba(centers[fgGroup]),
    bg: pixelToRgba(centers[bgGroup]),
  }
}

function roundToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.round(value / multiple) * multiple)
}

function fitPreviewSize(sourceWidth: number, sourceHeight: number, maxColumns: number) {
  const availableColumns = Math.max(1, Math.min(MAX_PREVIEW_COLUMNS, maxColumns))
  const sourceLimitedColumns = Math.max(1, Math.ceil(sourceWidth / BRAILLE_DOT_WIDTH))
  const maxPixelHeight = MAX_PREVIEW_BRAILLE_ROWS * BRAILLE_DOT_HEIGHT
  let columns = Math.min(availableColumns, sourceLimitedColumns)
  let pixelHeight = roundToMultiple(((columns * BRAILLE_DOT_WIDTH) / sourceWidth) * sourceHeight, BRAILLE_DOT_HEIGHT)

  if (pixelHeight > maxPixelHeight) {
    columns = Math.max(
      1,
      Math.min(
        availableColumns,
        sourceLimitedColumns,
        Math.floor((maxPixelHeight * sourceWidth) / (sourceHeight * BRAILLE_DOT_WIDTH)),
      ),
    )
    pixelHeight = roundToMultiple(((columns * BRAILLE_DOT_WIDTH) / sourceWidth) * sourceHeight, BRAILLE_DOT_HEIGHT)
  }

  return {
    columns,
    pixelWidth: columns * BRAILLE_DOT_WIDTH,
    pixelHeight: Math.min(maxPixelHeight, pixelHeight),
  }
}

async function loadImagePreview(url: string, maxColumns: number, signal: AbortSignal): Promise<ImagePreviewData> {
  const bytes = await readImageBytes(url, signal)
  if (signal.aborted) throw new Error("aborted")

  // Via `pickDecoder` rather than Jimp directly: this Braille path is the
  // fallback for terminals without a graphics protocol — most of Windows —
  // and Jimp cannot read the WebP files `IMAGE_EXTENSIONS` accepts.
  const decode = await pickDecoder()
  const image = await decode(bytes)
  const sourceWidth = image.width
  const sourceHeight = image.height
  if (!sourceWidth || !sourceHeight) throw new Error("image has no pixels")

  const { columns, pixelWidth, pixelHeight } = fitPreviewSize(sourceWidth, sourceHeight, maxColumns)

  const scaled = resize(image, pixelWidth, pixelHeight)
  const data = new Uint8Array(scaled.data.buffer, scaled.data.byteOffset, scaled.data.byteLength)
  const rows: ImagePreviewCell[][] = []
  for (let y = 0; y < pixelHeight; y += BRAILLE_DOT_HEIGHT) {
    const row: ImagePreviewCell[] = []
    for (let x = 0; x < pixelWidth; x += BRAILLE_DOT_WIDTH) {
      const colors: PixelColor[] = []
      for (let dy = 0; dy < BRAILLE_DOT_HEIGHT; dy++) {
        for (let dx = 0; dx < BRAILLE_DOT_WIDTH; dx++) {
          colors.push(pixelAt(data, pixelWidth, x + dx, y + dy))
        }
      }
      row.push(brailleCell(colors))
    }
    rows.push(row)
  }

  return {
    url,
    host: hostForUrl(url),
    width: sourceWidth,
    height: sourceHeight,
    columns,
    rows,
  }
}

function cachedImagePreview(url: string, maxColumns: number, signal: AbortSignal) {
  const key = `${maxColumns}\n${url}`
  return previewCache.load(key, (loadSignal) => loadImagePreview(url, maxColumns, loadSignal), signal)
}

function ImagePreview(props: { url: string; maxColumns: number }) {
  const { theme } = useTheme()
  const [state, setState] = createSignal<ImagePreviewState>({
    status: "loading",
  })

  createEffect(() => {
    const controller = new AbortController()
    const url = props.url
    setState({ status: "loading" })
    void cachedImagePreview(url, props.maxColumns, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data })
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
          when={state().status === "ready" ? (state() as { status: "ready"; data: ImagePreviewData }).data : undefined}
        >
          {(data) => (
            <>
              <text fg={theme.foreground.muted}>
                image | {data().host} | {data().width}x{data().height}
              </text>
              <box marginTop={1} flexDirection="column" flexShrink={0}>
                <For each={data().rows}>
                  {(row) => (
                    <text>
                      <For each={row}>{(cell) => <span style={{ fg: cell.fg, bg: cell.bg }}>{cell.char}</span>}</For>
                    </text>
                  )}
                </For>
              </box>
            </>
          )}
        </Match>
      </Switch>
    </box>
  )
}

export function ImagePreviewList(props: { text?: string; urls?: string[]; maxColumns: number; limit?: number }) {
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
    for (const url of extractImagePreviewUrls(props.text ?? "", limit)) {
      add(url, false)
      if (result.length >= limit) return result
    }
    return result
  })

  return (
    <Show when={urls().length > 0}>
      <box flexDirection="column" flexShrink={0}>
        <For each={urls()}>{(url) => <ImagePreview url={url} maxColumns={props.maxColumns} />}</For>
      </box>
    </Show>
  )
}
