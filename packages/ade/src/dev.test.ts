import { describe, expect, test } from "bun:test"
import { createMemo, createSignal } from "solid-js"
import { focusAfterClose } from "./grid/focus"
import type { GridPane } from "./grid/session-grid"

interface SessionFixture {
  id: string
  workspaceId: string
  title: string
  status: "working" | "waiting" | "done" | "error"
}

const FIXTURES: SessionFixture[] = [
  { id: "s1", workspaceId: "ws-ade", title: "Session 1", status: "working" },
  { id: "s2", workspaceId: "ws-ade", title: "Session 2", status: "waiting" },
  { id: "s3", workspaceId: "ws-ade", title: "Session 3", status: "done" },
  { id: "s4", workspaceId: "ws-desktop", title: "Session 4", status: "error" },
]

describe("dev.tsx harness logic", () => {
  test("Defect 11: closing a background pane in dev harness leaves focus unchanged", () => {
    const [panes, setPanes] = createSignal(FIXTURES)
    const [focused, setFocused] = createSignal<string | undefined>("s1")

    // The shared close rule from dev.tsx
    const close = (id: string, next?: string) => {
      const nextSelection =
        next !== undefined
          ? next
          : focusAfterClose({
              panes: panes().map((p) => p.id),
              focused: focused(),
              closing: id,
            })
      setPanes((current) => current.filter((pane) => pane.id !== id))
      setFocused(nextSelection)
    }

    // Close background pane s2 while s1 is focused
    close("s2")
    expect(focused()).toBe("s1")
    expect(panes().map((p) => p.id)).toEqual(["s1", "s3", "s4"])

    // Close background pane s4 while s1 is focused
    close("s4")
    expect(focused()).toBe("s1")
    expect(panes().map((p) => p.id)).toEqual(["s1", "s3"])

    // Close the focused pane s1 -> focus moves to its successor s3
    close("s1")
    expect(focused()).toBe("s3")
    expect(panes().map((p) => p.id)).toEqual(["s3"])

    // Close the only remaining pane s3 -> focus becomes undefined
    close("s3")
    expect(focused()).toBeUndefined()
    expect(panes().length).toBe(0)
  })

  test("Defect 12: gridPanes preserves stable GridPane object identity across selection changes", () => {
    const [panes, setPanes] = createSignal(FIXTURES)
    const [focused, setFocused] = createSignal<string | undefined>("s1")

    const paneCache = new Map<string, GridPane>()
    const gridPanes = createMemo<GridPane[]>(() => {
      const currentPanes = panes()
      const activeIds = new Set(currentPanes.map((p) => p.id))
      for (const id of paneCache.keys()) {
        if (!activeIds.has(id)) {
          paneCache.delete(id)
        }
      }

      return currentPanes.map((fixture) => {
        let entry = paneCache.get(fixture.id)
        if (!entry) {
          entry = {
            id: fixture.id,
            render: () => null as never,
          }
          paneCache.set(fixture.id, entry)
        }
        return entry
      })
    })

    const initialPanes = gridPanes()
    expect(initialPanes.length).toBe(4)

    // Change focus from s1 to s2
    setFocused("s2")

    const afterFocusChangePanes = gridPanes()

    // The GridPane objects MUST have identical references so Solid's <For> doesn't recreate panes
    for (let i = 0; i < initialPanes.length; i++) {
      expect(afterFocusChangePanes[i]).toBe(initialPanes[i])
      expect(afterFocusChangePanes[i].id).toBe(initialPanes[i].id)
    }

    // When a pane is closed, the remaining panes still preserve their object identities
    setPanes((current) => current.filter((p) => p.id !== "s2"))

    const afterClosePanes = gridPanes()
    expect(afterClosePanes.length).toBe(3)
    expect(afterClosePanes[0]).toBe(initialPanes[0]) // s1
    expect(afterClosePanes[1]).toBe(initialPanes[2]) // s3
    expect(afterClosePanes[2]).toBe(initialPanes[3]) // s4
  })
})
