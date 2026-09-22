/**
 * Resolving and loading a background source.
 *
 * A source is a single image (path, `file://`, `http(s)://`, `data:`) or a
 * directory — pointing at a wallpaper folder picks one of its images, which
 * is what makes `/background` → Shuffle useful.
 */
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pickDecoder, type PixelImage } from "@nikcli-ai/tui-image"
import { IMAGE_EXTENSIONS, isImagePath } from "./settings"
import { prepare } from "./pixels"
import { createPromiseCache } from "@tui/util/lru-cache"

const MAX_BYTES = 25 * 1024 * 1024

export async function listImages(directory: string) {
  const found = await fs.readdir(directory, { withFileTypes: true })
  return found
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && isImagePath(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort()
}

/** Folders offered by the picker, most specific first. */
export function suggestedFolders(cwd = process.cwd(), home = os.homedir()) {
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
    return true
  })
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

async function readBytes(location: string): Promise<Uint8Array> {
  if (location.startsWith("data:")) {
    const match = location.match(/^data:([^;,]+)?((?:;[^,]*)?),(.*)$/s)
    if (!match) throw new Error("invalid data URL")
    const payload = match[3] ?? ""
    return (match[2] ?? "").includes(";base64")
      ? Uint8Array.fromBase64(payload)
      : new TextEncoder().encode(decodeURIComponent(payload))
  }

  if (location.startsWith("http://") || location.startsWith("https://")) {
    const response = await fetch(location, { headers: { Accept: "image/*" } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_BYTES) throw new Error("image is too large")
    return new Uint8Array(buffer)
  }

  const filename = location.startsWith("file://") ? decodeURIComponent(new URL(location).pathname) : location
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
  return cache.load(location, async () => {
    const bytes = await readBytes(location)
    // WebP wallpapers are common and Jimp cannot read them; the fallback to
    // photon only works once its wasm asset has been located.
    const decoder = await pickDecoder()
    const image = await decoder(bytes)
    if (image.width <= 0 || image.height <= 0) throw new Error("decoder produced a zero-sized image")
    return prepare(image)
  })
}
