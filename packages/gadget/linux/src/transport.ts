/**
 * HTTP + SSE client for the gadgets bridge.
 *
 * Node 20 and Bun both ship `fetch` with streaming bodies, so the whole
 * transport is this file: no dependency, no EventSource polyfill. The SSE
 * reader parses `data:` lines itself, because `EventSource` cannot send an
 * `Authorization` header and the bridge refuses `?token=` on purpose — a token
 * in a URL ends up in logs.
 */
import {
  GadgetError,
  ROUTES,
  type DeviceEvent,
  type Frame,
  type Hello,
  type MessageBody,
  type MessageResponse,
  type PairRequest,
  type PairResponse,
  type ResultBody,
} from "./protocol.ts"

export interface TransportOptions {
  readonly server: string
  readonly token?: string
  readonly fetch?: typeof globalThis.fetch
}

/** `s` without trailing slashes. A loop, not a regex: a quantified pattern over input that comes from a config file is a ReDoS finding. */
export function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === "/") end--
  return s.slice(0, end)
}

/** A request that has not answered in this long is a dead connection, not a slow one. */
const REQUEST_TIMEOUT_MS = 15_000
/** The bridge pings every 15 s; three missed pings and the feed is dead. */
export const FEED_IDLE_MS = 45_000

export type FrameHandler = (frame: Frame) => void | Promise<void>

export class Transport {
  readonly server: string
  readonly token: string | undefined
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: TransportOptions) {
    this.server = trimTrailingSlashes(options.server)
    this.token = options.token
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  with(token: string): Transport {
    return new Transport({ server: this.server, token, fetch: this.fetchImpl })
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      accept: "application/json",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    }
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const response = await this.fetchImpl(this.server + path, {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const text = await response.text()
    let parsed: unknown = undefined
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
    }
    if (!response.ok) {
      throw (
        GadgetError.fromBody(parsed) ??
        new Error(`${method} ${path} failed with ${response.status}: ${text.slice(0, 200)}`)
      )
    }
    return parsed as T
  }

  info(signal?: AbortSignal) {
    return this.json<{ name: string; version: string; protocol: number; pairing: boolean }>(
      "GET",
      ROUTES.info,
      undefined,
      signal,
    )
  }

  pair(request: PairRequest, signal?: AbortSignal) {
    return this.json<PairResponse>("POST", ROUTES.pair, request, signal)
  }

  confirm(signal?: AbortSignal) {
    return this.json<{ ok: true }>("POST", ROUTES.pairConfirm, {}, signal)
  }

  hello(id: string, hello: Hello, signal?: AbortSignal) {
    return this.json<{ ok: true }>("PUT", ROUTES.hello(id), hello, signal)
  }

  result(id: string, body: ResultBody, signal?: AbortSignal) {
    return this.json<{ ok: true }>("POST", ROUTES.result(id), body, signal)
  }

  event(id: string, event: DeviceEvent, signal?: AbortSignal) {
    return this.json<{ handled: boolean }>("POST", ROUTES.event(id), event, signal)
  }

  message(id: string, body: MessageBody, signal?: AbortSignal) {
    return this.json<MessageResponse>("POST", ROUTES.message(id), body, signal)
  }

  /**
   * Hold the device's feed open and hand every frame to `onFrame`. Resolves
   * when the bridge closes the stream or `signal` aborts; rejects on a
   * transport failure so the caller can back off and reconnect.
   */
  async feed(id: string, onFrame: FrameHandler, signal?: AbortSignal, idleMs = FEED_IDLE_MS): Promise<void> {
    const response = await this.fetchImpl(this.server + ROUTES.commands(id), {
      method: "GET",
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      throw GadgetError.fromBody(parsed) ?? new Error(`feed failed with ${response.status}: ${text.slice(0, 200)}`)
    }
    if (!response.body) throw new Error("feed response has no body")
    for await (const frame of readFrames(response.body, signal, idleMs)) await onFrame(frame)
  }
}

/** Parse an SSE byte stream into frames. Exported for the bridge's own tests. */
export async function* readFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleMs = 0,
): AsyncGenerator<Frame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const abort = () => void reader.cancel().catch(() => undefined)
  signal?.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      const { value, done } = await readWithin(reader, idleMs)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        let frame: Frame
        try {
          frame = JSON.parse(data) as Frame
        } catch {
          continue
        }
        if (typeof frame === "object" && frame !== null && typeof frame.type === "string") yield frame
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    // A read may still be pending (idle timeout, abort): cancel it so the lock can be released.
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** One read, failing if nothing arrives within `idleMs` (0 = wait forever). The bridge pings, so silence means a dead connection. */
function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number) {
  if (idleMs <= 0) return reader.read()
  let timer: ReturnType<typeof setTimeout> | undefined
  const quiet = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the feed went quiet for ${Math.round(idleMs / 1000)}s`)), idleMs)
  })
  return Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer))
}

/** Bounded exponential backoff with jitter, the same shape nikcli's own clients use. */
export function backoff(attempt: number, baseMs = 1_000, maxMs = 30_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10))
  return Math.floor(exp / 2 + Math.random() * (exp / 2))
}
