---
name: nikcli-skill
description: |
  Comprehensive guide for working with the nikcli codebase - a Bun-based coding agent with TUI, HTTP server, mobile app, and multi-provider LLM support.
---

# nikcli Codebase Skill

Deep knowledge of the nikcli monorepo for effective development, debugging, and feature implementation.

## Quick Reference

### Key Commands

| Command                             | Purpose                        |
| ----------------------------------- | ------------------------------ |
| `bun run dev`                       | Run nikcli in development mode |
| `bun run typecheck`                 | Type-check the codebase        |
| `bun test`                          | Run test suite                 |
| `bun run build`                     | Build for production           |
| `./packages/sdk/js/script/build.ts` | Regenerate JavaScript SDK      |

### Critical Files

| File                                       | Role                                 |
| ------------------------------------------ | ------------------------------------ |
| `packages/nikcli/src/index.ts`             | CLI entrypoint, command registration |
| `packages/nikcli/src/server/server.ts`     | Listener + request pipeline          |
| `packages/nikcli/src/session/index.ts`     | Session engine core                  |
| `packages/nikcli/src/session/llm.ts`       | LLM request path                     |
| `packages/nikcli/src/tool/registry.ts`     | Tool registration                    |
| `packages/nikcli/src/config/config.ts`     | Configuration merge logic            |
| `packages/nikcli/src/provider/provider.ts` | Provider registry                    |
| `packages/nikcli/src/permission/next.ts`   | Permission evaluation                |
| `packages/nikcli/src/database/database.ts` | Central `nikcli.db` runtime          |
| `packages/nikcli/src/mcp/index.ts`         | MCP client lifecycle                 |
| `packages/nikcli/src/plugin/index.ts`      | Server plugin runtime                |

## Architecture Overview

### Package Structure

```
packages/
├── nikcli/          # Core CLI, TUI, server, sessions, tools
├── sdk/             # Generated JavaScript client
├── mobile/          # Expo companion app
├── studio/          # Desktop UI
├── plugin/          # Plugin system
├── remote/          # Remote execution
├── companion/       # Companion services
├── browser-control/ # Browser automation engine
├── computer-use/    # Desktop automation engine
└── terminal-control/# Terminal automation engine
```

### Runtime Flow

```
nikcli (default) → TUI Thread → Session Worker → Provider → Tools
nikcli run [msg]  → One-shot agent execution
nikcli serve      → HTTP server mode
nikcli mobile     → Mobile host API
```

### Instance Model

Services are scoped to project instances:

- **Global paths**: data, config, cache, state, log, bin, repos
- **Project instance**: current directory, worktree, lifecycle
- **Config layers**: remote → global → custom → project → env → directories

## Development Guide

### Running Locally

```bash
# Development with hot reload
cd packages/nikcli
bun run dev

# Type-check entire monorepo
bun run typecheck

# Run tests
bun test

# Build for production
bun run build
```

### Code Organization

#### Session System (`packages/nikcli/src/session/`)

Sessions are the main execution unit. They own the user/assistant message timeline, tool parts, status, permissions, questions, diffs, todo state, background children, workspace metadata, and share/export data.

| File            | Purpose                                         |
| --------------- | ----------------------------------------------- |
| `index.ts`      | Session CRUD, metadata, share lookup            |
| `llm.ts`        | LLM request loop, provider selection, streaming |
| `message-v2.ts` | Message persistence, part-level mutation        |
| `prompt.ts`     | Prompt assembly (84KB!)                         |
| `processor.ts`  | Message processing                              |
| `tools.ts`      | Tool execution within sessions                  |
| `status.ts`     | Session status (busy/idle/retry)                |
| `revert.ts`     | Diff revert/unrevert operations                 |
| `summary.ts`    | Session summaries and diff totals               |
| `goal.ts`       | Goal creation and management                    |
| `todo.ts`       | Todo state persistence                          |
| `compaction.ts` | Auto-compaction and context management          |
| `stats.ts`      | Token usage and cost statistics                 |

