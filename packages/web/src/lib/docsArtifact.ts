import { artifactKind, artifactShareUrl, writeArtifact } from "./artifact"

/**
 * Artifact authoring for the docs assistant.
 *
 * The assistant can emit a fenced block tagged `artifact` with attributes on
 * the info string; the content is published as a real, standalone HTML file on
 * nikcli-ai.dev/artifact/:id, reachable through its `?key=` capability link:
 *
 * ```artifact title="Nikcli permission modes" filename="permission-modes.html"
 * <h1>Permission modes</h1>
 * …
 * ```
 *
 * Artifacts are rendered in a sandboxed iframe by the artifact page, so the
 * document may carry its own styles and scripts, but it must be self-contained.
 */

export type PublishedArtifact = {
  id: string
  url: string
  title: string
  filename: string
}

export type ArtifactRequest = {
  title: string
  filename: string
  content: string
}

/** Max artifact the assistant may publish on its own. */
const MAX_ARTIFACT_BYTES = 256 * 1024

const ARTIFACT_BLOCK = /```artifact([^\n]*)\n([\s\S]*?)```(?:\s*\n|\s*$)/
/** Same block, left open because the model ran out of output tokens. */
const OPEN_ARTIFACT_BLOCK = /```artifact([^\n]*)\n([\s\S]*)$/
export const ARTIFACT_MARKER = "```artifact"

function attribute(info: string, name: string) {
  const match = info.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"))
  return match?.[1].trim() ?? ""
}

function safeFilename(value: string) {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)
  const base = cleaned || "artifact"
  return /\.html?$/i.test(base) ? base : `${base.replace(/\.[^.]*$/, "")}.html`
}

/**
 * Pulls the first artifact block out of an answer. Returns the answer with the
 * block removed, so the chat transcript stays readable.
 */
export function extractArtifact(answer: string): {
  text: string
  artifact: ArtifactRequest | null
} {
  const match = answer.match(ARTIFACT_BLOCK) ?? answer.match(OPEN_ARTIFACT_BLOCK)
  if (!match) return { text: answer, artifact: null }

  const [block, info, content] = match
  const body = content.replace(/\n+$/, "")
  if (!body.trim()) return { text: answer.replace(block, ""), artifact: null }

  return {
    text: answer
      .replace(block, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    artifact: {
      title: attribute(info, "title") || "Nikcli artifact",
      filename: safeFilename(attribute(info, "filename")),
      content: body,
    },
  }
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const looksLikeHtml = (content: string) =>
  /<(!doctype|html|body|main|header|footer|nav|aside|section|article|div|span|h[1-6]|p|ul|ol|table|pre|form|button|input|label|canvas|figure|style|script)\b/i.test(
    content,
  )

const isFullDocument = (content: string) => /<!doctype html|<html[\s>]/i.test(content)

/** Minimal Markdown → HTML, for when the model answers with Markdown anyway. */
function markdownToHtml(source: string) {
  return source
    .split(/```/)
    .map((block, index) => {
      if (index % 2 === 1) {
        const body = block.replace(/^[a-zA-Z0-9+#-]*\n/, "").replace(/\n$/, "")
        return `<pre><code>${escapeHtml(body)}</code></pre>`
      }

      const html: string[] = []
      let list: { type: "ul" | "ol"; items: string[] } | null = null

      const inline = (value: string) =>
        escapeHtml(value)
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\[([^\]]+)\]\((\/[^)\s]*|https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')

      const flush = () => {
        if (!list) return
        html.push(`<${list.type}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.type}>`)
        list = null
      }

      for (const rawLine of block.split("\n")) {
        const line = rawLine.trimEnd()
        if (!line.trim()) {
          flush()
          continue
        }

        const heading = line.match(/^(#{1,6})\s+(.*)$/)
        if (heading) {
          flush()
          const level = Math.min(heading[1].length + 1, 6)
          html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
          continue
        }

        const bullet = line.match(/^\s*[-*]\s+(.*)$/)
        if (bullet) {
          if (list?.type !== "ul") flush()
          list ??= { type: "ul", items: [] }
          list.items.push(inline(bullet[1]))
          continue
        }

        const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
        if (ordered) {
          if (list?.type !== "ol") flush()
          list ??= { type: "ol", items: [] }
          list.items.push(inline(ordered[1]))
          continue
        }

        flush()
        html.push(`<p>${inline(line)}</p>`)
      }

      flush()
      return html.join("\n")
    })
    .join("\n")
}

/**
 * Wraps a fragment in a self-contained, responsive, theme-aware document so
 * every artifact is a real HTML file that stands on its own.
 */
function htmlDocument(title: string, body: string, source: string) {
  // When the artifact ships its own CSS, stay out of its way: only a reset,
  // so the page looks exactly like the HTML that was written — same as an
  // artifact published from the CLI.
  const styled = /<style[\s>]/i.test(body)
  if (styled) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="nikcli docs assistant" />
<base target="_blank" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  img, svg, video, canvas { max-width: 100%; height: auto; }
  pre { overflow-x: auto; }
</style>
</head>
<body>
${body}
</body>
</html>
`
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="nikcli docs assistant" />
<base target="_blank" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --panel: #f6f7f9; --text: #14161a; --muted: #5c6470;
    --border: #e2e5ea; --accent: #2f6df6; --code: #f2f4f7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d0f12; --panel: #14171c; --text: #e8eaee; --muted: #98a1af;
      --border: #232830; --accent: #7aa2ff; --code: #14171c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem 4rem; background: var(--bg); color: var(--text);
    font: 16px/1.7 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1, h2, h3, h4 { line-height: 1.2; letter-spacing: -0.02em; margin: 2rem 0 0.75rem; }
  h1 { font-size: clamp(1.75rem, 4vw, 2.4rem); margin-top: 0; }
  h2 { font-size: 1.35rem; } h3 { font-size: 1.1rem; }
  p, li { color: var(--text); }
  a { color: var(--accent); text-underline-offset: 3px; }
  ul, ol { padding-left: 1.25rem; }
  li { margin: 0.35rem 0; }
  code {
    font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", monospace;
    font-size: 0.875em; background: var(--code); border: 1px solid var(--border);
    border-radius: 5px; padding: 0.1rem 0.35rem;
  }
  pre {
    background: var(--code); border: 1px solid var(--border); border-radius: 10px;
    padding: 0.9rem 1rem; overflow-x: auto;
  }
  pre code { background: none; border: 0; padding: 0; font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--border); padding: 0.5rem 0.7rem; text-align: left; }
  th { background: var(--panel); }
  blockquote { margin: 1rem 0; padding: 0.6rem 1rem; border-left: 3px solid var(--border); color: var(--muted); }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.8rem; }
</style>
</head>
<body>
<main>
${body}
<footer>Generated by the <a href="${escapeHtml(source)}/docs">nikcli</a> docs assistant from the official documentation. Verify commands before running them.</footer>
</main>
</body>
</html>
`
}

/**
 * Injected into every published artifact: whatever the model wrote, wide
 * content scrolls inside its own box instead of scrolling the page sideways
 * on a phone.
 */
const RESPONSIVE_GUARD = `<style>
  html, body { max-width: 100%; overflow-x: hidden; }
  table { display: block; width: 100%; max-width: 100%; overflow-x: auto; }
  pre, .scroll { max-width: 100%; overflow-x: auto; }
  img, svg, video, canvas, iframe { max-width: 100%; height: auto; }
  * { min-width: 0; overflow-wrap: anywhere; }
</style>`

function withResponsiveGuard(html: string) {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${RESPONSIVE_GUARD}\n</head>`)
  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, `$1\n${RESPONSIVE_GUARD}`)
  return `${RESPONSIVE_GUARD}\n${html}`
}

