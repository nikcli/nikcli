import { Option } from "effect"
import { Effect } from "effect"
import { Flag } from "@nikcli-ai/util/flag"
import { MobileAuth } from "@/mobile/auth"
import { UserDB } from "@/user/users"
import { externalSessionForToken, identityVerifierOptions, localAccountSession } from "@/server/identity-auth"
import { Log } from "@nikcli-ai/util/log"

/**
 * Canonical auth resolution for the nikcli server.
 *
 * `Auth.authenticate` is the single implementation of the resource-server
 * acceptance order (specs/unified-auth-plan.md §3.5):
 *
 *   1. identity-plane JWT from the issuer (`identity-auth.ts`, JWKS verify);
 *   2. capability tokens (`nkm_` — `MobileAuth.verify`);
 *   3. legacy credentials (`nku_` session, Basic, Tailscale), gated by
 *      `NIKCLI_REQUIRE_OAUTH` / `NIKCLI_LEGACY_LOGIN`.
 *
 * `ServerRouter` calls `authenticate` and remembers the principal on the
 * request. The HttpApi bridge calls the same function for direct consumers
 * (tests, embedded clients), so every entry point accepts the same credentials.
 *
 * `auth_token` (legacy `?token=` query parameter used by mobile and websocket
 * clients — see `MobileAuth.bearer`) is accepted as a bearer everywhere.
 */
export namespace Auth {
  const log = Log.create({ service: "httpapi.auth" })

  /** Basic-auth credentials. `username` defaults to `nikcli`. */
  export interface Credentials {
    readonly username: string
    readonly password: Option.Option<string>
  }

  /** The identity resolved for a request. `open` = allowed without an identified user (basic/tailscale/no-password dev mode). */
  export type Principal =
    | { readonly type: "user"; readonly session: { user: UserDB.PublicUser; token: string } }
    | { readonly type: "mobile"; readonly token: MobileAuth.PublicToken }
    | { readonly type: "open" }

  export type AuthenticateResult =
    | { readonly ok: true; readonly principal: Principal }
    | { readonly ok: false; readonly response: Response }

  const principals = new WeakMap<Request, Principal>()

  export function principal(request: Request): Principal | undefined {
    return principals.get(request)
  }

  export function remember(request: Request, value: Principal) {
    principals.set(request, value)
  }

  const localRequests = new WeakSet<Request>()

  /**
   * Record that a request came from this machine.
   *
   * `ServerRouter` marks two shapes: a request handed to it without a
   * `Bun.Server` (no socket at all — `Server.fetch` from the TUI worker, the
   * CLI, plugins, sdk-next), and one that arrived on a listener bound to
   * loopback, whose only reachable peers are on this machine. The second is
   * what the background service is, and it stopped being a detail when that
   * service became the default: the TUI no longer runs the engine in-process,
   * so "never crossed a socket" alone would have excluded the terminal itself.
   *
   * Either way the caller is already inside the trust boundary: it needs no
   * credentials to be admitted, it can read the same database directly, and
   * the token file it presents is its own.
   */
  export function markLocal(request: Request) {
    localRequests.add(request)
  }

  export function isLocal(request: Request): boolean {
    return localRequests.has(request)
  }

  const upstreamVerified = new WeakSet<Request>()

  /**
   * Record that a caller ahead of the encoded router has already made the auth
   * decision for this request, so the HttpApi security middleware must not
   * make it again (H8).
   *
   * This is not the same statement as `remember`. `remember` says *who* the
   * caller is; this says *that the question was already settled* — including
   * by a host that settles it by trusting its own transport. `WorkspaceServer`
   * is exactly that host: it serves a workspace sandbox on its own
   * `Bun.serve`, performs no authentication, and passes
   * `upstreamAuthVerified: true`. Without this marker the middleware would
   * start authenticating those requests and reject every one of them on a
   * server that has `NIKCLI_SERVER_PASSWORD` set.
   */
  export function markUpstreamVerified(request: Request) {
    upstreamVerified.add(request)
  }

  export function isUpstreamVerified(request: Request): boolean {
    return upstreamVerified.has(request)
  }

  /**
   * Test-only credential override, shared by every entry point.
   *
   * Production credentials come from `Flag.NIKCLI_SERVER_PASSWORD`, which is
   * captured at module-load time, so a test runner cannot flip the env var to
   * simulate a password-protected server. This seam lives here rather than on
   * one dispatcher because the bridge and the HttpApi security middleware both
   * have to see the same substitution — before H8 it sat in the bridge alone,
   * which would have left the middleware authenticating against the real
   * (empty) credentials. Reset it in a `finally`; production behavior is
   * unchanged while it is null.
   */
  let credentialsOverride: Credentials | null = null

  export function overrideCredentials(value: Credentials | null) {
    credentialsOverride = value
  }

  /** The override as `AuthenticateOptions`, or `undefined` when unset. */
  export function testOptions(): AuthenticateOptions | undefined {
    return credentialsOverride ? { credentials: credentialsOverride } : undefined
  }

