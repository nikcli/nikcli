import { useScrollAcceleration } from "@tui/util/scroll"
import { TextAttributes, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import TurndownService from "turndown"
import {
  applyLiveCapabilities,
  detectCapabilities,
  supportsKittyUnicodePlaceholders,
  type LiveCapabilities,
} from "@nikcli-ai/tui-image"
import { DialogHeader, useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import {
  BrowserSurface,
  browserSurfaceKey,
  type BrowserSurfaceControls,
  type BrowserSurfaceState,
  type SurfaceRenderer,
} from "./browser-surface"

type FocusArea = "url" | "content" | "page"

/**
 * `live` drives a real Bun.WebView page and paints its pixels (see
 * `specs/browser-live-view.md`); `reader` is the original fetch + Turndown
 * path. Reader mode is not a degraded fallback so much as a different tool —
 * it is the right rendering on a terminal without graphics, and it is what you
 * want when you mean to *read* a page rather than use it.
 */
type PreviewMode = "live" | "reader"

type PageState = {
  loading: boolean
  error: string | null
  url: string
  title: string
  description: string
  markdown: string
  headings: Heading[]
  sections: Section[]
  links: Link[]
}

type Heading = { level: number; text: string; slug: string }
type Section = { level: number; title: string; slug: string; markdown: string }
type Link = { text: string; href: string }

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
})

turndown.remove(["script", "style", "noscript", "iframe", "canvas", "form", "button", "input"])

function stripNoise(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
}

function extractTitle(html: string) {
  return (
    html
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ?? ""
  )
}

function extractDescription(html: string) {
  return (
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] ??
    ""
  )
}

function extractContentRoot(html: string) {
  return (
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
    html
  )
}

function normalizeMarkdown(md: string) {
  return md
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
}

function decodeHtml(v: string) {
  return v
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
}

