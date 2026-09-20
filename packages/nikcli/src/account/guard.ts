import { Effect } from "effect"
import { Account } from "./index"
import { AccountRequiredError, decide, describeDenial, type AccountGuardResult } from "./state"
import { runPromiseWithLayer } from "@/effect"

/**
 * Server-side account-required guard.
 *
 * `specs/effect-tui/12-identity-onboarding-auth.md` says account creation
 * cannot be skipped. The TUI already enforced this in the UI; this guard
 * is what stops a malformed client from bypassing it on the wire. Handlers
 * that touch the signed-in account (sync, share, mobile companion) call
 * `requireAccount` and treat `deny` as a typed `AccountRequiredError`.
 *
 * The guard itself only gathers: `Account.Service.active()` plus one token
 * attempt. Every verdict comes from the pure `decide()` in `state.ts`, which
 * is the single source of truth for the state machine — so the decision can
 * be tested without a service, and there is no second place a rule can
 * drift to.
 *
 * Not yet called from any handler. `script/check-account-required.ts` holds
 * the (currently empty) list of privileged routes that must adopt it; adding
 * a route there and not calling `requireAccount` from it fails CI. Wiring
 * the first routes is a deliberate step of its own, because a guard switched
 * on everywhere at once locks out every client that has not signed in yet.
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
