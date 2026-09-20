import { describe, expect, it } from "bun:test"
import { barrier, deferred, withTimeout, waitFor } from "./barrier"
import { withFixture } from "./fixture"

describe("barrier timing invariants (EOT-20)", () => {
  it("barrier opens exactly when count arrivals happen, not before", async () => {
    const g = barrier(3)
    expect(g.pending).toBe(3)
    g.arrive()
    expect(g.pending).toBe(2)
    let opened = false
    const waitPromise = g.wait({ timeoutMs: 1000 }).then(() => {
      opened = true
    })
    await Promise.resolve()
    expect(opened).toBe(false)
    g.arrive()
    g.arrive()
    await waitPromise
    expect(opened).toBe(true)
    expect(g.pending).toBe(0)
  })

  it("deferred resolves with the value passed in", async () => {
    const d = deferred<number>()
    d.resolve(42)
    expect(await d.promise).toBe(42)
  })

  it("withTimeout rejects with the label and the timeout duration when the promise hangs", async () => {
    const stuck = new Promise(() => {})
    let caught: Error | undefined
    try {
      await withTimeout(stuck, 25, "stuck-promise")
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toContain("stuck-promise")
    expect(caught?.message).toContain("25ms")
  })

  it("waitFor returns as soon as the condition holds, not at the interval boundary", async () => {
    let satisfied = false
    const start = Date.now()
    setTimeout(() => {
      satisfied = true
    }, 30)
    await waitFor(() => satisfied, {
      timeoutMs: 1000,
      intervalMs: 100,
      label: "later",
    })
    const elapsed = Date.now() - start
    expect(satisfied).toBe(true)
    // Must return at or shortly after the 30ms mark; not wait the 100ms interval.
    expect(elapsed).toBeLessThan(150)
  })
})

describe("withFixture (EOT-20)", () => {
  it("runs the body in an isolated home and returns its value", async () => {
    const seen: string[] = []
    const result = await withFixture(async (ctx) => {
      seen.push(ctx.home)
      return "value"
    })
    expect(result).toBe("value")
    expect(seen[0]).toBeTruthy()
  })

  it("gives each case a different home", async () => {
    const first = await withFixture(async (ctx) => ctx.home)
    const second = await withFixture(async (ctx) => ctx.home)
    expect(first).not.toBe(second)
  })

  it("runs seeds before the body, in the same context", async () => {
    const order: string[] = []
    const home = await withFixture(
      {
        seeds: {
          one: (ctx) => {
            order.push(`one:${typeof ctx.home}`)
          },
          two: async () => {
            order.push("two")
          },
        },
      },
      async (ctx) => {
        order.push("body")
        return ctx.home
      },
    )
    expect(order).toEqual(["one:string", "two", "body"])
    expect(home).toBeTruthy()
  })

  it("fails the case when declared barrier arrivals are left pending", async () => {
    // The point of declaring a count: a body that waits on fewer things than
    // it said it would has a barrier that opened for the wrong reason, and
    // that is a passing test hiding a race.
    let caught: Error | undefined
    try {
      await withFixture({ barrier: 2 }, async (ctx) => {
        ctx.barrier.arrive()
      })
    } catch (e) {
      caught = e as Error
    }
    expect(caught?.message).toContain("left 1 of 2 arrivals pending")
  })

  it("passes when every declared arrival is signalled", async () => {
    const value = await withFixture({ barrier: 2 }, async (ctx) => {
      ctx.barrier.arrive()
      ctx.barrier.arrive()
      await ctx.barrier.wait({ timeoutMs: 1000 })
      return "done"
    })
    expect(value).toBe("done")
  })

  it("lets the body's own failure through rather than replacing it", async () => {
    // A barrier complaint raised over a body that already threw would bury
    // the actual failure under a bookkeeping message.
    let caught: Error | undefined
    try {
      await withFixture({ barrier: 3 }, async () => {
        throw new Error("the real failure")
      })
    } catch (e) {
      caught = e as Error
    }
    expect(caught?.message).toBe("the real failure")
  })

  it("does not hold a case to a barrier it never declared", async () => {
    const value = await withFixture(async () => "no barrier declared")
    expect(value).toBe("no barrier declared")
  })

  it("ctx.await rejects with the label when a promise hangs", async () => {
    let caught: Error | undefined
    await withFixture(async (ctx) => {
      try {
        await ctx.await(withTimeout(new Promise(() => {}), 20, "inner"), "outer")
      } catch (e) {
        caught = e as Error
      }
    })
    expect(caught?.message).toContain("inner")
  })
})
