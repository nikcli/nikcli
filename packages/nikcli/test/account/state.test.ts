import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { AccountRequiredError, decide, describeDenial } from "@/account/state"
import { requireAccount } from "@/account/guard"
import { Account } from "@/account"

/**
 * EOT-12 account state machine + server-side guard.
 *
 * Tests here pin two contracts:
 *
 * 1. `decide()` is a pure function — same input, same output, no IO.
 * 2. `requireAccount()` is the server-side enforcement of the
 *    "account creation cannot be skipped" rule. A test runner can drive it
 *    with a stub layer; production code wires it into the HttpApi handlers.
 */

const STUB_ACTIVE = {
  id: "act_test_account",
  email: "test@nikcli.local",
  url: "https://auth.nikcli.store",
  active_org_id: null as null | string,
  created_at: 0,
  updated_at: 0,
}

const STUB_TOKEN = {
  id: STUB_ACTIVE.id,
  email: STUB_ACTIVE.email,
  url: STUB_ACTIVE.url,
  active_org_id: STUB_ACTIVE.active_org_id,
  created_at: STUB_ACTIVE.created_at,
  updated_at: STUB_ACTIVE.updated_at,
}

function stubLayer(opts: {
  active: typeof STUB_ACTIVE | undefined
  tokenSucceeds: boolean
}): Layer.Layer<Account.Service> {
  return Layer.succeed(
    Account.Service,
    Account.Service.of({
      login: () => Effect.die(new Error("not used in state-machine tests")),
      poll: () => Effect.die(new Error("not used in state-machine tests")),
      loginFull: () => Effect.die(new Error("not used in state-machine tests")),
      token: opts.tokenSucceeds
        ? () => Effect.succeed("stub-token")
        : () =>
            Effect.fail(
              new Account.TokenExpiredError({
                message: "stub failure",
              }) as never,
            ),
      orgs: () => Effect.succeed([] as never),
      active: () => Effect.succeed(opts.active),
      get: () => Effect.succeed(opts.active),
      list: () => Effect.succeed(opts.active ? [opts.active] : []),
      use: () => Effect.void,
      remove: () => Effect.succeed(false),
      config: () => Effect.succeed({ serverUrl: "https://auth.nikcli.store" }),
    }),
  )
}

describe("AccountState.decide()", () => {
  it("denies when no active account", () => {
    const verdict = decide({})
    expect(verdict.kind).toBe("deny")
    if (verdict.kind === "deny") {
      expect(verdict.reason).toBe("no_active_account")
      expect(verdict.state).toBe("unsigned")
    }
  })

  it("denies when identity is not verified even with an active account", () => {
    const verdict = decide({ active: STUB_ACTIVE, identityVerified: false })
    expect(verdict.kind).toBe("deny")
    if (verdict.kind === "deny") {
      expect(verdict.reason).toBe("identity_unverified")
      expect(verdict.state).toBe("expired")
    }
  })

  it("denies when token() failed despite an active account", () => {
    const verdict = decide({
      active: STUB_ACTIVE,
      tokenedBy: false,
      identityVerified: true,
    })
    expect(verdict.kind).toBe("deny")
    if (verdict.kind === "deny") {
      expect(verdict.reason).toBe("token_unavailable")
      expect(verdict.state).toBe("expired")
    }
  })

  it("allows when active account, identity verified, and token succeeds", () => {
    const verdict = decide({
      active: STUB_ACTIVE,
      tokenedBy: true,
      identityVerified: true,
    })
    expect(verdict.kind).toBe("allow")
    if (verdict.kind === "allow") {
      expect(verdict.accountID).toBe(STUB_ACTIVE.id)
    }
  })

  it("propagates the active org id when present", () => {
    const verdict = decide({
      active: { ...STUB_ACTIVE, active_org_id: "org_test" },
      tokenedBy: true,
      identityVerified: true,
    })
    expect(verdict.kind).toBe("allow")
    if (verdict.kind === "allow") {
      expect(verdict.orgID).toBe("org_test")
    }
  })
})

describe("AccountState.describeDenial()", () => {
  it("returns a non-empty human message for every denial reason", () => {
    const reasons: Array<"no_active_account" | "token_unavailable" | "identity_unverified"> = [
      "no_active_account",
      "token_unavailable",
      "identity_unverified",
    ]
    for (const reason of reasons) {
      const message = describeDenial({
        kind: "deny",
        reason,
        state: "unsigned",
      })
      expect(message.length).toBeGreaterThan(0)
    }
  })
})

describe("AccountState AccountRequiredError", () => {
  it("is a tagged error with reason + state + message", () => {
    const error = new AccountRequiredError({
      reason: "no_active_account",
      state: "unsigned",
      message: "Sign in to nikcli to use this endpoint.",
    })
    expect(error._tag).toBe("AccountRequired")
    expect(error.reason).toBe("no_active_account")
    expect(error.state).toBe("unsigned")
    expect(error.message).toBe("Sign in to nikcli to use this endpoint.")
  })
})

describe("AccountState requireAccount() guard", () => {
  it("fails with AccountRequiredError when there is no active account", async () => {
    const program = requireAccount().pipe(Effect.flip)
    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(stubLayer({ active: undefined, tokenSucceeds: false }))),
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      const err = exit.value as AccountRequiredError
      expect(err._tag).toBe("AccountRequired")
      expect(err.reason).toBe("no_active_account")
    }
  })

  it("succeeds and returns the account id when active + token ok", async () => {
    const result = await Effect.runPromise(
      requireAccount().pipe(Effect.provide(stubLayer({ active: STUB_TOKEN, tokenSucceeds: true }))),
    )
    expect(result.kind).toBe("allow")
    if (result.kind === "allow") {
      expect(result.accountID).toBe(STUB_ACTIVE.id)
    }
  })

  it("fails with token_unavailable when active account + token refresh fails", async () => {
    const exit = await Effect.runPromiseExit(
      requireAccount().pipe(Effect.flip, Effect.provide(stubLayer({ active: STUB_TOKEN, tokenSucceeds: false }))),
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      const err = exit.value as AccountRequiredError
      expect(err._tag).toBe("AccountRequired")
      expect(err.reason).toBe("token_unavailable")
    }
  })
})
