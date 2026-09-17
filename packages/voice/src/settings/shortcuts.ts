/**
 * Keyboard shortcuts integration with ADE keymap subsystem.
 *
 * Exposes chord binding factories, conflict diagnostics via findConflicts,
 * and platform-aware formatting using ADE's keymap parser.
 */

import {
  findConflicts,
  formatChord,
  parseChord,
  type Binding,
  type Chord,
  type Conflict,
  type Platform,
} from "@nikcli-ai/ade/keyboard/keymap"
import type { VoiceSettings } from "./model"
import { t } from "@nikcli-ai/ade/i18n"

export const VOICE_COMMAND_AGENT = "voice.mode.agent"
export const VOICE_COMMAND_TRANSCRIPTION = "voice.mode.transcription"

/**
 * Builds ADE keymap bindings for configured voice mode shortcut chords.
 */
export function buildVoiceBindings(settings: VoiceSettings, platform: Platform = "other"): Binding[] {
  return [
    {
      chord: parseChord(settings.agentChord, platform),
      commandId: VOICE_COMMAND_AGENT,
    },
    {
      chord: parseChord(settings.transcriptionChord, platform),
      commandId: VOICE_COMMAND_TRANSCRIPTION,
    },
  ]
}

/**
 * Detects any collision between configured voice shortcuts and existing ADE bindings.
 */
export function findVoiceShortcutConflicts(
  settings: VoiceSettings,
  existingBindings: readonly Binding[] = [],
  platform: Platform = "other",
): Conflict[] {
  const voiceBindings = buildVoiceBindings(settings, platform)
  return findConflicts([...existingBindings, ...voiceBindings])
}

/**
 * Italian names for the ADE commands a voice chord can land on.
 *
 * A collision reported as "pane.expand" tells the user nothing they can act
 * on. Every id ADE ships is spelled out; anything else falls back to the raw
 * id, which is still better than silence.
 */
const ADE_COMMAND_LABELS: Record<string, () => string> = {
  "palette.open": () => t("vui.command.palette"),
  "session.new": () => t("vui.command.sessionNew"),
  "pane.close": () => t("vui.command.paneClose"),
  "pane.expand": () => t("vui.command.paneExpand"),
  "pane.rename": () => t("vui.command.paneRename"),
  "view.toggle": () => t("vui.command.viewToggle"),
  "theme.toggle": () => t("vui.command.themeToggle"),
}

/**
 * Names a command in a way a user can recognise.
 */
export function describeCommandId(commandId: string): string {
  if (commandId === VOICE_COMMAND_AGENT) return t("vui.command.agent")
  if (commandId === VOICE_COMMAND_TRANSCRIPTION) return t("vui.command.transcription")
  const label = ADE_COMMAND_LABELS[commandId]?.()
  return label ? `${commandId} (${label})` : commandId
}

/**
 * One Italian sentence naming every voice chord that will not fire, or undefined.
 *
 * The recorder refuses a colliding chord, but the recorder is not the only way
 * one arrives: a profile hand-edited or copied from another machine can carry
 * it, and so can an ADE release that binds a chord a user had already taken.
 * In both cases the runtime resolves the key to ADE and the microphone simply
 * never opens — the exact failure this is here to stop being silent.
 */
export function summarizeVoiceShortcutConflicts(
  settings: VoiceSettings,
  existingBindings: readonly Binding[] = [],
  platform: Platform = "other",
): string | undefined {
  const voiceCommands = [VOICE_COMMAND_AGENT, VOICE_COMMAND_TRANSCRIPTION]
  const shadowed = findVoiceShortcutConflicts(settings, existingBindings, platform)
    .map((conflict) => {
      const mine = conflict.commandIds.filter((id) => voiceCommands.includes(id))
      if (mine.length === 0) return undefined
      const others = conflict.commandIds.filter((id) => !voiceCommands.includes(id))
      // Two voice modes on one chord shadow each other; neither can win.
      const winner = others.length > 0 ? others.map(describeCommandId).join(", ") : undefined
      const label = mine.map(describeCommandId).join(" e ")
      return winner
        ? t("vui.clash.taken", label, describeShortcut(conflict.chord, platform), winner)
        : t("vui.clash.both", label, describeShortcut(conflict.chord, platform))
    })
    .filter((line): line is string => line !== undefined)

  if (shadowed.length === 0) return undefined
  return t("vui.clash.inactive", shadowed.join(" "))
}

