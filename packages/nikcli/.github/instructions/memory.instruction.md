# Nikcli Project Memory

**Last updated**: 2026-08-24 (Brain pass; absorbed E5/H8/P2/C1/S4r landings + storage deletion + verified OAuth work + monorepo audit)

## Start Here

nikcli is an AI coding-agent runtime and OpenCode fork maintained by `nikomatt69`. It uses Bun 1.4.2, Effect 4 HttpApi, Solid/OpenTUI, Vercel AI SDK, SQLite/Drizzle, and an ongoing Effect 4 service migration. The main package is `packages/nikcli`. **Version 1.313.0** at the time of this pass.

- The default branch is **`live-main`** (both `AGENTS.md` files now agree).
- Root workspaces: `packages/*`, `packages/console/*`, `packages/remote`, `packages/sdk/js`, `packages/slack`, `github`. 41 packages total; key ones are `nikcli`, `sdk`, `tui`, `mobile`, `desktop`, `web`, `app`, `plugin`, `remote`, `companion`, `identity`, `auth`, `llm`, `inference`, `simulation`, `chatbot` (in-nikcli), `tui-image`, `terminal-control`, `httpapi-codegen`. Top-level apps: `app` (webgui), `web`, `desktop`.
- Use Bun only. From root: `bun turbo typecheck --concurrency=1`. From `packages/nikcli`: `bun run typecheck`, `bun test`, `bun run build`, `bun run lint`, `bun run format:check`, `bun run generate:httpapi-clients`, `bun run check:routes` (with `--strict` honored as of 2026-08-17).
- Lint/format: `bunx oxlint` / `bunx oxlint --fix`, `bunx prettier` / `bunx prettier --check` (oxfmt 0.56.0, oxlint 1.79.0); `pretest` runs `format:check lint` in parallel.
- Do not echo secrets: repo-root `nikcli.json` contains a real `nkm_*` bearer token. Treat it as sensitive.

**Package scale (2026-07-28 audit)**: 792 TS source files (~204k lines), 277 test files (~46k lines), 105 direct deps. Largest areas: `cli` 77k, `server` 27k, `session` 15k, `tool` 11k. Top 6 modules = ~43% of all code (power-law).

**Skills & docs**: A 959-line skill lives at `/Volumes/SSD/Projects/nikcli/.nikcli/skill/nikcli-skill/SKILL.md` covering quick reference, architecture, tools, server API, MCP, plugins, CLI, debugging, code examples, and best practices.

## Core Architecture

