import { and, count, Database, gte, lt, sql } from "@nikcli-ai/console-core/drizzle/index.js"
import { UsageTable } from "@nikcli-ai/console-core/schema/billing.sql.js"

/**
 * Public, aggregate-only feed of gateway usage — the data behind nikcli-ai.dev/data.
 *
 * Every figure is a SUM over the `usage` table, the row the gateway writes for
 * each completion it bills. It is served from here rather than queried from the
 * website's worker so the database credentials stay in the one deployment that
 * already holds them; the site only ever fetches this JSON.
 *
 * Nothing identifying leaves this route. Workspace, key and user columns are
 * never selected, only grouped away, so no row here can be traced back to an
 * account. `usage.cost` is what the caller was billed; the upstream cost is not
 * exposed anywhere, since publishing it beside the billed figure would publish
 * the margin.
 */

const DAY_SECONDS = 86_400
/** Rolling window the headline figures and the leaderboard are measured over. */
const WINDOW_DAYS = 30
/** Longer window for the daily series, so a trend is visible before a rank is. */
const SERIES_DAYS = 60
/** Lookback for the activity heatmap. */
const ACTIVITY_DAYS = 365

/** `usage.cost` is stored in micro-cents: 100 cents × 1e6 to the dollar. */
const MICRO_CENTS_PER_USD = 100_000_000

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

// The feed changes slowly and is identical for everyone, so it is worth holding
// at the edge; a stale copy is far better than a miss that scans the table.
const ok = "public, max-age=60, s-maxage=900, stale-while-revalidate=86400, stale-if-error=86400"
const failed = "public, max-age=1, s-maxage=60, stale-while-revalidate=600"

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const tokenSum = sql<number>`COALESCE(SUM(
  ${UsageTable.inputTokens} + ${UsageTable.outputTokens}
  + COALESCE(${UsageTable.reasoningTokens}, 0)
  + COALESCE(${UsageTable.cacheReadTokens}, 0)
  + COALESCE(${UsageTable.cacheWrite5mTokens}, 0)
  + COALESCE(${UsageTable.cacheWrite1hTokens}, 0)
), 0)`

const day = sql<string>`DATE(${UsageTable.timeCreated})`

/** One `GROUP BY model, provider` bucket over a time window. */
function bucketsBetween(from: Date, to: Date) {
  return Database.use((tx) =>
    tx
      .select({
        model: UsageTable.model,
        provider: UsageTable.provider,
        requests: count(),
        inputTokens: sql<number>`COALESCE(SUM(${UsageTable.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${UsageTable.outputTokens}), 0)`,
        reasoningTokens: sql<number>`COALESCE(SUM(${UsageTable.reasoningTokens}), 0)`,
        cacheReadTokens: sql<number>`COALESCE(SUM(${UsageTable.cacheReadTokens}), 0)`,
        cacheWriteTokens: sql<number>`COALESCE(SUM(${UsageTable.cacheWrite5mTokens}), 0) + COALESCE(SUM(${UsageTable.cacheWrite1hTokens}), 0)`,
        cost: sql<number>`COALESCE(SUM(${UsageTable.cost}), 0)`,
      })
      .from(UsageTable)
      .where(and(gte(UsageTable.timeCreated, from), lt(UsageTable.timeCreated, to)))
      .groupBy(UsageTable.model, UsageTable.provider),
  ).then((rows) =>
    rows.map((row) => ({
      model: row.model,
      provider: row.provider,
      requests: number(row.requests),
      inputTokens: number(row.inputTokens),
      outputTokens: number(row.outputTokens),
      reasoningTokens: number(row.reasoningTokens),
      cacheReadTokens: number(row.cacheReadTokens),
      cacheWriteTokens: number(row.cacheWriteTokens),
      costUsd: number(row.cost) / MICRO_CENTS_PER_USD,
    })),
  )
}

function dailyFrom(from: Date) {
  return Database.use((tx) =>
    tx
      .select({ day, model: UsageTable.model, tokens: tokenSum, requests: count() })
      .from(UsageTable)
      .where(gte(UsageTable.timeCreated, from))
      .groupBy(day, UsageTable.model)
      .orderBy(day),
  ).then((rows) =>
    rows.map((row) => ({
      day: String(row.day),
      model: row.model,
      tokens: number(row.tokens),
      requests: number(row.requests),
    })),
  )
}

/** One row per day, for the year-long activity grid. */
function activityFrom(from: Date) {
  return Database.use((tx) =>
    tx
      .select({ day, tokens: tokenSum, requests: count(), cost: sql<number>`COALESCE(SUM(${UsageTable.cost}), 0)` })
      .from(UsageTable)
      .where(gte(UsageTable.timeCreated, from))
      .groupBy(day)
      .orderBy(day),
  ).then((rows) =>
    rows.map((row) => ({
      date: String(row.day),
      tokens: number(row.tokens),
      requests: number(row.requests),
      costUsd: number(row.cost) / MICRO_CENTS_PER_USD,
    })),
  )
}

function daysAgo(now: number, days: number): Date {
  return new Date((now - days * DAY_SECONDS) * 1000)
}

export async function GET() {
  const now = Math.floor(Date.now() / 1000)
  const windowStart = daysAgo(now, WINDOW_DAYS)

  try {
    const [current, previous, daily, activity] = await Promise.all([
      bucketsBetween(windowStart, new Date(now * 1000)),
      bucketsBetween(daysAgo(now, WINDOW_DAYS * 2), windowStart),
      dailyFrom(daysAgo(now, SERIES_DAYS)),
      activityFrom(daysAgo(now, ACTIVITY_DAYS)),
    ])

    return new Response(
      JSON.stringify({
        generatedAt: now,
        windowDays: WINDOW_DAYS,
        seriesDays: SERIES_DAYS,
        activityDays: ACTIVITY_DAYS,
        current,
        previous,
        daily,
        activity,
      }),
      { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": ok, ...cors } },
    )
  } catch {
    // The page treats a failure as "nothing published yet" and says so, which is
    // the honest outcome — better than a 500 on a public marketing page.
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": failed, ...cors },
    })
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: cors })
}
