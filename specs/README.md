# Architecture Specs

Planning baseline: 2026-09-10. Scope: `packages/tui` and `packages/nikcli`, including their SDK, identity, observability,
bridge, and host seams.

Start with the [integrated roadmap](ROADMAP.md). These are implementation specifications, not claims that the proposed
changes or performance targets have shipped. Every spec has at least one landed slice — the roadmap's landed-work table
is the record of which — and a landed slice is not a passed release gate; the migrations the specs scope remain open.
EOT-18 is the one spec whose premise has been overtaken: the yargs surface it was written against is gone, and
[`cli-framework.md`](cli-framework.md) is the reference for what replaced it. Each spec header carries its own status.
No benchmark was run to establish a runtime baseline during this documentation change.

## Specification Catalog

| ID     | Specification                                                                                    | Primary ownership                          | Outcome                                                                  |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------ |
| EOT-01 | [Performance and verification baseline](effect-tui/01-performance-baseline.md)                   | Both packages                              | Reproducible budgets, lifecycle counters, meaningful gates               |
| EOT-02 | [Effect runtime and service boundaries](effect-tui/02-effect-boundaries.md)                      | nikcli Effect and domain maintainers       | Typed requirements, one bridge, explicit resource ownership              |
| EOT-03 | [TUI asynchronous lifecycle](effect-tui/03-tui-lifecycle.md)                                     | TUI contexts and dialogs                   | Cancellation and stale-result safety without framework churn             |
| EOT-04 | [Event delivery and recovery](effect-tui/04-event-delivery.md)                                   | Bus, server feed, TUI SDK                  | Bounded delivery with explicit recovery and no silent loss               |
| EOT-05 | [Reactive state and query coordination](effect-tui/05-reactive-state.md)                         | TUI sync and session view                  | Incremental updates, bounded caches, truthful readiness                  |
| EOT-06 | [Measured terminal rendering](effect-tui/06-terminal-rendering.md)                               | TUI session and renderer                   | Stable streaming, measured virtualization, idle efficiency               |
| EOT-07 | [Input and interaction architecture](effect-tui/07-input-interaction.md)                         | TUI prompt, dialogs, keymaps               | Deterministic focus and accessible keyboard workflows                    |
| EOT-08 | [Host, plugin, and startup boundaries](effect-tui/08-host-plugins-startup.md)                    | CLI host and TUI plugin maintainers        | Lean startup and revocable plugin lifetimes                              |
| EOT-09 | [Jobs, persistence, and resource budgets](effect-tui/09-jobs-persistence.md)                     | nikcli execution and repositories          | Durable outcomes, bounded concurrency, correct cancellation              |
| EOT-10 | [Contracts, errors, and trust boundaries](effect-tui/10-contracts-errors-security.md)            | HttpApi and domain maintainers             | Validated responses and failures that cannot look like success           |
| EOT-11 | [Provider streaming and inference pipeline](effect-tui/11-provider-inference-streaming.md)       | Provider/llm core maintainers              | Unified AI SDK → LLMEvent adapter, cancellation, cache, token accounting |
| EOT-12 | [Identity, onboarding, and auth flows](effect-tui/12-identity-onboarding-auth.md)                | Identity/auth/account maintainers          | Typed identity state machine, no PKCE downgrade, no skipped onboarding   |
| EOT-13 | [Observability pipeline and tracing](effect-tui/13-observability-pipeline.md)                    | Observability/brain/profile maintainers    | Fixed schema, redaction, bounded live panel, optional OTLP export        |
| EOT-14 | [Plugin v2 contracts and hot reload](effect-tui/14-plugin-v2-architecture.md)                    | Plugin SDK/runtime maintainers             | v2 manifest, capability gating, scoped generation, hot reload            |
| EOT-15 | [Sync snapshots, watermarks, and multi-device state](effect-tui/15-sync-snapshots-watermarks.md) | Sync/mobile-bridge maintainers             | Snapshot barrier, watermark, gap handling, multi-device ordering         |
| EOT-16 | [Workspace isolation and multi-workspace architecture](effect-tui/16-workspace-isolation.md)     | Workspace/project/worktree maintainers     | Workspace as typed Effect scope, hot switch, deterministic isolation     |
| EOT-17 | [Sandbox and permission boundaries](effect-tui/17-sandbox-permission-boundaries.md)              | Permission/sandbox/policy/tool maintainers | Typed ruleset, coupling respected, sandbox containment, headless posture |
| EOT-18 | [CLI command architecture and dispatch](effect-tui/18-cli-command-architecture.md)               | CLI dispatch/maintainers                   | Consistent command shape, daemon lifecycle, headless posture             |
| EOT-19 | [Mobile companion bridge](effect-tui/19-mobile-companion-bridge.md)                              | Mobile/companion/remote maintainers        | Typed bridge, JWT, websocket, multi-device, capability gating            |
| EOT-20 | [Testing architecture and harnesses](effect-tui/20-testing-architecture-harnesses.md)            | Test infrastructure                        | Three-layer harness, deterministic fixtures, barrier-based races         |

