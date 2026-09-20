import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { useAbortOnCleanup, useAttempts } from "@tui/util/lifecycle"

/**
 * The first tests in `packages/tui`.
 *
 * The package had no test directory at all, which is why
 * `specs/effect-tui/03-tui-lifecycle.md`'s audit of 88 candidate sites could
 * not be carried out with any confidence: there was nowhere to put the
 * evidence. These cover the primitive that audit builds on.
 *
 * No renderer is involved. `createRoot` gives a real Solid owner and a
 * `dispose` that runs `onCleanup`, which is exactly the lifecycle these
 * helpers hook — a dialog being dismissed is this, with a renderer attached.
 */

/** Run `body` under an owner and hand back its `dispose`. */
function withOwner<T>(body: () => T): { value: T; dispose: () => void } {
  let dispose!: () => void
  const value = createRoot((d) => {
    dispose = d
    return body()
  })
  return { value, dispose }
}

describe("useAbortOnCleanup", () => {
  it("is live while the owner is, and aborted once it is gone", () => {
    const { value: guard, dispose } = withOwner(() => useAbortOnCleanup())
    expect(guard.disposed()).toBe(false)
    expect(guard.signal.aborted).toBe(false)
    dispose()
    expect(guard.disposed()).toBe(true)
    expect(guard.signal.aborted).toBe(true)
  })

  it("still reports disposed to a continuation that was already resolved", async () => {
    // The race the flag exists for: aborting is not synchronous with the
    // continuation, so a request that had already come back still resumes
    // here. Only the flag catches that, which is why the docblock says to
    // check it after every await rather than only passing the signal.
    const { value: guard, dispose } = withOwner(() => useAbortOnCleanup())
    const settled = Promise.resolve("already came back")
    dispose()
    expect(await settled).toBe("already came back")
    expect(guard.disposed()).toBe(true)
  })
})

describe("useAttempts", () => {
  it("supersedes the running attempt when a new one starts", () => {
    const { value: attempts } = withOwner(() => useAttempts())
    const first = attempts.start()
    expect(first.stale()).toBe(false)

    const second = attempts.start()
    // The older attempt is stale even though the owner is very much alive —
    // disposal is not what makes its result wrong.
    expect(first.stale()).toBe(true)
    expect(first.signal.aborted).toBe(true)
    expect(second.stale()).toBe(false)
    expect(second.signal.aborted).toBe(false)
  })

  it("keeps an older attempt stale after the newer one finishes", () => {
    const { value: attempts } = withOwner(() => useAttempts())
    const first = attempts.start()
    attempts.start()
    // Generation, not a boolean: a second attempt completing must not make the
    // first one's result current again.
    expect(first.stale()).toBe(true)
  })

  it("makes every attempt stale when the owner is disposed", () => {
    const { value: attempts, dispose } = withOwner(() => useAttempts())
    const attempt = attempts.start()
    expect(attempts.disposed).toBe(false)
    dispose()
    expect(attempts.disposed).toBe(true)
    expect(attempt.stale()).toBe(true)
    expect(attempt.signal.aborted).toBe(true)
  })

  it("gives each attempt its own signal, not a field off a shared controller", () => {
    const { value: attempts } = withOwner(() => useAttempts())
    const first = attempts.start()
    const second = attempts.start()
    expect(first.signal).not.toBe(second.signal)
    // Reading `signal` off the shared controller after being superseded would
    // hand you the signal belonging to the attempt that replaced you.
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
  })

  describe("adopt", () => {
    it("hands the resource back while the attempt is current", () => {
      const { value: attempts } = withOwner(() => useAttempts())
      const attempt = attempts.start()
      const released: string[] = []
      expect(attempt.adopt("pty", (r) => released.push(r))).toBe("pty")
      expect(released).toEqual([])
    })

    it("releases the resource when a newer attempt has superseded this one", () => {
      // An abort signal does not un-open a pty. Checking `stale()` and
      // returning drops the only reference and nothing closes it.
      const { value: attempts } = withOwner(() => useAttempts())
      const attempt = attempts.start()
      attempts.start()
      const released: string[] = []
      expect(attempt.adopt("pty", (r) => released.push(r))).toBeUndefined()
      expect(released).toEqual(["pty"])
    })

    it("releases the resource when the owner is gone", () => {
      const { value: attempts, dispose } = withOwner(() => useAttempts())
      const attempt = attempts.start()
      dispose()
      const released: string[] = []
      expect(attempt.adopt("watcher", (r) => released.push(r))).toBeUndefined()
      expect(released).toEqual(["watcher"])
    })

    it("swallows a release that throws rather than failing the flow that superseded it", () => {
      const { value: attempts } = withOwner(() => useAttempts())
      const attempt = attempts.start()
      attempts.start()
      expect(() =>
        attempt.adopt("pty", () => {
          throw new Error("kill failed")
        }),
      ).not.toThrow()
    })
  })
})
