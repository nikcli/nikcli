/**
 * One-shot model calls: a completion, or an object that matches a schema.
 *
 * What the session streams goes through `LLM.stream`; this is for everything else that asks a model a
 * single question (titles' neighbours: the advisor, the auto-mode critique, mods' `model.complete`, the
 * chatbot, agent generation). They resolve the model the same way a turn does — `Provider.getModelRef`,
 * the provider's own `fetch` for OAuth and account tokens, `ProviderTransform` for message
 * normalisation and options — and run on `@nikcli-ai/llm`. A model with no native route fails with a
 * clear error rather than reaching for another runtime.
 */
import { Effect } from "effect"
import { Config } from "@/config/config"
import { generateLegacyText, generateLegacyObject } from "@/provider/legacy/call"
import { Runtime as LLMRuntime, type ProviderOptions } from "@nikcli-ai/llm"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { LoadAPIKeyError, NoNativeRouteError } from "@/provider/error"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { LLM } from "../llm"
import { toLLMProviderOptions } from "./native-request"
import type { JSONSchema7, ModelMessage } from "./types"

export type CallInput = {
  model: Provider.Model
  system?: string | readonly string[]
  messages?: ModelMessage[]
  prompt?: string
  temperature?: number
  maxOutputTokens?: number
  abort?: AbortSignal
  /** Options in the provider's own shape (e.g. `{ instructions, store }` for OpenAI), keyed as `ProviderTransform.providerOptions` expects. */
  providerOptions?: Record<string, unknown>
  headers?: Record<string, string>
}

export type CallUsage = { inputTokens?: number; outputTokens?: number }

async function nativeEnabled() {
  return runPromiseWithLayer(
    Config.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        return (yield* (yield* Config.Service).get()).experimental?.nativeLlm !== false
      }),
    ),
  )
}

function canFallback(error: unknown, input: CallInput) {
  return !input.abort?.aborted && !(error instanceof Error && error.name === "AbortError")
}

async function prepare(input: CallInput) {
  const { modelRef, provider } = await runPromiseWithLayer(
    Provider.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const service = yield* Provider.Service
        return {
          modelRef: yield* service.getModelRef(input.model),
          provider: yield* service.getProvider(input.model.providerID),
        }
      }),
    ),
  )
  if (!provider || !modelRef) {
    throw new NoNativeRouteError({
      providerID: input.model.providerID,
      modelID: input.model.id,
    })
  }
  const apiKey = typeof provider.options.apiKey === "string" ? provider.options.apiKey : provider.key
  if (!apiKey && typeof provider.options.fetch !== "function") {
    throw new LoadAPIKeyError(`API key is missing for provider ${provider.id}`)
  }

  const messages: ModelMessage[] = [
    ...(input.messages ?? []),
    ...(input.prompt === undefined ? [] : [{ role: "user", content: input.prompt } as ModelMessage]),
  ]
  const system = (typeof input.system === "string" ? [input.system] : [...(input.system ?? [])]).filter(Boolean)
  const request = LLM.buildLLMRequest(
    {
      system,
      // `message` rewrites in place; the native route places its own cache breakpoints.
      messages: ProviderTransform.message(
        messages.map((m) => ({ ...m })) as ModelMessage[],
        input.model,
        {},
        { cache: false },
      ),
      tools: {},
    },
    modelRef,
    {
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      providerOptions: input.providerOptions
        ? (toLLMProviderOptions(
            modelRef.route,
            ProviderTransform.providerOptions(input.model, input.providerOptions),
          ) as ProviderOptions)
        : undefined,
    },
    input.headers,
  )
  return {
    request,
    fetch: Provider.nativeFetch(provider),
    signal: input.abort,
  }
}

/** Ask a model for text. */
export async function generateText(input: CallInput): Promise<{ text: string; usage?: CallUsage }> {
  if (!(await nativeEnabled())) return generateLegacyText(input)
  try {
    const { request, fetch, signal } = await prepare(input)
    const response = await LLMRuntime.generateRequest(request, {
      fetch,
      signal,
    })
    return {
      text: response.text,
      usage: response.usage
        ? {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
          }
        : undefined,
    }
  } catch (error) {
    if (!canFallback(error, input)) throw error
    return generateLegacyText(input)
  }
}

/**
 * Ask a model for an object matching `schema`. The model is forced to call a synthetic tool whose
 * parameters are the schema, which every protocol supports; the caller validates the result.
 */
export async function generateObject(input: CallInput & { schema: JSONSchema7 }): Promise<{ object: unknown }> {
  if (!(await nativeEnabled())) return generateLegacyObject(input)
  try {
    const { request, fetch, signal } = await prepare(input)
    const result = await LLMRuntime.generateObjectRequest(
      {
        model: request.model,
        system: request.system,
        messages: request.messages,
        generation: request.generation,
        providerOptions: request.providerOptions,
        http: request.http,
        jsonSchema: input.schema as never,
      },
      { fetch, signal },
    )
    return { object: result.object }
  } catch (error) {
    if (!canFallback(error, input)) throw error
    return generateLegacyObject(input)
  }
}

