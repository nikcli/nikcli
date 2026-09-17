import type { Hooks, PluginInput } from "@nikcli-ai/plugin"
import { Flag } from "@nikcli-ai/util/flag"
import { Log } from "@nikcli-ai/util/log"
import { OAUTH_DUMMY_KEY } from "../auth"
import { OpenAIWebSocketPool } from "./openai/ws-pool"

export interface CodexAuthPluginOptions {
  experimentalWebSockets?: boolean
  /**
   * Fall back to `gpt-reserve` when the plan's main models are exhausted.
   * Defaults to on; `NIKCLI_DISABLE_GPT_RESERVE_FALLBACK=1` opts out.
   */
  reserveFallback?: boolean
}

const log = Log.create({ service: "plugin.codex" })

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
/**
 * The model a ChatGPT plan falls back to once its main models are used up.
 * OpenAI hides it from the Codex model picker (`visibility: "hide"`) and only
 * surfaces it when a usage limit is hit; nikcli does the same, plus it can be
 * picked by hand once the OAuth session has it in the catalog.
 */
export const RESERVE_MODEL_ID = "gpt-reserve"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455

interface PkceCodes {
  verifier: string
  challenge: string
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

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "nikcli",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

type CodexOAuthModel = {
  api: {
    id: string
  }
}

// gpt-6 and later ship to ChatGPT plans at launch, so the whole family is
// allowed by rule rather than by a per-id entry in the list above. The major
// version is read numerically rather than matched as a prefix, so "gpt-60"
// resolves to major 60 instead of accidentally reading as gpt-6. GPT-6 Astra
// ("gpt-6-astra", Codex CLI v0.153.1) is the first id this covers, and its
// "-aeon" sibling slug is covered by the same rule.
const GPT_MAJOR_VERSION_RE = /^gpt-(\d+)(?:[.-]|$)/

function gptMajorVersion(apiId: string) {
  const match = GPT_MAJOR_VERSION_RE.exec(apiId)
  return match ? Number(match[1]) : undefined
}

export function filterCodexOAuthModels(provider: { models: Record<string, CodexOAuthModel> }) {
  const allowedModels = new Set([
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    // The plan's reserve model. It is version-less, so neither the allow-list
    // prefix rules nor the >= gpt-6 rule below would keep it.
    RESERVE_MODEL_ID,
  ])
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (modelId.includes("codex")) continue
    if (allowedModels.has(model.api.id)) continue
    const major = gptMajorVersion(model.api.id)
    if (major !== undefined && major >= 6) continue
    const match = model.api.id.match(/^gpt-(\d+\.\d+)/)
    if (match && parseFloat(match[1]) > 5.4) continue
    delete provider.models[modelId]
  }
}

// ─── Reserve fallback ────────────────────────────────────────────────────────
//
// A ChatGPT plan meters the main models (gpt-6-astra, gpt-5.x, the codex
// slugs) separately from `gpt-reserve`. When the main allowance runs out the
// Codex backend answers 429 with a rate-limit-reached marker, and Codex CLI
// nudges you onto the reserve model. nikcli does it without the prompt: the
// exhausted model is remembered until its window resets and every request for
// it is rewritten to `gpt-reserve` on the way out.
//
// State is per process and deliberately not persisted — a stale "exhausted"
// entry would keep a recovered plan pinned to the reserve, and re-probing
// costs at most one request per window.

/** Reset horizon used when the 429 carries no hint about when the window reopens. */
const RESERVE_LIMIT_DEFAULT_MS = 15 * 60 * 1000
/** Upper bound on a parsed reset, so a bogus value cannot pin a session to the reserve. */
const RESERVE_LIMIT_MAX_MS = 7 * 24 * 60 * 60 * 1000

/** api id → epoch ms at which the model's plan allowance is expected back. */
const exhausted = new Map<string, number>()

/** Effort tiers `gpt-reserve` accepts; anything else 400s on the reserve. */
const RESERVE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"])

