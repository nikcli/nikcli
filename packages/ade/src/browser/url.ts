/**
 * URL normalization for the embedded browser pane.
 *
 * Developers type shorthand when previewing local development servers — `:5173`,
 * `3000`, or `localhost:3000`. Normalizing these into fully qualified URLs avoids
 * forcing the developer to type `http://` every time, while strictly rejecting
 * dangerous schemes like `javascript:`, `data:`, `file:`, and `vbscript:` that
 * must never be loaded into an embedded iframe.
 */

/**
 * Schemes that must be rejected immediately to prevent script execution,
 * local filesystem inspection, or content spoofing inside the frame.
 */
const FORBIDDEN_SCHEME_PREFIXES = [
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "blob:",
  "about:",
  "chrome:",
  "mailto:",
]

/**
 * Maximum TCP port number. Ports outside 1..65535 cannot represent a listening
 * server and must be rejected rather than normalized into a broken address.
 */
const MAX_PORT = 65535
const MIN_PORT = 1

function isValidHostname(hostname: string): boolean {
  if (!hostname) return false
  if (hostname.startsWith("-") || hostname.endsWith("-")) return false
  if (hostname.startsWith(".") || hostname.endsWith(".")) return false
  // IPv6 bracketed host
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true

  const labels = hostname.split(".")
  for (const label of labels) {
    if (!label) return false
    if (label.startsWith("-") || label.endsWith("-")) return false
    if (!/^[a-zA-Z0-9-]+$/.test(label)) return false
  }
  return true
}

/**
 * Normalizes user input into a valid HTTP/HTTPS URL loadable in an iframe.
 * Returns `undefined` if the input cannot be resolved into a safe URL.
 */
export function normalizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  // Strip control characters to avoid bypasses via newline/null injection.
  const sanitized = trimmed.replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
  const lower = sanitized.toLowerCase()

  for (const prefix of FORBIDDEN_SCHEME_PREFIXES) {
    if (lower.startsWith(prefix)) return undefined
  }

  // Pure port number shorthand: "3000" or "5173" or "3000/path?query#hash"
  const purePortMatch = sanitized.match(/^(\d{1,5})(\/.*)?$/)
  if (purePortMatch) {
    const port = Number.parseInt(purePortMatch[1], 10)
    if (port < MIN_PORT || port > MAX_PORT) return undefined
    const path = purePortMatch[2] ?? ""
    return `http://localhost:${port}${path}`
  }

  // Colon-prefixed port shorthand: ":5173" or ":3000/dashboard"
  const colonPortMatch = sanitized.match(/^:(\d{1,5})(\/.*)?$/)
  if (colonPortMatch) {
    const port = Number.parseInt(colonPortMatch[1], 10)
    if (port < MIN_PORT || port > MAX_PORT) return undefined
    const path = colonPortMatch[2] ?? ""
    return `http://localhost:${port}${path}`
  }

  // Explicit scheme with authority delimiter: e.g. "https://x.dev", "ftp://host"
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(sanitized)) {
    if (!/^https?:\/\//i.test(sanitized)) {
      // Only http and https are allowed for web frame navigation
      return undefined
    }
    try {
      const parsed = new URL(sanitized)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
      if (!isValidHostname(parsed.hostname)) return undefined
      if (hasCredentials(parsed)) return undefined
      if (parsed.port) {
        const portNum = Number.parseInt(parsed.port, 10)
        if (portNum < MIN_PORT || portNum > MAX_PORT) return undefined
      }
      /*
       * The canonical form, not the string that was typed.
       *
       * This validated `parsed` and then returned `sanitized` — the raw
       * input — so every character `new URL` would have percent-encoded
       * survived: `"`, `<`, `>`, backtick. `loadMirror` interpolates the
       * result into `<base href="…">` with no escaping, so a quote closed
       * the attribute and the rest of the "URL" became markup in a document
       * that, before the sandbox fix, ran in ADE's own origin.
       */
      return parsed.href
    } catch {
      return undefined
    }
  }

  // Host without scheme: e.g. "localhost:3000", "example.com", "127.0.0.1:8080"
  // Disallow spaces in hostname or invalid host formats
  if (sanitized.includes(" ")) return undefined

  const candidate = `http://${sanitized}`
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    if (!isValidHostname(parsed.hostname)) return undefined
    if (hasCredentials(parsed)) return undefined
    // Validate port if explicitly provided in host
    if (parsed.port) {
      const portNum = Number.parseInt(parsed.port, 10)
      if (portNum < MIN_PORT || portNum > MAX_PORT) return undefined
    }
    return parsed.href
  } catch {
    return undefined
  }
}

/**
 * Refuses the userinfo form, which is a disguise rather than a credential.
 *
 * `http://localhost:3000@evil.com/` is a perfectly valid URL whose host is
 * `evil.com`; everything before the `@` is a username. It passed every check
 * here because `parsed.hostname` really is a valid hostname, the address bar
 * showed the part a reader's eye stops at, and the frame loaded the other
 * site. The full string then reached the agent's prompt through
 * `formatSelectionContext`, so the agent was told it was looking at
 * localhost too.
 *
 * Nothing ADE's browser pane is for — previewing a local dev server — needs
 * userinfo, so it is refused rather than stripped: stripping would silently
 * load a different page than the one that was typed.
 */
function hasCredentials(parsed: URL): boolean {
  return parsed.username.length > 0 || parsed.password.length > 0
}

/**
 * Checks whether a given URL is safe and valid to load in the browser pane.
 */
export function isValidBrowserUrl(raw: string): boolean {
  return normalizeUrl(raw) !== undefined
}
