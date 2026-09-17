/**
 * Finding the plugins a project declares, from inside a webview.
 *
 * Why this is not `TuiPluginRuntime`
 * ---------------------------------
 * It was the first thing tried, and it cannot work. The TUI's discovery reads
 * the config through `pluginHost()` (an HTTP call to the nikcli server, which
 * ADE does not run), resolves specifiers with `resolvePluginTarget` (which
 * shells out to `bun install`), walks packages with `fs`, `path` and
 * `pathToFileURL`, watches sources with `fs.watch`, and finally does
 * `import("C:\\…\\index.ts")` — a bare filesystem path, which only a runtime
 * with a module loader over the disk can do. A WebView2 renderer has none of
 * that: no `fs`, no `path`, no `url`, no Bun, and `import()` resolves against
 * an HTTP(S) origin.
 *
 * So the mechanism is split rather than duplicated:
 *
 *  - **The declaration is the same one.** Plugins are listed in the project's
 *    `.nikcli/tui.json` under `plugin`, in the same `[spec]` /
 *    `[spec, options]` form, read with the same `pluginSpecifier` and
 *    `pluginOptions` the TUI uses (now in `@nikcli-ai/util/plugin-read`, so
 *    there is one definition and not two). Which surface a plugin serves is
 *    the package's own declaration: `exports["./tui"]` is the terminal's
 *    entry, `exports["./ade"]` is this one, and a package that declares only
 *    the first is simply not offered here. `pluginExportEntry` — the function
 *    the TUI's `resolvePluginEntrypoint` calls — makes that decision for both.
 *
 *  - **The I/O goes through Tauri**, and through commands that already exist:
 *    `read_text_file` and `path_exists`, reached through `host/shell.ts`. No
 *    new Rust, and nothing here touches the disk directly.
 *
 *  - **Path arithmetic is URL arithmetic.** `path.resolve` plus
 *    `Filesystem.contains` becomes `new URL(relative, base)` plus a prefix
 *    check on the resolved href. Same policy — an entrypoint may not escape
 *    its own package directory — expressed in the only vocabulary this
 *    environment has.
 *
 * npm specifiers are refused rather than half-supported: resolving one means
 * installing it, which is `bun install`, which is the host's job. The refusal
 * carries a reason so it can be shown rather than guessed at.
 */
import { pluginOptions, pluginSpecifier, pluginExportEntry, type PluginSpecValue } from "@nikcli-ai/util/plugin-read"

/** Which surface this discovery is for. The TUI passes `"tui"` for its own. */
export const ADE_EXPORT_KIND = "ade"

/** The config file ADE reads, relative to the project root. */
export const CONFIG_RELATIVE_PATH = ".nikcli/tui.json"

export interface DeclaredPlugin {
  readonly spec: string
  readonly options?: Record<string, unknown>
}

export interface ResolvedPlugin extends DeclaredPlugin {
  /** A `file://` URL for the module to import. */
  readonly entry: string
}

export interface RejectedPlugin extends DeclaredPlugin {
  /** Italian, because it is shown. */
  readonly reason: string
}

export type DiscoveryResult = {
  readonly resolved: ResolvedPlugin[]
  readonly rejected: RejectedPlugin[]
}

/** The slice of `host/shell.ts` discovery needs. Injected, so tests need no Tauri. */
export interface DiscoveryIO {
  readTextFile: (path: string, maxBytes?: number) => Promise<{ text: string }>
  exists: (path: string) => Promise<boolean>
}

/**
 * The declared plugin list in one config document.
 *
 * `JSON.parse`, not a JSONC reader: the file ADE reads is written by
 * `patchPluginConfig`, which emits plain JSON, and pulling a parser into the
 * webview to tolerate comments nobody writes is not a trade worth making. A
 * file that will not parse yields no plugins rather than an exception — a
 * half-edited config must not stop ADE from starting.
 */
export function parseDeclaredPlugins(text: string): DeclaredPlugin[] {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof document !== "object" || document === null) return []
  const list = (document as { plugin?: unknown }).plugin
  if (!Array.isArray(list)) return []

  const out: DeclaredPlugin[] = []
  for (const item of list) {
    if (typeof item !== "string" && !Array.isArray(item)) continue
    const spec = pluginSpecifier(item as PluginSpecValue)
    if (typeof spec !== "string" || !spec.trim()) continue
    const options = pluginOptions(item as PluginSpecValue)
    out.push(options ? { spec: spec.trim(), options } : { spec: spec.trim() })
  }
  return out
}

/** Whether a specifier names something on this machine rather than a package. */
export function isPathSpec(spec: string): boolean {
  return spec.startsWith("file://") || spec.startsWith(".") || spec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec)
}

/**
 * A path or `file://` specifier as a URL, resolved against the project root.
 *
 * Windows backslashes are normalised first: `new URL` treats `\` as an
 * ordinary character, so `C:\x\y` would become a single opaque segment and
 * every relative resolution against it would land in the wrong place.
 */
