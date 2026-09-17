/**
 * What the Estensioni page shows, computed from the catalog and the project's
 * `.mcp.json`: which servers are installed, which card says what, and which
 * cards a search or a filter keeps.
 *
 * The data and the file edits are Codex's (`mcp-catalog.ts`, `mcp-config.ts`);
 * this is only the reading of them the page needs, in plain `.ts` so it is
 * tested without a DOM.
 */

import { MCP_CATALOG, type McpCatalogEntry, type McpServerConfig } from "./mcp-catalog"
import { parseMcpConfig } from "./mcp-config"
import { t } from "../i18n"
import { CATALOG_EN } from "./catalog-en"

export interface InstalledServer {
  /** The key under `mcpServers`. */
  readonly name: string
  /** Where it runs: the URL of a remote server, the command line of a local one. */
  readonly detail: string
  readonly transport: "remote" | "stdio" | "sconosciuto"
  /** The catalog entry it came from, when it matches one. */
  readonly entry?: McpCatalogEntry
  /** `${VAR}` references in its definition: what the agent needs in its environment. */
  readonly variables: readonly string[]
  /**
   * A fact about how Claude Code reads it, when that differs from other
   * clients. Informational: the file may well be right for the client that
   * wrote it.
   */
  readonly note?: string
}

/**
 * A remote server without `type`. Cursor, VS Code and other clients accept
 * it; Claude Code skips it. Said plainly, not as an error.
 */
export function missingTypeNote(): string {
  return t("extensions.missingType")
}


const REFERENCE = /\$\{([A-Z_][A-Z0-9_]*)\}/g

function referencesIn(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(REFERENCE)) into.add(match[1]!)
  } else if (Array.isArray(value)) {
    for (const item of value) referencesIn(item, into)
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) referencesIn(item, into)
  }
}

/**
 * The catalog entry a server in `.mcp.json` was installed from: the same URL,
 * or the same command and package. Not the name alone — a hand-written
 * `stripe` pointing at something else is not the catalog's Stripe, and
 * showing it as installed would hide that the card's server is missing.
 */
export function matchCatalog(_name: string, server: unknown, catalog: readonly McpCatalogEntry[] = MCP_CATALOG): McpCatalogEntry | undefined {
  if (!server || typeof server !== "object") return undefined
  const config = server as McpServerConfig
  return catalog.find((entry) => {
    const theirs = entry.installation.config.server
    if (config.url && theirs.url) return config.url === theirs.url
    if (config.command && theirs.command && config.command === theirs.command) {
      const pkg = (args: readonly string[] | undefined) => args?.find((arg) => !arg.startsWith("-"))
      return pkg(config.args) !== undefined && pkg(config.args) === pkg(theirs.args)
    }
    return false
  })
}

/** The servers in the project's `.mcp.json`, in file order. Throws the parser's error for a broken file. */
export function installedServers(raw: string | undefined, catalog: readonly McpCatalogEntry[] = MCP_CATALOG): InstalledServer[] {
  const servers = parseMcpConfig(raw).mcpServers ?? {}
  return Object.entries(servers).map(([name, value]) => {
    const config = (value && typeof value === "object" ? value : {}) as McpServerConfig
    const variables = new Set<string>()
    referencesIn(config, variables)
    const entry = matchCatalog(name, config, catalog)
    return {
      name,
      detail: config.url ?? [config.command, ...(config.args ?? [])].filter(Boolean).join(" "),
      transport: config.url ? "remote" : config.command ? "stdio" : "sconosciuto",
      variables: [...variables].sort(),
      ...(entry ? { entry } : {}),
      ...(config.url && config.type !== "http" && config.type !== "sse" ? { note: missingTypeNote() } : {}),
    }
  })
}

export type CatalogFilter = "tutti" | "un-clic" | "guida" | "ufficiali" | "community"

export const CATALOG_FILTERS: readonly { id: CatalogFilter; readonly label: string }[] = [
  { id: "tutti", get label() { return t("extensions.filter.all") } },
  { id: "un-clic", get label() { return t("extensions.filter.oneClick") } },
  { id: "guida", get label() { return t("extensions.filter.guide") } },
  { id: "ufficiali", get label() { return t("extensions.filter.official") } },
  { id: "community", label: "Community" },
]

/** Accents off and lower case, so "calendario" finds "Calendar" only by what it says, not by how it is spelled. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

export function filterCatalog(
  catalog: readonly McpCatalogEntry[],
  query: string,
  filter: CatalogFilter,
): McpCatalogEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  return catalog.filter((entry) => {
    if (filter === "un-clic" && entry.installation.mode !== "one-click") return false
    if (filter === "guida" && entry.installation.mode !== "guide") return false
    if (filter === "ufficiali" && entry.origin !== "official") return false
    if (filter === "community" && entry.origin !== "community") return false
    const haystack = fold([entry.name, entry.publisher, entry.description, CATALOG_EN[entry.id]?.description ?? "", entry.id].join(" "))
    return words.every((word) => haystack.includes(word))
  })
}

export type CardAction =
  | { readonly kind: "installed" }
  | { readonly kind: "add" }
  | { readonly kind: "guide"; readonly url: string }
  /** The name is taken in `.mcp.json` by a different server. */
  | { readonly kind: "name-taken"; readonly name: string }

export function cardAction(entry: McpCatalogEntry, installed: readonly InstalledServer[]): CardAction {
  const name = entry.installation.config.name
  const same = installed.find((server) => server.entry?.id === entry.id)
  if (same) return { kind: "installed" }
  if (entry.installation.mode === "guide") return { kind: "guide", url: entry.installation.guideUrl }
  if (installed.some((server) => server.name === name)) return { kind: "name-taken", name }
  return { kind: "add" }
}

export function transportLabel(transport: readonly ("remote" | "stdio")[]): string {
  const labels = transport.map((item) => (item === "remote" ? t("extensions.transport.remote") : t("extensions.transport.stdio")))
  return labels.join(" · ")
}

/**
 * What the user has to do after adding: sign in on first use, or set the
 * variables the definition references. Values are never written into
 * `.mcp.json`; the agent reads them from its environment.
 */
export function afterInstallHint(entry: McpCatalogEntry): string {
  const variables = entry.installation.config.server
  const needed = new Set<string>()
  referencesIn(variables, needed)
  const names = [...needed].sort()
  const oauth = /oauth/.test(entry.authentication.kind)
  if (names.length === 0) return oauth ? t("extensions.after.oauth") : t("extensions.after.none")
  const list = names.join(", ")
  return oauth
    ? t("extensions.after.oauthOrEnv", list)
    : t("extensions.after.env", list)
}

/** Two letters for a card without a verified logo. */
export function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return (words[0] ?? "?").slice(0, 2).toUpperCase()
}
