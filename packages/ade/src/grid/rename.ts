/**
 * Renaming a session from its pane.
 *
 * The title is the one thing on a pane the user owns outright — the agent, the
 * branch and the state are facts, the name is a label — and it is edited in
 * place, on the header, where it is read. Two ways in: a double click on the
 * title, and the `pane.rename` command, which reaches the pane through a DOM
 * event so the workbench does not have to thread a "now editing" flag through
 * the renderer for a gesture that lasts two seconds.
 *
 * Plain `.ts` on purpose: `bun test` cannot load a Solid `.tsx`, and the rule
 * for what counts as a new name is the part worth asserting.
 */

/** Dispatched on a pane's root (`[data-pane-id]`) to open the title for editing. */
export const RENAME_EVENT = "ade:rename"

/**
 * The name to store, or nothing if the edit changes nothing.
 *
 * Whitespace around the name is dropped, because an accidental trailing space
 * is not a rename. An empty result keeps the old name rather than storing an
 * empty one: a pane with no title is a pane the sidebar cannot list.
 */
export function commitRename(raw: string, current: string): string | undefined {
  const next = raw.trim()
  if (next.length === 0 || next === current) return undefined
  return next
}

/**
 * Asks the pane with this id to start editing its title.
 *
 * Returns whether a pane was there to ask. A browser or file pane carries the
 * same attribute and simply does not listen, so the command is inert on them
 * instead of throwing.
 */
export function requestRename(paneId: string | undefined, root: ParentNode = document): boolean {
  if (!paneId) return false
  // Compared, not interpolated into a selector: an id is data, and a selector
  // built from it needs escaping that not every DOM agrees on.
  for (const pane of root.querySelectorAll("[data-pane-id]")) {
    if (pane.getAttribute("data-pane-id") !== paneId) continue
    pane.dispatchEvent(new CustomEvent(RENAME_EVENT))
    return true
  }
  return false
}
