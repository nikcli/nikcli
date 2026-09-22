# EOT-12: Identity, Onboarding, and Auth Flows

Status: proposed. Tier: 1. Phase: P1. Dependencies: EOT-02, EOT-03, EOT-10.
Owner: identity/auth/account maintainers and `packages/identity` Cloudflare Workers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B15, B24, B25 in the [register](../README.md): schema-first HttpApi, tagged account failures, and identity verifier
options already exist. The `packages/identity` Cloudflare Worker exposes login, OAuth callback, PKCE, device-code, passkey,
and rate-limit primitives, and `packages/nikcli/src/server/identity-auth.ts` already verifies JWTs against the issuer. The
gap is a unified architectural spec covering the **end-to-end** auth lifecycle across `packages/identity` (browser/Cloud),
the nikcli server (JWT verification), the TUI (`DialogAccountLogin`, onboarding), the CLI (`auth`, `account`),
the mobile app, and the SDK clients — and the migration between them. Login, refresh, expiry, and revocation must be a
single state machine, not a sequence of unrelated flows.

## Scope and Non-Goals

Define the canonical state machine and trust boundaries for identity, account creation, onboarding, login (passwordless
email, PKCE OAuth, device code, passkey), token lifecycle, and account switching. Preserve the existing
`packages/identity` Workers implementation and the existing JWT verifier. Do not invent a second identity provider,
relax PKCE to plain, skip account creation on first sign-in, store secrets in the TUI, or change the existing flag-based
opt-outs (`NIKCLI_AUTH_ISSUER=off`, etc.). Do not migrate `packages/identity` itself unless a contract change requires it.

## Design and Requirements

1. Model the auth lifecycle as a typed state machine in the contract layer: `Anonymous`, `VerifyingEmail`,
   `AwaitingDeviceCode`, `AwaitingPasskeyChallenge`, `AwaitingOAuthCallback`, `Authenticated`, `Refreshing`,
   `Expired`, `Revoked`. Transitions are explicit and serializable; the server and the TUI agree on the same legal
   transitions. Implement using `Schema.Union` tagged variants with `Schema.TaggedError` for each rejection.
2. PKCE S256 is the only OAuth flow. The verifier and challenge travel in the auth start request and the callback query,
   validated server-side against the OAuth provider. Plain PKCE, implicit flow, and password grant are forbidden. The
   TUI never holds an OAuth code at rest; the callback delivers the verifier only.
3. Device-code flow: the server polls the OAuth provider on a fixed cadence (provider-rate-limit aware), the TUI shows
   the user code, and the device-code expiry / slow-down / access-denied signals decode into typed failures. The TUI does
   not retry device-code polling after `access_denied` or `expired_token`.
4. Passwordless email: the TUI never handles raw email tokens; the server exchanges them. Magic-link clicks open in the
   browser and redirect to the TUI with a one-shot code, not a long-lived session.
5. Passkey (WebAuthn): the server stores credentials; the TUI uses `DialogAccountLogin` to surface the registration and
   assertion challenges. Passkey private keys never leave the platform authenticator. Recovery codes are generated once
   and shown exactly once.
6. Token lifecycle: access tokens have a server-defined TTL; refresh tokens rotate on use and on auth state change.
   Refresh is a separate typed operation that can fail with `AuthError.InvalidGrant`, `AuthError.Expired`,
   `AuthError.Revoked`, or `AuthError.Network`. The TUI shows the typed reason; auto-refresh is repeated only for
   transient failures with bounded budget.
7. Onboarding cannot be skipped. First sign-in must complete account creation (`Account.Service.create` or equivalent
   typed operation) before the TUI shows a usable prompt. Required steps include provider selection, model default,
   optional telemetry consent, and theme. Skipping a required step leaves the session in `IncompleteOnboarding`; the UI
   surfaces the missing step, never an empty success.
8. Account switching is a typed transition: `SwitchTo(accountID)` decodes identity, verifies the new token, invalidates
   cached `Auth.Info` for the previous account, and emits an audit event. Multi-account storage is bounded (candidate 16);
   an over-quota switch returns `AuthError.AccountLimitReached`, not silent eviction.
9. The nikcli server trusts the issuer's JWT (verified by `verifyAccessToken`) and stores the resulting `UserDB.PublicUser`
   locally. The TUI trusts the server's typed responses; it never re-validates the JWT signature. The server is the
   single trust boundary for `externalSessionForToken`; the TUI has no authority over its own authorization.
10. Revocation: a server-issued logout or a Cloud-side session invalidation must propagate to every open TUI/SDK/CLI
    connection within EOT-04's reconnect window. Revocation is reported as a typed `AuthError.Revoked`, not as a network
    error, and the TUI returns to the login state with a clear reason.
