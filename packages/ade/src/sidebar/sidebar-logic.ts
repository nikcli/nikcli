/**
 * The lifecycle of a sidebar resize drag, outside the component.
 *
 * `sidebar.tsx` used to inline this twice — once for the width handle, once
 * for the sessions-height handle — and a `.tsx` cannot be imported by a test
 * in this package, because bun test has no automatic JSX runtime here. So the
 * part of a drag that can actually go wrong (listeners that outlive the
 * gesture, a pointer capture that is never released, a teardown that runs
 * twice and persists a stale size) had no test at all. What stood in for one
 * was a local `cleanupDrag` declared inside `sidebar-logic.test.ts` that set a
 * local boolean: it asserted that assigning a function to a variable and then
 * calling it calls it, which is true of every function ever written and says
 * nothing about the sidebar.
 *
 * Extracting the lifecycle here makes it testable against a fake handle, with
 * no DOM: the component and the test drive the same code.
 */

/**
 * The part of the drag handle element this module touches.
 *
 * Declared with method syntax rather than function-typed properties so that a
 * real `HTMLElement` satisfies it structurally, and so a plain object can too.
 * The pointer-capture members are optional because the drag has to keep
 * working where they are missing (older webviews, and the happy-dom element
 * used in tests).
 */
export interface ResizeDragHandle {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
  setPointerCapture?(pointerId: number): void
  hasPointerCapture?(pointerId: number): boolean
  releasePointerCapture?(pointerId: number): void
}

export interface ResizeDragOptions {
  /** The handle the gesture started on. `null` when the event had no target. */
  handle: ResizeDragHandle | null | undefined
  /** The pointer to capture and to release again on teardown. */
  pointerId: number
  /** Reads the axis this drag tracks: `clientX` for width, `clientY` for height. */
  coordinate: (event: PointerEvent) => number
  /** Called for every move with the tracked coordinate. */
  onMove: (coordinate: number) => void
  /** Called exactly once, when the drag ends however it ends. */
  onEnd: () => void
  /** Called after `onEnd` only when the gesture finished on its own, to persist the result. */
  onCommit: () => void
}

/**
 * Starts a resize drag and returns its teardown.
 *
 * The three listeners go on the handle, not on `window`. Listening on the
 * window stops working the moment the pointer crosses into the browser pane's
 * iframe: events inside a frame belong to that document and neither
 * `pointermove` nor `pointerup` comes back out, so the `pointerup` that should
 * have ended the drag was never delivered, the listeners stayed attached, and
 * the sidebar went on resizing itself the next time the mouse moved with no
 * button down. `setPointerCapture` routes every event for this pointer to the
 * handle until release, iframe or not, and the browser ends the capture itself
 * if the element goes away — so a drag cannot outlive its own handle.
 *
 * `pointercancel` ends the drag the same way `pointerup` does. Losing the
 * capture — another window took the pointer, the element was removed — has to
 * finish the gesture rather than leave it live with nothing driving it.
 *
 * The returned teardown is idempotent and does not commit, which is what makes
 * it safe to call from `onCleanup` on unmount and again from the pointer-up
 * path without persisting a size twice.
 */
export function beginResizeDrag(options: ResizeDragOptions): () => void {
  const { handle, pointerId, coordinate, onMove, onEnd, onCommit } = options

  handle?.setPointerCapture?.(pointerId)

  let ended = false

  const onPointerMove: EventListener = (event) => {
    if (ended) return
    onMove(coordinate(event as PointerEvent))
  }

  const teardown = () => {
    if (ended) return
    ended = true
    handle?.removeEventListener("pointermove", onPointerMove)
    handle?.removeEventListener("pointerup", onPointerFinish)
    handle?.removeEventListener("pointercancel", onPointerFinish)
    // Only release a capture we actually hold: `releasePointerCapture` throws
    // `NotFoundError` for a pointer that was never captured, which on the
    // unmount path would take the rest of the cleanup down with it.
    if (handle?.hasPointerCapture?.(pointerId)) {
      handle.releasePointerCapture?.(pointerId)
    }
    onEnd()
  }

  const onPointerFinish: EventListener = () => {
    teardown()
    onCommit()
  }

  handle?.addEventListener("pointermove", onPointerMove)
  handle?.addEventListener("pointerup", onPointerFinish)
  handle?.addEventListener("pointercancel", onPointerFinish)

  return teardown
}
