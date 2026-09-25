import { AnalyticsShare } from "@/analytics/share"
import { runPromiseWithLayer } from "@/effect"
import { Flag } from "@nikcli-ai/util/flag"
import { bunUtils, onMemoryPressure } from "@/bun"
import { Installation } from "@/installation"
import { Project } from "@/project/project"
import { Workspace } from "@/workspace"
import { Effect } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { Log } from "@nikcli-ai/util/log"
import { HttpApiBridge } from "./httpapi/bridge"
import { isInstanceLessPath } from "./httpapi/instance-less"
import { PublicApi } from "./httpapi/public"
import { MDNS } from "./mdns"
import { PublicRoutes } from "./public"
import { ServerRouter } from "./server-router"
import { Auth } from "./httpapi/auth"
import { BackgroundService } from "@/service/service"
import { ServerWebSocket, type WebSocketData } from "./websocket"

// @ts-ignore This global prevents ai-sdk warnings from corrupting stdout.
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace Server {
  const log = Log.create({ service: "server" })
  const STOP_DRAIN_MS = 3000
  let memoryPressureBound = false

  let _url: URL | undefined
  /**
   * The LAN pairing listener's default port, one above the engine's 4096 so the
   * two never contend. Fixed on purpose: it is the port that ends up in the
   * pairing QR and in the firewall rule the user writes for it.
   */
  export const MOBILE_PORT = 4097

  let _corsWhitelist: string[] = []
  let _listenHostname: string | undefined
  let _mobileAuthRequired = false
  let requestHandler: ServerRouter.Fetch | undefined

  function isLoopbackHostname(hostname: string | undefined) {
    if (!hostname) return false
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
  }

  export function url(): URL {
    return _url ?? new URL("http://localhost:4096")
  }

  async function fallback(request: Request) {
    const pathname = new URL(request.url).pathname
    const response = isInstanceLessPath(pathname)
      ? await HttpApiBridge.handleGlobal(request, { upstreamAuthVerified: true, pathname })
      : await HttpApiBridge.handle(request, { upstreamAuthVerified: true, pathname })
    if (response.status !== 404) return response
    if (pathname.startsWith("/mobile/") || pathname === "/mobile") return response
    return PublicRoutes.proxy(request)
  }

  function pipeline() {
    return (requestHandler ??= ServerRouter.make({
      fallback,
      corsWhitelist: _corsWhitelist,
      listenHostname: _listenHostname,
      mobileAuthRequired: _mobileAuthRequired,
    }))
  }

  export function fetch(request: Request): Promise<Response> {
    return pipeline()(request)
  }

  /**
   * `fetch(input, init)` served in-process, for SDK clients inside this process.
   *
   * The SDK calls `fetch(url, init)`; `fetch` above takes one Request, and
   * passing the arguments straight through dropped `init` and handed the router
   * a bare URL. The request still crosses the router, so it presents the
   * credentials this server requires, by the same rule as every other client
   * (`BackgroundService.withCredentials`).
   */
  export const localFetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const authorization = Auth.authorizationHeader()
      if (!authorization) return pipeline()(request)
      const target = new URL(request.url)
      BackgroundService.withCredentials(target, request.headers, authorization)
      // Rebuilt only when a bearer moved into `?token=`; copying the request
      // keeps its body and its abort signal.
      return pipeline()(target.href === request.url ? request : new Request(target, request))
    },
    { preconnect: () => undefined },
  )

  export function openapi() {
    return Promise.resolve(OpenApi.fromApi(PublicApi))
  }

  export function listen(opts: {
    port: number
    hostname: string
    mdns?: boolean
    cors?: string[]
    mobileAuthRequired?: boolean
  }) {
    const envCors = process.env.NIKCLI_SERVER_CORS_ORIGINS
      ? process.env.NIKCLI_SERVER_CORS_ORIGINS.split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : []
    _corsWhitelist = [...(opts.cors ?? []), ...envCors]
    _listenHostname = opts.hostname
    _mobileAuthRequired = opts.mobileAuthRequired ?? false
    requestHandler = undefined

    if (Flag.NIKCLI_SERVER_TAILSCALE_AUTH && !isLoopbackHostname(opts.hostname)) {
      log.warn("tailscale auth enabled but server is not bound to loopback; refusing to trust identity headers", {
        hostname: opts.hostname,
      })
    }

    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      maxRequestBodySize: Flag.NIKCLI_SERVER_MAX_BODY ?? 2 * 1024 * 1024 * 1024,
      fetch: (request: Request, server: Bun.Server<WebSocketData>) => pipeline()(request, server),
      websocket: ServerWebSocket.handlers,
    }
    const tryServe = (port: number) => {
      try {
        return Bun.serve<WebSocketData>({ ...args, port })
      } catch {
        return undefined
      }
    }

    let server: ReturnType<typeof Bun.serve> | undefined
    if (opts.port === 0) {
      server = tryServe(4096) ?? tryServe(0)
    } else {
      server = tryServe(opts.port)
      if (!server) {
        log.warn(`port ${opts.port} is in use; falling back to an ephemeral port`, { hostname: opts.hostname })
        server = tryServe(0)
      }
    }
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    _url = server.url
    AnalyticsShare.start()
    if (!memoryPressureBound) {
      memoryPressureBound = true
      onMemoryPressure(() => {
        log.warn("os memory pressure")
        bunUtils.gc?.(true)
      })
    }

    const port = server.port
    const shouldPublishMDNS = Boolean(opts.mdns && port && !isLoopbackHostname(opts.hostname))
    if (shouldPublishMDNS && port) MDNS.publish(port)
    else if (opts.mdns) log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")

    if (Installation.isLocal()) {
      void runPromiseWithLayer(
        Project.defaultLayer,
        Effect.gen(function* () {
          const project = yield* Project.Service
          return yield* project.list()
        }),
      )
        .then((projects) => projects.forEach((project) => Workspace.startSyncing(project)))
        .catch((error) => log.warn("failed to start workspace syncing", { error }))
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      Workspace.stopAllSyncing()
      if (closeActiveConnections) return originalStop(true)

      const idle = server as typeof server & { closeIdleConnections?: () => void }
      idle.closeIdleConnections?.()

      let drained = false
      const drain = Promise.resolve(originalStop())
        .then(() => {
          drained = true
        })
        .catch(() => {
          drained = true
        })
      await Promise.race([drain, Bun.sleep(STOP_DRAIN_MS)])
      if (drained) return
      log.warn("graceful shutdown timed out; closing active connections", { ms: STOP_DRAIN_MS })
      await originalStop(true).catch(() => undefined)
    }

    return server
  }

  /**
   * The extra, token-gated listener a phone pairs against.
   *
   * A separate socket *and* a separate router, on purpose. `mobileAuthRequired`
   * used to be flipped on the process-wide pipeline, which reaches every local
   * client too: the TUI talks to this same engine without a mobile token, so
   * turning the flag on globally answered 401 to the editor that had just asked
   * for a pairing link. Here only requests arriving on the LAN socket are held
   * to a mobile token; the loopback listener keeps its own rules.
   *
   * Idempotent: pairing again (or from a second client) reuses the listener
   * that is already bound, so the QR code a phone already scanned keeps working.
   */
  export interface MobileListener {
    readonly url: string
    readonly hostname: string
    readonly port: number
  }

  let mobileServer: Bun.Server<WebSocketData> | undefined
  let mobileListener: MobileListener | undefined
  let mobileMDNS = false

  export function mobile(): MobileListener | undefined {
    return mobileListener
  }

  /** Closes the pairing listener, if one is bound. `false` when there was none. */
  export async function stopMobile(): Promise<boolean> {
    const server = mobileServer
    if (!server) return false
    mobileServer = undefined
    mobileListener = undefined
    // Only our own record: the main listener publishes and retracts its own.
    if (mobileMDNS) MDNS.unpublish()
    mobileMDNS = false
    await server.stop(true).catch(() => undefined)
    return true
  }

  export function listenMobile(opts: { hostname?: string; port?: number; mdns?: boolean } = {}): MobileListener {
    if (mobileListener) return mobileListener

    const hostname = opts.hostname ?? "0.0.0.0"
    const handler = ServerRouter.make({
      fallback,
      corsWhitelist: _corsWhitelist,
      listenHostname: hostname,
      mobileAuthRequired: true,
    })
    const args = {
      hostname,
      idleTimeout: 0,
      maxRequestBodySize: Flag.NIKCLI_SERVER_MAX_BODY ?? 2 * 1024 * 1024 * 1024,
      fetch: (request: Request, bound: Bun.Server<WebSocketData>) => handler(request, bound),
      websocket: ServerWebSocket.handlers,
    }
    const tryServe = (candidate: number) => {
      try {
        return Bun.serve<WebSocketData>({ ...args, port: candidate })
      } catch {
        return undefined
      }
    }
    // An ephemeral port meant the pairing QR carried a different port on every
    // restart, so the firewall rule the user had just written for it stopped
    // matching and the saved server URL in the app went stale. Prefer a fixed
    // one — and still fall back rather than fail, because a listener on an
    // unexpected port can at least be paired with, while none cannot.
    const wanted = opts.port ?? MOBILE_PORT
    let server = tryServe(wanted)
    if (!server) {
      log.warn(`port ${wanted} is in use; the pairing link will carry an ephemeral port`, { hostname })
      server = tryServe(0)
    }
    if (!server) throw new Error(`Failed to start the mobile listener on port ${wanted}`)
    const port = server.port
    if (!port) {
      void server.stop(true)
      throw new Error("the mobile listener did not bind a TCP port")
    }

    mobileMDNS = Boolean(opts.mdns) && !isLoopbackHostname(hostname)
    if (mobileMDNS) MDNS.publish(port)
    const listener: MobileListener = { url: `http://${hostname}:${port}`, hostname, port }
    mobileServer = server
    mobileListener = listener
    log.info("mobile listener started", listener)
    return listener
  }

  export async function ready(server: ReturnType<typeof listen>, timeoutMs = 5000) {
    const bound = server.hostname ?? "127.0.0.1"
    const host = bound === "0.0.0.0" || bound === "::" ? "127.0.0.1" : bound
    const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
    const target = `http://${authority}:${server.port}/global/health`
    const password = Flag.NIKCLI_SERVER_PASSWORD?.trim()
    const username = Flag.NIKCLI_SERVER_USERNAME?.trim() || "nikcli"
    const headers = password
      ? { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
      : undefined

    const deadline = Date.now() + timeoutMs
    let last: unknown
    for (;;) {
      try {
        const response = await globalThis.fetch(target, { headers, signal: AbortSignal.timeout(1000) })
        if (response.ok) return
        last = new Error(`health check returned ${response.status}`)
      } catch (error) {
        last = error
      }
      if (Date.now() >= deadline) break
      await Bun.sleep(50)
    }
    throw new Error(`server did not become ready within ${timeoutMs}ms`, { cause: last })
  }
}
