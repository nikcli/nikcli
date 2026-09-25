import { apiGroups } from "./apiGroups"
import { docsSidebar } from "./docsSidebar"

/**
 * Retrieval index for the docs support assistant (`/api/docs-assistant`).
 *
 * Titles and grouping come from {@link docsSidebar} so navigation stays the
 * single source of truth; this file only adds the retrieval text (page summary
 * plus the vocabulary real users type when they are looking for that page).
 *
 * `bun run check:docs-index` fails when a sidebar page has no entry here.
 */
export type DocsIndexEntry = {
  title: string
  href: string
  group: string
  summary: string
  keywords: string[]
}

type DocsIndexMeta = { summary: string; keywords: string[] }

const meta: Record<string, DocsIndexMeta> = {
  "/docs": {
    summary:
      "Source-of-truth overview of nikcli across the CLI, server, connectors and mobile app: what it is, how to install it, and how the pieces fit together.",
    keywords: [
      "overview",
      "getting started",
      "introduction",
      "install",
      "installation",
      "npm",
      "bun",
      "quickstart",
      "setup",
      "what is nikcli",
      "first run",
      "onboarding",
    ],
  },
  "/docs/architecture": {
    summary:
      "Map of the nikcli monorepo, CLI lifecycle, server stack, session runtime, storage model, integrations, mobile host and SDK boundary.",
    keywords: [
      "architecture",
      "monorepo",
      "lifecycle",
      "runtime",
      "design",
      "internals",
      "how it works",
      "boundaries",
      "structure",
    ],
  },
  "/docs/cli": {
    summary:
      "Complete command surface of the nikcli binary: every command, subcommand and flag exposed by the CLI entrypoint.",
    keywords: [
      "cli",
      "command",
      "commands",
      "flags",
      "arguments",
      "terminal",
      "run",
      "usage",
      "help",
      "binary",
      "npx",
      "slash command",
    ],
  },
  "/docs/configuration": {
    summary:
      "How nikcli discovers, parses, merges, validates and applies configuration across global, project and runtime sources, including config file locations and precedence.",
    keywords: [
      "config",
      "configuration",
      "settings",
      "nikcli.json",
      "env",
      "environment variable",
      "defaults",
      "override",
      "project config",
      "global config",
      "precedence",
      "schema",
      "theme",
    ],
  },
  "/docs/agents": {
    summary:
      "Agent definitions and how they are configured through config overlays: system prompts, tool access, subagents and delegation.",
    keywords: [
      "agent",
      "agents",
      "subagent",
      "delegation",
      "system prompt",
      "persona",
      "custom agent",
      "orchestrator",
      "vm agent",
    ],
  },
  "/docs/tools": {
    summary:
      "Public tools registered in the tool registry plus tool-gating behavior: file edits, shell, search, web, code mode and more.",
    keywords: [
      "tool",
      "tools",
      "registry",
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "glob",
      "webfetch",
      "code mode",
      "tool gating",
      "enable tool",
      "disable tool",
    ],
  },
  "/docs/providers": {
    summary:
      "How nikcli builds its model catalog, resolves credentials, selects runtime adapters and streams requests to model providers.",
    keywords: [
      "provider",
      "providers",
      "model",
      "models",
      "api key",
      "apikey",
      "anthropic",
      "openai",
      "claude",
      "gpt",
      "gemini",
      "ollama",
      "gateway",
      "credentials",
      "auth",
      "login",
      "token",
      "rate limit",
      "quota",
      "cost",
      "pricing",
    ],
  },
  "/docs/connectors": {
    summary:
      "How nikcli connects external services, stores credentials, exposes connector tools and receives bot webhooks (GitHub, Slack, Linear, Notion and friends).",
    keywords: [
      "connector",
      "connectors",
      "integration",
      "github",
      "slack",
      "linear",
      "notion",
      "jira",
      "webhook",
      "bot",
      "oauth",
      "credentials",
    ],
  },
  "/docs/routines": {
    summary:
      "Saved prompts with schedule or API triggers, scoped per project — cron-style automation for recurring nikcli work.",
    keywords: [
      "routine",
      "routines",
      "schedule",
      "scheduled",
      "cron",
      "trigger",
      "automation",
      "recurring",
      "saved prompt",
    ],
  },
  "/docs/loops": {
    summary:
      "Server-side headless Loops engine: a thin orchestrator composing Scheduler and Goal for long-running autonomous work.",
    keywords: ["loop", "loops", "headless", "autonomous", "goal", "scheduler", "background", "long running", "iterate"],
  },
  "/docs/missions": {
    summary:
      "High-altitude workflows that decompose a goal into milestones, each holding a DAG of features with a validation checkpoint per milestone.",
    keywords: [
      "mission",
      "missions",
      "milestone",
      "plan",
      "planning",
      "dag",
      "workflow",
      "roadmap",
      "checkpoint",
      "validation",
    ],
  },
  "/docs/localization": {
    summary: "Language, region, timezone and model reply-language settings managed through the nikcli locale command.",
    keywords: [
      "locale",
      "localization",
      "language",
      "translate",
      "i18n",
      "timezone",
      "region",
      "reply language",
      "italiano",
      "english",
    ],
  },
  "/docs/sessions": {
    summary:
      "How nikcli creates, stores, streams, forks, reverts and resumes agent sessions across CLI, TUI, mobile and API clients.",
    keywords: [
      "session",
      "sessions",
      "resume",
      "continue",
      "history",
      "fork",
      "revert",
      "undo",
      "share",
      "export",
      "chat history",
      "context",
      "compaction",
    ],
  },
  "/docs/permissions": {
    summary:
      "Permission modes and custom allow / ask / deny rules for every tool, including how approvals are prompted and persisted.",
    keywords: [
      "permission",
      "permissions",
      "approve",
      "approval",
      "allow",
      "deny",
      "ask",
      "yolo",
      "safe mode",
      "sandbox",
      "autonomous",
      "security",
      "prompt",
    ],
  },
  "/docs/guides": {
    summary:
      "Index of the step-by-step guides: writing a plugin, plugin recipes, using the HTTP API, and streaming a response.",
    keywords: ["guide", "guides", "tutorial", "walkthrough", "how to", "example", "getting started", "step by step"],
  },
  "/docs/guides/plugins": {
    summary:
      "Step-by-step guide to writing a nikcli plugin: asking nikcli to write one with the plugin tool, folder plugins and hot reload, the local file, the config entry, the two accepted module shapes, the plugin input, every hook, adding a custom tool with tool(), publishing to npm and debugging.",
    keywords: [
      "write a plugin",
      "create plugin",
      "plugin tutorial",
      "custom tool",
      "tool()",
      "hooks",
      "PluginInput",
      "plugin module",
      "publish plugin",
      "plugin not loading",
      "extend nikcli",
      "plugin tool",
      "self-extending",
      "hot reload plugin",
      "folder plugin",
    ],
  },
  "/docs/guides/plugin-recipes": {
    summary:
      "Eight complete example plugins: a tool that runs a script, a tool that streams progress, auto-denying a permission class, injecting shell secrets, tuning model parameters, redacting outbound requests, appending project rules to the system prompt, and notifying on session idle.",
    keywords: [
      "plugin example",
      "recipe",
      "sample plugin",
      "copy paste",
      "permission policy",
      "shell env",
      "secrets",
      "chat.params",
      "redact",
      "system prompt",
      "slack notification",
      "custom tool example",
    ],
  },
  "/docs/guides/api": {
    summary:
      "Quickstart for driving the nikcli HTTP API with curl and the typed client side by side: starting a server, authenticating, selecting a project, creating and prompting sessions, diffs, files, search, shell commands, permission replies, and a complete script.",
    keywords: [
      "api guide",
      "api tutorial",
      "how to use the api",
      "curl",
      "quickstart",
      "create session",
      "send prompt",
      "read file",
      "search",
      "permission reply",
      "automate",
      "script",
      "ci",
    ],
  },
  "/docs/guides/api-tour": {
    summary:
      "A hands-on tour of the HTTP API where every response shown was captured from a real server: health, paths, projects, the tool registry, agent permission tables, sessions, files, ripgrep search, empty-collection shapes, the SSE handshake, and what 404s, validation errors and unmatched paths actually return.",
    keywords: [
      "example output",
      "real response",
      "sample response",
      "try the api",
      "test endpoint",
      "curl example",
      "what does it return",
      "response shape",
      "json example",
      "playground",
      "error response",
      "404",
      "validation error",
      "NIKCLI_TEST_HOME",
      "throwaway server",
    ],
  },
  "/docs/guides/streaming": {
    summary:
      "Streaming nikcli output: subscribing to the event feed before submitting, promptAsync, printing message.part.updated deltas, detecting session.idle, the useful event types, and the same flow with curl.",
    keywords: [
      "streaming",
      "stream response",
      "sse",
      "event feed",
      "promptAsync",
      "delta",
      "tokens",
      "realtime",
      "session.idle",
      "message.part.updated",
      "live output",
    ],
  },
  "/docs/guides/providers": {
    summary:
      "Writing a provider plugin: the auth hook for API-key and OAuth methods, conditional prompts, the loader that turns a credential into request options, token refresh written back through the client, dynamic model lists, and per-provider chat.params fixups.",
    keywords: [
      "custom provider",
      "add provider",
      "model provider",
      "auth hook",
      "oauth provider",
      "api key provider",
      "loader",
      "refresh token",
      "provider models",
      "gateway",
      "internal model",
    ],
  },
  "/docs/guides/custom-interface": {
    summary:
      "Building a nikcli client: event-driven state keyed by part id, rendering parts, answering permission requests and questions, todos and diffs, reconnecting without losing the transcript, and a complete working terminal client.",
    keywords: [
      "custom interface",
      "build a client",
      "custom ui",
      "frontend",
      "render parts",
      "permission prompt",
      "question reply",
      "reconnect",
      "todo",
      "chat ui",
      "alternative interface",
    ],
  },
  "/docs/guides/terminals": {
    summary:
      "Driving the PTY API: creating terminals, attaching over a websocket with a query-parameter token, resizing so full-screen programs render, lifecycle, environment injection through shell.env, and wiring a terminal to xterm.js in the browser.",
    keywords: [
      "terminal",
      "pty",
      "websocket",
      "xterm",
      "shell",
      "resize",
      "tty",
      "interactive command",
      "terminal ui",
      "attach",
    ],
  },
  "/docs/guides/loops": {
    summary:
      "Automating with loops: defining stages with agents, objectives and token budgets, manual and interval triggers, maxRuns and timeouts, worktree isolation and createPR, running and pausing, run history, and generating a loop from a description.",
    keywords: [
      "loop",
      "automation",
      "schedule",
      "recurring",
      "nightly",
      "stages",
      "token budget",
      "worktree",
      "createPR",
      "interval",
      "cron",
      "unattended",
    ],
  },
  "/docs/guides/missions": {
    summary:
      "Orchestrating missions: milestones and features, dependsOn dependency graphs that allow parallel work, scrutiny and user-test validation gates, starting and pausing, watching execs, and mutating a feature mid-run.",
    keywords: [
      "mission",
      "milestone",
      "feature",
      "dependency graph",
      "dependsOn",
      "validation",
      "scrutiny",
      "parallel features",
      "orchestration",
      "plan",
    ],
  },
  "/docs/guides/workspaces": {
    summary:
      "Parallel work with workspaces: worktree and container configurations, creating and targeting them, warping a session between workspaces with copyChanges, status and events, cleanup, and running three branches at once from one script.",
    keywords: [
      "workspace",
      "parallel",
      "worktree",
      "container",
      "warp",
      "isolation",
      "multiple branches",
      "concurrent sessions",
      "sandbox",
    ],
  },
  "/docs/guides/ci": {
    summary:
      "Running nikcli in CI: the GitHub Action and every input, OIDC token exchange versus GITHUB_TOKEN, scheduled unattended runs, starting a headless server on any CI, filtering permissions in an unattended run, and a review job that fails the build.",
    keywords: [
      "ci",
      "github actions",
      "continuous integration",
      "pipeline",
      "gitlab",
      "automation",
      "review bot",
      "pull request",
      "workflow",
      "headless",
      "unattended",
      "oidc",
    ],
  },
  "/docs/build": {
    summary:
      "The three ways to build on nikcli without forking it: plugins that run inside the agent, the typed HTTP client that drives a running server, and the embedded host that runs nikcli in your own process.",
    keywords: [
      "build",
      "extend",
      "integrate",
      "embed",
      "sdk",
      "plugin",
      "custom tool",
      "hooks",
      "api client",
      "automation",
      "custom interface",
      "developer",
    ],
  },
  "/docs/build/client": {
    summary:
      "Driving a running nikcli server with @nikcli-ai/sdk: creating a client, the { data, error } result envelope and throwOnError, instance selection, method naming, streaming event feeds, authentication headers and ClientError.",
    keywords: [
      "client",
      "sdk",
      "createNikcliClient",
      "@nikcli-ai/sdk",
      "http client",
      "typed client",
      "throwOnError",
      "result envelope",
      "event stream",
      "sse",
      "bearer token",
      "script nikcli",
      "automation",
      "ci",
    ],
  },
  "/docs/build/sdk": {
    summary:
      "Embedding nikcli in-process with @nikcli-ai/sdk-next: creating a host, the Effect layer, directory binding, registering tools locally, and the process-global instance state caveat.",
    keywords: [
      "embedded",
      "embed",
      "sdk-next",
      "in-process",
      "no server",
      "effect layer",
      "NikCli.create",
      "register tool",
      "tool registry",
      "host",
    ],
  },
  "/docs/plugins": {
    summary:
      "How nikcli installs plugins, patches server and TUI config, loads built-ins and exposes plugin hooks, plus skills.",
    keywords: [
      "plugin",
      "plugins",
      "skill",
      "skills",
      "hook",
      "hooks",
      "extension",
      "install plugin",
      "marketplace",
      "custom command",
    ],
  },
  "/docs/server-api": {
    summary:
      "How the nikcli Hono server exposes CLI, TUI, mobile, workspace and generated HttpApi routes, including the OpenAPI surface and SDK.",
    keywords: [
      "server",
      "api",
      "http",
      "rest",
      "route",
      "routes",
      "endpoint",
      "openapi",
      "sdk",
      "port",
      "serve",
      "headless",
      "curl",
      "sse",
      "event stream",
      "hono",
    ],
  },
  "/docs/web-app": {
    summary:
      "Browser-based access to nikcli sessions, the Studio management dashboard and the companion UI served from the web package.",
    keywords: ["web", "web app", "browser", "studio", "dashboard", "companion", "ui", "online", "cloud"],
  },
  "/docs/mobile": {
    summary:
      "Running and managing nikcli from the Expo mobile app against a host server, including pairing and remote sessions.",
    keywords: ["mobile", "ios", "android", "expo", "phone", "app", "remote", "pair", "teleport", "push notification"],
  },
  "/docs/sync": {
    summary:
      "How nikcli journals local events, projects them into typed snapshots, ships them through an idempotent outbox and replays them onto an optional remote hub.",
    keywords: [
      "sync",
      "synchronization",
      "journal",
      "outbox",
      "snapshot",
      "replay",
      "hub",
      "offline",
      "conflict",
      "devices",
    ],
  },
  "/docs/mcp": {
    summary:
      "How nikcli connects local and remote Model Context Protocol servers, authenticates OAuth servers and exposes MCP tools to agent sessions.",
    keywords: [
      "mcp",
      "model context protocol",
      "mcp server",
      "stdio",
      "sse",
      "remote server",
      "oauth",
      "tools",
      "connect",
    ],
  },
  "/docs/lsp": {
    summary:
      "Language-server discovery, startup, diagnostics and the gated LSP tool used for type-aware code understanding.",
    keywords: [
      "lsp",
      "language server",
      "diagnostics",
      "typescript",
      "types",
      "errors",
      "intellisense",
      "hover",
      "definition",
    ],
  },
  "/docs/storage": {
    summary:
      "Persistent data layout, migrations, locks, caches and SQLite stores used by nikcli, and where files live on disk.",
    keywords: [
      "storage",
      "database",
      "sqlite",
      "cache",
      "disk",
      "path",
      "data directory",
      "migration",
      "lock",
      "cleanup",
      "reset",
      "where are files stored",
    ],
  },
  "/docs/tui": {
    summary:
      "Terminal UI entrypoint, worker RPC, OpenTUI renderer, command registry, routes, event streams and remote-control wiring.",
    keywords: [
      "tui",
      "terminal ui",
      "keyboard",
      "keybind",
      "shortcut",
      "command palette",
      "opentui",
      "render",
      "layout",
      "panel",
      "dialog",
    ],
  },
  "/docs/tui-plugins": {
    summary: "Every built-in TUI feature plugin: what it registers, which commands it owns and where its state lives.",
    keywords: ["tui plugin", "feature plugin", "built-in", "panel", "command", "registry", "state"],
  },
  "/docs/brain": {
    summary:
      "The Brain subsystem periodically consolidates session memory and re-evaluates long-running context via TUI plugin, server route and headless scheduler.",
    keywords: ["brain", "memory", "consolidate", "context", "recall", "long term", "knowledge", "embedding"],
  },
  "/docs/island": {
    summary: "NikcliIsland.app, the macOS Dynamic-Island-style notch HUD showing live nikcli session state.",
    keywords: ["island", "macos", "notch", "hud", "menu bar", "desktop app", "status"],
  },
  "/docs/observability": {
    summary: "OpenTelemetry (OTLP) trace export and live in-process telemetry for the TUI observability panel.",
    keywords: [
      "observability",
      "telemetry",
      "otel",
      "opentelemetry",
      "otlp",
      "trace",
      "metrics",
      "logs",
      "monitoring",
      "debug",
      "usage",
      "tokens",
    ],
  },
  "/docs/computer-use": {
    summary:
      "The computer-use engine for driving real desktop sessions — screenshots, clicks, keystrokes and app control.",
    keywords: [
      "computer use",
      "desktop",
      "screenshot",
      "click",
      "keyboard",
      "mouse",
      "gui",
      "automation",
      "accessibility",
    ],
  },
  "/docs/browser-control": {
    summary: "The browser-control engine driving headless Chromium sessions for web automation and page inspection.",
    keywords: [
      "browser",
      "chromium",
      "chrome",
      "headless",
      "playwright",
      "web automation",
      "scrape",
      "navigate",
      "screenshot",
    ],
  },
  "/docs/terminal-control": {
    summary: "The terminal-control engine that records, replays and bundles PTY-driven TUI sessions.",
    keywords: ["terminal control", "pty", "record", "replay", "asciinema", "bundle", "demo", "capture"],
  },
  "/docs/packages": {
    summary:
      "The nikcli monorepo package map: the core CLI/TUI/server package plus supporting infrastructure, provider integrations and surface-area extensions.",
    keywords: ["package", "packages", "monorepo", "workspace", "npm package", "sdk", "suite", "dependencies"],
  },
  "/docs/brand": {
    summary:
      "The nikcli wordmark variants, how they are themed across surfaces and where the brand assets live in each package.",
    keywords: ["brand", "logo", "wordmark", "assets", "colors", "press kit"],
  },
  "/docs/source-map": {
    summary:
      "A practical map for finding the real implementation behind CLI commands, API routes, TUI views, mobile flows, providers, plugins and storage.",
    keywords: ["source map", "source", "where is", "implementation", "file", "code", "contribute", "find code"],
  },
  "/docs/cli-debug": {
    summary:
      "Low-level debugging utilities under the debug command namespace, aimed at contributors and support rather than everyday use.",
    keywords: [
      "debug",
      "debugging",
      "troubleshoot",
      "troubleshooting",
      "verbose",
      "log",
      "logs",
      "diagnose",
      "crash",
      "bug",
      "not working",
      "error",
    ],
  },
}