  export interface AuthenticateOptions {
    /** Listen-state the router passes in; direct bridge consumers omit both. */
    readonly mobileAuthRequired?: boolean
    readonly listenHostname?: string
    /** Test seam replacing the Flag-derived basic-auth credentials. */
    readonly credentials?: Credentials
  }

  /**
   * Reads `Flag.NIKCLI_SERVER_*` every call so runtime changes (e.g. tests
   * that toggle the flag) take effect without a restart.
   */
  export function currentCredentials(): Credentials {
    const username = Flag.NIKCLI_SERVER_USERNAME?.trim() || "nikcli"
    const password = Flag.NIKCLI_SERVER_PASSWORD?.trim()
    return {
      username,
      password: password ? Option.some(password) : Option.none(),
    }
  }

  /** True when the configured password matches the request's basic-auth header. */
  export function matchesBasicAuth(credentials: Credentials, header: string | null | undefined): boolean {
    if (header === undefined || header === null) return false
    const match = /^Basic\s+(.+)$/i.exec(header)
    if (!match) return false
    const decoded = safeBase64Decode(match[1])
    if (!decoded) return false
    const sep = decoded.indexOf(":")
    if (sep < 0) return false
    const user = decoded.slice(0, sep)
    const pass = decoded.slice(sep + 1)
    return user === credentials.username && Option.getOrUndefined(credentials.password) === pass
  }

  /** Basic-auth challenge header emitted when credentials are required but missing/invalid. */
  export const challenge = `Basic realm="nikcli", charset="UTF-8"`

  /**
   * Parses `?token=…` from a URL. The `auth_token` security scheme: mobile and
   * websocket clients pass the bearer token via query parameter because the
   * transport cannot send custom headers.
   */
  export function extractQueryToken(url: URL): string | undefined {
    const value = url.searchParams.get("token")
    return value && value.length > 0 ? value : undefined
  }

  export function isLoopbackHostname(hostname: string | undefined) {
    if (!hostname) return false
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
  }

  /**
   * Routes reachable without credentials. Flag-dependent: closing legacy
   * login (`NIKCLI_REQUIRE_OAUTH` without `NIKCLI_LEGACY_LOGIN`) also closes
   * password login/registration.
   */
  export function isPublicPath(method: string, pathname: string): boolean {
    const normalizedMethod = method.toUpperCase()
    if (normalizedMethod === "OPTIONS") return true
    if (pathname === "/user/status") return true
    if ((pathname === "/user/login" || pathname === "/user/register") && (!Flag.requireOauth() || Flag.legacyLogin())) {
      return true
    }
    if (normalizedMethod === "GET" && pathname === "/global/health") return true
    // /account/(login|login/complete) is the browser sign-in flow; it is
    // public because the caller is unauthenticated by definition. The
    // `GET /account` (active session) call rejects on its own.
    if (pathname === "/account" || pathname === "/account/login" || pathname === "/account/login/complete") return true
    return false
  }

  function legacyUserTokenAllowed() {
    return !Flag.requireOauth() || Flag.legacyLogin()
  }

  /**
   * Best-effort principal resolution from a bearer token (header or
   * `?token=`), in acceptance order. Returns undefined when no bearer is
   * present or nothing matches — enforcement is `authenticate`'s job.
   */
  export async function resolveBearer(
    request: Request,
  ): Promise<Extract<Principal, { type: "user" | "mobile" }> | undefined> {
    const bearer = MobileAuth.bearer(request) ?? extractQueryToken(new URL(request.url))
    if (!bearer) return undefined
    const external = await externalSessionForToken(bearer).catch(() => undefined)
    if (external) return { type: "user", session: external }
    const mobile = await MobileAuth.verify(bearer)
    if (mobile) return { type: "mobile", token: mobile }
    if (bearer.startsWith("nku_") && legacyUserTokenAllowed()) {
      const user = Effect.runSync(UserDB.verifySession(bearer))
      if (user) return { type: "user", session: { user, token: bearer } }
    }
    return undefined
  }

