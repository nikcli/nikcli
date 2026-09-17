/**
 * Cloud speech-to-text transcriber powered by OpenRouter (microsoft/mai-transcribe-2).
 *
 * Implements the Transcriber contract by collecting silence-delimited audio Blobs
 * from createMicCapture, encoding them to pure base64, and dispatching HTTP POST requests
 * to OpenRouter's transcriptions API.
 *
 * Security & Reliability guarantees:
 * - Zero hardcoded or default API keys; key is strictly injected via caller options.
 * - API key is never logged, never printed, never spoken, and stripped from error messages.
 * - Distinct localized Italian errors for 401 (invalid key) and 402 (exhausted credit).
 * - Enforces 25 MB payload limit and AbortController timeout (30s) below upstream 60s cap.
 * - Tracks and exposes usage (cost and seconds) per transcription request.
 */

import { markVoice } from "../timing"
import { plainProblem } from "../effect/errors"
import type {
  FinalTranscriptCallback,
  PartialTranscriptCallback,
  Transcriber,
  TranscriberErrorCallback,
  TranscriberOptions,
  TranscriptEvent,
} from "./transcriber"
import {
  createMicCapture,
  encodeWav,
  type CapturedSegment,
  type MicCapture,
  type MicCaptureOptions,
} from "../audio/capture"
import {
  ApiKeyInvalid,
  ApiKeyMissing,
  MicPermissionDenied,
  MicUnavailable,
  QuotaExhausted,
  RequestTimeout,
  TranscriptionFailed,
} from "../effect/errors"

// ---------------------------------------------------------------------------
// Constants & Specifications
// ---------------------------------------------------------------------------

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions"
export const OPENROUTER_MODEL = "microsoft/mai-transcribe-2"
export const OPENROUTER_FALLBACK_MODEL = "openai/whisper-large-v3"
export const OPENROUTER_TIMEOUT_MS = 30_000
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // 25 MB limit

export type OpenRouterAudioFormat =
  | "webm"
  | "wav"
  | "mp3"
  | "flac"
  | "m4a"
  | "ogg"
  | "aac"

// ---------------------------------------------------------------------------
// Helpers: MIME to Format & Base64 Converter
// ---------------------------------------------------------------------------

/**
 * Maps a MIME type string to the short format tag required by OpenRouter.
 */
export function mimeToAudioFormat(mimeType: string): OpenRouterAudioFormat {
  const lower = mimeType.toLowerCase()
  if (lower.includes("webm")) return "webm"
  if (lower.includes("mp4") || lower.includes("m4a")) return "m4a"
  if (lower.includes("wav")) return "wav"
  if (lower.includes("mp3") || lower.includes("mpeg")) return "mp3"
  if (lower.includes("ogg")) return "ogg"
  if (lower.includes("flac")) return "flac"
  if (lower.includes("aac")) return "aac"
  return "webm"
}

/**
 * Converts an audio Blob to pure base64 without data URI scheme or prefix comma.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const g = typeof window !== "undefined" ? window : (globalThis as any)

  if (typeof g?.FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new g.FileReader()
      reader.onload = () => {
        const result = reader.result as string
        if (typeof result === "string") {
          const commaIdx = result.indexOf(",")
          resolve(commaIdx !== -1 ? result.slice(commaIdx + 1) : result)
        } else {
          reject(new Error("Errore durante la codifica base64 del file audio: risultato nullo."))
        }
      }
      reader.onerror = () => reject(reader.error ?? new Error("Errore durante la codifica base64 del file audio."))
      reader.readAsDataURL(blob)
    })
  }

  // Node.js / Bun runtime fallback
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64")
  }

  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Strictly scrubs the API key from any output string, preventing accidental leakage
 * into logs, exceptions, or UI surfaces.
 */
/**
 * Turns a settings language code into what the request body should carry.
 *
 * Returns undefined for "auto" and for anything empty, which the caller sends
 * as an absent field. Defaults to Italian only when nothing was asked for at
 * all, so an older caller that never passed a language keeps the behaviour it
 * had rather than silently switching to detection.
 */
