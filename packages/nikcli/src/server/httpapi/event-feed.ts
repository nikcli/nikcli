import { BusEvent } from "@/bus/bus-event"
import { Log } from "@nikcli-ai/util/log"

/**
 * One encoded frame per event, one bounded queue per connection.
 *
 * Before this module, `GET /event` and `GET /global/event` each built a
 * private `send` inside their `ReadableStream`, so `JSON.stringify` plus
 * UTF-8 encoding ran once per attached client per event, and
 * `controller.enqueue` — which never refuses — gave a stalled reader an
 * unbounded internal queue.
 *
 * A `Feed` owns the fan-out instead: it encodes an event once into an
 * immutable frame and offers that same frame to every connection. Each
 * connection carries its own lag budget, so a stalled reader is evicted with
 * a stated reason while publication and healthy readers continue in order.
 *
 * See `specs/effect-tui/04-event-delivery.md`.
 */
export namespace EventFeed {
  const log = Log.create({ service: "event.feed" })

  const encoder = new TextEncoder()

  /**
   * Frames a connection may fall behind by before it is evicted.
   *
   * This is an event count, not a memory bound: frame sizes vary and the
   * kernel and client buffers are outside server accounting. Tune it from
   * observed burst sizes and overflow frequency. A larger budget retains
   * stale clients longer.
   */
  export const LAG_BUDGET = 4096

  /** A connection-local frame: the greeting, a heartbeat, or a failure reason. */
  export type LocalEvent = {
    type: string
    properties: Record<string, unknown>
  }

  /**
   * Wraps a connection-local event in the route's wire shape.
   *
   * The two streams are deliberately different and both are load-bearing:
   * `/event` sends unwrapped `{type, properties}` while `/global/event` sends
   * `{payload: {...}}`. The TUI reads `data.type` on one and
   * `envelope.payload.type` on the other, so serving the wrong shape silently
   * drops every event client-side.
   */
  export type Envelope = (event: LocalEvent) => unknown

  /**
   * Reads the event type out of whatever shape this feed broadcasts.
   *
   * `broadcast` does **not** apply `Envelope` — that wraps connection-local
   * frames only. Each feed is handed values already in its own wire shape: the
   * instance feed receives the `Bus` event unwrapped (`{type, properties}`),
   * the global feed receives the `GlobalBus` payload (`{directory, payload}`).
   * So the visibility filter needs the same per-feed knowledge the envelope
   * carries, rather than assuming a `type` at the top level.
   */
  export type TypeOf = (event: unknown) => string | undefined

