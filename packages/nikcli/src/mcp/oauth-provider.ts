import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { McpAuth } from "./auth"
import { Log } from "@nikcli-ai/util/log"
import { Effect } from "effect"
import { runPromiseWithLayer } from "@/effect"

const log = Log.create({ service: "mcp.oauth" })

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
}

export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
  ) {}

  private runAuth<A, E>(effect: Effect.Effect<A, E, McpAuth.Service>) {
    return runPromiseWithLayer(McpAuth.defaultLayer, effect)
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Nikcli",
      client_uri: "https://nikcli-ai.dev",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }
    }

    const mcpName = this.mcpName
    const serverUrl = this.serverUrl
    const entry = await this.runAuth(
      Effect.gen(function* () {
        const auth = yield* McpAuth.Service
        return yield* auth.getForUrl(mcpName, serverUrl)
      }),
    )
    if (entry?.clientInfo) {
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        log.info("client secret expired, need to re-register", { mcpName: this.mcpName })
        return undefined
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
      }
    }

    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    const mcpName = this.mcpName
    const serverUrl = this.serverUrl
    await this.runAuth(
      Effect.gen(function* () {
        const auth = yield* McpAuth.Service
        yield* auth.updateClientInfo(
          mcpName,
          {
            clientId: info.client_id,
            clientSecret: info.client_secret,
            clientIdIssuedAt: info.client_id_issued_at,
            clientSecretExpiresAt: info.client_secret_expires_at,
          },
          serverUrl,
        )
      }),
    )
    log.info("saved dynamically registered client", {
      mcpName: this.mcpName,
      clientId: info.client_id,
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const mcpName = this.mcpName
    const serverUrl = this.serverUrl
    const entry = await this.runAuth(
      Effect.gen(function* () {
        const auth = yield* McpAuth.Service
        return yield* auth.getForUrl(mcpName, serverUrl)
      }),
    )
    if (!entry?.tokens) return undefined

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const mcpName = this.mcpName
    const serverUrl = this.serverUrl
    await this.runAuth(
      Effect.gen(function* () {
        const auth = yield* McpAuth.Service
        yield* auth.updateTokens(
          mcpName,
          {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
            scope: tokens.scope,
          },
          serverUrl,
        )
      }),
    )
    log.info("saved oauth tokens", { mcpName: this.mcpName })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info("redirecting to authorization", { mcpName: this.mcpName, url: authorizationUrl.toString() })
    await this.callbacks.onRedirect(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const mcpName = this.mcpName
    await this.runAuth(
      Effect.gen(function* () {
        const auth = yield* McpAuth.Service
        yield* auth.updateCodeVerifier(mcpName, codeVerifier)
      }),
    )
  }

  async codeVerifier(): Promise<string> {
    const mcpName = this.mcpName
    const entry = await this.runAuth(
      Effect.gen(function* () {
        const auth = yield* McpAuth.Service
        return yield* auth.get(mcpName)
      }),
    )
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    return entry.codeVerifier
  }

  async saveState(state: string): Promise<void> {
    const mcpName = this.mcpName
    await this.runAuth(
      Effect.gen(function* () {
        const auth = yield* McpAuth.Service
        yield* auth.updateOAuthState(mcpName, state)
      }),
    )
  }

  async state(): Promise<string> {
    const mcpName = this.mcpName
    const entry = await this.runAuth(
      Effect.gen(function* () {
        const auth = yield* McpAuth.Service
        return yield* auth.get(mcpName)
      }),
    )
    if (!entry?.oauthState) {
      throw new Error(`No OAuth state saved for MCP server: ${this.mcpName}`)
    }
    return entry.oauthState
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }
