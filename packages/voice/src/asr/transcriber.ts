/**
 * Transcriber contract for speech-to-text recognition.
 *
 * Why this interface exists:
 * The browser's Web Speech API is today's implementation, but not the only one
 * possible. Future backends (such as local Whisper models, WebSocket-based streaming
 * servers, or specialized audio pipelines) can satisfy this contract without touching
 * the dialogue state machine or ADE host bridge.
 */

export interface TranscriptEvent {
  /** The recognized spoken transcript text. */
  text: string
  /** Whether the transcript chunk is finalized. */
  isFinal: boolean
  /** Confidence score [0.0 - 1.0] when provided by the recognition engine. */
  confidence?: number
  /**
   * When the sentence began (epoch ms), where the backend knows. A sentence
   * arrives seconds after it started; whether the assistant was still awake
   * is a question about when it was said.
   */
  spokenAt?: number
}

export type PartialTranscriptCallback = (text: string) => void
export type FinalTranscriptCallback = (event: TranscriptEvent) => void
export type TranscriberErrorCallback = (error: Error) => void

export interface TranscriberOptions {
  onPartial?: PartialTranscriptCallback
  onFinal?: FinalTranscriptCallback
  onError?: TranscriberErrorCallback
}

export interface Transcriber {
  /** Start listening for spoken audio input. */
  start(): void | Promise<void>

  /** Stop listening and release active recognition resources. */
  stop(): void | Promise<void>

  /** Register callback invoked when an interim/partial recognition is received. */
  onPartial(callback: PartialTranscriptCallback): void

  /** Register callback invoked when a definitive/final recognition is received. */
  onFinal(callback: FinalTranscriptCallback): void

  /** Register callback invoked when a recognition or device error occurs. */
  onError(callback: TranscriberErrorCallback): void

  /** Explicitly start recording an utterance segment (e.g. on push-to-talk press). */
  startSegment?(): void

  /** Explicitly commit and flush the current utterance segment (e.g. on push-to-talk release). */
  commit?(): boolean

  /** Drop the segment being recorded without sending it (e.g. the key sound of a tap). */
  cancelSegment?(): void

  /**
   * Stop taking audio, but let what was already heard come back.
   *
   * `stop()` is the other half of a session ending and it discards: the
   * recognition loop is torn down with it, so a sentence still on its way
   * back from the service lands on nobody. Closing dictation right after
   * speaking — the most natural way to end it — lost the last sentence every
   * time. The engine calls this first, waits for `hasInFlight` to settle, and
   * only then stops.
   */
  finish?(): void

  /** Whether audio processing or transcription is currently in flight. */
  readonly hasInFlight?: boolean
}
