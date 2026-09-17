/**
 * Test double implementing the Transcriber contract.
 *
 * Allows unit tests to simulate spoken transcriptions, partial streaming,
 * and speech recognition errors without requiring audio hardware or a browser DOM.
 */

import type {
  FinalTranscriptCallback,
  PartialTranscriptCallback,
  Transcriber,
  TranscriberErrorCallback,
  TranscriberOptions,
  TranscriptEvent,
} from "./transcriber"

export interface FakeTranscriber extends Transcriber {
  /** True when start() was called without a matching stop(). */
  readonly isStarted: boolean

  /** Emit a transcription event directly to registered listeners. */
  emit(text: string, isFinal: boolean, confidence?: number): void

  /** Emit a recognition error directly to registered listeners. */
  emitError(error: Error): void

  /** Reset all listeners and state. */
  reset(): void

  /** Toggle in-flight transcription status for testing. */
  setHasInFlight(value: boolean): void

  /** Toggle commit result for testing push-to-talk segments. */
  setCommitResult(value: boolean): void
}

export function createFakeTranscriber(options: TranscriberOptions = {}): FakeTranscriber {
  let partialCb: PartialTranscriptCallback = options.onPartial ?? (() => {})
  let finalCb: FinalTranscriptCallback = options.onFinal ?? (() => {})
  let errorCb: TranscriberErrorCallback = options.onError ?? (() => {})
  let started = false
  let inFlight = false
  let commitResult = false

  return {
    get isStarted(): boolean {
      return started
    },

    get hasInFlight(): boolean {
      return inFlight
    },

    setHasInFlight(value: boolean): void {
      inFlight = value
    },

    setCommitResult(value: boolean): void {
      commitResult = value
    },

    startSegment(): void {},

    commit(): boolean {
      return commitResult
    },

    start(): void {
      started = true
    },

    stop(): void {
      started = false
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

    emit(text: string, isFinal: boolean, confidence?: number): void {
      if (isFinal) {
        finalCb({ text, isFinal: true, confidence })
      } else {
        partialCb(text)
      }
    },

    emitError(error: Error): void {
      errorCb(error)
    },

    reset(): void {
      started = false
      partialCb = () => {}
      finalCb = () => {}
      errorCb = () => {}
    },
  }
}
