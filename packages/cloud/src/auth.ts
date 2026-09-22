import type { MiddlewareHandler } from "hono"
import { parseBearerToken, verifyAccessToken, type VerifyAccessTokenOptions } from "@nikcli-ai/auth"
import { ensureUser } from "./db"
import type { AuthContext, CloudBindings, CloudEnv } from "./types"

export async function verifyAuthToken(token: string, env: CloudBindings): Promise<AuthContext> {
  const options: VerifyAccessTokenOptions = {
    issuer: env.AUTH_ISSUER ?? "https://auth.nikcli-ai.dev",
    audience: env.AUTH_AUDIENCE ?? "nikcli-api",
    jwksUrl: env.AUTH_JWKS_URL,
    jwtSecret: env.AUTH_JWT_SECRET,
  }
  const auth = await verifyAccessToken(token, options)

  return {
    userID: auth.accountID,
    email: auth.email,
    token,
    claims: auth.claims,
  }
}

export async function authenticateRequest(
  request: Request,
  env: CloudBindings,
  options?: { allowQueryToken?: boolean },
): Promise<AuthContext> {
  const requestURL = new URL(request.url)
  const queryToken = options?.allowQueryToken ? requestURL.searchParams.get("token") : null
  const authToken = parseBearerToken(request.headers.get("authorization"))
  const token = authToken ?? queryToken

  if (!token) {
    throw new Error("Missing bearer token")
  }

  return verifyAuthToken(token, env)
}

export const requireAuth: MiddlewareHandler<CloudEnv> = async (c, next) => {
  try {
    const auth = await authenticateRequest(c.req.raw, c.env, {
      allowQueryToken: false,
    })
    await ensureUser(c.env.DB, auth)
    c.set("auth", auth)
    await next()
  } catch {
    return c.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or missing authentication token",
        },
      },
      401,
    )
  }
}
