import * as PluginSpecModule from "@nikcli-ai/util/plugin-spec"
import { Log } from "@nikcli-ai/util/log"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import z from "zod"
import type { Mode as ComputerMode } from "@nikcli-ai/computer-use"
import { ModelsDev } from "../provider/models"
import { mergeDeep, unique } from "remeda"
import { Global } from "@nikcli-ai/util/global"
import fs from "fs/promises"
import { Flag } from "@nikcli-ai/util/flag"
import { Auth } from "../auth"
import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import { LSPServer } from "../lsp/server"
import { BunProc } from "@/bun"
import { Installation } from "@/installation"
import { ConfigMarkdown } from "./markdown"
import { WebSearchConfigSchema } from "@/tool/websearch/config"
import { existsSync } from "fs"
import { Bus } from "@/bus"
import { GlobalBus } from "@nikcli-ai/util/global-bus"
import { Event } from "../server/event"
import { Context, Effect, Layer, Schema, ScopedCache } from "effect"
import { InstanceState, runPromiseWithLayer } from "@/effect"
import type { InstanceContext } from "@/effect"
import { ConfigPaths } from "./paths"
import { AppFileSystem } from "@/filesystem"
import { overrideZod } from "@/util/zod-effect"

export namespace Config {
  const log = Log.create({ service: "config" })

  function runAuth<A, E>(effect: Effect.Effect<A, E, Auth.Service>) {
    return runPromiseWithLayer(Auth.defaultLayer, effect)
  }

