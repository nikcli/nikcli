import { joinPath } from "../host/path"
import type { McpInstallConfiguration, McpServerConfig } from "./mcp-catalog"
import { t } from "../i18n"

export type { McpInstallConfiguration, McpServerConfig } from "./mcp-catalog"

export const MCP_CONFIG_FILENAME = ".mcp.json"

type JsonObject = Record<string, unknown>

export interface McpConfigDocument extends JsonObject {
  readonly mcpServers?: Record<string, unknown>
}

/** The small filesystem seam needed by the project-level operations. */
export interface McpConfigIO {
  readTextFile: (path: string, maxBytes?: number) => Promise<{ text: string; truncated?: boolean }>
  writeTextFile: (path: string, contents: string) => Promise<string | null | undefined | void>
  /** When present, distinguishes an unreadable file from a missing file. */
  exists?: (path: string) => Promise<boolean>
}

export type McpConfigErrorCode =
  | "invalid-json"
  | "invalid-document"
  | "invalid-server-name"
  | "duplicate-server"
  | "invalid-server-config"
  | "secret-value"
  | "read-failed"
  | "write-failed"

export class McpConfigError extends Error {
  readonly code: McpConfigErrorCode

  constructor(code: McpConfigErrorCode, message: string) {
    super(message)
    this.name = "McpConfigError"
    this.code = code
  }
}

const SECRET_REFERENCE = /^\$\{[A-Z][A-Z0-9_]*\}$/
const SECRET_HEADER_TEMPLATE = /^(?:(?:Bearer|Basic) )?\$\{[A-Z][A-Z0-9_]*\}$/
const SECRET_ARGUMENT_TEMPLATE = /^(?:--[A-Za-z0-9_-]+=)?\$\{[A-Z][A-Z0-9_]*\}$/

/** True only for the `${UPPER_SNAKE_CASE}` references ADE may persist. */
export function isSecretReference(value: string): boolean {
  return SECRET_REFERENCE.test(value)
}

/** `.mcp.json` lives in the project, never in ADE's global settings. */
export function mcpConfigPath(projectRoot: string): string {
  return joinPath(projectRoot, MCP_CONFIG_FILENAME)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parses a project config while keeping all unrelated top-level keys intact. */
export function parseMcpConfig(raw: string | null | undefined): McpConfigDocument {
  if (raw === undefined || raw === null || raw.trim().length === 0) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\ufeff/, ""))
  } catch {
    throw new McpConfigError("invalid-json", t("mcp.error.json", MCP_CONFIG_FILENAME))
  }

  if (!isObject(parsed)) {
    throw new McpConfigError("invalid-document", t("mcp.error.document", MCP_CONFIG_FILENAME))
  }
  if ("mcpServers" in parsed && !isObject(parsed.mcpServers)) {
    throw new McpConfigError("invalid-document", t("mcp.error.servers", MCP_CONFIG_FILENAME))
  }
  return parsed
}

function serverName(name: string): string {
  if (name.trim() !== name || name.length === 0 || name.length > 128 || name === "__proto__") {
    throw new McpConfigError("invalid-server-name", t("mcp.error.name"))
  }
  return name
}

function isSensitiveName(name: string): boolean {
  return /(authorization|bearer|token|secret|password|api[_-]?key|client[_-]?(id|secret)|connection)/i.test(name)
}

function hasSafeSecretTemplate(value: string, pattern = SECRET_HEADER_TEMPLATE): boolean {
  return pattern.test(value)
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpConfigError("invalid-server-config", t("mcp.error.emptyString", label))
  }
}

/**
 * Checks only the values ADE is about to add. Existing project entries are
 * preserved as-is, but a newly selected card can never smuggle a raw token
 * into the project file.
 */
