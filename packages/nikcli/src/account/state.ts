import { Schema } from "effect"
import { AccountID, OrgID } from "./schema"

/**
 * `AccountState` — the typed state machine for the local nikcli session.
 *
 * This is the answer to `specs/effect-tui/12-identity-onboarding-auth.md`:
 * a state machine the server can require before privileged actions. The UI
 * already enforced "account creation cannot be skipped" by rendering a
 * sign-in dialog when no active account was present; the server side is
 * what stops a malformed client from bypassing it.
 *
 * The decision is pure: `decide()` takes a snapshot of what the service
 * knows and returns an `AccountGuardResult`, a discriminated union over
 * `kind`. All the `Effect`-side state stays in the existing
 * `Account.Service`. A consumer asking "may this caller proceed?" calls
 * `decide()` and matches on the result — no caller should reason over
 * `active() === undefined` directly, which is how the rule ends up written
 * twice and differently.
 *
 * `Schema.TaggedError` is the policy for expected failures per ROADMAP
 * non-negotiable #2: keep the Effect error channel typed, no `any`, no
 * squash-to-Error.
 */
export const AccountState = Schema.Literals([
  /** No account on this machine. Caller must complete the device-code flow. */
  "unsigned",
  /** An account row exists, but the bearer is missing or expired. */
  "expired",
  /** Account + bearer + email verified. Privileged actions are allowed. */
  "authenticated",
])
export type AccountState = Schema.Schema.Type<typeof AccountState>

/**
 * The decision the server must make before serving a privileged action.
 *
 * `AccountState` is the user-facing label; `AccountGuardResult` is the
 * server-side answer that downstream handlers and tests can match on without
 * having to interpret the state machine. The two are paired by `decide()`.
 */
export type AccountGuardResult =
  | {
      readonly kind: "allow"
      readonly accountID: AccountID
      readonly orgID?: OrgID
    }
  | {
      readonly kind: "deny"
      readonly reason: AccountDenialReason
      readonly state: AccountState
    }

export const AccountDenialReason = Schema.Literals([
  /** `active()` returned undefined. */
  "no_active_account",
  /** `active()` returned an account, but `token()` could not produce a valid bearer. */
  "token_unavailable",
  /**
   * There is an account row, but the caller's identity was not established
   * for this request. `decide` requires `identityVerified` to be passed
   * explicitly, so a caller that has not checked is denied rather than
   * defaulted through — the guard fails closed.
   */
  "identity_unverified",
])
export type AccountDenialReason = Schema.Schema.Type<typeof AccountDenialReason>

/**
 * Decide whether the server should serve a privileged action.
 *
 * Pure helper: takes the `active()` snapshot and the latest `token()` answer
 * and returns the guard verdict. The server wires this into `Auth.sessionFor`
 * (or any equivalent handler) and refuses `deny` with 401 + a typed
 * `AccountRequiredError`. Tests can call it directly without spinning up the
 * server.
 *
 * `identityVerified`: whether the caller's credential was established for
 * this request. Omitted counts as *not* verified: the parameter is optional
 * so callers cannot forget it silently, not so it can be skipped.
 *
 * `tokenedBy`: `true` when the latest `token()` call succeeded (a fresh
 * bearer is now in memory). `false` when the caller is signed out (token
 * expired or refresh failed), `undefined` when no `token()` call has been
 * made yet (i.e. there is no account to ask).
 */
export function decide(input: {
  readonly active?: {
    readonly id: AccountID
    readonly active_org_id?: OrgID | null
  }
  readonly tokenedBy?: boolean
  readonly identityVerified?: boolean
}): AccountGuardResult {
  if (!input.active) {
    return { kind: "deny", reason: "no_active_account", state: "unsigned" }
  }
  if (!input.identityVerified) {
    return { kind: "deny", reason: "identity_unverified", state: "expired" }
  }
  if (input.tokenedBy === false) {
    return { kind: "deny", reason: "token_unavailable", state: "expired" }
  }
  return {
    kind: "allow",
    accountID: input.active.id,
    ...(input.active.active_org_id ? { orgID: input.active.active_org_id } : {}),
  }
}

/**
 * The typed error the guard throws on `deny`. Handlers can `Effect.catchTag`
 * for `AccountRequired`; the wire shape carries `state` so the TUI can
 * route to the right onboarding step without re-deriving it.
 */
export class AccountRequiredError extends Schema.TaggedError<AccountRequiredError>()("AccountRequired", {
  reason: AccountDenialReason,
  state: AccountState,
  message: Schema.String,
}) {}

export function describeDenial(result: Extract<AccountGuardResult, { kind: "deny" }>): string {
  switch (result.reason) {
    case "no_active_account":
      return "Sign in to nikcli to use this endpoint."
    case "token_unavailable":
      return "Your nikcli session expired. Run `nikcli account login` to sign in again."
    case "identity_unverified":
      return "Your nikcli session could not be verified. Run `nikcli account login` to sign in again."
  }
}
