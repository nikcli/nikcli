import type {
  AgentInfo,
  CommandInfo,
  ConnectorAuthInput,
  ConnectorStatus,
  FileContent,
  FileNode,
  FilePart,
  FileDiff,
  GitHubBranch,
  Workflow,
  WorkflowJob,
  WorkflowRunList,
  GitHubDeviceAuthPollResult,
  GitHubDeviceAuthStart,
  GitHubPublishResult,
  GitHubRepo,
  GitHubSessionCreateResult,
  GitBranchInfo,
  GitCommitResult,
  GitState,
  HostConfigSnapshot,
  HostCommandConfig,
  HostMcpStatus,
  LoopDefinition,
  LoopDetailResult,
  LoopListResult,
  LoopRun,
  LoopTemplate,
  LoopWriteInput,
  ManagedGithubImport,
  MemorySearchHit,
  MissionDefinition,
  MissionDetailResult,
  MissionExec,
  MissionListResult,
  MissionTemplate,
  MissionWriteInput,
  ChatBotInfo,
  BrainStatus,
  BrainTriggerResult,
  ObservabilityStatus,
  FusionPreset,
  HostCapability,
  LspServerStatus,
  SessionTodo,
  MobileAuthToken,
  MobileExecutionTarget,
  ModelRef,
  MobileBootstrap,
  ProviderCatalog,
  PromptHistoryEntry,
  PromptPreset,
  PromptStashEntry,
  ProjectInfo,
  PtyCreateInput,
  PtyInfo,
  PtyUpdateInput,
  QuestionRequest,
  SearchMatch,
  Routine,
  RoutineCreateInput,
  RoutineUpdateInput,
  ServerConfig,
  Session,
  SessionDetail,
  SessionSummary,
  SkillInfo,
  TeleportResult,
  WorktreeInfo,
} from "@/lib/types"

type JsonObject = Record<string, unknown>

export class MobileResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "MobileResponseError"
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "")
}

function toBasicAuth(username: string, password: string): string {
  const value = `${username}:${password}`
  if (typeof btoa === "function") return btoa(value)
  return value
}

function parseErrorPayload(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const data = value as JsonObject
  const direct = data.error ?? data.message ?? data.detail
  if (typeof direct === "string" && direct.trim()) return direct.trim()
  if (Array.isArray(direct)) return direct.map(String).join(", ")
  return null
}

function isLikelyHtml(value: string): boolean {
  return /^\s*</.test(value)
}

export async function parseMobileResponse<T>(response: Response, pathname: string): Promise<T> {
  if (response.status === 204) return undefined as T

  const text = await response.text().catch(() => "")
  const contentType = response.headers.get("content-type") ?? ""
  let parsed: unknown = undefined

  if (text.trim()) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
  }

  if (!response.ok) {
    const parsedMessage = parseErrorPayload(parsed)
    if (parsedMessage) throw new MobileResponseError(parsedMessage, response.status)
    if (isLikelyHtml(text)) {
      throw new MobileResponseError(
        `Request to ${pathname} returned HTML (${response.status}). Check the server URL, auth, and endpoint prefix.`,
        response.status,
      )
    }
    throw new MobileResponseError(
      text.trim() || `Request to ${pathname} failed with ${response.status}`,
      response.status,
    )
  }

  if (parsed !== undefined) return parsed as T
  if (contentType.includes("application/json")) {
    throw new Error(`Request to ${pathname} returned invalid JSON`)
  }
  return text as T
}

