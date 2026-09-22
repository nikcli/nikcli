import { verifyAccessToken } from "@nikcli-ai/auth"
import type { APIContext, AstroCookies } from "astro"
import { getEnv, type RuntimeEnv } from "./env"

export interface AuthUser {
  id: string
  email: string
  name: string | null
  plan: string
  createdAt: number
}

export const SESSION_COOKIE = "nik_identity"
export const REFRESH_COOKIE = "nik_identity_refresh"

function verifier(env: RuntimeEnv) {
  const issuer = env.AUTH_ISSUER || "https://auth.nikcli-ai.dev"
  return {
    issuer,
    audience: env.AUTH_AUDIENCE || "nikcli-api",
    jwksUrl: env.AUTH_JWKS_URL || `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`,
  }
}

export async function ensureUser(env: RuntimeEnv, accountID: string, email?: string): Promise<AuthUser> {
  const existing = await env.DB.prepare("SELECT id, email, name, plan, created_at FROM users WHERE id = ?")
    .bind(accountID)
    .first<{
      id: string
      email: string
      name: string | null
      plan: string
      created_at: number
    }>()
  if (existing)
    return {
      id: existing.id,
      email: existing.email,
      name: existing.name,
      plan: existing.plan,
      createdAt: existing.created_at,
    }
  if (!email) throw new AuthError("Identity token is missing an email claim", 401)
  const byEmail = await env.DB.prepare("SELECT id, name, plan, created_at FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; name: string | null; plan: string; created_at: number }>()
  if (byEmail) {
    // Legacy (pre-issuer) account: re-key it to the issuer accountID. The
    // issuer verifies email ownership (GitHub / email code), so adopting the
    // row by email is safe. defer_foreign_keys lets the parent id change
    // before the children are re-pointed within the same transaction.
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = true"),
      env.DB.prepare("UPDATE users SET id = ?, updated_at = unixepoch() WHERE id = ?").bind(accountID, byEmail.id),
      env.DB.prepare("UPDATE api_keys SET user_id = ? WHERE user_id = ?").bind(accountID, byEmail.id),
      env.DB.prepare("UPDATE usage_events SET user_id = ? WHERE user_id = ?").bind(accountID, byEmail.id),
    ])
    return { id: accountID, email, name: byEmail.name, plan: byEmail.plan, createdAt: byEmail.created_at }
  }
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, plan, created_at, updated_at) VALUES (?, ?, NULL, 'free', ?, ?)",
  )
    .bind(accountID, email, now, now)
    .run()
  return { id: accountID, email, name: null, plan: "free", createdAt: now }
}

export async function getSessionUser(env: RuntimeEnv, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null
  try {
    const auth = await verifyAccessToken(token, verifier(env))
    return await ensureUser(env, auth.accountID, auth.email)
  } catch (error) {
    if (error instanceof AuthError) throw error
    return null
  }
}

export function setSessionCookie(cookies: AstroCookies, accessToken: string, maxAge = 15 * 60, secure = true) {
  cookies.set(SESSION_COOKIE, accessToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge,
  })
}

export function clearSessionCookie(cookies: AstroCookies) {
  cookies.delete(SESSION_COOKIE, { path: "/" })
  cookies.delete(REFRESH_COOKIE, { path: "/" })
}

export function readSessionCookie(cookies: AstroCookies): string | undefined {
  return cookies.get(SESSION_COOKIE)?.value
}

export async function getCurrentUser(ctx: APIContext): Promise<AuthUser | null> {
  const env = getEnv(ctx)
  const current = await getSessionUser(env, readSessionCookie(ctx.cookies))
  if (current) return current
  const refresh = ctx.cookies.get(REFRESH_COOKIE)?.value
  if (!refresh) return null
  const issuer = (env.AUTH_ISSUER || "https://auth.nikcli-ai.dev").replace(/\/$/, "")
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: "nikcli-inference-dashboard",
    }),
  })
  if (!response.ok) {
    clearSessionCookie(ctx.cookies)
    return null
  }
  const tokens = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in) return null
  setSessionCookie(ctx.cookies, tokens.access_token, tokens.expires_in, ctx.url.protocol === "https:")
  ctx.cookies.set(REFRESH_COOKIE, tokens.refresh_token, {
    httpOnly: true,
    secure: ctx.url.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 90 * 24 * 60 * 60,
  })
  return getSessionUser(env, tokens.access_token)
}

export async function createUser(): Promise<never> {
  throw new AuthError("Password registration has been retired; use issuer sign-in", 410)
}

export async function verifyCredentials(): Promise<never> {
  throw new AuthError("Password sign-in has been retired; use issuer sign-in", 410)
}

export async function createSession(): Promise<never> {
  throw new AuthError("Legacy sessions have been retired", 410)
}

export async function destroySession(): Promise<void> {}

export async function updateUserPassword(): Promise<never> {
  throw new AuthError("Password management has moved to the identity issuer", 410)
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = "AuthError"
  }
}
