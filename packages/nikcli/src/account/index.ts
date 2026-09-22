import path from "path"
import { AccountDB } from "./db"
import { AccountRepo } from "./repo"
import { normalizeServerUrl } from "./url"
import { FileLock } from "@/util/file-lock"
import { Global } from "@nikcli-ai/util/global"
import { Identifier } from "@nikcli-ai/util/id"
import { Lock } from "@/util/lock"
import { Log } from "@nikcli-ai/util/log"
import type { AccountRow } from "./schema"
import {
  AccountID,
  type DeviceCode,
  type DeviceCodeRequest,
  DeviceCodeResponse,
  type Info,
  type Org,
  type OrgID,
  PollResult,
  type RefreshToken,
  type UserCode,
} from "./schema"
import { Context, Effect, Layer, Schema } from "effect"

export namespace Account {
  const log = Log.create({ service: "account" })

  /**
   * Tagged errors that the account service can surface through the Effect
   * error channel. Each is a `Schema.TaggedError` so call sites can use
   * `Effect.catchTag("AccountNotFound", ...)` and `instanceof` continues to
   * work for plain `try/catch` paths.
   */
  export class NotFoundError extends Schema.TaggedError<NotFoundError>()("AccountNotFound", {
    message: Schema.String,
    accountID: Schema.String,
  }) {}

  export class LoginFlowError extends Schema.TaggedError<LoginFlowError>()("AccountLoginFlow", {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    responseBody: Schema.optional(Schema.String),
  }) {}

  export class LoginTimeoutError extends Schema.TaggedError<LoginTimeoutError>()("AccountLoginTimeout", {
    message: Schema.String,
  }) {}

  export class LoginDeniedError extends Schema.TaggedError<LoginDeniedError>()("AccountLoginDenied", {
    message: Schema.String,
  }) {}

  export class TokenExpiredError extends Schema.TaggedError<TokenExpiredError>()("AccountTokenExpired", {
    message: Schema.String,
  }) {}

  export class TokenRefreshError extends Schema.TaggedError<TokenRefreshError>()("AccountTokenRefresh", {
    message: Schema.String,
    accountID: Schema.String,
    status: Schema.optional(Schema.Number),
    responseBody: Schema.optional(Schema.String),
  }) {}

  export class FetchOrgsError extends Schema.TaggedError<FetchOrgsError>()("AccountFetchOrgs", {
    message: Schema.String,
    accountID: Schema.String,
    status: Schema.optional(Schema.Number),
    responseBody: Schema.optional(Schema.String),
  }) {}

