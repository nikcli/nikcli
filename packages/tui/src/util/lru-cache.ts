/**
 * Dependency-free LRU + TTL key tracker.
 *
 * Implements the eviction primitive from `specs/effect-tui/05-reactive-state.md`.
 * It deliberately does NOT own the cached values — it tracks recency/expiry of keys and
 * reports which keys should be dropped, so the caller (the Solid sync store) stays the
 * single source of truth for the data itself. `createPromiseCache` below is the variant
 * that does own its values, for module-level memos with no store behind them.
 */

export type LruOptions = {
  /** Hard cap on tracked keys. Overflow evicts least-recently-used first. */
  maxEntries: number
  /** Optional time-to-live in ms; expired keys are reported by `evictExpired`. */
  ttlMs?: number
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number
}

export function createLru(options: LruOptions) {
  const { maxEntries, ttlMs } = options
  const now = options.now ?? Date.now
  // Map preserves insertion order; we re-insert on touch to keep MRU at the end.
  const lastSeen = new Map<string, number>()

  function touch(key: string): void {
    if (lastSeen.has(key)) lastSeen.delete(key)
    lastSeen.set(key, now())
  }

  function has(key: string): boolean {
    return lastSeen.has(key)
  }

  function forget(key: string): void {
    lastSeen.delete(key)
  }

  /** Remove and return keys whose TTL has elapsed. No-op when `ttlMs` is unset. */
  function evictExpired(): string[] {
    if (ttlMs === undefined) return []
    const cutoff = now() - ttlMs
    const expired: string[] = []
    for (const [key, seen] of lastSeen) {
      if (seen <= cutoff) expired.push(key)
    }
    for (const key of expired) lastSeen.delete(key)
    return expired
  }

  /**
   * Remove and return least-recently-used keys beyond `maxEntries`.
   * `pinned` keys are never evicted and are skipped when choosing victims.
   */
  function evictOverflow(pinned?: Iterable<string>): string[] {
    const pinnedSet = pinned ? new Set(pinned) : undefined
    const overflow = lastSeen.size - maxEntries
    if (overflow <= 0) return []
    const evictable = [...lastSeen.keys()].filter((k) => !pinnedSet?.has(k))
    const dropped = evictable.slice(0, Math.min(overflow, evictable.length))
    for (const key of dropped) lastSeen.delete(key)
    return dropped
  }

  function clear(): void {
    lastSeen.clear()
  }

  function keys(): string[] {
    return [...lastSeen.keys()]
  }

  return {
    touch,
    has,
    forget,
    evictExpired,
    evictOverflow,
    clear,
    keys,
    get size() {
      return lastSeen.size
    },
  }
}

export type Lru = ReturnType<typeof createLru>

export type PromiseCacheOptions = {
  /** Hard cap on cached keys. Overflow drops least-recently-used first. */
  maxEntries: number
}

/**
 * A bounded memo for async work keyed by string: decoded images, rendered previews.
 *
 * The unbounded `Map<string, Promise<T>>` it replaces grew for the life of the
 * process — the preview caches were keyed by terminal size, so every resize added
 * a full cell grid per image, and every shuffled wallpaper stayed decoded. Beyond
 * the bound it keeps the two rules those maps had, and fixes the one they broke:
 *
 * - One load per key: concurrent callers share it.
 * - A failed load is forgotten, so the next call retries instead of replaying
 *   the failure. A newer entry for the same key is never the one removed.
 * - The load is cancelled only once *every* caller has left. The maps handed the
 *   load the first caller's signal, so a row that scrolled away mid-load aborted
 *   it for the row that replaced it, which then showed the abort as an error.
 *   A caller that passes no signal never leaves.
 *
 * Evicting an in-flight load drops it from the cache, not from its callers: it
 * still settles for everyone already waiting on it.
 */
export function createPromiseCache<T>(options: PromiseCacheOptions) {
  type Entry = { promise: Promise<T>; controller: AbortController; waiters: number; settled: boolean }
  const entries = new Map<string, Entry>()
  const recency = createLru({ maxEntries: options.maxEntries })

  function drop(key: string, entry: Entry) {
    if (entries.get(key) !== entry) return
    entries.delete(key)
    recency.forget(key)
  }

  function start(key: string, run: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController()
    const entry: Entry = { controller, waiters: 0, settled: false, promise: undefined as unknown as Promise<T> }
    entry.promise = run(controller.signal).then(
      (value) => {
        entry.settled = true
        return value
      },
      (error: unknown) => {
        entry.settled = true
        drop(key, entry)
        throw error
      },
    )
    entries.set(key, entry)
    recency.touch(key)
    for (const evicted of recency.evictOverflow()) entries.delete(evicted)
    return entry
  }

  function join(key: string, entry: Entry, signal: AbortSignal | undefined) {
    entry.waiters++
    if (!signal) return
    const leave = () => {
      entry.waiters--
      if (entry.waiters > 0 || entry.settled) return
      drop(key, entry)
      entry.controller.abort(signal.reason)
    }
    if (signal.aborted) return leave()
    signal.addEventListener("abort", leave, { once: true })
    entry.promise.then(
      () => signal.removeEventListener("abort", leave),
      () => signal.removeEventListener("abort", leave),
    )
  }

  return {
    /**
     * The cached result for `key`, or the result of `run` shared with every
     * other caller for it. `signal` is this caller's interest, not the load's.
     */
    load(key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      const cached = entries.get(key)
      if (cached) recency.touch(key)
      const entry = cached ?? start(key, run)
      join(key, entry, signal)
      return entry.promise
    },
    clear(): void {
      entries.clear()
      recency.clear()
    },
    get size() {
      return entries.size
    },
  }
}

export type PromiseCache<T> = ReturnType<typeof createPromiseCache<T>>