- `bin/nikcli:8` resolves the platform binary; dev runs `src/index.ts` (package.json:25). `src/index.ts:74` builds the yargs command graph; default command is `TuiThreadCommand` at `src/cli/cmd/tui/thread.ts:151`.
- TUI default flow: parent process spawns an isolated worker (`thread.ts:183`); worker hosts `Server.App` via `Rpc.listen(rpc)` at `src/cli/cmd/tui/worker.ts:116`, keeping domain/server state off the OpenTUI render thread. UI mounts at `app.tsx:113`; `SDKProvider` at `app.tsx:162` is the principal backend boundary.
- Default TUI uses direct worker RPC; `--port`/`--hostname` enables real HTTP; `nikcli attach` (attach.ts:3) uses a remote server without a worker; `nikcli serve` (cmd/serve.ts:73) is the headless path.
- TUI package extracted to `packages/tui` (U1, landed 2026-08-16). `@nikcli-ai/tui` has no `@/` imports and no `nikcli-ai` dependency on `packages/nikcli`; its tsconfig does not reference `packages/nikcli`. `packages/nikcli/src/cli/cmd/tui/` keeps four host files (`thread.ts`, `worker.ts`, `attach.ts`, `plugin/host-local.ts`) so the literal `./src/cli/cmd/tui/worker.ts` in the build scripts stays correct.
- The production agent loop is `SessionPrompt.loop()` (src/session/prompt.ts:686, ~2,538 lines). `SessionProcessor` (src/session/processor.ts:156) translates stream events into message parts, tool states, retries, snapshots, and bus updates.
- Sessions persist through v1 `Session`/`MessageV2` via `Session.Service` (src/session/index.ts:841, Effect layer at :885). `src/session/v2/` is the v2 entry/write projection; S4 (2026-08-14) inverted create/prompt and S4r (2026-08-23) extended the inversion to import/teleport/run — both write through `SessionV2`/`SessionV2Write.persist` first, with v1 as `toV1*` of those rows.
- Tools use `Tool.define()` (src/tool/tool.ts:122) and return `{ title, metadata, output, attachments? }`. Validation is Zod; the wrapper converts Promise/Effect implementations, applies truncation (2,000 lines / 50 KB), and supports `ctx.ask()` permissions. T2 (2026-08-14) added optional `output` zod codecs — tools that emit JSON declare a codec and return `value`; Code Mode receives `Tool.encoded(result, codec)`. Truncation still bounds only `output`. T3 (later) extends codecs to built-ins.
- `ToolRegistry.Service` (src/tool/registry.ts:199, :289) combines built-ins, feature flags, plugins, and opt-in pinned custom tools. T1 (2026-08-14) made registration an overlay stack: config-dir and plugin tools live in a reloadable derived cache, runtime registrations live in a separate non-reloadable cache. `resolveTools` (src/session/tools.ts:194) adds permissions, deadlines, session metadata, AI SDK adapters.
- `Provider.Service` (src/provider/provider.ts:1250; Effect impl at :2078) owns per-instance provider/model/SDK caches. `LLM.stream` (src/session/llm.ts:254, :479) picks native `@nikcli-ai/llm` or AI SDK fallback.
- Server is Effect HttpApi on Bun.serve (src/server/) with REST, SSE, WebSockets, OpenAPI, and workspace-aware request context. TUI/server communication uses generated `@nikcli-ai/sdk/httpapi`. **Hono and `NIKCLI_EXPERIMENTAL_HTTPAPI` are gone from `src/`** (post-H7 2026-08-20, post-H4 2026-08-17).
- Per-request flow: `ServerRouter` (src/server/server-router.ts) parses one URL and applies body limit, CORS, auth (via `Auth.authenticate`), workspace + directory resolution, then dispatches to the HttpApi bridge or raw handlers. `HttpApiBridge.handle` (src/server/httpapi/bridge.ts:328) uses `implementedRoutes` derived from `OpenApi.fromApi(PublicApi)`.

## Effect Migration Status

Substantial at the service-definition layer: session, provider, tools, permissions, question, config, agent, plugin, database, MCP, file, sync, worktree, account, auth, mission, loop, brain expose `Context.Service` interfaces. 265 files import Effect.

- Shared infrastructure: `ManagedRuntime`, shared layer memoization, observability, redirected Effect logging in `src/effect/runtime.ts:7`; per-directory scoped caches in `src/effect/instance-state.ts:31`.
- Instance context is dual-stack: `InstanceRef`/`WorkspaceRef` (src/effect/instance-ref.ts:14) provide fiber-local context, but `InstanceState.context` falls back to legacy ambient `Instance` (src/effect/instance-state.ts:5). `withInstanceAsync` (src/effect/with-instance.ts:30) is an explicit compatibility adapter. R1 (later) replaces with a keyed scoped instance runtime after lifecycle coverage lands.
- HTTP migration is done: H7 (2026-08-20) moved 115 unvalidated `/mobile/*` bodies onto encoded handlers; H4/H5/H1/H6/I1/X2 (2026-08-17–18) collapsed two dispatcher stacks, derived `implementedRoutes` from `PublicApi`, typed every TUI payload (`payload: unknown` → 0 in generated SDK), deleted legacy adapters (`provider/llm-client.ts`, `session/llm/ai-sdk.ts`, `session/message.ts` v1, `session/run-state.ts`, `session/runner.ts`, `share/share.ts`).
- HttpApi coverage is universal for JSON; raw handlers retained for SSE, prompts, webhooks. SSE and websocket upgrades stay ahead of the router on purpose (H7 does not promote mobile SSE/upload/upgrade).
- **E5 (landed 2026-08-24)**: typed Effect failure channel — `Session.asSessionError` is exported, `SessionRevert.Interface` / `SessionSummary.summarize` / `SessionSummary.diff` carry `Session.Error`, all 10 domain-rejecting handlers use `Effect.tryPromise({ catch: Session.asSessionError })`. `computeDiff` keeps `unknown` — real I/O. `declaredErrors` is a single `Effect.catch(asSessionError)`; `catchDefect` is gone. The 10 remaining `Effect.promise` sites are audited unknown-I/O and stay on `orDie`. `SessionPrompt.assertNotBusy` still raises by throw inside `Effect.gen` — separate cleanup, not part of E5.
- Domain internals still mixed: many services wrap Promise with `Effect.tryPromise`; SQLite repos are synchronous singletons; `SessionPrompt` and `LLM.stream` remain async-first.

