import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import semver from "semver"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import { hasPluginExport, pluginExportEntry } from "@nikcli-ai/util/plugin-read"
import { isRecord } from "@nikcli-ai/util/record"

// Old npm package names for plugins that are now built-in
export const DEPRECATED_PLUGIN_PACKAGES = ["nikcli-openai-codex-auth", "nikcli-copilot-auth"]

export function isDeprecatedPlugin(spec: string) {
  return DEPRECATED_PLUGIN_PACKAGES.some((pkg) => spec.includes(pkg))
}

export function parsePluginSpecifier(spec: string) {
  const lastAt = spec.lastIndexOf("@")
  const pkg = lastAt > 0 ? spec.substring(0, lastAt) : spec
  const version = lastAt > 0 ? spec.substring(lastAt + 1) : "latest"
  return { pkg, version }
}

export type PluginSource = "file" | "npm"
export type PluginKind = "server" | "tui"
type PluginMode = "strict" | "detect"

export function pluginSource(spec: string): PluginSource {
  return spec.startsWith("file://") ? "file" : "npm"
}

function resolveExportPath(raw: string, dir: string) {
  if (raw.startsWith("./") || raw.startsWith("../")) return path.resolve(dir, raw)
  if (raw.startsWith("file://")) return fileURLToPath(raw)
  return raw
}

export async function resolvePluginEntrypoint(spec: string, target: string, kind: PluginKind) {
  const pkg = await readPluginPackage(target).catch(() => undefined)
  if (!pkg) return target
  if (!hasPluginExport(pkg.json, kind)) return target

  const raw = pluginExportEntry(pkg.json, kind)
  if (!raw) return target

  const resolved = resolveExportPath(raw, pkg.dir)
  const root = Filesystem.resolve(pkg.dir)
  const next = Filesystem.resolve(resolved)
  if (!Filesystem.contains(root, next)) {
    throw new Error(`Plugin ${spec} resolved ${kind} entry outside plugin directory`)
  }

  return pathToFileURL(next).href
}

export function isPathPluginSpec(spec: string) {
  return spec.startsWith("file://") || spec.startsWith(".") || path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)
}

export async function resolvePathPluginTarget(spec: string) {
  const raw = spec.startsWith("file://") ? fileURLToPath(spec) : spec
  const file = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? raw : path.resolve(raw)
  const stat = await Filesystem.stat(file)
  if (!stat?.isDirectory()) {
    if (spec.startsWith("file://")) return spec
    return pathToFileURL(file).href
  }

  const pkg = await Filesystem.readJson<Record<string, unknown>>(path.join(file, "package.json")).catch(() => undefined)
  if (!pkg) throw new Error(`Plugin directory ${file} is missing package.json`)
  if (typeof pkg.main !== "string" || !pkg.main.trim()) {
    throw new Error(`Plugin directory ${file} must define package.json main`)
  }
  return pathToFileURL(path.resolve(file, pkg.main)).href
}

/**
 * Whether `version` satisfies `range`, with the host's coercion rules.
 *
 * Exported so the TUI plugin runtime can check a v2 manifest's
 * `hostRequirements` without taking its own `semver` dependency — this package
 * already has one, and the TUI already depends on this package. A second copy
 * on the startup path buys nothing.
 *
 * An unparseable range is a failure, not a pass: a manifest that asks for
 * something nobody can read is a manifest nobody has checked.
 */
export function satisfiesRange(version: string, range: string): boolean {
  if (!semver.validRange(range)) return false
  const coerced = semver.coerce(version)?.version ?? version
  return semver.satisfies(coerced, range)
}

export async function checkPluginCompatibility(target: string, nikcliVersion: string) {
  if (!semver.valid(nikcliVersion) || semver.major(nikcliVersion) === 0) return
  const pkg = await readPluginPackage(target).catch(() => undefined)
  if (!pkg) return
  const engines = pkg.json.engines
  if (!isRecord(engines)) return
  const range = engines.nikcli
  if (typeof range !== "string") return
  if (!semver.satisfies(nikcliVersion, range)) {
    throw new Error(`Plugin requires nikcli ${range} but running ${nikcliVersion}`)
  }
}

