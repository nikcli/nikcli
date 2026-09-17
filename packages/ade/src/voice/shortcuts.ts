/**
 * Voice shortcut resolution and conflict handling for ADE workbench.
 *
 * Enforces key safety invariants:
 * - ADE fixed bindings always take precedence over voice chords.
 * - When a voice chord collides with ADE bindings, ADE wins and voice does not activate.
 * - Auto-repeated key events (event.repeat) never restart push-to-talk listening.
 * - Window blur releases push-to-talk immediately to avoid leaving mic open.
 */

import {
  findVoiceShortcutConflicts,
  VOICE_COMMAND_AGENT,
  VOICE_COMMAND_TRANSCRIPTION,
  type VoiceMode,
  type VoiceSettings,
} from "@nikcli-ai/voice/core"
import {
  matchesChord,
  normalizeKeyName,
  parseChord,
  resolveBinding,
  type Binding,
  type Chord,
  type Conflict,
  type KeyInput,
  type Platform,
} from "../keyboard/keymap"

export interface VoiceShortcutResolution {
  type: "ade" | "voice-agent" | "voice-transcription" | "none"
  commandId?: string
  conflict?: Conflict
}

/**
 * Resolves a keyboard event against ADE bindings and configured voice chords.
 *
 * Rules:
 * 1. ADE bindings are tested first; if matched, ADE wins.
 * 2. If the chord collides with an ADE binding, voice is blocked and conflict is returned.
 * 3. Otherwise, matches against configured agentChord and transcriptionChord.
 */
/**
 * The last conflict scan, and what it was a scan of.
 *
 * This function runs on every keystroke anywhere in the application, and the
 * conflict scan inside it walks every ADE binding parsing a chord for each —
 * work that depends only on the settings and the binding table, neither of
 * which changes while someone is typing a sentence. Compared by reference,
 * because both are replaced rather than mutated when they do change, so a
 * stale answer is not reachable.
 */
let lastScan:
  | {
      settings: VoiceSettings
      bindings: readonly Binding[]
      platform: Platform
      conflicts: readonly Conflict[]
    }
  | undefined

function conflictsFor(
  voiceSettings: VoiceSettings,
  adeBindings: readonly Binding[],
  platform: Platform,
): readonly Conflict[] {
  if (
    lastScan &&
    lastScan.settings === voiceSettings &&
    lastScan.bindings === adeBindings &&
    lastScan.platform === platform
  ) {
    return lastScan.conflicts
  }
  const conflicts = findVoiceShortcutConflicts(voiceSettings, adeBindings, platform)
  lastScan = { settings: voiceSettings, bindings: adeBindings, platform, conflicts }
  return conflicts
}

export function resolveVoiceOrAdeKey(
  adeBindings: readonly Binding[],
  voiceSettings: VoiceSettings,
  event: KeyInput,
  platform: Platform,
): VoiceShortcutResolution {
  // 1. Resolve against fixed ADE bindings first
  const adeCommandId = resolveBinding(adeBindings as Binding[], event, platform)

  // Check for conflicts between configured voice shortcuts and ADE bindings
  const conflicts = conflictsFor(voiceSettings, adeBindings, platform)

  if (adeCommandId) {
    const matchedConflict = conflicts.find((c) => matchesChord(c.chord, event))
    return {
      type: "ade",
      commandId: adeCommandId,
      conflict: matchedConflict,
    }
  }

  // 2. If this chord matches any conflict involving voice shortcuts, voice must not activate
  const activeConflict = conflicts.find((c) => matchesChord(c.chord, event))
  if (activeConflict) {
    return {
      type: "none",
      conflict: activeConflict,
    }
  }

  // 3. Match against agent chord
  const agentChordObj = parseChord(voiceSettings.agentChord, platform)
  if (matchesChord(agentChordObj, event)) {
    return {
      type: "voice-agent",
      commandId: VOICE_COMMAND_AGENT,
    }
  }

  // 4. Match against transcription chord
  const transcriptionChordObj = parseChord(voiceSettings.transcriptionChord, platform)
  if (matchesChord(transcriptionChordObj, event)) {
    return {
      type: "voice-transcription",
      commandId: VOICE_COMMAND_TRANSCRIPTION,
    }
  }

  return { type: "none" }
}

export interface PushToTalkTarget {
  /** The mode is the chord's own: the two chords are two features. */
  pressToTalk(mode?: VoiceMode): Promise<void>
  releaseToTalk(): Promise<void>
}

