/**
 * Unified microphone capture and audio pipeline.
 *
 * Acquires getUserMedia({ audio: true }) exactly ONCE and routes the hardware stream
 * into three synchronized outputs:
 * 1. Real-time audio RMS level for visual activity rings (reusing audio/level.ts).
 * 2. Continuous 16 kHz mono Float32Array PCM chunks for local Parakeet TDT streaming.
 * 3. Speech-bounded compressed audio Blobs via MediaRecorder for cloud OpenRouter transcription.
 */

import { markVoice } from "../timing"
import {
  calculateRms,
  createSpeechDetector,
  type SpeechDetectorConfig,
} from "./level"
import { t } from "@nikcli-ai/ade/i18n"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum duration in milliseconds for an audio segment.
 * Short transient acoustic events (e.g. coughs, microphone bumps, keyboard taps)
 * below this threshold are discarded rather than dispatched to the transcriber.
 */
export const MIN_SEGMENT_DURATION_MS = 500

/**
 * Maximum duration in milliseconds for an audio recording segment.
 * OpenRouter terminates transcription requests after 60 seconds. Capping
 * continuous segments at 45 seconds leaves comfortable headroom for upload
 * latency, network fluctuations, and API processing without losing spoken words.
 */
export const MAX_SEGMENT_DURATION_MS = 45_000

/**
 * Audio kept from just before speech was recognised as speech.
 *
 * The detector needs more than one loud frame to call it speaking, and a
 * frame is 256 ms at the buffer size used here; the segment used to start
 * after that, so the first word arrived without its first syllables —
 * "apri il file" came back as "il file". The frames before the decision are
 * held here and put at the front of the segment.
 */
export const PRE_ROLL_MS = 400

// ---------------------------------------------------------------------------
// Format Detection
// ---------------------------------------------------------------------------

export type AudioFormat = "webm" | "m4a" | "wav"

export interface SupportedAudioFormat {
  mimeType: string
  format: AudioFormat
}

/**
 * Encodes a Float32Array 16 kHz mono PCM buffer into a standard 16-bit PCM WAV Blob.
 * Supported by 100% of speech-to-text providers without container or codec mismatches.
 */
export function encodeWav(samples: Float32Array, sampleRate: number = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeString(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // Mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (16-bit mono = 2 bytes/sample)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, "data")
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([buffer], { type: "audio/wav" })
}

/**
 * Probes MediaRecorder for supported container/codec formats.
 * Prefers Opus in WebM, falling back to AAC in MP4 container.
 * Throws a localized Italian error when neither is available.
 */
export function chooseSupportedAudioMimeType(
  isTypeSupported?: (mime: string) => boolean
): SupportedAudioFormat {
  const probe =
    isTypeSupported ??
    ((mime: string) => {
      const g = typeof window !== "undefined" ? window : (globalThis as any)
      const rec = g?.MediaRecorder
      return Boolean(rec && typeof rec.isTypeSupported === "function" && rec.isTypeSupported(mime))
    })

  if (probe("audio/webm;codecs=opus")) {
    return { mimeType: "audio/webm;codecs=opus", format: "webm" }
  }

  if (probe("audio/mp4")) {
    return { mimeType: "audio/mp4", format: "m4a" }
  }

  throw new Error(
    t("vui.mic.noFormat")
  )
}

// ---------------------------------------------------------------------------
// PCM Resampling
// ---------------------------------------------------------------------------

/**
 * Linearly resamples a Float32Array PCM buffer from fromSampleRate to toSampleRate (16 kHz).
 *
 * AudioContext was requested with sampleRate: 16000. If the underlying hardware
 * or browser does not honor this and uses a different rate (e.g. 44100 or 48000 Hz),
 * we explicitly resample the PCM samples to 16000 Hz mono. Parakeet TDT strictly
 * requires 16 kHz; wrong sample rates do not crash, but result in garbage transcription.
 */
export function resamplePcm(
  input: Float32Array,
  fromSampleRate: number,
  toSampleRate: number = 16000
): Float32Array {
  if (fromSampleRate === toSampleRate || input.length === 0) {
    return input
  }

  const ratio = fromSampleRate / toSampleRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(outLength)

  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio
    const srcIndexFloor = Math.floor(srcIndex)
    const srcIndexCeil = Math.min(input.length - 1, srcIndexFloor + 1)
    const weight = srcIndex - srcIndexFloor
    output[i] = input[srcIndexFloor] * (1 - weight) + input[srcIndexCeil] * weight
  }

  return output
}

