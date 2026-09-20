import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { increment, LIFECYCLE_KEYS, reset, snapshot } from "@/effect/lifecycle-counters"
import { InstanceScope } from "@/effect/instance-scope"
import { runPromiseWithLayer } from "@/effect/runtime"

// The counters are module-level state, and `bun test` shares one module
// registry across every file in a run — any earlier file that crossed the
// runtime bridge has already moved them. Reset on both sides of each test so
// this file reads its own writes whether it runs alone or in the suite.
beforeEach(() => reset())
afterEach(() => reset())

describe("lifecycle-counters", () => {
  it("snapshot reads zero for every key after a reset", () => {
    const snap = snapshot()
    for (const key of LIFECYCLE_KEYS) {
      expect(snap[key]).toBe(0)
    }
  })

  it("increment is additive and survives snapshot copies", () => {
    increment("scope.created", 3)
    increment("scope.created", 2)
    const snap = snapshot()
    expect(snap["scope.created"]).toBe(5)
    expect(snapshot()["scope.created"]).toBe(5)
  })

  it("reset clears every counter", () => {
    increment("scope.completed", 4)
    increment("scope.interrupted", 1)
    reset()
    expect(snapshot()["scope.completed"]).toBe(0)
    expect(snapshot()["scope.interrupted"]).toBe(0)
  })

  it("InstanceScope records scope.created on entry and scope.completed on success", async () => {
    const home = process.env.NIKCLI_TEST_HOME
    const db = process.env.NIKCLI_DB
    process.env.NIKCLI_TEST_HOME = "/tmp/nikcli-counter-success"
    process.env.NIKCLI_DB = "/tmp/nikcli-counter-success/nikcli.db"
    try {
      const result = await Effect.runPromise(InstanceScope.with({ directory: "/tmp" }, Effect.succeed("ok")))
      expect(result).toBe("ok")
      const snap = snapshot()
      expect(snap["scope.created"]).toBeGreaterThanOrEqual(1)
      expect(snap["scope.completed"]).toBeGreaterThanOrEqual(1)
      expect(snap["scope.interrupted"]).toBe(0)
    } finally {
      if (home === undefined) delete process.env.NIKCLI_TEST_HOME
      else process.env.NIKCLI_TEST_HOME = home
      if (db === undefined) delete process.env.NIKCLI_DB
      else process.env.NIKCLI_DB = db
    }
  })

  it("InstanceScope records scope.interrupted on caller cancel", async () => {
    const home = process.env.NIKCLI_TEST_HOME
    const db = process.env.NIKCLI_DB
    process.env.NIKCLI_TEST_HOME = "/tmp/nikcli-counter-interrupt"
    process.env.NIKCLI_DB = "/tmp/nikcli-counter-interrupt/nikcli.db"
    try {
      const fiber = Effect.runFork(InstanceScope.with({ directory: "/tmp" }, Effect.never))
      await Effect.runPromise(Effect.sleep(5))
      await Effect.runPromise(Fiber.interrupt(fiber))
      const snap = snapshot()
      // Exactly one. The cancellation path runs twice — the canceller, then
      // the Exit that interrupting the inner fiber produces — so counting in
      // both places booked every cancel as two.
      expect(snap["scope.interrupted"]).toBe(1)
      expect(snap["scope.created"]).toBe(1)
      expect(snap["scope.completed"]).toBe(0)
      expect(snap["scope.finalizer-leak"]).toBe(0)
    } finally {
      if (home === undefined) delete process.env.NIKCLI_TEST_HOME
      else process.env.NIKCLI_TEST_HOME = home
      if (db === undefined) delete process.env.NIKCLI_DB
      else process.env.NIKCLI_DB = db
    }
  })

  it("records scope.failed, not scope.interrupted, when instance bootstrap throws", async () => {
    const home = process.env.NIKCLI_TEST_HOME
    const db = process.env.NIKCLI_DB
    process.env.NIKCLI_TEST_HOME = "/tmp/nikcli-counter-bootstrap"
    process.env.NIKCLI_DB = "/tmp/nikcli-counter-bootstrap/nikcli.db"
    try {
      const boom = new Error("bootstrap exploded")
      const exit = await Effect.runPromiseExit(
        InstanceScope.with({ directory: "/tmp", init: () => Promise.reject(boom) }, Effect.succeed("unreachable")),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const snap = snapshot()
      expect(snap["scope.failed"]).toBe(1)
      expect(snap["scope.interrupted"]).toBe(0)
      expect(snap["scope.completed"]).toBe(0)
    } finally {
      if (home === undefined) delete process.env.NIKCLI_TEST_HOME
      else process.env.NIKCLI_TEST_HOME = home
      if (db === undefined) delete process.env.NIKCLI_DB
      else process.env.NIKCLI_DB = db
    }
  })

  it("runPromiseWithLayer records runtime.bridge.success on success", async () => {
    const value = await runPromiseWithLayer(Layer.empty, Effect.succeed(42))
    expect(value).toBe(42)
    expect(snapshot()["runtime.bridge.success"]).toBeGreaterThanOrEqual(1)
  })

  it("runPromiseWithLayer records runtime.bridge.failure on typed failure", async () => {
    class Sentinel extends Error {}
    let caught: unknown
    try {
      await runPromiseWithLayer(Layer.empty, Effect.fail(new Sentinel()))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Sentinel)
    expect(snapshot()["runtime.bridge.failure"]).toBeGreaterThanOrEqual(1)
  })
})
