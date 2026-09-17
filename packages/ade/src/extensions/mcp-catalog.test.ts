import { describe, expect, test } from "bun:test"
import { validateMcpServerConfig } from "./mcp-config"
import { MCP_CATALOG, findMcpServer } from "./mcp-catalog"

describe("MCP catalog", () => {
  test("contains the 25 verified servers with unique ids and source URLs", () => {
    expect(MCP_CATALOG).toHaveLength(25)

    const ids = MCP_CATALOG.map((server) => server.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const server of MCP_CATALOG) {
      expect(server.name.trim()).not.toBe("")
      expect(server.description.trim()).not.toBe("")
      expect(server.sourceUrl).toMatch(/^https:\/\//)
      expect(() => new URL(server.sourceUrl)).not.toThrow()
      expect(server.transport.length).toBeGreaterThan(0)
      expect(server.authentication.label.trim()).not.toBe("")
      expect(server.installation.config.name.trim()).not.toBe("")
      expect(server.installation.config.server).toBeDefined()
      expect(() => validateMcpServerConfig(server.installation.config.server)).not.toThrow()
    }
  })

  test("every remote card is written with the transport Claude Code needs", () => {
    const remotes = MCP_CATALOG.filter((server) => server.installation.config.server.url)
    expect(remotes.length).toBeGreaterThan(0)
    for (const server of remotes) {
      const config = server.installation.config.server
      // The catalog has no SSE endpoint today; one would say "sse" explicitly.
      expect(config.type).toBe(/\/sse\/?$/.test(config.url!) ? "sse" : "http")
    }
    for (const server of MCP_CATALOG.filter((entry) => entry.installation.config.server.command)) {
      expect(server.installation.config.server.type).toBeUndefined()
    }
  })

  test("marks one-click entries only when they carry a complete configuration", () => {
    for (const server of MCP_CATALOG) {
      if (server.installation.mode === "one-click") {
        expect(server.installation.config.server).toBeDefined()
      }
    }
  })

  test("keeps the two requested community entries and warns about Ryze write access", () => {
    expect(findMcpServer("higgsfield")?.origin).toBe("community")

    const ryze = findMcpServer("ryze-ai")
    expect(ryze?.origin).toBe("community")
    expect(ryze?.warning?.toLowerCase()).toContain("scrittura")
    expect(ryze?.warning?.toLowerCase()).toContain("account pubblicitari")
  })

  test("contains references, never copied secret placeholders or SVG payloads", () => {
    const serialized = JSON.stringify(MCP_CATALOG)
    expect(serialized).not.toMatch(/<token>|YOUR_[A-Z_]+|sk_live_|Bearer [A-Za-z0-9_-]{20,}/)
    expect(serialized).not.toContain("<svg")
    expect(serialized).not.toContain("<path")

    for (const server of MCP_CATALOG) {
      if (server.logo.kind === "simple-icons") expect(server.logo.id).not.toContain("<")
      else expect(server.logo.file).not.toContain("<")
    }
  })
})
