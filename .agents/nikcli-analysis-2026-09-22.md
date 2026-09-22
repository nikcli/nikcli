# nikcli — Repository Analysis

Baseline: 2026-09-22. Scope: the whole monorepo (`/Volumes/SSD/Projects/nikcli`). Source-of-truth files cross-checked:
`AGENTS.md`, `package.json`, `packages/nikcli/package.json`, `specs/README.md`, `specs/ROADMAP.md`,
`script/ci-validate.ts` (via three parallel explore tasks). Three classifications are used:

- **active** — has shipped code that matters today;
- **dormant** — present but unused / not on a hot path;
- **reference-only** — historical / design doc, not a runtime dependency.

Every recommendation below carries a tier (1 = must, 2 = should, 3 = nice, 4 = someday) and a one-line
fix-or-leave note per the user-habit preference.

---

## 1. Inventory snapshot

| Area                                                | Count                                              | Source                         |
| --------------------------------------------------- | -------------------------------------------------- | ------------------------------ |
| Workspace packages                                  | 39 in `packages/*` (+5 console sub-pkgs)           | `glob packages/*/package.json` |
| GitHub workflow files                               | 45                                                 | `.github/workflows/`           |
| Top-level `script/` files                           | 28                                                 | `script/` listing              |
| `specs/` documents                                  | 20 EOT specs + 4 docs + v2/storage subdirs         | `specs/README.md` catalog      |
| HttpApi groups (nikcli)                             | 26 + contract-only extras                          | explore task 2                 |
| Test files (nikcli)                                 | ~487                                               | explore task 2 (test layout)   |
| Active CI workflows in `test.yml`+`ci-pipeline.yml` | excluded nikcli suite, kept Windows+typecheck+lint | AGENTS.md                      |
| Bun version                                         | 1.4.2                                              | root `package.json`            |
| Cataloged version pins                              | 39 entries in root catalog                         | root `package.json:34-74`      |
| Patched deps                                        | 9                                                  | root `package.json:127-137`    |
| Top-level root docs                                 | ~12 `.md` files + 4 deployment configs             | root listing                   |

---

## 2. The 10 most-load-bearing facts about nikcli

1. **Single source of HTTP truth.** `packages/nikcli/src/server/httpapi/*` is the contract authority; no Hono,
   no hey-api, no v2 SDK. Both OpenAPI spec and generated clients (consumed as `@nikcli-ai/sdk/httpapi`)
   derive from it. Drift is a blocking CI gate (`check:routes`, generated-client diff). Active.
2. **Architecture program is the only "big plan".** Twenty EOT specs (EOT-01..20) scope the work, three horizons,
   every spec is `proposed` even when it has landed slices. P0 just closed on 2026-09-20 (perf-baseline gate).
   Active / reference-only at the slice level.
3. **CI does NOT run the full nikcli suite.** ~487 tests \* 80 MB leak per file = 14.5 GB; the runner OOMs at
   file 175. The whole suite runs locally via `bun run test:ci` (sharded, per-file isolation). This is
   non-negotiable per AGENTS.md. Active decision.
4. **Open-payload allowlist is gated.** 49 sites, 41 entries as of 2026-09-20, keyed by file + declaration text
   (not line number — line-number keys die on every unrelated edit). Active enforcement (`check:open-payloads`).
5. **Generated clients are blocking.** Drift in the generated tree fails the validate step, formatting/lint too.
   No advisory knobs in this pipeline. Active.
6. **Bridge protocol is the typed seam.** One contract per direction (CLI / TUI / SDK / mobile / companion / remote).
   Capability gating is part of the contract. JWT-verified. Single most-tested architectural surface in the spec
   catalogue (EOT-19 slices lead the most recent work). Active.
7. **Two auth planes coexist.** Provider credentials (OpenAI, Anthropic, etc.) are unrelated to nikcli account
   auth, which is device-code / passkey / PKCE. The recent EOT-12 work turned the second into a typed state
   machine. Active.
8. **Effect + OpenTUI pins are deliberate.** `@opentui/core` 0.5.11 (released 2026-09-11), Solid 1.9.12,
   Effect via local pin in `packages/nikcli/node_modules/effect/AGENTS.md`. Pin matters: B01 in the spec
   catalogue documents that the prior 0.5.10 streaming patch was dropped because 0.5.11 already does the
   right thing. Active.
