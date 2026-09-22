import type { APIRoute } from "astro"
import { ARTIFACT_TOKEN_COOKIE } from "../../lib/artifact"

export const POST: APIRoute = async (context) => {
  const env = (context.locals as App.Locals).runtime?.env
  const refresh = context.cookies.get("nikcli_refresh")?.value
  if (refresh) {
    const issuer = (env?.AUTH_ISSUER ?? "https://auth.nikcli-ai.dev").replace(/\/$/, "")
    await fetch(`${issuer}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh }),
    }).catch(() => undefined)
  }
  context.cookies.delete(ARTIFACT_TOKEN_COOKIE, { path: "/" })
  context.cookies.delete("nikcli_refresh", { path: "/" })
  return Response.json({ ok: true })
}
