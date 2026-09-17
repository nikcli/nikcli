/**
 * Text-to-speech speaker contract and implementations.
 *
 * Provides spoken Italian feedback for dialogue state, prompt confirmation requests,
 * and command outcomes. Ensures previous spoken utterances are canceled before
 * new ones start to prevent overlapping voices.
 */

export interface Speaker {
  /** Synthesizes and speaks the given text aloud. */
  speak(text: string): Promise<void> | void

  /** Immediately cancels any active or queued speech synthesis. */
  cancel(): void

  /** Starts preparing text that will be said shortly, so it starts sooner. */
  prefetch?(text: string): void
}

// ---------------------------------------------------------------------------
// Web Speech Synthesis Implementation
// ---------------------------------------------------------------------------

export interface WebSpeechSpeakerOptions {
  /** Target BCP-47 language tag (default: 'it-IT'). */
  lang?: string
  /** Preferred voice name or substring (e.g. 'diego', 'natural', 'isabella'). */
  preferredVoice?: string
  /** Speaking rate multiplier [0.1 - 10] (default: 1.02). */
  rate?: number
  /** Speaking pitch [0 - 2] (default: 1.0). */
  pitch?: number
  /** Speaking volume [0 - 1] (default: 1.0). */
  volume?: number
}

/**
 * Intelligent voice selection that prioritizes modern neural/natural voices over
 * legacy robotic SAPI synthesizer voices.
 *
 * In Windows WebView2/Edge and Chrome, high-fidelity neural voices contain
 * tokens like "Natural", "Neural", or "Online" (e.g. "Microsoft Diego Online (Natural) - Italian").
 * A naive find() on lang='it' picks legacy desktop voices first, sounding mechanical.
 */
export function pickBestVoice(
  voices: readonly SpeechSynthesisVoice[],
  lang = "it-IT",
  preferredVoice?: string,
): SpeechSynthesisVoice | undefined {
  if (!voices || voices.length === 0) return undefined

  const wanted = lang.slice(0, 2).toLowerCase()
  const matching = voices.filter((v) => v.lang.toLowerCase().replace(/_/g, "-").startsWith(wanted))
  if (matching.length === 0) return undefined

  // 1. Explicit preferred voice substring (e.g. "diego", "isabella")
  if (preferredVoice && preferredVoice.trim().length > 0) {
    const pref = preferredVoice.toLowerCase().trim()
    const hit = matching.find((v) => v.name.toLowerCase().includes(pref))
    if (hit) return hit
  }

  // 2. High-fidelity Neural / Natural / Online voices (Edge/WebView2 & modern OS)
  const neural = matching.find((v) => {
    const name = v.name.toLowerCase()
    return name.includes("natural") || name.includes("neural") || name.includes("online")
  })
  if (neural) return neural

  // 3. Diego (preferred deep, composed Italian tone for Jarvis)
  const diego = matching.find((v) => v.name.toLowerCase().includes("diego"))
  if (diego) return diego

  // 4. Google or Apple enhanced neural voices
  const enhanced = matching.find((v) => {
    const name = v.name.toLowerCase()
    return name.includes("google") || name.includes("enhanced") || name.includes("premium")
  })
  if (enhanced) return enhanced

  // 5. Fallback to first matching voice
  return matching[0]
}

export function createWebSpeechSpeaker(options: WebSpeechSpeakerOptions = {}): Speaker {
  const lang = options.lang ?? "it-IT"
  const rate = options.rate ?? 1.02

  function getSynthesis(): SpeechSynthesis | null {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      return window.speechSynthesis
    }
    if (typeof globalThis !== "undefined" && (globalThis as any).speechSynthesis) {
      return (globalThis as any).speechSynthesis
    }
    return null
  }

  /**
   * The voices, once the browser has actually loaded them.
   *
   * `getVoices()` returns an empty array on the first call in Chromium and
   * WebView2 — the list is populated asynchronously and announced by a
   * `voiceschanged` event. Read synchronously, as this used to be, the first
   * utterance of every session found nothing, fell through to the default
   * voice, and the assistant answered its first Italian sentence in English.
   * By the second sentence the list was there and the voice changed, which
   * reads as a bug rather than as a warm-up.
   *
   * Primed once here and kept: after `voiceschanged` the synchronous call
   * works, so this only has to bridge the first few hundred milliseconds.
   */
  let voices: SpeechSynthesisVoice[] = []
  const primeVoices = () => {
    const synthesis = getSynthesis()
    if (!synthesis) return
    try {
      const found = synthesis.getVoices()
      if (found.length > 0) voices = found
    } catch {
      // A synthesiser that refuses to enumerate leaves `voices` empty, and
      // the utterance goes out on the browser's default — the old behaviour.
    }
  }

  primeVoices()
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("voiceschanged", primeVoices)
    const synthesis = getSynthesis()
    // Chromium fires it on the synthesiser, other engines on the window.
    if (synthesis && typeof synthesis.addEventListener === "function") {
      synthesis.addEventListener("voiceschanged", primeVoices)
    }
  }

  return {
    speak(text: string): Promise<void> {
      const synthesis = getSynthesis()
      if (!synthesis) {
        return Promise.resolve()
      }

      // Hard rule: cancel previous speech before speaking anew
      synthesis.cancel()

      if (!text || text.trim().length === 0) {
        return Promise.resolve()
      }

      return new Promise<void>((resolve) => {
        const UtteranceCtor =
          (typeof window !== "undefined" && window.SpeechSynthesisUtterance) ||
          (globalThis as any).SpeechSynthesisUtterance

        if (!UtteranceCtor) {
          resolve()
          return
        }

        const utterance = new UtteranceCtor(text)
        utterance.lang = lang
        utterance.rate = rate
        if (options.pitch !== undefined) utterance.pitch = options.pitch
        if (options.volume !== undefined) utterance.volume = options.volume

        // Best natural neural voice available for the language
        primeVoices()
        const match = pickBestVoice(voices, lang, options.preferredVoice)
        if (match) {
          utterance.voice = match
        }

        utterance.onend = () => resolve()
        utterance.onerror = () => resolve()

        synthesis.speak(utterance)
      })
    },

    cancel(): void {
      const synthesis = getSynthesis()
      if (synthesis) {
        synthesis.cancel()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Fake Speaker for Testing
// ---------------------------------------------------------------------------

export interface FakeSpeaker extends Speaker {
  /** Chronological history of all spoken text strings. */
  readonly spoken: string[]
  /** Last spoken phrase. */
  readonly lastSpoken: string | undefined
  /** Clear spoken history. */
  clear(): void
}

export function createFakeSpeaker(): FakeSpeaker {
  const history: string[] = []

  return {
    get spoken(): string[] {
      return [...history]
    },

    get lastSpoken(): string | undefined {
      return history.length > 0 ? history[history.length - 1] : undefined
    },

    speak(text: string): Promise<void> {
      history.push(text)
      return Promise.resolve()
    },

    cancel(): void {
      // noop for fake
    },

    clear(): void {
      history.length = 0
    },
  }
}
