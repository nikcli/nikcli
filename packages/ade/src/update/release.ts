/**
 * Which ADE release is newer than the one running.
 *
 * ADE releases are GitHub releases on the fork, tagged `ade-v<major>.<minor>.<patch>`.
 * The same repository carries nikcli's own `v*` tags and other products'
 * prefixed ones, so the prefix is the whole filter: a release without it is
 * somebody else's.
 *
 * Pure, in a `.ts`, so the rule can be tested under `bun test`.
 */

export const RELEASE_REPO = "SandroHub013/nikcli"
export const TAG_PREFIX = "ade-v"

/** The fields of a GitHub release this module reads. */
export interface GithubRelease {
  readonly tag_name: string
  readonly html_url: string
  readonly draft: boolean
  readonly prerelease: boolean
  readonly published_at?: string | null
}

export interface AvailableUpdate {
  readonly version: string
  readonly url: string
}

type Triple = readonly [number, number, number]

/** `1.2.3`, `v1.2.3` or `ade-v1.2.3` as numbers; anything else is not a version. */
export function parseVersion(text: string): Triple | undefined {
  const match = /^(?:ade-)?v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!
  }
  return 0
}

/**
 * The newest published ADE release, when it is newer than `current`.
 *
 * A build whose own version does not parse, or is `0.0.0` (what `tauri dev`
 * and any unreleased build report), is never told to update: there is no
 * release it is behind, and a dev build nagging to install the public one
 * would teach everyone working on ADE to ignore the bell.
 */
export function newerRelease(current: string, releases: readonly GithubRelease[]): AvailableUpdate | undefined {
  const running = parseVersion(current)
  if (!running || compare(running, [0, 0, 0]) === 0) return undefined

  let best: { version: Triple; release: GithubRelease } | undefined
  for (const release of releases) {
    if (release.draft || release.prerelease) continue
    if (!release.tag_name.startsWith(TAG_PREFIX)) continue
    const version = parseVersion(release.tag_name)
    if (!version) continue
    if (!best || compare(version, best.version) > 0) best = { version, release }
  }

  if (!best || compare(best.version, running) <= 0) return undefined
  return { version: best.version.join("."), url: best.release.html_url }
}

/**
 * Only a release page on the fork may be opened from a notice.
 *
 * The URL comes from the network; opening whatever it says would let anyone
 * who can answer that request point ADE's "Scarica" at a page of their own.
 */
export function isReleasePage(url: string): boolean {
  return url.startsWith(`https://github.com/${RELEASE_REPO}/releases/`)
}
