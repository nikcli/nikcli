import type { APIRoute } from "astro"
import { z } from "zod"

/**
 * Receives an opt-in usage rollup from a nikcli install.
 *
 * Open by design, and hardened accordingly. An install running its own provider
 * keys has no account to sign with, and that is precisely the population
 * nikcli-ai.dev/data exists to show — the gateway already counts everyone else.
 * Requiring credentials would leave the page measuring the users it can already
 * see.
 *
 * So the input is treated as untrusted and the published figures are built to
 * survive that:
 *
 *   - every metric is **clamped, not rejected**, to a ceiling one install could
 *     plausibly reach in a day. A report claiming a trillion tokens contributes
 *     the ceiling, so no single identifier can move an aggregate far;
 *   - one row per (install, day, provider, model) via the primary key, so a
 *     retry replaces a day instead of doubling it, and inventing rows costs a
 *     distinct dimension value rather than unbounded volume;
 *   - only recent whole days are accepted;
 *   - requests are rate limited per source, which is what bounds inventing many
 *     identifiers;
 *   - `verified` records whether an account token came with the report. It is
 *     never required, and the account is never stored.
 */

/**
 * How far back a report may reach.
 *
 * Wide enough for a one-off backfill (`nikcli analytics publish --all`). The
 * routine path still sends a few days at a time; this is the ceiling, not the
 * norm. Without it the public page could only ever show the week just gone,
 * while every install held months the page would never see.
 *
 * Widening it does not widen what a bad actor can claim. Every metric is clamped
 * per row and rows are keyed by (install, day, provider, model), so more days
 * buys more clamped rows rather than bigger numbers, and the per-source rate
 * limit still caps how fast any of them arrive.
 */
const MAX_AGE_DAYS = 400
/** One report covers one install's recent days; more than this is not a CLI. */
const MAX_ROWS = 400

/**
 * Per install, per day, per model ceilings.
 *
 * These are deliberately near the top of what heavy real use reaches rather than
 * at the top of what the number type allows. The previous limits let one request
 * claim 4x10^13 tokens — forty times the figure the code alongside them called
 * impossible — which would have flattened every chart on the page.
 */
const CAP = {
  sessions: 5_000,
  messages: 20_000,
  toolCalls: 200_000,
  tokens: 1_000_000_000,
  costMicroCents: 1_000_000_000_000,
  durationMs: 86_400_000,
} as const

/** Requests accepted from one source per UTC hour. */
const RATE_LIMIT_PER_HOUR = 60

const row = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  messages: z.number().nonnegative().default(0),
  sessions: z.number().nonnegative().optional(),
  toolCalls: z.number().nonnegative().optional(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  /** Older installs send only this total. */
  tokens: z.number().nonnegative().default(0),
  costMicroCents: z.number().nonnegative().optional(),
  /** Older installs send USD. */
  cost: z.number().nonnegative().default(0),
  durationMs: z.number().nonnegative().optional(),
})

const body = z.object({
  /** Random, install-local, never published. */
  installID: z.string().min(8).max(64),
  version: z.string().max(32).optional(),
  rows: z.array(row).min(1).max(MAX_ROWS),
})

const MICRO_CENTS_PER_USD = 100_000_000

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
}

/** Clamp to `[0, cap]` and drop fractions — every stored metric is a count. */
function bounded(value: number | undefined, cap: number): number {
  if (!Number.isFinite(value ?? 0)) return 0
  return Math.min(Math.max(Math.trunc(value ?? 0), 0), cap)
}

/**
 * A source key that identifies a caller without storing its address: the raw IP
 * is hashed with the UTC hour, so the table holds a rotating opaque bucket.
 */
