export const SERVER_CONFIG_KEY = "nikcli_server_config"
// Shared pairing-token storage — the SAME keys the web app (src/app/api.ts) and the
// mobile/CLI pairing flow use, so the dashboard authenticates with the one bearer
// token that the nikcli server's global middleware accepts (Authorization: Bearer nkm_…).
export const SERVER_TOKEN_KEY = "nikcli_server_token"
// Legacy dashboard-only token key (email/password era) — still read for back-compat.
export const USER_TOKEN_KEY = "nikcli_dashboard_token"
export const DASHBOARD_USER_KEY = "nikcli_dashboard_user"
// Production nikcli server deployed on Railway, reachable at the s.nikcli-ai.dev subdomain.
// This is the default backend for every dashboard (hosted or local) unless overridden.
const PROD_SERVER_URL = "https://s.nikcli-ai.dev"
const DEFAULT_SERVER_URL =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.PROD_SERVER_URL) || PROD_SERVER_URL

// Local nikcli server (e.g. `nikcli serve`) for development.
const LOCAL_SERVER_URL = "http://localhost:4096"

type StoredServerConfig = { url?: string; token?: string; directory?: string; [k: string]: unknown }

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}

export function normalizeServerUrl(input: string): string {
  const value = input.trim()
  if (!value) return ""
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URL must start with http:// or https://")
  }
  return url.toString().replace(/\/$/, "")
}

function assertBrowserSafeServerUrl(url: string) {
  if (typeof window === "undefined") return
  if (window.location.protocol !== "https:") return
  const parsed = new URL(url)
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("Use an HTTPS nikcli server URL from this dashboard")
  }
}

function loadStoredServerUrl(): string {
  if (typeof localStorage === "undefined") return ""
  try {
    const raw = localStorage.getItem(SERVER_CONFIG_KEY)
    if (!raw) return ""
    const cfg = JSON.parse(raw) as StoredServerConfig
    return cfg.url ? normalizeServerUrl(cfg.url) : ""
  } catch {
    return ""
  }
}

function readStoredConfig(): StoredServerConfig {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(SERVER_CONFIG_KEY)
    return raw ? (JSON.parse(raw) as StoredServerConfig) : {}
  } catch {
    return {}
  }
}

function writeStoredConfig(patch: Partial<StoredServerConfig>) {
  if (typeof localStorage === "undefined") return
  // Merge so we never clobber fields the web app / mobile pairing also store
  // under nikcli_server_config (token, directory, model preferences, …).
  const next = { ...readStoredConfig(), ...patch }
  localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify(next))
}

export function saveServerConfig(url: string): string {
  const normalized = normalizeServerUrl(url)
  assertBrowserSafeServerUrl(normalized)
  writeStoredConfig({ url: normalized })
  return normalized
}

export function clearServerConfig() {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(SERVER_CONFIG_KEY)
}

/**
 * Resolve the shared nikcli pairing token (Authorization: Bearer nkm_…).
 * Reads the SAME locations the web app uses so the dashboard, the web app, and
 * the mobile/CLI pairing flow all share one credential:
 *   1. sessionStorage[nikcli_server_token]  (web app primary)
 *   2. nikcli_server_config.token           (web app fallback / pairing link)
 *   3. localStorage[nikcli_server_token]     (cross-tab persistence)
 *   4. localStorage[nikcli_dashboard_token]  (legacy dashboard token)
 */
export function getSharedToken(): string | null {
  if (typeof window === "undefined") return null
  const fromSession = window.sessionStorage?.getItem(SERVER_TOKEN_KEY)
  if (fromSession) return fromSession
  const cfgToken = readStoredConfig().token
  if (typeof cfgToken === "string" && cfgToken) return cfgToken
  const fromLocal = window.localStorage?.getItem(SERVER_TOKEN_KEY)
  if (fromLocal) return fromLocal
  return window.localStorage?.getItem(USER_TOKEN_KEY) || null
}

/** Persist the shared pairing token everywhere the ecosystem looks for it. */
export function saveSharedToken(token: string) {
  if (typeof window === "undefined") return
  const value = token.trim()
  if (!value) {
    clearDashboardSession()
    return
  }
  window.sessionStorage?.setItem(SERVER_TOKEN_KEY, value)
  window.localStorage?.setItem(SERVER_TOKEN_KEY, value)
  writeStoredConfig({ token: value })
}

export function clearDashboardSession() {
  if (typeof window === "undefined") return
  window.sessionStorage?.removeItem(SERVER_TOKEN_KEY)
  window.localStorage?.removeItem(SERVER_TOKEN_KEY)
  window.localStorage?.removeItem(USER_TOKEN_KEY)
  window.localStorage?.removeItem(DASHBOARD_USER_KEY)
  const { token: _drop, ...rest } = readStoredConfig()
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify(rest))
  }
}