#### Tool System (`packages/nikcli/src/tool/`)

Tools are registered in `registry.ts` with gating logic based on model capabilities, client type, and experimental flags.

| File          | Purpose                      |
| ------------- | ---------------------------- |
| `registry.ts` | Tool registration and gating |
| `bash.ts`     | Shell command execution      |
| `edit.ts`     | In-place file editing        |
| `write.ts`    | File writing/overwriting     |
| `read.ts`     | File reading                 |
| `glob.ts`     | File pattern matching        |
| `grep.ts`     | Content search with regex    |
| `task.ts`     | Subagent delegation          |
| `browser.ts`  | Browser automation           |
| `computer.ts` | Desktop automation           |
| `opentui.ts`  | Terminal dashboards          |
| `skill.ts`    | Skill loading                |
| `*.txt`       | Tool descriptions            |

#### Server (`packages/nikcli/src/server/`)

The server is Effect HttpApi on `Bun.serve`. There is no Hono app. Contracts live in `src/server/httpapi/`; `server.ts` owns the listener and request pipeline.

| File               | Purpose                                  |
| ------------------ | ---------------------------------------- |
| `server.ts`        | Listener, CORS, auth, instance selection |
| `httpapi/`         | Typed Effect HttpApi groups + handlers   |
| `server-router.ts` | Body limit, CORS, auth, dispatch         |
| `proxy.ts`         | Remote workspace proxying                |

#### Config (`packages/nikcli/src/config/`)

| File          | Purpose                   |
| ------------- | ------------------------- |
| `config.ts`   | Main config loader (86KB) |
| `paths.ts`    | Path discovery            |
| `tui.ts`      | TUI-specific config       |
| `features.ts` | Feature flags             |

#### Provider System (`packages/nikcli/src/provider/`)

| File              | Purpose                                  |
| ----------------- | ---------------------------------------- |
| `provider.ts`     | Provider registry, models.dev, SDK cache |
| `transform.ts`    | Provider-specific request transforms     |
| `auth.ts`         | Credential resolution                    |
| `models.ts`       | Model catalog and filtering              |
| `cache-policy.ts` | Provider cache behavior                  |

#### Permission System (`packages/nikcli/src/permission/`)

| File          | Purpose                       |
| ------------- | ----------------------------- |
| `next.ts`     | Permission evaluation service |
| `schema.ts`   | Permission schema definitions |
| `evaluate.ts` | Legacy compatibility exports  |
| `ruleset.ts`  | Ruleset evaluation logic      |

### Tool Registration Pattern

Tools are registered in `registry.ts` with gating logic:

- Model capability checks
- Client type filtering
- Experimental flags (`NIKCLI_EXPERIMENTAL_LSP_TOOL`)
- Permission mode overrides

### Permission System

Three modes control tool execution:

1. `require_approval` - Every tool asks user
2. `approve_for_me` (default) - Trusted local work allowed, shell/network asks
3. `full_access` - Everything allowed

Permission rules in config:

```json
{
  "permission": {
    "bash": {
      "git status*": "allow",
      "rm *": "deny",
      "*": "ask"
    }
  }
}
```

Evaluation order:

1. Config permission converted with `PermissionNext.fromConfig`
2. Persisted project approvals loaded from storage
3. Tool-specific extra rules merged by callers
4. Last matching rule wins (deny fails, ask prompts, allow continues)

### Session Lifecycle

1. **Create**: User input persisted as user message
2. **Context**: System context built from agent, config, instructions, tools, skills
3. **Gate**: Tool availability gated by model, config, MCP, connectors
4. **Permission**: `PermissionNext.ask` before risky actions
5. **Stream**: `LLM.stream` chooses provider/model, streams output
6. **Update**: Assistant text, tool calls, results update message timeline

### Server Request Pipeline