## HTTP API Surface

- `PublicApi` (src/server/httpapi/public.ts:453) = served groups plus contract-only groups for raw handlers (share, users, sync stats, SSE feeds, websocket upgrades). `PublicHttpApi.Api` (public.ts:54) is the served subset — every group has handlers.
- `HttpApiAuth.Middleware` is attached to every protected group (H8, landed 2026-08-24): `TopLevel`, `Analytics`, `App`, `Brain`, `Chatbot`, `Discord`, `Voice`, `Profile`, `Config`, `Connectors`, `Doctor`, `Experimental`, `File`, `Mcp`, `Mission`, `Mobile`, `Project`, `Provider`, `Question`, `Permission`, `Pty`, `Loop`, `Session`, `Sync`, `Tui`, `Workspace`. `GlobalHttpApi.Group` and `ContractExtraHttpApi.AccountGroup` are intentionally unwrapped (browser sign-in flow is unauthenticated by definition; `GlobalGroup` marks its one protected endpoint at the definition site).
- `HttpApiAuth.Middleware` declares three security schemes (`bearer`, `auth_token` query key, `basicAuth`) but the middleware delegates to `Auth.authenticate` rather than re-implementing the acceptance order — Tailscale identity, open mode, OAuth-only are all handled there.
- `implementedRoutes` (src/server/httpapi/bridge.ts:132) = generated routes + extra implemented routes; `groupByMethod` keeps a per-method bucket strategy. `test/benchmarks/bridge-supports.benchmark.test.ts` pins it.
- `rawRouteImplementations` (src/server/httpapi/inventory.ts:14) is a `Set<string>` of ~23 routes declared in the contract but served raw: SSE streams (`/event`, `/global/event`, `/sync/stream`), mobile prompt/upgrade routes, `/user/login`, `/user/register`, `/config/profiles`, share endpoints, `/pty/:id/connect`, profile/mcp config mutations, `POST /config/reload`, `POST /session/:id/message`, `POST /session/:id/prompt_async`, `PATCH /user/:id`.
- `instance-less.ts` owns root paths (`/global`, `/user`, `/account`); each root claims its bare path plus subtree. `HttpApiBridge.handleGlobal`, `Server.fallback`, `ServerRouter.dispatch`, and `PublicRoutes.globalRequest` ask `isInstanceLessPath` instead of spelling prefixes.
- `global-handlers.ts` (H2, 2026-08-16) is a second module by design: keeps `server.ts` and `server-router.ts` free of `UsersHttp` and `AccountHttp` in their module graph.

## Storage: SQL Only

**`src/storage/` directory deleted.** JSON `Storage` is gone. All durable domain state lives in `nikcli.db` behind domain repos: `SessionRepo`, `ProjectRepo`, `LoopRepo`, `MissionRepo`, `MonitorRepo`, `ShareRepo`, `ArtifactRepo`, `GoalRepo`, `BackgroundRunRepo`, `RoutineRepo`, `SessionDiffRepo`, `AccountRepo`, `AuthRepo`, `MobileAuthRepo`, `AnalyticsRepo`. `session_diff` stays durable (imported shares may carry only `FileDiff[]` and snapshot GC may remove unreferenced `write-tree` objects).

- `bun:sqlite` opened in exactly one place (`src/database/database.ts:35`); WAL, `foreign_keys=ON`, `mmap_size=0`.
- Major migration wave (2026-08-14): `20260814000000_loop_sql`, `20260814020000_domain_sql` (missions/monitors/shares/artifacts), `20260814030000_project_sql`, `20260814040000_analytics_share`, `20260814050000_session_goal`, `20260814060000_background_run`, `20260814070000_routine`, `20260814080000_session_diff`, `20260814090000_workspace_json`, `20260814100000_session_pending`, `20260814110000_instruction_sync`, `20260814010000_session_time_suspended` (graceful-restart turn suspension).
- Latest migrations: `20260816000000_session_last_model`, `20260824000000_session_directory_key` (adds indexed `directory_key` + `title_lower` columns on `session_info` for P2.1 SQL session-list).
- Legacy `storage/*.json` trees stay on disk for downgrade only; runtime does not read them. Spec: `specs/storage/remove-json-storage.md`.
- Session-owned errors: `src/session/error.ts` declares `SessionNotFoundError` and `SessionIOError`; HTTP wire stays `"NotFoundError"` literal.

