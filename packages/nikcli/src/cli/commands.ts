import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "./framework/spec"

/**
 * The command tree — names, descriptions and parameters, and nothing else.
 *
 * It began as generated output — transcribed from the yargs declarations it
 * replaced, and held to them by a parity harness while both existed. Those
 * declarations are gone, so this is now the source: edit it directly.
 *
 * This module must stay free of application imports: it is what `--help`,
 * command matching and shell completion read, so anything imported here is
 * evaluated by every invocation — the exact cost the split exists to avoid.
 * Implementations are loaded on demand by `framework/runtime.ts`.
 *
 * Mirrors opencode v2's `packages/cli/src/commands/commands.ts`.
 * See `specs/cli-framework.md`.
 */

const SpecAttach = Spec.make("attach", {
  description: "attach to a running nikcli server",
  params: {
    url: Argument.string("url").pipe(Argument.withDescription("http://localhost:4096")),
    dir: Flag.string("dir").pipe(Flag.withDescription("directory to run in"), Flag.optional),
    session: Flag.string("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("session id to continue"),
      Flag.optional,
    ),
  },
})

const SpecGenerate = Spec.make("generate")

const SpecAcp = Spec.make("acp", {
  description: "start ACP (Agent Client Protocol) server",
  params: {
    port: Flag.float("port").pipe(Flag.withDescription("port to listen on"), Flag.withDefault(0)),
    hostname: Flag.string("hostname").pipe(
      Flag.withDescription("hostname to listen on"),
      Flag.withDefault("127.0.0.1"),
    ),
    mdns: Flag.boolean("mdns").pipe(
      Flag.withDescription("enable mDNS service discovery (defaults hostname to 0.0.0.0)"),
      Flag.withDefault(false),
    ),
    cors: Flag.string("cors").pipe(Flag.withDescription("additional domains to allow for CORS"), Flag.atLeast(0)),
    cwd: Flag.string("cwd").pipe(
      Flag.withDescription("working directory"),
      Flag.withDefault("/Volumes/SSD/Projects/nikcli/packages/nikcli"),
    ),
  },
})

const SpecMcpAdd = Spec.make("add", {
  description: "add an MCP server",
})

const SpecMcpList = Spec.make("list", {
  description: "list MCP servers and their status",
})

const SpecMcpAuthList = Spec.make("list", {
  description: "list OAuth-capable MCP servers and their auth status",
})

const SpecMcpAuth = Spec.make("auth", {
  description: "authenticate with an OAuth-enabled MCP server",
  params: {
    name: Argument.string("name").pipe(Argument.withDescription("name of the MCP server"), Argument.optional),
  },
  commands: [SpecMcpAuthList],
})

const SpecMcpLogout = Spec.make("logout", {
  description: "remove OAuth credentials for an MCP server",
  params: {
    name: Argument.string("name").pipe(Argument.withDescription("name of the MCP server"), Argument.optional),
  },
})

const SpecMcpDebug = Spec.make("debug", {
  description: "debug OAuth connection for an MCP server",
  params: {
    name: Argument.string("name").pipe(Argument.withDescription("name of the MCP server")),
  },
})

const SpecMcp = Spec.make("mcp", {
  description: "manage MCP (Model Context Protocol) servers",
  commands: [SpecMcpAdd, SpecMcpList, SpecMcpAuth, SpecMcpLogout, SpecMcpDebug],
})

const SpecAutoModeDefaults = Spec.make("defaults", {
  description: "print the built-in auto mode classifier rules as JSON",
  params: {
    label: Flag.string("label").pipe(
      Flag.withDescription("only print rules whose label starts with this (case-insensitive)"),
      Flag.optional,
    ),
  },
})

const SpecAutoModeConfig = Spec.make("config", {
  description: "print the classifier rules auto mode actually uses, with your settings applied",
})

const SpecAutoModeCritique = Spec.make("critique", {
  description: "get AI feedback on your custom auto mode rules",
})

const SpecAutoModeReset = Spec.make("reset", {
  description: "remove your auto mode settings and return to the built-in rules",
  params: {
    yes: Flag.boolean("yes").pipe(Flag.withDescription("skip the confirmation"), Flag.withDefault(false)),
  },
})

const SpecAutoMode = Spec.make("auto-mode", {
  description: "inspect and manage the auto mode classifier rules",
  commands: [SpecAutoModeDefaults, SpecAutoModeConfig, SpecAutoModeCritique, SpecAutoModeReset],
})

const SpecAdsCreate = Spec.make("create", {
  description: "create a new ad",
  params: {
    id: Flag.string("id").pipe(Flag.withDescription("ad identifier"), Flag.optional),
    text: Flag.string("text").pipe(Flag.withDescription("ad text"), Flag.optional),
    url: Flag.string("url").pipe(Flag.withDescription("optional URL"), Flag.optional),
    disabled: Flag.boolean("disabled").pipe(Flag.withDescription("create the ad as disabled"), Flag.optional),
  },
})

const SpecAdsList = Spec.make("list", {
  description: "list ads",
})

const SpecAdsRemove = Spec.make("remove", {
  description: "remove an ad",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("ad identifier"), Argument.optional),
  },
})

const SpecAdsToggle = Spec.make("toggle", {
  description: "toggle an ad on or off",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("ad identifier"), Argument.optional),
  },
})

const SpecAdsEnable = Spec.make("enable", {
  description: "enable ads globally",
})

const SpecAdsDisable = Spec.make("disable", {
  description: "disable ads globally",
})

const SpecAds = Spec.make("ads", {
  description: "manage ads",
  commands: [SpecAdsCreate, SpecAdsList, SpecAdsRemove, SpecAdsToggle, SpecAdsEnable, SpecAdsDisable],
})

const SpecRun = Spec.make("run", {
  description: "run nikcli with a message",
  params: {
    message: Argument.string("message").pipe(Argument.withDescription("message to send"), Argument.variadic),
    command: Flag.string("command").pipe(
      Flag.withDescription("the command to run, use message for args"),
      Flag.optional,
    ),
    continue: Flag.boolean("continue").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("continue the last session"),
      Flag.optional,
    ),
    session: Flag.string("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("session id to continue"),
      Flag.optional,
    ),
    share: Flag.boolean("share").pipe(Flag.withDescription("share the session"), Flag.optional),
    model: Flag.string("model").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("model to use in the format of provider/model"),
      Flag.optional,
    ),
    agent: Flag.string("agent").pipe(Flag.withDescription("agent to use"), Flag.optional),
    format: Flag.choice("format", ["default", "json"]).pipe(
      Flag.withDescription("format: default (formatted) or json (raw JSON events)"),
      Flag.withDefault("default"),
    ),
    file: Flag.string("file").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("file(s) to attach to message"),
      Flag.atLeast(0),
    ),
    title: Flag.string("title").pipe(
      Flag.withDescription("title for the session (uses truncated prompt if no value provided)"),
      Flag.optional,
    ),
    attach: Flag.string("attach").pipe(
      Flag.withDescription("attach to a running nikcli server (e.g., http://localhost:4096)"),
      Flag.optional,
    ),
    port: Flag.float("port").pipe(
      Flag.withDescription("port for the local server (defaults to random port if no value provided)"),
      Flag.optional,
    ),
    variant: Flag.string("variant").pipe(
      Flag.withDescription("model variant (provider-specific reasoning effort, e.g., high, max, minimal)"),
      Flag.optional,
    ),
  },
})

