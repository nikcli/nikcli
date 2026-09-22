# Product roadmap

Prioritize user outcomes through measured evidence gates.

Status: **Proposed** (reconciled 2026-09-10; release-identity discovery was promoted to C3 and implemented 2026-09-09, and its probe was exercised against a real server on 2026-09-10 — the production two-upload window and a real failed-build case on Railway remain outstanding).

This document orders user outcomes, not implementation projects. The current [engineering program](./ROADMAP.md) uses proposed EOT-01 through EOT-20 specs with dependency exit gates.

---

## Interpret historical references

Non-EOT IDs below (including C1-C3, B1, E5, H8, P2/P2.1, E8/E9, S2/S4r, D1-D3, and U4/U6) belong to the earlier engineering plan, not the current EOT phases or IDs. Dated implementation, discovery, and validation statements are retained historical reports, not fresh verification or completion of the proposed EOT program.

The [historical CI contract](./v2/ci-pipeline-runtime-budgets.md) documents C1-C3, including release identity. The earlier roadmap's `verify-before-proceeding` execution record was not located in the inspected checkout; that contract is not a substitute for the missing run evidence.

---

## Apply evidence gates

Every product item moves through three gates:

1. **Baseline** — Instrument the current journey without collecting prompt, source, credential, or other private content.
2. **Target** — Record the expected movement, affected cohort, observation window, and rollback threshold before implementation.
3. **Delivery** — Link the accepted engineering items and verify the outcome after release. Shipping code without measuring the stated outcome does not complete the item.

The roadmap uses horizons rather than dates. `Now` means establish the baseline and remove a proven blocker; `Next` means discovery may run while `Now` is measured; `Later` is a hypothesis, not a release promise.

---

## Follow the sequence