  export function frame(value: unknown): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
  }

  export type CloseReason = { name: string; message: string }

  /**
   * Byte ceiling for a **single** broadcast frame.
   *
   * Enforced per frame, deliberately not over the connection's lifetime.
   * `Connection.written` is a lifetime total — it only ever grows — so
   * spending it as a budget would evict every healthy long-lived reader the
   * moment a session had streamed eight megabytes of ordinary events, which
   * a TUI session reaches well inside an hour. That is the failure
   * `specs/effect-tui/04-event-delivery.md` warns about: discovering where
   * the line is by having it disconnect a user.
   *
   * Per frame the question is answerable without an inventory: one event
   * larger than this is a producer bug, and forwarding it would put the same
   * megabytes into the client. Backpressure from a reader that cannot keep
   * up is a different failure with its own budget — see `LAG_BUDGET`.
   *
   * `Connection.cost.bytes` remains the measurement a lifetime or windowed
   * budget would be ratified against, if one is ever wanted.
   */
  export const BYTE_BUDGET = 8 * 1024 * 1024

  /**
   * How many `snapshot` frames one connection may have dropped before it is
   * evicted anyway.
   *
   * A reader that is behind on replaceable status is not the reader the lag
   * budget was written to catch, so dropping the frame and keeping the
   * connection is the correct answer — but "drop forever" is not a bounded
   * policy, and ROADMAP non-negotiable 4 requires one. Past this count the
   * reader is genuinely not consuming and is evicted with the ordinary
   * overflow reason.
   */
  export const COALESCE_BUDGET = 256

  /** A single SSE connection, its lag budget, and what it has cost so far. */
  export class Connection {
    private closed = false
    private written = 0
    private frames = 0
    private coalesced = 0

    constructor(
      private readonly controller: ReadableStreamDefaultController<Uint8Array>,
      private readonly envelope: Envelope,
      private readonly onClosed: () => void,
    ) {}

    /**
     * Send a connection-local frame. These bypass the lag budget: the
     * greeting and the heartbeat exist to establish and hold the connection,
     * so they must not be the thing that evicts it.
     */
    local(event: LocalEvent) {
      this.write(frame(this.envelope(event)))
    }

    /**
     * `local`, for a frame the route encodes itself — an SSE comment ping, or
     * a greeting in a wire shape `envelope` does not produce.
     */
    localFrame(encoded: Uint8Array) {
      this.write(encoded)
    }

    /**
     * Offer a broadcast frame. Returns false when the connection was evicted
     * rather than written to.
     *
     * Eviction has two triggers today, and they answer different questions:
     *
     *  - Frame lag: `desiredSize` reaches zero when the reader is
     *    `LAG_BUDGET` frames behind. That is a reader who cannot keep up.
     *    Evict with `SubscriberOverflowError`.
     *  - Frame size: this one frame is larger than `BYTE_BUDGET`. That is a
     *    producer bug, and it is the connection's reader who would pay for
     *    it. Evict with `ByteBudgetExceededError`.
     *
     * Local frames (greeting, heartbeat, close reason) bypass both — they
     * exist to hold the connection open and state why it is being dropped,
     * so they must never be what drops it.
     */
    offer(encoded: Uint8Array, delivery: BusEvent.Delivery = "ordered"): boolean {
      if (this.closed) return false
      // `desiredSize` is the queuing strategy's high-water mark minus what
      // the reader has not consumed, so it reaches zero exactly when the
      // connection is LAG_BUDGET frames behind. It is null once the stream
      // has closed or errored, which `write` handles.
      const desired = this.controller.desiredSize
      if (desired !== null && desired <= 0) {
        // The delivery class decides whether being behind is fatal. A
        // `snapshot` is replaceable by definition — status, progress, an lsp
        // refresh — so the right answer is to drop this frame and keep the
        // reader, who will be corrected by the next one. Evicting instead is
        // the failure `specs/effect-tui/04-event-delivery.md` names: a cap
        // that does not know which events may be coalesced "drops a permission
        // prompt to save a progress bar".
        //
        // Every other class evicts exactly as before. `ordered` loses content,
        // `decision` loses a prompt the user is waiting on, `terminal` loses a
        // completion — none of those may be dropped quietly, and the eviction
        // is how the client learns to refetch.
        if (delivery === "snapshot" && this.coalesced < COALESCE_BUDGET) {
          this.coalesced++
          return true
        }
        // The budget belongs to the stream's queuing strategy, not to this
        // object, so the message states the condition rather than a number
        // it cannot actually read back.
        this.fail({
          name: "SubscriberOverflowError",
          message: "subscriber exceeded its lag budget",
        })
        return false
      }
      // Checked before the write, so the oversized frame is never handed to
      // the reader: it is dropped, and the close reason `fail` writes in its
      // place goes out past this check (see `fail`).
      if (encoded.byteLength > BYTE_BUDGET) {
        this.fail({
          name: "ByteBudgetExceededError",
          message: `frame of ${encoded.byteLength} bytes exceeds the ${BYTE_BUDGET} byte frame budget`,
        })
        return false
      }
      return this.write(encoded)
    }

    /**
     * Close with a stated reason, delivered on the wire first.
     *
     * The reason frame is written past the budget on purpose — a client that
     * is being dropped should learn why, and the previous behaviour was a
     * silent close that looked identical to a network failure.
     */
    fail(reason: CloseReason) {
      if (this.closed) return
      // The cost travels with the reason: an eviction is the one moment where
      // knowing how much this subscriber had already been sent is worth
      // something, and it is what the byte budget will be ratified against.
      log.info("connection failed", { ...reason, ...this.cost })
      this.write(frame(this.envelope({ type: "server.error", properties: { ...reason } })))
      this.close()
    }

    close() {
      if (this.closed) return
      this.closed = true
      this.onClosed()
      try {
        this.controller.close()
      } catch {
        // Already closed by the client.
      }
    }

    /** Mark closed without touching the controller (the client hung up). */
    abandon() {
      if (this.closed) return
      this.closed = true
      this.onClosed()
    }

    /**
     * Frames and bytes this connection has been handed.
     *
     * Counted on the way out, so locally generated frames — the greeting, the
     * heartbeat, the close reason — are included. A count that only saw
     * broadcast traffic would under-report exactly the connections that are
     * being told something is wrong.
     */
    get cost(): { frames: number; bytes: number; coalesced: number } {
      return { frames: this.frames, bytes: this.written, coalesced: this.coalesced }
    }

    private write(encoded: Uint8Array): boolean {
      if (this.closed) return false
      try {
        this.controller.enqueue(encoded)
        this.frames++
        this.written += encoded.byteLength
        return true
      } catch (error) {
        log.debug("sse write failed", { error })
        this.abandon()
        return false
      }
    }
  }

  /** A fan-out group: one encode per event, shared by every connection in it. */
  export class Feed {
    private readonly connections = new Set<Connection>()

    constructor(
      private readonly envelope: Envelope,
      private readonly typeOf: TypeOf = (event) => (event as { type?: string } | undefined)?.type,
    ) {}

    get size() {
      return this.connections.size
    }

    /**
     * Attach a connection. The caller owns the `ReadableStream`; the feed only
     * needs its controller and a way to learn that it is gone.
     */
    attach(controller: ReadableStreamDefaultController<Uint8Array>, onClosed?: () => void): Connection {
      const connection: Connection = new Connection(controller, this.envelope, () => {
        this.connections.delete(connection)
        onClosed?.()
      })
      this.connections.add(connection)
      return connection
    }

    /**
     * Encode once, offer to everyone.
     *
     * With no connections attached the event is not encoded at all, so a
     * headless server pays nothing for the subscription it keeps.
     *
     * Internal events return here too, ahead of the encode, for the same
     * reason: withholding one must cost less than sending it, not more. A
     * withheld event produces no frame at all — there is no typed placeholder,
     * because a placeholder would republish the existence and the exact timing
     * of the process-local activity the filter exists to keep inside. See
     * `specs/v2/public-event-filter.md`.
     */
    broadcast(event: unknown) {
      if (this.connections.size === 0) return
      if (BusEvent.isInternal(this.typeOf(event))) return
      let encoded: Uint8Array
      try {
        encoded = frame(event)
      } catch (error) {
        // Skip the malformed event and drop the clients that would otherwise
        // see a silent gap, but keep the feed usable for later connections.
        const type = (event as { type?: unknown } | undefined)?.type
        log.error("event encoding failed", { type, error })
        this.failAll({
          name: "EncodingError",
          message: "an event could not be encoded",
        })
        return
      }
      // Resolved once per broadcast, not once per connection: the class is a
      // property of the event, and the encode above is already shared.
      const delivery = BusEvent.deliveryOf(this.typeOf(event))
      for (const connection of this.connections) connection.offer(encoded, delivery)
    }

    closeAll() {
      for (const connection of this.connections) connection.close()
    }

    failAll(reason: CloseReason) {
      for (const connection of this.connections) connection.fail(reason)
    }
  }

  /**
   * Build the `ReadableStream` for one connection with the lag budget as its
   * queuing strategy, so `desiredSize` measures exactly the budget.
   */
  export function stream(source: UnderlyingDefaultSource<Uint8Array>): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>(source, new CountQueuingStrategy({ highWaterMark: LAG_BUDGET }))
  }

  export type FilteredOptions = {
    /** The request's signal: the connection closes when the client goes away. */
    signal?: AbortSignal
    /** Wire shape of the close reason frame; see `Envelope`. */
    envelope: Envelope
    /** Written first, outside the lag budget. */
    greeting: Uint8Array
    /** Written every `intervalMs`, outside the lag budget. */
    heartbeat: { frame: Uint8Array; intervalMs: number }
    /** Encodes one event for the wire. Defaults to `frame` (`data: <json>`). */
    encode?: (value: unknown) => Uint8Array
    /**
     * Start delivering. `offer` takes an event and the type its delivery class
     * is read from; returns the unsubscribe.
     */
    subscribe: (offer: (value: unknown, type: string | undefined) => void) => () => void
  }

  /**
   * A single connection with its own filter, under the same policy as `Feed`.
   *
   * For the routes whose every reader wants a different slice of `GlobalBus` —
   * one session, one workspace, one project — so there is no fan-out to share
   * an encode across. What they do share with `/event` is the part that
   * matters: the lag budget as the stream's queuing strategy, eviction with a
   * stated reason, `snapshot` coalescing, and exactly one release of the
   * subscription and heartbeat however the connection ends — eviction, the
   * request aborting, or the reader cancelling.
   */
  export function filtered(options: FilteredOptions): ReadableStream<Uint8Array> {
    let connection: Connection | undefined
    let closed = false
    let unsubscribe: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const abort = () => connection?.close()

    const release = () => {
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
      unsubscribe?.()
      unsubscribe = undefined
      options.signal?.removeEventListener("abort", abort)
    }

    return stream({
      start(controller) {
        const current = new Connection(controller, options.envelope, release)
        connection = current
        current.localFrame(options.greeting)
        const encode = options.encode ?? frame
        const detach = options.subscribe((value, type) => {
          // Encoded here rather than by the route: `offer` runs inside
          // `GlobalBus.emit`, and a throw would reach whoever published.
          let encoded: Uint8Array
          try {
            encoded = encode(value)
          } catch (error) {
            log.error("event encoding failed", { type, error })
            current.fail({ name: "EncodingError", message: "an event could not be encoded" })
            return
          }
          current.offer(encoded, BusEvent.deliveryOf(type))
        })
        // Eviction can happen inside `subscribe` itself (a replay burst past
        // the budget), before there was an unsubscribe to call.
        if (closed) return detach()
        unsubscribe = detach
        heartbeat = setInterval(() => current.localFrame(options.heartbeat.frame), options.heartbeat.intervalMs)
        if (options.signal?.aborted) return current.close()
        options.signal?.addEventListener("abort", abort, { once: true })
      },
      cancel() {
        connection?.abandon()
      },
    })
  }

  export const HEADERS = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  } as const
}
