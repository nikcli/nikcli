import * as AuthSession from "expo-auth-session"
import * as WebBrowser from "expo-web-browser"
import type { DiscoveryDocument } from "expo-auth-session"
import { createTokenTriple, shouldRefreshToken, validateOAuthState, type OAuthTokenTriple } from "./oauth-core"
import { clearOAuthSession, getOAuthIssuer, getOAuthTokens, setOAuthSession } from "./storage"

WebBrowser.maybeCompleteAuthSession()

export const OAUTH_CLIENT_ID = "nikcli-mobile"
export const OAUTH_REDIRECT_URI = "nikcli://auth/callback"
export const DEFAULT_OAUTH_ISSUER = "https://auth.nikcli-ai.dev"

let refreshPromise: Promise<OAuthTokenTriple> | null = null

function isInvalidRefreshToken(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const value = error as { code?: unknown; params?: { error?: unknown } }
  return value.code === "invalid_grant" || value.params?.error === "invalid_grant"
}

function normalizedIssuer(override?: string): string {
  const value = (override || process.env.EXPO_PUBLIC_NIKCLI_AUTH_ISSUER || DEFAULT_OAUTH_ISSUER)
    .trim()
    .replace(/\/+$/, "")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("The OAuth issuer URL is invalid")
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("The OAuth issuer must use HTTPS (HTTP is allowed only for localhost)")
  }
  if (url.search || url.hash) throw new Error("The OAuth issuer URL cannot include a query or fragment")
  return value
}

function endpoint(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`OAuth discovery is missing ${field}`)
  return value
}

export async function discoverOAuthIssuer(
  override?: string,
): Promise<{ issuer: string; discovery: DiscoveryDocument }> {
  const issuer = normalizedIssuer(override)
  const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error(`OAuth discovery failed with ${response.status}`)
  const metadata = (await response.json()) as Record<string, unknown>
  if (typeof metadata.issuer === "string" && normalizedIssuer(metadata.issuer) !== issuer) {
    throw new Error("OAuth discovery returned a different issuer")
  }
  return {
    issuer,
    discovery: {
      authorizationEndpoint: endpoint(metadata.authorization_endpoint, "authorization_endpoint"),
      tokenEndpoint: endpoint(metadata.token_endpoint, "token_endpoint"),
      revocationEndpoint:
        typeof metadata.revocation_endpoint === "string" ? metadata.revocation_endpoint : `${issuer}/revoke`,
      userInfoEndpoint: typeof metadata.userinfo_endpoint === "string" ? metadata.userinfo_endpoint : undefined,
    },
  }
}

export async function loginWithOAuth(issuerOverride?: string): Promise<OAuthTokenTriple> {
  const { issuer, discovery } = await discoverOAuthIssuer(issuerOverride)
  const request = new AuthSession.AuthRequest({
    clientId: OAUTH_CLIENT_ID,
    redirectUri: OAUTH_REDIRECT_URI,
    responseType: AuthSession.ResponseType.Code,
    codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
    usePKCE: true,
  })
  const result = await request.promptAsync(discovery)
  if (result.type === "cancel" || result.type === "dismiss") throw new Error("Sign in was cancelled")
  if (result.type !== "success") {
    throw new Error(
      result.type === "error"
        ? result.params.error_description || result.params.error || "Sign in failed"
        : "Sign in did not complete",
    )
  }
  validateOAuthState(request.state, result.params.state)
  if (!result.params.code) throw new Error("The authorization server did not return a code")
  if (!request.codeVerifier) throw new Error("The PKCE verifier is unavailable")

  const response = await AuthSession.exchangeCodeAsync(
    {
      clientId: OAUTH_CLIENT_ID,
      code: result.params.code,
      redirectUri: OAUTH_REDIRECT_URI,
      extraParams: { code_verifier: request.codeVerifier },
    },
    discovery,
  )
  const tokens = createTokenTriple(response)
  await setOAuthSession(tokens, issuer)
  return tokens
}

async function refreshStoredOAuthTokens(tokens: OAuthTokenTriple, issuer: string): Promise<OAuthTokenTriple> {
  const { discovery } = await discoverOAuthIssuer(issuer)
  const response = await AuthSession.refreshAsync(
    { clientId: OAUTH_CLIENT_ID, refreshToken: tokens.refresh },
    discovery,
  )
  const rotated = createTokenTriple({
    ...response,
    previousRefreshToken: tokens.refresh,
  })
  await setOAuthSession(rotated, issuer)
  return rotated
}

export async function getValidOAuthTokens(force = false): Promise<OAuthTokenTriple | null> {
  const tokens = await getOAuthTokens()
  if (!tokens) return null
  if (!force && !shouldRefreshToken(tokens)) return tokens
  if (!refreshPromise) {
    refreshPromise = getOAuthIssuer()
      .then((issuer) => refreshStoredOAuthTokens(tokens, normalizedIssuer(issuer ?? undefined)))
      .catch(async (error) => {
        if (isInvalidRefreshToken(error)) await clearOAuthSession()
        throw error
      })
      .finally(() => {
        refreshPromise = null
      })
  }
  return refreshPromise
}

export async function revokeOAuthSession(): Promise<void> {
  const [tokens, issuer] = await Promise.all([getOAuthTokens(), getOAuthIssuer()])
  try {
    if (tokens) {
      const { discovery } = await discoverOAuthIssuer(issuer ?? undefined)
      if (discovery.revocationEndpoint) {
        await AuthSession.revokeAsync(
          {
            clientId: OAUTH_CLIENT_ID,
            token: tokens.refresh,
            tokenTypeHint: AuthSession.TokenTypeHint.RefreshToken,
          },
          discovery as DiscoveryDocument & { revocationEndpoint: string },
        )
      }
    }
  } finally {
    await clearOAuthSession()
  }
}
