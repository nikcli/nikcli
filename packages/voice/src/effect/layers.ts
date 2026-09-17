/**
 * Effect Layers wrapping existing concrete implementations with resource safety.
 *
 * Why this file exists:
 * In the legacy implementation, resource cleanup (closing AudioContext, terminating
 * MediaStream tracks, and unloading neural model weights in Parakeet) depended entirely
 * on the caller manually remembering to invoke `stop()`. If an error occurred midway,
 * or if a component was unmounted abruptly, the hardware microphone remained locked
 * and memory was leaked.
 *
 * Here, microphone capture, AudioContext, and Parakeet neural models are acquired via
 * `Effect.acquireRelease` inside a managed `Scope`. Release is strictly guaranteed by
 * the Effect runtime even if the surrounding program fails, aborts, or is interrupted.
 */

import { Effect, Layer, Option, Queue, Stream, type Scope } from "effect"
import type { VoiceHost } from "../bridge/host"
import type { TranscriptEvent, Transcriber as TranscriberContract } from "../asr/transcriber"
import {
  createParakeetTranscriber,
  describeParakeetReadiness,
  type ParakeetTranscriberOptions,
} from "../asr/parakeet-local"
import { createOpenRouterTranscriber, type OpenRouterTranscriberOptions } from "../asr/openrouter"
import type { SelectTranscriberOptions, TranscriberBackend } from "../asr/select"
import { createMicCapture, type CapturedSegment, type MicCaptureOptions } from "../audio/capture"
import {
  createWebSpeechSpeaker,
  createFakeSpeaker,
  type FakeSpeaker,
  type WebSpeechSpeakerOptions,
} from "../tts/speaker"
import { createFakeTranscriber, type FakeTranscriber } from "../asr/fake"

import {
  ApiKeyInvalid,
  ApiKeyMissing,
  AudioFormatUnsupported,
  HostActionFailed,
  MicPermissionDenied,
  MicUnavailable,
  ModelLoadFailed,
  QuotaExhausted,
  RequestTimeout,
  SpeechRecognitionUnavailable,
  TranscriptionFailed,
  type VoiceError,
} from "./errors"
import {
  MicCapture,
  Speaker,
  Transcriber,
  VoiceHostService,
  type MicCaptureService,
  type SpeakerService,
  type TranscriberEvent,
  type TranscriberService,
} from "./services"

/**
 * Maps arbitrary runtime errors or error strings into typed VoiceError tagged instances.
 */
export function mapToVoiceError(err: unknown): VoiceError {
  if (err && typeof err === "object" && "_tag" in err) {
    return err as VoiceError
  }
  const msg = err instanceof Error ? err.message : String(err ?? "")
  const lower = msg.toLowerCase()

  if (lower.includes("negato") || lower.includes("notallowederror") || lower.includes("permissiondenied")) {
    return new MicPermissionDenied({ message: msg, cause: err })
  }
  if (
    lower.includes("nessun microfono") ||
    lower.includes("notfounderror") ||
    lower.includes("devicesnotfound") ||
    lower.includes("non supportato in questo browser")
  ) {
    return new MicUnavailable({ message: msg, cause: err })
  }
  if (lower.includes("nessun formato audio")) {
    return new AudioFormatUnsupported({
      attemptedFormats: ["audio/webm;codecs=opus", "audio/mp4"],
      message: msg,
    })
  }
  if (lower.includes("riconoscimento vocale non supportato") || lower.includes("speechrecognition")) {
    return new SpeechRecognitionUnavailable({ message: msg })
  }
  if (lower.includes("chiave api openrouter mancante")) {
    return new ApiKeyMissing({ message: msg })
  }
  if (
    lower.includes("autenticazione openrouter fallita") ||
    lower.includes("la chiave openrouter non funziona") ||
    lower.includes("401")
  ) {
    return new ApiKeyInvalid({ message: msg, cause: err })
  }
  if (
    lower.includes("credito openrouter esaurito") ||
    lower.includes("credito openrouter è finito") ||
    lower.includes("402")
  ) {
    return new QuotaExhausted({ message: msg, cause: err })
  }
  if (lower.includes("timeout") || lower.includes("scaduta per timeout") || lower.includes("non ha risposto in")) {
    return new RequestTimeout({ message: msg })
  }
  if (lower.includes("parakeet")) {
    return new ModelLoadFailed({ backend: "parakeet", message: msg, cause: err })
  }
  return new TranscriptionFailed({ cause: err, message: msg })
}

