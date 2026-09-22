import { createRemoteJWKSet, jwtVerify } from "jose"
import type { JWTVerifyOptions } from "jose"
import { AuthClaims, type AuthContext } from "./claims"

const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export type VerifyAccessTokenOptions = {
  issuer: string
  audience: string
  jwksUrl?: string
  jwtSecret?: string | Uint8Array
  clockTolerance?: number | string
}

/**
 * The issuer moved from `*.nikcli-ai.dev` to `*.nikcli-ai.dev` with the same
 * signing keys, so a token minted under either hostname is the same issuer's.
 * Accepting both keeps tokens valid across the move whichever side deploys
 * first, and keeps installs still configured with the old URL working.
 */
export function acceptedIssuers(issuer: string): string[] {
  const legacy = issuer.replace(/\.nikcli-ai\.dev(?=[/:]|$)/, ".nikcli-ai.dev")
  const current = issuer.replace(/\.nikcli\.store(?=[/:]|$)/, ".nikcli-ai.dev")
  return [...new Set([issuer, current, legacy])]
}

function getRemoteJwks(url: string) {
  const cached = remoteJwks.get(url)
  if (cached) return cached
  const created = createRemoteJWKSet(new URL(url))
  remoteJwks.set(url, created)
  return created
}

export async function verifyAccessToken(token: string, options: VerifyAccessTokenOptions): Promise<AuthContext> {
  if (!options.jwksUrl && !options.jwtSecret) {
    throw new Error("Missing auth verifier configuration")
  }

  const verifyOptions: JWTVerifyOptions = {
    issuer: acceptedIssuers(options.issuer),
    audience: options.audience,
    clockTolerance: options.clockTolerance ?? 60,
    algorithms: options.jwksUrl ? ["ES256", "RS256", "EdDSA"] : ["HS256"],
  }
  const verified = options.jwksUrl
    ? await jwtVerify(token, getRemoteJwks(options.jwksUrl), verifyOptions)
    : await jwtVerify(
        token,
        typeof options.jwtSecret === "string" ? new TextEncoder().encode(options.jwtSecret) : options.jwtSecret!,
        verifyOptions,
      )
  const claims = AuthClaims.parse(verified.payload)

  return {
    accountID: claims.sub,
    email: claims.email,
    clientID: claims.client_id,
    claims,
  }
}

export function clearRemoteJwksCache(): void {
  remoteJwks.clear()
}
