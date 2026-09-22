import type { APIRoute } from "astro"
import { clearSessionCookie, REFRESH_COOKIE } from "../../../lib/auth"
import { getEnv } from "../../../lib/env"

export const POST: APIRoute = async (ctx) => {
  const refresh = ctx.cookies.get(REFRESH_COOKIE)?.value
  if (refresh) {
    const env = getEnv(ctx)
    const issuer = (env.AUTH_ISSUER || "https://auth.nikcli-ai.dev").replace(/\/$/, "")
    await fetch(`${issuer}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh }),
    }).catch(() => undefined)
  }
  clearSessionCookie(ctx.cookies)
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  })
}
