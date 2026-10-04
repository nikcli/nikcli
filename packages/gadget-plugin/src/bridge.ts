/**
 * The gadgets bridge: HTTP and server-sent events in front of the registry.
 *
 * It listens on its own port (4097 by default), not on the nikcli server's:
 * devices must never be able to reach the operator's API, and the operator's
 * API must never have to trust a device. The only unauthenticated routes are
 * `GET /` and `POST /pair`, and `/pair` needs the code nikcli printed.
 * Everything under `/admin` answers loopback callers only, which is how the
 * TUI plugin and nothing else reaches it.
 */
import { networkInterfaces } from "node:os"
import {
  GadgetError,
  LIMITS,
  PROTOCOL_VERSION,
  type DeviceEvent,
  type Frame,
  type GadgetInfo,
  type HealthInfo,
  type InvokeRequest,
  type MessageBody,
  type PairRequest,
} from "@nikcli-ai/gadget/protocol"
import { Registry, type Feed } from "./registry.ts"

export const BRIDGE_NAME = "nikcli-gadgets"
export const BRIDGE_VERSION = "1.427.0"
export const DEFAULT_PORT = 4097

/** What the host nikcli instance does for a device: start a session, answer a press. */
export interface BridgeHooks {
  message(device: GadgetInfo, text: string, sessionID?: string): Promise<string>
  press(device: GadgetInfo, event: DeviceEvent): Promise<{ handled: boolean }>
}

export interface BridgeOptions {
  readonly port?: number
  readonly host?: string
  /** Paired devices live here. Absent keeps them in memory (tests). */
  readonly file?: string
  /** Called for messages and presses; the plugin supplies it from the running instance. */
  readonly hooks?: () => BridgeHooks | undefined
  readonly log?: (message: string) => void
}

const encoder = new TextEncoder()

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  })
}

function failure(error: unknown, log: (message: string) => void): Response {
  if (error instanceof GadgetError) {
    return json(
      error.toJSON(),
      error.status,
      error.retryAfterMs ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) } : undefined,
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  log(`unhandled error: ${message}`)
  return json({ error: { name: "GadgetError.BadRequest", tag: "BadRequest", message: "internal error" } }, 500)
}

async function readJson<T>(request: Request): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > LIMITS.MAX_BODY_BYTES)
    throw new GadgetError("PayloadTooLarge", `body larger than ${LIMITS.MAX_BODY_BYTES} bytes`)
  const text = await request.text()
  if (Buffer.byteLength(text) > LIMITS.MAX_BODY_BYTES)
    throw new GadgetError("PayloadTooLarge", `body larger than ${LIMITS.MAX_BODY_BYTES} bytes`)
  if (!text.trim()) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new GadgetError("BadRequest", "body is not valid JSON")
  }
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization")
  if (!header) return undefined
  const space = header.indexOf(" ")
  if (space < 0 || header.slice(0, space).toLowerCase() !== "bearer") return undefined
  const token = header.slice(space + 1).trim()
  return token && !/\s/.test(token) ? token : undefined
}

/** Interfaces a LAN device can be reached through; docker0, veth*, br-*, virbr*, tun*, tap* and wg* are not. */
const LAN_INTERFACE = /^(en|eth|wl|ww)/

/**
 * The address a pairing prints for the device to connect to: the first IPv4
 * address of a physical interface, else any non-internal one, else loopback.
 * The first non-internal address on a developer machine is often Docker's
 * 172.17.0.1, which no other machine can reach.
 */