9. **Yargs → custom CLI parser migration landed.** EOT-18's parser premise is gone; `specs/cli-framework.md`
   describes what replaced it. Active.
10. **A `--detach` Railway deploy reports success before it has built anything.** Guards in place
    (`check-railway-context.ts`, `check-docker-versions.ts`, `script/railway-deploy.sh` preflight) — keep them
    wired into `ci-validate.ts`. Active trapdoor.

---

## 3. Per-item table (active / dormant / reference-only)

### 3.1 Top-level (`/`)

| Item                                                                                                      | Status         | Note                                                                                                                                                                                                        | Tier / fix-or-leave                                                                |
| --------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `AGENTS.md` (root)                                                                                        | must-read      | Highest-priority orientation; lists rules AGENTS must follow. **Stale on one fact: lists `packages/studio` which doesn't exist** (explore task 3 caught this).                                              | Tier 1 — fix the stale package name in the monorepo list.                          |
| `specs/` (20 EOT specs + 4 docs)                                                                          | active         | Implementation program; EOT-01..20 with deps, gates, slices, landed-work table.                                                                                                                             | Tier 1 — leave; ensure `check:spec-commit-refs` and `check:spec-paths` stay green. |
| `script/ci-validate.ts`                                                                                   | active         | CI orchestrator. Regenerates clients, checks open-payloads, runs route coverage, perf-baseline, network-egress, flag-capture, workspace-isolation, plugin-v2, observability-schema, spec paths/commit refs. | Tier 1 — leave; do not weaken signals.                                             |
| `Dockerfile`, `Dockerfile.serve`, `docker-compose.serve.yml`, `railway.toml`, `fly.toml`, `sst.config.ts` | active         | Multiple deploy surfaces. Railway has the documented detach-success trapdoor.                                                                                                                               | Tier 1 — keep `check-docker-versions.ts` wired.                                    |
| `nix/`, `flake.nix`, `flake.lock`                                                                         | active         | Nix packaging. `update-nix-hashes.yml` keeps it fresh.                                                                                                                                                      | Tier 3 — leave.                                                                    |
| `install`, `install.ps1`                                                                                  | active         | Bootstrap installers.                                                                                                                                                                                       | Tier 3 — leave.                                                                    |
| `.github/workflows/` (45 files)                                                                           | active         | Includes `ci-pipeline.yml`, `test.yml` (excludes nikcli suite), `windows-compat.yml` (4 targeted suites), `typecheck.yml`.                                                                                  | Tier 1 — never add the nikcli suite back.                                          |
| `patches/` (9 patched deps)                                                                               | active         | Bun-patchedDependencies for `@opentui/core`, `@ff-labs/fff-bun`, `@modelcontextprotocol/sdk`, etc.                                                                                                          | Tier 1 — leave; review on upstream bumps.                                          |
| `themes/`, `memory/`, `artifacts/`, `logs/`, `tmp/`                                                       | dormant        | Runtime data dirs / dev artifacts.                                                                                                                                                                          | Tier 4 — leave; check `.gitignore` discipline.                                     |
| `homebrew-tap/`                                                                                           | reference-only | External tap, not built from here.                                                                                                                                                                          | Tier 4 — leave.                                                                    |
| `github/`                                                                                                 | reference-only | GitHub-app workspace package, listed in root `workspaces.packages`.                                                                                                                                         | Tier 4 — leave.                                                                    |
| `infra/`, `.sst/`                                                                                         | dormant        | SST stacks; not part of CI hot path.                                                                                                                                                                        | Tier 3 — leave.                                                                    |
| `STATS.md`, `STYLE_GUIDE.md`, `SPEAK_SETUP.md`, `SECURITY.md`, `CHANGELOG.md`, `ai-sdk-updates.md`        | reference-only | Project meta-docs.                                                                                                                                                                                          | Tier 4 — leave.                                                                    |
| Root `bun.lock`                                                                                           | active         | Bun 1.4.2 lockfile.                                                                                                                                                                                         | Tier 1 — leave.                                                                    |
| Root `turbo.json`                                                                                         | active         | Turbo pipelines; `typecheck` runs `--concurrency=1`.                                                                                                                                                        | Tier 1 — leave.                                                                    |
| Root `oxlintrc.json` + `packages/nikcli/oxlint.slop.config.ts`                                            | active         | Two lint configs (default + "slop" detector).                                                                                                                                                               | Tier 1 — leave.                                                                    |

