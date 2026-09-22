import type { UserSchema } from "@nikcli-ai/util/user-schema"
import { UserSession } from "@nikcli-ai/util/user-session"

/**
 * The terminal's reader for `/user/*`.
 *
 * These routes are raw `Response` handlers outside the OpenAPI surface, so the
 * generated client has no methods for them and every call goes through
 * `sdk.fetch` by hand. Two things that are not optional:
 *
 * - **`sdk.fetch`, never global `fetch`.** In a normal run there is no
 *   listening HTTP server: the base URL is the synthetic `http://nikcli.local`
 *   and `sdk.fetch` marshals the request over worker RPC into `Server.fetch`.
 *   A hand-built `fetch` fails DNS silently — no error, no log line.
 * - **The bearer comes from the local token store.** The token is what this
 *   machine holds; the server cannot infer it. Sending none is still a fair
 *   question rather than an answer: for a caller on this machine the server
 *   resolves the session from the account row it refreshes itself, so only the
 *   401 it replies with means "signed out".
 */
export namespace UserApi {
  export type Sdk = { url?: string; fetch: typeof fetch }

  /**
   * A read that keeps the difference between a refusal and a silence.
   *
   * `get` below flattens both to `null`, which is all most callers need. The
   * startup gate is not one of them: it opens the sign-in dialog on a falsy
   * answer, so "the service has not finished booting" or "an auto-update just
   * restarted it" used to look exactly like "this machine is signed out".
   */
  type Answer<T> = { kind: "ok"; value: T } | { kind: "refused"; status: number } | { kind: "silent" }

