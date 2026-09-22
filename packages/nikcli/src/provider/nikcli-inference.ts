/**
 * The nikcli inference gateway is not published on models.dev, so it is
 * injected into the ModelsDev database the same way `cursor` is. That makes it
 * a first-class provider everywhere: `nikcli auth login`, `/models`, config
 * `provider.nikcli-inference`, and the env/api-key merge pipeline.
 *
 * The catalog is served by the gateway itself (`GET /v1/models`), so the entry
 * below only carries a seed model; the CUSTOM_LOADER in provider.ts replaces it
 * with the live list once a credential is available.
 */

export const NIKCLI_INFERENCE_ID = "nikcli-inference"
export const NIKCLI_INFERENCE_ENV = "NIKCLI_INFERENCE_KEY"
export const NIKCLI_INFERENCE_DEFAULT_URL = "https://inference.nikcli-ai.dev/v1"

export interface GatewayModel {
  id: string
  context_window?: number
  params?: string
  hf_id?: string
  pricing?: { input?: number; output?: number }
  thinking?: "native" | "optional" | null
  variant_of?: string
  alias_of?: string
}

/** Shape a gateway `/v1/models` entry into a models.dev-style model record. */
export function toModelsDevModel(m: GatewayModel): Record<string, unknown> {
  const context = m.context_window ?? 128_000
  // The gateway advertises multimodal input on the vision-capable families.
  const image = /scout|maverick|kimi|vl|omni|gemma/.test(m.id)
  return {
    id: m.id,
    name: m.id,
    family: "nikcli-inference",
    release_date: "2026-01-01",
    attachment: image,
    reasoning: m.thinking === "native" || m.id.endsWith(":thinking"),
    tool_call: true,
    temperature: true,
    cost: { input: m.pricing?.input ?? 0, output: m.pricing?.output ?? 0 },
    limit: { context, output: Math.min(context, 8192) },
    modalities: {
      input: image ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    options: {},
  }
}

/**
 * Seed entry used before the gateway has been contacted. `nikcli-free` is a
 * stable alias the gateway always resolves, so the provider is selectable in
 * `auth login` / `/models` even offline.
 */
export function nikcliInferenceModelsDevProvider(): {
  id: string
  name: string
  env: string[]
  api: string
  npm: string
  models: Record<string, unknown>
} {
  return {
    id: NIKCLI_INFERENCE_ID,
    name: "nikcli Inference Gateway",
    env: [NIKCLI_INFERENCE_ENV],
    api: NIKCLI_INFERENCE_DEFAULT_URL,
    npm: "@ai-sdk/openai-compatible",
    models: {
      "nikcli-free": toModelsDevModel({ id: "nikcli-free", context_window: 262_144 }),
    },
  }
}
