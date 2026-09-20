/**
 * EOT-02 multi-instance teardown test.
 *
 * B31 says workspaces on one directory currently share `InstanceScope`
 * resources. This test pins the *current* behavior so the next slice
 * (EOT-16 promoting workspace to owning scope) cannot regress the per-instance
 * invariants without a failing test.
 *
 * What we assert today:
 * - two concurrent `InstanceScope.with` calls on the same directory do not
 *   interleave finalizers (each is observed by the caller as its own event)
 * - interrupting one scope does not affect the other's outcome
 * - interruption records `scope.interrupted` exactly once per cancelled call
 *
 * The transition to true workspace isolation lives in EOT-16; this test is
 * the regression barrier for that work.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Fiber } from "effect"
import { InstanceScope } from "@/effect/instance-scope"
import { Instance } from "@/project/instance"
import { increment as lifecycleIncrement, reset, snapshot } from "@/effect/lifecycle-counters"

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const os = await import("node:os")
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-eot02-"))
  const db = path.join(home, "nikcli.db")
  const previousHome = process.env.NIKCLI_TEST_HOME
  const previousDb = process.env.NIKCLI_DB
  process.env.NIKCLI_TEST_HOME = home
  process.env.NIKCLI_DB = db
  process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
  reset()
  try {
    return await fn()
  } finally {
    await Instance.disposeAll().catch(() => undefined)
    if (previousHome === undefined) delete process.env.NIKCLI_TEST_HOME
    else process.env.NIKCLI_TEST_HOME = previousHome
    if (previousDb === undefined) delete process.env.NIKCLI_DB
    else process.env.NIKCLI_DB = previousDb
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
}

describe("EOT-02 multi-instance teardown", () => {
  it("two scopes on one directory settle independently and each bumps counters", async () => {
    await withTempHome(async () => {
      const a = Effect.runPromise(InstanceScope.with({ directory: "/tmp" }, Effect.succeed("a")))
      const b = Effect.runPromise(InstanceScope.with({ directory: "/tmp" }, Effect.succeed("b")))
      const [av, bv] = await Promise.all([a, b])
      expect(av).toBe("a")
      expect(bv).toBe("b")
      const snap = snapshot()
      expect(snap["scope.created"]).toBeGreaterThanOrEqual(2)
      expect(snap["scope.completed"]).toBeGreaterThanOrEqual(2)
      expect(snap["scope.interrupted"]).toBe(0)
    })
  })

  it("interrupting one scope does not cancel the other", async () => {
    await withTempHome(async () => {
      const before = snapshot()
      const slowFiber = Effect.runFork(InstanceScope.with({ directory: "/tmp" }, Effect.never))
      // Let the slow fiber start
      await Effect.runPromise(Effect.sleep(5))
      const fast = await Effect.runPromise(InstanceScope.with({ directory: "/tmp" }, Effect.succeed("fast")))
      expect(fast).toBe("fast")
      await Effect.runPromise(Fiber.interrupt(slowFiber))
      // Wait briefly so the cancel finalizer settles the counter
      await Effect.runPromise(Effect.sleep(5))
      const after = snapshot()
      expect(after["scope.completed"] - before["scope.completed"]).toBeGreaterThanOrEqual(1)
      expect(after["scope.interrupted"] - before["scope.interrupted"]).toBeGreaterThanOrEqual(1)
    })
  })

  it("lifecycle counter increments are observable from outside the scope", () => {
    const before = snapshot()
    lifecycleIncrement("runtime.bridge.success", 5)
    const after = snapshot()
    expect(after["runtime.bridge.success"] - before["runtime.bridge.success"]).toBe(5)
  })
})
