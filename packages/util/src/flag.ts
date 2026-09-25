function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  /**
   * Whether permission prompts are auto-approved for this process.
   *
   * Read on every access rather than captured at module load: the CLI sets the variable from its
   * argv middleware, which runs after this module is first imported, and the TUI reads it again in
   * a worker thread that inherits the environment.
   */
  export function autoApprove() {
    return truthy("NIKCLI_AUTO_APPROVE")
  }

  /**
   * The permission mode forced for this process by `--permission-mode`, or
   * `undefined` to use the configured one. Read on every access for the same
   * reason as `autoApprove`.
   */
  export function permissionMode(): "default" | "auto" | undefined {
    const value = process.env["NIKCLI_PERMISSION_MODE"]?.toLowerCase()
    if (value === "auto" || value === "default") return value
    return undefined
  }

  export const NIKCLI_AUTO_SHARE = truthy("NIKCLI_AUTO_SHARE")
  export const NIKCLI_GIT_BASH_PATH = process.env["NIKCLI_GIT_BASH_PATH"]
  export const NIKCLI_CONFIG = process.env["NIKCLI_CONFIG"]
  export declare const NIKCLI_CONFIG_DIR: string | undefined
  export const NIKCLI_CONFIG_CONTENT = process.env["NIKCLI_CONFIG_CONTENT"]
  export const NIKCLI_DISABLE_AUTOUPDATE = truthy("NIKCLI_DISABLE_AUTOUPDATE")
  export const NIKCLI_DISABLE_PRUNE = truthy("NIKCLI_DISABLE_PRUNE")
  export const NIKCLI_DISABLE_TERMINAL_TITLE = truthy("NIKCLI_DISABLE_TERMINAL_TITLE")
  export const NIKCLI_PERMISSION = process.env["NIKCLI_PERMISSION"]
  export const NIKCLI_DISABLE_DEFAULT_PLUGINS = truthy("NIKCLI_DISABLE_DEFAULT_PLUGINS")
  export declare const NIKCLI_ISLAND: boolean
  export declare const NIKCLI_HERDR: boolean
  export const NIKCLI_DISABLE_LSP_DOWNLOAD = truthy("NIKCLI_DISABLE_LSP_DOWNLOAD")
  export const NIKCLI_ENABLE_EXPERIMENTAL_MODELS = truthy("NIKCLI_ENABLE_EXPERIMENTAL_MODELS")
  // Opt out of falling back to `gpt-reserve` when a ChatGPT plan's main models
  // (gpt-6-astra, gpt-5.x, the codex slugs) run out of allowance. See
  // `plugin/codex.ts`; requests then fail with the provider's 429 instead.
  export const NIKCLI_DISABLE_GPT_RESERVE_FALLBACK = truthy("NIKCLI_DISABLE_GPT_RESERVE_FALLBACK")
  export const NIKCLI_DISABLE_AUTOCOMPACT = truthy("NIKCLI_DISABLE_AUTOCOMPACT")
  // Opt out of the in-process config hot reload (instance reload on config
  // file changes). Reload can still be triggered explicitly via the API.
  export const NIKCLI_DISABLE_HOT_RELOAD = truthy("NIKCLI_DISABLE_HOT_RELOAD")
  // Opt out of TUI plugin hot reload (watching local plugin sources and
  // swapping an edited plugin in place). Plugins then load once at startup.
  export const NIKCLI_DISABLE_PLUGIN_RELOAD = truthy("NIKCLI_DISABLE_PLUGIN_RELOAD")
  /** Log which part of the request prefix changed between calls. See `provider/cache-diagnostics.ts`. */
  export const NIKCLI_PROMPT_CACHE_DIAGNOSTICS = truthy("NIKCLI_PROMPT_CACHE_DIAGNOSTICS")
  /**
   * Prompt-cache entry lifetime: `long` opts into the provider's 1-hour entry
   * instead of the 5-minute default. See `provider/cache-policy.ts` for the
   * cost tradeoff.
   *
   * A function rather than a constant for the same reason as `autoApprove`: the
   * value can be set after this module is first imported.
   */
  export function cacheRetention() {
    return process.env["NIKCLI_CACHE_RETENTION"]
  }
  // Opt out of journaling local (non-workspace) session restore events into
  // the unified sync_event log.
  export const NIKCLI_DISABLE_SESSION_JOURNAL = truthy("NIKCLI_DISABLE_SESSION_JOURNAL")
  // Optional hub-and-spoke remote sync. Setting both URL and TOKEN enables
  // it; AUTOSTART=false keeps bootstrap from starting it automatically
  // (explicit `nikcli sync` / `nikcli serve` still can).
  export const NIKCLI_REMOTE_URL = process.env["NIKCLI_REMOTE_URL"]
  export const NIKCLI_REMOTE_TOKEN = process.env["NIKCLI_REMOTE_TOKEN"]
  export const NIKCLI_REMOTE_AUTOSTART = (() => {
    const value = process.env["NIKCLI_REMOTE_AUTOSTART"]?.toLowerCase()
    return value !== "false" && value !== "0"
  })()
  /** Read on every access: tests set it at their own module scope, after this module is imported. */
  export function disableModelsFetch() {
    return truthy("NIKCLI_DISABLE_MODELS_FETCH")
  }
  export const NIKCLI_DISABLE_CLAUDE_CODE = truthy("NIKCLI_DISABLE_CLAUDE_CODE")
  export const NIKCLI_DISABLE_CLAUDE_CODE_PROMPT =
    NIKCLI_DISABLE_CLAUDE_CODE || truthy("NIKCLI_DISABLE_CLAUDE_CODE_PROMPT")
  export const NIKCLI_DISABLE_CLAUDE_CODE_SKILLS =
    NIKCLI_DISABLE_CLAUDE_CODE || truthy("NIKCLI_DISABLE_CLAUDE_CODE_SKILLS")
  export const NIKCLI_DISABLE_EXTERNAL_SKILLS =
    NIKCLI_DISABLE_CLAUDE_CODE_SKILLS || truthy("NIKCLI_DISABLE_EXTERNAL_SKILLS")
  export declare const NIKCLI_DISABLE_PROJECT_CONFIG: boolean
  export const NIKCLI_FAKE_VCS = process.env["NIKCLI_FAKE_VCS"]
  export const NIKCLI_CLIENT = process.env["NIKCLI_CLIENT"] ?? "cli"
  export const NIKCLI_SERVER_PASSWORD = process.env["NIKCLI_SERVER_PASSWORD"]
  export const NIKCLI_SERVER_USERNAME = process.env["NIKCLI_SERVER_USERNAME"]
  // Max HTTP request body in bytes (defaults applied at the serve site). Lets
  // large teleport uploads through Bun's 128MB default when needed.
  export const NIKCLI_SERVER_MAX_BODY = process.env["NIKCLI_SERVER_MAX_BODY"]
    ? parseInt(process.env["NIKCLI_SERVER_MAX_BODY"]!, 10)
    : undefined
  export const NIKCLI_SERVER_TAILSCALE_AUTH = truthy("NIKCLI_SERVER_TAILSCALE_AUTH")
  export const NIKCLI_SERVER_TAILSCALE_USERS = process.env["NIKCLI_SERVER_TAILSCALE_USERS"]
  /**
   * Identity-plane verifier inputs, read on every access for the same reason
   * as `autoApprove`: the value can be set after this module is first
   * imported. Captured as constants, the first importer decided them for the
   * whole process — which under `bun test` is whichever file happened to load
   * a server module first, so a test that exports its own issuer and HS256
   * secret before importing anything still got the defaults, and every token
   * it signed verified as 401.
   */
  export function authIssuer() {
    return process.env["NIKCLI_AUTH_ISSUER"]
  }
  export function authJwksUrl() {
    return process.env["NIKCLI_AUTH_JWKS_URL"]
  }
  export function authAudience() {
    return process.env["NIKCLI_AUTH_AUDIENCE"] ?? "nikcli-api"
  }
  export function authJwtSecret() {
    return process.env["NIKCLI_AUTH_JWT_SECRET"]
  }
  /**
   * The legacy-credential gate, read on every access.
   *
   * Together these two decide whether the server still accepts `nku_`
   * sessions, Basic and Tailscale. Captured as constants they were fixed by
   * whichever module in the process touched a flag first, which under
   * `bun test` is not the file that set them — `test/server/unified-auth.fixture.ts`
   * exports `NIKCLI_REQUIRE_OAUTH=1` at its own module scope and would still
   * have run against the process default. A security test that passes because
   * the gate it meant to close was never open is worse than one that fails.
   *
   * They move together on purpose: every call site reads both, and a pair
   * where one side is live and the other is a snapshot can disagree.
   */
  export function requireOauth() {
    return truthy("NIKCLI_REQUIRE_OAUTH")
  }
  export function legacyLogin() {
    return truthy("NIKCLI_LEGACY_LOGIN")
  }

  // OpenTelemetry (OTLP) — standard env vars. Setting an endpoint enables export.
  export const OTEL_EXPORTER_OTLP_ENDPOINT = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  export const OTEL_EXPORTER_OTLP_HEADERS = process.env["OTEL_EXPORTER_OTLP_HEADERS"]
  export const NIKCLI_DANGEROUSLY_SKIP_PERMISSIONS = truthy("NIKCLI_DANGEROUSLY_SKIP_PERMISSIONS")
  // Live telemetry capture (spans streamed to the TUI panel) is on by default;
  // set this to opt out of the in-process span capture entirely.
  export const NIKCLI_DISABLE_OTEL_LIVE = truthy("NIKCLI_DISABLE_OTEL_LIVE")

  // SSH Server
  export const NIKCLI_SERVER_SSH_ENABLED = truthy("NIKCLI_SERVER_SSH_ENABLED")
  export const NIKCLI_SERVER_SSH_PORT = parseInt(process.env["NIKCLI_SERVER_SSH_PORT"] ?? "2222")
  export const NIKCLI_SERVER_SSH_HOST = process.env["NIKCLI_SERVER_SSH_HOST"] ?? "0.0.0.0"

  // Connectors
  export const NIKCLI_FIGMA_TOKEN = process.env["NIKCLI_FIGMA_TOKEN"]
  export const NIKCLI_SLACK_BOT_TOKEN = process.env["NIKCLI_SLACK_BOT_TOKEN"]
  export const NIKCLI_GITHUB_TOKEN = process.env["NIKCLI_GITHUB_TOKEN"]
  /**
   * The GitHub client every host falls back to. Public, not a secret: users
   * only approve their own GitHub account against it.
   *
   * This must be an **OAuth App**, not a GitHub App. A GitHub App issues user
   * tokens that expire in 8 hours and can only be refreshed by presenting the
   * app's client secret — which a CLI and a phone, both public clients, cannot
   * hold. GitHub answers `incorrect_client_credentials` and the connection
   * dies with no way back (see `refreshGithubToken` in
   * `server/mobile/helpers.ts`). An OAuth App's tokens do not expire, so that
   * failure cannot happen. A GitHub App also ignores the requested `scope` and
   * grants repo access per installation instead, which is where the 404s on
   * repositories came from.
   *
   * Single source of truth: the host resolves env var → `nikcli.json`
   * connector → this value, and nothing else ships a copy.
   */
  export const NIKCLI_GITHUB_OAUTH_CLIENT_ID_DEFAULT = "Ov23liIrum4YVdDu8Ogr"
  /**
   * The same lookup with the built-in default folded in, so this is never
   * empty. Kept for callers that just want "whatever client ID applies", but
   * do NOT use it to decide precedence: it cannot tell an operator's env var
   * apart from the default, and doing so is what made `nikcli.json` unable to
   * override the client ID. `githubOAuthClientID` in `server/mobile/helpers.ts`
   * owns that decision.
   *
   * `||` so empty-string env vars do not win over the default.
   */
  export const NIKCLI_GITHUB_OAUTH_CLIENT_ID =
    process.env["NIKCLI_GITHUB_OAUTH_CLIENT_ID"]?.trim() ||
    process.env["GITHUB_CLIENT_ID_CONSOLE"]?.trim() ||
    process.env["GITHUB_CLIENT_ID"]?.trim() ||
    NIKCLI_GITHUB_OAUTH_CLIENT_ID_DEFAULT
  export const NIKCLI_LOVABLE_TOKEN = process.env["NIKCLI_LOVABLE_TOKEN"] ?? process.env["NIKCLI_LOVABLE_API_KEY"]
  export const NIKCLI_LOVABLE_API_KEY = process.env["NIKCLI_LOVABLE_API_KEY"]

  // Notifications
  export const NIKCLI_SLACK_CHANNEL =
    process.env["NIKCLI_SLACK_CHANNEL"] ?? process.env["SLACK_DEFAULT_CHANNEL"] ?? process.env["SLACK_CHANNEL"]
  export const NIKCLI_DISCORD_WEBHOOK_URL =
    process.env["NIKCLI_DISCORD_WEBHOOK_URL"] ?? process.env["DISCORD_WEBHOOK_URL"]
  export const NIKCLI_TODO_NOTIFICATIONS = true
  export const NIKCLI_SLACK_TASK_NOTIFICATIONS =
    truthy("NIKCLI_SLACK_TASK_NOTIFICATIONS") || truthy("SLACK_TASK_NOTIFICATIONS")
  export const NIKCLI_DISCORD_TASK_NOTIFICATIONS =
    truthy("NIKCLI_DISCORD_TASK_NOTIFICATIONS") || truthy("DISCORD_TASK_NOTIFICATIONS")

  // TUI plugin system
  export declare const NIKCLI_TUI_CONFIG: string | undefined
  export const NIKCLI_PURE = truthy("NIKCLI_PURE")
  export const NIKCLI_PLUGIN_META_FILE = process.env["NIKCLI_PLUGIN_META_FILE"]

  // Experimental
  export const NIKCLI_EXPERIMENTAL = truthy("NIKCLI_EXPERIMENTAL")
  export const NIKCLI_EXPERIMENTAL_FILEWATCHER = true
  /** Read on every access: tests set it at their own module scope, after this module is imported. */
  export function disableFilewatcher() {
    return truthy("NIKCLI_EXPERIMENTAL_DISABLE_FILEWATCHER")
  }
  export const NIKCLI_EXPERIMENTAL_ICON_DISCOVERY = NIKCLI_EXPERIMENTAL || truthy("NIKCLI_EXPERIMENTAL_ICON_DISCOVERY")
  export const NIKCLI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = truthy("NIKCLI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const NIKCLI_ENABLE_EXA =
    truthy("NIKCLI_ENABLE_EXA") || NIKCLI_EXPERIMENTAL || truthy("NIKCLI_EXPERIMENTAL_EXA")
  export const NIKCLI_EXPERIMENTAL_BASH_MAX_OUTPUT_LENGTH = number("NIKCLI_EXPERIMENTAL_BASH_MAX_OUTPUT_LENGTH")
  export const NIKCLI_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("NIKCLI_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const NIKCLI_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("NIKCLI_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const NIKCLI_EXPERIMENTAL_OXFMT = true
  export const NIKCLI_EXPERIMENTAL_LSP_TY = true
  export const NIKCLI_EXPERIMENTAL_LSP_TOOL = true
  export const NIKCLI_DISABLE_FILETIME_CHECK = truthy("NIKCLI_DISABLE_FILETIME_CHECK")
  export const NIKCLI_EXPERIMENTAL_SCOUT = true
  export const NIKCLI_EXPERIMENTAL_WORKSPACES_TUI = true
  export const NIKCLI_EXPERIMENTAL_SECURITY_TOOL = true
  export const NIKCLI_EXPERIMENTAL_WEBSOCKETS = true
  // Confined code-mode tool (interpreter port from opencode v2 codemode); see specs/codemode.md.
  // Default-on; opt out with NIKCLI_DISABLE_CODE_MODE.
  export const NIKCLI_EXPERIMENTAL_CODE_MODE = !truthy("NIKCLI_DISABLE_CODE_MODE")
  // Linux-only: place sandboxed children in this cgroup before they start.
  export const NIKCLI_SANDBOX_CGROUP = process.env["NIKCLI_SANDBOX_CGROUP"]

  // Computer & browser control ("computer use" like Codex / Claude Code).
  // The browser_control tool drives @nikcli-ai/browser-control's local,
  // headless, background-daemon Chromium; desktop computer-use sends real
  // input to the local machine. Both tools remain explicitly disableable.
  // Opt out with NIKCLI_DISABLE_BROWSER_CONTROL_TOOL / NIKCLI_DISABLE_COMPUTER_TOOL.
  // NIKCLI_DISABLE_BROWSER_TOOL stays honoured: it is what the tool was called
  // before the rename, and it may already be set in someone's shell profile.
  export const NIKCLI_EXPERIMENTAL_BROWSER_CONTROL_TOOL = !(
    truthy("NIKCLI_DISABLE_BROWSER_CONTROL_TOOL") || truthy("NIKCLI_DISABLE_BROWSER_TOOL")
  )
  export const NIKCLI_EXPERIMENTAL_COMPUTER_TOOL = !truthy("NIKCLI_DISABLE_COMPUTER_TOOL")

  // Opt-in filesystem scan of `{tool,tools}/*.{js,ts}` under config dirs.
  // Default off — arbitrary code import from config directories is a security
  // boundary. Set NIKCLI_ALLOW_PLUGIN_AUTOLOAD=1 to restore the historical
  // glob+import behaviour, or pin specific files via `tool.allow` / `tool.pin`
  // in nikcli.json (allowlist loads without the flag).
  export declare const NIKCLI_ALLOW_PLUGIN_AUTOLOAD: boolean

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for NIKCLI_DISABLE_PROJECT_CONFIG
Object.defineProperty(Flag, "NIKCLI_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("NIKCLI_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "NIKCLI_ISLAND", {
  get() {
    return truthy("NIKCLI_ISLAND")
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "NIKCLI_HERDR", {
  get() {
    return truthy("NIKCLI_HERDR")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for NIKCLI_CONFIG_DIR
Object.defineProperty(Flag, "NIKCLI_CONFIG_DIR", {
  get() {
    return process.env["NIKCLI_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "NIKCLI_TUI_CONFIG", {
  get() {
    return process.env["NIKCLI_TUI_CONFIG"]
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "NIKCLI_ALLOW_PLUGIN_AUTOLOAD", {
  get() {
    return truthy("NIKCLI_ALLOW_PLUGIN_AUTOLOAD")
  },
  enumerable: true,
  configurable: false,
})

Object.defineProperty(Flag, "NIKCLI_GITHUB_OAUTH_CLIENT_ID", {
  get() {
    return (
      process.env["NIKCLI_GITHUB_OAUTH_CLIENT_ID"]?.trim() ||
      process.env["GITHUB_CLIENT_ID_CONSOLE"]?.trim() ||
      process.env["GITHUB_CLIENT_ID"]?.trim() ||
      Flag.NIKCLI_GITHUB_OAUTH_CLIENT_ID_DEFAULT
    )
  },
  enumerable: true,
  configurable: false,
})