// ---------------------------------------------------------------------------
// Captured Segment Interface
// ---------------------------------------------------------------------------

export interface CapturedSegment {
  blob: Blob
  format: AudioFormat
  mimeType: string
  durationMs: number
  /** Which segment this is, counted from 1: see `MicCapture.onHead`. */
  sequence?: number
}

/** The start of a segment still being recorded: see `MicCapture.onHead`. */
export interface SegmentHead {
  blob: Blob
  sequence: number
}

// ---------------------------------------------------------------------------
// MicCapture Interface & Options
// ---------------------------------------------------------------------------

export type MicLevelCallback = (level: number) => void
export type PcmChunkCallback = (chunk: Float32Array) => void
export type SegmentCallback = (segment: CapturedSegment) => void | Promise<void>
export type CaptureErrorCallback = (error: Error) => void
export type SpeechLifecycleCallback = () => void

export interface MicCaptureOptions {
  /** Injected time provider (epoch ms). Mandatory for deterministic testing. */
  now?: () => number
  /** Real-time RMS audio level stream [0.0 - 1.0]. */
  onLevel?: MicLevelCallback
  /** 16 kHz mono Float32Array PCM sample chunks for Parakeet. */
  onPcmChunk?: PcmChunkCallback
  /** Closed compressed speech segments for OpenRouter. */
  onSegment?: SegmentCallback
  /** Fired when intentional speech start is confirmed. */
  onSpeechStart?: SpeechLifecycleCallback
  /** Fired when speech concludes after silence timeout. */
  onSpeechEnd?: SpeechLifecycleCallback
  /** Fired when audio capture or device errors occur. */
  onError?: CaptureErrorCallback
  /** Minimum segment duration to retain (default: MIN_SEGMENT_DURATION_MS). */
  minSegmentDurationMs?: number
  /** Maximum segment duration before splitting (default: MAX_SEGMENT_DURATION_MS). */
  maxSegmentDurationMs?: number
  /** Preferred audio output format. If "wav", generates 16 kHz 16-bit mono WAV blobs. */
  preferredFormat?: AudioFormat
  /** Tuning parameters for silence detection state machine. */
  speechDetectorConfig?: SpeechDetectorConfig
  /** Test double injection: AudioContext constructor. */
  audioContextClass?: any
  /** Test double injection: MediaRecorder constructor. */
  mediaRecorderClass?: any
  /**
   * Which microphone to open. Absent means the system default.
   *
   * Requested as `ideal` rather than `exact`: an id stored yesterday may name
   * a headset that is not plugged in today, and `exact` answers that with an
   * `OverconstrainedError` — voice control that stops working because a cable
   * was moved. Ideal falls back to the default device, which is what the user
   * would have picked anyway.
   */
  deviceId?: string
  /** Test double injection: pre-existing MediaStream. */
  mediaStream?: MediaStream
  /** Test double injection: custom getUserMedia function. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  /** Test double injection: format support probe. */
  isTypeSupported?: (mime: string) => boolean
}