1. Body-limit and CORS
2. Auth and instance selection
3. Effect HttpApi groups
4. Raw handlers (share, SSE, websocket upgrades)

## Configuration

### Config Resolution Order

1. Remote well-known config (lowest precedence)
2. Global config (`~/.config/nikcli/nikcli.json`)
3. Custom config (`NIKCLI_CONFIG`)
4. Project config (discovered upward)
5. Inline JSON (`NIKCLI_CONFIG_CONTENT`)
6. Config directories (`.nikcli/`)
7. Runtime flag overrides

### Config Tokens

Supports environment and file substitution:

```json
{
  "provider": {
    "openai": {
      "options": {
        "apiKey": "{env:OPENAI_API_KEY}"
      }
    }
  }
}
```

### Key Environment Variables

| Variable                         | Effect                            |
| -------------------------------- | --------------------------------- |
| `NIKCLI_CONFIG`                  | Explicit config file path         |
| `NIKCLI_CONFIG_CONTENT`          | Inline JSON config                |
| `NIKCLI_DISABLE_PROJECT_CONFIG`  | Disable project config discovery  |
| `NIKCLI_EXPERIMENTAL_LSP_TOOL`   | Enable LSP tool                   |
| `NIKCLI_EXPERIMENTAL_HTTPAPI`    | Enable typed HttpApi bridge       |
| `NIKCLI_SERVER_PASSWORD`         | Enable Basic Auth                 |
| `NIKCLI_SERVER_TAILSCALE_AUTH`   | Trust loopback Tailscale identity |
| `NIKCLI_DISABLE_AUTOCOMPACT`     | Force compaction.auto false       |
| `NIKCLI_DISABLE_PRUNE`           | Force compaction.prune false      |
| `NIKCLI_DISABLE_DEFAULT_PLUGINS` | Skip built-in external plugins    |
| `NIKCLI_DISABLE_EXTERNAL_SKILLS` | Disable external skill discovery  |

### Provider Configuration

```json
{
  "model": "openrouter/openai/gpt-5",
  "small_model": "openai/gpt-5-mini",
  "provider": {
    "openrouter": {
      "options": {
        "apiKey": "{env:OPENROUTER_API_KEY}",
        "baseURL": "https://openrouter.ai/api/v1",
        "timeout": 300000,
        "chunkTimeout": 60000
      }
    }
  }
}
```

Provider resolution order:

1. Load models.dev catalog
2. Apply enabled/disabled providers filters
3. Probe dynamic local providers (ollama, nikcli-inference)
4. Merge provider overrides from config
5. Merge saved API auth records
6. Run plugin auth/model loaders
7. Filter alpha/deprecated/unavailable models
8. Create SDK instance caches

### Agent Configuration

```json
{
  "agent": {
    "build": {
      "model": "anthropic/claude-sonnet-4.5",
      "tools": ["bash", "edit", "read", "glob", "grep"]
    },
    "plan": {
      "model": "openai/gpt-5",
      "tools": ["read", "glob", "grep", "task"]
    }
  }
}
```

## Agents Reference

### Primary Agents

| Agent   | Purpose                                        |
| ------- | ---------------------------------------------- |
| `build` | Default coding agent with broadest tool access |
| `plan`  | Structured planning before execution           |
| `ralph` | Conversational lighter interactive work        |

### Delegated Agents

| Agent           | Purpose                                     |
| --------------- | ------------------------------------------- |
| `general`       | General-purpose research and parallel work  |
| `explore`       | Codebase discovery with read/grep/glob      |
| `fast-explore`  | Faster read-only exploration                |
| `planner`       | Multi-step implementation strategies        |
| `researcher`    | Background evidence collection              |
| `code-reviewer` | Code quality and safety review              |
| `debugger`      | Root cause identification and minimal fixes |
| `test-runner`   | Test execution and failure analysis         |
| `refactor`      | Safe cleanups without behavior changes      |
| `delegator`     | Coordinates background subagent results     |
| `support`       | Read-only nikcli help assistant             |

