/**
 * Resolving and loading a background source.
 *
 * A source is a single image (path, `file://`, `http(s)://`, `data:`) or a
 * directory — pointing at a wallpaper folder picks one of its images, which
 * is what makes `/background` → Shuffle useful.
 */
import fs from "fs/promises"
import { existsSync } from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { pickDecoder, type PixelImage } from "@nikcli-ai/tui-image"
import { IMAGE_EXTENSIONS, isImagePath } from "./settings"
import { prepare } from "./pixels"
import { createPromiseCache } from "@tui/util/lru-cache"

const MAX_BYTES = 25 * 1024 * 1024

/** How long a remote image may take to arrive before the source is reported as failed. */
const FETCH_TIMEOUT_MS = 15_000

export async function listImages(directory: string) {
  const found = await fs.readdir(directory, { withFileTypes: true })
  return found
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && isImagePath(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort()
}

/**
 * Folders offered by the picker, most specific first. Only folders that exist
 * are offered: a "Wallpapers" row that opens on "Cannot read this folder" is
 * a dead end, not a shortcut.
 */
export function suggestedFolders(cwd = process.cwd(), home = os.homedir(), exists = existsSync) {
  const folders = [
    { label: "Project", directory: cwd },
    { label: "Pictures", directory: path.join(home, "Pictures") },
    { label: "Wallpapers", directory: path.join(home, "Pictures", "Wallpapers") },
    { label: "Desktop", directory: path.join(home, "Desktop") },
    { label: "Downloads", directory: path.join(home, "Downloads") },
  ]
  const seen = new Set<string>()
  return folders.filter((folder) => {
    const key = path.resolve(folder.directory)
    if (seen.has(key)) return false
    seen.add(key)
    return exists(folder.directory)
  })
}

/**
 * Where the picker opens for a configured local source: the folder itself when
 * the source is one (a rotation), otherwise the folder holding the image.
 */
export function pickerStart(source: string, cwd = process.cwd()) {
  const local = localPath(source)
  if (!local || !isLocalSource(local)) return cwd
  const resolved = path.resolve(local)
  return isImagePath(resolved) ? path.dirname(resolved) : resolved
}

/** A path on this machine, as opposed to a `data:` or `scheme://` URL. */
export function isLocalSource(source: string) {
  return source !== "" && !source.startsWith("data:") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(source)
}

export type DirectoryEntry = { name: string; path: string; kind: "directory" | "image" }

/**
 * One directory as the picker shows it: sub-folders first, then images.
 * Everything else is hidden — the picker only ever produces a background.
 */
export async function listDirectory(directory: string): Promise<DirectoryEntry[]> {
  const found = await fs.readdir(directory, { withFileTypes: true })
  const directories: DirectoryEntry[] = []
  const images: DirectoryEntry[] = []
  for (const entry of found) {
    if (entry.name.startsWith(".")) continue
    const full = path.join(directory, entry.name)
    let isDirectory = entry.isDirectory()
    if (!isDirectory && entry.isSymbolicLink()) {
      isDirectory = (await fs.stat(full).catch(() => undefined))?.isDirectory() ?? false
    }
    if (isDirectory) directories.push({ name: entry.name, path: full, kind: "directory" })
    else if (isImagePath(entry.name)) images.push({ name: entry.name, path: full, kind: "image" })
  }
  const byName = (a: DirectoryEntry, b: DirectoryEntry) => a.name.localeCompare(b.name)
  return [...directories.sort(byName), ...images.sort(byName)]
}

/** Display form of a path: `~` for the home directory, separators kept as is. */
export function shortenPath(target: string, home = os.homedir()) {
  if (target === home) return "~"
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`
  if (target.startsWith(prefix)) return `~${target.slice(home.length)}`
  return target
}

/**
 * Turn a configured source into a concrete image location. Directories
 * resolve to one of their images (`index` walks the list, so a shuffle only
 * needs to bump a counter).
 */
export async function resolveSource(source: string, index = 0): Promise<string> {
  if (!source) throw new Error("no background image configured")
  if (source.startsWith("data:") || /^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return source
  const stat = await fs.stat(source).catch(() => undefined)
  if (!stat) throw new Error(`not found: ${source}`)
  if (!stat.isDirectory()) return source
  const images = await listImages(source)
  if (images.length === 0) throw new Error(`no images in ${source} (${IMAGE_EXTENSIONS.join(", ")})`)
  return images[((index % images.length) + images.length) % images.length]!
}

/** The local path a `file://` URL names, on either platform. Anything else is returned as is. */
export function localPath(location: string) {
  if (!location.startsWith("file://")) return location
  // `new URL(...).pathname` keeps the leading slash of `/C:/...` on Windows and
  // drops a `file://host/share` host; `fileURLToPath` handles both.
  return fileURLToPath(location)
}

async function readBytes(location: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (location.startsWith("data:")) {
    const match = location.match(/^data:([^;,]+)?((?:;[^,]*)?),(.*)$/s)
    if (!match) throw new Error("invalid data URL")
    const payload = match[3] ?? ""
    return (match[2] ?? "").includes(";base64")
      ? Uint8Array.fromBase64(payload)
      : new TextEncoder().encode(decodeURIComponent(payload))
  }

  if (location.startsWith("http://") || location.startsWith("https://")) {
    // Bounded on both axes. Without a deadline a host that accepts the
    // connection and never answers leaves the resource loading forever — no
    // toast, no fallback, and the next shuffle still waits on it. The size
    // check on the declared length refuses a large body before it is pulled;
    // the one on the buffer covers servers that do not declare it.
    const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)]
    if (signal) signals.push(signal)
    const response = await fetch(location, { headers: { Accept: "image/*" }, signal: AbortSignal.any(signals) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("image is too large")
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_BYTES) throw new Error("image is too large")
    return new Uint8Array(buffer)
  }

  const filename = localPath(location)
  const file = Bun.file(filename)
  if (!(await file.exists())) throw new Error(`not found: ${filename}`)
  if (file.size > MAX_BYTES) throw new Error("image is too large")
  return new Uint8Array(await file.arrayBuffer())
}

// Bounded: Shuffle walks a whole wallpaper folder, and an unbounded map kept
// every image it ever showed decoded for the rest of the process.
const cache = createPromiseCache<PixelImage>({ maxEntries: 4 })

/**
 * Decode a resolved location into a working-size image. Cached per location:
 * switching routes or resizing the terminal must never re-decode a photo.
 */
export function loadImage(location: string): Promise<PixelImage> {
  return cache.load(location, async (signal) => {
    const bytes = await readBytes(location, signal)
    // WebP wallpapers are common and Jimp cannot read them; the fallback to
    // photon only works once its wasm asset has been located.
    const decoder = await pickDecoder()
    const image = await decoder(bytes)
    if (image.width <= 0 || image.height <= 0) throw new Error("decoder produced a zero-sized image")
    return prepare(image)
  })
}
