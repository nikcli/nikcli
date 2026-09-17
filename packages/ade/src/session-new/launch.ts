/**
 * Generates the preview list of sessions that will launch.
 *
 * Each entry details the 1-based index displayed in the UI, the agent or shell identifier,
 * and the specific role (agent, shell, or reviewer) assigned to that slot according to the
 * chosen preset topology.
 */

import type { PresetId } from "./preset"

export interface LaunchEntry {
  index: number // 1-based, as shown in the UI
  agentId: string // the chosen agent, or the shell for a workbench slot
  role: "agent" | "shell" | "reviewer"
}

/**
 * Generates the exact list of session entries that the WILL LAUNCH section renders.
 *
 * The `count` parameter dictates the total number of entries generated. The selected preset
 * governs the role configuration for its specific slots:
 * - `solo` and `swarm`: all entries are `agent`.
 * - `pair`: slot 1 is `agent`, slot 2 is `reviewer`.
 * - `workbench`: slot 1 is `agent`, slot 2 is `shell` with agentId "terminal".
 *
 * If `count` is increased beyond what a preset defines, additional slots default to `agent`.
 * If no preset is selected, all slots default to `agent`.
 */
export function willLaunch(input: { preset?: PresetId; agentId: string; count: number }): LaunchEntry[] {
  const entries: LaunchEntry[] = []

  for (let i = 1; i <= input.count; i++) {
    if (input.preset === "pair" && i === 2) {
      entries.push({
        index: i,
        agentId: input.agentId,
        role: "reviewer",
      })
    } else if (input.preset === "workbench" && i === 2) {
      entries.push({
        index: i,
        agentId: "terminal",
        role: "shell",
      })
    } else {
      entries.push({
        index: i,
        agentId: input.agentId,
        role: "agent",
      })
    }
  }

  return entries
}
