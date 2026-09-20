# EOT-17: Sandbox and Permission Boundaries

Status: proposed. Tier: 1. Phase: P2. Dependencies: EOT-02, EOT-09, EOT-10, EOT-11.
Owner: permission, sandbox, policy, tool, plugin maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B32, B33 in the [register](../README.md): `packages/nikcli/src/permission/{ruleset,evaluate,arity,schema}.ts`
already define a typed ruleset, an evaluation engine, and a per-tool coupling map (`PermissionRuleset.TOOL_PERMISSION`,
e.g. `monitor` → `bash`, edit-family → `edit`). A deny on `bash` covers `monitor`; a deny on `monitor` alone does **not**.
`packages/nikcli/src/sandbox/index.ts` exposes a sandbox primitive. The remaining gap is a unified architectural spec
covering the **full** permission/sandbox/policy model: file system globs, network domains, command execution, sandbox
isolation, plugin capability gating, and the runtime that ties them together. Right now, those primitives exist as
loosely-coordinated modules rather than a single coherent trust boundary.

## Scope and Non-Goals

Define the canonical permission, sandbox, and policy architecture: typed ruleset, evaluation engine, sandbox isolation,
plugin capability gating, and tool authorization. Preserve the existing `PermissionRuleset.TOOL_PERMISSION` map and the
existing permission schema. Do not invent a second policy DSL, relax the existing coupling rules, allow bypassing
permission evaluation in plugins, or change the default permission posture (interactive prompts).

## Design and Requirements

1. Permissions are typed at three levels: `Permission.Decision` (`allow`/`deny`/`prompt`), `Permission.Rule`
   (`{tool, pattern, action, scope}`), and `Permission.Ruleset` (the named bundle per workspace/session/tool family).
   The evaluation engine composes them through `PermissionRuleset.TOOL_PERMISSION` so a rule on a parent tool covers its
   coupled children, never the other way around.
2. The ruleset is a finite, ordered list and **the last matching rule wins**, as shipped and documented in
   [`specs/v2/permission-ruleset-and-coupling.md`](../v2/permission-ruleset-and-coupling.md). `merge` is plain
   concatenation and `evaluate` walks it with `findLast`; the default when nothing matches is `ask`. There is no
   ruleset-precedence operator — whatever ordering a workspace, session, project or global bundle has is decided by
   how the caller builds the array, not by the evaluator, and this spec does not add one. Do **not** adopt an
   action-precedence order in which `allow` beats `deny`:
   `PermissionRuleset.autoApprove` (the `--yolo` / `--dangerously-skip-permissions` path) is built as a blanket
   `allow` followed by the surviving `deny` rules, and it is last-match ordering alone that keeps those denials in
   force. Under `allow > deny` every rail the user deliberately set would silently stop applying. Specificity-based
   tie-breaking would break the same construction and is likewise out. The evaluation is pure and side-effect free;
   side effects (audit, prompt) happen after the decision.
3. Patterns are typed: file system globs use `micromatch`-style syntax with typed capture groups; command patterns use
   the existing shell-split tokenizer; network patterns use URL or domain patterns with explicit scheme/host/port. The
   schema rejects patterns that would silently match everything (`**`, `*`, `*://*`).
