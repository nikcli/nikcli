import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS, createAutosave } from "./autosave"

/** A pair of listener registries a test can fire by hand. */
function listeners() {
  const held = new Map<string, Set<() => void>>()
  return {
    addEventListener: (type: string, listener: () => void) => {
      const set = held.get(type) ?? new Set()
      set.add(listener)
      held.set(type, set)
    },
    removeEventListener: (type: string, listener: () => void) => {
      held.get(type)?.delete(listener)
    },
    fire: (type: string) => {
      for (const listener of [...(held.get(type) ?? [])]) listener()
    },
    count: (type: string) => held.get(type)?.size ?? 0,
  }
}

/** Runs the body with a clock the test advances itself. */
function withFakeTimers(body: (tick: (ms: number) => void) => void) {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  let now = 0
  let nextId = 1
  const pending = new Map<number, { at: number; run: () => void }>()

  globalThis.setTimeout = ((run: () => void, delay = 0) => {
    const id = nextId++
    pending.set(id, { at: now + delay, run })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: unknown) => {
    pending.delete(id as number)
  }) as typeof clearTimeout

  const tick = (ms: number) => {
    now += ms
    // Sorted, so a timer set for earlier runs first even when both are due.
    for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now) {
        pending.delete(id)
        timer.run()
      }
    }
  }

  try {
    body(tick)
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
}

/**
 * An autosave with everything faked, built and left running.
 *
 * Built outside the `createRoot` callback rather than inside it, because
 * Solid flushes effects at the end of that callback: assertions written in
 * there run before the first `createEffect` has, and every timer this is
 * about would still be unset.
 */
function mount(options?: { visibilityState?: string }) {
  const page = listeners()
  const visibility = { ...listeners(), visibilityState: options?.visibilityState ?? "visible" }
  const [changed, setChanged] = createSignal(0)
  const writes = { count: 0 }
  let dispose!: () => void

  createRoot((disposer) => {
    dispose = disposer
    createAutosave({
      changed,
      write: () => {
        writes.count++
      },
      page,
      visibility,
    })
  })

  return { page, visibility, writes, dispose, change: () => setChanged((n) => n + 1) }
}

describe("createAutosave", () => {
  test("waits for the changes to stop before writing", () => {
    withFakeTimers((tick) => {
      const it = mount()

      tick(SAVE_DEBOUNCE_MS - 1)
      expect(it.writes.count).toBe(0)
      tick(1)
      expect(it.writes.count).toBe(1)

      it.change()
      tick(SAVE_DEBOUNCE_MS)
      expect(it.writes.count).toBe(2)

      it.dispose()
    })
  })

  test("a change that never stops is still written within the ceiling", () => {
    withFakeTimers((tick) => {
      const it = mount()

      /*
       * The defect this covers: an agent printing output kept resetting the
       * debounce, so nothing was written for as long as anything was running
       * — the one stretch worth surviving a crash.
       */
      for (let elapsed = 0; elapsed < SAVE_MAX_WAIT_MS; elapsed += SAVE_DEBOUNCE_MS / 2) {
        it.change()
        tick(SAVE_DEBOUNCE_MS / 2)
      }
      expect(it.writes.count).toBeGreaterThan(0)

      it.dispose()
    })
  })

  test("writes when the page goes away, without waiting for the debounce", () => {
    withFakeTimers((tick) => {
      const it = mount()

      it.page.fire("pagehide")
      expect(it.writes.count).toBe(1)
      // And the pending debounce was cancelled rather than firing after it.
      tick(SAVE_DEBOUNCE_MS + SAVE_MAX_WAIT_MS)
      expect(it.writes.count).toBe(1)

      it.dispose()
    })
  })

  test("writes when the window is hidden, and not when it is merely blurred", () => {
    withFakeTimers(() => {
      const it = mount()

      it.visibility.fire("visibilitychange")
      expect(it.writes.count).toBe(0)

      it.visibility.visibilityState = "hidden"
      it.visibility.fire("visibilitychange")
      expect(it.writes.count).toBe(1)

      it.dispose()
    })
  })

  test("nothing is left behind when the workbench goes", () => {
    withFakeTimers((tick) => {
      const it = mount()
      expect(it.page.count("pagehide")).toBe(1)
      expect(it.visibility.count("visibilitychange")).toBe(1)

      it.dispose()

      expect(it.page.count("pagehide")).toBe(0)
      expect(it.visibility.count("visibilitychange")).toBe(0)
      // A pending write must not fire against a workbench that is gone.
      tick(SAVE_MAX_WAIT_MS * 2)
      expect(it.writes.count).toBe(0)
    })
  })
})
