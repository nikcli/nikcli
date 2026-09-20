import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Cause, Data, Effect, Exit, Layer } from "effect"
import { runPromiseExitWithLayer, runPromiseWithLayer } from "@/effect/runtime"
import { reset, snapshot } from "@/effect/lifecycle-counters"

/**
 * What the runtime bridge preserves, and what it cannot.
 *
 * ROADMAP non-negotiable 2 requires the boundary to distinguish interruption,
 * defect, timeout, transport failure and an empty successful result. Four of
 * the five survive the promise bridge intact. **A defect and an interruption do
 * not**: both arrive as a bare `Error` with no `_tag`, no `cause` and no
 * symbol, differing only in their message — "boom" against "All fibers
 * interrupted without error". Classifying on a message is not classifying, so a
 * caller that needs to tell those two apart has to use the Exit variant, which
 * still has the `Cause`.
 *
 * That asymmetry is pinned here rather than left to be rediscovered. It is also
 * why the counters are taken from `Effect.onExit` *inside* the effect: the
 * Cause is still there, and the rejection the caller sees is untouched.
 */

class Typed extends Data.TaggedError("Typed")<{ why: string }> {}

beforeEach(() => reset())
afterEach(() => reset())

async function rejection(effect: Effect.Effect<unknown, unknown, never>) {
  try {
    await runPromiseWithLayer(Layer.empty, effect)
    return undefined
  } catch (error) {
    return error
  }
}

describe("what the promise bridge preserves", () => {
  it("rethrows a typed failure as itself, tag intact", async () => {
    // The whole point of Schema.TaggedError: a caller catches by `_tag`.
    const error = (await rejection(Effect.fail(new Typed({ why: "x" })))) as Typed
    expect(error).toBeInstanceOf(Typed)
    expect(error._tag).toBe("Typed")
    expect(error.why).toBe("x")
  })

  it("rethrows a timeout as a tagged TimeoutError", async () => {
    const error = (await rejection(Effect.never.pipe(Effect.timeout("5 millis")))) as { _tag?: string }
    expect(error?._tag).toBe("TimeoutError")
  })

  it("resolves an empty success rather than treating it as a failure", async () => {
    // The fifth case the non-negotiable names: `undefined` is a result, not an
    // absence of one.
    await expect(runPromiseWithLayer(Layer.empty, Effect.succeed(undefined))).resolves.toBeUndefined()
  })

  it("cannot tell a defect from an interruption", async () => {
    // Asserted as a limitation, not a wish. If a future Effect release attaches
    // the Cause to the rejection this fails, and that is the moment to delete
    // the workaround the Exit variant exists for.
    const defect = (await rejection(Effect.die(new Error("boom")))) as Record<string, unknown>
    const interrupted = (await rejection(Effect.interrupt)) as Record<string, unknown>
    for (const error of [defect, interrupted]) {
      expect(error).toBeInstanceOf(Error)
      expect(error._tag).toBeUndefined()
      expect((error as { cause?: unknown }).cause).toBeUndefined()
      expect(Object.getOwnPropertySymbols(error)).toEqual([])
    }
  })
})

describe("what the Exit bridge preserves", () => {
  it("keeps the Cause, so the distinction the promise loses is still there", async () => {
    const defect = await runPromiseExitWithLayer(Layer.empty, Effect.die(new Error("boom")))
    const interrupted = await runPromiseExitWithLayer(Layer.empty, Effect.interrupt)
    expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true)
    expect(Exit.isFailure(defect) && Cause.hasInterrupts(defect.cause)).toBe(false)
    expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true)
  })

  it("keeps a typed failure in the failure channel, not the defect channel", async () => {
    const exit = await runPromiseExitWithLayer(Layer.empty, Effect.fail(new Typed({ why: "y" })))
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
  })
})

describe("both bridges name an outcome the same way", () => {
  it("counts an interruption as interrupted, not as a failure", async () => {
    // The bug this fixes: the promise bridge booked every non-success as
    // `failure`, so an interrupted dialog read as a failed one in the counters.
    await rejection(Effect.interrupt)
    expect(snapshot()["runtime.bridge.interrupted"]).toBe(1)
    expect(snapshot()["runtime.bridge.failure"]).toBe(0)
  })

  it("counts a defect as a failure", async () => {
    await rejection(Effect.die(new Error("boom")))
    expect(snapshot()["runtime.bridge.failure"]).toBe(1)
    expect(snapshot()["runtime.bridge.interrupted"]).toBe(0)
  })

  it("counts a typed failure as a failure", async () => {
    await rejection(Effect.fail(new Typed({ why: "z" })))
    expect(snapshot()["runtime.bridge.failure"]).toBe(1)
  })

  it("counts a success once", async () => {
    await runPromiseWithLayer(Layer.empty, Effect.succeed(1))
    expect(snapshot()["runtime.bridge.success"]).toBe(1)
  })

  it("agrees with the Exit bridge on the same effect", async () => {
    await rejection(Effect.interrupt)
    const viaPromise = snapshot()["runtime.bridge.interrupted"]
    reset()
    await runPromiseExitWithLayer(Layer.empty, Effect.interrupt)
    expect(snapshot()["runtime.bridge.interrupted"]).toBe(viaPromise)
  })
})
