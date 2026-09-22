/**
 * Anonymous usage reporting, on by default.
 *
 * nikcli-ai.dev/data can only show what the inference gateway served, which is a
 * small slice of what nikcli actually runs: most people bring their own
 * provider keys, and those models never reach the gateway. This sends the
 * per-day, per-model totals the CLI already keeps locally, so the public page
 * reflects the models developers really use.
 *
 * Defaulting to on is what makes the picture representative — an opt-in sample
 * measures the people who opted in — so the burden is on this file to be worth
 * that default:
 *
 *   - only aggregates leave the machine: day, provider, model, session count,
 *     message count, token count, cost. No prompt, no file path, no repository,
 *     no session title, no account, no environment, no IP beyond the one any
 *     HTTP request carries;
 *   - the install identifier is a random v4 UUID generated here and kept
 *     locally. The server uses it only to replace a day rather than double it,
 *     and to count distinct installs. It is never published;
 *   - turning it off is a single flag, and the two conventional environment
 *     opt-outs are honoured before the config is even read, so a machine that
 *     has said "do not track" is never asked twice;
 *   - a failure is silent and retried later. Reporting must never be something
 *     the user notices, in either direction.
 */
import { Effect } from "effect"
import { AnalyticsRollup } from "./rollup"
import { Config } from "@/config/config"
import { Database } from "@/database/database"
import { Installation } from "@/installation"
import { Log } from "@nikcli-ai/util/log"
import { runPromiseWithLayer } from "@/effect"

export namespace AnalyticsShare {
  const log = Log.create({ service: "analytics-share" })

  const DEFAULT_ENDPOINT = "https://dashboard.nikcli-ai.dev/api/community/report"
  /** How far back to catch up when an install has been offline. */
  const MAX_CATCHUP_DAYS = 7
  const DAY_MS = 86_400_000
  /** Matches the collector's per-request row cap, so no batch is rejected whole. */
  const MAX_ROWS_PER_REPORT = 400
  /** Rollups store micro-cent integers; the wire keeps a USD number for older collectors. */
  const MICRO_CENTS_PER_USD = 100_000_000

  interface State {
    /** Random, local, never published. */
    installID: string
  }

  /** One row in `analytics_share`, read and upserted. See `Database.rawSql`. */
  function native(): Database.RawSql {
    return Database.rawSql("analytics.share")
  }

  function dayKey(at: number): string {
    return new Date(at).toISOString().slice(0, 10)
  }

  /**
   * A random v4 UUID — 122 bits of entropy and nothing else.
   *
   * Deliberately not `Identifier.ascending`, which nikcli uses for ids elsewhere:
   * those embed a timestamp, so the identifier itself would carry the moment the
   * install first reported. This one is drawn from the CSPRNG and encodes no
   * machine, no user and no clock.
   */
  function newInstallID(): string {
    return crypto.randomUUID()
  }

  function readState(): State {
    const row = native()
      .query<{ install_id: string }, []>(`SELECT install_id FROM analytics_share WHERE id = 'local'`)
      .get()
    if (row?.install_id) return { installID: row.install_id }
    const fresh: State = { installID: newInstallID() }
    writeState(fresh)
    return fresh
  }

  function writeState(state: State): void {
    try {
      native()
        .query(
          `INSERT INTO analytics_share (id, install_id, created_at) VALUES ('local', ?, ?)
           ON CONFLICT(id) DO UPDATE SET install_id = excluded.install_id`,
        )
        .run(state.installID, Date.now())
    } catch {
      // Reporting must never be something the user notices.
    }
  }

  /** The `analytics` block of the global config, or nothing if it is unreadable. */
  async function settings() {
    return runPromiseWithLayer(
      Config.defaultLayer,
      Effect.gen(function* () {
        const config = yield* Config.Service
        return (yield* config.getGlobal()).analytics
      }),
    ).catch(() => undefined)
  }

  /**
   * Sends every whole day since the last report, up to a week back. Returns the
   * number of rows accepted locally — zero when sharing is off, when there is
   * nothing new, or when the request failed.
   */
  /**
   * Whether reporting is on, given the config value.
   *
   * On unless told otherwise, with two escape hatches ahead of the config:
   * `DO_NOT_TRACK` is the cross-tool convention, and `NIKCLI_DISABLE_ANALYTICS`
   * is the nikcli-specific one. Both are read from the environment so a machine
   * or a CI image can opt out without a config file existing at all — which is
   * exactly the situation where a default-on feature would otherwise be hardest
   * to switch off.
   */
  export function enabled(share: boolean | undefined): boolean {
    if (optedOutByEnv()) return false
    return share !== false
  }

  function optedOutByEnv(): boolean {
    const truthy = (value: string | undefined) =>
      value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false"
    return truthy(process.env.DO_NOT_TRACK) || truthy(process.env.NIKCLI_DISABLE_ANALYTICS)
  }

  /** How often a long-lived server re-publishes while it stays up. */
  const REFRESH_MS = 6 * 60 * 60 * 1000

  let timer: ReturnType<typeof setInterval> | undefined