export function validateMcpServerConfig(config: McpServerConfig): void {
  if (!isObject(config)) {
    throw new McpConfigError("invalid-server-config", t("mcp.error.notObject"))
  }

  const hasUrl = config.url !== undefined
  const hasCommand = config.command !== undefined
  if (!hasUrl && !hasCommand) {
    throw new McpConfigError("invalid-server-config", t("mcp.error.urlOrCommand"))
  }

  if (hasUrl && hasCommand) {
    throw new McpConfigError("invalid-server-config", t("mcp.error.urlAndCommand"))
  }
  if (hasUrl && config.type !== "http" && config.type !== "sse") {
    throw new McpConfigError(
      "invalid-server-config",
      t("mcp.error.remoteType"),
    )
  }
  if (hasCommand && config.type !== undefined && config.type !== "stdio") {
    throw new McpConfigError("invalid-server-config", t("mcp.error.stdioType"))
  }

  if (hasUrl) {
    assertString(config.url, "url")
    try {
      const url = new URL(config.url)
      if (url.username || url.password) {
        throw new McpConfigError("secret-value", t("mcp.error.urlCredentials"))
      }
      for (const [name, value] of url.searchParams) {
        if (isSensitiveName(name) && !isSecretReference(value)) {
          throw new McpConfigError(
            "secret-value",
            t("mcp.error.urlSecret", name),
          )
        }
      }
    } catch (error) {
      if (error instanceof McpConfigError) throw error
      throw new McpConfigError("invalid-server-config", t("mcp.error.url"))
    }
  }
  if (hasCommand) assertString(config.command, "command")

  if (config.args !== undefined) {
    if (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string")) {
      throw new McpConfigError("invalid-server-config", t("mcp.error.args"))
    }
    for (const [index, arg] of config.args.entries()) {
      if (!isSensitiveName(arg)) continue
      const value = arg.includes("=") ? arg : config.args[index + 1]
      const safe = arg.includes("=")
        ? hasSafeSecretTemplate(arg, SECRET_ARGUMENT_TEMPLATE)
        : value !== undefined && isSecretReference(value)
      if (!safe) {
        throw new McpConfigError(
          "secret-value",
          t("mcp.error.argSecret", index),
        )
      }
    }
  }

  if (config.env !== undefined) {
    if (!isObject(config.env)) {
      throw new McpConfigError("invalid-server-config", t("mcp.error.env"))
    }
    for (const [name, value] of Object.entries(config.env)) {
      assertString(value, `env.${name}`)
      if (isSensitiveName(name) && !isSecretReference(value)) {
        throw new McpConfigError(
          "secret-value",
          t("mcp.error.secretRef", `env.${name}`),
        )
      }
    }
  }

  if (config.headers !== undefined) {
    if (!isObject(config.headers)) {
      throw new McpConfigError("invalid-server-config", t("mcp.error.headers"))
    }
    for (const [name, value] of Object.entries(config.headers)) {
      assertString(value, `headers.${name}`)
      if (isSensitiveName(name) && !hasSafeSecretTemplate(value)) {
        throw new McpConfigError(
          "secret-value",
          t("mcp.error.secretRef", `headers.${name}`),
        )
      }
    }
  }

  if (config.oauth !== undefined) {
    if (!isObject(config.oauth)) {
      throw new McpConfigError("invalid-server-config", t("mcp.error.oauth"))
    }
    assertString(config.oauth.clientId, "oauth.clientId")
    assertString(config.oauth.clientSecret, "oauth.clientSecret")
    if (!isSecretReference(config.oauth.clientId) || !isSecretReference(config.oauth.clientSecret)) {
      throw new McpConfigError(
        "secret-value",
        t("mcp.error.oauthSecret"),
      )
    }
  }
}

function installationOf(
  input: McpInstallConfiguration | string,
  definition?: McpServerConfig,
): McpInstallConfiguration {
  if (typeof input === "string") {
    if (definition === undefined) {
      throw new McpConfigError("invalid-server-config", t("mcp.error.missing"))
    }
    return { name: input, server: definition }
  }
  return input
}

