import { describe, expect, it } from "bun:test"
import { EventFeed } from "@/server/httpapi/event-feed"

/**
 * A controller that models a reader with a finite, observable backlog.
 *
 * `desiredSize` mirrors what a real `ReadableStream` built with
 * `CountQueuingStrategy({ highWaterMark: LAG_BUDGET })` reports: the budget
 * minus the chunks the reader has not consumed. `drain()` is the reader
 * catching up.
 */
function fakeConnection(budget = EventFeed.LAG_BUDGET) {
  const frames: string[] = []
  const decoder = new TextDecoder()
  let queued = 0
  let peak = 0
  let closed = false

  const controller = {
    get desiredSize() {
      return closed ? null : budget - queued
    },
    enqueue(chunk: Uint8Array) {
      if (closed) throw new Error("stream is closed")
      queued++
      if (queued > peak) peak = queued
      frames.push(decoder.decode(chunk))
    },
    close() {
      closed = true
    },
    error() {
      closed = true
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>

  return {
    controller,
    frames,
    drain() {
      queued = 0
    },
    get peak() {
      return peak
    },
    get closed() {
      return closed
    },
    /** Parsed `data:` payloads, in order. */
    get data() {
      return frames.map((frame) => JSON.parse(frame.replace(/^data: /, "").replace(/\n\n$/, "")))
    },
  }
}

const identity: EventFeed.Envelope = (event) => event
const wrapped: EventFeed.Envelope = (event) => ({ payload: event })

describe("EventFeed", () => {
  it("encodes an event once regardless of how many connections are attached", () => {
    const feed = new EventFeed.Feed(identity)
    const a = fakeConnection()
    const b = fakeConnection()
    const c = fakeConnection()
    feed.attach(a.controller)
    feed.attach(b.controller)
    feed.attach(c.controller)

    // `toJSON` is called exactly once per serialization, so it counts encodes
    // without mocking the module.
    let encodes = 0
    const event = {
      type: "session.updated",
      properties: {
        toJSON() {
          encodes++
          return { id: "ses_1" }
        },
      },
    }

    feed.broadcast(event)

    expect(encodes).toBe(1)
    expect(a.data).toEqual([{ type: "session.updated", properties: { id: "ses_1" } }])
    expect(b.data).toEqual(a.data)
    expect(c.data).toEqual(a.data)
  })

  it("does not encode at all when nothing is attached", () => {
    const feed = new EventFeed.Feed(identity)
    let encodes = 0
    feed.broadcast({
      type: "session.updated",
      properties: {
        toJSON() {
          encodes++
          return {}
        },
      },
    })
    expect(encodes).toBe(0)
  })

  it("evicts only the connection that exceeds its lag budget", () => {
    const feed = new EventFeed.Feed(identity)
    const slow = fakeConnection(2)
    const healthy = fakeConnection(2)
    feed.attach(slow.controller)
    feed.attach(healthy.controller)

    feed.broadcast({ type: "a", properties: {} })
    feed.broadcast({ type: "b", properties: {} })
    // The healthy reader keeps up; the slow one never consumes.
    healthy.drain()

    feed.broadcast({ type: "c", properties: {} })

    expect(slow.closed).toBe(true)
    expect(healthy.closed).toBe(false)
    expect(feed.size).toBe(1)

    // The evicted connection is told why, instead of the previous silent close.
    const last = slow.data.at(-1)
    expect(last).toMatchObject({
      type: "server.error",
      properties: { name: "SubscriberOverflowError" },
    })
    // ...and it did not receive the frame that overflowed it.
    expect(slow.data.map((event) => event.type)).toEqual(["a", "b", "server.error"])
    expect(slow.peak).toBeLessThanOrEqual(3)
  })

  it("a healthy reader never exceeds its lag budget", () => {
    const budget = 8
    const connection = fakeConnection(budget)
    const feed = new EventFeed.Feed(identity)
    feed.attach(connection.controller)

    for (let i = 0; i < 20; i++) {
      feed.broadcast({ type: `e${i}`, properties: {} })
      connection.drain()
    }

    expect(connection.closed).toBe(false)
    expect(connection.peak).toBeLessThanOrEqual(budget)
    expect(connection.peak).toBeGreaterThan(0)
  })

  it("keeps delivering to survivors after another connection overflows", () => {
    const feed = new EventFeed.Feed(identity)
    const slow = fakeConnection(1)
    const healthy = fakeConnection(64)
    feed.attach(slow.controller)
    feed.attach(healthy.controller)

    feed.broadcast({ type: "a", properties: {} })
    feed.broadcast({ type: "b", properties: {} })
    feed.broadcast({ type: "c", properties: {} })

    expect(slow.closed).toBe(true)
    expect(healthy.data.map((event) => event.type)).toEqual(["a", "b", "c"])
  })

  it("drops current connections on an encoding failure but stays usable", () => {
    const feed = new EventFeed.Feed(identity)
    const first = fakeConnection()
    feed.attach(first.controller)

    const cyclic: Record<string, unknown> = { type: "bad" }
    cyclic.self = cyclic
    feed.broadcast(cyclic)

    expect(first.closed).toBe(true)
    expect(first.data.at(-1)).toMatchObject({
      type: "server.error",
      properties: { name: "EncodingError" },
    })

    const second = fakeConnection()
    feed.attach(second.controller)
    feed.broadcast({ type: "session.updated", properties: {} })
    expect(second.data.map((event) => event.type)).toEqual(["session.updated"])
  })

  it("keeps connection-local frames outside the lag budget", () => {
    const feed = new EventFeed.Feed(identity)
    const connection = fakeConnection(1)
    const attached = feed.attach(connection.controller)

    // A heartbeat on a stalled connection must not be the thing that evicts
    // it — the greeting and heartbeat exist to hold the connection open.
    attached.local({ type: "server.connected", properties: {} })
    attached.local({ type: "server.heartbeat", properties: {} })
    attached.local({ type: "server.heartbeat", properties: {} })

    expect(connection.closed).toBe(false)
  })

  it("preserves both wire shapes", () => {
    const instance = fakeConnection()
    const instanceFeed = new EventFeed.Feed(identity)
    instanceFeed.attach(instance.controller).local({ type: "server.connected", properties: {} })
    instanceFeed.broadcast({
      type: "session.updated",
      properties: { id: "ses_1" },
    })

    const global = fakeConnection()
    const globalFeed = new EventFeed.Feed(wrapped)
    globalFeed.attach(global.controller).local({ type: "server.connected", properties: {} })
    globalFeed.broadcast({
      directory: "/tmp/p",
      payload: { type: "session.updated", properties: { id: "ses_1" } },
    })

    // /event: unwrapped. The TUI reads `data.type` directly.
    expect(instance.data).toEqual([
      { type: "server.connected", properties: {} },
      { type: "session.updated", properties: { id: "ses_1" } },
    ])
    // /global/event: the greeting is wrapped, and bus events already carry
    // their own `{directory, payload}` envelope and pass through untouched.
    expect(global.data).toEqual([
      { payload: { type: "server.connected", properties: {} } },
      {
        directory: "/tmp/p",
        payload: { type: "session.updated", properties: { id: "ses_1" } },
      },
    ])
  })

  it("removes a connection that the client hung up on", () => {
    const feed = new EventFeed.Feed(identity)
    const connection = fakeConnection()
    const attached = feed.attach(connection.controller)
    expect(feed.size).toBe(1)

    attached.abandon()

    expect(feed.size).toBe(0)
    feed.broadcast({ type: "session.updated", properties: {} })
    expect(connection.frames).toHaveLength(0)
  })

  it("frames events as SSE data lines", () => {
    const decoded = new TextDecoder().decode(EventFeed.frame({ type: "a" }))
    expect(decoded).toBe('data: {"type":"a"}\n\n')
  })
})

describe("connection cost accounting", () => {
  /**
   * EOT-04 requirement 3 asks for byte accounting alongside frame counts,
   * "including locally generated frames", before any admission cap is turned
   * on. `BYTE_BUDGET` is a candidate number awaiting P0 ratification; nothing
   * enforces it yet, and the inventory it will be ratified against is built
   * from what this measures.
   */
  it("counts frames and bytes handed to the connection", () => {
    const feed = new EventFeed.Feed((event) => event)
    const conn = fakeConnection()
    const connection = feed.attach(conn.controller)

    expect(connection.cost).toEqual({ frames: 0, bytes: 0 })

    feed.broadcast({ type: "session.updated", properties: { id: "ses_1" } })
    const after = connection.cost

    expect(after.frames).toBe(1)
    // Every byte the reader was handed, not an estimate of the payload.
    expect(after.bytes).toBe(conn.frames[0]!.length)
  })

  it("counts the frames the server generates, not only broadcasts", () => {
    // A connection being evicted is told why, and that frame costs bytes too.
    // Counting only broadcast traffic would under-report exactly the
    // connections something is going wrong on.
    const feed = new EventFeed.Feed((event) => event)
    const conn = fakeConnection(1)
    const connection = feed.attach(conn.controller)

    feed.broadcast({ type: "session.updated", properties: { id: "ses_1" } })
    feed.broadcast({ type: "session.updated", properties: { id: "ses_2" } })

    expect(conn.frames.some((frame) => frame.includes("SubscriberOverflowError"))).toBe(true)
    expect(connection.cost.frames).toBe(conn.frames.length)
    expect(connection.cost.bytes).toBe(conn.frames.reduce((total, frame) => total + frame.length, 0))
  })
})

/**
 * EOT-04 byte-budget enforcement.
 *
 * `BYTE_BUDGET` caps a single broadcast frame. It deliberately does not cap
 * what a connection is handed over its lifetime: `Connection.written` only
 * grows, so spending it as a budget evicts healthy long-lived readers on a
 * timer disguised as a limit.
 */
describe("EventFeed byte budget (EOT-04)", () => {
  it("BYTE_BUDGET is the published ceiling", () => {
    expect(EventFeed.BYTE_BUDGET).toBe(8 * 1024 * 1024)
  })

  it("a healthy reader is never evicted for what it has been sent over time", () => {
    // The regression this guards: checking `written + frame > BYTE_BUDGET`
    // rather than `frame > BYTE_BUDGET`. `written` is a lifetime total, so
    // that form disconnects every session that has streamed eight megabytes
    // of perfectly ordinary events — which a TUI session reaches well inside
    // an hour — with an error blaming the client.
    const feed = new EventFeed.Feed(identity)
    const conn = fakeConnection(EventFeed.LAG_BUDGET)
    const connection = feed.attach(conn.controller)

    const megabyte = "x".repeat(1024 * 1024)
    for (let i = 0; i < 12; i++) {
      feed.broadcast({ type: "chunk", i, payload: megabyte })
      conn.drain()
    }

    expect(connection.cost.bytes).toBeGreaterThan(EventFeed.BYTE_BUDGET)
    expect(feed.size).toBe(1)
    expect(conn.data.every((event) => event.type !== "server.error")).toBe(true)
  })

  it("a connection that stays under BYTE_BUDGET keeps receiving frames", () => {
    const feed = new EventFeed.Feed(identity)
    const conn = fakeConnection(EventFeed.LAG_BUDGET)
    const connection = feed.attach(conn.controller)
    // Keep the fake reader draining so the byte budget is the only thing
    // that could possibly evict the connection.
    for (let i = 0; i < 50; i++) {
      feed.broadcast({ type: "t", i })
      conn.drain()
    }
    // Observable: feed still holds the connection, no server.error frame.
    expect(feed.size).toBe(1)
    expect(conn.data.every((event) => event.type !== "server.error")).toBe(true)
    expect(connection.cost.bytes).toBeLessThan(EventFeed.BYTE_BUDGET)
  })

  it("a single oversized broadcast evicts the connection with ByteBudgetExceededError", () => {
    const feed = new EventFeed.Feed(identity)
    const conn = fakeConnection(EventFeed.LAG_BUDGET)
    feed.attach(conn.controller)

    // Build a payload that, once framed, is larger than BYTE_BUDGET. The
    // frame helper wraps it in `data: ...\n\n` so the framed byte count is
    // a few bytes more than the payload itself.
    const payload = "x".repeat(EventFeed.BYTE_BUDGET + 1024)
    feed.broadcast({ type: "oversized", payload })

    // The connection is evicted with the byte-budget reason, not the
    // frame-count reason. `feed.size` drops to 0 because the connection
    // was removed from the feed; the close-reason frame carries the typed
    // error name.
    expect(feed.size).toBe(0)
    const last = conn.data.at(-1)
    expect(last).toMatchObject({
      type: "server.error",
      properties: { name: "ByteBudgetExceededError" },
    })
    // And the offending frame did not get delivered to the connection —
    // only the close-reason frame.
    expect(conn.data.map((event) => event.type)).toEqual(["server.error"])
    expect(feed.size).toBe(0)
  })

  it("local frames bypass the byte budget", () => {
    const feed = new EventFeed.Feed(identity)
    const conn = fakeConnection(1)
    const connection = feed.attach(conn.controller)

    // Local frames go out through `write` and never reach the budget check
    // at all — the close reason has to survive an eviction it is announcing.
    for (let i = 0; i < 5; i++) {
      connection.local({ type: "server.heartbeat", properties: { i } })
    }

    // Observable: feed still holds the connection, no server.error frame.
    expect(feed.size).toBe(1)
    expect(conn.data.every((event) => event.type !== "server.error")).toBe(true)
    expect(connection.cost.frames).toBe(5)
    expect(connection.cost.bytes).toBeLessThan(1_000)
  })
})