export interface MicCapture {
  /** Opens the microphone, starts AudioContext and begins streaming. */
  start(): Promise<void>
  /** Completely stops all MediaStream tracks, releases AudioContext and stops recording. */
  stop(): void
  /** Explicitly starts recording a speech segment on demand (e.g. for push-to-talk press). */
  startSegment?(): void
  /** Commits and flushes any actively recorded speech segment immediately on demand. Returns true if segment was flushed. */
  commitSegment?(): boolean
  /** Drops the segment being recorded; the detector can start a new one on the next speech. */
  cancelSegment?(): void
  /** Feed a PCM buffer directly (useful for testing or virtual audio pipelines). */
  /** `at`: when the last sample of `samples` was heard; now, if not given. */
  processAudioFrame(samples: Float32Array, inputSampleRate?: number, at?: number): void
  /** Register or update RMS level listener. */
  onLevel(callback: MicLevelCallback): void
  /** Register or update PCM chunk listener. */
  onPcmChunk(callback: PcmChunkCallback): void
  /** Register or update segment listener. */
  onSegment(callback: SegmentCallback): void
  /**
   * Once a segment has been recorded for `afterMs`, its first `headMs` as a
   * WAV, while the speaker goes on: so its start can be transcribed before
   * the sentence ends. The segment itself comes later with the same `sequence`.
   */
  onHead?(callback: (head: SegmentHead) => void, timing: { afterMs: number; headMs: number }): void
  /** Register or update speech start listener. */
  onSpeechStart(callback: SpeechLifecycleCallback): void
  /** Register or update speech end listener. */
  onSpeechEnd(callback: SpeechLifecycleCallback): void
  /** Register or update error listener. */
  onError(callback: CaptureErrorCallback): void
  /** Whether capture is actively running. */
  readonly isRunning: boolean
  /** The selected short audio format code ("webm" or "m4a"). */
  readonly format: AudioFormat
  /** The full container and codec MIME type. */
  readonly mimeType: string
}

// ---------------------------------------------------------------------------
// MicCapture Factory
// ---------------------------------------------------------------------------

