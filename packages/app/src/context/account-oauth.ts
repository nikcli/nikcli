export const OAUTH_ISSUER =
  (import.meta.env.VITE_NIKCLI_ACCOUNT_URL as string | undefined)?.trim() || "https://auth.nikcli-ai.dev"
export const OAUTH_CLIENT_ID = "nikcli-desktop"
export const OAUTH_REDIRECT_URI = "nikcli://auth/callback"

export type OAuthTokens = {
  access: string
  refresh: string
  expires: number
}

export type OAuthPending = {
  state: string
  verifier: string
  created: number
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const encodeBase64Url = (bytes: Uint8Array) => {
  let value = ""
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const randomBase64Url = (bytes: number) => {
  const value = new Uint8Array(bytes)
  crypto.getRandomValues(value)
  return encodeBase64Url(value)
}

export async function createAuthorizationRequest(now = Date.now()) {
  const verifier = randomBase64Url(32)
  const state = randomBase64Url(32)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  const url = new URL("/authorize", OAUTH_ISSUER)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", OAUTH_CLIENT_ID)
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI)
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", encodeBase64Url(new Uint8Array(digest)))
  url.searchParams.set("code_challenge_method", "S256")
  return {
    url: url.toString(),
    pending: { state, verifier, created: now } satisfies OAuthPending,
  }
}

export function parseAuthCallback(input: string) {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return
  }
  if (url.protocol !== "nikcli:" || url.hostname !== "auth" || url.pathname !== "/callback") return
  return {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    error: url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? undefined,
  }
}

const parseTokenResponse = async (response: Response, fallbackRefresh?: string): Promise<OAuthTokens> => {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error_description?: string
      error?: string
    } | null
    throw new OAuthTokenError(body?.error_description ?? body?.error ?? "Authentication failed", response.status)
  }
  const body = (await response.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }
  if (typeof body.access_token !== "string" || !body.access_token)
    throw new Error("Token response is missing access_token")
  const refresh = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : fallbackRefresh
  if (!refresh) throw new Error("Token response is missing refresh_token")
  if (typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw new Error("Token response has an invalid expires_in")
  }
  return {
    access: body.access_token,
    refresh,
    expires: Date.now() + body.expires_in * 1000,
  }
}

export class OAuthTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(`${message} (${status})`)
    this.name = "OAuthTokenError"
  }
}

export async function exchangeAuthorizationCode(code: string, verifier: string, fetcher: Fetcher = globalThis.fetch) {
  const response = await fetcher(new URL("/oauth/token", OAUTH_ISSUER), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      code,
      code_verifier: verifier,
    }),
  })
  return parseTokenResponse(response)
}

export async function refreshOAuthTokens(current: OAuthTokens, fetcher: Fetcher = globalThis.fetch) {
  const response = await fetcher(new URL("/oauth/token", OAUTH_ISSUER), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: OAUTH_CLIENT_ID,
    }),
  })
  return parseTokenResponse(response, current.refresh)
}

export const isOAuthTokens = (value: unknown): value is OAuthTokens => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const token = value as Partial<OAuthTokens>
  return typeof token.access === "string" && typeof token.refresh === "string" && typeof token.expires === "number"
}
