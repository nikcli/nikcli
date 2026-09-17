import { describe, expect, test } from "bun:test"
import { type Command, filterCommands, moveSelection } from "./registry"

const commands: Command[] = [
  { id: "session.new", title: "Nuova Sessione", group: "Sessioni" },
  { id: "pane.close", title: "Chiudi Pannello", group: "Pannelli", shortcut: "Ctrl+W" },
  { id: "theme.toggle", title: "Cambia Tema", group: "Aspetto", keywords: ["scuro", "chiaro"] },
  { id: "files.search", title: "Cerca nei File", group: "File", enabled: false },
  { id: "palette.open", title: "Apri Palette Comandi", group: "Navigazione" },
]

describe("filterCommands", () => {
  test("empty query returns all commands, enabled first", () => {
    const hits = filterCommands(commands, "")
    expect(hits.length).toBe(commands.length)

    // Disabled commands should be at the end
    const disabledIdx = hits.findIndex((h) => h.command.enabled === false)
    for (let i = 0; i < disabledIdx; i++) {
      expect(hits[i].command.enabled).not.toBe(false)
    }
  })

  test("matches against title", () => {
    const hits = filterCommands(commands, "nuova")
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].command.id).toBe("session.new")
  })

  test("matches against group", () => {
    const hits = filterCommands(commands, "pannelli")
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.some((h) => h.command.id === "pane.close")).toBe(true)
  })

  test("matches against keywords", () => {
    const hits = filterCommands(commands, "scuro")
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].command.id).toBe("theme.toggle")
  })

  test("non-matching query returns empty list", () => {
    const hits = filterCommands(commands, "zzzzz")
    expect(hits).toEqual([])
  })

  test("disabled commands stay in results but sort to the bottom", () => {
    const hits = filterCommands(commands, "cerca")
    const searchHit = hits.find((h) => h.command.id === "files.search")
    expect(searchHit).toBeDefined()

    // If there are enabled hits, the disabled one must come after
    const enabledHits = hits.filter((h) => h.command.enabled !== false)
    if (enabledHits.length > 0) {
      const disabledIdx = hits.indexOf(searchHit!)
      const lastEnabledIdx = hits.lastIndexOf(enabledHits[enabledHits.length - 1])
      expect(disabledIdx).toBeGreaterThan(lastEnabledIdx)
    }
  })

  test("sorting is stable — same-score hits keep declaration order", () => {
    const sameGroup: Command[] = [
      { id: "a", title: "Azione Uno", group: "Test" },
      { id: "b", title: "Azione Due", group: "Test" },
      { id: "c", title: "Azione Tre", group: "Test" },
    ]
    const hits = filterCommands(sameGroup, "")
    expect(hits.map((h) => h.command.id)).toEqual(["a", "b", "c"])
  })

  test("provides title and group highlight ranges", () => {
    const hits = filterCommands(commands, "nuova")
    expect(hits[0].titleRanges.length).toBeGreaterThan(0)
  })
})

describe("moveSelection", () => {
  const makeHits = (enabled: boolean[]): ReturnType<typeof filterCommands> =>
    enabled.map((e, i) => ({
      command: { id: String(i), title: "", group: "", enabled: e },
      score: 0,
      titleRanges: [],
      groupRanges: [],
    }))

  test("moves down by one", () => {
    const hits = makeHits([true, true, true])
    expect(moveSelection(hits, 0, 1)).toBe(1)
  })

  test("moves up by one", () => {
    const hits = makeHits([true, true, true])
    expect(moveSelection(hits, 2, -1)).toBe(1)
  })

  test("clamps at the bottom", () => {
    const hits = makeHits([true, true, true])
    expect(moveSelection(hits, 2, 1)).toBe(2)
  })

  test("clamps at the top", () => {
    const hits = makeHits([true, true, true])
    expect(moveSelection(hits, 0, -1)).toBe(0)
  })

  test("skips disabled commands", () => {
    const hits = makeHits([true, false, true])
    expect(moveSelection(hits, 0, 1)).toBe(2)
  })

  test("returns -1 for empty list", () => {
    expect(moveSelection([], 0, 1)).toBe(-1)
  })

  test("returns -1 when all commands are disabled", () => {
    const hits = makeHits([false, false, false])
    expect(moveSelection(hits, 0, 1)).toBe(-1)
  })

  test("finds first enabled when starting out of bounds", () => {
    const hits = makeHits([false, true, true])
    expect(moveSelection(hits, -1, 1)).toBe(1)
  })
})
