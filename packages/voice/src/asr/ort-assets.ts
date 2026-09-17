/**
 * The ONNX runtime's own WebAssembly, served from the application rather than
 * from a CDN.
 *
 * parakeet.js, finding `ort.env.wasm.wasmPaths` unset, points the runtime at
 * `https://cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/`. Three things
 * are wrong with that here, and the third is the one that bites:
 *
 *   1. The local engine exists to transcribe without sending audio anywhere.
 *      Needing a CDN to *start* contradicts the promise on the first line of
 *      `parakeet-local.ts`.
 *   2. The file is 13–26 MB and is kept only by the HTTP cache, so it comes
 *      back down whenever that cache is cleared — while the model itself, in
 *      IndexedDB, stays put. "It re-downloads something every time" with no
 *      visible progress is this.
 *   3. In the packaged application the content-security policy lists
 *      `'self'` as the only script source. A module fetched from jsDelivr is
 *      refused there and nowhere else — so it works in `native:dev`, where
 *      Vite serves the page and no Tauri policy applies, and fails in the
 *      build.
 *
 * The runtime ships its WebAssembly inside the package, and the bundler can
 * emit it beside the application's own code. `?url` asks Vite for that emitted
 * path; the import is dynamic and guarded so that outside a bundler — under
 * `bun test`, or in a plain browser build — it simply fails and the caller
 * falls back to the previous behaviour rather than the module failing to load.
 *
 * The `jsep` variant covers both accelerators: it is the build with the WebGPU
 * execution provider compiled in, and it still runs the plain WASM path. One
 * file rather than one per backend, which is also the one the ADE bundle
 * already carries.
 */

/** What onnxruntime accepts for `env.wasm.wasmPaths` in its object form. */
export interface OrtWasmPaths {
  readonly wasm: string
  readonly mjs: string
}

let resolved: OrtWasmPaths | undefined | null = null

/**
 * Where the bundler put the runtime, or nothing if there was no bundler.
 *
 * Cached after the first attempt — including the failure — because this is on
 * the path of every model load and a failed dynamic import is not free.
 */
export async function bundledOrtPaths(): Promise<OrtWasmPaths | undefined> {
  if (resolved !== null) return resolved ?? undefined

  try {
    /*
     * Addressed the way the package publishes them, which is *not* through
     * `dist/`: onnxruntime's `exports` map names each runtime file at the top
     * level and exposes nothing else, so a `dist/…` specifier is refused by
     * the resolver with "Missing specifier" at build time.
     */
    const [wasm, mjs] = await Promise.all([
      import("onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url"),
      import("onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url"),
    ])
    const wasmUrl = (wasm as { default?: unknown }).default
    const mjsUrl = (mjs as { default?: unknown }).default
    resolved = typeof wasmUrl === "string" && typeof mjsUrl === "string" ? { wasm: wasmUrl, mjs: mjsUrl } : undefined
  } catch {
    resolved = undefined
  }

  return resolved ?? undefined
}