export function normalizeRequestLanguage(code: string | undefined): string | undefined {
  if (code === undefined) return "it"
  const clean = code.trim().toLowerCase()
  if (clean.length === 0 || clean === "auto") return undefined
  return clean
}

export function sanitizeApiKey(text: string, apiKey?: string): string {
  if (!text) return ""
  if (!apiKey || apiKey.trim().length === 0) return text
  return text.replaceAll(apiKey, "[REDACTED]")
}

// ---------------------------------------------------------------------------
// Usage & Options Interfaces
// ---------------------------------------------------------------------------

export interface OpenRouterUsage {
  seconds?: number
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  cost?: number
}

export type OpenRouterUsageCallback = (usage: OpenRouterUsage) => void

export interface OpenRouterTranscriberOptions extends TranscriberOptions {
  /** OpenRouter Bearer API key. Required; caller must provide it. */
  apiKey: string
  /** Speech-to-text model to query (default: 'microsoft/mai-transcribe-2'). */
  model?: string
  /** Callback fired with usage statistics (cost, tokens, seconds) upon successful transcription. */
  onUsage?: OpenRouterUsageCallback
  /**
   * ISO-639-1 code the audio is expected to be in, from `VoiceSettings.language`.
   *
   * This used to be the literal `"it"` in the request body, which made the
   * language picker decorative: it validated the code, stored it, redrew the
   * list from the model's own inventory, and then every request asked for
   * Italian anyway. Speaking English into it produced Italian-shaped nonsense
   * and nothing in the interface said why.
   *
   * `"auto"` is passed through as *no* language field: that is how the model
   * is asked to detect, and sending the string "auto" as a language code is
   * not the same request.
   */
  language?: string
  /** Request timeout in milliseconds (default: 30_000 ms). */
  timeoutMs?: number
  /** Optional pre-existing MicCapture instance. If omitted, createMicCapture() is used. */
  capture?: MicCapture
  /** Options passed to createMicCapture when capture is not pre-supplied. */
  captureOptions?: MicCaptureOptions
  /** Dependency injection hook for fetch. */
  fetch?: typeof globalThis.fetch
  /** Dependency injection hook for time provider. */
  now?: () => number
  /** Sends only the start of a sentence while nobody has called the assistant; see `NameGate`. */
  nameGate?: NameGate
}

/**
 * How much of a sentence is sent to learn whether it calls the assistant.
 *
 * With the microphone always open, every sentence in the room is a paid
 * request, and most of them are not for the assistant: the television, a
 * phone call. The phrase that calls it comes first, so the first second and a
 * half — the capture's pre-roll included — is enough to tell, and the rest of
 * the sentence is sent only when it does.
 */
export const NAME_PROBE_MS = 1_500

/**
 * Sentences up to this long are sent whole: cutting one would save little and
 * cost a second request when it does call the assistant.
 */
export const NAME_PROBE_WHOLE_UNDER_MS = 2_000

export interface NameGate {
  /**
   * Whether a sentence begun at `spokenAt` had to call the assistant; false
   * while it was awake or waiting for an answer.
   */
  active(spokenAt: number): boolean
  /** Whether the transcribed start of a sentence calls the assistant. */
  accepts(text: string): boolean
  /** The start of a sentence that did not call it, for the console to show. */
  onRejected?(text: string): void
  /** The start of a sentence called it: sent whole now, and the voice can stop at once. */
  onAccepted?(): void
  /** Each request sent while the gate was active, so the caller can count them. */
  onRequest?(): void
  /** A long sentence that could not be cut, and so was not sent at all. */
  onUncut?(): void
  probeMs?: number
  wholeUnderMs?: number
}

/**
 * The first `ms` of a 16-bit mono WAV, with its header rewritten to match.
 *
 * Undefined when the blob is not the WAV the capture writes, so the caller
 * sends the sentence whole rather than something the service cannot read.
 */