### Agent Modes

| Mode       | Meaning                                       |
| ---------- | --------------------------------------------- |
| `primary`  | Top-level agent for normal sessions           |
| `subagent` | Available only for delegated work             |
| `all`      | Both primary and delegated                    |
| `hidden`   | Internal helpers (compaction, title, summary) |

## Tools Reference

### Files & Search

| Tool          | Description               |
| ------------- | ------------------------- |
| `read`        | Read file contents        |
| `tree`        | Show directory structure  |
| `glob`        | Find files by pattern     |
| `grep`        | Search content with regex |
| `edit`        | In-place text edits       |
| `write`       | Write/overwrite files     |
| `apply_patch` | Structured diff patches   |
| `webfetch`    | Fetch URL content         |
| `websearch`   | Web search via Exa        |
| `codesearch`  | Code search via Exa       |

### Orchestration

| Tool         | Description                            |
| ------------ | -------------------------------------- |
| `bash`       | Run shell commands                     |
| `monitor`    | Run long-lived background commands     |
| `task`       | Launch delegated subagents             |
| `delegation` | Inspect/control background delegations |
| `delegator`  | Monitor/supervise delegation jobs      |
| `todowrite`  | Write session todo list                |
| `todoread`   | Read current todo list                 |
| `advisor`    | Background strategic guidance          |
| `opentui`    | Render terminal dashboards             |
| `question`   | Ask user structured questions          |

### Context & Memory

| Tool                  | Description                |
| --------------------- | -------------------------- |
| `context_collect`     | Collect workspace context  |
| `context_related`     | List related files         |
| `context_diagnostics` | List LSP diagnostics       |
| `memory_search`       | Search past session memory |
| `repo_clone`          | Clone remote repositories  |
| `repo_overview`       | Overview of managed repos  |
| `create_goal`         | Create session goal        |
| `get_goal`            | Read goal state            |
| `update_goal`         | Mark goal complete/blocked |
| `search_tools`        | Discover available tools   |
| `exec_code`           | Execute JS/TS code         |

### Integrations & Media

| Tool             | Description                |
| ---------------- | -------------------------- |
| `generate_image` | Create images from prompts |
| `speak`          | Text-to-speech output      |
| `skill`          | Load skill instructions    |
| `browser`        | Browser automation         |
| `computer`       | Desktop automation         |
| `lsp`            | Language server operations |
| `batch`          | Batch tool calls           |

## Server API Reference

### Route Groups

| Prefix        | Source                 | Purpose                                |
| ------------- | ---------------------- | -------------------------------------- |
| `/session`    | `routes/session.ts`    | Session lifecycle, messages, streaming |
| `/permission` | `routes/permission.ts` | Permission requests and replies        |
| `/provider`   | `routes/provider.ts`   | Provider catalog, auth, refresh        |
| `/mcp`        | `routes/mcp.ts`        | MCP status, add, OAuth, connect        |
| `/mobile`     | `routes/mobile.ts`     | Mobile bootstrap, sessions, repos      |
| `/connectors` | `routes/connectors.ts` | Connector status, auth                 |
| `/chatbot`    | `routes/chatbot.ts`    | Bot webhooks (Slack, Discord, etc.)    |
| `/config`     | `routes/config.ts`     | Config read, patch, profiles           |
| `/user`       | `routes/users.ts`      | Account login, registration            |
| `/global`     | `routes/global.ts`     | Global SSE stream, metadata            |
| `/workspace`  | `routes/workspace.ts`  | Workspace list, status, events         |
| `/loop`       | `routes/loop.ts`       | Loop CRUD, run, pause, resume          |
| `/mission`    | `routes/mission.ts`    | Mission orchestration                  |
| `/brain`      | `routes/brain.ts`      | Brain model, scheduler state           |
| `/analytics`  | `routes/analytics.ts`  | Usage analytics and drilldowns         |
| `/doctor`     | `routes/doctor.ts`     | Health diagnostics                     |
| `/tui`        | `routes/tui.ts`        | Remote TUI control                     |

