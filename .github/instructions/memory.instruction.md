# nikcli Project Memory

**Last updated**: 2026-09-16
**Default branch**: `live-main`
**Repo**: `github.com/nikcli/nikcli` - fork of [OpenCode](https://github.com/anomalyco/opencode)

Dependency versions and older module inventories below are historical notes from 2026-06-26, not a current manifest audit. Current repository AGENTS.md files take precedence.

## Overview

### Core

- **Bun** 1.4.2 — runtime, package manager
- **TypeScript** 7.0 native (`tsc` via `@typescript/native`) for typecheck; JS-based TypeScript 5.8/5.9 stays for the programmatic API (codemode transpile, Astro tooling)
- **Turborepo** — monorepo orchestration
- **Zod** 4.1.8 — validation (with `.meta()` for OpenAPI refs)
- **Effect** 4.0.0-beta.65 — typed runtime/dependency injection (migration in progress, 9-epoch plan)

### Frontend

- **SolidJS** 1.9.10 — TUI (OpenTUI), web app, enterprise, console
- **React** 18.3.1 — mobile (Expo), Astro pages, email templates
- **TailwindCSS** v4 (web/app) / v3 (mobile)
- **Kobalte** — SolidJS headless UI primitives
- **Vite** 7.1.4 — frontend build

### Backend / Server

- **Effect HttpApi on Bun.serve** - nikcli HTTP server; no Hono app. The contract generates OpenAPI and clients.
- **Hono** - used by other packages historically (companion, cloud, functions, enterprise); not the nikcli server.
- **WebSocket** (ws) — PTY, companion, remote
- **SSH** (ssh2 1.17.0) — remote access
- **mDNS** (bonjour-service) — server discovery

### AI / LLM

- **Vercel AI SDK** (`ai` 5.0.119, v2 of `@ai-sdk/*`) — core orchestration
- **17+ bundled providers**: Anthropic, OpenAI, Google, Vertex, Bedrock, Azure, Groq, Cerebras, Cohere, DeepInfra, Mistral, Perplexity, Together, Vercel Gateway, xAI, OpenRouter, GitLab, plus **custom plugin providers**: GitHub Copilot (custom SDK in `provider/sdk/copilot/`), Cloudflare, Codex, Cursor, XAI
- **Ollama** — auto-discovered locally, configurable base URL
- **MCP** (`@modelcontextprotocol/sdk` 1.25.2) — Model Context Protocol
- **ACP** (`@agentclientprotocol/sdk` 0.5.1) — Agent Client Protocol (IDE integration, e.g. Zed)
- **Chat adapters**: Discord, Slack, GitHub, Linear, Teams, Google Chat (with Redis/memory state)
- **Provider state cached** via `Instance.state(...)`: long-lived processes keep older resolved provider sets until instance disposal/recreation
- **`models --refresh` only refreshes models.dev cache** — provider-specific catalogs (Ollama, GitHub Copilot) come from their own runtime fetch paths

### Database & Storage

- **Drizzle ORM** — console-core (55 migrations as of 2026-04-04)
- **PostgreSQL** (pg), **MySQL** (mysql2), **PlanetScale**
- **Cloudflare D1** — edge SQLite (cloud)
- **Stripe** 18.0.0 — payments

### Infrastructure

- **SST** 3.19.3 — infrastructure as code (`infra/{app,console,enterprise,secret,stage}.ts`)
- **Cloudflare Workers** — edge deployment
- **Tauri v2** — desktop app (Rust + WebView, 96.6 MB build output)
- **Expo** 52.0.46 / **React Native** 0.76.7 — mobile (iOS + Android)
- **Railway** (`railway.toml`) + **Fly.io** (`fly.toml`) — alternative deploy surfaces
- **Docker** — `Dockerfile` (mobile host) + `Dockerfile.serve` + `docker-compose.serve.yml`
- **Nix** — reproducible builds (`flake.nix`)
- **GitHub Actions** — 23 workflows
- **Homebrew tap** — `homebrew-tap/nikcli.rb`
- **Patched deps** — 5 active patches in `patches/` (openrouter, fff-bun, photon-node, expo-modules-jsi, ghostty-web)

## Monorepo Structure (Selected Packages)

| Package                                                        | Name                             | Description                                                                                                   |
| -------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/nikcli`                                              | `nikcli`                         | Core CLI, Effect HttpApi server, sessions, tools, MCP/ACP                                                     |
| `packages/sdk/js`                                              | `@nikcli-ai/sdk`                 | Generated HttpApi clients; consumers use `@nikcli-ai/sdk/httpapi`                                             |
| `packages/tui`                                                 |                                  | Shared TUI components, including QR rendering                                                                 |
| `packages/studio`                                              |                                  | Desktop UI                                                                                                    |
| `packages/identity`                                            |                                  | Browser identity, database, and authentication contracts                                                      |
| `packages/llm`                                                 | `@nikcli-ai/llm`                 | LLM provider factories (modular, used by `provider/`)                                                         |
| `packages/util`                                                | `@nikcli-ai/util`                | Shared utilities (fn, error, retry, slug, path — Zod-based)                                                   |
| `packages/app`                                                 | `@nikcli-ai/app`                 | Shared web UI (SolidJS)                                                                                       |
| `packages/ui`                                                  | `@nikcli-ai/ui`                  | UI component library, icons, themes, i18n                                                                     |
| `packages/nikcli-plugins/`                                     | `nikcli-plugins`                 | External TUI plugin package (music, greet, matrix, starwars, weather, win95, pomodoro, calcio, pills, crypto) |
| `packages/plugin`                                              | `@nikcli-ai/plugin`              | Plugin system core + bundled plugins (codex, cursor, github-copilot, openai, cloudflare, xai)                 |
| `packages/desktop`                                             | `@nikcli-ai/desktop`             | Tauri v2 desktop app (16 languages)                                                                           |
| `packages/mobile`                                              | `@nikcli-ai/mobile`              | Expo/React Native mobile (iOS + Android) — companion with QR pairing                                          |
| `packages/enterprise`                                          | `@nikcli-ai/enterprise`          | Enterprise web app (SolidStart + Nitro)                                                                       |
| `packages/cloud`                                               | `@nikcli-ai/cloud`               | Cloudflare Workers backend (D1, Durable Objects, jose JWT)                                                    |
| `packages/companion`                                           | `@nikcli-ai/companion`           | Companion server (Hono + WebSocket + Cloudflare Workers)                                                      |
| `packages/remote`                                              | `@nikcli-ai/remote`              | Remote terminal via WebSocket + QR code + tunnels                                                             |
| `packages/slack`                                               | `@nikcli-ai/slack`               | Slack bot (@slack/bolt + Cloudflare Workers)                                                                  |
| `packages/discord`                                             | `@nikcli-ai/discord`             | Discord Gateway bot (discord.js) + invite helpers; TUI `/discord` wizard via HttpApi                          |
| `packages/web`                                                 | `@nikcli-ai/web`                 | Marketing/docs site at `nikcli-ai.dev` (Astro + React + Cloudflare)                                            |
| `packages/inference`                                           | `@nikcli-ai/inference`           | Inference service                                                                                             |
| `packages/inference-dashboard`                                 | `@nikcli-ai/inference-dashboard` | Analytics dashboard (Astro)                                                                                   |
| `packages/webrenderer`                                         | `@opentui/webrenderer`           | Native Rust web renderer (wry/tao) for TUI bridge                                                             |
| `packages/tui-image`                                           | `@nikcli-ai/tui-image`           | TUI image rendering helpers                                                                                   |
| `packages/terminal-control`                                    | `@nikcli-ai/terminal-control`    | Terminal control primitives                                                                                   |
| `packages/bench-tui`                                           | `@nikcli-ai/bench-tui`           | TUI benchmarking                                                                                              |
| `packages/function`                                            | `@nikcli-ai/function`            | Serverless function (Hono + Cloudflare Workers)                                                               |
| `packages/script`                                              | `@nikcli-ai/script`              | Cross-package scripting helpers                                                                               |
| `packages/http-recorder`                                       | `@nikcli-ai/http-recorder`       | HTTP recording test fixture                                                                                   |
| `packages/extensions/zed`                                      | `@nikcli-ai/zed`                 | Zed editor integration                                                                                        |
| `packages/containers/{base,bun-node,publish,rust,tauri-linux}` | `@nikcli-ai/containers-*`        | Container build assets                                                                                        |
| `packages/console/{app,core,function,mail,resource}`           | `@nikcli-ai/console-*`           | Console sub-monorepo (SolidStart + Drizzle + Stripe + jsx-email)                                              |
| `github/`                                                      | `github`                         | GitHub Action composite action                                                                                |

### Repository Root Structure

| Path                                                     | Purpose                                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/`                                              | Main product code: CLI, SDK, apps, workers, shared libs, desktop, mobile, console sub-monorepo                                                                        |
| `infra/`                                                 | SST app definitions wiring deployed services to package entrypoints (`infra/app.ts`, `infra/console.ts`, `infra/enterprise.ts`)                                       |
| `script/`                                                | Root automation: build, publish, schema/OpenAPI generation, formatting, changelog/release, e2e seeding (`script/build.ts`, `script/generate.ts`, `script/publish.ts`) |
| `nix/`                                                   | Reproducible dev/build packaging anchored by `flake.nix`                                                                                                              |
| `.github/`                                               | CI/CD workflows: typecheck, test, deploy, publish, nix builds, release (`test.yml`, `deploy.yml`, `publish.yml`)                                                      |
| `.sst/`, `.turbo/`, `node_modules/`, `dist/`, `.output/` | Generated/local state — treat as environment/cache noise unless explicitly targeted                                                                                   |

### Build / Tooling Config Files

- `package.json:8` — Bun version pin enforced on push by `.husky/pre-push`
- `package.json:28` — shared dependency catalog (Bun catalog entries)
- `bunfig.toml:4` — root test guardrail (forbids `bun test` at repo root)
- `turbo.json:1` — task graph: `typecheck`, `build`, selected `test`; build depends on upstream package builds
- `sst.config.ts:4` — deployment control plane targeting Cloudflare
- `.husky/pre-push:1` — enforces Bun version match + runs `bun typecheck`

## Core Architecture

### CLI Entry Points (`src/index.ts`)

- yargs-based CLI with `parserConfiguration({ "populate--": true })`
- Global middleware: log init, env vars (`AGENT=1`, `NIKCLI=1`)
- `--print-logs` and `--log-level` (DEBUG/INFO/WARN/ERROR) global options
- Binary shim (`bin/nikcli`) locates platform package binary and forwards argv
- Default command is TUI (registered as `$0 [project]` in `src/cli/cmd/tui/thread.ts:52`) — invoking `nikcli` with no subcommand lands there
- Local CLI execution also uses the internal server API; do not assume legacy `Server.App().fetch()` integration still applies.
- Uses `Installation.VERSION` (injected at build time via `NIKCLI_VERSION` env var) for `--version` flag

### CLI Startup & Auto-Upgrade Flow

**Entry chain:**

1. `src/index.ts` → yargs parses args → calls TUI command `src/cli/cmd/tui/thread.ts`
2. `thread.ts` → spawns worker process → mounts TUI via `render(...).mount()`
3. Worker sends `checkUpgrade` RPC call 1 second after TUI startup (`thread.ts:266-268`):
   ```ts
   setTimeout(() => {
     client.call("checkUpgrade", { directory: cwd }).catch(() => {})
   }, 1000).unref?.()
   ```
4. Worker `checkUpgrade` → calls `upgrade()` from `src/cli/upgrade.ts`

**`upgrade()` function (`src/cli/upgrade.ts`):**

1. Load global config (skip if no config)
2. Detect install method via `Installation.method()` (npm, brew, curl, etc. — `"unknown"` skips)
3. Fetch latest version via `Installation.latest(method)`
4. If already at latest → skip
5. If `autoupdate === false` or `NIKCLI_DISABLE_AUTOUPDATE=1` → skip
6. Determine release kind (major/minor/patch) via `Installation.getReleaseType(current, latest)`
7. If `autoupdate === "notify"` OR non-patch → publish `UpdateAvailable` event only (TUI shows toast/dialog)
8. If patch + autoupdate enabled → auto-upgrade silently, publish `Updated` event

**TUI upgrade dialog (`src/cli/cmd/tui/app.tsx`):**

- Listens for `installation.update-available` event via `Bus.subscribe()`
- Shows `DialogConfirm` with version info, "Update & Restart" / "Later" buttons
- If "Update & Restart": calls `upgradeNow()` from props → worker RPC → `Installation.upgrade()` → `Bus.publish(Updated)` → restart
- Listens for `installation.updated` event for restart confirmation toast

**Installation module (`src/installation/index.ts`):**

- `Installation.VERSION` — injected at build time (`NIKCLI_VERSION` env var), fallback `"local"`
- `Installation.CHANNEL` — injected at build time (`NIKCLI_CHANNEL` env var), fallback `"local"`
- Effect Service with methods: `info()`, `method()`, `latest(method)`, `upgrade(method, target)`
- `methodImpl()`: detects install method by checking `process.execPath` and running package manager commands
- `method()` returns: `"bun"` | `"npm"` | `"pnpm"` | `"yarn"` | `"brew"` | `"curl"` | `"choco"` | `"scoop"` | `"unknown"`
- `upgradeImpl()`: handles upgrade per method — for `"brew"` uses `brew upgrade <formula>` with `HOMEBREW_NO_AUTO_UPDATE=1`

### CLI Commands (38+ commands)

`run`, `goal`, `generate`, `agent`, `auth`, `account`, `upgrade`, `quickstart`, `doctor`, `uninstall`, `models`, `locale`, `serve`, `web`, `heap`, `stats`, `export`, `import`, `github`, `pr`, `session`, `image-model`, `speak-model`, `brain-model`, `remote`, `teleport`, `ads`, `companion`, `mobile`, `plug`, `routine`, `usage`, `mission`, `acp`, `mcp`, `connectors`, `chatbot`, `workspace-serve`
Plus TUI subcommands: `tui/attach`, `tui/thread`, `debug`

**Adding a new command:**

1. Create `src/cli/cmd/<name>.ts` exporting a yargs `CommandModule`
2. Import it in `src/index.ts` and register via `.command(...)`
3. For server/API-backed features: edit the contract in `src/server/httpapi/`, regenerate clients, then call from CLI
4. `process.on(SIGHUP)` ensures `serve` doesn't outlive its terminal

### Runtime Model

- Most commands enter runtime via `bootstrap()` in `src/cli/bootstrap.ts:4` wrapping `Instance.provide(...)` from `src/project/instance.ts:54`
- `Instance` is the core runtime container; resolves project/worktree, memoizes state per directory, handles teardown
- Runtime init in `src/project/bootstrap.ts:18` wires: plugins, sharing, formatters, LSP, file watching, VCS, snapshots, truncation, todos, delegation
- `InstanceBootstrap` (`bootstrap.ts`) fires: `Plugin.init()` (blocking), then `ShareNext`, `Format`, `FileWatcher`, `File`, `Vcs`, `Snapshot`, `Truncate`, `Todo`, `SessionV2` projector (fire-and-forget), then `LSP.init()` (blocking), then `Delegation.init()`, `Monitor.reconcile()`, `LoopEngine.restore()`, `MissionOrchestrator.restore()`, `Routine.restoreSchedulers()`. Subscribes to `Command.Event.Executed` → marks project initialized after `Command.Default.INIT`.
- **Architectural seam**: CLI commands stay thin; real behavior hangs off `Instance` + bootstrapped subsystems

### Effect Runtime (`src/effect/`) — **NEW**

Thin wrappers over Effect 4 (`effect@4.0.0-beta.65`):

- `instance-state.ts` — per-instance state via `InstanceState.make`
- `instance-scope.ts` — `locallyInstance(ctx, effect)` scopes to a directory
- `instance-ref.ts` — instance-scoped `Ref`
- `runtime.ts` — `AppRuntime.runPromise`, `runPromiseWithLayer`
- `run-service.ts` — `runService(Service, effect, withCurrentInstance?)`
- `with-instance.ts` — `withCurrentInstance`, `withInstanceAsync`

**Canonical pattern** repeated everywhere:

```ts
runX<A, E>(effect) = runPromiseWithLayer(X.defaultLayer, withCurrentInstance(effect))
```

Architecture changes to Effect boundaries, TUI lifecycle, event delivery, rendering, or startup follow `specs/README.md` and `specs/ROADMAP.md`. Start with EOT-01 measurement; later specs are dependency-gated and remain proposed until acceptance tests land. The old Hono/HttpApi coexistence description is obsolete.

### Agent System (`src/agent/agent.ts`)

Zod schema `Agent.Info` with fields: name, description, mode, native, hidden, topP, temperature, color, permission, model, variant, prompt, options, steps.

**Built-in agents (14 primary + subagents via Task tool delegation):**
| Agent | Mode | Description |
|-------|------|-------------|
| `ralph` | primary | Autonomous loop agent (iterates until complete, supports `steps` option) |
| `build` | primary | Main coding agent, allows plan_enter |
| `plan` | primary | Planning agent, denies edit except `.nikcli/plans/*.md` |
| `general` | all | General-purpose research + multi-step tasks |
| `explore` | all | Fast codebase exploration (read, grep, glob, bash, web) |
| `fast-explore` | all | Read-only quick inspection (read, grep, glob, list, tree) |
| `planner` | all | Multi-step implementation strategies |
| `scout` | all | Read-only external library research |
| `code-reviewer` | all | Quality and safety review |
| `debugger` | all | Root cause analysis + minimal fixes |
| `test-runner` | all | Test execution + failure analysis |
| `refactor` | all | Safe refactoring without behavior changes |
| `ultrareview` | all | Multi-agent parallel review fleet (uses `code-reviewer` parallel agents) |
| `compaction` | primary (hidden) | Session compaction |
| `title` | primary (hidden) | Title generation (temp: 0.5) |
| `summary` | primary (hidden) | Summary generation |

`SUBAGENT_TOOLSETS` defines restricted toolsets per subagent type. Custom agents from `nikcli.json` config extend/override built-ins. Agent prompts can be specialized via `.txt` files in `agent/*.txt`.

### Session System (`src/session/`)

- `Session.Info` Zod schema: id, slug, projectID, directory, parentID, workspaceID, share, github, title, version, time, permission, skills, revert
- **MessageV2**: `{ type: "text" | "reasoning" | "tool" | "file" | "step-start" | "step-finish" | "snapshot" | "patch" | "agent" | "retry" | "compaction" | "subtask" }` — with optional `usage` (input/total/cached), `finish_reason`, `model_id`, `cost` fields on each message
- **SessionV2** (`session/v2/`): event-sourced engine (newer than legacy session/) — projector fired in `InstanceBootstrap`
- **SessionProcessor** (`processor.ts`): doom loop detection (threshold: 3), compaction check, permission deny handling, retry logic
- **LLM streaming** (`llm.ts`): full stream with reasoning-start/delta/end, text-delta, tool-call, tool-result, error, finish; `looksLikeUIMessage()` + `repairMessage()` for malformed UI-shaped messages (fixes `AI_InvalidPromptError`); drops unrecoverable messages with warning
- **ShareNext** (`share-next.ts`): syncs session data to enterprise endpoint (`s.nikcli-ai.dev`), with local fallback
- **SessionPrompt** (`prompt.ts`): system prompts per provider (anthropic, gemini, qwen, beast, copilot-gpt-5, etc.)
- **SessionCompaction** (`compaction.ts`): auto-compaction based on token usage
- **SessionSummary** (`summary.ts`): session summarization
- **Todo** (`todo.ts`): todo list management (used for plan tracking)
- **Usage** (`usage.ts`): aggregates token usage and cost from session messages (input/total/cached), calculates cost from provider pricing
- Events: `session.created`, `session.updated`, `session.deleted`, `session.diff`, `session.error`

### Config System (`src/config/config.ts`)

Config layering (in precedence order):

1. Well-known remote config (`/.well-known/nikcli`)
2. Global config (`~/.nikcli/config`)
3. Custom env path/content
4. Project config (`nikcli.json`)
5. Scanned `.nikcli` dirs (upward scan)

User-defined extensions auto-loaded from `.nikcli` directories:

- Markdown commands from `{command,commands}/**/*.md`
- Markdown agents from `{agent,agents}/**/*.md`
- File-based plugins from `{plugin,plugins}/*.{ts,js}`
- Config-dir custom tool autoload requires `NIKCLI_ALLOW_PLUGIN_AUTOLOAD=1` or `tool.allow`/`tool.pin`; see `packages/nikcli/AGENTS.md`.
- Config plugins may trigger automatic npm package installation

Runtime command catalog merges: built-ins, config commands, MCP prompts, connector prompts, skills.

### Extension Points for New Features

| Feature Type                            | Where to Add                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| CLI command (orchestration/UI)          | `src/cli/cmd/<name>.ts`, register in `src/index.ts`                                                         |
| Server/API capability (CLI + TUI + SDK) | Edit group in `src/server/httpapi/`, then regenerate clients                                                |
| Model-executable tool during sessions   | Add in `src/tool/<name>.ts`, register in `src/tool/registry.ts`                                             |
| Connector-backed feature                | Extend `src/connectors/registry.ts` (surfaces in status/prompts/`use_connector` automatically)              |
| Plugin-based extensibility              | Use config/plugin discovery from `src/config/config.ts:355` and hook lifecycle in `src/plugin/index.ts:585` |
| AI/session command                      | Add to `src/command/index.ts:72` or support via markdown config                                             |

### Tool Registry (`src/tool/registry.ts`)

**60+ registered tools** (43 in main registry + dynamic loaders):

| Category             | Tools                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **File/code**        | `read`, `write`, `edit`, `multiedit`, `apply_patch`, `glob`, `grep`, `ls`, `tree`, `truncation`, `truncation-dir`                         |
| **Shell/exec**       | `bash`, `monitor` (background runner), `exec_code`                                                                                        |
| **Web/search**       | `webfetch`, `websearch`, `codesearch`, `repo_clone`, `repo_overview`                                                                      |
| **Browser/computer** | `browser` (Browser Use Cloud SDK v3, persistent sessions via `keepAlive:true`), `computer` (sandbox/host modes, requires Colima on macOS) |
| **Context**          | `context_collect`, `context_related`, `context_diagnostics`, `context_search`, `memory_search`                                            |
| **Planning/agents**  | `task` (37KB — largest), `delegation`, `delegator`, `advisor`, `plan-enter`, `plan-exit`, `todo` (write/read), `goal`                     |
| **Output media**     | `generate_image`, `speak`, `voice` (with `speak/{elevenlabs,openrouter,provider}.ts`)                                                     |
| **System**           | `lsp`, `question`, `skill`, `batch`, `monitor`                                                                                            |
| **Generative UI**    | `opentui` (32KB — emits reactive Solid components via TUI)                                                                                |
| **Misc**             | `search_tools`, `invalid`, `external-directory`, `mcp-exa`                                                                                |

**Author interface** (`Tool.define(id, init)`): normalizes both Promise- and Effect-returning `execute` into a unified `Tool.Def` where `execute` always returns `Effect.Effect<Result, Error>`. A compat `executeAsync(args, ctx)` wraps it via `AppRuntime.runPromise(...)`. Truncation runs automatically post-execute via `Truncate.Service` (best-effort, swallows errors).

**Two-layer description pattern**: each tool has a sibling `.txt` file with prompt instructions (`advisor.txt`, `apply_patch.txt`, `bash.txt`, etc.) — used by the agent system when assembling prompts.

Plus dynamically loaded tools from `tool/*.{js,ts}` files and plugin tools.
Conditional: `codesearch`/`websearch` require nikcli provider or `NIKCLI_ENABLE_EXA`. `apply_patch` used for GPT models, `edit`/`write` for others.

### Browser Tool (`src/tool/browser.ts` + `src/browser/browser.ts`) — **NEW**

3-layer architecture: `tool/browser.ts` → wrapper `Tool.define` with zod schema; `browser/browser.ts` → namespace `Browser` with singleton SDK state + cleanup on shutdown; `tui/component/dialog-browser-use.tsx` → SolidJS dialog for setup + model selection.

- **4 actions exposed**: `run` (task), `status`, `messages`, `stop`
- **Auth chain**: `process.env.BROWSER_USE_API_KEY` → auth vault `providerID: "browser-use"`
- **Persistence**: `keepAlive:true` + per-nikcli-session reuse — cookies, tabs, login state carried across conversation turns
- **Default conservative flags** (all `false`, browser-only mode): `skills`, `agentmail`, `enableScheduledTasks`
- **Supported models** (`Browser.MODELS`): `bu-mini`, `bu-max`, `bu-ultra`, `gemini-3-flash`, `claude-sonnet-4.6`, `claude-opus-4.6`, `claude-opus-4.7`, `gpt-5.4-mini`. Only `claude-sonnet-4.6`, `claude-opus-4.6`, `gpt-5.4-mini` are natively billable — others require BYO provider key (gap: dialog doesn't warn)
- **Cost cap**: default $1, configurable up to $100 via `maxCostUsd`

### Computer Tool (`src/tool/computer.ts`) — **NEW**

- **Modes**: `sandbox` (default, isolated Linux container — needs Colima on macOS, runs Fluxbox minimal desktop) or `host` (drives user's real machine, requires Screen Recording + Accessibility permissions)
- Screenshots returned inline; need `screenshot` action first to bootstrap sandbox image build
- Coordinates are screen pixels with (0,0) at top-left
- First action may take a while while the desktop image is built
- Never destructive without explicit instruction

### Permission System (`src/permission/next.ts`)

- `PermissionNext.Ruleset` = array of `{ permission, pattern, action }` where action is `"allow" | "deny" | "ask"`
- `PermissionNext.merge(...rulesets)` — deep merge with last-wins
- `PermissionNext.fromConfig(config)` — converts config objects to rulesets
- Default permissions: `*` allow, `doom_loop` ask, `external_directory` ask, `question` deny, `read *.env` ask

### Brain System (`src/brain/`) — **NEW**

Automatic memory consolidation system. Runs periodically (configurable via `experimental.brain` and `experimental.memory`):

- **Lock mechanism**: file-based lock with 1-hour duration, PID verification
- **Trigger conditions**: `minHours` (default 24) since last brain, `minSessions` (default 5) since last brain
- **Execution**: creates a restricted session (read, edit, glob, grep, list, tree only), reviews last 10 sessions (max 12K chars each), synthesizes memory into `.github/instructions/memory.instruction.md`
- **Config**: `experimental.brain` (bool), `experimental.memory` (bool), `experimental.brainMinHours`, `experimental.brainMinSessions`

### ACP System (`src/acp/`) — **NEW**

Agent Client Protocol implementation for IDE integration (e.g., Zed):

- `ACP.Agent` class implements `@agentclientprotocol/sdk` `Agent` interface
- Protocol v1, capabilities: loadSession, mcpCapabilities (http + sse), promptCapabilities (embeddedContext + image)
- Session management via `ACPSessionManager` (maps ACP sessions to nikcli sessions)
- Bidirectional event subscription: permission.asked → requestPermission, message.part.updated → sessionUpdate
- Tool call mapping: `toToolKind()` maps nikcli tools to ACP tool kinds (execute, fetch, edit, search, read, other)
- Command interception: `/compact` → summarize, other `/command` → session command
- `getNewContent()` uses `diff.applyPatch()` for ACP edit approvals
- Auth method: terminal-auth capability or `nikcli auth login`

### Scheduler System (`src/scheduler/`) — **NEW**

Generic interval-based task scheduler with `Instance.state` scoping:

- `Scheduler.register(task)` with `scope: "instance" | "global"` (default instance)
- Auto-cleanup on instance disposal
- `timer.unref()` to avoid keeping process alive

### Server and HTTP Contract

- `packages/nikcli/src/server/httpapi/` is the source of truth for endpoints, OpenAPI, and generated clients; runtime is Effect HttpApi on `Bun.serve`.
- Endpoint changes require `bun run generate:httpapi-clients` from `packages/nikcli` and inclusion of generated output. Schema rules and verification are in `packages/nikcli/AGENTS.md`.
- `bun run check:routes` runs route coverage there. `--strict` is honored as of 2026-08-17; it currently applies the same rules as default.
- `Account.Service` and related Effect services are canonical authentication boundaries; identity changes can span `packages/nikcli` and `packages/identity`.

### Workspace System (`src/workspace/`)

- `Workspace.Info` schema: id, branch, projectID, config
- Config types: `worktree` (local) or remote workspace
- **Sync loop**: SSE event stream from remote workspaces, mirrors events locally (session.status, permission.asked/replied)
- `startSyncing(project)` — starts sync for all non-worktree workspaces
- `session-proxy-middleware.ts` — transparently proxies session requests to remote workspace instances

### SDK (`packages/sdk/js`)

- Consumers import `@nikcli-ai/sdk/httpapi`; there is no v2 client or hey-api generation step.
- `packages/sdk/js/script/build.ts` regenerates from the HttpApi contract and emits `dist`.

### Plugin System (`src/plugin/`, `packages/plugin/`)

- Dynamic loading from `plugin/plugins/*.ts`, npm packages, or `tool/*.{js,ts}` directories
- `packages/plugin/src/`: `index.ts` (core), `shell.ts` (shell tools), `tool.ts` (tool definitions), `tui.ts` (TUI hooks)
- **11 built-in plugins**: agent-memory, background, background-agents, context-analysis, direnv, dynamic-context-pruning, envsitter-guard, handoff, safety-net, smart-title
- Copilot/Codex auth plugins support
- Notification dispatch: macOS, Slack, Discord

### TUI Plugin Package (`packages/nikcli-plugins/`) — **NEW**

External TUI plugin package using OpenTUI SolidJS components:

- **Import pattern**: `import { TuiPlugin, usePlugin, useSlot, useDialog } from "@nikcli-ai/plugin/tui"` + OpenTUI from `@opentui/solid`
- **Theme files**: JSON format with RGBA color values (e.g., `{ "current": { "primary": [255,149,0,1] } }`)
- **Key patterns**: KV store for persistence, `createSignal` for state, `createEffect` for side effects, `onMount`/`onCleanup` for lifecycle

**Known OpenTUI component constraints** (props that DO NOT exist at runtime):

- `<text>`: no `bold`, `fontSize`, `textWrap`, `textStyle`, `flex`, `borderDirection`, `borderTop`, `borderColor`, `onClick`, `fontFamily`, `fontStyle`
- `<box>`: no `borderTop`, `borderColor`, `overflow`, `paddingY`, `fg` (apply `fg` on child text elements instead)
- `attributes` prop expects number (bitmask), not string array — remove or use `@ts-ignore`
- No `flexGrow` prop
- `<input>` requires `type` property
- Dialog uses `content`/`footer` slots, not `title`/`body`
- `useKeyboard` events use `code` property, not `key`
- `useTerminalDimensions` for responsive layouts

**Plugins created** (2026-04-25): music (Spotify OAuth), greet (KV storage + ASCII gallery), matrix (rain animation), starwars (ASCII art), weather (wttr.in), win95, pomodoro, calcio, pills, crypto

### Connectors (`src/connectors/`)

- **5 API implementations**: Figma, GitHub, Lovable, Slack (each in `api/*.ts`)
- Auth, cache, credentials, registry modules
- Status schema (discriminated union): connected, disabled, failed, needs_auth
- Tool creation via `createTools()`, health checks, prompts
- Connector tools exposed via `use-connector` tool in registry

### Other Notable Modules

- `src/mcp/` — MCP client with OAuth, auth flows, well-known discovery
- `src/rag/` — chunking (`chunk.ts`), embedding (`embed.ts`), vector storage (`storage.ts`), search
- `src/skill/` — loads `SKILL.md` from `.nikcli/skill/`, `.claude/skills/`, `.agents/skills/`
- `src/bus/` — pub/sub event bus (`bus-event.ts`, `global.ts`) with typed events
- `src/mobile/` — bearer token auth (`MobileAuth`), GitHub repo management
- `src/storage/` — file-based JSON with read/write locks, migrations
- `src/file/` — fff integration, `.gitignore` support, file watcher, time utilities
- `src/snapshot/` — git snapshot management for reverts
- `src/share/` — session sharing to enterprise endpoint
- `src/shell/` — shell execution management
- `src/pty/` — pseudo-terminal support (bun-pty)
- `src/lsp/` — Language Server Protocol integration
- `src/format/` — code formatting
- `src/command/` — custom command system with templates
- `src/installation/` — version management, install detection
- `src/flag/` — environment flag parsing
- `src/id/` — identifier generation (ascending/descending ULID-based)
- `src/global/` — global paths (home, state, config)
- `src/project/` — instance management, bootstrap, VCS (git), state
- `src/util/` — 27 utility modules (archive, color, context, defer, error, eventloop, filesystem, flock, fn, format, hash, iife, keybind, lazy, locale, lock, log, network, process, queue, record, rpc, scrap, signal, timeout, token, wildcard)
- `src/chatbot/` — chatbot handlers
- `src/docs/` — documentation context/library management
- `src/worktree/` — git worktree management
- `src/bun/` — Bun process utilities and tool registry
- `src/ide/` — IDE integration
- `src/opentui/` — OpenTUI TUI integration (render.ts, context.ts, app.ts, dialog.ts, toast.ts)

### Terminal QR Rendering (2026-09-15 Sessions)

- `packages/util/src/win32.ts`: `shouldUseAsciiQR` consults `terminalRendersHalfBlockQR(env)`. Windows alone is not sufficient to force ASCII: recognized modern terminals such as WezTerm and Windows Terminal support compact half-block rendering; unknown/conhost environments retain ASCII fallback.
- `packages/remote/src/qrcode.ts`: `generateQR` uses `shouldRenderCompactTerminalQR()` rather than a platform-only default. `packages/tui/src/component/qr.tsx` passes environment through `qrRenderMode`.
- Terminal-detection tests must inject explicit environments (including `{}` for legacy Windows), avoiding host `process.env` contamination. Keep the Windows pairing-link fallback even when compact rendering is available.
- The later pane-fit work adds `qrDialogBudget`, `qrFittedSize`, `qrImagePlacement`, `qrToPixelImage`, and a capability-gated Kitty image path. Both mobile-connect panels pass `maxColumns`/`maxRows` from the remaining pane budget rather than putting the QR in a scrollbox.
- Image placement uses cell aspect `cell.height / cell.width`; a 106-column by 24-row budget at aspect 2 yields a 48-column by 24-row square image. Cell-art fallback must retain the complete symbol rather than clip modules to fit.
- `QRCode` uses Solid `<Show>` for reactive image/cell-art switching; a one-time component-body `if (fitted().image)` does not track later changes.
- Verification recorded on 2026-09-15: initial detection change had 12 pass, 0 fail (44 assertions) and nikcli typecheck exit 0. Later pane-fit suite had 14 pass, 0 fail (62 assertions), exit 0. The transcript ends after starting TUI typecheck: no final result or visual Windows verification is recorded. Herdr/WezTerm capability details should be rechecked before extending detection.
- Targeted regression command: `bun test test/cli/mobile-pairing.test.ts` from `packages/nikcli`, not repository root.

### Mobile Package (`packages/mobile`)

- Expo Router with routes: `index.tsx`, `connect.tsx`, `(app)/`, `+not-found.tsx`
- Components: chat/, layout/, session/, settings/, ui/, BottomSheet, ConnectionStatus, DiffViewer, GlassView, GlobalErrorBoundary, MessageBubble, NetworkBanner, PermissionCard, RepoCard, SessionListItem, Skeleton, ToolCallView
- Hooks: `use-session-stream.ts`
- Lib: chat-types, client (centralized auth/endpoints), cn, haptics, notifications, offline, server-provider, storage, store, theme, types, animation
- TailwindCSS v3 with NativeWind
- iOS + Android native builds

**Mobile Client (`lib/client.ts`) — refactored (2026-04-30/05-01):**

- `parseMobileResponse()` — JSON error parsing with structured error extraction (`error`/`message`/`detail` fields), HTML detection, 204 handling
- `buildMobileHeaders()` — bearer token + Basic auth fallback from `ServerConfig.username/password`, directory header
- `buildMobileUrl()` — URL construction that preserved base path (e.g., `/nikcli` in server URL)
- `ptyConnectUrl()` — WebSocket URL with token + directory query params (fixes terminal WebSocket errors when session is not in `/app` root); WebSocket can't send custom headers so directory must be in query string
- Basic auth fields exist in `ServerConfig` but were historically ignored; now respected
- Singleton pattern with cache key comparison and invalidation

**Terminal (`assets/terminal.html` + `app/(app)/terminal/index.tsx`):**

- Copy/paste via RN → WebView messages (`copy`, `paste` types)
- `collectTerminalText()` — uses `window.getSelection()` first, falls back to `.term-row` text nodes, then `textContent`
- Both `window.message` and `document.message` listeners (Android RN WebView compatibility)
- Lifecycle state (`stopped` flag) declared before use; `clearLifecycleTimers()` on close/retry
- Timeout in `startConnectionTimeout()` fires in `connect()` (called after socket creation, after clearing prior timeout); `onclose` handles retry accounting
- `TerminalWebView` caches HTML at module level (`terminalHtmlPromise`) instead of re-reading per tab
- Toolbar: Copy/Paste/New/Close all buttons with `expo-clipboard`
- Only active WebView visible + `pointerEvents="none"` for hidden ones
- Resize debounced 80ms via `resizeTimersRef`

**Known mobile issues (pending fix):**

- `GitStatusBar.tsx:66` — `setPulseKeys(newPulseKeys)` called unconditionally inside effect that depends on `pulseKeys`, creating potential render/effect loop when `gitState` is present; fix: only call `setPulseKeys` inside `if (hasChanged)` block
- `use-session-stream.ts:83` dependencies — missing `input.config?.username` and `input.config?.password` in effect deps; switching Basic Auth credentials can leave SSE stream with stale/missing auth
- `sessions/editor.tsx:543` — mode focus logic uses stale `mode` check instead of computing `nextMode` first; `view→edit` transition misses focus, `edit→view` schedules focus on hidden input
- `sessions/editor.tsx:286` — trailing newline dropped from highlighted view; files ending with `\n` show fewer rendered rows than `lineNumbers`, causing line-number/content mismatch near EOF
- Theme tokens duplicated across `lib/theme.ts`, `global.css`, `tailwind.config.js`
- `lib/storage.ts` / `lib/store.ts` duplicate defaults
- `lib/haptics.ts` — await on every haptic, no throttling for rapid selection triggers
- `lib/animation.ts` — staggered animations recreate all `Animated.Value`s on `itemCount` change without preserving values or cleanup
- `lib/types.ts` — may drift from server bootstrap fields (especially `expo`/`mobileProject`)
- `lib/server-provider.tsx` — duplicates request/error logic from `MobileClient`

### Desktop Package (`packages/desktop`)

- Tauri v2 with Rust sidecar (`src-tauri/src/`): main, lib, cli, server, markdown, window_customizer, windows, constants, job_object
- 16 language translations in `src/i18n/`
- Auto-updater support
- Deep-link, dialog, notification, shell, store, updater Tauri plugins

## Build Commands

- `bun dev` — run nikcli in dev mode (`bun run --cwd packages/nikcli --conditions=browser src/index.ts`)
- `bun run typecheck` — `bun turbo typecheck`
- `bun run build` per package — e.g., `bun run script/build.ts` for nikcli core
- `bun run generate:httpapi-clients` from `packages/nikcli` - regenerate clients after HTTP contract edits.
- `bun test test/path/file.test.ts` from the relevant package - targeted tests; root `bun test` is deliberately blocked even with a package-relative file argument.
- `bun run test:ci` from `packages/nikcli` - full CLI suite, sharded across short-lived Bun processes with `--parallel=1` and isolation; do not replace with one `bun test` process.
- Turborepo tasks: `typecheck`, `build`, `test`
- `tsc --noEmit` — typecheck for nikcli core (native TypeScript 7 compiler)
- Husky pre-push hook configured
- CI deploy: `bun sst deploy --stage=<branch>` on `dev` and `production`
- `ci-pipeline` runs `script/ci-validate.ts`; the full nikcli suite is intentionally excluded because of memory growth. Keep the four targeted real-Windows suites in `windows-compat.yml`.
- Generated client drift, formatting, lint, and typecheck are blocking validation. Every publish path validates; release deploy depends on publish, which depends on validate.
- Railway `--detach` only confirms upload acceptance. Keep `check-railway-context.ts`, `check-docker-versions.ts`, and `railway-deploy.sh` preflight wired into validation; a missing required `RAILWAY_TOKEN` fails deployment.
- Release/publish workflow: builds CLI artifacts first, then Tauri desktop artifacts, then completes release
- Cross-platform CLI binary build matrix: `script/build.ts:22` (packages/nikcli)

## Build Agent Risks / Patterns

- **Root tests are blocked**: `bunfig.toml` redirects to `do-not-run-tests-from-root`; run targeted tests from the package and the full CLI suite via `test:ci`.
- **Bun version pin enforced on push**: mismatched local Bun will fail pre-push/typecheck
- **Generated HttpApi clients are blocking artifacts**: use the contract workflow in the Server and HTTP Contract section; do not hand-edit generated clients.
- **Infra split across multiple deploy surfaces**: SST/Cloudflare, direct Wrangler packages, Tauri desktop, Expo mobile, Railway SSH serve, Nix packaging — edits can have cross-target consequences
- **Nested manifests below declared workspace globs** (e.g., `packages/remote/web-client/package.json`) are internal/build-only, not first-class workspaces
- **Config loading is side-effectful**: reading config can trigger npm package installation logic; `src/config/config.ts:203`

## Install/Release System (`packages/web/install`, `packages/web/public/install.sh`)

Two install scripts exist with different feature sets:

- `packages/web/install` (cache-bust 2026-04-16): older, no `--local` flag, no GitHub `v` prefix fallback
- `packages/web/public/install.sh` (cache-bust 2026-01-31): newer, has `--local [dist-dir]` and `v` prefix fallback

Both support:

- Platform detection: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`
- Archive formats: `.tar.gz` (Linux), `.zip` (macOS/Windows)
- Special targets: `baseline` (no AVX2), `musl` (Alpine/musl libc)
- Version stripping: leading `v` stripped from `--version` argument
- Dual download: `nikcli-ai.dev` (primary) + GitHub (fallback)
- Shell support: fish, zsh, bash, ash, sh

Archive structure: top-level `bin/nikcli` (not nested in `nikcli-<target>/`)
Post-install: updates `/usr/local/bin/nikcli` if running as root on Unix.

**Important**: `packages/web/install` (served at `/install`) lacks the `--local` flag and GitHub `v` prefix fallback that `public/install.sh` has. Align before future releases.

Release archive naming: `nikcli-ai-<target>.<ext>` (e.g., `nikcli-ai-linux-x64.tar.gz`) — prefix comes from `pkg.name` (`nikcli-ai`) in `packages/nikcli/package.json` and is used by `script/build.ts` for dist dir names, by `script/release-github.ts` for archive names, and must match the `ASSET_PREFIX` in both `install` and `packages/web/public/install.sh`.
GitHub release tag format: `vX.Y.Z`; installer also accepts bare `X.Y.Z` as fallback for legacy tags.

## Workspace Catalog (shared dependency versions)

Key catalog-pinned deps: `ai: 5.0.119`, `hono: 4.10.7`, `zod: 4.1.8`, `solid-js: 1.9.10`, `vite: 7.1.4`, `tailwindcss: 4.1.11`, `typescript: 5.8.2`, `shiki: 3.20.0`, `marked: 17.0.1`, `remeda: 2.26.0`, `diff: 8.0.2`

- `packages/mobile/app/(app)/sessions/explorer.tsx` — debounced search without stale-result cancellation, no per-row loading state, silent expand failures
- `packages/mobile/app/(app)/sessions/editor.tsx` — renders all highlighted lines + line numbers in nested ScrollViews with whole-file TextInput; needs file-size guards and virtualized read-only rendering
- `packages/mobile/app/(app)/_layout.tsx` — chrome hidden via brittle `segments.length > 2` check (now `root === "sessions" && Boolean(child)` / `root === "settings" && Boolean(child)`)
- `packages/mobile/components/session/ComposerToolDrawer.tsx` — `connectedCount` computed as `mcpServers.filter(s => s.connected).length` (MCP servers only, not MCP tools)

## Spec Files (`specs/`)

Mobile/perf specs:

- `01-persist-payload-limits.md` — payload limit optimization
- `02-cache-eviction.md` — cache eviction strategy
- `03-request-throttling.md` — request throttling
- `04-scroll-spy-optimization.md` — scroll spy optimization
- `05-modularize-and-dedupe.md` — modularization + dedup
- `06-app-i18n-audit.md` — app i18n audit
- `07-ui-i18n-audit.md` — UI i18n audit
- `perf-roadmap.md` — performance roadmap
- `project.md` — project/session API design spec

`packages/nikcli/specs/` (the CLI/TUI/server package — separate from the mobile specs above):

- `integration-master-plan.md` - historical nine-epoch internal-refactor plan; current architecture sequencing follows `specs/README.md` and `specs/ROADMAP.md` per AGENTS.md.
- `ux-roadmap.md` — user-facing UX / TUI / onboarding roadmap. 14+ themes (A–N) of UX items, plus 8 real bugs (theme M) found during the audit. Companion to the integration plan.
- `tui-plugins.md`, `openapi-translation-cleanup.md` — targeted specs feeding the integration plan.
- `effect/MASTER-PLAN.md` — Effect-migration master plan (superseded by `integration-master-plan.md` for sequencing; kept for detail).
- `v2/` — v2 API surface, TUI keymaps, notifications, message-shape specs.

## Mobile Optimization Roadmap (2026-04-30 planner session — pending implementation)

9-phase plan for `packages/mobile` (app + components + lib):

1. Stabilize networking/auth — `lib/client.ts` centralization, `server-provider.tsx` / `use-session-stream.ts` sharing
2. Fix high-impact lifecycle/runtime bugs — terminal.html lifecycle, animation cleanup, haptics non-blocking, `_layout.tsx` route matching
3. Repair explorer — per-row loading, expand errors, stale search protection
4. Consolidate sheet/button primitives — shared `BottomSheet` chrome, normalize `ActionButton`
5. Decompose settings without route changes — extract section components, reuse from dedicated screens
6. Decompose session detail into hooks/views — `use-session-detail.ts`, `use-session-events.ts`, etc.
7. Add list/editor/terminal performance guards — file-size limits, FlatList, WebView tab limits
8. Normalize tokens, storage defaults, state components — single source of truth for themes/defaults
9. Final regression pass — typecheck + device testing

Key files per phase are documented in the session transcript (ses_21f8bfe60ffeDvGMYWXKqpyr4h). Note: `connectedCount` in `ComposerToolDrawer.tsx` currently uses MCP server connections only, not MCP tool connections (pending fix in Phase 4).
