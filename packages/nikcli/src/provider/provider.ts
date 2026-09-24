import fuzzysort from "fuzzysort"
import { parseModel as parseModelLight } from "@nikcli-ai/util/model"
import * as ProviderSchema from "./schema"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "@nikcli-ai/util/log"
import { BunProc } from "../bun"
import { Plugin } from "../plugin"
import type { Hooks as PluginHooks } from "@nikcli-ai/plugin"
import { GPT_RESERVE_ID, ModelsDev } from "./models"
import { reasoningVariants } from "./variants"

import { Auth } from "../auth"
import { Account } from "../account"
import { Env } from "../env"
import { Flag } from "@nikcli-ai/util/flag"
import { iife } from "@nikcli-ai/util/iife"
import { Context, Effect, Exit, Layer, Schema, ScopedCache } from "effect"
import { InstanceState, locallyInstance, runPromiseWithLayer, type InstanceContext } from "@/effect"

// Bundled provider SDKs are loaded lazily (see BUNDLED_PROVIDERS): evaluating
// all twenty packages eagerly costs ~2s at process start, while a session only
// ever touches the ones it actually uses.
import type { AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import type { LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import type { createGitLab } from "@gitlab/gitlab-ai-provider"
import { ProviderTransform } from "./transform"
import * as CachePolicy from "./cache-policy"
import { ProviderError } from "./error"
import { Policy } from "@/policy/policy"
import { spreadIf } from "@/util/optional-key"
import {
  NIKCLI_INFERENCE_DEFAULT_URL,
  NIKCLI_INFERENCE_ENV,
  NIKCLI_INFERENCE_ID,
  toModelsDevModel,
  type GatewayModel,
} from "./nikcli-inference"

// @nikcli-ai/llm provider factories for the new route-based model ref system
import {
  OpenAI,
  Anthropic,
  Google,
  AmazonBedrock,
  Azure,
  XAI,
  OpenRouter,
  GitHubCopilot,
  OpenAICompatible,
} from "@nikcli-ai/llm/providers"
import { byProvider as providerProfiles } from "@nikcli-ai/llm/providers/openai-compatible-profile"
import type { ModelRef } from "@nikcli-ai/llm"
import z from "zod"

function runAuth<A, E>(effect: Effect.Effect<A, E, Auth.Service | Config.Service>) {
  return runPromiseWithLayer(Layer.merge(Auth.defaultLayer, Config.defaultLayer), effect)
}

function runPlugin<A, E>(effect: Effect.Effect<A, E, Plugin.Service>, ctx: InstanceContext) {
  return runPromiseWithLayer(Plugin.defaultLayer, locallyInstance(ctx, effect))
}

function authGet(providerID: string): Promise<Auth.Info | undefined> {
  return runAuth(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const direct = yield* auth.get(providerID)
      if (direct) return direct
      // Opencode #28489: fall back to `auth_provider` when the provider config
      // declares one. The resolution is read-time only; no side effects.
      const cfg = yield* Config.Service
      const info = yield* cfg.get()
      const alias = info.provider?.[providerID]
      if (alias?.auth_provider && alias.auth_provider !== providerID) {
        return yield* auth.get(alias.auth_provider)
      }
      return undefined
    }),
  )
}

function authAll(): Promise<Record<string, Auth.Info>> {
  return runAuth(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      return yield* auth.all()
    }),
  )
}

function pluginList(ctx: InstanceContext): Promise<PluginHooks[]> {
  return runPlugin(
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      return yield* plugin.list()
    }),
    ctx,
  )
}

function configGet(ctx: InstanceContext): Promise<Config.Info> {
  const effect = Effect.gen(function* () {
    const config = yield* Config.Service
    return yield* config.get()
  })
  return runPromiseWithLayer(Config.defaultLayer, locallyInstance(ctx, effect))
}

export namespace Provider {
  export const Model = ProviderSchema.Model
  export type Model = ProviderSchema.Model
  export const Info = ProviderSchema.Info
  export type Info = ProviderSchema.Info
  export const ModelSchema = ProviderSchema.ModelSchema
  export const InfoSchema = ProviderSchema.InfoSchema

  const log = Log.create({ service: "provider" })
  const OPENAI_HEADER_TIMEOUT_DEFAULT = 120_000

  function normalizeBaseURL(baseURL: string): string {
    return baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL
  }

  const RequestyPrice = z
    .number()
    .refine((value) => Number.isFinite(value) && value >= 0)
    .transform((value) => value * 1_000_000)
    .catch(0)

  const RequestyEpochSeconds = z
    .number()
    .refine((value) => Number.isFinite(value))
    .nullable()
    .catch(null)

  const RequestyPositiveInt = (fallback: number) =>
    z
      .number()
      .refine((value) => value > 0)
      .catch(fallback)

  const RequestyModel = z
    .object({
      id: z.string().trim().min(1),
      created: RequestyEpochSeconds,
      input_price: RequestyPrice,
      output_price: RequestyPrice,
      cached_price: RequestyPrice,
      context_window: RequestyPositiveInt(128_000),
      max_output_tokens: RequestyPositiveInt(4096),
      supports_reasoning: z.boolean().optional(),
      supports_vision: z.boolean().optional(),
      supports_tool_calling: z.boolean().optional(),
      supports_image_generation: z.boolean().optional(),
    })
    .refine((item) => !["__proto__", "constructor", "prototype"].includes(item.id))

  function normalizeOllamaV1BaseURL(baseURL: string): string {
    const url = normalizeBaseURL(baseURL)
    if (url.endsWith("/v1")) return url
    return `${url}/v1`
  }

  function isProbablyOllamaImageModel(modelID: string): boolean {
    const id = modelID.toLowerCase()
    if (id.includes("gpt-image")) return true
    if (id.includes("dall-e")) return true
    if (id.includes("image")) return true
    if (id.startsWith("sd") || id.includes("stable-diffusion")) return true
    return false
  }

