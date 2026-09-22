import type { APIRoute } from "astro"
import { ARTIFACT_TOKEN_COOKIE } from "../../lib/artifact"

export const GET: APIRoute = async (context) => {
  const state = context.url.searchParams.get("state")
  const expected = context.cookies.get("nikcli_oauth_state")?.value
  const verifier = context.cookies.get("nikcli_oauth_verifier")?.value
  const returnTo = context.cookies.get("nikcli_oauth_return")?.value || "/"
  context.cookies.delete("nikcli_oauth_state", { path: "/user" })
  context.cookies.delete("nikcli_oauth_verifier", { path: "/user" })
  context.cookies.delete("nikcli_oauth_return", { path: "/user" })
  if (!state || !expected || state !== expected || !verifier) {
    return Response.json({ error: "invalid_oauth_state" }, { status: 400 })
  }
  const code = context.url.searchParams.get("code")
  if (!code) return Response.json({ error: context.url.searchParams.get("error") ?? "missing_code" }, { status: 400 })
  const env = (context.locals as App.Locals).runtime?.env
  const issuer = (env?.AUTH_ISSUER ?? "https://auth.nikcli-ai.dev").replace(/\/$/, "")
  const redirectUri = new URL("/user/callback", context.url.origin).toString()
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "nikcli-web",
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  })
  if (!response.ok) return Response.json({ error: "token_exchange_failed" }, { status: 502 })
  const tokens = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in) {
    return Response.json({ error: "invalid_token_response" }, { status: 502 })
  }
  const secure = context.url.protocol === "https:"
  context.cookies.set(ARTIFACT_TOKEN_COOKIE, tokens.access_token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: tokens.expires_in,
  })
  context.cookies.set("nikcli_refresh", tokens.refresh_token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 90 * 24 * 60 * 60,
  })
  return context.redirect(returnTo)
}
