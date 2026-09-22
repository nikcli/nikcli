import type { APIRoute } from "astro"
import { getEnv } from "../../../lib/env"

function base64Url(bytes: Uint8Array): string {
  let value = ""
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export const GET: APIRoute = async (ctx) => {
  const env = getEnv(ctx)
  const issuer = (env.AUTH_ISSUER || "https://auth.nikcli-ai.dev").replace(/\/$/, "")
  const stateBytes = crypto.getRandomValues(new Uint8Array(32))
  const verifierBytes = crypto.getRandomValues(new Uint8Array(64))
  const state = base64Url(stateBytes)
  const verifier = base64Url(verifierBytes)
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
  const redirectUri = new URL("/api/auth/callback", ctx.request.url).toString()
  ctx.cookies.set("nik_oauth_state", state, {
    httpOnly: true,
    secure: ctx.url.protocol === "https:",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 600,
  })
  ctx.cookies.set("nik_oauth_verifier", verifier, {
    httpOnly: true,
    secure: ctx.url.protocol === "https:",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 600,
  })
  const url = new URL("/authorize", issuer)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "nikcli-inference-dashboard",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()
  return ctx.redirect(url.toString())
}