  /**
   * Full auth decision for a request. Both backends call this — Hono's
   * middleware for every route, the bridge for direct consumers — so the
   * acceptance order has exactly one implementation.
   */
  export async function authenticate(request: Request, options?: AuthenticateOptions): Promise<AuthenticateResult> {
    const bearer = MobileAuth.bearer(request) ?? extractQueryToken(new URL(request.url))
    if (bearer) {
      const principal = await resolveBearer(request)
      if (principal) {
        // Capability gating, for bearer principals only. A local caller with no
        // token never reaches here, so this cannot affect the desktop or the
        // TUI talking to their own server.
        if (principal.type === "mobile") {
          const pathname = new URL(request.url).pathname
          const required = MobileAuth.requiredCapability(pathname)
          if (required && !MobileAuth.can(principal.token.scope, required)) {
            log.warn("mobile capability denied", { scope: principal.token.scope, required, pathname })
            return forbidden(required)
          }
        }
        return { ok: true, principal }
      }
      // A local caller is admitted with no bearer at all, so an *aged-out* one
      // must not leave it less authorized than sending none. The terminal
      // holds a fifteen-minute issuer token on disk and sends it on every
      // `/user/*` call; rejecting the request outright turned "my token aged
      // out" into "signed out" for a machine whose account is still valid and
      // still refreshing. Fall through to the credential-free decision below —
      // the stale token buys nothing, it is simply ignored, and a configured
      // `NIKCLI_SERVER_PASSWORD` still has to be satisfied down there.
      //
      // Only for a token of the shape the terminal actually stores, though. A
      // bearer that was never this issuer's — an unknown `?token=`, a revoked
      // `nku_`, a typo — is a caller presenting a credential that does not
      // belong here, and "invalid" must stay 401 rather than decay into
      // "unauthenticated".
      if (!isLocal(request) || !carriesIssuerClaim(bearer)) return unauthorized()
    }

    if (options?.mobileAuthRequired || (Flag.requireOauth() && !Flag.legacyLogin())) {
      return unauthorized()
    }

    const credentials = options?.credentials ?? currentCredentials()

    const tailscaleAuthEnabled = Flag.NIKCLI_SERVER_TAILSCALE_AUTH && isLoopbackHostname(options?.listenHostname)
    if (tailscaleAuthEnabled) {
      const login = request.headers.get("Tailscale-User-Login")?.trim()
      if (login) {
        if (!isTailscaleLoginAllowed(login)) {
          log.warn("tailscale user not allowed", { login })
          return { ok: false, response: new Response("Forbidden", { status: 403 }) }
        }
        return { ok: true, principal: { type: "open" } }
      }
      // Tailscale auth requires identity headers; optionally fall back to Basic.
      if (Option.isNone(credentials.password)) return unauthorized()
    }

    if (Option.isNone(credentials.password)) return { ok: true, principal: { type: "open" } }
    if (matchesBasicAuth(credentials, request.headers.get("authorization"))) {
      return { ok: true, principal: { type: "open" } }
    }
    return {
      ok: false,
      response: new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": challenge },
      }),
    }
  }

  /**
   * The user session behind a request, for the `/user/*` and `/account`
   * handlers that need an identity rather than an authorization decision.
   *
   * A valid bearer answers first and always wins. Only when there is none —
   * and only for a request `markLocal` accepted as this machine's own — does
   * this fall back to the account this machine is signed into, whose token is
   * refreshed and verified by `localAccountSession`. A remote caller gets
   * `null`, exactly as before.
   */
  export async function sessionFor(request: Request): Promise<{ user: UserDB.PublicUser; token: string } | null> {
    const principal = await resolveBearer(request).catch(() => undefined)
    if (principal?.type === "user") return principal.session
    if (!isLocal(request)) return null
    return (await localAccountSession().catch(() => undefined)) ?? null
  }

  /**
   * Whether a rejected bearer is at least *shaped* like the issuer token this
   * machine stores — a JWT naming the configured issuer.
   *
   * The payload is read without verifying the signature, which is safe because
   * of what the answer is used for: it never grants anything, it only decides
   * whether a local caller's dead credential is ignored or refused. Anything
   * unparseable, or naming another issuer, is refused.
   */
  function carriesIssuerClaim(bearer: string): boolean {
    const issuer = identityVerifierOptions()?.issuer
    if (!issuer) return false
    const payload = bearer.split(".")[1]
    if (!payload) return false
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss?: unknown }
      return claims.iss === issuer
    } catch {
      return false
    }
  }

  function unauthorized(): AuthenticateResult {
    return { ok: false, response: new Response("Unauthorized", { status: 401 }) }
  }

  /**
   * A capability refusal, which is not a 401.
   *
   * The token is valid and the caller is who they say; the scope simply does
   * not carry this operation. Answering 401 would tell a paired device to
   * re-authenticate, which cannot help and which
   * `specs/effect-tui/19-mobile-companion-bridge.md` calls out by name: the
   * phone shows a button, the button does nothing, and the user concludes the
   * host is broken. The capability is named in the body so the client can say
   * which one is missing.
   */
  function forbidden(capability: string): AuthenticateResult {
    return {
      ok: false,
      response: new Response(`Forbidden: token scope lacks the "${capability}" capability`, { status: 403 }),
    }
  }

  function isTailscaleLoginAllowed(login: string) {
    const configured = Flag.NIKCLI_SERVER_TAILSCALE_USERS?.trim()
    if (!configured) return true

    const items = configured
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)

    if (items.length === 0) return true
    if (items.some((x) => x === "*" || x.toLowerCase() === "any")) return true

    const normalized = login.toLowerCase()
    return items.some((x) => x.toLowerCase() === normalized)
  }
}

function safeBase64Decode(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf-8")
  } catch {
    return null
  }
}
