import type { Hooks, PluginInput } from "@nikcli-ai/plugin"
import { Log } from "@nikcli-ai/util/log"
import { OAUTH_DUMMY_KEY } from "../auth"
import { ProviderOAuth } from "./oauth-refresh"
import { createServer } from "http"
import type { IncomingMessage, ServerResponse } from "http"
import type { AddressInfo } from "net"

const log = Log.create({ service: "plugin.xai" })

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const XAI_ISSUER = "https://auth.x.ai"
const XAI_DISCOVERY_URL = `${XAI_ISSUER}/.well-known/openid-configuration`
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access"
const OAUTH_REDIRECT_HOST = "127.0.0.1"
const OAUTH_REDIRECT_PORT = 56121
const OAUTH_REDIRECT_PATH = "/callback"
const USER_AGENT = "Hermes-Agent/1.0"

interface PkceCodes {
  verifier: string
  challenge: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

interface TokenExchangeResponse extends TokenResponse {
  refresh_token: string
}

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenExchangeResponse) => void
  reject: (error: Error) => void
}

interface DiscoveryEndpoints {
  authorization_endpoint: string
  token_endpoint: string
}

let cachedEndpoints: DiscoveryEndpoints | undefined
let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

async function discoverEndpoints(): Promise<DiscoveryEndpoints> {
  if (cachedEndpoints) return cachedEndpoints

  const response = await fetch(XAI_DISCOVERY_URL, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  })
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status}`)
  }

  const data = (await response.json()) as Record<string, unknown>
  const authorizationEndpoint = String(data.authorization_endpoint)
  const tokenEndpoint = String(data.token_endpoint)

  validateEndpoint(authorizationEndpoint, "authorization_endpoint")
  validateEndpoint(tokenEndpoint, "token_endpoint")

  cachedEndpoints = {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
  }
  return cachedEndpoints
}

function validateEndpoint(url: string, name: string) {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid ${name}: must use HTTPS`)
  }
  const host = parsed.hostname
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`Invalid ${name}: host must be x.ai or *.x.ai`)
  }
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string, authorizationEndpoint: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: XAI_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
    nonce: generateState(),
    plan: "generic",
    referrer: "hermes-agent",
  })
  return `${authorizationEndpoint}?${params.toString()}`
}

function getCallbackCorsOrigin(origin: string | undefined): string {
  if (!origin) return ""
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== "https:") return ""
    if (parsed.hostname === "x.ai" || parsed.hostname.endsWith(".x.ai")) return parsed.origin
    if (parsed.hostname === "grok.com" || parsed.hostname.endsWith(".grok.com")) return parsed.origin
  } catch {}
  return ""
}

function writeCallbackCorsHeaders(req: IncomingMessage, res: ServerResponse) {
  const origin = getCallbackCorsOrigin(Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin)
  if (!origin) return
  const requestedHeaders = req.headers["access-control-request-headers"]
  res.setHeader("Access-Control-Allow-Origin", origin)
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  res.setHeader(
    "Access-Control-Allow-Headers",
    typeof requestedHeaders === "string" && requestedHeaders.trim() ? requestedHeaders : "Content-Type",
  )
  res.setHeader("Access-Control-Allow-Private-Network", "true")
  res.setHeader("Access-Control-Max-Age", "600")
  res.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
  tokenEndpoint: string,
): Promise<TokenExchangeResponse> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: XAI_CLIENT_ID,
      code_verifier: pkce.verifier,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}: ${await response.text().catch(() => "")}`)
  }
  const tokens = (await response.json()) as TokenResponse
  if (!tokens.access_token) throw new Error("Token exchange failed: missing access_token")
  if (!tokens.refresh_token) throw new Error("Token exchange failed: missing refresh_token")
  return tokens as TokenExchangeResponse
}

async function refreshAccessToken(refreshToken: string, tokenEndpoint: string): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: XAI_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    // 400/401: the refresh token was revoked, already spent, or is too old.
    // Retrying cannot fix that; only a new sign-in can.
    if (response.status === 400 || response.status === 401) {
      throw new Error(
        `SuperGrok sign-in expired (${response.status}). Run \`nikcli auth login xai\` to reconnect.${detail ? ` ${detail}` : ""}`,
      )
    }
    throw new Error(`Token refresh failed: ${response.status}: ${detail}`)
  }
  const tokens = (await response.json()) as TokenResponse
  if (!tokens.access_token) throw new Error("Token refresh failed: missing access_token")
  return tokens
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>nikcli - xAI Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #0a0a0a;
        color: #f5f5f5;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f5f5f5;
        margin-bottom: 1rem;
      }
      p {
        color: #a0a0a0;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to nikcli.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>nikcli - xAI Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #0a0a0a;
        color: #f5f5f5;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #ff4444;
        margin-bottom: 1rem;
      }
      p {
        color: #a0a0a0;
      }
      .error {
        color: #ff8888;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #2a0a0a;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${error}</div>
    </div>
  </body>
</html>`

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    const address = oauthServer.address()
    if (address && typeof address === "object") {
      return {
        port: address.port,
        redirectUri: `http://${OAUTH_REDIRECT_HOST}:${address.port}${OAUTH_REDIRECT_PATH}`,
      }
    }
  }

  let serverPort = 0

  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${OAUTH_REDIRECT_HOST}:${serverPort}`)

    if (req.method === "OPTIONS") {
      writeCallbackCorsHeaders(req, res)
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === "GET" && url.pathname === OAUTH_REDIRECT_PATH) {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      if (error) {
        const errorMsg = errorDescription || error
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        writeCallbackCorsHeaders(req, res)
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!code) {
        const errorMsg = "Missing authorization code"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        writeCallbackCorsHeaders(req, res)
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!pendingOAuth || state !== pendingOAuth.state) {
        const errorMsg = "Invalid state - potential CSRF attack"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        writeCallbackCorsHeaders(req, res)
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      const current = pendingOAuth
      pendingOAuth = undefined

      const redirectUri = `http://${OAUTH_REDIRECT_HOST}:${serverPort}${OAUTH_REDIRECT_PATH}`
      discoverEndpoints()
        .then((endpoints) => exchangeCodeForTokens(code, redirectUri, current.pkce, endpoints.token_endpoint))
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err))

      writeCallbackCorsHeaders(req, res)
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(HTML_SUCCESS)
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  await new Promise<void>((resolve, reject) => {
    let triedEphemeral = false
    oauthServer!.listen(OAUTH_REDIRECT_PORT, OAUTH_REDIRECT_HOST, () => {
      const address = oauthServer!.address() as AddressInfo
      serverPort = address.port
      log.info("xai oauth server started", { port: serverPort })
      resolve()
    })
    oauthServer!.on("error", (error: Error & { code?: string }) => {
      if (serverPort || error.code !== "EADDRINUSE" || triedEphemeral) {
        reject(error)
        return
      }
      triedEphemeral = true
      oauthServer!.listen(0, OAUTH_REDIRECT_HOST, () => {
        const address = oauthServer!.address() as AddressInfo
        serverPort = address.port
        log.info("xai oauth server started", { port: serverPort })
        resolve()
      })
    })
  })

  return {
    port: serverPort,
    redirectUri: `http://${OAUTH_REDIRECT_HOST}:${serverPort}${OAUTH_REDIRECT_PATH}`,
  }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.close(() => {
      log.info("xai oauth server stopped")
    })
    oauthServer = undefined
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenExchangeResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      },
      5 * 60 * 1000,
    )

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

