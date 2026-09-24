import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js"
import { SDKProvider } from "@tui/context/sdk"
import {
  createReconnectGate,
  reconnectDelay,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  sleepUnlessAborted,
} from "@tui/util/reconnect"

describe("createReconnectGate", () => {
  it("does not refetch on the initial connection", () => {
    // `onMount` already loaded state; refetching here would double startup.
    const gate = createReconnectGate()
    expect(gate.observe("connecting")).toBe(false)
    expect(gate.observe("connected")).toBe(false)
  })

  it("refetches after the stream dropped and came back", () => {
    // Anything published while the stream was down is gone: the feed is a live
    // fan-out with no cursor to resume from.
    const gate = createReconnectGate()
    gate.observe("connecting")
    gate.observe("connected")
    expect(gate.observe("reconnecting")).toBe(false)
    expect(gate.observe("connected")).toBe(true)
  })

  it("refetches once per outage, not once per attempt", () => {
    const gate = createReconnectGate()
    gate.observe("connected")
    for (let i = 0; i < 5; i++) gate.observe("reconnecting")
    expect(gate.observe("connected")).toBe(true)
    expect(gate.observe("connected")).toBe(false)
  })

  it("recovers from every subsequent outage", () => {
    const gate = createReconnectGate()
    gate.observe("connected")
    gate.observe("reconnecting")
    expect(gate.observe("connected")).toBe(true)
    gate.observe("reconnecting")
    expect(gate.observe("connected")).toBe(true)
  })

  it("stays pending while the outage lasts", () => {
    const gate = createReconnectGate()
    expect(gate.pending).toBe(false)
    gate.observe("reconnecting")
    expect(gate.pending).toBe(true)
    gate.observe("connected")
    expect(gate.pending).toBe(false)
  })

  it("does not treat connecting as an outage", () => {
    // Only `markReconnecting` reports a dropped stream; `connecting` is the
    // state the signal starts in.
    const gate = createReconnectGate()
    gate.observe("connected")
    gate.observe("connecting")
    expect(gate.observe("connected")).toBe(false)
  })

  it("never reports a refetch while still disconnected", () => {
    const gate = createReconnectGate()
    gate.observe("connected")
    expect(gate.observe("reconnecting")).toBe(false)
    expect(gate.observe("reconnecting")).toBe(false)
  })
})

describe("reconnectDelay", () => {
  it("doubles from the base and stops at the cap", () => {
    const top = () => 1
    expect(reconnectDelay(1, top)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelay(2, top)).toBe(RECONNECT_BASE_MS * 2)
    expect(reconnectDelay(3, top)).toBe(RECONNECT_BASE_MS * 4)
    expect(reconnectDelay(50, top)).toBe(RECONNECT_MAX_MS)
  })

  it("keeps half of every step fixed, so no retry is immediate", () => {
    const bottom = () => 0
    expect(reconnectDelay(1, bottom)).toBe(RECONNECT_BASE_MS / 2)
    expect(reconnectDelay(0, bottom)).toBe(RECONNECT_BASE_MS / 2)
    expect(reconnectDelay(50, bottom)).toBe(RECONNECT_MAX_MS / 2)
  })

  it("spreads clients that failed together", () => {
    const delays = new Set(Array.from({ length: 20 }, () => reconnectDelay(3)))
    expect(delays.size).toBeGreaterThan(1)
  })
})

describe("sleepUnlessAborted", () => {
  it("returns as soon as the owner goes away", async () => {
    const ctrl = new AbortController()
    const started = performance.now()
    const wait = sleepUnlessAborted(60_000, ctrl.signal)
    ctrl.abort()
    await wait
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it("does not wait at all once aborted", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const started = performance.now()
    await sleepUnlessAborted(60_000, ctrl.signal)
    expect(performance.now() - started).toBeLessThan(100)
  })
})

describe("SDKProvider event stream", () => {
  it("waits between reconnects when the server closes every stream cleanly", async () => {
    // A server that accepts the subscription and closes it at once — an
    // eviction, a proxy with a short idle timeout — used to be re-subscribed
    // with no delay at all, so the loop spun as fast as the transport allowed.
    let subscribes = 0
    const fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("/global/event")) subscribes++
      // A real subscribe crosses I/O. Without this yield the unfixed loop runs
      // entirely on microtasks and starves the timers, so the test would hang
      // instead of failing.
      await new Promise((resolve) => setTimeout(resolve, 0))
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }) as typeof globalThis.fetch

    const { renderer } = await testRender(() =>
      createComponent(SDKProvider, {
        url: "http://nikcli.test",
        fetch,
        get children() {
          return null
        },
      }),
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 400))
      // Delays are at least 125, 250, 500 ms: at most three subscribes fit.
      expect(subscribes).toBeGreaterThanOrEqual(1)
      expect(subscribes).toBeLessThanOrEqual(3)
    } finally {
      renderer.destroy()
    }
  })
})