11. Re-authentication during a session: the TUI surfaces a banner, not a silent retry. Background operations pause, the
    user re-authenticates, and the pending work resumes; the typed recovery does not guess identities.
12. A refresh token is single-use machine-wide, not process-wide. The issuer rotates it on first use and revokes the
    whole family on the second, so several nikcli processes on one machine (installed TUI, dev build, background service,
    a `nikcli` command) serialize the refresh through a lock every one of them can see (`FileLock`) and re-read the
    account row from the database — never a cache — before spending the token. A process that cannot take the claim does
    not refresh; it answers from the account row and lets the holder rotate.
13. "Could not ask" is never "signed out". A startup that cannot reach the server, a `/user/me` that never answered, and
    an issuer that cannot be reached for a refresh all leave the session as it was: the sign-in dialog is opened only on
    an answer — a 401/403 from the server, or an `invalid_grant` on the refresh. Only that last one ends a session
    without the user asking, and the account row plus the local user it provisioned keep the machine signed in offline.

## Trust Topology

```text
Browser (packages/identity, Cloudflare Worker)
  - OAuth start, callback, PKCE, device-code, passkey
  - One-shot codes, short-lived, never stored client-side
Server (packages/nikcli)
  - Verifies issuer JWT (JWKS) at every request
  - Owns local account/user mapping
  - Owns session token issuance to SDK clients
TUI / SDK / CLI / mobile
  - Consumes server-issued tokens
  - Reports typed AuthError to UI on every transition
```

## Failure and Cancellation

`Schema.TaggedError` is required for every typed rejection: `AuthError.Network`, `AuthError.Timeout`,
`AuthError.InvalidGrant`, `AuthError.Expired`, `AuthError.Revoked`, `AuthError.AccountLimitReached`,
`AuthError.ProviderRejected`, `AuthError.OnboardingIncomplete`, `AuthError.PasskeyFailed`, `AuthError.RateLimited`.
Cancellation must interrupt the network polling (device-code, refresh) without leaving a dangling token; the TUI shows a
neutral "cancelled" state, never a fake error. A timed-out OAuth callback is not equivalent to a denied login; it is
reported as `AuthError.Timeout`. Redaction: tokens, OAuth codes, PKCE verifiers, email tokens, and passkey challenges
never appear in logs, errors, telemetry, or metric labels.

## Acceptance and Verification

- All identity state transitions are exercised through the SDK and the TUI: success, failure, expiry, revocation, switch,
  re-auth mid-session. Pure unit tests on the state machine are required, but real HttpApi round-trips with a controlled
  local issuer are also required.
- PKCE S256: a plain PKCE downgrade attempt fails signature verification on the server; a replay of a one-shot callback
  code is rejected. Device-code slow-down / expiry / access-denied are decoded into typed errors with no retry.
- Account creation cannot be skipped on first sign-in. Skipping a required onboarding step leaves the session incomplete;
  the TUI surfaces the missing step rather than reporting ready.
- Token refresh on a transient failure retries with bounded budget; expiry, revocation, and unknown grant do not retry;
  the user sees a typed banner with a reason and a re-auth button.
- Concurrent refreshes never present the same refresh token twice: a claim held elsewhere on the machine means no request
  is sent at all, and an unreachable issuer leaves the machine signed in rather than opening the sign-in dialog. Covered
  by `test/server/local-account-session.test.ts`, `test/util/file-lock.test.ts`, and `test/tui/user-api-session.test.ts`.
- Revocation issued from the issuer propagates to a connected TUI within EOT-04's reconnect window. A revoked token cannot
  silently re-authenticate using a previously cached refresh token.
- No tokens, OAuth codes, PKCE verifiers, email tokens, passkey challenges, or password material appear in logs, error
  bodies, stacks, telemetry spans, or metric dimensions. Redaction tests assert this for both success and failure paths.
- Extend `packages/nikcli/test/account/`, `packages/nikcli/test/auth/`, `packages/nikcli/test/server/httpapi-account.test.ts`,
  `packages/nikcli/test/server/httpapi-bridge-401.test.ts`, `packages/nikcli/test/server/httpapi-bridge-auth.test.ts`,
  `packages/nikcli/test/tui/onboarding-auth.test.ts`, and `packages/identity/test/` (existing).
- From `packages/nikcli`: `bun test test/account/ test/auth/ test/server/httpapi-account.test.ts test/tui/onboarding-auth.test.ts`.
  Run `packages/identity` tests through that package's own harness; do not assume a `bun test` in `packages/nikcli` covers
  Worker code. One final root `bun run typecheck` after the slice.

## Migration and Rollback

