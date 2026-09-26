import { dlopen, FFIType, ptr as rawPtr, toArrayBuffer, CString, suffix, JSCallback, type Pointer } from "bun:ffi"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function resolveLibraryPath(): string {
  const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so"
  const candidates = [
    resolve(__dirname, `../native/target/release/libwebrenderer.${ext}`),
    resolve(__dirname, `./libwebrenderer.${ext}`),
    resolve(__dirname, `../native/libwebrenderer-${process.platform}-${process.arch}.${ext}`),
  ]

  for (const candidate of candidates) {
    try {
      const file = Bun.file(candidate)
      if (file.size > 0) return candidate
    } catch {
      continue
    }
  }

  throw new Error(
    `webrenderer native library not found. Searched:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
      `Run: cd packages/webrenderer/native && cargo build --release`,
  )
}

const LIB_PATH = resolveLibraryPath()

const lib = dlopen(LIB_PATH, {
  // Lifecycle
  wr_init: { args: [], returns: FFIType.ptr },
  wr_pump: { args: [FFIType.ptr], returns: FFIType.i32 },
  wr_destroy: { args: [FFIType.ptr], returns: FFIType.void },

  // WebView management
  wr_webview_create: {
    args: [FFIType.ptr, FFIType.cstring, FFIType.i32, FFIType.i32, FFIType.function, FFIType.ptr],
    returns: FFIType.u32,
  },
  wr_webview_navigate: { args: [FFIType.ptr, FFIType.u32, FFIType.cstring], returns: FFIType.void },
  wr_webview_set_html: { args: [FFIType.ptr, FFIType.u32, FFIType.cstring], returns: FFIType.void },
  wr_webview_eval_js: { args: [FFIType.ptr, FFIType.u32, FFIType.cstring], returns: FFIType.void },
  wr_webview_resize: { args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32], returns: FFIType.void },
  wr_webview_destroy_by_id: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.void },

  // Screenshot
  wr_webview_screenshot: { args: [FFIType.ptr, FFIType.u32, FFIType.u8, FFIType.u8], returns: FFIType.ptr },
  wr_buffer_free: { args: [FFIType.ptr], returns: FFIType.void },

  // Input injection
  wr_webview_mouse_down: {
    args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u8],
    returns: FFIType.void,
  },
  wr_webview_mouse_up: {
    args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u8],
    returns: FFIType.void,
  },
  wr_webview_mouse_move: { args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32], returns: FFIType.void },
  wr_webview_mouse_wheel: {
    args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.f64, FFIType.f64],
    returns: FFIType.void,
  },
  wr_webview_key_down: { args: [FFIType.ptr, FFIType.u32, FFIType.cstring, FFIType.u8], returns: FFIType.void },
  wr_webview_insert_text: { args: [FFIType.ptr, FFIType.u32, FFIType.cstring], returns: FFIType.void },

  // Standalone image processing
  wr_decode_png: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  wr_resize_rgba: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.ptr,
  },
  wr_free_buffer: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
})

// Types

export interface RgbaBuffer {
  data: Uint8ClampedArray
  width: number
  height: number
}

// Singleton App Instance

let appPtr: Pointer | bigint | null = null
let pumpTimer: ReturnType<typeof setInterval> | null = null

function getApp(): Pointer | bigint {
  if (!appPtr) {
    appPtr = lib.symbols.wr_init()
    if (!appPtr || appPtr === 0) {
      throw new Error("Failed to initialize webrenderer native runtime")
    }
    // Pump event loop at ~60fps from main thread
    pumpTimer = setInterval(() => {
      if (appPtr) lib.symbols.wr_pump(appPtr as any)
    }, 16)
  }
  return appPtr
}

// Helpers

function toCString(str: string): Buffer {
  return Buffer.from(str + "\0")
}

// Public API

const noopCallback = new JSCallback((_eventPtr: number, _userData: number) => {}, {
  args: [FFIType.ptr, FFIType.ptr],
  returns: FFIType.void,
})

/**
 * Create a new webview instance.
 * Returns the webview ID (used for all subsequent operations).
 */
export function createWebview(url: string | null, width: number, height: number): number {
  const app = getApp()
  const urlBuf = url ? toCString(url) : null

  const id = lib.symbols.wr_webview_create(app, urlBuf ? rawPtr(urlBuf) : null, width, height, noopCallback, null)

  if (id === 0) {
    throw new Error("Failed to create webview")
  }
  return id
}

export function navigate(webviewId: number, url: string): void {
  const app = getApp()
  lib.symbols.wr_webview_navigate(app, webviewId, toCString(url))
}

export function setHtml(webviewId: number, html: string): void {
  const app = getApp()
  lib.symbols.wr_webview_set_html(app, webviewId, toCString(html))
}

export function evalJs(webviewId: number, js: string): void {
  const app = getApp()
  lib.symbols.wr_webview_eval_js(app, webviewId, toCString(js))
}

export function resizeWebview(webviewId: number, width: number, height: number): void {
  const app = getApp()
  lib.symbols.wr_webview_resize(app, webviewId, width, height)
}

/**
 * Capture a screenshot of the webview.
 * Returns RGBA pixel buffer or null on failure.
 */
export function captureScreenshot(webviewId: number, format: "png" | "jpeg" = "jpeg", quality = 80): RgbaBuffer | null {
  const app = getApp()
  const bufPtr = lib.symbols.wr_webview_screenshot(app, webviewId, format === "jpeg" ? 1 : 0, quality)

  if (!bufPtr || bufPtr === 0) return null

  // Read WrBuffer struct layout (24 bytes on arm64):
  // [data: ptr u64] [len: usize u64] [width: u32] [height: u32]
  const view = new DataView(toArrayBuffer(bufPtr, 0, 24))
  const dataPtr = Number(view.getBigUint64(0, true))
  const dataLen = Number(view.getBigUint64(8, true))
  const width = view.getUint32(16, true)
  const height = view.getUint32(20, true)

  // Copy pixel data before freeing the buffer
  const pixels = new Uint8ClampedArray(toArrayBuffer(dataPtr as any, 0, dataLen))
  const copy = new Uint8ClampedArray(pixels)
  lib.symbols.wr_buffer_free(bufPtr as any)

  return { data: copy, width, height }
}

export function destroyWebview(webviewId: number): void {
  const app = getApp()
  lib.symbols.wr_webview_destroy_by_id(app, webviewId)
}

export function destroyRuntime(): void {
  if (pumpTimer) {
    clearInterval(pumpTimer)
    pumpTimer = null
  }
  if (appPtr) {
    lib.symbols.wr_destroy(appPtr as any)
    appPtr = null
  }
}

// Input Injection

export function mouseDown(webviewId: number, x: number, y: number, button: number): void {
  lib.symbols.wr_webview_mouse_down(getApp(), webviewId, x, y, button)
}

export function mouseUp(webviewId: number, x: number, y: number, button: number): void {
  lib.symbols.wr_webview_mouse_up(getApp(), webviewId, x, y, button)
}

export function mouseMove(webviewId: number, x: number, y: number): void {
  lib.symbols.wr_webview_mouse_move(getApp(), webviewId, x, y)
}

export function mouseWheel(webviewId: number, x: number, y: number, dx: number, dy: number): void {
  lib.symbols.wr_webview_mouse_wheel(getApp(), webviewId, x, y, dx, dy)
}

export function keyDown(webviewId: number, key: string, modifiers: number): void {
  lib.symbols.wr_webview_key_down(getApp(), webviewId, toCString(key), modifiers)
}

export function insertText(webviewId: number, text: string): void {
  lib.symbols.wr_webview_insert_text(getApp(), webviewId, toCString(text))
}

// Standalone Image Processing (replaces pngjs)

export function decodePng(pngBytes: Uint8Array): RgbaBuffer {
  const wBuf = new Uint32Array(1)
  const hBuf = new Uint32Array(1)

  const pixelPtr = lib.symbols.wr_decode_png(rawPtr(pngBytes), pngBytes.length, rawPtr(wBuf), rawPtr(hBuf))

  if (!pixelPtr || (pixelPtr as unknown as number) === 0) {
    throw new Error("Failed to decode PNG")
  }

  const width = wBuf[0]!
  const height = hBuf[0]!
  const byteLen = width * height * 4

  const pixels = new Uint8ClampedArray(toArrayBuffer(pixelPtr as any, 0, byteLen))
  const copy = new Uint8ClampedArray(pixels)
  lib.symbols.wr_free_buffer(pixelPtr as any, byteLen)

  return { data: copy, width, height }
}

export function resizeRgba(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  newWidth: number,
  newHeight: number,
): RgbaBuffer {
  const lenBuf = new Uint32Array(1)

  const outPtr = lib.symbols.wr_resize_rgba(rawPtr(pixels), width, height, newWidth, newHeight, rawPtr(lenBuf))

  if (!outPtr || outPtr === 0) {
    throw new Error("Failed to resize RGBA buffer")
  }

  const outLen = lenBuf[0]!
  const result = new Uint8ClampedArray(toArrayBuffer(outPtr, 0, outLen))
  const copy = new Uint8ClampedArray(result)
  lib.symbols.wr_free_buffer(outPtr, outLen)

  return { data: copy, width: newWidth, height: newHeight }
}

export { lib }
