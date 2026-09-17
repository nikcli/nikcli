/**
 * Pure audio signal processing and speech/silence detection.
 *
 * Designed to run in any JavaScript runtime (Node.js, Bun, Browser) without DOM
 * or Web Audio dependencies. All time inputs are explicitly injected.
 */

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Default RMS threshold above which an audio frame is classified as voice/activity
 * rather than background room noise.
 */
export const DEFAULT_SPEECH_THRESHOLD = 0.025

/**
 * Duration of continuous silence (in milliseconds) after voice activity before
 * the utterance is considered concluded.
 */
export const DEFAULT_SILENCE_TIMEOUT_MS = 800

/**
 * Minimum duration of continuous audio activity (in milliseconds) required to
 * confirm intentional speech, filtering out short clicks or keyboard taps.
 */
export const DEFAULT_MIN_SPEECH_DURATION_MS = 120

// ---------------------------------------------------------------------------
// RMS Calculation
// ---------------------------------------------------------------------------

/**
 * Calculates the Root Mean Square (RMS) amplitude of a Float32Array PCM buffer.
 *
 * Returns 0.0 for empty buffers. Result is typically in the range [0.0, 1.0].
 */
export function calculateRms(samples: ArrayLike<number>): number {
  const len = samples.length
  if (len === 0) return 0.0

  let sumSquares = 0.0
  for (let i = 0; i < len; i++) {
    const val = samples[i]
    sumSquares += val * val
  }

  return Math.sqrt(sumSquares / len)
}

// ---------------------------------------------------------------------------
// Speech / Silence State Machine
// ---------------------------------------------------------------------------

export type SpeechState = "silent" | "speaking" | "speech_ended"

export interface SpeechDetectorConfig {
  /** RMS threshold for voice detection (default: DEFAULT_SPEECH_THRESHOLD). */
  speechThreshold?: number
  /** Silence duration in ms to trigger 'speech_ended' (default: DEFAULT_SILENCE_TIMEOUT_MS). */
  silenceDurationMs?: number
  /** Minimum activity duration in ms to confirm 'speaking' (default: DEFAULT_MIN_SPEECH_DURATION_MS). */
  minSpeechDurationMs?: number
}

export interface SpeechDetectorState {
  status: SpeechState
  speechStartTime?: number
  lastSpeechTime?: number
  silenceStartTime?: number
}

export function createInitialSpeechDetectorState(): SpeechDetectorState {
  return {
    status: "silent",
  }
}

/**
 * Pure transition function for speech and silence boundary detection.
 *
 * @param state Previous detector state
 * @param level Current RMS audio amplitude
 * @param now Injected current timestamp (epoch ms or performance timer)
 * @param config Optional tuning thresholds
 */
export function stepSpeechDetector(
  state: SpeechDetectorState,
  level: number,
  now: number,
  config: SpeechDetectorConfig = {}
): SpeechDetectorState {
  const threshold = config.speechThreshold ?? DEFAULT_SPEECH_THRESHOLD
  const silenceTimeout = config.silenceDurationMs ?? DEFAULT_SILENCE_TIMEOUT_MS
  const minSpeechDuration = config.minSpeechDurationMs ?? DEFAULT_MIN_SPEECH_DURATION_MS

  const isLoud = level >= threshold

  // Case 1: Audio level above threshold (speech or loud transient)
  if (isLoud) {
    // If was silent: candidate speech started
    if (state.status === "silent") {
      const startTime = state.speechStartTime ?? now
      const elapsed = now - startTime

      if (elapsed >= minSpeechDuration) {
        return {
          status: "speaking",
          speechStartTime: startTime,
          lastSpeechTime: now,
          silenceStartTime: undefined,
        }
      }

      return {
        ...state,
        speechStartTime: startTime,
        silenceStartTime: undefined,
      }
    }

    // If was already speaking: refresh last speech time
    if (state.status === "speaking") {
      return {
        ...state,
        lastSpeechTime: now,
        silenceStartTime: undefined,
      }
    }

    // If was speech_ended: new speech started
    if (state.status === "speech_ended") {
      return {
        status: "speaking",
        speechStartTime: now,
        lastSpeechTime: now,
        silenceStartTime: undefined,
      }
    }
  }

  // Case 2: Audio level below threshold (silence / ambient)
  if (state.status === "silent") {
    // Transient click died down before reaching minSpeechDuration: reset
    return {
      status: "silent",
      speechStartTime: undefined,
      silenceStartTime: undefined,
    }
  }

  if (state.status === "speaking") {
    const silenceStart = state.silenceStartTime ?? now
    const silenceDuration = now - silenceStart

    if (silenceDuration >= silenceTimeout) {
      return {
        status: "speech_ended",
        speechStartTime: undefined,
        lastSpeechTime: state.lastSpeechTime,
        silenceStartTime: silenceStart,
      }
    }

    return {
      ...state,
      silenceStartTime: silenceStart,
    }
  }

  // State remains speech_ended until explicit reset or new speech starts
  return state
}

