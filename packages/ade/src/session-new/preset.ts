/**
 * Session configuration presets, bounds, and labeling for the "New Session" screen.
 *
 * Presets provide quick-start topologies (solo, pair, workbench, swarm) that preconfigure
 * a default session count and role distribution. Users can subsequently tweak the session
 * count manually; when the count deviates from the selected preset, the configuration
 * transitions to "Personalizzata" (custom).
 */

import { t } from "../i18n"

export type PresetId = "solo" | "pair" | "workbench" | "swarm"

export interface Preset {
  id: PresetId
  label: string
  sessions: number
  description: string
}

/**
 * Available session presets in display order.
 * Labels and descriptions are getters, read in the current language (S41).
 */
export const PRESETS: Preset[] = [
  {
    id: "solo",
    get label() { return t("preset.solo") },
    sessions: 1,
    get description() { return t("preset.solo.desc") },
  },
  {
    id: "pair",
    get label() { return t("preset.pair") },
    sessions: 2,
    get description() { return t("preset.pair.desc") },
  },
  {
    id: "workbench",
    get label() { return t("preset.workbench") },
    sessions: 2,
    get description() { return t("preset.workbench.desc") },
  },
  {
    id: "swarm",
    get label() { return t("preset.swarm") },
    sessions: 4,
    get description() { return t("preset.swarm.desc") },
  },
]

export const MIN_SESSIONS = 1
export const MAX_SESSIONS = 6

/**
 * Ambiguity rule for `presetForCount`:
 *
 * Both `pair` and `workbench` define exactly 2 sessions, but they configure completely
 * different roles (pair creates a reviewer agent slot, while workbench creates an interactive
 * shell slot with agentId "terminal").
 *
 * When only a session count is provided without an explicit preset choice, a count of 2 is
 * inherently ambiguous. Arbitrarily defaulting to either `pair` or `workbench` would silently
 * impose unexpected role semantics on the user. Therefore, `presetForCount` returns a preset
 * if and only if the count uniquely and unambiguously identifies exactly one preset.
 * For ambiguous counts (e.g. 2) or counts matching no preset (e.g. 3, 5, 6), it returns `undefined`.
 */
export function presetForCount(count: number): Preset | undefined {
  const matching = PRESETS.filter((p) => p.sessions === count)
  return matching.length === 1 ? matching[0] : undefined
}

/**
 * What the footer calls the current configuration.
 *
 * Returns the Italian label of the selected preset if the current session count matches
 * that preset's defined count. If no preset is selected or if the user modified the count
 * away from the preset's definition, returns "Personalizzata" (Custom).
 */
export function configurationLabel(input: { preset?: PresetId; count: number }): string {
  if (input.preset) {
    const preset = PRESETS.find((p) => p.id === input.preset)
    if (preset && preset.sessions === input.count) {
      return preset.label
    }
  }
  return "Personalizzata"
}

/**
 * Clamps a requested count into [MIN_SESSIONS, MAX_SESSIONS].
 */
export function clampSessions(count: number): number {
  if (Number.isNaN(count)) {
    return MIN_SESSIONS
  }
  return Math.min(MAX_SESSIONS, Math.max(MIN_SESSIONS, Math.floor(count)))
}
