import { createTokenClient, StoredTokens, type TokenStore } from "@nikcli-ai/auth/client"

const OAUTH_TRANSACTION_KEY = "nikcli_studio_oauth_transaction"
const OAUTH_TOKENS_KEY = "nikcli_studio_oauth_tokens"
export const STUDIO_CLIENT_ID = "nikcli-studio"

type OAuthTransaction = {
  state: string
  verifier: string
  redirectUri: string
}

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomValue(bytes = 32): string {
  const value = new Uint8Array(bytes)
  crypto.getRandomValues(value)
  return base64Url(value)
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

export function issuerUrl(): string {
  return (import.meta.env.PUBLIC_NIKCLI_AUTH_ISSUER || "https://auth.nikcli-ai.dev").replace(/\/$/, "")
}

export async function beginOAuth(redirectUri: string): Promise<string> {
  const transaction: OAuthTransaction = {
    state: randomValue(),
    verifier: randomValue(64),
    redirectUri,
  }
  sessionStorage.setItem(OAUTH_TRANSACTION_KEY, JSON.stringify(transaction))
  const url = new URL("/authorize", issuerUrl())
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: STUDIO_CLIENT_ID,
    redirect_uri: redirectUri,
    state: transaction.state,
    code_challenge: await challengeFor(transaction.verifier),
    code_challenge_method: "S256",
  }).toString()
  return url.toString()
}

export async function completeOAuth(callbackUrl: string): Promise<StoredTokens> {
  const url = new URL(callbackUrl)
  const raw = sessionStorage.getItem(OAUTH_TRANSACTION_KEY)
  sessionStorage.removeItem(OAUTH_TRANSACTION_KEY)
  if (!raw) throw new Error("Missing OAuth transaction. Start sign-in again.")
  const transaction = JSON.parse(raw) as OAuthTransaction
  if (!url.searchParams.get("state") || url.searchParams.get("state") !== transaction.state) {
    throw new Error("OAuth state validation failed")
  }
  const code = url.searchParams.get("code")
  if (!code)
    throw new Error(
      url.searchParams.get("error_description") || url.searchParams.get("error") || "Missing authorization code",
    )
  const response = await fetch(new URL("/oauth/token", issuerUrl()), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: STUDIO_CLIENT_ID,
      code,
      redirect_uri: transaction.redirectUri,
      code_verifier: transaction.verifier,
    }),
  })
  if (!response.ok) throw new Error(`Token exchange failed (${response.status})`)
  const body = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!body.access_token || !body.refresh_token || !body.expires_in)
    throw new Error("Issuer returned an invalid token response")
  const tokens = StoredTokens.parse({
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000,
  })
  tokenStore.set(tokens)
  return tokens
}

export const tokenStore: TokenStore = {
  get() {
    const raw = localStorage.getItem(OAUTH_TOKENS_KEY)
    if (!raw) return undefined
    const parsed = StoredTokens.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  },
  set(tokens) {
    localStorage.setItem(OAUTH_TOKENS_KEY, JSON.stringify(tokens))
  },
  clear() {
    localStorage.removeItem(OAUTH_TOKENS_KEY)
  },
}

export function createStudioTokenClient() {
  return createTokenClient({
    issuer: issuerUrl(),
    clientID: STUDIO_CLIENT_ID,
    store: tokenStore,
  })
}
