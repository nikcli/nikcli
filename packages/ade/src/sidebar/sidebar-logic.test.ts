import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { type FileNode, deriveDefaultExpandedDirs, flattenFileTree } from "./file-tree"
import { createKeyedList } from "./keyed"
import { type ResizeDragHandle, beginResizeDrag } from "./sidebar-logic"
import {
  type FlatSessionChildRow,
  type FlatWorkspaceHeaderRow,
  type FlatWorkspaceRow,
  type Workspace,
  flattenWorkspaces,
} from "./workspace-tree"

const TEST_WORKSPACES: Workspace[] = [
  {
    id: "ws-1",
    name: "Workspace 1",
    sessions: [
      { id: "s1", title: "Session 1", status: "working" },
      { id: "s2", title: "Session 2", status: "waiting" },
    ],
  },
  {
    id: "ws-2",
    name: "Workspace 2",
    sessions: [
      { id: "s3", title: "Session 3", status: "done" },
    ],
  },
]

const TEST_FILES: FileNode[] = [
  {
    id: "d-pkg",
    name: "packages",
    path: "packages",
    kind: "directory",
    children: [
      {
        id: "d-ade",
        name: "ade",
        path: "packages/ade",
        kind: "directory",
        children: [
          { id: "f-pkg", name: "package.json", path: "packages/ade/package.json", kind: "file" },
        ],
      },
    ],
  },
  {
    id: "d-empty",
    name: "empty-folder",
    path: "empty-folder",
    kind: "directory",
    children: [],
  },
  {
    id: "f-readme",
    name: "README.md",
    path: "README.md",
    kind: "file",
  },
]