const SpecGoal = Spec.make("goal", {
  description: "work autonomously until a verifiable goal condition is met",
  params: {
    condition: Argument.string("condition").pipe(
      Argument.withDescription("completion condition to satisfy"),
      Argument.variadic,
    ),
    continue: Flag.boolean("continue").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("continue the last session"),
      Flag.optional,
    ),
    session: Flag.string("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("session id to continue"),
      Flag.optional,
    ),
    model: Flag.string("model").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("model to use in the format of provider/model"),
      Flag.optional,
    ),
    agent: Flag.string("agent").pipe(Flag.withDescription("agent to use"), Flag.optional),
    variant: Flag.string("variant").pipe(
      Flag.withDescription("model variant (provider-specific reasoning effort, e.g., high, max, minimal)"),
      Flag.optional,
    ),
    "token-budget": Flag.float("token-budget").pipe(
      Flag.withDescription("optional token budget for automatic goal continuation"),
      Flag.optional,
    ),
    format: Flag.choice("format", ["default", "json"]).pipe(
      Flag.withDescription("format: default (formatted) or json (raw JSON events)"),
      Flag.withDefault("default"),
    ),
  },
})

const SpecAnalyticsShow = Spec.make("show", {
  description: "print the aggregate dataset behind /data for this install",
  params: {
    today: Flag.boolean("today").pipe(Flag.withDescription("just today"), Flag.withDefault(false)),
    week: Flag.boolean("week").pipe(Flag.withDescription("the last 7 days"), Flag.withDefault(false)),
    month: Flag.boolean("month").pipe(Flag.withDescription("the last 30 days"), Flag.withDefault(false)),
    all: Flag.boolean("all").pipe(Flag.withDescription("every day on record (default)"), Flag.withDefault(false)),
    json: Flag.boolean("json").pipe(Flag.withDescription("print the raw dataset"), Flag.withDefault(false)),
  },
})

const SpecAnalyticsPublish = Spec.make("publish", {
  description: "send this install's rollups to the collector now",
  params: {
    today: Flag.boolean("today").pipe(Flag.withDescription("just today"), Flag.withDefault(false)),
    week: Flag.boolean("week").pipe(Flag.withDescription("the last 7 days"), Flag.withDefault(false)),
    month: Flag.boolean("month").pipe(Flag.withDescription("the last 30 days"), Flag.withDefault(false)),
    all: Flag.boolean("all").pipe(Flag.withDescription("every day on record (default)"), Flag.withDefault(false)),
  },
})

const SpecAnalytics = Spec.make("analytics", {
  description: "inspect and publish local usage rollups",
  commands: [SpecAnalyticsShow, SpecAnalyticsPublish],
})

const SpecApi = Spec.make("api", {
  description: "call one endpoint of the HTTP contract",
  params: {
    request: Argument.string("request").pipe(
      Argument.withDescription("operation id, or an HTTP method followed by a path"),
      Argument.variadic,
    ),
    data: Flag.string("data").pipe(Flag.withAlias("d"), Flag.withDescription("request body (JSON)"), Flag.optional),
    param: Flag.string("param").pipe(
      Flag.withAlias("p"),
      Flag.withDescription("path or query parameter, as name=value"),
      Flag.atLeast(0),
    ),
    header: Flag.string("header").pipe(
      Flag.withAlias("H"),
      Flag.withDescription("request header, as name:value"),
      Flag.atLeast(0),
    ),
    list: Flag.boolean("list").pipe(Flag.withDescription("list every declared operation and exit"), Flag.optional),
    directory: Flag.string("directory").pipe(
      Flag.withDescription("project directory to scope the request to"),
      Flag.optional,
    ),
  },
})

const SpecDebugConfig = Spec.make("config", {
  description: "show resolved configuration",
})

const SpecDebugLspDiagnostics = Spec.make("diagnostics", {
  description: "get diagnostics for a file",
  params: {
    file: Argument.string("file"),
  },
})

const SpecDebugLspSymbols = Spec.make("symbols", {
  description: "search workspace symbols",
  params: {
    query: Argument.string("query"),
  },
})

const SpecDebugLspDocumentSymbols = Spec.make("document-symbols", {
  description: "get symbols from a document",
  params: {
    uri: Argument.string("uri"),
  },
})

const SpecDebugLsp = Spec.make("lsp", {
  description: "LSP debugging utilities",
  commands: [SpecDebugLspDiagnostics, SpecDebugLspSymbols, SpecDebugLspDocumentSymbols],
})

const SpecDebugSearchTree = Spec.make("tree", {
  description: "show file tree using fff",
  params: {
    limit: Flag.float("limit").pipe(Flag.withDescription("Max nodes to render"), Flag.optional),
  },
})

const SpecDebugSearchFiles = Spec.make("files", {
  description: "list files using fff",
  params: {
    query: Flag.string("query").pipe(Flag.withDescription("Filter files by query"), Flag.optional),
    glob: Flag.string("glob").pipe(Flag.withDescription("Glob pattern to match files"), Flag.optional),
    limit: Flag.float("limit").pipe(Flag.withDescription("Limit number of results"), Flag.optional),
  },
})

const SpecDebugSearchContent = Spec.make("content", {
  description: "search file contents using fff",
  params: {
    pattern: Argument.string("pattern").pipe(Argument.withDescription("Search pattern")),
    mode: Flag.choice("mode", ["plain", "regex", "fuzzy"]).pipe(
      Flag.withDescription("Grep mode"),
      Flag.withDefault("plain"),
    ),
    limit: Flag.float("limit").pipe(Flag.withDescription("Limit number of results"), Flag.optional),
  },
})

const SpecDebugSearch = Spec.make("search", {
  description: "fff search debugging utilities",
  commands: [SpecDebugSearchTree, SpecDebugSearchFiles, SpecDebugSearchContent],
})

const SpecDebugFileRead = Spec.make("read", {
  description: "read file contents as JSON",
  params: {
    path: Argument.string("path").pipe(Argument.withDescription("File path to read")),
  },
})

const SpecDebugFileStatus = Spec.make("status", {
  description: "show file status information",
})

const SpecDebugFileList = Spec.make("list", {
  description: "list files in a directory",
  params: {
    path: Argument.string("path").pipe(Argument.withDescription("File path to list")),
  },
})

const SpecDebugFileSearch = Spec.make("search", {
  description: "search files by query",
  params: {
    query: Argument.string("query").pipe(Argument.withDescription("Search query")),
  },
})

