import { Effect, Schema } from "effect"
import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { createTwoFilesPatch } from "diff"
import { zod } from "@nikcli-ai/util/effect-zod"
import { Global } from "@nikcli-ai/util/global"
import { Flag } from "@nikcli-ai/util/flag"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import { Tool } from "./tool"
import DESCRIPTION from "./plugin.txt"
import { buildFileDiff, trimDiff } from "./file-diff"
import { BunProc } from "../bun"
import { Plugin } from "../plugin"
import { InstanceReload } from "../project/reload"
import { locallyInstance, runPromiseWithLayer, withInstanceAsync, type InstanceContext } from "@/effect"

const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "update", "list", "reload", "remove"]).annotate({
    description: "What to do. create/update need name and source; remove needs name.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "Plugin name, kebab-case (e.g. desktop-notify). Becomes the folder name.",
  }),
  description: Schema.optional(Schema.String).annotate({
    description: "One line saying what the plugin does; stored in its package.json.",
  }),
  source: Schema.optional(Schema.String).annotate({
    description: "Complete TypeScript source of the plugin's index.ts (create/update).",
  }),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: 'npm dependencies to install for the plugin, e.g. {"node-notifier": "^10.0.1"}.',
  }),
  scope: Schema.optional(Schema.Literals(["global", "project"])).annotate({
    description: 'Where the plugin lives: "global" (default, every project) or "project" (this project only).',
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Scope = "global" | "project"

type Metadata = {
  action: Params["action"]
  name?: string
  folder?: string
  /** The entry file written by create/update, and the change made to it. */
  filepath?: string
  diff?: string
  loaded?: boolean
  plugins?: Plugin.Status[]
}

export namespace PluginScaffold {
  export const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
  /** Folder names the config loader does not treat as server plugins. */
  const RESERVED = new Set(["tui", "node_modules"])

  export function validateName(name: string | undefined): string {
    if (!name) throw new Error("`name` is required for this action.")
    if (name.length > 64 || !NAME.test(name)) {
      throw new Error(`Invalid plugin name "${name}": use kebab-case, e.g. "desktop-notify".`)
    }
    if (RESERVED.has(name)) throw new Error(`"${name}" is reserved; choose another plugin name.`)
    return name
  }

  /**
   * Parse the source before anything touches disk, so a syntax error comes
   * back to the model as a tool error instead of as a plugin that fails to
   * load after it was installed.
   */
  export function checkSource(source: string | undefined): string {
    if (!source?.trim()) throw new Error("`source` is required: the full TypeScript of the plugin's index.ts.")
    let exports: string[]
    try {
      exports = new Bun.Transpiler({ loader: "ts" }).scan(source).exports
    } catch (error) {
      throw new Error(`The plugin source does not parse: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (exports.length === 0) {
      throw new Error(
        "The plugin source exports nothing. Export the plugin function, e.g. `export const MyPlugin: Plugin = async (ctx) => ({ ... })`.",
      )
    }
    return source
  }

  /**
   * The config directory a scope writes into. Project scope uses the nearest
   * existing `.nikcli` between the working directory and the worktree root —
   * the one the config loader already reads — and otherwise creates one at
   * the root of the project.
   */
  export function configRoot(scope: Scope, instance: InstanceContext): string {
    if (scope === "global") return Global.Path.config
    if (Flag.NIKCLI_DISABLE_PROJECT_CONFIG) {
      throw new Error('Project config is disabled (NIKCLI_DISABLE_PROJECT_CONFIG); use scope "global".')
    }
    const stop = instance.worktree === "/" ? instance.directory : instance.worktree
    let current = instance.directory
    while (true) {
      const candidate = path.join(current, ".nikcli")
      if (existsSync(candidate)) return candidate
      if (current === stop || !Filesystem.contains(stop, current)) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return path.join(stop, ".nikcli")
  }

  export function folderOf(scope: Scope, instance: InstanceContext, name: string) {
    return path.join(configRoot(scope, instance), "plugins", name)
  }

  /** The package.json a plugin folder carries: identity, entry, dependencies. */
  export function manifest(
    name: string,
    previous: Record<string, unknown> | undefined,
    input: { description?: string; dependencies?: Record<string, string> },
  ) {
    const dependencies = {
      ...(previous?.dependencies as Record<string, string> | undefined),
      ...input.dependencies,
    }
    return {
      ...previous,
      name: `nikcli-plugin-${name}`,
      version: typeof previous?.version === "string" ? previous.version : "0.1.0",
      private: true,
      type: "module",
      main: "index.ts",
      description: input.description ?? previous?.description ?? "",
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    }
  }

  export function formatStatus(plugins: readonly Plugin.Status[]): string {
    if (plugins.length === 0) return "No plugins are configured."
    return plugins
      .map((plugin) => {
        const where = plugin.source === "file" ? new URL(plugin.spec).pathname : plugin.spec
        if (plugin.error) return `- ${plugin.name} — FAILED: ${plugin.error}\n  ${where}`
        const hooks = plugin.hooks.length > 0 ? plugin.hooks.join(", ") : "none"
        const tools = plugin.tools.length > 0 ? plugin.tools.join(", ") : "none"
        return `- ${plugin.name} — loaded; hooks: ${hooks}; tools: ${tools}\n  ${where}`
      })
      .join("\n")
  }
}

function pluginStatus(instance: InstanceContext) {
  return runPromiseWithLayer(
    Plugin.defaultLayer,
    locallyInstance(
      instance,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        return yield* plugin.status()
      }),
    ),
  )
}

/** Hot reload the instance — config, then plugins — and report what is live. */
async function reloadAndReport(instance: InstanceContext, files: string[]) {
  await withInstanceAsync({ directory: instance.directory }, () => InstanceReload.reload(instance.directory, files))
  return pluginStatus(instance)
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  return Bun.file(file)
    .json()
    .catch(() => undefined)
}

export const PluginTool = Tool.define("plugin", {
  description: DESCRIPTION,
  parameters: zod(Parameters),
  async execute(params, ctx): Promise<Tool.Result<Metadata>> {
    const instance = ctx.instance

    if (params.action === "list") {
      const plugins = await pluginStatus(instance)
      return {
        title: `${plugins.length} plugin${plugins.length === 1 ? "" : "s"}`,
        output: PluginScaffold.formatStatus(plugins),
        metadata: { action: params.action, plugins },
      }
    }

    if (params.action === "reload") {
      const plugins = await reloadAndReport(instance, [])
      return {
        title: "Reloaded plugins",
        output: PluginScaffold.formatStatus(plugins),
        metadata: { action: params.action, plugins },
      }
    }

    const name = PluginScaffold.validateName(params.name)
    const scope: Scope = params.scope ?? "global"
    const folder = PluginScaffold.folderOf(scope, instance, name)
    const entry = path.join(folder, "index.ts")
    const exists = existsSync(folder)

    if (params.action === "remove") {
      if (!exists) throw new Error(`No ${scope} plugin named "${name}" (looked in ${folder}).`)
      await ctx.ask({
        permission: "plugin",
        patterns: [name],
        always: [name],
        metadata: { action: "remove", name, scope, folder },
      })
      await fs.rm(folder, { recursive: true, force: true })
      const plugins = await reloadAndReport(instance, [folder])
      return {
        title: `Removed plugin ${name}`,
        output: `Removed ${folder} and unloaded the plugin.\n\n${PluginScaffold.formatStatus(plugins)}`,
        metadata: { action: params.action, name, folder, plugins },
      }
    }

    if (params.action === "create" && exists) {
      throw new Error(
        `A ${scope} plugin named "${name}" already exists at ${folder}. Use action "update" to change it.`,
      )
    }
    if (params.action === "update" && !exists) {
      throw new Error(`No ${scope} plugin named "${name}" to update (looked in ${folder}). Use action "create".`)
    }

    const source = PluginScaffold.checkSource(params.source)
    const manifestPath = path.join(folder, "package.json")
    const previousManifest = exists ? await readJson(manifestPath) : undefined
    const pkg = PluginScaffold.manifest(name, previousManifest, {
      description: params.description,
      dependencies: params.dependencies,
    })
    const before = exists
      ? await Bun.file(entry)
          .text()
          .catch(() => "")
      : ""
    const diff = trimDiff(createTwoFilesPatch(entry, entry, before, source))

    // Plugin code runs inside nikcli with the user's privileges as soon as it
    // is loaded, so writing one is its own permission, asked every time unless
    // the user allowed this plugin name for good.
    await ctx.ask({
      permission: "plugin",
      patterns: [name],
      always: [name],
      metadata: {
        action: params.action,
        name,
        scope,
        folder,
        filepath: entry,
        diff,
        dependencies: pkg.dependencies ?? {},
        files: [buildFileDiff({ file: entry, before, after: source, patch: diff })],
      },
    })

    await fs.mkdir(folder, { recursive: true })
    await Bun.write(manifestPath, JSON.stringify(pkg, null, 2) + "\n")
    await Bun.write(entry, source)

    const notes: string[] = []
    if (pkg.dependencies) {
      ctx.metadata({ title: `Installing dependencies for ${name}` })
      const installed = await BunProc.run(["install"], { cwd: folder }).catch((error: unknown) => error)
      if (installed instanceof Error) {
        notes.push(`Dependency install failed: ${installed.message}`)
      }
    }

    ctx.metadata({ title: `Loading plugin ${name}` })
    const plugins = await reloadAndReport(instance, [entry])
    const spec = pathToFileURL(entry).href
    const status = plugins.find((plugin) => plugin.spec === spec)
    const verb = params.action === "create" ? "Created" : "Updated"

    let output: string
    let loaded = false
    if (!status) {
      const shadow = plugins.find((plugin) => plugin.name === name)
      output = shadow
        ? `${verb} ${entry}, but another plugin named "${name}" takes precedence (${shadow.spec}), so this one is not loaded. Rename the plugin or remove the other one.`
        : `${verb} ${entry}, but nikcli did not pick it up from ${path.dirname(folder)}. Check that this config directory is in use.`
    } else if (status.error) {
      output = `${verb} ${entry}, but the plugin FAILED to load:\n${status.error}\n\nFix the source and call this tool again with action "update".`
    } else {
      loaded = true
      const hooks = status.hooks.length > 0 ? status.hooks.join(", ") : "none"
      const tools = status.tools.length > 0 ? status.tools.join(", ") : "none"
      output =
        `${verb} and loaded plugin "${name}" (${scope}).\n` +
        `Folder: ${folder}\nHooks: ${hooks}\nTools: ${tools}` +
        (status.tools.length > 0 ? "\nThe tools are available from your next step." : "")
    }
    if (notes.length > 0) output += `\n\n${notes.join("\n")}`

    return {
      title: `${loaded ? verb : "Failed"} plugin ${name}`,
      output,
      metadata: { action: params.action, name, folder, filepath: entry, diff, loaded, plugins },
    }
  },
})
