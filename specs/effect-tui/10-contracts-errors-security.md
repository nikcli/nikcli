# EOT-10: Contracts, Errors, and Trust Boundaries

Status: proposed. Tier: 1. Phase: P1. Dependencies: EOT-01.
Owner: HttpApi/domain/security maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B10, B15: schema-first HttpApi and tagged account failures are already implemented. Promise SDK calls normally
resolve `{ data, error }`, so catch-only handling can mistake failure for absent data. The standalone TUI config reader
currently turns rejected/empty responses into `{}`. Stronger error contracts must span producer, generated client, and UI.

## Scope and Non-Goals

Validate trust boundaries and preserve typed failures across the current HttpApi/SDK/TUI stack. Pilot account, TUI config,
session pending-input, and event/recovery contracts before broadening. No auth-policy relaxation, account-creation bypass,
manual generated code edits, Hono fallback, duplicate config schema, or implementation change to `packages/identity`
without a separately scoped contract review.

## Design and Requirements

1. Domain services own reusable Effect schemas and `Schema.TaggedError` definitions. Decode unknown inputs at service or
   transport boundaries, not after mutating state. Keep pure trusted internal transformations free of redundant decoding.
   New Effect code uses `return yield*` for expected failure, not throws inside `Effect.gen`.
2. Keep `packages/nikcli/src/server/httpapi/` the source of truth. Reuse existing service schemas and shared `domain.ts`
   schemas; derive on-disk config from Zod through `fromZod`. Do not handwrite a parallel `Config.Info` or a UI copy of a
   domain union merely to avoid importing generated types.
3. For each touched response, test absent key, present `undefined`, null, and value against actual producers and the encoded
   HTTP response. Check this pin's `Schema.optional`/`optionalKey` behavior; retain load-bearing `jsonSafe` normalization
   until producers are proven compatible. Typecheck alone does not prove response encoding.
