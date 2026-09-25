import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { BunFileSystem, BunHttpServer, BunPath } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import { InstanceRef, InstanceState, LogRedirect, sharedMemoMap } from "@/effect"
import { ChatbotHttp } from "./chatbot"
import { HttpApiEvent } from "./event"
import { HttpApiPrompt } from "./prompt"
import { PublicApi, PublicHttpApi } from "./public"
import { rawGlobalHandlers } from "./global-handlers"
import { instanceLessRoot, isInstanceLessPath } from "./instance-less"
import { Auth } from "./auth"

export namespace HttpApiBridge {
  /**
   * Test-only seam for the auth check. Delegates to `Auth.overrideCredentials`,
   * which is where the state lives now that the HttpApi security middleware
   * has to see the same substitution (H8); this stays as the name the existing
   * tests call.
   */
  export function overrideAuth(creds: Auth.Credentials | null) {
    Auth.overrideCredentials(creds)
  }

  /**
   * Machine-readable route table for coverage checks.
   * `pattern` is the RegExp source (no flags). Prefer updating this list
   * whenever a new HttpApi surface lands; `script/check-route-coverage.ts`
   * and `test/server/routes-coverage.test.ts` assert every entry still
   * matches via `supports` / `supportsGlobal`.
   */
  export type RoutePattern = {
    readonly method: string
    readonly pattern: string
    readonly scope: "main" | "global"
  }

  /**
   * Convert an OpenAPI path template (`/session/{sessionID}/message`) into a
   * matchable RegExp (`/^\/session\/[^/]+\/message$/`). The template uses
   * `{name}` for path params; everything else is literal. `/` is matched
   * literally — name segments are `[^/]+` so a deep path stays that way.
   *
   * Special cases: a trailing `/?` mirrors the Hono-era routes that accept
   * the path with or without a trailing slash (still rare in the served
   * surface, kept only where the contract already allowed it).
   */
  function pathToRegex(template: string): RegExp {
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const substituted = escaped.replace(/\\\{[^/]+?\\\}/g, "[^/]+")
    return new RegExp(`^${substituted}$`)
  }

  /**
   * Walks the OpenAPI spec produced by `OpenApi.fromApi(PublicApi)` once at
   * module load. The pre-router allowlist cannot drift from the contract: a
   * new endpoint without a regex here fails at module load (because the
   * returned `Map` covers it), and the spec covers every route the bridge
   * serves. The traversal mirrors `inventory.ts:routes` so the two stay
   * aligned. Manual entries for non-OpenAPI surface (SSE / mobile prefix
   * match / `/sync/stream`) are appended afterwards.
   */
  /**
   * `/global/*` and `/user/*` are served by `handleGlobal`, before instance
   * context is bound, so they belong to `globalRoutes` and must stay out of
   * the instance table.
   */
  /**
   * Which contract paths are served before an instance is bound.
   *
   * This was a fourth hand-written spelling of the set `instance-less.ts` exists to hold — and it had
   * already drifted, listing `global|user` while the table also carried `/account`. It asks the table
   * now, so a root added there cannot be missed here.
   */
  const isInstanceLessRoute = (path: string) => isInstanceLessPath(path)

  /**
   * `GET /pty/{ptyID}/connect` is a WebSocket upgrade. It is declared on
   * `PublicApi` so the public OpenAPI carries the path, but it is not an HTTP
   * route the bridge serves — advertising it here would route the upgrade
   * into the HTTP handler instead of the WS server.
   */
  const WEBSOCKET_UPGRADE_PATH = /^\/pty\/[^/]+\/connect$/

  function routesFromPublicApi(
    api: typeof PublicApi,
    include?: (path: string) => boolean,
  ): ReadonlyArray<readonly [string, RegExp]> {
    const spec = OpenApi.fromApi(api)
    const verbMethods = ["get", "post", "put", "delete", "patch"] as const
    const result: Array<readonly [string, RegExp]> = []
    const paths = spec.paths ?? {}
    for (const [path, item] of Object.entries(paths)) {
      if (include && !include(path)) continue
      const re = pathToRegex(path)
      for (const method of verbMethods) {
        if (item?.[method]) result.push([method.toUpperCase(), re])
      }
    }
    return result
  }

