import { describe, expect, test } from "bun:test"
import {
  createParakeetTranscriber,
  describeParakeetReadiness,
  disposeParakeetModel,
  isParakeetModelWarmedUp,
  isWasmAvailable,
  isWebGpuAvailable,
  warmupParakeetModel,
  type ParakeetProgress,
} from "./parakeet-local"
import { createMicCapture } from "../audio/capture"

class MockStreamingTranscriber {
  processCalls = 0
  finalizeCalls = 0
  resetCalls = 0

  async processChunk(_chunk: Float32Array) {
    this.processCalls++
    return {
      chunkText: "ciao",
      text: "ciao mondo",
      words: ["ciao", "mondo"],
      is_final: false,
      totalDuration: 0.5,
    }
  }

  finalize() {
    this.finalizeCalls++
    return {
      text: "ciao mondo definitivo",
      words: ["ciao", "mondo", "definitivo"],
    }
  }

  reset() {
    this.resetCalls++
  }
}

class MockParakeetModel {
  backend: string
  disposed = false
  streaming = new MockStreamingTranscriber()

  constructor(backend: string) {
    this.backend = backend
  }

  createStreamingTranscriber(_opts?: any) {
    return this.streaming
  }

  async dispose() {
    this.disposed = true
  }
}

describe("asr/parakeet-local", () => {
  test("readiness reports usable when WASM or WebGPU available, and explains when model is not downloaded", () => {
    // Current runtime has WebAssembly
    expect(isWasmAvailable()).toBe(true)

    // Ready with model already downloaded
    const ready = describeParakeetReadiness({ isModelDownloaded: true })
    expect(ready.usable).toBe(true)

    // Model not yet downloaded
    const pendingDownload = describeParakeetReadiness({ isModelDownloaded: false })
    expect(pendingDownload.usable).toBe(false)
    expect(pendingDownload.reason).toContain("non è ancora stato scaricato in locale")
  })

  test("produces partial hypotheses from processChunk and final event from finalize", async () => {
    const mockModel = new MockParakeetModel("webgpu")
    const partials: string[] = []
    const finals: any[] = []

    // Fake capture to push audio chunks directly
    const capture = createMicCapture({
      mediaStream: {
        getTracks: () => [{ stop: () => {}, readyState: "live" }],
      } as any,
      isTypeSupported: () => true,
    })

    const transcriber = createParakeetTranscriber({
      capture,
      fromHub: async () => mockModel,
      supportsLanguage: () => true,
      onPartial: (text) => partials.push(text),
      onFinal: (evt) => finals.push(evt),
    })

    await transcriber.start()
    expect(transcriber.activeBackend).toBe("wasm") // Navigator.gpu not present in test runner

    // Feed a PCM chunk
    capture.processAudioFrame(new Float32Array(160).fill(0.1))

    // Allow async processChunk to settle
    await new Promise((r) => setTimeout(r, 10))

    expect(partials).toEqual(["ciao mondo"])
    expect(finals).toHaveLength(0)

    // Trigger silence end
    capture.processAudioFrame(new Float32Array(160).fill(0.0))
    // Call onSpeechEnd callback manually to test finalize pipeline
    ;(capture as any).stop()

    // Stop transcriber
    await transcriber.stop()
    expect(mockModel.disposed).toBe(true)
  })

  test("falls back to WASM when WebGPU initialization throws and declares WASM in activeBackend", async () => {
    const attempts: string[] = []
    const wasmModel = new MockParakeetModel("wasm")

    const fakeFromHub = async (_modelId: string, opts: any) => {
      attempts.push(opts.backend)
      if (opts.backend === "webgpu") {
        throw new Error("WebGPU initialization failed: GPU adapter not found")
      }
      return wasmModel
    }

    // Mock navigator.gpu temporarily
    const originalNavigator = globalThis.navigator
    ;(globalThis as any).navigator = {
      ...(originalNavigator || {}),
      gpu: {},
    }

    try {
      expect(isWebGpuAvailable()).toBe(true)

      const transcriber = createParakeetTranscriber({
        fromHub: fakeFromHub,
        supportsLanguage: () => true,
        captureOptions: {
          mediaStream: {
            getTracks: () => [],
          } as any,
          isTypeSupported: () => true,
        },
      })

      await transcriber.start()

      // Should have attempted webgpu first, then fallen back to wasm
      expect(attempts).toContain("webgpu")
      expect(attempts).toContain("wasm")
      expect(transcriber.activeBackend).toBe("wasm")
      expect(transcriber.statusMessage).toContain("wasm")

      await transcriber.stop()
    } finally {
      ;(globalThis as any).navigator = originalNavigator
    }
  })

  test("reports download progress and Italian preparation message to caller", async () => {
    const progressList: ParakeetProgress[] = []
    const mockModel = new MockParakeetModel("wasm")

    const fakeFromHub = async (_modelId: string, opts: any) => {
      opts.progress?.({ loaded: 250_000_000, total: 500_000_000, file: "model.onnx" })
      opts.progress?.({ loaded: 500_000_000, total: 500_000_000, file: "model.onnx" })
      return mockModel
    }

    const transcriber = createParakeetTranscriber({
      fromHub: fakeFromHub,
      supportsLanguage: () => true,
      onProgress: (p) => progressList.push(p),
      captureOptions: {
        mediaStream: { getTracks: () => [] } as any,
        isTypeSupported: () => true,
      },
    })

    await transcriber.start()

    expect(progressList.length).toBeGreaterThanOrEqual(2)
    // First message indicates preparation
    expect(progressList[0].message).toContain("Preparazione")
    // Subsequent reports include percentage
    const lastProgress = progressList[progressList.length - 1]
    expect(lastProgress.percent).toBe(100)
    expect(lastProgress.message).toContain("100%")

    await transcriber.stop()
  })

  test("rejects when the chosen language is not supported by the model", async () => {
    const errors: Error[] = []

    const transcriber = createParakeetTranscriber({
      fromHub: async () => new MockParakeetModel("wasm"),
      supportsLanguage: () => false, // Claims the language is not supported
      onError: (err) => errors.push(err),
      captureOptions: {
        mediaStream: { getTracks: () => [] } as any,
        isTypeSupported: () => true,
      },
    })

    // Both: reported to the listener and rejected, so a caller that awaited
    // start() cannot go on believing the microphone is live.
    await expect(transcriber.start()).rejects.toThrow(/non supporta la lingua scelta \('it'\)/)

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("non supporta la lingua scelta ('it')")
  })

  /*
   * The check used to name `"it"` whatever the user had picked, so a model
   * that speaks the chosen language but not Italian was refused, and one that
   * speaks Italian but not the chosen language was loaded and then transcribed
   * badly with nothing to explain it.
   */
  test("the coverage question names the language the user chose", async () => {
    const asked: string[][] = []

    const transcriber = createParakeetTranscriber({
      language: "en",
      fromHub: async () => new MockParakeetModel("wasm"),
      supportsLanguage: (id: string, code: string) => {
        asked.push([id, code])
        return code === "en"
      },
      captureOptions: {
        mediaStream: { getTracks: () => [] } as any,
        isTypeSupported: () => true,
      },
    })

    await transcriber.start()

    expect(asked.map(([, code]) => code)).toEqual(["en"])
    await transcriber.stop()
  })

  test("'auto' asks nothing, because there is no single code to ask about", async () => {
    let asked = 0

    const transcriber = createParakeetTranscriber({
      language: "auto",
      fromHub: async () => new MockParakeetModel("wasm"),
      supportsLanguage: () => {
        asked += 1
        return false // Would refuse the load if it were consulted at all.
      },
      captureOptions: {
        mediaStream: { getTracks: () => [] } as any,
        isTypeSupported: () => true,
      },
    })

    await transcriber.start()

    expect(asked).toBe(0)
    await transcriber.stop()
  })

  describe("in-memory caching & warmup lifecycle", () => {
    test("keeps model warm across sessions and avoids repeated fromHub downloads and progress events", async () => {
      await disposeParakeetModel()
      expect(isParakeetModelWarmedUp()).toBe(false)

      let fromHubCalls = 0
      const mockModel = new MockParakeetModel("wasm")
      const fakeFromHub = async () => {
        fromHubCalls++
        return mockModel
      }

      const progressHistory1: ParakeetProgress[] = []
      const transcriber1 = createParakeetTranscriber({
        keepWarm: true,
        fromHub: fakeFromHub,
        supportsLanguage: () => true,
        onProgress: (p) => progressHistory1.push(p),
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      })

      // 1. First start: loads model via fromHub, emits progress
      await transcriber1.start()
      expect(fromHubCalls).toBe(1)
      expect(progressHistory1.length).toBeGreaterThan(0)
      expect(isParakeetModelWarmedUp()).toBe(true)

      // Stop transcriber 1: with keepWarm=true, mockModel is NOT disposed
      await transcriber1.stop()
      expect(mockModel.disposed).toBe(false)
      expect(isParakeetModelWarmedUp()).toBe(true)

      // 2. Second start with new transcriber instance: reuses warm model instantly
      const progressHistory2: ParakeetProgress[] = []
      const transcriber2 = createParakeetTranscriber({
        keepWarm: true,
        fromHub: fakeFromHub,
        supportsLanguage: () => true,
        onProgress: (p) => progressHistory2.push(p),
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      })

      await transcriber2.start()
      // fromHub was NOT called again!
      expect(fromHubCalls).toBe(1)
      // No progress loading callbacks fired (instant 0ms reuse!)
      expect(progressHistory2).toEqual([])

      await transcriber2.stop()
      expect(mockModel.disposed).toBe(false)

      // 3. disposeParakeetModel clears the cache and releases the model
      await disposeParakeetModel()
      expect(isParakeetModelWarmedUp()).toBe(false)
      expect(mockModel.disposed).toBe(true)
    })

    test("warmupParakeetModel preloads model without starting microphone capture", async () => {
      await disposeParakeetModel()
      expect(isParakeetModelWarmedUp()).toBe(false)

      let fromHubCalls = 0
      const mockModel = new MockParakeetModel("wasm")
      const fakeFromHub = async () => {
        fromHubCalls++
        return mockModel
      }

      await warmupParakeetModel({
        onlyIfDownloaded: false,
        fromHub: fakeFromHub,
        supportsLanguage: () => true,
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      })

      expect(fromHubCalls).toBe(1)
      expect(isParakeetModelWarmedUp()).toBe(true)

      // Transcriber starting after warmup starts instantly with zero fromHub calls
      const transcriber = createParakeetTranscriber({
        keepWarm: true,
        fromHub: fakeFromHub,
        supportsLanguage: () => true,
        captureOptions: {
          mediaStream: { getTracks: () => [] } as any,
          isTypeSupported: () => true,
        },
      })

      await transcriber.start()
      expect(fromHubCalls).toBe(1)
      await transcriber.stop()

      await disposeParakeetModel()
      expect(isParakeetModelWarmedUp()).toBe(false)
      expect(mockModel.disposed).toBe(true)
    })

    test("push-to-talk: startSegment, commit, and hasInFlight correctly finalize speech", async () => {
      const mockModel = new MockParakeetModel("wasm")
      const finals: any[] = []

      const capture = createMicCapture({
        mediaStream: {
          getTracks: () => [{ stop: () => {}, readyState: "live" }],
        } as any,
        isTypeSupported: () => true,
      })

      const transcriber = createParakeetTranscriber({
        capture,
        fromHub: async () => mockModel,
        supportsLanguage: () => true,
        onFinal: (evt) => finals.push(evt),
      })

      await transcriber.start()

      // Before speaking: no speech segment active
      expect(transcriber.hasInFlight).toBe(false)

      // Start PTT segment
      transcriber.startSegment()

      // Feed PCM audio chunk
      const frame = new Float32Array(1600)
      for (let i = 0; i < frame.length; i++) frame[i] = 0.1
      capture.processAudioFrame(frame, 16000)

      // Commit PTT segment
      const committed = transcriber.commit()
      expect(committed).toBe(true)

      // Wait for queue to drain
      await new Promise((r) => setTimeout(r, 60))

      expect(finals).toHaveLength(1)
      expect(finals[0].text).toBe("ciao mondo definitivo")
      expect(transcriber.hasInFlight).toBe(false)

      await transcriber.stop()
    })
  })
})
