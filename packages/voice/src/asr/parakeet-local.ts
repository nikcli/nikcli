/**
 * Local in-browser speech-to-text transcriber powered by NVIDIA Parakeet TDT 0.6B v3.
 *
 * Implements the Transcriber contract purely in TypeScript via parakeet.js on onnxruntime-web.
 * Runs directly on client hardware using WebGPU when supported, with seamless automatic fallback
 * to WASM when WebGPU is absent or fails initialization.
 *
 * Zero external servers, zero Python daemons, zero native binaries.
 */

import type {
  FinalTranscriptCallback,
  PartialTranscriptCallback,
  Transcriber,
  TranscriberErrorCallback,
  TranscriberOptions,
  TranscriptEvent,
} from "./transcriber"
import { createMicCapture, type MicCapture, type MicCaptureOptions } from "../audio/capture"
import { requestPersistentStorage } from "./model-cache"
import { bundledOrtPaths } from "./ort-assets"
import { t } from "@nikcli-ai/ade/i18n"

// ---------------------------------------------------------------------------
// Availability Probes
// ---------------------------------------------------------------------------

/**
 * Checks whether the WebGPU API is present in the current host environment.
 */
export function isWebGpuAvailable(): boolean {
  if (typeof navigator === "undefined") return false
  return Boolean((navigator as any).gpu)
}

/**
 * Checks whether WebAssembly is supported in the current JavaScript runtime.
 */
export function isWasmAvailable(): boolean {
  return typeof WebAssembly !== "undefined" && typeof WebAssembly.validate === "function"
}

export interface ParakeetReadiness {
  usable: boolean
  reason?: string
}

/**
 * Describes whether local Parakeet transcription is usable now.
 * Distinguishes between lack of hardware/runtime support (neither WebGPU nor WASM)
 * and pending initial model download.
 */
export function describeParakeetReadiness(options?: { isModelDownloaded?: boolean }): ParakeetReadiness {
  const hasGpu = isWebGpuAvailable()
  const hasWasm = isWasmAvailable()

  if (!hasGpu && !hasWasm) {
    return {
      usable: false,
      reason: t("vui.asr.noRuntime"),
    }
  }

  if (options?.isModelDownloaded === false) {
    return {
      usable: false,
      reason: t("vui.asr.notDownloaded"),
    }
  }

  return { usable: true }
}

// ---------------------------------------------------------------------------
// Parakeet Types & Options
// ---------------------------------------------------------------------------

export type ParakeetBackend = "webgpu" | "wasm"

export interface ParakeetProgress {
  loaded: number
  total: number
  file?: string
  percent?: number
  message: string
}

export type ParakeetProgressCallback = (progress: ParakeetProgress) => void