export async function XAIAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    provider: {
      id: "xai",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") return provider.models

        const baseModels = Object.fromEntries(
          Object.entries(provider.models).map(([id, model]) => [
            id,
            { ...model, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
          ]),
        )

        // xAI now serves the Cursor Composer model through its own OAuth API, so
        // expose it in the xAI provider's model list for SuperGrok users. It's a
        // real, billable xAI-served model (not a test/staging stub). Because it
        // lives under the `xai` provider it inherits the Responses-API routing
        // from the `xai` custom loader; and since it's a tool-using coding model
        // (not a multi-agent variant) it keeps client-side tools — the transform's
        // `isMultiAgent` check leaves `composer-*` untouched.
        // Family "cursor" lets the family/context heuristics pick up the right
        // metadata (200k context, 32k output).
        const composerModel = Object.values(baseModels)[0]
        if (composerModel) {
          baseModels["composer-2.5"] = {
            ...composerModel,
            // Override api.id too — the template is a grok model, so without this
            // the request would be sent to xAI as `responses("grok-…")` instead of
            // the composer model the user actually selected.
            api: { ...composerModel.api, id: "composer-2.5" },
            name: "Cursor Composer 2.5",
            family: "cursor",
            limit: { ...composerModel.limit, context: 200_000, output: 32_000 },
          }
        }

        return baseModels
      },
    },
    auth: {
      provider: "xai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        const renew = (rejected?: string) =>
          ProviderOAuth.renew({
            providerID: "xai",
            read: getAuth,
            rejected,
            async exchange(stored) {
              const endpoints = await discoverEndpoints()
              const tokens = await refreshAccessToken(stored.refresh, endpoints.token_endpoint)
              return {
                access: tokens.access_token,
                refresh: tokens.refresh_token || stored.refresh,
                expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
              }
            },
            async write(tokens) {
              const result = await input.client.auth.set({
                providerID: "xai",
                payload: { type: "oauth", refresh: tokens.refresh, access: tokens.access, expires: tokens.expires },
              })
              if (result.error) throw result.error
            },
          })

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
              } else {
                delete (init.headers as Record<string, string>)["authorization"]
                delete (init.headers as Record<string, string>)["Authorization"]
              }
            }

            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // The stored credential is readonly, so a renewed one is held
            // locally for the rest of this request.
            let session: ProviderOAuth.Tokens = currentAuth as ProviderOAuth.Stored
            if (ProviderOAuth.expiring(session)) session = await renew()

            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }

            headers.set("authorization", `Bearer ${session.access}`)
            headers.set("User-Agent", USER_AGENT)

            const next = { ...init, headers }
            const response = await fetch(requestInput, next)
            // A 401 on a token the deadline still called valid means xAI retired
            // it early; renew once and replay rather than fail the turn.
            if (response.status !== 401) return response
            if (requestInput instanceof Request || !ProviderOAuth.replayable(init?.body)) return response
            const renewed = await renew(session.access).catch((error: unknown) => {
              log.warn("xai token renewal after 401 failed", {
                error: error instanceof Error ? error.message : String(error),
              })
              return undefined
            })
            if (!renewed) return response
            await response.body?.cancel().catch(() => {})
            headers.set("authorization", `Bearer ${renewed.access}`)
            return fetch(requestInput, next)
          },
        }
      },
      methods: [
        {
          label: "SuperGrok",
          type: "oauth",
          authorize: async (_inputs?: Record<string, string>) => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const endpoints = await discoverEndpoints()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state, endpoints.authorization_endpoint)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions:
                "Complete authorization in your browser. If xAI shows a 'Could not establish connection' page, paste the displayed code here.",
              method: "auto-code" as const,
              callback: async (code?: string) => {
                try {
                  const tokens = code?.trim()
                    ? await exchangeCodeForTokens(code.trim(), redirectUri, pkce, endpoints.token_endpoint)
                    : await callbackPromise
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  }
                } finally {
                  stopOAuthServer()
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
