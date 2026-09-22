import type { MessageWithParts, SessionArtifact, ToolState } from "@/lib/types"

export type PublishedArtifactKind = "html" | "markdown" | "image" | "video" | "text"
export type SessionPreviewKind = "url" | "html" | "svg" | "mermaid" | "markdown" | "image" | "video" | "text"

export type SessionPreview = {
  id: string
  kind: SessionPreviewKind
  title: string
  messageId: string
  /** Canonical nikcli-ai.dev link, safe to copy and share. */
  url?: string
  /** Capability URL used only to render the preview inside the connected session. */
  previewUrl?: string
  /** Capability URL for opening the full artifact viewer without another login. */
  viewerUrl?: string
  source?: "local" | "web"
  content?: string
  artifact?: {
    id: string
    kind: PublishedArtifactKind
    version: number
    filename?: string
    contentType?: string
    size?: number
    description?: string
  }
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi
const FENCE_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/g

/** Hosts that appear in chat but are never the user's running app preview. */
const PREVIEW_HOST_BLOCK_SUFFIXES = [
  "github.com",
  "gist.github.com",
  "gitlab.com",
  "bitbucket.org",
  "npmjs.com",
  "yarnpkg.com",
  "jsdelivr.net",
  "unpkg.com",
  "raw.githubusercontent.com",
  "developer.mozilla.org",
  "mdn.io",
  "mozilla.org",
  "stackoverflow.com",
  "reddit.com",
  "medium.com",
  "wikipedia.org",
  "google.com",
  "youtube.com",
  "twitter.com",
  "x.com",
  "react.dev",
  "nextjs.org",
  "expo.dev",
]

const PREVIEW_TUNNEL_SUFFIXES = [
  ".exp.direct",
  ".ngrok.io",
  ".ngrok-free.app",
  ".loca.lt",
  ".localtunnel.me",
  ".trycloudflare.com",
]

function trimPreviewRawUrl(raw: string) {
  return raw.replace(/[.,;:]+$/, "")
}

function isBlockedPreviewDocumentationHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return PREVIEW_HOST_BLOCK_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))
}

function isLoopbackPreviewHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1"
}

function isPrivateOrLanPreviewHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h.endsWith(".local")) return true
  if (h.startsWith("10.")) return true
  if (h.startsWith("192.168.")) return true
  const m = /^172\.(\d+)\./.exec(h)
  if (m) {
    const n = Number(m[1])
    if (n >= 16 && n <= 31) return true
  }
  return false
}

