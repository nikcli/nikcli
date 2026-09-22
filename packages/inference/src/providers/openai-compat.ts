import type { ChatMessage } from "../types"
import { BaseProvider } from "./index"

export interface ProviderDefinition {
  name: string
  baseUrl: string
  envKey: string
  /** Some providers (e.g. Anthropic) speak a non-OpenAI dialect; default is OpenAI-compatible chat. */
  dialect?: "openai" | "anthropic"
  /** Extra headers attached to every request. */
  headers?: Record<string, string>
}

/**
 * Public catalog of inference providers we can route to. Pricing lives in
 * `src/config/routing.ts` per (model, provider).
 *
 * A provider is auto-enabled iff its `envKey` is present in process.env at boot.
 */
export const PROVIDER_DEFS = {
  local: {
    name: "local",
    baseUrl: process.env.VLLM_BASE_URL ?? "http://localhost:8000/v1",
    envKey: "LOCAL_API_KEY",
  },
  together: {
    name: "together",
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
  },
  fireworks: {
    name: "fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envKey: "FIREWORKS_API_KEY",
  },
  deepinfra: {
    name: "deepinfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    envKey: "DEEPINFRA_API_KEY",
  },
  groq: {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
  },
  cerebras: {
    name: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
  },
  sambanova: {
    name: "sambanova",
    baseUrl: "https://api.sambanova.ai/v1",
    envKey: "SAMBANOVA_API_KEY",
  },
  hyperbolic: {
    name: "hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    envKey: "HYPERBOLIC_API_KEY",
  },
  nebius: {
    name: "nebius",
    baseUrl: "https://api.studio.nebius.ai/v1",
    envKey: "NEBIUS_API_KEY",
  },
  openrouter: {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    headers: {
      "HTTP-Referer": process.env.OPENROUTER_REFERRER ?? "https://nikcli-ai.dev",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "nikcli-inference",
    },
  },
  deepseek: {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
  },
  mistral: {
    name: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
  },
  moonshot: {
    name: "moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    envKey: "MOONSHOT_API_KEY",
  },
  zhipu: {
    name: "zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    envKey: "ZHIPU_API_KEY",
  },
} as const satisfies Record<string, ProviderDefinition>

export type ProviderName = keyof typeof PROVIDER_DEFS

/**
 * Generic provider for any OpenAI-compatible /chat/completions endpoint.
 * All upstream providers (except a future Anthropic adapter) use this directly.
 */
export class OpenAICompatProvider extends BaseProvider {
  name: string
  apiKey: string
  baseUrl: string
  private extraHeaders: Record<string, string>

  constructor(def: ProviderDefinition, apiKey?: string) {
    super()
    this.name = def.name
    this.baseUrl = def.baseUrl
    this.apiKey = apiKey ?? process.env[def.envKey] ?? ""
    this.extraHeaders = def.headers ?? {}
  }

  async chatCompletions(
    model: string,
    messages: ChatMessage[],
    options: {
      temperature?: number
      maxTokens?: number
      stream?: boolean
      tools?: unknown
      tool_choice?: unknown
      response_format?: unknown
      stop?: unknown
      seed?: number
      top_p?: number
      reasoning?: { effort?: "low" | "medium" | "high"; enabled?: boolean; max_tokens?: number; exclude?: boolean }
      extra?: Record<string, unknown>
    } = {},
  ): Promise<Response> {
    // Convert array content to string format for providers that expect string content
    const convertedMessages = messages.map((msg) => ({
      ...msg,
      content: BaseProvider.contentToString(msg.content),
    }))

    const body: Record<string, unknown> = {
      model,
      messages: convertedMessages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: options.stream ?? false,
    }
    if (options.top_p !== undefined) body.top_p = options.top_p
    if (options.tools !== undefined) body.tools = options.tools
    if (options.tool_choice !== undefined) body.tool_choice = options.tool_choice
    if (options.response_format !== undefined) body.response_format = options.response_format
    if (options.stop !== undefined) body.stop = options.stop
    if (options.seed !== undefined) body.seed = options.seed
    if (options.reasoning !== undefined) body.reasoning = options.reasoning
    if (options.extra) Object.assign(body, options.extra)

    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    })
  }

  override async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(3_000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}
