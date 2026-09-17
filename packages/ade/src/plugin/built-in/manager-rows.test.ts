import { describe, expect, test } from "bun:test"
import { contributionLabel, managerRows, managerSummary, type ManagerRow } from "./manager-rows"
import type { PluginStatus } from "../runtime"

const status = (over: Partial<PluginStatus> & { id: string }): PluginStatus => ({
  spec: over.id,
  source: "file",
  active: true,
  ...over,
})

const entry = (pluginId: string) => ({ pluginId }) as never

describe("managerRows", () => {
  test("counts what each plugin put on each surface", () => {
    const rows = managerRows({
      status: [status({ id: "a" })],
      commands: [entry("a"), entry("a"), entry("b")],
      panes: [entry("a")],
      sections: [],
    })
    expect(rows).toEqual([
      { id: "a", spec: "a", source: "file", active: true, error: undefined, commands: 2, panes: 1, sections: 0 },
    ])
  })

  /*
   * Failures first because they are the only rows that need doing something
   * about. A manager that lists twelve working plugins and buries the one that
   * threw is a list, not a report.
   */
  test("the ones that did not load come first, otherwise load order is kept", () => {
    const rows = managerRows({
      status: [
        status({ id: "ok1" }),
        status({ id: "bad1", active: false, error: "x" }),
        status({ id: "ok2" }),
        status({ id: "bad2", active: false, error: "y" }),
      ],
      commands: [],
      panes: [],
      sections: [],
    })
    expect(rows.map((row) => row.id)).toEqual(["bad1", "bad2", "ok1", "ok2"])
  })
})

describe("managerSummary", () => {
  const row = (active: boolean): ManagerRow => ({
    id: "x",
    spec: "x",
    source: "internal",
    active,
    commands: 0,
    panes: 0,
    sections: 0,
  })

  test("says nothing is loaded when nothing is", () => {
    expect(managerSummary([])).toBe("Nessun plugin caricato.")
  })

  test("counts, and agrees with itself in the singular", () => {
    expect(managerSummary([row(true)])).toBe("1 plugin attivo.")
    expect(managerSummary([row(true), row(true)])).toBe("2 plugin attivi.")
  })

  test("failures are named separately, because they are the point of the list", () => {
    expect(managerSummary([row(true), row(false)])).toBe("1 plugin attivo, 1 non caricato.")
    expect(managerSummary([row(false), row(false)])).toBe("0 plugin attivi, 2 non caricati.")
  })
})

describe("contributionLabel", () => {
  const row = (over: Partial<ManagerRow>): ManagerRow => ({
    id: "x",
    spec: "x",
    source: "file",
    active: true,
    commands: 0,
    panes: 0,
    sections: 0,
    ...over,
  })

  test("lists only the surfaces the plugin actually touched", () => {
    expect(contributionLabel(row({ commands: 1, sections: 2 }))).toBe("1 comando · 2 sezioni")
    expect(contributionLabel(row({ panes: 1 }))).toBe("1 pannello")
  })

  test("a plugin that contributed nothing gets no phrase at all", () => {
    expect(contributionLabel(row({}))).toBeUndefined()
  })
})
