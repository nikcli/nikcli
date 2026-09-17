/**
 * Pure path utilities.
 *
 * Every function here works on strings alone — no I/O, no platform detection
 * at runtime — so the module is testable in any environment.
 * Windows paths (backslashes, drive letters, UNC) are handled correctly because
 * ADE's primary target is Windows.
 */

/** Forward slashes, no trailing slash (except root like `C:/`). */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, "/")
  // Strip trailing slash, but preserve roots like `C:/` and `/`
  while (out.length > 1 && out.endsWith("/") && !/^[A-Za-z]:\/$/.test(out)) {
    out = out.slice(0, -1)
  }
  return out
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join("/"))
}

export function basename(p: string): string {
  const n = normalizePath(p)
  const i = n.lastIndexOf("/")
  return i === -1 ? n : n.slice(i + 1)
}

export function dirname(p: string): string {
  const n = normalizePath(p)
  const i = n.lastIndexOf("/")
  if (i === -1) return "."
  if (i === 0) return "/"
  // Drive root: `C:/foo` → `C:/`
  if (n[i - 1] === ":" && i <= 2) return n.slice(0, i + 1)
  return n.slice(0, i)
}

/**
 * Recognises `C:\`, `C:/`, `/`, and `\\server\share` (UNC).
 */
export function isAbsolutePath(p: string): boolean {
  if (p.startsWith("/") || p.startsWith("\\\\")) return true
  // Drive letter: `C:\` or `C:/`
  return /^[A-Za-z]:[\\/]/.test(p)
}

/** Replaces `home` prefix with `~` for compact display. */
export function toDisplayPath(p: string, home: string): string {
  const np = normalizePath(p).toLowerCase()
  const nh = normalizePath(home).toLowerCase()
  if (np === nh) return "~"
  const prefix = nh.endsWith("/") ? nh : nh + "/"
  if (np.startsWith(prefix)) {
    return "~" + "/" + normalizePath(p).slice(prefix.length)
  }
  return normalizePath(p)
}

/** Case-insensitive, normalised comparison — correct on Windows. */
export function pathEquals(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase()
}