/**
 * Formats a shortcut chord string or Chord object for clean display in UI menus.
 */
export function describeShortcut(chord: string | Chord, platform: Platform = "other"): string {
  const chordObj = typeof chord === "string" ? parseChord(chord, platform) : chord
  return formatChord(chordObj, platform)
}

// ---------------------------------------------------------------------------
// Chord safety
// ---------------------------------------------------------------------------

export type ChordRiskLevel = "ok" | "warn" | "refuse"

export interface ChordRisk {
  /** "refuse" must not be stored; "warn" is stored but explained. */
  readonly level: ChordRiskLevel
  /** Italian explanation for the user. Absent only when the level is "ok". */
  readonly message?: string
}

/**
 * Keys that are the act of writing or of moving the caret while writing.
 *
 * Bound without Ctrl/Alt/Cmd, each one stops doing its job everywhere in ADE,
 * because the workbench calls preventDefault on any chord it resolves.
 */
const TYPING_KEYS: ReadonlySet<string> = new Set([
  "space",
  "enter",
  "tab",
  "backspace",
  "delete",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
])

/**
 * `event.key` values that name a state of the keyboard rather than a key.
 *
 * A dead key is the first half of an accented character and an IME reports
 * "Process" for every keystroke it is composing — neither is a thing a user
 * can press again on purpose, so neither can be a shortcut.
 */
const NON_KEYS: ReadonlySet<string> = new Set(["", "dead", "unidentified", "process", "compose", "alphanumeric"])

/**
 * Judges whether a chord can be handed to the runtime key matcher at all.
 *
 * The rule that matters is the first one: Ctrl, Alt and Cmd lift a keystroke
 * out of ordinary typing, and Shift does not — Shift+K is simply how a capital
 * K is written. A voice shortcut of "K", or of "Shift+K", would take the
 * letter away from every field in the workbench, and the user who set it would
 * have no keyboard left to unset it with.
 */
export function describeChordRisk(chord: string | Chord, platform: Platform = "other"): ChordRisk {
  let parsed: Chord
  try {
    parsed = typeof chord === "string" ? parseChord(chord, platform) : chord
  } catch {
    return { level: "refuse", message: t("vui.shortcut.invalid") }
  }

  if (NON_KEYS.has(parsed.key)) {
    return {
      level: "refuse",
      message: t("vui.risk.noMainKey"),
    }
  }

  const lifted = parsed.ctrl || parsed.meta || parsed.alt
  if (!lifted) {
    const shown = formatChord(parsed, platform)
    if (parsed.key.length === 1) {
      return {
        level: "refuse",
        message: t("vui.risk.typing", shown),
      }
    }
    if (TYPING_KEYS.has(parsed.key)) {
      return {
        level: "refuse",
        message: t("vui.risk.typingMove", shown),
      }
    }
  }

  /*
   * The two combinations the operating system may take before ADE ever sees
   * them. Both are allowed — some machines pass them through — but the user is
   * told, because a shortcut that works on the developer's laptop and nowhere
   * else is worse than one that is refused outright.
   */
  if (platform !== "mac" && parsed.meta) {
    return {
      level: "warn",
      message: t("vui.risk.winKey"),
    }
  }
  if (platform !== "mac" && parsed.alt && !parsed.ctrl && !parsed.meta && parsed.key.length === 1) {
    return {
      level: "warn",
      message: t("vui.risk.altLetter"),
    }
  }

  return { level: "ok" }
}

/**
 * True when the chord is safe enough to store and to match against.
 */
export function isChordUsable(chord: string | Chord, platform: Platform = "other"): boolean {
  return describeChordRisk(chord, platform).level !== "refuse"
}
