import { Effect } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"

/**
 * Voice transcription, on the side that holds the key.
 *
 * The prompt used to do all of this in the terminal: resolve the OpenRouter API
 * key out of `auth.json` and `nikcli.json`, then post the recorded WAV straight
 * to OpenRouter. Recording is a device concern and stays there; the credential
 * is not. Moving the call — rather than exposing the key through a route — is
 * what keeps the terminal from needing `Auth` at all.
 */
export namespace VoiceTranscribe {
  const DEFAULT_MODEL = "openai/gpt-audio-mini"
  const BASE_URL = "https://openrouter.ai/api/v1"
  const PROMPT = "Transcribe this audio. Return only the transcript text without extra commentary."

  function endpoint(baseURL: string, path: string): string {
    return `${baseURL.replace(/\/+$/, "")}${path}`
  }

  /** A base URL is only honoured if it still points at OpenRouter. */
  function normalizeBaseURL(value: string | undefined): string {
    if (!value) return BASE_URL
    try {
      const parsed = new URL(value)
      if (!parsed.hostname.endsWith("openrouter.ai")) return BASE_URL
      return `${parsed.origin}/api/v1`
    } catch {
      return BASE_URL
    }
  }

  async function errorDetail(response: Response): Promise<string> {
    const text = await response.text().catch(() => "")
    if (!text) return response.statusText
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string }
      return parsed.error?.message ?? parsed.message ?? text
    } catch {
      return text
    }
  }

  async function credentials(): Promise<{ apiKey: string; baseURL: string }> {
    const auth = await runPromiseWithLayer(
      Auth.defaultLayer,
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return yield* auth.get("openrouter")
      }),
    ).catch(() => undefined)

    const config = await runPromiseWithLayer(
      Config.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const config = yield* Config.Service
          return yield* config.get()
        }),
      ),
    ).catch(() => ({}) as Config.Info)

    const options = (config as any)?.provider?.openrouter?.options ?? {}
    const optionApiKey = typeof options.apiKey === "string" ? options.apiKey : undefined

    const apiKey =
      process.env.NIKCLI_OPENROUTER_API_KEY ??
      process.env.OPENROUTER_API_KEY ??
      (auth?.type === "api" ? auth.key : undefined) ??
      optionApiKey

    if (!apiKey || !apiKey.trim()) {
      throw new Error("OpenRouter API key not configured")
    }

    return {
      apiKey: apiKey.trim(),
      baseURL: normalizeBaseURL(
        process.env.NIKCLI_OPENROUTER_BASE_URL ??
          process.env.OPENROUTER_BASE_URL ??
          (typeof options.baseURL === "string" ? options.baseURL : undefined),
      ),
    }
  }

  function model(): string {
    return process.env.NIKCLI_VOICE_TRANSCRIBE_MODEL ?? DEFAULT_MODEL
  }

  /** The `/responses` shape, used when `/chat/completions` fails for any reason but credit. */
  async function viaResponses(
    audio: string,
    format: string,
    config: { apiKey: string; baseURL: string },
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(endpoint(config.baseURL, "/responses"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nikcli-ai.dev/",
        "X-Title": "nikcli",
      },
      body: JSON.stringify({
        model: model(),
        temperature: 0,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: PROMPT },
              { type: "input_audio", input_audio: { data: audio, format } },
            ],
          },
        ],
      }),
      signal,
    })

    if (!response.ok) {
      throw new Error(`OpenRouter transcription failed (${response.status}): ${await errorDetail(response)}`)
    }

    const result = (await response.json()) as {
      output_text?: string
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
    }

    const fromOutputText = (result.output_text ?? "").trim()
    if (fromOutputText) return fromOutputText

    const fromContent =
      result.output
        ?.flatMap((x) => x.content ?? [])
        .map((x) => (x.type === "output_text" && x.text ? x.text : ""))
        .join(" ")
        .trim() ?? ""

    if (!fromContent) throw new Error("No transcript returned")
    return fromContent
  }

  function extractTranscript(content: unknown): string {
    if (typeof content === "string") return content.trim()
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part
          if (part && typeof part === "object" && "text" in part) {
            const text = (part as { text?: unknown }).text
            return typeof text === "string" ? text : ""
          }
          return ""
        })
        .join(" ")
        .trim()
    }
    return ""
  }

  /**
   * Transcribe a recording. `audio` is base64; `format` is the container.
   *
   * A 402 is re-thrown rather than retried — the second endpoint would fail the
   * same way, and "credits required" is the answer the user needs.
   */
  export async function run(input: { audio: string; format?: string }): Promise<string> {
    if (!input.audio) throw new Error("Recorded audio is empty")
    const format = input.format ?? "wav"
    const config = await credentials()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)

    try {
      const response = await fetch(endpoint(config.baseURL, "/chat/completions"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://nikcli-ai.dev/",
          "X-Title": "nikcli",
        },
        body: JSON.stringify({
          model: model(),
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: PROMPT },
                { type: "input_audio", input_audio: { data: input.audio, format } },
              ],
            },
          ],
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const detail = await errorDetail(response)
        if (response.status === 402) throw new Error(`OpenRouter audio credits required: ${detail}`)
        throw new Error(`OpenRouter transcription failed (${response.status}): ${detail}`)
      }

      const result = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>
      }
      const transcript = extractTranscript(result.choices?.[0]?.message?.content)
      if (!transcript) throw new Error("No transcript returned")
      return transcript
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      if (message.includes("credits required") || message.includes("(402)")) throw error
      return viaResponses(input.audio, format, config, controller.signal)
    } finally {
      clearTimeout(timeout)
    }
  }
}