## Evidence Register

Paths are relative to the repository root. Line references describe this inspection, not permanent API anchors.
An observed implementation surface is not automatically a proven runtime bug.

| Evidence | Inspected source                                                                                                  | Observed foundation or next-step opportunity                                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B01      | `packages/tui/package.json:33`, `packages/nikcli/package.json:133`, `package.json:94`                             | Effect/platform-bun remain pinned; OpenTUI core/solid are now `0.5.11` (released 2026-09-11). The local `@opentui/core@0.5.10` streaming-code patch was dropped because 0.5.11 already keeps `_lastHighlights` while streaming.                                    |
| B02      | `packages/nikcli/src/effect/runtime.ts:67`, `packages/nikcli/src/effect/run-service.ts:16`                        | Shared memo map and cached runtimes exist; `runService` now shares requirement type `R`, while `runPromiseWithLayer` and `runPromiseExitWithLayer` still erase requirements with `any`                                                                             |
| B03      | `packages/nikcli/src/effect/instance-scope.ts:19`, `packages/nikcli/src/effect/instance-state.ts:44`              | Structured interruption already exists; instance state has effectively unlimited capacity and lifetime by design                                                                                                                                                   |
| B04      | `packages/tui/src/util/lifecycle.ts:21`                                                                           | Abort-on-cleanup helper explicitly requires both abort and post-await checks; extend, do not duplicate                                                                                                                                                             |
| B05      | `packages/tui/src/context/sdk.tsx:117`                                                                            | Client batches envelopes at 16 ms; its array has no explicit capacity; reconnect uses manual backoff and `Bun.sleep`                                                                                                                                               |
| B06      | `packages/nikcli/src/server/httpapi/event-feed.ts:33`                                                             | Server already encodes once and bounds lag at 4096 frames; this is not a byte bound                                                                                                                                                                                |
| B07      | `packages/tui/src/context/sync.tsx:728`, `packages/tui/src/context/sync.tsx:867`                                  | Bootstrap has a generation guard; session LRU already has 25 entries and 30-minute TTL; optional request failures need explicit state                                                                                                                              |
| B08      | `packages/tui/src/routes/session/index.tsx:167`                                                                   | Live renderer already consumes `fromEntries` and stabilizes turns; nearby v1 migration prose is stale                                                                                                                                                              |
| B09      | `packages/tui/src/routes/session/index.tsx:185`, `packages/tui/src/routes/session/message-window.ts:54`           | `MESSAGE_HEIGHT_ESTIMATE = 6` and the 50 ms scroll poll live in `index.tsx`, which falls back to the full list while streaming; `message-window.ts` is pure range math                                                                                             |
| B10      | `packages/tui/src/app.tsx:102`, `packages/tui/src/host/standalone.ts:67`                                          | Renderer cap is 45 FPS; standalone host has no backend imports; remote config request failures throw `TuiConfigError` at startup, while reload logs the failure and retains the last good config                                                                   |
| B11      | `packages/tui/src/ui/dialog.tsx:148`                                                                              | Escape still closes only the top dialog. Ctrl+C now asks `renderer.currentFocusedEditor` instead of stringifying the stack entry or probing `document.activeElement`. Shared confirm/alert/help/export dialogs consume return with preventDefault/stopPropagation. |
| B12      | `packages/tui/src/plugin/runtime.ts:140`                                                                          | Plugin cleanup distinguishes success/error/timeout, but a Promise timeout alone cannot stop underlying work                                                                                                                                                        |
| B13      | `packages/nikcli/src/bus/index.ts:173`                                                                            | Promise publish is deliberately best-effort; changing it globally would change compatibility semantics                                                                                                                                                             |
| B14      | `packages/nikcli/src/monitor/manager.ts:24`, `packages/nikcli/src/background/run.ts:19`                           | Monitor output/tail and persistence are already throttled; background runs already have ownership and leases                                                                                                                                                       |
| B15      | `packages/nikcli/src/account/index.ts:31`, `packages/nikcli/AGENTS.md:67`                                         | Tagged account failures and schema-first HttpApi workflow already exist                                                                                                                                                                                            |
| B16      | `packages/nikcli/script/tui-startup.ts:198`                                                                       | Startup probe reports nearest-rank min/median/p95/max plus raw samples and optional child RSS; bootstrap is labeled separately from warm runs                                                                                                                      |
| B17      | `packages/nikcli/test/tui/streaming-churn.test.tsx:25`                                                            | Real renderable destruction is measured; preserve these non-vacuous regression assertions                                                                                                                                                                          |
| B18      | `packages/nikcli/src/session/prompt.ts`, `packages/tui/src/component/prompt/index.tsx`                            | Large coordination modules deserve responsibility-based extraction, not arbitrary file-size targets                                                                                                                                                                |
| B19      | `docs/sync-architecture.md:6`, `packages/nikcli/src/sync/index.ts`                                                | Durable per-aggregate sequence/snapshot machinery exists; global SSE is not automatically a replay protocol                                                                                                                                                        |
| B20      | `packages/llm/src/`, `packages/nikcli/src/provider/provider.ts:22`                                                | New `@nikcli-ai/llm` package owns `LLMEvent`/`LLMRequest` and route composition; the production request path still runs through AI SDK + Promises                                                                                                                  |
| B21      | `packages/nikcli/src/session/llm/{request,native-request,native-runtime,llm-event-adapter}.ts`                    | Per-provider streaming adapters and `llm-event-adapter` exist as a seam; no single Effect `Stream` topology spans provider → SDK → SSE → TUI                                                                                                                       |
| B22      | `packages/nikcli/src/provider/{cache-policy,cache-diagnostics,models-macro}.ts`                                   | Provider cache policy, diagnostics, and macro live as three separate modules; no typed `CachePolicy.Service` to compose them                                                                                                                                       |
| B23      | `packages/nikcli/src/provider/error.ts`, `packages/nikcli/src/provider/nikcli-inference.ts`                       | Provider errors and inference quota checks exist; absence of a tagged retry/failover service means retries are scattered through `session/llm/*`                                                                                                                   |
| B24      | `packages/identity/src/{login,passkey,tokens,rate-limit,http}.ts`                                                 | `packages/identity` Worker exposes PKCE, device-code, passkey, rate-limit; no unified state machine in the contract layer                                                                                                                                          |
| B25      | `packages/nikcli/src/server/identity-auth.ts:11`, `packages/nikcli/src/server/mobile/auth.ts`                     | JWT verifier options + bridge token validation exist; revoke/expire/re-auth are not a typed transition yet                                                                                                                                                         |
| B26      | `packages/nikcli/src/observability/otlp.ts:7`, `packages/nikcli/src/observability/telemetry-bus.ts`               | `Observability.layer` and `TelemetryRecord` exist; span/metric/log schema is implicit, not documented in one place                                                                                                                                                 |
| B27      | `packages/nikcli/src/brain/{index,scheduler}.ts`                                                                  | `brain` runs a scheduler; the schedule registry and metric/span integration live outside the observability spec                                                                                                                                                    |
| B28      | `packages/nikcli/src/profile/{index,profile}.ts`                                                                  | Profile counters exist; their cardinality and redaction rules are not coordinated with OTLP/live panel                                                                                                                                                             |
| B29      | `packages/plugin/src/v2/{effect,promise,tui}/`, `packages/plugin/src/tui.ts`                                      | v2 plugin contract exists with effect/promise/tui modules; runtime still routes through the legacy `plugin/runtime.ts`                                                                                                                                             |
| B30      | `packages/tui/src/plugin/{runtime,reload,v2,storage,host}.ts`                                                     | Plugin runtime, hot reload, and storage scopes exist; capability gating, scoped generation, and manifest validation are not a single contract                                                                                                                      |
| B31      | `packages/nikcli/src/effect/{instance-ref,instance-scope,instance-state,with-instance}.ts`                        | `InstanceRef`/`WorkspaceRef`/`InstanceState` exist; workspaces are a label on a request, not a first-class Effect scope                                                                                                                                            |
| B32      | `packages/nikcli/src/permission/{ruleset,evaluate,arity,schema}.ts`                                               | Typed ruleset + coupling map + evaluator exist; network/sandbox/plugin capabilities are not coordinated in one boundary                                                                                                                                            |
| B33      | `packages/nikcli/src/sandbox/index.ts`, `packages/nikcli/src/policy/policy.ts`                                    | Sandbox primitive + policy DSL exist; the runtime does not enforce a single sandbox boundary across tools/plugins                                                                                                                                                  |
| B34      | `packages/nikcli/src/cli/commands.ts`, `packages/nikcli/src/cli/framework/`, `packages/nikcli/src/cli/cmd/cmd.ts` | The yargs migration landed (see [`specs/cli-framework.md`](cli-framework.md)): the command tree is data and `cmd()` declares `bootstrap`/`teardown`. Dispatch-adjacent policy — exit-code mapping, headless posture, plugin command scoping — is still per-command |
| B35      | `packages/nikcli/src/cli/effect/prompt.ts`                                                                        | `@clack/prompts` wrapped in Effect; prompt fallback to non-interactive defaults is implicit                                                                                                                                                                        |
| B36      | `packages/nikcli/src/server/httpapi/mobile.ts`, `packages/nikcli/src/server/mobile/`                              | `/mobile/*` is one HttpApi group (1,319 lines) over 18 handler modules (3,605 lines) plus `server/websocket.ts`; the protocol is implicit                                                                                                                          |
| B37      | `packages/companion/`, `packages/remote/`                                                                         | Companion (Cloudflare Workers + UI) and remote (tunneled proxy + UI) exist; both consume the same bridge but do not share a schema test                                                                                                                            |
| B38      | `packages/nikcli/test/helpers/{sqlite,tool-context}.ts`, `script/test-ci.ts`, `package.json` scripts              | Isolated-database + tool-context helpers, sharded CI harness, and `test:unit`/`test:integration`/`test:e2e` exist; the layers split by path, not by resource access                                                                                                |
| B39      | `packages/nikcli/test/tui/`, `packages/nikcli/test/server/`, `packages/nikcli/test/effect/`                       | TUI/server/effect test directories exist; barriers vs. `sleep` discipline is not documented as a spec                                                                                                                                                              |
| B40      | `packages/nikcli/test/plugin/`, `packages/nikcli/test/cli/`, `packages/nikcli/test/mobile/`                       | Plugin/CLI/mobile test directories exist; per-feature harnesses vary and re-invent fixture loaders                                                                                                                                                                 |

