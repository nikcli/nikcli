/**
 * What ADE has to tell the user and they were not looking at.
 *
 * Until now every one of these was a transient: a save that failed wrote a
 * line into a transcript the user had scrolled away from, a session that
 * ended changed a colour in a pane that was off screen, a voice error
 * appeared in a strip and was dismissed by the next one. Nothing accumulated,
 * so anything missed was gone.
 *
 * The bell is the place they accumulate. This module is the part with a rule
 * in it: what counts as the same notice arriving twice, how many are kept,
 * and when the count goes back to zero.
 *
 * Pure, in a `.ts`, because a `.tsx` cannot be imported under `bun test` here.
 */

export type NoticeKind = "error" | "warning" | "info" | "done"

export interface Notice {
  readonly id: string
  readonly kind: NoticeKind
  readonly text: string
  /** Which session it came from, when it came from one. */
  readonly paneId?: string
  /** A page the notice can open, such as a new release. */
  readonly href?: string
  readonly at: number
  readonly read: boolean
}

/**
 * How many are kept.
 *
 * A bell that holds a thousand notices is a log, and a log is something
 * nobody opens. Past this the oldest go, because the reason to look at this
 * list is "what did I miss", not "what has ever happened".
 */
export const MAX_NOTICES = 50

/**
 * How close together two identical notices are the same event.
 *
 * An agent that fails to write a file usually fails to write it four times.
 * Four rows say nothing the first one did not, and they push the rest of the
 * list out of the window that keeps it readable.
 */
export const COALESCE_MS = 10_000

export interface NoticeInput {
  readonly kind: NoticeKind
  readonly text: string
  readonly paneId?: string
  readonly href?: string
  readonly at: number
}

/**
 * Adds a notice, or folds it into the one it repeats.
 *
 * Returns a new list, newest first. Folding deliberately does *not* mark the
 * existing notice unread again if it was read: the user has seen this, and a
 * bell that lights up for something already dismissed teaches them to ignore
 * the bell.
 */
export function addNotice(list: readonly Notice[], input: NoticeInput): Notice[] {
  const previous = list[0]
  if (
    previous &&
    previous.kind === input.kind &&
    previous.text === input.text &&
    previous.paneId === input.paneId &&
    input.at - previous.at < COALESCE_MS
  ) {
    // The same thing again, still happening: move its timestamp forward so a
    // burst does not expire out of the coalescing window halfway through.
    return [{ ...previous, at: input.at }, ...list.slice(1)]
  }

  const notice: Notice = {
    id: `n${input.at}-${list.length}`,
    kind: input.kind,
    text: input.text,
    ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
    ...(input.href !== undefined ? { href: input.href } : {}),
    at: input.at,
    read: false,
  }
  return [notice, ...list].slice(0, MAX_NOTICES)
}

/** How many the bell should show. Zero means no badge at all. */
export function unreadCount(list: readonly Notice[]): number {
  return list.reduce((total, notice) => (notice.read ? total : total + 1), 0)
}

/**
 * Everything read.
 *
 * Opening the list is reading it: the notices are one line each and they are
 * all on screen at once, so a per-row "mark as read" would be asking the user
 * to do bookkeeping for a machine that can already see they looked.
 */
export function markAllRead(list: readonly Notice[]): Notice[] {
  if (list.every((notice) => notice.read)) return [...list]
  return list.map((notice) => (notice.read ? notice : { ...notice, read: true }))
}

/** Removes one, for the row's own dismiss. */
export function dismissNotice(list: readonly Notice[], id: string): Notice[] {
  return list.filter((notice) => notice.id !== id)
}

/**
 * The bell's own state, so the component does not decide it twice.
 *
 * "alert" only for something that went wrong: a bell that shouts for a
 * finished session shouts all day, and then it is not a signal.
 */
export function bellTone(list: readonly Notice[]): "quiet" | "unread" | "alert" {
  const unread = list.filter((notice) => !notice.read)
  if (unread.length === 0) return "quiet"
  return unread.some((notice) => notice.kind === "error") ? "alert" : "unread"
}