export interface ParakeetTranscriberOptions extends TranscriberOptions {
  /** Progress callback reporting model download and readiness in Italian. */
  onProgress?: ParakeetProgressCallback
  /** Callback fired when the active acceleration backend is determined. */
  onBackendChange?: (backend: ParakeetBackend) => void
  /** Optional pre-existing MicCapture instance. If omitted, createMicCapture() is used. */
  capture?: MicCapture
  /** Options passed to createMicCapture when capture is not pre-supplied. */
  captureOptions?: MicCaptureOptions
  /**
   * parakeet.js model key or Hugging Face repo id (default: 'parakeet-tdt-0.6b-v3').
   *
   * A key, not NVIDIA's own repo name. parakeet.js only knows the ONNX exports
   * it ships a config for, and it answers every question about an id it does
   * not recognise — including "does this model speak Italian?" — with no. So
   * 'nvidia/parakeet-tdt-0.6b-v3', which reads like the right answer, made the
   * local engine refuse to start on a model that supports thirteen languages.
   */
  modelId?: string
  /**
   * ISO-639-1 code the user chose, from `VoiceSettings.language`.
   *
   * The coverage check below used to ask about `"it"` whatever the user had
   * picked, so a model that speaks the chosen language but not Italian was
   * refused, and one that speaks Italian but not the chosen language was
   * accepted and then transcribed badly. "auto" skips the check, because
   * there is no single code to ask about.
   */
  language?: string
  /**
   * Which accelerator to use: 'auto' tries WebGPU and falls back to WASM.
   *
   * Worth forcing, because the two are not the same model. WebGPU cannot run
   * the int8 encoder, so parakeet.js silently substitutes the fp32 one — around
   * four times the weights, for the same transcription. Where that does not
   * fit, 'wasm' is not a downgrade so much as the only build that loads.
   */
  executionBackend?: "auto" | "webgpu" | "wasm"
  /**
   * Where the ONNX runtime's own `.wasm` and glue live.
   *
   * This is not the model — it is the inference engine, 13 to 26 MB of
   * WebAssembly that has to be there before a single weight can be read.
   * parakeet.js, finding `ort.env.wasm.wasmPaths` unset, points it at
   * jsDelivr; the consequences are that the local engine cannot start without
   * a network (which is the one thing it exists to promise), that the file is
   * re-fetched whenever the HTTP cache lets go of it, and that in the packaged
   * application the content-security policy does not list that host as a
   * script source.
   *
   * Passed in rather than resolved here because only the bundler knows the
   * URL: ADE hands over the assets Vite emitted alongside its own code. Either
   * a directory prefix, or onnxruntime's `{ wasm, mjs }` map.
   */
  wasmPaths?: string | Record<string, string>
  /**
   * Whether to ask the browser to keep the downloaded model.
   *
   * On by default. Storage that has not been marked persistent is evicted
   * first when the disk fills, and the model is the largest thing in it — so
   * the default answer to "why has it downloaded again?" was an eviction
   * nobody asked for and nothing recorded.
   */
  persistStorage?: boolean
  /** Dependency injection hook for fromHub from parakeet.js. */
  /**
   * Whether to keep the loaded ONNX model warm in memory across sessions.
   * Defaults to true in production so repeated push-to-talk / widget activations
   * start instantaneously without reloading the 640 MB model every time.
   */
  keepWarm?: boolean
  /** Dependency injection hook for fromHub from parakeet.js. */
  fromHub?: any
  /** Dependency injection hook for supportsLanguage from parakeet.js. */
  supportsLanguage?: any
  /** Dependency injection hook for getModelConfig from parakeet.js. */
  getModelConfig?: any
}

export interface ParakeetTranscriber extends Transcriber {
  /** The backend currently active ('webgpu', 'wasm', or null if uninitialized). */
  readonly activeBackend: ParakeetBackend | null
  /** Human-readable Italian description of preparation/running status. */
  readonly statusMessage: string
  /** Whether the neural model is ready for real-time transcription. */
  readonly isReady: boolean
  /** Underlying microphone capture adapter. */
  readonly capture: MicCapture
  /** Warm up the model in memory without starting microphone capture. */
  warmup(): Promise<void>
  /** Whether audio processing or transcription is currently in flight. */
  readonly hasInFlight: boolean
  /** Explicitly start recording an utterance segment on push-to-talk press. */
  startSegment(): void
  /** Explicitly commit and finalize active utterance segment on push-to-talk release. */
  commit(): boolean
}

// ---------------------------------------------------------------------------
// Library Resolution Helper
// ---------------------------------------------------------------------------

/**
 * Points the ONNX runtime at the bundled WebAssembly instead of a CDN.
 *
 * Must run before the first `fromHub`: parakeet.js only substitutes its
 * jsDelivr URL when `wasmPaths` is still unset, so setting it here wins, and
 * setting it afterwards changes nothing. The import is the same module
 * instance parakeet.js resolves — the bundler dedupes it — which is what makes
 * writing to `env` from outside the library work at all.
 *
 * Failure is not fatal and is not reported: the runtime then falls back to the
 * CDN, which works on a connected machine and is exactly the behaviour that
 * existed before. What it must not do is stop the engine from starting.
 */
async function applyWasmPaths(given: string | Record<string, string> | undefined): Promise<void> {
  const paths = given ?? (await bundledOrtPaths())
  if (!paths) return
  try {
    const ort: any = await import("onnxruntime-web")
    const env = ort?.env ?? ort?.default?.env
    if (env?.wasm && !env.wasm.wasmPaths) env.wasm.wasmPaths = paths
  } catch {
    // No runtime to configure; `resolveParakeetLib` reports the real problem.
  }
}

