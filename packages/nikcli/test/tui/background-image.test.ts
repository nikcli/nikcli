import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createPixelImage, type PixelImage } from "@nikcli-ai/tui-image"
import {
  cleanSource,
  clampOpacity,
  DEFAULT_SETTINGS,
  isImagePath,
  normalize,
  opacityLabel,
  OPACITY_MAX,
  OPACITY_MIN,
  sourceLabel,
  stepOpacity,
} from "@tui/feature-plugins/background/settings"
import { bufferSize, bufferStride, compose, placement, prepare, resample } from "@tui/feature-plugins/background/pixels"
import {
  isLocalSource,
  listDirectory,
  listImages,
  localPath,
  pickerStart,
  resolveSource,
  shortenPath,
  suggestedFolders,
} from "@tui/feature-plugins/background/source"
import { readSettings, writeSettings } from "@tui/feature-plugins/background/store"
import { shouldUseRendererThread } from "@nikcli-ai/util/win32"

function solid(width: number, height: number, rgba: [number, number, number, number]): PixelImage {
  return createPixelImage(width, height, rgba)
}

function pixel(data: Uint8Array, width: number, x: number, y: number) {
  const index = (y * width + x) * 4
  return [data[index], data[index + 1], data[index + 2], data[index + 3]]
}