/** The shortest wait for the end of a sentence, however quick the speaker. */
export const MIN_SILENCE_TIMEOUT_MS = 700

/* Pauses shorter than this are between syllables, not between words. */
const MIN_LEARNED_PAUSE_MS = 150
const LEARNED_PAUSES = 30
const PAUSES_BEFORE_ADAPTING = 6
/** Speech this soon after a sentence was closed means the sentence had not ended. */
export const RESUMED_WITHIN_MS = 1_000
const REMEMBERED_CUTS = 10

/**
 * How long this speaker pauses inside a sentence, learned as they talk.
 *
 * A fixed 0.8 s wait after the last word is right for someone who stops to
 * think mid-sentence and slow for someone who does not. The pauses a speaker
 * makes and then carries on from are the ones that must not end a sentence:
 * the wait is the longest of the usual ones (nine in ten) plus a margin,
 * between 0.7 and 0.8 s. Until enough have been heard, 0.8 s.
 *
 * A pause that did end a sentence the speaker then went on with (`cut`) was
 * a pause to think, and the wait must not cut it again: it stays above the
 * last ones of those, however many short pauses come after. Only learning
 * the pauses that did not close, the wait fell to its minimum and cut every
 * thinking pause from then on.
 *
 * Kept for the whole app, so a microphone reopened keeps what it learned.
 */
export function createPauseLearner() {
  let pauses: number[] = []
  let cuts: number[] = []
  return {
    heard(pauseMs: number): void {
      if (pauseMs < MIN_LEARNED_PAUSE_MS || pauseMs >= DEFAULT_SILENCE_TIMEOUT_MS) return
      pauses = [...pauses, pauseMs].slice(-LEARNED_PAUSES)
    },
    cut(pauseMs: number): void {
      cuts = [...cuts, pauseMs].slice(-REMEMBERED_CUTS)
    },
    timeoutMs(): number {
      if (cuts.length > 0) {
        const longest = Math.max(...cuts)
        if (longest + 100 >= DEFAULT_SILENCE_TIMEOUT_MS) return DEFAULT_SILENCE_TIMEOUT_MS
      }
      if (pauses.length < PAUSES_BEFORE_ADAPTING) return DEFAULT_SILENCE_TIMEOUT_MS
      const sorted = [...pauses].sort((a, b) => a - b)
      const usual = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!
      const floor = Math.max(MIN_SILENCE_TIMEOUT_MS, ...cuts.map((cut) => cut + 100))
      return Math.min(DEFAULT_SILENCE_TIMEOUT_MS, Math.max(floor, usual + 200))
    },
  }
}

const sharedPauses = createPauseLearner()

/**
 * State container wrapping stepSpeechDetector for stateful usage.
 *
 * Without a fixed `silenceDurationMs`, the wait adapts to the speaker: see
 * `createPauseLearner`.
 */
export function createSpeechDetector(config: SpeechDetectorConfig = {}, pauses = sharedPauses) {
  let state = createInitialSpeechDetectorState()
  const adaptive = config.silenceDurationMs === undefined
  /* The last sentence end, to tell whether the speaker went on at once. */
  let ended: { at: number; quietSince: number } | undefined

  return {
    getState(): Readonly<SpeechDetectorState> {
      return state
    },

    step(level: number, now: number): SpeechState {
      const before = state
      const silenceDurationMs = adaptive ? pauses.timeoutMs() : config.silenceDurationMs
      state = stepSpeechDetector(state, level, now, { ...config, silenceDurationMs })
      // A pause the speaker carried on from.
      if (adaptive && before.status === "speaking" && before.silenceStartTime !== undefined && state.silenceStartTime === undefined) {
        pauses.heard(now - before.silenceStartTime)
      }
      if (state.status === "speech_ended" && before.status !== "speech_ended") {
        ended = { at: now, quietSince: state.silenceStartTime ?? now }
      } else if (state.status === "speaking" && before.status !== "speaking" && ended) {
        const resumedAt = state.speechStartTime ?? now
        if (adaptive && resumedAt - ended.at <= RESUMED_WITHIN_MS) pauses.cut(resumedAt - ended.quietSince)
        ended = undefined
      }
      return state.status
    },

    reset(): void {
      state = createInitialSpeechDetectorState()
    },
  }
}