/**
 * Gives back the memory the loaded model is holding.
 *
 * There is no `dispose()` and no `destroy()` on a `ParakeetModel` — stopping
 * used to try both and, finding neither, drop the reference and call it done.
 * A dropped reference is not a release: what the model holds is two
 * `InferenceSession`s (plus a third inside the ONNX preprocessor), each with
 * weights and, on WebGPU, device buffers that the garbage collector does not
 * own. So every stop-and-start left the previous copy in place and allocated a
 * fresh multi-gigabyte one beside it, which is how the renderer got past four
 * gigabytes and stopped answering.
 *
 * `release()` is onnxruntime's own name for this, and it is what the sessions
 * actually respond to.
 */
async function releaseModel(model: any): Promise<void> {
  const sessions = [model?.encoderSession, model?.joinerSession, model?.preprocessor?.session]
  for (const session of sessions) {
    try {
      if (session && typeof session.release === "function") await session.release()
    } catch {
      // A session that refuses to release is nothing the caller can act on,
      // and the rest must still be tried.
    }
  }
  // Kept for a future version of the library that grows one of these.
  try {
    if (typeof model?.dispose === "function") await model.dispose()
    else if (typeof model?.destroy === "function") await model.destroy()
  } catch {
    // ignore
  }
}

async function resolveParakeetLib(options: ParakeetTranscriberOptions) {
  if (options.fromHub && options.supportsLanguage) {
    return {
      fromHub: options.fromHub,
      supportsLanguage: options.supportsLanguage,
      getModelConfig: options.getModelConfig,
    }
  }

  try {
    const pkg = await import("parakeet.js")
    return {
      fromHub: options.fromHub ?? pkg.fromHub,
      supportsLanguage: options.supportsLanguage ?? pkg.supportsLanguage,
      getModelConfig: options.getModelConfig ?? pkg.getModelConfig,
    }
  } catch (err: any) {
    if (options.fromHub) {
      return {
        fromHub: options.fromHub,
        supportsLanguage: options.supportsLanguage ?? (() => true),
        getModelConfig: options.getModelConfig,
      }
    }
    throw new Error(
      `Libreria parakeet.js non trovata. Installa 'parakeet.js' e 'onnxruntime-web' per abilitare la trascrizione locale: ${err?.message ?? "modulo mancante"}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Parakeet Transcriber Factory & Shared Memory Cache
// ---------------------------------------------------------------------------

interface SharedParakeetState {
  model: any
  modelId: string
  activeBackend: ParakeetBackend
  initPromise?: Promise<{ model: any; activeBackend: ParakeetBackend }>
}

let globalSharedParakeet: SharedParakeetState | null = null

export function createParakeetTranscriber(options: ParakeetTranscriberOptions = {}): ParakeetTranscriber {
  const modelId = options.modelId ?? "parakeet-tdt-0.6b-v3"

  let partialCb: PartialTranscriptCallback = options.onPartial ?? (() => {})
  let finalCb: FinalTranscriptCallback = options.onFinal ?? (() => {})
  let errorCb: TranscriberErrorCallback = options.onError ?? (() => {})
  let progressCb: ParakeetProgressCallback = options.onProgress ?? (() => {})

  const micCapture: MicCapture = options.capture ?? createMicCapture(options.captureOptions)

  const isCustomMock = Boolean(options.fromHub)
  const keepWarm = options.keepWarm ?? !isCustomMock

  let activeBackend: ParakeetBackend | null = null
  let statusMessage = "In attesa di avvio..."
  let model: any = null
  let streamingTranscriber: any = null
  let userStopped = true

  async function initializeModel(): Promise<void> {
    if (model) return

    const preference = options.executionBackend ?? "auto"

    // 1. Instant re-use of already initialized neural model in RAM (0ms delay)
    if (keepWarm && globalSharedParakeet?.model) {
      const cached = globalSharedParakeet
      const matchesBackend =
        preference === "auto" ||
        preference === cached.activeBackend ||
        (preference === "webgpu" && cached.activeBackend === "webgpu") ||
        (preference === "wasm" && cached.activeBackend === "wasm")

      if (cached.modelId === modelId && matchesBackend) {
        model = cached.model
        activeBackend = cached.activeBackend
        statusMessage = `Modello Parakeet pronto (${activeBackend}).`
        options.onBackendChange?.(activeBackend)
        return
      }
    }

    // 2. Await in-flight model initialization if already warming up
    if (keepWarm && globalSharedParakeet?.initPromise) {
      try {
        const res = await globalSharedParakeet.initPromise
        model = res.model
        activeBackend = res.activeBackend
        statusMessage = `Modello Parakeet pronto (${activeBackend}).`
        options.onBackendChange?.(activeBackend)
        return
      } catch {
        // Fall through to retry loading
      }
    }

    const doLoad = async (): Promise<{ model: any; activeBackend: ParakeetBackend }> => {
      await applyWasmPaths(options.wasmPaths)

      /*
       * Asked before the download, not after: marking storage persistent once it
       * is full of weights is a request the browser may refuse precisely because
       * of how much is in there.
       */
      if (options.persistStorage !== false) {
        await requestPersistentStorage()
      }

      const { fromHub, supportsLanguage } = await resolveParakeetLib(options)

      // Verify coverage of the language the user actually chose.
      const wanted = (options.language ?? "it").trim().toLowerCase()
      if (typeof supportsLanguage === "function" && wanted.length > 0 && wanted !== "auto") {
        const isSupported = supportsLanguage(modelId, wanted)

        if (!isSupported) {
          throw new Error(`Il modello Parakeet non supporta la lingua scelta ('${wanted}').`)
        }
      }

      const progressBridge = (p: { loaded: number; total: number; file?: string }) => {
        const percent = p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : undefined
        const msg =
          percent !== undefined
            ? `Scaricamento del modello Parakeet: ${percent}%...`
            : "Preparazione del modello di trascrizione vocale locale in corso..."
        statusMessage = msg
        progressCb({
          loaded: p.loaded,
          total: p.total,
          file: p.file,
          percent,
          message: msg,
        })
      }

      statusMessage = "Preparazione del modello di trascrizione vocale locale in corso..."
      progressCb({
        loaded: 0,
        total: 100,
        percent: 0,
        message: statusMessage,
      })

      let loadedModel: any = null
      let resolvedBackend: ParakeetBackend | null = null
      let gpuFailure: string | undefined

      /*
       * Model quantization selection:
       * Parakeet TDT 0.6B INT8 quantized weights are ~640 MB total (622 MB encoder + 18 MB decoder).
       * In parakeet.js, when backend is 'webgpu' and encoderQuant is 'int8', parakeet.js explicitly
       * forces the encoder to FP32 (~3.9 GB download and 4+ GB memory footprint).
       *
       * To prevent 4 GB downloads and memory exhaustion:
       * - WebGPU attempts use 'fp16' (~1.2 GB, preventing the 4 GB fp32 unquantized download).
       * - WebAssembly uses 'int8' (~640 MB total, running on multithreaded SIMD WASM).
       */

      // 1. Attempt WebGPU execution if supported and not ruled out by preference
      if (preference !== "wasm" && isWebGpuAvailable()) {
        try {
          loadedModel = await fromHub(modelId, {
            backend: "webgpu",
            encoderQuant: "fp16",
            decoderQuant: "int8",
            progress: progressBridge,
          })
          resolvedBackend = "webgpu"
        } catch (gpuErr: any) {
          // WebGPU failed during runtime initialization; proceed to WASM fallback
          loadedModel = null
          resolvedBackend = null
          gpuFailure = gpuErr?.message ?? "errore sconosciuto"
        }
      }

      if (!loadedModel && preference === "webgpu") {
        statusMessage = "Inizializzazione fallita"
        throw new Error(
          `WebGPU è stato richiesto esplicitamente ma non è riuscito a inizializzarsi${
            gpuFailure ? ` (${gpuFailure})` : ""
          }. Scegli 'automatico' o 'WASM' nelle impostazioni vocali.`,
        )
      }

      // 2. Fallback or primary WebAssembly execution with lightweight INT8 quantization (~640 MB)
      if (!loadedModel) {
        statusMessage =
          preference === "wasm"
            ? "Inizializzazione del modello quantizzato INT8 su WASM (~640 MB)..."
            : gpuFailure
              ? `WebGPU non disponibile (${gpuFailure}). Avvio con WASM quantizzato INT8 (~640 MB)...`
              : "Inizializzazione con ripiego su WASM quantizzato INT8 (~640 MB)..."
        progressCb({
          loaded: 0,
          total: 100,
          message: statusMessage,
        })

        try {
          loadedModel = await fromHub(modelId, {
            backend: "wasm",
            encoderQuant: "int8",
            decoderQuant: "int8",
            progress: progressBridge,
          })
          resolvedBackend = "wasm"
        } catch (wasmErr: any) {
          statusMessage = "Inizializzazione fallita"
          throw new Error(
            `Impossibile inizializzare il modello Parakeet sia con WebGPU che con WASM: ${wasmErr?.message ?? "errore sconosciuto"}`,
          )
        }
      }

      return { model: loadedModel, activeBackend: resolvedBackend! }
    }

    if (keepWarm) {
      const p = doLoad()
      globalSharedParakeet = {
        model: null,
        modelId,
        activeBackend: "wasm",
        initPromise: p,
      }
      try {
        const res = await p
        globalSharedParakeet = {
          model: res.model,
          modelId,
          activeBackend: res.activeBackend,
        }
        model = res.model
        activeBackend = res.activeBackend
      } catch (err) {
        globalSharedParakeet = null
        throw err
      }
    } else {
      const res = await doLoad()
      model = res.model
      activeBackend = res.activeBackend
    }

    options.onBackendChange?.(activeBackend!)
    statusMessage = `Modello Parakeet pronto (${activeBackend}).`
  }

  /**
   * One thing at a time, in the order it was spoken.
   *
   * The capture delivers PCM from a synchronous audio callback and does not
   * wait for the handler, while `processChunk` is asynchronous and the
   * streaming transcriber it talks to is a stateful object that mutates its
   * decoder state and its offset across every `await`. So several chunks used
   * to be in flight against it at once, interleaving their state — and the
   * end of an utterance was worse: `finalize()` and `reset()` ran immediately
   * on speech end, while chunks were still resolving, so their words landed in
   * the transcriber *after* the reset and came out prefixed to the next
   * sentence.
   *
   * A chain is the whole fix. Every unit of work is appended to it, which
   * makes the order the spoken order and puts the finalisation after the last
   * chunk it is supposed to include. Nothing is dropped and nothing overlaps.
   */
  let work: Promise<void> = Promise.resolve()
  let inFlightTasks = 0
  let isSegmentActive = false
  let receivedPcmChunks = 0
  let isFinalizing = false

  const enqueue = (task: () => Promise<void>): void => {
    inFlightTasks++
    work = work
      .then(async () => {
        try {
          await task()
        } finally {
          inFlightTasks = Math.max(0, inFlightTasks - 1)
        }
      })
      .catch(() => {
        inFlightTasks = Math.max(0, inFlightTasks - 1)
      })
  }

  function finalizeSegment(): void {
    if (userStopped || !streamingTranscriber || isFinalizing) return
    isFinalizing = true
    isSegmentActive = false

    enqueue(async () => {
      try {
        if (userStopped || !streamingTranscriber) return
        const end = await streamingTranscriber.finalize()
        const text = (end && typeof end.text === "string" ? end.text : "").trim()
        finalCb({
          text,
          isFinal: true,
          confidence: 1.0,
        })
      } catch (err: any) {
        errorCb(new Error(`Errore finalizzazione trascrizione Parakeet: ${err?.message ?? "sconosciuto"}`))
      } finally {
        isFinalizing = false
        receivedPcmChunks = 0
        try {
          streamingTranscriber?.reset()
        } catch {
          // ignore
        }
      }
    })
  }

  // Bind microphone capture outputs
  micCapture.onPcmChunk((chunk: Float32Array) => {
    if (userStopped || !streamingTranscriber) return
    receivedPcmChunks++
    enqueue(async () => {
      if (userStopped || !streamingTranscriber) return
      try {
        const r = await streamingTranscriber.processChunk(chunk)
        if (r && typeof r.text === "string" && r.text.trim()) {
          partialCb(r.text.trim())
        }
      } catch (err: any) {
        errorCb(new Error(`Errore elaborazione chunk audio Parakeet: ${err?.message ?? "sconosciuto"}`))
      }
    })
  })

  micCapture.onSpeechEnd(() => {
    if (userStopped || !streamingTranscriber || receivedPcmChunks === 0 || isFinalizing) return
    finalizeSegment()
  })

  micCapture.onError((err: Error) => {
    errorCb(err)
  })

  return {
    get activeBackend(): ParakeetBackend | null {
      return activeBackend
    },

    get statusMessage(): string {
      return statusMessage
    },

    get isReady(): boolean {
      return Boolean((model || globalSharedParakeet?.model) && streamingTranscriber)
    },

    get hasInFlight(): boolean {
      return inFlightTasks > 0 || isFinalizing
    },

    get capture(): MicCapture {
      return micCapture
    },

    startSegment(): void {
      isSegmentActive = true
      receivedPcmChunks = 0
      isFinalizing = false
      if (streamingTranscriber) {
        try {
          streamingTranscriber.reset()
        } catch {
          // ignore
        }
      }
      micCapture.startSegment?.()
    },

    commit(): boolean {
      if (userStopped || !streamingTranscriber) return false
      if (isFinalizing) return false
      if (receivedPcmChunks === 0 && !isSegmentActive) return false
      micCapture.commitSegment?.()
      finalizeSegment()
      return true
    },

    finish(): void {
      // Finalisation is queued before the microphone goes, and `stop()` —
      // which resets the streaming state — is left for after it has run.
      this.commit()
      micCapture.stop()
    },

    async warmup(): Promise<void> {
      await initializeModel()
    },

    async start(): Promise<void> {
      userStopped = false
      isFinalizing = false
      isSegmentActive = false
      receivedPcmChunks = 0
      try {
        await initializeModel()
        streamingTranscriber = model.createStreamingTranscriber({ sampleRate: 16000 })
        await micCapture.start()
      } catch (err: any) {
        userStopped = true
        statusMessage = "Avvio fallito"
        const failure = new Error(
          `Errore durante l'avvio della trascrizione Parakeet: ${err?.message ?? "sconosciuto"}`,
        )
        errorCb(failure)
        /*
         * Reported AND rethrown. Swallowing it left start() resolving on a
         * transcriber with no model and no open microphone, so the caller set
         * itself to "listening" and waited for audio that could never arrive.
         */
        throw failure
      }
    },

    async stop(): Promise<void> {
      userStopped = true
      isFinalizing = false
      isSegmentActive = false
      receivedPcmChunks = 0
      micCapture.stop()

      if (streamingTranscriber) {
        try {
          streamingTranscriber.reset()
        } catch {
          // ignore
        }
        streamingTranscriber = null
      }

      const shouldRelease = options.keepWarm === false || (isCustomMock && options.keepWarm !== true)
      if (shouldRelease && model) {
        await releaseModel(model)
        model = null
        activeBackend = null
      }

      statusMessage = "Fermato"
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

/**
 * Frees the in-memory shared Parakeet neural model weights and ONNX sessions.
 */
export async function disposeParakeetModel(): Promise<void> {
  if (globalSharedParakeet?.model) {
    await releaseModel(globalSharedParakeet.model)
  }
  globalSharedParakeet = null
}

/**
 * Checks whether the Parakeet neural model is currently loaded and ready in memory.
 */
export function isParakeetModelWarmedUp(modelId = "parakeet-tdt-0.6b-v3"): boolean {
  return Boolean(globalSharedParakeet?.model && globalSharedParakeet.modelId === modelId)
}

export interface WarmupParakeetOptions extends ParakeetTranscriberOptions {
  /**
   * If true (default), only warm up if the model is already downloaded locally,
   * avoiding accidental background downloads.
   */
  onlyIfDownloaded?: boolean
}

/**
 * Preloads and warms up the Parakeet model into memory in the background,
 * so subsequent activations start instantly with 0ms delay.
 */
export async function warmupParakeetModel(options: WarmupParakeetOptions = {}): Promise<void> {
  const modelId = options.modelId ?? "parakeet-tdt-0.6b-v3"
  const preference = options.executionBackend ?? "auto"

  if (globalSharedParakeet?.model && globalSharedParakeet.modelId === modelId) {
    const cachedBackend = globalSharedParakeet.activeBackend
    const matchesBackend =
      preference === "auto" ||
      preference === cachedBackend ||
      (preference === "webgpu" && cachedBackend === "webgpu") ||
      (preference === "wasm" && cachedBackend === "wasm")
    if (matchesBackend) return
  }

  if (globalSharedParakeet?.initPromise) {
    try {
      await globalSharedParakeet.initPromise
      return
    } catch {
      // ignore
    }
  }

  if (options.onlyIfDownloaded !== false) {
    try {
      const { inspectModelCache } = await import("./model-cache")
      const cache = await inspectModelCache()
      if (!cache.present) {
        return
      }
    } catch {
      return
    }
  }

  const transcriber = createParakeetTranscriber({
    ...options,
    keepWarm: true,
  })
  await transcriber.warmup()
}
