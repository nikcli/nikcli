// Fetches GitHub releases at request time (SSR) and classifies their assets
// into user-facing download groups. New versions and freshly uploaded assets
// appear automatically — no redeploy required.

const REPO = "nikcli/nikcli"
const API = `https://api.github.com/repos/${REPO}/releases`

export type DownloadCategory = "desktop" | "ade" | "cli" | "mobile" | "other"
export type OS = "macos" | "windows" | "linux" | "android" | "ios" | "any"
export type Arch = "arm64" | "x64" | "universal" | "any"

export interface ClassifiedAsset {
  name: string
  url: string
  size: number
  downloadCount: number
  category: DownloadCategory
  os: OS
  arch: Arch
  /** Short human format, e.g. ".dmg", ".exe", ".tar.gz" */
  format: string
  /** Optional build variant qualifier, e.g. "baseline", "musl" */
  variant: string | null
  /** Human label used in the UI, e.g. "Apple Silicon (.dmg)" */
  label: string
}

export interface ReleaseInfo {
  tag: string
  name: string
  publishedAt: string | null
  htmlUrl: string
  prerelease: boolean
  /** Raw GitHub release notes (markdown) */
  body: string
  assets: ClassifiedAsset[]
}

interface RawAsset {
  name: string
  browser_download_url: string
  size: number
  download_count: number
}
interface RawRelease {
  tag_name: string
  name: string | null
  published_at: string | null
  html_url: string
  prerelease: boolean
  draft: boolean
  body: string | null
  assets: RawAsset[]
}

const fmtArch = (a: Arch, os: OS = "any"): string => {
  if (a === "arm64") return os === "macos" ? "Apple Silicon" : "ARM64"
  if (a === "x64") return os === "macos" ? "Intel" : "x64"
  if (a === "universal") return "Universal"
  return ""
}

const detectFormat = (name: string): string => {
  const n = name.toLowerCase()
  if (n.endsWith(".tar.gz")) return ".tar.gz"
  if (n.endsWith(".app.tar.gz")) return ".app.tar.gz"
  const dot = n.lastIndexOf(".")
  return dot >= 0 ? n.slice(dot) : ""
}

const detectArch = (name: string): Arch => {
  const n = name.toLowerCase()
  if (/(aarch64|arm64)/.test(n)) return "arm64"
  if (/(x86_64|x64|amd64|x86)/.test(n)) return "x64"
  if (/universal/.test(n)) return "universal"
  return "any"
}

/** Hidden internal/updater artifacts that shouldn't surface as downloads. */
const isInternal = (name: string): boolean => {
  const n = name.toLowerCase()
  return (
    n === "latest.json" ||
    n.endsWith(".sig") ||
    n.endsWith(".app.tar.gz") ||
    // Tauri updater zips for macOS (the .dmg is the user-facing installer)
    /-(?:aarch64|x86_64)-apple-darwin\.zip$/.test(n) ||
    // ADE also ships its .app as a bare zip; same bits as its .dmg for that arch
    n.endsWith(".app.zip")
  )
}

/**
 * ADE rides in the same release as nikcli: `ade-release` in attach_only mode
 * uploads its installers into the existing `v*` release, in the same Tauri
 * bundle formats as the nikcli desktop app. The product name in the filename
 * is the only thing that separates the two, so that is what the category keys
 * off — otherwise both apps' installers land in one "Desktop" list under
 * identical labels ("Apple Silicon (.dmg)" twice, and so on).
 */
const isAde = (name: string): boolean => /^ade[-_]/i.test(name)

/** Tauri installer bundles, shared by the nikcli desktop app and ADE. */
const installerOf = (n: string, format: string, arch: Arch): { os: OS; label: string } | null => {
  if (/\.dmg$/.test(n)) return { os: "macos", label: `${fmtArch(arch, "macos")} (.dmg)` }
  if (/-setup\.exe$/.test(n) || /\.msi$/.test(n))
    return { os: "windows", label: `${fmtArch(arch, "windows")} (${format === ".exe" ? "installer" : format})` }
  if (/\.deb$/.test(n)) return { os: "linux", label: `Debian / Ubuntu — ${fmtArch(arch, "linux")} (.deb)` }
  if (/\.rpm$/.test(n)) return { os: "linux", label: `Fedora / RHEL — ${fmtArch(arch, "linux")} (.rpm)` }
  if (/\.appimage$/.test(n)) return { os: "linux", label: `AppImage — ${fmtArch(arch, "linux")} (.AppImage)` }
  if (/\.exe$/.test(n)) return { os: "windows", label: `${fmtArch(arch, "windows")} (.exe)` }
  return null
}

