import { describe, expect, test } from "bun:test"
import {
  blobToBase64,
  createOpenRouterTranscriber,
  mimeToAudioFormat,
  OPENROUTER_ENDPOINT,
  OPENROUTER_MODEL,
  OPENROUTER_FALLBACK_MODEL,
  normalizeRequestLanguage,
  sanitizeApiKey,
  type OpenRouterUsage,
} from "./openrouter"
import { createMicCapture } from "../audio/capture"

describe("asr/openrouter", () => {
  test("mimeToAudioFormat extracts short extension format from complex MIME strings", () => {
    expect(mimeToAudioFormat("audio/webm;codecs=opus")).toBe("webm")
    expect(mimeToAudioFormat("audio/webm")).toBe("webm")
    expect(mimeToAudioFormat("audio/mp4")).toBe("m4a")
    expect(mimeToAudioFormat("audio/x-m4a")).toBe("m4a")
    expect(mimeToAudioFormat("audio/wav")).toBe("wav")
    expect(mimeToAudioFormat("audio/mp3")).toBe("mp3")
  })

  test("blobToBase64 produces pure base64 without 'data:' prefix or comma", async () => {
    const rawData = "RIFF....WAVEfmt simulated audio data"
    const blob = new Blob([rawData], { type: "audio/webm;codecs=opus" })
    const base64 = await blobToBase64(blob)

    expect(base64).not.toContain("data:")
    expect(base64).not.toContain(",")
    expect(base64.length).toBeGreaterThan(0)
  })

  test("sends exact body shape, short format, and Bearer authorization header", async () => {
    const SECRET_KEY = "test-sk-openrouter-9999"
    let capturedUrl = ""
    let capturedOptions: any = null
    const finals: any[] = []
    const usages: OpenRouterUsage[] = []

    const mockFetch = async (url: any, opts: any) => {
      capturedUrl = String(url)
      capturedOptions = opts
      return new Response(
        JSON.stringify({
          text: "apri il file sorgente",
          usage: {
            seconds: 3.2,
            total_tokens: 24,
            input_tokens: 18,
            output_tokens: 6,
            cost: 0.00015,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    }

    const capture = createMicCapture({
      mediaStream: { getTracks: () => [] } as any,
      isTypeSupported: () => true,
    })

    const transcriber = createOpenRouterTranscriber({
      apiKey: SECRET_KEY,
      capture,
      fetch: mockFetch as any,
      onFinal: (evt) => finals.push(evt),
      onUsage: (u) => usages.push(u),
    })

    await transcriber.start()

    // Simulate speech segment arriving from capture pipeline
    const segmentBlob = new Blob(["fake-audio-bytes"], { type: "audio/webm;codecs=opus" })
    ;(capture as any).stop() // triggers callbacks safely

    // Directly trigger onSegment through capture
    const segmentHandlers = (capture as any)
    // Emit segment to transcriber
    const segment = {
      blob: segmentBlob,
      format: "webm" as const,
      mimeType: "audio/webm;codecs=opus",
      durationMs: 3200,
    }

    // Trigger the registered segment listener
    const onSegmentMethod = (capture as any)
    // Dispatch segment to transcriber by triggering segment callback
    // We can simulate this by triggering capture's internal listener or using a test capture
    const testCapture = createMicCapture({
      mediaStream: { getTracks: () => [] } as any,
      isTypeSupported: () => true,
    })

    let registeredSegmentCb: any = null
    testCapture.onSegment = (cb: any) => {
      registeredSegmentCb = cb
    }

    const liveTranscriber = createOpenRouterTranscriber({
      apiKey: SECRET_KEY,
      capture: testCapture,
      fetch: mockFetch as any,
      onFinal: (evt) => finals.push(evt),
      onUsage: (u) => usages.push(u),
    })

    await liveTranscriber.start()
    await registeredSegmentCb(segment)

    expect(capturedUrl).toBe(OPENROUTER_ENDPOINT)
    expect(capturedOptions.method).toBe("POST")
    expect(capturedOptions.headers["Authorization"]).toBe(`Bearer ${SECRET_KEY}`)
    expect(capturedOptions.headers["Content-Type"]).toBe("application/json")

    const body = JSON.parse(capturedOptions.body)
    expect(body.model).toBe(OPENROUTER_MODEL)
    expect(body.language).toBe("it")
    expect(body.temperature).toBe(0)
    expect(body.input_audio).toBeDefined()
    expect(body.input_audio.format).toBe("webm")
    expect(body.input_audio.format).not.toContain("audio/")
    expect(body.input_audio.data).not.toContain("data:")
    expect(body.input_audio.data).not.toContain(",")

    // Final transcription event received
    expect(finals).toHaveLength(1)
    expect(finals[0].text).toBe("apri il file sorgente")

    // Usage tracking
    expect(liveTranscriber.lastUsage).toEqual({
      seconds: 3.2,
      total_tokens: 24,
      input_tokens: 18,
      output_tokens: 6,
      cost: 0.00015,
    })
    expect(liveTranscriber.getLastUsage()?.cost).toBe(0.00015)
    expect(usages).toHaveLength(1)
  })

  /*
   * The language picker was decorative: the code was validated, stored, and
   * listed from the model's own inventory, and then every request body said
   * `language: "it"`. Choosing English produced Italian-shaped nonsense with
   * nothing in the interface to explain it.
   */
  describe("the chosen language reaches the request", () => {
    /** Runs one segment through the transcriber and returns the parsed body. */
    async function bodyFor(language: string | undefined): Promise<any> {
      let captured: any = null
      const mockFetch = async (_url: any, opts: any) => {
        captured = opts
        return new Response(JSON.stringify({ text: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }

      let segmentCb: any = null
      const capture = createMicCapture({
        mediaStream: { getTracks: () => [] } as any,
        isTypeSupported: () => true,
      })
      capture.onSegment = (cb: any) => {
        segmentCb = cb
      }

      const transcriber = createOpenRouterTranscriber({
        apiKey: "test-key",
        capture,
        fetch: mockFetch as any,
        ...(language === undefined ? {} : { language }),
      })

      await transcriber.start()
      await segmentCb({
        blob: new Blob(["fake-audio-bytes"], { type: "audio/webm;codecs=opus" }),
        format: "webm" as const,
        mimeType: "audio/webm;codecs=opus",
        durationMs: 1000,
      })

      return JSON.parse(captured.body)
    }

    test("English is asked for as English", async () => {
      expect((await bodyFor("en")).language).toBe("en")
    })

    test("auto sends no language at all, which is how detection is requested", async () => {
      const body = await bodyFor("auto")
      expect("language" in body).toBe(false)
    })

    test("a caller that never mentions a language keeps the old behaviour", async () => {
      expect((await bodyFor(undefined)).language).toBe("it")
    })
  })

  describe("normalizeRequestLanguage", () => {
    test("lowercases and trims what the settings hold", () => {
      expect(normalizeRequestLanguage(" EN ")).toBe("en")
    })

    test("auto and empty mean no field; absent means the old default", () => {
      expect(normalizeRequestLanguage("auto")).toBeUndefined()
      expect(normalizeRequestLanguage("")).toBeUndefined()
      expect(normalizeRequestLanguage("   ")).toBeUndefined()
      expect(normalizeRequestLanguage(undefined)).toBe("it")
    })
  })

  test("401 and 402 status codes yield two distinct Italian error messages", async () => {
    let currentStatus = 401
    const errors: Error[] = []

    const mockFetch = async () => {
      return new Response(JSON.stringify({ error: "Auth problem" }), {
        status: currentStatus,
      })
    }

    let segmentCb: any = null
    const capture = {
      start: async () => {},
      stop: () => {},
      onSegment: (cb: any) => { segmentCb = cb },
      onError: () => {},
    } as any

    const transcriber = createOpenRouterTranscriber({
      apiKey: "test-key",
      capture,
      fetch: mockFetch as any,
      onError: (err) => errors.push(err),
    })

    await transcriber.start()

    // Test 401
    currentStatus = 401
    await segmentCb({
      blob: new Blob(["audio"]),
      format: "webm",
      durationMs: 1000,
    })

    expect(errors).toHaveLength(1)
    const err401 = errors[0].message
    expect(err401).toContain("chiave OpenRouter non funziona")

    // Test 402
    currentStatus = 402
    await segmentCb({
      blob: new Blob(["audio"]),
      format: "webm",
      durationMs: 1000,
    })

    expect(errors).toHaveLength(2)
    const err402 = errors[1].message
    expect(err402).toContain("credito OpenRouter è finito")

    // Must be completely distinct messages
    expect(err401).not.toBe(err402)
  })

  test("request timeout produces an Italian timeout error and leaves transcriber operational", async () => {
    const errors: Error[] = []

    // Mock fetch that respects AbortSignal and aborts
    const mockHangingFetch = async (_url: any, opts: any) => {
      return new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => {
          const abortErr = new Error("The operation was aborted")
          abortErr.name = "AbortError"
          reject(abortErr)
        })
      })
    }

    let segmentCb: any = null
    const capture = {
      start: async () => {},
      stop: () => {},
      onSegment: (cb: any) => { segmentCb = cb },
      onError: () => {},
    } as any

    const transcriber = createOpenRouterTranscriber({
      apiKey: "test-key",
      capture,
      timeoutMs: 20, // fast timeout for test
      fetch: mockHangingFetch as any,
      onError: (err) => errors.push(err),
    })

    await transcriber.start()

    await segmentCb({
      blob: new Blob(["audio"]),
      format: "webm",
      durationMs: 1000,
    })

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("non ha risposto")

    // Transcriber should not be locked; stop() can be called cleanly
    transcriber.stop()
  })

  test("STRICT SECURITY GUARANTEE: API key never appears in any error message", async () => {
    const SECRET_KEY = "sk-or-super-secret-bearer-key-xyz999"
    const errors: Error[] = []

    // Simulate an upstream error body that maliciously or accidentally echoes the key
    const mockLeakingFetch = async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: `Invalid access with token ${SECRET_KEY} while processing audio`,
          },
        }),
        { status: 500 }
      )
    }

    let segmentCb: any = null
    const capture = {
      start: async () => {},
      stop: () => {},
      onSegment: (cb: any) => { segmentCb = cb },
      onError: () => {},
    } as any

    const transcriber = createOpenRouterTranscriber({
      apiKey: SECRET_KEY,
      capture,
      fetch: mockLeakingFetch as any,
      onError: (err) => errors.push(err),
    })

    await transcriber.start()

    await segmentCb({
      blob: new Blob(["audio"]),
      format: "webm",
      durationMs: 1000,
    })

    expect(errors).toHaveLength(1)
    const emittedError = errors[0].message

    // Crucial safety assertion: the secret key must NEVER appear in the error message
    expect(emittedError).not.toContain(SECRET_KEY)
    expect(emittedError).toContain("[REDACTED]")

    // Also verify sanitizeApiKey helper directly
    expect(sanitizeApiKey(`key ${SECRET_KEY}`, SECRET_KEY)).toBe("key [REDACTED]")
  })

  test("automatically falls back to openai/whisper-large-v3 when primary model returns 400", async () => {
    const attempts: any[] = []
    const finals: any[] = []

    const mockFetch = async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body)
      attempts.push(body)

      if (body.model === OPENROUTER_MODEL) {
        return new Response(JSON.stringify({ error: { message: "Provider returned 400" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }

      if (body.model === OPENROUTER_FALLBACK_MODEL) {
        return new Response(JSON.stringify({ text: "trascrizione recuperata da whisper" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }

      return new Response("Unknown model", { status: 404 })
    }

    let segmentCb: any = null
    const capture = {
      start: async () => {},
      stop: () => {},
      onSegment: (cb: any) => { segmentCb = cb },
      onError: () => {},
    } as any

    const transcriber = createOpenRouterTranscriber({
      apiKey: "test-key",
      capture,
      fetch: mockFetch as any,
      onFinal: (evt) => finals.push(evt),
    })

    await transcriber.start()

    await segmentCb({
      blob: new Blob(["audio-bytes"]),
      format: "wav",
      durationMs: 1500,
    })

    // First attempt was mai-transcribe-2, second was retry without language/temp, third was fallback whisper-large-v3
    expect(attempts.some((a) => a.model === OPENROUTER_FALLBACK_MODEL)).toBe(true)
    expect(finals).toHaveLength(1)
    expect(finals[0].text).toBe("trascrizione recuperata da whisper")
  })

  test("a rate-limited primary model (429) goes straight to the fallback model", async () => {
    const attempts: any[] = []
    const finals: any[] = []
    const mockFetch = async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body)
      attempts.push(body.model)
      if (body.model === OPENROUTER_MODEL) {
        return new Response(JSON.stringify({ error: { message: "Provider returned 429" } }), { status: 429 })
      }
      return new Response(JSON.stringify({ text: "capitale dell'Australia" }), { status: 200 })
    }
    let segmentCb: any = null
    const capture = { start: async () => {}, stop: () => {}, onSegment: (cb: any) => { segmentCb = cb }, onError: () => {} } as any
    const transcriber = createOpenRouterTranscriber({ apiKey: "test-key", capture, fetch: mockFetch as any, onFinal: (evt) => finals.push(evt) })
    await transcriber.start()
    await segmentCb({ blob: new Blob(["audio-bytes"]), format: "wav", durationMs: 1500 })
    expect(attempts).toEqual([OPENROUTER_MODEL, OPENROUTER_FALLBACK_MODEL])
    expect(finals.map((f) => f.text)).toEqual(["capitale dell'Australia"])
  })

  test("extracts text from segments array when text field is missing", async () => {
    const finals: any[] = []
    const mockFetch = async () => {
      return new Response(
        JSON.stringify({
          segments: [
            { text: "ciao" },
            { text: "mondo" },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    }

    let segmentCb: any = null
    const capture = {
      start: async () => {},
      stop: () => {},
      onSegment: (cb: any) => { segmentCb = cb },
      onError: () => {},
    } as any

    const transcriber = createOpenRouterTranscriber({
      apiKey: "test-key",
      capture,
      fetch: mockFetch as any,
      onFinal: (evt) => finals.push(evt),
    })

    await transcriber.start()

    await segmentCb({
      blob: new Blob(["audio-bytes"]),
      format: "wav",
      durationMs: 1500,
    })

    expect(finals).toHaveLength(1)
    expect(finals[0].text).toBe("ciao mondo")
  })
})