export async function wavHead(blob: Blob, ms: number): Promise<Blob | undefined> {
  if (blob.size <= 44) return undefined
  const header = new DataView(await blob.slice(0, 44).arrayBuffer())
  const tag = (offset: number) =>
    String.fromCharCode(header.getUint8(offset), header.getUint8(offset + 1), header.getUint8(offset + 2), header.getUint8(offset + 3))
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(36) !== "data" || header.getUint16(34, true) !== 16) return undefined
  const rate = header.getUint32(24, true)
  const bytes = Math.floor((rate * ms) / 1000) * 2
  if (bytes >= blob.size - 44) return undefined
  const head = new Uint8Array(await blob.slice(0, 44 + bytes).arrayBuffer())
  const view = new DataView(head.buffer)
  view.setUint32(4, 36 + bytes, true)
  view.setUint32(40, bytes, true)
  return new Blob([head], { type: "audio/wav" })
}

export interface OpenRouterTranscriber extends Transcriber {
  /** Access usage statistics for the most recent successful transcription. */
  getLastUsage(): OpenRouterUsage | null
  /** Property accessor for usage metrics. */
  readonly lastUsage: OpenRouterUsage | null
  /** Underlying microphone capture adapter. */
  readonly capture: MicCapture
  /** Whether a transcription request is currently in flight. */
  readonly hasInFlight: boolean
}

// ---------------------------------------------------------------------------
// OpenRouter Transcriber Factory
// ---------------------------------------------------------------------------

