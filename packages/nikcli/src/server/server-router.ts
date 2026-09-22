import z from "zod"
import { Flag } from "@nikcli-ai/util/flag"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Session } from "@/session"
import { SessionError } from "@/session/error"
import { Log } from "@nikcli-ai/util/log"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/workspace"
import { WorkspaceContext } from "@/workspace/workspace-context"
import { runPromiseWithLayer, withCurrentInstance, withInstanceAsync } from "@/effect"
import { requestedDirectory } from "./httpapi/instance-less"
import { Effect } from "effect"
import { Provider } from "@/provider/provider"
import { Auth } from "./httpapi/auth"
import { HttpApiBridge } from "./httpapi/bridge"
import { bodyLimitResponse } from "./middleware/body-limit"
import { ServerProxy } from "./proxy"
import { PublicRoutes } from "./public"
import { isInstanceLessPath } from "./httpapi/instance-less"
import { ServerWebSocket, type WebSocketData } from "./websocket"

export namespace ServerRouter {
  const log = Log.create({ service: "server.router" })

  export type Options = {
    readonly fallback: (request: Request) => Promise<Response>
    readonly corsWhitelist?: readonly string[]
    readonly listenHostname?: string
    readonly mobileAuthRequired?: boolean
  }

  export type Fetch = (request: Request, server?: Bun.Server<WebSocketData>) => Promise<Response>

  export function principal(request: Request): Auth.Principal | undefined {
    return Auth.principal(request)
  }