const SpecDebugFileTree = Spec.make("tree", {
  description: "show directory tree",
  params: {
    dir: Argument.string("dir").pipe(
      Argument.withDescription("Directory to tree"),
      Argument.withDefault("/Volumes/SSD/Projects/nikcli/packages/nikcli"),
    ),
  },
})

const SpecDebugFile = Spec.make("file", {
  description: "file system debugging utilities",
  commands: [SpecDebugFileRead, SpecDebugFileStatus, SpecDebugFileList, SpecDebugFileSearch, SpecDebugFileTree],
})

const SpecDebugScrap = Spec.make("scrap", {
  description: "list all known projects",
})

const SpecDebugSkill = Spec.make("skill", {
  description: "list all available skills",
})

const SpecDebugSnapshotTrack = Spec.make("track", {
  description: "track current snapshot state",
})

const SpecDebugSnapshotPatch = Spec.make("patch", {
  description: "show patch for a snapshot hash",
  params: {
    hash: Argument.string("hash").pipe(Argument.withDescription("hash")),
  },
})

const SpecDebugSnapshotDiff = Spec.make("diff", {
  description: "show diff for a snapshot hash",
  params: {
    hash: Argument.string("hash").pipe(Argument.withDescription("hash")),
  },
})

const SpecDebugSnapshot = Spec.make("snapshot", {
  description: "snapshot debugging utilities",
  commands: [SpecDebugSnapshotTrack, SpecDebugSnapshotPatch, SpecDebugSnapshotDiff],
})

const SpecDebugAgent = Spec.make("agent", {
  description: "show agent configuration details",
  params: {
    name: Argument.string("name").pipe(Argument.withDescription("Agent name")),
    tool: Flag.string("tool").pipe(Flag.withDescription("Tool id to execute"), Flag.optional),
    params: Flag.string("params").pipe(
      Flag.withDescription("Tool params as JSON or a JS object literal"),
      Flag.optional,
    ),
  },
})

const SpecDebugPaths = Spec.make("paths", {
  description: "show global paths (data, config, cache, state)",
})

const SpecDebugWait = Spec.make("wait", {
  description: "wait indefinitely (for debugging)",
})

const SpecDebug = Spec.make("debug", {
  description: "debugging and troubleshooting tools",
  commands: [
    SpecDebugConfig,
    SpecDebugLsp,
    SpecDebugSearch,
    SpecDebugFile,
    SpecDebugScrap,
    SpecDebugSkill,
    SpecDebugSnapshot,
    SpecDebugAgent,
    SpecDebugPaths,
    SpecDebugWait,
  ],
})

const SpecAuthLogin = Spec.make("login", {
  description: "log in to a provider",
  params: {
    url: Argument.string("url").pipe(Argument.withDescription("nikcli auth provider"), Argument.optional),
    provider: Flag.boolean("provider").pipe(
      Flag.withDescription("Log in to an LLM provider instead of your nikcli account"),
      Flag.withDefault(false),
    ),
    server: Flag.string("server").pipe(Flag.withAlias("s"), Flag.withDescription("Identity issuer URL"), Flag.optional),
  },
})

const SpecAuthLogout = Spec.make("logout", {
  description: "log out from a configured provider",
})

const SpecAuthList = Spec.make("list", {
  description: "list providers",
})

const SpecAuth = Spec.make("auth", {
  description: "manage credentials",
  commands: [SpecAuthLogin, SpecAuthLogout, SpecAuthList],
})

const SpecAccountLogin = Spec.make("login", {
  description: "log in with device code",
  params: {
    server: Flag.string("server").pipe(Flag.withAlias("s"), Flag.withDescription("Auth server URL"), Flag.optional),
  },
})

const SpecAccountLogout = Spec.make("logout", {
  description: "log out from an account",
  params: {
    "account-id": Argument.string("account-id").pipe(
      Argument.withDescription("Account ID to log out from"),
      Argument.optional,
    ),
  },
})

const SpecAccountList = Spec.make("list", {
  description: "list accounts",
})

const SpecAccountSwitch = Spec.make("switch", {
  description: "switch active account",
  params: {
    "account-id": Argument.string("account-id").pipe(
      Argument.withDescription("Account ID to switch to"),
      Argument.optional,
    ),
  },
})

const SpecAccountOrgs = Spec.make("orgs", {
  description: "list organizations for an account",
  params: {
    "account-id": Argument.string("account-id").pipe(
      Argument.withDescription("Account ID to list orgs for (defaults to active)"),
      Argument.optional,
    ),
  },
})

const SpecAccount = Spec.make("account", {
  description: "manage accounts",
  commands: [SpecAccountLogin, SpecAccountLogout, SpecAccountList, SpecAccountSwitch, SpecAccountOrgs],
})

const SpecArtifactLogin = Spec.make("login", {
  description: "verify the active CLI user used for artifact publishing",
})

const SpecArtifactLogout = Spec.make("logout", {
  description: "explain how artifact authentication follows the CLI account",
})

const SpecArtifactList = Spec.make("list", {
  description: "list artifacts published from a session",
  params: {
    "session-id": Argument.string("session-id").pipe(
      Argument.withDescription("Session ID (lists artifacts for this session)"),
      Argument.optional,
    ),
  },
})

const SpecArtifact = Spec.make("artifact", {
  description: "manage published artifacts (nikcli-ai.dev/artifact)",
  commands: [SpecArtifactLogin, SpecArtifactLogout, SpecArtifactList],
})

const SpecAgentCreate = Spec.make("create", {
  description: "create a new agent",
  params: {
    path: Flag.string("path").pipe(Flag.withDescription("directory path to generate the agent file"), Flag.optional),
    description: Flag.string("description").pipe(Flag.withDescription("what the agent should do"), Flag.optional),
    mode: Flag.choice("mode", ["all", "primary", "subagent"]).pipe(Flag.withDescription("agent mode"), Flag.optional),
    tools: Flag.string("tools").pipe(
      Flag.withDescription(
        'comma-separated list of tools to enable (default: all). Available: "bash, read, write, edit, generate_image, speak, list, glob, grep, webfetch, task, todowrite, todoread"',
      ),
      Flag.optional,
    ),
    model: Flag.string("model").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("model to use in the format of provider/model"),
      Flag.optional,
    ),
  },
})

const SpecAgentList = Spec.make("list", {
  description: "list all available agents",
})

const SpecAgent = Spec.make("agent", {
  description: "manage agents",
  commands: [SpecAgentCreate, SpecAgentList],
})

const SpecUpgrade = Spec.make("upgrade", {
  description: "upgrade nikcli to the latest or a specific version",
  params: {
    target: Argument.string("target").pipe(
      Argument.withDescription("version to upgrade to, for ex '0.1.48' or 'v0.1.48'"),
      Argument.optional,
    ),
    method: Flag.choice("method", ["curl", "npm", "yarn", "pnpm", "bun", "brew", "choco", "scoop"]).pipe(
      Flag.withAlias("m"),
      Flag.withDescription("installation method to use"),
      Flag.optional,
    ),
  },
})

