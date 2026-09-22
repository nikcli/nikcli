import type { APIRoute } from "astro"

function base64Url(bytes: Uint8Array): string {
  let value = ""
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export const GET: APIRoute = async (context) => {
  const env = (context.locals as App.Locals).runtime?.env
  const issuer = (env?.AUTH_ISSUER ?? "https://auth.nikcli-ai.dev").replace(/\/$/, "")
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)))
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
  const returnTo = context.url.searchParams.get("return_to")
  const safeReturnTo = returnTo?.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/"
  const cookie = {
    httpOnly: true,
    secure: context.url.protocol === "https:",
    sameSite: "lax" as const,
    maxAge: 600,
  }
  context.cookies.set("nikcli_oauth_state", state, {
    ...cookie,
    path: "/user",
  })
  context.cookies.set("nikcli_oauth_verifier", verifier, {
    ...cookie,
    path: "/user",
  })
  context.cookies.set("nikcli_oauth_return", safeReturnTo, {
    ...cookie,
    path: "/user",
  })
  const redirectUri = new URL("/user/callback", context.url.origin).toString()
  const authorize = new URL("/authorize", issuer)
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: "nikcli-web",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()
  return context.redirect(authorize.toString())
}
