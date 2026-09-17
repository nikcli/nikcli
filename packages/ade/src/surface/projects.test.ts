import { describe, expect, test } from "bun:test"
import { createWorkbench, addPane, deriveWorkspaces } from "./state"
import type { Pane } from "./state"

const pane = (id: string, workspaceId: string): Pane => ({
  id,
  title: id,
  status: "working",
  workspaceId,
  model: "claude-code",
  mode: "custom",
  lines: [],
})

describe("deriveWorkspaces", () => {
  test("a project the user opened is listed before it has any session", () => {
    const rows = deriveWorkspaces([], [{ root: "C:/code/alfa", name: "alfa" }])
    expect(rows.map((r) => r.name)).toEqual(["alfa"])
    expect(rows[0]?.sessions).toEqual([])
    expect(rows[0]?.path).toBe("C:/code/alfa")
  })

  test("sessions land under the project they belong to", () => {
    let wb = createWorkbench()
    wb = addPane(wb, pane("p1", "alfa"))
    wb = addPane(wb, pane("p2", "alfa"))
    wb = addPane(wb, pane("p3", "beta"))

    const rows = deriveWorkspaces(wb.panes, [{ root: "C:/code/alfa", name: "alfa" }])
    const alfa = rows.find((r) => r.name === "alfa")
    const beta = rows.find((r) => r.name === "beta")

    expect(alfa?.sessions.map((s) => s.id)).toEqual(["p1", "p2"])
    expect(beta?.sessions.map((s) => s.id)).toEqual(["p3"])
  })

  test("a known project keeps its row when its last session closes", () => {
    // The regression this guards: derived from panes alone, the project the user
    // is standing in disappears from the list the moment it goes quiet.
    const known = [{ root: "C:/code/alfa", name: "alfa" }]
    const withSession = deriveWorkspaces([pane("p1", "alfa")], known)
    const afterClosing = deriveWorkspaces([], known)

    expect(withSession.map((r) => r.name)).toEqual(["alfa"])
    expect(afterClosing.map((r) => r.name)).toEqual(["alfa"])
  })

  test("a project is listed once even when it is both known and running", () => {
    const rows = deriveWorkspaces([pane("p1", "alfa")], [{ root: "C:/code/alfa", name: "alfa" }])
    expect(rows.length).toBe(1)
    expect(rows[0]?.sessions.length).toBe(1)
  })

  test("browser panes are not sessions and open no project row", () => {
    const rows = deriveWorkspaces([{ ...pane("b1", "alfa"), browserUrl: "http://localhost" }], [])
    expect(rows).toEqual([])
  })
})