/**
 * How a package specifier becomes a directory on disk.
 *
 * Everything else in this module is path and manifest work that both the server
 * and the terminal do; this one line shells out to `bun install`, which is the
 * host's job and the only reason the module used to live in `packages/nikcli`.
 * The host sets it once at startup — `src/plugin/shared.ts` does, on import.
 */
let installPackage: ((pkg: string, version: string) => Promise<string>) | undefined

export function configurePluginInstaller(install: (pkg: string, version: string) => Promise<string>): void {
  installPackage = install
}

export async function resolvePluginTarget(spec: string, parsed = parsePluginSpecifier(spec)) {
  if (isPathPluginSpec(spec)) return resolvePathPluginTarget(spec)
  if (!installPackage) {
    throw new Error(`Cannot install ${parsed.pkg}: no package installer is configured in this process`)
  }
  return installPackage(parsed.pkg, parsed.version)
}

export async function readPluginPackage(target: string) {
  const file = target.startsWith("file://") ? fileURLToPath(target) : target
  const stat = await Filesystem.stat(file)
  const dir = stat?.isDirectory() ? file : path.dirname(file)
  const pkg = path.join(dir, "package.json")
  const json = await Filesystem.readJson<Record<string, unknown>>(pkg)
  return { dir, pkg, json }
}

export function readPluginId(id: unknown, spec: string) {
  if (id === undefined) return
  if (typeof id !== "string") throw new TypeError(`Plugin ${spec} has invalid id type ${typeof id}`)
  const value = id.trim()
  if (!value) throw new TypeError(`Plugin ${spec} has an empty id`)
  return value
}

export async function getPluginIdFromPackage(target: string, spec: string): Promise<string | undefined> {
  try {
    const pkg = await readPluginPackage(target)
    if (typeof pkg.json.name !== "string" || !pkg.json.name.trim()) {
      return undefined
    }
    return pkg.json.name.trim()
  } catch {
    return undefined
  }
}

export function readV1Plugin(
  mod: Record<string, unknown>,
  spec: string,
  kind: PluginKind,
  mode: PluginMode = "strict",
) {
  const value = mod.default
  if (!isRecord(value)) {
    if (mode === "detect") return
    throw new TypeError(`Plugin ${spec} must default export an object with ${kind}()`)
  }
  if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return

  const server = "server" in value ? value.server : undefined
  const tui = "tui" in value ? value.tui : undefined
  if (server !== undefined && typeof server !== "function") {
    if (mode === "detect") return
    throw new TypeError(`Plugin ${spec} has invalid server export`)
  }
  if (tui !== undefined && typeof tui !== "function") {
    if (mode === "detect") return
    throw new TypeError(`Plugin ${spec} has invalid tui export`)
  }
  if (server !== undefined && tui !== undefined) {
    if (mode === "detect") return
    throw new TypeError(`Plugin ${spec} must default export either server() or tui(), not both`)
  }
  if (kind === "server" && server === undefined) {
    if (mode === "detect") return
    throw new TypeError(`Plugin ${spec} must default export an object with server()`)
  }
  if (kind === "tui" && tui === undefined) {
    if (mode === "detect") return undefined
  }

  return value
}

export async function resolvePluginId(source: PluginSource, spec: string, target: string, id: string | undefined) {
  if (source === "file") {
    if (id) return id
    throw new TypeError(`Path plugin ${spec} must export id`)
  }
  if (id) return id
  const pkg = await readPluginPackage(target)
  if (typeof pkg.json.name !== "string" || !pkg.json.name.trim()) {
    throw new TypeError(`Plugin package ${pkg.pkg} is missing name`)
  }
  return pkg.json.name.trim()
}
