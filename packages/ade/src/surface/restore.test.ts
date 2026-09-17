import { describe, expect, test } from "bun:test"
import { CHAT_AND_BOT_ENABLED, fromWorkspaceState, restoreView } from "./state"
import type { WorkspaceState } from "../session/persist"

const saved = (projectPath: string | undefined): WorkspaceState => ({
  version: 2,
  panes: [{ id: "p1", title: "Sessione 1", agent: "claude", cwd: "C:/code/alfa", branch: "main", status: "working" }],
  focusedPaneId: "p1",
  pinnedColumns: undefined,
  currentView: "plancia",
  sidebarWidth: 260,
  projectPath,
})

describe("restoreView", () => {
  test("a workspace saved before the rename opens on the terminals, not on nothing", () => {
    // Every machine that ran an earlier build has "plancia" on disk. Left
    // unmapped it restores a view no branch renders: an empty window with
    // working chrome, which is the hardest kind of bug to see.
    expect(restoreView("plancia")).toBe("code")
  })

  test("a workspace saved on the worktree board lands somewhere real", () => {
    // The board was removed rather than renamed, so there is nowhere exact to
    // send it. The terminals are the closest thing left.
    expect(restoreView("alberi")).toBe("code")
  })

  test("keeps a view it recognises", () => {
    expect(restoreView("agent")).toBe("agent")
    expect(restoreView("code")).toBe("code")
  })

  test("a workbench saved in a hidden section reopens in the grid", () => {
    // Otherwise the window opens in a section the bar does not list, with no way back to it.
    expect(restoreView("chat")).toBe(CHAT_AND_BOT_ENABLED ? "chat" : "code")
    expect(restoreView("bot")).toBe(CHAT_AND_BOT_ENABLED ? "bot" : "code")
  })

  test("falls back to the terminals for anything else", () => {
    expect(restoreView(undefined)).toBe("code")
    expect(restoreView("")).toBe("code")
    expect(restoreView("qualcosa")).toBe("code")
    expect(restoreView(7)).toBe("code")
  })
})

describe("fromWorkspaceState", () => {
  test("carries the saved view across the rename", () => {
    expect(fromWorkspaceState(saved("C:/code/alfa")).view).toBe("code")
  })

  test("files restored panes under the project they were saved in", () => {
    // The regression this guards: filed under a placeholder, a restored session
    // belongs to no project, so the per-project grid shows it nowhere.
    const wb = fromWorkspaceState(saved("C:/code/alfa"))
    expect(wb.panes[0]?.workspaceId).toBe("alfa")
  })

  test("reads the name off a Windows path just as well", () => {
    const wb = fromWorkspaceState(saved("C:\\Users\\me\\code\\beta"))
    expect(wb.panes[0]?.workspaceId).toBe("beta")
  })

  test("an explicit name wins over the saved path", () => {
    const wb = fromWorkspaceState(saved("C:/code/alfa"), "gamma")
    expect(wb.panes[0]?.workspaceId).toBe("gamma")
  })

  test("with no path and no name it still produces a usable pane", () => {
    const wb = fromWorkspaceState(saved(undefined))
    expect(wb.panes).toHaveLength(1)
    expect(wb.panes[0]?.workspaceId).toBe("ws-restored")
  })

  test("a trailing separator does not make the name empty", () => {
    const wb = fromWorkspaceState(saved("C:/code/alfa/"))
    expect(wb.panes[0]?.workspaceId).toBe("alfa")
  })
})