export function lanAddress(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string {
  let fallback: string | undefined
  for (const [name, list] of Object.entries(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.family !== "IPv4" || iface.internal) continue
      if (LAN_INTERFACE.test(name)) return iface.address
      fallback ??= iface.address
    }
  }
  return fallback ?? "127.0.0.1"
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

export class Bridge {
  readonly registry: Registry
  private server: ReturnType<typeof Bun.serve> | undefined
  private pinger: ReturnType<typeof setInterval> | undefined
  private readonly options: BridgeOptions
  private readonly log: (message: string) => void
  private lastError: string | undefined

  constructor(options: BridgeOptions = {}) {
    this.options = options
    this.log = options.log ?? ((message) => console.error(`[nikcli-gadgets] ${message}`))
    this.registry = new Registry({ file: options.file, url: () => this.url })
  }

  get port(): number {
    return this.server?.port ?? this.options.port ?? DEFAULT_PORT
  }

  get url(): string {
    const bound =
      this.options.host && this.options.host !== "0.0.0.0" && this.options.host !== "::" ? this.options.host : undefined
    const host = bound ?? lanAddress()
    return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${this.port}`
  }

  get listening(): boolean {
    return this.server !== undefined
  }

  /** Why the listener is not up, when it is not. */
  get problem(): string | undefined {
    return this.lastError
  }

  /** Start listening. Returns false (and records why) when the port is taken. */
  start(): boolean {
    if (this.server) return true
    try {
      this.server = Bun.serve({
        port: this.options.port ?? DEFAULT_PORT,
        hostname: this.options.host ?? "0.0.0.0",
        // Feeds are long-lived; the 15 s ping below keeps them inside this budget.
        idleTimeout: 120,
        fetch: (request, server) => {
          const address = server.requestIP(request)?.address
          const proxied = request.headers.has("x-forwarded-for") || request.headers.has("forwarded")
          return this.handle(request, address !== undefined && LOOPBACK.has(address) && !proxied)
        },
      })
      this.lastError = undefined
      this.pinger = setInterval(() => this.registry.ping(), LIMITS.PING_INTERVAL_MS)
      this.pinger.unref?.()
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  stop() {
    if (this.pinger) clearInterval(this.pinger)
    this.pinger = undefined
    this.registry.shutdown()
    this.server?.stop(true)
    this.server = undefined
  }

  /** Route one request. `local` is whether it came from this machine without a proxy. */
  async handle(request: Request, local: boolean): Promise<Response> {
    try {
      const url = new URL(request.url)
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
      const method = request.method.toUpperCase()

      if (parts.length === 0 && method === "GET") {
        return json({
          name: BRIDGE_NAME,
          version: BRIDGE_VERSION,
          protocol: PROTOCOL_VERSION,
          pairing: this.registry.pairing.open,
        })
      }
      if (parts[0] === "pair" && parts.length === 1 && method === "POST") {
        return json(this.registry.pair(await readJson<PairRequest>(request)))
      }
      if (parts[0] === "pair" && parts[1] === "confirm" && method === "POST") {
        const device = this.registry.authenticate(bearer(request))
        this.registry.confirm(device.id)
        return json({ ok: true })
      }
      if (parts[0] === "devices" && parts.length === 3) return await this.device(request, parts[1]!, parts[2]!, method)
      if (parts[0] === "admin") {
        if (!local) throw new GadgetError("Denied", "the admin routes answer callers on this machine only")
        this.refuseBrowsers(request)
        return await this.admin(request, parts.slice(1), method)
      }
      return json(
        {
          error: {
            name: "GadgetError.BadRequest",
            tag: "BadRequest",
            message: `no route for ${method} ${url.pathname}`,
          },
        },
        404,
      )
    } catch (error) {
      return failure(error, this.log)
    }
  }

  // --------------------------------------------------------------- devices

  private async device(request: Request, id: string, action: string, method: string): Promise<Response> {
    const record = this.registry.authenticate(bearer(request))
    if (record.id !== id) throw new GadgetError("Denied", "this token belongs to another gadget")
    // A device that has not pressed its button is not yet trusted with anything: not hello, not the feed, and not a session either.
    if (!record.confirmed) throw new GadgetError("Unconfirmed", "press the gadget's button to finish pairing first")
    switch (`${method} ${action}`) {
      case "PUT hello": {
        this.registry.hello(id, await readJson(request))
        return json({ ok: true })
      }
      case "GET commands":
        return this.feed(id)
      case "POST result": {
        const body = await readJson<{
          callID?: unknown
          output?: unknown
          exitCode?: unknown
          isError?: unknown
          truncated?: unknown
        }>(request)
        if (typeof body.callID !== "string") throw new GadgetError("BadRequest", "callID is required")
        this.registry.result(id, {
          callID: body.callID,
          output: typeof body.output === "string" ? body.output : "",
          ...(typeof body.exitCode === "number" ? { exitCode: body.exitCode } : {}),
          isError: body.isError === true,
          truncated: body.truncated === true,
        })
        return json({ ok: true })
      }
      case "POST event": {
        const body = await readJson<Partial<DeviceEvent>>(request)
        if ((body.kind !== "press" && body.kind !== "input") || typeof body.key !== "string" || !body.key) {
          throw new GadgetError("BadRequest", "event needs kind press|input and a key")
        }
        const hooks = this.options.hooks?.()
        if (!hooks) return json({ handled: false })
        const handled = await hooks.press(this.registry.get(id), {
          kind: body.kind,
          key: body.key,
          ...(typeof body.value === "string" ? { value: body.value } : {}),
        })
        return json(handled)
      }
      case "POST message": {
        const body = await readJson<Partial<MessageBody>>(request)
        if (typeof body.text !== "string") throw new GadgetError("BadRequest", "text is required")
        this.registry.admitMessage(id, body.text)
        const requested = typeof body.sessionID === "string" ? body.sessionID : undefined
        if (requested !== undefined && !this.registry.ownsSession(id, requested)) {
          throw new GadgetError("Denied", "a gadget can continue only the sessions it started")
        }
        const hooks = this.options.hooks?.()
        if (!hooks) throw new GadgetError("Offline", "no nikcli instance is ready to take messages yet")
        const sessionID = await hooks.message(this.registry.get(id), body.text, requested)
        this.registry.rememberSession(id, sessionID)
        return json({ sessionID }, 202)
      }
      default:
        throw new GadgetError("BadRequest", `no route for ${method} /devices/${id}/${action}`)
    }
  }

  private feed(id: string): Response {
    let detach: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          const feed: Feed = {
            send(frame: Frame) {
              // A full queue means the reader is `FEED_LAG_FRAMES` behind: refuse, and the registry evicts it.
              if (controller.desiredSize !== null && controller.desiredSize <= 0) return false
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
                return true
              } catch {
                return false
              }
            },
            close(reason: string) {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "bye", reason })}\n\n`))
              } catch {
                // Full or closed: the goodbye is a courtesy.
              }
              try {
                controller.close()
              } catch {
                // Already closed.
              }
            },
          }
          detach = this.registry.attach(id, feed)
        },
        cancel: () => detach?.(),
      },
      { highWaterMark: LIMITS.FEED_LAG_FRAMES },
    )
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    })
  }

  // ----------------------------------------------------------------- admin

  /**
   * A loopback source address is not proof the caller is the operator: any web
   * page the operator opens can send a request from their browser to
   * 127.0.0.1, and a DNS-rebinding page can do it under its own hostname. The
   * admin routes drive devices, so they refuse what a browser sends: a request
   * with an `Origin` header, a `Host` that is not a loopback name, or a body
   * that is not JSON (the only kind a page can send without a preflight is
   * not). The TUI and the CLI send none of those.
   */
  private refuseBrowsers(request: Request) {
    if (request.headers.has("origin")) {
      throw new GadgetError("Denied", "the admin routes do not answer browsers")
    }
    const host = request.headers.get("host")
    if (host !== null && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(host)) {
      throw new GadgetError("Denied", "the admin routes answer only under a loopback host name")
    }
    const hasBody = Number(request.headers.get("content-length") ?? "0") > 0
    const type = request.headers.get("content-type") ?? ""
    if (hasBody && !/^application\/json\b/i.test(type)) {
      throw new GadgetError("BadRequest", "admin requests with a body must be application/json")
    }
  }

  private async admin(request: Request, parts: string[], method: string): Promise<Response> {
    if (parts[0] === "pair" && method === "POST") return json(this.registry.openPairing())
    if (parts[0] !== "devices")
      throw new GadgetError("BadRequest", `no admin route for ${method} /admin/${parts.join("/")}`)
    if (parts.length === 1 && method === "GET") return json(this.registry.list())
    const id = parts[1]
    if (!id) throw new GadgetError("BadRequest", "device id is required")
    if (parts.length === 2 && method === "GET") return json(this.registry.get(id))
    if (parts.length === 2 && method === "DELETE") {
      this.registry.revoke(id)
      return json({ ok: true })
    }
    const action = parts[2]
    if (action === "message" && method === "POST") {
      const body = await readJson<{ text?: unknown; sessionID?: unknown }>(request)
      if (typeof body.text !== "string" || !body.text) throw new GadgetError("BadRequest", "text is required")
      this.registry.tell(id, body.text, typeof body.sessionID === "string" ? body.sessionID : undefined)
      return json({ ok: true })
    }
    if (action === "health" && method === "GET") {
      const result = await this.registry.invoke(id, { command: "device.health" })
      if (result.isError) throw new GadgetError("BadRequest", result.output || "device.health failed")
      return json(JSON.parse(result.output) as HealthInfo)
    }
    throw new GadgetError("BadRequest", `no admin route for ${method} /admin/${parts.join("/")}`)
  }
}
