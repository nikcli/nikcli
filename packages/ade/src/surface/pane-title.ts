import { t } from "../i18n"
import type { LaunchEntry } from "../session-new/launch"

/**
 * What a new pane is called when its task does not name it, as
 * "Sessione 3 — Claude Code" or "Session 3 — Claude Code".
 *
 * In the interface language of the moment the pane is created: the title is
 * then stored with the pane, so a session opened in Italian keeps its name
 * when the language changes, and a rename is never undone.
 */
export function defaultPaneTitle(role: LaunchEntry["role"], index: number, agent: string): string {
  const label = role === "reviewer" ? t("paneTitle.reviewer") : role === "shell" ? t("paneTitle.shell") : t("paneTitle.agent")
  return `${label} ${index} — ${agent}`
}
