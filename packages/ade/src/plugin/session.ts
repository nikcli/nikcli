/**
 * What a plugin is allowed to see of a session.
 *
 * A workbench `Pane` carries the whole transcript, the open buffer, the
 * worktree and the task text. A plugin gets the identity and the state and
 * nothing else — not because the transcript is a secret (the plugin shares a
 * JavaScript context with it) but because a narrow, stable shape is what makes
 * the contract in `@nikcli-ai/plugin/v2/ade` something ADE can keep: handing
 * out the internal type would make every field of it public, and renaming
 * `activity` would then be a breaking change for third-party code.
 */
import type { SessionInfo } from "@nikcli-ai/plugin/v2/ade/context"
import type { Pane } from "../surface/state"

export function toPluginSession(pane: Pane): SessionInfo {
  return {
    id: pane.id,
    title: pane.title,
    status: pane.status,
    agent: pane.agent,
    model: pane.model,
    cwd: pane.cwd,
    projectName: pane.workspaceId,
  }
}