### Auth Layers

| Layer        | Input                         | Behavior                      |
| ------------ | ----------------------------- | ----------------------------- |
| User session | Bearer token                  | Sets `userSession`            |
| Mobile token | Bearer or `?token=`           | Sets `mobileAuth`             |
| Tailscale    | `Tailscale-User-Login` header | Trust loopback identity       |
| Basic Auth   | Username/password             | Username defaults to `nikcli` |

### Session API

| Method           | Path                          | Behavior            |
| ---------------- | ----------------------------- | ------------------- |
| GET              | `/session`                    | List sessions       |
| POST             | `/session`                    | Create session      |
| GET              | `/session/status`             | Status map          |
| GET/PATCH/DELETE | `/session/:id`                | Read/update/remove  |
| POST             | `/session/:id/fork`           | Fork session        |
| POST             | `/session/:id/abort`          | Cancel execution    |
| POST             | `/session/:id/revert`         | Revert changes      |
| POST             | `/session/:id/unrevert`       | Undo revert         |
| GET              | `/session/:id/message`        | List messages       |
| GET/DELETE       | `/session/:id/message/:msgId` | Read/remove message |

## Storage Reference

### Path Roots

| Path                 | Purpose                                 |
| -------------------- | --------------------------------------- |
| `Global.Path.data`   | Long-lived data (storage, SQLite DBs)   |
| `Global.Path.bin`    | Managed binaries (LSP downloads)        |
| `Global.Path.cache`  | Disposable cache (model lists, indexes) |
| `Global.Path.config` | User config (nikcli.json, themes)       |
| `Global.Path.state`  | Ephemeral state (locks, stashes)        |
| `Global.Path.repos`  | Hosted repositories                     |

### Durable state (`nikcli.db`)

Sessions, messages, parts, todos, permissions, loops, missions, monitors, shares, and artifacts live behind domain repos (`SessionRepo`, `LoopRepo`, `MissionRepo`, `MonitorRepo`, `ShareRepo`, `ArtifactRepo`, …). Do not add JSON `Storage` reads for a domain that has already moved.

### Leftover JSON keys

JSON `Storage` remains only for derived/ephemeral keys. Do not extend this set; see `specs/storage/remove-json-storage.md`.

| Key                             | Content                    |
| ------------------------------- | -------------------------- |
| `session_diff/SESSION_ID`       | Session diffs              |
| `goal/SESSION_ID`               | Goal state                 |
| `routine/PROJECT_ID/ROUTINE_ID` | Mobile routine definitions |

### SQLite Databases

| Database    | Owner    | Purpose                                                                                |
| ----------- | -------- | -------------------------------------------------------------------------------------- |
| `nikcli.db` | Database | Central store. Legacy per-domain files were imported; they stay on disk for downgrade. |

## MCP Reference

### Server Types

| Type     | Transport | Use Case           |
| -------- | --------- | ------------------ |
| `local`  | stdio     | Local tool servers |
| `remote` | HTTP/SSE  | Remote APIs        |

### Status Values

| Status                      | Meaning                         |
| --------------------------- | ------------------------------- |
| `connected`                 | Connected and tools listed      |
| `disabled`                  | Config disabled or disconnected |
| `failed`                    | Connection or tool-list failed  |
| `needs_auth`                | OAuth required                  |
| `needs_client_registration` | OAuth client id needed          |

### CLI Commands

```bash
nikcli mcp list          # Show MCP status
nikcli mcp add           # Add server interactively
nikcli mcp auth <name>   # Start OAuth flow
nikcli mcp logout <name> # Remove stored auth
nikcli mcp debug <name>  # Inspect with raw client
```

## Plugin Reference

### Built-in Plugins

