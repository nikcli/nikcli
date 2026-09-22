import type { APIRoute } from "astro"
import { REFRESH_COOKIE, setSessionCookie } from "../../../lib/auth"
import { getEnv } from "../../../lib/env"

export const GET: APIRoute = async (ctx) => {
  const url = new URL(ctx.request.url)
  const state = url.searchParams.get("state")
  const expected = ctx.cookies.get("nik_oauth_state")?.value
  const verifier = ctx.cookies.get("nik_oauth_verifier")?.value
  ctx.cookies.delete("nik_oauth_state", { path: "/api/auth" })
  ctx.cookies.delete("nik_oauth_verifier", { path: "/api/auth" })
  if (!state || !expected || state !== expected || !verifier)
    return Response.json({ error: "invalid_oauth_state" }, { status: 400 })
  const code = url.searchParams.get("code")
  if (!code) return Response.json({ error: url.searchParams.get("error") || "missing_code" }, { status: 400 })
  const env = getEnv(ctx)
  const issuer = (env.AUTH_ISSUER || "https://auth.nikcli-ai.dev").replace(/\/$/, "")
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "nikcli-inference-dashboard",
      code,
      redirect_uri: new URL("/api/auth/callback", ctx.request.url).toString(),
      code_verifier: verifier,
    }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return Response.json(
      { error: "token_exchange_failed", issuer_status: response.status, issuer_error: detail.slice(0, 500) },
      { status: 502 },
    )
  }
  const tokens = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!tokens.access_token || !tokens.refresh_token) {
    return Response.json({ error: "invalid_token_response" }, { status: 502 })
  }
  setSessionCookie(ctx.cookies, tokens.access_token, tokens.expires_in, ctx.url.protocol === "https:")
  ctx.cookies.set(REFRESH_COOKIE, tokens.refresh_token, {
    httpOnly: true,
    secure: ctx.url.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 90 * 24 * 60 * 60,
  })
  return ctx.redirect("/dashboard")
}