  // Custom merge function that concatenates array fields instead of replacing them
  function mergeConfigConcatArrays(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source)
    if (target.plugin && source.plugin) {
      merged.plugin = Array.from(new Set([...target.plugin, ...source.plugin]))
    }
    if (target.instructions && source.instructions) {
      merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
    }
    if (target.experimental?.policies && source.experimental?.policies) {
      merged.experimental ??= {}
      merged.experimental.policies = [...target.experimental.policies, ...source.experimental.policies]
    }
    return merged
  }

  type State = {
    config: Info
    directories: string[]
  }

  export interface Interface {
    get(): Effect.Effect<Info, unknown>
    getGlobal(): Effect.Effect<Info, unknown>
    update(config: Info): Effect.Effect<void, unknown>
    updateGlobal(config: Info): Effect.Effect<void, unknown>
    directories(): Effect.Effect<string[], unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("Config.Service") {}

  async function loadState(ctx: InstanceContext, directories: string[], projectFiles: string[]): Promise<State> {
    const auth = await runAuth(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return yield* auth.all()
      }),
    )

    // Load remote/well-known config first as the base layer (lowest precedence)
    // This allows organizations to provide default configs that users can override
    let result: Info = {}
    for (const [key, value] of Object.entries(auth)) {
      if (value.type === "wellknown") {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(value.key)) {
          log.warn("skipping well-known config with invalid env key", {
            url: key,
            env: value.key,
          })
          continue
        }
        log.warn("fetching remote config from well-known endpoint", {
          url: `${key}/.well-known/nikcli`,
        })
        const response = await runAuth(
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            return yield* auth.fetchWellKnown(key)
          }),
        )
        if (!response.ok) {
          throw new Config.RemoteFetchError({
            url: key,
            status: response.status,
          })
        }
        const wellknown = (await response.json()) as {
          config?: Record<string, unknown>
        }
        const remoteConfig = wellknown.config ?? {}
        // Add $schema to prevent load() from trying to write back to a non-existent file
        if (!remoteConfig.$schema) remoteConfig.$schema = "https://nikcli-ai.dev/config.json"
        result = mergeConfigConcatArrays(
          result,
          await load(
            JSON.stringify(remoteConfig),
            `${key}/.well-known/nikcli`,
            { [value.key]: value.token },
            false,
            false,
          ),
        )
        log.debug("loaded remote config from well-known", { url: key })
      }
    }

    // Global user config overrides remote config
    result = mergeConfigConcatArrays(result, await global())

    // Custom config path overrides global
    if (Flag.NIKCLI_CONFIG) {
      result = mergeConfigConcatArrays(result, await loadFile(Flag.NIKCLI_CONFIG))
      log.debug("loaded custom config", { path: Flag.NIKCLI_CONFIG })
    }

    // Project config has highest precedence (overrides global and remote)
    if (!Flag.NIKCLI_DISABLE_PROJECT_CONFIG) {
      for (const resolved of projectFiles) {
        result = mergeConfigConcatArrays(result, await loadFile(resolved))
      }
    }

    // Inline config content has highest precedence
    if (Flag.NIKCLI_CONFIG_CONTENT) {
      result = mergeConfigConcatArrays(result, JSON.parse(Flag.NIKCLI_CONFIG_CONTENT))
      log.debug("loaded custom config from NIKCLI_CONFIG_CONTENT")
    }

    result.agent = result.agent || {}
    result.mode = result.mode || {}
    result.plugin = result.plugin || []

    if (Flag.NIKCLI_CONFIG_DIR) {
      log.debug("loading config from NIKCLI_CONFIG_DIR", {
        path: Flag.NIKCLI_CONFIG_DIR,
      })
    }

    for (const dir of unique(directories)) {
      if (dir.endsWith(".nikcli") || dir === Flag.NIKCLI_CONFIG_DIR) {
        log.debug(`loading config from ${path.join(dir, "nikcli.json")}`)
        result = mergeConfigConcatArrays(result, await loadFile(path.join(dir, "nikcli.json")))
        // to satisfy the type checker
        result.agent ??= {}
        result.mode ??= {}
        result.plugin ??= []
      }

      // Only install when deps are missing or stale; see `needsInstall`.
      if (await needsInstall(dir)) await installDependencies(dir)

      // The directory may not exist yet (e.g. when the plugin-install bootstrap
      // that creates it is skipped). Nothing to load from a missing dir, and the
      // glob scanners below would throw ENOENT on a non-existent cwd.
      if (!existsSync(dir)) continue

      result.command = mergeDeep(result.command ?? {}, await loadCommand(dir))
      result.agent = mergeDeep(result.agent, await loadAgent(dir))
      result.agent = mergeDeep(result.agent, await loadMode(dir))
      result.plugin.push(...(await loadPlugin(dir)))
    }

    // Migrate deprecated mode field to agent field
    for (const [name, mode] of Object.entries(result.mode)) {
      result.agent = mergeDeep(result.agent ?? {}, {
        [name]: {
          ...mode,
          mode: "primary" as const,
        },
      })
    }

    if (Flag.NIKCLI_PERMISSION) {
      result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.NIKCLI_PERMISSION))
    }

    // Backwards compatibility: legacy top-level `tools` config
    if (result.tools) {
      const perms: Record<string, Config.PermissionAction> = {}
      for (const [tool, enabled] of Object.entries(result.tools)) {
        const action: Config.PermissionAction = enabled ? "allow" : "deny"
        if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
          perms.edit = action
          continue
        }
        perms[tool] = action
      }
      result.permission = mergeDeep(perms, result.permission ?? {})
    }

    if (!result.username) result.username = os.userInfo().username

    // Handle migration from autoshare to share field
    if (result.autoshare === true && !result.share) {
      result.share = "auto"
    }

    if (!result.keybinds) result.keybinds = Info.shape.keybinds.parse({})

    // Apply flag overrides for compaction settings
    if (Flag.NIKCLI_DISABLE_AUTOCOMPACT) {
      result.compaction = { ...result.compaction, auto: false }
    }
    if (Flag.NIKCLI_DISABLE_PRUNE) {
      result.compaction = { ...result.compaction, prune: false }
    }

    result.plugin = deduplicatePlugins(result.plugin ?? [])

    return {
      config: result,
      directories,
    }
  }

  function makeScopedState(paths: ConfigPaths.Interface, appFs: AppFileSystem.Interface) {
    return InstanceState.make<State>(
      (ctx) =>
        Effect.gen(function* () {
          const directories = yield* paths.directories(ctx.directory, ctx.worktree)
          const found = Flag.NIKCLI_DISABLE_PROJECT_CONFIG
            ? []
            : yield* appFs.findUp("nikcli.json", ctx.directory, ctx.worktree)
          const projectFiles = found.toReversed()
          return yield* Effect.promise(() => loadState(ctx, directories, projectFiles))
        }),
      // Config participates in instance hot reload: when a config file changes
      // on disk, InstanceReload invalidates this cache so the next get() sees
      // the new agents/commands/permissions without a process restart.
      { reloadable: true },
    )
  }

  /** Config dirs a reinstall was already attempted for in this process. */
  const reinstalled = new Set<string>()

  /**
   * Whether a config dir needs `installDependencies`: its node_modules is
   * missing, or the `@nikcli-ai/plugin` it pins is not this release's. As in
   * opencode's `needsInstall` — without that version check a config dir keeps
   * the package it got on first run forever, including a broken one.
   *
   * Not for a symlinked node_modules (a worktree sharing the main checkout's,
   * where `bun install` fails with EEXIST), not for local builds (they install
   * `latest`, which has no version to compare), and at most once per process
   * per dir, so an offline start or a hot reload does not retry on every load.
   */
  export async function needsInstall(dir: string): Promise<boolean> {
    const modules = path.join(dir, "node_modules")
    if (!existsSync(modules)) return true
    if (Installation.isLocal() || reinstalled.has(dir)) return false
    const stat = await fs.lstat(modules).catch(() => undefined)
    if (!stat || stat.isSymbolicLink()) return false
    const pkg = await Bun.file(path.join(dir, "package.json"))
      .json()
      .catch(() => undefined)
    const pinned = pkg?.dependencies?.["@nikcli-ai/plugin"]
    if (pinned === Installation.VERSION) return false
    reinstalled.add(dir)
    return true
  }

  export async function installDependencies(dir: string) {
    if (process.env.NIKCLI_TEST_MODE || process.env.NIKCLI_SKIP_PLUGIN_INSTALL) return

    const pkg = path.join(dir, "package.json")

    if (!(await Bun.file(pkg).exists())) {
      await Bun.write(pkg, "{}")
    }

    const gitignore = path.join(dir, ".gitignore")
    const hasGitIgnore = await Bun.file(gitignore).exists()
    if (!hasGitIgnore) await Bun.write(gitignore, ["node_modules", "package.json", "bun.lock", ".gitignore"].join("\n"))

    // Never write to stdout/stderr here: it corrupts the TUI render. Log instead.
    await BunProc.run(
      ["add", "@nikcli-ai/plugin@" + (Installation.isLocal() ? "latest" : Installation.VERSION), "--exact"],
      {
        cwd: dir,
      },
    ).catch((err) => {
      log.warn("plugin install failed", { dir, error: String(err) })
    })

    // Install any additional dependencies defined in the package.json
    // This allows local plugins and custom tools to use external packages
    await BunProc.run(["install"], { cwd: dir }).catch((err) => {
      log.warn("dependency install failed", { dir, error: String(err) })
    })
  }

  function rel(item: string, patterns: string[]) {
    for (const pattern of patterns) {
      const index = item.indexOf(pattern)
      if (index === -1) continue
      return item.slice(index + pattern.length)
    }
  }

  function trim(file: string) {
    const ext = path.extname(file)
    return ext.length ? file.slice(0, -ext.length) : file
  }

  /**
   * Scan `dir` with `glob`, tolerating a missing directory. Returns nothing when
   * the directory doesn't exist (or the underlying scan reports ENOENT), so a
   * config dir that was never created doesn't crash config loading.
   */
  async function* safeScan(glob: Bun.Glob, dir: string) {
    if (!existsSync(dir)) return
    try {
      yield* glob.scan({
        absolute: true,
        followSymlinks: true,
        dot: true,
        cwd: dir,
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return
      throw err
    }
  }

  const COMMAND_GLOB = new Bun.Glob("{command,commands}/**/*.md")
  async function loadCommand(dir: string) {
    const result: Record<string, Command> = {}
    for await (const item of safeScan(COMMAND_GLOB, dir)) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = err instanceof ConfigMarkdown.FrontmatterError ? err.message : `Failed to parse command ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, {
          error: { name: "UnknownError" as const, data: { message } },
        })
        log.error("failed to load command", { command: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/.nikcli/command/", "/.nikcli/commands/", "/command/", "/commands/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const name = trim(file)

      const config = {
        name,
        ...md.data,
        template: md.content.trim(),
      }
      const parsed = Command.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw Object.assign(new InvalidError({ path: item, issues: parsed.error.issues }), { cause: parsed.error })
    }
    return result
  }

  const AGENT_GLOB = new Bun.Glob("{agent,agents}/**/*.md")
  async function loadAgent(dir: string) {
    const result: Record<string, Agent> = {}

    for await (const item of safeScan(AGENT_GLOB, dir)) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = err instanceof ConfigMarkdown.FrontmatterError ? err.message : `Failed to parse agent ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, {
          error: { name: "UnknownError" as const, data: { message } },
        })
        log.error("failed to load agent", { agent: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/.nikcli/agent/", "/.nikcli/agents/", "/agent/", "/agents/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const agentName = trim(file)

      const config = {
        name: agentName,
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw Object.assign(new InvalidError({ path: item, issues: parsed.error.issues }), { cause: parsed.error })
    }
    return result
  }

  const MODE_GLOB = new Bun.Glob("{mode,modes}/*.md")
  async function loadMode(dir: string) {
    const result: Record<string, Agent> = {}
    for await (const item of safeScan(MODE_GLOB, dir)) {
      const md = await ConfigMarkdown.parse(item).catch(async (err) => {
        const message = err instanceof ConfigMarkdown.FrontmatterError ? err.message : `Failed to parse mode ${item}`
        const { Session } = await import("@/session")
        Bus.publish(Session.Event.Error, {
          error: { name: "UnknownError" as const, data: { message } },
        })
        log.error("failed to load mode", { mode: item, err })
        return undefined
      })
      if (!md) continue

      const config = {
        name: path.basename(item, ".md"),
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = {
          ...parsed.data,
          mode: "primary" as const,
        }
        continue
      }
    }
    return result
  }

  const PLUGIN_GLOB = new Bun.Glob("{plugin,plugins}/*.{ts,js}")
  const PLUGIN_FOLDER_GLOB = new Bun.Glob("{plugin,plugins}/*/{package.json,index.ts,index.js}")
  async function loadPlugin(dir: string) {
    const plugins: string[] = []

    for await (const item of safeScan(PLUGIN_GLOB, dir)) {
      plugins.push(pathToFileURL(item).href)
    }

    // Folder plugins: `plugins/<name>/` with its own package.json and
    // dependencies — the shape the `plugin` tool writes. Sorted so the load
    // order does not depend on the order the filesystem lists entries in.
    const folders = new Set<string>()
    for await (const item of safeScan(PLUGIN_FOLDER_GLOB, dir)) folders.add(path.dirname(item))
    for (const folder of [...folders].sort()) {
      const entry = await pluginFolderEntry(folder)
      if (entry) plugins.push(pathToFileURL(entry).href)
    }
    return plugins
  }

  /**
   * Folder names under `plugin/` / `plugins/` that are not server plugins:
   * `tui` holds TUI plugin files (see `TuiConfig.pluginDirectories`), and the
   * others are tooling, never a plugin someone wrote.
   */
  const PLUGIN_FOLDER_RESERVED = new Set(["tui", "node_modules"])

  /**
   * The entry file of a folder plugin: package.json `main` when it names a file
   * inside the folder, else `index.ts`, else `index.js`. `undefined` for a
   * reserved or hidden folder, or one with no entry on disk.
   */
  export async function pluginFolderEntry(folder: string): Promise<string | undefined> {
    const name = path.basename(folder)
    if (name.startsWith(".") || PLUGIN_FOLDER_RESERVED.has(name)) return
    const pkg = await Bun.file(path.join(folder, "package.json"))
      .json()
      .catch(() => undefined)
    const main = pkg && typeof pkg.main === "string" ? pkg.main.trim() : ""
    const candidates = [
      ...(main ? [path.resolve(folder, main)] : []),
      path.join(folder, "index.ts"),
      path.join(folder, "index.js"),
    ]
    for (const candidate of candidates) {
      // A `main` that escapes the folder is ignored rather than followed.
      if (candidate !== folder && !candidate.startsWith(folder + path.sep)) continue
      if (existsSync(candidate)) return candidate
    }
  }

  /**
   * Extracts a canonical plugin name from a plugin specifier.
   * - For file:// URLs: extracts filename without extension, or the folder
   *   name for a folder plugin (`plugins/<name>/index.ts`), whose entry file
   *   is usually called `index` and would otherwise collide in dedup
   * - For npm packages: extracts package name without version
   *
   * @example
   * getPluginName("file:///path/to/plugin/foo.js") // "foo"
   * getPluginName("file:///path/to/plugins/notify/index.ts") // "notify"
   * getPluginName("oh-my-nikcli@2.4.3") // "oh-my-nikcli"
   * getPluginName("@scope/pkg@1.0.0") // "@scope/pkg"
   */
  export function getPluginName(plugin: string): string {
    if (plugin.startsWith("file://")) {
      const pathname = new URL(plugin).pathname
      const segments = pathname.split("/")
      const root = segments.findLastIndex((segment) => segment === "plugin" || segment === "plugins")
      if (root >= 0 && root <= segments.length - 3) return segments[root + 1]!
      return path.parse(pathname).name
    }
    const lastAt = plugin.lastIndexOf("@")
    if (lastAt > 0) {
      return plugin.substring(0, lastAt)
    }
    return plugin
  }

  /**
   * Deduplicates plugins by name, with later entries (higher priority) winning.
   * Priority order (highest to lowest):
   * 1. Local plugin/ directory
   * 2. Local nikcli.json
   * 3. Global plugin/ directory
   * 4. Global nikcli.json
   *
   * Since plugins are added in low-to-high priority order,
   * we reverse, deduplicate (keeping first occurrence), then restore order.
   */
  export function deduplicatePlugins(plugins: string[]): string[] {
    // seenNames: canonical plugin names for duplicate detection
    // e.g., "oh-my-nikcli", "@scope/pkg"
    const seenNames = new Set<string>()

    // uniqueSpecifiers: full plugin specifiers to return
    // e.g., "oh-my-nikcli@2.4.3", "file:///path/to/plugin.js"
    const uniqueSpecifiers: string[] = []

    for (const specifier of plugins.toReversed()) {
      const name = getPluginName(specifier)
      if (!seenNames.has(name)) {
        seenNames.add(name)
        uniqueSpecifiers.push(specifier)
      }
    }

    return uniqueSpecifiers.toReversed()
  }

  // Declared in @nikcli-ai/util/plugin-spec so a client can read a spec without the config module.
  export const PluginOptions = PluginSpecModule.PluginOptions
  export type PluginOptions = PluginSpecModule.PluginOptions
  export const PluginSpec = PluginSpecModule.PluginSpec
  export type PluginSpec = PluginSpecModule.PluginSpec
  export const pluginSpecifier = PluginSpecModule.pluginSpecifier
  export const pluginOptions = PluginSpecModule.pluginOptions

  export async function resolvePluginSpec(plugin: PluginSpec, configFilepath: string): Promise<PluginSpec> {
    const spec = pluginSpecifier(plugin)
    let resolved = spec
    try {
      resolved = import.meta.resolve!(spec, configFilepath)
    } catch (err) {
      log.warn("failed to resolve plugin path", { spec, error: err })
    }

    if (typeof plugin === "string") return resolved
    return [resolved, plugin[1]]
  }

  export function managedConfigDir() {
    return path.join(Global.Path.config, "managed")
  }

  export const McpLocal = z
    .object({
      type: z.literal("local").describe("Type of MCP server connection"),
      command: z.string().array().describe("Command and arguments to run the MCP server"),
      environment: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables to set when running the MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpLocalConfig",
    })

  export const McpOAuth = z
    .object({
      clientId: z
        .string()
        .optional()
        .describe("OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted."),
      clientSecret: z.string().optional().describe("OAuth client secret (if required by the authorization server)"),
      scope: z.string().optional().describe("OAuth scopes to request during authorization"),
    })
    .strict()
    .meta({
      ref: "McpOAuthConfig",
    })
  export type McpOAuth = z.infer<typeof McpOAuth>

  export const McpRemote = z
    .object({
      type: z.literal("remote").describe("Type of MCP server connection"),
      url: z.string().describe("URL of the remote MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
      oauth: z
        .union([McpOAuth, z.literal(false)])
        .optional()
        .describe(
          "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpRemoteConfig",
    })

  export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
  export type Mcp = z.infer<typeof Mcp>

  export const ConnectorFigma = z
    .object({
      type: z.literal("figma"),
      token: z.string().optional().describe("Figma personal access token"),
      enabled: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "ConnectorFigma" })
  export type ConnectorFigma = z.infer<typeof ConnectorFigma>

  export const ConnectorSlack = z
    .object({
      type: z.literal("slack"),
      botToken: z.string().optional().describe("Slack bot token"),
      teamId: z.string().optional().describe("Slack team ID"),
      enabled: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "ConnectorSlack" })
  export type ConnectorSlack = z.infer<typeof ConnectorSlack>

  export const ConnectorGithub = z
    .object({
      type: z.literal("github"),
      token: z.string().optional().describe("GitHub personal access token"),
      oauthClientId: z.string().optional().describe("GitHub OAuth client ID for mobile device flow"),
      clientId: z.string().optional().describe("Alias for GitHub OAuth client ID"),
      enabled: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "ConnectorGithub" })
  export type ConnectorGithub = z.infer<typeof ConnectorGithub>

  export const ConnectorLovable = z
    .object({
      type: z.literal("lovable"),
      token: z.string().optional().describe("Lovable API key"),
      apiKey: z.string().optional().describe("Legacy Lovable API key"),
      enabled: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "ConnectorLovable" })
  export type ConnectorLovable = z.infer<typeof ConnectorLovable>

  export const ConnectorDiscord = z
    .object({
      type: z.literal("discord"),
      botToken: z.string().optional().describe("Discord bot token"),
      enabled: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "ConnectorDiscord" })
  export type ConnectorDiscord = z.infer<typeof ConnectorDiscord>

  export const ConnectorTeams = z
    .object({
      type: z.literal("teams"),
      botToken: z.string().optional().describe("Microsoft Teams bot token"),
      enabled: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "ConnectorTeams" })
  export type ConnectorTeams = z.infer<typeof ConnectorTeams>

  export const ConnectorGChat = z
    .object({
      type: z.literal("gchat"),
      botToken: z.string().optional().describe("Google Chat bot token"),
      enabled: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "ConnectorGChat" })
  export type ConnectorGChat = z.infer<typeof ConnectorGChat>

  export const ConnectorLinear = z
    .object({
      type: z.literal("linear"),
      botToken: z.string().optional().describe("Linear bot token"),
      enabled: z.boolean().optional(),
    })
    .strict()
    .meta({ ref: "ConnectorLinear" })
  export type ConnectorLinear = z.infer<typeof ConnectorLinear>

  export const Connector = z.discriminatedUnion("type", [
    ConnectorFigma,
    ConnectorSlack,
    ConnectorGithub,
    ConnectorLovable,
    ConnectorDiscord,
    ConnectorTeams,
    ConnectorGChat,
    ConnectorLinear,
  ])
  export type Connector = z.infer<typeof Connector>

  export const PermissionAction = z.enum(["ask", "allow", "deny"]).meta({
    ref: "PermissionActionConfig",
  })
  export type PermissionAction = z.infer<typeof PermissionAction>

  export const PermissionObject = z.record(z.string(), PermissionAction).meta({
    ref: "PermissionObjectConfig",
  })
  export type PermissionObject = z.infer<typeof PermissionObject>

  export const PermissionRule = z.union([PermissionAction, PermissionObject]).meta({
    ref: "PermissionRuleConfig",
  })
  export type PermissionRule = z.infer<typeof PermissionRule>

  // Capture original key order before zod reorders, then rebuild in original order
  const permissionPreprocess = (val: unknown) => {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      return { __originalKeys: Object.keys(val), ...val }
    }
    return val
  }

  const permissionTransform = (x: unknown): Record<string, PermissionRule> => {
    if (typeof x === "string") return { "*": x as PermissionAction }
    const obj = x as { __originalKeys?: string[] } & Record<string, unknown>
    const { __originalKeys, ...rest } = obj
    if (!__originalKeys) return rest as Record<string, PermissionRule>
    const result: Record<string, PermissionRule> = {}
    for (const key of __originalKeys) {
      if (key in rest) result[key] = rest[key] as PermissionRule
    }
    return result
  }

  export const Permission = z
    .preprocess(
      permissionPreprocess,
      z
        .object({
          __originalKeys: z.string().array().optional(),
          read: PermissionRule.optional(),
          edit: PermissionRule.optional(),
          glob: PermissionRule.optional(),
          grep: PermissionRule.optional(),
          list: PermissionRule.optional(),
          tree: PermissionRule.optional(),
          bash: PermissionRule.optional(),
          task: PermissionRule.optional(),
          subagents: PermissionRule.optional(),
          context_collect: PermissionRule.optional(),
          context_related: PermissionRule.optional(),
          context_diagnostics: PermissionRule.optional(),
          memory_search: PermissionRule.optional(),
          generate_image: PermissionRule.optional(),
          external_directory: PermissionRule.optional(),
          todowrite: PermissionAction.optional(),
          todoread: PermissionAction.optional(),
          question: PermissionAction.optional(),
          webfetch: PermissionAction.optional(),
          websearch: PermissionAction.optional(),
          codesearch: PermissionAction.optional(),
          repo_clone: PermissionAction.optional(),
          repo_overview: PermissionAction.optional(),
          speak: PermissionRule.optional(),
          voice: PermissionRule.optional(),
          lsp: PermissionRule.optional(),
          doom_loop: PermissionAction.optional(),
        })
        .catchall(PermissionRule)
        .or(PermissionAction),
    )
    .transform(permissionTransform)
    .meta({
      ref: "PermissionConfig",
    })
  export type Permission = z.infer<typeof Permission>

  // `permissionTransform` rewrites a union of shapes into a plain rule map, so
  // the output type cannot be read off the zod graph. Pin it for the HTTP
  // contract, which derives its Config schema from this module (util/zod-effect).
  const PermissionActionEffect = Schema.Literals(["ask", "allow", "deny"]).annotate({
    identifier: "PermissionActionConfig",
  })
  const PermissionRuleEffect = Schema.Union([
    PermissionActionEffect,
    Schema.Record(Schema.String, PermissionActionEffect).annotate({
      identifier: "PermissionObjectConfig",
    }),
  ]).annotate({ identifier: "PermissionRuleConfig" })
  overrideZod(
    Permission,
    // A rule map: any key may be absent, so reading one yields `undefined`.
    Schema.Record(Schema.String, Schema.Union([PermissionRuleEffect, Schema.Undefined])).annotate({
      identifier: "PermissionConfig",
    }),
  )

  /**
   * The permission mode a session starts in. `default` prompts for `ask`
   * decisions; `auto` sends them to the auto mode classifier instead (see
   * `permission/auto.ts`). The ruleset itself is the same in both.
   */
  export const PermissionMode = z.enum(["default", "auto"]).meta({
    ref: "PermissionModeConfig",
  })
  export type PermissionMode = z.infer<typeof PermissionMode>

  /**
   * Auto mode classifier settings. Read from the global config only: a
   * project's `nikcli.json` is checked into the repo it describes, and a repo
   * must not be able to widen what the classifier lets through.
   */
  export const AutoMode = z
    .object({
      environment: z
        .array(z.string())
        .optional()
        .describe('Trusted infrastructure, as prose. Include "$defaults" to keep the built-in entries.'),
      allow: z
        .array(z.string())
        .optional()
        .describe('Exceptions to soft_deny rules, as prose. Include "$defaults" to keep the built-in rules.'),
      soft_deny: z
        .array(z.string())
        .optional()
        .describe('Block rules that explicit user intent can clear. Include "$defaults" to keep the built-in rules.'),
      hard_deny: z
        .array(z.string())
        .optional()
        .describe('Unconditional block rules. Include "$defaults" to keep the built-in rules.'),
      classify_all_shell: z
        .boolean()
        .optional()
        .describe("Suspend every shell allow rule in auto mode, so the classifier reviews every command"),
      model: z
        .string()
        .optional()
        .describe("Classifier model in provider/model format. Defaults to the session's model"),
      disable: z.boolean().optional().describe("Turn auto mode off: sessions set to auto run in default mode"),
    })
    .strict()
    .meta({
      ref: "AutoModeConfig",
    })
  export type AutoMode = z.infer<typeof AutoMode>

  export const Command = z.object({
    template: z.string().optional(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    subtask: z.boolean().optional(),
    /**
     * Alternative names accepted in the prompt autocomplete (e.g. `/gh` → `/github`).
     * Built-in commands (initialized in src/command/index.ts) may also declare
     * aliases in their own static config.
     */
    aliases: z.array(z.string()).optional(),
  })
  export type Command = z.infer<typeof Command>

  export const Reference = z
    .union([
      z
        .object({
          type: z.literal("git"),
          repository: z.string(),
          branch: z.string().optional(),
          description: z.string().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("local"),
          path: z.string(),
          description: z.string().optional(),
        })
        .strict(),
    ])
    .meta({
      ref: "ReferenceConfig",
    })
  export type Reference = z.infer<typeof Reference>

  export const Agent = z
    .object({
      model: z.string().optional(),
      variant: z
        .string()
        .optional()
        .describe("Default model variant for this agent (applies only when using the agent's configured model)."),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      prompt: z.string().optional(),
      tools: z.record(z.string(), z.boolean()).optional().describe("@deprecated Use 'permission' field instead"),
      disable: z.boolean().optional(),
      description: z.string().optional().describe("Description of when to use the agent"),
      mode: z.enum(["subagent", "primary", "all"]).optional(),
      hidden: z
        .boolean()
        .optional()
        .describe("Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)"),
      options: z.record(z.string(), z.any()).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format")
        .optional()
        .describe("Hex color code for the agent (e.g., #FF5733)"),
      steps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of agentic iterations before forcing text-only response"),
      // Opencode #24691: sort key for agent cycling order (Tab in TUI).
      // Lower numbers sort first; agents without `order` sort alphabetically after.
      order: z.number().int().optional().describe("Sorting priority for agent cycling. Lower = earlier."),
      maxSteps: z.number().int().positive().optional().describe("@deprecated Use 'steps' field instead."),
      permission: Permission.optional(),
      permission_mode: PermissionMode.optional().describe(
        "Permission mode for this agent; overrides the top-level one",
      ),
      advisor: z
        .string()
        .optional()
        .describe(
          "Advisor model in provider/model format (e.g. anthropic/claude-opus-4-6). Invoked by the executor for strategic guidance.",
        ),
      advisor_max_uses: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max advisor invocations per request (default: 3)."),
    })
    .catchall(z.any())
    .transform((agent, _ctx) => {
      const knownKeys = new Set([
        "name",
        "model",
        "variant",
        "prompt",
        "description",
        "temperature",
        "top_p",
        "mode",
        "hidden",
        "color",
        "steps",
        "maxSteps",
        "options",
        "permission",
        "permission_mode",
        "disable",
        "tools",
        "advisor",
        "advisor_max_uses",
      ])

      // Extract unknown properties into options
      const options: Record<string, unknown> = { ...agent.options }
      for (const [key, value] of Object.entries(agent)) {
        if (!knownKeys.has(key)) options[key] = value
      }

      // Convert legacy tools config to permissions
      const permission: Permission = {}
      for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
        const action = enabled ? "allow" : "deny"
        // write, edit, patch, multiedit all map to edit permission
        if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
          permission.edit = action
        } else {
          permission[tool] = action
        }
      }
      Object.assign(permission, agent.permission)

      // Convert legacy maxSteps to steps. Spread rather than assign: writing
      // `steps: undefined` when an agent declares neither leaves a present
      // `undefined` in the parsed document, and the HttpApi JSON encoder
      // rejects it — `GET /config` answered 400 until `jsonSafe` was added to
      // paper over exactly this.
      const steps = agent.steps ?? agent.maxSteps

      return {
        ...agent,
        options,
        permission,
        ...(steps !== undefined && { steps }),
      } as typeof agent & {
        options?: Record<string, unknown>
        permission?: Permission
        steps?: number
      }
    })
    .meta({
      ref: "AgentConfig",
    })
  export type Agent = z.infer<typeof Agent>

  export const Keybinds = z
    .object({
      leader: z.string().optional().default("ctrl+x").describe("Leader key for keybind combinations"),
      app_exit: z.string().optional().default("ctrl+c,ctrl+d,<leader>q").describe("Exit the application"),
      editor_open: z.string().optional().default("<leader>e").describe("Open external editor"),
      theme_list: z.string().optional().default("<leader>t").describe("List available themes"),
      sidebar_toggle: z.string().optional().default("<leader>b").describe("Toggle sidebar"),
      scrollbar_toggle: z.string().optional().default("none").describe("Toggle session scrollbar"),
      username_toggle: z.string().optional().default("none").describe("Toggle username visibility"),
      status_view: z.string().optional().default("<leader>s").describe("View status"),
      sync_view: z
        .string()
        .optional()
        .default("<leader>y")
        .describe("View sync status (sessions + workspace, hub remote)"),
      session_export: z.string().optional().default("<leader>x").describe("Export session to editor"),
      session_new: z.string().optional().default("<leader>n").describe("Create a new session"),
      session_list: z.string().optional().default("<leader>l").describe("List all sessions"),
      session_timeline: z.string().optional().default("<leader>g").describe("Show session timeline"),
      session_fork: z.string().optional().default("none").describe("Fork session from message"),
      session_rename: z.string().optional().default("ctrl+r").describe("Rename session"),
      session_delete: z.string().optional().default("ctrl+d").describe("Delete session"),
      session_pin_toggle: z.string().optional().default("<leader>p").describe("Toggle session pin"),
      session_scope_toggle: z
        .string()
        .optional()
        .default("ctrl+g")
        .describe("Toggle the session list between the current project and the global project"),
      session_tab_back: z.string().optional().default("ctrl+o").describe("Go back through session tab history"),
      session_tab_forward: z
        .string()
        .optional()
        .default("<leader>o")
        .describe("Go forward through session tab history"),
      session_quick_switch_1: z.string().optional().default("<leader>1").describe("Quick switch to session slot 1"),
      session_quick_switch_2: z.string().optional().default("<leader>2").describe("Quick switch to session slot 2"),
      session_quick_switch_3: z.string().optional().default("<leader>3").describe("Quick switch to session slot 3"),
      session_quick_switch_4: z.string().optional().default("<leader>4").describe("Quick switch to session slot 4"),
      session_quick_switch_5: z.string().optional().default("<leader>5").describe("Quick switch to session slot 5"),
      session_quick_switch_6: z.string().optional().default("<leader>6").describe("Quick switch to session slot 6"),
      session_quick_switch_7: z.string().optional().default("<leader>7").describe("Quick switch to session slot 7"),
      session_quick_switch_8: z.string().optional().default("<leader>8").describe("Quick switch to session slot 8"),
      session_quick_switch_9: z.string().optional().default("<leader>9").describe("Quick switch to session slot 9"),
      stash_delete: z.string().optional().default("ctrl+d").describe("Delete stash entry"),
      model_provider_list: z.string().optional().default("ctrl+a").describe("Open provider list from model dialog"),
      model_favorite_toggle: z.string().optional().default("ctrl+f").describe("Toggle model favorite status"),
      session_share: z.string().optional().default("none").describe("Share current session"),
      session_unshare: z.string().optional().default("none").describe("Unshare current session"),
      session_interrupt: z.string().optional().default("escape").describe("Interrupt current session"),
      session_codebro_open: z.string().optional().default("<leader>i").describe("Open the Codebro dossier"),
      subtask_background: z
        .string()
        .optional()
        .default("ctrl+b")
        .describe("Background current subtask and return to parent session"),
      subtask_picker: z.string().optional().default("down").describe("Open background subtask picker"),
      session_compact: z.string().optional().default("<leader>c").describe("Compact the session"),
      messages_page_up: z.string().optional().default("pageup,ctrl+alt+b").describe("Scroll messages up by one page"),
      messages_page_down: z
        .string()
        .optional()
        .default("pagedown,ctrl+alt+f")
        .describe("Scroll messages down by one page"),
      messages_line_up: z.string().optional().default("ctrl+alt+y").describe("Scroll messages up by one line"),
      messages_line_down: z.string().optional().default("ctrl+alt+e").describe("Scroll messages down by one line"),
      messages_half_page_up: z.string().optional().default("ctrl+alt+u").describe("Scroll messages up by half page"),
      messages_half_page_down: z
        .string()
        .optional()
        .default("ctrl+alt+d")
        .describe("Scroll messages down by half page"),
      messages_first: z.string().optional().default("ctrl+g,home").describe("Navigate to first message"),
      messages_last: z.string().optional().default("ctrl+alt+g,end").describe("Navigate to last message"),
      messages_next: z.string().optional().default("none").describe("Navigate to next message"),
      messages_previous: z.string().optional().default("none").describe("Navigate to previous message"),
      messages_last_user: z.string().optional().default("none").describe("Navigate to last user message"),
      messages_copy: z.string().optional().default("<leader>y").describe("Copy message"),
      messages_undo: z.string().optional().default("<leader>u").describe("Undo message"),
      messages_redo: z.string().optional().default("<leader>r").describe("Redo message"),
      messages_toggle_conceal: z
        .string()
        .optional()
        .default("<leader>h")
        .describe("Toggle code block concealment in messages"),
      tool_details: z.string().optional().default("none").describe("Toggle tool details visibility"),
      model_list: z.string().optional().default("<leader>m").describe("List available models"),
      model_cycle_recent: z.string().optional().default("f2").describe("Next recently used model"),
      model_cycle_recent_reverse: z.string().optional().default("shift+f2").describe("Previous recently used model"),
      model_cycle_favorite: z.string().optional().default("none").describe("Next favorite model"),
      model_cycle_favorite_reverse: z.string().optional().default("none").describe("Previous favorite model"),
      command_list: z.string().optional().default("ctrl+p").describe("List available commands"),
      agent_list: z.string().optional().default("<leader>a").describe("List agents"),
      agent_cycle: z.string().optional().default("tab").describe("Next agent"),
      agent_cycle_reverse: z.string().optional().default("shift+tab").describe("Previous agent"),
      permission_mode: z
        .string()
        .optional()
        .default("ctrl+s")
        .describe("Open permission presets for the current primary agent"),
      variant_cycle: z.string().optional().default("ctrl+t").describe("Cycle model variants"),
      input_clear: z.string().optional().default("ctrl+c").describe("Clear input field"),
      input_paste: z.string().optional().default("ctrl+v").describe("Paste from clipboard"),
      input_submit: z.string().optional().default("return").describe("Submit input"),
      input_newline: z
        .string()
        .optional()
        .default("shift+return,ctrl+return,alt+return,ctrl+j")
        .describe("Insert newline in input"),
      input_move_left: z.string().optional().default("left,ctrl+b").describe("Move cursor left in input"),
      input_move_right: z.string().optional().default("right,ctrl+f").describe("Move cursor right in input"),
      input_move_up: z.string().optional().default("up").describe("Move cursor up in input"),
      input_move_down: z.string().optional().default("down").describe("Move cursor down in input"),
      input_select_left: z.string().optional().default("shift+left").describe("Select left in input"),
      input_select_right: z.string().optional().default("shift+right").describe("Select right in input"),
      input_select_up: z.string().optional().default("shift+up").describe("Select up in input"),
      input_select_down: z.string().optional().default("shift+down").describe("Select down in input"),
      input_line_home: z.string().optional().default("ctrl+a").describe("Move to start of line in input"),
      input_line_end: z.string().optional().default("ctrl+e").describe("Move to end of line in input"),
      input_select_line_home: z
        .string()
        .optional()
        .default("ctrl+shift+a")
        .describe("Select to start of line in input"),
      input_select_line_end: z.string().optional().default("ctrl+shift+e").describe("Select to end of line in input"),
      input_visual_line_home: z.string().optional().default("alt+a").describe("Move to start of visual line in input"),
      input_visual_line_end: z.string().optional().default("alt+e").describe("Move to end of visual line in input"),
      input_select_visual_line_home: z
        .string()
        .optional()
        .default("alt+shift+a")
        .describe("Select to start of visual line in input"),
      input_select_visual_line_end: z
        .string()
        .optional()
        .default("alt+shift+e")
        .describe("Select to end of visual line in input"),
      input_buffer_home: z.string().optional().default("home").describe("Move to start of buffer in input"),
      input_buffer_end: z.string().optional().default("end").describe("Move to end of buffer in input"),
      input_select_buffer_home: z
        .string()
        .optional()
        .default("shift+home")
        .describe("Select to start of buffer in input"),
      input_select_buffer_end: z.string().optional().default("shift+end").describe("Select to end of buffer in input"),
      input_delete_line: z.string().optional().default("ctrl+shift+d").describe("Delete line in input"),
      input_delete_to_line_end: z.string().optional().default("ctrl+k").describe("Delete to end of line in input"),
      input_delete_to_line_start: z.string().optional().default("ctrl+u").describe("Delete to start of line in input"),
      input_backspace: z.string().optional().default("backspace,shift+backspace").describe("Backspace in input"),
      input_delete: z.string().optional().default("ctrl+d,delete,shift+delete").describe("Delete character in input"),
      input_undo: z.string().optional().default("ctrl+-,super+z").describe("Undo in input"),
      input_redo: z.string().optional().default("ctrl+.,super+shift+z").describe("Redo in input"),
      input_word_forward: z
        .string()
        .optional()
        .default("alt+f,alt+right,ctrl+right")
        .describe("Move word forward in input"),
      input_word_backward: z
        .string()
        .optional()
        .default("alt+b,alt+left,ctrl+left")
        .describe("Move word backward in input"),
      input_select_word_forward: z
        .string()
        .optional()
        .default("alt+shift+f,alt+shift+right")
        .describe("Select word forward in input"),
      input_select_word_backward: z
        .string()
        .optional()
        .default("alt+shift+b,alt+shift+left")
        .describe("Select word backward in input"),
      input_delete_word_forward: z
        .string()
        .optional()
        .default("alt+d,alt+delete,ctrl+delete")
        .describe("Delete word forward in input"),
      input_delete_word_backward: z
        .string()
        .optional()
        .default("ctrl+w,ctrl+backspace,alt+backspace")
        .describe("Delete word backward in input"),
      history_previous: z.string().optional().default("up").describe("Previous history item"),
      history_next: z.string().optional().default("down").describe("Next history item"),
      session_child_cycle: z.string().optional().default("<leader>right").describe("Next child session"),
      session_child_cycle_reverse: z.string().optional().default("<leader>left").describe("Previous child session"),
      // NOTE: for subtasks we prefer `subtask_background` (ctrl+b) which also
      // adds the child back to the background list. Keep this bound to ctrl+b
      // so "Parent" in subagent sessions matches the behavior users expect.
      session_parent: z.string().optional().default("ctrl+b").describe("Go to parent session"),
      session_child_close: z.string().optional().default("<leader>c").describe("Close subagent session"),
      terminal_suspend: z.string().optional().default("ctrl+z").describe("Suspend terminal"),
      terminal_title_toggle: z.string().optional().default("none").describe("Toggle terminal title"),
      tips_toggle: z.string().optional().default("<leader>h").describe("Toggle tips on home screen"),
      voice_record: z.string().optional().default("ctrl+alt+v").describe("Toggle voice recording (push to talk)"),
      app_support: z.string().optional().default("<leader>z").describe("Open the support assistant dialog"),
    })
    .strict()
    .meta({
      ref: "KeybindsConfig",
    })

  export const TUI = z.object({
    scroll_speed: z.number().min(0.001).optional().describe("TUI scroll speed"),
    scroll_acceleration: z
      .object({
        enabled: z.boolean().describe("Enable scroll acceleration"),
      })
      .optional()
      .describe("Scroll acceleration settings"),
    diff_style: z
      .enum(["auto", "stacked"])
      .optional()
      .describe("Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column"),
    mouse: z.boolean().optional().describe("Enable or disable mouse capture (default: true)"),
    sound: z.boolean().optional().describe("Enable or disable ambient sound feedback (default: true)"),
    bg_pulse: z.boolean().optional().describe("Enable animated background pulse behind the home logo (default: false)"),
    turn_tokens: z
      .boolean()
      .optional()
      .describe(
        "Show a per-turn token breakdown after each answer, with a warning when the prompt cache is invalidated (default: false)",
      ),
  })

  export const AdsItem = z
    .object({
      id: z.string().describe("Unique ad identifier"),
      text: z.string().describe("Ad message text"),
      url: z.string().url().optional().describe("Optional URL to show with the ad"),
      enabled: z.boolean().optional().describe("Enable this ad"),
    })
    .strict()
    .meta({
      ref: "AdsItemConfig",
    })
  export type AdsItem = z.infer<typeof AdsItem>

  export const Ads = z
    .object({
      enabled: z.boolean().optional().describe("Enable ads in the TUI"),
      ratio: z.number().min(0).max(1).optional().describe("Chance to show an ad instead of a tip (0-1)"),
      items: z.array(AdsItem).optional().describe("User-defined ads"),
    })
    .strict()
    .meta({
      ref: "AdsConfig",
    })
  export type Ads = z.infer<typeof Ads>

  export const Server = z
    .object({
      port: z.number().int().positive().optional().describe("Port to listen on"),
      hostname: z.string().optional().describe("Hostname to listen on"),
      mdns: z.boolean().optional().describe("Enable mDNS service discovery"),
      cors: z.array(z.string()).optional().describe("Additional domains to allow for CORS"),
    })
    .strict()
    .meta({
      ref: "ServerConfig",
    })

  export const Remote = z
    .object({
      enabled: z.boolean().optional().describe("Enable Remote Control automatically for all TUI sessions"),
      enableTunnel: z.boolean().optional().describe("Enable public tunnel by default for Remote Control"),
      provider: z
        .enum(["localtunnel", "cloudflared", "ngrok", "remotosh", "none"])
        .optional()
        .describe("Preferred tunnel provider for Remote Control"),
      askOnExistingSession: z
        .boolean()
        .optional()
        .describe("Prompt to continue existing remote session or start a new one"),
    })
    .strict()
    .meta({
      ref: "RemoteConfig",
    })
  export type Remote = z.infer<typeof Remote>

  export const Teleport = z
    .object({
      url: z.string().optional().describe("Last used teleport server base URL (e.g. a Railway deploy)"),
      token: z.string().optional().describe("Last used teleport mobile Bearer token"),
    })
    .strict()
    .meta({
      ref: "TeleportConfig",
    })
  export type Teleport = z.infer<typeof Teleport>

  export const Layout = z.enum(["auto", "stretch"]).meta({
    ref: "LayoutConfig",
  })
  export type Layout = z.infer<typeof Layout>

  export const Rag = z
    .object({
      model: z.string().optional().describe("Embedding model for RAG (e.g., nvidia/llama-embed-nemotron-8b)"),
      provider: z.string().optional().describe("Provider for RAG embeddings (defaults to nvidia)"),
    })
    .strict()
    .meta({
      ref: "RagConfig",
    })
  export type Rag = z.infer<typeof Rag>

  export const Image = z
    .object({
      model: z
        .string()
        .optional()
        .describe(
          "Image generation model ID (e.g., gpt-image-1, imagen-4.0-generate-001, openai/gpt-5-image, black-forest-labs/FLUX.1-dev). Any model ID works — not limited to the presets in the generate_image tool.",
        ),
      provider: z
        .string()
        .optional()
        .describe(
          "Provider ID for image generation (e.g., openai, google, xai, togetherai, openrouter). Determines which SDK authenticates the request.",
        ),
    })
    .strict()
    .meta({
      ref: "ImageConfig",
    })
  export type Image = z.infer<typeof Image>

  export const Computer = z
    .object({
      mode: z
        .enum(["sandbox", "host"])
        .optional()
        .describe(
          "Where the `computer` tool runs. 'sandbox' (default) drives an isolated background Linux desktop container and never touches your screen; 'host' drives your real machine in real time.",
        ),
      width: z.number().int().positive().optional().describe("Sandbox desktop width in pixels (default 1280)."),
      height: z.number().int().positive().optional().describe("Sandbox desktop height in pixels (default 800)."),
    })
    .strict()
    .meta({
      ref: "ComputerConfig",
    })
  export type Computer = z.infer<typeof Computer>
  /** Re-export of the underlying backend mode type for downstream consumers. */
  export type ComputerBackendMode = ComputerMode

  export const Attachment = z
    .object({
      image: z
        .object({
          auto_resize: z
            .boolean()
            .optional()
            .describe("Automatically downscale/re-encode images that exceed the configured limits"),
          max_width: z.number().int().positive().optional().describe("Maximum image width in pixels"),
          max_height: z.number().int().positive().optional().describe("Maximum image height in pixels"),
          max_base64_bytes: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Maximum base64-encoded payload size in bytes"),
        })
        .strict()
        .optional()
        .describe("Image attachment normalization options"),
    })
    .strict()
    .meta({
      ref: "AttachmentConfig",
    })
  export type Attachment = z.infer<typeof Attachment>

  export const Speak = z
    .object({
      provider: z.string().optional().describe("TTS provider (e.g., elevenlabs, openrouter)"),
      model: z.string().optional().describe("TTS voice ID (e.g., ElevenLabs voice ID, OpenRouter voice name)"),
      modelId: z.string().optional().describe("TTS model ID (e.g., eleven_v3, openai/gpt-audio-mini)"),
      outputFormat: z.string().optional().describe("TTS output format (e.g., mp3_44100_128, mp3, wav)"),
    })
    .strict()
    .meta({
      ref: "SpeakConfig",
    })
  export type Speak = z.infer<typeof Speak>

  export const Provider = ModelsDev.Provider.partial()
    .extend({
      // Opencode #28489: reuse another provider's auth flow. Useful for running
      // multiple model configurations under the same OAuth credentials.
      auth_provider: z
        .string()
        .optional()
        .describe(
          "Provider ID whose auth flow to reuse (e.g. 'github-copilot'). Credentials fall back to the source provider if none are stored under this alias.",
        ),
      whitelist: z.array(z.string()).optional(),
      blacklist: z.array(z.string()).optional(),
      models: z
        .record(
          z.string(),
          ModelsDev.Model.partial().extend({
            disabled: z
              .boolean()
              .optional()
              .describe(
                "Hide this model from the picker (opencode #21038). Useful when a provider exposes models you don't have access to on your subscription tier.",
              ),
            variants: z
              .record(
                z.string(),
                z
                  .object({
                    disabled: z.boolean().optional().describe("Disable this variant for the model"),
                  })
                  .catchall(z.any()),
              )
              .optional()
              .describe("Variant-specific configuration"),
          }),
        )
        .optional(),
      options: z
        .object({
          apiKey: z.string().optional(),
          baseURL: z.string().optional(),
          enterpriseUrl: z.string().optional().describe("GitHub Enterprise URL for copilot authentication"),
          setCacheKey: z.boolean().optional().describe("Enable promptCacheKey for this provider (default false)"),
          timeout: z
            .union([
              z
                .number()
                .int()
                .positive()
                .describe(
                  "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
                ),
              z.literal(false).describe("Disable timeout for this provider entirely."),
            ])
            .optional()
            .describe(
              "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
            ),
          headerTimeout: z
            .union([
              z
                .number()
                .int()
                .positive()
                .describe(
                  "Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.",
                ),
              z.literal(false).describe("Disable response header timeout for this provider."),
            ])
            .optional()
            .describe(
              "Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.",
            ),
          chunkTimeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Timeout in milliseconds between streamed SSE chunks for this provider. If no chunk arrives within this window, the request is aborted.",
            ),
        })
        .catchall(z.any())
        .optional(),
    })
    .strict()
    .meta({
      ref: "ProviderConfig",
    })
  export type Provider = z.infer<typeof Provider>

  export const PolicyStatement = z
    .object({
      effect: z.enum(["allow", "deny"]),
      action: z
        .string()
        .min(1)
        .regex(/^[^*]+\*?$|^\*$/, "Use either '*' or one trailing prefix wildcard")
        .describe("Operation name. Supports '*' and a trailing prefix wildcard."),
      resource: z
        .string()
        .min(1)
        .regex(/^[^*]+\*?$|^\*$/, "Use either '*' or one trailing prefix wildcard")
        .describe("Resource name. Supports '*' and a trailing prefix wildcard."),
    })
    .strict()
    .meta({
      ref: "PolicyStatementConfig",
    })
  export type PolicyStatement = z.infer<typeof PolicyStatement>

  export const SmallModelField = z
    .string()
    .describe("Small model to use for tasks like title generation in the format of provider/model")
    .optional()

  export const LspField = z
    .union([
      z.literal(false),
      z.record(
        z.string(),
        z.union([
          z.object({
            disabled: z.literal(true),
          }),
          z.object({
            command: z.array(z.string()),
            extensions: z.array(z.string()).optional(),
            disabled: z.boolean().optional(),
            env: z.record(z.string(), z.string()).optional(),
            initialization: z.record(z.string(), z.any()).optional(),
            /**
             * Opencode #17877: minimum diagnostic severity shown to the agent.
             * 1=Error (default), 2=Warning, 3=Info, 4=Hint.
             */
            min_severity: z
              .union([
                z
                  .number()
                  .int()
                  .min(1)
                  .max(4)
                  .describe("Minimum diagnostic severity: 1=Error (default), 2=Warning, 3=Info, 4=Hint."),
              ])
              .optional(),
          }),
        ]),
      ),
    ])
    .optional()
    .refine(
      (data) => {
        if (!data) return true
        if (typeof data === "boolean") return true
        const serverIds = new Set(Object.values(LSPServer).map((s) => s.id))

        return Object.entries(data).every(([id, config]) => {
          if (config.disabled) return true
          if (serverIds.has(id)) return true
          return Boolean(config.extensions)
        })
      },
      {
        error: "For custom LSP servers, 'extensions' array is required.",
      },
    )

  export const Info = z
    .object({
      $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
      theme: z.string().optional().describe("Theme name to use for the interface"),
      locale: z
        .object({
          language: z.string().optional().describe("UI and reply language as a BCP-47 primary subtag, e.g. 'it', 'en'"),
          region: z.string().optional().describe("ISO-3166 country code, e.g. 'IT', 'US'"),
          locale: z.string().optional().describe("Full BCP-47 tag, e.g. 'it-IT'; overrides language + region when set"),
          timezone: z.string().optional().describe("IANA timezone, e.g. 'Europe/Rome'"),
          currency: z.string().optional().describe("ISO-4217 currency code, e.g. 'EUR'; defaults from region"),
          autoDetect: z.boolean().optional().describe("Auto-detect locale from environment and system (default true)"),
          replyLanguage: z
            .union([z.boolean(), z.string()])
            .optional()
            .describe(
              "Instruct the model to reply in the user's language. true = detected language, a tag like 'it' = fixed language, false = off. Defaults to on for non-English locales.",
            ),
        })
        .optional()
        .describe("Localization: UI language, region, formatting, and model reply language"),
      keybinds: Keybinds.optional().describe("Custom keybind configurations"),
      logLevel: Log.Level.optional().describe("Log level"),
      tui: TUI.optional().describe("TUI specific settings"),
      ads: Ads.optional().describe("User-defined ads shown in the TUI tips area"),
      server: Server.optional().describe("Server configuration for nikcli serve and web commands"),
      remote: Remote.optional().describe("Remote Control defaults and behavior"),
      teleport: Teleport.optional().describe("Teleport server defaults for sending sessions to a remote server"),
      command: z
        .record(z.string(), Command)
        .optional()
        .describe("Command configuration, see https://nikcli-ai.dev/docs/commands"),
      reference: z
        .record(z.string(), Reference)
        .optional()
        .describe("Named external repositories or local directories exposed as read-only reference agents."),
      watcher: z
        .object({
          ignore: z.array(z.string()).optional(),
        })
        .optional(),
      plugin: z.string().array().optional(),
      snapshot: z.boolean().optional(),
      sync: z
        .object({
          url: z
            .string()
            .optional()
            .describe("Remote sync hub URL, e.g. https://s.nikcli-ai.dev. NIKCLI_REMOTE_URL overrides this."),
          token: z
            .string()
            .optional()
            .describe(
              "Bearer token for the remote hub (mobile, cli-sync, or studio scope). NIKCLI_REMOTE_TOKEN overrides this.",
            ),
          autostart: z
            .boolean()
            .optional()
            .describe("Connect to the hub automatically at startup (default true when url + token are set)"),
        })
        .strict()
        .optional()
        .describe("Optional hub-and-spoke remote sync settings, manageable from the TUI /sync dialog"),
      analytics: z
        .object({
          share: z
            .boolean()
            .optional()
            .describe(
              "Contribute anonymous per-day model totals to the public stats at nikcli-ai.dev/data. On by default; set false to opt out, or set DO_NOT_TRACK=1 / NIKCLI_DISABLE_ANALYTICS=1. Only day, provider, model, session count, message count, token count and cost are sent, under a random identifier — never prompts, paths, repositories, session titles or account.",
            ),
          endpoint: z
            .string()
            .optional()
            .describe("Where reports are sent. Defaults to the public nikcli endpoint; set this to self-host them."),
        })
        .strict()
        .optional()
        .describe("Opt-in anonymous usage reporting"),
      share: z
        .enum(["manual", "auto", "disabled"])
        .optional()
        .describe(
          "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
        ),
      autoshare: z
        .boolean()
        .optional()
        .describe("@deprecated Use 'share' field instead. Share newly created sessions automatically"),
      autoupdate: z
        .union([z.boolean(), z.literal("notify")])
        .optional()
        .describe(
          "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
        ),
      disabled_providers: z
        .array(z.string())
        .optional()
        .describe("@deprecated Use experimental.policies. Disable providers that are loaded automatically"),
      enabled_providers: z
        .array(z.string())
        .optional()
        .describe("@deprecated Use experimental.policies. When set, ONLY these providers will be enabled"),
      model: z.string().describe("Model to use in the format of provider/model, eg anthropic/claude-2").optional(),
      small_model: SmallModelField,
      default_agent: z
        .string()
        .optional()
        .describe(
          "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
        ),
      username: z
        .string()
        .optional()
        .describe("Custom username to display in conversations instead of system username"),
      mode: z
        .object({
          build: Agent.optional(),
          plan: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("@deprecated Use `agent` field instead."),
      agent: z
        .object({
          // primary
          plan: Agent.optional(),
          build: Agent.optional(),
          // subagent
          general: Agent.optional(),
          explore: Agent.optional(),
          scout: Agent.optional(),
          // specialized
          title: Agent.optional(),
          summary: Agent.optional(),
          compaction: Agent.optional(),
        })
        .catchall(Agent)
        .optional()
        .describe("Agent configuration, see https://nikcli-ai.dev/docs/agents"),
      provider: z
        .record(z.string(), Provider)
        .optional()
        .describe("Custom provider configurations and model overrides"),
      mcp: z
        .record(
          z.string(),
          z.union([
            Mcp,
            z
              .object({
                enabled: z.boolean(),
              })
              .strict(),
          ]),
        )
        .optional()
        .describe("MCP (Model Context Protocol) server configurations"),
      connectors: z
        .record(
          z.string(),
          z.union([
            Connector,
            z
              .object({
                enabled: z.boolean(),
              })
              .strict(),
          ]),
        )
        .optional()
        .describe("External service connectors (Figma, Slack, GitHub, Lovable)"),
      formatter: z
        .union([
          z.literal(false),
          z.literal(true),
          z.record(
            z.string(),
            z.object({
              disabled: z.boolean().optional(),
              command: z.array(z.string()).optional(),
              environment: z.record(z.string(), z.string()).optional(),
              extensions: z.array(z.string()).optional(),
            }),
          ),
        ])
        .optional(),
      websearch: WebSearchConfigSchema.optional(),
      lsp: LspField,
      instructions: z.array(z.string()).optional().describe("Additional instruction files or patterns to include"),
      layout: Layout.optional().describe("@deprecated Always uses stretch layout."),
      permission: Permission.optional(),
      permission_mode: PermissionMode.optional().describe("Permission mode sessions start in (default: default)"),
      auto_mode: AutoMode.optional().describe("Auto mode classifier settings (read from the global config only)"),
      tools: z.record(z.string(), z.boolean()).optional(),
      /**
       * Custom tool-file load policy for `{tool,tools}/*.{js,ts}` under
       * config directories. Distinct from deprecated `tools` (enable/disable
       * registered tool ids). See `ToolRegistry` + `NIKCLI_ALLOW_PLUGIN_AUTOLOAD`.
       */
      tool: z
        .object({
          allow: z
            .array(z.string())
            .optional()
            .describe(
              "Allowlist of custom tool file basenames or absolute paths. When set, only these files are imported (even without NIKCLI_ALLOW_PLUGIN_AUTOLOAD).",
            ),
          pin: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              "Map of basename/absolute path → sha256 hex. When set, mismatch rejects the file and skips registration.",
            ),
        })
        .optional()
        .describe("Filesystem tool autoload allowlist and integrity pins"),
      enterprise: z
        .object({
          url: z.string().optional().describe("Enterprise URL"),
        })
        .optional(),
      compaction: z
        .object({
          auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
          prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
          reserved: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Token buffer for compaction. Leaves enough window to avoid overflow during compaction."),
        })
        .optional(),
      experimental: z
        .object({
          policies: z
            .array(PolicyStatement)
            .optional()
            .describe("Ordered resource policy statements. Matching statements apply in order; the last match wins."),
          hook: z
            .object({
              file_edited: z
                .record(
                  z.string(),
                  z
                    .object({
                      command: z.string().array(),
                      environment: z.record(z.string(), z.string()).optional(),
                    })
                    .array(),
                )
                .optional(),
              session_completed: z
                .object({
                  command: z.string().array(),
                  environment: z.record(z.string(), z.string()).optional(),
                })
                .array()
                .optional(),
            })
            .optional(),
          // Opencode #21535: wrap template for queued user messages. Off unless
          // set — wrapping mid-turn text in "continue with your tasks" made
          // steer/wake absorption weaker than the pre-queue path.
          queued_message_wrap: z
            .union([
              z
                .object({
                  header: z.string().describe("Text before the user message."),
                  footer: z.string().describe("Text after the user message."),
                })
                .describe("Custom wrap template for queued user messages."),
              z.literal("default").describe("Use the default wrap (matches opencode upstream)."),
              z.boolean().describe("false to disable queued-message wrapping entirely; true for the default template."),
              z.null().describe("Disable queued-message wrapping entirely."),
            ])
            .optional()
            .describe("Opencode #21535: queued user-message wrap template."),
          chatMaxRetries: z.number().optional().describe("Number of retries for chat completions on failure"),
          disable_paste_summary: z.boolean().optional(),
          batch_tool: z.boolean().optional().describe("Enable the batch tool"),
          openTelemetry: z
            .boolean()
            .optional()
            .describe(
              "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag). Enabled by default; set to false to opt out. Spans are only exported when OTEL_EXPORTER_OTLP_ENDPOINT is set.",
            ),
          primary_tools: z
            .array(z.string())
            .optional()
            .describe("Tools that should only be available to primary agents."),
          continue_loop_on_deny: z.boolean().optional().describe("Continue the agent loop when a tool call is denied"),
          brain: z.boolean().optional().describe("Enable automatic memory consolidation (brain) feature"),
          brainMinHours: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Minimum hours between brain consolidation runs"),
          brainMinSessions: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Minimum number of sessions to trigger brain consolidation"),
          brainModel: z
            .string()
            .optional()
            .describe(
              "Model to use for the Brain memory consolidation session in the format of provider/model, e.g. anthropic/claude-sonnet-4-5. Falls back to the default model when unset.",
            ),
          memory: z.boolean().optional().describe("Enable memory file support for session context"),
          mcp_timeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in milliseconds for model context protocol (MCP) requests"),
          tool_timeout: z
            .union([z.number().int().positive(), z.literal(false)])
            .optional()
            .describe(
              "Outer timeout in milliseconds for non-task tool executions. Default 600000 (10 minutes). Set to false to disable. Tools that manage their own timeout (bash) still honor this as a hard outer bound when set.",
            ),
          task_timeout: z
            .union([z.number().int().positive(), z.literal(false)])
            .optional()
            .describe(
              "Timeout in milliseconds for foreground (non-background) task tool runs. Default 1800000 (30 minutes). Set to false to disable. Background tasks are unaffected.",
            ),
          nativeLlm: z
            .boolean()
            .optional()
            .describe(
              "Enable native @nikcli-ai/llm route streaming (requires resolvable ModelRef; falls back to AI SDK). Default off.",
            ),
          tui: z
            .object({
              cacheEviction: z
                .boolean()
                .optional()
                .describe(
                  "Bound in-memory TUI sync payload (message/part/diff/todo) with LRU eviction on session sync. Default off.",
                ),
              messageVirtualization: z
                .boolean()
                .optional()
                .describe(
                  "Window the session message list via message-window visibleRange instead of rendering all messages. Default off.",
                ),
              explorationGrouping: z
                .boolean()
                .optional()
                .describe(
                  "Collapse consecutive read-only tool calls (read/grep/glob/list/codesearch/webfetch) into a single summary row once the run finishes. Default off.",
                ),
            })
            .optional(),
          requests: z
            .object({
              latestOnlyLspRefresh: z
                .boolean()
                .optional()
                .describe("Coalesce rapid lsp.updated events into a single in-flight lsp.status refresh. Default off."),
            })
            .optional(),
          events: z
            .object({
              schemaEncoding: z
                .boolean()
                .optional()
                .describe(
                  "Encode SSE event payloads through their registered schema before serializing. Drops keys the schema does not declare, so the wire shape follows the contract rather than the publisher. Default off.",
                ),
            })
            .optional(),
        })
        .optional(),
      rag: Rag.optional().describe("RAG embedding configuration"),
      image: Image.optional().describe("Image generation configuration"),
      // Settings for the Browser Use Cloud path that was never shipped; nothing
      // has ever read them and `browser_control` needs no configuration. The key
      // stays accepted because the config object is strict — dropping it outright
      // would make an old nikcli.json fail to load rather than be ignored.
      browser: z.unknown().optional().describe("Deprecated and ignored; the browser_control tool needs no config"),
      computer: Computer.optional().describe("Computer use (computer tool) configuration"),
      attachment: Attachment.optional().describe("Attachment handling configuration"),
      speak: Speak.optional().describe("Text-to-speech configuration"),
      notifications: z
        .object({
          todo: z
            .object({
              enabled: z.boolean().optional().describe("Enable todo notifications"),
              macos: z.boolean().optional().describe("Enable macOS native notifications"),
              slack: z
                .object({
                  enabled: z.boolean().optional(),
                  connector: z.string().optional().describe("Name of the Slack connector to use"),
                  channel: z.string().optional().describe("Slack channel ID or name"),
                })
                .optional(),
              discord: z
                .object({
                  enabled: z.boolean().optional(),
                  webhook: z.string().optional().describe("Discord webhook URL"),
                })
                .optional(),
            })
            .optional(),
          icon: z
            .object({
              url: z.string().optional().describe("Icon image URL or file path for macOS notifications"),
              alt: z.string().optional().describe("Alt text (unused for macOS)"),
            })
            .optional(),
          notify: z
            .object({
              enabled: z.boolean().optional().describe("Enable native notifications"),
              macos: z.boolean().optional().describe("Enable macOS native notifications"),
              slack: z
                .object({
                  enabled: z.boolean().optional(),
                  connector: z.string().optional().describe("Name of the Slack connector to use"),
                  channel: z.string().optional().describe("Slack channel ID or name"),
                })
                .optional(),
              discord: z
                .object({
                  enabled: z.boolean().optional(),
                  webhook: z.string().optional().describe("Discord webhook URL"),
                })
                .optional(),
              events: z
                .object({
                  sessionIdle: z.boolean().optional().describe("Notify when a session becomes idle"),
                  sessionError: z.boolean().optional().describe("Notify when a session errors"),
                  permissionAsked: z.boolean().optional().describe("Notify when permissions are requested"),
                  questionAsked: z.boolean().optional().describe("Notify when questions are asked"),
                })
                .optional(),
              idleMinMs: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Minimum busy duration before idle notifications"),
              rateLimit: z
                .object({
                  windowMs: z.number().int().positive().optional().describe("Rate limit window in ms"),
                  maxPerWindow: z.number().int().positive().optional().describe("Max notifications per window"),
                })
                .optional(),
              retry: z
                .object({
                  attempts: z.number().int().positive().optional(),
                  delay: z.number().int().positive().optional().describe("Initial retry delay in ms"),
                  factor: z.number().positive().optional().describe("Backoff multiplier"),
                  maxDelay: z.number().int().positive().optional().describe("Max retry delay in ms"),
                  timeoutMs: z.number().int().positive().optional().describe("Timeout per attempt in ms"),
                })
                .optional(),
              breaker: z
                .object({
                  failures: z.number().int().positive().optional().describe("Failures before circuit opens"),
                  cooldownMs: z.number().int().positive().optional().describe("Circuit breaker cooldown in ms"),
                })
                .optional(),
              quietHours: z
                .object({
                  enabled: z.boolean().optional().describe("Enable quiet hours"),
                  start: z.string().optional().describe("Quiet hours start (HH:MM)"),
                  end: z.string().optional().describe("Quiet hours end (HH:MM)"),
                  suppress: z
                    .array(z.enum(["macos", "slack", "discord"]))
                    .optional()
                    .describe("Channels suppressed during quiet hours"),
                })
                .optional(),
            })
            .optional(),
        })
        .optional()
        .describe("Notification settings for various events"),
      mobile: z
        .object({
          tophat: z
            .object({
              enabled: z.boolean().optional().describe("Enable Tophat integration"),
              cliPath: z.string().optional().describe("Custom path to tophatctl binary"),
              defaultPlatform: z.enum(["ios", "android"]).optional().describe("Default target platform"),
              defaultDestination: z
                .enum(["device", "simulator", "emulator"])
                .optional()
                .describe("Default install destination"),
              autoDetect: z.boolean().optional().describe("Auto-detect mobile projects (default: true)"),
            })
            .strict()
            .optional(),
        })
        .strict()
        .optional()
        .describe("Mobile development settings"),
    })
    .strict()
    .meta({
      ref: "Config",
    })

  export type Info = z.output<typeof Info>

  async function global() {
    return await loadFile(path.join(Global.Path.config, "nikcli.json"))
  }

  async function loadFile(filepath: string, env: Record<string, string> = {}): Promise<Info> {
    log.info("loading", { path: filepath })
    let text = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return
        throw Object.assign(new JsonError({ path: filepath }), { cause: err })
      })
    if (!text) return {}
    return load(text, filepath, env)
  }

  async function load(
    text: string,
    configFilepath: string,
    env: Record<string, string> = {},
    allowProcessEnv = true,
    allowFileRefs = true,
  ) {
    const original = text
    // Opencode #21197: load .env files from the config directory and merge them
    // into the lookup chain for {env:VAR}. Process env still wins (later wins).
    if (allowProcessEnv && allowFileRefs) {
      const configDir = path.dirname(configFilepath)
      for (const envFile of [".env", ".env.local"]) {
        try {
          const content = await Bun.file(path.join(configDir, envFile)).text()
          for (const line of content.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
            if (m && !(m[1] in env)) env[m[1]] = m[2]
          }
        } catch {
          // .env files are optional
        }
      }
    }
    text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return env[varName] ?? (allowProcessEnv ? (process.env[varName] ?? "") : "")
    })

    const fileMatches = text.match(/\{file:[^}]+\}/g)
    if (allowFileRefs && fileMatches) {
      const configDir = path.dirname(configFilepath)
      const lines = text.split("\n")

      for (const match of fileMatches) {
        const lineIndex = lines.findIndex((line) => line.includes(match))
        if (lineIndex !== -1 && lines[lineIndex].trim().startsWith("//")) {
          continue // Skip if line is commented
        }
        let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
        if (filePath.startsWith("~/")) {
          filePath = path.join(os.homedir(), filePath.slice(2))
        }
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
        const fileContent = (
          await Bun.file(resolvedPath)
            .text()
            .catch((error) => {
              const errMsg = `bad file reference: "${match}"`
              if (error.code === "ENOENT") {
                throw Object.assign(
                  new InvalidError({
                    path: configFilepath,
                    message: errMsg + ` ${resolvedPath} does not exist`,
                  }),
                  { cause: error },
                )
              }
              throw Object.assign(new InvalidError({ path: configFilepath, message: errMsg }), { cause: error })
            })
        ).trim()
        // escape newlines/quotes, strip outer quotes
        text = text.replace(match, JSON.stringify(fileContent).slice(1, -1))
      }
    }

    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: configFilepath,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) {
      if (!parsed.data.$schema) {
        parsed.data.$schema = "https://nikcli-ai.dev/config.json"
        // Write the $schema to the original text to preserve variables like {env:VAR}
        const updated = original.replace(/^\s*\{/, '{\n  "$schema": "https://nikcli-ai.dev/config.json",')
        let tmp: string | undefined
        try {
          const target = await fs.realpath(configFilepath).catch(() => configFilepath)
          const stat = await fs.stat(target).catch(() => undefined)
          if (stat?.isFile()) {
            tmp = target + ".tmp"
            await Bun.write(tmp, updated)
            // chmod is Unix-only, skip on Windows
            if (process.platform !== "win32") {
              await fs.chmod(tmp, stat.mode & 0o777)
            }
            await fs.rename(tmp, target)
          }
        } catch (error) {
          log.debug("failed to persist config schema hint", {
            path: configFilepath,
            error,
          })
        } finally {
          if (tmp) {
            await fs.unlink(tmp).catch(() => undefined)
          }
        }
      }
      const data = parsed.data
      if (data.plugin) {
        for (let i = 0; i < data.plugin.length; i++) {
          const plugin = data.plugin[i]
          try {
            data.plugin[i] = import.meta.resolve!(plugin, configFilepath)
          } catch (err) {
            log.warn("failed to resolve plugin path", { plugin, error: err })
          }
        }
      }
      return data
    }

    throw new InvalidError({
      path: configFilepath,
      issues: parsed.error.issues,
    })
  }
  export class JsonError extends Schema.TaggedError<JsonError>()("ConfigJsonError", {
    path: Schema.String,
    message: Schema.optional(Schema.String),
  }) {}

  export class ConfigDirectoryTypoError extends Schema.TaggedError<ConfigDirectoryTypoError>()(
    "ConfigDirectoryTypoError",
    {
      path: Schema.String,
      dir: Schema.String,
      suggestion: Schema.String,
    },
  ) {}

  export class InvalidError extends Schema.TaggedError<InvalidError>()("ConfigInvalidError", {
    path: Schema.optional(Schema.String),
    issues: Schema.optional(Schema.Unknown),
    message: Schema.optional(Schema.String),
  }) {}

  /**
   * Thrown when fetching a remote well-known config endpoint returns a
   * non-2xx response. Tagged so the call site can use
   * `Effect.catchTag("ConfigRemoteFetch", ...)` and the existing
   * `instanceof Config.RemoteFetchError` continues to work.
   */
  export class RemoteFetchError extends Schema.TaggedError<RemoteFetchError>()("ConfigRemoteFetch", {
    url: Schema.String,
    status: Schema.Number,
  }) {}

  async function updateImpl(ctx: InstanceContext, config: Info) {
    const filepath = path.join(ctx.directory, "nikcli.json")
    const existing = await loadFile(filepath)
    await Bun.write(filepath, JSON.stringify(mergeDeep(existing, config), null, 2))
  }

  function globalConfigFile() {
    return path.join(Global.Path.config, "nikcli.json")
  }

  function parseConfig(text: string, filepath: string): Info {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: filepath,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) return parsed.data

    throw new InvalidError({
      path: filepath,
      issues: parsed.error.issues,
    })
  }

  async function updateGlobalImpl(config: Info) {
    const filepath = globalConfigFile()
    const before = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return "{}"
        throw Object.assign(new JsonError({ path: filepath }), { cause: err })
      })

    const existing = before.trim() ? parseConfig(before, filepath) : ({} as Info)
    await Bun.write(filepath, JSON.stringify(mergeDeep(existing, config), null, 2))

    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Event.Disposed.type,
        properties: {},
      },
    })
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const paths = yield* ConfigPaths.Service
      const appFs = yield* AppFileSystem.Service
      const scopedState = yield* makeScopedState(paths, appFs)

      const get: Interface["get"] = Effect.fn("Config.get")(function* () {
        return (yield* InstanceState.get(scopedState)).config
      })

      const getGlobal: Interface["getGlobal"] = Effect.fn("Config.getGlobal")(function* () {
        return yield* Effect.promise(() => Promise.resolve(global()))
      })

      const update: Interface["update"] = Effect.fn("Config.update")(function* (config) {
        const ctx = yield* InstanceState.context
        yield* Effect.promise(() => updateImpl(ctx, config))
        yield* ScopedCache.invalidate(scopedState, ctx.directory)
      })

      const updateGlobal: Interface["updateGlobal"] = Effect.fn("Config.updateGlobal")(function* (config) {
        yield* Effect.promise(() => updateGlobalImpl(config))
        yield* ScopedCache.invalidateAll(scopedState)
      })

      const directories: Interface["directories"] = Effect.fn("Config.directories")(function* () {
        return (yield* InstanceState.get(scopedState)).directories
      })

      return Service.of({
        directories,
        get,
        getGlobal,
        update,
        updateGlobal,
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(ConfigPaths.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
  )
}