/**
 * Bridges any concrete Transcriber implementation into the typed TranscriberService,
 * acquiring and releasing it within a managed Effect Scope.
 */
export function bridgeTranscriber(
  transcriber: TranscriberContract,
  mapErr: (err: unknown) => VoiceError = mapToVoiceError,
  onRawError?: (err: Error) => void,
): Effect.Effect<TranscriberService, VoiceError, Scope.Scope> {
  return Effect.gen(function* () {
    const eventsQueue = yield* Queue.unbounded<TranscriberEvent>()

    /*
     * Subscribed before start(), not after. Starting a local neural backend
     * means downloading and initialising a model, and everything that can go
     * wrong there is reported through onError rather than by rejecting — so a
     * listener attached afterwards hears nothing, and the engine reports
     * "listening" to a user talking to a transcriber that never came up.
     */
    transcriber.onPartial((text) => {
      Effect.runSync(Queue.offer(eventsQueue, { _tag: "partial", text }))
    })

    transcriber.onFinal((event) => {
      Effect.runSync(Queue.offer(eventsQueue, { _tag: "final", event }))
    })

    transcriber.onError((error) => {
      onRawError?.(error)
      const vError = mapErr(error)
      Effect.runSync(Queue.offer(eventsQueue, { _tag: "error", error: vError }))
    })

    /*
     * Started here, and released with the scope.
     *
     * Note what `acquireRelease` does *not* cover: an acquire that fails
     * registers no finalizer, so a `start()` that opens the microphone and
     * then throws — a model that will not load, an audio graph that refuses to
     * build — leaves the hardware open with nothing holding a reference to
     * close it. That is why `createMicCapture().start()` releases its own
     * stream on failure rather than relying on this.
     */
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => Promise.resolve(transcriber.start()),
        catch: (err) => mapErr(err),
      }),
      () => Effect.promise(() => Promise.resolve(transcriber.stop())),
    )

    const eventsStream = Stream.fromQueue(eventsQueue)

    const finals = eventsStream.pipe(
      Stream.filter((e): e is { readonly _tag: "final"; readonly event: TranscriptEvent } => e._tag === "final"),
      Stream.map((e) => e.event),
    )

    const partials = eventsStream.pipe(
      Stream.filter((e): e is { readonly _tag: "partial"; readonly text: string } => e._tag === "partial"),
      Stream.map((e) => e.text),
    )

    const stream = eventsStream.pipe(
      Stream.filterMap((e) => {
        if (e._tag === "final") return Option.some(e.event)
        if (e._tag === "partial") return Option.some({ text: e.text, isFinal: false })
        return Option.none()
      }),
    )

    return {
      /*
       * Already running by the time anyone can hold this.
       *
       * `start` used to be a second, independent `transcriber.start()` sitting
       * on the returned service — a loaded gun: calling it would open a second
       * `getUserMedia` stream on the same transcriber with no way to close the
       * first. It is kept because the service's shape is part of the
       * contract, and made a no-op because starting twice is never what the
       * caller means. Closing the scope is how a session ends.
       */
      start: Effect.void,
      stop: Effect.promise(() => Promise.resolve(transcriber.stop())),
      idle: Effect.map(Queue.size(eventsQueue), (size) => size <= 0),
      events: eventsStream,
      finals,
      partials,
      stream,
    }
  })
}

// ---------------------------------------------------------------------------
// 1. Microphone Hardware Capture Layer
// ---------------------------------------------------------------------------

export const MicCaptureLive = (options?: MicCaptureOptions): Layer.Layer<MicCaptureService, VoiceError> =>
  Layer.scoped(
    MicCapture,
    Effect.gen(function* () {
      const capture = createMicCapture(options)
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => capture.start(),
          catch: (err) => mapToVoiceError(err),
        }),
        () => Effect.sync(() => capture.stop()),
      )

      const levelsQueue = yield* Queue.sliding<number>(16)
      const pcmQueue = yield* Queue.sliding<Float32Array>(16)
      const segmentsQueue = yield* Queue.unbounded<CapturedSegment>()

      capture.onLevel((lvl) => {
        Effect.runSync(Queue.offer(levelsQueue, lvl))
      })
      capture.onPcmChunk((chunk) => {
        Effect.runSync(Queue.offer(pcmQueue, chunk))
      })
      capture.onSegment((seg) => {
        Effect.runPromise(Queue.offer(segmentsQueue, seg))
      })

      return {
        start: Effect.tryPromise({
          try: () => capture.start(),
          catch: (err) => mapToVoiceError(err),
        }),
        stop: Effect.sync(() => capture.stop()),
        levels: Stream.fromQueue(levelsQueue),
        pcmChunks: Stream.fromQueue(pcmQueue),
        segments: Stream.fromQueue(segmentsQueue),
      }
    }),
  )

// ---------------------------------------------------------------------------
// 2. Transcriber Concrete Implementations as Scoped Layers
// ---------------------------------------------------------------------------

export const TranscriberParakeetLive = (
  options?: ParakeetTranscriberOptions,
): Layer.Layer<TranscriberService, VoiceError> =>
  Layer.scoped(
    Transcriber,
    Effect.gen(function* () {
      const readiness = describeParakeetReadiness()
      if (!readiness.usable) {
        return yield* Effect.fail(
          new ModelLoadFailed({
            backend: "parakeet",
            message: readiness.reason ?? "Parakeet non disponibile.",
          }),
        )
      }
      const transcriber = createParakeetTranscriber(options)
      return yield* bridgeTranscriber(transcriber)
    }),
  )

export const TranscriberOpenRouterLive = (
  options: OpenRouterTranscriberOptions,
): Layer.Layer<TranscriberService, VoiceError> =>
  Layer.scoped(
    Transcriber,
    Effect.gen(function* () {
      if (!options.apiKey || options.apiKey.trim().length === 0) {
        return yield* Effect.fail(
          new ApiKeyMissing({
            message: "Chiave API OpenRouter mancante. Specificare una chiave valida.",
          }),
        )
      }
      const transcriber = createOpenRouterTranscriber(options)
      return yield* bridgeTranscriber(transcriber)
    }),
  )

export const TranscriberFake = (fake?: FakeTranscriber): Layer.Layer<TranscriberService, VoiceError> => {
  const instance = fake ?? createFakeTranscriber()
  return Layer.scoped(Transcriber, bridgeTranscriber(instance))
}

// ---------------------------------------------------------------------------
// 3. Backend Choice Layer
// ---------------------------------------------------------------------------

export const TranscriberSelectLive = (
  backend: TranscriberBackend,
  options: SelectTranscriberOptions = {},
): Layer.Layer<TranscriberService, VoiceError> => {
  switch (backend) {
    case "parakeet":
      return TranscriberParakeetLive(options.parakeetOptions)
    case "openrouter": {
      const apiKey = options.apiKey ?? options.openRouterOptions?.apiKey ?? ""
      return TranscriberOpenRouterLive({
        ...options.openRouterOptions,
        apiKey,
      })
    }
    default:
      return Layer.fail(
        new HostActionFailed({
          action: "select_backend",
          message: `Backend di trascrizione non riconosciuto: ${backend}`,
        }),
      )
  }
}

// ---------------------------------------------------------------------------
// 4. Speaker Layers (Live & Fake for Tests)
// ---------------------------------------------------------------------------

export const SpeakerLive = (options?: WebSpeechSpeakerOptions): Layer.Layer<SpeakerService> =>
  Layer.sync(Speaker, () => {
    const speaker = createWebSpeechSpeaker(options)
    return {
      speak: (text: string) =>
        Effect.tryPromise({
          try: () => Promise.resolve(speaker.speak(text)),
          catch: (err) =>
            new HostActionFailed({
              action: "speak",
              cause: err,
              message: "Errore durante la sintesi vocale.",
            }),
        }),
      cancel: Effect.sync(() => speaker.cancel()),
    }
  })

export const SpeakerFake = (fake?: FakeSpeaker): Layer.Layer<SpeakerService> => {
  const instance = fake ?? createFakeSpeaker()
  return Layer.succeed(Speaker, {
    speak: (text: string) =>
      Effect.sync(() => {
        instance.speak(text)
      }),
    cancel: Effect.sync(() => instance.cancel()),
  })
}

// ---------------------------------------------------------------------------
// 5. Host Layer
// ---------------------------------------------------------------------------

export const VoiceHostLive = (host: VoiceHost): Layer.Layer<VoiceHost> => Layer.succeed(VoiceHostService, host)
