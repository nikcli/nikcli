/**
 * Resource grouping for the HTTP API reference under `/docs/api`.
 *
 * The OpenAPI document tags operations by the HttpApi group that declares them,
 * which is the right granularity for the server but not always for a reader:
 * some tags are a handful of endpoints that belong together on one page, and
 * `mobile` alone is 120+ operations that nobody wants on a single page.
 *
 * This file is the mapping, and it deliberately does not import the spec: it is
 * pulled in by the docs sidebar and by the docs-assistant index, both of which
 * ship inside the Cloudflare worker. `bun run check:api-groups` fails when an
 * operation in the spec lands in no group, or in more than one.
 */
export type ApiGroup = {
  /** Page slug under `/docs/api/`. */
  slug: string
  title: string
  /** Shown on the page header and on the overview grid. */
  summary: string
  /** Retrieval vocabulary for the docs assistant. */
  keywords: string[]
  /** OpenAPI tags folded into this page. */
  tags: string[]
  /**
   * Restricts the page to paths under these prefixes. Used to split the very
   * large `mobile` tag; matching is segment-aware, so `/mobile/git` does not
   * capture `/mobile/github`.
   */
  include?: string[]
  /** Paths under these prefixes are documented on another page instead. */
  exclude?: string[]
  /** Sidebar section this page appears under. */
  section: "API Reference" | "API · Mobile"
}