  /**
   * Routes served by the bridge that are not in `PublicApi`:
   *
   * - `/event` and `/global/event` — SSE streams, kept as raw handlers
   *   because the contract declares them as `StreamSse` (a different
   *   response shape from a normal handler).
   * - `/sync/stream` — single SSE, served by `PublicRoutes.globalRequest`.
   * - `/sync/stats` and `/sync/{connect,disconnect,drain}` — served raw,
   *   declared in `ContractExtra`. Covered by the OpenAPI walk, but the
   *   generator catches them too.
   * - `/mobile/*` — a 404 under `/mobile/*` must not fall through to the
   *   website proxy (that was returning 200 HTML for deleted loops). The
   *   OpenAPI generator emits per-method regexes; the prefix match catches
   *   the methods it does not. Kept as a manual entry.
   * - `/sync/stats` — covered above; the regex + verb walk produces it.
   */
  const extraImplementedRoutes: ReadonlyArray<readonly [string, RegExp]> = [
    // `POST /chatbot/:platform/:bot` — webhook receivers served by
    // `ChatbotHttp.handle`, which is not on `PublicApi` (the contract only
    // describes `/chatbot/bots*`). The platform alternation comes from the
    // handler's own list so the two cannot drift: an unknown platform must
    // stay unsupported here, exactly as the handler rejects it.
    ["POST", new RegExp(`^\\/chatbot\\/(${ChatbotHttp.PLATFORMS.join("|")})\\/[^/]+$`)],
    // Prefix match for any `/mobile/*` path that the OpenAPI walk missed.
    ["GET", /^\/mobile\//],
    ["POST", /^\/mobile\//],
    ["PUT", /^\/mobile\//],
    ["PATCH", /^\/mobile\//],
    ["DELETE", /^\/mobile\//],
  ]

  const generatedRoutes = routesFromPublicApi(
    PublicApi,
    (path) => !isInstanceLessRoute(path) && !WEBSOCKET_UPGRADE_PATH.test(path.replace(/\{[^}]+\}/g, "x")),
  )
  const implementedRoutes = [...generatedRoutes, ...extraImplementedRoutes] as const

  /**
   * Instance-less routes served before instance context is bound. These must
   * never require `InstanceRef` — they run outside the instance/workspace
   * middleware, so `handleGlobal` provides no instance context.
   *
   * `/account` is not on `PublicApi` yet (it lives on the raw
   * `AccountHttp.handle` dispatcher ahead of the router), so it is the only
   * hand-rolled entry here. After H4 lands, this becomes a second call to
   * `routesFromPublicApi` against the account group.
   */
  const globalRoutes = [
    // Filter on the OpenAPI path, not on `pattern.source`: the source starts
    // with `^` and carries escaped slashes (`^\/user\/status$`), so the old
    // path-shaped test never matched and this list silently collapsed to the
    // three hand-rolled account entries below.
    ...routesFromPublicApi(PublicApi, (path) => isInstanceLessRoute(path)),
    // `/user/*` is raw (`UsersHttp`), and the contract only describes three of
    // the nine paths it serves — `status`, `me`, `logout`, `list` and the
    // delete are undeclared. A prefix entry keeps the branch honest with
    // `INSTANCE_LESS_ROOTS` in instance-less.ts, which already claims the whole
    // root, instead of drifting one path at a time.
    ["GET", /^\/user\//],
    ["POST", /^\/user\//],
    ["PATCH", /^\/user\//],
    ["DELETE", /^\/user\//],
    ["GET", /^\/account$/],
    ["POST", /^\/account\/login$/],
    ["POST", /^\/account\/login\/complete$/],
  ] as const

  /**
   * Method-grouped lookup derived from the flat route lists above, built once
   * at module load. `supports` runs on every request before the fallback
   * decision (see `ServerRouter.dispatch`), so the flat `.some()` over ~215
   * entries is avoided: only the bucket for the request method is scanned.
   */
  function groupByMethod(routes: ReadonlyArray<readonly [string, RegExp]>) {
    const byMethod = new Map<string, RegExp[]>()
    for (const [method, pattern] of routes) {
      const list = byMethod.get(method)
      if (list) list.push(pattern)
      else byMethod.set(method, [pattern])
    }
    return byMethod
  }

  const implementedByMethod = groupByMethod(implementedRoutes)
  const globalByMethod = groupByMethod(globalRoutes)

  /** Snapshot of bridge route patterns for coverage scripts/tests. */
  export function listImplemented(): RoutePattern[] {
    return [
      ...implementedRoutes.map(([method, pattern]) => ({
        method,
        pattern: pattern.source,
        scope: "main" as const,
      })),
      ...globalRoutes.map(([method, pattern]) => ({
        method,
        pattern: pattern.source,
        scope: "global" as const,
      })),
    ]
  }

  /**
   * Build a concrete sample path that matches `pattern` so `supports`
   * can be exercised without hand-writing fixtures for every route.
   * Replaces `[^/]+` / `.+` style segments with `x`, and `(a|b)` with `a`.
   */
  export function samplePathFor(patternSource: string): string {
    const filled = patternSource
      .replace(/^\^/, "")
      .replace(/\$$/, "")
      .replace(/\\\//g, "/")
      .replace(/\(\?:/g, "(")
      .replace(/\([^)]+\)/g, (group) => {
        const inner = group.slice(1, -1)
        const alt = inner.split("|")[0] ?? "x"
        return alt.replace(/[^a-zA-Z0-9_-]/g, "") || "x"
      })
      .replace(/\[\^\/\]\+/g, "x")
      .replace(/\.\+/g, "x")
      .replace(/\?/g, "")
      .replace(/\^/g, "")
      .replace(/\$/g, "")
    return filled.startsWith("/") ? filled : `/${filled}`
  }

  /**
   * Turn off Effect's built-in server span.
   *
   * `HttpEffect` wraps every request in `HttpMiddleware.tracer`
   * unconditionally — `disableLogger` does not reach it. That span records
   * `url.full`, `url.query`, `client.address`, `user_agent.original` and every
   * request and response header, which is most of EOT-13's forbidden list: the
   * sanitizer drops the `url.*` keys, but `x-forwarded-for` (an IP) and
   * `referer` (a full URL with a session id in it) survived it. On this runtime
   * no tracer is installed, so the span is built, filled and discarded on every
   * request, and nothing in `src` reads it. Leaving it on is the trap for
   * whoever wires a real tracer in next: the forbidden attributes arrive with
   * it. A server span for this bridge belongs to a middleware that records
   * only the allowed schema. `specs/effect-tui/13-observability-pipeline.md`.
   */
  const builtinServerSpanOff = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)

  /**
   * Shared Effect HttpApi layer used by `Server.fetch`. `LogRedirect` replaces
   * Effect's console default logger so router-internal logs (HttpApi spans,
   * encode errors) land in nikcli's `Log` sink instead of corrupting the TUI's
   * stdout.
   */
  export const layer = Layer.mergeAll(
    PublicHttpApi.layer.pipe(
      Layer.provide(Layer.mergeAll(BunHttpServer.layerHttpServices, BunFileSystem.layer, BunPath.layer)),
    ),
    LogRedirect,
    builtinServerSpanOff,
  )

  /**
   * Log the cause when an encoded route fails.
   *
   * Effect's `HttpMiddleware.logger` is the only thing that reports the cause
   * behind the response it produces, and `disableLogger: true` (below) turns
   * it off — so a response-encode failure answered an **empty 400 with nothing
   * logged at all**. That is not a corner case: it is how `plugin_meta` broke
   * `GET /tui/config` for every user with no plugins and how `featureMutate`
   * broke `POST /mission/:id/feature/:id`, both silently. This keeps the
   * silence for successful requests — `ServerRouter.dispatch` already logs
   * those — and logs only the failures, with the `SchemaError` path intact
   * (`Expected string` at `["workspaceID"]`).
   */
  const logFailures = <A, E, R>(httpApp: Effect.Effect<A, E, R>) =>
    Effect.tapCause(httpApp, (cause) => Effect.logError("encoded route failed", cause))

  /**
   * Web-standard request handler for the schema-encoded HttpApi routes.
   *
   * `disableLogger: true` skips Effect's built-in `HttpMiddleware.logger`:
   * `ServerRouter.dispatch` already logs start + duration for every request
   * except `POST /log`, so adding Effect's logger logs each encoded request
   * twice with the same span. Disable here and keep nikcli's own log — but
   * keep the half of that middleware nikcli has no replacement for, via
   * `logFailures` above.
   */
  export const webHandler = HttpRouter.toWebHandler(layer, {
    memoMap: sharedMemoMap,
    disableLogger: true,
    middleware: logFailures,
  }).handler

  /**
   * Match `pathname`, then retry without a trailing slash.
   *
   * When this table was hand-written the collection roots carried the
   * tolerance in the pattern itself (`/^\/mission\/?$/`, `/^\/doctor\/?$/`).
   * Deriving the patterns from the OpenAPI spec dropped it, because the spec
   * only knows the joined path — so `GET /mission/` stopped reaching the
   * bridge and fell through to the website proxy instead. The raw path is
   * tried first so prefix entries that end in a slash (`/^\/mobile\//`)
   * keep matching exactly as before.
   */
  function matchesAny(bucket: ReadonlyArray<RegExp>, pathname: string) {
    if (bucket.some((pattern) => pattern.test(pathname))) return true
    if (pathname.length > 1 && pathname.endsWith("/")) {
      const trimmed = pathname.slice(0, -1)
      return bucket.some((pattern) => pattern.test(trimmed))
    }
    return false
  }

  export function supports(pathname: string, method = "GET") {
    const bucket = implementedByMethod.get(method.toUpperCase())
    if (!bucket) return false
    return matchesAny(bucket, pathname)
  }

  export function supportsGlobal(pathname: string, method = "GET") {
    const bucket = globalByMethod.get(method.toUpperCase())
    if (!bucket) return false
    return matchesAny(bucket, pathname)
  }

  /** Serve an instance-less `/global/*` or `/user/*` request. Reads no Instance ALS. */
  export async function handleGlobal(
    request: Request,
    options?: { upstreamAuthVerified?: boolean; pathname?: string },
  ) {
    const pathname = options?.pathname ?? new URL(request.url).pathname
    if (options?.upstreamAuthVerified) Auth.markUpstreamVerified(request)
    if (!options?.upstreamAuthVerified && !Auth.isPublicPath(request.method, pathname)) {
      const result = await Auth.authenticate(request, Auth.testOptions())
      if (!result.ok) return result.response
      // Hand the decision to the contract's security middleware instead of
      // making it authenticate a second time (H8). Raw instance-less handlers
      // (`/global/event`, `/user/*`) never reach the middleware at all, which
      // is why this check stays: it is the catch-all for everything the
      // encoded contract does not describe, including unmatched paths.
      Auth.remember(request, result.principal)
    }
    if (request.method === "GET" && pathname === "/global/event") {
      return HttpApiEvent.handle()
    }
    const root = instanceLessRoot(pathname)
    if (root) {
      const response = await rawGlobalHandlers[root]?.(request)
      if (response) return response
    }
    return webHandler(request, Context.empty() as Context.Context<any>)
  }

  export async function handle(request: Request, options?: { upstreamAuthVerified?: boolean; pathname?: string }) {
    // Raw streaming responses (SSE, chunked prompt bodies) are served ahead
    // of the router — they are not schema-encoded HttpApi bodies.
    const pathname = options?.pathname ?? new URL(request.url).pathname
    if (request.method === "GET" && pathname === "/event") {
      // Instance-scoped SSE — plain {type, properties} from the instance Bus.
      // handle() (the /global/event shape) wraps events in {payload}, which
      // the TUI cannot parse; see HttpApiEvent.handleInstance.
      return Promise.resolve(HttpApiEvent.handleInstance())
    }
    if (request.method === "POST") {
      const prompt = pathname.match(/^\/session\/([^/]+)\/message$/)
      if (prompt) return HttpApiPrompt.prompt(request, decodeURIComponent(prompt[1]))
      const promptAsync = pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
      if (promptAsync) return HttpApiPrompt.promptAsync(request, decodeURIComponent(promptAsync[1]))
      if (pathname.startsWith("/chatbot/")) {
        // Webhook receivers need the raw Request (signature verification), so
        // they bypass the schema-encoding router like the other specials. An
        // unmatched path falls through — `/chatbot/bots*` is a declared group.
        const webhook = await ChatbotHttp.handle(request)
        if (webhook) return webhook
      }
    }
    // Requests normally arrive through Server.fetch(), whose router already
    // ran `Auth.authenticate`; direct bridge consumers and request-level tests
    // get the same canonical check here.
    //
    // This stays even though every encoded group now declares the security
    // middleware (H8), because the middleware can only guard paths the
    // contract describes: an unmatched path has no endpoint and therefore no
    // middleware, and answering it 404 to an unauthenticated caller on a
    // password-protected server would be a behavior change. `Auth.remember`
    // hands the result forward so the middleware does not authenticate twice.
    if (options?.upstreamAuthVerified) {
      Auth.markUpstreamVerified(request)
    } else {
      const result = await Auth.authenticate(request, Auth.testOptions())
      if (!result.ok) return result.response
      Auth.remember(request, result.principal)
    }
    return webHandler(request, Context.make(InstanceRef, InstanceState.ambient()) as Context.Context<any>)
  }
}
