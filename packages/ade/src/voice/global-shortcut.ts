/**
 * The voice chords as the operating system sees them.
 *
 * On the desktop the two voice chords are registered as global hotkeys, so
 * the microphone opens while another window has the keyboard. That has a
 * cost inside ADE's own window too: a registered hotkey is taken by the OS
 * before the webview ever gets a `keydown`, so for those two chords the
 * `window` listener in the workbench never fires and the only word ADE hears
 * is the plugin's event. Whatever that event does is therefore the whole
 * feature for anyone who set a chord of their own.
 *
 * It used to look for the letter "j" or "k" in the event's text. "Ctrl+Space"
 * contains neither, so a user who chose it pressed a key that the OS
 * swallowed and ADE dropped — nothing at all happened. This module names the
 * chord on both sides of the boundary so the comparison is on chords, not on
 * letters.
 *
 * Plain `.ts`: everything here is string work against the `global-hotkey`
 * crate's grammar, and that grammar is the thing worth asserting.
 */

import { normalizeKeyName, parseChord, type Chord, type Platform } from "../keyboard/keymap"
import { isSystemChord, isWindowsRuntime, type VoiceMode, type VoiceSettings } from "@nikcli-ai/voice/core"
import { t } from "../i18n"

/** The event the native side emits for every registered voice hotkey. */
export const GLOBAL_VOICE_EVENT = "nikcli-global-voice"

/**
 * Runs the registrations one at a time, newest last.
 *
 * Registering is drop-everything then claim, over the system, so a save that
 * starts while the previous one is still claiming unregisters what that one
 * has just claimed: the chords the user is left with are whichever call
 * happened to finish last, not the ones they saved. Each call waits for the
 * one before it, and its own promise settles when its own registration has.
 *
 * A call still waiting when a newer one arrives does not run at all: with a
 * chord changed twice in a second the middle one is not worth claiming, and
 * reporting it as busy would name a chord the user no longer wants. Its
 * promise settles as soon as it is known to be superseded, so a caller waiting
 * on it is not left hanging.
 */
export function serialiseRegistrations<Settings>(
  register: (settings: Settings) => Promise<unknown>,
): (settings: Settings) => Promise<void> {
  let running = false
  let queued: { settings: Settings; done: () => void } | undefined

  const run = async (waiter: { settings: Settings; done: () => void }): Promise<void> => {
    try {
      await register(waiter.settings)
    } catch {
      // A chord the system refuses is reported by the registration itself, and
      // the next save must still be applied.
    }
    waiter.done()
  }

  const pump = async (): Promise<void> => {
    running = true
    while (queued) {
      const next = queued
      queued = undefined
      await run(next)
    }
    running = false
  }

  return (settings: Settings): Promise<void> =>
    new Promise<void>((resolve) => {
      // Whoever is still queued is superseded by this call.
      queued?.done()
      queued = { settings, done: resolve }
      if (!running) void pump()
    })
}

export interface GlobalVoicePayload {
  /** The hotkey as `global-hotkey` prints it: `shift+control+Space`. */
  chord: string
  state: "pressed" | "released"
}

/**
 * An ADE chord string in the grammar `global-hotkey` parses.
 *
 * `mod` becomes `CommandOrControl`, which the crate resolves per platform the
 * same way `parseChord` does. An explicit `ctrl` or `cmd` stays what it is:
 * the old conversion folded both into `CommandOrControl`, so a chord written
 * as `ctrl+k` registered as Command+K on a Mac and matched nothing the user
 * had asked for.
 */
export function toTauriChord(chord: string): string {
  return chord
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
    .map((part) => {
      switch (part) {
        case "mod":
          return "CommandOrControl"
        case "ctrl":
        case "control":
          return "Control"
        case "cmd":
        case "command":
        case "meta":
          return "Super"
        case "alt":
        case "option":
        case "opt":
          return "Alt"
        case "shift":
          return "Shift"
        default:
          // The crate matches key names case-insensitively, and knows both the
          // `KeyboardEvent.code` spelling and the short one ("ArrowUp"/"Up").
          return part.toUpperCase()
      }
    })
    .join("+")
}

/**
 * The chord a `global-hotkey` string names, in ADE's own terms.
 *
 * The crate prints modifiers as `shift`, `control`, `alt`, `super` and the
 * key as its `KeyboardEvent.code` name (`KeyK`, `Space`, `Digit1`), which
 * `normalizeKeyName` already reduces to the spelling chords are compared on.
 */
export function parseGlobalChord(raw: string): Chord {
  const chord: Chord = { key: "", ctrl: false, meta: false, shift: false, alt: false }
  for (const token of raw.split("+")) {
    const part = token.trim().toLowerCase()
    if (part.length === 0) continue
    switch (part) {
      case "shift":
        chord.shift = true
        break
      case "control":
      case "ctrl":
        chord.ctrl = true
        break
      case "alt":
      case "option":
        chord.alt = true
        break
      case "super":
      case "command":
      case "cmd":
      case "meta":
        chord.meta = true
        break
      default:
        chord.key = normalizeKeyName(part)
    }
  }
  return chord
}

function sameChord(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.meta === b.meta && a.shift === b.shift && a.alt === b.alt
}

/**
 * Which voice feature the hotkey the OS reported belongs to, if either.
 *
 * Compared as chords, on the platform ADE is running on: `mod+shift+k` is
 * Control+Shift+K here and Command+Shift+K on a Mac, and the crate reports
 * whichever one it actually registered.
 */
export function modeForGlobalChord(
  raw: string,
  settings: Pick<VoiceSettings, "agentChord" | "transcriptionChord">,
  platform: Platform,
): VoiceMode | undefined {
  const pressed = parseGlobalChord(raw)
  if (pressed.key.length === 0) return undefined
  if (sameChord(pressed, parseChord(settings.agentChord, platform))) return "agent"
  if (sameChord(pressed, parseChord(settings.transcriptionChord, platform))) return "transcription"
  return undefined
}

