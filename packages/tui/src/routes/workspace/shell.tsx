import { createContext, createEffect, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"
import type { RepoStatus } from "./repo-status"

/**
 * State the workspace shell shares with the panels it hosts.
 *
 * Two things pushed this into a context. The repository status strip is one:
 * every panel wanted the branch and the dirty count, and four panels each
 * spawning their own `git status` was the spawn storm we already paid for once.
 *
 * `captured` is the other. The shell listens for `1`–`5` and `tab` on the raw
 * key stream, and it is registered *before* its children, so it saw every key
 * first — including the ones typed into a panel's filter box, where "3" quietly
 * switched tab instead of narrowing the list. A panel with an open input sets
 * `captured` and the shell stands down.
 */
export type WorkspaceShell = {
  status: Accessor<RepoStatus | undefined>
  loading: Accessor<boolean>
  refresh: () => void
  captured: Accessor<boolean>
  setCaptured: (value: boolean) => void
  /** Open the repository action menu (the shell's `.` key). */
  openActions: () => void
}

const WorkspaceShellCtx = createContext<WorkspaceShell>()

export function WorkspaceShellProvider(props: ParentProps<{ value: WorkspaceShell }>) {
  return <WorkspaceShellCtx.Provider value={props.value}>{props.children}</WorkspaceShellCtx.Provider>
}

/** `undefined` when a panel is rendered outside the workspace (tests, plugins). */
export function useWorkspaceShell() {
  return useContext(WorkspaceShellCtx)
}

/**
 * Hold the shell's shortcuts while `active()` — a filter or prompt is open.
 * Releases on cleanup so a panel that unmounts mid-edit cannot wedge the shell.
 */
export function useKeyboardCapture(active: Accessor<boolean>) {
  const shell = useWorkspaceShell()
  if (!shell) return
  createEffect(() => shell.setCaptured(active()))
  onCleanup(() => shell.setCaptured(false))
}