function stripTags(v: string) {
  return decodeHtml(v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim()
}

function slugify(v: string) {
  return (
    v
      .toLowerCase()
      .replace(/[`*_~[\]()+!?.,:;"']/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  )
}

/** Where the preview starts when it is opened without a URL. */
const HOME_URL = "https://www.google.com"

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function hostLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function parseStructure(markdown: string): {
  headings: Heading[]
  sections: Section[]
} {
  const lines = markdown.split("\n")
  const headings: (Heading & { index: number })[] = []
  const seen = new Map<string, number>()

  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})\s+(.+)$/.exec(lines[i]?.trim() ?? "")
    if (!match) continue
    const base = slugify(match[2])
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    headings.push({
      level: match[1].length,
      text: match[2].trim(),
      slug: count === 0 ? base : `${base}-${count + 1}`,
      index: i,
    })
  }

  const sections: Section[] = headings.map((h, idx) => {
    let end = lines.length
    for (let next = idx + 1; next < headings.length; next++) {
      if (headings[next]!.level <= h.level) {
        end = headings[next]!.index
        break
      }
    }
    return {
      level: h.level,
      title: h.text,
      slug: h.slug,
      markdown: normalizeMarkdown(lines.slice(h.index, end).join("\n")),
    }
  })

  return {
    headings: headings.map(({ level, text, slug }) => ({ level, text, slug })),
    sections,
  }
}

function extractLinks(html: string, baseUrl: string): Link[] {
  const links: Link[] = []
  const seen = new Set<string>()
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = m[1]?.trim()
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) continue
    let resolved = href
    try {
      resolved = new URL(href, baseUrl).toString()
    } catch {}
    if (seen.has(resolved)) continue
    seen.add(resolved)
    links.push({ href: resolved, text: stripTags(m[2] ?? "") || resolved })
    if (links.length >= 24) break
  }
  return links
}

async function fetchPage(url: string, signal: AbortSignal): Promise<PageState> {
  const res = await fetch(url, {
    signal,
    redirect: "follow",
    headers: {
      "User-Agent": "nikcli-preview/1.0",
      Accept: "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.8",
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)

  const finalUrl = res.url || url
  const ct = res.headers.get("content-type")?.toLowerCase() ?? ""
  const raw = await res.text()

  // Plain markdown
  if (ct.includes("markdown")) {
    const md = normalizeMarkdown(raw)
    const s = parseStructure(md)
    return {
      loading: false,
      error: null,
      url: finalUrl,
      title: hostLabel(finalUrl),
      description: "",
      markdown: md,
      headings: s.headings,
      sections: s.sections,
      links: [],
    }
  }

  // Non-HTML text
  if (!ct.includes("html") && !raw.includes("<html") && !raw.includes("<body")) {
    const fenced = ct.includes("json") ? `\`\`\`json\n${raw.trim()}\n\`\`\`` : raw.trim()
    const md = normalizeMarkdown(fenced)
    const s = parseStructure(md)
    return {
      loading: false,
      error: null,
      url: finalUrl,
      title: hostLabel(finalUrl),
      description: ct,
      markdown: md,
      headings: s.headings,
      sections: s.sections,
      links: [],
    }
  }

  // HTML → markdown
  const cleaned = stripNoise(raw)
  const contentHtml = extractContentRoot(cleaned)
  const md = normalizeMarkdown(turndown.turndown(contentHtml || cleaned))
  const s = parseStructure(md)

  return {
    loading: false,
    error: null,
    url: finalUrl,
    title: extractTitle(raw) || hostLabel(finalUrl),
    description: extractDescription(raw),
    markdown: md || "_No readable content extracted from this page._",
    headings: s.headings,
    sections: s.sections,
    links: extractLinks(contentHtml || cleaned, finalUrl),
  }
}

export type DialogWebPreviewProps = { url?: string }

export function DialogWebPreview(props: DialogWebPreviewProps) {
  const dialog = useDialog()
  const scrollAcceleration = useScrollAcceleration()
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  // Opened with no URL, the preview lands on a page rather than an empty box —
  // the address bar still takes focus, so typing goes straight to the URL.
  const initialUrl = props.url ? normalizeUrl(props.url) : HOME_URL

  // Env detection over-reports; the renderer's negotiated answer decides.
  const capabilities = applyLiveCapabilities(
    detectCapabilities(),
    (renderer.capabilities ?? null) as LiveCapabilities | null,
  )
  /**
   * Live WebView needs Kitty Unicode placeholders (Ghostty, Kitty, herdr).
   * Cursor / VS Code advertise Sixel, but those overlays do not leave with the
   * dialog — Esc closed the chrome and left Google on the grid. That path is
   * off: Cursor stays in the markdown reader, like before overlay support.
   *
   * `NIKCLI_BROWSER_LIVE=1` forces the Kitty path when detection is wrong
   * (a multiplexer that swallowed the capability query, say).
   */
  const liveRenderer: SurfaceRenderer | undefined =
    process.env["NIKCLI_BROWSER_LIVE"] === "1" || supportsKittyUnicodePlaceholders(capabilities) ? "kitty" : undefined

  /** Why WebView is not on offer here, said once and plainly. */
  const noGraphicsNote = () =>
    `▀ ${capabilities.terminal ?? "this terminal"} cannot composite a live page, so pages are read as markdown. Run nikcli in Ghostty or Kitty for the live WebView.`

  // Reader first: fetching a page and rendering its markdown costs one request
  // and works in every terminal, where live mode starts a headless WebView and
  // approximates the picture in whatever the terminal can paint. WebView is a
  // click away (the toolbar button, or ^⇧R) for whoever needs the real page.
  const [mode, setMode] = createSignal<PreviewMode>("reader")
  const [surface, setSurface] = createSignal<BrowserSurfaceState | undefined>()
  let surfaceControls: BrowserSurfaceControls | undefined

  const [address, setAddress] = createSignal(initialUrl)
  const [focusArea, setFocusArea] = createSignal<FocusArea>(props.url ? "content" : "url")
  const [historyStack, setHistoryStack] = createSignal<string[]>([])
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [page, setPage] = createSignal<PageState>({
    loading: false,
    error: null,
    url: "",
    title: "",
    description: "",
    markdown: "",
    headings: [],
    sections: [],
    links: [],
  })
  const [selectedSection, setSelectedSection] = createSignal<string | null>(null)

  // A terminal that cannot paint an image has no live mode to be in, whatever
  // the mode signal says — so every "are we live" question answers no, and the
  // reader keeps the box.
  const live = createMemo(() => mode() === "live" && liveRenderer !== undefined)
  const contentHeight = createMemo(() => {
    const h = dimensions().height
    // A reader can be short — you scroll it. A browser cannot: the box's shape
    // *is* the window's shape, and a wide, short box means a wide, short
    // viewport that shows a sliver of any page no matter how it is scaled. So
    // live mode takes every row the dialog can spare.
    if (live()) return Math.max(16, h - 15)
    return Math.max(12, Math.min(h - 14, Math.floor(h * 0.6)))
  })
  const innerHeight = createMemo(() => Math.max(6, contentHeight() - 2))
  const tight = createMemo(() => dimensions().width < 84)
  const wide = createMemo(() => dimensions().width >= 118)
  // `xlarge` dialog width, minus this component's padding (4), the content
  // box's border (2) and its inner padding (2). Kept in step with the JSX
  // below — the surface must be told its placement in cells, exactly.
  /**
   * Everything between the dialog's outer width and the surface's own cells.
   * The surface is sized in absolute cells, so being wrong here doesn't reflow
   * anything — it silently paints the page past the border. Counted once,
   * here, rather than inferred at each level:
   *
   *   dialog panel padding  2 + 2
   *   this component's padding 2 + 2
   *   content box border    1 + 1
   *   content box padding   1 + 1
   */
  const SURFACE_CHROME = 12

  const liveColumns = createMemo(() => {
    const dialogWidth = live()
      ? Math.max(1, dimensions().width - 4)
      : Math.min(120, Math.max(1, dimensions().width - 8))
    return Math.max(20, dialogWidth - SURFACE_CHROME)
  })
  const canGoBack = createMemo(() => (live() ? true : historyIndex() > 0))
  const canGoForward = createMemo(() => (live() ? true : historyIndex() < historyStack().length - 1))
  const sectionData = createMemo(() => page().sections.find((s) => s.slug === selectedSection()) ?? null)
  const displayedMarkdown = createMemo(() => sectionData()?.markdown || page().markdown)

  let urlTextarea: TextareaRenderable | undefined
  let pageTextarea: TextareaRenderable | undefined
  let abortCtrl: AbortController | undefined
  let reqId = 0

  function focusUrlBar() {
    pageTextarea?.blur()
    setFocusArea("url")
    setTimeout(() => {
      if (urlTextarea && !urlTextarea.isDestroyed) {
        urlTextarea.focus()
        urlTextarea.gotoLineEnd()
      }
    }, 1)
  }

  function focusContent() {
    urlTextarea?.blur()
    pageTextarea?.blur()
    setFocusArea("content")
  }

  /** The bar under the live page: typing here is typing into the WebView. */
  function focusPageBar() {
    if (!live()) return
    urlTextarea?.blur()
    setFocusArea("page")
    setTimeout(() => {
      if (pageTextarea && !pageTextarea.isDestroyed) {
        pageTextarea.focus()
      }
    }, 1)
  }

  function sendToPage(input: { key?: string; text?: string }) {
    surfaceControls?.key(input)
  }

  function submitPageText() {
    const v = pageTextarea?.plainText ?? ""
    if (v.length > 0) sendToPage({ text: v })
    sendToPage({ key: "enter" })
    pageTextarea?.clear()
  }

  async function navigate(rawUrl: string) {
    const url = normalizeUrl(rawUrl)
    if (!url) return
    setAddress(url)
    setSelectedSection(null)

    // In live mode the page owns navigation and its own history; the reader's
    // fetch/parse path below would be a second, divergent browser. After Go
    // the page keyboard is the next thing you want, not the address bar.
    if (live()) {
      surfaceControls?.goto(url)
      focusPageBar()
      return
    }

    focusContent()

    const id = ++reqId
    abortCtrl?.abort()
    const abort = new AbortController()
    abortCtrl = abort

    setPage((p) => ({ ...p, loading: true, error: null, url }))

    try {
      const result = await fetchPage(url, abort.signal)
      if (id !== reqId) return
      setPage(result)
      if (result.url) setAddress(result.url)

      const base = historyStack().slice(0, historyIndex() + 1)
      setHistoryStack([...base, result.url])
      setHistoryIndex(base.length)
    } catch (err) {
      if (abort.signal.aborted || id !== reqId) return
      setPage((p) => ({
        ...p,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      if (abortCtrl === abort) abortCtrl = undefined
    }
  }

  function reload() {
    if (live()) {
      surfaceControls?.reload()
      return
    }
    const target = page().url || address()
    if (target) void navigate(target)
  }

  function goBack() {
    if (live()) {
      surfaceControls?.back()
      return
    }
    if (!canGoBack()) return
    const idx = historyIndex() - 1
    setHistoryIndex(idx)
    const url = historyStack()[idx]!
    void navigate(url)
  }

  function goForward() {
    if (live()) {
      surfaceControls?.forward()
      return
    }
    if (!canGoForward()) return
    const idx = historyIndex() + 1
    setHistoryIndex(idx)
    const url = historyStack()[idx]!
    void navigate(url)
  }

  /**
   * Switching modes tears the surface down (its `onCleanup` removes the
   * session), so live→reader always leaves a fetched copy of wherever the page
   * had got to, not of wherever we started.
   */
  function toggleMode() {
    // Nothing to switch to without a graphics protocol; the note under the
    // toolbar already says why, so this is a no-op rather than a dead mode.
    if (!liveRenderer) return
    const next: PreviewMode = live() ? "reader" : "live"
    const current = live() ? (surface()?.url ?? address()) : page().url || address()
    setMode(next)
    surfaceControls = undefined
    setSurface(undefined)
    if (current) {
      setAddress(current)
      if (next === "reader") setTimeout(() => void navigate(current), 1)
      else setTimeout(() => focusPageBar(), 1)
    }
  }

  createEffect(() => dialog.setSize(live() ? "full" : "xlarge"))

  onMount(() => {
    // Live mode navigates through the surface, which boots with this URL
    // already; only the reader needs an explicit first fetch.
    if (!live()) setTimeout(() => void navigate(initialUrl), 1)
    // Without a URL of its own the dialog is a browser someone just opened:
    // the home page is loading, and the cursor waits in the address bar.
    if (!props.url) setTimeout(() => focusUrlBar(), 1)
  })

  onCleanup(() => {
    abortCtrl?.abort()
  })

  useKeyboard((evt) => {
    // Chords the dialog keeps for itself in both modes. In live mode these are
    // the *only* ones: everything else is the page's, the way it is in a real
    // browser — which is why they are ctrl-prefixed rather than bare letters.
    if (evt.ctrl && evt.name === "l") {
      focusUrlBar()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.ctrl && evt.name === "k" && live()) {
      focusPageBar()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.ctrl && evt.shift && evt.name === "r") {
      toggleMode()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.ctrl && evt.shift && evt.name === "t" && live()) {
      surfaceControls?.toggleTransmission()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    // The address bar and the page keyboard own their own keys.
    if (focusArea() === "url" || focusArea() === "page") return

    if (live()) {
      // `esc` is deliberately not forwarded: it has to reach the dialog so the
      // dialog can still be closed.
      if (evt.name === "escape") return
      if (browserSurfaceKey(surfaceControls, (input) => surfaceControls?.key(input), evt)) {
        evt.preventDefault()
        evt.stopPropagation()
      }
      return
    }

    if (!evt.ctrl && !evt.meta && !evt.shift && evt.name === "r") {
      reload()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (!evt.ctrl && !evt.meta && evt.name === "/") {
      focusUrlBar()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if ((evt.meta || evt.option) && evt.name === "left") {
      goBack()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if ((evt.meta || evt.option) && evt.name === "right") {
      goForward()
      evt.preventDefault()
      evt.stopPropagation()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <DialogHeader title="⊕ Web Preview" />

      <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
        <text
          fg={canGoBack() ? theme.foreground.default : theme.foreground.muted}
          onMouseUp={() => goBack()}
          flexShrink={0}
        >
          ←
        </text>
        <text
          fg={canGoForward() ? theme.foreground.default : theme.foreground.muted}
          onMouseUp={() => goForward()}
          flexShrink={0}
        >
          →
        </text>
        <text
          fg={live() || page().url ? theme.foreground.default : theme.foreground.muted}
          onMouseUp={() => reload()}
          flexShrink={0}
        >
          ↺
        </text>

        <Show
          when={focusArea() === "url"}
          fallback={
            <text
              fg={address() ? theme.foreground.default : theme.foreground.muted}
              flexGrow={1}
              wrapMode="char"
              onMouseUp={() => focusUrlBar()}
            >
              {address() || "press / or click to enter a URL..."}
            </text>
          }
        >
          <textarea
            ref={(v: TextareaRenderable) => {
              urlTextarea = v
            }}
            initialValue={address()}
            height={1}
            flexGrow={1}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={() => {
              const v = urlTextarea?.plainText.trim() ?? ""
              urlTextarea?.blur()
              if (!v) {
                focusContent()
                return
              }
              void navigate(v)
            }}
            onKeyPress={(evt) => {
              if (evt.name === "escape") {
                urlTextarea?.blur()
                focusContent()
                evt.preventDefault()
                evt.stopPropagation()
              }
            }}
            placeholder="https://example.com"
            textColor={theme.foreground.default}
            focusedTextColor={theme.foreground.default}
            cursorColor={theme.accent.fg}
          />
        </Show>

        <box
          backgroundColor={theme.accent.fg}
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
          onMouseUp={() => {
            const v = focusArea() === "url" ? (urlTextarea?.plainText.trim() ?? address()) : address()
            if (v) void navigate(v)
          }}
        >
          <text fg={theme.surface.base}>Go</text>
        </box>

        {/* Names where it takes you, not where you are — the mode you are in is
            already spelled out in the status line under this row. Greyed out,
            it means this terminal cannot paint a page at all. */}
        <box
          backgroundColor={liveRenderer ? (live() ? theme.surface.offset : theme.accent.secondary) : undefined}
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
          onMouseUp={(event) => {
            event.stopPropagation()
            toggleMode()
          }}
        >
          <text fg={!liveRenderer ? theme.foreground.muted : live() ? theme.foreground.default : theme.surface.base}>
            {live() ? "Markdown" : "WebView"}
          </text>
        </box>
      </box>

      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="char">
          {live() ? surface()?.title || surface()?.url || "" : page().title || (page().loading ? "Loading..." : "")}
        </text>
        <Show
          when={live()}
          fallback={
            <text fg={page().loading ? theme.accent.fg : page().error ? theme.status.error.fg : theme.foreground.muted}>
              {page().loading ? "loading" : page().error ? "error" : page().markdown ? "reader" : ""}
            </text>
          }
        >
          <text
            fg={
              surface()?.status === "error"
                ? theme.status.error.fg
                : surface()?.status === "live"
                  ? theme.accent.fg
                  : theme.foreground.muted
            }
          >
            {surface()?.status === "live"
              ? `live · ${liveRenderer === "kitty" ? "kitty" : "sixel"}${surface()?.measured ? "" : " · cell size assumed"}`
              : (surface()?.status ?? "starting")}
          </text>
        </Show>
      </box>

      <Show when={live() ? surface()?.error : page().error}>
        <box flexShrink={0}>
          <text fg={theme.status.error.fg}>✗ {live() ? surface()?.error : page().error}</text>
        </box>
      </Show>

      <Show when={!liveRenderer}>
        <box flexShrink={0}>
          <text fg={theme.foreground.muted} wrapMode="word">
            ⓘ {noGraphicsNote()}
          </text>
        </box>
      </Show>

      <box
        border
        borderColor={focusArea() === "content" ? theme.accent.fg : theme.border.default}
        focusedBorderColor={theme.border.focus}
        height={contentHeight()}
        flexShrink={0}
        onMouseUp={() => focusContent()}
      >
        <Show when={live()}>
          <box paddingLeft={1} paddingRight={1} height={innerHeight()}>
            <Show
              when={address()}
              fallback={
                <box paddingLeft={1} paddingTop={1}>
                  <text fg={theme.foreground.muted} wrapMode="word">
                    Enter a URL above and press Go — live mode starts a WebView for that page.
                    {"\n"}
                    ^⇧R switches to reader mode (fetch + markdown, no browser).
                  </text>
                </box>
              }
            >
              <BrowserSurface
                // Keyed by address so a fresh surface boots for each navigation
                // that tears down the previous session (mode toggles already do).
                initialUrl={address()}
                columns={liveColumns()}
                rows={innerHeight()}
                focused={focusArea() === "content"}
                // `live()` is false without a renderer, so this branch only ever
                // mounts with one.
                renderer={liveRenderer!}
                onState={setSurface}
                ref={(controls) => {
                  surfaceControls = controls
                }}
              />
            </Show>
          </box>
        </Show>

        <Show when={!live()}>
          <box
            flexDirection={wide() ? "row" : "column"}
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            height={innerHeight()}
          >
            <scrollbox
              scrollAcceleration={scrollAcceleration()}
              height={innerHeight()}
              focused={focusArea() === "content"}
              flexGrow={1}
              flexShrink={1}
            >
              <box gap={1} paddingTop={1} paddingBottom={1}>
                <Show when={page().description}>
                  <text fg={theme.foreground.muted} wrapMode="word">
                    {page().description}
                  </text>
                </Show>
                <Show when={sectionData()}>
                  <box
                    backgroundColor={theme.surface.offset}
                    paddingLeft={1}
                    paddingRight={1}
                    paddingTop={1}
                    paddingBottom={1}
                  >
                    <text fg={theme.accent.secondary} attributes={TextAttributes.BOLD}>
                      {sectionData()!.title}
                    </text>
                    <text fg={theme.accent.fg} onMouseUp={() => setSelectedSection(null)}>
                      show full page
                    </text>
                  </box>
                </Show>
                <Show when={!wide() && (page().headings.length > 0 || page().links.length > 0)}>
                  <Sidebar
                    headings={page().headings}
                    links={page().links}
                    selectedSection={selectedSection()}
                    onSelectSection={setSelectedSection}
                    onNavigate={(u) => void navigate(u)}
                  />
                </Show>
                <Show
                  when={displayedMarkdown()}
                  fallback={
                    <text fg={page().loading ? theme.accent.secondary : theme.foreground.muted} wrapMode="word">
                      {page().loading ? "Fetching and formatting page..." : "Enter a URL above to preview a website."}
                    </text>
                  }
                >
                  <markdown
                    content={displayedMarkdown()}
                    syntaxStyle={syntax()}
                    fg={theme.foreground.default}
                    conceal={true}
                    tableOptions={{
                      widthMode: "full",
                      wrapMode: "word",
                      cellPadding: tight() ? 0 : 1,
                      borders: !tight(),
                      outerBorder: false,
                      borderColor: theme.border.subtle,
                    }}
                  />
                </Show>
              </box>
            </scrollbox>
            <Show when={wide() && (page().headings.length > 0 || page().links.length > 0)}>
              <box width={30} flexShrink={0} height={innerHeight()}>
                <scrollbox
                  scrollAcceleration={scrollAcceleration()}
                  height={innerHeight()}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <Sidebar
                    headings={page().headings}
                    links={page().links}
                    selectedSection={selectedSection()}
                    onSelectSection={setSelectedSection}
                    onNavigate={(u) => void navigate(u)}
                  />
                </scrollbox>
              </box>
            </Show>
          </box>
        </Show>
      </box>

      <Show when={live()}>
        <box
          flexDirection="row"
          gap={1}
          alignItems="center"
          flexShrink={0}
          border
          borderColor={focusArea() === "page" ? theme.accent.fg : theme.border.default}
          paddingLeft={1}
          paddingRight={1}
          onMouseUp={() => focusPageBar()}
        >
          <text fg={theme.foreground.muted} flexShrink={0}>
            ⌨
          </text>
          <textarea
            ref={(v: TextareaRenderable) => {
              pageTextarea = v
            }}
            height={1}
            flexGrow={1}
            keyBindings={[{ name: "return", action: "submit" }]}
            onSubmit={() => submitPageText()}
            onKeyPress={(evt) => {
              if (evt.name === "escape") {
                pageTextarea?.blur()
                focusContent()
                evt.preventDefault()
                evt.stopPropagation()
                return
              }
              if (evt.name === "tab" && !evt.ctrl && !evt.meta) {
                sendToPage({ key: evt.shift ? "shift+tab" : "tab" })
                evt.preventDefault()
                evt.stopPropagation()
              }
            }}
            placeholder="type into the page…"
            textColor={theme.foreground.default}
            focusedTextColor={theme.foreground.default}
            cursorColor={theme.accent.fg}
          />
          <box
            backgroundColor={theme.accent.fg}
            paddingLeft={1}
            paddingRight={1}
            flexShrink={0}
            onMouseUp={() => submitPageText()}
          >
            <text fg={theme.surface.base}>↵</text>
          </box>
        </box>
      </Show>

      <box
        flexDirection={tight() ? "column" : "row"}
        justifyContent="space-between"
        flexShrink={0}
        gap={tight() ? 1 : 0}
      >
        <text fg={theme.foreground.muted} wrapMode="char">
          {(live() ? surface()?.url : "") || address() || ""}
        </text>
        <Show
          when={live()}
          fallback={
            <box flexDirection="row" gap={2}>
              <text fg={theme.foreground.muted}>⌥← back</text>
              <text fg={theme.foreground.muted}>⌥→ fwd</text>
              <text fg={theme.foreground.muted}>r reload</text>
              <text fg={theme.foreground.muted}>/ url</text>
              <Show when={liveRenderer}>
                <text fg={theme.foreground.muted}>^⇧R live</text>
              </Show>
            </box>
          }
        >
          <box flexDirection="row" gap={2}>
            <text fg={theme.foreground.muted}>^L url</text>
            <text fg={theme.foreground.muted}>^K page</text>
            <text fg={theme.foreground.muted}>⌥← back</text>
            <text fg={theme.foreground.muted}>⌥→ fwd</text>
            <Show when={liveRenderer === "kitty"}>
              <text fg={theme.foreground.muted}>^⇧T transport</text>
            </Show>
            <text fg={theme.foreground.muted}>^⇧R reader</text>
          </box>
        </Show>
      </box>
    </box>
  )
}

function Sidebar(props: {
  headings: Heading[]
  links: Link[]
  selectedSection: string | null
  onSelectSection: (slug: string | null) => void
  onNavigate: (url: string) => void
}) {
  const { theme } = useTheme()
  return (
    <box gap={1} paddingTop={1} paddingBottom={1}>
      <Show when={props.headings.length > 0}>
        <box
          gap={0}
          backgroundColor={theme.surface.offset}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={theme.accent.secondary} attributes={TextAttributes.BOLD}>
            On This Page
          </text>
          <For each={props.headings.slice(0, 16)}>
            {(h) => {
              const indent = Math.max(0, h.level - 1)
              const maxLen = 26 - indent
              const label = h.text.length > maxLen ? h.text.slice(0, maxLen - 2) + ".." : h.text
              return (
                <box paddingLeft={indent} onMouseUp={() => props.onSelectSection(h.slug)}>
                  <text fg={props.selectedSection === h.slug ? theme.accent.fg : theme.foreground.default}>
                    {label}
                  </text>
                </box>
              )
            }}
          </For>
          <Show when={props.selectedSection}>
            <text fg={theme.accent.fg} onMouseUp={() => props.onSelectSection(null)}>
              show full page
            </text>
          </Show>
        </box>
      </Show>
      <Show when={props.links.length > 0}>
        <box
          gap={0}
          backgroundColor={theme.surface.offset}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={theme.accent.secondary} attributes={TextAttributes.BOLD}>
            Links
          </text>
          <For each={props.links.slice(0, 10)}>
            {(link) => {
              const label = link.text.length > 26 ? link.text.slice(0, 24) + ".." : link.text
              return (
                <text fg={theme.accent.fg} wrapMode="char" onMouseUp={() => props.onNavigate(link.href)}>
                  {label}
                </text>
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}
