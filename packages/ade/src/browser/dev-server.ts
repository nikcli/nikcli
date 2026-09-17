/**
 * A dev server a session started, read from what the session prints (S46 F4).
 *
 * When an agent runs `npm run dev`, the server says where it is: Vite's
 * `Local: http://localhost:5173/`, Next's `- Local: http://localhost:3000`,
 * `Listening on port 8080`. ADE reads the same lines it already reads for
 * panel requests and offers to open that address in a web pane bound to the
 * session. Offered, not opened (D45): a session asking with `@ade browser
 * open` gets its pane at once; one ADE merely noticed gets a question.
 *
 * Only local addresses: a line that mentions a remote URL is not a server
 * this session started. `Network:` lines are the same server on the LAN
 * address, and are skipped so one server makes one offer.
 *
 * Plain `.ts`, so the patterns are tested.
 */

const ANSI = new RegExp(
  [
    "\\u001b\\[[0-9;?]*[ -/]*[@-~]", // CSI
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", // OSC, links included
    "\\u001b[@-Z\\\\-_]", // other escapes
  ].join("|"),
  "g",
)

/** Box drawing and the bullets TUIs put around a tool's output. */
const FRAME_CHARS = /[─-╿▀-▟│┃❯›»•●○◆▶➜]/g

const LOCAL_URL =
  /\bhttps?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))?(\/[^\s'"`<>)\]]*)?/i

/** Words that say the line announces a server, not merely mentions an address. */
const ANNOUNCES = /\b(local|ready|listening|running|started|serving|server|available|dev|preview|app)\b/i

const PORT_ONLY = /\b(?:listening|running|started|serving|server)\b[^\n]*?\b(?:on\s+)?(?:port\s+|:)(\d{2,5})\b/i

/** The address the line announces, normalised; undefined when it announces none. */
export function devServerUrl(raw: string): string | undefined {
  const line = raw.replace(ANSI, "").replace(FRAME_CHARS, " ").trim()
  if (!line || line.length > 400) return undefined
  if (/\b(network|external|on your network)\b/i.test(line)) return undefined

  const match = LOCAL_URL.exec(line)
  if (match) {
    if (!ANNOUNCES.test(line.replace(match[0], " "))) return undefined
    const port = match[2]
    if (!port || !validPort(port)) return undefined
    const path = (match[3] ?? "/").replace(/[.,;:!?]+$/, "") || "/"
    const scheme = match[0].toLowerCase().startsWith("https") ? "https" : "http"
    return `${scheme}://localhost:${Number(port)}${path}`
  }

  const portOnly = PORT_ONLY.exec(line)
  if (portOnly && validPort(portOnly[1]!)) return `http://localhost:${Number(portOnly[1])}/`
  return undefined
}

function validPort(port: string): boolean {
  const value = Number(port)
  return Number.isInteger(value) && value >= 80 && value <= 65535
}

/** `http://localhost:5173` for any address of the same server. */
export function serverOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const host = ["127.0.0.1", "0.0.0.0", "[::1]", "[::]"].includes(parsed.hostname) ? "localhost" : parsed.hostname
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80")
    return `${parsed.protocol}//${host}:${port}`
  } catch {
    return undefined
  }
}

export interface DevServerOffer {
  readonly sessionId: string
  readonly title: string
  readonly url: string
}

/**
 * Whether to offer `url` for `sessionId`.
 *
 * Once per session and server: a TUI redraws its screen, and the same line
 * comes back many times. Not when the session's own pane already shows that
 * server.
 */
export function shouldOffer(input: {
  sessionId: string
  url: string
  /** Servers already offered, answered or ignored, as `offerKey`. */
  seen: ReadonlySet<string>
  /** What the session's own web pane shows, if it has one. */
  ownedUrl?: string
}): boolean {
  const key = offerKey(input.sessionId, input.url)
  if (!key || input.seen.has(key)) return false
  return !(input.ownedUrl && serverOf(input.ownedUrl) === serverOf(input.url))
}

export function offerKey(sessionId: string, url: string): string {
  const server = serverOf(url)
  return server ? `${sessionId} ${server}` : ""
}
