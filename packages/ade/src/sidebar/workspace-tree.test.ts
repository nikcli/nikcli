import { describe, expect, test } from "bun:test"
import {
  type Workspace,
  countWorkspaceSessions,
  findWorkspaceBySessionId,
  flattenWorkspaces,
  getAllSessionIds,
  isWorkspaceExpanded,
  selectionAfterSessionClose,
  toggleWorkspaceExpansion,
} from "./workspace-tree"

const WORKSPACES_FIXTURE: Workspace[] = [
  {
    id: "ws-ade",
    name: "packages/ade",
    sessions: [
      { id: "s1", title: "Layout della griglia", status: "working" },
      { id: "s2", title: "Riquadri terminale", status: "waiting" },
      { id: "s3", title: "Sidebar progetti", status: "done" },
    ],
  },
  {
    id: "ws-desktop",
    name: "packages/desktop",
    sessions: [
      { id: "s4", title: "Sonda vocale", status: "error" },
      { id: "s5", title: "Navigazione file", status: "working" },
    ],
  },
  {
    id: "ws-empty",
    name: "packages/tui",
    sessions: [],
  },
]

describe("toggleWorkspaceExpansion and isWorkspaceExpanded", () => {
  test("toggles expansion state immutably", () => {
    const initial = new Set(["ws-ade"])

    const expandedDesktop = toggleWorkspaceExpansion(initial, "ws-desktop")
    expect(isWorkspaceExpanded(expandedDesktop, "ws-desktop")).toBe(true)
    expect(isWorkspaceExpanded(expandedDesktop, "ws-ade")).toBe(true)
    expect(isWorkspaceExpanded(initial, "ws-desktop")).toBe(false)

    const collapsedAde = toggleWorkspaceExpansion(expandedDesktop, "ws-ade")
    expect(isWorkspaceExpanded(collapsedAde, "ws-ade")).toBe(false)
    expect(isWorkspaceExpanded(collapsedAde, "ws-desktop")).toBe(true)
  })
})

describe("countWorkspaceSessions", () => {
  test("reports exact session counts per workspace", () => {
    expect(countWorkspaceSessions(WORKSPACES_FIXTURE[0])).toBe(3)
    expect(countWorkspaceSessions(WORKSPACES_FIXTURE[1])).toBe(2)
    expect(countWorkspaceSessions(WORKSPACES_FIXTURE[2])).toBe(0)
  })
})

describe("flattenWorkspaces", () => {
  test("flattens only workspace headers when all are collapsed", () => {
    const rows = flattenWorkspaces(WORKSPACES_FIXTURE, new Set())
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.type === "workspace")).toBe(true)
    expect(rows[0].id).toBe("ws-ade")
    expect(rows[1].id).toBe("ws-desktop")
    expect(rows[2].id).toBe("ws-empty")
  })

  test("flattens workspace header and session rows when expanded", () => {
    const expanded = new Set(["ws-ade"])
    const rows = flattenWorkspaces(WORKSPACES_FIXTURE, expanded, "s2")

    // ws-ade header + 3 sessions + ws-desktop header + ws-empty header = 6 rows
    expect(rows.length).toBe(6)
    expect(rows[0]).toEqual({
      type: "workspace",
      id: "ws-ade",
      workspace: WORKSPACES_FIXTURE[0],
      isExpanded: true,
      sessionCount: 3,
    })

    expect(rows[1]).toEqual({
      type: "session",
      id: "s1",
      session: WORKSPACES_FIXTURE[0].sessions[0],
      workspaceId: "ws-ade",
      isSelected: false,
    })

    expect(rows[2]).toEqual({
      type: "session",
      id: "s2",
      session: WORKSPACES_FIXTURE[0].sessions[1],
      workspaceId: "ws-ade",
      isSelected: true,
    })

    expect(rows[3]).toEqual({
      type: "session",
      id: "s3",
      session: WORKSPACES_FIXTURE[0].sessions[2],
      workspaceId: "ws-ade",
      isSelected: false,
    })

    expect(rows[4]).toEqual({
      type: "workspace",
      id: "ws-desktop",
      workspace: WORKSPACES_FIXTURE[1],
      isExpanded: false,
      sessionCount: 2,
    })
  })

  test("handles empty workspace list cleanly", () => {
    expect(flattenWorkspaces([], new Set())).toEqual([])
  })
})

