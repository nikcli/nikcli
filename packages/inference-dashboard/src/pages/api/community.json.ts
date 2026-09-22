import type { APIRoute } from "astro"

/**
 * Public, aggregate-only feed of what nikcli installs report running — the
 * community half of nikcli-ai.dev/data.
 *
 * `install_id` never leaves this route. It is grouped away everywhere, and the
 * only thing derived from it is `COUNT(DISTINCT install_id)`, so the feed can
 * say how many installs were active on a day without saying which.
 */

const DAY = 86_400_000
/** Window the leaderboard is measured over. */
const WINDOW_DAYS = 30
/** Longer window for the daily series. */
const SERIES_DAYS = 60

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}
const ok = "public, max-age=60, s-maxage=900, stale-while-revalidate=86400, stale-if-error=86400"
const failed = "public, max-age=1, s-maxage=60, stale-while-revalidate=600"

function json(data: unknown, status: number, cache: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cache, ...cors },
  })
}

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

interface Bucket {
  model: string
  provider: string
  messages: number
  sessions: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  tokens: number
  durationMs: number
  cost: number
  installs: number
}

export const GET: APIRoute = async (ctx) => {
  const DB = (ctx.locals as any).runtime?.env?.DB as D1Database | undefined
  if (!DB) return json({ error: "database_unavailable" }, 503, failed)

  const now = Date.now()
  const windowStart = dayKey(now - WINDOW_DAYS * DAY)
  const previousStart = dayKey(now - WINDOW_DAYS * 2 * DAY)
  const seriesStart = dayKey(now - SERIES_DAYS * DAY)

  // The full breakdown, so the page can show what opencode.ai/data shows —
  // blended price per million, cache ratio, cost per session — measured across
  // nikcli installs rather than across one gateway's traffic.
  //
  // `sessions` sums each install's per-day distinct count. Across installs that
  // is exact, since two installs never share a session; across days it counts a
  // session that ran past midnight once per day. It is activity, not reach —
  // reach is `installs`, which is a distinct count.
  const bucketSQL = `
    SELECT model, provider,
           SUM(messages)                 AS messages,
           SUM(sessions)                 AS sessions,
           SUM(tool_calls)               AS toolCalls,
           SUM(input_tokens)             AS inputTokens,
           SUM(output_tokens)            AS outputTokens,
           SUM(reasoning_tokens)         AS reasoningTokens,
           SUM(cache_read_tokens)        AS cacheReadTokens,
           SUM(cache_write_tokens)       AS cacheWriteTokens,
           SUM(total_tokens)             AS tokens,
           SUM(duration_ms)              AS durationMs,
           SUM(cost_micro_cents) / 1e8   AS cost,
           COUNT(DISTINCT install_id)    AS installs
    FROM community_stat
    WHERE day >= ? AND day < ?
    GROUP BY model, provider`

  // Distinct installs per model, counted here rather than folded out of the
  // per-model buckets afterwards. A model served by two providers has one bucket
  // each: summing them double-counts an install that used both, and taking the
  // larger silently undercounts two installs that each used one. Only a count
  // over the raw identifiers is right, and this is the last place they exist.
  const modelReachSQL = `
    SELECT model, COUNT(DISTINCT install_id) AS installs
    FROM community_stat
    WHERE day >= ? AND day < ?
    GROUP BY model`

  try {
    const [current, previous, daily, installs, reach, modelReach] = await Promise.all([
      DB.prepare(bucketSQL)
        .bind(windowStart, dayKey(now + DAY))
        .all<Bucket>(),
      DB.prepare(bucketSQL).bind(previousStart, windowStart).all<Bucket>(),
      DB.prepare(
        `SELECT day, model,
                SUM(total_tokens)          AS tokens,
                SUM(messages)              AS messages,
                SUM(sessions)              AS sessions,
                COUNT(DISTINCT install_id) AS installs
         FROM community_stat WHERE day >= ? GROUP BY day, model ORDER BY day ASC`,
      )
        .bind(seriesStart)
        .all<{ day: string; model: string; tokens: number; messages: number; sessions: number; installs: number }>(),
      DB.prepare(
        `SELECT day, COUNT(DISTINCT install_id) AS installs
         FROM community_stat WHERE day >= ? GROUP BY day ORDER BY day ASC`,
      )
        .bind(seriesStart)
        .all<{ day: string; installs: number }>(),
      DB.prepare(`SELECT COUNT(DISTINCT install_id) AS installs FROM community_stat WHERE day >= ?`)
        .bind(windowStart)
        .first<{ installs: number }>(),
      DB.prepare(modelReachSQL)
        .bind(windowStart, dayKey(now + DAY))
        .all<{ model: string; installs: number }>(),
    ])

    return json(
      {
        generatedAt: Math.floor(now / 1000),
        windowDays: WINDOW_DAYS,
        seriesDays: SERIES_DAYS,
        installsInWindow: reach?.installs ?? 0,
        current: current.results ?? [],
        previous: previous.results ?? [],
        daily: daily.results ?? [],
        installs: installs.results ?? [],
        /** Distinct installs per model — not derivable from `current`. */
        modelInstalls: modelReach.results ?? [],
      },
      200,
      ok,
    )
  } catch {
    return json({ error: "unavailable" }, 503, failed)
  }
}

export const OPTIONS: APIRoute = async () => new Response(null, { status: 200, headers: cors })