/**
 * Map an effort the main model accepted onto the nearest tier the reserve has.
 * gpt-6 exposes `none`/`minimal` at the bottom and `ultra` above `max`; the
 * reserve has neither end.
 */
function clampReserveEffort(effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined
  if (RESERVE_EFFORTS.has(effort)) return undefined
  if (effort === "none" || effort === "minimal") return "low"
  if (effort === "ultra") return "max"
  return "medium"
}

export function readRequestModel(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body)
    return typeof parsed?.model === "string" ? parsed.model : undefined
  } catch {
    return undefined
  }
}

/**
 * Rewrite a Responses request onto the reserve model. Returns undefined when
 * the body is not JSON we can safely rewrite, in which case the caller leaves
 * the request alone rather than guessing.
 */
export function withReserveModel(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body)
    if (!parsed || typeof parsed !== "object") return undefined
    parsed.model = RESERVE_MODEL_ID
    const effort = clampReserveEffort(parsed.reasoning?.effort)
    if (effort) parsed.reasoning.effort = effort
    return JSON.stringify(parsed)
  } catch {
    return undefined
  }
}

/**
 * Whether a 429 means "the plan's allowance for this model is spent" rather
 * than "you are sending too fast". Only the former should burn the fallback —
 * a throughput throttle is retried by the session at the same model.
 */
export function isUsageLimitResponse(status: number, headers: Headers, body: string) {
  if (status !== 429) return false
  if (headers.get("x-codex-rate-limit-reached-type")) return true
  return /usage[ _-]?limit|rate[ _-]?limit[ _-]?reached|credits[ _-]?depleted/i.test(body)
}

/** When the exhausted model is expected to be callable again. */
export function usageLimitResetAt(headers: Headers, body: string, now: number) {
  const bounded = (ms: number) => now + Math.min(Math.max(ms, 0), RESERVE_LIMIT_MAX_MS)

  const retryAfter = Number.parseFloat(headers.get("retry-after") ?? "")
  if (Number.isFinite(retryAfter) && retryAfter > 0) return bounded(retryAfter * 1000)

  const resetsIn = /"resets?_in_seconds"\s*:\s*(\d+(?:\.\d+)?)/.exec(body)
  if (resetsIn) return bounded(Number(resetsIn[1]) * 1000)

  // `resets_at` is epoch seconds in the Codex rate-limit snapshot.
  const resetsAt = /"resets_at"\s*:\s*(\d+(?:\.\d+)?)/.exec(body)
  if (resetsAt) {
    const at = Number(resetsAt[1]) * 1000
    if (at > now) return bounded(at - now)
  }

  return bounded(RESERVE_LIMIT_DEFAULT_MS)
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>Nikcli - Codex Authorization Successful</title>
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
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to Nikcli.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>Nikcli - Codex Authorization Failed</title>
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
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
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

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  oauthServer = Bun.serve({
    port: OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        if (error) {
          const errorMsg = errorDescription || error
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!code) {
          const errorMsg = "Missing authorization code"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!pendingOAuth || state !== pendingOAuth.state) {
          const errorMsg = "Invalid state - potential CSRF attack"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        const current = pendingOAuth
        pendingOAuth = undefined

        exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
          .then((tokens) => current.resolve(tokens))
          .catch((err) => current.reject(err))

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        })
      }

      if (url.pathname === "/cancel") {
        pendingOAuth?.reject(new Error("Login cancelled"))
        pendingOAuth = undefined
        return new Response("Login cancelled", { status: 200 })
      }

      return new Response("Not found", { status: 404 })
    },
  })

  log.info("codex oauth server started", { port: OAUTH_PORT })
  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.stop()
    oauthServer = undefined
    log.info("codex oauth server stopped")
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
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