Inventory the existing flows first; classify each as PKCE, device-code, passwordless email, or passkey. Migrate the state
machine and contract; then update one flow (start with the TUI's `DialogAccountLogin`) to consume the new types.
Validate the existing flow with `kill-switch` flag flips before removing the old codepath. Roll back behind the same
flag, not by deleting account data or invalidating user tokens. Account storage changes are additive; never delete user
accounts or audit history as part of a refactor.

## Discipline Addendum — 2026-09-20

Three things landed here, and the most useful of them is a negative result.

### 1. The account guard has no call site, and that is the finding

`src/account/state.ts` holds the pure `decide()` and `src/account/guard.ts` the `requireAccount` / `requireAccountOrThrow` wrappers (commit `644a8f28`). `PRIVILEGED_FILES` in `script/check-account-required.ts` is empty, and it stays empty (commit `6d880fc3`). Every surface the guard was written for is account-optional **by design**, and listing it would convert working behaviour into 401s:

- **sync** — `server/httpapi/sync.ts` identifies an unauthenticated local caller as `"operator"`, and `sync/sync-config.ts` reports `configured: false` with no account so remote sync simply does not run. Local-only sync works today.
- **share** — `share/share-next.ts` POSTs to `s.nikcli-ai.dev/api/share` with no authorization header. The share service is anonymous.
- **mobile companion** — carries its own `nkm_` capability tokens (`MobileAuth`); teleport takes the _target_ server's token in the request body. Neither reads this machine's account.

The one surface that answers "who is signed in on this machine" — `/user/me` and `/account` — is `localAccountSession` in `server/identity-auth.ts`. It makes the same two calls as `decide()` but keeps a distinction `decide()` does not model: an issuer that **answered** that the refresh chain is over ends the session, while an issuer that could not be **reached** falls back to the held session. Folding it into `decide()` as it stands would collapse "couldn't ask" into "signed out" — the bug that had signed-in users meeting the sign-in dialog on every launch. So the guard waits for a route that genuinely cannot serve an unauthenticated caller, rather than being forced onto ones that can.

`decide()` fails closed: `identityVerified` is optional so a caller cannot forget it silently, not so it can be skipped. `AccountRequiredError.state` only ever carries a denial state; the third `AccountState` member belongs to the machine's vocabulary, not to that payload.

### 2. Verifier configuration is read at call time

`Flag.NIKCLI_AUTH_{ISSUER,JWKS_URL,AUDIENCE,JWT_SECRET}` were `const`, capturing `process.env` when `@nikcli-ai/util/flag` was first imported — by whichever module in the process touched a flag first (commit `48344aa4` makes them functions). `flag.ts` already documented this hazard on `autoApprove` and `cacheRetention`; these four were missed.

The symptom was not a config bug, it was eight tests that failed in a directory run and passed alone, for a year, with nothing wrong in either file: `test/server/local-account-session.test.ts` exports its own issuer and HS256 secret at the top of its own file, before importing anything, and still got the process defaults, so every token it signed verified as 401. **Any** file that boots the server machinery reproduces it and no file that does not ever will — which is the shape of a structural bug wearing a flake's clothes. `test/auth/identity-verifier-env.test.ts` guards the ordering that was broken (import first, set the variables after) and fails 6/6 against the constants.

### 3. The capture class is now a CI gate, not four fixes

Four more constants were in the same class, found by intersecting "captured as
`export const` in `flag.ts`" with "assigned to `process.env` anywhere in the repo at
runtime": `NIKCLI_DISABLE_MODELS_FETCH`, `NIKCLI_EXPERIMENTAL_DISABLE_FILEWATCHER`, and
the legacy-credential pair `NIKCLI_REQUIRE_OAUTH` / `NIKCLI_LEGACY_LOGIN`.

The pair is the one that matters. `test/server/unified-auth.fixture.ts` sets
`NIKCLI_REQUIRE_OAUTH=1` at its own module scope, so its tests could have run against a
gate that was never closed — **a security test that passes because the thing it meant to
forbid was never forbidden**. They were converted together, because every call site reads
both and a pair where one side is live and the other a snapshot can disagree. The auth
suite stays green with the gate actually closing, which is the evidence that those tests
were correct and not merely passing.

`script/check-flag-capture.ts` now enforces the rule: a flag assigned at runtime anywhere
in the repository must not be a captured constant. `flag.ts` had documented the hazard on
`autoApprove` and `cacheRetention` since long before any of this, and documenting it did
not stop six more from being added — which is the argument for a gate over a comment. Its
`ALLOWLIST` is empty and each entry would need a reason, since a check whose escape hatch
is adding a name is worth nothing.

### 4. PKCE

`test/auth/pkce-no-downgrade.test.ts` pins that the challenge method cannot fall back from S256 to plain.