  function sessionIDFromPath(pathname: string) {
    const match = /^\/session\/([^/?#]+)/.exec(pathname)
    if (!match) return
    let value = match[1]
    try {
      value = decodeURIComponent(value)
    } catch {}
    return Session.ID.safeParse(value).success ? value : undefined
  }

  /**
   * The session a `:sessionID` route names, or `undefined` when there is none.
   *
   * "No such session" is a normal outcome — the id may belong to another host,
   * or be a path segment that merely looks like one — and it falls through to
   * request context. A **read failure** is not: a row that will not parse means
   * the store is damaged, and swallowing it would resolve the request against
   * the caller's directory and dispatch a handler there, quietly operating on
   * the wrong instance. Those two used to be the same `catch`.
   *
   * `specs/effect-tui/10-contracts-errors-security.md`: a failure must not be
   * able to look like a success.
   */
  async function sessionForRequest(sessionID: string, directory: string) {
    return withInstanceAsync({ directory, init: InstanceBootstrap }, async () =>
      runPromiseWithLayer(
        Session.defaultLayer,
        withCurrentInstance(
          Effect.gen(function* () {
            const session = yield* Session.Service
            return yield* session.getAnyProject(sessionID)
          }),
        ),
      ),
    ).catch((error: unknown) => {
      if (SessionError.isNotFound(error)) return undefined
      throw error
    })
  }

  /**
   * The workspace an id names, or `undefined` when there is no such workspace.
   *
   * A malformed id and an absent row are both "missing": the caller asked for
   * something that is not there, and the 404 downstream says exactly that. A
   * record that will not parse is a different thing — the row exists and the
   * store is damaged — and answering "no such workspace" for a workspace that
   * is plainly there sends the operator looking in the wrong place.
   *
   * `Workspace.get` validates the id with a zod schema before it reads, so the
   * two cases arrive as different errors and can be told apart here.
   */
  async function workspaceForRequest(id: string) {
    try {
      return await Workspace.get(id)
    } catch (error) {
      if (error instanceof z.ZodError) return undefined
      throw error
    }
  }

  export async function context(request: Request, parsed?: URL) {
    const url = parsed ?? new URL(request.url)
    let directory = requestedDirectory(request, url)
    const sessionID = sessionIDFromPath(url.pathname)
    // The session lookup also derives the workspace; if the caller already
    // pinned one via `?workspace=` or `x-nikcli-workspace`, skip it. Routes
    // that *require* the session lookup still fall through to
    // `sessionForRequest` below (`getAnyProject` is its own short-circuit).
    const explicitWorkspace = url.searchParams.get("workspace") || request.headers.get("x-nikcli-workspace")
    const routeSession = sessionID && !explicitWorkspace ? await sessionForRequest(sessionID, directory) : undefined
    const workspaceID = explicitWorkspace || routeSession?.workspaceID

    // The session's own directory outranks the one the request named, and it
    // has to be applied *before* the workspace branch. A remote target carries
    // no local path, so that branch used to return with `directory` still set
    // to whatever the caller sent — a session pinned to a container resolved
    // against the client's cwd, which is the one directory it is certainly not
    // in. Only a local target overrides it, below.
    if (routeSession?.directory) directory = routeSession.directory

    const workspace = workspaceID ? await workspaceForRequest(workspaceID) : undefined
    if (workspace) {
      const target = await Workspace.target(workspace.id)
      if (target?.type === "local") directory = target.directory
      return { directory, workspaceID: workspaceID ?? undefined, target }
    }
    return { directory, workspaceID: workspaceID ?? undefined, target: undefined }
  }

  /**
   * Host checks compare the parsed hostname, never a prefix of the origin:
   * `startsWith("http://localhost")` also admitted `http://localhost.evil.com`,
   * handing any site under a name like that credentialed read access to a
   * loopback server. A `tailscale*` name is admitted only as a single label —
   * a MagicDNS short name, which no public domain can be.
   */
  function loopbackOrTailnetOrigin(origin: string) {
    const url = URL.parse(origin)
    if (!url || url.protocol !== "http:") return false
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true
    return url.hostname.startsWith("tailscale") && !url.hostname.includes(".")
  }

  function originAllowed(origin: string, options: Options) {
    if (
      loopbackOrTailnetOrigin(origin) ||
      origin.startsWith("http://*.local") ||
      origin === "tauri://localhost" ||
      origin === "capacitor://localhost" ||
      origin.startsWith("exp://") ||
      origin.startsWith("nikcli://")
    )
      return true
    if (
      Flag.NIKCLI_SERVER_TAILSCALE_AUTH &&
      Auth.isLoopbackHostname(options.listenHostname) &&
      /^https:\/\/([a-z0-9-]+\.)*ts\.net(?::\d+)?$/.test(origin)
    )
      return true
    if (/^https:\/\/([a-z0-9-]+\.)*nikcli-ai\.dev$/.test(origin)) return true
    return options.corsWhitelist?.includes(origin) ?? false
  }

  function corsHeaders(request: Request, options: Options): Headers {
    const headers = new Headers()
    const origin = request.headers.get("origin")
    if (origin && originAllowed(origin, options)) {
      headers.set("access-control-allow-origin", origin)
      headers.set("access-control-allow-credentials", "true")
      headers.append("vary", "Origin")
    }
    return headers
  }

  function withCors(response: Response, request: Request, options: Options) {
    const headers = corsHeaders(request, options)
    for (const [key, value] of headers) response.headers.set(key, value)
    return response
  }

  function preflight(request: Request, options: Options) {
    const headers = corsHeaders(request, options)
    headers.set("access-control-allow-headers", "Authorization,Content-Type,x-nikcli-directory,x-nikcli-workspace")
    headers.set("access-control-allow-methods", "GET,HEAD,PUT,POST,DELETE,PATCH")
    return new Response(null, { status: 204, headers })
  }

  function isPtyNotFound(error: unknown): error is { message: string } {
    return (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: unknown })._tag === "PtyNotFoundError" &&
      "message" in error &&
      typeof (error as { message: unknown }).message === "string"
    )
  }

