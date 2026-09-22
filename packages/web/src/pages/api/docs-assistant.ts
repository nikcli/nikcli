import type { APIRoute } from "astro"
import { docsIndex } from "../../data/docsIndex"
import { ARTIFACT_MARKER, type ArtifactRequest, extractArtifact, publishArtifact } from "../../lib/docsArtifact"
import { type DocFetcher, docsFetcher, fetchDocMarkdown, normalizeDocsPath } from "../../lib/docsMarkdown"
import { type ToolCall, planDocs } from "../../lib/docsPlanner"
import { condenseMarkdown, selectDocs, tokenize } from "../../lib/docsRetrieval"
import { nikcliBackendConfig, runNikcliTurn } from "../../lib/nikcliDocsSession"

export const prerender = false

/**
 * Docs support assistant.
 *
 * Free for every visitor, no login: retrieval is lexical (no Vectorize),
 * grounding reuses the Markdown pipeline behind `/.llm`, and generation runs on
 * a Cloudflare Workers AI model covered by the free daily Neuron allocation.
 *
 * When the deployment configures a nikcli server (NIKCLI_DOCS_SERVER +
 * NIKCLI_DOCS_TOKEN) the same request is answered by a real nikcli session
 * instead, and follow-ups reuse it. Either way the assistant can publish an
 * artifact from its answer.
 */

/** Small + fast, and cheap against the Workers AI free allocation. */
const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast"
/**
 * Used only when the question asks for something buildable: writing a styled,
 * interactive HTML artifact needs a stronger model than a two-line answer, and
 * this one is still covered by the free Neuron allocation.
 */
const DEFAULT_ARTIFACT_MODEL = "@cf/openai/gpt-oss-20b"

/**
 * Wants a page built, not just an answer. "How do I create a session?" is a
 * question, so a build verb alone is not enough — it has to be aimed at
 * something page-shaped, or name an artifact outright.
 */
const BUILD_VERB =
  /\b(build|create|make|generate|design|draw|render|show me|write me|give me|crea|creami|genera|generami|costruisci|disegna|fammi|mostrami)\b/i
const BUILD_OBJECT =
  /\b(guide|guida|walkthrough|tutorial|onboarding|cheat ?sheet|dashboard|diagram|diagramma|chart|grafico|poster|infographic|page|pagina|ui|interfaccia|overview|summary|riassunto|comparison|confronto|checklist|reference|table|tabella|template|playground|visuali\w+)\b/i
const EXPLICIT_ARTIFACT = /\b(artifact|artefatt\w+|cheat ?sheet|cheatsheet)\b/i

const wantsArtifact = (question: string) =>
  EXPLICIT_ARTIFACT.test(question) || (BUILD_VERB.test(question) && BUILD_OBJECT.test(question))

const MAX_MESSAGES = 12
const MAX_QUESTION_CHARS = 1200
const MAX_DOCS = 3
/** Per-page grounding budget, in characters (~1.2k tokens). */
const DOC_BUDGET = 5000
const MAX_OUTPUT_TOKENS = 900
/** Answer plus the outline of a guide. */
const MAX_OUTLINE_OUTPUT_TOKENS = 1400
/** The rendered guide: layout, CSS and script for the whole page. */
const MAX_ARTIFACT_OUTPUT_TOKENS = 4000
const RATE_LIMIT_PER_HOUR = 20

type ChatRole = "user" | "assistant"
type ChatMessage = { role: ChatRole; content: string }
type Source = { title: string; href: string }
type Backend = "nikcli" | "workers-ai"

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })

function parseMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return []
  return input
    .filter(
      (message): message is ChatMessage =>
        !!message &&
        typeof message === "object" &&
        ["user", "assistant"].includes((message as ChatMessage).role) &&
        typeof (message as ChatMessage).content === "string",
    )
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, MAX_QUESTION_CHARS).trim(),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-MAX_MESSAGES)
}

/** Best-effort per-IP hourly cap so the free Workers AI allocation survives. */
async function rateLimited(env: CloudflareEnv, request: Request) {
  const kv = env.SESSIONS
  if (!kv) return false

  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
  if (!ip) return false

  const limit = Number(env.DOCS_ASSISTANT_RATE_LIMIT) || RATE_LIMIT_PER_HOUR
  const bucket = Math.floor(Date.now() / 3_600_000)
  const key = `docs-assistant:rl:${ip}:${bucket}`

  try {
    const used = Number((await kv.get(key)) ?? "0")
    if (used >= limit) return true
    await kv.put(key, String(used + 1), { expirationTtl: 3600 })
    return false
  } catch {
    return false
  }
}