## Data, Sync, And Workspaces

- Persistence is single-store: SQLite (`src/database/`, `nikcli.db`, WAL-configured, migrated at open in `src/database/database.ts:35`). No `src/storage/` runtime module.
- Unified sync: `src/sync/` uses `sync_event` as the event log with projector, reducer, snapshots, outbox. Key migrations: `20260630000000_sync_unify`, `20260630000100_workspace_drop_events`. `session_v2_event` and `workspace.events` were dropped — one event log.
- Distinguish three meanings of "sync": the `sync_event` log, `Workspace.startSyncing()` SSE loops, and Cloud push/pull. They are not interchangeable.
- Workspace backends are transparent to clients: `Workspace.get()` plus adaptor `target()` resolves local vs remote; server middleware proxies remote requests. Built-in adaptors are worktree and container.
- No ETag/`If-Match` optimistic-concurrency scheme; concurrency relies on locks, WAL, and sequence reservation.
- Optional Railway hub remote sync uses `s.nikcli-ai.dev`, `NIKCLI_REMOTE_URL`, `NIKCLI_REMOTE_TOKEN`. TUI exposes `/sync` and `<leader>y` via `RemoteSync` and `DialogSync`; routes include `/sync/stats`, `/sync/connect`, `/sync/disconnect`, `/sync/drain`.

## Agents, Delegation, And Testing

- Built-in primary agents: `build` (default), `plan`, `ralph`. Subagents: `explore`, `fast-explore`, `planner`, `researcher`, `code-reviewer`, `debugger`, `test-runner`, `refactor`, hidden `delegator`.
- `task` defaults to background, concurrency-limited; records are durable; completion wakes the parent with a synthetic prompt. Use `delegation` for list/read/cancel and `delegator` only for early progress/status.
- Long-running builds, typechecks, test suites, installs, servers must use `monitor`, not blocking bash.
- Bun tests live under `packages/nikcli/test/`, mirror `src/`. Sync/workspace suite last known green 2026-06-30: 17 tests across four files. Full suite does not run in CI — only `validate` (typecheck + generated drift) gates publishes. `windows-compat.yml` runs four targeted suites on real Windows in ~40s.
- **Test helper conventions**: prefer `withIsolatedDatabase` (`test/helpers/sqlite.ts`) for SQLite-touching suites; `makeToolContext` + `withProjectDirectory` (`test/helpers/tool-context.ts`) for tool behavioural tests.
- After changing contract groups in `src/server/httpapi/`, regenerate via `bun run generate:httpapi-clients` (compiles `PublicApi` directly, writes three targets: `packages/sdk/js/src/httpapi/generated`, `src/server/httpapi/client/generated`, `src/server/httpapi/client/api`). `bun run --cwd ../sdk/js build` rebuilds the publishable SDK from the contract.
- Generated HttpApi clients are a blocking validation artifact: `script/ci-validate.ts` regenerates both trees and fails on tracked drift. Formatting and lint are blocking.
- **Route coverage (2026-08-24)**: `bun run check:routes` passes via `inventoryFailures` (inventory.ts:70) — `handlerRoutes() + rawRouteImplementations.size == publicRoutes().length`, every operationId unique, every route has a contract. `--strict` honors the same rules; future strict-only additions land in `script/check-route-coverage.ts`.

## Verified Risks: 2026-08-24 Audit

A focused code-reviewer + architecture-mapping pass produced prioritized, verified risks with file references. P0 and several P1/P2 from the 2026-07-28 pass were closed by H8, E5, P2, and the storage deletion; surviving risks are re-prioritized below.