describe("findWorkspaceBySessionId and getAllSessionIds", () => {
  test("finds the containing workspace by session id", () => {
    expect(findWorkspaceBySessionId(WORKSPACES_FIXTURE, "s1")?.id).toBe("ws-ade")
    expect(findWorkspaceBySessionId(WORKSPACES_FIXTURE, "s4")?.id).toBe("ws-desktop")
    expect(findWorkspaceBySessionId(WORKSPACES_FIXTURE, "non-existent")).toBeUndefined()
  })

  test("collects all session ids in workspace order", () => {
    expect(getAllSessionIds(WORKSPACES_FIXTURE)).toEqual(["s1", "s2", "s3", "s4", "s5"])
  })
})

describe("selectionAfterSessionClose (Defect 4)", () => {
  test("Defect 4: closing an unselected session preserves the currently selected session", () => {
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s1", "s3")).toBe("s3")
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s4", "s2")).toBe("s2")
  })

  test("Defect 4: closing an unselected session when nothing is selected returns undefined", () => {
    // When nothing is selected, closing a session must not invent a selection
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s1", undefined)).toBeUndefined()
  })

  test("Defect 4: closing an unselected session with a gone id returns undefined", () => {
    // If the selected id is no longer in the session list, it must not invent a selection
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s1", "gone")).toBeUndefined()
  })

  test("Defect 4: closing the selected session moves to its successor in flat display order", () => {
    // Closing s1 (index 0) in ws-ade moves to s2
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s1", "s1")).toBe("s2")
    // Closing s2 (index 1) in ws-ade moves to s3
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s2", "s2")).toBe("s3")
    // Closing s3 (end of ws-ade) advances to successor in next workspace s4 (matches grid focusAfterClose)
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s3", "s3")).toBe("s4")
  })

  test("Defect 4: closing the final session across all workspaces falls back to predecessor", () => {
    // Closing s5 (last session overall) falls back to predecessor s4
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "s5", "s5")).toBe("s4")
  })

  test("Defect 4: closing the only session in a workspace advances to the next workspace", () => {
    const fixture: Workspace[] = [
      { id: "w1", name: "w1", sessions: [{ id: "solo-1", title: "Solo 1", status: "done" }] },
      { id: "w2", name: "w2", sessions: [{ id: "next-1", title: "Next 1", status: "working" }] },
    ]

    expect(selectionAfterSessionClose(fixture, "solo-1", "solo-1")).toBe("next-1")
  })

  test("Defect 4: closing the only session in the final workspace falls back to the previous workspace", () => {
    const fixture: Workspace[] = [
      { id: "w1", name: "w1", sessions: [{ id: "prev-1", title: "Prev 1", status: "done" }] },
      { id: "w2", name: "w2", sessions: [{ id: "solo-2", title: "Solo 2", status: "working" }] },
    ]

    expect(selectionAfterSessionClose(fixture, "solo-2", "solo-2")).toBe("prev-1")
  })

  test("Defect 4: closing the sole remaining session across all workspaces returns undefined", () => {
    const fixture: Workspace[] = [
      { id: "w1", name: "w1", sessions: [{ id: "last", title: "Last", status: "done" }] },
    ]

    expect(selectionAfterSessionClose(fixture, "last", "last")).toBeUndefined()
  })

  test("Defect 4: survives closing an untracked id without throwing", () => {
    expect(selectionAfterSessionClose(WORKSPACES_FIXTURE, "unknown", "s1")).toBe("s1")
  })
})