describe("background settings", () => {
  test("uses synchronous terminal output on Windows", () => {
    expect(shouldUseRendererThread("win32")).toBe(false)
    expect(shouldUseRendererThread("darwin")).toBe(true)
    expect(shouldUseRendererThread("linux")).toBe(true)
  })

  test("normalizes a bare string into a source", () => {
    expect(normalize("/tmp/a.png")).toEqual({ ...DEFAULT_SETTINGS, source: "/tmp/a.png" })
  })

  test("falls back to defaults for junk and out-of-range values", () => {
    expect(normalize(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalize({ fit: "stretch", scope: "nowhere", opacity: 12 })).toEqual({
      ...DEFAULT_SETTINGS,
      opacity: OPACITY_MAX,
    })
  })

  test("cleans terminal drag-and-drop paths", () => {
    // `windows` defaults to the host platform, and these are the POSIX shapes:
    // backslash means escaping here, not a separator. Pinned to false so the case
    // asserts what it is named for on either host — the sibling test below pins
    // it to true and covers the other half.
    const posix = false
    expect(cleanSource('"/tmp/my image.png"', "/Users/nik", posix)).toBe("/tmp/my image.png")
    expect(cleanSource("/tmp/my\\ image.png", "/Users/nik", posix)).toBe("/tmp/my image.png")
    expect(cleanSource("~/pics/a.png", "/Users/nik", posix)).toBe("/Users/nik/pics/a.png")
    expect(cleanSource("   ", "/Users/nik", posix)).toBe("")
  })

  test("keeps Windows separators instead of unescaping them", () => {
    const windows = true
    expect(cleanSource("C:\\Users\\39349\\a.png", "C:\\Users\\39349", windows)).toBe("C:\\Users\\39349\\a.png")
    expect(cleanSource('"C:\\Users\\39349\\my image.png"', "C:\\Users\\39349", windows)).toBe(
      "C:\\Users\\39349\\my image.png",
    )
    // `path.win32`, not `path.join`: the whole point of passing `windows` is that
    // the assertion describes Windows on either host. Bare `path.join` resolves
    // against the *runner*, so on POSIX this expected the mixed
    // `C:\Users\39349/Pictures\a.png` and the case failed everywhere but Windows.
    expect(cleanSource("~\\Pictures\\a.png", "C:\\Users\\39349", windows)).toBe(
      path.win32.join("C:\\Users\\39349", "Pictures\\a.png"),
    )
    expect(cleanSource("~", "C:\\Users\\39349", windows)).toBe("C:\\Users\\39349")
  })

  test("cycles opacity within bounds and wraps around", () => {
    expect(clampOpacity(-1)).toBe(OPACITY_MIN)
    expect(stepOpacity(0.3)).toBe(0.35)
    expect(stepOpacity(OPACITY_MAX)).toBe(OPACITY_MIN)
    expect(stepOpacity(OPACITY_MIN, -1)).toBe(OPACITY_MAX)
    expect(opacityLabel(0.35)).toBe("35%")
  })

  test("recognizes image files and labels sources", () => {
    expect(isImagePath("/a/b/photo.JPEG")).toBe(true)
    expect(isImagePath("https://x/y.png?raw=1")).toBe(true)
    expect(isImagePath("/a/b/notes.txt")).toBe(false)
    expect(sourceLabel("/a/b/photo.png")).toBe("photo.png")
    expect(sourceLabel("")).toBe("none")
  })
})

describe("background pixels", () => {
  test("cover crops the source to the target aspect and fills it", () => {
    const box = placement({ width: 400, height: 100 }, { width: 100, height: 100 }, "cover")
    expect(box.rect).toEqual({ x: 150, y: 0, width: 100, height: 100 })
    expect({ x: box.x, y: box.y, width: box.width, height: box.height }).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })
  })

  test("contain keeps the whole source and centers it", () => {
    const box = placement({ width: 400, height: 100 }, { width: 100, height: 100 }, "contain")
    expect(box.rect).toEqual({ x: 0, y: 0, width: 400, height: 100 })
    expect({ x: box.x, y: box.y, width: box.width, height: box.height }).toEqual({
      x: 0,
      y: 37,
      width: 100,
      height: 25,
    })
  })

  test("resample box-averages instead of point-sampling", () => {
    const image = createPixelImage(2, 1)
    image.data.set([0, 0, 0, 255], 0)
    image.data.set([100, 100, 100, 255], 4)
    const out = resample(image, { x: 0, y: 0, width: 2, height: 1 }, 1, 1)
    expect(Array.from(out.data)).toEqual([50, 50, 50, 255])
  })

  test("prepare shrinks oversized images and leaves small ones alone", () => {
    const small = solid(10, 10, [1, 2, 3, 255])
    expect(prepare(small, 64)).toBe(small)
    const large = prepare(solid(2000, 1000, [1, 2, 3, 255]), 100)
    expect([large.width, large.height]).toEqual([100, 50])
  })

  test("compose sizes the buffer for the native 2×2 super-sampler", () => {
    const data = compose(solid(4, 4, [0, 0, 0, 255]), {
      columns: 5,
      rows: 3,
      fit: "cover",
      opacity: 1,
      grayscale: false,
      base: { r: 0, g: 0, b: 0 },
    })
    expect(data).toHaveLength(bufferSize(5, 3))
    expect(bufferSize(5, 3)).toBe(10 * 6 * 4)
    expect(bufferStride(5)).toBe(10 * 4)
  })

  test("compose blends the image over the theme background by opacity", () => {
    const data = compose(solid(4, 4, [200, 100, 0, 255]), {
      columns: 1,
      rows: 1,
      fit: "cover",
      opacity: 0.5,
      grayscale: false,
      base: { r: 0, g: 0, b: 0 },
    })
    expect(pixel(data, 2, 0, 0)).toEqual([100, 50, 0, 255])
    expect(pixel(data, 2, 1, 1)).toEqual([100, 50, 0, 255])
  })

  test("compose applies grayscale and keeps the buffer opaque", () => {
    const data = compose(solid(2, 2, [255, 0, 0, 255]), {
      columns: 1,
      rows: 1,
      fit: "cover",
      opacity: 1,
      grayscale: true,
      base: { r: 0, g: 0, b: 0 },
    })
    expect(pixel(data, 2, 0, 0)).toEqual([54, 54, 54, 255])
  })

  test("contain letterboxes with the theme background", () => {
    // A cell is twice as tall as it is wide, so 4×4 cells is 4×8 square units:
    // an 8×2 image fits as a single 4-unit-wide band centered on row 3.
    // `blocks` keeps the raw sample grid — the geometry this asserts — where
    // `flat` would average row 3 into its neighbour.
    const data = compose(solid(8, 2, [255, 255, 255, 255]), {
      columns: 4,
      rows: 4,
      fit: "contain",
      opacity: 1,
      grayscale: false,
      base: { r: 10, g: 20, b: 30 },
      detail: "blocks",
    })
    expect(pixel(data, 8, 0, 0)).toEqual([10, 20, 30, 255])
    expect(pixel(data, 8, 0, 3)).toEqual([255, 255, 255, 255])
    expect(pixel(data, 8, 7, 3)).toEqual([255, 255, 255, 255])
    expect(pixel(data, 8, 0, 7)).toEqual([10, 20, 30, 255])
  })

  test("flat averages the two halves of a cell so a space can carry the whole color", () => {
    // Top half white, bottom half black.
    const image = createPixelImage(2, 2)
    image.data.set([255, 255, 255, 255], 0)
    image.data.set([255, 255, 255, 255], 4)
    image.data.set([0, 0, 0, 255], 8)
    image.data.set([0, 0, 0, 255], 12)
    const options = {
      columns: 1,
      rows: 1,
      fit: "cover",
      opacity: 1,
      grayscale: false,
      base: { r: 0, g: 0, b: 0 },
    } as const

    const blocks = compose(image, { ...options, detail: "blocks" })
    expect(pixel(blocks, 2, 0, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(blocks, 2, 0, 1)).toEqual([0, 0, 0, 255])

    // Both halves identical, and their average: the renderable drops the `▀`
    // and paints the background, which must still read as the whole cell.
    const flat = compose(image, { ...options, detail: "flat" })
    expect(pixel(flat, 2, 0, 0)).toEqual([128, 128, 128, 255])
    expect(pixel(flat, 2, 0, 1)).toEqual([128, 128, 128, 255])
    // `flat` is what an unset `detail` means.
    expect(Array.from(compose(image, options))).toEqual(Array.from(flat))
  })

  test("transparent source pixels keep the theme background", () => {
    const data = compose(solid(2, 2, [255, 255, 255, 0]), {
      columns: 1,
      rows: 1,
      fit: "cover",
      opacity: 1,
      grayscale: false,
      base: { r: 10, g: 20, b: 30 },
    })
    expect(pixel(data, 2, 0, 0)).toEqual([10, 20, 30, 255])
  })
})

