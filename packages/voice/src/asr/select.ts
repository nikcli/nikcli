/**
 * Transcriber backend selection and readiness diagnostics.
 *
 * Two engines, both of which work inside an embedded webview:
 * - "parakeet": Local neural model (NVIDIA Parakeet TDT 0.6B v3) via WebGPU/WASM
 * - "openrouter": Cloud ASR via OpenRouter (microsoft/mai-transcribe-2)
 *
 * There was a third, the browser's own Web Speech API, and it is gone. Inside
 * Tauri's WebView2 the constructor exists and the service behind it does not:
 * every `start()` was answered by an immediate `end` with no audio event, no
 * result and no error, so the app reported "listening" to a user talking to
 * nothing. ADE only ever runs in a webview, so an engine that only works in a
 * plain browser tab was a default that could never work where it shipped.
 *
 * Provides describeBackends() to inform the ADE UI why any engine is or isn't usable right now.
 */

import type { Transcriber } from "./transcriber"
import {
  createParakeetTranscriber,
  describeParakeetReadiness,
  isWasmAvailable,
  isWebGpuAvailable,
  type ParakeetTranscriberOptions,
} from "./parakeet-local"
import {
  createOpenRouterTranscriber,
  type OpenRouterTranscriberOptions,
} from "./openrouter"
import { t } from "@nikcli-ai/ade/i18n"

// ---------------------------------------------------------------------------
// Backend Identifier & Status Types
// ---------------------------------------------------------------------------

export type TranscriberBackend = "parakeet" | "openrouter"

export interface BackendStatus {
  /** Whether the backend can be activated and used right now. */
  usable: boolean
  /** Localized Italian explanation if not currently usable. */
  reason?: string
}

export interface BackendDescriptions {
  parakeet: BackendStatus
  openrouter: BackendStatus
}

export interface SelectTranscriberOptions {
  /** OpenRouter API key. */
  apiKey?: string
  /** Whether the Parakeet model weights have already been cached/downloaded locally. */
  isModelDownloaded?: boolean
  /**
   * `VoiceSettings.language`, applied to whichever backend is chosen.
   *
   * Set here rather than twice in the per-backend options because it is one
   * user decision, and the two places it used to be spelled were both the
   * constant `"it"`. A backend-specific option still wins, for a caller that
   * has a reason to differ.
   */
  language?: string
  /** Options passed when constructing the Parakeet transcriber. */
  parakeetOptions?: ParakeetTranscriberOptions
  /** Options passed when constructing the OpenRouter transcriber. */
  openRouterOptions?: Partial<OpenRouterTranscriberOptions>
}

// ---------------------------------------------------------------------------
// Backend Readiness Inspection
// ---------------------------------------------------------------------------

/**
 * Diagnostics utility returning usability state and user-facing Italian reasons
 * for all three transcription backends.
 *
 * Guarantees: Never throws.
 */
export function describeBackends(
  options: SelectTranscriberOptions = {}
): BackendDescriptions {
  try {
    // 1. Parakeet Local
    const parakeetStatus: BackendStatus = describeParakeetReadiness({
      isModelDownloaded: options.isModelDownloaded,
    })

    // 2. OpenRouter Cloud
    const candidateKey =
      options.apiKey ?? options.openRouterOptions?.apiKey
    const hasValidKey = Boolean(candidateKey && candidateKey.trim().length > 0)
    const openrouterStatus: BackendStatus = hasValidKey
      ? { usable: true }
      : {
          usable: false,
          reason: t("vui.asr.noKey"),
        }

    return {
      parakeet: parakeetStatus,
      openrouter: openrouterStatus,
    }
  } catch {
    return {
      parakeet: {
        usable: false,
        reason: t("vui.asr.parakeetCheck"),
      },
      openrouter: {
        usable: false,
        reason: t("vui.asr.keyCheck"),
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Backend Transcriber Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Transcriber instance for the requested backend.
 */
export function createTranscriberFor(
  backend: TranscriberBackend,
  options: SelectTranscriberOptions = {}
): Transcriber {
  switch (backend) {
    case "parakeet":
      return createParakeetTranscriber({
        language: options.language,
        ...options.parakeetOptions,
      })

    case "openrouter": {
      const apiKey = options.apiKey ?? options.openRouterOptions?.apiKey ?? ""
      return createOpenRouterTranscriber({
        language: options.language,
        ...options.openRouterOptions,
        apiKey,
      })
    }

    default:
      throw new Error(`Backend di trascrizione non riconosciuto: ${backend}`)
  }
}
