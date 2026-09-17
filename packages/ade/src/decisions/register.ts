/**
 * The open project's register, live: loaded when the project changes, read
 * again when the file changes on disk, appended to by the window and the panel.
 *
 * One instance for the whole workbench, so the badge, the window and every
 * Decisions panel show the same state and a write in one is seen by the
 * others at once rather than on the next poll.
 *
 * Watching is a stat, not a read: the directory listing's size and mtime for
 * the register, every few seconds while the window is visible, and a read
 * only when they move. Master appending from a shell shows up within one tick.
 */

import { createMemo, createSignal, type Accessor } from "solid-js"
import { every } from "../host/every"
import type { DirEntry } from "../host/shell"
import type { DecisionEvent } from "./log"
import { foldDecisions, type DecisionsState } from "./state"
import { appendDecisionEvent, loadDecisions, type DecisionsIo, type LoadedRegister } from "./store"
import { t } from "../i18n"

export const REGISTER_WATCH_MS = 2500

export interface DecisionsRegisterDeps {
  /** The register's path for the open project; undefined with no project. */
  path: Accessor<string | undefined>
  io: () => Promise<(DecisionsIo & { readDir?: (path: string) => Promise<DirEntry[]> }) | undefined>
}

export interface DecisionsRegister {
  readonly path: Accessor<string | undefined>
  /** Undefined until the first read, and while there is no project. */
  readonly loaded: Accessor<LoadedRegister | undefined>
  /**
   * Where every decision stands now. Folded again when the minute changes, so
   * a deferral that runs out while ADE is open comes back without a write.
   */
  readonly state: Accessor<DecisionsState | undefined>
  readonly now: Accessor<Date>
  /** Why the register could not be read; the last good state stays shown. */
  readonly error: Accessor<string | undefined>
  /** Re-reads now. */
  refresh: () => Promise<void>
  /** Appends one event; rejects with the reason it was refused. */
  append: (event: DecisionEvent) => Promise<void>
  /** Starts watching; returns the stop. */
  watch: () => () => void
}

export function createDecisionsRegister(deps: DecisionsRegisterDeps): DecisionsRegister {
  const [loaded, setLoaded] = createSignal<LoadedRegister>()
  const [error, setError] = createSignal<string>()
  const [now, setNow] = createSignal(new Date())
  const state = createMemo(() => {
    const register = loaded()
    return register ? foldDecisions(register.events, now()) : undefined
  })
  let loadedPath: string | undefined
  let stamp: string | undefined

  const stampOf = async (path: string): Promise<string | undefined> => {
    const io = await deps.io()
    if (!io?.readDir) return undefined
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    const dir = path.slice(0, slash)
    const name = path.slice(slash + 1)
    const entries = await io.readDir(dir).catch(() => [] as DirEntry[])
    const entry = entries.find((item) => item.name === name)
    return entry ? `${entry.size}:${entry.modified_ms}` : "assente"
  }

  const refresh = async () => {
    const path = deps.path()
    if (!path) {
      loadedPath = undefined
      stamp = undefined
      setLoaded(undefined)
      setError(undefined)
      return
    }
    const io = await deps.io()
    if (!io) return
    try {
      const nextStamp = await stampOf(path)
      setNow(new Date())
      const register = await loadDecisions(io, path)
      // The project may have changed while this read was on its way.
      if (deps.path() !== path) return
      loadedPath = path
      stamp = nextStamp
      setLoaded(register)
      setError(undefined)
    } catch (failure) {
      if (deps.path() === path) setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const append = async (event: DecisionEvent) => {
    const path = deps.path()
    const io = await deps.io()
    if (!path || !io) throw new Error(t("decisions.noProject.short"))
    await appendDecisionEvent(io, path, event)
    await refresh()
  }

  const tick = async () => {
    // Set only when the minute turns: nothing re-renders between two ticks.
    if (Math.floor(Date.now() / 60_000) !== Math.floor(now().getTime() / 60_000)) setNow(new Date())
    const path = deps.path()
    if (path !== loadedPath) return refresh()
    if (!path) return
    const next = await stampOf(path)
    // Without a directory listing there is nothing cheap to compare: read.
    if (next === undefined || next !== stamp) await refresh()
  }

  return {
    path: deps.path,
    loaded,
    state,
    now,
    error,
    refresh,
    append,
    watch: () => every(REGISTER_WATCH_MS, tick, { immediate: true }),
  }
}