describe("Sidebar pure logic and reactive helpers", () => {
  test("Defect 1: discriminated union FlatWorkspaceRow narrows cleanly without as casts", () => {
    const rows: FlatWorkspaceRow[] = flattenWorkspaces(TEST_WORKSPACES, new Set(["ws-1"]), "s1")

    for (const row of rows) {
      if (row.type === "workspace") {
        // TypeScript narrows row to FlatWorkspaceHeaderRow
        const header: FlatWorkspaceHeaderRow = row
        expect(header.workspace).toBeDefined()
        expect(typeof header.sessionCount).toBe("number")
      } else if (row.type === "session") {
        // TypeScript narrows row to FlatSessionChildRow
        const child: FlatSessionChildRow = row
        expect(child.session).toBeDefined()
        expect(typeof child.isSelected).toBe("boolean")
        expect(typeof child.workspaceId).toBe("string")
      }
    }
  })

  test("Defect 7: createKeyedList preserves item wrapper identity across selection updates", () => {
    createRoot((dispose) => {
      const [selected, setSelected] = createSignal("s1")
      const rows = () => flattenWorkspaces(TEST_WORKSPACES, new Set(["ws-1"]), selected())
      const keyed = createKeyedList(rows, (r) => `${r.type}:${r.id}`)

      const initial = keyed()
      expect(initial.length).toBe(4) // ws-1, s1, s2, ws-2

      const s1Entry = initial.find((e) => e.id === "session:s1")
      const s2Entry = initial.find((e) => e.id === "session:s2")
      const ws1Entry = initial.find((e) => e.id === "workspace:ws-1")

      expect(s1Entry).toBeDefined()
      expect(s2Entry).toBeDefined()
      expect(ws1Entry).toBeDefined()

      const s1Data = s1Entry!.data() as FlatSessionChildRow
      const s2Data = s2Entry!.data() as FlatSessionChildRow
      expect(s1Data.isSelected).toBe(true)
      expect(s2Data.isSelected).toBe(false)

      // Change selection from s1 to s2
      setSelected("s2")

      const updated = keyed()
      expect(updated.length).toBe(4)

      const s1EntryUpdated = updated.find((e) => e.id === "session:s1")
      const s2EntryUpdated = updated.find((e) => e.id === "session:s2")
      const ws1EntryUpdated = updated.find((e) => e.id === "workspace:ws-1")

      // The wrapper entry references MUST be identical (===) to prevent Solid's <For> from recreating DOM
      expect(s1EntryUpdated).toBe(s1Entry)
      expect(s2EntryUpdated).toBe(s2Entry)
      expect(ws1EntryUpdated).toBe(ws1Entry)

      // But their reactive data signals reflect the updated selection state
      expect((s1EntryUpdated!.data() as FlatSessionChildRow).isSelected).toBe(false)
      expect((s2EntryUpdated!.data() as FlatSessionChildRow).isSelected).toBe(true)

      dispose()
    })
  })

  test("Defect 7: createKeyedList preserves file tree row identity across selection changes", () => {
    createRoot((dispose) => {
      const [selectedPath, setSelectedPath] = createSignal("README.md")
      const files = () => flattenFileTree(TEST_FILES, new Set(["packages"]), selectedPath())
      const keyed = createKeyedList(files, (item) => item.path)

      const initial = keyed()
      const readmeEntry = initial.find((e) => e.id === "README.md")
      const packagesEntry = initial.find((e) => e.id === "packages")

      expect(readmeEntry?.data().isSelected).toBe(true)
      expect(packagesEntry?.data().isSelected).toBe(false)

      // Change selection to packages
      setSelectedPath("packages")

      const updated = keyed()
      const readmeEntryUpdated = updated.find((e) => e.id === "README.md")
      const packagesEntryUpdated = updated.find((e) => e.id === "packages")

      // Stable references
      expect(readmeEntryUpdated).toBe(readmeEntry)
      expect(packagesEntryUpdated).toBe(packagesEntry)

      expect(readmeEntryUpdated?.data().isSelected).toBe(false)
      expect(packagesEntryUpdated?.data().isSelected).toBe(true)

      dispose()
    })
  })

  test("Defect 9: deriveDefaultExpandedDirs derives top-level dirs and ancestors of selected file", () => {
    const defaultDirs = deriveDefaultExpandedDirs(TEST_FILES, "packages/ade/package.json")
    expect(defaultDirs.sort()).toEqual([
      "empty-folder",
      "packages",
      "packages/ade",
    ])

    // Fallback when no files provided
    expect(deriveDefaultExpandedDirs([]).sort()).toEqual(["packages", "src"])
  })

  /*
   * "Defect 10: calculates 1-based aria-level for tree hierarchies" was deleted
   * rather than rewritten, because there is nothing here to calculate.
   *
   * It declared `const wsHeaderLevel = 1` and asserted `toBe(1)` two lines
   * later, then asserted `(depth ?? 0) + 1` against the sum it had just been
   * given — arithmetic on its own constants, with the sidebar never involved.
   *
   * The real values are literals in the markup: `aria-level={1}` on a
   * workspace header, `aria-level={2}` on a session row, `aria-level={
   * props.item.depth + 1}` on a file row (`sidebar.tsx`). Only the last one
   * depends on anything computed, and the depth it reads is already asserted
   * for a whole tree in `file-tree.test.ts` ("includes children at correct
   * depth when directory is expanded"). That the attribute actually reaches
   * the DOM needs a rendered `.tsx`, which this package cannot import under
   * bun test — so it is checked by the accessibility pass, not here.
   */
})

/**
 * The resize drag lifecycle, driven through a fake handle.
 *
 * This replaces a test that built its own `cleanupDrag` closure inside the
 * test file and asserted that calling it set the local flag it had just set —
 * true of any function, and blind to every way a real drag leaks. The
 * lifecycle now lives in `sidebar-logic.ts` and this exercises that code.
 *
 * The handle is a plain object rather than an element: `beginResizeDrag` only
 * ever calls these five members, so a fake records exactly what the sidebar
 * would do to a real one, and the assertions stay about the drag rather than
 * about happy-dom's event plumbing.
 */