  export class IOError extends Schema.TaggedError<IOError>()("AccountIOError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }) {}

  /**
   * Union of all errors that any `Account.Service` method can fail with.
   */
  export type Error =
    | NotFoundError
    | LoginFlowError
    | LoginTimeoutError
    | LoginDeniedError
    | TokenExpiredError
    | TokenRefreshError
    | FetchOrgsError
    | IOError

  /**
   * Preserve typed account errors thrown by the impl. Anything we recognize
   * passes through unchanged; untyped `Error` instances become
   * `Account.IOError`; everything else is wrapped in `IOError` so the Effect
   * error channel stays typed at the `Account.Error` union.
   */
  function asAccountError(e: unknown): Error {
    if (
      e instanceof NotFoundError ||
      e instanceof LoginFlowError ||
      e instanceof LoginTimeoutError ||
      e instanceof LoginDeniedError ||
      e instanceof TokenExpiredError ||
      e instanceof TokenRefreshError ||
      e instanceof FetchOrgsError ||
      e instanceof IOError
    ) {
      return e
    }
    if (e instanceof Error) {
      return new IOError({ message: e.message, cause: e })
    }
    return new IOError({ message: String(e) })
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  const DEFAULT_ACCOUNT_URL = process.env.NIKCLI_ACCOUNT_URL ?? "https://auth.nikcli-ai.dev"

  /** Fallback poll cadence when the issuer does not send one. */
  const DEFAULT_POLL_INTERVAL_SECONDS = 5

  /**
   * Consecutive network/5xx failures tolerated while polling. The device code
   * stays valid on the issuer for its full lifetime, so giving up on the first
   * blip throws away a sign-in the user may already have approved.
   */
  const MAX_TRANSIENT_POLL_FAILURES = 6

  /**
   * Backoff between retries of a failed poll: 0.5s, 1s, 2s … capped at 30s.
   * The first retry is deliberately quick — a dropped request is usually back
   * before the next scheduled poll would have run anyway.
   */
  function backoffMs(failures: number): number {
    return Math.min(30_000, 500 * 2 ** (failures - 1))
  }

  // ============================================================================
  // Token cache — with eviction and size limits
  // ============================================================================

  const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>()
  const MAX_TOKEN_CACHE_SIZE = 50

  /** Evict stale entries from the token cache */
  function evictTokenCache() {
    const now = Date.now()
    // Remove expired entries first
    for (const [key, val] of tokenCache) {
      if (val.expiresAt <= now) tokenCache.delete(key)
    }
    // If still over size, evict the entry with the soonest expiry (LRU-like)
    if (tokenCache.size > MAX_TOKEN_CACHE_SIZE) {
      let oldest: string | undefined
      let oldestAt = Infinity
      for (const [key, val] of tokenCache) {
        if (val.expiresAt < oldestAt) {
          oldest = key
          oldestAt = val.expiresAt
        }
      }
      if (oldest) tokenCache.delete(oldest)
    }
  }

  // ============================================================================
  // Account row cache — avoids double-reads in token() + orgs()
  // ============================================================================

  const accountRowCache = new Map<string, { row: AccountRow; cachedAt: number }>()
  const ACCOUNT_ROW_CACHE_TTL = 5_000 // 5 seconds

  // ============================================================================
  // Device code flow
  // ============================================================================

  /**
   * Device code request options
   */
  export interface LoginOptions {
    email?: string
    serverUrl?: string
  }

  /**
   * Device code flow response (first step)
   */
  export interface LoginStartResult {
    deviceCode: DeviceCode
    userCode: UserCode
    verificationUrl: string
    /**
     * `verificationUrl` with the user code prefilled. Always open this one —
     * it is what turns approval into a single click. Falls back to the bare
     * verification URL when the issuer does not advertise it.
     */
    verificationUrlComplete: string
    interval: number
    expiresIn: number
    /** Absolute instant the device code stops being pollable. */
    expiresAt: number
  }

  export interface Interface {
    login(options?: LoginOptions): Effect.Effect<LoginStartResult, Error>
    poll(
      deviceCode: DeviceCode,
      options?: {
        serverUrl?: string
        onPending?: () => void
        signal?: AbortSignal
        /** Code lifetime from `login()`; polling stops once it elapses. */
        expiresIn?: number
      },
    ): Effect.Effect<
      {
        accountID: AccountID
        accessToken: string
        refreshToken: RefreshToken
        expiresIn: number
      },
      Error
    >
    loginFull(options?: LoginOptions & { onPending?: (userCode: UserCode) => void }): Effect.Effect<
      {
        accountID: AccountID
        accessToken: string
        refreshToken: RefreshToken
        expiresIn: number
      },
      Error
    >
    token(accountID: AccountID): Effect.Effect<string, Error>
    orgs(accountID: AccountID): Effect.Effect<Org[], Error>
    active(): Effect.Effect<Info | undefined>
    get(accountID: AccountID): Effect.Effect<Info | undefined>
    list(): Effect.Effect<Info[]>
    use(accountID: AccountID | null, orgID?: OrgID | null): Effect.Effect<void>
    remove(accountID: AccountID): Effect.Effect<boolean>
    config(): Effect.Effect<{ serverUrl: string }>
  }

  export class Service extends Context.Service<Service, Interface>()("Account.Service") {}

  export const layer = Layer.succeed(
    Service,
    Service.of({
      login: (options) =>
        Effect.tryPromise({
          try: () => loginImpl(options),
          catch: asAccountError,
        }),
      poll: (deviceCode, options) =>
        Effect.tryPromise({
          try: () => pollImpl(deviceCode, options),
          catch: asAccountError,
        }),
      loginFull: (options) =>
        Effect.tryPromise({
          try: () => loginFullImpl(options),
          catch: asAccountError,
        }),
      token: (accountID) =>
        Effect.tryPromise({
          try: () => tokenImpl(accountID),
          catch: asAccountError,
        }),
      orgs: (accountID) =>
        Effect.tryPromise({
          try: () => orgsImpl(accountID),
          catch: asAccountError,
        }),
      active: () => Effect.sync(() => activeImpl()),
      get: (accountID) => Effect.sync(() => getImpl(accountID)),
      list: () => Effect.sync(() => listImpl()),
      use: (accountID, orgID) => Effect.sync(() => useImpl(accountID, orgID)),
      remove: (accountID) => Effect.sync(() => removeImpl(accountID)),
      config: () => Effect.sync(() => configImpl()),
    }),
  )

  export const defaultLayer = layer

  /**
   * Start the device code login flow.
   * Returns the device code info needed for polling.
   */
  async function loginImpl(options: LoginOptions = {}): Promise<LoginStartResult> {
    const serverUrl = normalizeServerUrl(options.serverUrl ?? DEFAULT_ACCOUNT_URL)
    log.info("starting device code login", { serverUrl })

    const request: DeviceCodeRequest = {
      client_id: "nikcli",
      scope: "openid profile email offline_access",
    }

    const response = await fetch(`${serverUrl}oauth/device/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error")
      const retryAfter = Number(response.headers.get("retry-after"))
      throw new LoginFlowError({
        message:
          response.status === 429
            ? `Too many sign-in attempts from this network. Try again in ${
                Number.isFinite(retryAfter) && retryAfter > 0 ? `${retryAfter}s` : "a minute"
              }.`
            : `Failed to start device code flow: ${response.status} ${errorText}`,
        status: response.status,
        responseBody: errorText,
      })
    }

    // Validate rather than cast: a body missing `device_code` used to sail
    // through here and only surface much later as an unexplained "expired"
    // during polling.
    const parsed = DeviceCodeResponse.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) {
      throw new LoginFlowError({
        message: `The sign-in server returned an unexpected device-code response (${parsed.error.issues[0]?.message ?? "invalid body"}).`,
        status: response.status,
      })
    }
    const data = parsed.data
    log.info("device code received", { userCode: data.user_code })

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUrl: data.verification_url,
      verificationUrlComplete:
        data.verification_uri_complete ?? `${data.verification_url}?user_code=${encodeURIComponent(data.user_code)}`,
      interval: data.interval,
      expiresIn: data.expires_in,
      expiresAt: Date.now() + data.expires_in * 1000,
    }
  }

  /**
   * Poll for token completion of the device code flow.
   * Returns when the user has authenticated or throws on failure.
   */
  async function pollImpl(
    deviceCode: DeviceCode,
    options: {
      serverUrl?: string
      onPending?: () => void
      signal?: AbortSignal
      expiresIn?: number
    } = {},
  ): Promise<{
    accountID: AccountID
    accessToken: string
    refreshToken: RefreshToken
    expiresIn: number
  }> {
    const serverUrl = normalizeServerUrl(options.serverUrl ?? DEFAULT_ACCOUNT_URL)
    const startTime = Date.now()
    const deadline = startTime + (options.expiresIn ?? 600) * 1000
    let interval = DEFAULT_POLL_INTERVAL_SECONDS
    let transientFailures = 0

    log.info("polling for device code completion", { serverUrl })

    while (true) {
      options.signal?.throwIfAborted()

      // A dropped wifi packet, a proxy hiccup, or a 502 from the edge used to
      // abort the whole sign-in — after the user had already approved it in
      // the browser. Transient failures are retried against the same device
      // code, which stays valid until the issuer expires it.
      let response: Response
      try {
        response = await fetch(`${serverUrl}oauth/device/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: "nikcli",
            device_code: deviceCode,
          }),
          signal: options.signal,
        })
      } catch (cause) {
        options.signal?.throwIfAborted()
        transientFailures += 1
        if (transientFailures > MAX_TRANSIENT_POLL_FAILURES) {
          throw new LoginFlowError({
            message: `Lost contact with the sign-in server: ${cause instanceof Error ? cause.message : String(cause)}`,
          })
        }
        options.onPending?.()
        await Bun.sleep(backoffMs(transientFailures))
        continue
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error")
        if (response.status === 429 || response.status >= 500) {
          transientFailures += 1
          if (transientFailures > MAX_TRANSIENT_POLL_FAILURES) {
            throw new LoginFlowError({
              message: `The sign-in server kept failing (${response.status}). Please try again.`,
              status: response.status,
              responseBody: errorText,
            })
          }
          const retryAfter = Number(response.headers.get("retry-after"))
          options.onPending?.()
          await Bun.sleep(
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(transientFailures),
          )
          continue
        }
        throw new LoginFlowError({
          message: `Failed to poll device code: ${response.status} ${errorText}`,
          status: response.status,
          responseBody: errorText,
        })
      }

      const parsed = PollResult.safeParse(await response.json().catch(() => undefined))
      if (!parsed.success) {
        transientFailures += 1
        if (transientFailures > MAX_TRANSIENT_POLL_FAILURES) {
          throw new LoginFlowError({
            message: "The sign-in server returned an unexpected polling response.",
            status: response.status,
          })
        }
        await Bun.sleep(backoffMs(transientFailures))
        continue
      }
      // Any well-formed answer means the round-trip works again.
      transientFailures = 0
      const result = parsed.data

      switch (result.status) {
        case "pending": {
          interval = result.interval ?? interval
          options.onPending?.()
          await Bun.sleep(interval * 1000)
          break
        }

        case "slow_down": {
          // Honor the server's new interval for every later poll too, instead
          // of sleeping once and immediately hammering it again.
          interval = result.interval
          options.onPending?.()
          await Bun.sleep(interval * 1000)
          break
        }

        case "expired": {
          throw new LoginTimeoutError({
            message: "The sign-in code expired before it was approved. Start sign-in again to get a new one.",
          })
        }

        case "denied": {
          throw new LoginDeniedError({
            message: "Sign-in was denied in the browser.",
          })
        }

        case "success": {
          const profileResponse = await fetch(`${serverUrl}userinfo`, {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${result.access_token}`,
            },
          })
          if (!profileResponse.ok) {
            const errorText = await profileResponse.text().catch(() => "Unknown error")
            throw new LoginFlowError({
              message: `Failed to load the authenticated account: ${profileResponse.status} ${errorText}`,
              status: profileResponse.status,
              responseBody: errorText,
            })
          }
          const profile = (await profileResponse.json().catch(() => ({}))) as { email?: unknown }
          if (typeof profile.email !== "string" || !profile.email) {
            throw new LoginFlowError({
              message: "The authenticated account does not have an email address.",
            })
          }

          const email = profile.email.trim().toLowerCase()
          const existing = AccountRepo.list().find(
            (account) => account.email.toLowerCase() === email && normalizeServerUrl(account.url) === serverUrl,
          )
          const accountID = existing?.id ?? AccountID.parse(Identifier.ascending("account"))

          log.info("device code flow completed", { accountID })

          // Persist the account
          AccountRepo.persistAccount(
            accountID,
            email,
            serverUrl,
            result.access_token,
            result.refresh_token,
            result.expires_in,
          )
          // A row cached from before this sign-in names a refresh token the
          // issuer has already retired. Reading it once is enough to revoke
          // the family the sign-in just created, so it goes now.
          accountRowCache.delete(accountID)
          tokenCache.delete(accountID)

          return {
            accountID,
            accessToken: result.access_token,
            refreshToken: result.refresh_token,
            expiresIn: result.expires_in,
          }
        }
      }

      // Safety net: stop once the issuer's own code lifetime is up.
      if (Date.now() > deadline) {
        throw new LoginTimeoutError({
          message: "Sign-in timed out waiting for approval. Start sign-in again to get a new code.",
        })
      }
    }
  }

  /**
   * Full login flow: start + poll.
   * Convenience function that handles the entire device code flow.
   */
  async function loginFullImpl(options: LoginOptions & { onPending?: (userCode: UserCode) => void } = {}): Promise<{
    accountID: AccountID
    accessToken: string
    refreshToken: RefreshToken
    expiresIn: number
  }> {
    const start = await loginImpl(options)
    options.onPending?.(start.userCode)

    return pollImpl(start.deviceCode, {
      serverUrl: options.serverUrl,
      expiresIn: start.expiresIn,
      onPending: () => options.onPending?.(start.userCode),
    })
  }

  // ============================================================================
  // Token management
  // ============================================================================

  /**
   * Get a valid access token for an account.
   * Automatically refreshes if expired (within threshold).
   * Uses Lock.write to serialize concurrent refresh attempts.
   */
  async function tokenImpl(accountID: AccountID): Promise<string> {
    // Check in-memory cache first
    const cached = tokenCache.get(accountID)
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.accessToken
    }

    // Get account from DB (with row cache)
    const account = getAccountRowCached(accountID)
    if (!account) {
      throw new NotFoundError({ message: `Account not found: ${accountID}`, accountID })
    }

    // Check if token is still valid
    if (account.token_expiry > Date.now() + 60_000) {
      const accessToken = account.access_token
      tokenCache.set(accountID, {
        accessToken,
        expiresAt: account.token_expiry,
      })
      return accessToken
    }

    // Token expired or about to expire — refresh under lock
    const lockKey = `account-refresh:${accountID}`
    using _ = await Lock.write(lockKey)

    // …and under a lock the *other* nikcli processes on this machine can see.
    // The issuer rotates the refresh token on first use and revokes the family
    // on the second, so two processes reaching this line with the same stored
    // token do not race for a slower refresh, they end the session for both.
    await using claim = await claimRefresh(accountID)

    // Past the row cache deliberately: the process that just held the claim
    // persisted a new pair, and the point of waiting was to use it rather than
    // spend a token the issuer has already retired.
    const recheck = readAccountRow(accountID)
    if (!recheck) {
      throw new NotFoundError({ message: `Account not found: ${accountID}`, accountID })
    }

    if (recheck.token_expiry > Date.now() + 60_000) {
      tokenCache.set(accountID, { accessToken: recheck.access_token, expiresAt: recheck.token_expiry })
      return recheck.access_token
    }

    if (claim.contended) {
      // Nobody released the claim and the row is still stale. Presenting the
      // stored token now is exactly the double-use that kills the session, so
      // this asks the caller to try again instead.
      throw new TokenRefreshError({
        message: "Another nikcli process is still refreshing this session. Try again in a moment.",
        accountID,
      })
    }

    // Refresh the token
    log.info("refreshing account token", { accountID })

    const serverUrl = normalizeServerUrl(recheck.url)
    const response = await fetch(`${serverUrl}oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: recheck.refresh_token,
        client_id: "nikcli",
      }).toString(),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error")
      // 400/401 means the refresh token is revoked, reused, or simply too old:
      // no amount of retrying fixes it, the user has to sign in again. Say so
      // instead of surfacing the raw OAuth error body.
      if (response.status === 400 || response.status === 401) {
        throw new TokenExpiredError({
          message: "Your nikcli session expired. Run `nikcli account login` to sign in again.",
        })
      }
      throw new TokenRefreshError({
        message: `Could not refresh the nikcli session (${response.status}). Check your connection and try again.`,
        accountID,
        status: response.status,
        responseBody: errorText,
      })
    }

    const result = (await response.json().catch(() => undefined)) as
      | {
          access_token?: string
          refresh_token?: string
          expires_in?: number
        }
      | undefined
    if (!result?.access_token || typeof result.expires_in !== "number") {
      throw new TokenRefreshError({
        message: "The sign-in server returned an unexpected token refresh response.",
        accountID,
        status: response.status,
      })
    }

    // Persist updated tokens (only token fields, not email/url/created_at)
    AccountRepo.persistToken(
      accountID,
      result.access_token,
      result.refresh_token ?? recheck.refresh_token,
      result.expires_in,
    )

    // Update caches
    const expiresAt = Date.now() + result.expires_in * 1000
    tokenCache.set(accountID, { accessToken: result.access_token, expiresAt })
    // Invalidate the row cache so next read gets fresh data
    accountRowCache.delete(accountID)
    evictTokenCache()

    return result.access_token
  }

  // ============================================================================
  // Organizations
  // ============================================================================

  /**
   * List organizations for an account.
   * Uses the cached account row from token() to avoid double-reads.
   */
  async function orgsImpl(accountID: AccountID): Promise<Org[]> {
    const accessToken = await tokenImpl(accountID)
    // Reuse the cached account row instead of reading from DB again
    const account = getAccountRowCached(accountID)
    if (!account) {
      throw new NotFoundError({ message: `Account not found: ${accountID}`, accountID })
    }

    const serverUrl = normalizeServerUrl(account.url)

    const response = await fetch(`${serverUrl}api/user/orgs`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    })

    // The nikcli issuer has no organizations: `auth.nikcli-ai.dev` publishes no
    // `/api/user/orgs` route and its schema has no orgs table, so every call
    // here answered 404 and `nikcli account orgs` could only ever print
    // "Failed to fetch orgs: 404 404 Not Found" — never its own "No
    // organizations found". An issuer that does not expose the endpoint has no
    // organizations to report, which is an empty list, not an error. A real
    // failure (401, 5xx, a body that is not a list) still surfaces.
    if (response.status === 404) return []

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error")
      throw new FetchOrgsError({
        message: `Failed to fetch orgs: ${response.status} ${errorText}`,
        accountID,
        status: response.status,
        responseBody: errorText,
      })
    }

    const data = (await response.json().catch(() => undefined)) as { orgs?: Org[] } | undefined
    return data?.orgs ?? []
  }

  // ============================================================================
  // Account management
  // ============================================================================

  /**
   * Get the active account info
   */
  function activeImpl(): Info | undefined {
    return AccountRepo.active()
  }

  /**
   * Get account info by ID
   */
  function getImpl(accountID: AccountID): Info | undefined {
    return AccountRepo.get(accountID)
  }

  /**
   * List all accounts
   */
  function listImpl(): Info[] {
    return AccountRepo.list()
  }

  /**
   * Switch to a different account and optionally org.
   * Clears token cache for both the outgoing and incoming accounts.
   */
  function useImpl(accountID: AccountID | null, orgID?: OrgID | null): void {
    // Clear the outgoing account's cache too
    const config = Effect.runSync(AccountDB.getConfig())
    const previousActiveId = config.active_account_id
    if (previousActiveId) {
      tokenCache.delete(previousActiveId)
      accountRowCache.delete(previousActiveId)
    }
    // Clear the incoming account's cache
    if (accountID) {
      tokenCache.delete(accountID)
      accountRowCache.delete(accountID)
    }
    AccountRepo.use(accountID, orgID)
  }

  /**
   * Remove an account
   */
  function removeImpl(accountID: AccountID): boolean {
    tokenCache.delete(accountID)
    accountRowCache.delete(accountID)
    return AccountRepo.remove(accountID)
  }

  /**
   * Get the current server URL
   */
  function configImpl(): { serverUrl: string } {
    return {
      serverUrl: DEFAULT_ACCOUNT_URL,
    }
  }

  // ============================================================================
  // Internal helpers
  // ============================================================================

  /** Get an account row with short-lived caching to avoid double-reads */
  function getAccountRowCached(accountID: string): AccountRow | undefined {
    const now = Date.now()
    const cached = accountRowCache.get(accountID)
    if (cached && now - cached.cachedAt < ACCOUNT_ROW_CACHE_TTL) {
      return cached.row
    }
    return readAccountRow(accountID)
  }

  /**
   * The row as the database has it *now*, refilling the cache rather than
   * reading it. What the cache can hand back is a refresh token another
   * process has already spent, which is the one thing this row must never be
   * stale about.
   */
  function readAccountRow(accountID: string): AccountRow | undefined {
    const row = Effect.runSync(AccountDB.getAccount(accountID))
    if (row) accountRowCache.set(accountID, { row, cachedAt: Date.now() })
    else accountRowCache.delete(accountID)
    return row
  }

  /** One refresh claim per account, beside the rest of this machine's runtime state. */
  function refreshLockPath(accountID: string) {
    return path.join(Global.Path.state, `account-refresh-${accountID.replace(/[^\w.-]/g, "_")}.lock`)
  }

  /**
   * The right to spend this account's refresh token, as against the other
   * nikcli processes on this machine.
   *
   * `contended` means someone else has it and would not let go — the caller
   * must not refresh. A state directory that cannot hold a lock at all is a
   * different matter: it leaves the in-process lock as the only guard, which is
   * what the code did before, and is far better than a machine that can never
   * renew its session again.
   */
  type RefreshClaim = { contended: boolean; [Symbol.asyncDispose](): Promise<void> }

  /**
   * How long to wait for the process that holds the claim.
   *
   * Long enough to inherit the pair it is about to write — a refresh is one
   * round trip — and short enough that a caller on the startup path is not
   * parked behind it. Giving up is not signing out: the local session answers
   * from the account row while the other process rotates.
   */
  const REFRESH_CLAIM_TIMEOUT_MS = 3_000

  async function claimRefresh(accountID: string): Promise<RefreshClaim> {
    const held = await FileLock.acquire(refreshLockPath(accountID), {
      staleMs: 30_000,
      timeoutMs: REFRESH_CLAIM_TIMEOUT_MS,
    }).catch((error: unknown) => {
      log.warn("refresh claim unavailable; falling back to the in-process lock", {
        accountID,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    })
    return {
      contended: held === undefined,
      async [Symbol.asyncDispose]() {
        await held?.[Symbol.asyncDispose]()
      },
    }
  }
}
