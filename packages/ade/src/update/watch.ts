/**
 * Asks GitHub for new ADE releases, and says so once per version.
 *
 * The first check waits a little after launch, so start-up is not paying for
 * a network round trip; after that it repeats often enough that a release
 * published while the window is open is noticed in minutes rather than in
 * half an hour. Failures are silent unless someone asked: being offline is
 * not something the bell should report by itself.
 *
 * Three things decide when a check happens, and all three exist because the
 * releases people wait for arrive while they are doing something else:
 *
 *   - the timer, `CHECK_EVERY_MS`, for a window left open;
 *   - the window coming back to the front, which is when someone is looking;
 *   - the machine waking up, noticed as a jump in the clock, because timers
 *     do not fire while it sleeps and the release may be hours old by then.
 *
 * A hidden window never checks. Nobody is reading it, and a dozen windows
 * polling in the background is exactly how an IP runs out of GitHub's sixty
 * unauthenticated calls an hour.
 *
 * What keeps ADE inside that budget:
 *
 *   - `MIN_CHECK_GAP_MS` between two calls, whatever asked for them;
 *   - `MAX_CALLS_PER_HOUR`, counted over a moving hour, below sixty on
 *     purpose: the same IP may have another ADE window, or a git tool;
 *   - `If-None-Match`. GitHub answers an unchanged list with `304` and does
 *     not charge it to the limit, so a window that checks every three minutes
 *     and sees no new release spends almost nothing.
 */
import { newerRelease, parseVersion, RELEASE_REPO, type AvailableUpdate, type GithubRelease } from "./release"
import { t } from "../i18n"

/** After launch, once the window has drawn. */
export const FIRST_CHECK_MS = 15_000

/**
 * Between two timed checks.
 *
 * Three minutes: the user asked to hear about a release "as soon as it is
 * out", and thirty minutes was that wait. With `If-None-Match` the usual
 * answer is a `304`, which costs nothing.
 */
export const CHECK_EVERY_MS = 3 * 60_000

/** No two calls closer than this, however many things ask at once. */
export const MIN_CHECK_GAP_MS = 60_000

/**
 * Calls in any one hour, counting only the ones GitHub charges for.
 *
 * The unauthenticated limit is sixty per hour per IP, shared with everything
 * else on the machine that talks to the API.
 */
export const MAX_CALLS_PER_HOUR = 40

/** How much later than expected a timer has to fire to mean the machine slept. */
export const WAKE_GAP_MS = 2 * 60_000

/** How often the clock is looked at to notice a sleep. */
export const WAKE_POLL_MS = 30_000

/**
 * After a refused request, how long before trying again, when the answer
 * itself does not say. Doubles per consecutive failure up to the last.
 *
 * The hourly budget below counts *this process*: another ADE window, or a git
 * tool, spends from the same per-IP allowance without telling anyone. What
 * actually protects the limit is therefore not the counter but this: when
 * GitHub says no, ADE waits as long as it was told to, or longer each time.
 */
export const ERROR_BACKOFF_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000, 60 * 60_000] as const

/** What a check found, for whoever asked for it. */
export type CheckStatus =
  /** A release newer than this build. */
  | "update"
  /** This build is the newest release. */
  | "current"
  /** A dev build (`0.0.0`): there is no installed version to be behind. */
  | "dev"
  /** Not asked: too soon, out of budget, waiting after a refusal, or hidden. */
  | "skipped"
  /** The request failed. */
  | "error"

export interface CheckResult {
  readonly status: CheckStatus
  readonly at: number
  /** Present when `status` is `update`. */
  readonly update?: AvailableUpdate
  /** The running build's version, when it was read. */
  readonly currentVersion?: string
  /** Why it was skipped, or what failed; a sentence for a person. */
  readonly problem?: string
  /** True when GitHub said nothing changed and this is the last answer again. */
  readonly cached?: boolean
}

/** One look at the releases, or `notModified` when GitHub says nothing changed. */
export interface ReleaseFeedResult {
  readonly releases?: readonly GithubRelease[]
  readonly notModified: boolean
  /** The tag this answer carried, to be stored with the verdict drawn from it. */
  readonly etag?: string
}

export interface ReleaseFeed {
  read(): Promise<ReleaseFeedResult>
}

