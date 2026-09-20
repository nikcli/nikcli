import { describe, expect, it } from "bun:test"
import { Config } from "@/config/config"
import { Policy } from "@/policy/policy"

/**
 * The legacy-key contract for `nikcli.json`.
 *
 * `specs/v2/config.md` carries a per-field ledger — 17 fields to remove, 16 to
 * redesign — and a `Missing` row naming the one test that would promote it out
 * of `Proposed`: *a per-field migration test asserting that each `redesign`
 * row's legacy key still loads and maps to its new key.* This is that test,
 * written against the mappings that **already exist**, so it starts green on the
 * six the loader already performs and the first new rename extends it rather
 * than inventing it.
 *
 * Why this matters more than it looks. The ledger presents the migration
 * mechanism as an open choice between two precedents that disagree. They do not
 * disagree — they answer different questions:
 *
 *  - **Accept both keys in the loader** is used six times, and every case is a
 *    rename *within the same document*.
 *  - **Rewrite the file** (`migrate-tui-config.ts`) is used once, and only
 *    because it moves fields into a *different* document (`tui.json`) with its
 *    own published schema — which loader mapping cannot do.
 *
 * Every rename the ledger proposes (`plugin` → `plugins`, `agent` → `agents`,
 * and the rest) stays inside `nikcli.json`. So the mechanism is the first one,
 * and this file is the shape each of those renames gets tested in.
 *
 * Scope note: the three top-level mappings (`mode`, `tools`, `autoshare`) run
 * inside the file-loading pipeline and need a directory fixture, so they are not
 * here yet. The two agent-level ones and the provider pair are pure and are.
 */

describe("agent-level legacy keys", () => {
  it("maps `tools` to `permission`, allow for true and deny for false", () => {
    const agent = Config.Agent.parse({ tools: { bash: true, webfetch: false } })

    expect(agent.permission).toEqual({ bash: "allow", webfetch: "deny" })
  })

  it("collapses the whole edit family onto one `edit` permission", () => {
    // write/edit/patch/multiedit are one family — the same coupling
    // `PermissionRuleset.TOOL_PERMISSION` enforces at evaluation time. A legacy
    // document that names them separately must not produce four permissions.
    const agent = Config.Agent.parse({ tools: { write: false, patch: false, multiedit: false } })

    expect(agent.permission).toEqual({ edit: "deny" })
  })

  it("lets an explicit `permission` win over the legacy `tools` it overlaps", () => {
    // The new key is authoritative. If this inverted, a user adding `permission`
    // to a document that still had `tools` would silently keep the old answer.
    const agent = Config.Agent.parse({ tools: { bash: false }, permission: { bash: "allow" } })

    expect(agent.permission?.bash).toBe("allow")
  })

  it("maps `maxSteps` to `steps`", () => {
    expect(Config.Agent.parse({ maxSteps: 12 }).steps).toBe(12)
  })

  it("lets `steps` win over `maxSteps` when a document carries both", () => {
    expect(Config.Agent.parse({ steps: 3, maxSteps: 12 }).steps).toBe(3)
  })

  it("leaves `steps` absent rather than present-and-undefined when neither is set", () => {
    // Not a style point. The HttpApi encoder rejects a *present* `undefined`
    // against an `optionalKey` field, which is how `GET /config` answered an
    // empty 400 before `jsonSafe` — the same class
    // `specs/effect-tui/10-contracts-errors-security.md` sweeps for.
    const agent = Config.Agent.parse({ name: "plain" })

    expect("steps" in agent && agent.steps === undefined).toBe(false)
  })
})

describe("provider legacy keys", () => {
  it("maps `disabled_providers` to a deny statement", () => {
    const statements = Policy.legacyProviderStatements({
      disabled_providers: ["openai"],
      enabled_providers: undefined,
    })

    expect(statements).toContainEqual({ effect: "deny", action: "provider.use", resource: "openai" })
  })

  it("closes the default before allowing, so `enabled_providers` is really a whitelist", () => {
    // `Policy.allows` starts from the open default and takes the last match, so
    // a lone allow narrows nothing. The deny-all has to come first, and it has
    // to come *before* the allows in the array — assert the order, not just the
    // membership.
    const statements = Policy.legacyProviderStatements({
      enabled_providers: ["anthropic"],
      disabled_providers: undefined,
    })

    const denyAll = statements.findIndex((s) => s.effect === "deny" && s.resource === "*")
    const allow = statements.findIndex((s) => s.effect === "allow" && s.resource === "anthropic")

    expect(denyAll).toBeGreaterThanOrEqual(0)
    expect(allow).toBeGreaterThan(denyAll)
  })

  it("emits nothing when neither legacy key is present", () => {
    // A document that never used these keys must not acquire a policy, or the
    // legacy path would change behaviour for people who never opted into it.
    expect(Policy.legacyProviderStatements({ enabled_providers: undefined, disabled_providers: undefined })).toEqual([])
  })
})
