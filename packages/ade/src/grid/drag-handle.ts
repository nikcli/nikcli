/**
 * Where a pane can be picked up, and where a press belongs to something else.
 *
 * Its own file, and plain `.ts`, because this is the rule that decides whether
 * a press starts a drag at all: it was a pair of selectors inside the grid
 * component, testable only by hand, and a chip added to the header silently
 * took the middle of the header out of the handle.
 */

/**
 * A session's header, a browser's toolbar, or a grip a pane draws for the
 * purpose. The browser has no session header — its toolbar is the top of the
 * pane — so without it being a handle too it is the one pane that cannot be
 * picked up at all.
 */
export const HANDLE = '[data-slot="pane-header"], [data-slot="browser-header"], [data-slot="pane-grip"]'

/**
 * What a press inside a handle belongs to instead: anything that does
 * something when pressed, or takes text.
 *
 * `button` is listed, so anything drawn as a button that is *not* a control
 * has to stop being one. The state chip was a `<button>` with no `onClick`:
 * it did nothing when pressed and, by being a button, took the middle of the
 * header out of the handle. It is a `<span>` now — see `pane.tsx`.
 */
export const NOT_A_HANDLE = "button, input, textarea, select, a, [contenteditable], [role='button']"

/** Whether a press on `target` should start dragging the pane. */
export function isDragHandle(target: Element | null | undefined): boolean {
  if (!target) return false
  return Boolean(target.closest(HANDLE)) && !target.closest(NOT_A_HANDLE)
}
