/**
 * nikcli.store/releases/download/<tag>/<asset> — the download path the
 * installers already use.
 *
 * `install` sets this as `release_url_primary` and falls back to
 * github.com/.../releases/download on failure; `install.ps1` puts it first in
 * its candidate list. Both have been doing so against a 404, so every install
 * has been taking the fallback and the primary URL has been dead weight.
 *
 * Making it work buys the one thing GitHub cannot give us: the country. A
 * release asset's `download_count` is an integer with no dimensions, and npm
 * publishes only per-day totals, so the geographic breakdown on /data has no
 * upstream to come from. Here the request passes our edge, which resolves
 * `cf-ipcountry` on its own, and we record a day, a country and an asset name
 * before handing the download to GitHub.
 *
 * The redirect target is the real `browser_download_url`, so GitHub still
 * serves the bytes and still counts the download. This route adds a dimension
 * to that number; it does not replace it, and the two stay reconcilable.
 *
 * Counting must never cost a download. The insert runs inside `waitUntil`, so
 * the 302 goes out immediately, and every failure path — no database, a
 * rejected write, a missing country — still redirects.
 */
import type { APIRoute } from "astro"

const GITHUB_RELEASES = "https://github.com/nikcli/nikcli/releases/download"

/** Cloudflare omits the header for unknown or reserved addresses; `T1` is Tor. */
const UNKNOWN = "XX"

/**
 * The asset path is echoed into a redirect and stored, so it is validated
 * rather than trusted: release tags and asset names are a known-narrow
 * alphabet, and anything else is refused instead of being forwarded.
 */
const ASSET_PATH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

function countryOf(request: Request): string {
  const code = request.headers.get("cf-ipcountry")?.toUpperCase()
  return code && /^[A-Z]{2}$/.test(code) && code !== "T1" ? code : UNKNOWN
}

export const GET: APIRoute = async (ctx) => {
  const asset = ctx.params.asset ?? ""
  if (!ASSET_PATH.test(asset) || asset.includes("..")) {
    return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } })
  }

  const target = `${GITHUB_RELEASES}/${asset}`
  const DB = (ctx.locals as { runtime?: { env?: { DOWNLOADS?: D1Database } } }).runtime?.env?.DOWNLOADS

  if (DB) {
    const day = new Date().toISOString().slice(0, 10)
    const country = countryOf(ctx.request)
    // Only the filename is stored: the tag is already in STATS.md, and keeping
    // it here would multiply the rows by every release for no question anyone
    // asks of this table.
    const filename = asset.slice(asset.indexOf("/") + 1)
    const write = DB.prepare(
      `INSERT INTO download_hit (day, country, asset, hits) VALUES (?, ?, ?, 1)
       ON CONFLICT(day, country, asset) DO UPDATE SET hits = hits + 1`,
    )
      .bind(day, country, filename)
      .run()
    // A download must not wait on, or fail with, its own bookkeeping.
    ctx.locals.runtime?.ctx?.waitUntil(write.catch(() => {}))
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      // The mapping from asset name to GitHub URL is fixed, but the counter is
      // the point: a cached redirect is a download this never sees.
      "cache-control": "no-store",
    },
  })
}
