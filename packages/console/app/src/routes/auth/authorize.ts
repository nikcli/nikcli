import type { APIEvent } from "@solidjs/start/server"
import { useAuthSession } from "~/context/auth"

function base64Url(bytes: Uint8Array): string {
  let value = ""
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function GET(input: APIEvent) {
  const url = new URL(input.request.url)
  const cont = url.searchParams.get("continue") ?? ""
  const continueTo = cont.startsWith("/") && !cont.startsWith("//") ? cont : "/auth"
  const callbackUrl = new URL("./callback", input.request.url)
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)))
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
  const session = await useAuthSession()
  await session.update((value) => ({
    ...value,
    oauth: { state, verifier, callback: callbackUrl.toString(), continueTo },
  }))
  const issuer = import.meta.env.VITE_AUTH_URL || "https://auth.nikcli-ai.dev"
  const authorize = new URL("/authorize", issuer)
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: "nikcli-console",
    redirect_uri: callbackUrl.toString(),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()
  return Response.redirect(authorize.toString(), 302)
}
