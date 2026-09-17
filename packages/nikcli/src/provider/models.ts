import { Global } from "@nikcli-ai/util/global"
import { Log } from "@nikcli-ai/util/log"
import path from "path"
import { data } from "./models-macro" with { type: "macro" }
import { Installation } from "../installation"
import { Flag } from "@nikcli-ai/util/flag"
import { cursorModelsDevProvider } from "../plugin/cursor"
import { NIKCLI_INFERENCE_ID, nikcliInferenceModelsDevProvider } from "./nikcli-inference"
import { patchReasoningOptions } from "./variants-catalog-patch"
import { type DeepMutable, zodObject } from "@nikcli-ai/util/effect-zod"
import { Schema } from "effect"

/**
 * The reserve model a ChatGPT (Codex) plan falls back to when the main models
 * are exhausted. Not a models.dev entry — see `ModelsDev.patch`.
 */
export const GPT_RESERVE_ID = "gpt-reserve"

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  const filepath = path.join(Global.Path.cache, "models.json")

  function ensureModel(database: Record<string, Provider>, providerID: string, modelID: string, model: Model) {
    const provider = database[providerID]
    if (!provider) return
    if (!provider.models) return
    const existing = provider.models[modelID]
    if (existing) {
      // Merge `provider` and `modalities` so patches enrich models.dev entries
      // without clobbering fields the upstream registry already populated.
      const merged: Model = {
        ...existing,
        modalities: model.modalities ?? existing.modalities,
        provider: model.provider ?? existing.provider,
      }
      provider.models[modelID] = merged
      return
    }
    provider.models[modelID] = model
  }

  /**
   * Enrich the raw models.dev database with entries and fields the upstream
   * registry does not carry yet. Exported so the seeding can be asserted
   * directly, the same way `patchReasoningOptions` is.
   */
  export function patch(database: Record<string, Provider>): Record<string, Provider> {
    // MiniMax M2.5 (models.dev PR #875)
    const releaseDate = "2026-02-12"
    const limit = {
      context: 204_800,
      output: 131_072,
    }
    const modalities: NonNullable<Model["modalities"]> = {
      input: ["text"],
      output: ["text"],
    }

    const minimaxM25Paid: Model = {
      id: "MiniMax-M2.5",
      name: "MiniMax-M2.5",
      family: "minimax",
      release_date: releaseDate,
      attachment: false,
      reasoning: true,
      tool_call: true,
      temperature: true,
      cost: {
        input: 0.3,
        output: 1.2,
        cache_read: 0.03,
        cache_write: 0.375,
      },
      limit,
      modalities,
      options: {},
    }

    const minimaxM25Free: Model = {
      id: "MiniMax-M2.5",
      name: "MiniMax-M2.5",
      family: "minimax",
      release_date: releaseDate,
      attachment: false,
      reasoning: true,
      tool_call: true,
      temperature: true,
      cost: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      },
      limit,
      modalities,
      options: {},
    }

    const openrouterM25: Model = {
      id: "minimax/minimax-m2.5",
      name: "MiniMax M2.5",
      family: "minimax",
      release_date: releaseDate,
      attachment: false,
      reasoning: true,
      tool_call: true,
      temperature: true,
      interleaved: {
        field: "reasoning_details",
      },
      cost: {
        input: 0.3,
        output: 1.2,
      },
      limit,
      modalities,
      options: {},
    }

    // MiniMax M3 (1M context, MiniMax Sparse Attention, multimodal input, real coding-plan pricing)
    const m3ReleaseDate = "2026-05-31"
    const m3Limit = {
      context: 1_048_576,
      output: 131_072,
    }
    const m3Modalities: NonNullable<Model["modalities"]> = {
      input: ["text", "image", "video"],
      output: ["text"],
    }

    const minimaxM3: Model = {
      id: "MiniMax-M3",
      name: "MiniMax-M3",
      family: "minimax",
      release_date: m3ReleaseDate,
      attachment: true,
      reasoning: true,
      tool_call: true,
      temperature: true,
      cost: {
        input: 0.3,
        output: 1.2,
        cache_read: 0.03,
        cache_write: 0.375,
      },
      limit: m3Limit,
      modalities: m3Modalities,
      options: {},
    }

    const openrouterM3: Model = {
      id: "minimax/minimax-m3",
      name: "MiniMax M3",
      family: "minimax",
      release_date: m3ReleaseDate,
      attachment: true,
      reasoning: true,
      tool_call: true,
      temperature: true,
      interleaved: {
        field: "reasoning_details",
      },
      cost: {
        input: 0.3,
        output: 1.2,
      },
      limit: m3Limit,
      modalities: m3Modalities,
      options: {},
    }

    ensureModel(database, "minimax", "MiniMax-M2.5", minimaxM25Paid)
    ensureModel(database, "minimax-cn", "MiniMax-M2.5", minimaxM25Paid)
    ensureModel(database, "minimax-coding-plan", "MiniMax-M2.5", minimaxM25Free)
    ensureModel(database, "minimax-cn-coding-plan", "MiniMax-M2.5", minimaxM25Free)
    ensureModel(database, "openrouter", "minimax/minimax-m2.5", openrouterM25)

    ensureModel(database, "minimax", "MiniMax-M3", minimaxM3)
    ensureModel(database, "minimax-cn", "MiniMax-M3", minimaxM3)
    ensureModel(database, "minimax-coding-plan", "MiniMax-M3", minimaxM3)
    ensureModel(database, "minimax-cn-coding-plan", "MiniMax-M3", minimaxM3)
    ensureModel(database, "openrouter", "minimax/minimax-m3", openrouterM3)

    // ---- GPT-6 Astra ----
    // OpenAI shipped gpt-6-astra on 2026-09-03; models.dev has no row for it
    // yet, so seed one. `ensureModel` merges rather than replaces, so once the
    // upstream registry lists it the catalog entry wins.
    //
    // Pricing is the standard (<=272K input) tier: $10/M input, $1/M cached
    // input, $12.50/M cache write, $50/M output. The long-context tier (>272K
    // input re-prices the whole request at 2x input/cache and 1.5x output) is
    // deliberately NOT modelled as `context_over_200k`: that field's threshold
    // is hard-coded at 200K in session cost accounting, which would over-bill
    // every request in the 200K-272K band. Base rates stay exact there.
    // see: https://developers.openai.com/api/docs/models/gpt-6-astra
    const gpt6Astra: Model = {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      family: "gpt-6",
      release_date: "2026-09-03",
      attachment: true,
      reasoning: true,
      tool_call: true,
      // Reasoning is always on for Astra, and `temperature` cannot be used
      // while reasoning is enabled.
      temperature: false,
      cost: {
        input: 10,
        output: 50,
        cache_read: 1,
        cache_write: 12.5,
      },
      limit: {
        context: 1_050_000,
        output: 128_000,
      },
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      options: {},
    }
    ensureModel(database, "openai", "gpt-6-astra", gpt6Astra)

    // ---- GPT-Reserve ----
    // The model a ChatGPT (Codex) plan falls back to once the main models are
    // used up. OpenAI ships it with `visibility: "hide"` in the Codex model
    // manifest, so it is not in models.dev and never will be: it only exists
    // for plan-authenticated traffic through the Codex backend. `Provider`
    // deletes it again unless the openai auth is an OAuth credential, and
    // `filterCodexOAuthModels` keeps it for the sessions that can reach it.
    //
    // Fields mirror the Codex manifest entry: 272K standard context window,
    // low/medium/high/xhigh/max reasoning (no `none`/`minimal`), text+image in,
    // and `medium` as the default effort. Cost is 0 because plan traffic is not
    // metered per token — the same reason the codex plugin zeroes every other
    // model it keeps.
    const gptReserve: Model = {
      id: GPT_RESERVE_ID,
      name: "GPT-Reserve",
      family: "gpt-reserve",
      release_date: "2026-09-03",
      attachment: true,
      reasoning: true,
      tool_call: true,
      temperature: false,
      cost: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      },
      limit: {
        context: 272_000,
        output: 128_000,
      },
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      options: {},
    }
    ensureModel(database, "openai", GPT_RESERVE_ID, gptReserve)

    // ---- Image models (registered because models.dev does not yet list these AI SDK image factories) ----
    const imageModalities: NonNullable<Model["modalities"]> = {
      input: ["text"],
      output: ["image"],
    }

    const imageModel = (id: string, name: string, family: string, npm: string, api: string): Model => ({
      id,
      name,
      family,
      release_date: "2025-01-01",
      attachment: false,
      reasoning: false,
      tool_call: false,
      temperature: false,
      cost: { input: 0, output: 0 },
      limit: { context: 1_000, output: 1_000 },
      modalities: imageModalities,
      options: {},
      provider: { npm, api },
    })

    // OpenAI (direct) — @ai-sdk/openai exposes .image(modelId)
    ensureModel(
      database,
      "openai",
      "gpt-image-1",
      imageModel("gpt-image-1", "GPT Image 1", "gpt-image", "@ai-sdk/openai", "https://api.openai.com/v1"),
    )
    ensureModel(
      database,
      "openai",
      "gpt-image-1-mini",
      imageModel("gpt-image-1-mini", "GPT Image 1 mini", "gpt-image", "@ai-sdk/openai", "https://api.openai.com/v1"),
    )
    ensureModel(
      database,
      "openai",
      "gpt-image-1.5",
      imageModel("gpt-image-1.5", "GPT Image 1.5", "gpt-image", "@ai-sdk/openai", "https://api.openai.com/v1"),
    )
    ensureModel(
      database,
      "openai",
      "dall-e-3",
      imageModel("dall-e-3", "DALL·E 3", "dall-e", "@ai-sdk/openai", "https://api.openai.com/v1"),
    )

    // Google (direct) — @ai-sdk/google exposes .image(modelId)
    ensureModel(
      database,
      "google",
      "imagen-4.0-generate-001",
      imageModel(
        "imagen-4.0-generate-001",
        "Imagen 4 Generate",
        "imagen",
        "@ai-sdk/google",
        "https://generativelanguage.googleapis.com/v1beta",
      ),
    )
    ensureModel(
      database,
      "google",
      "imagen-4.0-ultra-generate-001",
      imageModel(
        "imagen-4.0-ultra-generate-001",
        "Imagen 4 Ultra",
        "imagen",
        "@ai-sdk/google",
        "https://generativelanguage.googleapis.com/v1beta",
      ),
    )
    ensureModel(
      database,
      "google",
      "imagen-4.0-fast-generate-001",
      imageModel(
        "imagen-4.0-fast-generate-001",
        "Imagen 4 Fast",
        "imagen",
        "@ai-sdk/google",
        "https://generativelanguage.googleapis.com/v1beta",
      ),
    )

    // xAI (direct) — @ai-sdk/xai exposes .image(modelId)
    ensureModel(
      database,
      "xai",
      "grok-imagine-image",
      imageModel("grok-imagine-image", "Grok Imagine Image", "grok-imagine", "@ai-sdk/xai", "https://api.x.ai/v1"),
    )
    ensureModel(
      database,
      "xai",
      "grok-imagine-image-pro",
      imageModel(
        "grok-imagine-image-pro",
        "Grok Imagine Image Pro",
        "grok-imagine",
        "@ai-sdk/xai",
        "https://api.x.ai/v1",
      ),
    )

    // Together AI — @ai-sdk/togetherai exposes .image(modelId)
    ensureModel(
      database,
      "togetherai",
      "black-forest-labs/FLUX.1-dev",
      imageModel(
        "black-forest-labs/FLUX.1-dev",
        "FLUX.1-dev",
        "flux",
        "@ai-sdk/togetherai",
        "https://api.together.xyz/v1",
      ),
    )
    ensureModel(
      database,
      "togetherai",
      "black-forest-labs/FLUX.1-schnell",
      imageModel(
        "black-forest-labs/FLUX.1-schnell",
        "FLUX.1-schnell",
        "flux",
        "@ai-sdk/togetherai",
        "https://api.together.xyz/v1",
      ),
    )
    ensureModel(
      database,
      "togetherai",
      "black-forest-labs/FLUX.1.1-pro",
      imageModel(
        "black-forest-labs/FLUX.1.1-pro",
        "FLUX.1.1-pro",
        "flux",
        "@ai-sdk/togetherai",
        "https://api.together.xyz/v1",
      ),
    )
    ensureModel(
      database,
      "togetherai",
      "stabilityai/stable-diffusion-xl-base-1.0",
      imageModel(
        "stabilityai/stable-diffusion-xl-base-1.0",
        "Stable Diffusion XL Base 1.0",
        "sdxl",
        "@ai-sdk/togetherai",
        "https://api.together.xyz/v1",
      ),
    )

    // Patch openrouter-routed image models so `getImageModel` routes them correctly
    // (models.dev entries lack modalities + provider metadata).
    ensureModel(
      database,
      "openrouter",
      "google/nano-banana-pro-2.5",
      imageModel(
        "google/nano-banana-pro-2.5",
        "Google Nano Banana Pro 2.5",
        "nanobanana",
        "@openrouter/ai-sdk-provider",
        "https://openrouter.ai/api/v1",
      ),
    )
    ensureModel(
      database,
      "openrouter",
      "openai/gpt-5-image",
      imageModel(
        "openai/gpt-5-image",
        "OpenAI GPT-5 Image",
        "gpt-image",
        "@openrouter/ai-sdk-provider",
        "https://openrouter.ai/api/v1",
      ),
    )

    // Cursor is not in models.dev; inject it so /connect dialog can offer it.
    if (!database["cursor"]) {
      database["cursor"] = cursorModelsDevProvider() as Provider
    }

    // Same for the nikcli inference gateway — the live catalog is fetched by
    // its custom loader, this seed just makes it a known provider.
    if (!database[NIKCLI_INFERENCE_ID]) {
      database[NIKCLI_INFERENCE_ID] = nikcliInferenceModelsDevProvider() as Provider
    }

    // Catalog-driven variant generation, mirroring upstream opencode v2's
    // `opencode.variant` plugin. The patch fills in `reasoning_options`
    // for entries that the upstream registry doesn't enrich (grok, deepseek,
    // kimi, qwen, glm, MiniMax M3). Entries that already declare options
    // are left untouched, so explicit catalog overrides still win.
    patchReasoningOptions(database as Record<string, Provider>)

    return database
  }

  const ModalityValueSchema = Schema.Literals(["text", "audio", "image", "video", "pdf"])

  const CostBlockSchema = Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cache_read: Schema.optional(Schema.Number),
    cache_write: Schema.optional(Schema.Number),
  })

  const ModelSchema = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    family: Schema.optional(Schema.String),
    release_date: Schema.String,
    attachment: Schema.Boolean,
    reasoning: Schema.Boolean,
    temperature: Schema.Boolean,
    tool_call: Schema.Boolean,
    interleaved: Schema.optional(
      Schema.Union([
        Schema.Literal(true),
        Schema.Struct({
          field: Schema.Literals(["reasoning_content", "reasoning_details"]),
        }),
      ]),
    ),
    cost: Schema.optional(
      Schema.Struct({
        input: Schema.Number,
        output: Schema.Number,
        cache_read: Schema.optional(Schema.Number),
        cache_write: Schema.optional(Schema.Number),
        context_over_200k: Schema.optional(CostBlockSchema),
      }),
    ),
    limit: Schema.Struct({
      context: Schema.Number,
      input: Schema.optional(Schema.Number),
      output: Schema.Number,
    }),
    modalities: Schema.optional(
      Schema.Struct({
        input: Schema.Array(ModalityValueSchema),
        output: Schema.Array(ModalityValueSchema),
      }),
    ),
    experimental: Schema.optional(Schema.Boolean),
    status: Schema.optional(Schema.Literals(["alpha", "beta", "deprecated"])),
    options: Schema.Record(Schema.String, Schema.Unknown),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    provider: Schema.optional(Schema.Struct({ npm: Schema.String, api: Schema.String })),
    // Per-model reasoning variant controls (mirrors the upstream models.dev
    // `reasoning_options` field). When present, `src/provider/variants.ts`
    // turns these into the model.variants map; when absent, the loader falls
    // back to the procedural `ProviderTransform.variants` derivation so we
    // don't regress models whose entries haven't been migrated upstream yet.
    reasoning_options: Schema.optional(
      Schema.Array(
        Schema.Union([
          Schema.Struct({
            type: Schema.Literal("effort"),
            // null means "no effort control" (e.g. a toggle-only option that
            // also wants to expose the off state as a named effort variant);
            // skipped during variant synthesis.
            values: Schema.Array(Schema.Union([Schema.String, Schema.Null])),
          }),
          Schema.Struct({
            type: Schema.Literal("toggle"),
          }),
          Schema.Struct({
            type: Schema.Literal("budget_tokens"),
            min: Schema.optional(Schema.Number),
            max: Schema.optional(Schema.Number),
          }),
        ]),
      ),
    ),
    variants: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
  })
  export const Model = zodObject(ModelSchema)
  export type Model = DeepMutable<Schema.Schema.Type<typeof ModelSchema>>

  const ProviderSchema = Schema.Struct({
    api: Schema.optional(Schema.String),
    name: Schema.String,
    env: Schema.mutable(Schema.Array(Schema.String)),
    id: Schema.String,
    npm: Schema.optional(Schema.String),
    models: Schema.Record(Schema.String, ModelSchema),
  })
  export const Provider = zodObject(ProviderSchema)
  export type Provider = DeepMutable<Schema.Schema.Type<typeof ProviderSchema>>

  export async function get() {
    if (!Flag.NIKCLI_DISABLE_MODELS_FETCH) {
      refresh().catch((error) => {
        log.error("background models refresh failed", { error })
      })
    }
    const file = Bun.file(filepath)
    const result = await file.json().catch(() => {})
    if (result) return patch(result as Record<string, Provider>)
    if (typeof data === "function" && !Flag.NIKCLI_DISABLE_MODELS_FETCH) {
      try {
        const json = await data()
        return patch(JSON.parse(json) as Record<string, Provider>)
      } catch (error) {
        log.error("Failed to load embedded models data", { error })
      }
    }
    if (Flag.NIKCLI_DISABLE_MODELS_FETCH) return {}
    const url = Global.Path.modelsDevUrl
    const json = await fetch(`${url}/api.json`)
      .then((x) => (x.ok ? x.text() : "{}"))
      .catch((error) => {
        log.error("Failed to fetch models.dev", { error })
        return "{}"
      })
    try {
      return patch(JSON.parse(json) as Record<string, Provider>)
    } catch (error) {
      // Captive portals / proxies can return a 200 with a non-JSON body.
      log.error("models.dev returned invalid JSON", { error })
      return {}
    }
  }

  export async function refresh() {
    if (Flag.NIKCLI_DISABLE_MODELS_FETCH) return
    const file = Bun.file(filepath)
    log.info("refreshing", {
      file,
    })
    const url = Global.Path.modelsDevUrl
    const result = await fetch(`${url}/api.json`, {
      headers: {
        "User-Agent": Installation.USER_AGENT,
      },
      signal: AbortSignal.timeout(10 * 1000),
    }).catch((e) => {
      log.error("Failed to fetch models.dev", {
        error: e,
      })
    })
    if (result && result.ok) await Bun.write(file, await result.text())
  }
}

setInterval(
  () => {
    ModelsDev.refresh().catch((error) => {
      Log.Default.error("scheduled models.dev refresh failed", { error })
    })
  },
  60 * 1000 * 60,
).unref()