const SpecQuickstart = Spec.make("quickstart", {
  description: "interactive walkthrough for first-time nikcli users",
  params: {
    "skip-checks": Flag.boolean("skip-checks").pipe(
      Flag.withDescription("skip the connectivity and config checks"),
      Flag.optional,
    ),
    "dry-run": Flag.boolean("dry-run").pipe(
      Flag.withDescription("print the next-step command without running it"),
      Flag.optional,
    ),
  },
})

const SpecDoctor = Spec.make("doctor", {
  description: "diagnose common nikcli setup issues",
  params: {
    json: Flag.boolean("json").pipe(
      Flag.withDescription("emit a JSON report instead of a human-readable one"),
      Flag.optional,
    ),
  },
})

const SpecUninstall = Spec.make("uninstall", {
  description: "uninstall nikcli and remove all related files",
  params: {
    "keep-config": Flag.boolean("keep-config").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("keep configuration files"),
      Flag.withDefault(false),
    ),
    "keep-data": Flag.boolean("keep-data").pipe(
      Flag.withAlias("d"),
      Flag.withDescription("keep session data and snapshots"),
      Flag.withDefault(false),
    ),
    "dry-run": Flag.boolean("dry-run").pipe(
      Flag.withDescription("show what would be removed without removing"),
      Flag.withDefault(false),
    ),
    force: Flag.boolean("force").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("skip confirmation prompts"),
      Flag.withDefault(false),
    ),
  },
})

const SpecServe = Spec.make("serve", {
  description: "starts a headless nikcli server",
  params: {
    port: Flag.float("port").pipe(Flag.withDescription("port to listen on"), Flag.withDefault(0)),
    hostname: Flag.string("hostname").pipe(
      Flag.withDescription("hostname to listen on"),
      Flag.withDefault("127.0.0.1"),
    ),
    mdns: Flag.boolean("mdns").pipe(
      Flag.withDescription("enable mDNS service discovery (defaults hostname to 0.0.0.0)"),
      Flag.withDefault(false),
    ),
    cors: Flag.string("cors").pipe(Flag.withDescription("additional domains to allow for CORS"), Flag.atLeast(0)),
    stdio: Flag.boolean("stdio").pipe(
      Flag.withDescription("print the readiness handshake as a single JSON line on stdout (for parent processes)"),
      Flag.withDefault(false),
    ),
    service: Flag.boolean("service").pipe(
      Flag.withDescription("run as the shared background service: publish a registration clients can discover"),
      Flag.withDefault(false),
    ),
  },
})

const SpecServiceStart = Spec.make("start", {
  description: "start the background service if it is not already running",
})

const SpecServiceStop = Spec.make("stop", {
  description: "stop the background service",
})

const SpecServiceRestart = Spec.make("restart", {
  description: "restart the background service",
})

const SpecServiceStatus = Spec.make("status", {
  description: "show whether the background service is running",
  params: {
    json: Flag.boolean("json").pipe(Flag.withDescription("print the status as JSON"), Flag.withDefault(false)),
  },
})

const SpecServiceGet = Spec.make("get", {
  description: "show the service settings, or one of them",
  params: {
    key: Argument.string("key").pipe(Argument.withDescription("hostname | port | cors | env"), Argument.optional),
  },
})

const SpecServiceSet = Spec.make("set", {
  description: "change a service setting and stop the running service",
  params: {
    key: Argument.string("key").pipe(Argument.withDescription("hostname | port | cors | env")),
    value: Argument.string("value").pipe(Argument.withDescription("the value, or the env var name")),
    nested: Argument.string("nested").pipe(
      Argument.withDescription("the env var value, for `set env <name> <value>`"),
      Argument.optional,
    ),
  },
})

const SpecServiceUnset = Spec.make("unset", {
  description: "clear a service setting and stop the running service",
  params: {
    key: Argument.string("key").pipe(Argument.withDescription("hostname | port | cors | env")),
    nested: Argument.string("nested").pipe(
      Argument.withDescription("the env var name, for `unset env <name>`"),
      Argument.optional,
    ),
  },
})

const SpecServicePassword = Spec.make("password", {
  description: "print the service password (username nikcli), or replace it and stop the running service",
  params: {
    value: Argument.string("value").pipe(Argument.withDescription("the new password"), Argument.optional),
  },
})

const SpecService = Spec.make("service", {
  description: "manage the shared background nikcli service",
  commands: [
    SpecServiceStart,
    SpecServiceStop,
    SpecServiceRestart,
    SpecServiceStatus,
    SpecServiceGet,
    SpecServiceSet,
    SpecServiceUnset,
    SpecServicePassword,
  ],
})

const SpecWorkspaceServe = Spec.make("workspace-serve", {
  description: "starts a remote workspace event server",
  params: {
    port: Flag.float("port").pipe(Flag.withDescription("port to listen on"), Flag.withDefault(0)),
    hostname: Flag.string("hostname").pipe(
      Flag.withDescription("hostname to listen on"),
      Flag.withDefault("127.0.0.1"),
    ),
    mdns: Flag.boolean("mdns").pipe(
      Flag.withDescription("enable mDNS service discovery (defaults hostname to 0.0.0.0)"),
      Flag.withDefault(false),
    ),
    cors: Flag.string("cors").pipe(Flag.withDescription("additional domains to allow for CORS"), Flag.atLeast(0)),
  },
})

const SpecWeb = Spec.make("web", {
  description: "start nikcli server and open web interface",
  params: {
    port: Flag.float("port").pipe(Flag.withDescription("port to listen on"), Flag.withDefault(0)),
    hostname: Flag.string("hostname").pipe(
      Flag.withDescription("hostname to listen on"),
      Flag.withDefault("127.0.0.1"),
    ),
    mdns: Flag.boolean("mdns").pipe(
      Flag.withDescription("enable mDNS service discovery (defaults hostname to 0.0.0.0)"),
      Flag.withDefault(false),
    ),
    cors: Flag.string("cors").pipe(Flag.withDescription("additional domains to allow for CORS"), Flag.atLeast(0)),
  },
})

const SpecHeap = Spec.make("heap", {
  description: "show heap and process memory metrics",
  params: {
    detailed: Flag.boolean("detailed").pipe(
      Flag.withAlias("a"),
      Flag.withDescription("show all available memory metrics"),
      Flag.optional,
    ),
  },
})

const SpecModels = Spec.make("models", {
  description: "list all available models",
  params: {
    provider: Argument.string("provider").pipe(
      Argument.withDescription("provider ID to filter models by"),
      Argument.optional,
    ),
    verbose: Flag.boolean("verbose").pipe(
      Flag.withDescription("use more verbose model output (includes metadata like costs)"),
      Flag.optional,
    ),
    refresh: Flag.boolean("refresh").pipe(
      Flag.withDescription("refresh the models cache from models.dev"),
      Flag.optional,
    ),
  },
})