function createFakeHandle(options: { capturable?: boolean } = {}) {
  const capturable = options.capturable ?? true
  const listeners = new Map<string, EventListener[]>()
  let captured: number | undefined
  const released: number[] = []

  return {
    get listenerTypes() {
      return [...listeners.keys()].sort()
    },
    get listenerCount() {
      return [...listeners.values()].reduce((n, l) => n + l.length, 0)
    },
    get captured() {
      return captured
    },
    get released() {
      return released
    },
    dispatch(type: string, coords: { clientX?: number; clientY?: number } = {}) {
      // A real Event carrying only the two fields `coordinate` ever reads, so
      // the listeners are called with exactly what the browser would pass.
      const event = Object.assign(new Event(type), coords)
      // Iterate a copy: the pointerup listener tears the drag down, which
      // splices this very array while we are walking it.
      for (const listener of (listeners.get(type) ?? []).slice()) {
        listener(event)
      }
    },
    handle: {
      addEventListener(type: string, listener: EventListener) {
        const existing = listeners.get(type)
        if (existing) existing.push(listener)
        else listeners.set(type, [listener])
      },
      removeEventListener(type: string, listener: EventListener) {
        const existing = listeners.get(type)
        if (!existing) return
        const i = existing.indexOf(listener)
        if (i >= 0) existing.splice(i, 1)
        if (existing.length === 0) listeners.delete(type)
      },
      setPointerCapture(pointerId: number) {
        if (capturable) captured = pointerId
      },
      hasPointerCapture(pointerId: number) {
        return captured === pointerId
      },
      releasePointerCapture(pointerId: number) {
        released.push(pointerId)
        if (captured === pointerId) captured = undefined
      },
    },
  }
}