4. Audit open success/domain payloads. The [open-payload policy](../README.md#open-payloads) requires an operation-specific
   justification and test for genuine opaque passthrough/event frames/redirects. Ordinary domain data may not use
   `Schema.Unknown` or generated `any` as a workaround for a failing schema.
5. Define a UI boundary outcome distinguishing success, domain rejection, authentication/authorization failure, transport
   failure, decode/encode contract failure, timeout, and cancellation. Reuse SDK/domain types; the adapter may normalize
   presentation, but must retain cause/category for diagnostics. A fulfilled Promise with `error` is a failure.
6. Keep status, operationId, route shape, directory/workspace selection, and compatibility names stable unless an explicitly
   additive/versioned change is required. Maintain served versus contract-only/raw group distinction; raw SSE and websocket
   routes require independent validation tests because HttpApi response encoding does not protect their runtime output.
7. Retry only classified transient operations with a budget and abortable wait. Never blindly retry non-idempotent writes,
   auth denial, validation errors, or unknown outcomes after a disconnect. Surface ambiguous mutation outcomes and refresh
   authoritative state before deciding whether retry is safe.
8. Preserve PKCE S256/device-code expiry/denial/slow-down semantics, account creation/onboarding requirements, callback
   redirect validation, and token refresh boundaries in affected flows. EOT-12 owns the state machine behind these
   transitions; this spec owns their wire contract. Keep authorization enforced server-side; hiding a
   TUI action is not an authorization boundary. Do not expand plugin autoload or cross-workspace visibility.
9. Log through the redacted sink. Error bodies, tokens, authorization headers, OAuth codes, prompts, and sensitive URL
   parameters cannot appear in TUI errors, stack traces, spans, or metric dimensions. EOT-13 owns the span/metric/log
   schema and the forbidden-dimension list this rule enforces. `NIKCLI_DEBUG` remains the existing
   stack-display control; no new telemetry export or credential exposure defaults.

## Outcome Matrix

| Outcome                        | User-facing behavior                                  | Retry/compatibility                               |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------- |
| Empty successful list          | Legitimate empty state                                | No failure banner                                 |
| Required config failure        | Actionable startup failure, no healthy default config | Explicit retry/auth action                        |
| Optional catalog failure       | Partial UI with stale/error resource state            | Bounded transient retry                           |
| Permission/auth rejection      | Visible denial or existing login flow                 | Never convert to empty success or auto-bypass     |
| Contract encode/decode failure | Sanitized internal/contract failure                   | No weakening schema to ship                       |
| Request cancelled by owner     | No stale commit or dismissal toast                    | No automatic retry                                |
| Mutation acknowledgement lost  | Unknown outcome, authoritative refresh                | No duplicate submission without idempotency proof |

## Failure and Cancellation

Keep Cause/Exit distinctions internally and sanitize only at user/wire boundaries. Capture the original error in logs
without leaking secrets; never manufacture success to keep a dialog open. An aborted client request must interrupt its
owned server work through EOT-02, while accepted durable jobs follow EOT-09 ownership. Error transformation must not turn
an interruption into a retryable transport error or overwrite the real failure with a cleanup message.

## Acceptance and Verification

- Test malformed input, real producer response encoding, optional/null variants, 401/403/404, transport disconnect, timeout,
  cancellation, and domain error round trips through `Server.fetch` and generated clients. No external sign-in required.
- Assert both SDK modes: default fulfilled `{ data, error }` and `throwOnError: true`. UI adapters produce the same category
  and never report complete/ready when only the catch path was bypassed.
- Standalone invalid/unauthorized config never silently becomes default config. Optional resources remain usable but
  visibly degraded. Pending user input cannot disappear because its fetch failed.
- Add redaction assertions for fake fixture secrets in error bodies/URLs/logs; use controlled local issuer responses to
  exercise auth protocol edge cases without real accounts or production DB access.
- Extend `packages/nikcli/test/server/httpapi-encode-failure.test.ts`,
  `packages/nikcli/test/server/httpapi-config-schema.test.ts`,
  `packages/nikcli/test/server/httpapi-client-compat.test.ts`, `packages/nikcli/test/server/httpapi-account.test.ts`, and
  matching `packages/nikcli/test/account/` and `packages/nikcli/test/tui/onboarding-auth.test.ts` cases.
- From `packages/nikcli`: `bun test test/server/httpapi-encode-failure.test.ts test/server/httpapi-config-schema.test.ts test/server/httpapi-client-compat.test.ts test/server/httpapi-account.test.ts`.
  After any HTTP contract edit: `bun run generate:httpapi-clients`, `bun run check:routes`, affected tests, and one final
  root `bun run typecheck`. Review all three generated targets and include their output with the implementation change.
- Encoding/decoding overhead stays within EOT-01 approved latency budgets. Improve schema reuse or boundary placement if
  needed; removing validation or expanding `any` is not a performance optimization.

## Migration and Rollback

Characterize one producer-to-TUI flow, fix its boundary and explicit error handling, regenerate if the contract changes,
then expand by domain. Maintain an inventory of intentional open payloads and existing compatibility names. Roll back
internal adapters behind the same contract or retain additive fields; do not break old SDK consumers or relax security,
validation, or CI client-drift checks to recover from a failed release.

## Discipline Addendum — 2026-09-20

`script/check-open-payloads.ts` is in CI (commit `644a8f28`), backed by `packages/nikcli/specs/httpapi-open-payloads.json`: 49 `Schema.Unknown` sites across `src/server/httpapi/`, 41 justified entries.

1. **The allowlist is keyed by file plus the declaring line's text, never by line number.** A line number makes every unrelated edit above a listed site fail the gate, and the repair — renumbering the allowlist — is a diff that looks like review and contains none. The snippet is also what a reviewer needs to read next to the justification. `count` covers a file that declares the same shape more than once, so a _second_ copy of an already justified declaration is still a new open payload and still needs review.
2. **`Schema.Record(Schema.String, Schema.Unknown)` is tracked but is not a violation.** The codegen emits `{ [k: string]: unknown }`, a typed record, not an `any`. It is listed so the policy stays explicit and CI does not block on it alone.
3. **A missing entry fails; a stale entry warns.** An allowlisted declaration that has disappeared is a cleanup, not a breach, and failing CI for it teaches people to delete entries to get green.
4. **The gate is driven by its own test.** `test/script/check-open-payloads.test.ts` runs the real script against a synthetic tree through `--dir` / `--allowlist`: unlisted fails, listed passes, a line shift still passes, a duplicate fails, a vanished entry warns without failing. An earlier version of that test re-declared the script's regexes and asserted against the copies, which passes whatever the script does.