## Pinned Technique References

The workspace has no root `node_modules/effect/AGENTS.md`; the installed reference is
`packages/nikcli/node_modules/effect/AGENTS.md`. Read that file and its sibling `ai-docs/src`, not an unrelated v3 tutorial.
Confirmed in this installation: `Context.Service`, `Schema.TaggedError`, `Effect.fn`, `Effect.tryPromise`,
`Effect.acquireRelease`, `Effect.forkScoped`, `Queue.bounded`, `PubSub.bounded`, `Schedule.exponential`,
`Schedule.jittered`, and `Schedule.recurs`. Exact composition semantics must be checked when implementing.

Relevant installed examples:

- `packages/nikcli/node_modules/effect/ai-docs/src/01_effect/05_resources/10_acquire-release.ts`
- `packages/nikcli/node_modules/effect/ai-docs/src/06_schedule/10_schedules.ts`
- `packages/nikcli/node_modules/effect/ai-docs/src/01_effect/03_services/20_layer-composition.ts`
- `packages/nikcli/node_modules/effect/node_modules/effect/ai-docs/src/02_schema/02_tagged-errors.ts`

OpenTUI skill pages read: `/docs/bindings/solid`, `/docs/core-concepts/renderer`, and `/docs/core-concepts/keyboard`.
Those documentation routes are references, not repository files. Check the installed declarations before selecting APIs:
`packages/tui/node_modules/@opentui/core/renderer.d.ts`,
`packages/tui/node_modules/@opentui/core/renderables/ScrollBox.d.ts`, and
`packages/tui/node_modules/@opentui/solid/index.d.ts`.
`testRender`, `requestRender`, `requestLive`, `dropLive`, typed `scrollTop`/`scrollHeight`, `scrollChildIntoView`, `viewportCulling`, and `MacOSScrollAccel` exist in the 0.5.11 pin.
Do not assume an `onScroll` JSX prop or browser DOM virtualization library exists for this renderer.
Manual `child.y - scroll.y` is wrong on `ScrollBoxRenderable`: `y` is the box origin, not the scroll offset.

