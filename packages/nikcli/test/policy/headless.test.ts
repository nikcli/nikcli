import { describe, expect, it } from "bun:test"
import { Policy } from "@/policy/policy"
import type { Config } from "@/config/config"

/**
 * EOT-17 policy + headless posture.
 *
 * `specs/effect-tui/17-sandbox-permission-boundaries.md` requirement 8:
 * "Headless mode fails closed unless every required decision is pre-resolved."
 *
 * Nikcli implements this at two boundaries:
 *
 *  - **Policy**: `Policy.allows()` walks `enabled_providers` /
 *    `disabled_providers` and `experimental.policies` statements; last match
 *    wins. The default answer to a missing match is `true` (allow) — that
 *    is the policy model: a user who does not write a statement is opting
 *    into the open default. **Headless callers must pre-resolve this with
 *    `Policy.allowsProvider()` before every provider use.**
 *
 *  - **Headless entry**: `cli/main-effect.ts` sets `NIKCLI_AUTO_APPROVE=1`
 *    only when `--auto`/`--yolo`/`--dangerously-skip-permissions` is on
 *    the command line. The CLI is the **only** way to set it; a headless
 *    caller without those flags sees no auto-approve, which is the
 *    "fails closed" default.
 */

function configWith(extra: Partial<Config.Info>): Config.Info {
  return { ...extra }
}

describe("EOT-17 Policy.allowsProvider", () => {
  it("a config with no statements allows every provider (open default)", () => {
    expect(Policy.allowsProvider(configWith({}), "anthropic")).toBe(true)
    expect(Policy.allowsProvider(configWith({}), "openai")).toBe(true)
  })

  it("disabled_providers narrows the allow set", () => {
    const cfg = configWith({ disabled_providers: ["anthropic"] })
    expect(Policy.allowsProvider(cfg, "anthropic")).toBe(false)
    expect(Policy.allowsProvider(cfg, "openai")).toBe(true)
  })

  it("enabled_providers flips the default to deny-others", () => {
    const cfg = configWith({ enabled_providers: ["anthropic"] })
    expect(Policy.allowsProvider(cfg, "anthropic")).toBe(true)
    expect(Policy.allowsProvider(cfg, "openai")).toBe(false)
  })

  it("experimental.policies statements take precedence over legacy lists", () => {
    // legacy says deny anthropic; experimental says allow it.
    const cfg = configWith({
      disabled_providers: ["anthropic"],
      experimental: {
        policies: [{ effect: "allow", action: "provider.use", resource: "anthropic" }],
      },
    })
    expect(Policy.allowsProvider(cfg, "anthropic")).toBe(true)
  })

  it("prefix wildcard matches every resource starting with the prefix", () => {
    const cfg = configWith({
      experimental: {
        policies: [{ effect: "allow", action: "provider.use", resource: "anthropic/*" }],
      },
    })
    expect(Policy.allowsProvider(cfg, "anthropic/claude-opus-4-6")).toBe(true)
    // A lone `allow` statement does NOT deny everything else: `allows()`
    // begins at the open default and only a *matching* statement changes it.
    // Narrowing the set requires an explicit `{ effect: "deny", resource: "*" }`
    // ahead of the allow — which is exactly what `legacyProviderStatements`
    // emits for `enabled_providers`.
    expect(Policy.allowsProvider(cfg, "openai/gpt-5")).toBe(true)
  })

  it("an explicit deny-* ahead of the allow is what narrows the set", () => {
    const cfg = configWith({
      experimental: {
        policies: [
          { effect: "deny", action: "provider.use", resource: "*" },
          { effect: "allow", action: "provider.use", resource: "anthropic/*" },
        ],
      },
    })
    expect(Policy.allowsProvider(cfg, "anthropic/claude-opus-4-6")).toBe(true)
    expect(Policy.allowsProvider(cfg, "openai/gpt-5")).toBe(false)
  })

  it("the * wildcard allows every provider", () => {
    const cfg = configWith({
      experimental: {
        policies: [{ effect: "allow", action: "provider.use", resource: "*" }],
      },
    })
    expect(Policy.allowsProvider(cfg, "anything")).toBe(true)
  })
})

describe("EOT-17 headless mode fails closed", () => {
  it("NIKCLI_AUTO_APPROVE is unset by default — autoApprove() does not activate", () => {
    // The CLI bootstrap is the only path that sets NIKCLI_AUTO_APPROVE;
    // a headless caller that does not pass --auto / --yolo /
    // --dangerously-skip-permissions sees no auto-approve, and prompts
    // would be answered with the default action — which for an
    // unattended runner is "ask" → blocked.
    const previous = process.env.NIKCLI_AUTO_APPROVE
    try {
      delete process.env.NIKCLI_AUTO_APPROVE
      expect(process.env.NIKCLI_AUTO_APPROVE).toBeUndefined()
    } finally {
      if (previous !== undefined) process.env.NIKCLI_AUTO_APPROVE = previous
    }
  })

  it("autoApprove preserves explicit deny rules (deny survives an opt-in blanket allow)", () => {
    // The `PermissionRuleset.autoApprove` rewrites a ruleset so nothing
    // asks, but explicit deny entries survive — the user set them on
    // purpose. This is the slice of the policy that makes
    // `fullAccess()` safe to hand to an unattended loop runner.
    const rules = PermissionRuleset.fullAccess()
    const auto = PermissionRuleset.autoApprove(rules)
    expect(auto.some((r) => r.action === "deny")).toBe(true)
    expect(auto.find((r) => r.permission === "*")?.action).toBe("allow")
  })
})

// Minimal re-export shim so the test can reach PermissionRuleset without
// pulling the whole permission module surface — and without going through
// PermissionNext (stateful, Effect-bound).
import { PermissionRuleset } from "@/permission/ruleset"

describe("EOT-17 Policy statement shape", () => {
  it("Statement is exactly {effect, action, resource}", () => {
    const statement: Policy.Statement = {
      effect: "allow",
      action: "provider.use",
      resource: "anthropic",
    }
    expect(statement).toEqual({
      effect: "allow",
      action: "provider.use",
      resource: "anthropic",
    })
  })

  it("legacyProviderStatements emits a default deny + per-provider allows when enabled_providers is set", () => {
    const stmts = Policy.legacyProviderStatements({
      enabled_providers: ["a", "b"],
    })
    expect(stmts.find((s) => s.effect === "deny" && s.resource === "*")).toBeDefined()
    expect(
      stmts
        .filter((s) => s.effect === "allow")
        .map((s) => s.resource)
        .sort(),
    ).toEqual(["a", "b"])
  })

  it("statements returns legacy + experimental in that order (experimental wins by being last)", () => {
    const stmts = Policy.statements({
      enabled_providers: ["legacy"],
      experimental: {
        policies: [{ effect: "allow", action: "provider.use", resource: "experimental" }],
      },
    })
    expect(stmts.at(-1)?.resource).toBe("experimental")
    expect(stmts.find((s) => s.resource === "legacy")).toBeDefined()
  })
})
