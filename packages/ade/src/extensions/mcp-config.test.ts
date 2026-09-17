import { describe, expect, test } from "bun:test"
import {
  addMcpServer,
  addMcpServerToProject,
  removeMcpServer,
  removeMcpServerFromProject,
  type McpConfigIO,
  type McpInstallConfiguration,
} from "./mcp-config"

function installation(name = "github"): McpInstallConfiguration {
  return {
    name,
    server: { type: "http", url: "https://example.test/mcp" },
  }
}

function fakeIo(files: Record<string, string>): McpConfigIO {
  return {
    async readTextFile(path) {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return { text }
    },
    async writeTextFile(path, text) {
      files[path] = text
      return null
    },
  }
}

describe(".mcp.json merge", () => {
  test("creates mcpServers when the project has no file", () => {
    const text = addMcpServer(undefined, installation())

    expect(JSON.parse(text)).toEqual({
      mcpServers: { github: { type: "http", url: "https://example.test/mcp" } },
    })
  })

  test("keeps other top-level settings and servers when adding", () => {
    const current =
      '{\r\n\t"mcpServers": {\r\n\t\t"other": { "url": "https://other.test/mcp" }\r\n\t},\r\n\t"inputs": { "theme": "dark" }\r\n}\r\n'
    const next = addMcpServer(current, installation())
    const parsed = JSON.parse(next)

    expect(parsed.inputs).toEqual({ theme: "dark" })
    expect(parsed.mcpServers.other).toEqual({ url: "https://other.test/mcp" })
    expect(parsed.mcpServers.github).toEqual({ type: "http", url: "https://example.test/mcp" })
    expect(next).toContain("\r\n")
  })

  test("rejects a server name that is already present", () => {
    const current = JSON.stringify({ mcpServers: { github: { url: "https://old.test/mcp" } } })

    expect(() => addMcpServer(current, installation())).toThrow(/già presente/i)
  })

  test("a remote server says its transport, or Claude Code ignores it", () => {
    const bare = { name: "github", server: { url: "https://example.test/mcp" } }
    expect(() => addMcpServer(undefined, bare)).toThrow(/type "http" o "sse"/)
    const sse = addMcpServer(undefined, { name: "old", server: { type: "sse", url: "https://example.test/sse" } })
    expect(JSON.parse(sse).mcpServers.old).toEqual({ type: "sse", url: "https://example.test/sse" })
    expect(() => addMcpServer(undefined, { name: "x", server: { type: "stdio", url: "https://example.test/mcp" } })).toThrow()
    expect(() => addMcpServer(undefined, { name: "x", server: { type: "http", command: "npx" } })).toThrow()
    expect(JSON.parse(addMcpServer(undefined, { name: "x", server: { command: "npx", args: ["-y", "pkg"] } })).mcpServers.x).toEqual({
      command: "npx",
      args: ["-y", "pkg"],
    })
  })

  test("reports malformed JSON clearly", () => {
    expect(() => addMcpServer("{ non json", installation())).toThrow(/\.mcp\.json.*JSON valido/i)
  })

  test("removes only the selected server and leaves an absent one untouched", () => {
    const current = JSON.stringify({
      mcpServers: {
        github: { url: "https://github.test/mcp" },
        other: { command: "other" },
      },
      inputs: { theme: "dark" },
    })

    const next = removeMcpServer(current, "github")
    expect(JSON.parse(next!)).toEqual({ mcpServers: { other: { command: "other" } }, inputs: { theme: "dark" } })
    expect(removeMcpServer(current, "missing")).toBe(current)
  })

  test("never writes a raw credential value", () => {
    expect(() =>
      addMcpServer(undefined, {
        name: "stripe",
        server: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer sk_live_this_must_not_be_written" },
        },
      }),
    ).toThrow(/riferimento.*variabile/i)
  })

  test("reads, merges and writes only the project file", async () => {
    const files: Record<string, string> = {
      "C:/repo/.mcp.json": JSON.stringify({ mcpServers: { other: { command: "other" } } }),
    }
    const io = fakeIo(files)

    await addMcpServerToProject("C:/repo", installation("github"), io)
    expect(JSON.parse(files["C:/repo/.mcp.json"]!).mcpServers.github).toEqual({
      type: "http",
      url: "https://example.test/mcp",
    })

    await removeMcpServerFromProject("C:/repo", "github", io)
    expect(JSON.parse(files["C:/repo/.mcp.json"]!).mcpServers).toEqual({ other: { command: "other" } })
  })
})
