/**
 * Keyboard shortcut capture and conflict diagnostics for voice settings.
 *
 * Provides pure keyboard event translation, conflict resolution against ADE bindings,
 * platform detection, language proximity suggestion, and safe API key masking.
 */

import {
  describeChordRisk,
  describeCommandId,
  findVoiceShortcutConflicts,
  describeShortcut,
  VOICE_COMMAND_AGENT,
  VOICE_COMMAND_TRANSCRIPTION,
} from "../settings/shortcuts"
import type { VoiceSettings } from "../settings/model"
import {
  normalizeKeyName,
  parseChord,
  type Binding,
  type Platform,
} from "@nikcli-ai/ade/keyboard/keymap"
import { DEFAULT_BINDINGS } from "@nikcli-ai/ade/keyboard/bindings"
import type { LanguageOption } from "../settings/languages"
import { t } from "@nikcli-ai/ade/i18n"

export interface KeyInput {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type ShortcutCaptureResult =
  | { type: "cancel" }
  | { type: "modifier_only"; modifiers: string[] }
  | { type: "chord"; chord: string; display: string }
  | { type: "ignored" }

export interface ConflictCheckResult {
  /** True when the chord must not be stored. `message` says why, in Italian. */
  hasConflict: boolean
  conflictingCommand?: string
  message?: string
  /** Set when the chord is acceptable but worth a word to the user, in Italian. */
  warning?: string
}

/**
 * ADE's own bindings, read from ADE rather than copied.
 *
 * This list used to be retyped here. That made every new ADE binding a silent
 * hole in the collision check: the panel would happily record a chord ADE had
 * just claimed, and the user would find the shortcut dead with nothing said.
 */
export const DEFAULT_ADE_SHORTCUT_BINDINGS: readonly { chord: string; commandId: string }[] =
  DEFAULT_BINDINGS

export { describeCommandId } from "../settings/shortcuts"

/**
 * Detects the runtime OS platform without crashing in non-browser environments.
 */
export function getPlatform(): Platform {
  if (typeof navigator !== "undefined") {
    const nav = navigator as { platform?: string; userAgent?: string }
    const p = (nav.platform || nav.userAgent || "").toLowerCase()
    if (p.includes("mac")) return "mac"
  }
  return "other"
}

/**
 * Translates a minimal keyboard event into a normalized chord string.
 *
 * Guarantees:
 * - Escape cancels recording without altering existing value.
 * - Modifier-only key presses return modifier_only status.
 * - Valid combinations are normalized to portable chord syntax (e.g. "mod+shift+k").
 */
export function captureKeyboardEvent(
  event: KeyInput,
  platform: Platform
): ShortcutCaptureResult {
  if (event.key === "Escape" || event.key === "Esc") {
    return { type: "cancel" }
  }

  if (event.key === "Tab") {
    return { type: "ignored" }
  }

  const isModifier = ["Control", "Alt", "Shift", "Meta"].includes(event.key)
  if (isModifier) {
    const modifiers: string[] = []
    if (platform === "mac") {
      if (event.ctrlKey) modifiers.push("⌃")
      if (event.altKey) modifiers.push("⌥")
      if (event.shiftKey) modifiers.push("⇧")
      if (event.metaKey) modifiers.push("⌘")
    } else {
      if (event.ctrlKey) modifiers.push("Ctrl")
      if (event.altKey) modifiers.push("Alt")
      if (event.shiftKey) modifiers.push("Shift")
      if (event.metaKey) modifiers.push("Meta")
    }
    return { type: "modifier_only", modifiers }
  }

  /*
   * The recorded key is spelled the way the matcher will spell it.
   *
   * `normalizeKeyName` is the same function `parseChord` and `matchesChord`
   * run, so what is written here is what fires later — the space bar being the
   * case that used to break: it was stored as "space" and compared against the
   * literal " " the browser reports, which never agreed.
   */
  const canonical = normalizeKeyName(event.key)
  if (canonical.length === 0) {
    return { type: "ignored" }
  }
  // "+" separates the parts of a chord string, so it can only travel by name.
  const rawKey = canonical === "+" ? "plus" : canonical

  const parts: string[] = []
  if (platform === "mac") {
    if (event.metaKey) parts.push("mod")
    if (event.ctrlKey) parts.push("ctrl")
    if (event.altKey) parts.push("alt")
    if (event.shiftKey) parts.push("shift")
  } else {
    if (event.ctrlKey) parts.push("mod")
    if (event.altKey) parts.push("alt")
    if (event.shiftKey) parts.push("shift")
    if (event.metaKey) parts.push("meta")
  }
  parts.push(rawKey)

  const chord = parts.join("+")
  const display = describeShortcut(chord, platform)

  return {
    type: "chord",
    chord,
    display,
  }
}

/**
 * Checks whether a proposed chord can be bound, and what it would cost.
 *
 * Two separate questions are answered in one pass, in the order that matters:
 * a chord that would eat the user's typing is refused before anyone asks what
 * else it collides with, because the answer would not change the outcome.
 */
export function checkShortcutConflict(
  proposedChord: string,
  targetCommand: string,
  currentSettings: VoiceSettings,
  existingBindings: readonly Binding[] = [],
  platform: Platform = "other"
): ConflictCheckResult {
  const risk = describeChordRisk(proposedChord, platform)
  if (risk.level === "refuse") {
    return {
      hasConflict: true,
      message: risk.message ?? t("vui.shortcut.invalid"),
    }
  }

  const candidateSettings: VoiceSettings = {
    ...currentSettings,
    agentChord:
      targetCommand === VOICE_COMMAND_AGENT ? proposedChord : currentSettings.agentChord,
    transcriptionChord:
      targetCommand === VOICE_COMMAND_TRANSCRIPTION
        ? proposedChord
        : currentSettings.transcriptionChord,
  }

  const defaultBindings: Binding[] = DEFAULT_ADE_SHORTCUT_BINDINGS.map((b) => ({
    chord: parseChord(b.chord, platform),
    commandId: b.commandId,
  }))

  const allBindings = [...defaultBindings, ...existingBindings]
  const conflicts = findVoiceShortcutConflicts(candidateSettings, allBindings, platform)
  const targetConflict = conflicts.find((c) => c.commandIds.includes(targetCommand))

  if (targetConflict) {
    const conflictingCommand =
      targetConflict.commandIds.find((id) => id !== targetCommand) ??
      targetConflict.commandIds[0]

    return {
      hasConflict: true,
      conflictingCommand,
      message: t("vui.shortcut.conflict", describeCommandId(conflictingCommand)),
    }
  }

  return {
    hasConflict: false,
    ...(risk.level === "warn" && risk.message ? { warning: risk.message } : {}),
  }
}

/**
 * Suggests the closest available language when the requested language is unsupported.
 */
export function suggestClosestLanguage(
  currentCode: string,
  available: readonly LanguageOption[]
): LanguageOption | undefined {
  if (available.length === 0) return undefined

  const clean = currentCode.trim().toLowerCase()
  const base = clean.split("-")[0]

  const exact = available.find((l) => l.code.toLowerCase() === clean)
  if (exact) return exact

  const baseMatch = available.find((l) => l.code.toLowerCase() === base)
  if (baseMatch) return baseMatch

  const romance = ["it", "es", "fr", "pt", "ro"]
  if (romance.includes(base)) {
    const it = available.find((l) => l.code.toLowerCase() === "it")
    if (it) return it
    const otherRomance = available.find((l) => romance.includes(l.code.toLowerCase()))
    if (otherRomance) return otherRomance
  }

  const germanic = ["en", "de", "nl", "sv", "da", "no"]
  if (germanic.includes(base)) {
    const en = available.find((l) => l.code.toLowerCase() === "en")
    if (en) return en
    const otherGermanic = available.find((l) => germanic.includes(l.code.toLowerCase()))
    if (otherGermanic) return otherGermanic
  }

  const slavic = ["ru", "pl", "uk", "cs"]
  if (slavic.includes(base)) {
    const slavicMatch = available.find((l) => slavic.includes(l.code.toLowerCase()))
    if (slavicMatch) return slavicMatch
  }

  const itFallback = available.find((l) => l.code.toLowerCase() === "it")
  if (itFallback) return itFallback

  const enFallback = available.find((l) => l.code.toLowerCase() === "en")
  if (enFallback) return enFallback

  return available[0]
}

/**
 * Returns a masked representation showing only the presence and last 4 characters of an API key.
 * Never outputs the full key in clear text.
 */
export function formatMaskedApiKey(key: string | undefined): string {
  if (!key || key.trim().length === 0) {
    return ""
  }
  const clean = key.trim()
  if (clean.length <= 4) {
    return "••••"
  }
  return `•••• •••• •••• ${clean.slice(-4)}`
}
