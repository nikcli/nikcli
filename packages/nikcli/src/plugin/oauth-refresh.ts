import path from "path"
import { Global } from "@nikcli-ai/util/global"
import { Log } from "@nikcli-ai/util/log"
import { FileLock } from "@/util/file-lock"

const log = Log.create({ service: "plugin.oauth-refresh" })

/**
 * Keeping a provider's OAuth session (ChatGPT, SuperGrok) alive.
 *
 * Both issuers rotate the refresh token on every use and refuse it the second
 * time, so the one thing this must never do is present a refresh token that
 * has already been spent. Three ways that used to happen:
 *
 * - two requests in one process found the token expired together and both
 *   refreshed (subagents, title generation next to the reply);
 * - two nikcli processes did the same (a TUI and a background server, two
 *   terminals);
 * - a process refreshed from a copy of the credential it had read before
 *   another one rotated it.
 *
 * So a renewal is single-flight within the process, runs under a lock every
 * nikcli process on the machine can see, and re-reads the stored credential
 * once it holds that lock: if someone else already renewed, their pair is used
 * instead of spending the token again. It is the same discipline
 * `Account.token()` follows for the nikcli identity session.
 */
export namespace ProviderOAuth {
  export type Tokens = {
    access: string
    refresh: string
    expires: number
    accountId?: string
  }

  export type Stored = Tokens & { type: "oauth" }

  /**
   * Renew this long before the deadline, so a long tool-using turn does not
   * meet a 401 halfway through its request.
   */
  export const REFRESH_SKEW_MS = 120_000

  /**
   * How long to wait for another process that is renewing the same session.
   * A renewal is one round trip; past this the holder is assumed stuck, and
   * the caller is told to retry rather than spend the token alongside it.
   */
  const CLAIM_TIMEOUT_MS = 10_000

  /** `exp` of a JWT access token, unverified — only ever used to renew early. */
  function jwtExpiry(token: string): number | undefined {
    const parts = token.split(".")
    if (parts.length !== 3) return undefined
    try {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown }
      return typeof claims.exp === "number" ? claims.exp * 1000 : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Whether the credential needs renewing before it is used. The stored
   * `expires` is only as good as the `expires_in` the issuer sent, so a JWT's
   * own `exp` is honoured as well.
   */
  export function expiring(auth: { access?: string; expires?: number }, now = Date.now()): boolean {
    if (!auth.access || !auth.expires) return true
    if (auth.expires - now <= REFRESH_SKEW_MS) return true
    const exp = jwtExpiry(auth.access)
    return exp !== undefined && exp - now <= REFRESH_SKEW_MS
  }

  /**
   * Whether a request can be sent again after a 401. A stream has already been
   * consumed by the first attempt; the AI SDK sends JSON strings, which can.
   */
  export function replayable(body: BodyInit | null | undefined): boolean {
    return body === undefined || body === null || typeof body === "string"
  }

  export type RenewOptions = {
    providerID: string
    /** The credential as auth.json holds it right now — never a cached copy. */
    read: () => Promise<{ type: string } | undefined>
    /** Spend `stored.refresh` at the issuer's token endpoint. */
    exchange: (stored: Stored) => Promise<Tokens>
    /** Persist the rotated pair; must reject when it was not written. */
    write: (tokens: Tokens) => Promise<void>
    /**
     * The access token the provider just answered 401 to. It is renewed even
     * though its deadline says it is still valid — unless another caller has
     * already replaced it.
     */
    rejected?: string
  }

  const inflight = new Map<string, Promise<Tokens>>()

  /**
   * Pairs this process obtained but could not persist, keyed by the refresh
   * token they replace. Without this a failed write strands the session: the
   * store still offers the spent token, and the next renewal would present it.
   */
  const unpersisted = new Map<string, { spent: string; tokens: Tokens }>()

  /** A usable credential for `providerID`, renewing it at most once at a time. */
  export function renew(options: RenewOptions): Promise<Tokens> {
    const pending = inflight.get(options.providerID)
    if (pending) return pending
    const task = renewUnderClaim(options).finally(() => inflight.delete(options.providerID))
    inflight.set(options.providerID, task)
    return task
  }

  function lockPath(providerID: string) {
    return path.join(Global.Path.state, `provider-refresh-${providerID.replace(/[^\w.-]/g, "_")}.lock`)
  }

  function asStored(value: { type: string } | undefined): Stored | undefined {
    if (!value || value.type !== "oauth") return undefined
    const stored = value as Partial<Stored>
    if (typeof stored.refresh !== "string" || !stored.refresh) return undefined
    return value as Stored
  }

  function usable(auth: Tokens, rejected: string | undefined) {
    return !expiring(auth) && auth.access !== rejected
  }

  async function renewUnderClaim(options: RenewOptions): Promise<Tokens> {
    const { providerID } = options
    // A state directory that cannot hold a lock leaves the in-process
    // single-flight as the only guard — still far better than never renewing.
    const held = await FileLock.acquire(lockPath(providerID), {
      staleMs: 30_000,
      timeoutMs: CLAIM_TIMEOUT_MS,
    }).catch((error: unknown) => {
      log.warn("refresh claim unavailable; falling back to the in-process guard", {
        providerID,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    })
    try {
      const stored = asStored(await options.read())
      if (!stored) throw new Error(`${providerID} is no longer signed in with OAuth. Run \`nikcli auth login\`.`)

      // Someone else — another request, another process — renewed while this
      // one waited. Use their pair; the stored refresh token is theirs to spend.
      if (usable(stored, options.rejected)) return stored

      const pending = unpersisted.get(providerID)
      if (pending && pending.spent === stored.refresh) {
        // The store still holds the token this process already spent. Retry the
        // write, and hand out the pair regardless: it is the only live one.
        await persist(options, pending.spent, pending.tokens)
        if (usable(pending.tokens, options.rejected)) return pending.tokens
        return await exchange(options, { ...stored, ...pending.tokens })
      }

      if (held === undefined) {
        throw new Error(`Another nikcli process is still refreshing the ${providerID} session. Try again in a moment.`)
      }

      return await exchange(options, stored)
    } finally {
      await held?.[Symbol.asyncDispose]()
    }
  }

  async function exchange(options: RenewOptions, stored: Stored): Promise<Tokens> {
    log.info("refreshing oauth token", { providerID: options.providerID })
    const tokens = await options.exchange(stored)
    await persist(options, stored.refresh, tokens)
    log.info("oauth token refreshed", {
      providerID: options.providerID,
      expiresAt: new Date(tokens.expires).toISOString(),
    })
    return tokens
  }

  async function persist(options: RenewOptions, spent: string, tokens: Tokens) {
    try {
      await options.write(tokens)
      unpersisted.delete(options.providerID)
    } catch (error) {
      unpersisted.set(options.providerID, { spent, tokens })
      log.error("could not persist the refreshed oauth token", {
        providerID: options.providerID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