const SpecLocale = Spec.make("locale", {
  description: "show or set the CLI language, region, and the model's reply language",
  params: {
    action: Argument.choice("action", ["show", "set", "reset"]).pipe(
      Argument.withDescription("show the resolved locale, set overrides, or reset to auto-detect"),
      Argument.withDefault("show"),
    ),
    language: Flag.string("language").pipe(Flag.withDescription("language subtag, e.g. it, ja, ar"), Flag.optional),
    region: Flag.string("region").pipe(Flag.withDescription("ISO-3166 country code, e.g. IT, JP"), Flag.optional),
    locale: Flag.string("locale").pipe(
      Flag.withDescription("full BCP-47 tag, e.g. it-IT (overrides language + region)"),
      Flag.optional,
    ),
    timezone: Flag.string("timezone").pipe(Flag.withDescription("IANA timezone, e.g. Europe/Rome"), Flag.optional),
    currency: Flag.string("currency").pipe(Flag.withDescription("ISO-4217 currency code, e.g. EUR"), Flag.optional),
    "reply-language": Flag.string("reply-language").pipe(
      Flag.withDescription("model reply language: true | false | <tag> (e.g. fr)"),
      Flag.optional,
    ),
    "no-auto-detect": Flag.boolean("no-auto-detect").pipe(
      Flag.withDescription("disable auto-detection from environment"),
      Flag.optional,
    ),
    global: Flag.boolean("global").pipe(
      Flag.withDescription("edit global config instead of project config"),
      Flag.withDefault(true),
    ),
  },
})

const SpecStats = Spec.make("stats", {
  description: "show token usage and cost statistics",
  params: {
    days: Flag.float("days").pipe(
      Flag.withDescription("show stats for the last N days (default: all time)"),
      Flag.optional,
    ),
    tools: Flag.float("tools").pipe(Flag.withDescription("number of tools to show (default: all)"), Flag.optional),
    models: Flag.string("models").pipe(
      Flag.withDescription("show model statistics (default: hidden). Pass a number to show top N, otherwise shows all"),
      Flag.optional,
    ),
    project: Flag.string("project").pipe(
      Flag.withDescription("filter by project (default: all projects, empty string: current project)"),
      Flag.optional,
    ),
  },
})

const SpecExport = Spec.make("export", {
  description: "export session data as JSON",
  params: {
    sessionID: Argument.string("sessionID").pipe(Argument.withDescription("session id to export"), Argument.optional),
  },
})

const SpecImport = Spec.make("import", {
  description: "import session data from JSON file or URL",
  params: {
    file: Argument.string("file").pipe(Argument.withDescription("path to JSON file or share URL")),
  },
})

const SpecGithubInstall = Spec.make("install", {
  description: "install the GitHub agent",
})

const SpecGithubRun = Spec.make("run", {
  description: "run the GitHub agent",
  params: {
    event: Flag.string("event").pipe(Flag.withDescription("GitHub mock event to run the agent for"), Flag.optional),
    token: Flag.string("token").pipe(
      Flag.withDescription("GitHub personal access token (github_pat_********)"),
      Flag.optional,
    ),
  },
})

const SpecGithub = Spec.make("github", {
  description: "manage GitHub agent",
  commands: [SpecGithubInstall, SpecGithubRun],
})

const SpecPr = Spec.make("pr", {
  description: "fetch and checkout a GitHub PR branch, then run nikcli",
  params: {
    number: Argument.float("number").pipe(Argument.withDescription("PR number to checkout")),
  },
})

const SpecSessionList = Spec.make("list", {
  description: "list sessions",
  params: {
    "max-count": Flag.float("max-count").pipe(
      Flag.withAlias("n"),
      Flag.withDescription("limit to N most recent sessions"),
      Flag.optional,
    ),
    format: Flag.choice("format", ["table", "json"]).pipe(
      Flag.withDescription("output format"),
      Flag.withDefault("table"),
    ),
  },
})

const SpecSession = Spec.make("session", {
  description: "manage sessions",
  commands: [SpecSessionList],
})

const SpecImageModel = Spec.make("image-model", {
  description: "list or set image generation models",
  params: {
    provider: Argument.string("provider").pipe(
      Argument.withDescription(
        "provider ID to use for image generation (e.g., openai, google, xai, togetherai, openrouter). See presets: gpt_image, imagen_4, grok_imagine, flux_dev, nanobanana.",
      ),
      Argument.optional,
    ),
    model: Argument.string("model").pipe(
      Argument.withDescription(
        "image model ID (e.g., gpt-image-1, imagen-4.0-generate-001, grok-imagine-image, black-forest-labs/FLUX.1-dev, openai/gpt-5-image)",
      ),
      Argument.optional,
    ),
    reset: Flag.boolean("reset").pipe(Flag.withDescription("reset image config to defaults"), Flag.withDefault(false)),
    global: Flag.boolean("global").pipe(
      Flag.withDescription("edit global config instead of project config"),
      Flag.withDefault(false),
    ),
    refresh: Flag.boolean("refresh").pipe(
      Flag.withDescription("refresh the models cache from models.dev"),
      Flag.withDefault(false),
    ),
  },
})

const SpecSpeakModel = Spec.make("speak-model", {
  description: "list or set TTS (speak) models",
  params: {
    provider: Argument.string("provider").pipe(
      Argument.withDescription("TTS provider ID (e.g., elevenlabs, openrouter)"),
      Argument.optional,
    ),
    model: Argument.string("model").pipe(Argument.withDescription("TTS model/voice ID to use"), Argument.optional),
    reset: Flag.boolean("reset").pipe(Flag.withDescription("reset speak config to defaults"), Flag.withDefault(false)),
    global: Flag.boolean("global").pipe(
      Flag.withDescription("edit global config instead of project config"),
      Flag.withDefault(false),
    ),
  },
})

const SpecBrainModel = Spec.make("brain-model", {
  description: "list or set the model used by Brain memory consolidation",
  params: {
    model: Argument.string("model").pipe(
      Argument.withDescription("model to use in the format of provider/model (e.g. anthropic/claude-sonnet-4-5)"),
      Argument.optional,
    ),
    reset: Flag.boolean("reset").pipe(
      Flag.withDescription("reset the brain model back to the default"),
      Flag.withDefault(false),
    ),
    global: Flag.boolean("global").pipe(
      Flag.withDescription("edit global config instead of project config"),
      Flag.withDefault(false),
    ),
    refresh: Flag.boolean("refresh").pipe(
      Flag.withDescription("refresh the models cache from models.dev"),
      Flag.withDefault(false),
    ),
  },
})

