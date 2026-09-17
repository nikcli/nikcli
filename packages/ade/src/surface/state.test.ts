import { describe, test, expect } from "bun:test"
import {
  ADE_VIEWS,
  CHAT_AND_BOT_ENABLED,
  VISIBLE_VIEWS,
  visibleViews,
  isViewVisible,
  nextView,
  reachableView,
  createWorkbench,
  addPane,
  closePane,
  updatePane,
  expandPane,
  setColumns,
  deriveWorkspaces,
  toWorkspaceState,
  fromWorkspaceState,
  type Pane,
} from "./state"

describe("surface state", () => {
  const mockPane: Pane = {
    id: "p1",
    title: "Test",
    status: "working",
    model: "test-model",
    mode: "auto",
    lines: [],
    cwd: "test/path",
    workspaceId: "ws1",
  }

  test("addPane adds pane and focuses it", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    expect(wb.panes).toHaveLength(1)
    expect(wb.panes[0]).toBe(mockPane)
    expect(wb.focusedId).toBe("p1")
  })

  test("closePane removes pane and updates focus", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    wb = addPane(wb, { ...mockPane, id: "p2" })
    expect(wb.panes).toHaveLength(2)
    wb = closePane(wb, "p2")
    expect(wb.panes).toHaveLength(1)
    expect(wb.focusedId).toBe("p1")
  })

  test("updatePane modifies only the target pane", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    wb = updatePane(wb, "p1", { title: "New Title" })
    expect(wb.panes[0].title).toBe("New Title")
  })

  /*
   * `paneStatusToOccupantState` and `buildOccupantsByPath` were tested here
   * and used nowhere else. They existed for the worktree board, which was
   * removed from the interface: the two functions, the `Occupant` model and
   * the whole `worktrees/` subsystem went with it. Their tests were the last
   * thing calling them, which is the shape this clean-up is about.
   */

  test("deriveWorkspaces groups panes", () => {
    const panes: Pane[] = [
      mockPane,
      { ...mockPane, id: "p2", workspaceId: "ws1" },
      { ...mockPane, id: "p3", workspaceId: "ws2" },
      { ...mockPane, id: "b1", browserUrl: "http://url", workspaceId: "ws3" },
    ]
    const ws = deriveWorkspaces(panes)
    expect(ws).toHaveLength(2) // browser is ignored
    expect(ws.find((w) => w.id === "ws1")?.sessions).toHaveLength(2)
    expect(ws.find((w) => w.id === "ws2")?.sessions).toHaveLength(1)
  })

  test("toWorkspaceState and fromWorkspaceState roundtrips basic info", () => {
    let wb = createWorkbench()
    wb = addPane(wb, mockPane)
    const state = toWorkspaceState(wb)
    expect(state.panes).toHaveLength(1)
    expect(state.panes[0].id).toBe("p1")

    const restored = fromWorkspaceState(state)
    expect(restored.panes).toHaveLength(1)
    expect(restored.panes[0].id).toBe("p1")
    /*
     * "done", not "working". The pane was saved mid-run, but a pty is a child
     * of the app: by the time this state is read back the process is gone,
     * whether the user closed the window or the machine restarted. Restoring
     * "working" showed a running session with no pid behind it, with the
     * liveness sweep animating under it. This test used to assert exactly
     * that, and its own comment noted the status was not really restored.
     */
    expect(restored.panes[0].status).toBe("done")
  })
})

describe("panes of several projects, and spawned worktrees, survive a restart", () => {
  test("each pane keeps its project, worktree and spawn arguments", () => {
    let wb = createWorkbench()
    wb = { ...wb, projectPath: "C:/p/web" }
    wb = addPane(wb, {
      id: "a",
      title: "A",
      status: "idle",
      mode: "auto",
      lines: [],
      model: "codex",
      agent: "codex",
      workspaceId: "web",
      cwd: "C:/p/web",
    })
    wb = addPane(wb, {
      id: "b",
      title: "revisore",
      status: "idle",
      mode: "auto",
      lines: [],
      model: "agy",
      agent: "agy",
      workspaceId: "api",
      cwd: "C:/p/api-ade/revisore",
      worktree: "C:/p/api-ade/revisore",
      spawnArgs: ["--model", "gemini-3.1-pro-high"],
      tree: { branch: "ade/revisore", fidelity: "full" },
    })
    const back = fromWorkspaceState(JSON.parse(JSON.stringify(toWorkspaceState(wb))))
    expect(back.panes.map((pane) => pane.workspaceId)).toEqual(["web", "api"])
    expect(back.panes[1]?.worktree).toBe("C:/p/api-ade/revisore")
    expect(back.panes[1]?.spawnArgs).toEqual(["--model", "gemini-3.1-pro-high"])
    expect(back.panes[1]?.tree?.fidelity).toBe("full")
  })
})
describe("the Chat and Bot switch (S40)", () => {
  test("the visible sections follow the switch, and agent and code are always there", () => {
    expect(visibleViews(false)).toEqual(["agent", "code"])
    expect(visibleViews(true)).toEqual([...ADE_VIEWS])
    expect(VISIBLE_VIEWS).toEqual(visibleViews(CHAT_AND_BOT_ENABLED))
  })

  for (const enabled of [false, true]) {
    test(`a hidden section is never where the cycle or an outside request lands (switch ${enabled ? "on" : "off"})`, () => {
      const views = visibleViews(enabled)
      const visited = new Set<string>()
      let view = nextView("code", views)
      for (let i = 0; i < ADE_VIEWS.length * 2; i++) {
        expect(isViewVisible(view, views)).toBe(true)
        visited.add(view)
        view = nextView(view, views)
      }
      expect(visited.size).toBe(views.length)
      for (const asked of ADE_VIEWS) expect(isViewVisible(reachableView(asked, views), views)).toBe(true)
      expect(reachableView("chat", views)).toBe(enabled ? "chat" : "code")
      expect(reachableView("bot", views)).toBe(enabled ? "bot" : "code")
    })
  }
})
