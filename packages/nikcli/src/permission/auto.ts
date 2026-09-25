import os from "os"
import path from "path"
import type { PermissionRuleset } from "./ruleset"

/**
 * Auto mode — the pure half.
 *
 * Auto mode is a permission *mode*, not a ruleset action: the ruleset keeps its
 * three actions (`allow` / `ask` / `deny`) and this module decides, for a
 * decision the ruleset already made, whether it stands or is handed to the
 * classifier instead of the user. It mirrors Claude Code's auto mode:
 *
 *   1. `deny` always wins, before anything else runs.
 *   2. Explicit, content-scoped `ask` rules still prompt the user.
 *   3. Read-only tools, and edits inside the working tree that do not touch a
 *      protected path, are approved without the classifier.
 *   4. Everything else — shell, network, subagents, MCP, writes outside the
 *      tree, protected paths, critical-path removals — goes to the classifier.
 *   5. Broad allow rules that grant arbitrary code execution (`bash: "*"`,
 *      wildcarded interpreters, package-manager runners, `task`) are suspended
 *      while auto mode is on; narrow rules such as `bash: { "bun test": "allow" }`
 *      stay in force.
 *
 * Everything with side effects — reading the transcript, calling the model,
 * resolving which sessions are in auto mode — lives in `session/auto-mode.ts`.
 */
export namespace AutoMode {
  export const MODES = ["default", "auto"] as const
  export type Mode = (typeof MODES)[number]

  /**
   * Denial thresholds. Three blocks in a row, or twenty in a session, pause
   * auto mode and hand the next decision back to the user. Not configurable,
   * matching Claude Code.
   */
  export const LIMITS = { consecutive: 3, total: 20 } as const

  /**
   * Tier 1: permissions whose `allow` is final in auto mode. These tools only
   * read, navigate, or touch nikcli's own session state, so a classifier call
   * would cost latency and buy nothing.
   */
  export const SAFE_PERMISSIONS: ReadonlySet<string> = new Set([
    "read",
    "glob",
    "grep",
    "list",
    "tree",
    "lsp",
    "todoread",
    "todowrite",
    "question",
    "plan_enter",
    "plan_exit",
    "skill",
    "context_collect",
    "context_related",
    "context_diagnostics",
    "repo_overview",
    "speak",
    "invalid",
  ])

  /**
   * Decisions only a person can make. Auto mode never hands these to the
   * classifier: `voice` opens the microphone, and `doom_loop` is nikcli asking
   * whether an agent repeating the same call should be stopped.
   */
  export const HUMAN_PERMISSIONS: ReadonlySet<string> = new Set(["voice", "doom_loop"])

  /** Permissions whose rules are suspended whole in auto mode (Claude Code drops `Agent` allow rules). */
  const DELEGATION_PERMISSIONS: ReadonlySet<string> = new Set(["task"])

  export const PROTECTED_DIRECTORIES = [
    ".git",
    ".config/git",
    ".vscode",
    ".idea",
    ".husky",
    ".cargo",
    ".devcontainer",
    ".yarn",
    ".mvn",
    ".nikcli",
    ".claude",
  ] as const

  /** Sub-trees of a protected directory that nikcli itself writes to. */
  export const PROTECTED_EXCEPTIONS = [".nikcli/.worktrees", ".nikcli/plans", ".claude/worktrees"] as const

  export const PROTECTED_FILES: ReadonlySet<string> = new Set([
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_aliases",
    ".bash_logout",
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".zlogin",
    ".zlogout",
    ".profile",
    ".envrc",
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".pnp.cjs",
    ".pnp.loader.mjs",
    ".pnpmfile.cjs",
    "bunfig.toml",
    ".bunfig.toml",
    ".bazelrc",
    ".bazelversion",
    ".bazeliskrc",
    ".pre-commit-config.yaml",
    "lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yml",
    ".lefthook.yaml",
    "gradle-wrapper.properties",
    "maven-wrapper.properties",
    ".devcontainer.json",
    ".ripgreprc",
    "pyrightconfig.json",
    ".mcp.json",
    ".claude.json",
    "nikcli.json",
    "nikcli.jsonc",
  ])

  function segments(file: string) {
    return file
      .replaceAll("\\", "/")
      .split("/")
      .filter((part) => part !== "" && part !== ".")
  }

