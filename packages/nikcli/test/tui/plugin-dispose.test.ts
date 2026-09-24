import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createPluginScope } from "@tui/plugin/runtime"
import { TUI_SRC } from "./tui-source"

/**
 * Dispose order is the whole point of this file.
 *
 * The scope walks its cleanups newest-first, and the host's own
 * deregistrations — the command list, the routes, the event listeners, the
 * plugin host entry — are *in* that queue alongside whatever the plugin
 * registered. Stopping at the first callback that hangs or throws therefore
 * left a disposed plugin still wired into the TUI: its commands in the palette,
 * its routes resolvable, its listeners receiving events.
 */
function scope(timeoutMs: number) {
  return createPluginScope({ spec: "test://plugin" } as Parameters<typeof createPluginScope>[0], "test", timeoutMs)
}

describe("plugin scope dispose", () => {
  test("a hung callback does not strand the cleanups queued before it", async () => {
    const ran: string[] = []
    const s = scope(20)

    // Registered first, so it runs *last*: it is the one a `break` dropped.
    s.lifecycle.onDispose(() => {
      ran.push("host-unregister")
    })
    s.lifecycle.onDispose(() => new Promise<void>(() => {}))

    await s.dispose()
    expect(ran).toEqual(["host-unregister"])
  })

  test("a throwing callback does not stop the queue either", async () => {
    const ran: string[] = []
    const s = scope(500)

    s.lifecycle.onDispose(() => {
      ran.push("host-unregister")
    })
    s.lifecycle.onDispose(() => {
      throw new Error("plugin cleanup blew up")
    })

    await s.dispose()
    expect(ran).toEqual(["host-unregister"])
  })

  test("every remaining cleanup still runs once the budget is spent", async () => {
    const ran: string[] = []
    const s = scope(10)

    s.lifecycle.onDispose(() => {
      ran.push("a")
    })
    s.lifecycle.onDispose(() => {
      ran.push("b")
    })
    // Two hangs: the first eats the budget, the second gets no wait at all —
    // both must still be *invoked*, and both must still be followed by a and b.
    s.lifecycle.onDispose(() => new Promise<void>(() => {}))
    s.lifecycle.onDispose(() => new Promise<void>(() => {}))

    await s.dispose()
    expect(ran).toEqual(["b", "a"])
  })

  test("tracked host disposers run in reverse registration order", async () => {
    const ran: string[] = []
    const s = scope(500)

    s.track(() => ran.push("first"))
    s.track(() => ran.push("second"))

    await s.dispose()
    expect(ran).toEqual(["second", "first"])
  })

  test("the lifecycle signal is aborted before any cleanup runs", async () => {
    const s = scope(500)
    let abortedDuringCleanup = false
    s.lifecycle.onDispose(() => {
      abortedDuringCleanup = s.lifecycle.signal.aborted
    })

    await s.dispose()
    expect(abortedDuringCleanup).toBe(true)
  })

  test("repeated dispose cycles leave no residual owner callbacks", async () => {
    for (let cycle = 0; cycle < 20; cycle++) {
      const ran: string[] = []
      const s = scope(50)
      s.lifecycle.onDispose(() => {
        ran.push("cleanup")
      })
      await s.dispose()
      expect(ran).toEqual(["cleanup"])
      expect(s.lifecycle.signal.aborted).toBe(true)
      s.lifecycle.onDispose(() => {
        ran.push("late")
      })
      await s.dispose()
      expect(ran).toEqual(["cleanup"])
    }
  })

  test("a shared deadline bounds several wedged plugins together, not one budget each", async () => {
    // Shutdown disposes plugins one after another. With only the per-plugin
    // budget, four wedged plugins held exit for four budgets.
    const ran: string[] = []
    const scopes = Array.from({ length: 4 }, (_, index) => {
      const s = scope(300)
      s.lifecycle.onDispose(() => {
        ran.push(`host-unregister-${index}`)
      })
      s.lifecycle.onDispose(() => new Promise<void>(() => {}))
      return s
    })

    const started = performance.now()
    const deadline = Date.now() + 150
    for (const s of scopes) await s.dispose(deadline)
    const elapsed = performance.now() - started

    // One shared budget plus scheduling slack — far below 4 x 300 ms.
    expect(elapsed).toBeLessThan(600)
    // Spending the budget skips the wait, never the host's deregistrations.
    expect(ran).toEqual(["host-unregister-0", "host-unregister-1", "host-unregister-2", "host-unregister-3"])
  })

  test("a deadline further out than the scope's own budget does not extend it", async () => {
    const s = scope(20)
    s.lifecycle.onDispose(() => new Promise<void>(() => {}))
    const started = performance.now()
    await s.dispose(Date.now() + 60_000)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("runtime shutdown hands every plugin the same deadline", async () => {
    // Pinned against the source because `TuiPluginRuntime.dispose` needs a live
    // host to reach; the scope behaviour it relies on is covered above.
    const src = await Bun.file(path.join(TUI_SRC, "plugin/runtime.ts")).text()
    const body = src.slice(src.indexOf("export async function dispose()"))
    const deadline = body.indexOf("const deadline = Date.now() + SHUTDOWN_BUDGET_MS")
    const loop = body.indexOf("await deactivatePluginEntry(state, plugin, false, deadline)")
    expect(deadline).toBeGreaterThan(-1)
    expect(loop).toBeGreaterThan(deadline)
  })
})
