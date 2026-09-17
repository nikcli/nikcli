/**
 * What the always-on indicator says, and what pressing it does.
 *
 * An open microphone nobody pressed has to be visible for as long as it is
 * open: that is the condition for opening it by itself. The indicator is also
 * the switch — the orb beside it calls the assistant instead of closing it.
 */

import { wakeWordEnabled, type VoiceMode, type VoiceSettings } from "../settings/model"
import { t } from "@nikcli-ai/ade/i18n"

export type ListeningState =
  | { kind: "hidden" }
  | { kind: "listening"; text: string; title: string }
  | { kind: "follow-up"; text: string; title: string }
  | { kind: "paused"; text: string; title: string }

export function listeningState(input: {
  settings: Pick<VoiceSettings, "alwaysListen" | "activation" | "wakeWord">
  running: boolean
  mode: VoiceMode
  paused: boolean
  /** An answer has just been said and the next sentence needs no name. */
  followUp?: boolean
}): ListeningState {
  const { settings } = input
  if (!wakeWordEnabled() || !settings.alwaysListen || settings.activation !== "wake-word") return { kind: "hidden" }
  if (input.running && input.mode === "agent" && input.followUp) {
    return {
      kind: "follow-up",
      text: t("vui.followUp.text"),
      title: t("vui.followUp.title", settings.wakeWord),
    }
  }
  if (input.running && input.mode === "agent") {
    return {
      kind: "listening",
      text: t("vui.listening.text", settings.wakeWord),
      title: t("vui.listening.title", settings.wakeWord),
    }
  }
  if (input.paused) {
    return {
      kind: "paused",
      text: t("vui.paused.text"),
      title: t("vui.paused.title"),
    }
  }
  return { kind: "hidden" }
}
