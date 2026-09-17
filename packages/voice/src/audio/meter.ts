/**
 * Web Audio microphone level meter adapter.
 *
 * Captures user microphone input via MediaDevices, routes it through an AnalyserNode,
 * and streams real-time RMS audio levels to callbacks for visual volume rings.
 *
 * Safety guarantee:
 * Stopping the meter closes the AudioContext and explicitly calls .stop() on all
 * MediaStreamTracks to prevent the browser tab from holding the microphone device hostage.
 */

import { calculateRms } from "./level"
import { MicPermissionDenied, MicUnavailable } from "../effect/errors"
import { t } from "@nikcli-ai/ade/i18n"

export type MicLevelCallback = (level: number) => void

export interface MicMeterOptions {
  /** Callback fired on each audio animation frame with the calculated RMS level [0.0 - 1.0]. */
  onLevel?: MicLevelCallback
  /** AnalyserNode FFT size for time-domain sampling (default: 512). */
  fftSize?: number
  /**
   * Which microphone to meter. Absent means the system default.
   *
   * The meter opens a stream of its own, separate from the one the transcriber
   * records — two `getUserMedia` calls, two devices to choose. Left unset here
   * while the transcriber was pointed somewhere else, the ring would animate
   * off one microphone while the words were recognised from another, which is
   * an interface quietly lying about what it is listening to.
   */
  deviceId?: string
}

export interface MicMeter {
  /** Requests microphone permissions and starts monitoring audio levels. */
  start(): Promise<void>

  /** Immediately stops monitoring, disconnects audio nodes, and releases the hardware mic. */
  stop(): void

  /** Register or update the level callback. */
  onLevel(callback: MicLevelCallback): void

  /**
   * Points the meter at a different microphone for its next start.
   *
   * Does not move a running meter: the device is fixed in the `MediaStream` at
   * `getUserMedia` time, so changing it means stopping and starting again, and
   * whoever owns the session is the one who decides when that happens. See
   * `engine.updateSettings`.
   */
  setDevice(deviceId: string | undefined): void

  /** Whether the meter is currently actively capturing audio. */
  readonly isRunning: boolean
}

export function createMicMeter(options: MicMeterOptions = {}): MicMeter {
  let levelCallback: MicLevelCallback = options.onLevel ?? (() => {})
  let deviceId: string | undefined = options.deviceId
  let running = false

  let audioContext: AudioContext | null = null
  let mediaStream: MediaStream | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let analyserNode: AnalyserNode | null = null
  let animationFrameId: number | null = null
  let intervalId: any = null

  function cleanup(): void {
    running = false

    if (animationFrameId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }

    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }

    if (sourceNode) {
      try {
        sourceNode.disconnect()
      } catch {
        // ignore
      }
      sourceNode = null
    }

    if (analyserNode) {
      try {
        analyserNode.disconnect()
      } catch {
        // ignore
      }
      analyserNode = null
    }

    if (mediaStream) {
      for (const track of mediaStream.getTracks()) {
        try {
          track.stop()
        } catch {
          // ignore
        }
      }
      mediaStream = null
    }

    if (audioContext) {
      if (audioContext.state !== "closed") {
        audioContext.close().catch(() => {})
      }
      audioContext = null
    }
  }

  function tick(analyser: AnalyserNode, buffer: Float32Array): void {
    if (!running) return

    analyser.getFloatTimeDomainData(buffer as any)
    const rms = calculateRms(buffer)
    levelCallback(rms)

    if (typeof requestAnimationFrame === "function") {
      animationFrameId = requestAnimationFrame(() => tick(analyser, buffer))
    }
  }

  return {
    get isRunning(): boolean {
      return running
    },

    async start(): Promise<void> {
      if (running) return

      /*
       * Typed, not anonymous.
       *
       * These used to be bare `Error`s carrying Italian sentences, and the
       * sentence was the only thing that survived: by the time the widget saw
       * it, `lastError()` was a string and nothing downstream could tell a
       * microphone the user has not granted from an API key that has expired.
       * The two need different answers — one is fixed in a browser prompt,
       * the other in settings — so the difference has to be a type. The
       * phrasing now comes from `spokenMessage`, which already had these
       * exact two cases written out.
       */
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function"
      ) {
        throw new MicUnavailable({
          message: t("vui.mic.unsupported"),
        })
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            // `ideal`, so a microphone that has been unplugged since it was
            // chosen falls back to the default instead of refusing to open.
            ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
          },
        })
      } catch (err: any) {
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          throw new MicPermissionDenied({
            message:
              t("vui.mic.denied"),
            cause: err,
          })
        }
        if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
          throw new MicUnavailable({
            message: t("vui.mic.noneDevice"),
            cause: err,
          })
        }
        throw new MicUnavailable({
          message: t("vui.mic.failed", err?.message ?? t("vui.error.unknown")),
          cause: err,
        })
      }

      mediaStream = stream

      const AudioContextClass =
        (typeof window !== "undefined" && (window.AudioContext || (window as any).webkitAudioContext)) ||
        (globalThis as any).AudioContext

      if (!AudioContextClass) {
        cleanup()
        throw new Error(
          t("vui.mic.noAudioContext")
        )
      }

      const ctx = new AudioContextClass()
      if (ctx.state === "suspended") {
        try {
          await ctx.resume()
        } catch {
          // ignore
        }
      }
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = options.fftSize ?? 512

      src.connect(analyser)

      audioContext = ctx
      sourceNode = src
      analyserNode = analyser

      const buffer = new Float32Array(analyser.fftSize)
      running = true

      if (typeof requestAnimationFrame === "function") {
        animationFrameId = requestAnimationFrame(() => tick(analyser, buffer))
      } else {
        intervalId = setInterval(() => tick(analyser, buffer), 30)
      }
    },

    stop(): void {
      cleanup()
      levelCallback(0.0)
    },

    onLevel(callback: MicLevelCallback): void {
      levelCallback = callback
    },

    setDevice(next: string | undefined): void {
      deviceId = next
    },
  }
}