## Subsystem Documents Outside This Catalog

The EOT catalog above is one program. These documents describe subsystems that already shipped, or
decisions that are not part of that program. They are not EOT specs and carry their own status.

| Document                                                                        | Job                                                                                                                  |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Project, directory binding, and copies](project.md)                            | How one server serves many projects and worktrees: directory-bound instances, project identity, git-worktree copies. |
| [TUI package extraction](tui-package.md)                                        | The completed move of the terminal application into `packages/tui`.                                                  |
| [Retire `src/storage/storage.ts`](storage/remove-json-storage.md)               | The completed retirement of the JSON key-value store.                                                                |
| [Effect Drizzle SQLite adapter](storage/effect-sqlite-package.md)               | **Proposed.** Vendor the Drizzle Effect SQLite adapter, then port `src/database/database.ts` onto it.                |
| [Retire the synchronous `Database` wrapper](storage/retire-database-wrapper.md) | **Proposed.** 92 references across 39 files, grouped and sequenced; invariants and count now gated.                  |
| [V2 specifications](v2/README.md)                                               | The v2 contracts, decisions, and working documents, with their own status rule.                                      |

## Existing Plans and Compatibility

At inspection, `specs/` and `docs/architecture/` were empty and no on-disk roadmap was found in `specs`, `docs`, or `.goals`.
Live source comments for TUI extraction, event delivery, cache eviction, request throttling, message virtualization,
plugin v2 selection, and the new llm package now point at this catalog.