/** Normalizes assistant output into a complete HTML document. */
export function toHtmlFile(request: ArtifactRequest, origin: string) {
  if (isFullDocument(request.content)) return withResponsiveGuard(request.content)
  const body = looksLikeHtml(request.content) ? request.content : markdownToHtml(request.content)
  return withResponsiveGuard(htmlDocument(request.title, body, origin))
}

/**
 * Publishes an artifact anonymously (owned by nobody, reachable through the
 * capability link) and returns its shareable URL.
 */
export async function publishArtifact(
  bucket: R2Bucket,
  request: ArtifactRequest,
  options: { origin: string; publicOrigin?: string; sessionID?: string },
): Promise<PublishedArtifact | null> {
  const content = new TextEncoder().encode(toHtmlFile(request, options.publicOrigin || options.origin))
  if (content.byteLength === 0 || content.byteLength > MAX_ARTIFACT_BYTES) return null

  const contentType = "text/html; charset=utf-8"
  const kind = artifactKind(contentType)
  if (!kind) return null

  const id = crypto.randomUUID()
  const viewKey = crypto.randomUUID().replace(/-/g, "")
  const now = Date.now()

  await writeArtifact(
    bucket,
    {
      id,
      secret: crypto.randomUUID(),
      viewKey,
      title: request.title,
      description: "Created by the nikcli docs assistant",
      filename: request.filename,
      contentType,
      kind,
      size: content.byteLength,
      version: 1,
      sessionID: options.sessionID,
      owner: "",
      author: "nikcli docs assistant",
      time: { created: now, updated: now },
    },
    content.buffer as ArrayBuffer,
  )

  // Artifacts are always shared under their canonical nikcli-ai.dev home, even
  // when created from a preview deployment or a local dev server.
  return {
    id,
    url: artifactShareUrl(id, viewKey, options.publicOrigin || options.origin),
    title: request.title,
    filename: request.filename,
  }
}