const SpecRemoteStart = Spec.make("start", {
  description: "start a new remote control session",
  params: {
    port: Flag.float("port").pipe(Flag.withDescription("port to listen on"), Flag.withDefault(0)),
    hostname: Flag.string("hostname").pipe(Flag.withDescription("hostname to listen on"), Flag.withDefault("0.0.0.0")),
    mdns: Flag.boolean("mdns").pipe(
      Flag.withDescription("enable mDNS service discovery (defaults hostname to 0.0.0.0)"),
      Flag.withDefault(false),
    ),
    cors: Flag.string("cors").pipe(Flag.withDescription("additional domains to allow for CORS"), Flag.atLeast(0)),
    name: Flag.string("name").pipe(
      Flag.withAlias("n"),
      Flag.withDescription("terminal remote session name"),
      Flag.optional,
    ),
    timeout: Flag.string("timeout").pipe(
      Flag.withAlias("t"),
      Flag.withDescription("connection timeout in seconds"),
      Flag.withDefault("15"),
    ),
    "no-tunnel": Flag.boolean("no-tunnel").pipe(
      Flag.withDescription("disable public tunnel (use local network only)"),
      Flag.withDefault(false),
    ),
    provider: Flag.string("provider").pipe(
      Flag.withDescription("tunnel provider (localtunnel, cloudflared, ngrok, remotosh)"),
      Flag.optional,
    ),
    cloud: Flag.boolean("cloud").pipe(Flag.withDescription("enable cloud relay mode"), Flag.withDefault(false)),
    "cloud-url": Flag.string("cloud-url").pipe(Flag.withDescription("cloud relay base URL"), Flag.optional),
    "cloud-token": Flag.string("cloud-token").pipe(Flag.withDescription("cloud relay bearer token"), Flag.optional),
    "cloud-device-id": Flag.string("cloud-device-id").pipe(
      Flag.withDescription("cloud relay device identifier"),
      Flag.optional,
    ),
    "cloud-session-id": Flag.string("cloud-session-id").pipe(
      Flag.withDescription("override cloud relay session ID"),
      Flag.optional,
    ),
    "cloud-public-key": Flag.string("cloud-public-key").pipe(
      Flag.withDescription("optional E2E public key to register with cloud"),
      Flag.optional,
    ),
    mobile: Flag.boolean("mobile").pipe(
      Flag.withDescription("also start the /mobile API host and print an app pairing QR"),
      Flag.withDefault(false),
    ),
    "mobile-only": Flag.boolean("mobile-only").pipe(
      Flag.withDescription("start only the mobile-compatible /mobile API host"),
      Flag.withDefault(false),
    ),
    "public-url": Flag.string("public-url").pipe(
      Flag.withDescription("public HTTPS URL used by the mobile app outside your LAN or tailnet"),
      Flag.optional,
    ),
    pair: Flag.boolean("pair").pipe(
      Flag.withDescription("create and print a mobile pairing token when the mobile host is enabled"),
      Flag.withDefault(true),
    ),
    "pair-name": Flag.string("pair-name").pipe(
      Flag.withDescription("name for the generated mobile pairing token"),
      Flag.withDefault("iphone"),
    ),
    "pair-expiry-days": Flag.float("pair-expiry-days").pipe(
      Flag.withDescription("optional mobile pairing token expiry in days"),
      Flag.optional,
    ),
  },
})

const SpecRemoteStop = Spec.make("stop", {
  description: "stop the active remote session",
})

const SpecRemoteStatus = Spec.make("status", {
  description: "show remote session status",
  params: {
    json: Flag.boolean("json").pipe(Flag.withDescription("output as JSON"), Flag.optional),
  },
})

const SpecRemoteShare = Spec.make("share", {
  description: "get shareable session link",
})

const SpecRemoteAttach = Spec.make("attach", {
  description: "attach to an existing session",
  params: {
    // Declared only in yargs' command string (`attach <sessionId>`), never via
    // `.positional()`, so the generator never saw it.
    sessionId: Argument.string("sessionId").pipe(Argument.withDescription("session to attach to")),
  },
})

const SpecRemote = Spec.make("remote", {
  description: "manage terminal and mobile app remote control sessions",
  params: {
    // Same: `remote [command]` declared the positional in the command string.
    command: Argument.string("command").pipe(Argument.withDescription("subcommand to run"), Argument.optional),
  },
  commands: [SpecRemoteStart, SpecRemoteStop, SpecRemoteStatus, SpecRemoteShare, SpecRemoteAttach],
})

const SpecTeleport = Spec.make("teleport", {
  description: "teleport a session to a remote nikcli server to continue it from mobile",
  params: {
    sessionID: Argument.string("sessionID").pipe(
      Argument.withDescription("session id to teleport (defaults to interactive selection)"),
      Argument.optional,
    ),
    url: Flag.string("url").pipe(
      Flag.withAlias("u"),
      Flag.withDescription("remote server base URL (e.g. https://my-app.up.railway.app)"),
      Flag.optional,
    ),
    token: Flag.string("token").pipe(
      Flag.withAlias("t"),
      Flag.withDescription("mobile Bearer token for the remote server"),
      Flag.optional,
    ),
    content: Flag.boolean("content").pipe(
      Flag.withDescription("clone the working directory (source files, no binaries) to the server"),
      Flag.withDefault(true),
    ),
    git: Flag.boolean("git").pipe(
      Flag.withDescription("also include the full .git history (large — off by default)"),
      Flag.withDefault(false),
    ),
    save: Flag.boolean("save").pipe(
      Flag.withDescription("remember the server URL and token for next time"),
      Flag.withDefault(true),
    ),
  },
})

const SpecCompanionServe = Spec.make("serve", {
  description: "Start the nikcli server with companion UI",
  params: {
    port: Flag.float("port").pipe(Flag.withDescription("Port to run the server on"), Flag.withDefault(4096)),
    host: Flag.string("host").pipe(Flag.withDescription("Host to bind to"), Flag.withDefault("0.0.0.0")),
  },
})

const SpecCompanionOpen = Spec.make("open", {
  description: "Open the companion UI in browser",
  params: {
    port: Flag.float("port").pipe(Flag.withDescription("Port where server is running"), Flag.withDefault(4096)),
    session: Flag.string("session").pipe(Flag.withDescription("Session ID to connect to"), Flag.optional),
  },
})

const SpecCompanion = Spec.make("companion", {
  description: "Web UI for nikcli sessions",
  commands: [SpecCompanionServe, SpecCompanionOpen],
})

const SpecMobileServe = Spec.make("serve", {
  description: "start nikcli with mobile-friendly defaults",
  params: {
    port: Flag.float("port").pipe(Flag.withDescription("port to listen on"), Flag.withDefault(0)),
    hostname: Flag.string("hostname").pipe(Flag.withDescription("hostname to listen on"), Flag.withDefault("0.0.0.0")),
    mdns: Flag.boolean("mdns").pipe(
      Flag.withDescription("enable mDNS service discovery (defaults hostname to 0.0.0.0)"),
      Flag.withDefault(false),
    ),
    cors: Flag.string("cors").pipe(Flag.withDescription("additional domains to allow for CORS"), Flag.atLeast(0)),
    "public-url": Flag.string("public-url").pipe(
      Flag.withDescription("public HTTPS URL used by the mobile app outside your tailnet"),
      Flag.optional,
    ),
    pair: Flag.boolean("pair").pipe(
      Flag.withDescription("create and print a new mobile pairing token at startup"),
      Flag.withDefault(false),
    ),
    "pair-name": Flag.string("pair-name").pipe(
      Flag.withDescription("name for the generated pairing token"),
      Flag.withDefault("iphone"),
    ),
    "pair-expiry-days": Flag.float("pair-expiry-days").pipe(
      Flag.withDescription("optional token expiry in days"),
      Flag.optional,
    ),
  },
})