| Plugin              | Purpose                  |
| ------------------- | ------------------------ |
| Codex auth          | Codex authentication     |
| GitHub Copilot auth | Copilot/enterprise auth  |
| xAI auth            | xAI provider auth        |
| Cursor auth         | Cursor ACP/provider auth |
| Cloudflare auth     | Workers/AI Gateway auth  |
| Notify plugin       | Session notifications    |

### TUI Feature Plugins

| Plugin          | Capability              |
| --------------- | ----------------------- |
| `brain`         | Model picker, scheduler |
| `browser`       | Browser-use control     |
| `chatbot`       | Bot control panel       |
| `computer`      | Computer-use capture    |
| `connectors`    | Connector status        |
| `deepsec`       | Security checks         |
| `island`        | macOS notch integration |
| `observability` | OTel spans              |
| `loops`         | Loop management         |
| `mission`       | Mission orchestration   |

### Plugin Manifest

```json
{
  "name": "@scope/my-plugin",
  "version": "1.0.0",
  "exports": {
    "./server": "./dist/server.js",
    "./tui": "./dist/tui.js"
  },
  "oc-plugin": ["server", "tui"]
}
```

### Skills vs Plugins

| Feature      | Plugin                           | Skill                            |
| ------------ | -------------------------------- | -------------------------------- |
| Runtime code | Yes, imported/executed           | No, prompt/context only          |
| Config field | `plugin`                         | Discovered from directories      |
| TUI manager  | System plugin manager            | Skills dialog                    |
| Disable flag | `NIKCLI_DISABLE_DEFAULT_PLUGINS` | `NIKCLI_DISABLE_EXTERNAL_SKILLS` |

## CLI Reference

### Interactive Workflows

```bash
nikcli                         # Open TUI in current directory
nikcli ../repo --model gpt-5   # Open TUI in another project
nikcli --continue              # Continue last session
nikcli --session ses_example   # Open specific session
nikcli run "fix the failing test"  # One-shot prompt
nikcli run --attach http://127.0.0.1:4096 "summarize work"  # Attach to server
nikcli quickstart              # Interactive walkthrough
nikcli pr 42                   # Checkout and open PR branch
```

### Autonomous & Scheduled

```bash
nikcli goal "all tests pass"           # Work until condition met
nikcli goal --token-budget 50000 "fix integration test"
nikcli routine list                    # List routines
nikcli routine create                  # Create routine
nikcli routine run <id>                # Trigger routine
nikcli loop list                       # List loops
nikcli loop create --name "triage" --stage "..." --every 30m
nikcli mission new -f ./brief.md       # Create mission
nikcli mission start <id>              # Start mission
```

### Services & Remote

```bash
nikcli serve                           # Start HTTP API server
nikcli web                             # Start web UI
nikcli companion serve                 # Boot with companion UI
nikcli mobile serve --pair             # Mobile API host
nikcli mobile pair                     # Generate pairing QR
nikcli remote start                    # Start remote session
nikcli remote status                   # Show remote status
nikcli remote share                    # Print shareable link
```

### Integration & Automation

```bash
nikcli connectors list                 # List connectors
nikcli connectors add                  # Add connector
nikcli connectors auth <name>          # Authenticate connector
nikcli bot list                        # List bots
nikcli bot add                         # Add bot
nikcli bot start <name>                # Start bot
nikcli plugin @scope/my-plugin         # Install plugin
```

### Models, Locale & Config

```bash
nikcli auth list                       # List authenticated providers
nikcli auth login                      # Authenticate provider
nikcli models anthropic --refresh      # Refresh model catalog
nikcli locale set --language ja        # Set language
nikcli account login                   # Login to nikcli account
nikcli agent list                      # List agents
nikcli image-model                     # Set image model
nikcli speak-model                     # Set TTS model
```

### Diagnostics & Maintenance

```bash
nikcli doctor                          # Diagnose setup issues
nikcli heap --detailed                 # Show memory metrics
nikcli stats                           # Token usage stats
nikcli usage                           # Usage charts
nikcli export abc123 > session.json    # Export session
nikcli import ./session.json           # Import session
nikcli upgrade                         # Upgrade nikcli
nikcli uninstall --keep-config --dry-run
```