export const apiGroups: ApiGroup[] = [
  {
    slug: "core",
    title: "Core",
    section: "API Reference",
    tags: ["top-level"],
    summary:
      "Instance lifecycle, resolved paths, version control status and apply, and the registries of commands, agents, skills, language servers and formatters.",
    keywords: [
      "path",
      "vcs",
      "git status",
      "diff",
      "apply patch",
      "agent list",
      "skill list",
      "command list",
      "lsp status",
      "formatter",
      "instance dispose",
    ],
  },
  {
    slug: "session",
    title: "Sessions",
    section: "API Reference",
    tags: ["session"],
    summary:
      "The session lifecycle: create, fork, revert, share and delete sessions, read messages and parts, inspect todos, diffs, context and goals, and drive background delegations and monitors.",
    keywords: [
      "session",
      "create session",
      "fork",
      "revert",
      "unrevert",
      "share",
      "summarize",
      "messages",
      "parts",
      "todo",
      "diff",
      "context",
      "background",
      "delegation",
      "monitor",
      "abort",
    ],
  },
  {
    slug: "session-prompt",
    title: "Prompting",
    section: "API Reference",
    tags: ["session-prompt"],
    summary:
      "The two entry points that send a prompt to a session: the synchronous call that returns the assistant message, and the async call that returns immediately and streams over the event feed.",
    keywords: ["prompt", "send message", "chat", "ask", "prompt_async", "streaming prompt", "run agent"],
  },
  {
    slug: "events",
    title: "Events",
    section: "API Reference",
    tags: ["events"],
    summary:
      "Server-sent event feeds. One feed is scoped to the resolved instance, the other spans every instance the server hosts.",
    keywords: ["events", "sse", "server sent events", "subscribe", "stream", "event feed", "realtime", "websocket"],
  },
  {
    slug: "file",
    title: "Files & Search",
    section: "API Reference",
    tags: ["file"],
    summary:
      "Reading and writing files in the resolved project, listing a directory, reading the working-tree status, and the three search endpoints behind text, filename and symbol lookup.",
    keywords: [
      "file",
      "read file",
      "write file",
      "list files",
      "find",
      "grep",
      "ripgrep",
      "search",
      "symbol",
      "file status",
    ],
  },
  {
    slug: "project",
    title: "Projects",
    section: "API Reference",
    tags: ["project"],
    summary:
      "Project registry: the known projects, the one the current request resolved to, the directories inside it, and the project-copy lifecycle.",
    keywords: ["project", "current project", "directory", "project copy", "worktree copy", "refresh"],
  },
  {
    slug: "experimental",
    title: "Tools & Worktrees",
    section: "API Reference",
    tags: ["experimental"],
    summary:
      "Experimental surface: the tool registry, the resource list, plain git worktrees, and the managed worktrees that carry parent/child links.",
    keywords: [
      "tool",
      "tool ids",
      "resource",
      "worktree",
      "managed worktree",
      "experimental",
      "link",
      "children",
      "ancestors",
    ],
  },
  {
    slug: "workspace",
    title: "Workspaces",
    section: "API Reference",
    tags: ["workspace", "workspace-extra"],
    summary:
      "Workspace contexts — create, list, restore and remove them, read their status and event feed, and warp a session from one workspace into another.",
    keywords: ["workspace", "warp", "restore", "adaptor", "sync list", "workspace events", "workspace status"],
  },
  {
    slug: "config",
    title: "Configuration",
    section: "API Reference",
    tags: ["config", "config-management"],
    summary:
      "Read and patch the merged nikcli config, reload it from disk, resolve the provider table, and manage MCP server entries and config profiles.",
    keywords: [
      "config",
      "configuration",
      "nikcli.json",
      "reload",
      "profiles",
      "activate profile",
      "mcp config",
      "providers",
    ],
  },
  {
    slug: "provider",
    title: "Providers & Auth",
    section: "API Reference",
    tags: ["provider", "auth"],
    summary:
      "Model providers and the credentials behind them: list providers and their auth state, set or remove an API key, and run the OAuth authorize/callback pair.",
    keywords: [
      "provider",
      "model",
      "api key",
      "auth",
      "oauth",
      "authorize",
      "callback",
      "credentials",
      "login provider",
    ],
  },
  {
    slug: "connectors",
    title: "Connectors",
    section: "API Reference",
    tags: ["connectors"],
    summary: "Connector status, per-connector credentials, and cache invalidation.",
    keywords: ["connector", "integration", "connector auth", "invalidate", "notion", "linear", "slack"],
  },
  {
    slug: "mcp",
    title: "MCP",
    section: "API Reference",
    tags: ["mcp"],
    summary:
      "Model Context Protocol servers: status, adding a server, connecting and disconnecting it, toggling it, and the OAuth flow for servers that need one.",
    keywords: ["mcp", "model context protocol", "mcp server", "connect", "disconnect", "toggle", "mcp auth", "oauth"],
  },
  {
    slug: "permission",
    title: "Permissions",
    section: "API Reference",
    tags: ["permission"],
    summary: "Pending permission requests and the reply that approves or denies one.",
    keywords: ["permission", "approve", "deny", "allow", "reject", "pending permission", "tool approval"],
  },
  {
    slug: "question",
    title: "Questions",
    section: "API Reference",
    tags: ["question"],
    summary: "Questions an agent has asked the user, and the reply or rejection that unblocks it.",
    keywords: ["question", "ask user", "reply", "reject", "clarification", "pending question"],
  },
  {
    slug: "loop",
    title: "Loops",
    section: "API Reference",
    tags: ["loop"],
    summary:
      "Loop definitions and their runs: list, upsert, generate from a description, toggle, run, pause, resume and abort, plus the run history.",
    keywords: ["loop", "recurring", "schedule", "run loop", "abort", "pause", "resume", "loop template", "loop runs"],
  },
  {
    slug: "mission",
    title: "Missions",
    section: "API Reference",
    tags: ["mission"],
    summary:
      "Mission definitions, their feature list, and the execution lifecycle — start, pause, cancel — along with recent executions.",
    keywords: ["mission", "feature", "execution", "start mission", "cancel", "mission template", "generate mission"],
  },
  {
    slug: "brain",
    title: "Brain",
    section: "API Reference",
    tags: ["brain"],
    summary: "Background learning status and the manual trigger that forces a pass.",
    keywords: ["brain", "learning", "habits", "memory", "trigger brain", "background learning"],
  },
  {
    slug: "profile",
    title: "Profile",
    section: "API Reference",
    tags: ["profile"],
    summary:
      "The declared user profile and the habits the Brain learned, plus the preview of what actually reaches the system prompt.",
    keywords: ["profile", "habits", "preferences", "system prompt", "preview", "clear profile"],
  },
  {
    slug: "analytics",
    title: "Analytics",
    section: "API Reference",
    tags: ["analytics"],
    summary:
      "Usage rollups: global and daily totals, per-session detail, the session list that backs the project breakdown, the leaderboard, and the combined data payload.",
    keywords: ["analytics", "usage", "tokens", "cost", "leaderboard", "daily", "stats", "heatmap"],
  },
  {
    slug: "sync",
    title: "Sync",
    section: "API Reference",
    tags: ["sync"],
    summary:
      "Event-sourced sync: push events, read the outbox and snapshots, stream changes, and manage the connection and drain.",
    keywords: ["sync", "outbox", "snapshot", "event stream", "drain", "connect", "sync stats", "replication"],
  },
  {
    slug: "pty",
    title: "Terminals",
    section: "API Reference",
    tags: ["pty", "pty-connect"],
    summary: "Pseudo-terminal sessions — create, resize, remove, and the upgrade endpoint that attaches to one.",
    keywords: ["pty", "terminal", "shell", "tty", "resize", "connect terminal", "websocket"],
  },
  {
    slug: "tui",
    title: "TUI Control",
    section: "API Reference",
    tags: ["tui"],
    summary:
      "The control channel a running terminal UI exposes: append or submit a prompt, open a dialog, execute a command, show a toast, and the request/response pair behind remote control.",
    keywords: [
      "tui",
      "terminal ui",
      "append prompt",
      "submit prompt",
      "toast",
      "open sessions",
      "open models",
      "control",
      "remote control",
    ],
  },
  {
    slug: "chatbot",
    title: "Chatbots",
    section: "API Reference",
    tags: ["chatbot"],
    summary: "Registered chat bots and the start/stop control for each one.",
    keywords: ["chatbot", "bot", "start bot", "stop bot", "telegram", "slack bot"],
  },
  {
    slug: "discord",
    title: "Discord",
    section: "API Reference",
    tags: ["discord"],
    summary: "Discord integration status, first-time setup, and the start/stop control.",
    keywords: ["discord", "bot", "setup discord", "start", "stop"],
  },
  {
    slug: "voice",
    title: "Voice",
    section: "API Reference",
    tags: ["voice"],
    summary: "Audio transcription for voice input.",
    keywords: ["voice", "transcribe", "audio", "speech to text", "whisper", "microphone"],
  },
  {
    slug: "app",
    title: "Skills & Logs",
    section: "API Reference",
    tags: ["app"],
    summary: "Creating and deleting skills, and the log sink clients write into.",
    keywords: ["skill", "create skill", "delete skill", "log", "logging"],
  },
  {
    slug: "account",
    title: "Accounts & Users",
    section: "API Reference",
    tags: ["account", "users"],
    summary:
      "The nikcli account behind a server (login and its completion step) and the local UserDB records the server owns.",
    keywords: ["account", "login", "sign in", "register", "user", "token", "nku", "auth code"],
  },
  {
    slug: "share",
    title: "Sharing",
    section: "API Reference",
    tags: ["share"],
    summary: "Public read endpoints for a shared session, in both the page and JSON forms.",
    keywords: ["share", "shared session", "public link", "share data", "share id"],
  },
  {
    slug: "global",
    title: "Health & Doctor",
    section: "API Reference",
    tags: ["global", "doctor"],
    summary: "Server health, global dispose, and the doctor report that checks the install end to end.",
    keywords: ["health", "healthcheck", "dispose", "doctor", "diagnostics", "status", "ping"],
  },
  {
    slug: "mobile",
    title: "Host & Bootstrap",
    section: "API · Mobile",
    tags: ["mobile"],
    exclude: [
      "/mobile/session",
      "/mobile/teleport",
      "/mobile/git",
      "/mobile/github",
      "/mobile/loops",
      "/mobile/missions",
      "/mobile/routines",
      "/mobile/pty",
    ],
    summary:
      "The mobile host surface: pairing tokens, the bootstrap payload the app opens with, projects and commands, memory, worktrees, and the host capability probes behind browser, computer, island, devtools and LAN.",
    keywords: [
      "mobile",
      "pairing",
      "pair token",
      "bootstrap",
      "mobile auth",
      "host",
      "lan",
      "island",
      "devtools",
      "memory",
      "stash",
      "fusion",
      "observability",
    ],
  },
  {
    slug: "mobile-session",
    title: "Sessions",
    section: "API · Mobile",
    tags: ["mobile"],
    include: ["/mobile/session", "/mobile/teleport"],
    summary:
      "Session endpoints shaped for the mobile app: list and create, send a message, stream updates, answer permissions and questions, read diffs and todos, and teleport a session between hosts.",
    keywords: [
      "mobile session",
      "mobile message",
      "mobile stream",
      "teleport",
      "mobile diff",
      "mobile todo",
      "rename session",
      "mobile permission",
    ],
  },
  {
    slug: "mobile-git",
    title: "Git & GitHub",
    section: "API · Mobile",
    tags: ["mobile"],
    include: ["/mobile/git", "/mobile/github"],
    summary:
      "The git toolbar behind the mobile review panel — status, diff, commits, branches, stage, commit, push and pull — plus the GitHub side: repos, branches, imports, Actions runs and the device OAuth flow.",
    keywords: [
      "mobile git",
      "commit",
      "push",
      "pull",
      "checkout",
      "stage",
      "discard",
      "github",
      "repos",
      "actions",
      "workflow",
      "rerun",
      "device flow",
      "import repo",
    ],
  },
  {
    slug: "mobile-automation",
    title: "Automation",
    section: "API · Mobile",
    tags: ["mobile"],
    include: ["/mobile/loops", "/mobile/missions", "/mobile/routines"],
    summary: "Loops, missions and routines as the mobile app drives them, including the tokenised routine trigger.",
    keywords: [
      "mobile loop",
      "mobile mission",
      "mobile routine",
      "trigger",
      "schedule",
      "automation",
      "run",
      "pause",
      "resume",
    ],
  },
  {
    slug: "mobile-pty",
    title: "Terminals",
    section: "API · Mobile",
    tags: ["mobile"],
    include: ["/mobile/pty"],
    summary: "Pseudo-terminals for the mobile app, including the connect endpoint the terminal view attaches to.",
    keywords: ["mobile pty", "mobile terminal", "shell", "connect", "resize"],
  },
]

export const apiGroupBySlug = new Map(apiGroups.map((group) => [group.slug, group]))

function matchesPrefix(path: string, prefixes: string[]) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/** Whether an operation belongs on a group's page. */
export function groupOwns(group: ApiGroup, path: string, tags: string[]) {
  if (!tags.some((tag) => group.tags.includes(tag))) return false
  if (group.include && !matchesPrefix(path, group.include)) return false
  if (group.exclude && matchesPrefix(path, group.exclude)) return false
  return true
}