describe("background source", () => {
  const root = path.join(os.tmpdir(), `nikcli-background-${process.pid}`)
  const nested = path.join(root, "nested")

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  async function seed() {
    await fs.mkdir(nested, { recursive: true })
    await Bun.write(path.join(root, "b.png"), "b")
    await Bun.write(path.join(root, "a.jpg"), "a")
    await Bun.write(path.join(root, "notes.txt"), "x")
    await Bun.write(path.join(root, ".hidden.png"), "h")
    await Bun.write(path.join(nested, "c.webp"), "c")
  }

  test("lists folders first, then images, hiding everything else", async () => {
    await seed()
    expect(await listDirectory(root)).toEqual([
      { name: "nested", path: nested, kind: "directory" },
      { name: "a.jpg", path: path.join(root, "a.jpg"), kind: "image" },
      { name: "b.png", path: path.join(root, "b.png"), kind: "image" },
    ])
    expect(await listImages(root)).toEqual([path.join(root, "a.jpg"), path.join(root, "b.png")])
  })

  test("resolves a file as-is and rotates through a folder", async () => {
    await seed()
    const file = path.join(root, "a.jpg")
    expect(await resolveSource(file)).toBe(file)
    expect(await resolveSource(root, 0)).toBe(file)
    expect(await resolveSource(root, 1)).toBe(path.join(root, "b.png"))
    // Shuffle counts up forever; the folder wraps around.
    expect(await resolveSource(root, 2)).toBe(file)
    expect(await resolveSource("https://example.com/a.png")).toBe("https://example.com/a.png")
    await expect(resolveSource(path.join(root, "missing.png"))).rejects.toThrow("not found")
    await expect(resolveSource(nested + "/empty")).rejects.toThrow("not found")
  })

  test("maps file URLs to local paths on either platform", () => {
    expect(localPath("/tmp/a.png")).toBe("/tmp/a.png")
    expect(localPath("https://example.com/a.png")).toBe("https://example.com/a.png")
    const url = Bun.pathToFileURL(path.resolve("my image.png")).href
    expect(url).toContain("%20")
    expect(localPath(url)).toBe(path.resolve("my image.png"))
  })

  test("tells local paths from URLs", () => {
    expect(isLocalSource("/tmp/a.png")).toBe(true)
    expect(isLocalSource("C:\\Users\\me\\a.png")).toBe(true)
    expect(isLocalSource("")).toBe(false)
    expect(isLocalSource("data:image/png;base64,AAAA")).toBe(false)
    expect(isLocalSource("https://example.com/a.png")).toBe(false)
    expect(isLocalSource("file:///tmp/a.png")).toBe(false)
  })

  test("the picker opens on the configured folder, or on the image's folder", () => {
    const cwd = path.resolve("/work")
    // A rotation source is a folder: opening its *parent* would show the user a
    // list of folders when they came to pick among that folder's images.
    expect(pickerStart(path.join(cwd, "wallpapers"), cwd)).toBe(path.join(cwd, "wallpapers"))
    expect(pickerStart(path.join(cwd, "wallpapers", "a.png"), cwd)).toBe(path.join(cwd, "wallpapers"))
    expect(pickerStart("", cwd)).toBe(cwd)
    expect(pickerStart("https://example.com/a.png", cwd)).toBe(cwd)
  })

  test("only suggests folders that exist, without duplicates", () => {
    const home = path.resolve("/home/nik")
    const present = new Set([home, path.join(home, "Pictures"), path.join(home, "Downloads")])
    const folders = suggestedFolders(home, home, (target) => present.has(path.resolve(target)))
    expect(folders.map((folder) => folder.label)).toEqual(["Project", "Pictures", "Downloads"])
  })

  test("shortens paths under the home directory", () => {
    // `shortenPath` matches the home prefix with `path.sep`, so a POSIX literal
    // never matches on Windows and the case would fail for the separator rather
    // than for the shortening. Built natively: the assertion is about what the
    // function does, not about which slash the host uses.
    const home = path.join(path.sep, "Users", "nik")
    expect(shortenPath(path.join(home, "Pictures"), home)).toBe(`~${path.sep}Pictures`)
    expect(shortenPath(home, home)).toBe("~")

    const outside = path.join(path.sep, "etc")
    expect(shortenPath(outside, home)).toBe(outside)
  })
})

describe("background store", () => {
  function fakeKV() {
    const values: Record<string, unknown> = {}
    return {
      get: <Value>(key: string, fallback?: Value) => (values[key] ?? fallback) as Value,
      set: (key: string, value: unknown) => {
        values[key] = value
      },
    }
  }

  test("patches settings without dropping the other fields", () => {
    const kv = fakeKV()
    expect(readSettings(kv)).toEqual(DEFAULT_SETTINGS)
    writeSettings(kv, { source: "/tmp/a.png" })
    writeSettings(kv, { opacity: 0.5 })
    expect(readSettings(kv)).toEqual({ ...DEFAULT_SETTINGS, source: "/tmp/a.png", opacity: 0.5 })
  })
})