/**
 * A refused or failed request, with when GitHub said to come back.
 *
 * `retryAt` comes from the answer itself — `Retry-After` on a secondary rate
 * limit, `x-ratelimit-reset` when the hourly one is spent — so ADE waits
 * exactly as long as it was told instead of asking again in three minutes and
 * being refused again.
 */
export class ReleaseFeedError extends Error {
  readonly retryAt?: number
  constructor(message: string, retryAt?: number) {
    super(message)
    this.name = "ReleaseFeedError"
    if (retryAt !== undefined) this.retryAt = retryAt
  }
}

/**
 * What is kept between runs: the tag, and the verdict that tag stands for.
 *
 * The two only make sense together. A tag stored alone is a promise that the
 * next answer may be a bare `304`, and a `304` carries no releases: ADE would
 * come back from a restart holding a token that means "nothing changed since
 * the answer you no longer have", and would tell the user they are up to date
 * while the release it announced yesterday sits unread. Whoever writes one
 * writes both.
 */
export interface UpdateMemory {
  readonly etag?: string
  /** The release found the last time a list was read; absent when there was none. */
  readonly update?: AvailableUpdate
}

export interface UpdateMemoryStore {
  read(): UpdateMemory | undefined
  write(memory: UpdateMemory): void
}

export interface UpdateWatchOptions {
  /** The running build's version; `0.0.0` for dev builds. */
  readonly currentVersion: () => Promise<string>
  readonly onUpdate: (update: AvailableUpdate) => void
  readonly feed?: ReleaseFeed
  /** Whether the window is on screen. A hidden one is never checked. */
  readonly isVisible?: () => boolean
  readonly now?: () => number
  /** Subscribes to "the window came back"; returns the unsubscribe. */
  readonly onForeground?: (run: () => void) => () => void
  /**
   * Where the tag and its verdict are kept between runs.
   *
   * Absent: every launch reads the whole list once, which is correct and
   * costs one call.
   */
  readonly memory?: UpdateMemoryStore
}

/**
 * GitHub's release list, asked for with the tag it last answered with.
 *
 * The whole list rather than `releases/latest`: this repository carries
 * nikcli's releases and other products' too, and `latest` is whichever was
 * published last, which is usually not ADE's. The filtering is in
 * `newerRelease`, so the list has to be the one that contains `ade-v*`.
 */