const SpecMobilePair = Spec.make("pair", {
  description: "generate a mobile pairing token and QR code",
  params: {
    "public-url": Flag.string("public-url").pipe(
      Flag.withDescription("public server URL the mobile app should connect to"),
    ),
    name: Flag.string("name").pipe(Flag.withDescription("token label"), Flag.withDefault("iphone")),
    "expiry-days": Flag.float("expiry-days").pipe(Flag.withDescription("optional token expiry in days"), Flag.optional),
    directory: Flag.string("directory").pipe(
      Flag.withDescription("default directory or repo path for the paired app"),
      Flag.optional,
    ),
  },
})

const SpecMobileTokenList = Spec.make("list", {
  description: "list mobile pairing tokens",
})

const SpecMobileTokenRevoke = Spec.make("revoke", {
  description: "revoke a mobile pairing token",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("token id to revoke")),
  },
})

const SpecMobileToken = Spec.make("token", {
  commands: [SpecMobileTokenList, SpecMobileTokenRevoke],
})

const SpecMobile = Spec.make("mobile", {
  description: "mobile app host and pairing tools",
  commands: [SpecMobileServe, SpecMobilePair, SpecMobileToken],
})

const SpecRoutineList = Spec.make("list", {
  description: "list all routines for the current project",
  params: {
    format: Flag.choice("format", ["table", "json"]).pipe(
      Flag.withDescription("output format"),
      Flag.withDefault("table"),
    ),
  },
})

const SpecRoutineCreate = Spec.make("create", {
  description: "create a new routine interactively",
  params: {
    name: Flag.string("name").pipe(Flag.withAlias("n"), Flag.withDescription("routine name"), Flag.optional),
    prompt: Flag.string("prompt").pipe(Flag.withAlias("p"), Flag.withDescription("prompt to run"), Flag.optional),
    cron: Flag.string("cron").pipe(
      Flag.withDescription("cron schedule (e.g. @hourly, @daily, */30, 0 */6 * * *)"),
      Flag.optional,
    ),
    api: Flag.boolean("api").pipe(Flag.withDescription("enable an API trigger with a generated token"), Flag.optional),
    "api-token": Flag.string("api-token").pipe(
      Flag.withDescription("enable an API trigger with a custom token"),
      Flag.optional,
    ),
  },
})

const SpecRoutineGet = Spec.make("get", {
  description: "show details of a routine",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("routine ID")),
    format: Flag.choice("format", ["text", "json"]).pipe(Flag.withDefault("text")),
  },
})

const SpecRoutineRun = Spec.make("run", {
  description: "trigger an immediate run of a routine",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("routine ID")),
    text: Flag.string("text").pipe(Flag.withDescription("one-off context to append to this run"), Flag.optional),
  },
})

const SpecRoutinePause = Spec.make("pause", {
  description: "pause a routine (disables scheduled triggers)",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("routine ID")),
  },
})

const SpecRoutineResume = Spec.make("resume", {
  description: "resume a paused routine",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("routine ID")),
  },
})

const SpecRoutineDelete = Spec.make("delete", {
  description: "delete a routine",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("routine ID")),
    yes: Flag.boolean("yes").pipe(Flag.withAlias("y"), Flag.withDescription("skip confirmation"), Flag.optional),
  },
})

const SpecRoutine = Spec.make("routine", {
  description: "manage routines — scheduled and API-triggered AI workflows",
  commands: [
    SpecRoutineList,
    SpecRoutineCreate,
    SpecRoutineGet,
    SpecRoutineRun,
    SpecRoutinePause,
    SpecRoutineResume,
    SpecRoutineDelete,
  ],
})

const SpecMissionList = Spec.make("list", {
  description: "list all missions for the current project",
  params: {
    format: Flag.choice("format", ["table", "json"]).pipe(
      Flag.withDescription("output format"),
      Flag.withDefault("table"),
    ),
  },
})

const SpecMissionNew = Spec.make("new", {
  description: "create a new mission from a brief (or an LLM-generated plan from a description)",
  params: {
    name: Flag.string("name").pipe(Flag.withAlias("n"), Flag.withDescription("mission name"), Flag.optional),
    brief: Flag.string("brief").pipe(
      Flag.withAlias("b"),
      Flag.withDescription("mission brief (inline)"),
      Flag.optional,
    ),
    file: Flag.string("file").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("mission brief file path (markdown OK)"),
      Flag.optional,
    ),
    "from-description": Flag.string("from-description").pipe(
      Flag.withDescription("natural-language description that an LLM will turn into a plan"),
      Flag.optional,
    ),
    model: Flag.string("model").pipe(
      Flag.withDescription("model override (providerID/modelID) for the planner"),
      Flag.optional,
    ),
    agent: Flag.string("agent").pipe(Flag.withDescription("default agent for the planner"), Flag.optional),
    "worker-model": Flag.string("worker-model").pipe(
      Flag.withDescription("model override propagated to every worker run"),
      Flag.optional,
    ),
    start: Flag.boolean("start").pipe(Flag.withDescription("start orchestration immediately"), Flag.optional),
  },
})

const SpecMissionGet = Spec.make("get", {
  description: "show details of a mission",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("mission ID")),
    format: Flag.choice("format", ["text", "json"]).pipe(Flag.withDefault("text")),
  },
})

const SpecMissionStart = Spec.make("start", {
  description: "start (or resume) orchestrating a mission",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("mission ID")),
    tail: Flag.boolean("tail").pipe(
      Flag.withDescription("tail the runtime until the mission leaves the running state"),
      Flag.optional,
    ),
  },
})

const SpecMissionPause = Spec.make("pause", {
  description: "pause orchestration of a mission",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("mission ID")),
  },
})

const SpecMissionResume = Spec.make("resume", {
  description: "resume a paused or frozen mission",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("mission ID")),
  },
})

const SpecMissionCancel = Spec.make("cancel", {
  description: "cancel and freeze a mission for reassessment",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("mission ID")),
  },
})

const SpecMissionDelete = Spec.make("delete", {
  description: "delete a mission and its execution history",
  params: {
    id: Argument.string("id").pipe(Argument.withDescription("mission ID")),
    yes: Flag.boolean("yes").pipe(Flag.withAlias("y"), Flag.withDescription("skip confirmation"), Flag.optional),
  },
})

const SpecMission = Spec.make("mission", {
  description: "manage Missions — multi-milestone autonomous workflows",
  commands: [
    SpecMissionList,
    SpecMissionNew,
    SpecMissionGet,
    SpecMissionStart,
    SpecMissionPause,
    SpecMissionResume,
    SpecMissionCancel,
    SpecMissionDelete,
  ],
})

