import path from "path"
import { Global } from "@nikcli-ai/util/global"
import fs from "fs/promises"
import z from "zod"
import { Lock } from "../util/lock"
import { Log } from "@nikcli-ai/util/log"
import { UserFacingError } from "@nikcli-ai/util/user-error"
import { zod, zodObject } from "@nikcli-ai/util/effect-zod"
import { Context, Effect, Layer, Schema } from "effect"

export const OAUTH_DUMMY_KEY = "nikcli-oauth-dummy-key"

export namespace Auth {
  const log = Log.create({ service: "auth" })

  const SAFE_CURL_FLAGS = new Set([
    "-f",
    "-s",
    "-S",
    "-L",
    "-fsS",
    "-fsSL",
    "-sS",
    "-sSL",
    "-SL",
    "--fail",
    "--silent",
    "--show-error",
    "--location",
  ])
  const SAFE_WGET_FLAGS = new Set(["-q", "--quiet", "-O-", "-qO-"])
  const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

  const OauthSchema = Schema.Struct({
    type: Schema.Literal("oauth"),
    refresh: Schema.String,
    access: Schema.String,
    expires: Schema.Number,
    accountId: Schema.optional(Schema.String),
    enterpriseUrl: Schema.optional(Schema.String),
  }).annotate({ identifier: "OAuth" })
  export const Oauth = zodObject(OauthSchema)

  const ApiSchema = Schema.Struct({
    type: Schema.Literal("api"),
    key: Schema.String,
  }).annotate({ identifier: "ApiAuth" })
  export const Api = zodObject(ApiSchema)

  const WellKnownSchema = Schema.Struct({
    type: Schema.Literal("wellknown"),
    key: Schema.String,
    token: Schema.String,
  }).annotate({ identifier: "WellKnownAuth" })
  export const WellKnown = zodObject(WellKnownSchema)

  export const InfoSchema = Schema.Union([OauthSchema, ApiSchema, WellKnownSchema]).annotate({ identifier: "Auth" })
  export const Info = zod(InfoSchema)
  export type Info = Schema.Schema.Type<typeof InfoSchema>

