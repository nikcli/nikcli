import { Context, Effect, Stream } from "effect"
import type { VoiceHost } from "../bridge/host"
import type { TranscriptEvent } from "../asr/transcriber"
import type { CapturedSegment } from "../audio/capture"
import type { VoiceError } from "./errors"

/**
 * Event discriminated union emitted by transcriber event streams.
 */
export type TranscriberEvent =
  | { readonly _tag: "partial"; readonly text: string }
  | { readonly _tag: "final"; readonly event: TranscriptEvent }
  | { readonly _tag: "error"; readonly error: VoiceError }

/**
 * Transcriber service interface.
 * Exposes lifecycle controls and reactive event streams for interim and final hypotheses.
 */
export interface TranscriberService {
  /** Start listening for spoken input. */
  readonly start: Effect.Effect<void, VoiceError>
  /** Stop listening and release active recognition handles. */
  readonly stop: Effect.Effect<void>
  /** Stream of finalized transcript events. */
  readonly finals: Stream.Stream<TranscriptEvent, VoiceError>
  /** Stream of interim/partial transcript hypotheses. */
  readonly partials: Stream.Stream<string, VoiceError>
  /** Combined stream of all transcript events (both partial and final). */
  readonly stream: Stream.Stream<TranscriptEvent, VoiceError>
  /** Unified event stream preserving failures inline so processing loops never terminate on error. */
  readonly events: Stream.Stream<TranscriberEvent, never>
  /**
   * Whether every event produced so far has been taken off the stream.
   *
   * Optional, because a hand-built service in a test has no queue to ask.
   * A session that is ending waits on this so a final transcript that has
   * arrived but not yet been read is not dropped with the scope.
   */
  readonly idle?: Effect.Effect<boolean>
}

export const Transcriber = Context.GenericTag<TranscriberService>("@nikcli-ai/voice/Transcriber")

/**
 * Text-to-speech speaker service interface.
 */
export interface SpeakerService {
  /** Synthesize and speak the given text aloud. */
  readonly speak: (text: string) => Effect.Effect<void, VoiceError>
  /** Immediately cancel active or queued speech. */
  readonly cancel: Effect.Effect<void>
  /**
   * Say this after whatever is being said, for a reply read in pieces as it is
   * written. Completes when this piece has been said; an empty piece completes
   * when everything queued has. A cancel drops the queue.
   */
  readonly append?: (text: string) => Effect.Effect<void, VoiceError>
}

export const Speaker = Context.GenericTag<SpeakerService>("@nikcli-ai/voice/Speaker")

/**
 * Microphone hardware capture and audio processing pipeline service interface.
 */
export interface MicCaptureService {
  /** Open hardware microphone and begin streaming audio buffers. */
  readonly start: Effect.Effect<void, VoiceError>
  /** Halt capture and release hardware microphone tracks. */
  readonly stop: Effect.Effect<void>
  /** Real-time RMS audio volume levels [0.0 - 1.0]. */
  readonly levels: Stream.Stream<number, VoiceError>
  /** 16 kHz mono Float32Array PCM chunks for local neural models. */
  readonly pcmChunks: Stream.Stream<Float32Array, VoiceError>
  /** Silence-delimited compressed audio segments for cloud ASR. */
  readonly segments: Stream.Stream<CapturedSegment, VoiceError>
}

export const MicCapture = Context.GenericTag<MicCaptureService>("@nikcli-ai/voice/MicCapture")

/**
 * VoiceHost service tag directly exposing the existing VoiceHost contract.
 */
export const VoiceHostService = Context.GenericTag<VoiceHost>("@nikcli-ai/voice/VoiceHostService")