function classify(asset: RawAsset): ClassifiedAsset {
  const name = asset.name
  const n = name.toLowerCase()
  const format = detectFormat(name)
  const arch = detectArch(name)
  let variant: string | null = null
  if (/baseline/.test(n)) variant = "baseline"
  else if (/musl/.test(n)) variant = "musl"

  let category: DownloadCategory = "other"
  let os: OS = "any"
  let label = name

  // Mobile artifacts
  if (n.endsWith(".apk") || n.endsWith(".aab")) {
    category = "mobile"
    os = "android"
    label = `Android (${format})`
  } else if (n.endsWith(".ipa")) {
    category = "mobile"
    os = "ios"
    label = `iOS (${format})`
  }
  // CLI binaries: published as nikcli-ai-<os>-<arch>...
  else if (n.startsWith("nikcli-ai-")) {
    category = "cli"
    if (/darwin/.test(n)) os = "macos"
    else if (/linux/.test(n)) os = "linux"
    else if (/windows|win/.test(n)) os = "windows"
    const variantTag = variant ? ` · ${variant}` : ""
    label = `${fmtArch(arch, os)}${variantTag} (${format})`
  }
  // GUI installers (Tauri): Nikcli_<ver>_… for the desktop app, ADE_<ver>_… for ADE.
  else {
    const installer = installerOf(n, format, arch)
    if (installer) {
      category = isAde(name) ? "ade" : "desktop"
      os = installer.os
      label = installer.label
    }
  }

  return {
    name,
    url: asset.browser_download_url,
    size: asset.size,
    downloadCount: asset.download_count,
    category,
    os,
    arch,
    format,
    variant,
    label,
  }
}

function shape(rel: RawRelease): ReleaseInfo {
  const assets = rel.assets
    .filter((a) => !isInternal(a.name))
    .map(classify)
    // hide unclassified noise from the primary view, keep real downloads
    .filter((a) => a.category !== "other")
  return {
    tag: rel.tag_name,
    name: rel.name || rel.tag_name,
    publishedAt: rel.published_at,
    htmlUrl: rel.html_url,
    prerelease: rel.prerelease,
    body: rel.body || "",
    assets,
  }
}

/**
 * A release is "complete" only once its CI pipeline has published the full
 * artifact set: the desktop app for macOS + Windows + Linux AND the CLI. The
 * Windows desktop installer is signed/built last, so this gate is the reliable
 * signal that CI has finished. The download page keys off
 * this so they never surface a half-published version.
 */
export function isComplete(rel: ReleaseInfo): boolean {
  const desktopOs = new Set(rel.assets.filter((a) => a.category === "desktop").map((a) => a.os))
  const hasCli = rel.assets.some((a) => a.category === "cli")
  return desktopOs.has("macos") && desktopOs.has("windows") && desktopOs.has("linux") && hasCli
}

/** Compare semver-ish "x.y.z" strings; returns >0 if a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0)
  const pb = b
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export async function fetchReleases(limit = 30): Promise<ReleaseInfo[]> {
  const res = await fetch(`${API}?per_page=${limit}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "nikcli-web",
    },
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const data = (await res.json()) as RawRelease[]
  return data.filter((r) => !r.draft).map(shape)
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "—"
  const units = ["B", "KB", "MB", "GB"]
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatDate(iso: string | null): string {
  if (!iso) return ""
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  } catch {
    return ""
  }
}

export const OS_META: Record<
  Exclude<OS, "any">,
  { label: string; icon: "apple" | "windows" | "linux" | "android" | "ios" }
> = {
  macos: { label: "macOS", icon: "apple" },
  windows: { label: "Windows", icon: "windows" },
  linux: { label: "Linux", icon: "linux" },
  android: { label: "Android", icon: "android" },
  ios: { label: "iOS", icon: "ios" },
}
