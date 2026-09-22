import { Effect } from "effect"
import { Account } from "./index"
import { AccountRequiredError, decide, describeDenial, type AccountGuardResult } from "./state"
import { runPromiseWithLayer } from "@/effect"

/**
 * Server-side account-required guard.
 *
 * `specs/effect-tui/12-identity-onboarding-auth.md` asks for a guard that
 * stops a malformed client from skipping account creation on the wire. This
 * is it: it gathers `Account.Service.active()` plus one token attempt, and
 * every verdict comes from the pure `decide()` in `state.ts`, so the decision
 * is testable without a service and cannot drift to a second place.
 *
 * **It has no call site, and that is the finding, not an omission.** Each
 * surface the guard was meant for turned out to be account-optional by
 * design, and switching it on would convert working behaviour into 401s:
 *
 *  - **sync** — `server/httpapi/sync.ts` identifies an unauthenticated local
 *    caller as `"operator"`, and `sync/sync-config.ts` reports
 *    `configured: false` with no account so remote sync simply does not run.
 *    Requiring an account here would break local-only sync, which works.
 *  - **share** — `share/share-next.ts` POSTs to `s.nikcli-ai.dev/api/share`
 *    with no authorization header at all. The share service is anonymous.
 *  - **mobile companion** — carries its own `nkm_` capability tokens
 *    (`MobileAuth`), and teleport takes the *target* server's token in the
 *    request body. Neither reads this machine's account.
 *
 * The one surface that does answer "who is signed in on this machine" —
 * `/user/me` and `/account` — is served by `localAccountSession` in
 * `server/identity-auth.ts`, which makes the same two calls but keeps a
 * distinction `decide()` deliberately does not model: an issuer that
 * *answered* that the refresh chain is over ends the session, while an
 * issuer that could not be reached falls back to the held session. Folding
 * it into `decide()` as it stands would collapse "couldn't ask" into
 * "signed out" — which is the bug that had signed-in users meeting the
 * sign-in dialog on every launch.
 *
 * So this stays available and tested, and a route adopts it when one
 * genuinely cannot serve an unauthenticated caller. Adding a file to
 * `PRIVILEGED_FILES` in `script/check-account-required.ts` without importing
 * this module fails CI.
 */
export function requireAccount(): Effect.Effect<
  Extract<AccountGuardResult, { kind: "allow" }>,
  AccountRequiredError,
  Account.Service
> {
  return Effect.gen(function* () {
    const account = yield* Account.Service
    const active = yield* account.active()
    let tokenedBy: boolean | undefined
    if (active) {
      const result = yield* account.token(active.id).pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.succeed(true),
          onFailure: () => Effect.succeed(false),
        }),
      )
      tokenedBy = result
    }
    const verdict = decide({ active, tokenedBy, identityVerified: true })
    if (verdict.kind === "allow") return verdict
    return yield* Effect.fail(
      new AccountRequiredError({
        reason: verdict.reason,
        state: verdict.state,
        message: describeDenial(verdict),
      }),
    )
  })
}

/**
 * Promise-side helper for raw-`Response` handlers (the `/account/*`
 * group) that want a sync `Promise` shape. Same semantics as
 * `requireAccount`, wrapped in `runPromiseWithLayer`.
 */
export async function requireAccountOrThrow(): Promise<Extract<AccountGuardResult, { kind: "allow" }>> {
  return runPromiseWithLayer(Account.defaultLayer, requireAccount())
}