This section preserves the earlier evidence-gated discovery sequence and its historical engineering IDs. For new work, use the current [dependency gates](./ROADMAP.md#prioritized-work-and-dependencies) and [verification requirements](./ROADMAP.md#verification-and-promotion); they do not reconstruct the earlier acceptance records.

A phase only moves to the next when both legs hold: the engineering acceptance gate passes and the product-side measurement window closes without observing the blocked failure mode. Product discovery may audit, define cohorts/events/privacy fields/windows/rollback thresholds, and measure existing behavior; any production instrumentation or behavior change must first be admitted to ROADMAP with an ID and runnable acceptance gate.

---

### Verify release integrity

- **Engineering** - C1 gates every publish; E5, H8, and P2 landed on 2026-08-24. On 2026-09-09 the full validation runner (`script/ci-validate.ts`, the same one CI's `validate` job runs) passed 12 steps of 12, which closes B1 and C2. **C3 landed the same day**: the validated commit is baked into the binary, served on the existing public health response, and confirmed by a bounded probe after the detached upload.
- **Local evidence** - The earlier `verify-before-proceeding` record is unavailable in the inspected checkout; the reported run results below have not been reverified in this review.
- **The probe is proven, not just unit-tested (2026-09-10)** - A compiled binary built from an earlier commit was served locally and probed three ways: matching revision accepted (exit 0), the newer expected commit rejected at the deadline while the older one kept answering (exit 1), and nothing listening rejected (exit 1). The middle case is this brief's **old-healthy-instance** case, staged with a real older binary rather than a fixture.
- **Limits** - Desktop/mobile builds and production deployment were not run. C3 gives the release decision something that can be wrong, and the gate that reads it now works end to end; what it has never done is judge an actual Railway upload.
- **Product** - Release-identity discovery is now promoted and implemented. First-use, continuity, automation, share, and paid-value discovery are recorded below and still admit no implementation or production collection.
- **Phase exit** - Two consecutive approved uploads must match the expected identity, and first-use evidence must cover one release boundary. Neither observation gate is closed, and both now have the instrumentation they need to be run.

---

### Measure the landed cuts

- **Engineering** - P2 closed on 2026-08-24: SQL list work reduced materialization from 2000 to 20 rows and elapsed time from 7.84 ms to 0.73 ms on the seeded request. Hot-poll logging landed; parsed-URL carry-through measured 0.03% of a request and was rejected, with benches not scheduled.
- **Product** - First-use discovery now maps the TUI path and existing `session.error` names. Measuring a cohort still needs an admitted engineering item. Count actionable failures even when successful hot-poll requests are intentionally quiet.
- **Phase exit** — P2.1 is on a loose CI budget, the same seeded request records a lower materialization count and elapsed time than before, and first-use baseline numbers are recorded for the release boundary the slice lands in.

---

### Preserve declared authentication

- **Engineering** - H8 landed on 2026-08-24; do not restart its implementation. Preserve contract-declared security, public endpoint exceptions, open-mode and Tailscale behavior, and authentication exactly once for direct bridge callers.
- **Product** — First-use, continuity, and automation discovery briefs are recorded below. Hot-poll silence under the logging policy still belongs in any later first-use failure taxonomy. No engineering ID is admitted from those briefs.
- **Phase exit** — `/event` and `/session/status` are duration-gated without dropping real failures (**met 2026-08-24**); OpenAPI shows security on protected operations and its absence on public ones; `bun run check:routes` and `bun run generate:httpapi-clients` are clean; first-use baseline reflects the new logging policy.

---

### Explore existing boundaries

- **Engineering** - The 2026-08-26 refill, E8, and E9 are closed. Continuity and automation implementation still wait for an evidenced ROADMAP item.
- **Product** - Continuity and automation discovery briefs below are complete. Each names existing seams and an explicit rejection: no engineering ID from this repository state.
- **Phase exit** - Met for discovery. Measurement windows (continuation success, orphan rates) remain open and uninstrumented.

---

### Promote or archive

- **Engineering** - Admit discoveries only with repository evidence and a runnable acceptance gate. Re-evaluate earlier items when their measurable cohort disappears.
- **Product** — Review Now baselines after hosted validation. Continuity, automation, share, and paid-value discovery each rejected an engineering ID from this repository state. Promote only after an observed gap with a runnable gate; otherwise archive the hypothesis.
- **Phase exit** — Each horizon in the outcome sequence either has a measured movement toward its user promise or has been archived with a written reason; engineering IDs that are not on the path are taken off the active plan.

---

## Prioritize outcomes

| Horizon   | Outcome                                                        | Measure                                                                                                           | Engineering relationship                                                                                                                                                         |
| --------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Now**   | Releases users can trust                                       | Successful validation-to-publish chain, generated-client drift, deploy acceptance and post-deploy health          | C1 guards the publish, C3 the upload: the validated commit is baked, served on health, and confirmed by a bounded probe. What remains is running two approved uploads through it |
| **Now**   | First useful result with less setup friction                   | Install-to-provider-ready completion, time to first successful session turn, failures grouped by actionable cause | Promote only failures observed in installer, auth, provider catalog, or first-turn paths                                                                                         |
| **Next**  | Continue the same session across terminal, desktop, and mobile | Cross-surface continuation success, reconnect failures, state divergence, time to resume                          | Prefer existing HttpApi, event, pending-input, workspace, and SessionV2 seams; do not create a second transport or renderer                                                      |
| **Next**  | Delegate repeatable work with confidence                       | Loop/mission/background-run completion, intervention rate, restart recovery, explicit failure causes              | S4r is landed; discovery now maps reliability gaps across existing Loop, Mission, background-run, and restart seams                                                              |
| **Later** | Share and distribute work safely                               | Share completion, recipient activation, revocation success, deployment/install channel reliability                | Discovery must define trust, ownership, and revocation before changing collaboration or hosted surfaces                                                                          |
| **Later** | Validate sustainable paid value                                | Retention and willingness-to-pay by outcome cohort, support cost, provider-cost envelope                          | No billing architecture enters the engineering roadmap before a priced cohort and measurable entitlement boundary exist                                                          |

---

## Scope discovery

---

### Prove release identity

- **User promise** — A published CLI, desktop artifact, or hosted service corresponds to validated source and does not report success when a required stage was skipped.
- **Current evidence (source, 2026-09-09)** — C1 protects validation and required deployment gates; C2 locally removes the obsolete Effect install from the image. `GET /global/health` is public (`Auth.isPublicPath`) and returns only `{ healthy: true, version }` from `Installation.VERSION` (`packages/nikcli/src/server/httpapi/global.ts`). That version is the compile-time `NIKCLI_VERSION` define (`packages/util/src/version.ts`, `packages/nikcli/script/build.ts`), falling back to `"local"`. No git SHA, image digest, or build time is baked or served. Generated `GlobalHealth` is `{ healthy: true; version: string }` (`packages/sdk/js/src/httpapi/generated/types.ts`). `script/railway-deploy.sh --detach` exits 0 when `railway up` accepts the upload; `.github/workflows/ci-pipeline.yml` records the service name and does not capture a deployment id. Package version therefore cannot distinguish two uploads of the same release from a healthy older instance.
- **Association model** — Expected identity is the git SHA of the commit that passed validate+publish. Build identity is that same SHA baked into the image at compile, not the semver. Observed identity is whatever a later health probe returns after the upload. The link that must exist before code is admitted: SHA → immutable image → Railway service and environment → the detached upload. Today the last three hops are missing from CI output, and the first hop is missing from the binary.
- **Observation window** — One bounded wait for observed identity to equal expected identity. Do not poll forever and do not treat `--detach` success as health. Timeout without a matching probe is a failed release decision, the same class of lie as a detached upload that never built.
- **Mismatch and timeout** — Reject a healthy probe whose revision (once it exists) or version disagrees with the expected SHA/release. Reject an unhealthy probe. Reject timeout. A version match alone is not enough: two uploads of `1.330.0` would both look healthy.
- **Rollback** — This brief does not authorize automatic production rollback. A failed observation fails the release decision; the next upload still needs identity match. Auto-rollback is a later product choice.
- **Contract and privacy** — Health is already public, so a revision in the JSON body is public metadata. An optional additive field would regenerate `GlobalHealth` and is a C1 drift item; a required field is a contract bump. Header-only identity would hide the value from generated clients and from the curl probe operators already use. Store only revision, service, environment, upload/deployment id if Railway exposes one, timestamps, and coarse pass/fail. No tokens, source, prompts, or credentials.
- **Evidence gate** — Record expected vs observed identity for two consecutive separately approved uploads, plus a failed-build case and an old-healthy-instance case. **The old-healthy-instance case is done (2026-09-10)**, against a locally served binary compiled from an earlier commit: the probe reported `still serving a30188cfc7…` twice and then failed the release at the deadline. The unreachable case is done the same way. What is left needs Railway: two consecutive approved uploads, and a real failed build.
- **Historical promotion, 2026-09-09: C3** - The [retained CI contract](./v2/ci-pipeline-runtime-budgets.md#4-what---detach-still-cannot-tell-you) describes the validated commit baked as `NIKCLI_REVISION`, exposed as an optional health-response `revision`, and checked by `script/check-release-identity.ts` after upload. This documents the mechanism, not the missing execution record or completion of the production observation window.
- **Still not admitted** — Production collection and automatic rollback. The two-upload window needs deploy permission and is not run from a checkout; a failed observation fails the release decision, and the next upload still has to match.

---

### Measure first use

- **User promise** — A new user can install Nikcli, connect a provider, open a project, and complete one useful turn with failures that explain the next action.
- **Proposed product events, not in source** — `install_completed`, `provider_configured`, `session_created`, `first_turn_started`, `first_turn_completed`, and `categorized_failure` exist only in this document and an old plan file. They are not runtime events. Do not treat the names as an implementation checklist.
- **Actual first-use path (TUI, 2026-09-09)** — First run is `UserApi.hasUsers(sdk) === false` and `kv.onboarding_complete` is unset (`packages/tui/src/app.tsx`). Onboarding cannot skip account or AI provider (`packages/nikcli/test/tui/onboarding-auth.test.ts`). Steps in `packages/tui/src/component/dialog-onboarding.tsx`: Welcome → Account (`DialogAccountLogin`, device-code OAuth to auth.nikcli-ai.dev) → Filesystem → AI provider → optional Extras / Image / TTS / Remote → Test. After a created account, empty `sync.data.provider` opens `DialogProviderList`. A returning user with no session gets `DialogLogin`. LLM credentials are `PUT /auth/:providerID` (`packages/nikcli/src/server/extra.ts`), separate from the account JWT.
- **Install vs upgrade** — `Installation.Event` is `installation.updated` / `installation.updateAvailable` with a version string (`packages/nikcli/src/installation/index.ts`). `UpgradeFailedError` is an upgrade failure, not first-install completion. Binary install (curl/npm/brew) has no in-app completion event.
- **Session and turn, already on the bus** — `session.created` carries session info (`packages/nikcli/src/session/index.ts`). Turn progress is `session.status` (`idle` / `busy` / `retry`) plus deprecated `session.idle`. Failures publish `session.error` with the assistant-error union in `packages/nikcli/src/session/message-v2.ts`: `ProviderAuthError`, `APIError`, `UnknownError`, `MessageAbortedError`, `MessageOutputLengthError`, `MessageContextOverflowError`, `StructuredOutputError`. Empty catalog after model filter drops the provider (`packages/nikcli/src/provider/provider.ts`). `telemetry.record` is in-process OTLP span capture for the TUI panel, not a funnel (`packages/nikcli/src/observability/telemetry-bus.ts`).
- **Proposed event vs existing signal**

  | Proposed product event | Closest existing signal                               | Enough to measure the promise?               |
  | ---------------------- | ----------------------------------------------------- | -------------------------------------------- |
  | Installation completed | Binary on PATH; upgrade events only                   | No. First install is outside the process.    |
  | Provider configured    | `sync.data.provider.length > 0` after `PUT /auth/:id` | Locally, yes. Not aggregated.                |
  | Session created        | `session.created` bus event                           | Locally, yes. Not a first-use cohort.        |
  | First turn started     | `session.status` → `busy`                             | Locally, yes. No first-turn flag.            |
  | First turn completed   | `session.status` → `idle` without `session.error`     | Locally, yes. Idle is not success.           |
  | Categorized failure    | `session.error` name + onboarding/login error strings | Locally, yes. No elapsed-time or user count. |

- **What can be measured without new instrumentation** — Manual or support-log review of onboarding step, `ProviderAuthError` / `APIError` on first prompt, empty provider list, and OAuth start/poll failures in `DialogAccountLogin`. That cannot rank blockers by affected users or elapsed-time cost.
- **What would need an admitted engineering ID** — Any outbound event, duration timer, or coarse failure code sent off-box. If later admitted, reuse the existing error names above; do not invent a parallel taxonomy. Payload limit remains version, platform, elapsed time, and a coarse code. No prompts, source, credentials, or tokens.
- **Observation window** — One release boundary after hosted B1/C2 validation. Count only TUI first-run (`hasUsers === false`) plus the first session that reaches idle or error. Desktop and mobile login screens exist; they are not this baseline.
- **Promotion rule** — Rank blockers by affected users and elapsed-time cost. Do not turn skippable extras (image/TTS/remote) into architecture work. Do not collect production telemetry until an engineering ID exists. This brief does not admit one.

---

### Check continuity

- **User promise** — A session started on one supported surface resumes on another without transcript loss, duplicate execution, or hidden queued input.
- **Shared protocol (landed)** — One HttpApi, one SessionV2 write path ([session-v2-write-path.md](./v2/session-v2-write-path.md)), one pending table ([durable-pending-input.md](./v2/durable-pending-input.md)), one event feed ([event-stream-architecture.md](./v2/event-stream-architecture.md)). Instance selection is `directory` query or `x-nikcli-directory` (`packages/nikcli/src/server/server-router.ts`). Workspace identity is `wrk_…`; remote workspaces proxy POST via `session-proxy-middleware.ts` and never proxy GET. Do not add a second transport.
- **Surface resume paths (2026-09-09)**

  | Surface                  | How a session is identified                                                                                 | How input is admitted                                                                     | Local extra queue                                                                                    |
  | ------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
  | TUI                      | `sdk.client.session.create({ workspaceID })` then prompt (`packages/tui/src/component/prompt/index.tsx`)    | Generated client `session.prompt` / `delivery: queue\|steer`                              | None beyond `session_pending`                                                                        |
  | Desktop (`packages/app`) | Same generated client; route `/{dir}/session`                                                               | Same HttpApi                                                                              | None beyond `session_pending`                                                                        |
  | Mobile                   | `Session.Service.create` in `packages/nikcli/src/server/mobile/session.ts`; detail rebinds `info.directory` | `sessionMessage` returns `{ accepted: true }` and fires `prompt` / proxied `prompt_async` | `packages/mobile/lib/offline.ts` SecureStore `sendMessage` queue (max 50), separate from SQL pending |

- **Reconnect after graceful restart** — Implemented (S2): `time_suspended` on `session_info`, consumed once at `ServeCommand` start, then `SessionPrompt.loop` from durable history ([session-restart-continuation.md](./v2/session-restart-continuation.md)). Embedded TUI workers do not adopt another process's turn. Hard crash, in-flight provider requests, and non-idempotent tool replay stay out of scope.
- **Hidden queued input** — Server pending rows survive cancel/restart and are visible on TUI cards. Mobile also keeps an offline `sendMessage` queue in SecureStore and infers "queued" user messages from id order vs the in-flight assistant (`packages/mobile/lib/session-queue.ts`). That client queue is not `session_pending`. Duplicate send after reconnect is the failure class to watch; it is not evidenced as a production incident in this repo today.
- **What can be measured without new instrumentation** — Manual resume of one `ses_…` on TUI then desktop then mobile against the same directory; after `nikcli serve` SIGTERM, confirm `time_suspended` consume and loop re-entry (`test/session/restart-continuation.test.ts`). Inspect `session_pending` vs mobile SecureStore after an offline send. No existing event counts continuation success, transcript divergence, or duplicate execution across surfaces.
- **What would need an admitted engineering ID** — Any cross-surface continuation counter, a merge of the mobile offline queue into `session_pending`, or a second protocol. None of those is admitted here.
- **Discovery result** — No repository leftover that admits an engineering ID. The protocol already exists. The only evidenced design tension is mobile's extra offline queue. Rank it only after an observed duplicate or lost send; do not pre-build a sync fabric.
- **Promotion rule** — Reuse generated HttpApi clients and the shared event/session models. Surface-specific presentation stays local. Protocol divergence needs an explicit contract decision. This brief does not admit one.

---

### Assess automation

- **User promise** — Delegated work reports durable progress, survives supported restarts, and fails with enough context for a user to recover.
- **Landed seams (2026-09-09)** — Loop runs persist with `started_runs` nullable (derive once from history, not zero); `MAX_CONCURRENT_RUNS = 3`; lease `15_000` ms; startup `restore()` marks stale `running` as `orphaned` (`packages/nikcli/src/loop/engine.ts`, [loop-engine-contract.md](./v2/loop-engine-contract.md)). Mission exec uses the same status union including `orphaned` and has no FK to the definition so orphan recovery can find surviving work ([mission-orchestrator-contract.md](./v2/mission-orchestrator-contract.md)). Background runs share the 15s lease and `orphaned` finalize (`packages/nikcli/src/background/run.ts`). Graceful session resume is S2; hard-crash replay is an explicit non-goal.
- **Existing signals** — Run/exec status `running | complete | error | timeout | cancelled | orphaned`. Lifetime loop counts are SQL `started_runs`, not trimmed history. Session errors on delegated turns reuse `session.error`. There is no off-box completion or intervention funnel.
- **What can be measured without new instrumentation** — Count `orphaned` vs `complete` vs `error` in local SQL after a graceful restart and after a killed process. That is operator evidence, not a product cohort.
- **Discovery result** — No leftover in the tree that admits an engineering ID. Lease recovery and orphan status already exist. Clustered ownership, fencing, provider-dispatch ambiguity, and tool idempotency are still designed together or not at all. Do not promote "add metrics" or "hard-crash replay" from this brief.
- **Promotion rule** — Use these seams to rank an observed reliability gap. This brief does not admit an item.

---

### Share and distribute work

- **User promise** — A user can share a session, command, or artifact with a defined audience, revoke access, and trust that recipients see the intended snapshot.
- **Landed seam (2026-09-09)** — `ShareNext` (`packages/nikcli/src/share/share-next.ts`, [share-v2-contract.md](./v2/share-v2-contract.md)). Mode is `remote | local`, not a visibility lattice. Remote create POSTs `{ sessionID }` to `enterprise.url` or `https://s.nikcli-ai.dev`, stores `{ id, secret, url }`, then full-syncs. Local fallback needs `baseUrl`. `NIKCLI_DISABLE_SHARE` makes create throw. Public HTTP is GET `/s/:shareID` (308 to `/share/:id`), `/share/:shareID`, `/api/share/:shareID`, `/api/share/:shareID/data` (`packages/nikcli/src/server/httpapi/contract-extra.ts`). `publicData` reads the **local** row only and returns `Data[] | undefined`. `remove` deletes rows (remote DELETE 404 ignored); there is no `removed_at`, `owner_id`, or write-time redaction in this module.
- **Proposed product events, not in source** — Share created, recipient opened, access revoked, share failed. Those names are not runtime events. Closest signals: SQL `session_share` / `local_share` rows, remote HTTP success/failure logs, `NIKCLI_DISABLE_SHARE`.
- **Trust / ownership / revocation gaps (discovery, not a backlog)** — No audience class. No recipient identity. Public read does not consult mode or owner. Revocation is delete, not a tombstone recipients can observe. Payload privacy is whatever `payload()` included. Recipient activation cannot be counted from this repo.
- **What can be measured without new instrumentation** — Manual create → open URL → remove on one session, local and remote. That cannot rank share completion, recipient activation, or revocation success.
- **Discovery result** — The share protocol exists. Trust, ownership, and revocation are not defined enough to admit collaboration or hosted-surface work. Do not add billing, a visibility enum, or a second share service from this brief.
- **Promotion rule** — Define trust, ownership, and revocation before changing collaboration or hosted surfaces. This brief does not admit an engineering ID. Horizon stays Later until first-use and release-identity windows exist.

---

### Validate paid value

- **User promise** — A paying user can name the outcome they bought and keep receiving it without surprise cost or support burden.
- **Current evidence (2026-09-09)** — `packages/nikcli` has no billing, entitlement, or subscription service. Identity rate limits (`packages/identity/src/constants.ts`) are anti-abuse windows, not paid quotas. Inference notes Stripe as declared but unused and customer billing UI as out of scope (`packages/inference/AGENTS.md`). Provider `insufficient_quota` is an upstream API error, not an nikcli entitlement.
- **Proposed measures, not in source** — Retention by first-use cohort, willingness-to-pay, support tickets per active user, provider-cost envelope per successful turn. None of these are collected here.
- **Discovery result** — No priced cohort and no measurable entitlement boundary exist in this repository. Billing architecture would be a wish-list refill.
- **Promotion rule** — No billing architecture, entitlement service, or metering pipeline enters ROADMAP before a priced cohort and a measurable entitlement boundary exist. This brief does not admit an item. Horizon stays Later.

---

## Remaining sequence

Order, with what is left of each:

1. ~~`ci-validate.ts` for B1/C2.~~ **Done 2026-09-09** — 12 of 12 steps green; B1 and C2 are closed.
2. ~~Give the release decision an identity it can be wrong about.~~ **Done 2026-09-09** as C3, the one ROADMAP ID promoted out of these briefs.
3. Two approved uploads against [release identity](#prove-release-identity), plus a real failed build. **Needs deploy permission** — this is the open item, and it is an operator action, not more code. The old-healthy-instance and unreachable cases were closed locally on 2026-09-10, so what remains is Railway-side only.
4. Optional operator observation of first-use, continuation, and orphan rates from existing logs/SQL — not production telemetry.
5. Share and paid-value stay Later until those windows exist and a priced cohort / share trust model is evidenced outside this brief.

Discovery for Now / Next / Later horizons is complete. Everything implementable from this repository state is implemented; (3) waits on a deploy, and the remaining horizons wait on an observed gap with a runnable gate.

**Engineering-side state, 2026-09-10.** Every contract in `specs/v2/` is Accepted and implemented with its invariants pinned (ROADMAP D1/D2), the suite is green end to end for the first time — 392 files, 4157 pass, 0 fail — after two long-carried failures turned out to be real bugs (D3), and the last open dependency note from U4 is closed (U6). None of that moves a product measurement; it means a product item that gets promoted from here starts against a repository with no known-red test and no undocumented contract.

---

## Review at release

At release boundaries, record each outcome's baseline window, target, observed result, and linked engineering IDs. Archive an item when evidence rejects the user problem rather than keeping unowned later work.