export function githubReleaseFeed(doFetch: typeof fetch = fetch, initialEtag?: string): ReleaseFeed {
  // Given by the caller, which is also what stores it alongside the verdict:
  // see `UpdateMemory`.
  let etag: string | undefined = initialEtag
  return {
    async read(): Promise<ReleaseFeedResult> {
      const response = await doFetch(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`, {
        headers: {
          Accept: "application/vnd.github+json",
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      })
      // Not charged to the rate limit, which is what makes a short interval affordable.
      if (response.status === 304) return { notModified: true }
      if (!response.ok) throw new ReleaseFeedError(`GitHub ${response.status}`, retryAfter(response, Date.now()))
      const tag = response.headers.get("etag")
      if (tag) etag = tag
      return {
        releases: (await response.json()) as GithubRelease[],
        notModified: false,
        ...(tag ? { etag: tag } : {}),
      }
    },
  }
}

/**
 * When a refused answer says to come back, as a moment in time.
 *
 * `Retry-After` is either seconds or a date; `x-ratelimit-reset` is the
 * epoch second the hourly allowance refills, and only counts when the
 * allowance really is spent — the header rides along on every answer.
 */
export function retryAfter(response: { headers: Headers; status: number }, at: number): number | undefined {
  const after = response.headers.get("retry-after")
  if (after) {
    const seconds = Number(after)
    if (Number.isFinite(seconds)) return at + Math.max(0, seconds) * 1000
    const date = Date.parse(after)
    if (!Number.isNaN(date)) return date
  }
  const remaining = response.headers.get("x-ratelimit-remaining")
  const reset = Number(response.headers.get("x-ratelimit-reset"))
  if (remaining === "0" && Number.isFinite(reset) && reset > 0) return reset * 1000
  return undefined
}

/** Kept for callers that only want the list. */
export async function fetchReleases(): Promise<readonly GithubRelease[]> {
  const { releases } = await githubReleaseFeed().read()
  return releases ?? []
}

export interface UpdateWatch {
  /** Starts the timers and the listeners; call once. */
  start(): void
  stop(): void
  /**
   * Checks now, for someone who asked.
   *
   * `force` skips the wait between calls — a person pressing "Controlla
   * aggiornamenti" is not a background poll — but never the hourly budget,
   * which is the one that protects the limit.
   */
  check(options?: { force?: boolean }): Promise<CheckResult>
}

/**
 * A remembered update as a release row again.
 *
 * Only the two fields `newerRelease` reads are kept, because they are the only
 * two a notice needs; the row is rebuilt around them so the comparison after a
 * `304` is the same code as the one after a list.
 */
function releaseRow(update: AvailableUpdate): GithubRelease {
  return { tag_name: `ade-v${update.version}`, html_url: update.url, draft: false, prerelease: false }
}

/** A build with no released version behind it: `tauri dev` and anything unreleased. */
function devBuild(version: string): boolean {
  const parsed = parseVersion(version)
  return !parsed || (parsed[0] === 0 && parsed[1] === 0 && parsed[2] === 0)
}

/** The newest release newer than `current`, with the row it came from. */
function pickUpdate(
  current: string,
  releases: readonly GithubRelease[],
): { update: AvailableUpdate; release: GithubRelease } | undefined {
  const update = newerRelease(current, releases)
  if (!update) return undefined
  const release = releases.find((candidate) => candidate.html_url === update.url)
  return release ? { update, release } : undefined
}

export function createUpdateWatch(options: UpdateWatchOptions): UpdateWatch {
  const now = options.now ?? Date.now
  const remembered = options.memory?.read()
  const feed = options.feed ?? githubReleaseFeed(fetch, remembered?.etag)
  const visible = options.isVisible ?? (() => true)
  const announced = new Set<string>()
  /** When each charged call was made, over the last hour. */
  const charged: number[] = []
  let lastCallAt: number | undefined
  /**
   * The newest release seen, with the row it came from.
   *
   * Kept because a `304` carries no list: without it the answer to "is there
   * an update?" would be "no" for as long as GitHub keeps saying "unchanged".
   */
  let lastUpdate: { update: AvailableUpdate; release: GithubRelease } | undefined = remembered?.update
    ? { update: remembered.update, release: releaseRow(remembered.update) }
    : undefined
  let etag = remembered?.etag
  /** Set when a request was refused; nothing is asked before it. */
  let waitUntil: number | undefined
  /** Consecutive failures, for the wait that grows. */
  let failures = 0
  let timers: ReturnType<typeof setTimeout>[] = []
  let unsubscribe: (() => void) | undefined
  let lastTick = now()

  const budgetLeft = (at: number): boolean => {
    while (charged.length > 0 && at - charged[0]! >= 60 * 60_000) charged.shift()
    return charged.length < MAX_CALLS_PER_HOUR
  }

  /** Says it once per run, whether it was read from GitHub or from the last one. */
  const announce = (update: AvailableUpdate): AvailableUpdate => {
    if (!announced.has(update.version)) {
      announced.add(update.version)
      options.onUpdate(update)
    }
    return update
  }

  /** The tag and the verdict, stored as one so neither can outlive the other. */
  const remember = (update: AvailableUpdate | undefined) => {
    options.memory?.write({ ...(etag ? { etag } : {}), ...(update ? { update } : {}) })
  }

  const check = async (opts: { force?: boolean } = {}): Promise<CheckResult> => {
    const at = now()
    if (!opts.force && !visible()) {
      return { status: "skipped", at, problem: t("update.skip.hidden") }
    }
    if (!opts.force && lastCallAt !== undefined && at - lastCallAt < MIN_CHECK_GAP_MS) {
      return { status: "skipped", at, problem: t("update.skip.recent") }
    }
    if (!budgetLeft(at)) {
      return { status: "skipped", at, problem: t("update.skip.budget") }
    }
    /*
     * GitHub said to come back later, and asking sooner earns another refusal.
     * Not even a person pressing the command gets through: the answer would be
     * the refusal, and the wait would start again from here.
     */
    if (waitUntil !== undefined && at < waitUntil) {
      return { status: "skipped", at, problem: "GitHub ha chiesto di aspettare: riprovo più tardi." }
    }
    lastCallAt = at
    try {
      const [currentVersion, result] = await Promise.all([options.currentVersion(), feed.read()])
      waitUntil = undefined
      failures = 0
      /*
       * Nothing changed since the last look, so the last verdict still holds.
       * Recomputing it from an empty list would say "you are on the newest
       * one" to someone who was told about a release a minute ago — which is
       * exactly what the command is pressed to confirm.
       */
      if (result.notModified) {
        if (lastUpdate && newerRelease(currentVersion, [lastUpdate.release])) {
          /*
           * A release remembered from a previous run has never been announced
           * in this window: the bell starts each launch empty, and this is the
           * only chance to say it, since the list will keep answering `304`
           * until somebody publishes something else.
           */
          return { status: "update", at, currentVersion, update: announce(lastUpdate.update), cached: true }
        }
        return { status: devBuild(currentVersion) ? "dev" : "current", at, currentVersion, cached: true }
      }
      charged.push(at)
      if (result.etag) etag = result.etag
      if (devBuild(currentVersion)) {
        lastUpdate = undefined
        remember(undefined)
        return { status: "dev", at, currentVersion }
      }
      const found = pickUpdate(currentVersion, result.releases ?? [])
      lastUpdate = found
      // The verdict and the tag that stands for it, written together.
      remember(found?.update)
      if (!found) return { status: "current", at, currentVersion }
      return { status: "update", at, currentVersion, update: announce(found.update) }
    } catch (error) {
      // A charged call all the same: GitHub counted the request that failed.
      charged.push(at)
      const told = error instanceof ReleaseFeedError ? error.retryAt : undefined
      waitUntil = told ?? at + (ERROR_BACKOFF_MS[Math.min(failures, ERROR_BACKOFF_MS.length - 1)] ?? 0)
      failures++
      return { status: "error", at, problem: error instanceof Error ? error.message : String(error) }
    }
  }

  const background = () => void check().catch(() => {})

  return {
    start() {
      timers.push(setTimeout(background, FIRST_CHECK_MS))
      timers.push(setInterval(background, CHECK_EVERY_MS) as unknown as ReturnType<typeof setTimeout>)
      /*
       * A sleeping machine fires no timers: on waking, the interval would
       * wait its full turn before looking, and the release published in the
       * meantime would arrive minutes late. A clock that jumped further than
       * this poll could account for is that wake.
       */
      lastTick = now()
      timers.push(
        setInterval(() => {
          const at = now()
          const slept = at - lastTick > WAKE_POLL_MS + WAKE_GAP_MS
          lastTick = at
          if (slept) background()
        }, WAKE_POLL_MS) as unknown as ReturnType<typeof setTimeout>,
      )
      unsubscribe = options.onForeground?.(background)
    },
    stop() {
      for (const timer of timers) {
        clearTimeout(timer)
        clearInterval(timer as unknown as ReturnType<typeof setInterval>)
      }
      timers = []
      unsubscribe?.()
      unsubscribe = undefined
    },
    check,
  }
}

/**
 * What the bell says about a check somebody asked for.
 *
 * Every outcome gets a line, "nothing new" included: a command that answers
 * only when there is an update leaves the user pressing it again to find out
 * whether it did anything.
 */
export function checkMessage(result: CheckResult): { kind: "info" | "error"; text: string; href?: string } {
  switch (result.status) {
    case "update":
      return {
        kind: "info",
        text: t("update.available", result.update?.version ?? ""),
        ...(result.update ? { href: result.update.url } : {}),
      }
    case "current":
      return {
        kind: "info",
        text: result.currentVersion ? t("update.current", result.currentVersion) : t("update.none"),
      }
    case "dev":
      return {
        kind: "info",
        text: t("update.dev"),
      }
    case "skipped":
      return { kind: "info", text: result.problem ?? t("update.skip.other") }
    case "error":
      return { kind: "error", text: t("update.failed", result.problem ?? "") }
  }
}

/** Starts watching; the returned function stops it. */
export function startUpdateWatch(options: UpdateWatchOptions): () => void {
  const watch = createUpdateWatch(options)
  watch.start()
  return () => watch.stop()
}