### 3.2 Workspace packages (`packages/*`)

39 packages; only the non-obvious ones get a row. (Naming conventions: `packages/{area}` is current; legacy
`packages/console/*` predates the flat layout.)

| Package                                                                       | Status                 | Note                                                                                                                   | Tier / fix-or-leave                                                                               |
| ----------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `nikcli`                                                                      | active (core)          | CLI + server + TUI host. ~487 tests. `bin/nikcli` entry.                                                               | Tier 1 — leave.                                                                                   |
| `tui`                                                                         | active (core)          | Extracted TUI; Sibling workspace, not bundled into nikcli binary. Renderer pinned 45 FPS.                              | Tier 1 — leave.                                                                                   |
| `sdk`, `sdk-next`                                                             | active                 | Two SDK generations; the `js/` subdir regenerates from HttpApi contract.                                               | Tier 1 — leave; `sdk-next` looks like a parallel track — verify it's not duplicating `sdk`.       |
| `plugin`                                                                      | active                 | v1 + v2 contracts (`src/v2/{effect,promise,tui}/`). v2 gate enforced in CI.                                            | Tier 1 — leave.                                                                                   |
| `auth`                                                                        | active                 | EOT-12 typed state machine lives here.                                                                                 | Tier 1 — leave.                                                                                   |
| `identity`                                                                    | active                 | Cloudflare Workers identity service (PKCE, device-code, passkey, rate-limit).                                          | Tier 1 — leave.                                                                                   |
| `llm`                                                                         | active                 | New package owning `LLMEvent`/`LLMRequest` and route composition.                                                      | Tier 1 — leave; EOT-11 migration still open.                                                      |
| `companion`                                                                   | active                 | Cloudflare Workers + UI; consumes the bridge.                                                                          | Tier 1 — leave.                                                                                   |
| `remote`                                                                      | active                 | Tunneled proxy + UI; shares bridge with companion.                                                                     | Tier 1 — leave.                                                                                   |
| `mobile`                                                                      | active                 | Expo mobile companion (`bunx expo run:ios --device Nikoemme --configuration Release --no-bundler` per AGENTS.md).      | Tier 1 — leave.                                                                                   |
| `web`, `app`, `desktop`                                                       | active                 | Web/webgui/desktop front-ends.                                                                                         | Tier 1 — leave.                                                                                   |
| `slack`, `discord`                                                            | active                 | Slack bolt + Discord connectors.                                                                                       | Tier 2 — leave.                                                                                   |
| `cloud`, `enterprise`                                                         | active                 | Cloud + enterprise offerings.                                                                                          | Tier 2 — leave.                                                                                   |
| `ade`, `function`, `script`, `simulation`, `inference`, `inference-dashboard` | active                 | AutoDev, serverless function runtime, scripts, simulation, inference + dashboard.                                      | Tier 2 — leave.                                                                                   |
| `voice`                                                                       | active                 | Voice transcription (`Whisper` via OpenRouter).                                                                        | Tier 3 — leave.                                                                                   |
| `browser-control`, `terminal-control`, `computer-use`                         | active                 | Headless tools.                                                                                                        | Tier 2 — leave.                                                                                   |
| `http-recorder`, `httpapi-codegen`                                            | active                 | HTTP plumbing.                                                                                                         | Tier 2 — leave.                                                                                   |
| `nikcli-island`, `webrenderer`                                                | active                 | UI islands + WebGPU renderer.                                                                                          | Tier 3 — leave.                                                                                   |
| `tui-math`, `tui-image`, `tui-storybook`, `bench-tui`                         | active                 | TUI primitives + benchmarks + Storybook.                                                                               | Tier 2 — leave.                                                                                   |
| `util`, `ui`                                                                  | active                 | Cross-cutting helpers + shared UI components.                                                                          | Tier 2 — leave.                                                                                   |
| `console/{app,core,function,mail,resource}`                                   | active (legacy layout) | Pre-flat-layout leftover, still listed under workspaces `packages/console/*`.                                          | Tier 2 — verify they're still imported; consider migrating to top-level or documenting the split. |
| `packages/console/packages/`                                                  | dormant                | Accidental nested duplicate of console packages — explore task 3 flagged it. **NOT picked up by the workspaces glob.** | Tier 1 — clean up. Either delete or wire into workspaces.                                         |
| (missing) `packages/studio`                                                   | reference-only         | Root `AGENTS.md` mentions it; it doesn't exist.                                                                        | Tier 1 — update `AGENTS.md` to match reality.                                                     |

