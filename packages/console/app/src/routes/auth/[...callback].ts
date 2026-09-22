import { redirect } from "@solidjs/router"
import type { APIEvent } from "@solidjs/start/server"
import { useAuthSession } from "~/context/auth"
import { localeFromRequest, route } from "~/lib/language"
import { verifyAccessToken } from "@nikcli-ai/auth"

export async function GET(input: APIEvent) {
  const url = new URL(input.request.url)
  const locale = localeFromRequest(input.request)

  try {
    const code = url.searchParams.get("code")
    if (!code) throw new Error("No code found")
    const session = await useAuthSession()
    const transaction = session.data.oauth
    if (!transaction || !url.searchParams.get("state") || url.searchParams.get("state") !== transaction.state) {
      throw new Error("OAuth state validation failed")
    }
    const issuer = import.meta.env.VITE_AUTH_URL || "https://auth.nikcli-ai.dev"
    const response = await fetch(new URL("/oauth/token", issuer), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "nikcli-console",
        redirect_uri: transaction.callback,
        code,
        code_verifier: transaction.verifier,
      }),
    })
    if (!response.ok) throw new Error(`Token exchange failed (${response.status})`)
    const tokens = (await response.json()) as { access_token?: string }
    if (!tokens.access_token) throw new Error("Identity issuer returned no access token")
    const identity = await verifyAccessToken(tokens.access_token, {
      issuer,
      audience: "nikcli-api",
      jwksUrl: new URL("/.well-known/jwks.json", issuer).toString(),
    })
    const email = identity.email
    if (!email) throw new Error("Identity token has no verified email")
    const id = identity.accountID
    await session.update((value) => {
      return {
        ...value,
        oauth: undefined,
        account: {
          ...value.account,
          [id]: {
            id,
            email,
          },
        },
        current: id,
      }
    })
    return redirect(route(locale, transaction.continueTo))
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        cause: Object.fromEntries(url.searchParams.entries()),
      }),
      { status: 500 },
    )
  }
}