## Debugging

### Common Issues

| Symptom                    | Cause                      | Fix                                       |
| -------------------------- | -------------------------- | ----------------------------------------- |
| Config parse error         | JSONC syntax error         | Check line/column after token expansion   |
| Tool blocked               | Permission mode            | Check `permission` config or mode preset  |
| Provider missing           | Auth or filter             | Run `nikcli models --refresh`             |
| Session not updating       | Event sync issue           | Check server auth and SDK provider        |
| `Session.BusyError`        | Prompt already running     | Use abort, wait for idle, or fork         |
| Always approval not reused | Different pattern/project  | Check stored rules under project          |
| Invalid prompt error       | Malformed message shape    | Verify `normalizeStreamMessages` input    |
| 401 on every request       | Missing auth               | Check bearer token, Basic Auth, Tailscale |
| Session list empty         | Wrong data root or project | Check `nikcli debug paths`                |
| HTTP 404 stored object     | Missing SQL row            | Confirm the domain repo returns the id    |
| MCP needs_auth             | OAuth required             | Run `nikcli mcp auth <name>`              |
| MCP no tools               | listTools failed           | Check server logs and response            |
| Mobile bootstrap slow      | Multiple subsystem checks  | Smoke `/mobile/auth/token` first          |
| Plugin install failed      | Package resolution         | Check error and registry settings         |

### Debug Commands

```bash
# Diagnose setup issues
nikcli doctor

# Show heap/memory metrics
nikcli heap --detailed

# Export session for inspection
nikcli export [sessionID] > session.json

# View token usage
nikcli stats

# Enable verbose logging
nikcli --print-logs --log-level debug run "your prompt"

# Check storage paths
nikcli debug paths

# Inspect leftover JSON storage (derived/ephemeral keys only)
find "$HOME/.local/share/nikcli/storage" -maxdepth 3 -type f | sort | head

# Inspect SQLite
sqlite3 "$HOME/.local/share/nikcli/nikcli.db" ".tables"
```

### Log Analysis

Logs are stored in `Global.Path.log/`:

```bash
# Enable verbose logging
nikcli --print-logs --log-level debug run "your prompt"
```

## Integration Points

### MCP (Model Context Protocol)

```json
{
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": ["bunx", "@modelcontextprotocol/server-filesystem", "."],
      "environment": { "LOG_LEVEL": "info" },
      "timeout": 30000
    },
    "remote-docs": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer token" },
      "oauth": { "clientId": "...", "clientSecret": "..." }
    }
  }
}
```

### Connectors

```json
{
  "connectors": {
    "github": { "type": "github", "enabled": true },
    "slack": { "type": "slack", "enabled": true },
    "figma": { "type": "figma", "enabled": true }
  }
}
```

### Mobile Host

API for companion app:

- Auth tokens via `POST /mobile/auth/token`
- Session streaming over SSE
- Permission replies
- Bootstrap, pairing, repos, git, approvals, routines, terminals

### LSP Integration

```json
{
  "lsp": {
    "pyright": { "disabled": true },
    "custom-ts": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx"]
    }
  }
}
```

### Notifications

```json
{
  "notifications": {
    "notify": {
      "enabled": true,
      "events": {
        "sessionIdle": true,
        "sessionError": true,
        "permissionAsked": true
      },
      "slack": { "enabled": true, "connector": "slack", "channel": "#builds" }
    }
  }
}
```

## Code Examples

### Adding a New Tool

```typescript
// 1. Create implementation in packages/nikcli/src/tool/your-tool.ts
export const yourTool = {
  name: "your_tool",
  description: "Description from your-tool.txt",
  parameters: {
    /* zod schema */
  },
  execute: async (params, ctx) => {
    // Implementation
    return { result: "success" }
  },
}

// 2. Register in packages/nikcli/src/tool/registry.ts
// Add to the tools array with appropriate gating
```