export function resolveServerBase(override?: string | null): string {
  // Every dashboard (hosted on nikcli-ai.dev or run locally) targets the nikcli
  // server — defaulting to the Railway deployment at s.nikcli-ai.dev — and
  // authenticates with the shared pairing token. An explicit override or a stored
  // server URL always wins (e.g. pointing at a local `nikcli serve`).
  const candidate = override
    ? normalizeServerUrl(override)
    : loadStoredServerUrl() || DEFAULT_SERVER_URL || LOCAL_SERVER_URL
  if (!candidate) return ""
  assertBrowserSafeServerUrl(candidate)
  return candidate
}

export function buildApiUrl(path: string, serverUrl?: string | null): string {
  const base = resolveServerBase(serverUrl)
  if (!base) {
    throw new Error("No server configured. Connect to a nikcli server first.")
  }
  return `${base}${path}`
}

function parseResponseBody(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const message = Reflect.get(error, "message")
    if (typeof message === "string" && message.trim()) return message
    const body = Reflect.get(error, "body")
    if (body && typeof body === "object") {
      const nested = Reflect.get(body, "error")
      if (typeof nested === "string" && nested.trim()) return nested
    }
    const nestedError = Reflect.get(error, "error")
    if (typeof nestedError === "string" && nestedError.trim()) return nestedError
  }
  return "Request failed"
}

export class DashboardApiError extends Error {
  status: number
  body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = "DashboardApiError"
    this.status = status
    this.body = body
  }
}

type DashboardRequestInit = RequestInit & {
  serverUrl?: string | null
  token?: string | null
}

