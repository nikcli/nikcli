/**
 * The two string operations the browser pane cannot get wrong.
 *
 * Both live here rather than inside the component because both were wrong,
 * and a Solid `.tsx` cannot be imported under `bun test` in this repo — so
 * anything that has to be *proved* has to be somewhere a test can reach it.
 */

/**
 * Makes a reload actually reload.
 *
 * `loadToken` was incremented on every Reload and never read by anything.
 * In `native` fidelity that meant the button rewrote the iframe's `src` with
 * a string identical to the one already there; Solid compares and writes
 * nothing, so the frame did not renavigate. Worse, the handshake timer
 * started anyway, found no bridge after 1500 ms, and replaced a live page
 * with a static mirror of it — so Reload's visible effect was to *downgrade*
 * the preview.
 *
 * The first load carries no marker, so an untouched preview requests exactly
 * the URL that was typed. Reloads carry `?__ade_reload=<n>`, which is what a
 * cache-busting parameter is for, and which no dev server routes on.
 */
export function withLoadToken(url: string, token: number): string {
  if (token <= 1) return url

  try {
    const parsed = new URL(url)
    parsed.searchParams.set("__ade_reload", String(token))
    return parsed.href
  } catch {
    // Not parseable: better to return it unchanged than to corrupt it.
    return url
  }
}

/**
 * Escapes a value being interpolated into a double-quoted HTML attribute.
 *
 * `loadMirror` builds `<base href="…">` by hand. One unescaped `"` closes
 * the attribute and everything after it becomes markup, in a document that
 * — before the sandbox lost `allow-same-origin` — ran in ADE's own origin
 * with `window.parent.document` and `__TAURI_INTERNALS__` in reach.
 *
 * `&` is escaped first, otherwise it would double-escape the entities the
 * other replacements introduce.
 */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