### 3.3 CI / workflows (45 total)

| Workflow                                                                                                                                | Status        | Note                                                                                         | Tier / fix-or-leave                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `ci-pipeline.yml`, `test.yml`                                                                                                           | active (must) | Typecheck + lint + targeted tests. Excludes full nikcli suite by design.                     | Tier 1 — leave; never add nikcli suite back. |
| `windows-compat.yml`                                                                                                                    | active        | Runs 4 targeted suites (double-esc, session, config+worktree, util) on real Windows in ~40s. | Tier 1 — leave.                              |
| `ci-check.yml`, `typecheck.yml`, `lint`, `format`                                                                                       | active        | Blocking validation.                                                                         | Tier 1 — leave.                              |
| `publish.yml`, `release-*.yml`, `desktop-release.yml`, `mobile-ios.yml`, `mobile-android.yml`, `ade-release.yml`                        | active        | Release pipelines. Every publish path runs validation.                                       | Tier 1 — leave.                              |
| `deploy.yml`, `containers.yml`                                                                                                          | active        | Container / Docker deploys.                                                                  | Tier 1 — leave.                              |
| `security.yml`, `compliance-close.yml`, `gitleaks`                                                                                      | active        | Security automation.                                                                         | Tier 1 — leave.                              |
| `docs-update.yml`, `docs-locale-sync.yml`, `web-version-check.yml`, `storybook.yml`                                                     | active        | Docs + web/storybook sync.                                                                   | Tier 2 — leave.                              |
| `auto-fix`, `pr-management`, `pr-standards`, `triage`, `close-issues`, `close-stale-prs`, `stale-issues`, `duplicate-issues`, `labeler` | active        | Repo automation.                                                                             | Tier 2 — leave.                              |
| `ade-auto-release.yml`, `ade-checks.yml`, `ade-macos.yml`                                                                               | active        | ADE-specific.                                                                                | Tier 3 — leave.                              |
| `sync-zed-extension.yml`, `publish-vscode.yml`, `publish-github-action.yml`                                                             | active        | Extension publishing.                                                                        | Tier 3 — leave.                              |
| `beta.yml`, `notify-discord.yml`, `stats.yml`, `update-nix-hashes.yml`, `nix-eval.yml`, `review.yml`                                    | active        | Misc.                                                                                        | Tier 3 — leave.                              |

### 3.4 `script/` (28 files)

Top non-obvious ones (full inventory in `script/` directory listing):

| Script                                                                                                           | Status        | Note                                                         | Tier / fix-or-leave |
| ---------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------ | ------------------- |
| `ci-validate.ts`                                                                                                 | active (must) | Orchestrator. Drives every check script listed below.        | Tier 1 — leave.     |
| `generate-httpapi-clients.ts` (in nikcli pkg)                                                                    | active        | Regenerates SDK from contract.                               | Tier 1 — leave.     |
| `check-route-coverage.ts`                                                                                        | active        | `--strict` flag read from argv; same rules as default today. | Tier 1 — leave.     |
| `check-open-payloads.ts`                                                                                         | active        | Forbids a new `Schema.Unknown` not in the allowlist.         | Tier 1 — leave.     |
| `check-account-required.ts`, `check-flag-capture.ts`                                                             | active        | Auth surface guards.                                         | Tier 1 — leave.     |
| `check-observability-schema.ts`, `check-network-egress.ts`, `check-workspace-isolation.ts`, `check-plugin-v2.ts` | active        | Spec gates.                                                  | Tier 1 — leave.     |
| `check-spec-commit-refs.ts`, `check-spec-paths.ts`                                                               | active        | Spec rot guards (non-blocking).                              | Tier 2 — leave.     |
| `check-perf-baseline.ts`                                                                                         | active        | P0 closure gate.                                             | Tier 1 — leave.     |
| `check-docker-versions.ts`, `check-railway-context.ts`, `railway-deploy.sh`                                      | active        | Detach-success trapdoor guards.                              | Tier 1 — leave.     |
| `perf-baseline.ts`, `tui-startup.ts`, `tui-smoke.ts`                                                             | active        | Measurement probes.                                          | Tier 2 — leave.     |
| `ci-check-workflows.ts`, `ci-report-failure.ts`, `ci-autofix.ts`                                                 | active        | CI plumbing.                                                 | Tier 2 — leave.     |
| `release/*`, `release-github.ts`, `publish-*`                                                                    | active        | Release flow.                                                | Tier 1 — leave.     |
| `seed-e2e.ts`, `run-headless.ts`, `schema.ts`, `format.ts`, `stats.ts`                                           | active        | Dev helpers.                                                 | Tier 3 — leave.     |