// ── Images ──────────────────────────────────────────────────────────────────

export type ImageInput = {
  model: Provider.Model
  prompt: string
  n?: number
  /** `{width}x{height}` */
  size?: string
  /** `{width}:{height}` */
  aspectRatio?: string
  seed?: number
  /** Raw fields merged into the request body, keyed by provider (`{ openai: { quality: "high" } }`). */
  providerOptions?: Record<string, Record<string, unknown>>
  abort?: AbortSignal
  headers?: Record<string, string>
}

export type GeneratedImage = { base64: string; mediaType: string }

const IMAGE_HOSTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  openrouter: "https://openrouter.ai/api/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
}

function sniffMediaType(base64: string): string {
  const head = Buffer.from(base64.slice(0, 24), "base64")
  if (head[0] === 0x89 && head[1] === 0x50) return "image/png"
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg"
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp"
  return "image/png"
}

/**
 * Generate images. The image APIs are plain JSON over HTTP and differ by vendor only in body fields:
 * OpenAI, xAI, Together and OpenRouter share `/images/generations`; Google's Imagen is a `:predict`
 * call. The provider's own `fetch` is used when it has one, as for chat.
 */
export async function generateImage(input: ImageInput): Promise<{ images: GeneratedImage[]; warnings: string[] }> {
  const provider = await runPromiseWithLayer(
    Provider.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        return yield* (yield* Provider.Service).getProvider(input.model.providerID)
      }),
    ),
  )
  if (!provider) throw new Error(`Provider ${input.model.providerID} is not configured`)

  const vendor = input.model.providerID.includes("openrouter") ? "openrouter" : input.model.providerID.split(".")[0]!
  const configured = input.model.api.url || (provider.options.baseURL as string | undefined)
  const baseURL = (configured || IMAGE_HOSTS[vendor] || "").replace(/\/+$/, "")
  if (!baseURL) throw new Error(`No image endpoint is known for provider ${input.model.providerID}`)

  const apiKey = (typeof provider.options.apiKey === "string" ? provider.options.apiKey : provider.key) || ""
  const send = Provider.nativeFetch(provider) ?? globalThis.fetch
  const warnings: string[] = []
  const extra = input.providerOptions?.[vendor] ?? input.providerOptions?.[input.model.providerID] ?? {}
  const modelID = input.model.api.id
  const n = input.n ?? 1

  let url: string
  let body: Record<string, unknown>
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(provider.options.headers as Record<string, string> | undefined),
    ...input.model.headers,
    ...input.headers,
  }

  if (vendor === "google") {
    url = `${baseURL}/models/${modelID}:predict`
    headers["x-goog-api-key"] = apiKey
    body = {
      instances: [{ prompt: input.prompt }],
      parameters: {
        sampleCount: n,
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...extra,
      },
    }
    if (input.size) warnings.push("size is not supported by this model; use aspectRatio")
    if (input.seed !== undefined) warnings.push("seed is not supported by this model")
  } else {
    url = `${baseURL}/images/generations`
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    body = { model: modelID, prompt: input.prompt, n }
    if (vendor === "xai") {
      if (input.aspectRatio) body.aspect_ratio = input.aspectRatio
      if (input.size) warnings.push("size is not supported by this model; use aspectRatio")
      body.response_format = "b64_json"
    } else if (vendor === "togetherai") {
      if (input.size) {
        const [width, height] = input.size.split("x").map(Number)
        body.width = width
        body.height = height
      }
      if (input.aspectRatio) warnings.push("aspectRatio is not supported by this model; use size")
      if (input.seed !== undefined) body.seed = input.seed
      body.response_format = "base64"
    } else {
      if (input.size) body.size = input.size
      if (input.aspectRatio) warnings.push("aspectRatio is not supported by this model; use size")
      if (input.seed !== undefined) warnings.push("seed is not supported by this model")
      // The gpt-image models always return base64 and reject the field.
      if (!/^(chatgpt-image|gpt-image)/.test(modelID)) body.response_format = "b64_json"
    }
    Object.assign(body, extra)
  }

  const response = await send(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: input.abort,
  })
  if (!response.ok) {
    throw new Error(`Image generation failed (${response.status}): ${(await response.text()).slice(0, 500)}`)
  }
  const json = (await response.json()) as {
    data?: Array<{ b64_json?: string }>
    predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>
  }
  const images: GeneratedImage[] = [
    ...(json.data ?? []).flatMap((item) =>
      item.b64_json ? [{ base64: item.b64_json, mediaType: sniffMediaType(item.b64_json) }] : [],
    ),
    ...(json.predictions ?? []).flatMap((item) =>
      item.bytesBase64Encoded
        ? [
            {
              base64: item.bytesBase64Encoded,
              mediaType: item.mimeType ?? sniffMediaType(item.bytesBase64Encoded),
            },
          ]
        : [],
    ),
  ]
  if (images.length === 0) throw new Error("The image API returned no images")
  return { images, warnings }
}