function indentation(raw: string | null | undefined): string {
  if (!raw) return "  "
  const line = raw.split(/\r?\n/).find((candidate) => /^\s+\"[^\"]+\"\s*:/.test(candidate))
  if (!line) return "  "
  const leading = line.match(/^\s+/)?.[0] ?? "  "
  return leading.includes("\t") ? "\t" : leading.slice(0, 10)
}

function newline(raw: string | null | undefined): "\n" | "\r\n" {
  return raw?.includes("\r\n") ? "\r\n" : "\n"
}

function render(document: JsonObject, source: string | null | undefined): string {
  let json: string
  try {
    json = JSON.stringify(document, null, indentation(source))
  } catch {
    throw new McpConfigError("invalid-document", t("mcp.error.serialize", MCP_CONFIG_FILENAME))
  }
  const lineBreak = newline(source)
  if (lineBreak === "\r\n") json = json.replace(/\n/g, "\r\n")
  return `${json}${lineBreak}`
}

/** Adds one card's server definition and refuses an existing name. */
export function addMcpServer(raw: string | null | undefined, installation: McpInstallConfiguration): string
export function addMcpServer(raw: string | null | undefined, name: string, server: McpServerConfig): string
export function addMcpServer(
  raw: string | null | undefined,
  input: McpInstallConfiguration | string,
  definition?: McpServerConfig,
): string {
  const chosen = installationOf(input, definition)
  const name = serverName(chosen.name)
  validateMcpServerConfig(chosen.server)

  const document = parseMcpConfig(raw)
  const servers = isObject(document.mcpServers) ? document.mcpServers : {}
  if (Object.prototype.hasOwnProperty.call(servers, name)) {
    throw new McpConfigError("duplicate-server", t("mcp.error.duplicate", name, MCP_CONFIG_FILENAME))
  }

  return render({ ...document, mcpServers: { ...servers, [name]: chosen.server } }, raw)
}

/** Removes one server and returns the original text when there was nothing to remove. */
export function removeMcpServer(raw: string | null | undefined, name: string): string | undefined {
  if (raw === undefined || raw === null) return raw ?? undefined
  const key = serverName(name)
  const document = parseMcpConfig(raw)
  const servers = document.mcpServers
  if (!isObject(servers) || !Object.prototype.hasOwnProperty.call(servers, key)) return raw

  const nextServers = { ...servers }
  delete nextServers[key]
  return render({ ...document, mcpServers: nextServers }, raw)
}

/** Reads `.mcp.json`; an absent file is the normal first-install case. */
export async function readProjectMcpConfig(projectRoot: string, io: McpConfigIO): Promise<string | undefined> {
  const path = mcpConfigPath(projectRoot)
  try {
    const read = await io.readTextFile(path)
    if (read.truncated) {
      throw new McpConfigError(
        "read-failed",
        t("mcp.error.tooLarge", MCP_CONFIG_FILENAME),
      )
    }
    return read.text
  } catch (error) {
    if (error instanceof McpConfigError) throw error
    if (io.exists) {
      let present = false
      try {
        present = await io.exists(path)
      } catch {
        present = true
      }
      if (present) {
        throw new McpConfigError(
          "read-failed",
          t("mcp.error.read", MCP_CONFIG_FILENAME, error instanceof Error ? error.message : String(error)),
        )
      }
    }
    return undefined
  }
}

async function writeProjectMcpConfig(projectRoot: string, contents: string, io: McpConfigIO): Promise<void> {
  const failure = await io.writeTextFile(mcpConfigPath(projectRoot), contents)
  if (failure) {
    throw new McpConfigError("write-failed", t("mcp.error.write", MCP_CONFIG_FILENAME, String(failure)))
  }
}

/** Merges one server into the project file and returns the written text. */
export async function addMcpServerToProject(
  projectRoot: string,
  installation: McpInstallConfiguration,
  io: McpConfigIO,
): Promise<string> {
  const current = await readProjectMcpConfig(projectRoot, io)
  const next = addMcpServer(current, installation)
  await writeProjectMcpConfig(projectRoot, next, io)
  return next
}

/** Removes one server from the project file without rewriting a no-op. */
export async function removeMcpServerFromProject(
  projectRoot: string,
  name: string,
  io: McpConfigIO,
): Promise<string | undefined> {
  const current = await readProjectMcpConfig(projectRoot, io)
  const next = removeMcpServer(current, name)
  if (next !== undefined && next !== current) await writeProjectMcpConfig(projectRoot, next, io)
  return next
}