/**
 * Renders a docs page to Markdown, cached in the Workers cache so repeat
 * questions do not re-render and re-convert the same HTML.
 */
async function loadDoc(href: string, origin: string, fetcher: DocFetcher) {
  const cacheKey = new Request(`${origin}/_docs-assistant-cache?path=${encodeURIComponent(href)}`)
  // `caches.default` is the Workers cache; the DOM's CacheStorage has no such
  // property, and outside a Worker (dev, tests) there is no cache at all.
  const cache = (globalThis.caches as unknown as { default?: Cache } | undefined)?.default

  try {
    const hit = await cache?.match(cacheKey)
    if (hit) return await hit.text()
  } catch {
    // Cache unavailable (e.g. local dev) — fall through to a live render.
  }

  const doc = await fetchDocMarkdown(href, origin, fetcher)
  try {
    await cache?.put(
      cacheKey,
      new Response(doc.markdown, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "public, max-age=1800",
        },
      }),
    )
  } catch {
    // Caching is an optimization only.
  }
  return doc.markdown
}

const ARTIFACT_INSTRUCTIONS = [
  "When the user asks for something they will keep, use or share — a guide, a walkthrough, a cheatsheet, a checklist, a comparison, a reference — end your reply with exactly one fenced block:",
  '```artifact title="Short title" filename="name.html"',
  "## Section heading",
  "1. Step, with the exact command in `backticks`",
  "- Fact, option or gotcha to show",
  "```",
  "Artifact rules:",
  "- Inside the block, write only the outline of the page: section headings, ordered steps, bullet points, tables, and the exact commands or config snippets. It is rendered into a designed, interactive HTML guide for you — do not write HTML, CSS or JavaScript yourself.",
  "- Cover the whole topic in that outline: every step, option and caveat you want on the page, taken from the documentation excerpts.",
  "- The block is removed from the chat and published as a shareable page on nikcli-ai.dev; introduce it in one sentence before the block and do not repeat its content outside the block.",
  "- Use it only when a standalone page is genuinely useful; a normal answer needs no artifact.",
].join("\n")

/**
 * Renders an outline into the published artifact: a designed, interactive
 * guide. The chat model only supplies content, so the look stays consistent
 * and does not depend on a small model inventing a layout.
 */