export function createOpenRouterTranscriber(
  options: OpenRouterTranscriberOptions
): OpenRouterTranscriber {
  const apiKey = options.apiKey
  const timeoutMs = options.timeoutMs ?? OPENROUTER_TIMEOUT_MS
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
  const language = normalizeRequestLanguage(options.language)

  let partialCb: PartialTranscriptCallback = options.onPartial ?? (() => {})
  let finalCb: FinalTranscriptCallback = options.onFinal ?? (() => {})
  let errorCb: TranscriberErrorCallback = options.onError ?? (() => {})
  let usageCb: OpenRouterUsageCallback = options.onUsage ?? (() => {})

  let lastUsage: OpenRouterUsage | null = null
  let userStopped = true
  let inFlightRequests = 0

  const micCapture: MicCapture =
    options.capture ?? createMicCapture({ preferredFormat: "wav", ...options.captureOptions })

  const now = options.now ?? Date.now

  async function transcribeSegment(segment: CapturedSegment, deliver: (text: string) => void): Promise<void> {
    if (!segment.blob || segment.blob.size === 0) return

    inFlightRequests++
    // Cleared once the body is read, not when the headers arrive: a body that
    // trickles in was the one part of the request with no limit.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!apiKey || apiKey.trim().length === 0) {
        errorCb(
          new ApiKeyMissing({
            message:
              "Chiave API OpenRouter mancante. Specificare una chiave API valida nelle opzioni.",
          }) as unknown as Error
        )
        return
      }

      if (segment.blob.size > MAX_AUDIO_BYTES) {
        const sizeMb = Math.round(segment.blob.size / (1024 * 1024))
        errorCb(
          new Error(
            `File audio troppo grande (${sizeMb} MB): il limite massimo consentito per richiesta è di 25 MB.`
          )
        )
        return
      }

      let base64Audio: string = ""
      let shortFormat = segment.format || mimeToAudioFormat(segment.mimeType || segment.blob.type)

      // In a browser environment, if the audio segment is in webm/m4a format,
      // transcode it to 16 kHz WAV via AudioContext.decodeAudioData.
      // Azure MAI-Transcribe 2 strictly requires WAV/PCM.
      if (shortFormat !== "wav" && typeof window !== "undefined") {
        const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
        if (AudioCtx) {
          try {
            const ctx = new AudioCtx({ sampleRate: 16000 })
            const arrayBuf = await segment.blob.arrayBuffer()
            const decoded = await ctx.decodeAudioData(arrayBuf)
            const pcm = decoded.getChannelData(0)
            const wavBlob = encodeWav(pcm, decoded.sampleRate)
            base64Audio = await blobToBase64(wavBlob)
            shortFormat = "wav"
            await ctx.close().catch(() => {})
          } catch {
            // Decode failed (e.g. mock test blob), fall back to original blob
          }
        }
      }

      if (!base64Audio) {
        try {
          base64Audio = await blobToBase64(segment.blob)
        } catch (err: any) {
          errorCb(
            new Error(
              `Impossibile convertire l'audio per l'invio: ${err?.message ?? "errore sconosciuto"}`
            )
          )
          return
        }
      }

      const controller = new AbortController()
      timer = setTimeout(() => controller.abort(), timeoutMs)

      const primaryModel = options.model ?? OPENROUTER_MODEL
      const requestPayload: Record<string, any> = {
        model: primaryModel,
        input_audio: {
          data: base64Audio,
          format: shortFormat,
        },
        ...(language ? { language } : {}),
        temperature: 0,
      }

      let response: Response
      markVoice("asr-sent", `${Math.round(segment.durationMs)}ms`)
      try {
        response = await fetchFn(OPENROUTER_ENDPOINT, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
        })

        // If OpenRouter returns 400 (e.g. "Provider returned 400" because Azure MAI-Transcribe 2
        // has an upstream provider failure or rejects language/temperature parameters):
        // A 429 is the upstream provider being rate limited, not this app
        // sending too much: the first sentence of a session got one in ADE
        // Test and was lost. It goes straight to the fallback model, since
        // asking the same model again at once would only be refused again.
        if (!response.ok && (response.status === 400 || response.status === 429 || response.status >= 500)) {
          // Attempt 1: Retry without language and temperature
          if (response.status !== 429) try {
            const retryResponse = await fetchFn(OPENROUTER_ENDPOINT, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: primaryModel,
                input_audio: {
                  data: base64Audio,
                  format: shortFormat,
                },
              }),
              signal: controller.signal,
            })
            if (retryResponse.ok) {
              response = retryResponse
            }
          } catch {
            // continue to fallback below
          }

          // Attempt 2: If still failing and primary was not already the fallback model, retry with whisper-large-v3
          if (!response.ok && primaryModel !== OPENROUTER_FALLBACK_MODEL) {
            try {
              const fallbackResponse = await fetchFn(OPENROUTER_ENDPOINT, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: OPENROUTER_FALLBACK_MODEL,
                  input_audio: {
                    data: base64Audio,
                    format: shortFormat,
                  },
                  ...(language ? { language } : {}),
                }),
                signal: controller.signal,
              })
              if (fallbackResponse.ok) {
                response = fallbackResponse
              }
            } catch {
              // keep original response for standard error handling below
            }
          }
        }
      } catch (netErr: any) {
      if (controller.signal.aborted || netErr?.name === "AbortError") {
        errorCb(
          new RequestTimeout({
            timeoutMs,
            message: `Il servizio che trascrive la voce non ha risposto in ${Math.round(timeoutMs / 1000)} secondi: riprova tra poco.`,
          }) as unknown as Error
        )
        return
      }

      const safeNetMessage = sanitizeApiKey(
        netErr?.message ?? "connessione fallita",
        apiKey
      )
      errorCb(
        new Error(
          `Non ho rete in questo momento: ti sento appena torna. (${safeNetMessage})`
        )
      )
      return
    }

    if (!response.ok) {
      if (response.status === 401) {
        errorCb(
          new ApiKeyInvalid({
            message:
              "La chiave OpenRouter non funziona: controllala nelle impostazioni della voce.",
          }) as unknown as Error
        )
        return
      }

      if (response.status === 402) {
        errorCb(
          new QuotaExhausted({
            message:
              "Il credito OpenRouter è finito: ricaricalo e ti sento di nuovo.",
          }) as unknown as Error
        )
        return
      }

      if (response.status === 429) {
        errorCb(
          new Error(
            "Il servizio che trascrive la voce è occupato (troppe richieste): riprova tra qualche secondo."
          )
        )
        return
      }

      let detail = ""
      try {
        const errorJson = await response.json()
        if (errorJson?.error?.message) {
          detail = String(errorJson.error.message)
        } else if (typeof errorJson?.error === "string") {
          detail = errorJson.error
        }
      } catch {
        // Response was not JSON
      }

      const safeDetail = sanitizeApiKey(detail, apiKey)
      const detailSuffix = safeDetail ? `: ${safeDetail}` : ""
      errorCb(
        new Error(
          `Il servizio che trascrive la voce ha avuto un problema (${response.status})${detailSuffix}: riprova tra poco.`
        )
      )
      return
    }

    try {
      const data = await response.json()

      if (data?.usage) {
        lastUsage = data.usage
        usageCb(data.usage)
      }

      const text = (
        data?.text ??
        data?.transcription ??
        (Array.isArray(data?.segments) ? data.segments.map((s: any) => s.text).join(" ") : "") ??
        ""
      ).trim()
      if (text) deliver(text)
    } catch (parseErr: any) {
      if (parseErr?.name === "AbortError") {
        errorCb(
          new RequestTimeout({
            timeoutMs,
            message: `Il servizio che trascrive la voce non ha risposto in ${Math.round(timeoutMs / 1000)} secondi: riprova tra poco.`,
          }) as unknown as Error
        )
        return
      }
      errorCb(
        new Error(
          `Risposta non valida dal servizio di trascrizione: ${parseErr?.message ?? "formato inatteso"}`
        )
      )
    }
  } finally {
    clearTimeout(timer)
    inFlightRequests--
  }
}

  /** The start of a sentence, when that is all that should be sent; see `NameGate`. */
  async function probeFor(segment: CapturedSegment): Promise<Blob | undefined> {
    const gate = options.nameGate
    if (!gate || segment.format !== "wav") return undefined
    return wavHead(segment.blob, gate.probeMs ?? NAME_PROBE_MS)
  }

  /*
   * The start of a long sentence, sent while it is still being spoken: the
   * same request `probeFor` would make once it ended, a second earlier. Only
   * past `wholeUnderMs`, so a sentence that would have gone whole is not
   * probed as well.
   */
  const earlyProbes = new Map<number, Promise<string>>()
  const earlyGate = options.nameGate
  if (earlyGate) {
    micCapture.onHead?.(
      ({ blob, sequence }) => {
        const wholeUnderMs = earlyGate.wholeUnderMs ?? NAME_PROBE_WHOLE_UNDER_MS
        if (!earlyGate.active(now() - wholeUnderMs)) return
        earlyGate.onRequest?.()
        let heard = ""
        const probe = transcribeSegment({ blob, format: "wav", mimeType: "audio/wav", durationMs: earlyGate.probeMs ?? NAME_PROBE_MS }, (text) => (heard = text))
          .then(() => heard)
          .catch(() => "")
        earlyProbes.set(sequence, probe)
      },
      {
        afterMs: earlyGate.wholeUnderMs ?? NAME_PROBE_WHOLE_UNDER_MS,
        headMs: earlyGate.probeMs ?? NAME_PROBE_MS,
      },
    )
  }

  micCapture.onSegment(async (segment: CapturedSegment) => {
    // Held for the whole exchange: between the two requests nothing is in
    // flight, and a stop that looked then would drop the sentence.
    inFlightRequests++
    try {
      const spokenAt = now() - segment.durationMs
      const deliver = (text: string) => finalCb({ text, isFinal: true, confidence: 1.0, spokenAt })
      const gate = options.nameGate
      const early = segment.sequence === undefined ? undefined : earlyProbes.get(segment.sequence)
      for (const sequence of earlyProbes.keys()) {
        if (segment.sequence !== undefined && sequence <= segment.sequence) earlyProbes.delete(sequence)
      }
      const gated = early !== undefined || gate?.active(spokenAt) === true
      const long = segment.durationMs > (gate?.wholeUnderMs ?? NAME_PROBE_WHOLE_UNDER_MS)
      const head = early ? undefined : gated && long ? await probeFor(segment) : undefined
      /* Waiting for the name, a long sentence goes whole only once its start
         has called; one that cannot be cut is not sent at all. */
      if (gated && long && !head && !early) {
        gate!.onUncut?.()
        return
      }
      if (gated && !early) gate!.onRequest?.()
      if (head || early) {
        let heard = ""
        if (early) heard = await early
        else await transcribeSegment({ ...segment, blob: head! }, (text) => (heard = text))
        markVoice("asr-probe-back", heard)
        if (!heard) return
        if (!options.nameGate!.accepts(heard)) {
          options.nameGate!.onRejected?.(heard)
          return
        }
        options.nameGate!.onAccepted?.()
        options.nameGate!.onRequest?.()
      }
      await transcribeSegment(segment, deliver)
      markVoice("asr-back")
    } catch (err: any) {
      const safeMsg = sanitizeApiKey(err?.message ?? "errore sconosciuto", apiKey)
      errorCb(new Error(`Non sono riuscito a trascrivere la frase: ${safeMsg}`))
    } finally {
      inFlightRequests--
    }
  })

  micCapture.onError((err: Error) => {
    errorCb(err)
  })

  return {
    getLastUsage(): OpenRouterUsage | null {
      return lastUsage
    },

    get lastUsage(): OpenRouterUsage | null {
      return lastUsage
    },

    get capture(): MicCapture {
      return micCapture
    },

    get hasInFlight(): boolean {
      return inFlightRequests > 0
    },

    startSegment(): void {
      micCapture.startSegment?.()
    },

    commit(): boolean {
      return Boolean(micCapture.commitSegment?.())
    },

    cancelSegment(): void {
      micCapture.cancelSegment?.()
    },

    finish(): void {
      // Stopping the capture closes the open segment and hands it to
      // `transcribeSegment` synchronously, so `hasInFlight` is already true
      // when this returns and the caller's wait sees the request.
      userStopped = true
      micCapture.stop()
    },

    async start(): Promise<void> {
      userStopped = false
      // Reported and rethrown: a start() that resolves is a promise to the
      // caller that audio is now flowing, and without a key or a microphone
      // none is.
      if (!apiKey || apiKey.trim().length === 0) {
        const missing = new ApiKeyMissing({
          message:
            "Chiave API OpenRouter mancante. Specificare una chiave API valida nelle opzioni.",
        })
        errorCb(missing as unknown as Error)
        throw missing
      }

      try {
        await micCapture.start()
      } catch (err: any) {
        userStopped = true
        const lower = String(err?.message ?? "").toLowerCase()
        if (lower.includes("negato") || lower.includes("notallowed") || lower.includes("permission")) {
          const permErr = new MicPermissionDenied({
            message: "Accesso al microfono negato: consentilo nelle impostazioni di privacy del sistema (Windows: Impostazioni › Privacy e sicurezza › Microfono, per le app desktop).",
            cause: err,
          })
          errorCb(permErr as unknown as Error)
          throw permErr
        }
        if (lower.includes("nessun microfono") || lower.includes("notfound")) {
          const unavailErr = new MicUnavailable({
            message: "Nessun microfono rilevato o non accessibile. Collega un dispositivo audio e riprova.",
            cause: err,
          })
          errorCb(unavailErr as unknown as Error)
          throw unavailErr
        }
        const failure = new TranscriptionFailed({
          cause: err,
          message: plainProblem(err?.message) ?? `Non riesco ad aprire il microfono: ${err?.message ?? "non so perché"}`,
        })
        errorCb(failure as unknown as Error)
        throw failure
      }
    },

    stop(): void {
      userStopped = true
      micCapture.stop()
    },

    onPartial(callback: PartialTranscriptCallback): void {
      partialCb = callback
    },

    onFinal(callback: FinalTranscriptCallback): void {
      finalCb = callback
    },

    onError(callback: TranscriberErrorCallback): void {
      errorCb = callback
    },
  }
}