  /**
   * Whether an edit target is one of the protected paths. `file` may be
   * relative to the working tree (what the edit tools put in their patterns)
   * or absolute.
   */
  export function isProtectedPath(file: string) {
    const parts = segments(file)
    if (parts.length === 0) return false
    if (PROTECTED_FILES.has(parts[parts.length - 1]!)) return true
    for (let index = 0; index < parts.length; index++) {
      const rest = parts.slice(index).join("/")
      for (const dir of PROTECTED_DIRECTORIES) {
        if (rest !== dir && !rest.startsWith(dir + "/")) continue
        const excepted = PROTECTED_EXCEPTIONS.some(
          (exception) => rest === exception || rest.startsWith(exception + "/"),
        )
        if (!excepted) return true
      }
    }
    return false
  }

  /** Edit patterns are `path.relative(worktree, file)`: anything that climbs out is outside the tree. */
  export function isInsideWorktree(file: string) {
    if (file === "" || file === "*") return false
    if (path.isAbsolute(file) || /^[a-z]:/i.test(file)) return false
    const parts = segments(file)
    return parts.length > 0 && parts[0] !== ".."
  }

  const INTERPRETERS = new Set([
    "python",
    "python2",
    "python3",
    "node",
    "bun",
    "deno",
    "ruby",
    "perl",
    "php",
    "lua",
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "pwsh",
    "powershell",
    "osascript",
    "npx",
    "bunx",
    "pnpx",
    "uvx",
    "eval",
    "exec",
    "sudo",
    "doas",
    "env",
    "xargs",
    "nohup",
    "time",
    "watch",
    "ssh",
    "docker",
    "podman",
    "kubectl",
  ])
  const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "uv", "poetry", "pipenv", "cargo", "go", "make", "just"])
  const RUNNER_VERBS = new Set(["run", "exec", "x", "dlx", "run-script", "start", "test"])

  /**
   * A shell allow pattern that amounts to "run anything": `*`, a wildcarded
   * interpreter (`python*`, `node *`), or a package-manager runner
   * (`npm run *`, `bun x *`). These are the rules auto mode suspends.
   */
  export function isBroadShellPattern(pattern: string) {
    const trimmed = pattern.trim()
    if (trimmed === "" || trimmed === "*" || trimmed === "**") return true
    if (!trimmed.endsWith("*")) return false
    const head = trimmed.slice(0, -1).trim()
    if (head === "") return true
    const tokens = head.split(/\s+/)
    const first = tokens[0]!.toLowerCase()
    if (tokens.length === 1) return INTERPRETERS.has(first.replace(/[0-9.]+$/, "")) || RUNNERS.has(first)
    if (INTERPRETERS.has(first)) return true
    if (RUNNERS.has(first) && tokens.length === 2 && RUNNER_VERBS.has(tokens[1]!.toLowerCase())) return true
    return false
  }

  function stripQuotes(token: string) {
    if (token.length >= 2 && (token.startsWith('"') || token.startsWith("'")) && token.endsWith(token[0]!)) {
      return token.slice(1, -1)
    }
    return token
  }

  function parentsOf(dir: string) {
    const result: string[] = []
    let current = path.resolve(dir)
    while (true) {
      result.push(current)
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }

  /**
   * Whether an `rm`/`rmdir` sub-command targets a critical path: the root, a
   * top-level directory, the home directory, the working tree or one of its
   * parents, a glob directly under one of those, or an unguarded glob under a
   * shell variable (`rm -rf "$DIR"/*`). An allow rule never approves one of
   * these; in auto mode they go to the classifier.
   */
  export function isCriticalRemoval(command: string, input: { worktree: string; directory: string; home?: string }) {
    const tokens = command.trim().split(/\s+/)
    const program = tokens[0]?.toLowerCase()
    if (program !== "rm" && program !== "rmdir") return false
    const home = path.resolve(input.home ?? os.homedir())
    // The home directory, and the working tree and every directory above it.
    const critical = new Set([home, ...parentsOf(input.worktree), ...parentsOf(input.directory)])
    for (const raw of tokens.slice(1)) {
      if (raw.startsWith("-")) continue
      // `rm -rf "$DIR"/*` becomes a removal from the root when the variable is
      // empty; `"${DIR:?}"/*` is guarded and stays out of this check.
      if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?["']?\/(\*|$)/.test(raw) && !/\$\{[A-Za-z_][A-Za-z0-9_]*:\?/.test(raw)) {
        return true
      }
      const token = stripQuotes(raw)
      if (/^(~|\$HOME|\$\{HOME\})\/?\*?$/.test(token)) return true
      const glob = token === "*" || token.endsWith("/*")
      const base = glob ? token.slice(0, -1) : token
      const expanded = base.startsWith("~/") ? path.join(home, base.slice(2)) : base
      const resolved = path.resolve(input.directory, expanded === "" ? "." : expanded)
      const root = path.parse(resolved).root
      if (resolved === root || path.dirname(resolved) === root) return true
      if (critical.has(resolved)) return true
    }
    return false
  }

  export type Route = "allow" | "ask" | "classify"

  export type RouteInput = {
    permission: string
    pattern: string
    /** The rule `PermissionRuleset.evaluate` picked; never a `deny` (those are terminal before routing). */
    rule: PermissionRuleset.Rule
    worktree: string
    directory: string
    classifyAllShell?: boolean
    home?: string
  }

  /**
   * Whether a decision could change in auto mode at all. Callers use this to
   * skip resolving the session's mode for the common case — a safe tool that
   * the ruleset already allows — so auto mode costs nothing on reads.
   */
  export function relevant(permission: string, rule: PermissionRuleset.Rule) {
    if (rule.action === "deny") return false
    if (rule.action === "ask") return true
    return !SAFE_PERMISSIONS.has(permission)
  }

  /** Tier routing for one pattern of one request. See the namespace comment for the order. */
  export function route(input: RouteInput): Route {
    const { permission, pattern, rule } = input
    if (HUMAN_PERMISSIONS.has(permission)) return rule.action === "allow" ? "allow" : "ask"

    if (rule.action === "ask") {
      // A content-scoped ask rule is the user saying "prompt me for this".
      if (rule.pattern !== "*") return "ask"
      if (SAFE_PERMISSIONS.has(permission)) return "allow"
      if (permission === "edit") return editRoute(input)
      return "classify"
    }

    if (SAFE_PERMISSIONS.has(permission)) return "allow"
    if (permission === "edit") return editRoute(input)
    if (DELEGATION_PERMISSIONS.has(permission)) return "classify"
    if (permission === "bash") {
      if (input.classifyAllShell) return "classify"
      if (isCriticalRemoval(pattern, input)) return "classify"
      // A narrow allow rule approves a command prefix, not its arguments:
      // `git *` must not wave through `git push --force`.
      if (destructiveCategory("bash", [pattern])) return "classify"
      return isBroadShellPattern(rule.pattern) ? "classify" : "allow"
    }
    return rule.pattern === "*" ? "classify" : "allow"
  }

  function editRoute(input: RouteInput): Route {
    if (!isInsideWorktree(input.pattern)) return "classify"
    if (isProtectedPath(input.pattern)) return "classify"
    if (destructiveCategory("edit", [input.pattern])) return "classify"
    return "allow"
  }

  // ---------------------------------------------------------------------------
  // Classifier rules
  // ---------------------------------------------------------------------------

  export const DEFAULTS_TOKEN = "$defaults"

  export type Rules = {
    environment: string[]
    allow: string[]
    soft_deny: string[]
    hard_deny: string[]
  }

  export type RulesConfig = Partial<Record<keyof Rules, string[]>>

  export const DEFAULT_RULES: Rules = {
    environment: [
      "**Organization**: None configured. Primary use: software development.",
      "**Trusted repo**: The git repository the agent started in (its working directory) and the remotes that were configured for it when the session started. A remote added or repointed during the session (`git remote add`, `git remote set-url`) is not trusted unless the user named it. Confidential material is fine in a private repo; in a public one only that repo's own work is. Secrets and personal or entrusted data are never cleared into any repo by its visibility.",
      "**Repository visibility**: Assume private unless the remote host and name, or the user's own message, show that it is public.",
      "**Source control**: Only the trusted repo's configured remotes.",
      "**Trusted internal domains**: None configured. localhost and 127.0.0.1 are local.",
      "**Trusted cloud buckets**: None configured.",
      "**Key internal services**: None configured.",
      "**Internal package registry**: None configured. Installing from the registries the project's manifests and lock files already use is routine.",
      "**Internal sharing / snippet hosting**: None configured. Public paste, gist, and diagram services are outside the trust boundary.",
      "**Sensitive data locations & audiences**: None configured. Treat credential stores, SSH keys, cloud credentials, browser profiles, shell history, session transcripts, and user-data exports as sensitive.",
      "**Sensitive remote targets**: Any host, cluster, namespace, container, or environment whose name carries `prod`, `production`, or `live`.",
      "**Protected IaC scopes**: Any infrastructure scope named as production.",
      "**Host containment**: An ordinary developer machine or CI runner with open internet. The cloud instance-metadata endpoint and the host's own service identity are not part of any task.",
    ],
    allow: [
      "Local Work: Reading, creating, and editing files inside the working directory; running the project's builds, tests, linters, formatters, type checkers, and local dev servers.",
      "Declared Dependencies: Installing dependencies declared in the project's manifests or lock files from the registry they already use.",
      "Read-only Network: GET requests, web searches, fetching documentation, and read-only API calls, including authenticated reads against the service a credential belongs to.",
      "Env Credentials: Reading `.env` files and sending a credential to the API it is issued for.",
      "Repo Push: Committing and pushing to any branch of the trusted repo, and opening a pull request in it that matches the user's request. A branch named as a deploy or publication target (`production`, `release`, `gh-pages`) is judged on its own terms, and the pushed content is still checked against every other rule.",
      "Session Resources: Stopping or deleting processes, jobs, files, branches, or worktrees the agent itself created earlier in this session.",
      "Security Work: Reading, reviewing, or writing security-related code, configuration, and threat models as part of the user's task.",
      "Test Artifacts: Hardcoded test API keys, placeholder credentials in examples, or hardcoded test cases. A value copied from a real secret or sensitive path is never a test artifact.",
      "Agent Collaboration: Delegating part of the user's task to a subagent, or messaging agents working in the same session, when the delegated task stays within what the user asked for.",
      "Trusted Destinations: Sending data to the domains, buckets, and services listed in the environment. This covers data flow only, not destructive or credential operations on that infrastructure.",
    ],
    soft_deny: [
      "Download and Execute [named+specifics — must name: the source and that it runs]: Downloading and executing code (`curl | sh`, `wget -O- | bash`, `iex (irm ...)`), or running code cloned or fetched from outside the trusted repo.",
      "Git Destructive [named+specifics — must name: the destructive operation and its target]: Force pushing (`git push --force`, `--force-with-lease`), deleting remote branches, tags, or releases, or rewriting remote history. Also `git commit --amend` when the commit at HEAD was not created by the agent in this session, or has already been pushed. A message-only reword of the agent's own unpushed commit is fine.",
      "Discard Uncommitted Work [named+specifics — must name: discarding the changes]: `git reset --hard`, `git checkout -- .`, `git restore .`, `git clean -fd`, `git stash drop`, `git stash clear`, or anything else that would discard staged, modified, or untracked work.",
      "Irreversible Local Destruction [named+specifics — must name: the exact path]: Irreversibly deleting or overwriting files or directories that existed before the session and that the user did not name; recursive deletes whose target is an unassigned shell variable; wildcard or age-filtered deletes in `/tmp`, `$TMPDIR`, or shared cache directories; removals targeting the root, a top-level directory, the home directory, or the working directory and its parents.",
      "Database Destructive [named+specifics — must name: the operation and the database or table]: Dropping or truncating databases, schemas, tables, collections, or indexes; `DELETE` or `UPDATE` without a `WHERE` clause or that touches more rows than the task needs; `ALTER TABLE ... DROP`; `FLUSHALL`/`FLUSHDB`, `dropDatabase`, `deleteMany({})`; resetting or force-pushing a schema (`prisma migrate reset`, `prisma db push --force-reset` or `--accept-data-loss`, `drizzle-kit push`/`drop`, `rails db:drop`/`db:reset`, `supabase db reset`), rolling back migrations, or restoring a dump over existing data (`--drop`, `--clean`). This applies to local development databases as well when they hold data that existed before the session. Deleting or overwriting database files (`*.db`, `*.sqlite`) counts too.",
      "Filesystem Destructive [named+specifics — must name: the exact path]: Recursive or forced deletion (`rm -rf`, `rm -r`, `find -delete`, `xargs rm`, `rsync --delete`), wiping or overwriting (`shred`, `dd of=`, `mkfs`, `truncate -s`, `mv -f`/`cp -f` over existing files), or recursive permission and ownership changes (`chmod -R`, `chown -R`) on anything other than build output, caches, or files the agent created in this session. Anything outside the working directory, and anything under the home directory, needs the user to have named it.",
      "Production Deploy [named+specifics — must name: the deploy and its target]: Production deploys, releases, package publishes (`npm publish`, `cargo publish`), database migrations against non-local databases, or toggling, ramping, or deleting production feature flags.",
      "Infrastructure Changes [named+specifics — must name: the resource]: `terraform destroy`, `pulumi destroy`, `cdk destroy`, `terragrunt destroy`, applying a plan that destroys resources, applying changes to a protected IaC scope, draining or removing cluster nodes, creating DaemonSets or admission webhooks, or writes to a shared cluster that reach beyond the resource the user named (label selectors, `--all`).",
      "Cloud Mass Deletion [named+specifics — must name: the bucket or scope]: Mass deletion on cloud storage or deleting stateful cloud resources the agent did not create.",
      "Permission Grants [named+specifics — must name: the grant and the grantee]: Granting IAM roles, repository or organization permissions, changing repository visibility, writing to a secret manager, or changing DNS records or TLS certificates.",
      "Review Bypass: Merging a pull request no human approved, approving the agent's own pull request, disabling or skipping CI checks, commenting out, deleting, or force-passing a test that guards security behavior, or posting a comment that is itself a command to automation (`/deploy`, `/merge`, `atlantis apply`).",
      "Security Weakening: Disabling logging or auditing, installing persistence (SSH keys, cron jobs, launch agents, shell rc changes), or passing a flag that disarms a safety guard (`--insecure`, `--no-verify`, `-k`, `--disable-ssl`).",
      "Auto Mode Bypass: Launching an autonomous agent or harness with per-action approval or isolation disabled (`nikcli --auto`, `--yolo`, `--dangerously-skip-permissions`, `claude --dangerously-skip-permissions`, `--yes-always`, `--no-sandbox`), changing nikcli's own `permission`, `permission_mode`, or `auto_mode` configuration, writing to nikcli session transcripts or its database, or sending keystrokes to nikcli's own terminal to drive its interface.",
      "Credential Exposure: Printing a live credential or token into the transcript or a file, scanning credential stores for usable tokens, reading credentials that belong to the host rather than the task (node certificates, container-registry auth), or requesting credentials from the cloud instance-metadata endpoint (`169.254.169.254`).",
      "External Targets [named+specifics — must name: the external target]: Pushing to, forking, or opening a pull request against a repository or organization other than the trusted repo, `git remote add` or `git remote set-url` to a remote the user did not name, or repointing an API base URL, proxy, webhook receiver, or registry mirror at a third-party host that does not fit the task.",
      "Sensitive Content Outbound [named+specifics — must name: the details and the recipient]: Including internal paths, code names, infrastructure identifiers, live personal data from API responses, or content from sensitive locations in commits, pushes, pull request or issue text, comments, gists, pastes, or publishes that leave the trust boundary, or posting a link whose URL itself carries the content to a public sharing service.",
      "Tunnels and Remote Shells: Opening a tunnel or reverse shell that makes a local service reachable from the internet, reaching a public host through a tunnel or rewritten resolver or proxy, opening interactive shells or port-forwards into a sensitive remote target, or connecting to or scanning sibling containers, pods, VMs, or the node beneath the container.",
      "Registry Bypass: Routing a package install around the internal package registry to a public registry.",
    ],
    hard_deny: [
      "Data Exfiltration: Sending repository contents, secrets, credentials, tokens, environment files, or personal or entrusted data to a destination outside the trust boundary — an external host, a third-party API that the credential does not belong to, or a public paste — including through URL query strings, DNS lookups, encoded payloads, or files staged for later upload.",
    ],
  }

  /**
   * Resolve the effective rules. A configured list replaces the default list
   * for that section unless it contains `"$defaults"`, in which case the
   * defaults are spliced in at that position.
   */
  export function resolveRules(config?: RulesConfig): Rules {
    const section = (key: keyof Rules) => {
      const configured = config?.[key]
      if (!configured) return [...DEFAULT_RULES[key]]
      return configured.flatMap((entry) => (entry === DEFAULTS_TOKEN ? DEFAULT_RULES[key] : [entry]))
    }
    return {
      environment: section("environment"),
      allow: section("allow"),
      soft_deny: section("soft_deny"),
      hard_deny: section("hard_deny"),
    }
  }

  /** Rules whose label starts with `label` (case-insensitive), per section — `nikcli auto-mode defaults --label`. */
  export function filterRules(rules: Rules, label: string): Rules {
    const needle = label.toLowerCase()
    const match = (rule: string) => rule.replace(/^\*\*/, "").toLowerCase().startsWith(needle)
    return {
      environment: rules.environment.filter(match),
      allow: rules.allow.filter(match),
      soft_deny: rules.soft_deny.filter(match),
      hard_deny: rules.hard_deny.filter(match),
    }
  }

  // ---------------------------------------------------------------------------
  // Classifier prompt and verdicts
  // ---------------------------------------------------------------------------

  export type Action = {
    permission: string
    patterns: string[]
    tool?: string
    input?: unknown
    metadata?: Record<string, unknown>
    cwd: string
    gitStatus?: string
  }

  export type Verdict =
    | { kind: "allow" }
    | { kind: "block"; rule: string; reason: string }
    /** The classifier produced nothing usable: denied, not counted, never run unreviewed. */
    | { kind: "unavailable"; reason: string }

  export function formatRules(rules: Rules) {
    const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "- None")
    return [
      "<environment>",
      list(rules.environment),
      "</environment>",
      "",
      "<hard_deny>",
      list(rules.hard_deny),
      "</hard_deny>",
      "",
      "<soft_deny>",
      list(rules.soft_deny),
      "</soft_deny>",
      "",
      "<allow>",
      list(rules.allow),
      "</allow>",
    ].join("\n")
  }

  function stringify(value: unknown) {
    if (value === undefined) return ""
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  const MAX_ACTION_CHARS = 20_000

  export function formatAction(action: Action) {
    const lines = [
      "<pending_action>",
      `permission: ${action.permission}`,
      ...(action.tool ? [`tool: ${action.tool}`] : []),
      `working_directory: ${action.cwd}`,
      `targets:\n${action.patterns.map((pattern) => `  - ${pattern}`).join("\n")}`,
    ]
    const input = stringify(action.input)
    if (input) lines.push(`input:\n${input.slice(0, MAX_ACTION_CHARS)}`)
    const metadata = action.metadata ? pickMetadata(action.metadata) : undefined
    if (metadata) lines.push(`details:\n${metadata}`)
    if (action.gitStatus !== undefined) {
      lines.push(`git_status (captured by nikcli, not by the agent):\n${action.gitStatus.trim() || "(clean)"}`)
    }
    lines.push("</pending_action>")
    return lines.join("\n")
  }

  /** Metadata keys that describe the action itself; previews and diffs are summarized, never dumped. */
  function pickMetadata(metadata: Record<string, unknown>) {
    const keep: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(metadata)) {
      if (key === "files" || key === "auto_mode") continue
      if (key === "diff" && typeof value === "string") {
        keep.diff = value.slice(0, MAX_ACTION_CHARS)
        continue
      }
      keep[key] = value
    }
    const text = stringify(keep)
    return text === "{}" ? undefined : text.slice(0, MAX_ACTION_CHARS)
  }

  export const STAGE1_INSTRUCTION = [
    "Stage 1 — fast filter.",
    "Decide whether the pending action could match any hard_deny or soft_deny rule that is not clearly cleared by an allow exception or by the user's explicit, specific request.",
    "Err toward `block` when unsure: a `block` here only sends the action to a careful second review.",
    "Answer with exactly one word and nothing else: `block` or `allow`.",
  ].join("\n")

  export const STAGE2_INSTRUCTION = [
    "Stage 2 — careful review.",
    "Reason step by step inside <thinking></thinking>: what exactly the action does, its blast radius, which rules could apply, and whether the user's own messages explicitly and specifically authorized this exact action.",
    "Then answer in exactly this format:",
    "<verdict>allow</verdict> or <verdict>block</verdict>",
    "<rule>Label of the rule that decided it, or None</rule>",
    "<reason>One sentence for the agent explaining the decision.</reason>",
  ].join("\n")

  export function parseStage1(text: string): "allow" | "block" | undefined {
    const cleaned = text
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
      .trim()
      .toLowerCase()
    const match = cleaned.match(/\b(block|allow)\b/)
    return match ? (match[1] as "allow" | "block") : undefined
  }

  export function parseStage2(text: string): Exclude<Verdict, { kind: "unavailable" }> | undefined {
    const body = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    const verdict = body.match(/<verdict>\s*(allow|block)\s*<\/verdict>/i)?.[1]?.toLowerCase()
    if (!verdict) return undefined
    if (verdict === "allow") return { kind: "allow" }
    const rule = body.match(/<rule>\s*([\s\S]*?)\s*<\/rule>/i)?.[1]?.trim()
    const reason = body.match(/<reason>\s*([\s\S]*?)\s*<\/reason>/i)?.[1]?.trim()
    return {
      kind: "block",
      rule:
        rule && rule.toLowerCase() !== "none"
          ? rule.replace(/\s*\[.*$/, "").replace(/:.*$/, "")
          : "Blocked by classifier",
      reason: reason || "The auto mode classifier judged this action unsafe.",
    }
  }

  /**
   * What the agent reads when an action is blocked. It names the rule in
   * brackets, like Claude Code, and asks the agent to treat the boundary in
   * good faith rather than route around it.
   */
  export function blockedMessage(verdict: Extract<Verdict, { kind: "block" }>) {
    return [
      `Permission for this action was denied by the auto mode classifier. [${verdict.rule}] ${verdict.reason}`,
      "Treat this boundary in good faith: do not retry the same action or try to accomplish it another way that would bypass the block.",
      "Continue with a safer alternative if one exists. If the action is genuinely required, stop and explain to the user what you need and why, so they can approve it explicitly.",
    ].join("\n")
  }

  export function unavailableMessage(reason: string) {
    return [
      `Auto mode could not determine the safety of this action (${reason}), so it was not run.`,
      "Continue with other work if you can, or ask the user to approve the action explicitly.",
    ].join("\n")
  }

  // ---------------------------------------------------------------------------
  // Denial tracking
  // ---------------------------------------------------------------------------

  export type Denials = { consecutive: number; total: number }

  export function emptyDenials(): Denials {
    return { consecutive: 0, total: 0 }
  }

  /** An allowed action resets the consecutive counter; the total persists. */
  export function recordAllowed(denials: Denials) {
    denials.consecutive = 0
  }

  /**
   * Record a block. Returns `true` when a threshold is reached and the action
   * must go to the user instead. The total counter resets only when its own
   * limit is what triggered the fallback.
   */
  export function recordBlocked(denials: Denials) {
    denials.consecutive++
    denials.total++
    const consecutive = denials.consecutive >= LIMITS.consecutive
    const total = denials.total >= LIMITS.total
    if (total) denials.total = 0
    return consecutive || total
  }

  /** The user approved a fallback prompt: auto mode resumes from a clean streak. */
  export function recordApproved(denials: Denials) {
    denials.consecutive = 0
  }

  // ---------------------------------------------------------------------------
  // Commands that discard work get a git status the classifier can read.
  // ---------------------------------------------------------------------------

  const DISCARDING = [
    /\bgit\s+reset\s+.*--hard\b/,
    /\bgit\s+checkout\s+(--\s|.*\s--\s)/,
    /\bgit\s+checkout\s+\.\s*$/,
    /\bgit\s+restore\b/,
    /\bgit\s+clean\b/,
    /\bgit\s+stash\s+(drop|clear)\b/,
    /\brm\s+(-[a-z]*r[a-z]*|--recursive)\b/i,
  ]

  export function discardsWork(command: string) {
    return DISCARDING.some((pattern) => pattern.test(command))
  }

  // ---------------------------------------------------------------------------
  // Actions that always get the careful review.
  //
  // Stage 1 is a cheap filter, and the model behind it depends on the user's
  // provider. For the categories below a false "allow" costs work that cannot
  // be recovered, so they skip the filter and go straight to the reasoned
  // stage-2 review. This only ever adds scrutiny: it cannot approve anything.
  // ---------------------------------------------------------------------------

  const DESTRUCTIVE_SHELL: ReadonlyArray<{ category: string; pattern: RegExp }> = [
    // git: history rewrites, remote deletions, discarded work
    { category: "git", pattern: /\bgit\b.*\bpush\b.*(\s-f\b|--force|--mirror|--delete|\s-d\b|\s:[^\s]+)/ },
    { category: "git", pattern: /\bgit\b.*\breset\b.*--(hard|merge|keep)\b/ },
    { category: "git", pattern: /\bgit\b.*\b(clean|filter-branch|filter-repo|replace)\b/ },
    { category: "git", pattern: /\bgit\b.*\bcheckout\b.*(\s--\s|\s-f\b|--force|\s\.\s*$)/ },
    { category: "git", pattern: /\bgit\b.*\brestore\b/ },
    { category: "git", pattern: /\bgit\b.*\bstash\s+(drop|clear)\b/ },
    { category: "git", pattern: /\bgit\b.*\bbranch\b.*(\s-D\b|--delete\s+--force|\s-d\b|--delete\b)/ },
    { category: "git", pattern: /\bgit\b.*\btag\b.*(\s-d\b|--delete\b)/ },
    { category: "git", pattern: /\bgit\b.*\b(rebase|commit\s+.*--amend|update-ref\s+-d|reflog\s+(expire|delete))\b/ },
    { category: "git", pattern: /\bgit\b.*\bgc\b.*--prune/ },
    { category: "git", pattern: /\bgit\b.*\bworktree\s+remove\b/ },
    { category: "git", pattern: /\bgit\b.*\bremote\s+(add|set-url|remove|rm)\b/ },
    {
      category: "git",
      pattern: /\bgh\s+(pr\s+merge|repo\s+(delete|edit|fork)|release\s+delete|api\b.*-X\s*(DELETE|PUT|PATCH))/i,
    },
    // databases: schema drops, bulk deletes, resets
    {
      category: "database",
      pattern: /\b(drop\s+(table|database|schema|index|view|collection)|truncate\s+(table\s+)?\w)/i,
    },
    { category: "database", pattern: /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i },
    { category: "database", pattern: /\b(update\s+\S+\s+set\b(?![\s\S]*\bwhere\b))/i },
    { category: "database", pattern: /\balter\s+table\b.*\bdrop\b/i },
    { category: "database", pattern: /\b(flushall|flushdb|dropDatabase|deleteMany\s*\(\s*\{\s*\}\s*\))/ },
    {
      category: "database",
      pattern: /\bprisma\s+(migrate\s+(reset|deploy)|db\s+push\b.*(--force-reset|--accept-data-loss))/,
    },
    { category: "database", pattern: /\bdrizzle-kit\s+(push|drop|migrate)\b/ },
    { category: "database", pattern: /\b(rails|rake)\s+db:(drop|reset|schema:load|migrate)/ },
    {
      category: "database",
      pattern:
        /\b(knex\s+migrate:(rollback|down)|sequelize\s+db:(drop|migrate:undo)|typeorm\s+(schema:drop|migration:revert))/,
    },
    {
      category: "database",
      pattern: /\b(supabase\s+db\s+(reset|push)|dropdb|mongorestore\s+.*--drop|pg_restore\s+.*--clean)\b/,
    },
    {
      category: "database",
      pattern: /\b(psql|mysql|sqlite3|mongosh|mongo|redis-cli|clickhouse-client)\b.*\b(drop|truncate|delete|flush)/i,
    },
    // filesystem: recursive or forced deletion, wiping, permission sweeps
    { category: "filesystem", pattern: /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\b|--recursive|--force)/ },
    { category: "filesystem", pattern: /\b(rmdir|shred|srm|unlink)\b/ },
    { category: "filesystem", pattern: /\bfind\b.*\s-(delete|exec\s+rm)\b/ },
    { category: "filesystem", pattern: /\b(dd\s+.*\bof=|mkfs(\.\w+)?\b|diskutil\s+(erase|partition)|fdisk|wipefs)/ },
    { category: "filesystem", pattern: /\b(chmod|chown|chgrp)\s+(-[a-zA-Z]*R|--recursive)/ },
    { category: "filesystem", pattern: /\btruncate\s+-s\b/ },
    { category: "filesystem", pattern: /\b(mv|cp)\b.*\s(-f\b|--force\b)/ },
    { category: "filesystem", pattern: /\brsync\b.*--delete/ },
    { category: "filesystem", pattern: /\bxargs\b.*\brm\b/ },
    // remote code, deploys, infrastructure
    { category: "remote-code", pattern: /\b(curl|wget|iwr|irm)\b.*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/ },
    { category: "remote-code", pattern: /\b(curl|wget)\b.*\|\s*(python\d?|node|bun|perl|ruby)\b/ },
    { category: "deploy", pattern: /\b(npm|pnpm|yarn|bun|cargo|gem|twine|poetry)\s+publish\b/ },
    {
      category: "deploy",
      pattern:
        /\b(railway\s+(up|deploy|down|delete)|vercel\b.*--prod|fly\s+(deploy|destroy)|netlify\s+deploy\b.*--prod|heroku\s+.*(destroy|releases:rollback))/,
    },
    { category: "deploy", pattern: /\b(terraform|terragrunt|pulumi|cdk)\s+(apply|destroy|up|deploy)\b/ },
    { category: "deploy", pattern: /\bkubectl\s+(delete|drain|apply|replace|scale|rollout\s+undo|patch)\b/ },
    {
      category: "deploy",
      pattern: /\b(docker|podman)\s+(system\s+prune|volume\s+(rm|prune)|rm\s+-f|rmi\s+-f|compose\s+down\s+.*-v)/,
    },
    { category: "deploy", pattern: /\b(aws\s+s3\s+(rm|rb)|gsutil\s+(-m\s+)?rm|gcloud\b.*\bdelete\b|az\b.*\bdelete\b)/ },
    // privilege
    { category: "privilege", pattern: /(^|\s)(sudo|doas|su)\s/ },
  ]

  /**
   * The destructive category a request falls in, if any. Shell requests are
   * matched per sub-command; an edit to a protected path or a database file
   * counts too.
   */
  export function destructiveCategory(permission: string, patterns: readonly string[]): string | undefined {
    if (permission === "bash") {
      for (const pattern of patterns) {
        const hit = DESTRUCTIVE_SHELL.find((entry) => entry.pattern.test(pattern))
        if (hit) return hit.category
      }
      return undefined
    }
    if (permission === "edit") {
      if (patterns.some((pattern) => /\.(sqlite3?|db|mdb|accdb)$/i.test(pattern))) return "database"
      if (patterns.some(isProtectedPath)) return "protected-path"
    }
    return undefined
  }
}