const HTML_BUILDER_PROMPT = `You build interactive HTML guides about nikcli, an open-source terminal-native AI development agent.

Output raw HTML only: one complete <!doctype html> document. No Markdown, no code fence, no commentary before or after.

Start from this design system and keep its tokens and class names — fill it with the real content:

<style>
:root {
  --bg:#ffffff; --panel:#f7f8fa; --raised:#ffffff; --text:#14161a; --muted:#5c6470;
  --border:#e3e6eb; --accent:#2f6df6; --accent-soft:rgba(47,109,246,0.12);
  --ok:#1f9d55; --warn:#c77700; --danger:#d64545; --code:#f2f4f7; --radius:14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#0d0f12; --panel:#14171c; --raised:#171b21; --text:#e8eaee; --muted:#98a1af;
    --border:#242932; --accent:#7aa2ff; --accent-soft:rgba(122,162,255,0.16);
    --ok:#4ade80; --warn:#f0b429; --danger:#f87171; --code:#11141a;
  }
}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);
  font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:52rem;margin:0 auto;padding:2rem 1.1rem 4rem}
.hero{border:1px solid var(--border);background:linear-gradient(180deg,var(--accent-soft),transparent);
  border-radius:var(--radius);padding:1.6rem 1.4rem;margin-bottom:1.5rem}
.hero h1{margin:0 0 .4rem;font-size:clamp(1.6rem,4vw,2.2rem);letter-spacing:-.02em;line-height:1.15}
.hero p{margin:0;color:var(--muted)}
.badge{display:inline-block;padding:.2rem .6rem;border-radius:999px;font-size:.72rem;font-weight:700;
  letter-spacing:.06em;text-transform:uppercase;background:var(--accent-soft);color:var(--accent);margin-bottom:.7rem}
.progress{height:6px;border-radius:999px;background:var(--border);overflow:hidden;margin:1rem 0 1.5rem}
.progress > i{display:block;height:100%;width:0;background:var(--accent);transition:width .3s ease}
.tabs{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:1rem}
.tab{border:1px solid var(--border);background:var(--panel);color:var(--muted);border-radius:999px;
  padding:.45rem .9rem;font:inherit;font-size:.85rem;font-weight:600;cursor:pointer}
.tab[aria-selected="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
.card{border:1px solid var(--border);background:var(--raised);border-radius:var(--radius);padding:1.1rem 1.2rem;margin-bottom:1rem}
.step{display:flex;gap:.9rem;align-items:flex-start}
.step-n{flex:0 0 1.9rem;height:1.9rem;border-radius:999px;background:var(--accent);color:#fff;
  display:grid;place-items:center;font-size:.85rem;font-weight:700}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:.5rem 0}
.grid{display:grid;gap:.9rem;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.check{display:flex;gap:.6rem;align-items:flex-start;padding:.5rem 0;cursor:pointer}
.check input{margin-top:.35rem;accent-color:var(--accent)}
pre{position:relative;background:var(--code);border:1px solid var(--border);border-radius:10px;
  padding:.85rem 1rem;overflow-x:auto;font-size:.85rem}
code{font-family:ui-monospace,SFMono-Regular,"JetBrains Mono",monospace}
.copy{position:absolute;top:.45rem;right:.45rem;border:1px solid var(--border);background:var(--raised);
  color:var(--muted);border-radius:8px;padding:.2rem .5rem;font:inherit;font-size:.72rem;cursor:pointer}
.copy:hover{color:var(--accent);border-color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{border:1px solid var(--border);padding:.55rem .7rem;text-align:left}
th{background:var(--panel)}
a{color:var(--accent)} footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--border);color:var(--muted);font-size:.8rem}
@media (max-width:420px){.wrap{padding:1.25rem .85rem 3rem}.grid{grid-template-columns:1fr}}
</style>

Requirements:
- It is a guide, not a wall of text: a hero (badge, title, one-line intro), then numbered steps in .card/.step, or .tabs switching between sections when the content is a comparison.
- Make it genuinely interactive with an inline <script>: tab switching, a copy button injected into every <pre>, checkboxes that drive the .progress bar, and smooth-scrolling anchors. Wire everything with addEventListener; keep all state in variables (no localStorage — it is blocked).
- Use colour with intent: the accent for actions and active state, --ok/--warn/--danger for safe/careful/destructive notes. If you draw a <canvas> or <svg> chart, fill it with those same colours, never black.
- Every CSS and JS value must be complete and valid; never leave a number or colour channel empty.
- Sandboxed iframe: no network requests, no external fonts, scripts, or images.
- Responsive to 360px: wrap every <table> in <div class="scroll"> so wide content scrolls inside its own box, and keep code lines short. The page itself must never scroll sideways.
- Readable in light and dark, and factually faithful to the documentation given. Link back to docs pages with absolute https://nikcli-ai.dev/docs/... URLs.`