describe("beginResizeDrag", () => {
  test("captures the pointer and listens on the handle, not on the window", () => {
    const fake = createFakeHandle()

    beginResizeDrag({
      handle: fake.handle,
      pointerId: 7,
      coordinate: (e) => e.clientX,
      onMove: () => {},
      onEnd: () => {},
      onCommit: () => {},
    })

    // Capture is what keeps the gesture alive when the pointer crosses into
    // the browser pane's iframe; window listeners stop being delivered there.
    expect(fake.captured).toBe(7)
    expect(fake.listenerTypes).toEqual(["pointercancel", "pointermove", "pointerup"])
  })

  test("forwards the tracked axis on every move", () => {
    const fake = createFakeHandle()
    const seen: number[] = []

    beginResizeDrag({
      handle: fake.handle,
      pointerId: 1,
      coordinate: (e) => e.clientY,
      onMove: (value) => seen.push(value),
      onEnd: () => {},
      onCommit: () => {},
    })

    fake.dispatch("pointermove", { clientX: 999, clientY: 120 })
    fake.dispatch("pointermove", { clientX: 999, clientY: 160 })

    // `coordinate` picks the axis, so the height drag never reacts to clientX.
    expect(seen).toEqual([120, 160])
  })

  test("pointerup detaches every listener, releases the capture, then commits", () => {
    const fake = createFakeHandle()
    const order: string[] = []

    beginResizeDrag({
      handle: fake.handle,
      pointerId: 3,
      coordinate: (e) => e.clientX,
      onMove: () => order.push("move"),
      onEnd: () => order.push("end"),
      onCommit: () => order.push("commit"),
    })

    fake.dispatch("pointerup")

    // Nothing left attached is the whole point: the leak this replaced was a
    // pointerup that never arrived, leaving the sidebar resizing on hover.
    expect(fake.listenerCount).toBe(0)
    expect(fake.released).toEqual([3])
    expect(fake.captured).toBeUndefined()
    // The size must be settled before it is persisted, never the other way.
    expect(order).toEqual(["end", "commit"])
  })

  test("moves after the drag ended are ignored", () => {
    const fake = createFakeHandle()
    let moves = 0

    beginResizeDrag({
      handle: fake.handle,
      pointerId: 1,
      coordinate: (e) => e.clientX,
      onMove: () => moves++,
      onEnd: () => {},
      onCommit: () => {},
    })

    fake.dispatch("pointermove", { clientX: 100 })
    fake.dispatch("pointerup")
    fake.dispatch("pointermove", { clientX: 400 })

    expect(moves).toBe(1)
  })

  test("pointercancel ends the drag exactly as pointerup does", () => {
    const fake = createFakeHandle()
    let ended = 0
    let committed = 0

    beginResizeDrag({
      handle: fake.handle,
      pointerId: 4,
      coordinate: (e) => e.clientX,
      onMove: () => {},
      onEnd: () => ended++,
      onCommit: () => committed++,
    })

    // Capture lost — another window took the pointer, the element went away.
    // The gesture has to finish rather than stay live with nothing driving it.
    fake.dispatch("pointercancel")

    expect(ended).toBe(1)
    expect(committed).toBe(1)
    expect(fake.listenerCount).toBe(0)
    expect(fake.captured).toBeUndefined()
  })

  test("the returned teardown ends the drag without persisting a size", () => {
    const fake = createFakeHandle()
    let ended = 0
    let committed = 0

    const teardown = beginResizeDrag({
      handle: fake.handle,
      pointerId: 5,
      coordinate: (e) => e.clientX,
      onMove: () => {},
      onEnd: () => ended++,
      onCommit: () => committed++,
    })

    // This is the unmount path: the component is going away mid-drag, so the
    // half-finished width must not be written to storage.
    teardown()

    expect(ended).toBe(1)
    expect(committed).toBe(0)
    expect(fake.listenerCount).toBe(0)
    expect(fake.released).toEqual([5])
  })

  test("teardown is idempotent, and a late pointerup cannot re-end the drag", () => {
    const fake = createFakeHandle()
    let ended = 0

    const teardown = beginResizeDrag({
      handle: fake.handle,
      pointerId: 6,
      coordinate: (e) => e.clientX,
      onMove: () => {},
      onEnd: () => ended++,
      onCommit: () => {},
    })

    teardown()
    teardown()

    // `onEnd` clears the component's `activeResizeCleanup` and drops the
    // resizing class; running it twice on one gesture would undo a second
    // drag that had already started.
    expect(ended).toBe(1)
    // Only the capture we held is released. A second release of a pointer
    // that was never captured throws NotFoundError in a real browser, which
    // on the unmount path would take the rest of the cleanup down with it.
    expect(fake.released).toEqual([6])
  })

  test("survives a handle without pointer capture support", () => {
    const fake = createFakeHandle({ capturable: false })
    const bare: ResizeDragHandle = {
      addEventListener: (type, listener) => fake.handle.addEventListener(type, listener),
      removeEventListener: (type, listener) => fake.handle.removeEventListener(type, listener),
    }
    let ended = 0

    beginResizeDrag({
      handle: bare,
      pointerId: 2,
      coordinate: (e) => e.clientX,
      onMove: () => {},
      onEnd: () => ended++,
      onCommit: () => {},
    })

    // Older webviews and the test DOM have no pointer capture. The drag is
    // degraded there, not broken: the listeners still attach and still detach.
    fake.dispatch("pointerup")
    expect(ended).toBe(1)
    expect(fake.listenerCount).toBe(0)
  })

  test("a missing handle starts nothing and tears down without throwing", () => {
    let ended = 0

    // `event.currentTarget` is null once the handler has returned, and Solid
    // reuses the event object; the drag must not explode on that path.
    const teardown = beginResizeDrag({
      handle: null,
      pointerId: 1,
      coordinate: (e) => e.clientX,
      onMove: () => {},
      onEnd: () => ended++,
      onCommit: () => {},
    })

    expect(() => teardown()).not.toThrow()
    expect(ended).toBe(1)
  })
})

/*
 * What this file deliberately does not cover about the drag.
 *
 * `beginResizeDrag` is the whole lifecycle, but three things around it are
 * browser behaviour and cannot be asserted from a fake handle:
 *
 *  - that `setPointerCapture` really does reroute events across an iframe
 *    boundary, which is the bug that made the handle-scoped listeners
 *    necessary in the first place;
 *  - that `event.preventDefault()` in the pointerdown handler suppresses the
 *    text selection that otherwise follows the pointer across the sidebar;
 *  - that `event.currentTarget` inside Solid's `onPointerDown` is the resize
 *    handle element, which is what the component passes as `handle`.
 *
 * All three live in `sidebar.tsx`, a `.tsx` this package cannot import under
 * bun test. They are left named here rather than simulated: re-declaring them
 * over local variables is exactly what the deleted "Defect 2" test did, and it
 * is how a green suite missed the leak.
 */
