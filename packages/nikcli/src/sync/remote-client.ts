/**
 * RemoteSyncClient — HTTPS client for the optional remote hub server
 * (e.g. https://s.nikcli-ai.dev). Used by the local CLI to push events
 * it produced and to subscribe to events the remote server produced
 * for the same project.
 *
 * The wire protocol mirrors the in-process one: a `SyncEventRecord`
 * crosses the wire as JSON. The client uses `fetch` for push and
 * `EventSource` for subscribe; both are part of the Web standard so
 * no extra runtime dependencies.
 *
 * Reconnection is handled with exponential backoff (cap 30s). On
 * reconnect, the client asks the server for events with `seq > lastSeq`
 * via the `/sync/outbox?since=…` catch-up endpoint to avoid gaps.
 */
import { Log } from "@nikcli-ai/util/log"
import type { SyncEventRecord } from "./index"

const log = Log.create({ service: "sync.remote-client" })

export type RemoteSyncClientOptions = {
  url: string
  token: string
  projectID: string
  onEvent: (event: SyncEventRecord) => void | Promise<void>
  onError?: (error: unknown) => void
}

export class RemoteSyncClient {
  private source: EventSource | undefined
  private lastSeq = 0
  private stopped = false
  private backoffMs = 1000
  private readonly backoffCapMs = 30_000
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly opts: RemoteSyncClientOptions) {}

  async start(): Promise<void> {
    this.stopped = false
    // Step 1: catch-up via /sync/outbox?since=0
    await this.catchUp().catch((error) => {
      log.warn("initial catch-up failed", { error })
    })
    // Step 2: subscribe to live stream
    this.subscribe()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.source) {
      this.source.close()
      this.source = undefined
    }
  }

  /**
   * Push a single event to the remote server. Returns true on success,
   * false on transient failure (the caller should leave the event in
   * the outbox for retry).
   */
  async push(event: SyncEventRecord): Promise<boolean> {
    const url = `${this.opts.url.replace(/\/$/, "")}/sync/event`
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify({ event, projectID: this.opts.projectID }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        log.warn("push failed", {
          status: res.status,
          event: event.id,
        })
        return false
      }
      return true
    } catch (error) {
      log.warn("push error", { error, event: event.id })
      return false
    }
  }

  private async catchUp(): Promise<void> {
    const url = new URL(`${this.opts.url.replace(/\/$/, "")}/sync/outbox`)
    url.searchParams.set("projectID", this.opts.projectID)
    url.searchParams.set("since", String(this.lastSeq))
    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${this.opts.token}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      throw new Error(`catch-up HTTP ${res.status}`)
    }
    const body = (await res.json()) as {
      events: SyncEventRecord[]
      hasMore: boolean
    }
    for (const event of body.events) {
      this.lastSeq = Math.max(this.lastSeq, event.seq)
      await this.opts.onEvent(event)
    }
    if (body.hasMore) {
      // Recurse to drain remaining pages
      await this.catchUp()
    }
  }

  private subscribe(): void {
    if (this.stopped) return
    const url = new URL(`${this.opts.url.replace(/\/$/, "")}/sync/stream`)
    url.searchParams.set("projectID", this.opts.projectID)

    // EventSource sends credentials as query string only; the token must
    // be passed via a separate header which EventSource does not support.
    // Workaround: append the token as a query param on a TLS-only URL.
    // The server validates the token on every event message.
    url.searchParams.set("token", this.opts.token)

    try {
      this.source = new EventSource(url.toString())
      this.source.addEventListener("sync", (raw) => {
        try {
          const messageEvent = raw as MessageEvent
          const event = JSON.parse(messageEvent.data) as SyncEventRecord
          this.lastSeq = Math.max(this.lastSeq, event.seq)
          void this.opts.onEvent(event)
        } catch (error) {
          log.warn("malformed sync event", { error })
        }
      })
      this.source.addEventListener("error", () => {
        if (this.stopped) return
        this.source?.close()
        this.source = undefined
        this.opts.onError?.(new Error("EventSource error"))
        this.scheduleReconnect()
      })
      this.backoffMs = 1000
    } catch (error) {
      log.warn("subscribe failed", { error })
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffCapMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.catchUp()
        .catch((error) => log.warn("catch-up failed", { error }))
        .finally(() => this.subscribe())
    }, delay)
  }
}