export async function requestJson<T>(path: string, init: DashboardRequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  if (init.token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${init.token}`)
  }

  const response = await fetch(buildApiUrl(path, init.serverUrl), {
    ...init,
    headers,
  })

  const text = await response.text()
  const body = parseResponseBody(text)
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "error" in body && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error || response.statusText
        : typeof body === "string" && body.trim()
          ? body
          : response.statusText || `Request failed: ${response.status}`
    throw new DashboardApiError(message, response.status, body)
  }

  return body as T
}

function getServerBase(): string {
  return resolveServerBase()
}

function getToken(): string | null {
  return getSharedToken()
}

function handle401() {
  clearDashboardSession()
  if (typeof window !== "undefined") window.location.href = "/dashboard/login"
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  try {
    return await requestJson<T>(path, {
      ...init,
      token,
    })
  } catch (error) {
    if (error instanceof DashboardApiError && error.status === 401) {
      handle401()
      throw new Error("Session expired. Please log in again.")
    }
    throw error
  }
}

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body) }
}

export type NikcliConfig = {
  model?: string
  small_model?: string
  theme?: string
  autoupdate?: boolean | "notify"
  _path?: string
  mcp?: Record<string, McpServerConfig>
}

export type McpServerConfig =
  | { type: "local"; command: string[]; enabled?: boolean }
  | { type: "remote"; url: string; enabled?: boolean }

export type ProfileInfo = {
  mcpCount?: number
  plugins?: string[]
  providerCount?: number
}

export type ProfilesData = { profiles: Record<string, ProfileInfo>; activeProfile: string }

export type CloudSessionInfo = {
  id: string
  title: string
  parentID?: string
  directory?: string
  time?: {
    created: number
    updated: number
    archived?: number
  }
  messageCount?: number
  messages?: number
}

export type CloudSessionStatus = {
  status?: string
  lastUpdate?: number
  error?: string
}

export type CloudSessionCreateInput = {
  title?: string
  parentID?: string
}

export type SkillSummary = {
  name: string
  description?: string
  category?: string
  tags?: string[]
  path?: string
  disabled?: boolean
}

export type SkillDetail = SkillSummary & { content?: string }

export type SkillsData = { skills: SkillSummary[] }

export type PluginInfo = {
  name: string
  description?: string
  path?: string
  content?: string
}

export type PluginsData = { plugins: PluginInfo[] }

export type AgentInfo = {
  name: string
  description?: string
  mode?: string
  model?: string
  path?: string
}

export type AgentsData = { agents: AgentInfo[] }

export type CommandInfo = { name: string; description?: string; path?: string }
export type CommandsData = { commands: CommandInfo[] }

export type AuthInfo = { type: "api"; apiKey: string } | { type: "oauth"; access: string; refresh?: string }
export type AuthData = { auth: Record<string, { type: string; apiKey?: string }> }

export type BackupInfo = { name: string; size?: number; createdAt?: string }
export type BackupsData = { backups: BackupInfo[] }

export type GitHubStatus = { available: boolean; authenticated: boolean; username?: string }

export type ConfigPathsData = { detected?: string; candidates: string[] }

export type UserPatch = {
  displayName?: string
  password?: string
  role?: "admin" | "user"
}

export const studioApi = {
  config: {
    get: () => request<NikcliConfig>("/config"),
    patch: (patch: Partial<NikcliConfig>) =>
      request<{ success: boolean }>("/config", { method: "PATCH", ...json(patch) }),
    paths: () => request<ConfigPathsData>("/config/paths"),
    providers: () => request<{ providers: Record<string, unknown> }>("/config/providers"),
    setProviderApiKey: (id: string, apiKey: string) =>
      request<{ success: boolean }>(`/provider/${id}/api`, { method: "POST", ...json({ apiKey }) }),
  },

  mcp: {
    add: (name: string, config: McpServerConfig) =>
      request<{ success: boolean }>("/mcp", { method: "POST", ...json({ name, config }) }),
    patch: (name: string, patch: Partial<McpServerConfig>) =>
      request<{ success: boolean }>(`/config/mcp/${encodeURIComponent(name)}`, { method: "PATCH", ...json(patch) }),
    delete: (name: string) =>
      request<{ success: boolean }>(`/config/mcp/${encodeURIComponent(name)}`, { method: "DELETE" }),
    toggle: (name: string, enabled: boolean) =>
      request<Record<string, unknown>>(`/mcp/${encodeURIComponent(name)}/toggle`, {
        method: "POST",
        ...json({ enabled }),
      }),
  },

  profiles: {
    // Profiles live under the config router on the server: /config/profiles
    list: () => request<ProfilesData>("/config/profiles"),
    create: (name: string) => request<{ success: boolean }>("/config/profiles", { method: "POST", ...json({ name }) }),
    activate: (name: string) =>
      request<{ success: boolean }>(`/config/profiles/activate/${encodeURIComponent(name)}`, { method: "POST" }),
  },

  sessions: {
    list: (query: { roots?: boolean; limit?: number; search?: string } = {}) => {
      const params = new URLSearchParams()
      if (query.roots !== undefined) params.set("roots", String(query.roots))
      if (query.limit !== undefined) params.set("limit", String(query.limit))
      if (query.search) params.set("search", query.search)
      const suffix = params.toString() ? `?${params.toString()}` : ""
      return request<CloudSessionInfo[]>(`/session${suffix}`)
    },
    status: () => request<Record<string, CloudSessionStatus>>("/session/status"),
    create: (input: CloudSessionCreateInput = {}) =>
      request<CloudSessionInfo>("/session", { method: "POST", ...json(input) }),
    update: (id: string, patch: { title?: string; time?: { archived?: number } }) =>
      request<CloudSessionInfo>(`/session/${encodeURIComponent(id)}`, { method: "PATCH", ...json(patch) }),
    delete: (id: string) => request<boolean>(`/session/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },

  skills: {
    list: async () => ({ skills: await request<SkillSummary[]>("/skill") }),
    get: (name: string) => request<SkillDetail>(`/skill/${encodeURIComponent(name)}`),
    create: (name: string, description: string, content: string) =>
      request<{ success: boolean }>("/skill", { method: "POST", ...json({ name, description, content }) }),
    update: (name: string, data: Partial<SkillDetail>) =>
      request<{ success: boolean }>(`/skill/${encodeURIComponent(name)}`, { method: "PUT", ...json(data) }),
    delete: (name: string) => request<{ success: boolean }>(`/skill/${encodeURIComponent(name)}`, { method: "DELETE" }),
    importUrls: (urls: string[]) =>
      request<{ success: boolean; imported: number }>("/skills/import", { method: "POST", ...json({ urls }) }),
  },

  plugins: {
    list: () => request<PluginsData>("/plugins"),
    get: (name: string) => request<PluginInfo>(`/plugins/${encodeURIComponent(name)}`),
    create: (name: string, template: string) =>
      request<{ success: boolean }>("/plugins", { method: "POST", ...json({ name, template }) }),
    update: (name: string, content: string) =>
      request<{ success: boolean }>(`/plugins/${encodeURIComponent(name)}`, { method: "PUT", ...json({ content }) }),
  },

  agents: {
    list: async () => ({ agents: await request<AgentInfo[]>("/agent") }),
    create: (name: string, description: string, prompt: string) =>
      request<{ success: boolean }>("/agents", { method: "POST", ...json({ name, description, prompt }) }),
  },

  commands: {
    list: async () => ({ commands: await request<CommandInfo[]>("/command") }),
  },

  auth: {
    list: () => request<AuthData>("/auth"),
    set: (provider: string, info: AuthInfo) =>
      request<{ success: boolean }>(`/auth/${encodeURIComponent(provider)}`, { method: "POST", ...json(info) }),
    remove: (provider: string) =>
      request<{ success: boolean }>(`/auth/${encodeURIComponent(provider)}`, { method: "DELETE" }),
  },

  backup: {
    list: () => request<BackupsData>("/backup/list"),
    create: () => request<{ success: boolean; name: string }>("/backup/create", { method: "POST", ...json({}) }),
    restore: (name: string) => request<{ success: boolean }>("/backup/restore", { method: "POST", ...json({ name }) }),
  },

  github: {
    status: () => request<GitHubStatus>("/github/status"),
    push: () => request<{ success: boolean }>("/github/sync/push", { method: "POST", ...json({}) }),
  },

  users: {
    update: (id: string, patch: UserPatch) =>
      request<{ id: string; username: string; email: string; display_name?: string | null; role: "admin" | "user" }>(
        `/user/${encodeURIComponent(id)}`,
        { method: "PATCH", ...json(patch) },
      ),
    delete: (id: string) => request<{ ok: boolean }>(`/user/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
}
