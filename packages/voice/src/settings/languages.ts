/**
 * Supported speech recognition language resolution across backends.
 *
 * Provides language inventories and capability checks for:
 * - "parakeet": Inspected dynamically at runtime via parakeet.js model configuration
 * - "openrouter": ISO-639-1 model multilingual capability surface
 */

import type { TranscriberBackend } from "../asr/select"

/*
 * `parakeet.js` is NOT imported here, and that is the point.
 *
 * A static `import * as parakeet from "parakeet.js"` at the top of this file
 * pulled the whole ASR stack — parakeet.js, then `onnxruntime-web`, then a
 * 23.8 MB `ort-wasm-simd-threaded.jsep.wasm` — into ADE's main bundle, for a
 * module whose entire job is to render a dropdown of language names. Every
 * start of the app paid for it, and the installer carried it.
 *
 * It is loaded on demand instead, by whoever is actually about to transcribe:
 * `asr/parakeet-local.ts` already does this with a dynamic import. Until that
 * has happened, `availableLanguages("parakeet")` answers from the model card
 * below rather than from the library.
 */

/**
 * The languages NVIDIA Parakeet TDT 0.6B v3 is published as supporting.
 *
 * A fallback, not the source of truth: `parakeetLib` overrides it whenever a
 * caller has the library loaded, and `parakeet-local.ts` asks the real
 * `supportsLanguage` before it will start. This list only has to be right
 * enough to populate a dropdown before anything has been downloaded.
 */
const PARAKEET_V3_CODES: readonly string[] = [
  "it",
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "nl",
  "pl",
  "ru",
  "uk",
  "hr",
  "cs",
  "da",
]

export interface LanguageOption {
  /** ISO-639-1 language code (e.g. 'it', 'en', 'fr'). */
  readonly code: string
  /** Human-readable localized label, presented in the target language where possible. */
  readonly label: string
}

export interface AvailableLanguagesOptions {
  /** Target model identifier for Parakeet (defaults to 'parakeet-tdt-0.6b-v3'). */
  modelId?: string
  /** Injectable parakeet.js library reference for testing without monkey-patching. */
  parakeetLib?: {
    getModelConfig?: (modelId: string) => { languages?: string[] } | undefined
    getLanguageName?: (code: string) => string
    supportsLanguage?: (modelIdOrCode: string, code?: string) => boolean
  }
}

/**
 * Derives an endonym (name of the language in that language itself) using Intl.DisplayNames,
 * falling back to the English or code name if unavailable.
 */
export function formatLanguageLabel(code: string, fallbackName?: string): string {
  if (code.toLowerCase() === "auto") {
    return "Rilevamento automatico"
  }

  try {
    const displayNames = new Intl.DisplayNames([code], { type: "language" })
    const endonym = displayNames.of(code)
    if (endonym && endonym.length > 0) {
      return endonym.charAt(0).toUpperCase() + endonym.slice(1)
    }
  } catch {
    // Intl.DisplayNames may fail in legacy environments or for custom codes
  }

  if (fallbackName && fallbackName.length > 0) {
    return fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1)
  }

  return code.toUpperCase()
}

/**
 * Standard ISO-639-1 languages supported by OpenRouter speech-to-text models (e.g. Whisper / MAI).
 */
const OPENROUTER_MAJOR_CODES: readonly string[] = [
  "it",
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "nl",
  "pl",
  "ru",
  "ja",
  "ko",
  "zh",
  "ar",
  "hi",
  "tr",
  "sv",
  "da",
  "fi",
  "no",
  "el",
  "cs",
  "ro",
  "uk",
  "id",
  "vi",
]

/**
 * Returns the list of supported languages for the given backend.
 *
 * Guarantees:
 * - Parakeet languages are NEVER hardcoded: they are read strictly at runtime from parakeet.js.
 * - Labels are formatted in their native endonym when supported by Intl.
 */
export function availableLanguages(
  backend: TranscriberBackend,
  options: AvailableLanguagesOptions = {}
): LanguageOption[] {
  switch (backend) {
    case "parakeet": {
      const lib = options.parakeetLib
      const modelId = options.modelId ?? "parakeet-tdt-0.6b-v3"

      const config =
        lib?.getModelConfig?.(modelId) ??
        lib?.getModelConfig?.("parakeet-tdt-0.6b-v3") ??
        lib?.getModelConfig?.("ysdede/parakeet-tdt-0.6b-v3-onnx")

      const rawCodes = config?.languages ?? PARAKEET_V3_CODES

      return rawCodes.map((code) => {
        const fallback = lib?.getLanguageName ? lib.getLanguageName(code) : undefined
        return {
          code,
          label: formatLanguageLabel(code, fallback),
        }
      })
    }

    case "openrouter": {
      return OPENROUTER_MAJOR_CODES.map((code) => ({
        code,
        label: formatLanguageLabel(code),
      }))
    }

    default:
      return []
  }
}

/**
 * Checks whether a given language code is supported by the target backend.
 */
export function isLanguageSupported(
  backend: TranscriberBackend,
  code: string,
  options: AvailableLanguagesOptions = {}
): boolean {
  const cleanCode = code.trim().toLowerCase()
  if (!cleanCode) return false

  switch (backend) {
    case "parakeet": {
      const lib = options.parakeetLib
      const modelId = options.modelId ?? "parakeet-tdt-0.6b-v3"

      if (lib && typeof lib.supportsLanguage === "function") {
        try {
          if (lib.supportsLanguage(modelId, cleanCode)) return true
        } catch {
          // ignore
        }
        try {
          if (lib.supportsLanguage("parakeet-tdt-0.6b-v3", cleanCode)) return true
        } catch {
          // ignore
        }
      }

      const config =
        lib?.getModelConfig?.(modelId) ??
        lib?.getModelConfig?.("parakeet-tdt-0.6b-v3") ??
        lib?.getModelConfig?.("ysdede/parakeet-tdt-0.6b-v3-onnx")

      // Without the library loaded, the model card is the best answer there
      // is — and `parakeet-local.ts` asks the real thing before starting.
      return (config?.languages ?? PARAKEET_V3_CODES).includes(cleanCode)
    }

    case "openrouter":
      return (
        OPENROUTER_MAJOR_CODES.includes(cleanCode) ||
        cleanCode === "auto" ||
        cleanCode.length === 2
      )

    default:
      return false
  }
}