function systemPrompt(context: string, currentPage?: Source) {
  const pages = docsIndex.map((entry) => `- ${entry.title} — ${entry.href}`).join("\n")

  return [
    "You are the Nikcli documentation assistant, embedded in the official docs at nikcli-ai.dev.",
    "Nikcli is an open-source, terminal-native AI development agent (CLI, TUI, server, web app and mobile app).",
    "You help users understand and use nikcli. You are support, not a code-writing agent.",
    "",
    "Rules:",
    "- Answer ONLY from the documentation excerpts below. They are the source of truth.",
    "- If the excerpts do not contain the answer, say so plainly and point to the closest documentation page, plus https://github.com/nikcli/nikcli/issues for anything unresolved.",
    "- Never invent commands, flags, config keys, API routes, package names or file paths.",
    "- Be concise: a short answer first, then bullets or a fenced code block when there are commands to run.",
    "- Link the pages you used as Markdown links with site-relative paths, e.g. [Configuration](/docs/configuration).",
    "- Reply in the language the user wrote in.",
    "",
    ARTIFACT_INSTRUCTIONS,
    "",
    currentPage ? `The user is currently reading: ${currentPage.title} (${currentPage.href}).` : "",
    "",
    "Documentation table of contents (link to these paths only):",
    pages,
    "",
    "Documentation excerpts:",
    context,
  ]
    .filter(Boolean)
    .join("\n")
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "nikcli-guide"

/** Title for a guide the user asked for but the model did not name. */
function guideTitle(question: string) {
  const cleaned = question
    .replace(/^\s*(please\s+)?/i, "")
    .replace(/^(build|create|make|generate|design|write|give)\s+(me\s+)?(an?\s+)?(interactive\s+)?/i, "")
    .replace(/[?!.]+\s*$/, "")
    .trim()
  const title = cleaned.length > 3 ? cleaned : question.trim()
  const short = title.length > 70 ? `${title.slice(0, 67).trimEnd()}…` : title
  return short.charAt(0).toUpperCase() + short.slice(1)
}

const isLocalOrigin = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname.endsWith(".local") ||
  hostname.endsWith(".localhost")

/**
 * The answer without its artifact block — that gets published, not chatted.
 * While the block is still streaming, everything from the fence on is hidden.
 */
function visibleAnswer(answer: string) {
  const marker = answer.indexOf(ARTIFACT_MARKER)
  if (marker === -1) return answer
  return answer.includes("```", marker + ARTIFACT_MARKER.length)
    ? extractArtifact(answer).text
    : answer.slice(0, marker).trimEnd()
}

/**
 * Holds back a trailing partial code fence so a half-written ```artifact
 * marker never flashes in the transcript.
 */
function withheldTail(text: string) {
  const fence = text.lastIndexOf("`")
  return fence !== -1 && text.length - fence < 12 ? text.slice(0, fence) : text
}

export type AnswerChunk = { kind: "text" | "reasoning"; text: string }

/** Parses the Workers AI SSE frames into answer and reasoning deltas. */
async function* workersAiDeltas(upstream: ReadableStream<Uint8Array>): AsyncGenerator<AnswerChunk> {
  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  /**
   * Workers AI models do not agree on a stream shape: Llama sends
   * `{response}`, gpt-oss sends Responses API events, and some models send
   * OpenAI chat chunks. Reasoning deltas are dropped — only the answer shows.
   */
  const parse = (payload: string): AnswerChunk | null => {
    if (payload === "[DONE]") return null
    try {
      const data = JSON.parse(payload) as {
        response?: unknown
        reasoning?: unknown
        type?: unknown
        delta?: unknown
        choices?: Array<{
          delta?: { content?: unknown; reasoning_content?: unknown }
        }>
      }

      if (typeof data.response === "string") return { kind: "text", text: data.response }
      if (typeof data.reasoning === "string") return { kind: "reasoning", text: data.reasoning }

      if (typeof data.delta === "string" && typeof data.type === "string") {
        if (data.type.endsWith("output_text.delta")) return { kind: "text", text: data.delta }
        if (data.type.includes("reasoning")) return { kind: "reasoning", text: data.delta }
      }

      const choice = data.choices?.[0]?.delta
      if (typeof choice?.content === "string") return { kind: "text", text: choice.content }
      if (typeof choice?.reasoning_content === "string") return { kind: "reasoning", text: choice.reasoning_content }

      return null
    } catch {
      return null
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const text = parse(trimmed.slice(5).trim())
        if (text) yield text
      }
    }
    if (buffer.trim().startsWith("data:")) {
      const text = parse(buffer.trim().slice(5).trim())
      if (text) yield text
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Wraps an answer stream in our SSE protocol: `meta`, `tool`, `sources`,
 * `reasoning`, `delta`/`text`, `status`, `artifact`, `error`, `done`.
 */
function eventStream(input: {
  answer: AsyncGenerator<AnswerChunk>
  /** `append`: chunks are deltas. `replace`: each chunk is the full answer. */
  mode: "append" | "replace"
  sources: Source[]
  tools?: ToolCall[]
  backend: Backend
  sessionID?: string
  /** Publish a guide even when the model did not volunteer an artifact block. */
  forceArtifact?: boolean
  titleHint: string
  publish: (draft: ArtifactRequest) => Promise<unknown>
}) {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) => controller.enqueue(encoder.encode(sse(event, data)))

      emit("meta", { backend: input.backend, sessionID: input.sessionID })
      for (const tool of input.tools ?? []) emit("tool", tool)
      emit("sources", input.sources)

      let answer = ""
      let sent = 0
      let announced = false
      try {
        for await (const chunk of input.answer) {
          if (chunk.kind === "reasoning") {
            emit("reasoning", { text: chunk.text })
            continue
          }

          answer = input.mode === "replace" ? chunk.text : answer + chunk.text

          if (!announced && answer.includes(ARTIFACT_MARKER)) {
            announced = true
            emit("status", { message: "Building a shareable artifact…" })
          }

          // nikcli reports the whole message, so replace; Workers AI streams
          // tokens, so append. Either way an in-progress artifact fence is held
          // back until the block is complete and can be stripped.
          if (input.mode === "replace") {
            emit("text", { text: visibleAnswer(answer) })
            continue
          }

          const visible = withheldTail(visibleAnswer(answer))
          if (visible.length > sent) {
            emit("delta", { text: visible.slice(sent) })
            sent = visible.length
          }
        }

        if (!answer.trim()) {
          emit("error", { message: "The model returned an empty answer." })
        } else {
          const { text, artifact } = extractArtifact(answer)
          emit("text", { text })

          // Either the model asked for an artifact, or the question did: a
          // request to build something always ends with a published page.
          const draft =
            artifact ??
            (input.forceArtifact && text.trim().length > 200
              ? {
                  title: input.titleHint,
                  filename: `${slugify(input.titleHint)}.html`,
                  content: text,
                }
              : null)

          if (draft) {
            if (!announced) emit("status", { message: "Building your guide…" })
            try {
              const published = await input.publish(draft)
              if (published) emit("artifact", published)
            } catch {
              emit("notice", {
                message: "The guide for this answer could not be published.",
              })
            }
          }
        }
      } catch (error) {
        emit("error", {
          message: error instanceof Error ? error.message : "The answer stream failed.",
        })
      } finally {
        emit("done", {})
        controller.close()
      }
    },
  })
}

