import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { useAbortOnCleanup, useAttempts } from "@tui/util/lifecycle"

/** Run inside a Solid owner so `onCleanup` registers, and return the disposer. */
function withOwner<T>(fn: () => T): { value: T; dispose: () => void } {
  let value!: T
  let dispose!: () => void
  createRoot((d) => {
    dispose = d
    value = fn()
  })
  return { value, dispose }
}

describe("useAbortOnCleanup", () => {
  it("is not disposed while the owner lives", () => {
    const { value, dispose } = withOwner(() => useAbortOnCleanup())
    expect(value.disposed()).toBe(false)
    expect(value.signal.aborted).toBe(false)
    dispose()
  })

  it("aborts and reports disposed once the owner is gone", () => {
    const { value, dispose } = withOwner(() => useAbortOnCleanup())
    dispose()
    expect(value.disposed()).toBe(true)
    expect(value.signal.aborted).toBe(true)
  })
})

describe("useAttempts", () => {
  it("keeps a lone attempt fresh", () => {
    const { value, dispose } = withOwner(() => useAttempts())
    const attempt = value.start()
    expect(attempt.stale()).toBe(false)
    expect(attempt.signal.aborted).toBe(false)
    dispose()
  })

  it("makes the previous attempt stale when a new one starts", () => {
    // The bug this exists for: press retry while a device-code poll is parked
    // on an await, and the older run resumes into a live component.
    const { value, dispose } = withOwner(() => useAttempts())
    const first = value.start()
    const second = value.start()
    expect(first.stale()).toBe(true)
    expect(second.stale()).toBe(false)
    dispose()
  })

  it("aborts the superseded attempt's signal", () => {
    const { value, dispose } = withOwner(() => useAttempts())
    const first = value.start()
    value.start()
    expect(first.signal.aborted).toBe(true)
    dispose()
  })

  it("leaves the newest attempt's signal usable", () => {
    const { value, dispose } = withOwner(() => useAttempts())
    value.start()
    const latest = value.start()
    expect(latest.signal.aborted).toBe(false)
    dispose()
  })

  it("makes every attempt stale on disposal", () => {
    const { value, dispose } = withOwner(() => useAttempts())
    const only = value.start()
    dispose()
    expect(only.stale()).toBe(true)
    expect(value.disposed).toBe(true)
  })

  it("aborts the running attempt on disposal", () => {
    const { value, dispose } = withOwner(() => useAttempts())
    const attempt = value.start()
    dispose()
    expect(attempt.signal.aborted).toBe(true)
  })

  it("reports an attempt started after disposal as stale", () => {
    // A keypress handler that fires during teardown must not start real work.
    const { value, dispose } = withOwner(() => useAttempts())
    dispose()
    expect(value.start().stale()).toBe(true)
  })

  it("does not report disposed before the owner is torn down", () => {
    const { value, dispose } = withOwner(() => useAttempts())
    expect(value.disposed).toBe(false)
    dispose()
  })

  /**
   * `adopt` had no test and has no caller — it is referenced only by the
   * example in its own docblock. Covered here because the thing it guards
   * against is invisible when it goes wrong: `stale()` answers whether a
   * *result* still matters, and an abort signal does not un-open a pty or
   * un-spawn a process. Checking `stale()` and returning drops the only
   * reference, and nothing closes it.
   */
  describe("adopt", () => {
    it("hands the resource back while the attempt is current", () => {
      const { value, dispose } = withOwner(() => useAttempts())
      const attempt = value.start()
      const released: string[] = []
      expect(attempt.adopt("pty", (r) => released.push(r))).toBe("pty")
      expect(released).toEqual([])
      dispose()
    })

    it("releases a resource a superseded attempt acquired", () => {
      const { value, dispose } = withOwner(() => useAttempts())
      const attempt = value.start()
      value.start()
      const released: string[] = []
      expect(attempt.adopt("pty", (r) => released.push(r))).toBeUndefined()
      expect(released).toEqual(["pty"])
      dispose()
    })

    it("releases a resource that arrived after the owner was gone", () => {
      const { value, dispose } = withOwner(() => useAttempts())
      const attempt = value.start()
      dispose()
      const released: string[] = []
      expect(attempt.adopt("watcher", (r) => released.push(r))).toBeUndefined()
      expect(released).toEqual(["watcher"])
    })

    it("swallows a release that throws rather than failing the flow that superseded it", () => {
      const { value, dispose } = withOwner(() => useAttempts())
      const attempt = value.start()
      value.start()
      expect(() =>
        attempt.adopt("pty", () => {
          throw new Error("kill failed")
        }),
      ).not.toThrow()
      dispose()
    })
  })
})
