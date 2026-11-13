/**
 * The orb's tooltip (DS-polish, closure 7): what it is and the chord that does
 * the same, «Microfono · Ctrl+Shift+K». The chord is the one of the mode the
 * orb opens, the default one. What the microphone is doing now stays in the
 * accessible name, which changes with it.
 */
import type { Platform } from "@nikcli-ai/ade/keyboard/keymap"
import { t } from "@nikcli-ai/ade/i18n"
import type { VoiceSettings } from "../settings/model"
import { describeShortcut } from "../settings/shortcuts"

export function orbTitle(
  settings: Pick<VoiceSettings, "mode" | "agentChord" | "transcriptionChord" | "dictationPress">,
  platform: Platform,
): string {
  const chord = settings.mode === "transcription" ? settings.transcriptionChord : settings.agentChord
  return `${t("vui.orb.title", describeShortcut(chord, platform))}\n${dictationHint(settings, platform)}`
}

/**
 * How the dictation chord opens the microphone, in one line.
 *
 * Held to speak, a tap opened and closed it before anyone could see it, and
 * nothing anywhere said the chord had to be held: the user pressed it the
 * way one presses a switch and concluded it did not work.
 */
export function dictationHint(
  settings: Pick<VoiceSettings, "transcriptionChord" | "dictationPress">,
  platform: Platform,
): string {
  const chord = describeShortcut(settings.transcriptionChord, platform)
  return t(settings.dictationPress === "toggle" ? "vui.dictation.hint.toggle" : "vui.dictation.hint.hold", chord)
}
