/**
 * Pure data models and tree flattening for workspaces and live agent sessions.
 *
 * In ADE, sessions are grouped by workspace/project. The sidebar presents this
 * hierarchy as an expandable list where each workspace displays its live
 * sessions, their execution status, and selection state.
 */

import { focusAfterClose } from "../grid/focus"
import type { PaneStatus } from "../grid/pane"

export type WorkspaceSessionStatus = PaneStatus

export type AgentDisplayStatus = "disponibile" | "a lavoro" | "in attesa di input" | "task completata" | "errore"

export function mapAgentStatus(status: WorkspaceSessionStatus): AgentDisplayStatus {
  switch (status) {
    case "working":
      return "a lavoro"
    case "waiting":
      return "in attesa di input"
    case "done":
      return "task completata"
    case "error":
      return "errore"
    case "idle":
    case "provisioning":
    default:
      return "disponibile"
  }
}

export function normalizeAgentId(raw?: string): string {
  if (!raw) return "nikcli"
  const s = raw.toLowerCase().trim()
  if (s.includes("claude")) return "claude-code"
  if (s.includes("codex") || s.includes("openai")) return "codex"
  if (s.includes("opencode")) return "opencode"
  if (s.includes("agy") || s.includes("antigravity")) return "agy"
  if (s.includes("hermes") || s.includes("nous")) return "hermes"
  if (s.includes("kimi") || s.includes("moonshot")) return "kimi"
  if (s.includes("prime")) return "prime"
  if (s.includes("ohmypi")) return "ohmypi"
  if (s.includes("pi")) return "pi"
  if (s.includes("shell") || s.includes("term") || s.includes("bash") || s.includes("zsh") || s.includes("powershell"))
    return "terminal"
  if (s.includes("nik")) return "nikcli"
  return "nikcli"
}

export interface SidebarSession {
  id: string
  title: string
  status: WorkspaceSessionStatus
  workspaceId?: string
  activity?: string
  startTime?: number
  agent?: string
  branch?: string
  cwd?: string
}

export interface Workspace {
  id: string
  name: string
  path?: string
  branch?: string
  sessions: SidebarSession[]
}

export interface FlatWorkspaceHeaderRow {
  type: "workspace"
  id: string
  workspace: Workspace
  isExpanded: boolean
  sessionCount: number
}

export interface FlatSessionChildRow {
  type: "session"
  id: string
  session: SidebarSession
  workspaceId: string
  isSelected: boolean
}

export type FlatWorkspaceRow = FlatWorkspaceHeaderRow | FlatSessionChildRow

/**
 * Toggles the expanded state of a workspace, returning a new immutable Set.
 */
export function toggleWorkspaceExpansion(expanded: ReadonlySet<string>, workspaceId: string): Set<string> {
  const next = new Set(expanded)
  if (next.has(workspaceId)) {
    next.delete(workspaceId)
  } else {
    next.add(workspaceId)
  }
  return next
}

/**
 * Checks whether a workspace is expanded.
 */
export function isWorkspaceExpanded(expanded: ReadonlySet<string>, workspaceId: string): boolean {
  return expanded.has(workspaceId)
}

/**
 * Returns the total number of sessions currently active in a workspace.
 */
export function countWorkspaceSessions(workspace: Workspace): number {
  return workspace.sessions.length
}

/**
 * Flattens the workspace hierarchy into a linear sequence of rows for rendering.
 *
 * Collapsed workspaces produce a single workspace header row. Expanded
 * workspaces produce the header row followed by their session children.
 */
export function flattenWorkspaces(
  workspaces: readonly Workspace[],
  expanded: ReadonlySet<string>,
  selectedSessionId?: string,
): FlatWorkspaceRow[] {
  const rows: FlatWorkspaceRow[] = []

  for (const workspace of workspaces) {
    const isExpanded = expanded.has(workspace.id)
    rows.push({
      type: "workspace",
      id: workspace.id,
      workspace,
      isExpanded,
      sessionCount: workspace.sessions.length,
    })

    if (isExpanded) {
      for (const session of workspace.sessions) {
        rows.push({
          type: "session",
          id: session.id,
          session,
          workspaceId: workspace.id,
          isSelected: session.id === selectedSessionId,
        })
      }
    }
  }

  return rows
}

/**
 * Finds the workspace that contains a given session id.
 */
export function findWorkspaceBySessionId(workspaces: readonly Workspace[], sessionId: string): Workspace | undefined {
  return workspaces.find((ws) => ws.sessions.some((s) => s.id === sessionId))
}

/**
 * Collects all session IDs across all workspaces in display order.
 */
export function getAllSessionIds(workspaces: readonly Workspace[]): string[] {
  const ids: string[] = []
  for (const ws of workspaces) {
    for (const session of ws.sessions) {
      ids.push(session.id)
    }
  }
  return ids
}

/**
 * Determines which session should be selected when a session is closed.
 *
 * Delegates directly to the single authoritative focusAfterClose rule across all
 * session IDs in flat display order, ensuring that sidebar selection and grid focus
 * never disagree on screen.
 *
 * 1. Closing an unselected session never moves selection; if nothing was selected
 *    or the selected session is already absent, returns undefined.
 * 2. Closing the selected session moves to its successor in flat display order
 *    (seamlessly advancing into the next workspace if at the end of a workspace).
 * 3. If it was the last session in the entire list, falls back to its predecessor.
 * 4. If no sessions remain anywhere, returns undefined.
 */
export function selectionAfterSessionClose(
  workspaces: readonly Workspace[],
  closingId: string,
  currentSelectedId?: string,
): string | undefined {
  return focusAfterClose({
    panes: getAllSessionIds(workspaces),
    focused: currentSelectedId,
    closing: closingId,
  })
}