async function rateBucket(request: Request): Promise<string> {
  const source = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown"
  const hour = Math.floor(Date.now() / 3_600_000)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${source}:${hour}`))
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")
}

async function overRateLimit(DB: D1Database, bucket: string): Promise<boolean> {
  const expiresAt = Math.floor(Date.now() / 1000) + 3_600
  const result = await DB.prepare(
    `INSERT INTO community_ingest_rate (bucket, hits, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1
     RETURNING hits`,
  )
    .bind(bucket, expiresAt)
    .first<{ hits: number }>()
  return (result?.hits ?? 0) > RATE_LIMIT_PER_HOUR
}

export const POST: APIRoute = async (ctx) => {
  const DB = (ctx.locals as any).runtime?.env?.DB as D1Database | undefined
  if (!DB) return json({ error: "database_unavailable" }, 500)

  const payload = await ctx.request
    .json()
    .then((value) => body.safeParse(value))
    .catch(() => undefined)
  if (!payload) return json({ error: "invalid_request", message: "body must be JSON" }, 400)
  if (!payload.success) {
    // Zod's issues name the offending path, which is what makes a rejected
    // report debuggable from the CLI side.
    return json({ error: "invalid_request", issues: payload.error.issues }, 400)
  }

  const bucket = await rateBucket(ctx.request)
  if (await overRateLimit(DB, bucket).catch(() => false)) {
    return json({ error: "rate_limited" }, 429)
  }

  const parsed = payload.data
  const today = new Date()
  const oldest = new Date(today.getTime() - MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10)
  const newest = today.toISOString().slice(0, 10)
  const rows = parsed.rows.filter((r) => r.day >= oldest && r.day <= newest)
  if (rows.length === 0) return json({ ok: true, accepted: 0 })

  // Never required, never stored — only counted, so a verified-only view stays
  // possible without keeping any link to the account.
  const verified = ctx.request.headers.get("authorization") ? 1 : 0
  const now = Math.floor(Date.now() / 1000)

  const statement = DB.prepare(
    `INSERT INTO community_stat (
       install_id, day, provider, model,
       sessions, messages, tool_calls,
       input_tokens, output_tokens, reasoning_tokens,
       cache_read_tokens, cache_write_tokens, total_tokens,
       cost_micro_cents, duration_ms, verified, version, updated_at
     )
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(install_id, day, provider, model) DO UPDATE SET
       sessions = excluded.sessions,
       messages = excluded.messages,
       tool_calls = excluded.tool_calls,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       reasoning_tokens = excluded.reasoning_tokens,
       cache_read_tokens = excluded.cache_read_tokens,
       cache_write_tokens = excluded.cache_write_tokens,
       total_tokens = excluded.total_tokens,
       cost_micro_cents = excluded.cost_micro_cents,
       duration_ms = excluded.duration_ms,
       verified = excluded.verified,
       version = excluded.version,
       updated_at = excluded.updated_at`,
  )

  await DB.batch(
    rows.map((r) => {
      const input = bounded(r.inputTokens, CAP.tokens)
      const output = bounded(r.outputTokens, CAP.tokens)
      const reasoning = bounded(r.reasoningTokens, CAP.tokens)
      const cacheRead = bounded(r.cacheReadTokens, CAP.tokens)
      const cacheWrite = bounded(r.cacheWriteTokens, CAP.tokens)
      const breakdown = input + output + reasoning + cacheRead + cacheWrite
      // Installs that send only a total keep working; the breakdown wins when
      // it is present so the parts always add up to the whole.
      const total = bounded(breakdown > 0 ? breakdown : r.tokens, CAP.tokens)
      const cost = bounded(
        r.costMicroCents !== undefined ? r.costMicroCents : r.cost * MICRO_CENTS_PER_USD,
        CAP.costMicroCents,
      )

      return statement.bind(
        parsed.installID,
        r.day,
        r.provider,
        r.model,
        bounded(r.sessions, CAP.sessions),
        bounded(r.messages, CAP.messages),
        bounded(r.toolCalls, CAP.toolCalls),
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total,
        cost,
        bounded(r.durationMs, CAP.durationMs),
        verified,
        parsed.version ?? null,
        now,
      )
    }),
  )

  return json({ ok: true, accepted: rows.length })
}