  /**
   * Start reporting in the background, and keep it going.
   *
   * A run at startup is what makes this automatic for the common case: most
   * nikcli processes are short-lived, and every start catches up whatever days
   * are still unpublished. The interval is for the ones that stay up for days,
   * which would otherwise report once and go quiet.
   *
   * `includeToday` is on: the day in progress is sent too, so a page reading this
   * is current rather than always a day behind. Resending it is free — the
   * collector keys on (install, day, provider, model), so each send replaces the
   * last, and tomorrow's run replaces the partial day with the complete one.
   */
  export function start(): void {
    const tick = () => void run({ includeToday: true }).catch(() => undefined)
    tick()
    if (timer) return
    timer = setInterval(tick, REFRESH_MS)
    // Never hold the process open on account of reporting.
    timer.unref?.()
  }

  /** Stop the background timer. Safe to call when it was never started. */
  export function stop(): void {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  export async function run(options?: {
    force?: boolean
    includeToday?: boolean
    /** Send every day on record, not just the catch-up window. */
    all?: boolean
    /** Explicit window in days, counting back from today. Overrides `all`. */
    days?: number
  }): Promise<number> {
    const analytics = await settings()
    // `force` is for an explicit `nikcli analytics publish`: the user asked for it
    // in that moment, which is the consent the default stands in for otherwise.
    if (!enabled(analytics?.share) && options?.force !== true) return 0

    const state = readState()
    // Yesterday is the newest whole day; today is still accumulating, so it is
    // only sent when asked for — a partial day would be replaced by the complete
    // one tomorrow, which the (install, day, model) key makes safe.
    const newest = options?.includeToday ? dayKey(Date.now()) : dayKey(Date.now() - DAY_MS)
    const window = dayKey(Date.now() - MAX_CATCHUP_DAYS * DAY_MS)
    const bounds = await AnalyticsRollup.bounds().catch(() => ({
      earliestDay: undefined,
      publishedPeriods: 1,
    }))

    // An explicit window wins — that is the caller naming a range. Otherwise the
    // first run reaches back to the first day on record, so an install in use for
    // months contributes that history rather than a week of it, and afterwards
    // the short catch-up window is enough: a backfill happens once, not on every
    // boot.
    const explicit = options?.days ? dayKey(Date.now() - (options.days - 1) * DAY_MS) : undefined
    const backfill = options?.all === true || bounds.publishedPeriods === 0
    const from = explicit ?? (backfill ? (bounds.earliestDay ?? window) : window)
    if (from > newest) return 0
    const yesterday = newest

    // Recompute before reading: the rollup for a day is derived from that day's
    // messages, so rebuilding is what makes a resumed session or a late message
    // land in the numbers that get sent.
    await AnalyticsRollup.rebuild({ from, to: yesterday }).catch(() => 0)

    // Which days still need sending is asked of the rollups, not tracked as a
    // high-water mark: a day that gained messages after it was first reported
    // becomes pending again, where "last day sent" would have kept the stale
    // numbers forever.
    const periods = await AnalyticsRollup.pending({ from, to: yesterday }).catch((): string[] => [])
    if (periods.length === 0) return 0

    const wanted = new Set(periods)
    const rollups = await AnalyticsRollup.read({ from, to: yesterday })
      .then((all) => all.filter((stat) => wanted.has(stat.periodKey)))
      .catch((): AnalyticsRollup.Row[] => [])

    const rows = rollups.map((stat) => ({
      day: stat.periodKey,
      // Provider and model are separate columns in the rollup, taken from the
      // message that produced them. They used to be recovered by splitting a
      // `provider/model` key, which produced "unknown" whenever the key was a
      // bare model id.
      provider: stat.provider,
      model: stat.model,
      messages: stat.messages,
      tokens: stat.totalTokens,
      cost: stat.costMicroCents / MICRO_CENTS_PER_USD,
      // Richer aggregates for collectors that understand them. Older ones ignore
      // unknown fields, so both can read the same report.
      sessions: stat.sessions,
      toolCalls: stat.toolCalls,
      inputTokens: stat.inputTokens,
      outputTokens: stat.outputTokens,
      reasoningTokens: stat.reasoningTokens,
      cacheReadTokens: stat.cacheReadTokens,
      cacheWriteTokens: stat.cacheWriteTokens,
      costMicroCents: stat.costMicroCents,
      durationMs: stat.durationMs,
    }))

    // A pending day with no rows ran nothing. Marking it published is what stops
    // the catch-up window re-reading it on every startup.
    if (rows.length === 0) {
      await AnalyticsRollup.markPublished(periods).catch(() => undefined)
      return 0
    }

    // Sent in batches the collector will accept whole. A year of history across a
    // dozen models is thousands of rows, and one oversized request would be
    // rejected outright rather than partially stored.
    const endpoint = analytics?.endpoint ?? DEFAULT_ENDPOINT
    const sent: string[] = []
    for (let offset = 0; offset < rows.length; offset += MAX_ROWS_PER_REPORT) {
      const batch = rows.slice(offset, offset + MAX_ROWS_PER_REPORT)
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ installID: state.installID, version: Installation.VERSION, rows: batch }),
        })
        if (!response.ok) {
          log.info("report rejected", { status: response.status, batch: batch.length })
          break
        }
      } catch (error) {
        log.info("report failed", { error: String(error) })
        break
      }
      sent.push(...batch.map((row) => row.day))
    }
    if (sent.length === 0) return 0

    // Only the days a batch actually carried are marked, and only after the
    // collector accepted them — a run that stopped halfway resumes where it
    // stopped rather than claiming the whole range.
    const delivered = periods.filter((period) => sent.includes(period))
    await AnalyticsRollup.markPublished(delivered).catch(() => undefined)
    log.info("reported", { days: delivered.length, rows: sent.length })
    return sent.length
  }
}
