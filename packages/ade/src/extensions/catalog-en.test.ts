import { afterEach, describe, expect, test } from "bun:test"
import { resetLocaleForTests } from "../i18n"
import { CATALOG_EN, catalogText } from "./catalog-en"
import { filterCatalog } from "./extensions"
import { MCP_CATALOG } from "./mcp-catalog"

afterEach(() => resetLocaleForTests("it"))

describe("the MCP catalog in English", () => {
  test("every entry has its English texts, a warning where the entry has one, and nothing for entries that are gone", () => {
    const ids = MCP_CATALOG.map((entry) => entry.id)
    expect(Object.keys(CATALOG_EN).sort()).toEqual([...ids].sort())
    for (const entry of MCP_CATALOG) {
      expect(`${entry.id}: ${Boolean(CATALOG_EN[entry.id]?.warning)}`).toBe(`${entry.id}: ${Boolean(entry.warning)}`)
    }
  })

  test("the texts follow the language", () => {
    const github = MCP_CATALOG.find((entry) => entry.id === "github")!
    expect(catalogText(github).description).toBe(github.description)
    resetLocaleForTests("en")
    expect(catalogText(github).description).toStartWith("Manage GitHub")
    expect(catalogText(github).authentication).toBe("OAuth or personal access token")
  })

  test("a search finds a server by its English description too", () => {
    expect(filterCatalog(MCP_CATALOG, "invoices", "tutti").map((entry) => entry.id)).toContain("stripe")
    expect(filterCatalog(MCP_CATALOG, "fatture", "tutti").map((entry) => entry.id)).toContain("stripe")
  })
})

describe("validation errors follow the language", () => {
  test("an MCP configuration error is written in English under English", async () => {
    const { addMcpServer } = await import("./mcp-config")
    resetLocaleForTests("en")
    expect(() =>
      addMcpServer("{ not json", { name: "x", server: { type: "http", url: "https://example.test/mcp" } }),
    ).toThrow(/doesn't contain valid JSON/)
  })

  test("a broken decision log line is described in English under English", async () => {
    const { parseDecisionLog } = await import("../decisions/log")
    const { describeProblems } = await import("../decisions/state")
    resetLocaleForTests("en")
    const { problems } = parseDecisionLog("{ nope\n")
    expect(describeProblems(problems, [])).toEqual(["line 1: invalid JSON"])
  })
})