`specs/v2/`, `specs/storage/`, `specs/tui-package.md` and `specs/PRODUCT_ROADMAP.md` were deleted in af5546f8c9, a commit
whose message covers only TUI tests. They are restored: 38 source comments cite them, and
`test/cli/command-surface.test.ts` reads `specs/v2/cli-command-surface.md` as a gate, so its loss made that test fail on
HEAD. Those documents record subsystems that **shipped**; the specs in this catalog are **proposed**. They are not
alternatives to each other, and this catalog does not mark the historical documents complete or superseded. Existing
[sync architecture documentation](../docs/sync-architecture.md) remains a reference; recheck implementation details
before changing replay semantics.

| Historical topic                                 | Continuation in this roadmap                                         |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| Runtime/instance R2 and Effect service migration | EOT-02                                                               |
| Dialog lifecycle and cancellation                | EOT-03                                                               |
| Event stream architecture                        | EOT-04                                                               |
| Cache eviction and request throttling            | EOT-05                                                               |
| Message virtualization and streaming churn       | EOT-06                                                               |
| TUI package extraction and startup               | EOT-08                                                               |
| SQL storage consolidation                        | EOT-09                                                               |
| HttpApi encoding, schema reuse, and clients      | EOT-10                                                               |
| CLI command surface (gated inventory)            | [specs/v2/cli-command-surface.md](v2/cli-command-surface.md), EOT-18 |
| Provider streaming and AI SDK adapter            | EOT-11                                                               |
| Identity / auth / onboarding                     | EOT-12                                                               |
| Observability pipeline and tracing               | EOT-13                                                               |
| Plugin v2 contract and hot reload                | EOT-14                                                               |
| Sync snapshots and watermarks                    | EOT-15                                                               |
| Workspace as Effect scope                        | EOT-16                                                               |
| Sandbox and permission architecture              | EOT-17                                                               |
| CLI command architecture and dispatch            | EOT-18                                                               |
| Mobile companion bridge                          | EOT-19                                                               |
| Testing architecture and harnesses               | EOT-20                                                               |

