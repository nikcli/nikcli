/**
 * Where the keyboard should land inside a session pane.
 *
 * One definition, used by everything that hands a pane the keyboard: the
 * `focused` effect, and the drop handler. They used to disagree — the effect
 * knew about the terminal and the drop knew about nothing — which is how a
 * screenshot dropped onto a pane left the caret in the screenshot tray.
 *
 * A `.tsx` cannot be imported under `bun test` here, but this is plain DOM
 * and the test preload registers happy-dom, so the choice below is asserted
 * against real elements rather than described in a comment and hoped for.
 */

/**
 * Ordered by what a session pane is for.
 *
 * The terminal wins whenever there is one: it is the session. xterm renders
 * into a hidden textarea, so that textarea — not the wrapper — is what has to
 * receive focus, and it is tried first. The composer (`pane-input`) is the
 * fallback for a pane whose process has finished and has no terminal left.
 */
const TARGETS = [
  '[data-slot="pane-terminal"] textarea',
  '[data-slot="pane-terminal"]',
  '[data-slot="pane-input"]',
  "textarea",
] as const

/**
 * The element that should hold the caret, or nothing if the pane has none.
 *
 * A disabled control is skipped rather than returned. The composer of a
 * finished session *is* disabled — there is no process to type to — and
 * `focus()` on it does nothing at all, silently: without this the pane
 * reports that it took the caret while the caret is still on `<body>`.
 */
export function findFocusTarget(root: ParentNode): HTMLElement | undefined {
  for (const selector of TARGETS) {
    for (const found of root.querySelectorAll<HTMLElement>(selector)) {
      if (!isFocusable(found)) continue
      return found
    }
  }
  return undefined
}

function isFocusable(element: HTMLElement): boolean {
  if ((element as HTMLElement & { disabled?: boolean }).disabled === true) return false
  return element.getAttribute("aria-disabled") !== "true"
}

/**
 * Puts the caret in the pane, and says whether it had to.
 *
 * `preventScroll` because the grid is the scrolling container: focusing a
 * terminal in a six-pane grid must not jump the layout to bring it into view,
 * since the user is already looking at it.
 */
export function focusPane(root: ParentNode | undefined | null): boolean {
  if (!root) return false
  const target = findFocusTarget(root)
  if (!target) return false
  target.focus({ preventScroll: true })
  return true
}

/**
 * True when the caret is already somewhere inside this pane.
 *
 * Used to leave a deliberate focus alone — a user who clicked into the
 * composer must not be thrown back into the terminal by an unrelated
 * re-render. Note that it is deliberately *not* consulted after a drop: a
 * drag leaves focus on whatever was dragged, which is outside the pane, and
 * the answer would be "no" for the wrong reason.
 */
export function holdsFocus(root: ParentNode | undefined | null, active: Element | null): boolean {
  if (!root || !active) return false
  return root === active || (root as ParentNode & Node).contains?.(active) === true
}