export const POST: APIRoute = async ({ request, locals, url }) => {
  const env = locals.runtime?.env as CloudflareEnv | undefined
  const nikcli = env ? nikcliBackendConfig(env) : null
  if (!env?.AI && !nikcli) {
    return json(
      {
        error: "The docs assistant is not configured on this deployment (missing Workers AI binding).",
      },
      503,
    )
  }

  let body: { messages?: unknown; path?: unknown; sessionID?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: "Invalid JSON body." }, 400)
  }

  const messages = parseMessages(body.messages)
  const question = [...messages].reverse().find((message) => message.role === "user")?.content
  if (!question) return json({ error: "Ask a question first." }, 400)

  if (env && (await rateLimited(env, request))) {
    return json(
      {
        error: "Too many questions from this address in the last hour. Try again later, or read the docs directly.",
      },
      429,
    )
  }

  const currentPath = typeof body.path === "string" ? normalizeDocsPath(body.path, url.origin) : undefined

  // Retrieval: rank pages across the conversation, weighted to the latest
  // question, then ground on the top pages plus the page being read.
  const conversation = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join(" ")
  let picked = selectDocs({
    query: `${question} ${question} ${conversation}`,
    currentPath,
    limit: MAX_DOCS,
  })
  const tokens = tokenize(question)

  // Keywords find the obvious pages; a tool call catches the ones the user
  // described without naming ("it keeps asking me" → Permissions). The model's
  // picks lead, lexical results fill the remaining slots, and either half alone
  // is enough if the other fails.
  const tools: ToolCall[] = []
  if (env?.AI) {
    const planned = await planDocs({
      ai: env.AI,
      model: env.DOCS_ASSISTANT_MODEL || DEFAULT_MODEL,
      question,
      limit: MAX_DOCS,
    })
    if (planned.call) tools.push(planned.call)

    if (planned.paths.length > 0) {
      const order = [...(currentPath ? [currentPath] : []), ...planned.paths, ...picked.map((entry) => entry.href)]
      picked = [...new Set(order)].slice(0, MAX_DOCS).flatMap((path) => {
        const entry = docsIndex.find((item) => item.href === path)
        return entry ? [{ ...entry, score: 1 }] : []
      })
    }
  }

  const fetcher = docsFetcher(env)
  const loaded = await Promise.all(
    picked.map(async (entry) => {
      try {
        return {
          entry,
          markdown: condenseMarkdown(await loadDoc(entry.href, url.origin, fetcher), tokens, DOC_BUDGET),
        }
      } catch {
        return null
      }
    }),
  )

  const grounded = loaded.filter((item): item is NonNullable<typeof item> => item !== null)
  if (grounded.length === 0) {
    return json({ error: "Could not load the documentation right now. Try again." }, 502)
  }

  const context = grounded
    .map((item) => `<page title="${item.entry.title}" path="${item.entry.href}">\n${item.markdown}\n</page>`)
    .join("\n\n")

  const sources: Source[] = grounded.map((item) => ({
    title: item.entry.title,
    href: item.entry.href,
  }))
  const currentPage = currentPath ? sources.find((source) => source.href === currentPath) : undefined
  const system = systemPrompt(context, currentPage)

  const wantsGuide = wantsArtifact(question)
  const model = env?.DOCS_ASSISTANT_MODEL || DEFAULT_MODEL
  const artifactModel = env?.DOCS_ASSISTANT_ARTIFACT_MODEL || DEFAULT_ARTIFACT_MODEL

  /**
   * Renders the outline the chat model wrote into the published guide. The
   * design lives in HTML_BUILDER_PROMPT, so every artifact looks the same no
   * matter which model answered.
   */
  const renderArtifact = async (draft: ArtifactRequest) => {
    if (!env?.AI) return draft

    const messages = [
      { role: "system", content: HTML_BUILDER_PROMPT },
      {
        role: "user",
        content: `The user asked: ${question}\n\nBuild the interactive guide "${draft.title}" from this outline:\n\n${draft.content}\n\nSupporting documentation (use it for accuracy, do not invent anything):\n${context}`,
      },
    ]

    try {
      // Streamed, not awaited as one response: reasoning models return an
      // empty message when asked for the whole page at once, but stream the
      // document fine — and the parser keeps reasoning out of the HTML.
      const upstream = (await env.AI.run(artifactModel, {
        stream: true,
        max_tokens: MAX_ARTIFACT_OUTPUT_TOKENS,
        temperature: 0.4,
        messages,
      })) as ReadableStream<Uint8Array>

      let text = ""
      for await (const chunk of workersAiDeltas(upstream)) {
        if (chunk.kind === "text") text += chunk.text
      }

      text = text
        .replace(/^\s*```[a-z]*\n?/i, "")
        .replace(/```\s*$/, "")
        .trim()

      // Anything shorter is a refusal or a stub — keep the outline instead,
      // which still publishes as a readable page.
      return text.length > 400 ? { ...draft, content: text } : draft
    } catch {
      return draft
    }
  }

  const publish = async (draft: ArtifactRequest) => {
    if (!env?.ARTIFACTS) return null
    return publishArtifact(env.ARTIFACTS, await renderArtifact(draft), {
      origin: url.origin,
      // Local and preview runs keep their own origin: the artifact lives in
      // that deployment's bucket, so a nikcli-ai.dev link would 404.
      publicOrigin: isLocalOrigin(url.hostname) ? undefined : env.ARTIFACT_PUBLIC_ORIGIN,
      sessionID: typeof body.sessionID === "string" ? body.sessionID : undefined,
    })
  }

  const streamHeaders = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }

  // Preferred backend: a real nikcli session, when the deployment has one.
  if (nikcli) {
    try {
      const turn = await runNikcliTurn({
        config: nikcli,
        sessionID: typeof body.sessionID === "string" ? body.sessionID : undefined,
        prompt: `${system}\n\n---\n\nUser question: ${question}`,
        signal: request.signal,
      })

      return new Response(
        eventStream({
          answer: (async function* () {
            for await (const text of turn.stream) yield { kind: "text", text }
          })() as AsyncGenerator<AnswerChunk>,
          mode: "replace",
          sources,
          tools,
          backend: "nikcli",
          forceArtifact: wantsGuide,
          titleHint: guideTitle(question),
          sessionID: turn.sessionID,
          publish,
        }),
        { headers: streamHeaders },
      )
    } catch {
      // nikcli server unreachable — fall through to Workers AI.
    }
  }

  if (!env?.AI) {
    return json({ error: "The nikcli backend is unavailable right now." }, 502)
  }

  try {
    const upstream = (await env.AI.run(model, {
      stream: true,
      max_tokens: wantsGuide ? MAX_OUTLINE_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      messages: [{ role: "system", content: system }, ...messages],
    })) as ReadableStream<Uint8Array>

    return new Response(
      eventStream({
        answer: workersAiDeltas(upstream),
        mode: "append",
        sources,
        tools,
        backend: "workers-ai",
        forceArtifact: wantsGuide,
        titleHint: guideTitle(question),
        publish,
      }),
      { headers: streamHeaders },
    )
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? `Workers AI request failed: ${error.message}` : "Workers AI request failed.",
      },
      502,
    )
  }
}

export const GET: APIRoute = () => json({ error: "Use POST with { messages, path, sessionID }." }, 405)