export function specToUrl(spec: string, projectRoot: string): string | undefined {
  try {
    if (spec.startsWith("file://")) return new URL(spec).href
    const slashed = spec.replace(/\\/g, "/")
    if (/^[A-Za-z]:\//.test(slashed)) return new URL(`file:///${slashed}`).href
    if (slashed.startsWith("/")) return new URL(`file://${slashed}`).href
    const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "")
    const base = /^[A-Za-z]:\//.test(root) ? `file:///${root}/` : `file://${root}/`
    return new URL(slashed, base).href
  } catch {
    return undefined
  }
}

/** The directory a URL lives in, with a trailing slash so it is a valid base. */
function directoryOf(url: string): string {
  return url.slice(0, url.lastIndexOf("/") + 1)
}

/** A `file://` URL back to something `read_text_file` will accept. */
export function urlToPath(url: string): string {
  const raw = decodeURIComponent(url.replace(/^file:\/\//, ""))
  // `file:///C:/x` leaves a leading slash in front of the drive letter, which
  // Windows will not open.
  return /^\/[A-Za-z]:/.test(raw) ? raw.slice(1) : raw
}

/**
 * A package manifest's ADE entry, resolved and contained.
 *
 * Returns the reason on failure rather than throwing: one broken plugin in a
 * list of five must not cost the other four.
 */
export function resolveManifestEntry(
  manifestUrl: string,
  manifestText: string,
): { entry: string } | { reason: string } {
  let json: unknown
  try {
    json = JSON.parse(manifestText)
  } catch {
    return { reason: "package.json non è JSON valido" }
  }
  if (typeof json !== "object" || json === null) return { reason: "package.json non è un oggetto" }

  const raw = pluginExportEntry(json as Record<string, unknown>, ADE_EXPORT_KIND)
  if (!raw) return { reason: `il pacchetto non dichiara exports["./${ADE_EXPORT_KIND}"]` }

  const base = directoryOf(manifestUrl)
  let resolved: string
  try {
    resolved = new URL(raw, base).href
  } catch {
    return { reason: `exports["./${ADE_EXPORT_KIND}"] non è un percorso valido` }
  }
  // The same rule `resolvePluginEntrypoint` enforces with `Filesystem.contains`:
  // a plugin may not point its entrypoint at a file outside its own directory.
  if (!resolved.startsWith(base)) {
    return { reason: "l'entrypoint del plugin esce dalla cartella del pacchetto" }
  }
  return { entry: resolved }
}

/**
 * Turns one declared plugin into something importable.
 *
 * A specifier may name the module directly (it ends in a JavaScript
 * extension) or a package directory, in which case its `package.json` decides.
 */
export async function resolveDeclaredPlugin(
  declared: DeclaredPlugin,
  projectRoot: string,
  io: DiscoveryIO,
): Promise<ResolvedPlugin | RejectedPlugin> {
  if (!isPathSpec(declared.spec)) {
    return {
      ...declared,
      reason:
        "i plugin npm non si possono installare dalla finestra desktop: aggiungilo dal terminale, poi riapri ADE",
    }
  }

  const url = specToUrl(declared.spec, projectRoot)
  if (!url) return { ...declared, reason: "percorso del plugin non valido" }

  if (/\.(m?js|mjs|jsx)$/i.test(url)) {
    if (!(await io.exists(urlToPath(url)))) return { ...declared, reason: "il file del plugin non esiste" }
    return { ...declared, entry: url }
  }

  const manifestUrl = new URL("package.json", url.endsWith("/") ? url : `${url}/`).href
  const manifestPath = urlToPath(manifestUrl)
  if (!(await io.exists(manifestPath))) {
    return { ...declared, reason: "la cartella del plugin non contiene un package.json" }
  }

  const manifest = await io.readTextFile(manifestPath).catch(() => undefined)
  if (!manifest) return { ...declared, reason: "package.json non è leggibile" }

  const outcome = resolveManifestEntry(manifestUrl, manifest.text)
  if ("reason" in outcome) return { ...declared, reason: outcome.reason }

  if (!(await io.exists(urlToPath(outcome.entry)))) {
    return { ...declared, reason: "l'entrypoint dichiarato non esiste" }
  }
  return { ...declared, entry: outcome.entry }
}

/** Everything the project declares, sorted into what loads and what does not. */
export async function discoverPlugins(projectRoot: string, io: DiscoveryIO): Promise<DiscoveryResult> {
  const configPath = urlToPath(specToUrl(CONFIG_RELATIVE_PATH, projectRoot) ?? "")
  if (!configPath || !(await io.exists(configPath))) return { resolved: [], rejected: [] }

  const config = await io.readTextFile(configPath).catch(() => undefined)
  if (!config) return { resolved: [], rejected: [] }

  const resolved: ResolvedPlugin[] = []
  const rejected: RejectedPlugin[] = []
  for (const declared of parseDeclaredPlugins(config.text)) {
    const outcome = await resolveDeclaredPlugin(declared, projectRoot, io)
    if ("entry" in outcome) resolved.push(outcome)
    else rejected.push(outcome)
  }
  return { resolved, rejected }
}