/**
 * Retrieval metadata for the generated API reference. The group definitions
 * already carry a summary and the vocabulary a reader would type, so deriving
 * it here keeps one description per resource instead of two that drift.
 */
const apiMeta: Record<string, DocsIndexMeta> = {
  "/docs/api": {
    summary:
      "Complete HTTP API reference for the nikcli server: base URL, the four authentication schemes, instance selection, streaming endpoints, the generated SDK client, and every resource group.",
    keywords: [
      "api",
      "http api",
      "rest",
      "endpoint",
      "openapi",
      "swagger",
      "spec",
      "curl",
      "base url",
      "authentication",
      "bearer token",
      "sdk client",
      "operation id",
    ],
  },
  ...Object.fromEntries(
    apiGroups.map((group) => [
      `/docs/api/${group.slug}`,
      {
        summary: `HTTP API endpoints — ${group.summary}`,
        keywords: ["api", "endpoint", "http", ...group.keywords],
      },
    ]),
  ),
}

const entryMeta = (href: string): DocsIndexMeta | undefined => meta[href] ?? apiMeta[href]

export const docsIndex: DocsIndexEntry[] = docsSidebar.flatMap((group) =>
  group.items.map((item) => ({
    title: item.title,
    href: item.href,
    group: group.title,
    summary: entryMeta(item.href)?.summary ?? item.title,
    keywords: entryMeta(item.href)?.keywords ?? [],
  })),
)

/** Sidebar pages with no retrieval metadata, and metadata for dead pages. */
export function docsIndexGaps() {
  const sidebarPaths = new Set(docsIndex.map((entry) => entry.href))
  return {
    missing: docsIndex.filter((entry) => !entryMeta(entry.href)).map((entry) => entry.href),
    orphaned: [...Object.keys(meta), ...Object.keys(apiMeta)].filter((href) => !sidebarPaths.has(href)),
  }
}