---

## 4. Architectural observations

These are the structural reads that the per-item inventory hides.

1. **The monorepo is bigger than its `AGENTS.md`.** 39 packages, not 6. The root doc lists the core 6; everything
   else (slack, discord, voice, mobile, cloud, enterprise, etc.) is invisible at the top level. **Tier 1**: update
   `AGENTS.md` to either enumerate them or link to a fuller inventory.
2. **The contract authority is unusually disciplined.** The drift between `packages/nikcli/src/server/httpapi/*`
   and the generated `@nikcli-ai/sdk/httpapi` client is CI-blocking, and the open-payload allowlist is keyed on
   declaration text rather than line number. The latter is a small but high-leverage detail: line-number keys
   die on every unrelated edit above a listed site. **Tier 1**: leave as-is, document the "why text-keyed" rule
   so future contributors don't "fix" it back to line numbers.
3. **CI deliberately excludes the full nikcli suite, but the discipline isn't documented outside AGENTS.md.**
   Anyone new to the repo will read `test.yml`, see no nikcli tests, and try to add them. **Tier 1**: cross-link
   the rationale from `ci-pipeline.yml` (or a workflow README).
4. **The TUI is a sibling workspace, not bundled.** This is correct architecturally but creates a startup path
   (`packages/tui/src/host/standalone.ts`) that owns its own config reload and lifecycle. **Tier 2**: keep both
   `standalone` and `compiled` smoke tests green (`smoke:standalone` in `tui`, `smoke:tui` in `nikcli`).
5. **Two SDKs exist (`sdk`, `sdk-next`).** The `AGENTS.md` claim that the old `v2` client is gone conflicts with
   the presence of `sdk-next` on disk. **Tier 1**: confirm whether `sdk-next` is a forward track or a parallel
   experiment; align docs and package scripts.
6. **The CLI command parser migration (EOT-18) shipped without its policy.** Spec says "exit-code mapping,
   headless posture, daemon lifecycle" remain open even though the parser premise is gone. **Tier 2**: that
   work belongs on someone's roadmap, not in limbo.
7. **Recent slices show a clear theme: tests fail-flaky, root cause is a defect.** The 2026-09-20 landed-work
   rows call out three cases where a red test mode was diagnosing a real bug (Flag constant captured at import,
   an `npx` with no deadline, a `BYTE_BUDGET` slice that would have disconnected every healthy long-lived
   session). **Tier 1**: keep the discipline of bisecting before retrying — this is a process observation, but
   it's load-bearing for code health.
8. **A intermittent never-paints startup is observed (1 in 3-8 runs).** Root cause investigation in
   `specs/ROADMAP.md` (P0 closure section) narrows it to `@opentui/core` terminal capability negotiation
   blocking on replies. **Tier 1**: fix before ratifying any perf baseline. A budget over a flaky run certifies
   a flaky binary.

---

## 5. Recommendation tiers

### Tier 1 (must — do before anything else)

- Fix root `AGENTS.md` package list: drop `packages/studio`, add the actual 39 packages or link to a full inventory.
- Investigate `packages/console/packages/` — looks like a stale nested duplicate not in workspaces glob. Either
  delete or wire into `workspaces.packages`.
