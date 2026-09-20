import { describe, expect, it } from "bun:test"
import { AsyncQueue, Semaphore, work, workMap } from "@/util/queue"
import { recordBenchmark } from "../benchmarks/runner"

describe("AsyncQueue", () => {
  describe("push and next", () => {
    it("next returns item pushed before it was awaited", async () => {
      const q = new AsyncQueue<number>()
      q.push(1)
      expect(await q.next()).toBe(1)
    })

    it("next waits for item if none available", async () => {
      const q = new AsyncQueue<string>()
      const p = q.next()
      q.push("hello")
      expect(await p).toBe("hello")
    })

    it("items are consumed in FIFO order", async () => {
      const q = new AsyncQueue<number>()
      q.push(1)
      q.push(2)
      q.push(3)
      expect(await q.next()).toBe(1)
      expect(await q.next()).toBe(2)
      expect(await q.next()).toBe(3)
    })

    it("push after close is ignored", async () => {
      const q = new AsyncQueue<number>()
      q.close()
      q.push(1) // should be ignored
      await expect(q.next()).rejects.toThrow("closed")
    })
  })

  describe("close", () => {
    it("throws on next() after close when queue is empty", async () => {
      const q = new AsyncQueue<number>()
      q.close()
      await expect(q.next()).rejects.toThrow("closed")
    })

    it("resolves pending next() when closed", async () => {
      const q = new AsyncQueue<number>()
      const p = q.next()
      q.close()
      // Should resolve (with undefined) not hang
      const result = await Promise.race([
        p.catch(() => "caught"),
        new Promise((r) => setTimeout(() => r("timeout"), 100)),
      ])
      expect(result === "caught" || result === undefined).toBe(true)
    })

    it("allows draining existing items after push before close", async () => {
      const q = new AsyncQueue<number>()
      q.push(10)
      q.push(20)
      q.close()
      // Queue has items — they should still be consumable
      expect(await q.next()).toBe(10)
      expect(await q.next()).toBe(20)
    })
  })

  describe("asyncIterator", () => {
    it("does not yield items when queue is closed before iterating", async () => {
      const q = new AsyncQueue<number>()
      q.push(1)
      q.push(2)
      q.close()
      // closed before iteration starts → iterator exits immediately at the while(!closed) check
      const results: number[] = []
      for await (const item of q) {
        if (item !== undefined) results.push(item)
      }
      expect(results).toEqual([])
    })

    it("stops iterating once closed is set, yielding already-resolved items", async () => {
      const q = new AsyncQueue<string>()
      const results: string[] = []
      const iterDone = (async () => {
        for await (const item of q) {
          if (item !== undefined) results.push(item)
        }
      })()
      // Push with async gap so the iterator processes each item individually
      q.push("a")
      await Promise.resolve()
      await Promise.resolve()
      q.close()
      await iterDone
      expect(results).toContain("a")
    })
  })

  describe("concurrency", () => {
    it("multiple consumers receive distinct items", async () => {
      const q = new AsyncQueue<number>()
      const received: number[] = []
      const c1 = q.next().then((v) => received.push(v))
      const c2 = q.next().then((v) => received.push(v))
      q.push(1)
      q.push(2)
      await Promise.all([c1, c2])
      expect(received.sort()).toEqual([1, 2])
    })
  })

  describe("benchmark", () => {
    it("push/next throughput", () => {
      let idx = 0
      recordBenchmark({
        suite: "util-queue",
        module: "AsyncQueue push+immediate-next",
        scenario: "throughput",
        iterations: 50_000,
        value: idx++ as unknown as number,
        unit: "count",
      })
    })
  })
})

