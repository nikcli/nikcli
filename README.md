# Nikcli

> **Nikcli is a fork of [OpenCode](https://github.com/anomalyco/opencode)** — the open source coding agent. AI-powered development tool: CLI, TUI, server, web, mobile, bots.

Nikcli is a **fork of [OpenCode](https://github.com/anomalyco/opencode)**, the open source coding agent (the repo previously lived at `sst/opencode` — same project, same org). **All credit for the original project goes to the OpenCode authors and its community** — nikcli exists only because that work is open source, and every part of nikcli that came from OpenCode remains theirs.

This fork is maintained by **nikomatt69**. On top of the OpenCode base, nikcli adds new commands (`goal`, `routine`, `mobile`, `ads`, `heap`, `locale`, `brain-model` / `image-model` / `speak-model`, `workspace-serve`, …), ACP integration, the Loops/Goal/Routines system, mobile pairing with a dedicated Expo app, the web companion UI, multi-channel bots, the Session v2 engine, and Effect Schema throughout the HTTP contract.

> Nikcli is **not** affiliated with, endorsed by, or supported by the OpenCode project. Please report nikcli issues here, not upstream. Full credits, history, and the original license live in the upstream repository: [https://github.com/anomalyco/opencode](https://github.com/anomalyco/opencode).

- **Upstream project**: OpenCode — [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode)
- **Maintainer of this fork**: nikomatt69 — [GitHub](https://github.com/nikomatt69) · [X](https://x.com/nikomatt69)
- **Release**: see [GitHub Releases](https://github.com/nikcli/nikcli/releases/latest) · Package manager: `bun@1.4.2`
- **License**: MIT — see `LICENSE`, which retains the upstream OpenCode copyright.

---

## Table of contents

1. [What nikcli is](#what-nikcli-is)
2. [Installation](#installation)
3. [Build from source](#build-from-source)
4. [Quickstart](#quickstart)
5. [Monorepo architecture](#monorepo-architecture)
6. [CLI: all commands](#cli-all-commands)
7. [TUI: terminal user interface](#tui-terminal-user-interface)
8. [Agents and subagents](#agents-and-subagents)
9. [Toolset available to agents](#toolset-available-to-agents)
10. [Skills](#skills)
11. [Loops, Goal, Routines](#loops-goal-routines)
12. [Providers, models, connectors and MCP](#providers-models-connectors-and-mcp)
13. [Sessions, worktrees, sandboxes, sharing](#sessions-worktrees-sandboxes-sharing)
14. [Server, web, mobile, remote control](#server-web-mobile-remote-control)
15. [Bots and chat adapters](#bots-and-chat-adapters)
16. [Plugins, skills and TUI sub-plugins](#plugins-skills-and-tui-sub-plugins)
17. [Configuration](#configuration)
18. [Documentation and resources](#documentation-and-resources)
19. [Credits](#credits)

---

## What nikcli is

> Reminder: nikcli is a fork of [OpenCode](https://github.com/anomalyco/opencode). The architecture below — TUI, headless server, tool registry, session engine, plugin runtime — descends from OpenCode's design; credit for it belongs to the upstream project.

Nikcli is not just a CLI to chat with a model: it is a **complete agentic platform** that orchestrates models, tools, subagents and project context. Its main surfaces:

- **Interactive TUI** — a full-screen terminal application built on [OpenTUI](https://github.com/sst/opentui) and Solid.js: sessions, turn queues, history, autocomplete, permissions, modal dialogs, remote attach.
- **Headless server** — HTTP + SSE + WebSocket on Effect `HttpApi` and `Bun.serve`, with OpenAPI and a generated TypeScript/JavaScript SDK.
- **One-shot CLI** — non-interactive execution (`run`, `goal`, `mission`, `agent`, `generate`, `github`, `pr`, `stats`, `export` / `import`).
- **Web companion** — SolidStart/Cloudflare UI for sessions and sharing (`nikcli web`, `nikcli companion serve`).
- **Mobile companion** — Expo / React Native app in `packages/mobile` with QR pairing and `nikcli://` deep links.
- **Multi-platform bots** — unified adapter for Slack, Discord, Microsoft Teams, Google Chat, GitHub Issues, Linear.
- **Plugin runtime** — plugin installation with hot-reload for TUI, agents and tools (`nikcli plug install <mod>`).
- **ACP server** — implements the [Agent Client Protocol](https://github.com/zed-industries/acp) to integrate with external editors and IDEs (`nikcli acp`).
- **Missions** — high-altitude workflows that decompose a goal into milestones, each holding a DAG of features with a validation checkpoint per milestone (`nikcli mission`). Headless, server-side orchestrator.
- **Loops** — named, persisted workflows that run an ordered list of stages, each driven by a single `goal` command. Manage them through the TUI or HTTP/SDK; the headless LoopEngine keeps firing on schedule when the TUI is closed.
- **Observability** — OpenTelemetry (OTLP) trace export and a live in-process telemetry panel (configurable through `OTEL_EXPORTER_OTLP_ENDPOINT` and `NIKCLI_DISABLE_OTEL_LIVE`).

Everything is orchestrated by an internal **event bus**, a **SQLite/Drizzle persistence** layer, and a service architecture built with `Effect` (typed schema validation, dependency injection, layer composition).

---

## Installation

The install script downloads release binaries from `nikcli-ai.dev` with GitHub releases as fallback (`packages/web/install`).

**macOS / Linux**

```bash
curl -fsSL https://nikcli-ai.dev/install | bash
nikcli
```

**Windows** (PowerShell 5.1+ or pwsh 7+ — `curl | bash` needs a bash to pipe into, so use this instead):

```powershell
irm https://nikcli-ai.dev/install.ps1 | iex
nikcli
```

**Any platform** (npm, pnpm, yarn or bun):

```bash
npm i -g nikcli-ai@latest
```

The install location can be overridden with `NIKCLI_INSTALL_DIR` (or `XDG_BIN_DIR`); it defaults to
`~/.nikcli/bin` on every platform. The PowerShell installer also reads `NIKCLI_VERSION` to pin a version
and `NIKCLI_NO_PATH=1` to leave the user PATH alone.

Alternative install methods handled by `nikcli upgrade`:

```bash
nikcli upgrade --method curl    # standalone installer (install.ps1 on Windows)
nikcli upgrade --method npm     # npm package
nikcli upgrade --method pnpm
nikcli upgrade --method bun
nikcli upgrade --method brew    # macOS / Linux
```

> Requirements: Node.js or Bun runtime, Git for most VCS flows, `gh` CLI for `nikcli pr` and some GitHub integrations.

---

## Build from source

```bash
bun install
bun run --cwd packages/nikcli --conditions=browser src/index.ts
```

Useful development scripts:

| Script                                                   | Description                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `bun run dev`                                            | Start the nikcli CLI/TUI from source                           |
| `bun run typecheck`                                      | `bun turbo typecheck` across the whole workspace               |
| `bun run build`                                          | Build all packages                                             |
| `bun run web:dev`                                        | Dev server for the `packages/web` site                         |
| `bun run --cwd packages/nikcli generate:httpapi-clients` | Regenerate clients after modifying the Effect HttpApi contract |
| `cd packages/nikcli && bun run bench`                    | TUI bench (`test/bench/viz.tsx`)                               |
| `cd packages/nikcli && bun run sandbox:vercel`           | Vercel sandbox smoke test                                      |

---

## Quickstart

```bash
nikcli                  # opens the TUI in the current directory
nikcli run "..."        # one-shot without TUI
nikcli quickstart       # 60s walkthrough for first-time users
nikcli doctor           # diagnostics: connectivity, config, providers
```

Connect an LLM provider:

```bash
nikcli auth login
# or select from the CLI/TUI with the dedicated dialog
```

Running `nikcli` with no arguments opens the **TUI**, which by default starts a local server in the background and connects to it via WebSocket/SSE. The TUI can also be attached to a remote instance:

```bash
nikcli serve --hostname 0.0.0.0 --port 4096
nikcli attach http://other-host:4096
```

---

## Monorepo architecture

Bun workspace with centralized version catalog (`bunfig.toml`, `package.json`).

| Package                                      | Role                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/nikcli`                            | Core CLI/TUI/server — main application (`@nikcli-ai/cli`, `nikcli` binary)                    |
| `packages/sdk`                               | API SDK generated from OpenAPI (`@nikcli-ai/sdk` for JS, other languages in `packages/sdk/*`) |
| `packages/plugin`                            | Plugin system and hooks contract (`@nikcli-ai/plugin`)                                        |
| `packages/remote`                            | Tunnels, QR pairing, web client for remote attach                                             |
| `packages/companion`                         | Companion UI and companion server routes                                                      |
| `packages/terminal-control`                  | Terminal abstraction reused by CLI and IDE                                                    |
| `packages/mobile`                            | Mobile Expo / React Native app with realtime SSE                                              |
| `packages/app`                               | Main web app (SolidStart)                                                                     |
| `packages/web`                               | Documentation site + installer + landing (`nikcli-ai.dev`)                                     |
| `packages/desktop`                           | Tauri desktop app                                                                             |
| `packages/enterprise`                        | Enterprise SSO / multi-tenant build                                                           |
| `packages/cloud`                             | Cloudflare worker (KV, Durable Objects)                                                       |
| `packages/slack`                             | Slack Bolt adapter and health check                                                           |
| `packages/script`                            | Shared build/release scripts                                                                  |
| `packages/util`                              | Shared utilities (effect-zod, locale, log, retry, …)                                          |
| `packages/llm`                               | Additional AI SDK adapters (e.g. GitLab)                                                      |
| `packages/function`                          | FaaS helpers and queue workers                                                                |
| `packages/inference` · `inference-dashboard` | Inference telemetry and dashboard                                                             |
| `packages/console`                           | Administration panel                                                                          |
| `packages/webrenderer` · `tui-image`         | Experimental TUI renderers                                                                    |
| `packages/http-recorder`                     | HTTP recorder for test/replay                                                                 |
| `packages/containers`                        | Container bundles for deploy                                                                  |
| `homebrew-tap` · `infra` · `nix` · `script`  | Packaging and IaC                                                                             |

Internal layout of the core (`packages/nikcli/src`):

```
account/        # account management with device code
acp/            # Agent Client Protocol (editor ↔ nikcli)
agent/          # agent system, prompts, generate, subagents
analytics/      # local/aggregated telemetry
auth/           # provider credentials (keychain, file, OAuth)
background/     # background jobs (e.g. TTS, embeddings)
brain/          # brain scheduler (background reasoning)
bus/            # typed global event bus (BusEvent)
chatbot/        # multi-channel bot (chat adapter)
cli/            # command tree, bootstrap, network, UI helpers
command/        # command service (named commands invokable by agents)
config/         # typed config (jsonc) + project config + TUI config
connectors/     # connector service + creds (Linear, GitHub, Slack, …)
database/       # drizzle ORM + migrations
db/             # users, KV, accounts
delegation/     # background subagent runs
effect/         # Effect runtime, layer helpers
file/           # file abstraction (read/write/patch/tree)
filesystem/     # fs helpers
flag/           # environment-variable flags (incl. OTEL/NIKCLI_*)
format/         # formatter (prettier, biome, oxc, …)
git/            # local git operations (status, diff, worktree)
global/         # global paths (~/.config/nikcli)
ide/            # editor integrations (VSCode, Cursor, Zed)
image/          # image tools
installation/   # version, install method, upgrade
interaction/    # user interactions (prompt, confirm, select)
locale/         # localization (language, region, timezone, currency)
loop/           # headless Loop engine (Scheduler + Goal composition)
lsp/            # LSP client for diagnostics and goto
mcp/            # Model Context Protocol (server + client)
mission/        # headless Mission orchestrator (milestones / features / validation)
mobile/         # mobile routines, auth, project detect
monitor/        # background command runner (persistent output)
observability/  # OpenTelemetry (OTLP) export + live telemetry panel
patch/          # unified patch engine
permission/     # permission system (rules, evaluate, ask)
plugin/         # plugin loader and contract
project/        # project, instance, VCS, bootstrap
prompt/         # prompt composition and variants
provider/       # provider registry, auth, transform, models
pty/            # pseudo-terminal reused by the bash tool and TUI
question/       # interactive questions
sandbox/        # sandbox runner (Vercel, Docker, local)
scheduler/      # cron-like scheduler (basis of Loops)
session/        # messages, compaction, revert, prompt, v2
share/          # public/enterprise session sharing
shell/          # shell detection
skill/          # skill discovery and execution
snapshot/       # heap/process snapshot
storage/        # abstract KV/storage
sync/           # workspace sync (projects ↔ server)
tool/           # tool registry (read, write, bash, webfetch, …)
util/           # utilities (log, id, locale, retry, error, …)
workspace/      # multi-project workspace + event server
worktree/       # git worktree management
```

---

## CLI: all commands

All main commands (registered in `packages/nikcli/src/cli-main.ts`):

| Command                                                                       | Purpose                                                                                               |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------- | ------------------------------------ |
| `nikcli`                                                                      | Default: opens the TUI.                                                                               |
| `nikcli run [message..]`                                                      | Runs a one-shot prompt non-interactively; supports model variants, agent, session, fork, attachments. |
| `nikcli goal [condition..]`                                                   | Works autonomously until a verifiable condition holds (Goal engine with budget and persistent state). |
| `nikcli mission`                                                              | Headless Mission orchestrator: new, start, pause, resume, cancel, get, list.                          |
| `nikcli routine`                                                              | Create / list / get / run / pause / resume / delete routines (cron + API trigger).                    |
| `nikcli generate`                                                             | Prints the server OpenAPI spec with JS SDK samples.                                                   |
| `nikcli acp`                                                                  | Starts an ACP (Agent Client Protocol) server for external editors.                                    |
| `nikcli mcp`                                                                  | Manage MCP servers: add, OAuth auth, list, status, debug.                                             |
| `nikcli tui` (default) · `nikcli attach <url>`                                | Local TUI or attach to a remote server.                                                               |
| `nikcli serve`                                                                | Starts a headless Effect HttpApi server (HTTP + SSE + WebSocket) with OpenAPI.                        |
| `nikcli web`                                                                  | Starts the server and opens the web UI in the browser.                                                |
| `nikcli workspace-serve`                                                      | Starts the multi-workspace event server (proactive sync).                                             |
| `nikcli companion serve`                                                      | Server with integrated companion UI (also accessible from mobile).                                    |
| `nikcli remote start` / `remote status`                                       | Remote control of the session (localtunnel / cloudflared / ngrok / remotosh tunnel, cloud relay).     |
| `nikcli mobile`                                                               | Mobile pairing: QR + deep link, host server for the device.                                           |
| `nikcli chat` (`chatbot`)                                                     | Starts a bot on Slack / Discord / Teams / Google Chat / Linear / GitHub.                              |
| `nikcli auth`                                                                 | Provider credentials: login / logout / list / set / get / remove with device code.                    |
| `nikcli account`                                                              | nikcli cloud account (login, logout, list, switch, orgs).                                             |
| `nikcli agent create` / `agent list`                                          | Generate (via LLM) or list custom agents.                                                             |
| `nikcli models [provider]`                                                    | List models from `models.dev`, refresh cache, filter by provider.                                     |
| `nikcli brain-model` · `image-model` · `speak-model`                          | Configure brain, image-gen and TTS models.                                                            |
| `nikcli locale [show                                                          | set                                                                                                   | reset]` | Set language/region/timezone/currency and the model reply language. |
| `nikcli stats` · `nikcli usage` · `nikcli ads`                                | Local metrics, session/project cost, configurable ads.                                                |
| `nikcli heap`                                                                 | Show process memory metrics (rss, heap, external, arrayBuffers).                                      |
| `nikcli session list`                                                         | List and manage saved sessions (with pager).                                                          |
| `nikcli export [sessionID]`                                                   | Export a session as JSON (info + messages + parts).                                                   |
| `nikcli import <file>`                                                        | Import a session from JSON or a share URL.                                                            |
| `nikcli share` (via TUI)                                                      | Generate a public/enterprise URL for the session.                                                     |
| `nikcli github install` · `nikcli github run`                                 | Install and manage a GitHub App for automations.                                                      |
| `nikcli pr <number>`                                                          | Check out a PR and auto-start a review session.                                                       |
| `nikcli plug` (`plugin`)                                                      | Install and manage plugins (npm mod or local path) with config patching.                              |
| `nikcli connectors`                                                           | Manage connectors (Linear, GitHub, Slack, Notion, …) with dedicated auth.                             |
| `nikcli quickstart` · `nikcli doctor` · `nikcli upgrade` · `nikcli uninstall` | Onboarding, diagnostics, upgrade, uninstall.                                                          |
| `nikcli completion`                                                           | Generate shell completion scripts.                                                                    |
| Global flags                                                                  | `--print-logs`, `--log-level DEBUG                                                                    | INFO    | WARN                                                                | ERROR`, `--help/-h`, `--version/-v`. |

### Auto-approving permissions

`--auto` (aliases `--yolo`, `--dangerously-skip-permissions`) stops nikcli from pausing for
permission confirmations. Intended for unattended runs — CI, scripted sessions, sandboxed
worktrees — where there is nobody to answer a prompt.

It converts every `ask` into `allow`. It does **not** override anything you explicitly set to
`deny`: a denial is a rail you deliberately put in place, and a flag named "skip permissions"
should not quietly remove it. Combine the flag with `permission` denials in your config to run
unattended while keeping specific operations off-limits:

```jsonc
// nikcli.json
{ "permission": { "bash": { "rm *": "deny", "git push *": "deny" } } }
```

```sh
nikcli --auto run "migrate the config loader to zod v4"
```

The flag applies to the whole process, including the session worker the TUI runs in.

### OpenTelemetry / observability flags

These environment variables configure the observability layer described in the
[Observability docs](https://nikcli-ai.dev/docs/observability). They are read at process start
and are not hot-reloadable.

| Variable                      | Default | Purpose                                                             |
| ----------------------------- | ------- | ------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset   | OTLP/HTTP endpoint. Setting it enables export.                      |
| `OTEL_EXPORTER_OTLP_HEADERS`  | unset   | Comma-separated `key=value` pairs (e.g. `Authorization=Bearer%20…`) |
| `OTEL_RESOURCE_ATTRIBUTES`    | unset   | Comma-separated `key=value` pairs merged into every span resource.  |
| `NIKCLI_DISABLE_OTEL_LIVE`    | `false` | Opt out of the in-process span capture (live panel).                |

---

## TUI: terminal user interface

The TUI (`packages/nikcli/src/cli/cmd/tui`) runs in a dedicated worker (`worker.ts`) that talks to the server via RPC + SSE. It is built on `@opentui/core` and `@opentui/solid` (45 FPS renderer, mouse, kitty keyboard, copy-on-select) and on `@solid-primitives/*` for storage, event-bus and scheduling.

### Main areas (routes)

- **Home** — landing screen with prompt, tips, ads and MCP status.
- **Session** — detailed view: messages, subagent footer, timeline, fork, permissions, interactions, todo, contextual sidebar.
- **Workspace** — multi-project with sidebars for files, todo, MCP, LSP, context.
- **Tree** — tree visualization of files/sessions with activity rows.
- **Changes** — modified files with comments and header (PR-like review).
- **Git graph** · **GitHub** — commit graph visualization and integrated PR/issue view.
- **Workspace create / list / unavailable** — workspace management.

### Main dialogs

`dialog-model`, `dialog-mcp`, `dialog-routine`, `dialog-status`, `dialog-usage`, `dialog-theme-list` / `create`, `dialog-settings`, `dialog-config`, `dialog-help`, `dialog-tour`, `dialog-support`, `dialog-command` (command palette), `dialog-agent`, `dialog-advisor-model`, `dialog-skills`, `dialog-session-list` / `warp` / `delete-failed` / `rename`, `dialog-workspace-list` / `create` / `file-changes` / `unavailable`, `dialog-variant` (model effort selection), `dialog-stash` (prompt queue), `dialog-tag`, `dialog-login`, `dialog-onboarding`, `dialog-auth-manage`, `dialog-chat` (quick chat), `dialog-analytics`, `dialog-web-preview`, `dialog-image-model`, `dialog-speak-model`, `dialog-status`, `dialog-telemetry-live` (live OpenTelemetry spans), `dialog-opentelemetry` (OTLP configuration), `dialog-remote` (tunnel status), `dialog-provider` (provider picker), `plugin-route-missing` (fallback for missing plugin routes).

### Cross-cutting features

- **Advanced prompt** — history with arrow keys, frecency, stash, contextual completion, customizable keymaps (`textarea-keybindings.ts`), sounds (`cli-sound`).
- **Granular permissions** — `PermissionNext` system with rules per tool, path, command; `arity` evaluation (1st, 2nd, 3rd degree); contextual TUI prompts.
- **Multiple sessions** — sidebar with fuzzy search (`fuzzysort`), warp (quick jump), delete-failed handling.
- **Integrated worktrees** — create/switch git worktrees without leaving the TUI.
- **Status indicator** — idle, running, blocked, usage_limited, budget_limited.
- **Theming** — custom themes with creator/list dialog, KV persistence.
- **Audio cues** — sound notifications on important events (`util/sound`).
- **Image preview** — inline rendering of generated images (`tui-image`).
- **TUI plugin system** — the TUI is extensible via `feature-plugins/` (home, loops, sidebar, system) and runtime plugins that can mount new slots, routes, and keymaps.

### TUI = server client

The TUI can run as a client to a remote server (`nikcli attach`), so the same interface can control sessions on a different machine (workstation ↔ cloud server, etc.).

---

## Agents and subagents

The agent system (`packages/nikcli/src/agent/`) defines the LLM behavior, the exposed tools, the permissions and the mode (`primary` / `subagent` / `all`).

### Primary agents (built-in)

- `build` — agent with full permissions (`edit`, `bash`, `write`, web, …), primary mode. Default agent for "build anything" use.
- `plan` — read-only agent: can analyze code, do research, but cannot modify files or perform side-effects. Primary mode.

### Specialized subagents (built-in)

- `general` — generic fallback.
- `explore` — code search and mapping (read-only).
- `@fast-explore` — ultra-fast variant for light navigation.
- `@planner` — produces structured action plans.
- `@code-reviewer` — cognitive PR/diff review.
- `@debugger` — failure/log analysis and fix hypotheses.
- `@test-runner` — test execution/analysis, case generation.
- `@refactor` — conservative refactoring.
- `scout` — external exploration (libraries, APIs).
- `researcher` — evidence-based research in the background.
- `support` — documentation agent, read-only.
- `ultrareview-reviewer` — parallel reviewer for ultrareview.
- `delegator` — batch delegation with supervisor session.

> `build` and `plan` are primary. Subagents are invoked by the primary via the `task` tool or through the `delegation` / `delegator` tools with supervised parallel execution.

### Custom agents

`nikcli agent create` uses a meta-prompt (`agent/generate.txt`) to generate an agent from a description, picking the identifier, system prompt, enabled tools and mode. The resulting file is a Markdown with frontmatter saved to `~/.config/nikcli/agent/` or to the project's `.nikcli/agent/`. `nikcli agent list` shows the resolved list with the effective permissions.

### Modes

- `primary` — user entrypoint only.
- `subagent` — invokable only by other agents.
- `all` — both roles.

### Delegation runtime

The `delegation` and `delegator` tools let the primary agent start subagents in the background with a `delegation_id` and keep working; on completion, a supervisor session synthesizes the results. The `task` tool runs synchronous subagents.

---

## Toolset available to agents

Tools are registered in `packages/nikcli/src/tool/`:

| Tool                                                                             | Purpose                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `read` · `write` · `edit` · `multiedit` · `apply_patch`                          | File I/O with unified diff and safe patch.                                                                                            |
| `ls` · `tree` · `glob` · `grep` · `codesearch`                                   | Search and listing.                                                                                                                   |
| `bash` · `monitor`                                                               | Shell execution: `bash` for short commands, `monitor` for builds/tests/typecheck/dev servers with persistent logs and wake-on-finish. |
| `task` · `delegation` · `delegator`                                              | Subagent orchestration.                                                                                                               |
| `todowrite` · `todoread` · `goal`                                                | Todo list and Goal engine management.                                                                                                 |
| `webfetch` · `websearch`                                                         | Content retrieval and web search.                                                                                                     |
| `plan` · `plan-enter` · `plan-exit`                                              | Explicit plan mode (read-only enforcement).                                                                                           |
| `skill`                                                                          | Load and execute a declarative skill.                                                                                                 |
| `apply_patch` · `batch`                                                          | Multi-file patch.                                                                                                                     |
| `invalid`                                                                        | Fallback for malformed calls.                                                                                                         |
| `context_collect` · `context_related` · `context_diagnostics` · `context_search` | Context helpers (LSP, related, diagnostics).                                                                                          |
| `lsp`                                                                            | LSP operations (definitions, references, hover, symbols, completion, call hierarchy, implementations).                                |
| `question`                                                                       | Interactive multi-choice questions (UI).                                                                                              |
| `generate_image`                                                                 | Image generation (OpenRouter `gpt-5-image`, `nano-banana-pro-2.5`).                                                                   |
| `speak` (and providers `elevenlabs`, `openrouter`)                               | TTS voice synthesis played on the device.                                                                                             |
| `voice`                                                                          | Speech-to-text (OpenRouter transcription).                                                                                            |
| `mcp-exa`                                                                        | Preconfigured Exa MCP (search/extract).                                                                                               |
| `memory_search`                                                                  | Search across sessions/projects memory.                                                                                               |
| `repo_clone` · `repo_overview`                                                   | Clone/overview external repos.                                                                                                        |
| `search_tools`                                                                   | Tool discovery (including TUI plugin slots).                                                                                          |
| `external-directory`                                                             | External path validation.                                                                                                             |
| `exec_code`                                                                      | Controlled code execution (sandbox).                                                                                                  |
| `truncation` · `truncation-dir`                                                  | Output truncation to avoid context saturation.                                                                                        |
| `opentui` · `chart-braille-line`                                                 | OpenTUI/chart render in-terminal.                                                                                                     |
| `advisor`                                                                        | Background strategist for complex decisions.                                                                                          |

Each tool has a description in `tool/<name>.txt` consulted by the primary agent for selection.

---

## Skills

**Skills** (`packages/nikcli/src/skill/`) are Markdown + script packages (e.g. `computer-use`, `orca-cli`, `effect`, `opentui`, `bun-file-io`, `orchestration`, `find-skills`, `emil-design-eng`, …) that inject specialized instructions, hooks, and extra tools. They are dynamically loaded and filtered against the agent permissions. The `skill` tool lets the agent invoke them explicitly.

---

## Loops, Goal, Routines, Missions

Nikcli ships four continuous-orchestration primitives:

- **Goal** (`session/goal.ts`, `nikcli goal` command) — the agent works **until** a verifiable condition holds, with state `active | paused | blocked | usage_limited | budget_limited | complete`, token budget and iteration count (`MAX_ITERATIONS = 50`).
- **Loops** (`loop/engine.ts` + TUI `feature-plugins/loops`) — a loop is a named, persisted workflow that runs an ordered list of stages, each driven by a single `goal` command. Triggers are manual or interval (`Scheduler` with `scope: "instance"`). It keeps running even when the TUI is closed thanks to the server-side engine. The user defines objective + trigger + stop conditions once.
- **Missions** (`mission/orchestrator.ts` + TUI `feature-plugins/mission`) — a higher-altitude workflow that decomposes a goal into milestones, each holding a DAG of features, with a validation checkpoint at the end of every milestone (`scrutiny`, `user-test`, or `none`). The orchestrator drives one feature at a time as a `goal` command, then runs a validation worker before advancing.
- **Routines** (`mobile/routine.ts`, `nikcli routine` command) — workflows scheduled (cron) or triggerable via API/HTTP, with auth tokens. They expose nikcli procedures as endpoints.

> These primitives compose existing tools (`Scheduler`, Goal, `task`, `delegation`): nothing is reinvented, only orchestrated.

---

## Providers, models, connectors and MCP

### LLM providers

Registry in `packages/nikcli/src/provider/`. Integrated AI SDK adapters: **Anthropic, OpenAI, Azure OpenAI, Google, Google Vertex, AWS Bedrock, Groq, Mistral, Cohere, xAI (Grok), Cerebras, DeepInfra, Perplexity, Together AI, OpenRouter, Vercel AI Gateway, GitLab AI Provider, OpenAI-compatible**. Custom adapters also included for **GitHub Copilot, OpenAI Codex, Cloudflare AI, Cursor**.

For each provider:

- Models (synced with `models.dev` via `provider/models.ts`).
- Prompt/stream transformations (`provider/transform.ts`).
- Auth flow (`provider/auth.ts`).

Commands:

```bash
nikcli auth login
nikcli models                  # all models
nikcli models openai --verbose
nikcli brain-model             # model for the "brain" (background reasoning)
nikcli image-model openrouter openai/gpt-5-image
nikcli speak-model elevenlabs YOq2y2Up4RgXP2HyXjE5
```

### Multimodal models

- **Image**: `gpt-5-image` (OpenAI), `nano-banana-pro-2.5` (Google) — via OpenRouter.
- **TTS**: ElevenLabs (high quality) and OpenRouter (OpenAI TTS, `gpt-audio-mini`).
- **STT**: OpenRouter transcription.

### MCP (Model Context Protocol)

First-class MCP server with OAuth auth (`packages/nikcli/src/mcp`):

- `nikcli mcp add <name> <url-or-cmd>`: adds a server.
- `nikcli mcp auth <name>`: dedicated OAuth flow.
- `nikcli mcp list` · `status` · `debug`.
- MCP tools are exposed as native tools in the agent (registered in `tool/registry.ts`).
- Preconfigured MCP: **Exa** (`mcp-exa`).

### Connectors

`packages/nikcli/src/connectors/` manages third-party integrations with dedicated credentials and auth (GitHub, GitLab, Linear, Slack, Notion, Jira, …). Commands `nikcli connectors` (add, list, auth, status) with both CLI and TUI support. Each connector exposes an API reused by the agent tools.

---

## Sessions, worktrees, sandboxes, sharing

### Sessions

`session/` defines `Session.Info`, `MessageV2`, parts (text, tool-call, file, patch, image, subagent, …), compaction, revert/unrevert, fork, retry, summary, and a v2 engine (`session/v2`) rolling out. Storage is SQLite via Drizzle (`session.sql.ts`).

### Worktrees

`worktree/` manages managed and unmanaged git worktrees to isolate sessions per branch.

### Sandboxes

`sandbox/` lets you run tools in isolated environments: **Vercel Sandbox** (`@vercel/sandbox`), Docker containers, local execution. Sessions can be associated with a sandbox for real isolation.

### Sharing

`share/` and `share-next.ts` generate public/enterprise URLs to read sessions. `nikcli export` and `nikcli import` allow JSON serialization. The `nikcli import` command also accepts share URLs, normalizing enterprise hosts (`nikcli-ai.dev`, `*.dev.nikcli-ai.dev`).

### Loop, Background, Brain

- `background/` — long-running jobs with monitoring.
- `brain/` — brain scheduler that produces background reasoning with a dedicated model (`BRAIN_SESSION_TITLE`), used by the TUI for titles/tips.

### Permission system

`permission/next.ts` + `evaluate.ts` + `schema.ts` with rules per tool/agent/path/command, 3-tier evaluation (`arity.ts`). The TUI asks for confirmation contextually.

### Sync / Workspace

`sync/` and `workspace/` keep projects and sessions in sync on multi-workspace servers. `nikcli serve` and `nikcli workspace-serve` expose event servers; MCP and mobile clients consume via SSE.

---

## Server, web, mobile, remote control

### HTTP/SSE/WebSocket server

`packages/nikcli/src/server/server.ts` owns the listener and request pipeline. The contract lives in `src/server/httpapi/`:

- **Effect `HttpApi`** groups plus raw handlers on `Bun.serve`. OpenAPI and the generated clients come from `PublicApi`.
- **Clients** — `bun run generate:httpapi-clients` writes `@nikcli-ai/sdk/httpapi` and the in-process Effect client. There is no Hono app and no hey-api step.
- **Routes** — session, file, pty, mcp, connectors, mobile, provider, config, permission, loop, question, global, tui, experimental, users, workspace, …
- **SSE** for realtime events to the TUI, mobile, web (`EventFeed`).
- **WebSocket** for PTY connect.
- **mDNS** (`server/mdns.ts`) with `bonjour-service` for local discovery.
- **Proxy** (`server/proxy.ts`) to route to container/sandbox instances.
- **Auth**: optional basic auth, `NIKCLI_SERVER_PASSWORD`, `NIKCLI_SERVER_TAILSCALE_AUTH` to trust Tailscale headers on loopback.

### Web apps

- `packages/web` (Astro + Tailwind) — public site, install script, docs (hosted on Cloudflare Pages).
- `packages/app` (SolidStart) — full web application.
- `packages/companion` — companion UI and server routes for `nikcli companion serve`.

### Mobile companion

- `packages/mobile` (Expo / React Native) with realtime SSE, iOS and Android support (`ios/`, `android/`, `eas.json`).
- Installing a release build: [`packages/mobile/README.md`](packages/mobile/README.md). Android ships a plain `.apk`; iOS ships an **unsigned** `.ipa` that you re-sign yourself with SideStore/Sideloadly, because the project has no Apple Developer Program membership.
- Pairing: `nikcli mobile` shows a QR + deep link `nikcli://connect?server=...&token=...&directory=...`.
- `MobileAuth` server-side (`packages/nikcli/src/mobile/auth.ts`) handles tokens, device id, scope.

### Remote control

- `nikcli remote start` opens a tunnel (localtunnel, cloudflared, ngrok, **remotosh**) or uses the **cloud relay** (`--cloud`) with bearer token.
- `nikcli remote status` shows tunnel state.
- `packages/remote` contains the web client and QR renderer (`qrRenderer`, `tunnelProvider`, `cloudService`).
- `packages/terminal-control` abstracts the terminal session across CLI, TUI and agents.

---

## Bots and chat adapters

`packages/nikcli/src/chatbot/` orchestrates multi-platform bots thanks to `@chat-adapter/*`:

- **Slack** (`packages/slack`, deployed on `slack.nikcli-ai.dev` via Wrangler).
- **Discord Gateway** (`packages/discord`, `@nikcli-ai/discord`) — native Gateway bot. In the TUI, `/discord` (alias `/discord-setup`) walks through the bot token, invite URL, and start/stop. HTTP: `GET /discord`, `POST /discord/setup`, `/start`, `/stop`.
- **Discord webhooks** (`@chat-adapter/discord`) — the Chat SDK adapter, managed with `/bots`.
- **Microsoft Teams** (`@chat-adapter/teams`).
- **Google Chat** (`@chat-adapter/gchat`).
- **GitHub Issues** (`@chat-adapter/github`).
- **Linear** (`@chat-adapter/linear`).
- In-memory state persistence (`@chat-adapter/state-memory`).

Unified command:

```bash
nikcli chat          # configure and start the Chat SDK bot
nikcli chatbot       # alias
```

In the TUI, `/discord` sets up the Discord Gateway bot (token, invite, start). `/bots` manages Chat SDK webhook adapters.

Bot sessions are full nikcli sessions: prompt, tools, MCP, connectors, history.

---

## Plugins, skills and TUI sub-plugins

### Plugins (in-process)

`packages/nikcli/src/plugin/` supports plugins that add:

- Agents (Markdown files with frontmatter `mode` + `tools`).
- Tools (entries in `tool/registry.ts`).
- Hooks (`@nikcli-ai/plugin` exports a hook system: `auth`, `chat.headers`, `chat.params`, `tool.execute.before`, `tool.execute.after`, `experimental.session.compacting`, `experimental.text.complete`, `command.execute.before`, …).
- LLM providers.
- TUI plugins (route, slot, keymap, asset).

Install:

```bash
nikcli plug install @nikcli-ai/plugin-foo
nikcli plug list
nikcli plug remove @nikcli-ai/plugin-foo
```

Preconfigured plugins (`packages/plugin/plugins`):

- `agent-memory` · `background` · `background-agents` · `context-analysis` · `direnv` · `dynamic-context-pruning` · `envsitter-guard` · `handoff` · `safety-net` · `smart-title`.

### Skills

Skills (above) are a lighter format: just Markdown with a description and associated tools.

### TUI sub-plugins

The TUI feature-plugins (`feature-plugins/home`, `loops`, `sidebar`, `system`) are declarative extension points to mount views/components without patching the core. The `tui/plugin/` system provides `api.tsx`, `runtime.ts`, `slots.tsx`, `keymap.ts`, `internal.ts`.

---

## Configuration

Config resolution (in order of increasing priority):

1. **Remote**: `/.well-known/nikcli` for public OAuth providers.
2. **Global**: `~/.config/nikcli/nikcli.jsonc` (or `nikcli.json`, `config.json`).
3. **Custom**: env vars `NIKCLI_CONFIG` (path) or `NIKCLI_CONFIG_CONTENT` (string).
4. **Project**: `nikcli.jsonc` or `nikcli.json` walking up the directory tree.

Schema published at: [https://nikcli-ai.dev/config.json](https://nikcli-ai.dev/config.json)

Minimal example:

```jsonc
{
  "$schema": "https://nikcli-ai.dev/config.json",
  "theme": "nikcli",
  "provider": {
    "openai": { "options": { "apiKey": "sk-..." } },
  },
  "agent": {
    "build": { "model": "anthropic/claude-sonnet-4.5" },
    "plan": { "model": "anthropic/claude-haiku-4.5" },
  },
  "mcp": {
    "exa": { "type": "remote", "url": "https://mcp.exa.ai/mcp" },
  },
}
```

Useful sub-configs:

- `theme`, `keybinds`, `tui` — TUI look/feel and behavior.
- `provider.<id>.models` — pin models per provider.
- `agent.<name>` — model, prompt, tools, permission.
- `permission` — global rules.
- `mcp` — MCP servers.
- `connectors` — connectors with creds.
- `compaction`, `share`, `experimental` — flags and limits.
- `ads` — custom ads/announcements for the TUI.
- `locale` — language/region/model reply language (`it-IT`, `Europe/Rome`, `EUR`, `reply-language: "it"`).

Recognized env flags (see `flag/flag.ts`): `NIKCLI_SERVER_PASSWORD`, `NIKCLI_SERVER_TAILSCALE_AUTH`, `NIKCLI_OPENROUTER_API_KEY`, `NIKCLI_ELEVENLABS_API_KEY`, `NIKCLI_GIT_BASH_PATH`, `NIKCLI_LOG_LEVEL`, etc.

---

## Documentation and resources

- **Site & docs**: [https://nikcli-ai.dev/docs](https://nikcli-ai.dev/docs)
- **Config schema**: [https://nikcli-ai.dev/config.json](https://nikcli-ai.dev/config.json)
- **Quickstart**: [https://nikcli-ai.dev/docs/quickstart](https://nikcli-ai.dev/docs/quickstart)
- **Web app**: [https://app.nikcli-ai.dev](https://app.nikcli-ai.dev)
- **Slack bot**: [https://slack.nikcli-ai.dev](https://slack.nikcli-ai.dev)
- **Upstream project (OpenCode)**: [https://github.com/anomalyco/opencode](https://github.com/anomalyco/opencode)
- **This fork**: [https://github.com/nikcli/nikcli](https://github.com/nikcli/nikcli)
- **Issue tracker & discussions**: GitHub repository.
- **Internal specs** (in `specs/`): start at `specs/README.md` and `specs/ROADMAP.md` for the Effect/TUI architecture program.
- **Changelog**: `CHANGELOG.md` (v1.5.0 — Effect Schema migration, Feb 2026 milestone).

Useful repository files:

- `AGENTS.md` — conventions for coding agents.
- `STYLE_GUIDE.md` — code style (function-first, no `let`, avoid `else`, single-word naming, prefer `Bun.*`).
- `CONTRIBUTING.md` · `SECURITY.md` · `DEPLOYMENT.md` · `SPEAK_SETUP.md` · `STATS.md`.
- `install` — bash install script.
- `Dockerfile` · `Dockerfile.serve` — container images.
- `sst.config.ts` · `fly.toml` · `railway.toml` · `wrangler.toml` — deploy configs.

---

## Credits

Nikcli is a fork of **[OpenCode](https://github.com/anomalyco/opencode)**, the open source coding agent
(the repo previously lived at `sst/opencode`). The core architecture, the terminal-first
product idea, and a large share of the code in this repository originate there. Thanks to the OpenCode
authors, maintainers, and contributors for releasing it under a permissive license.

Nikcli is an independent fork, not affiliated with or endorsed by the OpenCode project. Any bug you hit
in nikcli should be reported to this repository, never upstream.

## License

MIT — see `LICENSE`. The license file retains the upstream OpenCode copyright alongside the
copyright for this fork's changes.
