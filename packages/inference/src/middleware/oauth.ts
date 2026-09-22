import { createRemoteJWKSet, jwtVerify } from "jose"

/**
 * Minimal offline verifier for issuer (auth.nikcli-ai.dev) access tokens.
 * Mirrors @nikcli-ai/auth verify.ts, but avoids the workspace dependency so
 * the standalone Docker build (deploy/package.runtime.json) keeps working.
 */

const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getRemoteJwks(url: string) {
  const cached = remoteJwks.get(url)
  if (cached) return cached
  const created = createRemoteJWKSet(new URL(url))
  remoteJwks.set(url, created)
  return created
}

/**
 * The issuer moved from `*.nikcli-ai.dev` to `*.nikcli-ai.dev` with the same
 * signing keys; tokens minted under either hostname are this issuer's.
 * Mirrors `acceptedIssuers` in @nikcli-ai/auth.
 */
function acceptedIssuers(issuer: string): string[] {
  const legacy = issuer.replace(/\.nikcli-ai\.dev(?=[/:]|$)/, ".nikcli-ai.dev")
  const current = issuer.replace(/\.nikcli\.store(?=[/:]|$)/, ".nikcli-ai.dev")
  return [...new Set([issuer, current, legacy])]
}

export interface OauthContext {
  accountID: string
  email?: string
}

export async function verifyOauthToken(
  token: string,
  options: { issuer: string; audience: string; jwksUrl: string },
): Promise<OauthContext> {
  const verified = await jwtVerify(token, getRemoteJwks(options.jwksUrl), {
    issuer: acceptedIssuers(options.issuer),
    audience: options.audience,
    clockTolerance: 60,
    algorithms: ["ES256", "RS256", "EdDSA"],
  })
  const sub = verified.payload.sub
  if (!sub) throw new Error("Access token is missing a sub claim")
  const email = typeof verified.payload.email === "string" ? verified.payload.email : undefined
  return { accountID: sub, email }
}

export function clearJwksCacheForTests(): void {
  remoteJwks.clear()
}
