/**
 * Turning a resolved plugin entrypoint into a live module.
 *
 * This is the one step that has no TUI counterpart worth copying. The TUI
 * does `import(entry)` where `entry` is a `file://` URL and the runtime is Bun,
 * which will happily load a `.ts` file off the disk and transpile it. A
 * WebView2 renderer will do neither: `file://` is not the window's origin, and
 * there is no transpiler behind the import.
 *
 * What it can do is fetch through Tauri's asset protocol, which is exactly
 * what `convertFileSrc` exists for — it rewrites a filesystem path into a URL
 * the webview is allowed to request. Two conditions follow, and both are real
 * deployment requirements rather than details:
 *
 *   1. The application's capabilities must grant `assetProtocol` for the
 *      directories plugins live in. Without it the request is refused and the
 *      import rejects; the runtime reports that as the plugin's load error,
 *      which is the right place for it to show up.
 *   2. A plugin must ship **JavaScript**. `discovery.ts` only accepts an entry
 *      ending in a JavaScript extension for that reason — a `.ts` entrypoint
 *      would 200 with a MIME type the webview will not execute, and the error
 *      ("failed to fetch dynamically imported module") says nothing about why.
 *
 * Neither condition can be checked from a terminal, so this module is the
 * boundary where headless verification stops.
 */

/** Whether this build is running inside the desktop shell at all. */
function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
}

/** A `file://` URL as a filesystem path `convertFileSrc` will accept. */
function toPath(entry: string): string {
  const raw = decodeURIComponent(entry.replace(/^file:\/\//, ""))
  return /^\/[A-Za-z]:/.test(raw) ? raw.slice(1) : raw
}

/**
 * Imports a plugin module, or throws with something a user can act on.
 *
 * The `@vite-ignore` is load-bearing: without it Vite tries to resolve the
 * specifier at build time, fails, and turns a runtime capability into a build
 * error about a module that does not exist yet by definition.
 */
export async function importPluginModule(entry: string): Promise<Record<string, unknown>> {
  if (!inTauri()) {
    throw new Error("i plugin di progetto si caricano solo nell'app desktop")
  }
  const { convertFileSrc } = await import("@tauri-apps/api/core")
  const url = convertFileSrc(toPath(entry))
  const module = (await import(/* @vite-ignore */ url)) as Record<string, unknown>
  return module
}
