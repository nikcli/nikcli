import { describe, expect, test } from "bun:test"
import { createRoot, createMemo } from "solid-js"
import { quotaForAgent, isQuotaUnavailable } from "./quota"
import { createQuotaStore } from "./quota-store"

const report = (remaining: number, at: string) =>
  JSON.stringify({
    generatedAt: at,
    providers: [
      {
        provider: "claude",
        plan: "max",
        windows: [{ id: "five_hour", kind: "session", percentRemaining: remaining, resetsAt: "2026-09-15T22:40:00Z" }],
      },
    ],
  })

describe("createQuotaStore", () => {
  test("a view built before the first read updates when the report arrives, and again when it changes", async () => {
    let clock = Date.parse("2026-09-15T20:00:00Z")
    let text: string | undefined
    const store = createQuotaStore(
      async () => text,
      () => clock,
    )

    const seen = createRoot(() => createMemo(() => quotaForAgent("claude-code", store.snapshot(), store.now())))
    expect(isQuotaUnavailable(seen())).toBe(true)

    text = report(64, "2026-09-15T19:59:00Z")
    await store.refresh()
    const first = seen()
    if (!first || isQuotaUnavailable(first)) throw new Error("expected a reading")
    expect(first.displayValue).toBe("64%")

    text = report(51, "2026-09-15T20:04:00Z")
    clock = Date.parse("2026-09-15T20:05:00Z")
    await store.refresh()
    const second = seen()
    if (!second || isQuotaUnavailable(second)) throw new Error("expected a reading")
    expect(second.displayValue).toBe("51%")
  })

  test("the clock moves on each refresh, so the countdown does", async () => {
    let clock = Date.parse("2026-09-15T20:00:00Z")
    const text = report(64, "2026-09-15T19:59:00Z")
    const store = createQuotaStore(
      async () => text,
      () => clock,
    )
    await store.refresh()
    const before = quotaForAgent("claude-code", store.snapshot(), store.now())
    clock += 10 * 60_000
    await store.refresh()
    const after = quotaForAgent("claude-code", store.snapshot(), store.now())
    if (!before || !after || isQuotaUnavailable(before) || isQuotaUnavailable(after))
      throw new Error("expected readings")
    expect(before.countdown).toBe("2h 40m")
    expect(after.countdown).toBe("2h 30m")
  })

  test("a failed or half-written read keeps the last reading; a read that finds no report clears it", async () => {
    const clock = () => Date.parse("2026-09-15T20:00:00Z")
    let mode: "good" | "broken" | "throws" | "none" = "good"
    const store = createQuotaStore(async () => {
      if (mode === "throws") throw new Error("EPERM")
      if (mode === "broken") return '{"generatedAt": "2026-09'
      if (mode === "none") return undefined
      return report(64, "2026-09-15T19:59:00Z")
    }, clock)
    const shown = () => quotaForAgent("claude-code", store.snapshot(), store.now())

    await store.refresh()
    for (const hiccup of ["broken", "throws"] as const) {
      mode = hiccup
      await store.refresh()
      const kept = shown()
      if (!kept || isQuotaUnavailable(kept)) throw new Error(`${hiccup} blanked the reading`)
      expect(kept.displayValue).toBe("64%")
    }
    mode = "none"
    await store.refresh()
    expect(isQuotaUnavailable(shown())).toBe(true)
  })

  test("a read that never answers gives up after the timeout and keeps the last reading", async () => {
    const clock = () => Date.parse("2026-09-15T20:00:00Z")
    let hang = false
    const store = createQuotaStore(
      () => (hang ? new Promise<string>(() => {}) : Promise.resolve(report(64, "2026-09-15T19:59:00Z"))),
      clock,
      20,
    )
    await store.refresh()
    hang = true
    const started = Date.now()
    await store.refresh()
    expect(Date.now() - started).toBeLessThan(1_000)
    const kept = quotaForAgent("claude-code", store.snapshot(), store.now())
    if (!kept || isQuotaUnavailable(kept)) throw new Error("the timeout blanked the reading")
    expect(kept.displayValue).toBe("64%")
  })

  test("agy's file is read on every refresh, alongside quota-axi's report and without it", async () => {
    const clock = () => Date.parse("2026-09-16T13:06:00Z")
    let agyText: string | undefined = JSON.stringify({
      provider: "antigravity",
      capturedAt: "2026-09-16T13:05:00Z",
      data: { quota: { "gemini-5h": { remaining_fraction: 0.4, reset_time: "2026-09-16T18:00:00Z" } } },
    })
    let axiText: string | undefined
    const store = createQuotaStore(
      async () => axiText,
      clock,
      2_000,
      async () => agyText,
    )
    const agy = () => quotaForAgent("agy", store.snapshot(), store.now())
    const claude = () => quotaForAgent("claude-code", store.snapshot(), store.now())

    await store.refresh()
    const first = agy()
    if (!first || isQuotaUnavailable(first)) throw new Error("expected agy's reading")
    expect(first.displayValue).toBe("40%")
    expect(isQuotaUnavailable(claude())).toBe(true)

    axiText = report(64, "2026-09-16T13:05:00Z")
    await store.refresh()
    expect(isQuotaUnavailable(claude())).toBe(false)
    expect(isQuotaUnavailable(agy())).toBe(false)

    agyText = undefined
    await store.refresh()
    expect(isQuotaUnavailable(agy())).toBe(true)
    expect(isQuotaUnavailable(claude())).toBe(false)
  })

  test("a reading kept through failures stays, marked old, once it is too old", async () => {
    let clock = Date.parse("2026-09-15T20:00:00Z")
    let fail = false
    const store = createQuotaStore(
      async () => {
        if (fail) throw new Error("EPERM")
        return report(64, "2026-09-15T19:59:00Z")
      },
      () => clock,
    )
    await store.refresh()
    fail = true
    clock += 31 * 60_000
    await store.refresh()
    const kept = quotaForAgent("claude-code", store.snapshot(), store.now())
    if (!kept || isQuotaUnavailable(kept)) throw new Error("the last reading must stay visible")
    expect(kept.stale).toBe(true)
    expect(kept.displayValue).toBe("64%")
  })

  test("Claude's status line file keeps the bar current between quota-axi runs", async () => {
    let clock = Date.parse("2026-09-15T20:00:00Z")
    const line = () =>
      JSON.stringify({
        provider: "claude",
        capturedAt: new Date(clock - 5_000).toISOString(),
        data: { rateLimits: { five_hour: { used_percentage: 40, resets_at: 1789593600 } } },
      })
    const store = createQuotaStore(
      async () => report(64, "2026-09-15T19:59:00Z"),
      () => clock,
      2_000,
      undefined,
      async () => line(),
    )
    const states: string[] = []
    for (let i = 0; i < 6; i++) {
      await store.refresh()
      const shown = quotaForAgent("claude-code", store.snapshot(), store.now())
      states.push(isQuotaUnavailable(shown) ? "n/d" : shown!.stale ? "old" : shown!.displayValue)
      clock += 20 * 60_000
    }
    expect(states).toEqual(["60%", "60%", "60%", "60%", "60%", "60%"])
  })
})