/**
 * Longest a push-to-talk press is believed before the microphone is released anyway.
 *
 * `keyup` is not guaranteed to arrive: a native modal, a system permission
 * prompt, or focus moving into an iframe can swallow it, and `blur` does not
 * always follow. Every one of those leaves the microphone recording with
 * nobody watching, which is the worst failure this feature can have. Two
 * minutes is far longer than anyone holds a key to speak, so the watchdog never
 * cuts a real press short — it only ends one that has already gone wrong.
 */
export const PUSH_TO_TALK_MAX_HOLD_MS = 120_000

export interface PushToTalkOptions {
  /** Schedules the watchdog. Injected so tests can run it without waiting. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  maxHoldMs?: number
}

/**
 * Manages push-to-talk lifecycle ensuring event.repeat is ignored
 * and window blur, key release, or the watchdog safely releases the microphone.
 */
export function createPushToTalkHandler(engine: PushToTalkTarget, options: PushToTalkOptions = {}) {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const maxHoldMs = options.maxHoldMs ?? PUSH_TO_TALK_MAX_HOLD_MS

  let isPressed = false
  let activeChord: Chord | undefined = undefined
  let watchdog: unknown = undefined

  const stopWatchdog = () => {
    if (watchdog !== undefined) {
      clearTimer(watchdog)
      watchdog = undefined
    }
  }

  /**
   * The release that is still settling, if one is.
   *
   * `isPressed` goes false before the engine has finished letting go, so a
   * chord pressed again inside that window used to start a new press against
   * a half-released one — the two then raced, and which of them the microphone
   * ended up believing depended on timing. The next press waits instead.
   */
  let releasing: Promise<void> | undefined

  /** Ends the press exactly once, whatever ended it. */
  const release = async (): Promise<boolean> => {
    if (!isPressed) {
      return false
    }
    isPressed = false
    activeChord = undefined
    stopWatchdog()
    releasing = engine.releaseToTalk()
    try {
      await releasing
    } finally {
      releasing = undefined
    }
    return true
  }

  const onKeyDown = async (
    chord: Chord,
    event: { repeat?: boolean },
    /* Which feature the chord that was pressed belongs to. Passed through
       rather than read from settings: the stored mode is only the default,
       and the chord already says which of the two was asked for. */
    mode?: VoiceMode,
  ): Promise<boolean> => {
    // OS auto-repeat must not restart listening
    if (event.repeat) {
      return false
    }
    if (isPressed) {
      return false
    }
    // A release still settling owns the microphone until it has finished.
    if (releasing) {
      await releasing
    }
    isPressed = true
    activeChord = chord
    watchdog = setTimer(() => {
      void release()
    }, maxHoldMs)
    await engine.pressToTalk(mode)
    return true
  }

  /**
   * Whether letting go of this key ends the press.
   *
   * The chord's own key does, and so does any modifier the chord requires:
   * lifting Shift out of "mod+shift+k" means the chord is no longer held, and
   * a microphone that stayed open would be one nothing on the keyboard could
   * close. Nothing else does — and that is the fix. `onKeyUp` used to release
   * on *any* key release, so a stray keystroke anywhere in the application,
   * or the release of a key pressed before the chord, dropped the microphone
   * in the middle of a sentence.
   *
   * No key at all still releases: that is the blur and watchdog path, where
   * there is no key to compare and the only safe answer is to let go.
   */
  const endsPress = (key: string | undefined, chord: Chord | undefined): boolean => {
    if (key === undefined) return true
    if (!chord) return true
    const norm = normalizeKeyName(key)
    if (norm === chord.key) return true
    if ((norm === "shift" || norm.startsWith("shift")) && chord.shift) return true
    if ((norm === "control" || norm === "ctrl" || norm.startsWith("control")) && chord.ctrl) return true
    if ((norm === "meta" || norm === "cmd" || norm === "os" || norm.startsWith("meta")) && chord.meta) return true
    if (
      (norm === "alt" || norm === "opt" || norm === "option" || norm === "altgraph" || norm.startsWith("alt")) &&
      chord.alt
    )
      return true
    return false
  }

  const shouldReleaseKey = (key?: string, code?: string): boolean => {
    if (!isPressed) return false
    const keyMatches = key !== undefined && endsPress(key, activeChord)
    const codeMatches = code !== undefined && endsPress(code, activeChord)
    return (key === undefined && code === undefined) || keyMatches || codeMatches
  }

  const onKeyUp = async (key?: string, code?: string): Promise<boolean> => {
    if (!shouldReleaseKey(key, code)) return false
    return release()
  }

  const onBlur = async (): Promise<boolean> => release()

  return {
    isPressed: () => isPressed,
    activeChord: () => activeChord,
    shouldReleaseKey,
    onKeyDown,
    onKeyUp,
    onBlur,
  }
}