export function buildMobileHeaders(config: ServerConfig, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    ...(extra ?? {}),
    "Content-Type": "application/json",
  }
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`
  } else if (config.username && config.password) {
    headers.Authorization = `Basic ${toBasicAuth(config.username, config.password)}`
  }
  if (config.directory) headers["x-nikcli-directory"] = config.directory
  return headers
}

export function buildMobileUrl(config: Pick<ServerConfig, "url">, pathname: string): string {
  const base = trimTrailingSlash(config.url)
  const path = pathname.startsWith("/") ? pathname.slice(1) : pathname
  return `${base}/${path}`
}

/** Primary filesystem directory for a session (execution cwd). */
export function sessionWorkspaceDirectory(session: Pick<Session, "directory" | "github">): string | undefined {
  const directory =
    session.directory?.trim() ||
    session.github?.worktree.directory?.trim() ||
    session.github?.repositoryDirectory?.trim() ||
    ""
  return directory || undefined
}

/** Secondary directory when the primary path differs from the repo root or worktree. */
export function sessionWorkspaceFallback(session: Pick<Session, "directory" | "github">): string | undefined {
  const primary = sessionWorkspaceDirectory(session)
  for (const candidate of [session.github?.worktree.directory?.trim(), session.github?.repositoryDirectory?.trim()]) {
    if (candidate && candidate !== primary) return candidate
  }
  return undefined
}

/** Git operations for a session use the same directory as workspace file access. */
export const sessionGitDirectory = sessionWorkspaceDirectory

/** Resolve the parent project directory used for worktree create/reset/remove calls. */
export function projectDirectoryForWorktree(
  projects: ProjectInfo[],
  selectedDirectory?: string,
  fallback?: ProjectInfo,
): string | undefined {
  const selected = projects.find((item) => {
    const sandboxes = Array.isArray(item.sandboxes) ? item.sandboxes : []
    return item.worktree === selectedDirectory || sandboxes.includes(selectedDirectory || "")
  })
  return selected?.worktree || fallback?.worktree
}

/**
 * Normalize a user-entered teleport server URL into a base origin we can append
 * `/mobile/teleport` to. Accepts values with or without a scheme/trailing slash.
 */
export function normalizeTeleportBaseUrl(raw: string): string | null {
  let value = raw.trim()
  if (!value) return null
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  try {
    const url = new URL(value)
    return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/mobile(\/teleport)?$/, "")
  } catch {
    return null
  }
}

export class MobileClient {
  constructor(
    private readonly config: ServerConfig,
    /**
     * `onUnauthorized` refreshes the account token after a 401. `fallbackToken`
     * is the pairing token from the stored config, kept apart because the
     * account token overwrites `config.token` while a user is signed in — so
     * once a refresh fails there is otherwise nothing left to try, even on a
     * phone whose pairing token the host still honours.
     */
    private readonly auth?: { onUnauthorized(): Promise<string | null>; fallbackToken?: string },
  ) {}

  withDirectory(directory: string) {
    return new MobileClient({ ...this.config, directory }, this.auth)
  }

  headers(extra?: Record<string, string>) {
    return buildMobileHeaders(this.config, extra)
  }

  url(pathname: string) {
    return buildMobileUrl(this.config, pathname)
  }

  async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    let response = await fetch(this.url(pathname), {
      ...init,
      headers: this.headers(init?.headers as Record<string, string> | undefined),
    })
    if (response.status === 401 && this.auth) {
      // A failed refresh is not the end of the road: fall back to the pairing
      // token. The guard skips the retry when it would resend what already
      // failed — with no account token, `config.token` is that same pairing
      // token and a second identical request just earns a second 401.
      const refreshed = await this.auth.onUnauthorized()
      const fallback = this.auth.fallbackToken?.trim() || undefined
      const token = refreshed ?? (fallback && fallback !== this.config.token ? fallback : null)
      if (token) {
        response = await fetch(this.url(pathname), {
          ...init,
          headers: buildMobileHeaders(
            { ...this.config, token, username: undefined, password: undefined },
            init?.headers as Record<string, string> | undefined,
          ),
        })
      }
    }
    return parseMobileResponse<T>(response, pathname)
  }

  bootstrap() {
    return this.request<MobileBootstrap>("/mobile/bootstrap")
  }

  listCommands(sessionID: string) {
    return this.request<CommandInfo[]>(`/mobile/session/${encodeURIComponent(sessionID)}/command`)
  }

  listHostCommands() {
    return this.request<CommandInfo[]>("/mobile/command")
  }

  listSessions(search?: string) {
    const query = new URLSearchParams({ roots: "true" })
    if (search) query.set("search", search)
    return this.request<SessionSummary[]>(`/mobile/session?${query.toString()}`)
  }

  createSession(input?: {
    title?: string
    parentID?: string
    permission?: unknown
    github?: Session["github"]
    executionTarget?: MobileExecutionTarget
  }) {
    return this.request<Session>("/mobile/session", {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    })
  }

  getSession(sessionID: string) {
    return this.request<SessionDetail>(`/mobile/session/${encodeURIComponent(sessionID)}`)
  }

  compactSession(sessionID: string, model: ModelRef) {
    return this.request<boolean>(`/session/${encodeURIComponent(sessionID)}/summarize`, {
      method: "POST",
      body: JSON.stringify({
        providerID: model.providerID,
        modelID: model.modelID,
        auto: false,
      }),
    })
  }

  sendMessage(sessionID: string, text: string, options?: { model?: ModelRef; agent?: string; variant?: string }) {
    return this.sendParts(sessionID, [{ type: "text", text }], options)
  }

  sendCommand(
    sessionID: string,
    command: string,
    argumentsText = "",
    options?: { model?: ModelRef; agent?: string; variant?: string },
  ) {
    return this.request<{
      info: SessionDetail["messages"][number]["info"]
      parts: SessionDetail["messages"][number]["parts"]
    }>(`/mobile/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify({
        command,
        arguments: argumentsText,
        agent: options?.agent,
        model: options?.model,
        variant: options?.variant,
      }),
    })
  }

  sendParts(
    sessionID: string,
    parts: Array<Pick<FilePart, "type" | "mime" | "filename" | "url"> | { type: "text"; text: string }>,
    options?: { model?: ModelRef; agent?: string; variant?: string },
  ) {
    return this.request<{ accepted: true }>(`/mobile/session/${encodeURIComponent(sessionID)}/message`, {
      method: "POST",
      body: JSON.stringify({ parts, ...options }),
    })
  }

  deleteSession(sessionID: string) {
    return this.request<{ success: true }>(`/mobile/session/${encodeURIComponent(sessionID)}`, {
      method: "DELETE",
    })
  }

  abortSession(sessionID: string) {
    return this.request<{ success: true }>(`/mobile/session/${encodeURIComponent(sessionID)}/abort`, {
      method: "POST",
    })
  }

  respondToPermission(sessionID: string, permissionID: string, response: "once" | "always" | "reject") {
    return this.request<{ success: true }>(
      `/mobile/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`,
      {
        method: "POST",
        body: JSON.stringify({ response }),
      },
    )
  }

  respondToQuestion(sessionID: string, requestID: string, answers: string[][]) {
    return this.request<{ success: true }>(
      `/mobile/session/${encodeURIComponent(sessionID)}/question/${encodeURIComponent(requestID)}`,
      {
        method: "POST",
        body: JSON.stringify({ answers }),
      },
    )
  }

  rejectQuestion(sessionID: string, requestID: string) {
    return this.request<{ success: true }>(
      `/mobile/session/${encodeURIComponent(sessionID)}/question/${encodeURIComponent(requestID)}`,
      {
        method: "DELETE",
      },
    )
  }

  getDiff(sessionID: string, messageID: string) {
    return this.request<FileDiff[]>(
      `/mobile/session/${encodeURIComponent(sessionID)}/diff/${encodeURIComponent(messageID)}`,
    )
  }

  sessionStreamUrl(sessionID: string) {
    return this.url(`/mobile/session/${encodeURIComponent(sessionID)}/stream`)
  }

  /**
   * Teleport a session living on this server to another nikcli server (e.g. a
   * Railway deploy) so it can be resumed there — including its working directory.
   * The phone has no filesystem, so this delegates to the connected server, which
   * archives the session's working dir and ships both content and transcript to
   * the target. The target also gets a project entry in its repo list.
   */
  async teleport(
    sessionID: string,
    target: {
      url: string
      token: string
      content?: boolean
      includeGit?: boolean
    },
  ): Promise<TeleportResult> {
    const base = normalizeTeleportBaseUrl(target.url)
    if (!base) throw new Error("Invalid teleport server URL")

    return this.request<TeleportResult>(`/mobile/session/${encodeURIComponent(sessionID)}/teleport`, {
      method: "POST",
      body: JSON.stringify({
        url: base,
        token: target.token.trim(),
        content: target.content,
        includeGit: target.includeGit,
      }),
    })
  }

  listProjects() {
    return this.request<ProjectInfo[]>("/mobile/project")
  }

  listProviders() {
    return this.request<ProviderCatalog>("/provider")
  }

  getConfig() {
    return this.request<HostConfigSnapshot>("/config")
  }

  updateConfig(config: HostConfigSnapshot) {
    return this.request<HostConfigSnapshot>("/config", {
      method: "PATCH",
      body: JSON.stringify(config),
    })
  }

  listMcpStatus() {
    return this.request<Record<string, HostMcpStatus>>("/mcp")
  }

  listPromptHistory() {
    return this.request<PromptHistoryEntry[]>("/mobile/memory/history")
  }

  searchMemories(query: string) {
    return this.request<MemorySearchHit[]>(`/mobile/memory/search?query=${encodeURIComponent(query)}`)
  }

  listPromptStash() {
    return this.request<PromptStashEntry[]>("/mobile/memory/stash")
  }

  addPromptStash(input: { input: string }) {
    return this.request<PromptStashEntry>("/mobile/memory/stash", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  removePromptStash(id: string) {
    return this.request<{ success: true }>(`/mobile/memory/stash/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  }

  connectMcp(name: string) {
    return this.request<boolean>(`/mcp/${encodeURIComponent(name)}/connect`, {
      method: "POST",
    })
  }

  disconnectMcp(name: string) {
    return this.request<boolean>(`/mcp/${encodeURIComponent(name)}/disconnect`, {
      method: "POST",
    })
  }

  toggleMcp(name: string, enabled: boolean) {
    return this.request<Record<string, HostMcpStatus>>(`/mcp/${encodeURIComponent(name)}/toggle`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    })
  }

  getGitStatus() {
    return this.request<GitState>("/mobile/git/status")
  }

  getGitCommits(limit: number = 20) {
    return this.request<import("@/lib/types").GitCommit[]>(`/mobile/git/commits?limit=${limit}`)
  }

  getGitDiff(options?: { staged?: boolean; file?: string }) {
    const params = new URLSearchParams()
    if (options?.staged) params.set("staged", "true")
    if (options?.file) params.set("file", options.file)
    const query = params.toString()
    return this.request<import("@/lib/types").ParsedFileDiff[]>(`/mobile/git/diff${query ? `?${query}` : ""}`)
  }

  getGitBranches() {
    return this.request<GitBranchInfo[]>("/mobile/git/branches")
  }

  stageGitFiles(paths: string[]) {
    return this.request<{ success: true }>("/mobile/git/stage", {
      method: "POST",
      body: JSON.stringify({ files: paths }),
    })
  }

  unstageGitFiles(paths: string[]) {
    return this.request<{ success: true }>("/mobile/git/unstage", {
      method: "POST",
      body: JSON.stringify({ files: paths }),
    })
  }

  discardGitFiles(paths: string[]) {
    return this.request<{ success: true }>("/mobile/git/discard", {
      method: "POST",
      body: JSON.stringify({ files: paths }),
    })
  }

  createGitCommit(message: string, files?: string[], options?: { stagedOnly?: boolean }) {
    return this.request<GitCommitResult>("/mobile/git/commit", {
      method: "POST",
      body: JSON.stringify({ message, files, stagedOnly: options?.stagedOnly }),
    })
  }

  pushGitBranch(upstream?: string) {
    const query = upstream ? `?upstream=${encodeURIComponent(upstream)}` : ""
    return this.request<{ success: true; pushed: boolean }>(`/mobile/git/push${query}`, { method: "POST" })
  }

  pullGitBranch() {
    return this.request<{
      success: true
      pulled: boolean
      conflicts?: string[]
    }>("/mobile/git/pull", {
      method: "POST",
    })
  }

  checkoutGitBranch(branch: string, options?: { create?: boolean }) {
    return this.request<{ success: true }>("/mobile/git/checkout", {
      method: "POST",
      body: JSON.stringify({ branch, create: options?.create }),
    })
  }

  // ── File System ──────────────────────────────────────────────────────────

  listDirectory(dirPath: string) {
    return this.request<FileNode[]>(`/file?path=${encodeURIComponent(dirPath)}`)
  }

  readFile(filePath: string) {
    return this.request<FileContent>(`/file/content?path=${encodeURIComponent(filePath)}`)
  }

  writeFile(filePath: string, content: string) {
    return this.request<{ success: boolean }>("/file/content", {
      method: "PUT",
      body: JSON.stringify({ path: filePath, content }),
    })
  }

  searchFiles(query: string) {
    return this.request<string[]>(`/find/file?query=${encodeURIComponent(query)}`)
  }

  searchText(pattern: string) {
    return this.request<SearchMatch[]>(`/find?pattern=${encodeURIComponent(pattern)}`)
  }

  startMcpAuth(name: string) {
    return this.request<{ authorizationUrl: string }>(`/mcp/${encodeURIComponent(name)}/auth`, {
      method: "POST",
    })
  }

  removeMcpAuth(name: string) {
    return this.request<{ success: true }>(`/mcp/${encodeURIComponent(name)}/auth`, {
      method: "DELETE",
    })
  }

  listSkills() {
    return this.request<SkillInfo[]>("/skill")
  }

  setProviderApiKey(providerID: string, key: string) {
    return this.request<{ success: true }>(`/provider/${encodeURIComponent(providerID)}/api`, {
      method: "POST",
      body: JSON.stringify({ key }),
    })
  }

  removeProviderAuth(providerID: string) {
    return this.request<{ success: true }>(`/provider/${encodeURIComponent(providerID)}/auth`, {
      method: "DELETE",
    })
  }

  listGithubRepos() {
    return this.request<GitHubRepo[]>("/mobile/github/repos")
  }

  listGithubBranches(owner: string, repo: string) {
    return this.request<GitHubBranch[]>(
      `/mobile/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    )
  }

  listGithubWorkflows(owner: string, repo: string) {
    return this.request<Workflow[]>(
      `/mobile/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows`,
    )
  }

  listGithubWorkflowRuns(owner: string, repo: string, options?: { branch?: string; limit?: number }) {
    const params = new URLSearchParams()
    if (options?.branch) params.set("branch", options.branch)
    if (options?.limit) params.set("limit", String(options.limit))
    const query = params.toString()
    return this.request<WorkflowRunList>(
      `/mobile/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs${query ? `?${query}` : ""}`,
    )
  }

  listGithubWorkflowRunJobs(owner: string, repo: string, runID: number) {
    return this.request<WorkflowJob[]>(
      `/mobile/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runID}/jobs`,
    )
  }

  rerunGithubWorkflowRun(owner: string, repo: string, runID: number, options?: { failedOnly?: boolean }) {
    return this.request<{ success: true }>(
      `/mobile/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runID}/rerun`,
      { method: "POST", body: JSON.stringify({ failedOnly: options?.failedOnly ?? false }) },
    )
  }

  cancelGithubWorkflowRun(owner: string, repo: string, runID: number) {
    return this.request<{ success: true }>(
      `/mobile/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runID}/cancel`,
      { method: "POST" },
    )
  }

  dispatchGithubWorkflow(
    owner: string,
    repo: string,
    workflowID: string,
    input: { ref: string; inputs?: Record<string, string> },
  ) {
    return this.request<{ success: true }>(
      `/mobile/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowID)}/dispatch`,
      { method: "POST", body: JSON.stringify(input) },
    )
  }

  listGithubImports() {
    return this.request<ManagedGithubImport[]>("/mobile/github/imports")
  }

  startGithubDeviceAuth() {
    return this.request<GitHubDeviceAuthStart>("/mobile/github/oauth/device", {
      method: "POST",
    })
  }

  saveGithubOAuthClientID(clientId: string) {
    return this.request<HostConfigSnapshot>("/mobile/github/oauth/client", {
      method: "POST",
      body: JSON.stringify({ clientId }),
    })
  }

  pollGithubDeviceAuth(deviceCode: string) {
    return this.request<GitHubDeviceAuthPollResult>("/mobile/github/oauth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
    })
  }

  setGithubToken(token: string) {
    return this.request<{ success: true }>("/mobile/github/auth", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
  }

  clearGithubToken() {
    return this.request<{ success: true }>("/mobile/github/auth", {
      method: "DELETE",
    })
  }

  importGithubRepo(input: { owner: string; repo: string; cloneUrl: string; defaultBranch: string; private: boolean }) {
    return this.request<{ import: ManagedGithubImport; project: ProjectInfo }>("/mobile/github/import", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  createGithubSession(input: {
    owner: string
    repo: string
    cloneUrl: string
    htmlUrl?: string
    defaultBranch: string
    baseBranch: string
    private: boolean
    title?: string
    executionTarget?: MobileExecutionTarget
  }) {
    return this.request<GitHubSessionCreateResult>("/mobile/github/session", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  publishGithubSession(sessionID: string, input?: { title?: string; body?: string; commitMessage?: string }) {
    return this.request<GitHubPublishResult>(`/mobile/session/${encodeURIComponent(sessionID)}/publish`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    })
  }

  cleanupGithubSession(sessionID: string) {
    return this.request<{ success: true }>(`/mobile/session/${encodeURIComponent(sessionID)}/cleanup`, {
      method: "POST",
    })
  }

  createWorktree(input?: string | { name?: string; projectDirectory?: string }) {
    const options = typeof input === "string" ? { name: input } : input
    const scoped = options?.projectDirectory ? this.withDirectory(options.projectDirectory) : this
    return scoped.request<WorktreeInfo>("/mobile/worktree", {
      method: "POST",
      body: JSON.stringify(options?.name ? { name: options.name } : {}),
    })
  }

  resetWorktree(directory: string, projectDirectory?: string) {
    const scoped = projectDirectory ? this.withDirectory(projectDirectory) : this
    return scoped.request<{ success: true }>("/mobile/worktree/reset", {
      method: "POST",
      body: JSON.stringify({ directory }),
    })
  }

  removeWorktree(directory: string, projectDirectory?: string) {
    const scoped = projectDirectory ? this.withDirectory(projectDirectory) : this
    return scoped.request<{ success: true }>("/mobile/worktree", {
      method: "DELETE",
      body: JSON.stringify({ directory }),
    })
  }

  async ping(): Promise<boolean> {
    try {
      await this.request<MobileBootstrap>("/mobile/bootstrap")
      return true
    } catch {
      return false
    }
  }

  listAuthTokens() {
    return this.request<MobileAuthToken[]>("/mobile/auth/token")
  }

  createAuthToken(name?: string, expiresInDays?: number) {
    return this.request<{ token: string; info: MobileAuthToken }>("/mobile/auth/token", {
      method: "POST",
      body: JSON.stringify({ name, expiresInDays }),
    })
  }

  revokeAuthToken(id: string) {
    return this.request<{ revoked: boolean }>(`/mobile/auth/token/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  }

  listConnectors() {
    return this.request<Record<string, ConnectorStatus>>("/connectors")
  }

  setConnectorAuth(name: string, input: ConnectorAuthInput) {
    return this.request<{ success: true }>(`/connectors/${encodeURIComponent(name)}/auth`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  removeConnectorAuth(name: string) {
    return this.request<{ success: true }>(`/connectors/${encodeURIComponent(name)}/auth`, {
      method: "DELETE",
    })
  }

  listAgents() {
    return this.request<AgentInfo[]>("/agent")
  }

  renameSession(sessionID: string, title: string) {
    return this.request<{ success: true }>(`/mobile/session/${encodeURIComponent(sessionID)}/rename`, {
      method: "POST",
      body: JSON.stringify({ title }),
    })
  }

  // ── Routines ────────────────────────────────────────────────────────────────

  listRoutines() {
    return this.request<Routine[]>("/mobile/routines")
  }

  createRoutine(input: RoutineCreateInput) {
    return this.request<Routine>("/mobile/routines", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  getRoutine(id: string) {
    return this.request<Routine>(`/mobile/routines/${encodeURIComponent(id)}`)
  }

  updateRoutine(id: string, input: RoutineUpdateInput) {
    return this.request<Routine>(`/mobile/routines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  }

  deleteRoutine(id: string) {
    return this.request<{ success: true }>(`/mobile/routines/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  }

  runRoutine(id: string) {
    return this.request<Session>(`/mobile/routines/${encodeURIComponent(id)}/run`, {
      method: "POST",
    })
  }

  pauseRoutine(id: string) {
    return this.request<Routine>(`/mobile/routines/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    })
  }

  resumeRoutine(id: string) {
    return this.request<Routine>(`/mobile/routines/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    })
  }

  // ── Loops ───────────────────────────────────────────────────────────────────

  async listLoops() {
    const result = await this.request<unknown>("/mobile/loops")
    if (
      !result ||
      typeof result !== "object" ||
      !Array.isArray((result as JsonObject).loops) ||
      !Array.isArray((result as JsonObject).runtimes)
    ) {
      throw new Error(
        "The server returned an incompatible loop list. Update the connected Nikcli server and try again.",
      )
    }
    return result as LoopListResult
  }

  listLoopTemplates() {
    return this.request<{ templates: LoopTemplate[] }>("/mobile/loops/templates")
  }

  generateLoop(description: string, options?: { model?: string; agent?: string }) {
    return this.request<LoopDefinition>("/mobile/loops/generate", {
      method: "POST",
      body: JSON.stringify({ description, ...options }),
    })
  }

  createLoop(input: LoopWriteInput) {
    return this.request<LoopDefinition>("/mobile/loops", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  getLoop(id: string) {
    return this.request<LoopDetailResult>(`/mobile/loops/${encodeURIComponent(id)}`)
  }

  updateLoop(id: string, input: LoopWriteInput) {
    return this.request<LoopDefinition>(`/mobile/loops/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  }

  deleteLoop(id: string) {
    return this.request<{ success: true }>(`/mobile/loops/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  }

  listLoopRuns(id: string, limit = 50) {
    return this.request<{ runs: LoopRun[] }>(`/mobile/loops/${encodeURIComponent(id)}/runs?limit=${limit}`)
  }

  runLoop(id: string) {
    return this.request<{ success: true }>(`/mobile/loops/${encodeURIComponent(id)}/run`, {
      method: "POST",
    })
  }

  abortLoop(id: string) {
    return this.request<{ success: true }>(`/mobile/loops/${encodeURIComponent(id)}/abort`, {
      method: "POST",
    })
  }

  toggleLoop(id: string, enabled: boolean) {
    return this.request<LoopDefinition>(`/mobile/loops/${encodeURIComponent(id)}/toggle`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    })
  }

  pauseLoop(id: string) {
    return this.request<{ success: true }>(`/mobile/loops/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    })
  }

  resumeLoop(id: string) {
    return this.request<{ success: true }>(`/mobile/loops/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    })
  }

  // ── Missions ────────────────────────────────────────────────────────────────

  async listMissions() {
    const result = await this.request<unknown>("/mobile/missions")
    if (
      !result ||
      typeof result !== "object" ||
      !Array.isArray((result as JsonObject).missions) ||
      !Array.isArray((result as JsonObject).runtimes)
    ) {
      throw new Error(
        "The server returned an incompatible mission list. Update the connected Nikcli server and try again.",
      )
    }
    return result as MissionListResult
  }

  listMissionTemplates() {
    return this.request<{ templates: MissionTemplate[] }>("/mobile/missions/templates")
  }

  generateMission(description: string, options?: { model?: string; agent?: string }) {
    return this.request<MissionDefinition>("/mobile/missions/generate", {
      method: "POST",
      body: JSON.stringify({ description, ...options }),
    })
  }

  createMission(input: MissionWriteInput) {
    return this.request<MissionDefinition>("/mobile/missions", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  getMission(id: string) {
    return this.request<MissionDetailResult>(`/mobile/missions/${encodeURIComponent(id)}`)
  }

  updateMission(id: string, input: MissionDefinition) {
    return this.request<MissionDefinition>(`/mobile/missions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  }

  deleteMission(id: string) {
    return this.request<{ success: true }>(`/mobile/missions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
  }

  listMissionExecs(id: string, limit = 50) {
    return this.request<{ execs: MissionExec[] }>(`/mobile/missions/${encodeURIComponent(id)}/execs?limit=${limit}`)
  }

  startMission(id: string) {
    return this.request<{ success: true }>(`/mobile/missions/${encodeURIComponent(id)}/start`, { method: "POST" })
  }

  pauseMission(id: string) {
    return this.request<{ success: true }>(`/mobile/missions/${encodeURIComponent(id)}/pause`, { method: "POST" })
  }

  cancelMission(id: string) {
    return this.request<{ success: true }>(`/mobile/missions/${encodeURIComponent(id)}/cancel`, { method: "POST" })
  }

  mutateMissionFeature(
    id: string,
    featureID: string,
    input: { status?: MissionDefinition["milestones"][number]["features"][number]["status"]; error?: string },
  ) {
    return this.request<MissionDefinition>(
      `/mobile/missions/${encodeURIComponent(id)}/feature/${encodeURIComponent(featureID)}`,
      { method: "POST", body: JSON.stringify(input) },
    )
  }

  getSessionTodos(sessionID: string) {
    return this.request<{ todos: SessionTodo[] }>(`/mobile/session/${encodeURIComponent(sessionID)}/todo`)
  }

  getBrainStatus() {
    return this.request<BrainStatus>("/mobile/brain")
  }

  triggerBrain(force = true) {
    return this.request<BrainTriggerResult>("/mobile/brain", {
      method: "POST",
      body: JSON.stringify({ force }),
    })
  }

  listChatBots() {
    return this.request<{ bots: ChatBotInfo[] }>("/mobile/chatbot/bots")
  }

  startChatBot(name: string) {
    return this.request<{ running: boolean; error?: string }>(
      `/mobile/chatbot/bots/${encodeURIComponent(name)}/start`,
      { method: "POST" },
    )
  }

  stopChatBot(name: string) {
    return this.request<{ removed: boolean }>(`/mobile/chatbot/bots/${encodeURIComponent(name)}/stop`, {
      method: "POST",
    })
  }

  getObservability() {
    return this.request<ObservabilityStatus>("/mobile/observability")
  }

  setObservability(enabled: boolean) {
    return this.request<ObservabilityStatus>("/mobile/observability", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    })
  }

  listLspStatus() {
    return this.request<{ servers: LspServerStatus[]; error?: string }>("/mobile/lsp")
  }

  listFusionPresets() {
    return this.request<{ presets: FusionPreset[] }>("/mobile/fusion")
  }

  setFusionPreset(name: string, enabled: boolean) {
    return this.request<{ name: string; enabled: boolean }>("/mobile/fusion", {
      method: "POST",
      body: JSON.stringify({ name, enabled }),
    })
  }

  getHostBrowser() {
    return this.request<HostCapability<{ sessions?: unknown[] }>>("/mobile/host/browser")
  }

  getHostComputer() {
    return this.request<HostCapability<{ platform?: string; screenshot?: boolean; input?: boolean; detail?: string }>>(
      "/mobile/host/computer",
    )
  }

  getHostHerdr() {
    return this.request<HostCapability<{ enabled?: boolean; installed?: boolean }>>("/mobile/host/herdr")
  }

  setHostHerdr(enabled: boolean) {
    return this.request<HostCapability<{ enabled?: boolean }>>("/mobile/host/herdr", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    })
  }

  getHostIsland() {
    return this.request<
      HostCapability<{ supported?: boolean; enabled?: boolean; appRunning?: boolean; sessions?: number }>
    >("/mobile/host/island")
  }

  getHostDevtools() {
    return this.request<
      HostCapability<{ rss?: number; heapUsed?: number; pid?: number; uptimeSec?: number; platform?: string }>
    >("/mobile/host/devtools")
  }

  // ── PTY (Terminal) ──────────────────────────────────────────────────────────

  listPty() {
    return this.request<PtyInfo[]>("/mobile/pty")
  }

  createPty(input: PtyCreateInput = {}) {
    return this.request<PtyInfo>("/mobile/pty", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  getPty(ptyID: string) {
    return this.request<PtyInfo>(`/mobile/pty/${encodeURIComponent(ptyID)}`)
  }

  updatePty(ptyID: string, input: PtyUpdateInput) {
    return this.request<PtyInfo>(`/mobile/pty/${encodeURIComponent(ptyID)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    })
  }

  removePty(ptyID: string) {
    return this.request<boolean>(`/mobile/pty/${encodeURIComponent(ptyID)}`, {
      method: "DELETE",
    })
  }

  /** Returns the ws:// or wss:// URL to connect wterm's WebSocketTransport */
  ptyConnectUrl(ptyID: string): string {
    const http = this.url(`/mobile/pty/${encodeURIComponent(ptyID)}/connect`)
    const ws = http.replace(/^https?:/, (m) => (m === "https:" ? "wss:" : "ws:"))
    const url = new URL(ws)
    // WebSocket does not support custom headers. Mirror the headers used by createPty()
    // through query params so the server resolves the same Instance.directory/state.
    if (this.config.token) url.searchParams.set("token", this.config.token)
    if (this.config.directory) url.searchParams.set("directory", this.config.directory)
    return url.toString()
  }

  withToken(token: string): MobileClient {
    return new MobileClient({ ...this.config, token }, this.auth)
  }

  get serverUrl(): string {
    return this.config.url
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _client: MobileClient | null = null
let _configKey = ""

export function createMobileClient(config: ServerConfig): MobileClient {
  _configKey = JSON.stringify(config)
  _client = new MobileClient(config)
  return _client
}

export function getCachedClient(): MobileClient | null {
  return _client
}

export function invalidateClient(): void {
  _client = null
  _configKey = ""
}

export async function getMobileClient(): Promise<MobileClient | null> {
  const { getServerConfig } = await import("./storage")
  const config = await getServerConfig()
  if (!config) return null
  const key = JSON.stringify(config)
  if (_client && _configKey === key) return _client
  return createMobileClient(config)
}
