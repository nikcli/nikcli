import type { TTSProvider, TTSProviderConfig, TTSRequest, TTSResponse, TTSVoice } from "@nikcli-ai/util/tts/provider"

const OPENROUTER_VOICES: TTSVoice[] = [
  { id: "alloy", name: "Alloy" },
  { id: "ash", name: "Ash" },
  { id: "ballad", name: "Ballad" },
  { id: "coral", name: "Coral" },
  { id: "echo", name: "Echo" },
  { id: "fable", name: "Fable" },
  { id: "nova", name: "Nova" },
  { id: "onyx", name: "Onyx" },
  { id: "sage", name: "Sage" },
  { id: "shimmer", name: "Shimmer" },
]

const DEFAULT_MODEL_ID = "openai/gpt-audio-mini"
const BASE_URL = "https://openrouter.ai/api/v1"

type OpenRouterErrorBody = {
  error?: {
    message?: string
  }
  message?: string
  detail?: string
}

type OpenRouterStreamChunk = {
  choices?: Array<{
    delta?: {
      audio?: {
        data?: string
      }
    }
  }>
}

function buildWavBuffer(pcmData: Uint8Array, sampleRate = 24000, channels = 1, bitsPerSample = 16): ArrayBuffer {
  const dataSize = pcmData.byteLength
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF
  view.setUint8(0, 0x52)
  view.setUint8(1, 0x49)
  view.setUint8(2, 0x46)
  view.setUint8(3, 0x46)
  view.setUint32(4, 36 + dataSize, true)
  view.setUint8(8, 0x57)
  view.setUint8(9, 0x41)
  view.setUint8(10, 0x56)
  view.setUint8(11, 0x45)
  // fmt
  view.setUint8(12, 0x66)
  view.setUint8(13, 0x6d)
  view.setUint8(14, 0x74)
  view.setUint8(15, 0x20)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, (sampleRate * channels * bitsPerSample) / 8, true)
  view.setUint16(32, (channels * bitsPerSample) / 8, true)
  view.setUint16(34, bitsPerSample, true)
  // data
  view.setUint8(36, 0x64)
  view.setUint8(37, 0x61)
  view.setUint8(38, 0x74)
  view.setUint8(39, 0x61)
  view.setUint32(40, dataSize, true)

  new Uint8Array(buffer, 44).set(pcmData)
  return buffer
}

export class OpenRouterProvider implements TTSProvider {
  readonly id = "openrouter"
  readonly name = "OpenRouter"
  readonly description = "OpenRouter OpenAI-compatible text-to-speech"

  protected config: TTSProviderConfig | null = null

  /**
   * Where the key comes from.
   *
   * Env only here, so the terminal can list voices and models without pulling
   * `Auth` and `Config` — and with them the Effect runtime — into its graph.
   * The server subclass overrides this to add `auth.json` and the provider
   * options in `nikcli.json`; nothing else about the provider differs, which is
   * why this is a hook rather than two implementations.
   */
  protected async resolveCredentials(): Promise<{ apiKey?: string; baseURL?: string }> {
    return {
      apiKey: process.env.NIKCLI_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY,
      baseURL: process.env.NIKCLI_OPENROUTER_BASE_URL,
    }
  }

  async getConfig(): Promise<TTSProviderConfig> {
    if (this.config) return this.config

    const resolved = await this.resolveCredentials()
    const apiKey = resolved.apiKey

    if (!apiKey || !apiKey.trim()) {
      throw new Error(
        [
          "OpenRouter API key not found.",
          "",
          "Set NIKCLI_OPENROUTER_API_KEY (or OPENROUTER_API_KEY),",
          "or run `nikcli auth login` and choose openrouter.",
        ].join("\n"),
      )
    }

    this.config = {
      apiKey: apiKey.trim(),
      baseURL: resolved.baseURL ?? BASE_URL,
      timeout: 30000,
    }
    return this.config
  }

  async getVoices(): Promise<TTSVoice[]> {
    return OPENROUTER_VOICES
  }

  async getAudioModels(_options?: { refresh?: boolean }): Promise<TTSVoice[]> {
    return [
      { id: "openai/gpt-audio-mini", name: "GPT Audio Mini" },
      { id: "openai/gpt-audio", name: "GPT Audio" },
      { id: "openai/gpt-4o-audio-preview", name: "GPT-4o Audio Preview" },
    ]
  }

  async speak(request: TTSRequest, options?: { signal?: AbortSignal }): Promise<TTSResponse> {
    const config = await this.getConfig()
    const modelId = request.modelId ?? DEFAULT_MODEL_ID
    const voiceId = request.voiceId || "alloy"

    const response = await fetch(`${config.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nikcli-ai.dev/",
        "X-Title": "nikcli",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: request.text }],
        modalities: ["text", "audio"],
        audio: { voice: voiceId, format: "pcm16" },
        stream: true,
      }),
      signal: options?.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      let errorDetail = errorText

      try {
        const parsed = JSON.parse(errorText) as OpenRouterErrorBody
        errorDetail = parsed.error?.message ?? parsed.message ?? parsed.detail ?? errorText
      } catch {
        // keep raw text
      }

      switch (response.status) {
        case 401:
          throw new Error("OpenRouter authentication failed (401). Your API key may be invalid or expired.")
        case 429:
          throw new Error("OpenRouter rate limit exceeded (429). Too many requests.")
        case 400:
          throw new Error(`OpenRouter bad request (400): ${errorDetail}`)
        default:
          throw new Error(`OpenRouter error (${response.status}): ${errorDetail}`)
      }
    }

    if (!response.body) throw new Error("OpenRouter: empty response body")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const audioChunks: string[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const data = trimmed.slice(5).trim()
        if (data === "[DONE]") continue

        try {
          const chunk = JSON.parse(data) as OpenRouterStreamChunk
          const audioData = chunk.choices?.[0]?.delta?.audio?.data
          if (audioData) audioChunks.push(audioData)
        } catch {
          // skip malformed SSE chunks
        }
      }
    }

    const allB64 = audioChunks.join("")
    if (!allB64) throw new Error("OpenRouter: no audio data in stream response")

    const binary = atob(allB64)
    const pcm = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) pcm[i] = binary.charCodeAt(i)

    return {
      audio: buildWavBuffer(pcm),
      contentType: "audio/wav",
      metadata: {
        provider: this.id,
        modelId,
        voiceId,
      },
    }
  }

  async validate(): Promise<{ valid: boolean; error?: string }> {
    try {
      const config = await this.getConfig()
      const response = await fetch(`${config.baseURL}/models`, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      })

      if (response.status === 401) {
        return { valid: false, error: "Invalid API key" }
      }

      if (!response.ok) {
        return { valid: false, error: `API returned status ${response.status}` }
      }

      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : "Unknown error" }
    }
  }
}

export const openRouterProvider = new OpenRouterProvider()
export const OPENROUTER_VOICES_LIST = OPENROUTER_VOICES