### Adding a Server Route

Edit the HttpApi group in `packages/nikcli/src/server/httpapi/`, then run `bun run generate:httpapi-clients` from `packages/nikcli`. Full workflow is in `packages/nikcli/AGENTS.md` ("HTTP integration workflow"). There is no Hono app and no `src/server/routes/` tree.

### Working with Sessions

```typescript
import { Session } from "./session"

// Create session
const session = await Session.create({
  title: "My Session",
  projectID: "project-id",
  directory: "/path/to/project",
})

// Add message
await Session.message(session.id, {
  role: "user",
  content: "Hello",
})

// Get session status
const status = await Session.status(session.id)
// Returns: 'busy' | 'idle' | 'retry'
```

### Working with Permissions

```typescript
import { PermissionNext } from "./permission"

// Check permission
const result = await PermissionNext.ask({
  permission: "bash",
  pattern: "git status",
  action: "ask",
})

// Handle reply
// 'once' - resolve current request
// 'always' - persist approval for project
// 'reject' - reject with optional feedback
```

### Working with Providers

```typescript
import { Provider } from "./provider"

// Refresh provider cache
await Provider.refresh()

// Get model catalog
const models = await Provider.list()

// Get specific provider
const openai = await Provider.get("openai")
```

### Working with Storage

Durable domain state lives in `nikcli.db` behind domain repos. Do not add JSON `Storage` reads for a domain that has already moved (sessions, messages, loops, missions, monitors, shares, artifacts).

```typescript
import { SessionRepo } from "./session/repo"

SessionRepo.upsert(session)
const session = SessionRepo.get(sessionId)
SessionRepo.update(sessionId, (draft) => {
  draft.title = "New Title"
})
```

JSON `Storage` remains only for leftover derived/ephemeral keys (`session_diff`, goals, analytics, PTY). See `specs/storage/remove-json-storage.md`.

### Working with MCP

```typescript
import { Mcp } from "./mcp"

// List connected servers
const servers = await Mcp.list()

// Connect to server
await Mcp.connect("my-server")

// Get tools from server
const tools = await Mcp.tools("my-server")

// Execute MCP tool
const result = await Mcp.callTool("my-server", "tool-name", { arg: "value" })
```

## Best Practices

1. **Minimize new files** - Prefer editing existing files
2. **Use parallel tools** - Background tasks for independent work
3. **Type safety** - Run `bun run typecheck` before commits
4. **Test changes** - Run `bun test` for affected modules
5. **Regenerate SDK** - After server endpoint changes
6. **Check permissions** - Add permission gating for new tools
7. **Update docs** - Keep skill and documentation current
8. **Use Effect** - Prefer Effect services for new features
9. **Follow patterns** - Match existing code organization
10. **Verify routes** - Test with curl or SDK after changes
11. **Check storage** - Durable domain state goes through SQL repos; do not add JSON `Storage` reads for a domain that has already moved
12. **Test MCP** - Verify tool conversion works correctly
13. **Test plugins** - Ensure server/TUI targets work
14. **Back up data** - Before manual storage edits

## Learning Resources

- **Docs**: https://nikcli-ai.dev/docs
- **Architecture**: https://nikcli-ai.dev/docs/architecture
- **CLI Reference**: https://nikcli-ai.dev/docs/cli
- **Sessions**: https://nikcli-ai.dev/docs/sessions
- **Providers**: https://nikcli-ai.dev/docs/providers
- **Permissions**: https://nikcli-ai.dev/docs/permissions
- **Server API**: https://nikcli-ai.dev/docs/server-api
- **Storage**: https://nikcli-ai.dev/docs/storage
- **MCP**: https://nikcli-ai.dev/docs/mcp
- **Plugins**: https://nikcli-ai.dev/docs/plugins
- **GitHub**: https://github.com/nikcli/nikcli
