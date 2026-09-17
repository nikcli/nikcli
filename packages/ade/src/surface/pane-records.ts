import { createSignal } from "solid-js"
import type { Buffer } from "../editor"
import type { PermissionRequest } from "../session/permission"
import type { SessionReport } from "../session/report"
import type { SessionDiff } from "../review"

/**
 * Everything ADE knows about a pane that is not part of the pane.
 *
 * Seven maps keyed by pane id, all with the same life: they start empty, they
 * gain an entry when something happens to a session, and they have to lose it
 * when that session closes. They were seven separate signals in the workbench
 * and one hand-written `forgetPane` that deleted from each by name — which is
 * a list that has to be edited every time a map is added, and was not: the
 * maps grew for as long as ADE stayed open, holding buffers and diffs for
 * panes that had been closed hours earlier.
 *
 * Here the forgetting iterates the records themselves, so a new one is
 * cleaned up by having been declared.
 *
 * None of this is persisted, and that is deliberate: a diff is a reading of
 * the disk at a moment, and restoring yesterday's would be showing a picture
 * of a checkout that has moved since.
 */

/**
 * One map, read like a signal and written by id.
 *
 * Callable so that `buffers()[id]` still works — the readers throughout the
 * grid are reading a plain object and should not have to care that there is
 * an API behind it.
 */
export interface PaneRecord<T> {
  (): Record<string, T>
  /** The entry for one pane, tracked like any other read. */
  get(id: string): T | undefined
  /** Writes an entry. Writing the value already there notifies nobody. */
  set(id: string, value: T): void
  /**
   * Rewrites an entry from what it was. Returning `undefined` removes it,
   * which is how an entry that was never there stays absent rather than
   * becoming an explicit `undefined`.
   */
  update(id: string, change: (current: T | undefined) => T | undefined): void
  /** Drops the entry for one pane. */
  forget(id: string): void
}

export function createPaneRecord<T>(): PaneRecord<T> {
  const [all, setAll] = createSignal<Record<string, T>>({})

  const record = (() => all()) as PaneRecord<T>

  record.get = (id) => all()[id]

  record.set = (id, value) => setAll((current) => (current[id] === value ? current : { ...current, [id]: value }))

  record.update = (id, change) =>
    setAll((current) => {
      const next = change(current[id])
      if (next === current[id]) return current
      if (next === undefined) {
        if (!(id in current)) return current
        const without = { ...current }
        delete without[id]
        return without
      }
      return { ...current, [id]: next }
    })

  record.forget = (id) => record.update(id, () => undefined)

  return record
}

export interface PaneRecords {
  /** What each session has told us about its own spending. */
  reports: PaneRecord<SessionReport>
  /** Open file buffers. */
  buffers: PaneRecord<Buffer>
  bufferLoading: PaneRecord<boolean>
  /** The question each pane is currently stopped on, if any. */
  permissions: PaneRecord<PermissionRequest>
  /** Whether a pane is showing its transcript or its diff. */
  paneView: PaneRecord<"transcript" | "diff">
  paneDiff: PaneRecord<SessionDiff>
  diffLoading: PaneRecord<boolean>
  /** Forgets a pane in every record at once. */
  forget(id: string): void
}

export function createPaneRecords(): PaneRecords {
  const records = {
    reports: createPaneRecord<SessionReport>(),
    buffers: createPaneRecord<Buffer>(),
    bufferLoading: createPaneRecord<boolean>(),
    permissions: createPaneRecord<PermissionRequest>(),
    paneView: createPaneRecord<"transcript" | "diff">(),
    paneDiff: createPaneRecord<SessionDiff>(),
    diffLoading: createPaneRecord<boolean>(),
  }

  // Read off the object rather than listed again, so the two cannot disagree.
  const everything = Object.values(records) as PaneRecord<unknown>[]

  return {
    ...records,
    forget(id) {
      for (const record of everything) record.forget(id)
    },
  }
}
