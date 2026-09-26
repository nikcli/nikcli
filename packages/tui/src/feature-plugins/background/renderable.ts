/**
 * `<nikcli_background>` — an OpenTUI renderable that paints an RGBA buffer as
 * a full-screen half-block image.
 *
 * The alternative (a grid of `<text>` cells, the way `bg-pulse.tsx` works) is
 * fine for a few thousand animated cells but not for a photo covering the
 * whole terminal. Here the pixels go straight to the Zig super-sampler, which
 * writes `▀` cells with per-cell foreground/background in one native call.
 *
 * Painting happens into the renderable's own frame buffer and only when the
 * pixels or the size changed; the per-frame cost is the buffer blit that
 * {@link FrameBufferRenderable} already does.
 */
import { FrameBufferRenderable, RGBA, type OptimizedBuffer, type RenderContext } from "@opentui/core"
import { extend } from "@opentui/solid"
import { ptr } from "bun:ffi"
import { bufferSize, bufferStride } from "./pixels"
import { dbg } from "./__debug"

export type BackgroundRenderableOptions = {
  /** Optional: the Solid reconciler assigns size as a prop, after construction. */
  width?: number
  height?: number
  pixels?: Uint8Array
  base?: RGBA
  paintEnabled?: boolean
  flat?: boolean
}

const BLACK = RGBA.fromInts(0, 0, 0, 255)

/** `" "` — what a flat cell holds instead of the half-block glyph. */
const SPACE = 32

export class BackgroundRenderable extends FrameBufferRenderable {
  private _pixels: Uint8Array | undefined
  private _base: RGBA = BLACK
  private _painted = false
  private _paintEnabled = true
  private _flat = true

  constructor(ctx: RenderContext, options: BackgroundRenderableOptions) {
    // The frame buffer must exist before layout runs; it is resized to the
    // real size the first time `onResize` fires.
    super(ctx, {
      ...options,
      width: Math.max(1, options.width ?? 1),
      height: Math.max(1, options.height ?? 1),
      // Solid creates custom elements with only an id, inserts them, and then
      // assigns JSX props. Set the layer here so the renderable can never be
      // inserted at the default z-index and briefly paint over the UI.
      zIndex: -1,
      respectAlpha: false,
    })
    this.selectable = false
    if (options.base) this._base = options.base
    if (options.pixels) this._pixels = options.pixels
    if (options.paintEnabled !== undefined) this._paintEnabled = options.paintEnabled
    if (options.flat !== undefined) this._flat = options.flat
  }

  get pixels(): Uint8Array | undefined {
    return this._pixels
  }

  set pixels(value: Uint8Array | undefined) {
    dbg("set pixels", () => value?.byteLength ?? 0)
    if (this._pixels === value) return
    this._pixels = value
    this._painted = false
    this.requestRender()
  }

  get base(): RGBA {
    return this._base
  }

  set base(value: RGBA) {
    if (this._base === value) return
    this._base = value
    this._painted = false
    this.requestRender()
  }

  /**
   * Whether the last frame actually blitted the image — false while the source
   * is still decoding, or after a resize the pixels have not caught up with.
   * The guard reads it to know its copy of the frame is worth comparing
   * against.
   */
  get painting(): boolean {
    return this._paintEnabled && this._painted
  }

  get flat(): boolean {
    return this._flat
  }

  set flat(value: boolean) {
    if (this._flat === value) return
    this._flat = value
    this._painted = false
    this.requestRender()
  }

  get paintEnabled(): boolean {
    return this._paintEnabled
  }

  set paintEnabled(value: boolean) {
    dbg("set paint enabled", () => value)
    if (this._paintEnabled === value) return
    this._paintEnabled = value
    this.requestRender()
  }

  protected override onResize(width: number, height: number) {
    dbg("onResize", () => [width, height])
    super.onResize(width, height)
    this._painted = false
  }

  /** @returns whether the pixel buffer matched the frame buffer and was drawn. */
  private paint() {
    const pixels = this._pixels
    if (!pixels) return false
    const buffer = this.frameBuffer
    // The native super-sampler reads a 2×2 pixel block per cell and does not
    // bounds-check, so an undersized buffer would read past its end. A
    // mismatch here means the terminal resized and the new pixels have not
    // been composed yet — keep the previous frame instead.
    if (pixels.byteLength !== bufferSize(buffer.width, buffer.height)) {
      dbg("paint size mismatch", () => [pixels.byteLength, bufferSize(buffer.width, buffer.height)])
      return false
    }
    buffer.clear(this._base)
    buffer.drawSuperSampleBuffer(0, 0, ptr(pixels), pixels.byteLength, "rgba8unorm", bufferStride(buffer.width))
    // The super-sampler writes a `▀` into every cell: the foreground is the top
    // half, the background the bottom. That glyph is what the terminal's own
    // text layer sees where it expects blank space — selection copies blocks,
    // and link detection runs a path together with whatever sits left of it,
    // because OpenTUI leaves a cell untouched when the UI draws a space over
    // it. Blanking the char keeps the cell's color (it lives in the
    // background) and hands the terminal a screen it can read. `compose` has
    // already averaged the two halves, so nothing else is lost.
    if (this._flat) buffer.buffers.char.fill(SPACE)
    return true
  }

  protected override renderSelf(buffer: OptimizedBuffer) {
    // Do not use Renderable.visible for toggling the wallpaper. OpenTUI may
    // rebuild layout/render ordering when a node re-enters the visible tree;
    // keeping this node present and only skipping its blit preserves z-order.
    if (!this._paintEnabled) return
    if (!this._painted) {
      this._painted = this.paint()
      dbg("paint", () => ({
        painted: this._painted,
        size: [this.width, this.height],
        fb: [this.frameBuffer.width, this.frameBuffer.height],
        px: this._pixels?.byteLength ?? 0,
        target: [buffer.width, buffer.height],
      }))
      if (!this._painted) return
    }
    super.renderSelf(buffer)
  }
}

extend({ nikcli_background: BackgroundRenderable })