  export function mapError(error: unknown): Response {
    log.error("failed", { error })
    if (typeof error === "object" && error !== null && "__http" in error) {
      const marker = (error as { __http: { status: number; name: string; data: Record<string, unknown> } }).__http
      return Response.json({ name: marker.name, data: marker.data }, { status: marker.status })
    }
    if (error instanceof Session.BusyError) {
      return Response.json(
        { name: error._tag, data: { sessionID: error.sessionID, message: error.message } },
        { status: 409 },
      )
    }
    // The wire name is the literal "NotFoundError", not the error's `_tag` —
    // `SessionError.NotFoundError` is tagged "SessionNotFoundError" and the
    // declared response schemas pin the literal. Pty and Workspace own the
    // same 404 shape after dropping borrowed `Storage.NotFoundError`.
    if (SessionError.isNotFound(error) || error instanceof Workspace.NotFoundError || isPtyNotFound(error)) {
      return Response.json({ name: "NotFoundError", data: { message: error.message } }, { status: 404 })
    }
    if (error instanceof Provider.ModelNotFoundError) {
      return Response.json(
        {
          name: error._tag,
          data: { providerID: error.providerID, modelID: error.modelID, suggestions: error.suggestions },
        },
        { status: 400 },
      )
    }
    if (error instanceof Vcs.PatchApplyError) {
      return Response.json(
        { name: error._tag, data: { message: error.message, reason: error.reason } },
        { status: 400 },
      )
    }
    if (error instanceof Error && error.name.startsWith("Worktree")) {
      return Response.json({ name: error.name, data: { message: error.message } }, { status: 400 })
    }
    if (typeof error === "object" && error !== null && "getResponse" in error) {
      const getResponse = (error as { getResponse?: unknown }).getResponse
      if (typeof getResponse === "function") return getResponse.call(error) as Response
    }
    const isError = error instanceof Error
    return Response.json(
      {
        name: "Unknown",
        data: {
          message: isError ? error.message : String(error),
          ...(process.env.NIKCLI_DEBUG === "1" && isError ? { stack: error.stack } : undefined),
        },
      },
      { status: 500 },
    )
  }

  function isWebSocketUpgrade(request: Request) {
    return request.headers.get("upgrade")?.toLowerCase() === "websocket"
  }

  async function dispatch(
    request: Request,
    options: Options,
    server: Bun.Server<WebSocketData> | undefined,
    url: URL,
  ): Promise<Response> {
    const pathname = url.pathname
    // `/sync/stream` is not a root of its own: one SSE path, served instance-less
    // by `PublicRoutes.globalRequest`, with no sibling under `/sync/`.
    const global = isInstanceLessPath(pathname) || (request.method === "GET" && pathname === "/sync/stream")
    if (global) {
      const raw = await PublicRoutes.globalRequest(request)
      if (raw) return raw
      if (HttpApiBridge.supportsGlobal(pathname, request.method)) {
        return HttpApiBridge.handleGlobal(request, { upstreamAuthVerified: true, pathname })
      }
      return options.fallback(request)
    }

    const resolved = await context(request, url)
    const { workspaceID } = resolved
    let { directory } = resolved
    if (workspaceID) {
      const target = resolved.target
      if (!target) return new Response(`Workspace not found: ${workspaceID}`, { status: 404 })
      if (target.type === "remote") {
        if (isWebSocketUpgrade(request) && server) {
          const failed = ServerWebSocket.upgrade(server, request, ServerProxy.data(target, request))
          if (failed) return failed
          return new Response(null, { status: 101 })
        }
        return ServerProxy.http(target, request)
      }
    }

    return WorkspaceContext.provide({
      workspaceID: workspaceID ?? undefined,
      fn: () =>
        withInstanceAsync({ directory, workspaceID: workspaceID ?? undefined, init: InstanceBootstrap }, async () => {
          if (isWebSocketUpgrade(request) && server) {
            const match = ServerWebSocket.match(pathname)
            if (match) {
              const failed = ServerWebSocket.upgrade(server, request, {
                type: "pty",
                ptyID: match.ptyID,
                directory,
                workspaceID: workspaceID ?? undefined,
              })
              if (failed) return failed
              return new Response(null, { status: 101 })
            }
          }
          const raw = await PublicRoutes.instanceRequest(request)
          if (raw) return raw
          if (HttpApiBridge.supports(pathname, request.method)) {
            return HttpApiBridge.handle(request, { upstreamAuthVerified: true, pathname })
          }
          return options.fallback(request)
        }),
    })
  }

