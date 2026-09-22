import { z } from "zod"

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),

  VLLM_BASE_URL: z.string().url().default("http://localhost:8000/v1"),
  LOCAL_API_KEY: z.string().default("local-dev-key"),

  TOGETHER_API_KEY: z.string().optional(),
  FIREWORKS_API_KEY: z.string().optional(),
  DEEPINFRA_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  CEREBRAS_API_KEY: z.string().optional(),
  SAMBANOVA_API_KEY: z.string().optional(),
  HYPERBOLIC_API_KEY: z.string().optional(),
  NEBIUS_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_REFERRER: z.string().optional(),
  OPENROUTER_APP_NAME: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  MOONSHOT_API_KEY: z.string().optional(),
  ZHIPU_API_KEY: z.string().optional(),

  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  /**
   * Dashboard control plane (dashboard.nikcli-ai.dev). When both are set,
   * customer keys are validated against POST /api/validate and usage is
   * recorded via POST /api/usage/ingest; the hardcoded demo keys are disabled.
   */
  INFERENCE_DASHBOARD_URL: z.string().url().optional(),
  GATEWAY_SHARED_SECRET: z.string().optional(),

  /** Identity issuer for OAuth bearer tokens (offline JWKS verification). */
  AUTH_ISSUER: z.string().url().default("https://auth.nikcli-ai.dev"),
  AUTH_AUDIENCE: z.string().default("nikcli-api"),
  AUTH_JWKS_URL: z.string().url().optional(),

  INFERENCE_CACHE_MAX: z.coerce.number().int().positive().default(5_000),
  INFERENCE_CACHE_TTL: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60),

  ALLOW_ESTIMATED_ROUTES: z.coerce.boolean().default(false),

  /** Expose and serve only the models with a 0/0 billed price (verified `:free` upstreams). */
  INFERENCE_FREE_ONLY: z.coerce.boolean().default(false),

  /** Provider name to prefer for ALL requests (overridable per-request via nikcli.preferProvider). */
  DEFAULT_PREFER_PROVIDER: z.string().optional(),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  STRIPE_SECRET_KEY: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached
  // Treat empty strings as "not set" + strip surrounding quotes (common in .env files).
  const cleaned: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || v === "") {
      cleaned[k] = undefined
      continue
    }
    let trimmed = v.trim()
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      trimmed = trimmed.slice(1, -1)
    }
    cleaned[k] = trimmed === "" ? undefined : trimmed
  }
  const result = envSchema.safeParse(cleaned)
  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n  ")
    throw new Error(`Invalid environment configuration:\n  ${errors}`)
  }
  cached = result.data
  return cached
}

export function resetEnvForTests() {
  cached = null
}