## Open Payloads

This is the policy referenced by `packages/nikcli/AGENTS.md`. Only genuine opaque passthroughs, polymorphic event
payloads, SSE frames, or bodyless redirects qualify; an ordinary domain success object does not. Never introduce
`Schema.Unknown` merely to make response encoding or generated-client validation pass.

The inventory EOT-10 asked for now exists and is enforced: `packages/nikcli/specs/httpapi-open-payloads.json` carries
each declaration with its owner, kind and justification, and `bun run check:open-payloads` (in `script/ci-validate.ts`)
fails on a `Schema.Unknown` under `src/server/httpapi/` that is not listed. 49 sites, 41 entries as of 2026-09-20.

Two properties of that file are load-bearing. It is keyed by **file plus the declaring line's text**, not by line
number — a line number turns every unrelated edit above a listed site into a CI failure, and renumbering an allowlist
is a diff that looks like review and contains none. And `Schema.Record(Schema.String, Schema.Unknown)` is tracked but
is not a violation: the codegen emits `{ [k: string]: unknown }`, a typed record rather than an `any`. See the
Discipline Addendum in `effect-tui/10-contracts-errors-security.md`.

## Observability Schema and Redaction Discipline

EOT-13 owns the canonical span/metric/log schema. The high-level rules are enforced across every spec:

- Spans are stable, lower-cased, dotted, and use `Tracer` directly.
- Span attributes are drawn from a fixed schema; forbidden dimensions include raw prompts, completions, file paths,
  URLs with credentials, tokens, OAuth codes, PKCE verifiers, emails, account ids, IP addresses, and request bodies.
  Prompts may only appear as a stable hash and a length bucket.
- Metric labels share the same forbidden-dimension list; histograms use the Effect default buckets.
- Logs flow through `Log` with structured JSON output and redacted sinks (`safeStringify`, `redactUrl`). Spans
  correlate to logs through `trace_id`/`span_id`.
- The live TUI panel reads from `telemetry-bus` and is rate-limited; it never blocks the input thread.
- OTLP export is opt-in (`OTEL_EXPORTER_OTLP_ENDPOINT`); the live panel is default-on. Redaction is not a
  configurable option.

## Workspace Scope Discipline

EOT-16 owns the canonical workspace model. The high-level rules are enforced across every spec:

- A workspace is a typed Effect scope, not a label on a request.
- Per-workspace mutable state is namespaced by `WorkspaceRef`; cross-workspace leakage is a typed failure.
- Hot switch is a deterministic, cancellable operation; durable background jobs survive, ephemeral resources do not.
- Concurrent workspaces share the process runtime, not the resource scopes.
- Duplicate workspace identity reuses the existing scope; identity mismatch creates a parallel scope.

## Permission, Sandbox, and Policy Discipline

EOT-17 owns the canonical permission/sandbox/policy boundary. The high-level rules are enforced across every spec:

- Every cross-boundary call routes through `Permission.evaluate`; undeclared permission requirements are runtime
  refusals.
- A deny is terminal; a prompt is the default for undeclared operations.
- The sandbox is containment at the OS level (file/path/network restrictions), not cryptographic isolation.
- Network policy routes every outbound HTTP/WS/raw TCP through the runtime `HttpClient`; bypass is a defect.
- Audit logs are redacted; prompts, secrets, file contents, and arbitrary request bodies are never recorded.
- Headless mode fails closed unless every required decision is pre-resolved.