- **P1 — `normalizeMessages` still inefficient.** `src/provider/transform.ts:75` carries `// TODO: fix this stupid inefficient dogshit function`. June 2026 resource review flagged it; the function is still there. Runs on every LLM call. P3 (later, in `specs/ROADMAP.md`) requires characterization + a bench or counter comment before optimization.
- **P1 — Excessive concentration.** `src/session/prompt.ts` (2,538 lines) controls nearly every agent concern. `src/cli/cmd/tui/routes/session/index.tsx` (3,968 lines). High-conflict, hard-to-test change surfaces.
- **P2 — `Auth.authenticate()` open-principal fallback.** `src/server/httpapi/auth.ts:236` returns `{ type: "open" }` when no password is configured. Mitigated at the contract level by H8 (`HttpApiAuth.Middleware` on every protected group): direct calls to encoded endpoints authenticate through the middleware; the `{ type: "open" }` principal only matters for paths the contract does not describe (raw streaming, unmatched). `isPublicPath` (auth.ts:160) explicitly lists `/global/health`, OPTIONS, `/user/status`, `/user/login`, `/user/register`, `/account{,/login,/login/complete}`.
- **P2 — Query-token exposure.** `extractQueryToken` (src/server/httpapi/auth.ts:145) accepts `?token=` globally; query tokens are principally needed for websocket/mobile transports. Tokens can leak through browser history, intermediary logs, copied URLs.
- **P2 — Effect migration adapter-heavy.** 265 files import Effect, but 269 `process.env` references, 153 raw `fetch()` calls, 76 filesystem-importing files, many `runPromiseWithLayer` wrappers remain. Pays complexity costs from both styles.
- **P2 — Background execution is process-bound.** Workers/delegators run as in-process loops in `src/tool/task.ts`. Persisted leases enable orphan detection, but process restart still abandons active computation. `session_pending` (2026-08-14) makes pending input durable; `session_time_suspended` (2026-08-14) survives graceful restart. Hard-crash recovery is explicitly out of scope.
- **P3 — Dual context model (ambient Instance + Effect InstanceRef).** Can cause scope leaks or incorrect directory resolution when async work escapes its intended boundary. R1 (later) replaces it.
- **P3 — README doc-drift.** `README.md` references `packages/chatbot/` directory and the `@nikcli-ai/chatbot` alias — neither exists; the real implementation is `packages/nikcli/src/chatbot/` + a `ChatbotHttpApi` group (HttpApi contract for chatbot bots/start) + `ChatbotHttp` raw handlers. Should be corrected in README §15, or a `packages/chatbot/` workspace promoted.

## Known Technical Work

- **OAuth onboarding (2026-07-17 review, status verified 2026-08-24).** Three items, mixed state:
  - (a) `DialogLogin.run()` loop guard — **obsolete.** The `DialogLogin` symbol no longer exists in `packages/nikcli/src/`; `app.tsx:435` was refactored away. Bug path no longer present at the original location.
  - (b) OAuth cancellation — **partially fixed.** `account/index.ts:390` passes `signal: options.signal` to the `/userinfo` fetch, and `:393` has a `signal?.throwIfAborted()` guard. **Polling sleeps at `:401`, `:418-419`, `:439`, `:450`, `:459` are still bare `Bun.sleep` — a cancel does not interrupt them.** Cancellation behaviour is partial: the round-trip stops, but the user keeps waiting through several stale polls before the next loop iteration checks the signal.
  - (c) Identity email refresh — **still present.** `packages/identity/src/database.ts:30` still has `if (linked) return linked` without updating the linked account's normalized verified email before returning. A user who fixes a typo in their OAuth provider's email does not see the new address in nikcli until they unlink and re-link.