  /**
   * Paths a connected client polls or holds open continuously, which would
   * otherwise account for most lines in the log while carrying no information
   * (P2.2). They are quiet only while they are fast and successful — see
   * `logCompletion`.
   */
  const HOT_PATHS = new Set(["/event", "/session/status"])

  /** A quiet path that takes at least this long is logged anyway. */
  const SLOW_REQUEST_MS = 250

  /**
   * Whether to log a finished request.
   *
   * Deterministic, not sampled: the same request logs the same way every time,
   * so a reproduction does not depend on which side of a sample it fell. The
   * policy can only ever suppress a *fast, successful* hot-path poll — a
   * failure, a thrown error (no response), or a slow poll still logs, which is
   * the point: the noise goes, the evidence stays.
   */
  function logCompletion(pathname: string, response: Response | undefined, duration: number) {
    if (pathname === "/log") return false
    if (!HOT_PATHS.has(pathname)) return true
    if (response === undefined || response.status >= 400) return true
    return duration >= SLOW_REQUEST_MS
  }

  export function make(options: Options): Fetch {
    return async (request, server) => {
      // Two ways a request can be this machine's operator. No `Bun.Server`
      // means no socket at all: `Server.fetch` called from inside the process
      // (the TUI worker, the CLI, plugins, sdk-next). A loopback-bound listener
      // qualifies only once the caller satisfies the server's own credential —
      // the background service's terminal does; another local user, or a page
      // in a browser, reaches the same socket without it.
      //
      // Checking the *listener*, not the peer address, is deliberate: a
      // non-loopback listener never qualifies, so nothing a remote caller puts
      // in a header or a forwarded address can buy this. What it grants is
      // `Auth.sessionFor` answering with the account this machine is signed
      // into, which is why it must follow the credential and not the socket.
      if (
        !server ||
        (Auth.isLoopbackHostname(options.listenHostname) &&
          Auth.serverAdmission(request, { listenHostname: options.listenHostname }) === "admitted")
      ) {
        Auth.markLocal(request)
      }
      const limited = bodyLimitResponse(request)
      if (limited) return withCors(limited, request, options)
      if (request.method === "OPTIONS") return preflight(request, options)
      const started = performance.now()
      const url = new URL(request.url)
      const pathname = url.pathname
      // The start line cannot know the outcome, so a hot path never logs one;
      // its completion line carries the same method and path anyway.
      if (pathname !== "/log" && !HOT_PATHS.has(pathname)) {
        log.info("request", { method: request.method, path: pathname })
      }
      let response: Response | undefined
      try {
        const publicResponse = await PublicRoutes.publicRequest(request)
        if (publicResponse) return (response = withCors(publicResponse, request, options))
        const auth = await Auth.authenticate(request, {
          mobileAuthRequired: options.mobileAuthRequired,
          listenHostname: options.listenHostname,
        })
        if (!auth.ok && !Auth.isPublicPath(request.method, pathname))
          return (response = withCors(auth.response, request, options))
        if (auth.ok) Auth.remember(request, auth.principal)
        return (response = withCors(await dispatch(request, options, server, url), request, options))
      } catch (error) {
        return (response = withCors(mapError(error), request, options))
      } finally {
        const duration = performance.now() - started
        if (logCompletion(pathname, response, duration)) {
          log.info("request completed", {
            method: request.method,
            path: pathname,
            duration,
          })
        }
      }
    }
  }
}