4. Decisions that require user input are routed to the TUI's permission prompt; the prompt uses the existing
   `interaction-spec` shape. The prompt is per-decision; the answer is recorded in the ruleset for the active scope
   but is **never** persisted as a global rule without an explicit "remember" action. Bulk-decision (e.g. "approve all
   bash") is a typed operation, not a silent blanket rule.
5. Permission denial is **terminal** for the operation: a denied call returns `PermissionError.Denied` with the rule
   that fired, the operation that was blocked, and the requested resource. The runtime never retries a denied operation
   on the user's behalf; a retry is an explicit user action.
6. The sandbox is a typed boundary that wraps a command's environment: file system view, network policy, environment
   variable whitelist, working directory, and child process budget. Sandbox configuration is part of the ruleset; the
   runtime applies it before the command starts, and the command cannot escape it. The sandbox does not provide
   cryptographic isolation; it provides containment at the OS level (file/path/network restrictions), not a jail.
7. Plugin capability gating follows EOT-14: a plugin's `permissions` field declares its request; the host grants
   capabilities through the ruleset; a denied capability disables the corresponding UI action with a reason, never
   silently no-ops.
8. Tool authorization is the runtime side of permissions. Every tool execution routes through `Permission.evaluate`,
   which composes the ruleset, the tool's declared requirements, and the ambient `WorkspaceRef`. Tools that need
   permission must declare it in their schema; the runtime refuses to invoke a tool that has undeclared permission
   requirements.
9. Network policy: outbound HTTP, WebSocket, and raw TCP from tools and plugins go through the runtime's `HttpClient`
   and a typed `Network.Policy`. The policy applies URL/domain filtering, schema validation of the request body, and
   redaction of the response. A tool that bypasses the policy is a defect, not a configuration.
10. Audit: every permission decision (allow/deny/prompt) is logged through the redacted sink with the rule, scope,
    operation, and outcome. Audit logs are queryable; the user can inspect the recent history in the TUI. Audit data
    never contains prompts, secrets, file contents, or arbitrary request bodies — only the rule key, scope id, and
    outcome.
11. Plugin trust: lifecycle isolation (EOT-14) is not security isolation. A plugin that gets a permission grant can
    exercise that grant; the ruleset enforces the grant, not the plugin lifetime. Plugins cannot grant themselves
    additional permissions, and the user-facing trust indicator (UI badge) reflects the active capability surface.
12. Default posture: interactive prompts are the default for any operation that requires a permission the ruleset
    does not pre-authorize. Headless/CI modes must declare an explicit ruleset that fully resolves every required
    decision; otherwise the runtime fails closed.

## Permission Topology

```text
Tool invocation
  -> Permission.evaluate(ruleset, tool, scope)
       -> Decision: allow | deny | prompt
       -> Sandbox.apply(sandboxConfig, scope)
       -> Network.Policy.apply(networkPolicy)
       -> Plugin capability check
       -> Audit log (redacted)
  -> Tool execution (typed Effect with abort)
       -> Cleanup: release sandbox resources, audit outcome
```

## Failure and Cancellation

Use `Schema.TaggedError`: `PermissionError.Denied`, `PermissionError.PromptCancelled`, `PermissionError.PromptTimeout`,
`PermissionError.RulesetInvalid`, `PermissionError.SandboxInitFailed`, `PermissionError.NetworkDenied`,
`PermissionError.CapabilityDenied`, `PermissionError.AuditFailed`. Cancellation of a permission prompt returns
`PermissionError.PromptCancelled`, not a denial; the operation does not run. Sandbox failures are observable in the
audit log and reported to the user; a sandbox leak is treated as a fatal runtime defect, not a permission denial.
Permission evaluation must not block indefinitely; an evaluation that needs a user prompt has a deadline.

## Acceptance and Verification

- Permission rules are exercised end-to-end: explicit allow, explicit deny, prompt, default-deny, scope inheritance,
  tool-coupling (deny on `bash` covers `monitor`, deny on `monitor` alone does not), and the longest-match precedence.
- A sandbox-init failure aborts the operation with `PermissionError.SandboxInitFailed`; the resource is not leaked.
- A network call from a tool that bypasses the `Network.Policy` is rejected as a defect; the bypass attempt is recorded.
- Plugin capability denial disables the corresponding UI action with a reason; the plugin cannot self-grant.
- Audit logs contain no prompt content, secrets, file contents, or arbitrary request bodies; a fuzz test asserts this
  for both allow and deny paths.
- Headless mode without a fully-resolving ruleset fails closed; a CI run with a permissive flag and a missing ruleset
  does not silently run with default permissions.
- Permission denial never retries on the user's behalf; the user explicitly retries if desired.
- Extend `packages/nikcli/test/permission/`, `packages/nikcli/test/sandbox/`, `packages/nikcli/test/policy/`,
  `packages/nikcli/test/plugin/`, and the existing tool permission tests.
- From `packages/nikcli`: `bun test test/permission/ test/sandbox/ test/policy/ test/plugin/`. One final root
  `bun run typecheck` after the slice.
- Meet EOT-01 budgets; permission evaluation p95 below 5 ms; audit write does not exceed the approved log budget;
  redaction tests pass with synthetic secrets.

## Migration and Rollback

Inventory existing permission checks and group them by ruleset (file system, network, command, plugin). Migrate one
group (start with the file system) to the typed evaluation. Verify the existing interactive prompt remains the default.
Add the new audit schema and redaction tests. Roll back by falling back to the legacy evaluator; never delete the typed
errors or the audit schema. Plugin permission grants are additive; never revoke a previously-granted capability without
an explicit migration step.

## Discipline Addendum — 2026-09-19

Slice 6 landed the parts of this spec that are enforceable today, and recorded the one that is not. Four notes so a reviewer does not have to re-derive them.

1. **Network policy has no chokepoint — and building one now would be a lie.** The spec asks for every outbound HTTP/WS/raw TCP call to route through the runtime `HttpClient`. It does not: `fetch`/`WebSocket`/`Bun.connect` are called directly from **45 modules** under `packages/nikcli/src`, and the only Effect `FetchHttpClient` layer in the tree (`observability/otlp.ts`) serves OTLP export alone. Wrapping a layer that nothing calls would add a policy check no traffic passes through. What is enforced instead is **accounting**: `packages/nikcli/specs/network-egress.json` lists all 45 modules with a purpose, and `script/check-network-egress.ts` fails CI on an unlisted egress module (new surface) or a listed module with no egress (stale entry). Regenerate the list with `--report`; the detector that validates the file is the one that produced it, so they cannot drift. `packages/llm/src` is already layer-based and has zero direct egress — that is the shape the rest should eventually take.
2. **The sandbox contract is pinned by tests, not by a comment.** `test/sandbox/sandbox.test.ts` locks `SAFE_ENV_PASSTHROUGH` (the exact eight-variable allowlist), `scrubEnv`'s credential stripping and caller-extras behaviour, the `{cwd, project}` shape of `EscapeError`, the SIGTERM→SIGKILL escalation producing a typed `TimeoutError`, and the fact that `defaultLayer === localLayer` — i.e. no Docker/Vercel/Firecracker layer has been wired despite the plug-in points existing as types. A future layer must update that last assertion deliberately.
3. **`Policy.allows` starts from the open default and takes the last match.** A lone `{allow, resource: "anthropic/*"}` does **not** deny every other provider; narrowing requires an explicit `{deny, resource: "*"}` ahead of the allow — which is exactly what `legacyProviderStatements` emits for `enabled_providers`. `test/policy/headless.test.ts` pins both halves, because assuming the stricter reading is the natural mistake.
4. **Headless fails closed at the CLI boundary, not in policy.** `cli/main-effect.ts` sets `NIKCLI_AUTO_APPROVE=1` only for `--auto`/`--yolo`/`--dangerously-skip-permissions`. There is no other writer. An unattended runner therefore hits `ask` and blocks unless the caller opted in — and `PermissionRuleset.autoApprove` keeps `deny` entries alive underneath the blanket allow, which is what makes `fullAccess()` safe to hand to a loop/mission runner. The bash⊃monitor and edit-family couplings were already locked by `test/permission/coupling.test.ts`; Slice 6 added nothing there because nothing was missing.
