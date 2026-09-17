/**
 * Reading a plugin declaration, without touching a disk.
 *
 * Everything here is a pure function over strings and already-parsed JSON.
 * That is the whole reason the module exists: `plugin-spec.ts` reaches for
 * zod and `plugin-shared.ts` reaches for `fs`, `path` and `url`, and neither
 * can be imported by a renderer — ADE runs inside a WebView2 process with no
 * Node built-ins and a bundle budget that does not want a schema library for
 * three accessors.
 *
 * Both of those modules now source their readers from here, so ADE and the TUI
 * agree on what a spec is and where a plugin's entrypoint is declared, rather
 * than each having its own opinion that drifts.
 */
import { isRecord } from "@nikcli-ai/util/record"

/**
 * A plugin as config names it: a bare specifier, or a `[specifier, options]`
 * pair.
 *
 * Structural, and deliberately not the zod-inferred `PluginSpec` — it is the
 * same type, expressed without the schema, so importing it costs nothing.
 */
export type PluginSpecValue = string | [string, Record<string, unknown>]

export function pluginSpecifier(plugin: string | PluginSpecValue) {
  if (typeof plugin === "string") return plugin
  return plugin[0]
}

export function pluginOptions(plugin: string | PluginSpecValue) {
  if (typeof plugin === "string") return
  return plugin[1]
}

/**
 * The string behind one `exports` entry, however it was written.
 *
 * An export target is either a path or a conditions object; `import` wins over
 * `default` because a plugin is always loaded as ESM, by the terminal and by
 * the webview alike.
 */
export function extractExportValue(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!isRecord(value)) return undefined
  for (const key of ["import", "default"]) {
    const nested = value[key]
    if (typeof nested === "string") return nested
  }
  return undefined
}

/**
 * Where a package declares its entrypoint for one surface, as a path relative
 * to the package, or `undefined` when it declares none.
 *
 * This is what makes one published plugin serve both surfaces: `./tui` is the
 * terminal's entry and `./ade` is the desktop's, and a package that exports
 * only one is simply not offered to the other.
 */
export function pluginExportEntry(json: Record<string, unknown>, kind: string): string | undefined {
  if (!isRecord(json.exports)) return undefined
  return extractExportValue(json.exports[`./${kind}`])
}

/** Whether a package declares an entrypoint for one surface at all. */
export function hasPluginExport(json: Record<string, unknown>, kind: string): boolean {
  if (!isRecord(json.exports)) return false
  return `./${kind}` in json.exports
}