export function createMicCapture(options: MicCaptureOptions = {}): MicCapture {
  const nowFn = options.now ?? (() => Date.now())
  const minDuration = options.minSegmentDurationMs ?? MIN_SEGMENT_DURATION_MS
  const maxDuration = options.maxSegmentDurationMs ?? MAX_SEGMENT_DURATION_MS

  let onLevelCb: MicLevelCallback = options.onLevel ?? (() => {})
  let onPcmChunkCb: PcmChunkCallback = options.onPcmChunk ?? (() => {})
  let onSegmentCb: SegmentCallback = options.onSegment ?? (() => {})
  let onSpeechStartCb: SpeechLifecycleCallback = options.onSpeechStart ?? (() => {})
  let onSpeechEndCb: SpeechLifecycleCallback = options.onSpeechEnd ?? (() => {})
  let onErrorCb: CaptureErrorCallback = options.onError ?? (() => {})

  const { mimeType: chosenMimeType, format: chosenFormat } = chooseSupportedAudioMimeType(
    options.isTypeSupported
  )

  const detector = createSpeechDetector(options.speechDetectorConfig)

  let running = false
  let audioContext: AudioContext | null = null
  let mediaStream: MediaStream | null = options.mediaStream ?? null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let processorNode: any = null
  let recorder: any = null
  let recordedChunks: Blob[] = []
  let recordedPcmChunks: Float32Array[] = []
  /* The most recent frames heard outside a segment; see PRE_ROLL_MS. */
  let preRoll: Float32Array[] = []
  const preRollSamples = Math.round((PRE_ROLL_MS / 1000) * 16000)
  let segmentStartTime = 0
  let isRecordingSegment = false
  let sequence = 0
  let head: { callback: (head: SegmentHead) => void; afterMs: number; headMs: number } | undefined
  let headSent = false
  /**
   * The segment that has been closed but not yet flushed.
   *
   * Its own chunks and its own length, taken at the moment it closed. See
   * `closeCurrentSegment` for why neither can be read back later.
   */
  let pendingSegment:
    | {
        chunks: Blob[]
        pcmWavBlob?: Blob
        durationMs: number
        reason?: "silence" | "max_duration" | "stop" | "commit"
        sequence: number
      }
    | undefined

  function safeStopAllTracks(stream: MediaStream | null): void {
    if (!stream) return
    try {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // ignore individual track stop errors
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Builds the audio graph on an open stream: the context, the PCM tap and the
   * recorder that makes the compressed segments.
   *
   * Its own function so `start()` can put a `try` around it — see the comment
   * there. Nothing in here opens hardware; the stream is already the caller's.
   */
  async function buildGraph(stream: MediaStream): Promise<void> {
    // Initialize AudioContext requested at 16000 Hz
    const AudioCtxClass =
      options.audioContextClass ??
      (typeof window !== "undefined" && (window.AudioContext || (window as any).webkitAudioContext)) ??
      (globalThis as any).AudioContext

    if (AudioCtxClass) {
      try {
        audioContext = new AudioCtxClass({ sampleRate: 16000 })
      } catch {
        audioContext = new AudioCtxClass()
      }

      /*
       * A context created outside a user gesture starts suspended, and a
       * suspended context never fires onaudioprocess: the microphone is open,
       * the level stays at zero and not one PCM frame reaches the recognizer.
       * Resuming is cheap when it is already running and is the difference
       * between silence and speech everywhere the gesture was a keyboard
       * shortcut rather than a click.
       */
      if (audioContext && audioContext.state === "suspended") {
        try {
          await audioContext.resume()
        } catch {
          // A context that refuses to resume still reports its own errors below
        }
      }

      if (audioContext && stream && typeof audioContext.createMediaStreamSource === "function") {
        sourceNode = audioContext.createMediaStreamSource(stream)

        // ScriptProcessorNode for raw PCM extraction
        if (typeof audioContext.createScriptProcessor === "function") {
          /*
           * 2048 samples: a callback every ~43 ms at 48 kHz, so the end of a
           * sentence is noticed at most that late.
           */
          const bufferSize = 2048
          processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1)
          const sampleRate = audioContext.sampleRate

          processorNode.onaudioprocess = (event: any) => {
            if (!running) return
            const inputChannel: Float32Array = event.inputBuffer.getChannelData(0)
            /*
             * In 20 ms slices, each at the moment it was heard: a whole buffer
             * averaged together hides where the voice stopped, and the wait
             * for the end of the sentence started up to a buffer late.
             */
            const heardAt = nowFn()
            const slice = Math.max(1, Math.round(sampleRate / 50))
            for (let start = 0; start < inputChannel.length; start += slice) {
              const end = Math.min(inputChannel.length, start + slice)
              processAudioFrame(inputChannel.slice(start, end), sampleRate, heardAt - ((inputChannel.length - end) / sampleRate) * 1000)
            }
            const outputBuffer = event.outputBuffer
            if (outputBuffer) {
              for (let i = 0; i < outputBuffer.numberOfChannels; i++) {
                outputBuffer.getChannelData(i).fill(0)
              }
            }
          }

          sourceNode.connect(processorNode)
          // ScriptProcessorNode must be connected to destination in some browsers to trigger audioprocess
          if (audioContext.destination) {
            try {
              const muteGain = audioContext.createGain()
              muteGain.gain.value = 0
              processorNode.connect(muteGain)
              muteGain.connect(audioContext.destination)
            } catch {
              try {
                processorNode.connect(audioContext.destination)
              } catch {
                // ignore
              }
            }
          }
        }
      }
    }

    // Initialize MediaRecorder for compressed speech segments
    const MediaRecorderClass =
      options.mediaRecorderClass ??
      (typeof window !== "undefined" ? (window as any).MediaRecorder : (globalThis as any).MediaRecorder)

    if (MediaRecorderClass) {
      try {
        recorder = new MediaRecorderClass(stream, { mimeType: chosenMimeType })
      } catch {
        try {
          recorder = new MediaRecorderClass(stream)
        } catch {
          recorder = null
        }
      }

      if (recorder) {
        recorder.ondataavailable = (event: any) => {
          if (!event.data || event.data.size === 0) return
          /*
           * While a stop is in flight the data still belongs to the segment
           * that is closing, not to the one that has already started in its
           * place — see `closeCurrentSegment`.
           */
          if (pendingSegment) pendingSegment.chunks.push(event.data)
          else recordedChunks.push(event.data)
        }

        recorder.onstop = () => flushPendingSegment()
      }
    }
  }

  /**
   * Lets go of the microphone and everything attached to it.
   *
   * Shared by `stop()` and by a `start()` that failed partway: those two must
   * release exactly the same things, and the failure path is the one where
   * getting it wrong leaves the recording indicator on for the rest of the day.
   */
  function releaseHardware(): void {
    if (processorNode) {
      try {
        processorNode.disconnect()
      } catch {
        // ignore
      }
      processorNode = null
    }

    if (sourceNode) {
      try {
        sourceNode.disconnect()
      } catch {
        // ignore
      }
      sourceNode = null
    }

    safeStopAllTracks(mediaStream)
    mediaStream = null

    if (audioContext) {
      if (audioContext.state !== "closed") {
        audioContext.close().catch(() => {})
      }
      audioContext = null
    }
  }

  function startSegmentRecording(withPreRoll = false): void {
    if (isRecordingSegment) return
    recordedChunks = []
    // Only for a start the detector decided on. A key press marks the start
    // itself, and what came before it is the key.
    recordedPcmChunks = withPreRoll ? preRoll : []
    preRoll = []
    segmentStartTime = nowFn()
    isRecordingSegment = true
    sequence++
    headSent = false
    if (recorder) {
      try {
        recorder.start(100)
      } catch {
        // If recorder.start with timeslice fails, retry without timeslice
        try {
          recorder.start()
        } catch (err: any) {
          if (options.preferredFormat !== "wav") {
            onErrorCb(new Error(t("vui.mic.recordFailed", err?.message ?? t("vui.error.unknown"))))
          }
        }
      }
    }
  }

  function closeCurrentSegment(reason: "silence" | "max_duration" | "stop" | "commit"): void {
    if (!isRecordingSegment) {
      markVoice("segment-skipped", reason)
      return
    }
    isRecordingSegment = false
    const closeTime = nowFn()
    const duration = Math.max(0, closeTime - segmentStartTime)
    const quietSince = detector.getState().silenceStartTime
    markVoice("segment-closed", `${reason} ${Math.round(duration)}ms, silenzio ${quietSince === undefined ? "-" : Math.round(closeTime - quietSince)}ms`)

    let wavBlob: Blob | undefined
    if (recordedPcmChunks.length > 0) {
      let totalLength = 0
      for (const chunk of recordedPcmChunks) {
        totalLength += chunk.length
      }
      const mergedPcm = new Float32Array(totalLength)
      let offset = 0
      for (const chunk of recordedPcmChunks) {
        mergedPcm.set(chunk, offset)
        offset += chunk.length
      }
      wavBlob = encodeWav(mergedPcm, 16000)
    }

    /*
     * The closing segment takes its chunks and its length with it.
     *
     * `MediaRecorder.stop()` is asynchronous: the last `dataavailable` and then
     * `onstop` arrive after this function has returned. On the `max_duration`
     * path a new segment is started immediately — which reset `segmentStartTime`
     * and replaced `recordedChunks` — so by the time `onstop` ran it measured a
     * segment that had just begun, decided it was shorter than the minimum, and
     * threw away forty-five seconds of speech. Every long sentence was silently
     * dropped.
     *
     * Handing the array over here and pointing the recorder's own callbacks at
     * it until it has flushed is what keeps the two segments apart.
     */
    pendingSegment = { chunks: recordedChunks, pcmWavBlob: wavBlob, durationMs: duration, reason, sequence }
    recordedChunks = []
    recordedPcmChunks = []

    if (options.preferredFormat === "wav" && wavBlob) {
      if (recorder) {
        try {
          if (recorder.state === "recording" || recorder.state === "paused") {
            recorder.stop()
          }
        } catch {
          // ignore
        }
      }
      flushPendingSegment()
    } else if (recorder) {
      try {
        if (recorder.state === "recording" || recorder.state === "paused") {
          recorder.stop()
        }
      } catch {
        // ignore
      }

      // If recorder onstop is configured, it will handle emit, otherwise run synchronously
      if (typeof recorder.onstop !== "function") {
        flushPendingSegment()
      }
    } else {
      flushPendingSegment()
    }

    if (reason === "max_duration" && running) {
      // Utterance is continuing past MAX_SEGMENT_DURATION_MS: start new segment immediately
      startSegmentRecording()
    }
  }

  /**
   * Hands the closed segment to whoever is listening, or drops it if it was
   * too short to be speech.
   *
   * Called from `onstop` in a real browser and directly when a test double has
   * no `onstop`, so the two paths cannot drift: the length is the one measured
   * when the segment closed, never one recomputed later against a clock that
   * has moved on.
   */
  function flushPendingSegment(): void {
    const segment = pendingSegment
    pendingSegment = undefined
    if (!segment) return

    // Short transients: a cough, a throat clear, a click on the desk.
    // On explicit push-to-talk commit or session stop, allow short commands down to 150 ms.
    const isIntentional = segment.reason === "commit" || segment.reason === "stop"
    const threshold = isIntentional ? 150 : minDuration
    if (segment.durationMs < threshold) {
      markVoice("segment-dropped", `${Math.round(segment.durationMs)}ms`)
      return
    }

    if (options.preferredFormat === "wav" && segment.pcmWavBlob) {
      onSegmentCb({
        blob: segment.pcmWavBlob,
        format: "wav",
        mimeType: "audio/wav",
        durationMs: segment.durationMs,
        sequence: segment.sequence,
      })
    } else {
      onSegmentCb({
        blob: new Blob(segment.chunks, { type: chosenMimeType }),
        format: chosenFormat,
        mimeType: chosenMimeType,
        durationMs: segment.durationMs,
        sequence: segment.sequence,
      })
    }
  }

  function processAudioFrame(samples: Float32Array, inputSampleRate: number = 16000, at?: number): void {
    if (!running) return

    // Resample to 16 kHz mono Float32Array for Parakeet
    const pcm16k =
      inputSampleRate !== 16000
        ? resamplePcm(samples, inputSampleRate, 16000)
        : samples

    onPcmChunkCb(pcm16k)

    // Compute RMS amplitude and stream to level listeners
    const rms = calculateRms(pcm16k)
    onLevelCb(rms)

    // Drive speech/silence detector state machine
    const currentTime = at ?? nowFn()
    const prevStatus = detector.getState().status
    const currentStatus = detector.step(rms, currentTime)

    // Handle state transitions
    if (currentStatus === "speaking") {
      if (prevStatus !== "speaking") {
        startSegmentRecording(true)
        onSpeechStartCb()
      } else if (isRecordingSegment && currentTime - segmentStartTime >= maxDuration) {
        // Segment duration reached upper threshold (OpenRouter 60s limit protection)
        closeCurrentSegment("max_duration")
      } else if (
        isRecordingSegment &&
        currentTime - segmentStartTime >= 12_000 &&
        detector.getState().silenceStartTime !== undefined &&
        currentTime - (detector.getState().silenceStartTime ?? currentTime) >= 500
      ) {
        // Natural cadence break in continuous speech: flush chunk so transcription arrives incrementally
        closeCurrentSegment("max_duration")
      }
    } else if (currentStatus === "speech_ended") {
      if (prevStatus === "speaking" || isRecordingSegment) {
        closeCurrentSegment("silence")
        onSpeechEndCb()
      }
      detector.reset()
    }

    if (isRecordingSegment) {
      recordedPcmChunks.push(new Float32Array(pcm16k))
      if (head && !headSent && currentTime - segmentStartTime >= head.afterMs) {
        headSent = true
        const wanted = Math.round((head.headMs / 1000) * 16000)
        const samples = new Float32Array(wanted)
        let filled = 0
        for (const chunk of recordedPcmChunks) {
          if (filled >= wanted) break
          const part = chunk.subarray(0, wanted - filled)
          samples.set(part, filled)
          filled += part.length
        }
        head.callback({ blob: encodeWav(samples.subarray(0, filled), 16000), sequence })
      }
    } else {
      preRoll.push(new Float32Array(pcm16k))
      let held = 0
      for (const frame of preRoll) held += frame.length
      while (preRoll.length > 1 && held - preRoll[0].length >= preRollSamples) {
        held -= preRoll[0].length
        preRoll.shift()
      }
    }
  }

  return {
    get isRunning(): boolean {
      return running
    },

    get format(): AudioFormat {
      return chosenFormat
    },

    get mimeType(): string {
      return chosenMimeType
    },

    processAudioFrame,

    async start(): Promise<void> {
      if (running) return

      let stream = mediaStream
      if (!stream) {
        const getUserMediaFn =
          options.getUserMedia ??
          (() => {
            const nav = typeof navigator !== "undefined" ? navigator : (globalThis as any).navigator
            if (!nav?.mediaDevices?.getUserMedia) {
              throw new Error(
                t("vui.mic.unsupported")
              )
            }
            return nav.mediaDevices.getUserMedia.bind(nav.mediaDevices)
          })()

        try {
          stream = await getUserMediaFn({
            audio: {
              channelCount: 1,
              sampleRate: 16000,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              ...(options.deviceId ? { deviceId: { ideal: options.deviceId } } : {}),
            },
          })
        } catch (err: any) {
          if (err.name === "OverconstrainedError" || err.name === "ConstraintNotSatisfiedError") {
            // Only reachable if a browser treats `ideal` as binding. Named so the
            // message points at the picker rather than at the permission dialog.
            throw new Error(
              t("vui.mic.chosenMissing")
            )
          }
          if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
            throw new Error(
              t("vui.mic.denied")
            )
          }
          if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
            throw new Error(
              t("vui.mic.none")
            )
          }
          throw new Error(
            t("vui.mic.failed", err?.message ?? t("vui.error.unknown"))
          )
        }
      }

      // Only reachable through an injected `mediaStream` of null; said rather
      // than asserted, because the graph below would fail far less legibly.
      if (!stream) throw new Error(t("vui.mic.noStream"))

      mediaStream = stream

      /*
       * From here the microphone is open, and everything below can still fail:
       * an `AudioContext` the browser refuses to create, a
       * `createMediaStreamSource` that throws on a stream with no audio track.
       * Without this, such a failure rejected `start()` with `running` still
       * false and the hardware stream live — the recording light on, nothing
       * listening, and no object left holding a reference to turn it off.
       */
      try {
        await buildGraph(stream)
        running = true
      } catch (err) {
        releaseHardware()
        throw err
      }
    },


    stop(): void {
      running = false

      if (isRecordingSegment) {
        closeCurrentSegment("stop")
      }

      releaseHardware()
      detector.reset()
      preRoll = []
      onLevelCb(0.0)
    },

    startSegment(): void {
      if (!isRecordingSegment && running) {
        startSegmentRecording()
      }
    },

    commitSegment(): boolean {
      if (isRecordingSegment) {
        closeCurrentSegment("commit")
        detector.reset()
        return true
      }
      return false
    },

    cancelSegment(): void {
      if (!isRecordingSegment) return
      isRecordingSegment = false
      recordedChunks = []
      recordedPcmChunks = []
      // With nothing pending, the recorder's own stop flushes nothing.
      if (recorder && !pendingSegment) {
        try {
          if (recorder.state === "recording" || recorder.state === "paused") recorder.stop()
        } catch {
          // ignore
        }
      }
      detector.reset()
    },

    onLevel(callback: MicLevelCallback): void {
      onLevelCb = callback
    },

    onPcmChunk(callback: PcmChunkCallback): void {
      onPcmChunkCb = callback
    },

    onHead(callback: (head: SegmentHead) => void, timing: { afterMs: number; headMs: number }): void {
      head = { callback, ...timing }
    },

    onSegment(callback: SegmentCallback): void {
      onSegmentCb = callback
    },

    onSpeechStart(callback: SpeechLifecycleCallback): void {
      onSpeechStartCb = callback
    },

    onSpeechEnd(callback: SpeechLifecycleCallback): void {
      onSpeechEndCb = callback
    },

    onError(callback: CaptureErrorCallback): void {
      onErrorCb = callback
    },
  }
}
