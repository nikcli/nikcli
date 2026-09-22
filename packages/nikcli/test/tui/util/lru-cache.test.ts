import { describe, expect, it } from "bun:test"
import { createLru, createPromiseCache } from "@tui/util/lru-cache"

describe("createLru", () => {
  it("evicts least-recently-used keys beyond maxEntries", () => {
    const lru = createLru({ maxEntries: 2 })
    lru.touch("a")
    lru.touch("b")
    lru.touch("a") // a is now MRU
    lru.touch("c") // overflow -> b (LRU) should be evicted
    const dropped = lru.evictOverflow()
    expect(dropped).toEqual(["b"])
    expect(lru.keys().sort()).toEqual(["a", "c"])
  })

  it("never evicts pinned keys", () => {
    const lru = createLru({ maxEntries: 1 })
    lru.touch("a")
    lru.touch("b")
    lru.touch("c")
    const dropped = lru.evictOverflow(["a"])
    expect(dropped).not.toContain("a")
    expect(lru.has("a")).toBe(true)
  })

  it("the most-recently-touched key is never evicted on overflow", () => {
    const lru = createLru({ maxEntries: 3 })
    for (const k of ["a", "b", "c", "d"]) lru.touch(k)
    lru.touch("active") // just opened -> MRU
    const dropped = lru.evictOverflow()
    expect(dropped).not.toContain("active")
    expect(lru.has("active")).toBe(true)
  })

  it("reports expired keys based on ttl with an injected clock", () => {
    let t = 1000
    const lru = createLru({ maxEntries: 10, ttlMs: 100, now: () => t })
    lru.touch("a")
    t = 1050
    lru.touch("b")
    t = 1150 // a is 150ms old (expired), b is 100ms old (== ttl, expired by <=)
    const expired = lru.evictExpired()
    expect(expired.sort()).toEqual(["a", "b"])
    expect(lru.size).toBe(0)
  })

  it("forget removes a key without eviction", () => {
    const lru = createLru({ maxEntries: 10 })
    lru.touch("a")
    lru.forget("a")
    expect(lru.has("a")).toBe(false)
  })
})

describe("createPromiseCache", () => {
  /** A load the test settles by hand, recording the signal it was given. */
  function deferred<T>() {
    const calls: Array<{ signal: AbortSignal; resolve: (value: T) => void; reject: (error: unknown) => void }> = []
    const load = (signal: AbortSignal) =>
      new Promise<T>((resolve, reject) => {
        calls.push({ signal, resolve, reject })
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    return { calls, load }
  }

  it("shares one load per key", async () => {
    const cache = createPromiseCache<string>({ maxEntries: 4 })
    const { calls, load } = deferred<string>()
    const a = cache.load("k", load)
    const b = cache.load("k", load)
    expect(calls.length).toBe(1)
    calls[0].resolve("v")
    expect(await a).toBe("v")
    expect(await b).toBe("v")
    expect(await cache.load("k", load)).toBe("v")
    expect(calls.length).toBe(1)
  })

  it("holds at most maxEntries, dropping the least recently used", async () => {
    const cache = createPromiseCache<string>({ maxEntries: 2 })
    let loads = 0
    const load = async () => `v${++loads}`
    await cache.load("a", load)
    await cache.load("b", load)
    await cache.load("a", load) // a is now most recent
    await cache.load("c", load) // evicts b
    expect(cache.size).toBe(2)
    expect(loads).toBe(3)
    await cache.load("a", load)
    expect(loads).toBe(3)
    await cache.load("b", load)
    expect(loads).toBe(4)
  })

  it("forgets a failed load so the next call retries", async () => {
    const cache = createPromiseCache<string>({ maxEntries: 4 })
    let fail = true
    const load = async () => {
      if (fail) throw new Error("boom")
      return "ok"
    }
    await expect(cache.load("k", load)).rejects.toThrow("boom")
    expect(cache.size).toBe(0)
    fail = false
    expect(await cache.load("k", load)).toBe("ok")
  })

  it("one caller leaving does not abort the load another caller still waits on", async () => {
    const cache = createPromiseCache<string>({ maxEntries: 4 })
    const { calls, load } = deferred<string>()
    const first = new AbortController()
    const second = new AbortController()
    void cache.load("k", load, first.signal).catch(() => undefined)
    const waiting = cache.load("k", load, second.signal)
    first.abort()
    expect(calls[0].signal.aborted).toBe(false)
    calls[0].resolve("v")
    expect(await waiting).toBe("v")
  })

  it("aborts the load once every caller has left, and does not cache it", async () => {
    const cache = createPromiseCache<string>({ maxEntries: 4 })
    const { calls, load } = deferred<string>()
    const first = new AbortController()
    const second = new AbortController()
    const a = cache.load("k", load, first.signal)
    const b = cache.load("k", load, second.signal)
    first.abort()
    second.abort()
    expect(calls[0].signal.aborted).toBe(true)
    await expect(a).rejects.toBeDefined()
    await expect(b).rejects.toBeDefined()
    expect(cache.size).toBe(0)
    // A caller arriving afterwards starts a fresh load instead of inheriting the abort.
    const fresh = cache.load("k", load)
    expect(calls.length).toBe(2)
    calls[1].resolve("v")
    expect(await fresh).toBe("v")
  })

  it("a caller without a signal keeps the load alive", async () => {
    const cache = createPromiseCache<string>({ maxEntries: 4 })
    const { calls, load } = deferred<string>()
    const leaving = new AbortController()
    void cache.load("k", load, leaving.signal).catch(() => undefined)
    const staying = cache.load("k", load)
    leaving.abort()
    expect(calls[0].signal.aborted).toBe(false)
    calls[0].resolve("v")
    expect(await staying).toBe("v")
  })

  it("an evicted in-flight load still settles for its callers, and its failure spares the newer entry", async () => {
    const cache = createPromiseCache<string>({ maxEntries: 1 })
    const { calls, load } = deferred<string>()
    const old = cache.load("a", load)
    await cache.load("b", async () => "b") // evicts in-flight a
    const newer = cache.load("a", load) // a fresh load for a
    expect(calls.length).toBe(2)
    calls[0].reject(new Error("old failed"))
    await expect(old).rejects.toThrow("old failed")
    calls[1].resolve("new")
    expect(await newer).toBe("new")
    expect(await cache.load("a", load)).toBe("new")
    expect(calls.length).toBe(2)
  })
})