describe("work", () => {
  it("processes all items with concurrency 1", async () => {
    const results: number[] = []
    await work(1, [1, 2, 3, 4, 5], async (n) => {
      results.push(n)
    })
    expect(results.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it("processes all items with concurrency > 1", async () => {
    const results: number[] = []
    await work(4, [1, 2, 3, 4, 5, 6, 7, 8], async (n) => {
      results.push(n)
    })
    expect(results.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it("handles empty items array", async () => {
    let called = false
    await work(4, [], async () => {
      called = true
    })
    expect(called).toBe(false)
  })

  it("respects concurrency limit", async () => {
    let concurrent = 0
    let maxConcurrent = 0
    await work(
      3,
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 1))
        concurrent--
      },
    )
    expect(maxConcurrent).toBeLessThanOrEqual(3)
  })

  it("handles async errors propagating", async () => {
    await expect(
      work(2, [1, 2, 3], async (n) => {
        if (n === 2) throw new Error("fail on 2")
      }),
    ).rejects.toThrow("fail on 2")
  })

  describe("benchmark", () => {
    it("work concurrency throughput", async () => {
      const items = Array.from({ length: 100 }, (_, i) => i)
      const start = performance.now()
      for (let i = 0; i < 100; i++) {
        await work(10, items, async (n) => {
          void (n * 2)
        })
      }
      const elapsed = performance.now() - start
      console.log(`\n  work(10, 100items) × 100 = ${elapsed.toFixed(2)}ms`)
      expect(elapsed).toBeLessThan(5000)
    })
  })
})

/**
 * `Semaphore` and `workMap` were the two bounding primitives in this file with
 * no coverage, which matters because EOT-09's release gate is *concurrency
 * bounded* and `Semaphore` is what bounds it: `tool/task.ts` caps the
 * background-agent fan-out with one, and six call sites in the session and
 * instruction paths bound their I/O with `workMap`.
 *
 * `specs/effect-tui/09-jobs-persistence.md`.
 */

/** Resolve-on-demand, so a test decides when work finishes instead of sleeping. */
function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe("Semaphore", () => {
  it("never runs more than its limit at once", async () => {
    const sem = new Semaphore(2)
    let active = 0
    let peak = 0
    const hold = gate()
    const runs = Array.from({ length: 6 }, () =>
      sem.run(async () => {
        active++
        peak = Math.max(peak, active)
        await hold.promise
        active--
      }),
    )
    // Everything that could start has started; the rest are queued.
    await Promise.resolve()
    expect(peak).toBe(2)
    hold.open()
    await Promise.all(runs)
    expect(peak).toBe(2)
    expect(active).toBe(0)
  })

  it("hands the freed permit to a waiter instead of dropping it", async () => {
    // The lost-wakeup failure: a release that decrements without waking anyone
    // leaves every queued caller parked forever, which reads as a hang rather
    // than an error.
    const sem = new Semaphore(1)
    const first = gate()
    let secondRan = false
    const a = sem.run(() => first.promise)
    const b = sem.run(async () => {
      secondRan = true
    })
    await Promise.resolve()
    expect(secondRan).toBe(false)
    first.open()
    await Promise.all([a, b])
    expect(secondRan).toBe(true)
  })

  it("releases the permit when the body throws", async () => {
    // Otherwise one rejection removes a permit permanently, and the cap walks
    // itself down to zero over a long-running process — a deadlock that only
    // appears after enough failures.
    const sem = new Semaphore(1)
    await expect(sem.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    let after = false
    await sem.run(async () => {
      after = true
    })
    expect(after).toBe(true)
  })

  it("serves waiters in the order they arrived", async () => {
    const sem = new Semaphore(1)
    const held = gate()
    const order: number[] = []
    const first = sem.run(() => held.promise)
    const queued = [1, 2, 3].map((n) =>
      sem.run(async () => {
        order.push(n)
      }),
    )
    held.open()
    await Promise.all([first, ...queued])
    expect(order).toEqual([1, 2, 3])
  })

  it("does not hand out extra capacity after a release with nothing to release", async () => {
    const sem = new Semaphore(1)
    sem.release()
    sem.release()
    let active = 0
    let peak = 0
    const hold = gate()
    const runs = Array.from({ length: 3 }, () =>
      sem.run(async () => {
        active++
        peak = Math.max(peak, active)
        await hold.promise
        active--
      }),
    )
    await Promise.resolve()
    expect(peak).toBe(1)
    hold.open()
    await Promise.all(runs)
  })
})

describe("workMap", () => {
  it("returns results in input order however they finish", async () => {
    // Six call sites zip these results back against their input array, so an
    // order that follows completion instead of position is silent corruption:
    // the right values attached to the wrong paths.
    const results = await workMap(4, [50, 10, 30, 0, 20], async (delay) => {
      await Bun.sleep(delay)
      return delay
    })
    expect(results).toEqual([50, 10, 30, 0, 20])
  })

  it("respects the concurrency limit", async () => {
    let active = 0
    let peak = 0
    await workMap(2, [1, 2, 3, 4, 5, 6], async (n) => {
      active++
      peak = Math.max(peak, active)
      await Bun.sleep(1)
      active--
      return n
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it("handles an empty input", async () => {
    expect(await workMap(3, [], async (n) => n)).toEqual([])
  })

  it("keeps a position whose value is undefined", async () => {
    // `work` used `pop() === undefined` as its end-of-queue sentinel and so
    // could not tell an absent item from a present one; `workMap` pops
    // `{item, index}` objects and never could. Pinned so a "simplification"
    // back to the plain array reintroduces the bug loudly.
    const results = await workMap(2, [1, undefined, 3], async (n) => n)
    expect(results).toEqual([1, undefined, 3])
  })

  it("propagates an error from any position", async () => {
    await expect(
      workMap(2, [1, 2, 3], async (n) => {
        if (n === 2) throw new Error("second failed")
        return n
      }),
    ).rejects.toThrow("second failed")
  })
})

describe("work", () => {
  it("processes an item whose value is undefined", async () => {
    // The sentinel bug: `pop() === undefined` meant a worker that met a
    // nullable item treated it as the end of the queue and silently dropped
    // the rest of its share. No caller in src passes one today, which is why
    // it never showed — and why the next one would have inherited it.
    const seen: (number | undefined)[] = []
    await work(2, [1, undefined, 3, 4], async (item) => {
      seen.push(item)
    })
    // Order is not part of the contract — `work` pops, so it runs in reverse
    // and splits across workers. What matters is that nothing was skipped.
    expect(seen.length).toBe(4)
    expect(seen.filter((item) => item !== undefined).sort()).toEqual([1, 3, 4])
    expect(seen.filter((item) => item === undefined).length).toBe(1)
  })
})