- TUI `parsers-config.ts:145-148` has `// TODO: Injections not working for some reason` with the `injections` array commented out for HTML tree-sitter. `:240` has `// TODO: Replace with official tree-sitter-nix WASM when published`.
- TUI `wake-dedup.ts:33-36` has `TODO(livello 2):` for SSE `id:` reconnect — server SSE envelope does not currently carry `id:`, so reconnect relies on TTL-bounded first-seen heuristic.
- The `opentui` tool has a schema/input-transform bug: component collection fields such as `items`, `nodes`, and table arrays may validate as objects rather than arrays. Proposed fix is a discriminated Zod union plus actionable validation errors; not confirmed implemented.
- `/brain` and `/doctor` route review found unresolved risks: status polling mutates Brain throttle state, HTTP doctor includes a TTY check that fails headlessly, trigger exceptions can return undocumented 500s, doctor is mounted after project bootstrap despite not needing it.
- `console/app/src/routes/black/workspace.tsx:26-39` has a hardcoded fixture (`wrk_*` IDs in JSX) with `// TODO: Frank, replace with real workspaces`.
- Windows CI has recurring Bun bin-remap failures after hoisted installs. Recommended mitigation is `bun install --force` in Windows jobs. When adding a root workspace, update `nix/node_modules.nix` fileset too (it must include `../github`).
- `bun/index.ts:105` has a TODO depending on upstream Bun issue (oven-sh/bun#19936); cannot be fixed locally.
- Avoid leaking query tokens in server logs; `server.ts` request logging can include token-bearing paths. `mobile/auth.ts` also needs constant-time token comparison.
- **`terminal-control bundle` requires ffmpeg** (not installed on this machine). Recording works; bundle generation fails until ffmpeg is added via brew or equivalent.

## Roadmap (closed items, 2026-08-14 → 2026-08-24)

`Now` is empty as of 2026-08-24. The remaining `Later` items are **R1** (keyed scoped instance runtime), **T3** (output codecs on built-ins), **P3** (characterize `normalizeMessages`).

- **C1 — Release integrity** (2026-08-23): direct publishes run central validation unless caller marks `prevalidated`; missing Railway credential fails the deploy.
- **E4 — Encode optionals as absent keys** (corrected scope, completed 2026-08-19): the original framing was wrong; `jsonSafe` is load-bearing. `session.ts` keeps it for the three `Schema.Unknown` SessionV2 payloads; `provider.ts` and `config.ts` keep it for live `fetch` functions in `options`.
- **H1 — TUI payloads typed** (2026-08-17 → 2026-08-18): `payload: unknown` is 0 in generated SDK.
- **H2 — One instance-less path module** (2026-08-16): `instance-less.ts` + `global-handlers.ts`.
- **H3 — Generated namespaced SDK view** (2026-08-23): `PublicClientCompat` declares all 336 Promise endpoints exactly once; `emitPromiseCompat` rejects missing/unknown/duplicate/colliding entries.
- **H4/H5/H6 — One dispatcher, generated allowlist, typed inputs** (2026-08-17 → 2026-08-18).
- **H7 — JSON `/mobile/*` onto encoded handlers** (2026-08-20).
- **H8 — `HttpApiMiddleware` on encoded groups** (2026-08-24). 328 secured, 10 open (pinned by `test/server/httpapi-security.test.ts`).
- **E5 — Typed Effect failure channel** (2026-08-24).
- **P2 — Request-path cuts** (2026-08-24). P2.1: SQL session-list with `directory_key` + `title_lower` columns (`20260824000000_session_directory_key`). P2.2 (URL carry-through): measured, **rejected** — reparses cost 0.03% per request.
- **P1 — Provider policy** (2026-08-14): `Policy` evaluates `experimental.policies` with wildcards and last-match-wins.
- **T1 — Scoped tool registration** (2026-08-14): overlay stack with reloadable derived + non-reloadable runtime cache.
- **T2 — Tool output schemas** (2026-08-14): wrapper parses `result.value` after execute; T3 (later) extends to built-ins.
- **S1 — Durable pending input** (2026-08-14): `session_pending` + atomic batched promotion.
- **S2 — Turns survive graceful restart** (2026-08-14): `session_info.time_suspended` + partial index.
- **S3 — Instruction sync** (2026-08-14): `instruction_blob` + delta of content hashes.
- **S4 — V2 write path** (2026-08-14): entries persist first; v1 is `toV1*`.
- **S4r — Import / teleport / run write through SessionV2** (2026-08-23).
- **E1 — One encode per event** (2026-08-14): `EventFeed` fans both SSE routes from one encoded frame with per-connection lag budget.
- **E3c — Public event filter** (2026-08-16): six event types withheld from SSE seam.
- **D1 — Session-owned errors** (2026-08-14): HTTP wire stays `"NotFoundError"` literal.
- **D2 — All domain state in SQL** (2026-08-14): missions, monitors, shares, artifacts, project, analytics, goals, background runs, routines — all behind repos with backfill migrations. `src/storage/` runtime module deleted.
- **I1 — One Identifier module** (2026-08-18): `packages/util/src/identifier.ts` deleted; callers use prefixed `Identifier.descending("event")` / `"session"`.
- **X2 — Delete adapters with no production callers** (2026-08-18): five modules + their tests.
- **U1 — TUI package extracted** (2026-08-16): `packages/tui` (`@nikcli-ai/tui`).
- **U2 — Semantic theme tokens** (2026-08-14): nested tokens derived from flat document in `theme-tokens.ts`.
- **U3 — Built-in themes lazy-load** (2026-08-14): only `nikcli.json` is parsed at TUI module load.
- **X1 — Subsystem-doc triage** (2026-08-14): `dc0f8bb003` deleted 52 files under `packages/nikcli/specs/`. The 14 that described live subsystems were triaged; source of truth stays the code.

## Monorepo Audit (2026-08-24)

A monorepo-wide audit (~41 packages) was performed with reverse-dependents, CI references, and 6-month commit counts. Active vs dormant classification:

- **ACTIVE** (used by other packages + recent commits + CI wired): `nikcli`, `sdk` (js), `tui`, `mobile`, `desktop`, `web`, `app`, `plugin`, `remote`, `companion`, `identity`, `auth`, `llm`, `inference`, `inference-dashboard`, `terminal-control`, `tui-image`, `tui-math`, `ui`, `util`, `httpapi-codegen`, `discord`, `slack`, `computer-use`, `browser-control`, `enterprise`, `function`, `webrenderer`, `simulation`, `script`, `cloud`, `bench-tui`.
- **DORMANT** (zero dependents, no recent commits, possibly legacy/experimental): `sdk-next` (4 commits over 6 months — only used as the opencode-replacement shape that the in-package `sdk/js` has already absorbed), `containers` (no `package.json` at top level — was a copy of upstream dockerfiles), `extensions` (no top-level `package.json`).
- **REFERENCE-ONLY**: `nikcli-island` (one-off isolated embed; not depended on by other packages).

Decisions deferred to user — see Unused Workspaces thread.

## Mobile UI/UX Notes

`packages/mobile` is Expo/React Native with NativeWind, Expo Router, Zustand, SecureStore, and a direct `MobileClient` data layer. Existing durable polish targets:

- Fix `SessionComposer` stop action: `onStop` is accepted but was not wired; several model/MCP props are also unused.
- Add semantic color tokens and improve `InfoChip` warning mapping; current warning colors can look like danger, especially in dark mode.
- Add accessibility role, label, and hint to icon-only pressables; give `ActionButton` a default button role/state.
- Remove nested `SafeAreaView` behavior in terminal route and guard retained terminal tabs against a disconnected client.
- Keep the planned direction: stronger semantic tokens, contextual header/tab states, consistent loading/empty/error patterns, cleaner transcript/tool/permission states, and better safe-area handling.

## Reference Facts

- OpenCode upstream reference branch is `anomalyco/opencode:dev`.
- The root `AGENTS.md` contains stale package/branch claims; verify live workspace state rather than copying them forward.
- Session transcript text is in SQLite (`message_info`, `message_part`); `session_diff/*.json` files may only be empty `[]` stubs.
- Verification baseline (2026-08-24): `bun run typecheck` passes (exit 0); `bun run check:routes` passes via `inventoryFailures`; `bun run generate:httpapi-clients` is drift-free; `bunx oxlint` clean; `bunx prettier --check` clean.
- Toolchain pinned: `bun@1.4.2` (workspace), `typescript@5.8.2` (catalog, with `@typescript/native` 7.0.2 for typecheck), `zod@4.1.8`, `effect@4.x`, `remeda@2.26.0`, `marked@17.0.1`, `solid-js@1.9.10`, `hono@4.12.34` (still in catalog for downstream packages — server itself does not import it).
- OpenTUI dashboard schemas documented in the nikcli-skill: `stat_grid` (label/value/color), `key_value` (key/value/status), `bar_chart` (label/value/color, value=number), `list` (primary/secondary/icon/status), `compare` (rows with label/left/right/winner), `gauge` (value/max/label/min/thresholds), `accordion` (sections with title/open/content/items), `diff` (before/after/mode/filetype/title), `code` (content/filetype/showLineNumbers), `markdown` (content), `sparkline_row` (rows with label/values/current), `tree` (nodes with label/status/children), `histogram` (bins with label/count), `heatmap` (rowLabels/colLabels/values 2D/colorScale), `line_chart` (series with name/values/color + labels/height/showAxis). Status fields accept "default"|"success"|"warning"|"error"|"info". Max `status_grid` items ≤48.
