/** Platform the webview runs on — drives shortcut glyphs and the title-bar layout. */
const nav = typeof navigator === "undefined" ? undefined : navigator
const ident = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`

export const isMac = /Mac|iPhone|iPad/i.test(ident)
export const isWindows = !isMac && /Win/i.test(ident)
export const platform = isMac ? "mac" : isWindows ? "windows" : "linux"

/** Modifier as the platform draws it: `⌘` on macOS, `Ctrl+` elsewhere. */
export const MOD = isMac ? "⌘" : "Ctrl+"
export const shortcut = (key: string) => `${MOD}${key}`

/** Marks <html> so CSS can adapt (macOS has an overlay title bar with traffic lights, others a native one). */
export function initPlatform() {
  document.documentElement.dataset.platform = platform
}
