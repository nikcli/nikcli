/**
 * The browser pane's own back/forward list.
 *
 * The frame's `history` cannot serve: the frame is sandboxed without
 * `allow-same-origin`, so its window is cross-origin to ADE and reading
 * `contentWindow.history` throws. It also dies with the frame, and the frame
 * is rebuilt whenever the pane is drawn again — switching project and back
 * is enough. This list lives in the workbench instead, so it comes back with
 * the pane, and is saved with it.
 *
 * It records what the pane loaded (address bar, back, forward), not links
 * followed inside the page: those happen in a document ADE cannot read.
 */

export interface BrowserHistory {
  entries: string[]
  index: number
}

/** Enough to go back through a working session, small enough to save with every autosave. */
export const HISTORY_LIMIT = 50

export function startHistory(url: string): BrowserHistory {
  return { entries: [url], index: 0 }
}

/** The page being shown. */
export function currentEntry(history: BrowserHistory): string {
  return history.entries[history.index] ?? ""
}

/**
 * A new page: what was ahead of the current one is dropped, as in any browser.
 * Loading the page already shown is not a new entry.
 */
export function visit(history: BrowserHistory, url: string): BrowserHistory {
  if (currentEntry(history) === url) return history
  const entries = [...history.entries.slice(0, history.index + 1), url].slice(-HISTORY_LIMIT)
  return { entries, index: entries.length - 1 }
}

export function canStep(history: BrowserHistory, delta: -1 | 1): boolean {
  const next = history.index + delta
  return next >= 0 && next < history.entries.length
}

/** Back (-1) or forward (+1); the same history when there is nowhere to go. */
export function step(history: BrowserHistory, delta: -1 | 1): BrowserHistory {
  return canStep(history, delta) ? { entries: history.entries, index: history.index + delta } : history
}

/**
 * The history a pane opens with.
 *
 * A saved one is used only when it is whole and its current entry is the
 * pane's URL; anything else starts over from the URL, which is the one thing
 * the pane is known to show.
 */
export function restoreHistory(url: string, saved: unknown): BrowserHistory {
  if (!saved || typeof saved !== "object") return startHistory(url)
  const { entries, index } = saved as { entries?: unknown; index?: unknown }
  if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) return startHistory(url)
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= entries.length) {
    return startHistory(url)
  }
  if (entries[index] !== url) return startHistory(url)
  const kept = entries.slice(-HISTORY_LIMIT)
  const keptIndex = index - (entries.length - kept.length)
  return keptIndex < 0 ? startHistory(url) : { entries: kept, index: keptIndex }
}

/*
 * Query parameters that carry credentials: Jupyter's `?token=`, magic links,
 * OAuth's `code=`, signed URLs. Matched on the parts of the name, so
 * `access_token`, `api-key` and `X-Amz-Signature` are caught while `zipcode`
 * or `monkey` are not.
 */
const SECRET_PARTS = new Set([
  "token",
  "code",
  "key",
  "apikey",
  "secret",
  "password",
  "passwd",
  "pwd",
  "auth",
  "session",
  "sessionid",
  "sid",
  "sig",
  "signature",
  "jwt",
  "credential",
  "credentials",
])
// Also inside a longer name (`sessionid`, `xsrftoken`); "auth" is not, or `author` would go too.
const SECRET_WORDS = ["token", "secret", "password", "session"]

function isSecretName(name: string): boolean {
  const lower = name.toLowerCase()
  if (SECRET_WORDS.some((word) => lower.includes(word))) return true
  return lower.split(/[^a-z0-9]+/).some((part) => SECRET_PARTS.has(part))
}

/*
 * Path segments that are credentials: `/reset/<token>`, `/magic/<token>`,
 * signed share links. A segment after one of these words, or any long
 * random-looking one, is treated as a secret. Long ids that are not secret
 * (a commit hash, a UUID) are caught too, and lose only the path.
 */
const SECRET_PATH_WORDS = new Set([
  "reset",
  "reset-password",
  "password-reset",
  "verify",
  "verification",
  "confirm",
  "confirmation",
  "magic",
  "magic-link",
  "invite",
  "invitation",
  "activate",
  "activation",
  "token",
  "tokens",
  "auth",
  "login",
  "signin",
  "sign-in",
  "unsubscribe",
  "share",
  "download",
])

function looksRandom(segment: string): boolean {
  return (
    segment.length >= 24 && /^[A-Za-z0-9_\-.~=+%]+$/.test(segment) && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment)
  )
}

function hasSecretPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean)
  return segments.some((segment, index) => {
    if (looksRandom(segment)) return true
    const previous = segments[index - 1]?.toLowerCase()
    return previous !== undefined && SECRET_PATH_WORDS.has(previous) && segment.length >= 8 && /[0-9]/.test(segment)
  })
}

/**
 * The URL as it may be written to disk.
 *
 * The workbench is saved in plain text, and a URL is often the credential
 * itself. Parameters that look like one are removed, and so is a fragment
 * carrying an OAuth token (`#access_token=…`); a secret in the path leaves
 * only the site (`hasSecretPath`). What is shown on screen is
 * not touched: only what is saved.
 */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Unreadable: keep only what precedes a query or fragment.
    return url.replace(/[?#].*$/, "")
  }
  // A secret in the path cannot be cut out and leave a working address: only the site is kept.
  if (hasSecretPath(parsed.pathname)) return `${parsed.origin}/`
  let changed = false
  for (const name of [...parsed.searchParams.keys()]) {
    if (!isSecretName(name)) continue
    parsed.searchParams.delete(name)
    changed = true
  }
  if (parsed.username || parsed.password) {
    parsed.username = ""
    parsed.password = ""
    changed = true
  }
  const fragment = parsed.hash.slice(1)
  if (fragment.includes("=") && [...new URLSearchParams(fragment.replace(/^[/!?]+/, "")).keys()].some(isSecretName)) {
    parsed.hash = ""
    changed = true
  }
  // Untouched URLs are returned as written, so the saved history still matches the pane's URL.
  return changed ? parsed.href : url
}

/** `redactUrl` over a whole history; its current entry stays the redacted URL. */
export function redactHistory(history: BrowserHistory): BrowserHistory {
  return { entries: history.entries.map(redactUrl), index: history.index }
}