/**
 * What the window should do about one event from a system-wide voice hotkey.
 *
 * A separate function because the answer has to be testable without a webview:
 * this event is the *whole* keyboard for a registered chord, and if the chord
 * the native side names is not recognised, the safe answer is to say so. It is
 * never to fall back on a mode — falling back would open the microphone in
 * whichever mode happens to be stored, and the user who pressed the
 * assistant's chord would get dictation with no idea why.
 */
export type GlobalVoiceAction =
  | { kind: "press"; mode: VoiceMode }
  | { kind: "release" }
  | { kind: "unknown"; chord: string }
  | { kind: "ignore" }

export function globalVoiceAction(
  rawPayload: unknown,
  settings: Pick<VoiceSettings, "agentChord" | "transcriptionChord">,
  platform: Platform,
): GlobalVoiceAction {
  const payload = readGlobalVoicePayload(rawPayload)
  if (!payload) return { kind: "ignore" }
  const mode = modeForGlobalChord(payload.chord, settings, platform)
  if (!mode) return { kind: "unknown", chord: payload.chord }
  return payload.state === "released" ? { kind: "release" } : { kind: "press", mode }
}

/** What to say when the system reports a chord ADE cannot place. */
export function unknownChordMessage(chord: string): string {
  return t("voice.shortcut.unknown", chord)
}

/**
 * What to say about a chord the system would not give ADE.
 *
 * Two different refusals: a key the system-wide table cannot name (see
 * `isSystemChord`), which no other application has anything to do with, and a
 * chord someone else already holds.
 */
export function busyMessage(mode: VoiceMode, chord: string, windows: boolean = isWindowsRuntime()): string {
  const feature = t(mode === "agent" ? "voice.shortcut.feature.agent" : "voice.shortcut.feature.transcription")
  return isSystemChord(chord, windows) ? t("voice.shortcut.busy", chord, feature) : t("voice.shortcut.notSystem", chord, feature)
}

/**
 * The refusals the voice settings show beside each chord, until a save claims it.
 *
 * The notice strip says it once, at startup, and goes; someone who comes back
 * later to find out why the chord does nothing looks in the voice settings,
 * and a refused chord there looked exactly like one that works.
 */
export function refusalsOf(
  failed: readonly { mode: VoiceMode; chord: string }[],
  windows: boolean = isWindowsRuntime(),
): Partial<Record<VoiceMode, string>> {
  const refusals: Partial<Record<VoiceMode, string>> = {}
  for (const { mode, chord } of failed) refusals[mode] = busyMessage(mode, chord, windows)
  return refusals
}

export interface RegisterVoiceShortcutsDeps {
  /** Drops every hotkey ADE holds, so a changed chord stops answering. */
  unregisterAll: () => Promise<void>
  /** Claims one chord, in the grammar `toTauriChord` produces. */
  register: (chord: string) => Promise<void>
  /** Says what could not be claimed, in the interface rather than the console. */
  report?: (message: string) => void
  /** Whether the Windows key table limits the chords (see `isSystemChord`); the running system when left out. */
  windows?: boolean
}

/**
 * Claims both voice chords system-wide, each on its own.
 *
 * One `try` around both used to mean the first refusal — a chord another
 * application already holds, which is common for Ctrl+Space — skipped the
 * registration of the other one, so a single busy chord silently turned off
 * both shortcuts. The failure was a `console.warn` nobody sees, and from the
 * outside the feature simply did not work.
 */
export async function registerVoiceShortcuts(
  settings: Pick<VoiceSettings, "agentChord" | "transcriptionChord">,
  deps: RegisterVoiceShortcutsDeps,
): Promise<{ registered: VoiceMode[]; failed: { mode: VoiceMode; chord: string; problem: string }[] }> {
  try {
    await deps.unregisterAll()
  } catch {
    // Nothing held, or the plugin is gone: the registrations below say so themselves.
  }

  const windows = deps.windows ?? isWindowsRuntime()
  const registered: VoiceMode[] = []
  const failed: { mode: VoiceMode; chord: string; problem: string }[] = []
  const wanted: { mode: VoiceMode; chord: string }[] = [
    { mode: "transcription", chord: settings.transcriptionChord },
    { mode: "agent", chord: settings.agentChord },
  ]

  for (const { mode, chord } of wanted) {
    /* Not claimed at all, on Windows: on a layout other than the American one
       the system would give ADE a different key, taken from whatever else
       uses it. It still works in ADE's window, where the keydown listener
       sees it. Elsewhere the key is registered as it was recorded. */
    if (!isSystemChord(chord, windows)) {
      failed.push({ mode, chord, problem: "not a system-wide key" })
      deps.report?.(busyMessage(mode, chord, windows))
      continue
    }
    try {
      await deps.register(toTauriChord(chord))
      registered.push(mode)
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err)
      failed.push({ mode, chord, problem })
      deps.report?.(busyMessage(mode, chord, windows))
    }
  }

  return { registered, failed }
}

/**
 * The event payload, whichever shape the native side sent.
 *
 * A build of the native shell older than this module sends the bare chord
 * string and only on press; that is still understood, so a stale binary does
 * not turn the shortcut off again.
 */
export function readGlobalVoicePayload(payload: unknown): GlobalVoicePayload | undefined {
  if (typeof payload === "string") {
    return payload.length > 0 ? { chord: payload, state: "pressed" } : undefined
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>
    if (typeof record.chord !== "string" || record.chord.length === 0) return undefined
    const state = record.state === "released" ? "released" : "pressed"
    return { chord: record.chord, state }
  }
  return undefined
}