- Confirm whether `packages/sdk-next` is the forward track or parallel experiment; align docs.
- Investigate the intermittent never-paints startup before ratifying any performance baseline.
- Keep the discipline: never add the nikcli test suite back to CI; never weaken CI signals by skipping,
  quarantining, or marking steps `critical: false` to hide failures.

### Tier 2 (should — this quarter)

- Document the "open-payload allowlist keyed by declaration text, not line number" rule so contributors don't
  "fix" it back.
- Cross-link the "why CI excludes the nikcli suite" rationale from `ci-pipeline.yml` or a workflow README.
- Pick up EOT-18's remaining policy work (exit-code mapping, headless posture, daemon lifecycle).
- Verify `smoke:standalone` (TUI) and `smoke:tui` (nikcli) both stay green on the compiled binary.

### Tier 3 (nice — opportunistic)

- Migrate the `packages/console/*` legacy layout into the flat `packages/*` namespace (only if it's
  actually still imported anywhere — verify first).
- Wire `packages/ade`, `inference`, `simulation` into a higher-level overview doc so they show up in the
  architectural picture.
- Consolidate the four deployment surfaces (Dockerfile, Dockerfile.serve, railway.toml, fly.toml, sst.config.ts)
  behind a single deployment doc — they currently duplicate context.

### Tier 4 (someday — defer)

- Retire `themes/`, `memory/`, `artifacts/`, `logs/`, `tmp/` only if `.gitignore` discipline slips.
- Reconsider `homebrew-tap/` ownership (lives in this repo but isn't actually built here).

---

## 6. Verification gates (what to run before/after any change)

From the spec roadmap's "Verification and Promotion" table — preserved here as the canonical
checklist:

| Surface            | Required evidence                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Runtime/service    | `packages/nikcli/test/effect` + changed domain tests; interruption + finalizer assertions               |
| TUI lifecycle      | `packages/nikcli/test/tui`, real OpenTUI frame assertions, PTY if behavior changes                      |
| HTTP contract      | `bun run generate:httpapi-clients` (packages/nikcli), `bun run check:routes`, server/client tests       |
| Bridge             | Round-trip + capability gating + watermark/snapshot barrier                                             |
| Identity/auth      | State-machine matrix + controlled local issuer; redaction; no skipped onboarding                        |
| Observability      | Schema-validated spans/metrics/logs; redaction fuzz; bounded live panel; OTLP smoke                     |
| Plugin v2          | Manifest validation; capability denial; reload concurrency; storage scoping; v1 coexistence             |
| Workspace/sync     | Concurrent isolation; hot switch determinism; multi-device ordering                                     |
| CLI host/startup   | `bun run smoke:standalone` in `packages/tui`; `bun run smoke:tui` + compiled probe in `packages/nikcli` |
| Mobile/companion   | JWT round-trip; websocket reconnect; PTY bounded; multi-device ordering                                 |
| Sandbox/permission | Coupling respected; sandbox containment; headless posture fail-closed                                   |
| Any slice          | Root `bun run typecheck` (serialized), affected format/lint checks                                      |
| Release            | Local `bun run test:ci` in `packages/nikcli`, smokes, existing CI remains blocking                      |

**Hard rule:** never run root `bun test` — root script intentionally fails. Never repeat typecheck runs on
low-memory machines. A passing typecheck is not proof of cancellation, replay, focus, identity, observability,
or bridge correctness.

---

## 7. Where this analysis came from

- Root `AGENTS.md` (must-read orientation, with the stale `packages/studio` reference).
- Root `package.json` (Bun 1.4.2, catalog of 39 pins, 9 patched deps).
- `packages/nikcli/package.json` (37 explicit check:\* scripts wired through `ci-validate.ts`).
- `specs/README.md` (20-spec catalog + 40 evidence rows) and `specs/ROADMAP.md` (3 horizons, 41 landed slices).
- Three parallel `explore` agent runs: monorepo inventory, nikcli internals, secondary packages.
- `script/` listing (28 scripts) and `.github/workflows/` listing (45 workflows).

---

_End of analysis — written to disk per project convention; this file lives at
`.agents/nikcli-analysis-2026-09-22.md`._