export async function CodexAuthPlugin(input: PluginInput, options: CodexAuthPluginOptions = {}): Promise<Hooks> {
  const websocketFetches: Array<ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>> = []

  return {
    async dispose() {
      for (const websocketFetch of websocketFetches) websocketFetch.close()
      websocketFetches.length = 0
    },
    auth: {
      provider: "openai",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        const websocketFetch = options.experimentalWebSockets
          ? OpenAIWebSocketPool.createWebSocketFetch({ httpFetch: fetch })
          : undefined
        if (websocketFetch) websocketFetches.push(websocketFetch)
        if (auth.type !== "oauth") return websocketFetch ? { fetch: websocketFetch } : {}

        filterCodexOAuthModels(provider)

        // On unless explicitly disabled: without it a spent plan just errors,
        // which is the one moment the reserve model exists for.
        const reserveFallback =
          (options.reserveFallback ?? true) &&
          !Flag.NIKCLI_DISABLE_GPT_RESERVE_FALLBACK &&
          RESERVE_MODEL_ID in provider.models

        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

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
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
              }
            }

            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth")
              return websocketFetch ? websocketFetch(requestInput, init) : fetch(requestInput, init)

            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string }

            // The stored credential is readonly, so the refreshed token is held
            // locally for the rest of this request.
            let access = currentAuth.access
            if (!access || currentAuth.expires < Date.now()) {
              log.info("refreshing codex access token")
              const tokens = await refreshAccessToken(currentAuth.refresh)
              const newAccountId = extractAccountId(tokens) || authWithAccount.accountId
              await input.client.auth.set({
                providerID: "codex",
                payload: {
                  type: "oauth",
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  ...(newAccountId && { accountId: newAccountId }),
                },
              })
              access = tokens.access_token
              authWithAccount.accountId = newAccountId
            }

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

            headers.set("authorization", `Bearer ${access}`)

            if (authWithAccount.accountId) {
              headers.set("ChatGPT-Account-Id", authWithAccount.accountId)
            }

            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
            const url =
              parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
                ? new URL(CODEX_API_ENDPOINT)
                : parsed

            const requestInit: RequestInit = {
              ...init,
              headers,
            }

            const send = (body?: string) => {
              const next = body === undefined ? requestInit : { ...requestInit, body }
              if (websocketFetch && parsed.pathname.includes("/v1/responses")) return websocketFetch(url, next)
              return fetch(url, OpenAIWebSocketPool.withoutInternalHeaders(next))
            }

            // Only model calls can fall back, and only when we can read the
            // model out of the body to rewrite it.
            const body = requestInit.body
            if (!reserveFallback || url.href !== CODEX_API_ENDPOINT || typeof body !== "string") return send()

            const requested = readRequestModel(body)
            if (!requested || requested === RESERVE_MODEL_ID) return send()

            // Already known to be out of allowance: skip the doomed request.
            const until = exhausted.get(requested)
            if (until !== undefined) {
              if (until > Date.now()) {
                const rewritten = withReserveModel(body)
                if (rewritten) return send(rewritten)
              } else {
                exhausted.delete(requested)
              }
            }

            const response = await send()
            if (response.status !== 429) return response

            // Safe to drain: this is an error response, never the SSE stream.
            const text = await response.text()
            const replay = () =>
              new Response(text, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              })
            if (!isUsageLimitResponse(response.status, response.headers, text)) return replay()

            const rewritten = withReserveModel(body)
            if (!rewritten) return replay()

            const resetAt = usageLimitResetAt(response.headers, text, Date.now())
            exhausted.set(requested, resetAt)
            log.info("plan usage limit reached, falling back to the reserve model", {
              model: requested,
              reserve: RESERVE_MODEL_ID,
              resetAt: new Date(resetAt).toISOString(),
            })
            input.client.tui
              .showToast({
                title: "Usage limit",
                message: `${requested} is out of plan allowance — continuing on ${RESERVE_MODEL_ID}`,
                variant: "warning",
                duration: 8000,
              })
              .catch(() => {})
            return send(rewritten)
          },
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                const accountId = extractAccountId(tokens)
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId,
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
