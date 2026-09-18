import { verifyAccessToken, type VerifyAccessTokenOptions } from "@nikcli-ai/auth"
import { Effect } from "effect"
import { Flag } from "@nikcli-ai/util/flag"
import { Account } from "@/account"
import { AccountDB } from "@/account/db"
import { runPromiseWithLayer } from "@/effect"
import { UserDB } from "@/user/users"

const DEFAULT_ISSUER = "https://auth.nikcli.store"

/**
 * The server is the single trust boundary in
 * `specs/effect-tui/12-identity-onboarding-auth.md`: it verifies the issuer JWT
 * and the TUI/SDK/CLI consume its typed answers rather than re-validating the
 * signature themselves. That spec turns login/refresh/expiry/revocation into
 * one state machine on top of this verifier; it does not replace it.
 */
export function identityVerifierOptions(): VerifyAccessTokenOptions | undefined {
  // Default-on: every nikcli server accepts issuer JWTs. Verification is
  // lazy — the JWKS is only fetched when a JWT-shaped bearer arrives, so
  // offline/local servers with no OAuth clients never touch the network.
  // Set NIKCLI_AUTH_ISSUER=off (or 0/false) to disable entirely.
  const raw = Flag.NIKCLI_AUTH_ISSUER?.trim()
  if (raw && ["off", "0", "false", "none"].includes(raw.toLowerCase())) return
  const issuer = raw || DEFAULT_ISSUER
  const jwksUrl = Flag.NIKCLI_AUTH_JWKS_URL ?? new URL("/.well-known/jwks.json", issuer).toString()
  return {
    issuer,
    audience: Flag.NIKCLI_AUTH_AUDIENCE,
    jwksUrl: Flag.NIKCLI_AUTH_JWT_SECRET ? undefined : jwksUrl,
    jwtSecret: Flag.NIKCLI_AUTH_JWT_SECRET,
  }
}

/**
 * A verdict, not an outage: carrying a `code` is what tells
 * `localAccountSession` this token was judged rather than unreachable.
 */
class MissingEmailClaim extends Error {
  readonly code = "ERR_IDENTITY_NO_EMAIL"
  constructor() {
    super("Identity token is missing the verified email claim")
  }
}

export async function externalSessionForToken(
  token: string,
): Promise<{ user: UserDB.PublicUser; token: string } | undefined> {
  const verifier = identityVerifierOptions()
  if (!verifier) return
  const auth = await verifyAccessToken(token, verifier)
  if (!auth.email) throw new MissingEmailClaim()
  return {
    user: Effect.runSync(UserDB.ensureExternalUser({ sub: auth.accountID, email: auth.email })),
    token,
  }
}

/**
 * The session this machine holds, independent of what the caller presented.
 *
 * The terminal stores the issuer access token in a file and sends it as its
 * bearer, but that token lives about fifteen minutes while the account row
 * beside it carries a refresh token and renews itself. Every launch after the
 * first quarter hour therefore arrived with a dead bearer and read as signed
 * out — which is how a signed-in user got the sign-in dialog on every start.
 *
 * Identity is resolved from the renewing side instead. `Account.token`
 * refreshes when the stored token is close to expiry, and what it hands back
 * is verified here exactly like any other bearer: the caller's expired token
 * is never trusted, it is ignored. That is also why only callers the router
 * already admits without credentials may reach this — see `Auth.sessionFor`.
 * It answers "who is signed in on this machine", not "who sent this request".
 *
 * Renewing needs the network, and a laptop that cannot reach the issuer is not
 * a laptop whose owner signed out. A refresh the issuer *answered* — a dead or
 * reused refresh token — does end the session and the sign-in dialog is then
 * correct; anything that never got an answer falls back to the account row and
 * the user it already provisioned here, which is state only a sign-in on this
 * machine could have written.
 */
export async function localAccountSession(): Promise<{ user: UserDB.PublicUser; token: string } | undefined> {
  if (!identityVerifierOptions()) return
  const active = await runPromiseWithLayer(
    Account.defaultLayer,
    Effect.gen(function* () {
      const account = yield* Account.Service
      return yield* account.active()
    }),
  ).catch(() => undefined)
  if (!active) return

  let token: string | undefined
  try {
    token = await runPromiseWithLayer(
      Account.defaultLayer,
      Effect.gen(function* () {
        const account = yield* Account.Service
        return yield* account.token(active.id)
      }),
    )
  } catch (error) {
    if (isSignedOut(error)) return
    return heldSession(active)
  }
  if (!token) return

  try {
    return await externalSessionForToken(token)
  } catch (error) {
    // The token is this machine's own and freshly issued, so a verifier that
    // rejects it on its merits is a real problem — but one that could not
    // fetch the JWKS has decided nothing at all.
    if (!isUnreachable(error)) throw error
    return heldSession(active)
  }
}

/**
 * The account this machine is signed into, as it stands without the issuer.
 *
 * Only a completed sign-in writes the account row *and* provisions the local
 * user beside it, so finding both is what makes this a session rather than a
 * guess. The token handed back is the stored one — stale, and labelled that
 * way by its own `exp` — because inventing a credential here would be worse
 * than reporting the one the machine actually holds.
 */
function heldSession(active: { id: string; email: string }): { user: UserDB.PublicUser; token: string } | undefined {
  const user = Effect.runSync(UserDB.findByEmail(active.email))
  if (!user) return
  const row = Effect.runSync(AccountDB.getAccount(active.id))
  if (!row) return
  return { user: UserDB.toPublic(user), token: row.access_token }
}

/** An answer from the issuer that this machine's refresh chain is over. */
function isSignedOut(error: unknown): boolean {
  return tagOf(error) === "AccountTokenExpired"
}

function tagOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const tag = (error as { _tag?: unknown })._tag
  return typeof tag === "string" ? tag : undefined
}

/**
 * Whether a verifier failure means "could not reach the issuer" rather than
 * "this token is not good".
 *
 * jose labels every verdict it reaches with an `ERR_*` code; a fetch that
 * never completed arrives as a plain `TypeError`, and its own timeout is the
 * one coded error that is still an absence of an answer.
 */
function isUnreachable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== "string") return true
  return code === "ERR_JWKS_TIMEOUT"
}
