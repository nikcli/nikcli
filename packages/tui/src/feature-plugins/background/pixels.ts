/**
 * Pixel math for the background image.
 *
 * The terminal is painted through OpenTUI's native half-block super-sampler
 * (`OptimizedBuffer.drawSuperSampleBuffer`), which consumes a plain RGBA
 * buffer super-sampled 2× on both axes — a 2×2 pixel block per cell, averaged
 * horizontally into the two halves of a `▀`. This module turns a decoded
 * image into exactly that buffer: crop to the terminal aspect, resample, then
 * blend over the theme background so text stays readable. In the default
 * `flat` mode the two halves of a cell are averaged together, because the
 * renderable then paints a space rather than a `▀` — see {@link flatten}.
 *
 * Everything here is pure and synchronous so it can be unit-tested without a
 * renderer or a real image file.
 */
import { createPixelImage, type PixelImage } from "@nikcli-ai/tui-image"
import type { BackgroundDetail, BackgroundFit } from "./settings"

export type Rect = { x: number; y: number; width: number; height: number }

export type Rgb = { r: number; g: number; b: number }

export type ComposeOptions = {
  /** Terminal size in cells. */
  columns: number
  rows: number
  fit: BackgroundFit
  /** 0..1 — how strongly the image shows through `base`. */
  opacity: number
  grayscale: boolean
  /** Theme background the image is blended over. */
  base: Rgb
  /**
   * `flat` (the default) collapses each cell to a single color, so the
   * renderable can drop the `▀` glyph without losing anything.
   */
  detail?: BackgroundDetail
}

/** Super-sampling factor the native half-block renderer expects, per axis. */
export const SAMPLES_PER_CELL = 2

/** Byte length of the pixel buffer for a `columns × rows` terminal. */
export function bufferSize(columns: number, rows: number) {
  return columns * SAMPLES_PER_CELL * rows * SAMPLES_PER_CELL * 4
}

/** Row stride, in bytes, of the pixel buffer for `columns` cells. */
export function bufferStride(columns: number) {
  return columns * SAMPLES_PER_CELL * 4
}

/**
 * Largest side we keep after decoding. Terminals top out around 400 columns,
 * so a 1024px working copy is always oversampled; capping it keeps every
 * later resample (one per terminal resize) in the sub-millisecond range.
 */
export const MAX_WORKING_SIDE = 1024

/** Source rectangle and destination box for a `cover` / `contain` fit. */
export function placement(
  source: { width: number; height: number },
  target: { width: number; height: number },
  fit: BackgroundFit,
): { rect: Rect; x: number; y: number; width: number; height: number } {
  const sourceAspect = source.width / source.height
  const targetAspect = target.width / target.height

  if (fit === "cover") {
    let cropWidth = source.width
    let cropHeight = source.height
    if (sourceAspect > targetAspect) cropWidth = Math.max(1, Math.round(source.height * targetAspect))
    else cropHeight = Math.max(1, Math.round(source.width / targetAspect))
    return {
      rect: {
        x: Math.floor((source.width - cropWidth) / 2),
        y: Math.floor((source.height - cropHeight) / 2),
        width: cropWidth,
        height: cropHeight,
      },
      x: 0,
      y: 0,
      width: target.width,
      height: target.height,
    }
  }

  const scale = Math.min(target.width / source.width, target.height / source.height)
  const width = Math.max(1, Math.min(target.width, Math.round(source.width * scale)))
  const height = Math.max(1, Math.min(target.height, Math.round(source.height * scale)))
  return {
    rect: { x: 0, y: 0, width: source.width, height: source.height },
    x: Math.floor((target.width - width) / 2),
    y: Math.floor((target.height - height) / 2),
    width,
    height,
  }
}

/**
 * Box-average resample of `rect` into a `width × height` image. Averaging
 * (rather than the bilinear sampler in `@nikcli-ai/tui-image`) matters here:
 * a 4000px photo shrunk to ~200 cells aliases badly when point-sampled.
 */
export function resample(image: PixelImage, rect: Rect, width: number, height: number): PixelImage {
  if (width <= 0 || height <= 0) throw new RangeError(`target must be positive, got ${width}x${height}`)
  const out = createPixelImage(width, height)
  const left = Math.max(0, Math.min(image.width - 1, Math.floor(rect.x)))
  const top = Math.max(0, Math.min(image.height - 1, Math.floor(rect.y)))
  const right = Math.max(left + 1, Math.min(image.width, Math.round(rect.x + rect.width)))
  const bottom = Math.max(top + 1, Math.min(image.height, Math.round(rect.y + rect.height)))
  const spanX = right - left
  const spanY = bottom - top

  for (let y = 0; y < height; y++) {
    const y0 = top + Math.floor((y * spanY) / height)
    const y1 = Math.max(y0 + 1, top + Math.ceil(((y + 1) * spanY) / height))
    for (let x = 0; x < width; x++) {
      const x0 = left + Math.floor((x * spanX) / width)
      const x1 = Math.max(x0 + 1, left + Math.ceil(((x + 1) * spanX) / width))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = y0; sy < y1 && sy < bottom; sy++) {
        for (let sx = x0; sx < x1 && sx < right; sx++) {
          const index = (sy * image.width + sx) * 4
          r += image.data[index] ?? 0
          g += image.data[index + 1] ?? 0
          b += image.data[index + 2] ?? 0
          a += image.data[index + 3] ?? 0
          count++
        }
      }
      if (count === 0) count = 1
      const target = (y * width + x) * 4
      out.data[target] = Math.round(r / count)
      out.data[target + 1] = Math.round(g / count)
      out.data[target + 2] = Math.round(b / count)
      out.data[target + 3] = Math.round(a / count)
    }
  }
  return out
}

