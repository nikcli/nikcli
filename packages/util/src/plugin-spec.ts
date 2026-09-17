import z from "zod"

/**
 * How a plugin is named in config, and how to read one.
 *
 * A spec is either a bare specifier or a `[specifier, options]` pair. Both the config loader and
 * the TUI's plugin runtime destructure it, and the two accessors below are the whole of that
 * knowledge — `Config.pluginSpecifier` and `Config.pluginOptions` re-export them, so nothing has
 * to load the config module to read a tuple.
 *
 * The `ref` annotations are load-bearing: they name these schemas in the generated OpenAPI.
 */
export const PluginOptions = z.record(z.string(), z.unknown()).meta({
  ref: "PluginOptionsConfig",
})
export type PluginOptions = z.infer<typeof PluginOptions>

export const PluginSpec = z.union([z.string(), z.tuple([z.string(), PluginOptions])]).meta({
  ref: "PluginSpecConfig",
})
export type PluginSpec = z.infer<typeof PluginSpec>

/*
 * The two accessors live in `plugin-read.ts` and are re-exported here.
 *
 * Nothing about reading a tuple needs a schema library, and ADE — which runs
 * in a webview and must not bundle zod — needs exactly these two. Keeping the
 * import path callers already use means the move cost nobody anything.
 */
export { pluginOptions, pluginSpecifier } from "@nikcli-ai/util/plugin-read"