  export const WellKnownAuthResponse = zodObject(
    Schema.Struct({
      auth: Schema.Struct({
        command: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))).pipe(
          Schema.check(Schema.isMinLength(1)),
        ),
        env: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/))),
      }),
    }),
  )

  /**
   * Tagged errors that the auth service can surface through the Effect
   * error channel. Each is a `Schema.TaggedError` so call sites can use
   * `Effect.catchTag("AuthNotFound", ...)` and `instanceof` continues to
   * work for plain `try/catch` paths.
   */
  export class NotFoundError extends Schema.TaggedError<NotFoundError>()("AuthNotFound", {
    message: Schema.String,
    providerID: Schema.String,
  }) {}

  export class NotOAuthProviderError extends Schema.TaggedError<NotOAuthProviderError>()("AuthNotOAuthProvider", {
    message: Schema.String,
    providerID: Schema.String,
  }) {}

  export class TokenRefreshError extends Schema.TaggedError<TokenRefreshError>()("AuthTokenRefresh", {
    message: Schema.String,
    providerID: Schema.String,
    status: Schema.optional(Schema.Number),
    responseBody: Schema.optional(Schema.String),
  }) {}

  export class WellKnownError extends Schema.TaggedError<WellKnownError>()("AuthWellKnown", {
    message: Schema.String,
  }) {}

  export class IOError extends Schema.TaggedError<IOError>()("AuthIOError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }) {}

  /**
   * Union of all errors that any `Auth.Service` method can fail with.
   * Includes `UserFacingError` for the user-presentable 401/400 path on
   * token refresh.
   */
  export type Error =
    | NotFoundError
    | NotOAuthProviderError
    | TokenRefreshError
    | WellKnownError
    | IOError
    | UserFacingError

  /**
   * Preserve typed auth errors thrown by the impl. Anything we recognize
   * passes through unchanged; untyped `Error` instances become
   * `Auth.IOError`; everything else is wrapped in `IOError` so the Effect
   * error channel stays typed at the `Auth.Error` union.
   */
  function asAuthError(e: unknown): Error {
    if (
      e instanceof NotFoundError ||
      e instanceof NotOAuthProviderError ||
      e instanceof TokenRefreshError ||
      e instanceof WellKnownError ||
      e instanceof IOError ||
      e instanceof UserFacingError
    ) {
      return e
    }
    if (e instanceof Error) {
      return new IOError({ message: e.message, cause: e })
    }
    return new IOError({ message: String(e) })
  }

  export interface Interface {
    fetchWellKnown(baseURL: string): Effect.Effect<Response, Error>
    fetchWellKnownToken(baseURL: string, command: string[]): Effect.Effect<string, Error>
    get(providerID: string): Effect.Effect<Info | undefined, never>
    all(): Effect.Effect<Record<string, Info>, never>
    set(key: string, info: Info): Effect.Effect<void, Error>
    remove(key: string): Effect.Effect<void, Error>
    refresh(providerID: string): Effect.Effect<z.infer<typeof Oauth>, Error>
    getValid(providerID: string): Effect.Effect<Info | undefined, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("Auth.Service") {}

  export const layer = Layer.succeed(
    Service,
    Service.of({
      fetchWellKnown: (baseURL) => Effect.tryPromise({ try: () => fetchWellKnownImpl(baseURL), catch: asAuthError }),
      fetchWellKnownToken: (baseURL, command) =>
        Effect.tryPromise({ try: () => fetchWellKnownTokenImpl(baseURL, command), catch: asAuthError }),
      get: (providerID) => Effect.promise(() => getImpl(providerID)),
      all: () => Effect.promise(() => allImpl()),
      set: (key, info) => Effect.tryPromise({ try: () => setImpl(key, info), catch: asAuthError }),
      remove: (key) => Effect.tryPromise({ try: () => removeImpl(key), catch: asAuthError }),
      refresh: (providerID) => Effect.tryPromise({ try: () => refreshImpl(providerID), catch: asAuthError }),
      getValid: (providerID) => Effect.tryPromise({ try: () => getValidImpl(providerID), catch: asAuthError }),
    }),
  )

  export const defaultLayer = layer

  function filepath() {
    return path.join(Global.Path.data, "auth.json")
  }

  function sameOriginURL(baseURL: string, value: string) {
    const base = new URL(baseURL)
    const resolved = new URL(value, baseURL)
    if (resolved.origin !== base.origin) return
    return resolved.toString()
  }

  function extractCurlURL(baseURL: string, command: string[]) {
    let url: string | undefined
    for (const arg of command.slice(1)) {
      if (arg.startsWith("-")) {
        if (!SAFE_CURL_FLAGS.has(arg)) return
        continue
      }
      if (url) return
      url = arg
    }
    if (!url) return
    return sameOriginURL(baseURL, url)
  }

  function extractWgetURL(baseURL: string, command: string[]) {
    let url: string | undefined
    for (let i = 1; i < command.length; i++) {
      const arg = command[i]
      if (SAFE_WGET_FLAGS.has(arg)) continue
      if (arg === "-O") {
        if (command[i + 1] !== "-") return
        i++
        continue
      }
      if (arg.startsWith("-")) return
      if (url) return
      url = arg
    }
    if (!url) return
    return sameOriginURL(baseURL, url)
  }

  async function fetchSameOrigin(url: string, maxRedirects = 5): Promise<Response> {
    const origin = new URL(url).origin
    let current = url

    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const response = await fetch(current, { redirect: "manual" })
      if (!REDIRECT_STATUS.has(response.status)) {
        return response
      }

      const location = response.headers.get("location")
      if (!location) {
        throw new WellKnownError({ message: "Well-known endpoint returned a redirect without a location" })
      }

      if (redirects === maxRedirects) {
        throw new WellKnownError({ message: "Too many well-known redirects" })
      }

      const next = new URL(location, current)
      if (next.origin !== origin) {
        throw new WellKnownError({ message: "Cross-origin well-known redirects are not allowed" })
      }

      current = next.toString()
    }

    throw new WellKnownError({ message: "Too many well-known redirects" })
  }

  async function fetchWellKnownImpl(baseURL: string) {
    return fetchSameOrigin(new URL("/.well-known/nikcli", baseURL).toString())
  }

  async function fetchWellKnownTokenImpl(baseURL: string, command: string[]) {
    const url =
      command[0] === "curl"
        ? extractCurlURL(baseURL, command)
        : command[0] === "wget"
          ? extractWgetURL(baseURL, command)
          : undefined

    if (!url) {
      throw new WellKnownError({ message: "Unsupported or unsafe well-known auth command" })
    }

    const response = await fetchSameOrigin(url)
    if (!response.ok) {
      throw new WellKnownError({ message: `Failed to fetch well-known auth token (${response.status})` })
    }

    return (await response.text()).trim()
  }

  function normalizeKey(key: string): string {
    return key.replace(/\/+$/, "")
  }

  async function getImpl(providerID: string) {
    const auth = await allImpl()
    return auth[normalizeKey(providerID)]
  }

  async function allImpl(): Promise<Record<string, Info>> {
    const file = Bun.file(filepath())
    // On Windows, Bun.file might have issues with certain paths
    // Use fs.readFile as fallback for better Windows compatibility
    let data: Record<string, unknown> = {}
    try {
      data = await file.json()
    } catch {
      // Fallback: try reading with fs for better Windows compatibility
      try {
        const text = await fs.readFile(filepath(), "utf-8")
        data = JSON.parse(text)
      } catch (error) {
        // Missing file is the normal first-run case; anything else means the
        // auth store is unreadable and silently treating it as empty would
        // make stored credentials vanish without a trace.
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          log.warn("auth store unreadable, treating as empty", { error })
        }
      }
    }

    const result = Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = Info.safeParse(value)
        if (!parsed.success) return acc
        acc[normalizeKey(key)] = parsed.data
        return acc
      },
      {} as Record<string, Info>,
    )

    const envRaw = process.env.NIKCLI_AUTH_CONTENT
    if (envRaw) {
      try {
        const envData = JSON.parse(envRaw)
        if (envData && typeof envData === "object") {
          for (const [key, value] of Object.entries(envData)) {
            const parsed = Info.safeParse(value)
            if (parsed.success) {
              result[normalizeKey(key)] = parsed.data
            }
          }
        }
      } catch {
        // Invalid JSON in env, ignore
      }
    }

    return result
  }

  async function setImpl(key: string, info: Info) {
    const normalized = normalizeKey(key)
    const file = filepath()
    const tmp = file + ".tmp"
    // Serialize all auth.json mutations: an unguarded read-modify-write here
    // can drop a concurrent update (e.g. a token refresh for another provider).
    using _ = await Lock.write("auth-file")
    try {
      const data = await allImpl()
      await Bun.write(tmp, JSON.stringify({ ...data, [normalized]: info }, null, 2))
      // chmod is Unix-only, skip on Windows
      if (process.platform !== "win32") {
        await fs.chmod(tmp, 0o600)
      }
      await fs.rename(tmp, file)
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
  }

  async function removeImpl(key: string) {
    const normalized = normalizeKey(key)
    const file = filepath()
    const tmp = file + ".tmp"
    using _ = await Lock.write("auth-file")
    try {
      const data = await allImpl()
      delete data[normalized]
      await Bun.write(tmp, JSON.stringify(data, null, 2))
      // chmod is Unix-only, skip on Windows
      if (process.platform !== "win32") {
        await fs.chmod(tmp, 0o600)
      }
      await fs.rename(tmp, file)
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
  }

  /**
   * Refresh an OAuth token using the refresh token.
   * Returns the updated auth info.
   * Only works for providers with type "oauth".
   */
  async function refreshImpl(providerID: string): Promise<z.infer<typeof Oauth>> {
    const normalized = normalizeKey(providerID)
    const current = await getImpl(normalized)

    if (!current) {
      throw new NotFoundError({ message: `No auth found for provider: ${providerID}`, providerID })
    }

    if (current.type !== "oauth") {
      throw new NotOAuthProviderError({
        message: `Provider ${providerID} is not an OAuth provider`,
        providerID,
      })
    }

    const oauth = current as z.infer<typeof Oauth>

    // Build refresh request
    const tokenUrl = oauth.enterpriseUrl
      ? `${oauth.enterpriseUrl}/oauth/token`
      : "https://auth.nikcli-ai.dev/oauth/token"

    log.info("refreshing token", { providerID })

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oauth.refresh,
        client_id: "nikcli",
      }).toString(),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error")
      log.error("token refresh failed", { providerID, status: response.status, error: errorText })
      if (response.status === 401 || response.status === 400) {
        throw new UserFacingError({
          title: "Auth session expired",
          what: `${providerID} rejected the refresh token (${response.status}).`,
          try: `Run \`nikcli auth login ${providerID}\` to reconnect, or pick a different provider.`,
          docs: "https://nikcli-ai.dev/docs/auth",
          cause: { status: response.status, error: errorText },
        })
      }
      throw new TokenRefreshError({
        message: `Token refresh failed: ${response.status} ${errorText}`,
        providerID,
        status: response.status,
        responseBody: errorText,
      })
    }

    const result = (await response.json()) as {
      access_token: string
      refresh_token?: string
      expires_in: number
    }

    const updated: z.infer<typeof Oauth> = {
      type: "oauth",
      access: result.access_token,
      refresh: result.refresh_token ?? oauth.refresh,
      expires: Date.now() + result.expires_in * 1000,
      accountId: oauth.accountId,
      enterpriseUrl: oauth.enterpriseUrl,
    }

    // Persist the updated auth
    await setImpl(normalized, updated)

    log.info("token refreshed", { providerID, expiresAt: new Date(updated.expires).toISOString() })

    return updated
  }

  /**
   * Token refresh threshold: refresh if token expires within this many milliseconds
   */
  const REFRESH_THRESHOLD_MS = 60_000 // 60 seconds

  /**
   * Get a valid auth token, refreshing if necessary.
   * Uses Lock.write to serialize concurrent refresh attempts.
   * Returns the auth info with a valid (non-expired) access token.
   */
  async function getValidImpl(providerID: string): Promise<Info | undefined> {
    const normalized = normalizeKey(providerID)
    const current = await getImpl(normalized)

    if (!current) {
      return undefined
    }

    // Non-OAuth providers are always valid
    if (current.type !== "oauth") {
      return current
    }

    const oauth = current as z.infer<typeof Oauth>

    // Check if token is still valid (with threshold)
    const now = Date.now()
    if (oauth.expires > now + REFRESH_THRESHOLD_MS) {
      return oauth
    }

    // Token is expired or about to expire — refresh under lock
    const lockKey = `auth-refresh:${normalized}`
    using _ = await Lock.write(lockKey)

    // Re-check after acquiring lock (another caller may have refreshed)
    const recheck = await getImpl(normalized)
    if (!recheck || recheck.type !== "oauth") {
      return recheck
    }

    const recheckOauth = recheck as z.infer<typeof Oauth>
    if (recheckOauth.expires > now + REFRESH_THRESHOLD_MS) {
      return recheckOauth
    }

    // Still expired — perform refresh
    try {
      return await refreshImpl(normalized)
    } catch (error) {
      log.warn("token refresh failed, returning current token", {
        providerID: normalized,
        error,
      })
      // Return current token even if refresh failed — let the API call fail naturally
      return recheckOauth
    }
  }
}