  async function ask<T>(sdk: Sdk, path: string, headers?: HeadersInit): Promise<Answer<T>> {
    const base = sdk.url
    if (!base) return { kind: "silent" }
    try {
      const res = await sdk.fetch(`${base.replace(/\/$/, "")}${path}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return { kind: "refused", status: res.status }
      return { kind: "ok", value: (await res.json()) as T }
    } catch {
      return { kind: "silent" }
    }
  }

  async function get<T>(sdk: Sdk, path: string, headers?: HeadersInit): Promise<T | null> {
    const answer = await ask<T>(sdk, path, headers)
    return answer.kind === "ok" ? answer.value : null
  }

  /**
   * A read on behalf of this machine's session.
   *
   * The token is sent when the store has one, and holding none is not a local
   * answer: these routes resolve a local caller from the machine's account row
   * (`Auth.sessionFor`), so bailing out before asking reported "signed out" for
   * a machine that was signed in with an empty token file.
   */
  async function authed<T>(sdk: Sdk, path: string): Promise<T | null> {
    const token = UserSession.getSync()
    return get<T>(sdk, path, token ? { authorization: `Bearer ${token}` } : undefined)
  }

  /**
   * A write, with the server's own message on failure.
   *
   * Every `/user/*` failure body is `{ error }` with only the status differing —
   * which is why these routes are raw handlers rather than an `HttpApi` group —
   * so the message is the whole result and the dialogs show it verbatim rather
   * than inventing one.
   */
  export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

  async function send<T>(
    sdk: Sdk,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Result<T>> {
    const base = sdk.url
    if (!base) return { ok: false, error: "No server" }
    const token = UserSession.getSync()
    try {
      const res = await sdk.fetch(`${base.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A device-code poll waits for a human, so it carries the caller's own
        // signal instead of a timeout. Everything else keeps the 30s bound.
        signal: signal ?? AbortSignal.timeout(30_000),
      })
      const payload = (await res.json().catch(() => undefined)) as { error?: string } | undefined
      if (!res.ok) return { ok: false, error: payload?.error ?? `Request failed (${res.status})` }
      return { ok: true, data: payload as T }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Signed in, signed out, or not answered — the three states the startup
   * gate has to tell apart before it decides to interrupt someone.
   */
  export type SessionState =
    | { status: "signed-in"; user: UserSchema.PublicUser }
    | { status: "signed-out" }
    | { status: "unknown" }

  /**
   * Who this machine is signed in as, according to the server.
   *
   * The bearer is sent when there is one, and its absence is *not* a local
   * verdict: `/user/me` answers a local caller from the machine's own account
   * row, so a missing or aged-out token file is the server's question to
   * settle, not a reason to skip asking. Only a 401/403 — the server saying it
   * has no session for this machine — counts as signed out. A timeout, a
   * transport that is not up yet, a 5xx: none of those are an answer.
   */
  export async function session(sdk: Sdk): Promise<SessionState> {
    const token = UserSession.getSync()
    const answer = await ask<UserSchema.PublicUser>(
      sdk,
      "/user/me",
      token ? { authorization: `Bearer ${token}` } : undefined,
    )
    if (answer.kind === "ok") return { status: "signed-in", user: answer.value }
    if (answer.kind === "refused" && (answer.status === 401 || answer.status === 403)) return { status: "signed-out" }
    return { status: "unknown" }
  }

  /** The signed-in account, or `null` when this machine holds no valid session. */
  export async function me(sdk: Sdk): Promise<UserSchema.PublicUser | null> {
    const state = await session(sdk)
    return state.status === "signed-in" ? state.user : null
  }

  /** Contact and unread counters for the signed-in account. */
  export function stats(sdk: Sdk) {
    return authed<UserSchema.Stats>(sdk, "/user/me/stats")
  }

  /**
   * Whether any account exists on this install — the first-run signal.
   *
   * Deliberately unauthenticated: `/user/status` is one of the paths
   * `Auth.isPublicPath` admits, because asking it is what happens *before*
   * anyone can be signed in. An unreachable server answers `null`, which the
   * caller must not read as "no users" — that would restart onboarding for
   * someone who already has an account.
   */
  export async function hasUsers(sdk: Sdk): Promise<boolean | null> {
    const result = await get<{ hasUsers: boolean }>(sdk, "/user/status")
    return result ? result.hasUsers : null
  }

  export type Session = { token: string; user: UserSchema.PublicUser }

  /**
   * Create the local account and its session.
   *
   * The route enforces policy the in-process call did not: registration is
   * refused when OAuth is required, and once any account exists only an admin
   * may add another. That is the point of going through it.
   */
  export function register(sdk: Sdk, input: { username: string; email: string; password: string }) {
    return send<Session>(sdk, "POST", "/user/register", input)
  }

  /**
   * Exchange a password for a session.
   *
   * The route answers the same "Invalid credentials" for an unknown email and a
   * wrong password, so the dialog can no longer say which was wrong — that is
   * the route refusing to confirm whether an address has an account here.
   */
  export function login(sdk: Sdk, input: { email: string; password: string }) {
    return send<Session>(sdk, "POST", "/user/login", input)
  }

  /** Revoke the session server-side. The caller still has to drop the local token. */
  export function logout(sdk: Sdk) {
    return send<{ ok: boolean }>(sdk, "POST", "/user/logout")
  }

  /**
   * The browser sign-in flow, as the terminal sees it.
   *
   * `complete` is one call that blocks until the user approves and hands back
   * the issuer session. The access token is the bearer: storing it and asking
   * `/user/me` is what provisions the local user, so nothing here mints a
   * second identity. Pass an `AbortSignal` so escape actually stops waiting.
   */
  export type AccountInfo = {
    id: string
    email: string
    url: string
    active_org_id?: string | null
    created_at: number
    updated_at: number
  }

  export type LoginStart = {
    deviceCode: string
    userCode: string
    verificationUrl: string
    verificationUrlComplete: string
    interval: number
    expiresIn: number
    expiresAt: number
  }

  /** `null` also answers "nobody is signed in" — the dialogs treat both the same. */
  export function account(sdk: Sdk) {
    return authed<AccountInfo | null>(sdk, "/account").then((value) => value ?? null)
  }

  export function accountLogin(sdk: Sdk, signal?: AbortSignal) {
    return send<LoginStart>(sdk, "POST", "/account/login", undefined, signal)
  }

  export type AccountSession = {
    accountID: string
    accessToken: string
    expiresIn: number
    email: string | null
  }

  export function accountComplete(
    sdk: Sdk,
    input: { deviceCode: string; expiresIn?: number },
    signal?: AbortSignal,
  ): Promise<Result<AccountSession>> {
    return send(sdk, "POST", "/account/login/complete", input, signal)
  }

  /** Rotate the caller's own password. The current one is verified server-side. */
  export function changePassword(sdk: Sdk, input: { current: string; next: string }) {
    return send<UserSchema.PublicUser>(sdk, "POST", "/user/me/password", input)
  }

  /** Self-edit; the route allows it for the bearer's own id (or an admin). */
  export function update(sdk: Sdk, id: string, patch: { displayName?: string; password?: string }) {
    return send<UserSchema.PublicUser>(sdk, "PATCH", `/user/${encodeURIComponent(id)}`, patch)
  }
}