function serverPreviewHostname(serverUrl: string | undefined): string | null {
  if (!serverUrl) return null
  try {
    return new URL(serverUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

function isLikelyDevPreviewTunnel(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return PREVIEW_TUNNEL_SUFFIXES.some((suffix) => h.endsWith(suffix))
}

function isSessionWorkspacePreviewUrl(raw: string, normalized: string, serverUrl?: string): boolean {
  let rawParsed: URL
  let normParsed: URL
  try {
    rawParsed = new URL(trimPreviewRawUrl(raw))
    normParsed = new URL(normalized)
  } catch {
    return false
  }

  const rawHost = rawParsed.hostname.toLowerCase()
  const normHost = normParsed.hostname.toLowerCase()

  if (
    (rawHost === "nikcli-ai.dev" || rawHost.endsWith(".nikcli-ai.dev")) &&
    /^\/artifact\/[^/]+/.test(rawParsed.pathname)
  ) {
    return true
  }

  if (isBlockedPreviewDocumentationHost(rawHost) || isBlockedPreviewDocumentationHost(normHost)) return false
  if (isLoopbackPreviewHost(rawHost)) return true

  const serverHost = serverPreviewHostname(serverUrl)
  if (serverHost && normHost === serverHost) return true
  if (isPrivateOrLanPreviewHost(normHost)) return true
  if (isLikelyDevPreviewTunnel(normHost)) return true

  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asToolState(value: unknown): ToolState | null {
  if (!isRecord(value) || typeof value.status !== "string") return null
  return value as ToolState
}

function toolPreviewText(part: MessageWithParts["parts"][number]) {
  if (part.type !== "tool") return ""
  const state = asToolState(part.state)
  if (state?.status !== "completed") return ""
  return `${state.title ?? ""}\n${state.output}`
}

function normalizePreviewUrl(raw: string, serverUrl?: string) {
  try {
    const url = new URL(trimPreviewRawUrl(raw))
    if (["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname) && serverUrl) {
      const host = new URL(serverUrl)
      url.hostname = host.hostname
      url.protocol = host.protocol
    }
    return url.toString()
  } catch {
    return null
  }
}

function previewSource(url: string): SessionPreview["source"] {
  try {
    const parsed = new URL(url)
    return parsed.port || ["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname) ? "local" : "web"
  } catch {
    return "web"
  }
}

function parseFenceKind(info: string): SessionPreviewKind | null {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  if (lang === "html" || lang === "htm") return "html"
  if (lang === "svg") return "svg"
  if (lang === "mermaid") return "mermaid"
  if (lang.startsWith("artifact:")) {
    const sub = lang.slice("artifact:".length)
    if (sub === "html" || sub === "htm") return "html"
    if (sub === "svg") return "svg"
    if (sub === "mermaid") return "mermaid"
  }
  return null
}

function contentFingerprint(kind: SessionPreviewKind, content: string) {
  return `${kind}:${content.trim().slice(0, 400)}:${content.length}`
}

function titleForPreview(preview: Pick<SessionPreview, "kind" | "url" | "content">) {
  if (preview.kind === "url" && preview.url) return labelForUrl(preview.url)
  const lines = preview.content?.trim().split("\n").filter(Boolean) ?? []
  const first = lines[0]?.replace(/^#+\s*/, "").trim()
  if (first && first.length <= 48) return first
  const label =
    preview.kind === "html"
      ? "HTML"
      : preview.kind === "svg"
        ? "SVG"
        : preview.kind === "mermaid"
          ? "Diagram"
          : preview.kind === "markdown"
            ? "Markdown"
            : preview.kind === "image"
              ? "Image"
              : preview.kind === "video"
                ? "Video"
                : "Text"
  return `${label} artifact`
}

export function labelForUrl(value: string) {
  try {
    const url = new URL(value)
    const host = url.host.replace(/^www\./, "")
    return url.pathname && url.pathname !== "/" ? `${host}${url.pathname}` : host
  } catch {
    return value
  }
}

export function kindLabel(kind: SessionPreviewKind) {
  if (kind === "url") return "Live"
  if (kind === "html") return "HTML"
  if (kind === "svg") return "SVG"
  if (kind === "mermaid") return "Diagram"
  if (kind === "markdown") return "Markdown"
  if (kind === "image") return "Image"
  if (kind === "video") return "Video"
  return "Text"
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function previewSourceText(preview: SessionPreview): string {
  if (preview.url) return preview.url
  return preview.content ?? ""
}

export function previewDocumentHtml(preview: SessionPreview, isDark: boolean): string | null {
  if (preview.url || preview.previewUrl || preview.viewerUrl) return null

  const content = preview.content?.trim() ?? ""
  if (!content) return null

  if (preview.kind === "svg") {
    if (content.includes("<svg")) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:${isDark ? "#0a0a0a" : "#f8fafc"}">${content}</body></html>`
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:${isDark ? "#0a0a0a" : "#f8fafc"}"><img alt="SVG artifact" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}" style="max-width:100%;height:auto"/></body></html>`
  }

  if (preview.kind === "mermaid") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script><style>body{margin:0;padding:16px;background:${isDark ? "#0a0a0a" : "#f8fafc"};color:${isDark ? "#f5f5f4" : "#141413"};font-family:-apple-system,BlinkMacSystemFont,sans-serif}</style></head><body><pre class="mermaid">${escapeHtml(content)}</pre><script>mermaid.initialize({startOnLoad:true,theme:"${isDark ? "dark" : "default"}"});</script></body></html>`
  }

  if (/<html[\s>]/i.test(content)) return content
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{margin:0;padding:16px;background:${isDark ? "#0a0a0a" : "#ffffff"};color:${isDark ? "#f5f5f4" : "#141413"};font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.5}</style></head><body>${content}</body></html>`
}

export function previewAllowsNetwork(preview: SessionPreview) {
  return Boolean(preview.url || preview.previewUrl || preview.viewerUrl) || preview.kind === "mermaid"
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function publishedKind(value: unknown): PublishedArtifactKind | null {
  if (value === "html" || value === "markdown" || value === "image" || value === "video" || value === "text") {
    return value
  }
  return null
}

function extractPublishedArtifact(part: MessageWithParts["parts"][number], messageId: string): SessionPreview | null {
  if (part.type !== "tool" || part.tool !== "artifact") return null
  const state = asToolState(part.state)
  if (state?.status !== "completed") return null

  const metadata = state.metadata
  if (!isRecord(metadata)) return null

  const artifactId = stringValue(metadata.id)
  const url = stringValue(metadata.url)
  const kind = publishedKind(metadata.kind)
  if (!artifactId || !url || !kind) return null

  const rawUrl = stringValue(metadata.previewUrl)
  const viewerUrl = stringValue(metadata.viewerUrl)
  const previewUrl = kind === "markdown" || kind === "text" ? (viewerUrl ?? rawUrl) : (rawUrl ?? viewerUrl)

  return {
    id: `artifact:${artifactId}`,
    kind,
    title: stringValue(metadata.title) ?? state.title ?? labelForUrl(viewerUrl ?? url),
    messageId,
    url: viewerUrl ?? url,
    previewUrl,
    viewerUrl,
    source: "web",
    artifact: {
      id: artifactId,
      kind,
      version: numberValue(metadata.version) ?? 1,
      filename: stringValue(metadata.filename),
      contentType: stringValue(metadata.contentType),
      size: numberValue(metadata.size),
      description: stringValue(metadata.description),
    },
  }
}

function previewFromSessionArtifact(artifact: SessionArtifact): SessionPreview {
  const previewUrl = artifact.kind === "markdown" || artifact.kind === "text" ? artifact.viewerUrl : artifact.previewUrl
  return {
    id: `artifact:${artifact.id}`,
    kind: artifact.kind,
    title: artifact.title,
    messageId: `artifact:${artifact.id}`,
    url: artifact.viewerUrl || artifact.url,
    previewUrl,
    viewerUrl: artifact.viewerUrl,
    source: "web",
    artifact: {
      id: artifact.id,
      kind: artifact.kind,
      version: artifact.version,
      filename: artifact.filename,
      contentType: artifact.contentType,
      size: artifact.size,
      description: artifact.description,
    },
  }
}

function extractFromText(
  text: string,
  messageId: string,
  serverUrl: string | undefined,
  seenUrls: Set<string>,
  seenContent: Set<string>,
  out: SessionPreview[],
) {
  for (const match of text.matchAll(FENCE_PATTERN)) {
    const kind = parseFenceKind(match[1] ?? "")
    const content = match[2]?.trim() ?? ""
    if (!kind || !content) continue

    const fingerprint = contentFingerprint(kind, content)
    if (seenContent.has(fingerprint)) continue
    seenContent.add(fingerprint)

    const draft = { kind, content } as const
    out.push({
      id: `${messageId}:artifact:${out.length}`,
      kind,
      title: titleForPreview(draft),
      messageId,
      content,
    })
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = normalizePreviewUrl(match[0], serverUrl)
    if (!url || seenUrls.has(url)) continue
    if (!isSessionWorkspacePreviewUrl(match[0], url, serverUrl)) continue
    seenUrls.add(url)

    const draft = { kind: "url" as const, url }
    out.push({
      id: `${messageId}:url:${out.length}`,
      kind: "url",
      title: titleForPreview(draft),
      messageId,
      url,
      source: previewSource(url),
    })
  }
}

function messageTexts(message: MessageWithParts) {
  return message.parts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : toolPreviewText(part)))
    .filter(Boolean)
}

function rememberPreviewUrls(preview: SessionPreview, seen: Set<string>) {
  for (const value of [preview.url, preview.viewerUrl, preview.previewUrl]) {
    if (!value) continue
    seen.add(value)
    try {
      const next = new URL(value)
      next.search = ""
      seen.add(next.toString())
    } catch {
      // ignore invalid URLs
    }
  }
}

/** Newest messages first; dedupes URLs and generated blocks. */
export function extractSessionPreviews(
  messages: MessageWithParts[],
  serverUrl?: string,
  persistedArtifacts: SessionArtifact[] = [],
): SessionPreview[] {
  const seenUrls = new Set<string>()
  const seenContent = new Set<string>()
  const seenArtifacts = new Set<string>()
  const previews: SessionPreview[] = []

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    for (const part of message.parts) {
      const artifact = extractPublishedArtifact(part, message.info.id)
      if (!artifact || !artifact.artifact || seenArtifacts.has(artifact.artifact.id)) continue
      seenArtifacts.add(artifact.artifact.id)
      rememberPreviewUrls(artifact, seenUrls)
      previews.push(artifact)
    }
    for (const text of messageTexts(message)) {
      extractFromText(text, message.info.id, serverUrl, seenUrls, seenContent, previews)
    }
  }

  for (const artifact of persistedArtifacts) {
    if (seenArtifacts.has(artifact.id)) continue
    seenArtifacts.add(artifact.id)
    const preview = previewFromSessionArtifact(artifact)
    rememberPreviewUrls(preview, seenUrls)
    previews.push(preview)
  }

  return previews
}

/** Generated artifacts (html/svg/mermaid) embedded in a single assistant message. */
export function extractMessageArtifacts(message: MessageWithParts): SessionPreview[] {
  if (message.info.role !== "assistant") return []

  const seenContent = new Set<string>()
  const artifacts: SessionPreview[] = []

  for (const part of message.parts) {
    const artifact = extractPublishedArtifact(part, message.info.id)
    if (artifact) artifacts.push(artifact)
  }

  for (const text of messageTexts(message)) {
    for (const match of text.matchAll(FENCE_PATTERN)) {
      const kind = parseFenceKind(match[1] ?? "")
      const content = match[2]?.trim() ?? ""
      if (!kind || !content) continue

      const fingerprint = contentFingerprint(kind, content)
      if (seenContent.has(fingerprint)) continue
      seenContent.add(fingerprint)

      const draft = { kind, content } as const
      artifacts.push({
        id: `${message.info.id}:artifact:${artifacts.length}`,
        kind,
        title: titleForPreview(draft),
        messageId: message.info.id,
        content,
      })
    }
  }

  return artifacts
}

/** First generated artifact in a message, if any. */
export function extractInlineArtifact(message: MessageWithParts): SessionPreview | null {
  return extractMessageArtifacts(message)[0] ?? null
}

export function isGeneratedPreview(preview: SessionPreview) {
  return preview.kind !== "url" && !preview.artifact
}