const SpecUsage = Spec.make("usage", {
  description: "show token usage with charts and visual breakdowns",
  params: {
    days: Flag.float("days").pipe(
      Flag.withDescription("show usage for the last N days (default: 7)"),
      Flag.withDefault(7),
    ),
    top: Flag.float("top").pipe(Flag.withDescription("show top N sessions (default: 10)"), Flag.withDefault(10)),
    models: Flag.boolean("models").pipe(
      Flag.withDescription("show model breakdown (default: true)"),
      Flag.withDefault(true),
    ),
    project: Flag.string("project").pipe(
      Flag.withDescription("filter by project (default: current project)"),
      Flag.optional,
    ),
    "no-chart": Flag.boolean("no-chart").pipe(Flag.withDescription("disable ASCII charts"), Flag.withDefault(false)),
  },
})

const SpecPlugin = Spec.make("plugin", {
  description: "install plugin and update config",
  params: {
    module: Argument.string("module").pipe(Argument.withDescription("npm module name")),
    global: Flag.boolean("global").pipe(
      Flag.withAlias("g"),
      Flag.withDescription("install in global config"),
      Flag.withDefault(false),
    ),
    force: Flag.boolean("force").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("replace existing plugin version"),
      Flag.withDefault(false),
    ),
  },
})

const SpecSyncStatus = Spec.make("status", {
  description: "show outbox state and last-seen sequence",
})

const SpecSyncConnect = Spec.make("connect", {
  description: "force a connection to the configured remote hub",
})

const SpecSyncDisconnect = Spec.make("disconnect", {
  description: "show how to end an active sync connect session (no separate stop API)",
})

const SpecSyncTokenCreate = Spec.make("create", {
  description: "create a cli-sync scoped token for connecting a CLI to this hub",
  params: {
    name: Flag.string("name").pipe(Flag.withDescription("token label"), Flag.withDefault("cli-sync")),
    "expiry-days": Flag.float("expiry-days").pipe(Flag.withDescription("optional token expiry in days"), Flag.optional),
  },
})

const SpecSyncToken = Spec.make("token", {
  commands: [SpecSyncTokenCreate],
})

const SpecSync = Spec.make("sync", {
  description: "manage optional remote hub sync (e.g. https://s.nikcli-ai.dev)",
  commands: [SpecSyncStatus, SpecSyncConnect, SpecSyncDisconnect, SpecSyncToken],
})

const SpecConnectorsList = Spec.make("list", {
  description: "list configured connectors and their status",
})

const SpecConnectorsAdd = Spec.make("add", {
  description: "add a connector",
})

const SpecConnectorsAuth = Spec.make("auth", {
  description: "authenticate with a connector",
  params: {
    name: Argument.string("name").pipe(Argument.withDescription("name of the connector"), Argument.optional),
  },
})

const SpecConnectorsLogout = Spec.make("logout", {
  description: "remove credentials for a connector",
  params: {
    name: Argument.string("name").pipe(Argument.withDescription("name of the connector"), Argument.optional),
  },
})

const SpecConnectors = Spec.make("connectors", {
  description: "manage external service connectors (Figma, Slack, GitHub, Lovable)",
  commands: [SpecConnectorsList, SpecConnectorsAdd, SpecConnectorsAuth, SpecConnectorsLogout],
})

const SpecBotList = Spec.make("list", {
  description: "list configured chat bots and their status",
})

const SpecBotAdd = Spec.make("add", {
  description: "add a new chat bot",
})

const SpecBotStart = Spec.make("start", {
  description: "start a chat bot",
  params: {
    name: Argument.string("name").pipe(Argument.withDescription("name of the bot to start"), Argument.optional),
  },
})

const SpecBotStop = Spec.make("stop", {
  description: "stop a running chat bot",
  params: {
    name: Argument.string("name").pipe(Argument.withDescription("name of the bot to stop"), Argument.optional),
  },
})

const SpecBotWebhook = Spec.make("webhook", {
  description: "show webhook URL for a bot",
  params: {
    name: Argument.string("name").pipe(Argument.withDescription("name of the bot"), Argument.optional),
  },
})

const SpecBot = Spec.make("bot", {
  description: "manage chat bots (Discord, Slack, Teams, Google Chat, Linear, GitHub)",
  commands: [SpecBotList, SpecBotAdd, SpecBotStart, SpecBotStop, SpecBotWebhook],
})

export const Commands = Spec.make("nikcli", {
  description: "start nikcli tui",
  params: {
    port: Flag.float("port").pipe(Flag.withDescription("port to listen on"), Flag.withDefault(0)),
    hostname: Flag.string("hostname").pipe(
      Flag.withDescription("hostname to listen on"),
      Flag.withDefault("127.0.0.1"),
    ),
    mdns: Flag.boolean("mdns").pipe(
      Flag.withDescription("enable mDNS service discovery (defaults hostname to 0.0.0.0)"),
      Flag.withDefault(false),
    ),
    cors: Flag.string("cors").pipe(Flag.withDescription("additional domains to allow for CORS"), Flag.atLeast(0)),
    project: Flag.string("project").pipe(Flag.withDescription("path to start nikcli in"), Flag.optional),
    standalone: Flag.boolean("standalone").pipe(
      Flag.withDescription("run with a private in-process server instead of the shared background service"),
      Flag.withDefault(false),
    ),
    model: Flag.string("model").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("model to use in the format of provider/model"),
      Flag.optional,
    ),
    continue: Flag.boolean("continue").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("continue the last session"),
      Flag.optional,
    ),
    session: Flag.string("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("session id to continue"),
      Flag.optional,
    ),
    prompt: Flag.string("prompt").pipe(Flag.withDescription("prompt to use"), Flag.optional),
    agent: Flag.string("agent").pipe(Flag.withDescription("agent to use"), Flag.optional),
  },
  commands: [
    SpecAttach,
    SpecGenerate,
    SpecAcp,
    SpecMcp,
    SpecAutoMode,
    SpecAds,
    SpecRun,
    SpecGoal,
    SpecAnalytics,
    SpecApi,
    SpecDebug,
    SpecAuth,
    SpecAccount,
    SpecArtifact,
    SpecAgent,
    SpecUpgrade,
    SpecQuickstart,
    SpecDoctor,
    SpecUninstall,
    SpecServe,
    SpecService,
    SpecWorkspaceServe,
    SpecWeb,
    SpecHeap,
    SpecModels,
    SpecLocale,
    SpecStats,
    SpecExport,
    SpecImport,
    SpecGithub,
    SpecPr,
    SpecSession,
    SpecImageModel,
    SpecSpeakModel,
    SpecBrainModel,
    SpecRemote,
    SpecTeleport,
    SpecCompanion,
    SpecMobile,
    SpecRoutine,
    SpecMission,
    SpecUsage,
    SpecPlugin,
    SpecSync,
    SpecConnectors,
    SpecBot,
  ],
})