/** Shrink an image so its longest side is at most `maxSide`. */
export function prepare(image: PixelImage, maxSide = MAX_WORKING_SIDE): PixelImage {
  const longest = Math.max(image.width, image.height)
  if (longest <= maxSide) return image
  const scale = maxSide / longest
  return resample(
    image,
    { x: 0, y: 0, width: image.width, height: image.height },
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  )
}

function luminance(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Build the RGBA buffer handed to the super-sampler. Pixels outside the image
 * (the letterbox of a `contain` fit) stay at the theme background, so the
 * result is always fully opaque and never punches a hole in the UI.
 */
export function compose(image: PixelImage, options: ComposeOptions): Uint8Array {
  const { columns, rows, base } = options
  if (columns <= 0 || rows <= 0) throw new RangeError(`target must be positive, got ${columns}x${rows}`)
  const width = columns * SAMPLES_PER_CELL
  const height = rows * SAMPLES_PER_CELL
  const out = new Uint8Array(width * height * 4)
  for (let i = 0; i < out.length; i += 4) {
    out[i] = base.r
    out[i + 1] = base.g
    out[i + 2] = base.b
    out[i + 3] = 255
  }

  // Fit against the *physical* shape of the terminal — a cell is about twice
  // as tall as it is wide, so the drawable area is `columns × rows * 2` square
  // units. The buffer is `columns * 2 × rows * 2`, i.e. horizontally denser,
  // so the destination box is stretched back out on the x axis.
  const box = placement(image, { width: columns, height: rows * 2 }, options.fit)
  const destination = {
    x: box.x * SAMPLES_PER_CELL,
    y: box.y,
    width: Math.max(1, box.width * SAMPLES_PER_CELL),
    height: Math.max(1, box.height),
  }
  const sampled = resample(image, box.rect, destination.width, destination.height)
  const opacity = Math.min(1, Math.max(0, options.opacity))

  for (let y = 0; y < destination.height; y++) {
    const targetY = destination.y + y
    if (targetY < 0 || targetY >= height) continue
    for (let x = 0; x < destination.width; x++) {
      const targetX = destination.x + x
      if (targetX < 0 || targetX >= width) continue
      const source = (y * destination.width + x) * 4
      let r = sampled.data[source] ?? 0
      let g = sampled.data[source + 1] ?? 0
      let b = sampled.data[source + 2] ?? 0
      const alpha = ((sampled.data[source + 3] ?? 255) / 255) * opacity
      if (options.grayscale) {
        const gray = luminance(r, g, b)
        r = gray
        g = gray
        b = gray
      }
      const target = (targetY * width + targetX) * 4
      out[target] = Math.round(base.r + (r - base.r) * alpha)
      out[target + 1] = Math.round(base.g + (g - base.g) * alpha)
      out[target + 2] = Math.round(base.b + (b - base.b) * alpha)
      out[target + 3] = 255
    }
  }
  if ((options.detail ?? "flat") === "flat") flatten(out, columns, rows)
  return out
}

/**
 * Collapse every cell to a single color, in place.
 *
 * A `flat` background is painted as a space, which can only carry the cell's
 * background color — the half the super-sampler would have put in the
 * foreground is dropped. So the cell's four samples are averaged into one
 * color and written back to all of them: whichever half survives, it is the
 * whole cell's color rather than one shifted half a row up.
 *
 * The cost is the vertical half-resolution the half-block bought, and there is
 * no winning it back: a cell can hold one background color, so one color per
 * cell is the most a screen the terminal can still select and link over will
 * ever carry. Softening the grid to hide the steps only trades the mosaic for
 * mush — `detail: "blocks"` is the way to ask for the sharper image, with the
 * terminal-side cost that comes with it.
 */
function flatten(pixels: Uint8Array, columns: number, rows: number) {
  const stride = bufferStride(columns)
  const samples = SAMPLES_PER_CELL * SAMPLES_PER_CELL
  // Sample offsets relative to a cell's top-left sample, computed once: this
  // runs over every cell of the terminal on each compose, and an array per
  // cell was most of what it allocated.
  const offsets = new Int32Array(samples)
  for (let sampleY = 0; sampleY < SAMPLES_PER_CELL; sampleY++) {
    for (let sampleX = 0; sampleX < SAMPLES_PER_CELL; sampleX++) {
      offsets[sampleY * SAMPLES_PER_CELL + sampleX] = sampleY * stride + sampleX * 4
    }
  }

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const origin = row * SAMPLES_PER_CELL * stride + column * SAMPLES_PER_CELL * 4
      for (let channel = 0; channel < 3; channel++) {
        let total = 0
        for (let i = 0; i < samples; i++) total += pixels[origin + offsets[i]! + channel]!
        const average = Math.round(total / samples)
        for (let i = 0; i < samples; i++) pixels[origin + offsets[i]! + channel] = average
      }
    }
  }
}
