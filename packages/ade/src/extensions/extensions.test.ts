import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  afterInstallHint,
  cardAction,
  filterCatalog,
  installedServers,
  matchCatalog,
  missingTypeNote,
  monogram,
} from "./extensions"
import { findMcpServer, MCP_CATALOG } from "./mcp-catalog"
import { addMcpServer } from "./mcp-config"

const stripe = findMcpServer("stripe")!

describe("installed servers", () => {
  test("read from .mcp.json, matched to the catalog, with the variables they reference", () => {
    const raw = addMcpServer(
      JSON.stringify({ mcpServers: { mio: { command: "node", args: ["server.js"], env: { TOKEN: "${MY_TOKEN}" } } } }),
      stripe.installation.config,
    )
    const servers = installedServers(raw)
    expect(servers.map((server) => [server.name, server.transport, server.entry?.id])).toEqual([
      ["mio", "stdio", undefined],
      [
        stripe.installation.config.name,
        stripe.transport.includes("remote") && stripe.installation.config.server.url ? "remote" : "stdio",
        "stripe",
      ],
    ])
    expect(servers[0]!.detail).toBe("node server.js")
    expect(servers[0]!.variables).toEqual(["MY_TOKEN"])
  })

  test("a server renamed by hand is still recognised by its URL", () => {
    const github = findMcpServer("github")!
    expect(matchCatalog("gh-lavoro", { url: github.installation.config.server.url })?.id).toBe("github")
    expect(matchCatalog("altro", { url: "https://example.com/mcp" })).toBeUndefined()
  })

  test("a remote server written without type gets a note, not an alarm", () => {
    const github = findMcpServer("github")!
    const raw = JSON.stringify({
      mcpServers: {
        github: { url: github.installation.config.server.url },
        ok: { type: "sse", url: "https://x.test/sse" },
      },
    })
    const [bare, sse] = installedServers(raw)
    expect(bare!.entry?.id).toBe("github")
    // A note, not an error: other clients read the file as it is.
    expect(bare!.note).toBe(missingTypeNote())
    expect(missingTypeNote()).not.toMatch(/errore|rimuov/i)
    expect(sse!.note).toBeUndefined()
    expect(installedServers(addMcpServer(undefined, github.installation.config))[0]!.note).toBeUndefined()
  })

  test("no file is no servers; a broken file says why", () => {
    expect(installedServers(undefined)).toEqual([])
    expect(() => installedServers("{rotto")).toThrow(".mcp.json non contiene JSON valido.")
  })
})

describe("the catalog", () => {
  test("search ignores case and accents and needs every word", () => {
    expect(filterCatalog(MCP_CATALOG, "STRIPE", "tutti").map((entry) => entry.id)).toEqual(["stripe"])
    expect(filterCatalog(MCP_CATALOG, "google calendar", "tutti").map((entry) => entry.id)).toContain("google-calendar")
    expect(filterCatalog(MCP_CATALOG, "nessunservercosi", "tutti")).toEqual([])
  })

  test("filters by how it installs and who publishes it", () => {
    const community = filterCatalog(MCP_CATALOG, "", "community").map((entry) => entry.id)
    expect(community.length).toBeGreaterThan(0)
    expect(community.every((id) => findMcpServer(id)!.origin === "community")).toBe(true)
    expect(filterCatalog(MCP_CATALOG, "", "guida").every((entry) => entry.installation.mode === "guide")).toBe(true)
    expect(filterCatalog(MCP_CATALOG, "", "un-clic").length + filterCatalog(MCP_CATALOG, "", "guida").length).toBe(
      MCP_CATALOG.length,
    )
  })

  test("a card offers to add, says it is installed, guides, or warns of a name clash", () => {
    const guide = MCP_CATALOG.find((entry) => entry.installation.mode === "guide")!
    expect(cardAction(stripe, [])).toEqual({ kind: "add" })
    expect(cardAction(stripe, installedServers(addMcpServer(undefined, stripe.installation.config)))).toEqual({
      kind: "installed",
    })
    expect(cardAction(guide, [])).toEqual({ kind: "guide", url: guide.installation.guideUrl })
    const clash = JSON.stringify({ mcpServers: { [stripe.installation.config.name]: { command: "altro" } } })
    expect(cardAction(stripe, installedServers(clash))).toEqual({
      kind: "name-taken",
      name: stripe.installation.config.name,
    })
  })

  test("after adding, the hint names the variables and never a value", () => {
    for (const entry of MCP_CATALOG) {
      const hint = afterInstallHint(entry)
      expect(hint.length).toBeGreaterThan(10)
      expect(hint).not.toMatch(/sk-|ghp_|xox/)
    }
  })

  test("every logo the catalog names is bundled, or has a monogram", () => {
    const missing = MCP_CATALOG.filter((entry) => {
      const file = entry.logo.kind === "simple-icons" ? `${entry.logo.id}.svg` : entry.logo.file
      return !existsSync(join(import.meta.dir, "logos", file))
    }).map((entry) => entry.id)
    // The ones without a verified asset, listed in logos/SOURCES.md.
    expect(missing.sort()).toEqual(["context7", "higgsfield", "ryze-ai", "slack"].sort())
    expect(monogram("Ryze AI")).toBe("RA")
    expect(monogram("Context7")).toBe("CO")
  })
})