  function timeoutController(ms: number) {
    const ctl = new AbortController()
    const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError({ ms })), ms)
    return {
      signal: ctl.signal,
      clear: () => clearTimeout(id),
    }
  }

  function wrapSSE(res: Response, ms: number, ctl: AbortController) {
    if (ms <= 0) return res
    if (!res.body) return res
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

    const reader = res.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const id = setTimeout(() => {
            const err = new Error("SSE read timed out")
            ctl.abort(err)
            void reader.cancel(err)
            reject(err)
          }, ms)

          reader.read().then(
            (part) => {
              clearTimeout(id)
              resolve(part)
            },
            (err) => {
              clearTimeout(id)
              reject(err)
            },
          )
        })

        if (part.done) {
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      },
      async cancel(reason) {
        ctl.abort(reason)
        await reader.cancel(reason)
      },
    })

    return new Response(body, {
      headers: new Headers(res.headers),
      status: res.status,
      statusText: res.statusText,
    })
  }

  async function loadOllamaProvider(config: Config.Info): Promise<Info | undefined> {
    const configured = config.provider?.["ollama"]
    // SAFETY: provider options come from user config and Env.get reads process env; both are strings when present
    const configuredBaseURL =
      (configured?.options?.baseURL as string | undefined) ?? (Env.get("OLLAMA_BASE_URL") as string | undefined)
    const baseURL = normalizeOllamaV1BaseURL(configuredBaseURL ?? "http://127.0.0.1:11434/v1")

    // SAFETY: apiKey comes from user config or process env, both string-valued when set
    const apiKey = (configured?.options?.apiKey as string | undefined) ?? Env.get("OLLAMA_API_KEY") ?? "ollama"

    // Avoid hitting external networks unless explicitly configured by the user.
    const isLocal = baseURL.startsWith("http://127.0.0.1:11434") || baseURL.startsWith("http://localhost:11434")
    const shouldProbe = isLocal || Boolean(configuredBaseURL)
    if (!shouldProbe) return undefined

    // Availability check + model listing via OpenAI compatibility.
    const modelsUrl = `${baseURL}/models`
    const modelsRes = await fetch(modelsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      // Local Ollama can be slow on cold start; keep this lenient.
      signal: AbortSignal.timeout(isLocal ? 1500 : 2000),
    }).catch(() => undefined)
    if (!modelsRes?.ok) return undefined

    // SAFETY: modelsRes.ok was checked above; res.json() is untyped so all fields are accessed defensively below
    const listJson = (await modelsRes.json().catch(() => undefined)) as
      | { data?: Array<{ id?: string; created?: number }> }
      | undefined
    // SAFETY: filter(Boolean) drops the undefined ids produced by the map before this point
    const modelIDs = listJson?.data?.map((x) => x.id).filter(Boolean) as string[] | undefined

    if (!modelIDs || modelIDs.length === 0) return undefined

    const models: Record<string, Model> = {}
    for (const modelID of modelIDs) {
      const created = listJson?.data?.find((x) => x.id === modelID)?.created
      const release_date =
        typeof created === "number" && Number.isFinite(created)
          ? new Date(created * 1000).toISOString().slice(0, 10)
          : "1970-01-01"
      models[modelID] = {
        id: modelID,
        providerID: "ollama",
        name: modelID,
        api: {
          id: modelID,
          url: baseURL,
          npm: "@ai-sdk/openai-compatible",
        },
        status: "active",
        headers: {},
        options: {},
        cost: {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
        },
        limit: {
          // Unknown; keep conservative defaults to avoid over-promising context.
          context: 8192,
          output: 2048,
        },
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: false,
          input: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          output: {
            text: true,
            audio: false,
            image: isProbablyOllamaImageModel(modelID),
            video: false,
            pdf: false,
          },
          interleaved: false,
        },
        release_date,
        variants: {},
      }
    }

    return {
      id: "ollama",
      name: configured?.name ?? (isLocal ? "Ollama (local)" : "Ollama"),
      source: "custom",
      env: [],
      options: {
        baseURL,
        apiKey,
      },
      models,
    }
  }

  /** Access token for the active nikcli account (issuer sign-in). Cached + auto-refreshed by Account. */
  async function accountAccessToken(): Promise<string | undefined> {
    return runPromiseWithLayer(
      Account.defaultLayer,
      Effect.gen(function* () {
        const account = yield* Account.Service
        const active = yield* account.active()
        if (!active) return undefined
        return yield* account.token(active.id)
      }),
    ).catch(() => undefined)
  }

  /**
   * Credential precedence mirrors the other providers: explicit config, env,
   * `nikcli auth login nikcli-inference` API key, then the account OAuth
   * sign-in (the same identity as the rest of nikcli).
   */
  async function nikcliInferenceCredential(ctx: InstanceContext) {
    const config = await configGet(ctx)
    const configured = config.provider?.[NIKCLI_INFERENCE_ID]
    // SAFETY: provider option and env values are strings when present, widened by the loose config options shape
    const baseURL = normalizeBaseURL(
      (configured?.options?.baseURL as string | undefined) ??
        Env.get("NIKCLI_INFERENCE_URL") ??
        NIKCLI_INFERENCE_DEFAULT_URL,
    )
    const auth = await authGet(NIKCLI_INFERENCE_ID)
    // SAFETY: apiKey comes from user config or process env, both string-valued when set
    const explicitKey =
      (configured?.options?.apiKey as string | undefined) ??
      Env.get(NIKCLI_INFERENCE_ENV) ??
      (auth?.type === "api" ? auth.key : undefined)
    const apiKey = explicitKey ?? (await accountAccessToken())
    return { baseURL, apiKey, explicitKey }
  }

  /**
   * Live catalog from the gateway; undefined when it cannot be reached.
   * Custom loaders receive the already-parsed internal `Model` shape (with
   * `api`/`capabilities`), not the models.dev shape used to seed the database.
   */
  async function fetchNikcliInferenceModels(
    baseURL: string,
    apiKey: string,
  ): Promise<Record<string, Model> | undefined> {
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(4000),
    }).catch(() => undefined)
    if (!res?.ok) return undefined
    // SAFETY: res.ok was checked above; res.json() is untyped so data is accessed defensively below
    const json = (await res.json().catch(() => undefined)) as { data?: GatewayModel[] } | undefined
    const data = json?.data
    if (!data?.length) return undefined
    const models: Record<string, Model> = {}
    for (const m of data) {
      if (!m.id) continue
      const seed = toModelsDevModel(m)
      // SAFETY: seed.limit is built by toModelsDevModel above; context/output are numeric there
      const context = (seed.limit as { context: number }).context
      // SAFETY: seed fields come from toModelsDevModel(m), which normalizes each gateway model
      // to the internal Model shape (family/release_date strings, reasoning/attachment booleans)
      models[m.id] = {
        id: m.id,
        providerID: NIKCLI_INFERENCE_ID,
        name: m.id,
        family: seed.family as string,
        api: { id: m.id, url: baseURL, npm: "@ai-sdk/openai-compatible" },
        status: "active",
        headers: {},
        options: {},
        cost: {
          input: m.pricing?.input ?? 0,
          output: m.pricing?.output ?? 0,
          cache: { read: 0, write: 0 },
        },
        limit: { context, output: (seed.limit as { output: number }).output },
        capabilities: {
          temperature: true,
          reasoning: seed.reasoning as boolean,
          attachment: seed.attachment as boolean,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: seed.attachment as boolean,
            video: false,
            pdf: false,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          interleaved: false,
        },
        release_date: seed.release_date as string,
        variants: {},
      }
    }
    return models
  }

  function isGpt5OrLater(modelID: string): boolean {
    const match = /^gpt-(\d+)/.exec(modelID)
    if (!match) {
      return false
    }
    return Number(match[1]) >= 5
  }

  function shouldUseCopilotResponsesApi(modelID: string): boolean {
    return isGpt5OrLater(modelID) && !modelID.startsWith("gpt-5-mini")
  }

  type ProviderSdkOptions = ProviderSchema.Info["options"]
  type BundledFactory = (options: ProviderSdkOptions) => SDK

  const BUNDLED_PROVIDERS: Record<string, () => Promise<BundledFactory>> = {
    "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock),
    "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
    "@ai-sdk/azure": () => import("@ai-sdk/azure").then((m) => m.createAzure),
    "@ai-sdk/google": () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI),
    "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex").then((m) => m.createVertex),
    "@ai-sdk/google-vertex/anthropic": () =>
      import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic),
    "@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI),
    "@ai-sdk/openai-compatible": () =>
      import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible as unknown as BundledFactory),
    "@openrouter/ai-sdk-provider": () => import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter),
    "@ai-sdk/xai": () => import("@ai-sdk/xai").then((m) => m.createXai),
    "@ai-sdk/mistral": () => import("@ai-sdk/mistral").then((m) => m.createMistral),
    "@ai-sdk/groq": () => import("@ai-sdk/groq").then((m) => m.createGroq),
    "@ai-sdk/deepinfra": () => import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra),
    "@ai-sdk/cerebras": () => import("@ai-sdk/cerebras").then((m) => m.createCerebras),
    "@ai-sdk/cohere": () => import("@ai-sdk/cohere").then((m) => m.createCohere),
    "@ai-sdk/gateway": () => import("@ai-sdk/gateway").then((m) => m.createGateway),
    "@ai-sdk/togetherai": () => import("@ai-sdk/togetherai").then((m) => m.createTogetherAI),
    "@ai-sdk/perplexity": () => import("@ai-sdk/perplexity").then((m) => m.createPerplexity),
    "@ai-sdk/vercel": () => import("@ai-sdk/vercel").then((m) => m.createVercel),
    "@gitlab/gitlab-ai-provider": () => import("@gitlab/gitlab-ai-provider").then((m) => m.createGitLab),
    "@ai-sdk/github-copilot": () =>
      import("./sdk/copilot").then((m) => m.createOpenaiCompatible as unknown as BundledFactory),
  }

  type CustomModelLoader = (sdk: SDK, modelID: string, options?: ProviderSdkOptions) => Promise<LanguageModelV2>
  // Loaders receive the converted Provider.Info entry held in `database` — nikcli's
  // own model shape with nested `capabilities` — not the raw ModelsDev catalog.
  type CustomLoader = (
    provider: Pick<Info, "id" | "name" | "source" | "env" | "options" | "models">,
    ctx: InstanceContext,
  ) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    options?: ProviderSdkOptions
  }>

  const CUSTOM_LOADERS = {
    async anthropic() {
      return {
        autoload: false,
        options: {
          headers: {
            "anthropic-beta":
              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }
    },
    async nikcli(input: { id: string; env: string[]; models: Record<string, Model> }, ctx: InstanceContext) {
      const hasKey = await (async () => {
        const env = Env.all()
        if (input.env.some((item) => env[item])) return true
        if (await authGet(input.id)) return true
        const config = await configGet(ctx)
        if (config.provider?.["nikcli"]?.options?.apiKey) return true
        return false
      })()

      if (!hasKey) {
        for (const [key, value] of Object.entries(input.models)) {
          const modelValue = value as { cost?: { input?: number } }
          if (modelValue?.cost?.input === 0) continue
          delete input.models[key]
        }
      }

      return {
        autoload: Object.keys(input.models).length > 0,
        options: hasKey ? {} : { apiKey: "public" },
      }
    },
    async [NIKCLI_INFERENCE_ID](
      input: { id: string; env: string[]; models: Record<string, Model> },
      ctx: InstanceContext,
    ) {
      const { baseURL, apiKey, explicitKey } = await nikcliInferenceCredential(ctx)
      // No credential at all: leave the seed catalog in place but stay dormant,
      // exactly like a provider whose API key has not been set yet.
      if (!apiKey) return { autoload: false, options: { baseURL } }

      const live = await fetchNikcliInferenceModels(baseURL, apiKey).catch(() => undefined)
      if (live) {
        for (const key of Object.keys(input.models)) delete input.models[key]
        Object.assign(input.models, live)
      }

      return {
        autoload: true,
        options: {
          baseURL,
          apiKey,
          // OAuth access tokens expire (~15 min): when the credential comes from
          // the account sign-in, re-resolve it per request. Account.token caches
          // and refreshes transparently.
          ...(!explicitKey && {
            fetch: async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
              const token = (await accountAccessToken()) ?? apiKey
              const headers = new Headers(init?.headers)
              headers.set("Authorization", `Bearer ${token}`)
              return globalThis.fetch(url, {
                ...init,
                headers,
                compress: "gzip",
              } as RequestInit)
            },
          }),
        },
      }
    },
    openai: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: ProviderSdkOptions) {
          return sdk.responses(modelID)
        },
        options: { headerTimeout: OPENAI_HEADER_TIMEOUT_DEFAULT },
      }
    },
    xai: async () => {
      return {
        autoload: false,
        // xAI: the Responses API is the recommended path for every grok model and
        // Chat Completions is deprecated; for SuperGrok / multi-agent models it's
        // the *only* supported path ("Multi Agent requests are not allowed on chat
        // completions"). Route all xai models through `sdk.responses()` regardless
        // of auth type — equivalent to the AI SDK migration `xai()` -> `xai.responses()`.
        // https://docs.x.ai/developers/model-capabilities/text/multi-agent
        //
        // `options: {}` is intentional: an empty object merges cleanly, whereas an
        // absent `options` is ignored by the loader merge (so it can never wipe the
        // OAuth `apiKey`/`fetch` merged earlier by the xai auth plugin).
        options: {},
        async getModel(sdk: any, modelID: string, _options?: ProviderSdkOptions) {
          return sdk.responses(modelID)
        },
      }
    },
    "github-copilot": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: ProviderSdkOptions) {
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    "github-copilot-enterprise": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: ProviderSdkOptions) {
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    azure: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: ProviderSdkOptions) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {},
      }
    },
    "azure-cognitive-services": async () => {
      const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: ProviderSdkOptions) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    },
    "amazon-bedrock": async (
      _input: { id: string; env: string[]; models: Record<string, Model> },
      ctx: InstanceContext,
    ) => {
      const config = await configGet(ctx)
      const providerConfig = config.provider?.["amazon-bedrock"]

      const auth = await authGet("amazon-bedrock")

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = Env.get("AWS_REGION")
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = Env.get("AWS_PROFILE")
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")

      const awsBearerToken = iife(() => {
        const envToken = Env.get("AWS_BEARER_TOKEN_BEDROCK")
        if (envToken) return envToken
        if (auth?.type === "api") {
          Env.set("AWS_BEARER_TOKEN_BEDROCK", auth.key)
          return auth.key
        }
        return undefined
      })

      const awsWebIdentityTokenFile = Env.get("AWS_WEB_IDENTITY_TOKEN_FILE")

      if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile) return { autoload: false }

      const providerOptions: AmazonBedrockProviderSettings = {
        region: defaultRegion,
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken) {
        const { fromNodeProviderChain } = await import(await BunProc.install("@aws-sdk/credential-providers"))

        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        async getModel(sdk: any, modelID: string, options?: ProviderSdkOptions) {
          // Skip region prefixing if model already has a cross-region inference profile prefix
          if (modelID.startsWith("global.") || modelID.startsWith("jp.")) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from nikcli.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    },
    openrouter: async () => {
      // Support both NIKCLI_OPENROUTER_API_KEY and OPENROUTER_API_KEY for Windows compatibility
      const apiKey = process.env.NIKCLI_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY
      return {
        autoload: false,
        options: {
          ...(apiKey && { apiKey }),
          // Enable OpenRouter usage accounting so responses include the actual
          // billed cost (providerMetadata.openrouter.usage.cost), used by
          // Session.getUsage — notably for meta-models like `openrouter/fusion`
          // that have no fixed catalog price.
          extraBody: { usage: { include: true } },
          headers: {
            "HTTP-Referer": "https://nikcli-ai.dev/",
            "X-Title": "nikcli",
          },
        },
      }
    },
    vercel: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://nikcli-ai.dev/",
            "x-title": "nikcli",
          },
        },
      }
    },
    "google-vertex": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "us-east5"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "google-vertex-anthropic": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "sap-ai-core": async () => {
      const auth = await authGet("sap-ai-core")
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = Env.get("AICORE_SERVICE_KEY")
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          Env.set("AICORE_SERVICE_KEY", auth.key)
          return auth.key
        }
        return undefined
      })
      const deploymentId = Env.get("AICORE_DEPLOYMENT_ID")
      const resourceGroup = Env.get("AICORE_RESOURCE_GROUP")

      return {
        autoload: !!envServiceKey,
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          return sdk(modelID)
        },
      }
    },
    zenmux: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://nikcli-ai.dev/",
            "X-Title": "nikcli",
          },
        },
      }
    },
    gitlab: async (input: { id: string; env: string[]; models: Record<string, Model> }, ctx: InstanceContext) => {
      const instanceUrl = Env.get("GITLAB_INSTANCE_URL") || "https://gitlab.com"

      const auth = await authGet(input.id)
      const apiKey = await (async () => {
        if (auth?.type === "oauth") return auth.access
        if (auth?.type === "api") return auth.key
        return Env.get("GITLAB_TOKEN")
      })()

      const config = await configGet(ctx)
      const providerConfig = config.provider?.["gitlab"]

      return {
        autoload: !!apiKey,
        options: {
          instanceUrl,
          apiKey,
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...providerConfig?.options?.featureFlags,
          },
        },
        async getModel(sdk: ReturnType<typeof createGitLab>, modelID: string) {
          return sdk.agenticChat(modelID, {
            featureFlags: {
              duo_agent_platform_agentic_chat: true,
              duo_agent_platform: true,
              ...providerConfig?.options?.featureFlags,
            },
          })
        },
      }
    },
    "cloudflare-ai-gateway": async (input: { id: string }) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      const gateway = Env.get("CLOUDFLARE_GATEWAY_ID")

      if (!accountId || !gateway) return { autoload: false }

      // Get API token from env or auth prompt
      const apiToken = await (async () => {
        const envToken = Env.get("CLOUDFLARE_API_TOKEN")
        if (envToken) return envToken
        const auth = await authGet(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })()

      return {
        autoload: true,
        async getModel(sdk: any, modelID: string, _options?: ProviderSdkOptions) {
          return sdk.languageModel(modelID)
        },
        options: {
          baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/compat`,
          headers: {
            // Cloudflare AI Gateway uses cf-aig-authorization for authenticated gateways
            // This enables Unified Billing where Cloudflare handles upstream provider auth
            ...(apiToken ? { "cf-aig-authorization": `Bearer ${apiToken}` } : undefined),
            "HTTP-Referer": "https://nikcli-ai.dev/",
            "X-Title": "nikcli",
          },
          // Custom fetch to handle parameter transformation and auth
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            // Strip Authorization header - AI Gateway uses cf-aig-authorization instead
            headers.delete("Authorization")

            // Transform max_tokens to max_completion_tokens for newer models
            if (init?.body && init.method === "POST") {
              try {
                const body = JSON.parse(init.body as string)
                if (body.max_tokens !== undefined && !body.max_completion_tokens) {
                  body.max_completion_tokens = body.max_tokens
                  delete body.max_tokens
                  init = { ...init, body: JSON.stringify(body) }
                }
              } catch {
                // If body parsing fails, continue with original request
              }
            }

            return fetch(input, {
              ...init,
              headers,
              compress: "gzip",
            } as RequestInit)
          },
        },
      }
    },
    cerebras: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "nikcli",
          },
        },
      }
    },
  } as unknown as Record<string, CustomLoader>

  type LooseModel = Omit<Partial<Model>, "api" | "capabilities" | "cost" | "limit"> & {
    api?: Partial<Model["api"]>
    capabilities?: Omit<Partial<Model["capabilities"]>, "input" | "output"> & {
      input?: Partial<Model["capabilities"]["input"]>
      output?: Partial<Model["capabilities"]["output"]>
    }
    cost?: Omit<Partial<Model["cost"]>, "cache"> & {
      cache?: Partial<Model["cost"]["cache"]>
    }
    limit?: Partial<Model["limit"]>
  }

  function normalizeModel(providerID: string, modelID: string, input: unknown, fallback?: Model): Model {
    const model = input as LooseModel
    return {
      id: modelID,
      providerID,
      api: {
        id: model.api?.id ?? fallback?.api.id ?? modelID,
        npm: model.api?.npm ?? fallback?.api.npm ?? "@ai-sdk/openai-compatible",
        // `url` / `family` / `experimentalOver200K` / `limit.input` are
        // `optionalKey`: a present `undefined` fails the response encode on
        // `GET /provider` and `GET /config/providers` instead of omitting them.
        ...spreadIf("url", model.api?.url ?? fallback?.api.url),
      },
      name: model.name ?? fallback?.name ?? modelID,
      ...spreadIf("family", model.family ?? fallback?.family),
      capabilities: {
        temperature: model.capabilities?.temperature ?? fallback?.capabilities.temperature ?? false,
        reasoning: model.capabilities?.reasoning ?? fallback?.capabilities.reasoning ?? false,
        attachment: model.capabilities?.attachment ?? fallback?.capabilities.attachment ?? false,
        toolcall: model.capabilities?.toolcall ?? fallback?.capabilities.toolcall ?? true,
        input: {
          text: model.capabilities?.input?.text ?? fallback?.capabilities.input.text ?? true,
          audio: model.capabilities?.input?.audio ?? fallback?.capabilities.input.audio ?? false,
          image: model.capabilities?.input?.image ?? fallback?.capabilities.input.image ?? false,
          video: model.capabilities?.input?.video ?? fallback?.capabilities.input.video ?? false,
          pdf: model.capabilities?.input?.pdf ?? fallback?.capabilities.input.pdf ?? false,
        },
        output: {
          text: model.capabilities?.output?.text ?? fallback?.capabilities.output.text ?? true,
          audio: model.capabilities?.output?.audio ?? fallback?.capabilities.output.audio ?? false,
          image: model.capabilities?.output?.image ?? fallback?.capabilities.output.image ?? false,
          video: model.capabilities?.output?.video ?? fallback?.capabilities.output.video ?? false,
          pdf: model.capabilities?.output?.pdf ?? fallback?.capabilities.output.pdf ?? false,
        },
        interleaved: model.capabilities?.interleaved ?? fallback?.capabilities.interleaved ?? false,
      },
      cost: {
        input: model.cost?.input ?? fallback?.cost.input ?? 0,
        output: model.cost?.output ?? fallback?.cost.output ?? 0,
        cache: {
          read: model.cost?.cache?.read ?? fallback?.cost.cache.read ?? 0,
          write: model.cost?.cache?.write ?? fallback?.cost.cache.write ?? 0,
        },
        ...spreadIf("experimentalOver200K", model.cost?.experimentalOver200K ?? fallback?.cost.experimentalOver200K),
      },
      limit: {
        context: model.limit?.context ?? fallback?.limit.context ?? 0,
        ...spreadIf("input", model.limit?.input ?? fallback?.limit.input),
        output: model.limit?.output ?? fallback?.limit.output ?? 0,
      },
      status: model.status ?? fallback?.status ?? "active",
      options: model.options ?? fallback?.options ?? {},
      headers: model.headers ?? fallback?.headers ?? {},
      release_date: model.release_date ?? fallback?.release_date ?? "",
      variants: model.variants ?? fallback?.variants ?? {},
    }
  }

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      ...spreadIf("family", model.family),
      api: {
        id: model.id,
        url: model.provider?.api ?? provider.api!,
        npm: iife(() => {
          if (provider.id.startsWith("github-copilot")) return "@ai-sdk/github-copilot"
          return model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible"
        }),
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        ...(model.cost?.context_over_200k
          ? {
              experimentalOver200K: {
                cache: {
                  read: model.cost.context_over_200k.cache_read ?? 0,
                  write: model.cost.context_over_200k.cache_write ?? 0,
                },
                input: model.cost.context_over_200k.input,
                output: model.cost.context_over_200k.output,
              },
            }
          : {}),
      },
      limit: {
        context: model.limit.context,
        ...spreadIf("input", model.limit.input),
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
      variants: {},
    }

    // Data-driven variant derivation, mirroring upstream opencode v2:
    // when models.dev declares `reasoning_options` for a model we read the
    // variant tiers straight from the catalog. When the field is absent
    // (catalog not yet migrated upstream) we fall back to the procedural
    // `ProviderTransform.variants` derivation so no model regresses.
    const npm = m.api.npm
    const fromCatalog = reasoningVariants(model, npm)
    m.variants =
      fromCatalog && Object.keys(fromCatalog).length > 0
        ? fromCatalog
        : (mapValues(ProviderTransform.variants(m), (v) => v) as typeof fromCatalog)

    return normalizeModel(provider.id, model.id, m)
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: provider.id,
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
    }
  }

  export async function discoverRequestyModels(input: {
    baseURL?: string
    apiKey?: string
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  }): Promise<Record<string, Model>> {
    const baseURL = normalizeBaseURL(input.baseURL ?? "https://router.requesty.ai/v1")
    const fetcher = input.fetch ?? globalThis.fetch
    try {
      const headers: Record<string, string> = {}
      if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
      const response = await fetcher(`${baseURL}/models`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) {
        log.warn("requesty model discovery failed", {
          status: response.status,
        })
        return {}
      }

      const payload = (await response.json()) as { data?: unknown[] }
      if (!Array.isArray(payload.data)) return {}

      const models: Record<string, Model> = Object.create(null)
      for (const value of payload.data) {
        const parsed = RequestyModel.safeParse(value)
        if (!parsed.success) continue
        const item = parsed.data
        const created = item.created === null ? undefined : new Date(item.created * 1000)
        const releaseDate = created && Number.isFinite(created.getTime()) ? created.toISOString().slice(0, 10) : ""
        const model: Model = {
          id: item.id,
          providerID: "requesty",
          name: item.id,
          family: "",
          api: {
            id: item.id,
            url: baseURL,
            npm: "@ai-sdk/openai-compatible",
          },
          status: "active",
          headers: {},
          options: {},
          cost: {
            input: item.input_price,
            output: item.output_price,
            cache: { read: item.cached_price, write: 0 },
          },
          limit: {
            context: item.context_window,
            output: item.max_output_tokens,
          },
          capabilities: {
            temperature: true,
            reasoning: item.supports_reasoning ?? false,
            attachment: item.supports_vision ?? false,
            toolcall: item.supports_tool_calling ?? false,
            input: {
              text: true,
              audio: false,
              image: item.supports_vision ?? false,
              video: false,
              pdf: false,
            },
            output: {
              text: true,
              audio: false,
              image: item.supports_image_generation ?? false,
              video: false,
              pdf: false,
            },
            interleaved: false,
          },
          release_date: releaseDate,
          variants: {},
        }
        model.variants = mapValues(ProviderTransform.variants(model), (variant) => variant)
        models[item.id] = model
      }
      log.info("requesty model discovery complete", {
        count: Object.keys(models).length,
      })
      return models
    } catch (error) {
      log.warn("requesty model discovery failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      return {}
    }
  }

  type RequestyDiscoveryCacheEntry =
    | {
        baseURL: string
        apiKey?: string
        expires: number
        promise: Promise<Record<string, Model>>
      }
    | undefined

  export function createRequestyDiscoveryCache(
    input: {
      discover?: typeof discoverRequestyModels
      now?: () => number
    } = {},
  ) {
    const discover = input.discover ?? discoverRequestyModels
    const now = input.now ?? Date.now
    let cache: RequestyDiscoveryCacheEntry

    return (request: { baseURL?: string; apiKey?: string }): Promise<Record<string, Model>> => {
      const baseURL = normalizeBaseURL(request.baseURL ?? "https://router.requesty.ai/v1")
      if (cache && cache.baseURL === baseURL && cache.apiKey === request.apiKey && cache.expires > now()) {
        return cache.promise
      }

      const promise = discover({ baseURL, apiKey: request.apiKey })
      cache = {
        baseURL,
        apiKey: request.apiKey,
        expires: now() + 30_000,
        promise,
      }
      void promise.then((models) => {
        if (cache?.promise !== promise) return
        if (Object.keys(models).length > 0) cache.expires = now() + 5 * 60_000
      })
      return promise
    }
  }

  const cachedRequestyModels = createRequestyDiscoveryCache()

  type State = {
    models: Map<string, LanguageModelV2>
    images: Map<string, ReturnType<SDK["imageModel"]>>
    providers: { [providerID: string]: Info }
    sdk: Map<number, SDK>
    modelLoaders: { [providerID: string]: CustomModelLoader }
  }

  export interface Interface {
    list(): Effect.Effect<Record<string, Info>, never>
    getProvider(providerID: string): Effect.Effect<Info | undefined, never>
    getModel(providerID: string, modelID: string): Effect.Effect<Model, Error>
    getLanguage(model: Model): Effect.Effect<LanguageModelV2, Error>
    getImageModel(model: Model): Effect.Effect<ReturnType<SDK["imageModel"]>, Error>
    /** Resolve a model to a @nikcli-ai/llm ModelRef for the route-based provider system. */
    getModelRef(model: Model): Effect.Effect<ModelRef | undefined, never>
    closest(
      providerID: string,
      query: string[],
    ): Effect.Effect<{ providerID: string; modelID: string } | undefined, never>
    getSmallModel(providerID: string): Effect.Effect<Model | undefined, Error>
    defaultModel(): Effect.Effect<{ providerID: string; modelID: string }, never>
    /**
     * Invalidate the cached provider state for the current instance directory.
     * Call this after writes that change auth or `config.provider.*` so the
     * next `list()` / `getProvider()` / `getModel()` rebuilds the state from
     * the new auth + config. Without this, a freshly-connected provider stays
     * invisible until the process restarts.
     */
    refresh(): Effect.Effect<void, never>
  }

  export class Service extends Context.Service<Service, Interface>()("Provider.Service") {}

  async function buildState(ctx: InstanceContext): Promise<State> {
    using _ = log.time("state")
    const config = await configGet(ctx)
    const policy = Policy.statements(config)

    function isProviderAllowed(providerID: string): boolean {
      return Policy.allows(policy, {
        action: "provider.use",
        resource: providerID,
      })
    }

    // Requesty discovery is a network round trip that needs only config and
    // auth, not the models.dev catalog. Started here it overlaps the catalog
    // load instead of following it; the result is still applied at the same
    // point below. The no-op handler only keeps a rejection from surfacing as
    // unhandled when the catalog turns out to have no requesty entry — the
    // await below still sees it.
    const requestyDiscovery = isProviderAllowed("requesty")
      ? (async () => {
          const configured = config.provider?.["requesty"]
          const auth = await authGet("requesty")
          const apiKey =
            (configured?.options?.apiKey as string | undefined) ??
            (auth?.type === "api" ? auth.key : undefined) ??
            Env.get("REQUESTY_API_KEY")
          return cachedRequestyModels({
            baseURL: configured?.options?.baseURL as string | undefined,
            apiKey,
          })
        })()
      : undefined
    requestyDiscovery?.catch(() => {})

    const modelsDev = await ModelsDev.get()
    const database = mapValues(modelsDev, fromModelsDevProvider)

    // `gpt-reserve` is seeded into the openai catalog by `ModelsDev.patch`, but
    // it only exists for ChatGPT plan traffic through the Codex backend — an
    // api.openai.com key cannot call it. Drop it unless the openai credential is
    // an OAuth one, so it never shows up in the picker for API-key users.
    // (`filterCodexOAuthModels` in the codex plugin keeps it for OAuth sessions.)
    const openaiAuth = await authGet("openai")
    if (openaiAuth?.type !== "oauth") delete database["openai"]?.models[GPT_RESERVE_ID]

    const providers: { [providerID: string]: Info } = {}
    const languages = new Map<string, LanguageModelV2>()
    const images = new Map<string, ReturnType<SDK["imageModel"]>>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const sdk = new Map<number, SDK>()

    log.info("init")

    const requesty = database["requesty"]
    if (requesty && requestyDiscovery) {
      const discovered = await requestyDiscovery
      if (Object.keys(discovered).length > 0) requesty.models = discovered
    }

    // Auto-detect local Ollama and expose it as a provider when available.
    const ollama = await loadOllamaProvider(config).catch((error) => {
      log.debug("ollama provider unavailable", {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    })
    if (ollama && isProviderAllowed(ollama.id)) {
      providers[ollama.id] = ollama
    }

    // The nikcli inference gateway is a regular provider now: seeded into the
    // ModelsDev database and activated by its CUSTOM_LOADER below.

    const configProviders = Object.entries(config.provider ?? {})

    // Add GitHub Copilot Enterprise provider that inherits from GitHub Copilot
    if (database["github-copilot"]) {
      const githubCopilot = database["github-copilot"]
      database["github-copilot-enterprise"] = {
        ...githubCopilot,
        id: "github-copilot-enterprise",
        name: "GitHub Copilot Enterprise",
        models: mapValues(githubCopilot.models, (model) => ({
          ...model,
          providerID: "github-copilot-enterprise",
        })),
      }
    }

    function mergeProvider(providerID: string, provider: Partial<Info>) {
      const existing = providers[providerID]
      if (existing) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerID]
      if (match) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(match, provider)
        return
      }
      // Provider doesn't exist in ModelsDev - create a default entry with available info
      // This allows dynamically loaded providers (e.g., nikcli-inference, ollama) and
      // provider configs without models.json entries to still be visible and functional
      const configProvider = configProviders.find(([id]) => id === providerID)?.[1]
      if (!configProvider && !provider.key) return // Nothing to add, skip

      providers[providerID] = {
        id: providerID,
        name: configProvider?.name ?? providerID,
        source: provider.source ?? "api",
        env: configProvider?.env ?? [],
        options: {
          ...configProvider?.options,
          ...provider.options,
        },
        models: {},
        ...provider,
      }
    }

    // extend database from config
    for (const [providerID, provider] of configProviders) {
      const existing = database[providerID]
      const parsed: Info = {
        id: providerID,
        name: provider.name ?? existing?.name ?? providerID,
        env: provider.env ?? existing?.env ?? [],
        options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
        source: "config",
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existingModel = parsed.models[model.id ?? modelID]
        const apiID = model.id ?? existingModel?.api.id ?? modelID
        const apiNpm =
          model.provider?.npm ??
          provider.npm ??
          existingModel?.api.npm ??
          modelsDev[providerID]?.npm ??
          "@ai-sdk/openai-compatible"
        const name = iife(() => {
          if (model.name) return model.name
          if (model.id && model.id !== modelID) return modelID
          return existingModel?.name ?? modelID
        })
        const parsedModel: Model = {
          id: modelID,
          api: {
            id: apiID,
            npm: apiNpm,
            ...spreadIf(
              "url",
              model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
            ),
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID,
          capabilities: {
            temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
            reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
            attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
            toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
            input: {
              text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
              audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
              image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
              video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
              pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
            },
            output: {
              text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
              audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
              image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
              video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
              pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
            },
            interleaved:
              model.interleaved ??
              existingModel?.capabilities.interleaved ??
              (!existingModel && apiNpm === "@ai-sdk/openai-compatible" && apiID.includes("deepseek")
                ? { field: "reasoning_content" }
                : // Opencode #24218: reasoning models implicitly use reasoning_content as the
                  // interleaved field for openai-compatible backends that don't advertise it.
                  apiNpm === "@ai-sdk/openai-compatible" && model.reasoning === true
                  ? { field: "reasoning_content" }
                  : false),
            // Opencode #21627: openai-compatible models advertised without an image modality
            // can still accept image inputs in practice (vLLM, LM Studio, LiteLLM). Default
            // to true so users don't have to configure `modalities.input.image: true`.
            ...(apiNpm === "@ai-sdk/openai-compatible" && !model.modalities?.input
              ? {
                  input: {
                    text: existingModel?.capabilities.input.text ?? true,
                    audio: existingModel?.capabilities.input.audio ?? false,
                    image: true,
                    video: existingModel?.capabilities.input.video ?? false,
                    pdf: true,
                  },
                }
              : {}),
          },
          cost: {
            input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
            output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
            cache: {
              read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
              write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
            },
          },
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          limit: {
            context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
            output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
          },
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          family: model.family ?? existingModel?.family ?? "",
          release_date: model.release_date ?? existingModel?.release_date ?? "",
          variants: {},
        }
        // Data-driven first (mirrors upstream opencode v2): when the
        // user-declared model carries `reasoning_options` in its catalog
        // entry, derive variants from that. Fall back to the procedural
        // derivation for entries that don't yet declare the new field, and
        // always let explicit `model.variants` win on key collision so users
        // can override catalog defaults per-model.
        const baseVariants = reasoningVariants(model, parsedModel.api.npm)
        const merged = mergeDeep(
          baseVariants && Object.keys(baseVariants).length > 0 ? baseVariants : ProviderTransform.variants(parsedModel),
          model.variants ?? {},
        )
        parsedModel.variants = mapValues(
          pickBy(merged, (v) => !v.disabled),
          (v) => omit(v, ["disabled"]),
        )
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }

    // load env
    const env = Env.all()
    for (const [providerID, provider] of Object.entries(database)) {
      if (!isProviderAllowed(providerID)) continue
      const apiKey = provider.env.map((item: string) => env[item]).find(Boolean)
      if (!apiKey) continue
      mergeProvider(providerID, {
        source: "env",
        ...spreadIf("key", provider.env.length === 1 ? apiKey : undefined),
      })
    }

    // load apikeys
    for (const [providerID, provider] of Object.entries(await authAll()) as Array<[string, Auth.Info]>) {
      if (!isProviderAllowed(providerID)) continue
      if (provider.type === "api") {
        mergeProvider(providerID, {
          source: "api",
          ...spreadIf("key", provider.key),
        })
      }
    }

    for (const plugin of await pluginList(ctx)) {
      if (!plugin.auth) continue
      const providerID = plugin.auth.provider
      if (!isProviderAllowed(providerID)) continue

      // For github-copilot plugin, check if auth exists for either github-copilot or github-copilot-enterprise
      let hasAuth = false
      const auth = await authGet(providerID)
      if (auth) hasAuth = true

      // Special handling for github-copilot: also check for enterprise auth
      if (providerID === "github-copilot" && !hasAuth) {
        const enterpriseAuth = await authGet("github-copilot-enterprise")
        if (enterpriseAuth) hasAuth = true
      }

      if (!hasAuth) continue
      if (!plugin.auth.loader) continue

      // Load for the main provider if auth exists
      if (auth) {
        // SDK Model.api.url is still required until the OpenAPI/SDK regen after
        // optional-url; cast at the plugin boundary (runtime already tolerates
        // missing urls via options.baseURL).
        const options = await plugin.auth.loader(
          () => authGet(providerID) as any,
          database[plugin.auth.provider] as any,
        )
        mergeProvider(plugin.auth.provider, {
          source: "custom",
          options: options,
        })
      }

      // If this is github-copilot plugin, also register for github-copilot-enterprise if auth exists
      if (providerID === "github-copilot") {
        const enterpriseProviderID = "github-copilot-enterprise"
        if (isProviderAllowed(enterpriseProviderID)) {
          const enterpriseAuth = await authGet(enterpriseProviderID)
          if (enterpriseAuth) {
            const enterpriseOptions = await plugin.auth.loader(
              () => authGet(enterpriseProviderID) as any,
              database[enterpriseProviderID] as any,
            )
            mergeProvider(enterpriseProviderID, {
              source: "custom",
              options: enterpriseOptions,
            })
          }
        }
      }
    }

    for (const [providerID, fn] of Object.entries(CUSTOM_LOADERS)) {
      if (!isProviderAllowed(providerID)) continue
      const data = database[providerID]
      if (!data) {
        log.error("Provider does not exist in model list " + providerID)
        continue
      }
      const result = await fn(data, ctx)
      if (result && (result.autoload || providers[providerID])) {
        if (result.getModel) modelLoaders[providerID] = result.getModel
        // Only forward `options` when the loader actually returned them.
        // mergeDeep treats an explicit `options: undefined` as an overwrite,
        // which would wipe options already merged by env/auth/plugin loaders
        // (e.g. the OAuth `apiKey` + Bearer-injecting `fetch`) — leaving the SDK
        // with no credentials and surfacing a spurious "API key is missing".
        const partial: Partial<Info> = { source: "custom" }
        if (result.options) partial.options = result.options
        mergeProvider(providerID, partial)
      }
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      const partial: Partial<Info> = { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (provider.options) partial.options = provider.options
      mergeProvider(providerID, partial)
    }

    for (const hook of await pluginList(ctx)) {
      const p = hook.provider
      if (!p?.models) continue
      if (!isProviderAllowed(p.id)) continue
      const provider = providers[p.id]
      if (!provider) continue
      const pluginAuth = await authGet(p.id)
      const currentModels = provider.models
      provider.models = await p
        // See auth.loader cast above — SDK Provider/Model lag the optional api.url.
        .models(provider as any, { auth: pluginAuth ?? undefined })
        .then((next) =>
          Object.fromEntries(
            Object.entries(next).map(([id, model]) => [id, normalizeModel(p.id, id, model, currentModels[id])]),
          ),
        )
        .catch((e) => {
          log.warn("plugin provider.models failed", { id: p.id, error: e })
          return provider.models
        })
    }

    for (const [providerID, provider] of Object.entries(providers) as Array<[string, Info]>) {
      if (!isProviderAllowed(providerID)) {
        delete providers[providerID]
        continue
      }

      const configProvider = config.provider?.[providerID]

      for (const [modelID, rawModel] of Object.entries(provider.models) as Array<[string, Model]>) {
        const model = normalizeModel(providerID, modelID, rawModel)
        provider.models[modelID] = model
        model.api.id = model.api.id ?? model.id ?? modelID
        if (modelID === "gpt-5-chat-latest" || (providerID === "openrouter" && modelID === "openai/gpt-5-chat"))
          delete provider.models[modelID]
        if (model.status === "alpha" && !Flag.NIKCLI_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
        if (model.status === "deprecated") delete provider.models[modelID]
        // Opencode #21038: per-model `disabled` flag in config hides models from the picker.
        if (configProvider?.models?.[modelID]?.disabled === true) delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        )
          delete provider.models[modelID]

        // Filter out disabled variants from config
        const configVariants = configProvider?.models?.[modelID]?.variants
        if (configVariants && model.variants) {
          const merged = mergeDeep(model.variants, configVariants)
          model.variants = mapValues(
            pickBy(merged, (v) => !v.disabled),
            (v) => omit(v, ["disabled"]),
          )
        }
      }

      if (Object.keys(provider.models).length === 0) {
        delete providers[providerID]
        continue
      }

      log.info("found", { providerID })
    }

    return {
      models: languages,
      images,
      providers,
      sdk,
      modelLoaders,
    }
  }

  const stateEffect = InstanceState.make<State>((ctx) => Effect.promise(() => buildState(ctx)))

  const sdkCacheFnIds = new WeakMap<Function, number>()
  let sdkCacheFnSeq = 1
  function sdkCacheFnId(fn: Function): number {
    const existing = sdkCacheFnIds.get(fn)
    if (existing) return existing
    const next = sdkCacheFnSeq++
    sdkCacheFnIds.set(fn, next)
    return next
  }

  function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object") return false
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  }

  function stableKey(value: unknown, seen: Map<object, number>): string {
    if (value === null) return "null"
    switch (typeof value) {
      case "string":
        return `s:${value}`
      case "number":
        return Number.isFinite(value) ? `n:${value}` : `n:${String(value)}`
      case "boolean":
        return value ? "b:1" : "b:0"
      case "undefined":
        return "u"
      case "function":
        return `f:${sdkCacheFnId(value)}`
      case "bigint":
        return `bi:${value.toString()}`
      case "symbol":
        return `sym:${String(value)}`
      case "object": {
        const obj = value as object
        const existing = seen.get(obj)
        if (existing !== undefined) return `ref:${existing}`
        const id = seen.size + 1
        seen.set(obj, id)

        if (Array.isArray(value)) {
          return `a:[${value.map((v) => stableKey(v, seen)).join(",")}]`
        }
        if (isPlainObject(value)) {
          const keys = Object.keys(value).sort()
          const rec = value as Record<string, unknown>
          let out = "o:{"
          for (const k of keys) {
            out += `${k}:${stableKey(rec[k], seen)};`
          }
          out += "}"
          return out
        }
        return `obj:${Object.prototype.toString.call(value)}#${id}`
      }
    }
    return "unknown"
  }

  function stableHeadersKey(headers: unknown): string {
    if (!headers || typeof headers !== "object") return ""
    const obj = headers as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    let out = ""
    for (const k of keys) {
      const v = obj[k]
      // Headers are expected to be string-like.
      out += `${k}\0${typeof v === "string" ? v : String(v)}\0`
    }
    return out
  }

  function sdkCacheKey(npm: string, options: ProviderSdkOptions): number {
    const baseURL = options["baseURL"] ?? ""
    const apiKey = options["apiKey"] ?? ""
    const includeUsage = options["includeUsage"] ?? ""
    const timeout = options["timeout"] ?? ""
    const headersKey = stableHeadersKey(options["headers"])
    const fetchKey = typeof options["fetch"] === "function" ? `fetch:${sdkCacheFnId(options["fetch"])}` : ""

    const seen = new Map<object, number>()
    const restKeys = Object.keys(options)
      .filter((k) => k !== "baseURL" && k !== "apiKey" && k !== "includeUsage" && k !== "timeout" && k !== "headers")
      .sort()
    let rest = ""
    for (const k of restKeys) {
      const v = options[k]
      // Skip undefined to match common JSON-ish semantics, and avoid hashing huge transient objects.
      if (v === undefined) continue
      rest += `${k}=${stableKey(v, seen)}\n`
    }

    return Bun.hash.xxHash32(
      `${npm}\n${baseURL}\n${apiKey}\n${includeUsage}\n${timeout}\n${headersKey}\n${fetchKey}\n${rest}`,
    )
  }

  async function getSDK(s: State, model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const provider = s.providers[model.providerID]
      const options = { ...provider.options }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      if (!options["baseURL"]) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
      if (model.headers)
        options["headers"] = {
          ...(options["headers"] as Model["headers"] | undefined),
          ...model.headers,
        }

      const key = sdkCacheKey(model.api.npm, options)
      const existing = s.sdk.get(key)
      if (existing) return existing

      const customFetch = options["fetch"] as
        | ((input: any, init?: BunFetchRequestInit) => Promise<Response>)
        | undefined
      const chunkTimeout = options["chunkTimeout"]
      const headerTimeout = options["headerTimeout"]
      delete options["chunkTimeout"]
      delete options["headerTimeout"]

      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        const fetchFn = customFetch ?? fetch
        const opts = init ?? {}
        const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
        const headerTimeoutMs = headerTimeout === false ? undefined : headerTimeout
        const headerTimeoutCtl = typeof headerTimeoutMs === "number" ? timeoutController(headerTimeoutMs) : undefined
        const signals: AbortSignal[] = []

        if (opts.signal) signals.push(opts.signal)
        if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
        if (headerTimeoutCtl) signals.push(headerTimeoutCtl.signal)
        if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false) {
          signals.push(AbortSignal.timeout(options["timeout"] as number))
        }

        const combined = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
        if (combined) opts.signal = combined

        // Strip openai itemId metadata following what codex does
        // Codex uses #[serde(skip_serializing)] on id fields for all item types:
        // Message, Reasoning, FunctionCall, LocalShellCall, CustomToolCall, WebSearchCall
        // IDs are only re-attached for Azure with store=true
        if (
          (model.api.npm === "@ai-sdk/openai" || model.api.npm === "@ai-sdk/azure") &&
          opts.body &&
          opts.method === "POST"
        ) {
          const body = JSON.parse(opts.body as string)
          const keepIds = body.store === true
          if (!keepIds && Array.isArray(body.input)) {
            for (const item of body.input) {
              if ("id" in item) {
                delete item.id
              }
            }
            opts.body = JSON.stringify(body)
          }
        }

        // Inject cache_control on the last tool definition for Anthropic-compatible providers.
        // Anthropic treats this as a cache breakpoint — all preceding tools get cached together.
        // Saves 5-15k tokens/call after the first request in a session.
        const isAnthropicLike =
          model.api.npm === "@ai-sdk/anthropic" ||
          model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
          model.api.npm === "@ai-sdk/amazon-bedrock" ||
          model.providerID === "google-vertex-anthropic"
        if (isAnthropicLike && opts.body && opts.method === "POST") {
          try {
            const body = JSON.parse(opts.body as string)
            if (Array.isArray(body.tools) && body.tools.length > 0) {
              const last = body.tools[body.tools.length - 1]
              // Anthropic rejects a request carrying more than four breakpoints, so
              // count what message-level placement already spent rather than assuming
              // this marker is free. `transform.applyCaching` reserves a slot for it,
              // but plugins and provider-specific paths can add their own.
              const spent = CachePolicy.countWireBreakpoints(body)
              if (!last.cache_control && spent < CachePolicy.BREAKPOINT_CAP) {
                // The tool array is the largest byte-stable block in the request, so
                // it is the breakpoint that gains most from the longer lifetime — a
                // retention setting that skipped it would miss the point.
                const ttl = CachePolicy.ttlFor(CachePolicy.resolveRetention())
                last.cache_control = ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" }
                opts.body = JSON.stringify(body)
              } else if (spent >= CachePolicy.BREAKPOINT_CAP) {
                log.warn("skipping tool cache breakpoint", {
                  reason: "request already at the provider breakpoint cap",
                  spent,
                })
              }
            }
          } catch {
            // Malformed body — skip caching, don't break the request
          }
        }

        const res = await fetchFn(input, {
          ...opts,
          // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
          timeout: false,
        }).finally(() => headerTimeoutCtl?.clear())

        if (!chunkAbortCtl) return res
        return wrapSSE(res, chunkTimeout as number, chunkAbortCtl)
      }

      // Special case: google-vertex-anthropic uses a subpath import
      const bundledKey =
        model.providerID === "google-vertex-anthropic" ? "@ai-sdk/google-vertex/anthropic" : model.api.npm
      const bundledFn = BUNDLED_PROVIDERS[bundledKey]
      if (bundledFn) {
        log.info("using bundled provider", {
          providerID: model.providerID,
          pkg: bundledKey,
        })
        const create = await bundledFn()
        const loaded = create({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded as SDK
      }

      let installedPath: string
      if (!model.api.npm.startsWith("file://")) {
        installedPath = await BunProc.install(model.api.npm, "latest")
      } else {
        log.info("loading local provider", { pkg: model.api.npm })
        installedPath = model.api.npm
      }

      const mod = await import(installedPath)

      const createKey = Object.keys(mod).find((key) => key.startsWith("create"))
      if (!createKey) {
        log.error("No create function found in provider module", {
          npm: model.api.npm,
          keys: Object.keys(mod),
        })
        throw Object.assign(new InitError({ providerID: model.providerID }), {
          cause: new Error("Provider module missing create function"),
        })
      }
      const fn = mod[createKey]
      const loaded = fn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, loaded)
      return loaded as SDK
    } catch (e) {
      log.error("getSDK failed", {
        providerID: model.providerID,
        modelID: model.id,
        npm: model.api.npm,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      })
      throw Object.assign(new InitError({ providerID: model.providerID }), {
        cause: e,
      })
    }
  }

  function modelFromState(s: State, providerID: string, modelID: string) {
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, {
        limit: 3,
        threshold: -10000,
      })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({
        providerID,
        modelID,
        suggestions: suggestions as string[],
      })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, {
        limit: 3,
        threshold: -10000,
      })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({
        providerID,
        modelID,
        suggestions: suggestions as string[],
      })
    }
    return info
  }

  /** Resolve a @nikcli-ai/llm ModelRef from a Provider.Model + Provider.Info pair. */
  function mapToModelRef(model: Model, providerInfo: Info): ModelRef | undefined {
    const apiKey = (providerInfo.options?.["apiKey"] as string | undefined) ?? providerInfo.key
    const baseURL = model.api.url || (providerInfo.options?.["baseURL"] as string | undefined)
    const providerID = model.providerID
    const npm = model.api.npm
    const id = model.api.id

    // Helper to extract typed options from the provider's generic options bag.
    // Returns `undefined` for absent keys so downstream defaults apply.
    const opt = <T>(key: string): T | undefined => providerInfo.options?.[key] as T | undefined

    try {
      switch (npm) {
        case "@ai-sdk/openai":
          // OpenAI SDK is shared by OpenAI, Azure, and GitHub Copilot — disambiguate by providerID.
          if (providerID.includes("github-copilot")) {
            return GitHubCopilot.model(id, {
              baseURL,
              apiKey,
              headers: model.headers,
            } as any)
          }
          if (providerID.includes("azure")) {
            const resourceName =
              (providerInfo.options?.["resourceName"] as string | undefined) ?? extractAzureResource(baseURL ?? "")
            return Azure.model(id, {
              ...(resourceName ? { resourceName } : undefined),
              baseURL,
              apiKey,
            } as any)
          }
          return OpenAI.responses(id, { baseURL, apiKey } as any)

        case "@ai-sdk/anthropic":
          return Anthropic.model(id, { baseURL, apiKey } as any)

        case "@ai-sdk/google":
          return Google.model(id, { baseURL, apiKey } as any)

        case "@ai-sdk/amazon-bedrock":
          return AmazonBedrock.model(id, {
            region: opt<string>("region"),
            baseURL,
            apiKey,
          } as any)

        case "@ai-sdk/xai":
          return XAI.responses(id, { baseURL, apiKey } as any)

        case "@openrouter/ai-sdk-provider":
          return OpenRouter.model(id, { baseURL, apiKey } as any)

        case "@ai-sdk/github-copilot":
          return GitHubCopilot.model(id, { baseURL, apiKey } as any)

        case "@ai-sdk/groq":
          return OpenAICompatible.groq.model(id, { apiKey } as any)

        case "@ai-sdk/deepinfra":
          return OpenAICompatible.deepinfra.model(id, { apiKey } as any)

        case "@ai-sdk/cerebras":
          return OpenAICompatible.cerebras.model(id, { apiKey } as any)

        case "@ai-sdk/togetherai":
          return OpenAICompatible.togetherai.model(id, { apiKey } as any)

        // Edge case: GitHub Copilot Enterprise inherits from GitHub Copilot
        case "@ai-sdk/github-copilot-enterprise":
          return GitHubCopilot.model(id, { baseURL, apiKey } as any)

        case "@ai-sdk/openai-compatible":
        default: {
          // Try to match against known OpenAI-compatible profiles
          const profile = providerProfiles[providerID]
          if (profile) {
            return OpenAICompatible.profileModel(profile, id, {
              apiKey,
              baseURL,
            } as any)
          }
          // Generic fallback for custom OpenAI-compatible providers
          if (baseURL) {
            return OpenAICompatible.model(id, {
              provider: providerID,
              baseURL,
              apiKey,
            } as any)
          }
          // No baseURL — can't construct a valid route without an endpoint
          return undefined
        }
      }
    } catch (e) {
      log.warn("mapToModelRef failed", {
        providerID,
        modelID: model.id,
        npm,
        error: String(e),
      })
      return undefined
    }
  }

  /** Extract the Azure resource name from an azure.com baseURL. */
  function extractAzureResource(baseURL: string): string | undefined {
    const match = /https:\/\/([^.]+)\.openai\.azure\.com/.exec(baseURL)
    return match?.[1]
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* stateEffect
      const getState = () => InstanceState.get(state)

      const getModelEffect: Interface["getModel"] = Effect.fn("Provider.getModel")(function* (providerID, modelID) {
        const s = yield* getState()
        return modelFromState(s, providerID, modelID)
      })

      const getLanguage: Interface["getLanguage"] = Effect.fn("Provider.getLanguage")(function* (model) {
        const s = yield* getState()
        const key = `${model.providerID}/${model.id}`
        if (s.models.has(key)) return s.models.get(key)!

        const provider = s.providers[model.providerID]
        const sdk = yield* Effect.tryPromise({
          try: () => getSDK(s, model),
          catch: asProviderError,
        })

        return yield* Effect.tryPromise<LanguageModelV2, Error>({
          try: async () => {
            try {
              const language = s.modelLoaders[model.providerID]
                ? await s.modelLoaders[model.providerID](sdk, model.api.id, provider.options)
                : sdk.languageModel(model.api.id)
              s.models.set(key, language as LanguageModelV2)
              return language as LanguageModelV2
            } catch (e) {
              if (e instanceof NoSuchModelError) {
                throw Object.assign(
                  new ModelNotFoundError({
                    modelID: model.id,
                    providerID: model.providerID,
                  }),
                  { cause: e },
                )
              }
              throw e
            }
          },
          catch: asProviderError,
        })
      })

      const getImageModel: Interface["getImageModel"] = Effect.fn("Provider.getImageModel")(function* (model) {
        const s = yield* getState()
        const key = `${model.providerID}/${model.id}`
        if (s.images.has(key)) return s.images.get(key)!

        return yield* Effect.tryPromise<ReturnType<SDK["imageModel"]>, Error>({
          try: async () => {
            const providerID = model.providerID ?? ""
            const apiNpm = model.api?.npm ?? ""

            if (
              providerID.includes("openrouter") ||
              apiNpm.includes("openrouter") ||
              apiNpm.includes("openai-compatible")
            ) {
              const { createOpenAI } = await import("@ai-sdk/openai")
              const provider = s.providers[providerID] || s.providers["openrouter"]
              const openrouterApi = "https://openrouter.ai/api/v1"
              const baseURL = model.api?.url || (providerID.includes("openrouter") ? openrouterApi : undefined)

              const openaiSDK = createOpenAI({
                name: providerID,
                baseURL,
                apiKey: provider?.key ?? (provider as any)?.options?.apiKey,
              })

              const image = openaiSDK.imageModel(model.api.id)
              s.images.set(key, image)
              return image
            }

            const sdk = await getSDK(s, model)
            try {
              const image = sdk.imageModel(model.api.id)
              s.images.set(key, image)
              return image
            } catch (e) {
              if (e instanceof NoSuchModelError) {
                throw Object.assign(
                  new ModelNotFoundError({
                    modelID: model.id,
                    providerID: model.providerID,
                  }),
                  { cause: e },
                )
              }
              throw e
            }
          },
          catch: asProviderError,
        })
      })

      const closest: Interface["closest"] = Effect.fn("Provider.closest")(function* (providerID, query) {
        const s = yield* getState()
        const provider = s.providers[providerID]
        if (!provider) return undefined
        for (const item of query) {
          for (const modelID of Object.keys(provider.models)) {
            if (modelID.includes(item)) return { providerID, modelID }
          }
        }
      })

      const getSmallModel: Interface["getSmallModel"] = Effect.fn("Provider.getSmallModel")(function* (providerID) {
        const ctx = yield* InstanceState.context
        const cfg = yield* Effect.promise(() => configGet(ctx))
        // Opencode #21184: an explicit empty string explicitly disables the
        // small-model fallback (e.g. user wants to skip Haiku entirely).
        if (cfg.small_model && cfg.small_model !== "") {
          const parsed = parseModel(cfg.small_model)
          return yield* getModelEffect(parsed.providerID, parsed.modelID)
        }
        if (cfg.small_model === "") {
          return undefined
        }

        const s = yield* getState()
        const provider = s.providers[providerID]
        if (provider) {
          if (providerID.startsWith("nikcli") || providerID.startsWith("github-copilot")) {
            for (const item of priority) {
              for (const model of Object.keys(provider.models)) {
                if (model.includes(item)) return yield* getModelEffect(providerID, model)
              }
            }
          }
        }

        const nikcliProvider = s.providers["nikcli"]
        if (nikcliProvider && nikcliProvider.models["gpt-5-nano"]) {
          return yield* getModelEffect("nikcli", "gpt-5-nano")
        }

        return undefined
      })

      const defaultModel: Interface["defaultModel"] = Effect.fn("Provider.defaultModel")(function* () {
        const ctx = yield* InstanceState.context
        const cfg = yield* Effect.promise(() => configGet(ctx))
        const s = yield* getState()

        function isAvailable(providerID: string, modelID: string) {
          return !!s.providers[providerID]?.models[modelID]
        }

        function bestAvailable() {
          const allModels: Model[] = []
          for (const [pid, provider] of Object.entries(s.providers)) {
            for (const mid of Object.keys(provider.models)) {
              const m = provider.models[mid]
              if (m) allModels.push({ ...m, providerID: pid } as Model)
            }
          }
          const sorted = sort(allModels)
          if (sorted.length > 0) {
            const best = sorted[0]
            return {
              providerID: (best as any).providerID as string,
              modelID: best.id,
            }
          }
          return { providerID: "nikcli", modelID: "" }
        }

        if (cfg.model) {
          const parsed = parseModel(cfg.model)
          if (isAvailable(parsed.providerID, parsed.modelID)) return parsed
          return bestAvailable() ?? parsed
        }
        return bestAvailable()
      })

      const getModelRef: Interface["getModelRef"] = Effect.fn("Provider.getModelRef")(function* (model) {
        const s = yield* getState()
        const providerInfo = s.providers[model.providerID]
        if (!providerInfo) return undefined
        return mapToModelRef(model, providerInfo)
      })

      const refresh: Interface["refresh"] = Effect.fn("Provider.refresh")(function* () {
        // Clear the cached LanguageModel instances built from the old SDK +
        // auth before invalidating, so the next getLanguage() rebuilds them.
        // Effect failures don't surface as JS exceptions inside Effect.gen, so
        // capture the Exit instead of a try/catch (state may not be built yet).
        const stateExit = yield* Effect.exit(getState())
        if (Exit.isSuccess(stateExit)) {
          stateExit.value.models.clear()
          stateExit.value.sdk.clear()
        }
        // Invalidate every cached directory entry, not just the current one.
        // Auth (`auth.json`) and config live in global/shared locations, so a
        // credential change affects the provider list for *every* instance
        // directory/worktree. Invalidating only `ctx.directory` left stale
        // snapshots behind whenever the entry was built under a different key
        // than the one in scope at refresh time — the cause of the model list
        // staying empty for a freshly-connected provider until a CLI restart.
        yield* ScopedCache.invalidateAll(state)
      })

      return Service.of({
        list: Effect.fn("Provider.list")(function* () {
          return (yield* getState()).providers
        }),
        getProvider: Effect.fn("Provider.getProvider")(function* (providerID) {
          return (yield* getState()).providers[providerID]
        }),
        getModel: getModelEffect,
        getLanguage,
        getImageModel,
        getModelRef,
        closest,
        getSmallModel,
        defaultModel,
        refresh,
      })
    }),
  )

  export const defaultLayer = layer

  // Ascending priority: `sort` orders by `findIndex` descending, so the last
  // entry wins. gpt-6-astra is OpenAI's current flagship, ahead of gpt-5.
  const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro", "gpt-6-astra"]
  export function sort(models: Model[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export const parseModel = parseModelLight

  export class ModelNotFoundError extends Schema.TaggedError<ModelNotFoundError>()("ProviderModelNotFoundError", {
    providerID: Schema.String,
    modelID: Schema.String,
    suggestions: Schema.optional(Schema.Array(Schema.String)),
  }) {}

  export class InitError extends Schema.TaggedError<InitError>()("ProviderInitError", {
    providerID: Schema.String,
  }) {}

  /**
   * Union of all errors that any `Provider.Service` method can fail with.
   * Use this in the Effect error channel of downstream consumers so they can
   * `Effect.catchTag` against the specific error class.
   *
   * `ProviderError.HeaderTimeoutError` is included because a hung provider
   * header request is a typed failure surfaced by `getLanguage` /
   * `getImageModel`.
   */
  export type Error = ModelNotFoundError | InitError | ProviderError.HeaderTimeoutError

  /**
   * Preserve the typed provider error thrown by an impl. Falls back to
   * `InitError` for unexpected non-`Provider.Error` rejections so the
   * service's Effect error channel stays typed at the `Provider.Error`
   * union. Header timeouts from the underlying SDK are mapped to
   * `ProviderError.HeaderTimeoutError` for caller-side `catchTag`.
   */
  export function asProviderError(e: unknown): Error {
    if (e instanceof ModelNotFoundError) return e
    if (e instanceof InitError) return e
    if (e instanceof ProviderError.HeaderTimeoutError) return e
    if (e instanceof Error) {
      const message = (e as { code?: string; message?: string }).message ?? e.message
      return new InitError({ providerID: message })
    }
    return new InitError({ providerID: String(e) })
  }
}
