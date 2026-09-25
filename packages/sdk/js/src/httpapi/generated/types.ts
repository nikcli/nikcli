export type InstanceDisposeResult = boolean

export type Path = { home: string; state: string; config: string; worktree: string; directory: string }

export type VcsInfo = { branch?: string | undefined }

export type VcsFileStatus = {
  file: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

export type VcsApplyResult = { applied: boolean }

export type Command = {
  name: string
  description?: string | undefined
  agent?: string | undefined
  model?: string | undefined
  mcp?: boolean | undefined
  skill?: boolean | undefined
  template: unknown
  subtask?: boolean | undefined
  hints: Array<string>
}

export type Agent = {
  name: string
  description?: string | undefined
  mode: "subagent" | "primary" | "all"
  native?: boolean | undefined
  hidden?: boolean | undefined
  topP?: number | undefined
  temperature?: number | undefined
  color?: string | undefined
  permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  permissionMode?: "default" | "auto" | undefined
  model?: { modelID: string; providerID: string } | undefined
  advisor?: { model: { modelID: string; providerID: string }; maxUses?: number | undefined } | undefined
  variant?: string | undefined
  prompt?: string | undefined
  options: { [x: string]: any }
  steps?: number | undefined
}

export type Skill = {
  name: string
  description: string
  location: string
  category?: string | undefined
  tags?: Array<string> | undefined
  version?: string | undefined
}

export type LSPStatus = { id: string; name: string; root: string; status: "connected" | "error" }

export type FormatterStatus = { name: string; extensions: Array<string>; enabled: boolean }

export type AnalyticsTokenBreakdown = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type AnalyticsProviderStat = { sessions: number; messages: number; tokens: number; cost: number }

export type AnalyticsModelTokens = { input: number; output: number; reasoning: number }

export type AnalyticsProjectStat = { sessions: number; tokens: number; cost: number; lastActive: number }

export type AnalyticsDataModelStat = {
  model: string
  provider: string
  author: string
  tokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  sessions: number
  messages: number
  toolCalls: number
  costUsd: number
  share: number
  pricePerMillion: number
  costPerSession: number
  tokensPerSession: number
  cacheRatio: number | null
}

export type AnalyticsDataPeriodStat = {
  month: string | null
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  messages: number
  toolCalls: number
  sessions: number
  costUsd: number
  models: number
  pricePerMillion: number
  costPerSession: number
  cacheRatio: number | null
}

export type AppSkillInfo = {
  name: string
  description: string
  location: string
  category?: string | undefined
  tags?: Array<string> | undefined
  version?: string | undefined
}

export type BrainStatus = {
  enabled: boolean
  memoryEnabled: boolean
  minHours: number
  minSessions: number
  lastBrainAt: number
  hoursSinceLastBrain: number
  sessionsSinceLastBrain: number
  shouldTrigger: boolean
  model?: { providerID: string; modelID: string } | undefined
}

export type BrainResult = {
  success: boolean
  sessionsReviewed: number
  hoursSinceLastBrain: number
  error?: string | undefined
  sessionID?: string | undefined
}

export type ChatbotBot = { name: string; type: string; running: boolean; webhookPath: string }

export type ChatbotStartResult = { running: boolean; error?: string | undefined }

export type ChatbotStopResult = { removed: boolean }

export type DiscordStatus = {
  configured: boolean
  running: boolean
  username?: string
  clientId?: string
  inviteUrl?: string
  error?: string
}

export type DiscordSetupOutput2 = { username: string; clientId: string; inviteUrl: string }

export type DiscordStartResult = { running: boolean; error?: string }

export type DiscordStopResult = { stopped: boolean }

export type VoiceTranscribeResult = { transcript: string; error?: string | undefined }

export type ProfileInfo = {
  version: number
  key: string
  name?: string | undefined
  role?: string | undefined
  about?: string | undefined
  stack?: Array<string> | undefined
  expertise?: Array<string> | undefined
  learning?: Array<string> | undefined
  skills?: Array<string> | undefined
  tools?: { preferred?: Array<string> | undefined; avoid?: Array<string> | undefined } | undefined
  conventions?: Array<string> | undefined
  communication?:
    | {
        verbosity?: "concise" | "balanced" | "detailed" | undefined
        language?: string | undefined
        explain?: boolean | undefined
      }
    | undefined
  custom?: string | undefined
  habits?: boolean | undefined
  updatedAt: number
}

export type ProfileDeleted = { deleted: boolean }

export type ProfileHabits = { content: string }

export type ProfilePreview = { lines: Array<string>; habitsFile: string }

export type KeybindsConfig = {
  leader?: string | undefined
  app_exit?: string | undefined
  editor_open?: string | undefined
  theme_list?: string | undefined
  sidebar_toggle?: string | undefined
  scrollbar_toggle?: string | undefined
  username_toggle?: string | undefined
  status_view?: string | undefined
  sync_view?: string | undefined
  session_export?: string | undefined
  session_new?: string | undefined
  session_list?: string | undefined
  session_timeline?: string | undefined
  session_fork?: string | undefined
  session_rename?: string | undefined
  session_delete?: string | undefined
  session_pin_toggle?: string | undefined
  session_scope_toggle?: string | undefined
  session_tab_back?: string | undefined
  session_tab_forward?: string | undefined
  session_quick_switch_1?: string | undefined
  session_quick_switch_2?: string | undefined
  session_quick_switch_3?: string | undefined
  session_quick_switch_4?: string | undefined
  session_quick_switch_5?: string | undefined
  session_quick_switch_6?: string | undefined
  session_quick_switch_7?: string | undefined
  session_quick_switch_8?: string | undefined
  session_quick_switch_9?: string | undefined
  stash_delete?: string | undefined
  model_provider_list?: string | undefined
  model_favorite_toggle?: string | undefined
  session_share?: string | undefined
  session_unshare?: string | undefined
  session_interrupt?: string | undefined
  session_codebro_open?: string | undefined
  subtask_background?: string | undefined
  subtask_picker?: string | undefined
  session_compact?: string | undefined
  messages_page_up?: string | undefined
  messages_page_down?: string | undefined
  messages_line_up?: string | undefined
  messages_line_down?: string | undefined
  messages_half_page_up?: string | undefined
  messages_half_page_down?: string | undefined
  messages_first?: string | undefined
  messages_last?: string | undefined
  messages_next?: string | undefined
  messages_previous?: string | undefined
  messages_last_user?: string | undefined
  messages_copy?: string | undefined
  messages_undo?: string | undefined
  messages_redo?: string | undefined
  messages_toggle_conceal?: string | undefined
  tool_details?: string | undefined
  model_list?: string | undefined
  model_cycle_recent?: string | undefined
  model_cycle_recent_reverse?: string | undefined
  model_cycle_favorite?: string | undefined
  model_cycle_favorite_reverse?: string | undefined
  command_list?: string | undefined
  agent_list?: string | undefined
  agent_cycle?: string | undefined
  agent_cycle_reverse?: string | undefined
  permission_mode?: string | undefined
  variant_cycle?: string | undefined
  input_clear?: string | undefined
  input_paste?: string | undefined
  input_submit?: string | undefined
  input_newline?: string | undefined
  input_move_left?: string | undefined
  input_move_right?: string | undefined
  input_move_up?: string | undefined
  input_move_down?: string | undefined
  input_select_left?: string | undefined
  input_select_right?: string | undefined
  input_select_up?: string | undefined
  input_select_down?: string | undefined
  input_line_home?: string | undefined
  input_line_end?: string | undefined
  input_select_line_home?: string | undefined
  input_select_line_end?: string | undefined
  input_visual_line_home?: string | undefined
  input_visual_line_end?: string | undefined
  input_select_visual_line_home?: string | undefined
  input_select_visual_line_end?: string | undefined
  input_buffer_home?: string | undefined
  input_buffer_end?: string | undefined
  input_select_buffer_home?: string | undefined
  input_select_buffer_end?: string | undefined
  input_delete_line?: string | undefined
  input_delete_to_line_end?: string | undefined
  input_delete_to_line_start?: string | undefined
  input_backspace?: string | undefined
  input_delete?: string | undefined
  input_undo?: string | undefined
  input_redo?: string | undefined
  input_word_forward?: string | undefined
  input_word_backward?: string | undefined
  input_select_word_forward?: string | undefined
  input_select_word_backward?: string | undefined
  input_delete_word_forward?: string | undefined
  input_delete_word_backward?: string | undefined
  history_previous?: string | undefined
  history_next?: string | undefined
  session_child_cycle?: string | undefined
  session_child_cycle_reverse?: string | undefined
  session_parent?: string | undefined
  session_child_close?: string | undefined
  terminal_suspend?: string | undefined
  terminal_title_toggle?: string | undefined
  tips_toggle?: string | undefined
  voice_record?: string | undefined
  app_support?: string | undefined
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

export type AdsItemConfig = { id: string; text: string; url?: string | undefined; enabled?: boolean | undefined }

export type ServerConfig = {
  port?: number | undefined
  hostname?: string | undefined
  mdns?: boolean | undefined
  cors?: Array<string> | undefined
}

export type RemoteConfig = {
  enabled?: boolean | undefined
  enableTunnel?: boolean | undefined
  provider?: "localtunnel" | "cloudflared" | "ngrok" | "remotosh" | "none" | undefined
  askOnExistingSession?: boolean | undefined
}

export type TeleportConfig = { url?: string | undefined; token?: string | undefined }

export type ReferenceConfig =
  | { type: "git"; repository: string; branch?: string | undefined; description?: string | undefined }
  | { type: "local"; path: string; description?: string | undefined }

export type PermissionActionConfig = "ask" | "allow" | "deny"

export type PermissionModeConfig = "default" | "auto"

export type ProviderConfig = {
  api?: string | undefined
  name?: string | undefined
  env?: Array<string> | undefined
  id?: string | undefined
  npm?: string | undefined
  models?:
    | {
        [x: string]: {
          id?: string | undefined
          name?: string | undefined
          family?: string | undefined
          release_date?: string | undefined
          attachment?: boolean | undefined
          reasoning?: boolean | undefined
          temperature?: boolean | undefined
          tool_call?: boolean | undefined
          interleaved?: true | { field: "reasoning_content" | "reasoning_details" } | undefined
          cost?:
            | {
                input: number
                output: number
                cache_read?: number | undefined
                cache_write?: number | undefined
                context_over_200k?:
                  | { input: number; output: number; cache_read?: number | undefined; cache_write?: number | undefined }
                  | undefined
              }
            | undefined
          limit?: { context: number; input?: number | undefined; output: number } | undefined
          modalities?:
            | {
                input: Array<"text" | "audio" | "image" | "video" | "pdf">
                output: Array<"text" | "audio" | "image" | "video" | "pdf">
              }
            | undefined
          experimental?: boolean | undefined
          status?: "alpha" | "beta" | "deprecated" | undefined
          options?: { [x: string]: any } | undefined
          headers?: { [x: string]: string } | undefined
          provider?: { npm: string; api: string } | undefined
          reasoning_options?:
            | Array<
                | { type: "effort"; values: Array<string | null> }
                | { type: "toggle" }
                | { type: "budget_tokens"; min?: number | undefined; max?: number | undefined }
              >
            | undefined
          variants?: { [x: string]: { disabled?: boolean | undefined } & { [x: string]: any | undefined } } | undefined
          disabled?: boolean | undefined
        }
      }
    | undefined
  auth_provider?: string | undefined
  whitelist?: Array<string> | undefined
  blacklist?: Array<string> | undefined
  options?:
    | ({
        apiKey?: string | undefined
        baseURL?: string | undefined
        enterpriseUrl?: string | undefined
        setCacheKey?: boolean | undefined
        timeout?: number | false | undefined
        headerTimeout?: number | false | undefined
        chunkTimeout?: number | undefined
      } & { [x: string]: any | undefined })
    | undefined
}

export type McpLocalConfig = {
  type: "local"
  command: Array<string>
  environment?: { [x: string]: string } | undefined
  enabled?: boolean | undefined
  timeout?: number | undefined
}

export type McpOAuthConfig = {
  clientId?: string | undefined
  clientSecret?: string | undefined
  scope?: string | undefined
}

export type ConnectorFigma = { type: "figma"; token?: string | undefined; enabled?: boolean | undefined }

export type ConnectorSlack = {
  type: "slack"
  botToken?: string | undefined
  teamId?: string | undefined
  enabled?: boolean | undefined
}

export type ConnectorGithub = {
  type: "github"
  token?: string | undefined
  oauthClientId?: string | undefined
  clientId?: string | undefined
  enabled?: boolean | undefined
}

export type ConnectorLovable = {
  type: "lovable"
  token?: string | undefined
  apiKey?: string | undefined
  enabled?: boolean | undefined
}

export type ConnectorDiscord = { type: "discord"; botToken?: string | undefined; enabled?: boolean | undefined }

export type ConnectorTeams = { type: "teams"; botToken?: string | undefined; enabled?: boolean | undefined }

export type ConnectorGChat = { type: "gchat"; botToken?: string | undefined; enabled?: boolean | undefined }

export type ConnectorLinear = { type: "linear"; botToken?: string | undefined; enabled?: boolean | undefined }

export type LayoutConfig = "auto" | "stretch"

export type AutoModeConfig = {
  environment?: Array<string> | undefined
  allow?: Array<string> | undefined
  soft_deny?: Array<string> | undefined
  hard_deny?: Array<string> | undefined
  classify_all_shell?: boolean | undefined
  model?: string | undefined
  disable?: boolean | undefined
}

export type PolicyStatementConfig = { effect: "allow" | "deny"; action: string; resource: string }

export type RagConfig = { model?: string | undefined; provider?: string | undefined }

export type ImageConfig = { model?: string | undefined; provider?: string | undefined }

export type ComputerConfig = {
  mode?: "sandbox" | "host" | undefined
  width?: number | undefined
  height?: number | undefined
}

export type AttachmentConfig = {
  image?:
    | {
        auto_resize?: boolean | undefined
        max_width?: number | undefined
        max_height?: number | undefined
        max_base64_bytes?: number | undefined
      }
    | undefined
}

export type SpeakConfig = {
  provider?: string | undefined
  model?: string | undefined
  modelId?: string | undefined
  outputFormat?: string | undefined
}

export type Model = {
  id: string
  providerID: string
  api: { id: string; url?: string; npm: string }
  name: string
  family?: string
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
    interleaved: boolean | { field: "reasoning_content" | "reasoning_details" }
  }
  cost: {
    input: number
    output: number
    cache: { read: number; write: number }
    experimentalOver200K?: { input: number; output: number; cache: { read: number; write: number } }
  }
  limit: { context: number; input?: number; output: number }
  status: "alpha" | "beta" | "deprecated" | "active"
  options: { [x: string]: any }
  headers: { [x: string]: string }
  release_date: string
  variants?: { [x: string]: { [x: string]: any } }
}

export type ConnectorStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }

export type ConnectorsSuccess = { success: true }

export type DoctorCheck = { ok: boolean; label: string; detail?: string | undefined; fix?: string | undefined }

export type ToolIDs = Array<string>

export type ToolListItem = { id: string; description: string; parameters: unknown }

export type Worktree = { name: string; branch?: string | undefined; directory: string }

export type WorktreeList = Array<string>

export type McpResource = {
  name: string
  uri: string
  description?: string | undefined
  mimeType?: string | undefined
  client: string
}

export type ManagedWorktreeInfo = {
  id: string
  parentId: string | null
  name: string
  branch: string
  directory: string
  createdAt: number
}

export type SearchMatch = {
  path: { text: string }
  lines: { text: string }
  line_number: number
  absolute_offset: number
  submatches: Array<{ match: { text: string }; start: number; end: number }>
}

export type Symbol = {
  name: string
  kind: number
  location: {
    uri: string
    range: { start: { line: number; character: number }; end: { line: number; character: number } }
  }
}

export type FileNode = { name: string; path: string; absolute: string; type: "file" | "directory"; ignored: boolean }

export type FileContent = {
  type: "text"
  content: string
  diff?: string | undefined
  patch?:
    | {
        oldFileName: string
        newFileName: string
        oldHeader?: string | undefined
        newHeader?: string | undefined
        hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: Array<string> }>
        index?: string | undefined
      }
    | undefined
  encoding?: "base64" | undefined
  mimeType?: string | undefined
}

export type FileWriteResult = { success: boolean }

export type File = { path: string; added: number; removed: number; status: "added" | "deleted" | "modified" }

export type GlobalHealth = { healthy: true; version: string; revision?: string }

export type MCPStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

export type McpStartAuthResponse = { authorizationUrl: string }

export type McpMutationSuccess = { success: true }

export type MissionFeature = {
  id: string
  name: string
  objective: string
  agent: string
  model?: string
  tokenBudget?: number
  dependsOn: Array<string>
  status: "pending" | "running" | "done" | "blocked" | "skipped" | "error"
  error?: string
}

export type MissionModels = { worker?: string; validation?: string; orchestrator?: string }

export type MissionWorktree = { name: string; branch?: string; directory: string }

export type MissionRuntime = {
  missionID: string
  status: "idle" | "running" | "paused" | "error" | "cancelling"
  sessionID?: string
  currentMilestoneID?: string
  currentFeatureID?: string
  doneFeatures: number
  totalFeatures: number
  lastError?: string
  lastRunAt?: number
}

export type MissionTemplate = { id: string; title: string; description: string; brief: string }

export type MissionExec = {
  id: string
  missionID: string
  kind: "feature" | "validation"
  targetID: string
  targetName: string
  startedAt: number
  endedAt?: number
  status: "running" | "complete" | "error" | "timeout" | "cancelled" | "orphaned"
  heartbeatAt?: number
  sessionID?: string
  error?: string
  ok: boolean
}

export type MissionBooleanResult = boolean

export type MobileAuthTokenPublic = {
  id: string
  name: string
  createdAt: number
  lastUsedAt?: number | undefined
  expiresAt?: number | undefined
  scope?: string | undefined
}

export type MobileProject = {
  id: string
  worktree: string
  canonical: string
  vcs?: "git" | undefined
  name?: string | undefined
  icon?: { url?: string | undefined; override?: string | undefined; color?: string | undefined } | undefined
  commands?: { start?: string | undefined } | undefined
  time: { created: number; updated: number; initialized?: number | undefined }
  sandboxes: Array<string>
  current: boolean
}

export type MobileCommand = {
  name: string
  description?: string | undefined
  agent?: string | undefined
  model?: string | undefined
  mcp?: boolean | undefined
  skill?: boolean | undefined
  subtask?: boolean | undefined
  hints: Array<string>
}

export type MobilePromptHistoryEntry = {
  id: string
  input: string
  mode?: "normal" | "shell" | undefined
  partsCount: number
}

export type MobileMemorySearchHit = {
  id: string
  sessionID: string
  sessionTitle: string
  messageID: string
  role: "user" | "assistant"
  createdAt: number
  preview: string
}

export type MobilePromptStashEntry = { id: string; input: string; timestamp: number; partsCount: number }

export type MobileSuccess = { success: true }

export type MobileGithubBranch = { name: string; protected?: boolean | undefined; commit: { sha: string } }

export type MobileGithubWorkflow = {
  id: number
  name: string
  path: string
  state: string
  htmlUrl?: string | undefined
}

export type MobileGithubWorkflowRun = {
  id: number
  name: string
  workflowID?: number | undefined
  runNumber: number
  attempt?: number | undefined
  status: string
  conclusion?: string | undefined
  event: string
  branch: string
  sha: string
  title: string
  actor?: { login: string; avatarUrl?: string | undefined } | undefined
  htmlUrl: string
  createdAt: number
  updatedAt: number
  startedAt?: number | undefined
  durationMs?: number | undefined
}

export type MobileGithubWorkflowStep = {
  name: string
  number: number
  status: string
  conclusion?: string | undefined
  startedAt?: number | undefined
  completedAt?: number | undefined
}

export type MobileGithubImport = {
  owner: string
  repo: string
  fullName: string
  directory: string
  cloneUrl: string
  defaultBranch: string
  private: boolean
  importedAt: number
  updatedAt: number
  projectID?: string | undefined
}

export type KeybindsConfig1 = {
  leader?: string | undefined
  app_exit?: string | undefined
  editor_open?: string | undefined
  theme_list?: string | undefined
  sidebar_toggle?: string | undefined
  scrollbar_toggle?: string | undefined
  username_toggle?: string | undefined
  status_view?: string | undefined
  sync_view?: string | undefined
  session_export?: string | undefined
  session_new?: string | undefined
  session_list?: string | undefined
  session_timeline?: string | undefined
  session_fork?: string | undefined
  session_rename?: string | undefined
  session_delete?: string | undefined
  session_pin_toggle?: string | undefined
  session_scope_toggle?: string | undefined
  session_tab_back?: string | undefined
  session_tab_forward?: string | undefined
  session_quick_switch_1?: string | undefined
  session_quick_switch_2?: string | undefined
  session_quick_switch_3?: string | undefined
  session_quick_switch_4?: string | undefined
  session_quick_switch_5?: string | undefined
  session_quick_switch_6?: string | undefined
  session_quick_switch_7?: string | undefined
  session_quick_switch_8?: string | undefined
  session_quick_switch_9?: string | undefined
  stash_delete?: string | undefined
  model_provider_list?: string | undefined
  model_favorite_toggle?: string | undefined
  session_share?: string | undefined
  session_unshare?: string | undefined
  session_interrupt?: string | undefined
  session_codebro_open?: string | undefined
  subtask_background?: string | undefined
  subtask_picker?: string | undefined
  session_compact?: string | undefined
  messages_page_up?: string | undefined
  messages_page_down?: string | undefined
  messages_line_up?: string | undefined
  messages_line_down?: string | undefined
  messages_half_page_up?: string | undefined
  messages_half_page_down?: string | undefined
  messages_first?: string | undefined
  messages_last?: string | undefined
  messages_next?: string | undefined
  messages_previous?: string | undefined
  messages_last_user?: string | undefined
  messages_copy?: string | undefined
  messages_undo?: string | undefined
  messages_redo?: string | undefined
  messages_toggle_conceal?: string | undefined
  tool_details?: string | undefined
  model_list?: string | undefined
  model_cycle_recent?: string | undefined
  model_cycle_recent_reverse?: string | undefined
  model_cycle_favorite?: string | undefined
  model_cycle_favorite_reverse?: string | undefined
  command_list?: string | undefined
  agent_list?: string | undefined
  agent_cycle?: string | undefined
  agent_cycle_reverse?: string | undefined
  permission_mode?: string | undefined
  variant_cycle?: string | undefined
  input_clear?: string | undefined
  input_paste?: string | undefined
  input_submit?: string | undefined
  input_newline?: string | undefined
  input_move_left?: string | undefined
  input_move_right?: string | undefined
  input_move_up?: string | undefined
  input_move_down?: string | undefined
  input_select_left?: string | undefined
  input_select_right?: string | undefined
  input_select_up?: string | undefined
  input_select_down?: string | undefined
  input_line_home?: string | undefined
  input_line_end?: string | undefined
  input_select_line_home?: string | undefined
  input_select_line_end?: string | undefined
  input_visual_line_home?: string | undefined
  input_visual_line_end?: string | undefined
  input_select_visual_line_home?: string | undefined
  input_select_visual_line_end?: string | undefined
  input_buffer_home?: string | undefined
  input_buffer_end?: string | undefined
  input_select_buffer_home?: string | undefined
  input_select_buffer_end?: string | undefined
  input_delete_line?: string | undefined
  input_delete_to_line_end?: string | undefined
  input_delete_to_line_start?: string | undefined
  input_backspace?: string | undefined
  input_delete?: string | undefined
  input_undo?: string | undefined
  input_redo?: string | undefined
  input_word_forward?: string | undefined
  input_word_backward?: string | undefined
  input_select_word_forward?: string | undefined
  input_select_word_backward?: string | undefined
  input_delete_word_forward?: string | undefined
  input_delete_word_backward?: string | undefined
  history_previous?: string | undefined
  history_next?: string | undefined
  session_child_cycle?: string | undefined
  session_child_cycle_reverse?: string | undefined
  session_parent?: string | undefined
  session_child_close?: string | undefined
  terminal_suspend?: string | undefined
  terminal_title_toggle?: string | undefined
  tips_toggle?: string | undefined
  voice_record?: string | undefined
  app_support?: string | undefined
}

export type LogLevel1 = "DEBUG" | "INFO" | "WARN" | "ERROR"

export type AdsItemConfig1 = { id: string; text: string; url?: string | undefined; enabled?: boolean | undefined }

export type ServerConfig1 = {
  port?: number | undefined
  hostname?: string | undefined
  mdns?: boolean | undefined
  cors?: Array<string> | undefined
}

export type RemoteConfig1 = {
  enabled?: boolean | undefined
  enableTunnel?: boolean | undefined
  provider?: "localtunnel" | "cloudflared" | "ngrok" | "remotosh" | "none" | undefined
  askOnExistingSession?: boolean | undefined
}

export type TeleportConfig1 = { url?: string | undefined; token?: string | undefined }

export type ReferenceConfig1 =
  | { type: "git"; repository: string; branch?: string | undefined; description?: string | undefined }
  | { type: "local"; path: string; description?: string | undefined }

export type PermissionModeConfig1 = "default" | "auto"

export type ProviderConfig1 = {
  api?: string | undefined
  name?: string | undefined
  env?: Array<string> | undefined
  id?: string | undefined
  npm?: string | undefined
  models?:
    | {
        [x: string]: {
          id?: string | undefined
          name?: string | undefined
          family?: string | undefined
          release_date?: string | undefined
          attachment?: boolean | undefined
          reasoning?: boolean | undefined
          temperature?: boolean | undefined
          tool_call?: boolean | undefined
          interleaved?: true | { field: "reasoning_content" | "reasoning_details" } | undefined
          cost?:
            | {
                input: number
                output: number
                cache_read?: number | undefined
                cache_write?: number | undefined
                context_over_200k?:
                  | { input: number; output: number; cache_read?: number | undefined; cache_write?: number | undefined }
                  | undefined
              }
            | undefined
          limit?: { context: number; input?: number | undefined; output: number } | undefined
          modalities?:
            | {
                input: Array<"text" | "audio" | "image" | "video" | "pdf">
                output: Array<"text" | "audio" | "image" | "video" | "pdf">
              }
            | undefined
          experimental?: boolean | undefined
          status?: "alpha" | "beta" | "deprecated" | undefined
          options?: { [x: string]: any } | undefined
          headers?: { [x: string]: string } | undefined
          provider?: { npm: string; api: string } | undefined
          reasoning_options?:
            | Array<
                | { type: "effort"; values: Array<string | null> }
                | { type: "toggle" }
                | { type: "budget_tokens"; min?: number | undefined; max?: number | undefined }
              >
            | undefined
          variants?: { [x: string]: { disabled?: boolean | undefined } & { [x: string]: any | undefined } } | undefined
          disabled?: boolean | undefined
        }
      }
    | undefined
  auth_provider?: string | undefined
  whitelist?: Array<string> | undefined
  blacklist?: Array<string> | undefined
  options?:
    | ({
        apiKey?: string | undefined
        baseURL?: string | undefined
        enterpriseUrl?: string | undefined
        setCacheKey?: boolean | undefined
        timeout?: number | false | undefined
        headerTimeout?: number | false | undefined
        chunkTimeout?: number | undefined
      } & { [x: string]: any | undefined })
    | undefined
}

export type McpLocalConfig1 = {
  type: "local"
  command: Array<string>
  environment?: { [x: string]: string } | undefined
  enabled?: boolean | undefined
  timeout?: number | undefined
}

export type McpOAuthConfig1 = {
  clientId?: string | undefined
  clientSecret?: string | undefined
  scope?: string | undefined
}

export type ConnectorFigma1 = { type: "figma"; token?: string | undefined; enabled?: boolean | undefined }

export type ConnectorSlack1 = {
  type: "slack"
  botToken?: string | undefined
  teamId?: string | undefined
  enabled?: boolean | undefined
}

export type ConnectorGithub1 = {
  type: "github"
  token?: string | undefined
  oauthClientId?: string | undefined
  clientId?: string | undefined
  enabled?: boolean | undefined
}

export type ConnectorLovable1 = {
  type: "lovable"
  token?: string | undefined
  apiKey?: string | undefined
  enabled?: boolean | undefined
}

export type ConnectorDiscord1 = { type: "discord"; botToken?: string | undefined; enabled?: boolean | undefined }

export type ConnectorTeams1 = { type: "teams"; botToken?: string | undefined; enabled?: boolean | undefined }

export type ConnectorGChat1 = { type: "gchat"; botToken?: string | undefined; enabled?: boolean | undefined }

export type ConnectorLinear1 = { type: "linear"; botToken?: string | undefined; enabled?: boolean | undefined }

export type LayoutConfig1 = "auto" | "stretch"

export type AutoModeConfig1 = {
  environment?: Array<string> | undefined
  allow?: Array<string> | undefined
  soft_deny?: Array<string> | undefined
  hard_deny?: Array<string> | undefined
  classify_all_shell?: boolean | undefined
  model?: string | undefined
  disable?: boolean | undefined
}

export type PolicyStatementConfig1 = { effect: "allow" | "deny"; action: string; resource: string }

export type RagConfig1 = { model?: string | undefined; provider?: string | undefined }

export type ImageConfig1 = { model?: string | undefined; provider?: string | undefined }

export type ComputerConfig1 = {
  mode?: "sandbox" | "host" | undefined
  width?: number | undefined
  height?: number | undefined
}

export type AttachmentConfig1 = {
  image?:
    | {
        auto_resize?: boolean | undefined
        max_width?: number | undefined
        max_height?: number | undefined
        max_base64_bytes?: number | undefined
      }
    | undefined
}

export type SpeakConfig1 = {
  provider?: string | undefined
  model?: string | undefined
  modelId?: string | undefined
  outputFormat?: string | undefined
}

export type MobileGithubDeviceAuthStart = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string | undefined
  expiresAt: number
  interval: number
}

export type MobileGithubDeviceAuthPollResult = {
  status: "pending" | "approved" | "denied" | "expired"
  interval?: number | undefined
  user?: { login: string; name?: string | null | undefined; avatar_url?: string | undefined } | undefined
}

export type Project = {
  id: string
  worktree: string
  canonical: string
  vcs?: "git" | undefined
  name?: string | undefined
  icon?: { url?: string | undefined; override?: string | undefined; color?: string | undefined } | undefined
  commands?: { start?: string | undefined } | undefined
  time: { created: number; updated: number; initialized?: number | undefined }
  sandboxes: Array<string>
}

export type FileDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified" | undefined
  before: string
  after: string
}

export type SessionWorktree = {
  name: string
  branch: string
  directory: string
  repositoryDirectory?: string | undefined
  cleanedAt?: number | undefined
}

export type SessionWorktree1 = {
  name: string
  branch: string
  directory: string
  repositoryDirectory?: string | undefined
  cleanedAt?: number | undefined
}

export type SessionMobile = {
  platforms: Array<"ios" | "android" | "expo" | "flutter" | "react-native">
  primaryPlatform: string
  method: string
  detectedAt: number
  buildStatus?: "unknown" | "building" | "succeeded" | "failed" | undefined
  lastBuildAt?: number | undefined
  artifacts?:
    | Array<{ platform: string; path: string; size?: number | undefined; createdAt?: number | undefined }>
    | undefined
}

export type PermissionAction = "allow" | "deny" | "ask"

export type Worktree1 = { name: string; branch?: string | undefined; directory: string }

export type Project1 = {
  id: string
  worktree: string
  canonical: string
  vcs?: "git" | undefined
  name?: string | undefined
  icon?: { url?: string | undefined; override?: string | undefined; color?: string | undefined } | undefined
  commands?: { start?: string | undefined } | undefined
  time: { created: number; updated: number; initialized?: number | undefined }
  sandboxes: Array<string>
}

export type Workspace = {
  id: string
  name: string
  timeUsed: number
  branch: string | null
  projectID: string
  config:
    | {
        directory: string
        type: "worktree"
        name?: string | undefined
        strategy?: "git" | "cow" | undefined
        eventLimit?: number | undefined
      }
    | {
        directory: string
        type: "container"
        runtime: "docker" | "podman"
        image: string
        containerName: string
        port: number
        serverUrl: string
        eventLimit?: number | undefined
      }
    | { directory: string; type: "branch"; branch?: string | undefined; eventLimit?: number | undefined }
}

export type FileDiff1 = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified" | undefined
  before: string
  after: string
}

export type SessionWorktree2 = {
  name: string
  branch: string
  directory: string
  repositoryDirectory?: string | undefined
  cleanedAt?: number | undefined
}

export type SessionWorktree3 = {
  name: string
  branch: string
  directory: string
  repositoryDirectory?: string | undefined
  cleanedAt?: number | undefined
}

export type SessionMobile1 = {
  platforms: Array<"ios" | "android" | "expo" | "flutter" | "react-native">
  primaryPlatform: string
  method: string
  detectedAt: number
  buildStatus?: "unknown" | "building" | "succeeded" | "failed" | undefined
  lastBuildAt?: number | undefined
  artifacts?:
    | Array<{ platform: string; path: string; size?: number | undefined; createdAt?: number | undefined }>
    | undefined
}

export type PermissionAction1 = "allow" | "deny" | "ask"

export type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy"; since: number }
  | { type: "busy" }

export type FileDiff2 = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified" | undefined
  before: string
  after: string
}

export type SessionWorktree4 = {
  name: string
  branch: string
  directory: string
  repositoryDirectory?: string
  cleanedAt?: number
}

export type SessionWorktree5 = {
  name: string
  branch: string
  directory: string
  repositoryDirectory?: string
  cleanedAt?: number
}

export type SessionMobile2 = {
  platforms: Array<"ios" | "android" | "expo" | "flutter" | "react-native">
  primaryPlatform: string
  method: string
  detectedAt: number
  buildStatus?: "unknown" | "building" | "succeeded" | "failed"
  lastBuildAt?: number
  artifacts?: Array<{ platform: string; path: string; size?: number; createdAt?: number }>
}

export type PermissionAction2 = "allow" | "deny" | "ask"

export type FileDiff3 = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified" | undefined
  before: string
  after: string
}

export type SessionWorktree6 = {
  name: string
  branch: string
  directory: string
  repositoryDirectory?: string | undefined
  cleanedAt?: number | undefined
}

export type SessionWorktree7 = {
  name: string
  branch: string
  directory: string
  repositoryDirectory?: string | undefined
  cleanedAt?: number | undefined
}

export type SessionMobile3 = {
  platforms: Array<"ios" | "android" | "expo" | "flutter" | "react-native">
  primaryPlatform: string
  method: string
  detectedAt: number
  buildStatus?: "unknown" | "building" | "succeeded" | "failed" | undefined
  lastBuildAt?: number | undefined
  artifacts?:
    | Array<{ platform: string; path: string; size?: number | undefined; createdAt?: number | undefined }>
    | undefined
}

export type PermissionAction3 = "allow" | "deny" | "ask"

export type SessionStatus1 =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy"; since: number }
  | { type: "busy" }

export type OutputFormatText = { type: "text" }

export type JSONSchema = { [x: string]: any }

export type FileDiff4 = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified" | undefined
  before: string
  after: string
}

export type ProviderAuthError = { name: "ProviderAuthError"; data: { providerID: string; message: string } }

export type UnknownError = { name: "UnknownError"; data: { message: string } }

export type MessageOutputLengthError = { name: "MessageOutputLengthError"; data: {} }

export type MessageContextOverflowError = {
  name: "MessageContextOverflowError"
  data: { message: string; statusCode?: number | undefined; responseBody?: string | undefined }
}

export type MessageAbortedError = { name: "MessageAbortedError"; data: { message: string } }

export type StructuredOutputError = { name: "StructuredOutputError"; data: { message: string; retries: number } }

export type APIError = {
  name: "APIError"
  data: {
    message: string
    statusCode?: number | undefined
    isRetryable: boolean
    responseHeaders?: { [x: string]: string } | undefined
    responseBody?: string | undefined
    metadata?: { [x: string]: string } | undefined
    classification?: "payload-too-large" | undefined
  }
}

export type TextPart = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean | undefined
  ignored?: boolean | undefined
  time?: { start: number; end?: number | undefined } | undefined
  metadata?: { [x: string]: any } | undefined
}

export type SubtaskPart = {
  id: string
  sessionID: string
  messageID: string
  type: "subtask"
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string } | undefined
  command?: string | undefined
  background?: boolean | undefined
}

export type ReasoningPart = {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  metadata?: { [x: string]: any } | undefined
  time: { start: number; end?: number | undefined }
}

export type FilePartSourceText = { value: string; start: number; end: number }

export type FilePartSourceText1 = { value: string; start: number; end: number }

export type Range = { start: { line: number; character: number }; end: { line: number; character: number } }

export type FilePartSourceText2 = { value: string; start: number; end: number }

export type ToolStatePending = { status: "pending"; input: { [x: string]: any }; raw: string }

export type ToolStateRunning = {
  status: "running"
  input: { [x: string]: any }
  title?: string | undefined
  metadata?: { [x: string]: any } | undefined
  structured?: { [x: string]: any } | undefined
  content?:
    | Array<{ type: "text"; text: string } | { type: "file"; data: string; mime: string; name?: string | undefined }>
    | undefined
  time: { start: number }
}

export type FilePartSourceText3 = { value: string; start: number; end: number }

export type FilePartSourceText4 = { value: string; start: number; end: number }

export type Range1 = { start: { line: number; character: number }; end: { line: number; character: number } }

export type FilePartSourceText5 = { value: string; start: number; end: number }

export type ToolStateError = {
  status: "error"
  input: { [x: string]: any }
  error: string
  metadata?: { [x: string]: any } | undefined
  time: { start: number; end: number }
}

export type StepStartPart = {
  id: string
  sessionID: string
  messageID: string
  type: "step-start"
  snapshot?: string | undefined
}

export type StepFinishPart = {
  id: string
  sessionID: string
  messageID: string
  type: "step-finish"
  reason: string
  snapshot?: string | undefined
  cost: number
  tokens: {
    total?: number | undefined
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export type SnapshotPart = { id: string; sessionID: string; messageID: string; type: "snapshot"; snapshot: string }

export type PatchPart = {
  id: string
  sessionID: string
  messageID: string
  type: "patch"
  hash: string
  files: Array<string>
}

export type AgentPart = {
  id: string
  sessionID: string
  messageID: string
  type: "agent"
  name: string
  source?: { value: string; start: number; end: number } | undefined
}

export type APIError1 = {
  name: "APIError"
  data: {
    message: string
    statusCode?: number | undefined
    isRetryable: boolean
    responseHeaders?: { [x: string]: string } | undefined
    responseBody?: string | undefined
    metadata?: { [x: string]: string } | undefined
    classification?: "payload-too-large" | undefined
  }
}

export type CompactionPart = { id: string; sessionID: string; messageID: string; type: "compaction"; auto: boolean }

export type MobileArtifact = {
  id: string
  title: string
  description?: string | undefined
  filename: string
  contentType: string
  kind: "html" | "markdown" | "image" | "video" | "text"
  url: string
  viewerUrl: string
  previewUrl: string
  version: number
  sessionID: string
  size: number
  time: { created: number; updated: number }
}

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: Array<string>
  metadata: { [x: string]: any }
  always: Array<string>
  tool?: { messageID: string; callID: string } | undefined
}

export type QuestionOption = { label: string; description: string }

export type OutputFormatText1 = { type: "text" }

export type JSONSchema1 = { [x: string]: any }

export type ProviderAuthError1 = { name: "ProviderAuthError"; data: { providerID: string; message: string } }

export type UnknownError1 = { name: "UnknownError"; data: { message: string } }

export type MessageOutputLengthError1 = { name: "MessageOutputLengthError"; data: {} }

export type MessageContextOverflowError1 = {
  name: "MessageContextOverflowError"
  data: { message: string; statusCode?: number; responseBody?: string }
}

export type MessageAbortedError1 = { name: "MessageAbortedError"; data: { message: string } }

export type StructuredOutputError1 = { name: "StructuredOutputError"; data: { message: string; retries: number } }

export type APIError2 = {
  name: "APIError"
  data: {
    message: string
    statusCode?: number
    isRetryable: boolean
    responseHeaders?: { [x: string]: string }
    responseBody?: string
    metadata?: { [x: string]: string }
    classification?: "payload-too-large"
  }
}

export type TextPart1 = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: { [x: string]: any }
}

export type SubtaskPart1 = {
  id: string
  sessionID: string
  messageID: string
  type: "subtask"
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
  background?: boolean
}

export type ReasoningPart1 = {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  metadata?: { [x: string]: any }
  time: { start: number; end?: number }
}

export type FilePartSourceText6 = { value: string; start: number; end: number }

export type Range2 = { start: { line: number; character: number }; end: { line: number; character: number } }

export type ToolStatePending1 = { status: "pending"; input: { [x: string]: any }; raw: string }

export type ToolStateRunning1 = {
  status: "running"
  input: { [x: string]: any }
  title?: string
  metadata?: { [x: string]: any }
  structured?: { [x: string]: any }
  content?: Array<{ type: "text"; text: string } | { type: "file"; data: string; mime: string; name?: string }>
  time: { start: number }
}

export type ToolStateError1 = {
  status: "error"
  input: { [x: string]: any }
  error: string
  metadata?: { [x: string]: any }
  time: { start: number; end: number }
}

export type StepStartPart1 = { id: string; sessionID: string; messageID: string; type: "step-start"; snapshot?: string }

export type StepFinishPart1 = {
  id: string
  sessionID: string
  messageID: string
  type: "step-finish"
  reason: string
  snapshot?: string
  cost: number
  tokens: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

export type SnapshotPart1 = { id: string; sessionID: string; messageID: string; type: "snapshot"; snapshot: string }

export type PatchPart1 = {
  id: string
  sessionID: string
  messageID: string
  type: "patch"
  hash: string
  files: Array<string>
}

export type AgentPart1 = {
  id: string
  sessionID: string
  messageID: string
  type: "agent"
  name: string
  source?: { value: string; start: number; end: number }
}

export type CompactionPart1 = { id: string; sessionID: string; messageID: string; type: "compaction"; auto: boolean }

export type MobileAccepted = { accepted: true }

export type MobileGithubPublishResult = {
  commitSha: string
  branch: string
  pullRequest: { number: number; url: string; title: string }
}

export type Todo = { content: string; status: string; priority: string; id: string }

export type MobileTeleportResult = {
  sessionID: string
  title?: string | undefined
  messageCount: number
  directory?: string | undefined
  workspace: boolean
}

export type Worktree2 = { name: string; branch?: string | undefined; directory: string }

export type MobileGitChange = {
  status: "added" | "modified" | "deleted" | "renamed"
  path: string
  additions?: number | undefined
  deletions?: number | undefined
  oldPath?: string | undefined
}

export type MobileGitFileDiff = {
  file: string
  oldPath?: string | undefined
  hunks: Array<{
    header: { oldStart: number; oldLines: number; newStart: number; newLines: number }
    lines: Array<{
      type: "add" | "remove" | "context"
      text: string
      oldLineNumber?: number | undefined
      newLineNumber?: number | undefined
    }>
  }>
  isBinary: boolean
  additions: number
  deletions: number
}

export type MobileGitCommit = {
  sha: string
  message: string
  author: { name: string; email: string }
  timestamp: number
  filesCount: number
  additions: number
  deletions: number
}

export type MobileGitBranch = {
  name: string
  isCurrent: boolean
  isProtected: boolean
  aheadBy: number
  behindBy: number
}

export type LoopStage = { name: string; agent: string; model?: string; objective: string; tokenBudget?: number }

export type LoopTrigger = { kind: "manual" } | { kind: "interval"; everyMs: number }

export type LoopWorktree = { name: string; branch?: string; directory: string }

export type MobileLoopRuntime = {
  loopID: string
  status: "idle" | "running" | "paused" | "error" | "cancelling"
  runs: number
  lastRunAt?: number | undefined
  lastError?: string | undefined
  sessionID?: string | undefined
}

export type MobileLoopTemplate = {
  id: string
  title: string
  description: string
  draft: {
    name?: string | undefined
    stages: Array<{
      name?: string | undefined
      agent?: string | undefined
      model?: string | undefined
      objective: string
      tokenBudget?: number | undefined
    }>
    intervalMs?: number | undefined
    maxRuns?: number | undefined
  }
}

export type MobileLoopRun = {
  id: string
  loopID: string
  startedAt: number
  endedAt?: number | undefined
  status: "running" | "complete" | "error" | "timeout" | "cancelled" | "orphaned"
  heartbeatAt?: number | undefined
  sessionID?: string | undefined
  error?: string | undefined
  ok: boolean
  pullRequest?:
    | {
        number: number
        url: string
        branch: string
        base: string
        title?: string | undefined
        action: "created" | "updated"
      }
    | undefined
}

export type RoutineTriggerSchedule = { type: "schedule"; cron: string; enabled: boolean }

export type RoutineTriggerApi = { type: "api"; token: string; enabled: boolean }

export type Pty = {
  id: string
  title: string
  command: string
  args: Array<string>
  cwd: string
  status: "running" | "exited"
  pid: number
}

export type MobileMissionDefinition = {
  id: string
  name: string
  brief: string
  milestones: Array<{
    id: string
    name: string
    features: Array<{
      id: string
      name: string
      objective: string
      agent: string
      model?: string | undefined
      tokenBudget?: number | undefined
      dependsOn?: Array<string> | undefined
      status?: "pending" | "running" | "done" | "blocked" | "skipped" | "error" | undefined
      error?: string | undefined
    }>
    validation?: "scrutiny" | "user-test" | "none" | undefined
    status?: "pending" | "running" | "validating" | "done" | "blocked" | undefined
  }>
  models?:
    | { worker?: string | undefined; validation?: string | undefined; orchestrator?: string | undefined }
    | undefined
  timeoutMs?: number | undefined
  sandbox?: boolean | undefined
  worktree?: { name: string; branch?: string | undefined; directory: string } | undefined
  status?: "planning" | "ready" | "running" | "paused" | "frozen" | "complete" | "error" | undefined
  createdAt: number
}

export type MobileMissionRuntime = {
  missionID: string
  status: "idle" | "running" | "paused" | "error" | "cancelling"
  sessionID?: string | undefined
  currentMilestoneID?: string | undefined
  currentFeatureID?: string | undefined
  doneFeatures: number
  totalFeatures: number
  lastError?: string | undefined
  lastRunAt?: number | undefined
}

export type MobileMissionTemplate = { id: string; title: string; description: string; brief: string }

export type MobileMissionExec = {
  id: string
  missionID: string
  kind: "feature" | "validation"
  targetID: string
  targetName: string
  startedAt: number
  endedAt?: number | undefined
  status: "running" | "complete" | "error" | "timeout" | "cancelled" | "orphaned"
  heartbeatAt?: number | undefined
  sessionID?: string | undefined
  error?: string | undefined
  ok: boolean
}

export type MobileHostLan = {
  listening: boolean
  url?: string | undefined
  hostname?: string | undefined
  port?: number | undefined
}

export type Project2 = {
  id: string
  worktree: string
  canonical: string
  vcs?: "git" | undefined
  name?: string | undefined
  icon?: { url?: string | undefined; override?: string | undefined; color?: string | undefined } | undefined
  commands?: { start?: string | undefined } | undefined
  time: { created: number; updated: number; initialized?: number | undefined }
  sandboxes: Array<string>
}

export type ProjectDirectory = { directory: string; strategy?: string | undefined }

export type ProjectCopy = { directory: string }

export type ProjectCopyRefresh = { updated: Array<string>; removed: Array<string> }

export type ProviderAuthMethod = { type: "oauth" | "api"; label: string }

export type ProviderMutationSuccess = { success: true }

export type ProviderOAuthAuthorization = { url: string; method: "auto" | "code" | "auto-code"; instructions: string }

export type QuestionOption1 = { label: string; description: string }

export type PermissionRequest1 = {
  id: string
  sessionID: string
  permission: string
  patterns: Array<string>
  metadata: { [x: string]: any }
  always: Array<string>
  tool?: { messageID: string; callID: string } | undefined
}

export type PermissionBlocked = {
  id: string
  sessionID: string
  permission: string
  patterns: Array<string>
  rule: string
  reason: string
  time: number
  tool?: { messageID: string; callID: string } | undefined
}

export type Pty1 = {
  id: string
  title: string
  command: string
  args: Array<string>
  cwd: string
  status: "running" | "exited"
  pid: number
}

export type LoopRuntime = {
  loopID: string
  status: "idle" | "running" | "paused" | "error" | "cancelling"
  runs: number
  lastRunAt?: number
  lastError?: string
  sessionID?: string
}

export type LoopTemplate = {
  id: string
  title: string
  description: string
  draft: {
    name?: string
    stages: Array<{ name?: string; agent?: string; model?: string; objective: string; tokenBudget?: number }>
    intervalMs?: number
    maxRuns?: number
  }
}

export type LoopPullRequestRef = {
  number: number
  url: string
  branch: string
  base: string
  title?: string
  action: "created" | "updated"
}

export type LoopBooleanResult = boolean

export type SessionStatus2 =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy"; since: number }
  | { type: "busy" }

export type BooleanResult = boolean

export type TextPartInput = {
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: { [x: string]: any }
  id?: string | undefined
}

export type AgentPartInput = {
  type: "agent"
  name: string
  source?: { value: string; start: number; end: number }
  id?: string | undefined
}

export type SubtaskPartInput = {
  type: "subtask"
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
  background?: boolean
  id?: string | undefined
}

export type SessionV2EntryList = Array<unknown>

export type SessionV2State = unknown

export type SessionV2EventList = Array<unknown>

export type SessionInstructionList = Array<{ path: string; name: string }>

export type SessionContextSource = {
  id: string
  category: "system" | "instructions" | "skills" | "mcp" | "tools" | "agents" | "messages"
  label: string
  detail?: string
  tokens: number
  enabled: boolean
  togglable: boolean
  toggleKind?: "mcp" | "skill" | "instruction" | "tool"
  toggleKey?: string
}

export type SessionGoalState = {
  sessionID: string
  goalID: string
  objective: string
  status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete"
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  iterationCount: number
  timeCreated: number
  timeUpdated: number
}

export type DelegationJob = {
  jobID: string
  rootDelegationID: string
  parentSessionID: string
  title: string
  agent: string
  parentAgent?: string
  status: "running" | "complete" | "error" | "timeout" | "cancelled" | "orphaned" | "synthesizing"
  source?:
    | "task"
    | "model-subtask"
    | "advisor"
    | "research"
    | "ultrareview"
    | "delegator"
    | "delegator-followup"
    | "loop"
    | "other"
  workerSessionID?: string
  delegatorID?: string
  delegatorSessionID?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
  lastActivityAt?: number
  progressSummary?: string
  resultSummary?: string
  error?: string
}

export type SessionMonitorOutput2 = {
  id: string
  sessionID: string
  messageID: string
  callID: string
  partID?: string
  title: string
  command: string
  cwd: string
  agent: string
  wake: boolean
  timeoutMs?: number | "Infinity" | "-Infinity" | "NaN"
  status: "running" | "complete" | "error" | "timeout" | "cancelled"
  pid?: number | "Infinity" | "-Infinity" | "NaN"
  exitCode?: number | "Infinity" | "-Infinity" | "NaN"
  signal?: string
  logPath: string
  commandPath: string
  pidPath: string
  exitCodePath: string
  preview?: string | null | null
  bytes?: number | "Infinity" | "-Infinity" | "NaN" | null | null
  time: {
    created: number | "Infinity" | "-Infinity" | "NaN"
    updated: number | "Infinity" | "-Infinity" | "NaN"
    completed?: number | "Infinity" | "-Infinity" | "NaN"
  }
} | null

export type SessionMonitorLogOutput2 = {
  record: {
    id: string
    sessionID: string
    messageID: string
    callID: string
    partID?: string
    title: string
    command: string
    cwd: string
    agent: string
    wake: boolean
    timeoutMs?: number | "Infinity" | "-Infinity" | "NaN"
    status: "running" | "complete" | "error" | "timeout" | "cancelled"
    pid?: number | "Infinity" | "-Infinity" | "NaN"
    exitCode?: number | "Infinity" | "-Infinity" | "NaN"
    signal?: string
    logPath: string
    commandPath: string
    pidPath: string
    exitCodePath: string
    preview?: string | null | null
    bytes?: number | "Infinity" | "-Infinity" | "NaN" | null | null
    time: {
      created: number | "Infinity" | "-Infinity" | "NaN"
      updated: number | "Infinity" | "-Infinity" | "NaN"
      completed?: number | "Infinity" | "-Infinity" | "NaN"
    }
  }
  output: string
  truncated: boolean
} | null

export type AccountResponse = unknown

export type SyncOutboxResponse = { events: Array<unknown>; hasMore: boolean }

export type SyncSnapshotResponse = { lastSeq: number; state: unknown }

export type SyncStatsEvent = {
  id: string
  projectId: string
  workspaceId?: string | undefined
  aggregate: string
  seq: number
  type: string
  timestamp: number
  origin: string
  dataPreview: unknown
}

export type SyncConfigSetResponse = {
  configured: boolean
  url?: string | undefined
  source?: "env" | "config" | undefined
  started: boolean
  error?: string | undefined
}

export type TuiBooleanResult = boolean

export type PluginOptionsConfig = { [x: string]: any }

export type TuiControlRequest = { path: string; body: unknown }

export type WorkspaceAdaptorInfo = { type: string; name: string; description: string; available?: boolean | undefined }

export type WorkspaceConnectionStatus = {
  workspaceID: string
  status: "connected" | "connecting" | "disconnected" | "error"
}

export type WorkspaceConfig =
  | { type: "worktree"; directory: string; strategy?: "git" | "cow" | undefined; eventLimit?: number | undefined }
  | {
      type: "container"
      directory: string
      runtime: "docker" | "podman"
      image: string
      containerName: string
      port: number
      serverUrl: string
      eventLimit?: number | undefined
    }
  | { type: "branch"; directory: string; branch?: string | undefined; eventLimit?: number | undefined }

export type WorkspaceRestore = { workspaceID: string; sessions: Array<string>; events: Array<unknown> }

export type WorkspaceSessionRestore = {
  workspaceID: string
  sessionID: string
  sessions: Array<string>
  events: Array<unknown>
}

export type ConfigReloadResponse = { reloaded: boolean; directory: string }

export type SuccessFlag = { success: boolean }

export type ConfigProfileInfo = { mcpCount: number; plugins: Array<string>; providerCount: number }

export type Project3 = {
  id: string
  worktree: string
  canonical: string
  vcs?: "git" | undefined
  name?: string | undefined
  icon?: { url?: string | undefined; override?: string | undefined; color?: string | undefined } | undefined
  commands?: { start?: string | undefined } | undefined
  time: { created: number; updated: number; initialized?: number | undefined }
  sandboxes: Array<string>
}

export type EventTelemetryRecord = {
  type: "telemetry.record"
  properties: {
    id: string
    traceId: string
    parentId?: string | undefined
    name: string
    kind: string
    startTime: number
    durationMs: number
    statusCode?: number | undefined
    statusMessage?: string | undefined
    attributes?: { [x: string]: string } | undefined
  }
}

export type EventServerInstanceDisposed = { type: "server.instance.disposed"; properties: { directory: string } }

export type PermissionRequest2 = {
  id: string
  sessionID: string
  permission: string
  patterns: Array<string>
  metadata: { [x: string]: any }
  always: Array<string>
  tool?: { messageID: string; callID: string } | undefined
}

export type EventPermissionReplied = {
  type: "permission.replied"
  properties: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" }
}

export type PermissionBlocked1 = {
  id: string
  sessionID: string
  permission: string
  patterns: Array<string>
  rule: string
  reason: string
  time: number
  tool?: { messageID: string; callID: string } | undefined
}

export type QuestionOption2 = { label: string; description: string }

export type QuestionAnswer = Array<string>

export type EventQuestionRejected = { type: "question.rejected"; properties: { sessionID: string; requestID: string } }

export type EventInstallationUpdated = { type: "installation.updated"; properties: { version: string } }

export type EventInstallationUpdateAvailable = {
  type: "installation.update-available"
  properties: {
    version: string
    method?: "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown" | undefined
    current?: string | undefined
  }
}

export type EventServerConnected = { type: "server.connected"; properties: {} }

export type EventGlobalDisposed = { type: "global.disposed"; properties: {} }

export type EventLspUpdated = { type: "lsp.updated"; properties: {} }

export type FileDiff5 = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified" | undefined
  before: string
  after: string
}

export type MessageContextOverflowError2 = {
  name: "MessageContextOverflowError"
  data: { message: string; statusCode?: number; responseBody?: string }
}

export type StructuredOutputError2 = { name: "StructuredOutputError"; data: { message: string; retries: number } }

export type APIError3 = {
  name: "APIError"
  data: {
    message: string
    statusCode?: number
    isRetryable: boolean
    responseHeaders?: { [x: string]: string }
    responseBody?: string
    metadata?: { [x: string]: string }
    classification?: "payload-too-large"
  }
}

export type EventMessageRemoved = { type: "message.removed"; properties: { sessionID: string; messageID: string } }

export type TextPart2 = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: { [x: string]: any }
}

export type ReasoningPart2 = {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  metadata?: { [x: string]: any }
  time: { start: number; end?: number }
}

export type Range3 = { start: { line: number; character: number }; end: { line: number; character: number } }

export type ToolStateRunning2 = {
  status: "running"
  input: { [x: string]: any }
  title?: string
  metadata?: { [x: string]: any }
  structured?: { [x: string]: any }
  content?: Array<{ type: "text"; text: string } | { type: "file"; data: string; mime: string; name?: string }>
  time: { start: number }
}

export type ToolStateError2 = {
  status: "error"
  input: { [x: string]: any }
  error: string
  metadata?: { [x: string]: any }
  time: { start: number; end: number }
}

export type StepFinishPart2 = {
  id: string
  sessionID: string
  messageID: string
  type: "step-finish"
  reason: string
  snapshot?: string
  cost: number
  tokens: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

export type EventMessagePartRemoved = {
  type: "message.part.removed"
  properties: { sessionID: string; messageID: string; partID: string }
}

export type SessionWorktree8 = {
  name: string
  branch: string
  directory: string
  repositoryDirectory?: string
  cleanedAt?: number
}

export type SessionMobile4 = {
  platforms: Array<"ios" | "android" | "expo" | "flutter" | "react-native">
  primaryPlatform: string
  method: string
  detectedAt: number
  buildStatus?: "unknown" | "building" | "succeeded" | "failed"
  lastBuildAt?: number
  artifacts?: Array<{ platform: string; path: string; size?: number; createdAt?: number }>
}

export type EventSessionPendingPromoted = {
  type: "session.pending.promoted"
  properties: { sessionID: string; pendingIDs: Array<string>; messageIDs: Array<string> }
}

export type EventSessionInstructionsUpdated = {
  type: "session.instructions.updated"
  properties: { sessionID: string; delta: { [x: string]: string | "removed" } }
}

export type EventTuiPromptAppend = { type: "tui.prompt.append"; properties: { text: string } }

export type EventTuiCommandExecute = {
  type: "tui.command.execute"
  properties: {
    command:
      | "session.list"
      | "session.new"
      | "session.share"
      | "session.interrupt"
      | "session.compact"
      | "session.page.up"
      | "session.page.down"
      | "session.line.up"
      | "session.line.down"
      | "session.half.page.up"
      | "session.half.page.down"
      | "session.first"
      | "session.last"
      | "prompt.clear"
      | "prompt.submit"
      | "agent.cycle"
      | string
  }
}

export type EventTuiToastShow = {
  type: "tui.toast.show"
  properties: { title?: string; message: string; variant: "info" | "success" | "warning" | "error"; duration: number }
}

export type EventTuiSessionSelect = { type: "tui.session.select"; properties: { sessionID: string } }

export type EventMcpToolsChanged = { type: "mcp.tools.changed"; properties: { server: string } }

export type EventFileWatcherUpdated = {
  type: "file.watcher.updated"
  properties: { file: string; event: "add" | "change" | "unlink" }
}

export type EventVcsBranchUpdated = { type: "vcs.branch.updated"; properties: { branch?: string | undefined } }

export type SessionStatus3 =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy"; since: number }
  | { type: "busy" }

export type EventSessionIdle = { type: "session.idle"; properties: { sessionID: string } }

export type EventSessionCompacted = { type: "session.compacted"; properties: { sessionID: string } }

export type SessionGoalState1 = {
  sessionID: string
  goalID: string
  objective: string
  status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete"
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  iterationCount: number
  timeCreated: number
  timeUpdated: number
}

export type EventIdeInstalled = { type: "ide.installed"; properties: { ide: string } }

export type Pty2 = {
  id: string
  title: string
  command: string
  args: Array<string>
  cwd: string
  status: "running" | "exited"
  pid: number
}

export type EventPtyExited = { type: "pty.exited"; properties: { id: string; exitCode: number } }

export type EventPtyDeleted = { type: "pty.deleted"; properties: { id: string } }

export type EventSessionV2Updated = { type: "session.v2.updated"; properties: { sessionID: string } }

export type EventSessionEntryUpdated = {
  type: "session.entry.updated"
  properties: { sessionID: string; entry: unknown }
}

export type EventSessionEntryRemoved = {
  type: "session.entry.removed"
  properties: { sessionID: string; entryID: string }
}

export type EventFileEdited = { type: "file.edited"; properties: { file: string } }

export type EventMonitorCreated = {
  type: "monitor.created"
  properties: {
    sessionID: string
    record: {
      id: string
      sessionID: string
      messageID: string
      callID: string
      partID?: string
      title: string
      command: string
      cwd: string
      agent: string
      wake: boolean
      timeoutMs?: number
      status: "running" | "complete" | "error" | "timeout" | "cancelled"
      pid?: number
      exitCode?: number
      signal?: string
      logPath: string
      commandPath: string
      pidPath: string
      exitCodePath: string
      preview?: string | undefined
      bytes?: number | undefined
      time: { created: number; updated: number; completed?: number }
    }
  }
}

export type EventMonitorUpdated = {
  type: "monitor.updated"
  properties: {
    sessionID: string
    record: {
      id: string
      sessionID: string
      messageID: string
      callID: string
      partID?: string
      title: string
      command: string
      cwd: string
      agent: string
      wake: boolean
      timeoutMs?: number
      status: "running" | "complete" | "error" | "timeout" | "cancelled"
      pid?: number
      exitCode?: number
      signal?: string
      logPath: string
      commandPath: string
      pidPath: string
      exitCodePath: string
      preview?: string | undefined
      bytes?: number | undefined
      time: { created: number; updated: number; completed?: number }
    }
  }
}

export type EventMonitorOutput = {
  type: "monitor.output"
  properties: {
    sessionID: string
    monitorID: string
    delta: string
    preview: string
    bytes: number
    status: "running" | "complete" | "error" | "timeout" | "cancelled"
  }
}

export type EventMonitorCompleted = {
  type: "monitor.completed"
  properties: {
    sessionID: string
    monitorID: string
    title: string
    status: "running" | "complete" | "error" | "timeout" | "cancelled"
    exitCode: number | null
    logPath: string
    wake: boolean
  }
}

export type EventLoopUpserted = { type: "loop.upserted"; properties: { loopID: string } }

export type EventLoopRemoved = { type: "loop.removed"; properties: { loopID: string } }

export type EventLoopRunStarted = {
  type: "loop.run.started"
  properties: { loopID: string; runID: string; sessionID: string }
}

export type EventLoopRunFinished = {
  type: "loop.run.finished"
  properties: {
    loopID: string
    runID: string
    sessionID?: string | undefined
    status: "running" | "complete" | "error" | "timeout" | "cancelled" | "orphaned"
    ok: boolean
    error?: string | undefined
  }
}

export type EventLoopRuntimeChanged = { type: "loop.runtime.changed"; properties: { loopID: string } }

export type EventMissionUpserted = { type: "mission.upserted"; properties: { missionID: string } }

export type EventMissionRemoved = { type: "mission.removed"; properties: { missionID: string } }

export type EventMissionStarted = { type: "mission.started"; properties: { missionID: string } }

export type EventMissionFinished = {
  type: "mission.finished"
  properties: { missionID: string; status: "complete" | "error" | "paused" | "frozen"; error?: string | undefined }
}

export type EventMissionExecStarted = {
  type: "mission.exec.started"
  properties: {
    missionID: string
    execID: string
    kind: "feature" | "validation"
    targetID: string
    targetName: string
    sessionID: string
  }
}

export type EventMissionExecFinished = {
  type: "mission.exec.finished"
  properties: {
    missionID: string
    execID: string
    kind: "feature" | "validation"
    targetID: string
    status: "running" | "complete" | "error" | "timeout" | "cancelled" | "orphaned"
    ok: boolean
    error?: string | undefined
  }
}

export type EventMissionRuntimeChanged = { type: "mission.runtime.changed"; properties: { missionID: string } }

export type EventMissionAborted = { type: "mission.aborted"; properties: { missionID: string; reason: string } }

export type EventWorkspaceStatus = {
  type: "workspace.status"
  properties: { workspaceID: string; status: "connecting" | "connected" | "disconnected" | "error" }
}

export type EventWorkspaceReady = { type: "workspace.ready"; properties: { name: string } }

export type EventWorkspaceFailed = { type: "workspace.failed"; properties: { message: string } }

export type EventDelegationCompleted = {
  type: "delegation.completed"
  properties: {
    delegationID: string
    parentSessionID: string
    status: "running" | "complete" | "error" | "timeout" | "cancelled" | "orphaned"
    title: string
  }
}

export type WorkspaceJournalEvent = unknown

export type WorkspaceSessionWarpResponse = { sessionID: string; workspaceID: string | null }

export type PublicUser = {
  id: string
  username: string
  email: string
  display_name: string | null
  role: "admin" | "user"
  created_at: number
  updated_at: number
}

export type AnalyticsDaily = {
  date: string
  sessions: number
  messages: number
  tokens: AnalyticsTokenBreakdown
  cost: number
  toolCalls: number
  tools: { [x: string]: { calls: number; success: number; error: number } }
  providers: { [x: string]: { messages: number; tokens: number; cost: number } }
  models: { [x: string]: { messages: number; tokens: number; cost: number } }
  recordedAt: number
}

export type AnalyticsSession = {
  sessionID: string
  projectID: string
  directory: string
  title: string
  providerID: string
  modelID: string
  messages: number
  tokens: AnalyticsTokenBreakdown
  cost: number
  toolCalls: number
  duration: number
  time: { created: number; completed: number }
}

export type AnalyticsModelStat = {
  sessions: number
  messages: number
  tokens: AnalyticsModelTokens
  cost: number
  firstUsed: number
  lastUsed: number
}

export type AnalyticsLeaderboard = {
  models: Array<{
    key: string
    providerID: string
    modelID: string
    sessions: number
    messages: number
    tokens: AnalyticsModelTokens
    cost: number
    firstUsed: number
    lastUsed: number
    totalTokens: number
  }>
  providers: Array<{ id: string; sessions: number; messages: number; tokens: number; cost: number }>
  projects: Array<{ id: string; sessions: number; tokens: number; cost: number; lastActive: number }>
}

export type AnalyticsData = {
  totals: {
    tokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    sessions: number
    messages: number
    toolCalls: number
    costUsd: number
    models: number
    providers: number
    authors: number
    pricePerMillion: number
    costPerSession: number
    tokensPerSession: number
    cacheRatio: number | null
    change: number | null
  }
  models: Array<AnalyticsDataModelStat>
  authors: Array<{ author: string; tokens: number; sessions: number; share: number; models: number }>
  series: Array<{ day: string; byModel: { [x: string]: number }; tokens: number; sessions: number }>
  months: Array<AnalyticsDataPeriodStat>
  lifetime: AnalyticsDataPeriodStat
  seriesModels: Array<string>
  windowDays: number
  seriesDays: number
  from: string
  to: string
  generatedAt: number
} | null

export type ProfileInfoOrNull = ProfileInfo | null

export type AdsConfig = {
  enabled?: boolean | undefined
  ratio?: number | undefined
  items?: Array<AdsItemConfig> | undefined
}

export type PermissionObjectConfig = { [x: string]: PermissionActionConfig }

export type McpRemoteConfig = {
  type: "remote"
  url: string
  enabled?: boolean | undefined
  headers?: { [x: string]: string } | undefined
  oauth?: McpOAuthConfig | false | undefined
  timeout?: number | undefined
}

export type Provider = {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  env: Array<string>
  key?: string | undefined
  options: { [x: string]: any }
  models: { [x: string]: Model }
}

export type ConnectorsStatusOutput2 = { [x: string]: ConnectorStatus }

export type DoctorReport = {
  ok: boolean
  version: string
  channel: string
  failures: number
  results: Array<DoctorCheck>
}

export type ToolList = Array<ToolListItem>

export type McpResourceMap = { [x: string]: McpResource }

export type ManagedWorktreeList = Array<ManagedWorktreeInfo>

export type MCPStatusMap = { [x: string]: MCPStatus }

export type MissionMilestone = {
  id: string
  name: string
  features: Array<MissionFeature>
  validation: "scrutiny" | "user-test" | "none"
  status: "pending" | "running" | "validating" | "done" | "blocked"
}

export type MissionTemplatesOutput2 = { templates: Array<MissionTemplate> }

export type MissionExecsOutput2 = { execs: Array<MissionExec> }

export type MobileBootstrap = {
  version: string
  auth: { bearerEnabled: boolean; currentToken?: MobileAuthTokenPublic | undefined }
  currentProject: MobileProject
  projects: Array<MobileProject>
  execution: { container: { available: boolean; runtime?: "docker" | "podman" | undefined; image: string } }
  github: {
    connected: boolean
    tokenAvailable?: boolean | undefined
    reconnectRequired?: boolean | undefined
    oauthDeviceEnabled: boolean
    oauthDeviceConfigured?: boolean | undefined
    oauthClientSource?: "flag" | "config" | "env" | undefined
    user?: { login: string; name?: string | null | undefined; avatar_url?: string | undefined } | undefined
  }
  expo: { available: boolean; easAvailable: boolean; details: Array<string> }
  mobileProject?:
    | {
        detected: boolean
        platforms?: Array<string> | undefined
        primaryPlatform?: string | undefined
        method?: string | undefined
        root?: string | undefined
      }
    | undefined
}

export type MobileGithubWorkflowRunList = {
  runs: Array<MobileGithubWorkflowRun>
  totalCount: number
  configured: boolean
}

export type MobileGithubWorkflowJob = {
  id: number
  name: string
  status: string
  conclusion?: string | undefined
  htmlUrl?: string | undefined
  startedAt?: number | undefined
  completedAt?: number | undefined
  durationMs?: number | undefined
  steps: Array<MobileGithubWorkflowStep>
}

export type AdsConfig1 = {
  enabled?: boolean | undefined
  ratio?: number | undefined
  items?: Array<AdsItemConfig1> | undefined
}

export type McpRemoteConfig1 = {
  type: "remote"
  url: string
  enabled?: boolean | undefined
  headers?: { [x: string]: string } | undefined
  oauth?: McpOAuthConfig1 | false | undefined
  timeout?: number | undefined
}

export type SessionGithub = {
  owner: string
  repo: string
  fullName: string
  baseBranch: string
  headBranch: string
  repositoryDirectory?: string | undefined
  cloneUrl?: string | undefined
  htmlUrl?: string | undefined
  private?: boolean | undefined
  worktree: SessionWorktree
  pullRequest?: { number: number; url: string; title: string } | undefined
  lastCommitSha?: string | undefined
  publishedAt?: number | undefined
  publishError?: string | undefined
}

export type PermissionRule = { permission: string; pattern: string; action: PermissionAction }

export type SessionGithub1 = {
  owner: string
  repo: string
  fullName: string
  baseBranch: string
  headBranch: string
  repositoryDirectory?: string | undefined
  cloneUrl?: string | undefined
  htmlUrl?: string | undefined
  private?: boolean | undefined
  worktree: SessionWorktree2
  pullRequest?: { number: number; url: string; title: string } | undefined
  lastCommitSha?: string | undefined
  publishedAt?: number | undefined
  publishError?: string | undefined
}

export type PermissionRule1 = { permission: string; pattern: string; action: PermissionAction1 }

export type FileDiffList = Array<FileDiff2>

export type SessionGithub2 = {
  owner: string
  repo: string
  fullName: string
  baseBranch: string
  headBranch: string
  repositoryDirectory?: string
  cloneUrl?: string
  htmlUrl?: string
  private?: boolean
  worktree: SessionWorktree4
  pullRequest?: { number: number; url: string; title: string }
  lastCommitSha?: string
  publishedAt?: number
  publishError?: string
}

export type PermissionRule2 = { permission: string; pattern: string; action: PermissionAction2 }

export type SessionGithub3 = {
  owner: string
  repo: string
  fullName: string
  baseBranch: string
  headBranch: string
  repositoryDirectory?: string | undefined
  cloneUrl?: string | undefined
  htmlUrl?: string | undefined
  private?: boolean | undefined
  worktree: SessionWorktree6
  pullRequest?: { number: number; url: string; title: string } | undefined
  lastCommitSha?: string | undefined
  publishedAt?: number | undefined
  publishError?: string | undefined
}

export type PermissionRule3 = { permission: string; pattern: string; action: PermissionAction3 }

export type OutputFormatJsonSchema = { type: "json_schema"; schema: JSONSchema; retryCount?: number | undefined }

export type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number | undefined }
  error?:
    | ProviderAuthError
    | UnknownError
    | MessageOutputLengthError
    | MessageContextOverflowError
    | MessageAbortedError
    | StructuredOutputError
    | APIError
    | undefined
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: { cwd: string; root: string }
  summary?: boolean | undefined
  cost: number
  tokens: {
    total?: number | undefined
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  structured?: unknown | undefined
  finish?: string | undefined
}

export type FileSource = { text: FilePartSourceText; type: "file"; path: string }

export type SymbolSource = {
  text: FilePartSourceText1
  type: "symbol"
  path: string
  range: Range
  name: string
  kind: number
}

export type ResourceSource = { text: FilePartSourceText2; type: "resource"; clientName: string; uri: string }

export type FileSource1 = { text: FilePartSourceText3; type: "file"; path: string }

export type SymbolSource1 = {
  text: FilePartSourceText4
  type: "symbol"
  path: string
  range: Range1
  name: string
  kind: number
}

export type ResourceSource1 = { text: FilePartSourceText5; type: "resource"; clientName: string; uri: string }

export type RetryPart = {
  id: string
  sessionID: string
  messageID: string
  type: "retry"
  attempt: number
  error: APIError1
  time: { created: number }
}

export type QuestionInfo = {
  question: string
  header: string
  options: Array<QuestionOption>
  multiple?: boolean | undefined
  custom?: boolean | undefined
}

export type OutputFormatJsonSchema1 = { type: "json_schema"; schema: JSONSchema1; retryCount: number }

export type AssistantMessage1 = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?:
    | ProviderAuthError1
    | UnknownError1
    | MessageOutputLengthError1
    | MessageContextOverflowError1
    | MessageAbortedError1
    | StructuredOutputError1
    | APIError2
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: { cwd: string; root: string }
  summary?: boolean
  cost: number
  tokens: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  structured?: any
  finish?: string
}

export type RetryPart1 = {
  id: string
  sessionID: string
  messageID: string
  type: "retry"
  attempt: number
  error: APIError2
  time: { created: number }
}

export type FileSource2 = { text: FilePartSourceText6; type: "file"; path: string }

export type ResourceSource2 = { text: FilePartSourceText6; type: "resource"; clientName: string; uri: string }

export type SymbolSource2 = {
  text: FilePartSourceText6
  type: "symbol"
  path: string
  range: Range2
  name: string
  kind: number
}

export type TodoList = Array<Todo>

export type EventTodoUpdated = {
  type: "todo.updated"
  properties: { sessionID: string; todos: Array<Todo>; diff: { added: Array<Todo>; completed: Array<Todo> } }
}

export type MobileGitStatus = {
  branch: string
  staged: Array<MobileGitChange>
  unstaged: Array<MobileGitChange>
  untracked: Array<string>
  commitsAhead: number
  commitsBehind: number
  lastCommit?: { sha: string; message: string; author: string; timestamp: number } | undefined
}

export type LoopDefinition = {
  id: string
  name: string
  stages: Array<LoopStage>
  trigger: LoopTrigger
  maxRuns?: number
  timeoutMs?: number
  createPR?: boolean
  sandbox?: boolean
  worktree?: LoopWorktree
  paused?: boolean
  enabled: boolean
  createdAt: number
}

export type RoutineTrigger = RoutineTriggerSchedule | RoutineTriggerApi

export type ProviderAuthMethods = { [x: string]: Array<ProviderAuthMethod> }

export type QuestionInfo1 = {
  question: string
  header: string
  options: Array<QuestionOption1>
  multiple?: boolean | undefined
  custom?: boolean | undefined
}

export type PtyList = Array<Pty1>

export type LoopTemplatesOutput2 = { templates: Array<LoopTemplate> }

export type LoopRun = {
  id: string
  loopID: string
  startedAt: number
  endedAt?: number
  status: "running" | "complete" | "error" | "timeout" | "cancelled" | "orphaned"
  heartbeatAt?: number
  sessionID?: string
  error?: string
  ok: boolean
  pullRequest?: LoopPullRequestRef
}

export type SessionStatusMap = { [x: string]: SessionStatus2 }

export type SessionContextBreakdown = {
  model?: { providerID: string; modelID: string; name: string; contextLimit: number }
  reported: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number }
  sources: Array<SessionContextSource>
  estimatedTotal: number
}

export type SessionGoalOutput2 = SessionGoalState | null

export type SessionBackgroundOutput2 = Array<DelegationJob>

export type SessionBackgroundInspectOutput2 = DelegationJob | null

export type SyncStatsOutput2 = {
  url?: string | undefined
  configured: boolean
  source: string
  connected: boolean
  pending: number
  failed: number
  total: number
  lastSeq: number
  lastError?: string | undefined
  lastChange: number
  events: Array<SyncStatsEvent>
}

export type PluginSpecConfig = string | [string, PluginOptionsConfig]

export type Workspace1 = {
  id: string
  name: string
  timeUsed: number
  branch: string | null
  projectID: string
  config: WorkspaceConfig
}

export type ConfigProfilesList = { profiles: { [x: string]: ConfigProfileInfo }; activeProfile: string }

export type EventProjectUpdated = { type: "project.updated"; properties: Project3 }

export type EventPermissionAsked = { type: "permission.asked"; properties: PermissionRequest2 }

export type EventPermissionBlocked = { type: "permission.blocked"; properties: PermissionBlocked1 }

export type QuestionInfo2 = {
  question: string
  header: string
  options: Array<QuestionOption2>
  multiple?: boolean | undefined
  custom?: boolean | undefined
}

export type EventQuestionReplied = {
  type: "question.replied"
  properties: { sessionID: string; requestID: string; answers: Array<QuestionAnswer> }
}

export type EventSessionDiff = { type: "session.diff"; properties: { sessionID: string; diff: Array<FileDiff5> } }

export type AssistantMessage2 = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?:
    | ProviderAuthError1
    | UnknownError1
    | MessageOutputLengthError1
    | MessageContextOverflowError2
    | MessageAbortedError1
    | StructuredOutputError2
    | APIError3
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: { cwd: string; root: string }
  summary?: boolean
  cost: number
  tokens: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  structured?: any
  finish?: string
}

export type RetryPart2 = {
  id: string
  sessionID: string
  messageID: string
  type: "retry"
  attempt: number
  error: APIError3
  time: { created: number }
}

export type EventSessionError = {
  type: "session.error"
  properties: {
    sessionID?: string | undefined
    error?:
      | ProviderAuthError1
      | UnknownError1
      | MessageOutputLengthError1
      | MessageContextOverflowError2
      | MessageAbortedError1
      | StructuredOutputError2
      | APIError3
      | undefined
  }
}

export type SymbolSource3 = {
  text: FilePartSourceText6
  type: "symbol"
  path: string
  range: Range3
  name: string
  kind: number
}

export type SessionGithub4 = {
  owner: string
  repo: string
  fullName: string
  baseBranch: string
  headBranch: string
  repositoryDirectory?: string
  cloneUrl?: string
  htmlUrl?: string
  private?: boolean
  worktree: SessionWorktree8
  pullRequest?: { number: number; url: string; title: string }
  lastCommitSha?: string
  publishedAt?: number
  publishError?: string
}

export type EventSessionStatus = { type: "session.status"; properties: { sessionID: string; status: SessionStatus3 } }

export type EventSessionGoal = {
  type: "session.goal"
  properties: { sessionID: string; goal: SessionGoalState1 | null }
}

export type EventPtyCreated = { type: "pty.created"; properties: { info: Pty2 } }

export type EventPtyUpdated = { type: "pty.updated"; properties: { info: Pty2 } }

export type UserSession = { token: string; user: PublicUser }

export type AnalyticsGlobal = {
  version: 1
  updatedAt: number
  totals: { sessions: number; messages: number; tokens: AnalyticsTokenBreakdown; cost: number; toolCalls: number }
  byProvider: { [x: string]: AnalyticsProviderStat }
  byModel: { [x: string]: AnalyticsModelStat }
  byProject: { [x: string]: AnalyticsProjectStat }
}

export type PermissionRuleConfig = PermissionActionConfig | PermissionObjectConfig

export type ConfigProviders = { providers: Array<Provider>; default: { [x: string]: string } }

export type ProviderList = { all: Array<Provider>; default: { [x: string]: string }; connected: Array<string> }

export type MissionDefinition = {
  id: string
  name: string
  brief: string
  milestones: Array<MissionMilestone>
  models: MissionModels
  timeoutMs?: number
  sandbox?: boolean
  worktree?: MissionWorktree
  status: "planning" | "ready" | "running" | "paused" | "frozen" | "complete" | "error"
  createdAt: number
}

export type PermissionRuleset = Array<PermissionRule>

export type PermissionRuleset1 = Array<PermissionRule1>

export type PermissionRuleset2 = Array<PermissionRule2>

export type PermissionRuleset3 = Array<PermissionRule3>

export type OutputFormat = OutputFormatText | OutputFormatJsonSchema

export type FilePartSource = FileSource | SymbolSource | ResourceSource

export type FilePartSource1 = FileSource1 | SymbolSource1 | ResourceSource1

export type QuestionRequest = {
  id: string
  sessionID: string
  questions: Array<QuestionInfo>
  tool?: { messageID: string; callID: string } | undefined
}

export type OutputFormat1 = OutputFormatText1 | OutputFormatJsonSchema1

export type FilePartSource2 = FileSource2 | SymbolSource2 | ResourceSource2

export type LoopListOutput2 = { loops: Array<LoopDefinition>; runtimes: Array<LoopRuntime> }

export type LoopGetOutput2 = { loop: LoopDefinition; runtime: LoopRuntime }

export type MobileRoutine = {
  id: string
  name: string
  prompt: string
  triggers: Array<RoutineTrigger>
  model?: { providerID: string; modelID: string } | undefined
  paused: boolean
  projectID: string
  directory: string
  createdAt: number
  updatedAt: number
  lastRunAt?: number | undefined
  lastSessionID?: string | undefined
}

export type QuestionRequest1 = {
  id: string
  sessionID: string
  questions: Array<QuestionInfo1>
  tool?: { messageID: string; callID: string } | undefined
}

export type LoopRunsOutput2 = { runs: Array<LoopRun> }

export type TuiConfig = {
  $schema?: string | undefined
  theme?: string | undefined
  keybinds?:
    | {
        leader?: string | undefined
        app_exit?: string | undefined
        editor_open?: string | undefined
        theme_list?: string | undefined
        sidebar_toggle?: string | undefined
        scrollbar_toggle?: string | undefined
        username_toggle?: string | undefined
        status_view?: string | undefined
        sync_view?: string | undefined
        session_export?: string | undefined
        session_new?: string | undefined
        session_list?: string | undefined
        session_timeline?: string | undefined
        session_fork?: string | undefined
        session_rename?: string | undefined
        session_delete?: string | undefined
        session_pin_toggle?: string | undefined
        session_scope_toggle?: string | undefined
        session_tab_back?: string | undefined
        session_tab_forward?: string | undefined
        session_quick_switch_1?: string | undefined
        session_quick_switch_2?: string | undefined
        session_quick_switch_3?: string | undefined
        session_quick_switch_4?: string | undefined
        session_quick_switch_5?: string | undefined
        session_quick_switch_6?: string | undefined
        session_quick_switch_7?: string | undefined
        session_quick_switch_8?: string | undefined
        session_quick_switch_9?: string | undefined
        stash_delete?: string | undefined
        model_provider_list?: string | undefined
        model_favorite_toggle?: string | undefined
        session_share?: string | undefined
        session_unshare?: string | undefined
        session_interrupt?: string | undefined
        session_codebro_open?: string | undefined
        subtask_background?: string | undefined
        subtask_picker?: string | undefined
        session_compact?: string | undefined
        messages_page_up?: string | undefined
        messages_page_down?: string | undefined
        messages_line_up?: string | undefined
        messages_line_down?: string | undefined
        messages_half_page_up?: string | undefined
        messages_half_page_down?: string | undefined
        messages_first?: string | undefined
        messages_last?: string | undefined
        messages_next?: string | undefined
        messages_previous?: string | undefined
        messages_last_user?: string | undefined
        messages_copy?: string | undefined
        messages_undo?: string | undefined
        messages_redo?: string | undefined
        messages_toggle_conceal?: string | undefined
        tool_details?: string | undefined
        model_list?: string | undefined
        model_cycle_recent?: string | undefined
        model_cycle_recent_reverse?: string | undefined
        model_cycle_favorite?: string | undefined
        model_cycle_favorite_reverse?: string | undefined
        command_list?: string | undefined
        agent_list?: string | undefined
        agent_cycle?: string | undefined
        agent_cycle_reverse?: string | undefined
        permission_mode?: string | undefined
        variant_cycle?: string | undefined
        input_clear?: string | undefined
        input_paste?: string | undefined
        input_submit?: string | undefined
        input_newline?: string | undefined
        input_move_left?: string | undefined
        input_move_right?: string | undefined
        input_move_up?: string | undefined
        input_move_down?: string | undefined
        input_select_left?: string | undefined
        input_select_right?: string | undefined
        input_select_up?: string | undefined
        input_select_down?: string | undefined
        input_line_home?: string | undefined
        input_line_end?: string | undefined
        input_select_line_home?: string | undefined
        input_select_line_end?: string | undefined
        input_visual_line_home?: string | undefined
        input_visual_line_end?: string | undefined
        input_select_visual_line_home?: string | undefined
        input_select_visual_line_end?: string | undefined
        input_buffer_home?: string | undefined
        input_buffer_end?: string | undefined
        input_select_buffer_home?: string | undefined
        input_select_buffer_end?: string | undefined
        input_delete_line?: string | undefined
        input_delete_to_line_end?: string | undefined
        input_delete_to_line_start?: string | undefined
        input_backspace?: string | undefined
        input_delete?: string | undefined
        input_undo?: string | undefined
        input_redo?: string | undefined
        input_word_forward?: string | undefined
        input_word_backward?: string | undefined
        input_select_word_forward?: string | undefined
        input_select_word_backward?: string | undefined
        input_delete_word_forward?: string | undefined
        input_delete_word_backward?: string | undefined
        history_previous?: string | undefined
        history_next?: string | undefined
        session_child_cycle?: string | undefined
        session_child_cycle_reverse?: string | undefined
        session_parent?: string | undefined
        session_child_close?: string | undefined
        terminal_suspend?: string | undefined
        terminal_title_toggle?: string | undefined
        tips_toggle?: string | undefined
        voice_record?: string | undefined
        app_support?: string | undefined
      }
    | undefined
  plugin?: Array<PluginSpecConfig> | undefined
  plugin_enabled?: { [x: string]: boolean } | undefined
  scroll_speed?: number | undefined
  scroll_acceleration?: { enabled: boolean } | undefined
  diff_style?: "auto" | "stacked" | undefined
  mouse?: boolean | undefined
  sound?: boolean | undefined
  bg_pulse?: boolean | undefined
  turn_tokens?: boolean | undefined
  plugin_meta?: { [x: string]: { scope: "global" | "local"; source: string } }
} & { [x: string]: any }

export type OptionalWorkspace = Workspace1 | null

export type QuestionRequest2 = {
  id: string
  sessionID: string
  questions: Array<QuestionInfo2>
  tool?: { messageID: string; callID: string } | undefined
}

export type FilePartSource3 = FileSource2 | SymbolSource3 | ResourceSource2

export type PermissionConfig = { [x: string]: PermissionRuleConfig | undefined }

export type MissionListOutput2 = { missions: Array<MissionDefinition>; runtimes: Array<MissionRuntime> }

export type MissionGetOutput2 = { mission: MissionDefinition; runtime: MissionRuntime }

export type Session = {
  id: string
  slug: string
  projectID: string
  directory: string
  parentID?: string | undefined
  workspaceID?: string | undefined
  summary?: { additions: number; deletions: number; files: number; diffs?: Array<FileDiff> | undefined } | undefined
  share?: { url: string } | undefined
  github?: SessionGithub | undefined
  worktree?: SessionWorktree1 | undefined
  mobile?: SessionMobile | undefined
  title: string
  activeCommand?: string | undefined
  version: string
  time: { created: number; updated: number; compacting?: number | undefined; archived?: number | undefined }
  permission?: PermissionRuleset | undefined
  skills?: Array<string> | undefined
  disabledInstructions?: Array<string> | undefined
  disabledTools?: { [x: string]: boolean } | undefined
  revert?:
    | { messageID: string; partID?: string | undefined; snapshot?: string | undefined; diff?: string | undefined }
    | undefined
  lastModel?: { providerID: string; modelID: string } | undefined
}

export type Session1 = {
  id: string
  slug: string
  projectID: string
  directory: string
  parentID?: string | undefined
  workspaceID?: string | undefined
  summary?: { additions: number; deletions: number; files: number; diffs?: Array<FileDiff1> | undefined } | undefined
  share?: { url: string } | undefined
  github?: SessionGithub1 | undefined
  worktree?: SessionWorktree3 | undefined
  mobile?: SessionMobile1 | undefined
  title: string
  activeCommand?: string | undefined
  version: string
  time: { created: number; updated: number; compacting?: number | undefined; archived?: number | undefined }
  permission?: PermissionRuleset1 | undefined
  skills?: Array<string> | undefined
  disabledInstructions?: Array<string> | undefined
  disabledTools?: { [x: string]: boolean } | undefined
  revert?:
    | { messageID: string; partID?: string | undefined; snapshot?: string | undefined; diff?: string | undefined }
    | undefined
  lastModel?: { providerID: string; modelID: string } | undefined
}

export type Session2 = {
  id: string
  slug: string
  projectID: string
  directory: string
  parentID?: string
  workspaceID?: string
  summary?: { additions: number; deletions: number; files: number; diffs?: Array<FileDiff2> }
  share?: { url: string }
  github?: SessionGithub2
  worktree?: SessionWorktree5
  mobile?: SessionMobile2
  title: string
  activeCommand?: string
  version: string
  time: { created: number; updated: number; compacting?: number; archived?: number }
  permission?: PermissionRuleset2
  skills?: Array<string>
  disabledInstructions?: Array<string>
  disabledTools?: { [x: string]: boolean }
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
  lastModel?: { providerID: string; modelID: string }
}

export type Session4 = {
  id: string
  slug: string
  projectID: string
  directory: string
  parentID?: string
  workspaceID?: string
  summary?: { additions: number; deletions: number; files: number; diffs?: Array<FileDiff5> }
  share?: { url: string }
  github?: SessionGithub4
  worktree?: SessionWorktree8
  mobile?: SessionMobile4
  title: string
  activeCommand?: string
  version: string
  time: { created: number; updated: number; compacting?: number; archived?: number }
  permission?: PermissionRuleset2
  skills?: Array<string>
  disabledInstructions?: Array<string>
  disabledTools?: { [x: string]: boolean }
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
  lastModel?: { providerID: string; modelID: string }
}

export type Session3 = {
  id: string
  slug: string
  projectID: string
  directory: string
  parentID?: string | undefined
  workspaceID?: string | undefined
  summary?: { additions: number; deletions: number; files: number; diffs?: Array<FileDiff3> | undefined } | undefined
  share?: { url: string } | undefined
  github?: SessionGithub3 | undefined
  worktree?: SessionWorktree7 | undefined
  mobile?: SessionMobile3 | undefined
  title: string
  activeCommand?: string | undefined
  version: string
  time: { created: number; updated: number; compacting?: number | undefined; archived?: number | undefined }
  permission?: PermissionRuleset3 | undefined
  skills?: Array<string> | undefined
  disabledInstructions?: Array<string> | undefined
  disabledTools?: { [x: string]: boolean } | undefined
  revert?:
    | { messageID: string; partID?: string | undefined; snapshot?: string | undefined; diff?: string | undefined }
    | undefined
  lastModel?: { providerID: string; modelID: string } | undefined
}

export type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  format?: OutputFormat | undefined
  summary?: { title?: string | undefined; body?: string | undefined; diffs: Array<FileDiff4> } | undefined
  agent: string
  model: { providerID: string; modelID: string }
  system?: string | undefined
  tools?: { [x: string]: boolean } | undefined
  variant?: string | undefined
}

export type FilePart = {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string | undefined
  url: string
  source?: FilePartSource | undefined
}

export type FilePart1 = {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string | undefined
  url: string
  source?: FilePartSource1 | undefined
}

export type UserMessage1 = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  format?: OutputFormat1
  summary?: { title?: string; body?: string; diffs: Array<FileDiff2> }
  agent: string
  model: { providerID: string; modelID: string }
  system?: string
  tools?: { [x: string]: boolean }
  variant?: string
}

export type UserMessage2 = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  format?: OutputFormat1
  summary?: { title?: string; body?: string; diffs: Array<FileDiff5> }
  agent: string
  model: { providerID: string; modelID: string }
  system?: string
  tools?: { [x: string]: boolean }
  variant?: string
}

export type FilePart2 = {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: FilePartSource2
}

export type FilePartInput = {
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: FilePartSource2
  id?: string | undefined
}

export type EventQuestionAsked = { type: "question.asked"; properties: QuestionRequest2 }

export type FilePart3 = {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: FilePartSource3
}

export type AgentConfig = {
  model?: string | undefined
  variant?: string | undefined
  temperature?: number | undefined
  top_p?: number | undefined
  prompt?: string | undefined
  tools?: { [x: string]: boolean } | undefined
  disable?: boolean | undefined
  description?: string | undefined
  mode?: "subagent" | "primary" | "all" | undefined
  hidden?: boolean | undefined
  options?: { [x: string]: any } | undefined
  color?: string | undefined
  steps?: number | undefined
  order?: number | undefined
  maxSteps?: number | undefined
  permission?: PermissionConfig | undefined
  permission_mode?: PermissionModeConfig | undefined
  advisor?: string | undefined
  advisor_max_uses?: number | undefined
} & { [x: string]: any | undefined }

export type AgentConfig1 = {
  model?: string | undefined
  variant?: string | undefined
  temperature?: number | undefined
  top_p?: number | undefined
  prompt?: string | undefined
  tools?: { [x: string]: boolean } | undefined
  disable?: boolean | undefined
  description?: string | undefined
  mode?: "subagent" | "primary" | "all" | undefined
  hidden?: boolean | undefined
  options?: { [x: string]: any } | undefined
  color?: string | undefined
  steps?: number | undefined
  order?: number | undefined
  maxSteps?: number | undefined
  permission?: PermissionConfig | undefined
  permission_mode?: PermissionModeConfig1 | undefined
  advisor?: string | undefined
  advisor_max_uses?: number | undefined
} & { [x: string]: any | undefined }

export type MobileGithubSessionCreateResult = {
  session: Session
  worktree: Worktree1
  project: Project1
  workspace?: Workspace | undefined
}

export type MobileSessionSummary = { info: Session1; status?: SessionStatus | undefined }

export type SessionList = Array<Session2>

export type EventSessionCreated = { type: "session.created"; properties: { info: Session4 } }

export type EventSessionUpdated = { type: "session.updated"; properties: { info: Session4 } }

export type EventSessionDeleted = { type: "session.deleted"; properties: { info: Session4 } }

export type Message = UserMessage | AssistantMessage

export type ToolStateCompleted = {
  status: "completed"
  input: { [x: string]: any }
  output: string
  title: string
  metadata: { [x: string]: any }
  time: { start: number; end: number; compacted?: number | undefined }
  attachments?: Array<FilePart1> | undefined
}

export type Message1 = UserMessage1 | AssistantMessage1

export type Message2 = UserMessage2 | AssistantMessage2

export type ToolStateCompleted1 = {
  status: "completed"
  input: { [x: string]: any }
  output: string
  title: string
  metadata: { [x: string]: any }
  time: { start: number; end: number; compacted?: number }
  attachments?: Array<FilePart2>
}

export type PromptPartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput

export type ToolStateCompleted2 = {
  status: "completed"
  input: { [x: string]: any }
  output: string
  title: string
  metadata: { [x: string]: any }
  time: { start: number; end: number; compacted?: number }
  attachments?: Array<FilePart3>
}

export type Config = {
  $schema?: string | undefined
  theme?: string | undefined
  locale?:
    | {
        language?: string | undefined
        region?: string | undefined
        locale?: string | undefined
        timezone?: string | undefined
        currency?: string | undefined
        autoDetect?: boolean | undefined
        replyLanguage?: boolean | string | undefined
      }
    | undefined
  keybinds?: KeybindsConfig | undefined
  logLevel?: LogLevel | undefined
  tui?:
    | {
        scroll_speed?: number | undefined
        scroll_acceleration?: { enabled: boolean } | undefined
        diff_style?: "auto" | "stacked" | undefined
        mouse?: boolean | undefined
        sound?: boolean | undefined
        bg_pulse?: boolean | undefined
        turn_tokens?: boolean | undefined
      }
    | undefined
  ads?: AdsConfig | undefined
  server?: ServerConfig | undefined
  remote?: RemoteConfig | undefined
  teleport?: TeleportConfig | undefined
  command?:
    | {
        [x: string]: {
          template?: string | undefined
          description?: string | undefined
          agent?: string | undefined
          model?: string | undefined
          subtask?: boolean | undefined
          aliases?: Array<string> | undefined
        }
      }
    | undefined
  reference?: { [x: string]: ReferenceConfig } | undefined
  watcher?: { ignore?: Array<string> | undefined } | undefined
  plugin?: Array<string> | undefined
  snapshot?: boolean | undefined
  sync?: { url?: string | undefined; token?: string | undefined; autostart?: boolean | undefined } | undefined
  analytics?: { share?: boolean | undefined; endpoint?: string | undefined } | undefined
  share?: "manual" | "auto" | "disabled" | undefined
  autoshare?: boolean | undefined
  autoupdate?: boolean | "notify" | undefined
  disabled_providers?: Array<string> | undefined
  enabled_providers?: Array<string> | undefined
  model?: string | undefined
  small_model?: string | undefined
  default_agent?: string | undefined
  username?: string | undefined
  mode?:
    | ({ build?: AgentConfig | undefined; plan?: AgentConfig | undefined } & { [x: string]: AgentConfig | undefined })
    | undefined
  agent?:
    | ({
        plan?: AgentConfig | undefined
        build?: AgentConfig | undefined
        general?: AgentConfig | undefined
        explore?: AgentConfig | undefined
        scout?: AgentConfig | undefined
        title?: AgentConfig | undefined
        summary?: AgentConfig | undefined
        compaction?: AgentConfig | undefined
      } & { [x: string]: AgentConfig | undefined })
    | undefined
  provider?: { [x: string]: ProviderConfig } | undefined
  mcp?: { [x: string]: McpLocalConfig | McpRemoteConfig | { enabled: boolean } } | undefined
  connectors?:
    | {
        [x: string]:
          | ConnectorFigma
          | ConnectorSlack
          | ConnectorGithub
          | ConnectorLovable
          | ConnectorDiscord
          | ConnectorTeams
          | ConnectorGChat
          | ConnectorLinear
          | { enabled: boolean }
      }
    | undefined
  formatter?:
    | false
    | true
    | {
        [x: string]: {
          disabled?: boolean | undefined
          command?: Array<string> | undefined
          environment?: { [x: string]: string } | undefined
          extensions?: Array<string> | undefined
        }
      }
    | undefined
  websearch?:
    | {
        provider?: "exa" | "parallel" | "mcp" | undefined
        apiKey?: string | undefined
        url?: string | undefined
        tool?: string | undefined
      }
    | undefined
  lsp?:
    | false
    | {
        [x: string]:
          | { disabled: true }
          | {
              command: Array<string>
              extensions?: Array<string> | undefined
              disabled?: boolean | undefined
              env?: { [x: string]: string } | undefined
              initialization?: { [x: string]: any } | undefined
              min_severity?: number | undefined
            }
      }
    | undefined
  instructions?: Array<string> | undefined
  layout?: LayoutConfig | undefined
  permission?: PermissionConfig | undefined
  permission_mode?: PermissionModeConfig | undefined
  auto_mode?: AutoModeConfig | undefined
  tools?: { [x: string]: boolean } | undefined
  tool?: { allow?: Array<string> | undefined; pin?: { [x: string]: string } | undefined } | undefined
  enterprise?: { url?: string | undefined } | undefined
  compaction?: { auto?: boolean | undefined; prune?: boolean | undefined; reserved?: number | undefined } | undefined
  experimental?:
    | {
        policies?: Array<PolicyStatementConfig> | undefined
        hook?:
          | {
              file_edited?:
                | { [x: string]: Array<{ command: Array<string>; environment?: { [x: string]: string } | undefined }> }
                | undefined
              session_completed?:
                | Array<{ command: Array<string>; environment?: { [x: string]: string } | undefined }>
                | undefined
            }
          | undefined
        queued_message_wrap?: { header: string; footer: string } | "default" | boolean | null | undefined
        chatMaxRetries?: number | undefined
        disable_paste_summary?: boolean | undefined
        batch_tool?: boolean | undefined
        openTelemetry?: boolean | undefined
        primary_tools?: Array<string> | undefined
        continue_loop_on_deny?: boolean | undefined
        brain?: boolean | undefined
        brainMinHours?: number | undefined
        brainMinSessions?: number | undefined
        brainModel?: string | undefined
        memory?: boolean | undefined
        mcp_timeout?: number | undefined
        tool_timeout?: number | false | undefined
        task_timeout?: number | false | undefined
        nativeLlm?: boolean | undefined
        tui?:
          | {
              cacheEviction?: boolean | undefined
              messageVirtualization?: boolean | undefined
              explorationGrouping?: boolean | undefined
            }
          | undefined
        requests?: { latestOnlyLspRefresh?: boolean | undefined } | undefined
        events?: { schemaEncoding?: boolean | undefined } | undefined
      }
    | undefined
  rag?: RagConfig | undefined
  image?: ImageConfig | undefined
  browser?: unknown | undefined
  computer?: ComputerConfig | undefined
  attachment?: AttachmentConfig | undefined
  speak?: SpeakConfig | undefined
  notifications?:
    | {
        todo?:
          | {
              enabled?: boolean | undefined
              macos?: boolean | undefined
              slack?:
                | { enabled?: boolean | undefined; connector?: string | undefined; channel?: string | undefined }
                | undefined
              discord?: { enabled?: boolean | undefined; webhook?: string | undefined } | undefined
            }
          | undefined
        icon?: { url?: string | undefined; alt?: string | undefined } | undefined
        notify?:
          | {
              enabled?: boolean | undefined
              macos?: boolean | undefined
              slack?:
                | { enabled?: boolean | undefined; connector?: string | undefined; channel?: string | undefined }
                | undefined
              discord?: { enabled?: boolean | undefined; webhook?: string | undefined } | undefined
              events?:
                | {
                    sessionIdle?: boolean | undefined
                    sessionError?: boolean | undefined
                    permissionAsked?: boolean | undefined
                    questionAsked?: boolean | undefined
                  }
                | undefined
              idleMinMs?: number | undefined
              rateLimit?: { windowMs?: number | undefined; maxPerWindow?: number | undefined } | undefined
              retry?:
                | {
                    attempts?: number | undefined
                    delay?: number | undefined
                    factor?: number | undefined
                    maxDelay?: number | undefined
                    timeoutMs?: number | undefined
                  }
                | undefined
              breaker?: { failures?: number | undefined; cooldownMs?: number | undefined } | undefined
              quietHours?:
                | {
                    enabled?: boolean | undefined
                    start?: string | undefined
                    end?: string | undefined
                    suppress?: Array<"macos" | "slack" | "discord"> | undefined
                  }
                | undefined
            }
          | undefined
      }
    | undefined
  mobile?:
    | {
        tophat?:
          | {
              enabled?: boolean | undefined
              cliPath?: string | undefined
              defaultPlatform?: "ios" | "android" | undefined
              defaultDestination?: "device" | "simulator" | "emulator" | undefined
              autoDetect?: boolean | undefined
            }
          | undefined
      }
    | undefined
} & { [x: string]: any }

export type MobileConfigInfo = {
  $schema?: string | undefined
  theme?: string | undefined
  locale?:
    | {
        language?: string | undefined
        region?: string | undefined
        locale?: string | undefined
        timezone?: string | undefined
        currency?: string | undefined
        autoDetect?: boolean | undefined
        replyLanguage?: boolean | string | undefined
      }
    | undefined
  keybinds?: KeybindsConfig1 | undefined
  logLevel?: LogLevel1 | undefined
  tui?:
    | {
        scroll_speed?: number | undefined
        scroll_acceleration?: { enabled: boolean } | undefined
        diff_style?: "auto" | "stacked" | undefined
        mouse?: boolean | undefined
        sound?: boolean | undefined
        bg_pulse?: boolean | undefined
        turn_tokens?: boolean | undefined
      }
    | undefined
  ads?: AdsConfig1 | undefined
  server?: ServerConfig1 | undefined
  remote?: RemoteConfig1 | undefined
  teleport?: TeleportConfig1 | undefined
  command?:
    | {
        [x: string]: {
          template?: string | undefined
          description?: string | undefined
          agent?: string | undefined
          model?: string | undefined
          subtask?: boolean | undefined
          aliases?: Array<string> | undefined
        }
      }
    | undefined
  reference?: { [x: string]: ReferenceConfig1 } | undefined
  watcher?: { ignore?: Array<string> | undefined } | undefined
  plugin?: Array<string> | undefined
  snapshot?: boolean | undefined
  sync?: { url?: string | undefined; token?: string | undefined; autostart?: boolean | undefined } | undefined
  analytics?: { share?: boolean | undefined; endpoint?: string | undefined } | undefined
  share?: "manual" | "auto" | "disabled" | undefined
  autoshare?: boolean | undefined
  autoupdate?: boolean | "notify" | undefined
  disabled_providers?: Array<string> | undefined
  enabled_providers?: Array<string> | undefined
  model?: string | undefined
  small_model?: string | undefined
  default_agent?: string | undefined
  username?: string | undefined
  mode?:
    | ({ build?: AgentConfig1 | undefined; plan?: AgentConfig1 | undefined } & {
        [x: string]: AgentConfig1 | undefined
      })
    | undefined
  agent?:
    | ({
        plan?: AgentConfig1 | undefined
        build?: AgentConfig1 | undefined
        general?: AgentConfig1 | undefined
        explore?: AgentConfig1 | undefined
        scout?: AgentConfig1 | undefined
        title?: AgentConfig1 | undefined
        summary?: AgentConfig1 | undefined
        compaction?: AgentConfig1 | undefined
      } & { [x: string]: AgentConfig1 | undefined })
    | undefined
  provider?: { [x: string]: ProviderConfig1 } | undefined
  mcp?: { [x: string]: McpLocalConfig1 | McpRemoteConfig1 | { enabled: boolean } } | undefined
  connectors?:
    | {
        [x: string]:
          | ConnectorFigma1
          | ConnectorSlack1
          | ConnectorGithub1
          | ConnectorLovable1
          | ConnectorDiscord1
          | ConnectorTeams1
          | ConnectorGChat1
          | ConnectorLinear1
          | { enabled: boolean }
      }
    | undefined
  formatter?:
    | false
    | true
    | {
        [x: string]: {
          disabled?: boolean | undefined
          command?: Array<string> | undefined
          environment?: { [x: string]: string } | undefined
          extensions?: Array<string> | undefined
        }
      }
    | undefined
  websearch?:
    | {
        provider?: "exa" | "parallel" | "mcp" | undefined
        apiKey?: string | undefined
        url?: string | undefined
        tool?: string | undefined
      }
    | undefined
  lsp?:
    | false
    | {
        [x: string]:
          | { disabled: true }
          | {
              command: Array<string>
              extensions?: Array<string> | undefined
              disabled?: boolean | undefined
              env?: { [x: string]: string } | undefined
              initialization?: { [x: string]: any } | undefined
              min_severity?: number | undefined
            }
      }
    | undefined
  instructions?: Array<string> | undefined
  layout?: LayoutConfig1 | undefined
  permission?: PermissionConfig | undefined
  permission_mode?: PermissionModeConfig1 | undefined
  auto_mode?: AutoModeConfig1 | undefined
  tools?: { [x: string]: boolean } | undefined
  tool?: { allow?: Array<string> | undefined; pin?: { [x: string]: string } | undefined } | undefined
  enterprise?: { url?: string | undefined } | undefined
  compaction?: { auto?: boolean | undefined; prune?: boolean | undefined; reserved?: number | undefined } | undefined
  experimental?:
    | {
        policies?: Array<PolicyStatementConfig1> | undefined
        hook?:
          | {
              file_edited?:
                | { [x: string]: Array<{ command: Array<string>; environment?: { [x: string]: string } | undefined }> }
                | undefined
              session_completed?:
                | Array<{ command: Array<string>; environment?: { [x: string]: string } | undefined }>
                | undefined
            }
          | undefined
        queued_message_wrap?: { header: string; footer: string } | "default" | boolean | null | undefined
        chatMaxRetries?: number | undefined
        disable_paste_summary?: boolean | undefined
        batch_tool?: boolean | undefined
        openTelemetry?: boolean | undefined
        primary_tools?: Array<string> | undefined
        continue_loop_on_deny?: boolean | undefined
        brain?: boolean | undefined
        brainMinHours?: number | undefined
        brainMinSessions?: number | undefined
        brainModel?: string | undefined
        memory?: boolean | undefined
        mcp_timeout?: number | undefined
        tool_timeout?: number | false | undefined
        task_timeout?: number | false | undefined
        nativeLlm?: boolean | undefined
        tui?:
          | {
              cacheEviction?: boolean | undefined
              messageVirtualization?: boolean | undefined
              explorationGrouping?: boolean | undefined
            }
          | undefined
        requests?: { latestOnlyLspRefresh?: boolean | undefined } | undefined
        events?: { schemaEncoding?: boolean | undefined } | undefined
      }
    | undefined
  rag?: RagConfig1 | undefined
  image?: ImageConfig1 | undefined
  browser?: unknown | undefined
  computer?: ComputerConfig1 | undefined
  attachment?: AttachmentConfig1 | undefined
  speak?: SpeakConfig1 | undefined
  notifications?:
    | {
        todo?:
          | {
              enabled?: boolean | undefined
              macos?: boolean | undefined
              slack?:
                | { enabled?: boolean | undefined; connector?: string | undefined; channel?: string | undefined }
                | undefined
              discord?: { enabled?: boolean | undefined; webhook?: string | undefined } | undefined
            }
          | undefined
        icon?: { url?: string | undefined; alt?: string | undefined } | undefined
        notify?:
          | {
              enabled?: boolean | undefined
              macos?: boolean | undefined
              slack?:
                | { enabled?: boolean | undefined; connector?: string | undefined; channel?: string | undefined }
                | undefined
              discord?: { enabled?: boolean | undefined; webhook?: string | undefined } | undefined
              events?:
                | {
                    sessionIdle?: boolean | undefined
                    sessionError?: boolean | undefined
                    permissionAsked?: boolean | undefined
                    questionAsked?: boolean | undefined
                  }
                | undefined
              idleMinMs?: number | undefined
              rateLimit?: { windowMs?: number | undefined; maxPerWindow?: number | undefined } | undefined
              retry?:
                | {
                    attempts?: number | undefined
                    delay?: number | undefined
                    factor?: number | undefined
                    maxDelay?: number | undefined
                    timeoutMs?: number | undefined
                  }
                | undefined
              breaker?: { failures?: number | undefined; cooldownMs?: number | undefined } | undefined
              quietHours?:
                | {
                    enabled?: boolean | undefined
                    start?: string | undefined
                    end?: string | undefined
                    suppress?: Array<"macos" | "slack" | "discord"> | undefined
                  }
                | undefined
            }
          | undefined
      }
    | undefined
  mobile?:
    | {
        tophat?:
          | {
              enabled?: boolean | undefined
              cliPath?: string | undefined
              defaultPlatform?: "ios" | "android" | undefined
              defaultDestination?: "device" | "simulator" | "emulator" | undefined
              autoDetect?: boolean | undefined
            }
          | undefined
      }
    | undefined
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export type EventMessageUpdated = { type: "message.updated"; properties: { info: Message2 } }

export type ToolState1 = ToolStatePending1 | ToolStateRunning1 | ToolStateCompleted1 | ToolStateError1

export type SessionPendingPromptInput = {
  sessionID: string
  messageID?: string
  delivery?: "steer" | "queue"
  model?: { providerID: string; modelID: string }
  agent?: string
  noReply?: boolean
  tools?: { [x: string]: boolean }
  format?: OutputFormat1
  system?: string
  variant?: string
  parts: Array<PromptPartInput>
}

export type ToolState2 = ToolStatePending1 | ToolStateRunning2 | ToolStateCompleted2 | ToolStateError2

export type ToolPart = {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  metadata?: { [x: string]: any } | undefined
}

export type ToolPart1 = {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: ToolState1
  metadata?: { [x: string]: any }
}

export type SessionPendingInput2 = {
  id: string
  sessionID: string
  delivery: "steer" | "queue"
  messageID: string
  data: SessionPendingPromptInput
  createdAt: number
}

export type ToolPart2 = {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: ToolState2
  metadata?: { [x: string]: any }
}

export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

export type Part1 =
  | TextPart1
  | SubtaskPart1
  | ReasoningPart1
  | FilePart2
  | ToolPart1
  | StepStartPart1
  | StepFinishPart1
  | SnapshotPart1
  | PatchPart1
  | AgentPart1
  | RetryPart1
  | CompactionPart1

export type SessionPendingInputList = Array<SessionPendingInput2>

export type Part2 =
  | TextPart2
  | SubtaskPart1
  | ReasoningPart2
  | FilePart3
  | ToolPart2
  | StepStartPart1
  | StepFinishPart2
  | SnapshotPart1
  | PatchPart1
  | AgentPart1
  | RetryPart2
  | CompactionPart1

export type MobileSessionDetail = {
  info: Session3
  status?: SessionStatus1 | undefined
  messages: Array<{ info: Message; parts: Array<Part> }>
  artifacts: Array<MobileArtifact>
  permissions: Array<PermissionRequest>
  questions: Array<QuestionRequest>
}

export type MessageWithParts = { info: Message1; parts: Array<Part1> }

export type MessageList = Array<{ info: Message1; parts: Array<Part1> }>

export type SessionPromptResponse = { info: Message1; parts: Array<Part1> }

export type ShareData = Array<
  | { type: "session"; data: Session2 }
  | { type: "message"; data: Message1 }
  | { type: "part"; data: Part1 }
  | { type: "session_diff"; data: Array<FileDiff2> }
  | { type: "model"; data: Array<Model> }
>

export type EventMessagePartUpdated = { type: "message.part.updated"; properties: { part: Part2; delta?: string } }

export type Event =
  | EventProjectUpdated
  | EventTelemetryRecord
  | EventServerInstanceDisposed
  | EventPermissionAsked
  | EventPermissionReplied
  | EventPermissionBlocked
  | EventQuestionAsked
  | EventQuestionReplied
  | EventQuestionRejected
  | EventInstallationUpdated
  | EventInstallationUpdateAvailable
  | EventServerConnected
  | EventGlobalDisposed
  | EventLspUpdated
  | EventMessageUpdated
  | EventMessageRemoved
  | EventMessagePartUpdated
  | EventMessagePartRemoved
  | EventSessionCreated
  | EventSessionUpdated
  | EventSessionDeleted
  | EventSessionDiff
  | EventSessionError
  | EventSessionPendingPromoted
  | EventSessionInstructionsUpdated
  | EventTuiPromptAppend
  | EventTuiCommandExecute
  | EventTuiToastShow
  | EventTuiSessionSelect
  | EventMcpToolsChanged
  | EventFileWatcherUpdated
  | EventVcsBranchUpdated
  | EventTodoUpdated
  | EventSessionStatus
  | EventSessionIdle
  | EventSessionCompacted
  | EventSessionGoal
  | EventIdeInstalled
  | EventPtyCreated
  | EventPtyUpdated
  | EventPtyExited
  | EventPtyDeleted
  | EventSessionV2Updated
  | EventSessionEntryUpdated
  | EventSessionEntryRemoved
  | EventFileEdited
  | EventMonitorCreated
  | EventMonitorUpdated
  | EventMonitorOutput
  | EventMonitorCompleted
  | EventLoopUpserted
  | EventLoopRemoved
  | EventLoopRunStarted
  | EventLoopRunFinished
  | EventLoopRuntimeChanged
  | EventMissionUpserted
  | EventMissionRemoved
  | EventMissionStarted
  | EventMissionFinished
  | EventMissionExecStarted
  | EventMissionExecFinished
  | EventMissionRuntimeChanged
  | EventMissionAborted
  | EventWorkspaceStatus
  | EventWorkspaceReady
  | EventWorkspaceFailed
  | EventDelegationCompleted

export type Event1 =
  | EventProjectUpdated
  | EventTelemetryRecord
  | EventServerInstanceDisposed
  | EventPermissionAsked
  | EventPermissionReplied
  | EventPermissionBlocked
  | EventQuestionAsked
  | EventQuestionReplied
  | EventQuestionRejected
  | EventInstallationUpdated
  | EventInstallationUpdateAvailable
  | EventServerConnected
  | EventGlobalDisposed
  | EventLspUpdated
  | EventMessageUpdated
  | EventMessageRemoved
  | EventMessagePartUpdated
  | EventMessagePartRemoved
  | EventSessionCreated
  | EventSessionUpdated
  | EventSessionDeleted
  | EventSessionDiff
  | EventSessionError
  | EventSessionPendingPromoted
  | EventSessionInstructionsUpdated
  | EventTuiPromptAppend
  | EventTuiCommandExecute
  | EventTuiToastShow
  | EventTuiSessionSelect
  | EventMcpToolsChanged
  | EventFileWatcherUpdated
  | EventVcsBranchUpdated
  | EventTodoUpdated
  | EventSessionStatus
  | EventSessionIdle
  | EventSessionCompacted
  | EventSessionGoal
  | EventIdeInstalled
  | EventPtyCreated
  | EventPtyUpdated
  | EventPtyExited
  | EventPtyDeleted
  | EventSessionV2Updated
  | EventSessionEntryUpdated
  | EventSessionEntryRemoved
  | EventFileEdited
  | EventMonitorCreated
  | EventMonitorUpdated
  | EventMonitorOutput
  | EventMonitorCompleted
  | EventLoopUpserted
  | EventLoopRemoved
  | EventLoopRunStarted
  | EventLoopRunFinished
  | EventLoopRuntimeChanged
  | EventMissionUpserted
  | EventMissionRemoved
  | EventMissionStarted
  | EventMissionFinished
  | EventMissionExecStarted
  | EventMissionExecFinished
  | EventMissionRuntimeChanged
  | EventMissionAborted
  | EventWorkspaceStatus
  | EventWorkspaceReady
  | EventWorkspaceFailed
  | EventDelegationCompleted

export type GlobalEvent = { directory: string; payload: Event1 }

export type VcsApplyError = {
  readonly name: "VcsApplyError"
  readonly data: { readonly message: string; readonly reason: string }
}

export type AnalyticsSessionNotFound = { readonly error: "Session not found" }

export type DiscordValidationError = { readonly name: "ValidationError"; readonly data: { readonly [x: string]: any } }

export type ConfigUpdateError = { readonly name: string; readonly data: { readonly [x: string]: any } }

export type ConnectorsValidationError = {
  readonly name: "ValidationError"
  readonly data: { readonly [x: string]: any }
}

export type McpOAuthUnsupportedError = { readonly error: string }

export type MissionValidationError = { readonly name: "ValidationError"; readonly data: { readonly [x: string]: any } }

export type MissionNotFound = { readonly name: "NotFound"; readonly data: { readonly [x: string]: any } }

export type MobileNotFound = { readonly name: "NotFoundError"; readonly error: string }

export type MobileUnauthorized = { readonly name: "Unauthorized"; readonly error: string }

export type MobileBadRequest = { readonly name: "BadRequest"; readonly error: string }

export type PtyCreateErrorBody = { readonly name: "PtyCreateError"; readonly data: { readonly [x: string]: any } }

export type PtyNotFoundError = { readonly name: "NotFoundError"; readonly data: { readonly [x: string]: any } }

export type LoopValidationError = { readonly name: "ValidationError"; readonly data: { readonly [x: string]: any } }

export type LoopNotFound = { readonly name: "NotFound"; readonly data: { readonly [x: string]: any } }

export type SessionNotFoundError = { readonly name: "NotFoundError"; readonly data: { readonly [x: string]: any } }

export type SessionBusyErrorBody = { readonly name: "SessionBusyError"; readonly data: { readonly [x: string]: any } }

export type SessionPartMismatchError = {
  readonly name: "PartMismatchError"
  readonly data: { readonly [x: string]: any }
}

export type SessionBackgroundNotFound = { readonly error: "Session not found" }

export type AccountError = { readonly error: string }

export type SyncRateLimited = { readonly headers: { readonly "retry-after": string } }

export type UnauthorizedChallenge = { readonly headers: { readonly "www-authenticate"?: string | undefined } }

export type TuiValidationError = { readonly data: unknown; readonly error: unknown; readonly success: false }

export type TuiNotFoundError = { readonly name: "NotFoundError"; readonly data: { readonly [x: string]: any } }

export type TopLevelVcsApplyPayload = { readonly patch: string }

export type AppLogPayload = {
  readonly service: string
  readonly level: "debug" | "info" | "error" | "warn"
  readonly message: string
  readonly extra?: { readonly [x: string]: any } | undefined
}

export type AppSkillCreatePayload = {
  readonly name: string
  readonly description: string
  readonly category?: string | undefined
  readonly tags?: ReadonlyArray<string> | undefined
  readonly content?: string | undefined
  readonly scope?: "workspace" | "global" | undefined
}

export type BrainTriggerPayload = { readonly force?: boolean | undefined; readonly sessionID?: string | undefined }

export type DiscordSetupPayload = { readonly botToken: string }

export type VoiceTranscribePayload = { readonly audio: string; readonly format?: string | undefined }

export type ProfilePatchPayload = {
  readonly name?: string | undefined
  readonly role?: string | undefined
  readonly about?: string | undefined
  readonly stack?: ReadonlyArray<string> | undefined
  readonly expertise?: ReadonlyArray<string> | undefined
  readonly learning?: ReadonlyArray<string> | undefined
  readonly skills?: ReadonlyArray<string> | undefined
  readonly tools?:
    | { readonly preferred?: ReadonlyArray<string> | undefined; readonly avoid?: ReadonlyArray<string> | undefined }
    | undefined
  readonly conventions?: ReadonlyArray<string> | undefined
  readonly communication?:
    | {
        readonly verbosity?: "concise" | "balanced" | "detailed" | undefined
        readonly language?: string | undefined
        readonly explain?: boolean | undefined
      }
    | undefined
  readonly custom?: string | undefined
  readonly habits?: boolean | undefined
}

export type ConnectorsAuthSetPayload = {
  readonly token?: string
  readonly botToken?: string
  readonly apiKey?: string
  readonly teamId?: string
  readonly expiresAt?: number
  readonly refreshToken?: string
  readonly refreshTokenExpiresAt?: number
}

export type ConnectorsInvalidatePayload = { readonly name?: string }

export type ExperimentalWorktreeCreatePayload = {
  readonly name?: string | undefined
  readonly branch?: string | undefined
  readonly branchPrefix?: string | undefined
  readonly baseBranch?: string | undefined
  readonly remote?: string | undefined
  readonly startCommand?: string | undefined
}

export type ExperimentalWorktreeRemovePayload = { readonly directory: string }

export type ExperimentalWorktreeResetPayload = { readonly directory: string }

export type ExperimentalManagedWorktreeCreatePayload = {
  readonly from: string
  readonly name?: string | undefined
  readonly into?: string | undefined
}

export type ExperimentalManagedWorktreeRemovePayload = { readonly at: string }

export type ExperimentalManagedWorktreeLinkPayload = { readonly at: string; readonly to?: string | undefined }

export type FileWritePayload = { readonly path: string; readonly content: string }

export type McpAddPayload = {
  readonly name: string
  readonly config:
    | {
        readonly type: "local"
        readonly command: ReadonlyArray<string>
        readonly environment?: { readonly [x: string]: string } | undefined
        readonly enabled?: boolean | undefined
        readonly timeout?: number | undefined
      }
    | {
        readonly type: "remote"
        readonly url: string
        readonly enabled?: boolean | undefined
        readonly headers?: { readonly [x: string]: string } | undefined
        readonly oauth?:
          | {
              readonly clientId?: string | undefined
              readonly clientSecret?: string | undefined
              readonly scope?: string | undefined
            }
          | false
          | undefined
        readonly timeout?: number | undefined
      }
}

export type McpAuthCallbackPayload = { readonly code: string }

export type McpTogglePayload = { readonly enabled: boolean }

export type MissionGeneratePayload = {
  readonly description: string
  readonly model?: string
  readonly agent?: string
  readonly sessionID?: string
}

export type MissionUpsertPayload = {
  readonly name: string
  readonly brief: string
  readonly milestones: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly features: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly objective: string
      readonly agent: string
      readonly model?: string | undefined
      readonly tokenBudget?: number | undefined
      readonly dependsOn?: ReadonlyArray<string> | undefined
      readonly status?: "pending" | "running" | "done" | "blocked" | "skipped" | "error" | undefined
      readonly error?: string | undefined
    }>
    readonly validation?: "scrutiny" | "user-test" | "none" | undefined
    readonly status?: "pending" | "running" | "validating" | "done" | "blocked" | undefined
  }>
  readonly models?:
    | {
        readonly worker?: string | undefined
        readonly validation?: string | undefined
        readonly orchestrator?: string | undefined
      }
    | undefined
  readonly timeoutMs?: number | undefined
  readonly sandbox?: boolean | undefined
  readonly worktree?:
    | { readonly name: string; readonly branch?: string | undefined; readonly directory: string }
    | undefined
}

export type MissionUpdatePayload = {
  readonly name: string
  readonly brief: string
  readonly milestones: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly features: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly objective: string
      readonly agent: string
      readonly model?: string | undefined
      readonly tokenBudget?: number | undefined
      readonly dependsOn?: ReadonlyArray<string> | undefined
      readonly status?: "pending" | "running" | "done" | "blocked" | "skipped" | "error" | undefined
      readonly error?: string | undefined
    }>
    readonly validation?: "scrutiny" | "user-test" | "none" | undefined
    readonly status?: "pending" | "running" | "validating" | "done" | "blocked" | undefined
  }>
  readonly models?:
    | {
        readonly worker?: string | undefined
        readonly validation?: string | undefined
        readonly orchestrator?: string | undefined
      }
    | undefined
  readonly timeoutMs?: number | undefined
  readonly sandbox?: boolean | undefined
  readonly worktree?:
    | { readonly name: string; readonly branch?: string | undefined; readonly directory: string }
    | undefined
  readonly status?: "planning" | "ready" | "running" | "paused" | "frozen" | "complete" | "error" | undefined
  readonly createdAt: number
}

export type MissionStartPayload = { readonly sessionID?: string | undefined }

export type MissionFeatureMutatePayload = {
  readonly status?: "pending" | "running" | "done" | "blocked" | "skipped" | "error" | undefined
  readonly error?: string | undefined
  readonly appendDependsOn?: ReadonlyArray<string> | undefined
}

export type MobileAuthTokenCreatePayload = { readonly name?: string; readonly expiresInDays?: number }

export type MobileMemoryStashCreatePayload = { readonly input: string }

export type MobileGithubWorkflowRunRerunPayload = { readonly failedOnly?: boolean | undefined }

export type MobileGithubWorkflowDispatchPayload = {
  readonly ref: string
  readonly inputs?: { readonly [x: string]: string } | undefined
}

export type MobileGithubOauthClientPayload = { readonly clientId: string }

export type MobileGithubOauthDevicePollPayload = { readonly deviceCode: string }

export type MobileGithubAuthSetPayload = { readonly token: string }

export type MobileGithubImportPayload = {
  readonly owner: string
  readonly repo: string
  readonly cloneUrl: string
  readonly defaultBranch: string
  readonly private?: boolean | undefined
}

export type MobileGithubSessionCreatePayload = {
  readonly owner: string
  readonly repo: string
  readonly cloneUrl: string
  readonly htmlUrl?: string | undefined
  readonly defaultBranch: string
  readonly baseBranch: string
  readonly private?: boolean | undefined
  readonly title?: string | undefined
  readonly executionTarget?: ("local" | "container") | undefined
}

export type MobileSessionCreatePayload = {
  readonly parentID?: string | undefined
  readonly title?: string | undefined
  readonly permission?:
    | ReadonlyArray<{
        readonly permission: string
        readonly pattern: string
        readonly action: "allow" | "deny" | "ask"
      }>
    | undefined
  readonly github?:
    | {
        readonly owner: string
        readonly repo: string
        readonly fullName: string
        readonly baseBranch: string
        readonly headBranch: string
        readonly repositoryDirectory?: string | undefined
        readonly cloneUrl?: string | undefined
        readonly htmlUrl?: string | undefined
        readonly private?: boolean | undefined
        readonly worktree: {
          readonly name: string
          readonly branch: string
          readonly directory: string
          readonly repositoryDirectory?: string | undefined
          readonly cleanedAt?: number | undefined
        }
        readonly pullRequest?: { readonly number: number; readonly url: string; readonly title: string } | undefined
        readonly lastCommitSha?: string | undefined
        readonly publishedAt?: number | undefined
        readonly publishError?: string | undefined
      }
    | undefined
  readonly executionTarget?: ("local" | "container") | undefined
}

export type MobileSessionCommandPayload = {
  readonly command: string
  readonly arguments?: string | undefined
  readonly agent?: string | undefined
  readonly model?: { readonly providerID: string; readonly modelID: string } | undefined
  readonly variant?: string | undefined
}

export type MobileSessionMessagePayload = {
  readonly messageID?: string | undefined
  readonly delivery?: "steer" | "queue" | undefined
  readonly model?: { readonly providerID: string; readonly modelID: string } | undefined
  readonly agent?: string | undefined
  readonly noReply?: boolean | undefined
  readonly tools?: { readonly [x: string]: boolean } | undefined
  readonly format?:
    | (
        | { readonly type: "text" }
        | {
            readonly type: "json_schema"
            readonly schema: { readonly [x: string]: any }
            readonly retryCount?: number | undefined
          }
      )
    | undefined
  readonly system?: string | undefined
  readonly variant?: string | undefined
  readonly parts: ReadonlyArray<
    | {
        readonly id?: string | undefined
        readonly type: "text"
        readonly text: string
        readonly synthetic?: boolean | undefined
        readonly ignored?: boolean | undefined
        readonly time?: { readonly start: number; readonly end?: number | undefined } | undefined
        readonly metadata?: { readonly [x: string]: any } | undefined
      }
    | {
        readonly id?: string | undefined
        readonly type: "file"
        readonly mime: string
        readonly filename?: string | undefined
        readonly url: string
        readonly source?:
          | (
              | {
                  readonly text: { readonly value: string; readonly start: number; readonly end: number }
                  readonly type: "file"
                  readonly path: string
                }
              | {
                  readonly text: { readonly value: string; readonly start: number; readonly end: number }
                  readonly type: "symbol"
                  readonly path: string
                  readonly range: {
                    readonly start: { readonly line: number; readonly character: number }
                    readonly end: { readonly line: number; readonly character: number }
                  }
                  readonly name: string
                  readonly kind: number
                }
              | {
                  readonly text: { readonly value: string; readonly start: number; readonly end: number }
                  readonly type: "resource"
                  readonly clientName: string
                  readonly uri: string
                }
            )
          | undefined
      }
    | {
        readonly id?: string | undefined
        readonly type: "agent"
        readonly name: string
        readonly source?: { readonly value: string; readonly start: number; readonly end: number } | undefined
      }
    | {
        readonly id?: string | undefined
        readonly type: "subtask"
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly providerID: string; readonly modelID: string } | undefined
        readonly command?: string | undefined
        readonly background?: boolean | undefined
      }
  >
  readonly parentSessionID?: string | undefined
}

export type MobilePermissionRespondPayload = { readonly response: "once" | "always" | "reject" }

export type MobileQuestionRespondPayload = { readonly answers: ReadonlyArray<ReadonlyArray<string>> }

export type MobileSessionPublishPayload = {
  readonly title?: string | undefined
  readonly body?: string | undefined
  readonly commitMessage?: string | undefined
}

export type MobileSessionRenamePayload = { readonly title: string }

export type MobileTeleportInPayload = {
  readonly title?: string | undefined
  readonly name?: string | undefined
  readonly origin?: string | undefined
  readonly permission?:
    | ReadonlyArray<{
        readonly permission: string
        readonly pattern: string
        readonly action: "allow" | "deny" | "ask"
      }>
    | undefined
  readonly messages: ReadonlyArray<{
    readonly info:
      | {
          readonly id: string
          readonly sessionID: string
          readonly role: "user"
          readonly time: { readonly created: number }
          readonly format?:
            | (
                | { readonly type: "text" }
                | {
                    readonly type: "json_schema"
                    readonly schema: { readonly [x: string]: any }
                    readonly retryCount?: number | undefined
                  }
              )
            | undefined
          readonly summary?:
            | {
                readonly title?: string | undefined
                readonly body?: string | undefined
                readonly diffs: ReadonlyArray<{
                  readonly file: string
                  readonly patch: string
                  readonly additions: number
                  readonly deletions: number
                  readonly status?: "added" | "deleted" | "modified" | undefined
                  readonly before: string
                  readonly after: string
                }>
              }
            | undefined
          readonly agent: string
          readonly model: { readonly providerID: string; readonly modelID: string }
          readonly system?: string | undefined
          readonly tools?: { readonly [x: string]: boolean } | undefined
          readonly variant?: string | undefined
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly role: "assistant"
          readonly time: { readonly created: number; readonly completed?: number | undefined }
          readonly error?:
            | {
                readonly name: "ProviderAuthError"
                readonly data: { readonly providerID: string; readonly message: string }
              }
            | { readonly name: "UnknownError"; readonly data: { readonly message: string } }
            | { readonly name: "MessageOutputLengthError"; readonly data: {} }
            | {
                readonly name: "MessageContextOverflowError"
                readonly data: {
                  readonly message: string
                  readonly statusCode?: number | undefined
                  readonly responseBody?: string | undefined
                }
              }
            | { readonly name: "MessageAbortedError"; readonly data: { readonly message: string } }
            | {
                readonly name: "StructuredOutputError"
                readonly data: { readonly message: string; readonly retries: number }
              }
            | {
                readonly name: "APIError"
                readonly data: {
                  readonly message: string
                  readonly statusCode?: number | undefined
                  readonly isRetryable: boolean
                  readonly responseHeaders?: { readonly [x: string]: string } | undefined
                  readonly responseBody?: string | undefined
                  readonly metadata?: { readonly [x: string]: string } | undefined
                  readonly classification?: "payload-too-large" | undefined
                }
              }
            | undefined
          readonly parentID: string
          readonly modelID: string
          readonly providerID: string
          readonly mode: string
          readonly agent: string
          readonly path: { readonly cwd: string; readonly root: string }
          readonly summary?: boolean | undefined
          readonly cost: number
          readonly tokens: {
            readonly total?: number | undefined
            readonly input: number
            readonly output: number
            readonly reasoning: number
            readonly cache: { readonly read: number; readonly write: number }
          }
          readonly structured?: unknown | undefined
          readonly finish?: string | undefined
        }
    readonly parts: ReadonlyArray<
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "text"
          readonly text: string
          readonly synthetic?: boolean | undefined
          readonly ignored?: boolean | undefined
          readonly time?: { readonly start: number; readonly end?: number | undefined } | undefined
          readonly metadata?: { readonly [x: string]: any } | undefined
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "subtask"
          readonly prompt: string
          readonly description: string
          readonly agent: string
          readonly model?: { readonly providerID: string; readonly modelID: string } | undefined
          readonly command?: string | undefined
          readonly background?: boolean | undefined
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "reasoning"
          readonly text: string
          readonly metadata?: { readonly [x: string]: any } | undefined
          readonly time: { readonly start: number; readonly end?: number | undefined }
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "file"
          readonly mime: string
          readonly filename?: string | undefined
          readonly url: string
          readonly source?:
            | (
                | {
                    readonly text: { readonly value: string; readonly start: number; readonly end: number }
                    readonly type: "file"
                    readonly path: string
                  }
                | {
                    readonly text: { readonly value: string; readonly start: number; readonly end: number }
                    readonly type: "symbol"
                    readonly path: string
                    readonly range: {
                      readonly start: { readonly line: number; readonly character: number }
                      readonly end: { readonly line: number; readonly character: number }
                    }
                    readonly name: string
                    readonly kind: number
                  }
                | {
                    readonly text: { readonly value: string; readonly start: number; readonly end: number }
                    readonly type: "resource"
                    readonly clientName: string
                    readonly uri: string
                  }
              )
            | undefined
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "tool"
          readonly callID: string
          readonly tool: string
          readonly state:
            | { readonly status: "pending"; readonly input: { readonly [x: string]: any }; readonly raw: string }
            | {
                readonly status: "running"
                readonly input: { readonly [x: string]: any }
                readonly title?: string | undefined
                readonly metadata?: { readonly [x: string]: any } | undefined
                readonly structured?: { readonly [x: string]: any } | undefined
                readonly content?:
                  | ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | {
                          readonly type: "file"
                          readonly data: string
                          readonly mime: string
                          readonly name?: string | undefined
                        }
                    >
                  | undefined
                readonly time: { readonly start: number }
              }
            | {
                readonly status: "completed"
                readonly input: { readonly [x: string]: any }
                readonly output: string
                readonly title: string
                readonly metadata: { readonly [x: string]: any }
                readonly time: { readonly start: number; readonly end: number; readonly compacted?: number | undefined }
                readonly attachments?:
                  | ReadonlyArray<{
                      readonly id: string
                      readonly sessionID: string
                      readonly messageID: string
                      readonly type: "file"
                      readonly mime: string
                      readonly filename?: string | undefined
                      readonly url: string
                      readonly source?:
                        | (
                            | {
                                readonly text: { readonly value: string; readonly start: number; readonly end: number }
                                readonly type: "file"
                                readonly path: string
                              }
                            | {
                                readonly text: { readonly value: string; readonly start: number; readonly end: number }
                                readonly type: "symbol"
                                readonly path: string
                                readonly range: {
                                  readonly start: { readonly line: number; readonly character: number }
                                  readonly end: { readonly line: number; readonly character: number }
                                }
                                readonly name: string
                                readonly kind: number
                              }
                            | {
                                readonly text: { readonly value: string; readonly start: number; readonly end: number }
                                readonly type: "resource"
                                readonly clientName: string
                                readonly uri: string
                              }
                          )
                        | undefined
                    }>
                  | undefined
              }
            | {
                readonly status: "error"
                readonly input: { readonly [x: string]: any }
                readonly error: string
                readonly metadata?: { readonly [x: string]: any } | undefined
                readonly time: { readonly start: number; readonly end: number }
              }
          readonly metadata?: { readonly [x: string]: any } | undefined
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "step-start"
          readonly snapshot?: string | undefined
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "step-finish"
          readonly reason: string
          readonly snapshot?: string | undefined
          readonly cost: number
          readonly tokens: {
            readonly total?: number | undefined
            readonly input: number
            readonly output: number
            readonly reasoning: number
            readonly cache: { readonly read: number; readonly write: number }
          }
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "snapshot"
          readonly snapshot: string
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "patch"
          readonly hash: string
          readonly files: ReadonlyArray<string>
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "agent"
          readonly name: string
          readonly source?: { readonly value: string; readonly start: number; readonly end: number } | undefined
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "retry"
          readonly attempt: number
          readonly error: {
            readonly name: "APIError"
            readonly data: {
              readonly message: string
              readonly statusCode?: number | undefined
              readonly isRetryable: boolean
              readonly responseHeaders?: { readonly [x: string]: string } | undefined
              readonly responseBody?: string | undefined
              readonly metadata?: { readonly [x: string]: string } | undefined
              readonly classification?: "payload-too-large" | undefined
            }
          }
          readonly time: { readonly created: number }
        }
      | {
          readonly id: string
          readonly sessionID: string
          readonly messageID: string
          readonly type: "compaction"
          readonly auto: boolean
        }
    >
  }>
  readonly uploadID?: string | undefined
}

export type MobileTeleportOutPayload = {
  readonly url: string
  readonly token: string
  readonly content?: boolean | undefined
  readonly includeGit?: boolean | undefined
}

export type MobileWorktreeCreatePayload = {
  readonly name?: string | undefined
  readonly branch?: string | undefined
  readonly branchPrefix?: string | undefined
  readonly baseBranch?: string | undefined
  readonly remote?: string | undefined
  readonly startCommand?: string | undefined
  readonly detached?: boolean | undefined
  readonly sourceDirectory?: string | undefined
  readonly root?: string | undefined
}

export type MobileWorktreeRemovePayload = { readonly directory: string; readonly force?: boolean | undefined }

export type MobileWorktreeResetPayload = { readonly directory: string }

export type MobileGitCommitPayload = {
  readonly message: string
  readonly files?: ReadonlyArray<string> | undefined
  readonly amend?: boolean | undefined
  readonly stagedOnly?: boolean | undefined
}

export type MobileGitCheckoutPayload = { readonly branch: string; readonly create?: boolean | undefined }

export type MobileGitStagePayload = { readonly files: ReadonlyArray<string> }

export type MobileGitUnstagePayload = { readonly files: ReadonlyArray<string> }

export type MobileGitDiscardPayload = { readonly files: ReadonlyArray<string> }

export type MobileLoopCreatePayload = {
  readonly name: string
  readonly stages: ReadonlyArray<{
    readonly name: string
    readonly agent: string
    readonly model?: string | undefined
    readonly objective: string
    readonly tokenBudget?: number | undefined
  }>
  readonly trigger: { readonly kind: "manual" } | { readonly kind: "interval"; readonly everyMs: number }
  readonly maxRuns?: number | undefined
  readonly timeoutMs?: number | undefined
  readonly createPR?: boolean | undefined
  readonly sandbox?: boolean | undefined
  readonly worktree?:
    | { readonly name: string; readonly branch?: string | undefined; readonly directory: string }
    | undefined
  readonly paused?: boolean | undefined
  readonly enabled: boolean
}

export type MobileLoopGeneratePayload = {
  readonly description: string
  readonly model?: string | undefined
  readonly agent?: string | undefined
  readonly sessionID?: string | undefined
}

export type MobileLoopUpdatePayload = {
  readonly name: string
  readonly stages: ReadonlyArray<{
    readonly name: string
    readonly agent: string
    readonly model?: string | undefined
    readonly objective: string
    readonly tokenBudget?: number | undefined
  }>
  readonly trigger: { readonly kind: "manual" } | { readonly kind: "interval"; readonly everyMs: number }
  readonly maxRuns?: number | undefined
  readonly timeoutMs?: number | undefined
  readonly createPR?: boolean | undefined
  readonly sandbox?: boolean | undefined
  readonly worktree?:
    | { readonly name: string; readonly branch?: string | undefined; readonly directory: string }
    | undefined
  readonly paused?: boolean | undefined
  readonly enabled: boolean
}

export type MobileLoopTogglePayload = { readonly enabled: boolean }

export type MobileRoutineCreatePayload = {
  readonly name: string
  readonly prompt: string
  readonly triggers?:
    | ReadonlyArray<
        | { readonly type: "schedule"; readonly cron: string; readonly enabled: boolean }
        | { readonly type: "api"; readonly token: string; readonly enabled: boolean }
      >
    | undefined
  readonly model?: { readonly providerID: string; readonly modelID: string } | undefined
}

export type MobileRoutineUpdatePayload = {
  readonly name?: string | undefined
  readonly prompt?: string | undefined
  readonly triggers?:
    | ReadonlyArray<
        | { readonly type: "schedule"; readonly cron: string; readonly enabled: boolean }
        | { readonly type: "api"; readonly token: string; readonly enabled: boolean }
      >
    | undefined
  readonly model?: { readonly providerID: string; readonly modelID: string } | undefined
  readonly paused?: boolean | undefined
}

export type MobileRoutineRunPayload = { readonly text?: string | undefined }

export type MobileRoutineTriggerPayload = { readonly text?: string | undefined }

export type MobilePtyCreatePayload = {
  readonly command?: string | undefined
  readonly args?: ReadonlyArray<string> | undefined
  readonly cwd?: string | undefined
  readonly title?: string | undefined
  readonly env?: { readonly [x: string]: string } | undefined
}

export type MobilePtyUpdatePayload = {
  readonly title?: string | undefined
  readonly size?: { readonly rows: number; readonly cols: number } | undefined
}

export type MobileMissionCreatePayload = {
  readonly name: string
  readonly brief: string
  readonly milestones: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly features: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly objective: string
      readonly agent: string
      readonly model?: string | undefined
      readonly tokenBudget?: number | undefined
      readonly dependsOn?: ReadonlyArray<string> | undefined
      readonly status?: "pending" | "running" | "done" | "blocked" | "skipped" | "error" | undefined
      readonly error?: string | undefined
    }>
    readonly validation?: "scrutiny" | "user-test" | "none" | undefined
    readonly status?: "pending" | "running" | "validating" | "done" | "blocked" | undefined
  }>
  readonly models?:
    | {
        readonly worker?: string | undefined
        readonly validation?: string | undefined
        readonly orchestrator?: string | undefined
      }
    | undefined
  readonly timeoutMs?: number | undefined
  readonly sandbox?: boolean | undefined
  readonly worktree?:
    | { readonly name: string; readonly branch?: string | undefined; readonly directory: string }
    | undefined
}

export type MobileMissionGeneratePayload = {
  readonly description: string
  readonly model?: string | undefined
  readonly agent?: string | undefined
  readonly sessionID?: string | undefined
}

export type MobileMissionUpdatePayload = {
  readonly name: string
  readonly brief: string
  readonly milestones: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly features: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly objective: string
      readonly agent: string
      readonly model?: string | undefined
      readonly tokenBudget?: number | undefined
      readonly dependsOn?: ReadonlyArray<string> | undefined
      readonly status?: "pending" | "running" | "done" | "blocked" | "skipped" | "error" | undefined
      readonly error?: string | undefined
    }>
    readonly validation?: "scrutiny" | "user-test" | "none" | undefined
    readonly status?: "pending" | "running" | "validating" | "done" | "blocked" | undefined
  }>
  readonly models?:
    | {
        readonly worker?: string | undefined
        readonly validation?: string | undefined
        readonly orchestrator?: string | undefined
      }
    | undefined
  readonly timeoutMs?: number | undefined
  readonly sandbox?: boolean | undefined
  readonly worktree?:
    | { readonly name: string; readonly branch?: string | undefined; readonly directory: string }
    | undefined
  readonly status?: "planning" | "ready" | "running" | "paused" | "frozen" | "complete" | "error" | undefined
  readonly createdAt: number
}

export type MobileMissionFeatureMutatePayload = {
  readonly status?: "pending" | "running" | "done" | "blocked" | "skipped" | "error" | undefined
  readonly error?: string | undefined
  readonly appendDependsOn?: ReadonlyArray<string> | undefined
}

export type MobileObservabilitySetPayload = { readonly enabled: boolean }

export type MobileFusionSetPayload = { readonly name: string; readonly enabled: boolean }

export type MobileHostHerdrSetPayload = { readonly enabled: boolean }

export type MobileHostLanStartPayload = { readonly mdns?: boolean }

export type ProjectUpdatePayload = {
  readonly name?: string | undefined
  readonly icon?:
    | { readonly url?: string | undefined; readonly override?: string | undefined; readonly color?: string | undefined }
    | undefined
}

export type ProjectCopyCreatePayload = {
  readonly strategy: "git_worktree"
  readonly directory: string
  readonly name?: string | undefined
}

export type ProjectCopyRemovePayload = { readonly directory: string; readonly force: boolean }

export type ProviderApiPayload = { readonly key: string }

export type ProviderOauthAuthorizePayload = { readonly method: number }

export type ProviderOauthCallbackPayload = { readonly method: number; readonly code?: string }

export type QuestionReplyPayload = { readonly answers: ReadonlyArray<ReadonlyArray<string>> }

export type PermissionReplyPayload = {
  readonly reply: "once" | "always" | "reject"
  readonly message?: string | undefined
}

export type PtyCreatePayload = {
  readonly command?: string | undefined
  readonly args?: ReadonlyArray<string> | undefined
  readonly cwd?: string | undefined
  readonly title?: string | undefined
  readonly env?: { readonly [x: string]: string } | undefined
}

export type PtyUpdatePayload = {
  readonly title?: string | undefined
  readonly size?: { readonly rows: number; readonly cols: number } | undefined
}

export type LoopGeneratePayload = {
  readonly description: string
  readonly model?: string
  readonly agent?: string
  readonly sessionID?: string
}

export type LoopUpsertPayload = {
  readonly name: string
  readonly stages: ReadonlyArray<{
    readonly name: string
    readonly agent: string
    readonly model?: string
    readonly objective: string
    readonly tokenBudget?: number
  }>
  readonly trigger: { readonly kind: "manual" } | { readonly kind: "interval"; readonly everyMs: number }
  readonly maxRuns?: number
  readonly timeoutMs?: number
  readonly createPR?: boolean
  readonly sandbox?: boolean
  readonly worktree?: { readonly name: string; readonly branch?: string; readonly directory: string }
  readonly paused?: boolean
  readonly enabled?: boolean
}

export type LoopUpdatePayload = {
  readonly name: string
  readonly stages: ReadonlyArray<{
    readonly name: string
    readonly agent: string
    readonly model?: string
    readonly objective: string
    readonly tokenBudget?: number
  }>
  readonly trigger: { readonly kind: "manual" } | { readonly kind: "interval"; readonly everyMs: number }
  readonly maxRuns?: number
  readonly timeoutMs?: number
  readonly createPR?: boolean
  readonly sandbox?: boolean
  readonly worktree?: { readonly name: string; readonly branch?: string; readonly directory: string }
  readonly paused?: boolean
  readonly enabled: boolean
  readonly createdAt: number
}

export type LoopTogglePayload = { readonly enabled: boolean }

export type LoopRunPayload = { readonly sessionID?: string }

export type SessionCreatePayload = {
  readonly parentID?: string
  readonly title?: string
  readonly permission?: ReadonlyArray<unknown>
  readonly skills?: ReadonlyArray<string>
  readonly github?: unknown
  readonly workspaceID?: string
}

export type SessionUpdatePayload = { readonly title?: string; readonly time?: { readonly archived?: number } }

export type SessionForkPayload = { readonly messageID?: string }

export type SessionRevertPayload = { readonly messageID: string; readonly partID?: string }

export type SessionSummarizePayload = { readonly providerID: string; readonly modelID: string; readonly auto?: boolean }

export type SessionCommandPayload = {
  readonly messageID?: string
  readonly delivery?: "steer" | "queue"
  readonly agent?: string
  readonly model?: string
  readonly arguments: string
  readonly command: string
  readonly variant?: string
  readonly parts?: ReadonlyArray<unknown>
}

export type SessionShellPayload = {
  readonly agent: string
  readonly model?: { readonly providerID: string; readonly modelID: string }
  readonly command: string
}

export type SessionPermissionRespondPayload = { readonly response: "once" | "always" | "reject" }

export type SessionContextTogglePayload = {
  readonly kind: "mcp" | "skill" | "instruction" | "tool"
  readonly key: string
  readonly enabled: boolean
}

export type AccountCompletePayload = { readonly deviceCode: string; readonly expiresIn?: number }

export type SyncEventPayload = {
  readonly event: {
    readonly id: string
    readonly projectId: string
    readonly workspaceId?: string | undefined
    readonly aggregate: string
    readonly seq: number
    readonly type: string
    readonly data: unknown
    readonly timestamp: number
    readonly origin?: string | undefined
    readonly originSeq?: number | undefined
  }
  readonly projectID: string
}

export type SyncConfigPayload = {
  readonly url: string
  readonly token?: string | undefined
  readonly autostart?: boolean | undefined
}

export type TuiAppendPromptPayload = { readonly text: string }

export type TuiExecuteCommandPayload = { readonly command: string }

export type TuiShowToastPayload = {
  readonly title?: string
  readonly message: string
  readonly variant: "info" | "success" | "warning" | "error"
  readonly duration: number
}

export type TuiPublishPayload = { readonly type: string; readonly properties: unknown }

export type TuiSelectSessionPayload = { readonly sessionID: string }

export type TuiControlResponsePayload = { readonly path: string; readonly body: unknown }

export type WorkspaceCreatePayload = {
  readonly branch: string | null
  readonly config:
    | {
        readonly type: "worktree"
        readonly directory: string
        readonly strategy?: "git" | "cow" | undefined
        readonly eventLimit?: number | undefined
      }
    | {
        readonly type: "container"
        readonly directory: string
        readonly runtime: "docker" | "podman"
        readonly image: string
        readonly containerName: string
        readonly port: number
        readonly serverUrl: string
        readonly eventLimit?: number | undefined
      }
    | {
        readonly type: "branch"
        readonly directory: string
        readonly branch?: string | undefined
        readonly eventLimit?: number | undefined
      }
}

export type WorkspaceWarpPayload = {
  readonly id: string | null
  readonly sessionID: string
  readonly copyChanges?: boolean | undefined
  readonly timeoutMs?: number | undefined
}

export type ConfigManagementMcpAddPayload = { readonly name: string; readonly config: unknown }

export type ConfigManagementProfileCreatePayload = { readonly name: string }

export type SessionPromptPromptPayload = {
  readonly messageID?: string
  readonly delivery?: "steer" | "queue"
  readonly model?: { readonly providerID: string; readonly modelID: string }
  readonly agent?: string
  readonly noReply?: boolean
  readonly tools?: { readonly [x: string]: boolean }
  readonly format?:
    | { readonly type: "text" }
    | { readonly type: "json_schema"; readonly schema: { readonly [x: string]: any }; readonly retryCount: number }
  readonly system?: string
  readonly variant?: string
  readonly parts: ReadonlyArray<
    | {
        readonly type: "text"
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly time?: { readonly start: number; readonly end?: number }
        readonly metadata?: { readonly [x: string]: any }
        readonly id?: string | undefined
      }
    | {
        readonly type: "file"
        readonly mime: string
        readonly filename?: string
        readonly url: string
        readonly source?:
          | {
              readonly text: { readonly value: string; readonly start: number; readonly end: number }
              readonly type: "file"
              readonly path: string
            }
          | {
              readonly text: { readonly value: string; readonly start: number; readonly end: number }
              readonly type: "symbol"
              readonly path: string
              readonly range: {
                readonly start: { readonly line: number; readonly character: number }
                readonly end: { readonly line: number; readonly character: number }
              }
              readonly name: string
              readonly kind: number
            }
          | {
              readonly text: { readonly value: string; readonly start: number; readonly end: number }
              readonly type: "resource"
              readonly clientName: string
              readonly uri: string
            }
        readonly id?: string | undefined
      }
    | {
        readonly type: "agent"
        readonly name: string
        readonly source?: { readonly value: string; readonly start: number; readonly end: number }
        readonly id?: string | undefined
      }
    | {
        readonly type: "subtask"
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly providerID: string; readonly modelID: string }
        readonly command?: string
        readonly background?: boolean
        readonly id?: string | undefined
      }
  >
}

export type SessionPromptPromptAsyncPayload = {
  readonly messageID?: string
  readonly delivery?: "steer" | "queue"
  readonly model?: { readonly providerID: string; readonly modelID: string }
  readonly agent?: string
  readonly noReply?: boolean
  readonly tools?: { readonly [x: string]: boolean }
  readonly format?:
    | { readonly type: "text" }
    | { readonly type: "json_schema"; readonly schema: { readonly [x: string]: any }; readonly retryCount: number }
  readonly system?: string
  readonly variant?: string
  readonly parts: ReadonlyArray<
    | {
        readonly type: "text"
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly time?: { readonly start: number; readonly end?: number }
        readonly metadata?: { readonly [x: string]: any }
        readonly id?: string | undefined
      }
    | {
        readonly type: "file"
        readonly mime: string
        readonly filename?: string
        readonly url: string
        readonly source?:
          | {
              readonly text: { readonly value: string; readonly start: number; readonly end: number }
              readonly type: "file"
              readonly path: string
            }
          | {
              readonly text: { readonly value: string; readonly start: number; readonly end: number }
              readonly type: "symbol"
              readonly path: string
              readonly range: {
                readonly start: { readonly line: number; readonly character: number }
                readonly end: { readonly line: number; readonly character: number }
              }
              readonly name: string
              readonly kind: number
            }
          | {
              readonly text: { readonly value: string; readonly start: number; readonly end: number }
              readonly type: "resource"
              readonly clientName: string
              readonly uri: string
            }
        readonly id?: string | undefined
      }
    | {
        readonly type: "agent"
        readonly name: string
        readonly source?: { readonly value: string; readonly start: number; readonly end: number }
        readonly id?: string | undefined
      }
    | {
        readonly type: "subtask"
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly providerID: string; readonly modelID: string }
        readonly command?: string
        readonly background?: boolean
        readonly id?: string | undefined
      }
  >
}

export type WorkspaceExtraSessionWarpPayload = {
  readonly workspaceID: string | null
  readonly copyChanges?: boolean | undefined
  readonly timeoutMs?: number | undefined
}

export type UsersRegisterPayload = {
  readonly username: string
  readonly email: string
  readonly password: string
  readonly displayName?: string | undefined
}

export type UsersLoginPayload = { readonly email: string; readonly password: string }

export type UsersUpdatePayload = {
  readonly displayName?: string | undefined
  readonly password?: string | undefined
  readonly role?: "admin" | "user" | undefined
}

export type TopLevelDisposeOutput = InstanceDisposeResult

export type TopLevelPathOutput = Path

export type TopLevelVcsOutput = VcsInfo

export type TopLevelVcsStatusOutput = Array<VcsFileStatus>

export type TopLevelVcsDiffRawOutput = string

export type TopLevelVcsApplyInput = { readonly patch: TopLevelVcsApplyPayload["patch"] }

export type TopLevelVcsApplyOutput = VcsApplyResult

export type TopLevelCommandOutput = Array<Command>

export type TopLevelAgentOutput = Array<Agent>

export type TopLevelSkillOutput = Array<Skill>

export type TopLevelLspOutput = Array<LSPStatus>

export type TopLevelFormatterOutput = Array<FormatterStatus>

export type AnalyticsGlobalOutput = AnalyticsGlobal

export type AnalyticsDailyInput = {
  readonly from?: {
    readonly from?: string | undefined
    readonly to?: string | undefined
    readonly days?: string | undefined
  }["from"]
  readonly to?: {
    readonly from?: string | undefined
    readonly to?: string | undefined
    readonly days?: string | undefined
  }["to"]
  readonly days?: {
    readonly from?: string | undefined
    readonly to?: string | undefined
    readonly days?: string | undefined
  }["days"]
}

export type AnalyticsDailyOutput = Array<AnalyticsDaily>

export type AnalyticsSessionInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type AnalyticsSessionOutput = AnalyticsSession

export type AnalyticsSessionsOutput = Array<AnalyticsSession>

export type AnalyticsLeaderboardOutput = AnalyticsLeaderboard

export type AnalyticsDataInput = {
  readonly days?: { readonly days?: string | undefined; readonly seriesDays?: string | undefined }["days"]
  readonly seriesDays?: { readonly days?: string | undefined; readonly seriesDays?: string | undefined }["seriesDays"]
}

export type AnalyticsDataOutput = AnalyticsData

export type AppLogInput = {
  readonly service: AppLogPayload["service"]
  readonly level: AppLogPayload["level"]
  readonly message: AppLogPayload["message"]
  readonly extra?: AppLogPayload["extra"]
}

export type AppLogOutput = boolean

export type AppSkillCreateInput = {
  readonly name: AppSkillCreatePayload["name"]
  readonly description: AppSkillCreatePayload["description"]
  readonly category?: AppSkillCreatePayload["category"]
  readonly tags?: AppSkillCreatePayload["tags"]
  readonly content?: AppSkillCreatePayload["content"]
  readonly scope?: AppSkillCreatePayload["scope"]
}

export type AppSkillCreateOutput = AppSkillInfo

export type AppSkillDeleteInput = { readonly name: { readonly name: string }["name"] }

export type AppSkillDeleteOutput = boolean

export type BrainStatusOutput = BrainStatus

export type BrainTriggerInput = {
  readonly force?: BrainTriggerPayload["force"]
  readonly sessionID?: BrainTriggerPayload["sessionID"]
}

export type BrainTriggerOutput = BrainResult

export type ChatbotBotsOutput = Array<ChatbotBot>

export type ChatbotStartInput = { readonly name: { readonly name: string }["name"] }

export type ChatbotStartOutput = ChatbotStartResult

export type ChatbotStopInput = { readonly name: { readonly name: string }["name"] }

export type ChatbotStopOutput = ChatbotStopResult

export type DiscordStatusOutput = DiscordStatus

export type DiscordSetupInput = { readonly botToken: DiscordSetupPayload["botToken"] }

export type DiscordSetupOutput = DiscordSetupOutput2

export type DiscordStartOutput = DiscordStartResult

export type DiscordStopOutput = DiscordStopResult

export type VoiceTranscribeInput = {
  readonly audio: VoiceTranscribePayload["audio"]
  readonly format?: VoiceTranscribePayload["format"]
}

export type VoiceTranscribeOutput = VoiceTranscribeResult

export type ProfileGetOutput = ProfileInfoOrNull

export type ProfilePatchInput = {
  readonly name?: ProfilePatchPayload["name"]
  readonly role?: ProfilePatchPayload["role"]
  readonly about?: ProfilePatchPayload["about"]
  readonly stack?: ProfilePatchPayload["stack"]
  readonly expertise?: ProfilePatchPayload["expertise"]
  readonly learning?: ProfilePatchPayload["learning"]
  readonly skills?: ProfilePatchPayload["skills"]
  readonly tools?: ProfilePatchPayload["tools"]
  readonly conventions?: ProfilePatchPayload["conventions"]
  readonly communication?: ProfilePatchPayload["communication"]
  readonly custom?: ProfilePatchPayload["custom"]
  readonly habits?: ProfilePatchPayload["habits"]
}

export type ProfilePatchOutput = ProfileInfo

export type ProfileClearOutput = ProfileDeleted

export type ProfileHabitsInput = { readonly worktree?: { readonly worktree?: string | undefined }["worktree"] }

export type ProfileHabitsOutput = ProfileHabits

export type ProfilePreviewInput = { readonly worktree?: { readonly worktree?: string | undefined }["worktree"] }

export type ProfilePreviewOutput = ProfilePreview

export type ProfileClearHabitsInput = { readonly worktree?: { readonly worktree?: string | undefined }["worktree"] }

export type ProfileClearHabitsOutput = ProfileDeleted

export type ConfigGetOutput = Config

export type ConfigUpdateInput = {
  readonly payload: {
    readonly $schema?: string | undefined
    readonly theme?: string | undefined
    readonly locale?:
      | {
          readonly language?: string | undefined
          readonly region?: string | undefined
          readonly locale?: string | undefined
          readonly timezone?: string | undefined
          readonly currency?: string | undefined
          readonly autoDetect?: boolean | undefined
          readonly replyLanguage?: boolean | string | undefined
        }
      | undefined
    readonly keybinds?:
      | {
          readonly leader?: string | undefined
          readonly app_exit?: string | undefined
          readonly editor_open?: string | undefined
          readonly theme_list?: string | undefined
          readonly sidebar_toggle?: string | undefined
          readonly scrollbar_toggle?: string | undefined
          readonly username_toggle?: string | undefined
          readonly status_view?: string | undefined
          readonly sync_view?: string | undefined
          readonly session_export?: string | undefined
          readonly session_new?: string | undefined
          readonly session_list?: string | undefined
          readonly session_timeline?: string | undefined
          readonly session_fork?: string | undefined
          readonly session_rename?: string | undefined
          readonly session_delete?: string | undefined
          readonly session_pin_toggle?: string | undefined
          readonly session_scope_toggle?: string | undefined
          readonly session_tab_back?: string | undefined
          readonly session_tab_forward?: string | undefined
          readonly session_quick_switch_1?: string | undefined
          readonly session_quick_switch_2?: string | undefined
          readonly session_quick_switch_3?: string | undefined
          readonly session_quick_switch_4?: string | undefined
          readonly session_quick_switch_5?: string | undefined
          readonly session_quick_switch_6?: string | undefined
          readonly session_quick_switch_7?: string | undefined
          readonly session_quick_switch_8?: string | undefined
          readonly session_quick_switch_9?: string | undefined
          readonly stash_delete?: string | undefined
          readonly model_provider_list?: string | undefined
          readonly model_favorite_toggle?: string | undefined
          readonly session_share?: string | undefined
          readonly session_unshare?: string | undefined
          readonly session_interrupt?: string | undefined
          readonly session_codebro_open?: string | undefined
          readonly subtask_background?: string | undefined
          readonly subtask_picker?: string | undefined
          readonly session_compact?: string | undefined
          readonly messages_page_up?: string | undefined
          readonly messages_page_down?: string | undefined
          readonly messages_line_up?: string | undefined
          readonly messages_line_down?: string | undefined
          readonly messages_half_page_up?: string | undefined
          readonly messages_half_page_down?: string | undefined
          readonly messages_first?: string | undefined
          readonly messages_last?: string | undefined
          readonly messages_next?: string | undefined
          readonly messages_previous?: string | undefined
          readonly messages_last_user?: string | undefined
          readonly messages_copy?: string | undefined
          readonly messages_undo?: string | undefined
          readonly messages_redo?: string | undefined
          readonly messages_toggle_conceal?: string | undefined
          readonly tool_details?: string | undefined
          readonly model_list?: string | undefined
          readonly model_cycle_recent?: string | undefined
          readonly model_cycle_recent_reverse?: string | undefined
          readonly model_cycle_favorite?: string | undefined
          readonly model_cycle_favorite_reverse?: string | undefined
          readonly command_list?: string | undefined
          readonly agent_list?: string | undefined
          readonly agent_cycle?: string | undefined
          readonly agent_cycle_reverse?: string | undefined
          readonly permission_mode?: string | undefined
          readonly variant_cycle?: string | undefined
          readonly input_clear?: string | undefined
          readonly input_paste?: string | undefined
          readonly input_submit?: string | undefined
          readonly input_newline?: string | undefined
          readonly input_move_left?: string | undefined
          readonly input_move_right?: string | undefined
          readonly input_move_up?: string | undefined
          readonly input_move_down?: string | undefined
          readonly input_select_left?: string | undefined
          readonly input_select_right?: string | undefined
          readonly input_select_up?: string | undefined
          readonly input_select_down?: string | undefined
          readonly input_line_home?: string | undefined
          readonly input_line_end?: string | undefined
          readonly input_select_line_home?: string | undefined
          readonly input_select_line_end?: string | undefined
          readonly input_visual_line_home?: string | undefined
          readonly input_visual_line_end?: string | undefined
          readonly input_select_visual_line_home?: string | undefined
          readonly input_select_visual_line_end?: string | undefined
          readonly input_buffer_home?: string | undefined
          readonly input_buffer_end?: string | undefined
          readonly input_select_buffer_home?: string | undefined
          readonly input_select_buffer_end?: string | undefined
          readonly input_delete_line?: string | undefined
          readonly input_delete_to_line_end?: string | undefined
          readonly input_delete_to_line_start?: string | undefined
          readonly input_backspace?: string | undefined
          readonly input_delete?: string | undefined
          readonly input_undo?: string | undefined
          readonly input_redo?: string | undefined
          readonly input_word_forward?: string | undefined
          readonly input_word_backward?: string | undefined
          readonly input_select_word_forward?: string | undefined
          readonly input_select_word_backward?: string | undefined
          readonly input_delete_word_forward?: string | undefined
          readonly input_delete_word_backward?: string | undefined
          readonly history_previous?: string | undefined
          readonly history_next?: string | undefined
          readonly session_child_cycle?: string | undefined
          readonly session_child_cycle_reverse?: string | undefined
          readonly session_parent?: string | undefined
          readonly session_child_close?: string | undefined
          readonly terminal_suspend?: string | undefined
          readonly terminal_title_toggle?: string | undefined
          readonly tips_toggle?: string | undefined
          readonly voice_record?: string | undefined
          readonly app_support?: string | undefined
        }
      | undefined
    readonly logLevel?: ("DEBUG" | "INFO" | "WARN" | "ERROR") | undefined
    readonly tui?:
      | {
          readonly scroll_speed?: number | undefined
          readonly scroll_acceleration?: { readonly enabled: boolean } | undefined
          readonly diff_style?: "auto" | "stacked" | undefined
          readonly mouse?: boolean | undefined
          readonly sound?: boolean | undefined
          readonly bg_pulse?: boolean | undefined
          readonly turn_tokens?: boolean | undefined
        }
      | undefined
    readonly ads?:
      | {
          readonly enabled?: boolean | undefined
          readonly ratio?: number | undefined
          readonly items?:
            | ReadonlyArray<{
                readonly id: string
                readonly text: string
                readonly url?: string | undefined
                readonly enabled?: boolean | undefined
              }>
            | undefined
        }
      | undefined
    readonly server?:
      | {
          readonly port?: number | undefined
          readonly hostname?: string | undefined
          readonly mdns?: boolean | undefined
          readonly cors?: ReadonlyArray<string> | undefined
        }
      | undefined
    readonly remote?:
      | {
          readonly enabled?: boolean | undefined
          readonly enableTunnel?: boolean | undefined
          readonly provider?: "localtunnel" | "cloudflared" | "ngrok" | "remotosh" | "none" | undefined
          readonly askOnExistingSession?: boolean | undefined
        }
      | undefined
    readonly teleport?: { readonly url?: string | undefined; readonly token?: string | undefined } | undefined
    readonly command?:
      | {
          readonly [x: string]: {
            readonly template?: string | undefined
            readonly description?: string | undefined
            readonly agent?: string | undefined
            readonly model?: string | undefined
            readonly subtask?: boolean | undefined
            readonly aliases?: ReadonlyArray<string> | undefined
          }
        }
      | undefined
    readonly reference?:
      | {
          readonly [x: string]:
            | {
                readonly type: "git"
                readonly repository: string
                readonly branch?: string | undefined
                readonly description?: string | undefined
              }
            | { readonly type: "local"; readonly path: string; readonly description?: string | undefined }
        }
      | undefined
    readonly watcher?: { readonly ignore?: ReadonlyArray<string> | undefined } | undefined
    readonly plugin?: ReadonlyArray<string> | undefined
    readonly snapshot?: boolean | undefined
    readonly sync?:
      | {
          readonly url?: string | undefined
          readonly token?: string | undefined
          readonly autostart?: boolean | undefined
        }
      | undefined
    readonly analytics?: { readonly share?: boolean | undefined; readonly endpoint?: string | undefined } | undefined
    readonly share?: "manual" | "auto" | "disabled" | undefined
    readonly autoshare?: boolean | undefined
    readonly autoupdate?: boolean | "notify" | undefined
    readonly disabled_providers?: ReadonlyArray<string> | undefined
    readonly enabled_providers?: ReadonlyArray<string> | undefined
    readonly model?: string | undefined
    readonly small_model?: string | undefined
    readonly default_agent?: string | undefined
    readonly username?: string | undefined
    readonly mode?:
      | ({
          readonly build?:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
          readonly plan?:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
        } & {
          readonly [x: string]:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
        })
      | undefined
    readonly agent?:
      | ({
          readonly plan?:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
          readonly build?:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
          readonly general?:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
          readonly explore?:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
          readonly scout?:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
          readonly title?:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
          readonly summary?:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
          readonly compaction?:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
        } & {
          readonly [x: string]:
            | ({
                readonly model?: string | undefined
                readonly variant?: string | undefined
                readonly temperature?: number | undefined
                readonly top_p?: number | undefined
                readonly prompt?: string | undefined
                readonly tools?: { readonly [x: string]: boolean } | undefined
                readonly disable?: boolean | undefined
                readonly description?: string | undefined
                readonly mode?: "subagent" | "primary" | "all" | undefined
                readonly hidden?: boolean | undefined
                readonly options?: { readonly [x: string]: any } | undefined
                readonly color?: string | undefined
                readonly steps?: number | undefined
                readonly order?: number | undefined
                readonly maxSteps?: number | undefined
                readonly permission?:
                  | {
                      readonly [x: string]:
                        | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
                        | undefined
                    }
                  | undefined
                readonly permission_mode?: ("default" | "auto") | undefined
                readonly advisor?: string | undefined
                readonly advisor_max_uses?: number | undefined
              } & { readonly [x: string]: any | undefined })
            | undefined
        })
      | undefined
    readonly provider?:
      | {
          readonly [x: string]: {
            readonly api?: string | undefined
            readonly name?: string | undefined
            readonly env?: ReadonlyArray<string> | undefined
            readonly id?: string | undefined
            readonly npm?: string | undefined
            readonly models?:
              | {
                  readonly [x: string]: {
                    readonly id?: string | undefined
                    readonly name?: string | undefined
                    readonly family?: string | undefined
                    readonly release_date?: string | undefined
                    readonly attachment?: boolean | undefined
                    readonly reasoning?: boolean | undefined
                    readonly temperature?: boolean | undefined
                    readonly tool_call?: boolean | undefined
                    readonly interleaved?:
                      | true
                      | { readonly field: "reasoning_content" | "reasoning_details" }
                      | undefined
                    readonly cost?:
                      | {
                          readonly input: number
                          readonly output: number
                          readonly cache_read?: number | undefined
                          readonly cache_write?: number | undefined
                          readonly context_over_200k?:
                            | {
                                readonly input: number
                                readonly output: number
                                readonly cache_read?: number | undefined
                                readonly cache_write?: number | undefined
                              }
                            | undefined
                        }
                      | undefined
                    readonly limit?:
                      | { readonly context: number; readonly input?: number | undefined; readonly output: number }
                      | undefined
                    readonly modalities?:
                      | {
                          readonly input: ReadonlyArray<"text" | "audio" | "image" | "video" | "pdf">
                          readonly output: ReadonlyArray<"text" | "audio" | "image" | "video" | "pdf">
                        }
                      | undefined
                    readonly experimental?: boolean | undefined
                    readonly status?: "alpha" | "beta" | "deprecated" | undefined
                    readonly options?: { readonly [x: string]: any } | undefined
                    readonly headers?: { readonly [x: string]: string } | undefined
                    readonly provider?: { readonly npm: string; readonly api: string } | undefined
                    readonly reasoning_options?:
                      | ReadonlyArray<
                          | { readonly type: "effort"; readonly values: ReadonlyArray<string | null> }
                          | { readonly type: "toggle" }
                          | {
                              readonly type: "budget_tokens"
                              readonly min?: number | undefined
                              readonly max?: number | undefined
                            }
                        >
                      | undefined
                    readonly variants?:
                      | {
                          readonly [x: string]: { readonly disabled?: boolean | undefined } & {
                            readonly [x: string]: any | undefined
                          }
                        }
                      | undefined
                    readonly disabled?: boolean | undefined
                  }
                }
              | undefined
            readonly auth_provider?: string | undefined
            readonly whitelist?: ReadonlyArray<string> | undefined
            readonly blacklist?: ReadonlyArray<string> | undefined
            readonly options?:
              | ({
                  readonly apiKey?: string | undefined
                  readonly baseURL?: string | undefined
                  readonly enterpriseUrl?: string | undefined
                  readonly setCacheKey?: boolean | undefined
                  readonly timeout?: number | false | undefined
                  readonly headerTimeout?: number | false | undefined
                  readonly chunkTimeout?: number | undefined
                } & { readonly [x: string]: any | undefined })
              | undefined
          }
        }
      | undefined
    readonly mcp?:
      | {
          readonly [x: string]:
            | {
                readonly type: "local"
                readonly command: ReadonlyArray<string>
                readonly environment?: { readonly [x: string]: string } | undefined
                readonly enabled?: boolean | undefined
                readonly timeout?: number | undefined
              }
            | {
                readonly type: "remote"
                readonly url: string
                readonly enabled?: boolean | undefined
                readonly headers?: { readonly [x: string]: string } | undefined
                readonly oauth?:
                  | {
                      readonly clientId?: string | undefined
                      readonly clientSecret?: string | undefined
                      readonly scope?: string | undefined
                    }
                  | false
                  | undefined
                readonly timeout?: number | undefined
              }
            | { readonly enabled: boolean }
        }
      | undefined
    readonly connectors?:
      | {
          readonly [x: string]:
            | { readonly type: "figma"; readonly token?: string | undefined; readonly enabled?: boolean | undefined }
            | {
                readonly type: "slack"
                readonly botToken?: string | undefined
                readonly teamId?: string | undefined
                readonly enabled?: boolean | undefined
              }
            | {
                readonly type: "github"
                readonly token?: string | undefined
                readonly oauthClientId?: string | undefined
                readonly clientId?: string | undefined
                readonly enabled?: boolean | undefined
              }
            | {
                readonly type: "lovable"
                readonly token?: string | undefined
                readonly apiKey?: string | undefined
                readonly enabled?: boolean | undefined
              }
            | {
                readonly type: "discord"
                readonly botToken?: string | undefined
                readonly enabled?: boolean | undefined
              }
            | { readonly type: "teams"; readonly botToken?: string | undefined; readonly enabled?: boolean | undefined }
            | { readonly type: "gchat"; readonly botToken?: string | undefined; readonly enabled?: boolean | undefined }
            | {
                readonly type: "linear"
                readonly botToken?: string | undefined
                readonly enabled?: boolean | undefined
              }
            | { readonly enabled: boolean }
        }
      | undefined
    readonly formatter?:
      | false
      | true
      | {
          readonly [x: string]: {
            readonly disabled?: boolean | undefined
            readonly command?: ReadonlyArray<string> | undefined
            readonly environment?: { readonly [x: string]: string } | undefined
            readonly extensions?: ReadonlyArray<string> | undefined
          }
        }
      | undefined
    readonly websearch?:
      | {
          readonly provider?: "exa" | "parallel" | "mcp" | undefined
          readonly apiKey?: string | undefined
          readonly url?: string | undefined
          readonly tool?: string | undefined
        }
      | undefined
    readonly lsp?:
      | false
      | {
          readonly [x: string]:
            | { readonly disabled: true }
            | {
                readonly command: ReadonlyArray<string>
                readonly extensions?: ReadonlyArray<string> | undefined
                readonly disabled?: boolean | undefined
                readonly env?: { readonly [x: string]: string } | undefined
                readonly initialization?: { readonly [x: string]: any } | undefined
                readonly min_severity?: number | undefined
              }
        }
      | undefined
    readonly instructions?: ReadonlyArray<string> | undefined
    readonly layout?: ("auto" | "stretch") | undefined
    readonly permission?:
      | {
          readonly [x: string]:
            | (("ask" | "allow" | "deny") | { readonly [x: string]: "ask" | "allow" | "deny" })
            | undefined
        }
      | undefined
    readonly permission_mode?: ("default" | "auto") | undefined
    readonly auto_mode?:
      | {
          readonly environment?: ReadonlyArray<string> | undefined
          readonly allow?: ReadonlyArray<string> | undefined
          readonly soft_deny?: ReadonlyArray<string> | undefined
          readonly hard_deny?: ReadonlyArray<string> | undefined
          readonly classify_all_shell?: boolean | undefined
          readonly model?: string | undefined
          readonly disable?: boolean | undefined
        }
      | undefined
    readonly tools?: { readonly [x: string]: boolean } | undefined
    readonly tool?:
      | {
          readonly allow?: ReadonlyArray<string> | undefined
          readonly pin?: { readonly [x: string]: string } | undefined
        }
      | undefined
    readonly enterprise?: { readonly url?: string | undefined } | undefined
    readonly compaction?:
      | {
          readonly auto?: boolean | undefined
          readonly prune?: boolean | undefined
          readonly reserved?: number | undefined
        }
      | undefined
    readonly experimental?:
      | {
          readonly policies?:
            | ReadonlyArray<{ readonly effect: "allow" | "deny"; readonly action: string; readonly resource: string }>
            | undefined
          readonly hook?:
            | {
                readonly file_edited?:
                  | {
                      readonly [x: string]: ReadonlyArray<{
                        readonly command: ReadonlyArray<string>
                        readonly environment?: { readonly [x: string]: string } | undefined
                      }>
                    }
                  | undefined
                readonly session_completed?:
                  | ReadonlyArray<{
                      readonly command: ReadonlyArray<string>
                      readonly environment?: { readonly [x: string]: string } | undefined
                    }>
                  | undefined
              }
            | undefined
          readonly queued_message_wrap?:
            | { readonly header: string; readonly footer: string }
            | "default"
            | boolean
            | null
            | undefined
          readonly chatMaxRetries?: number | undefined
          readonly disable_paste_summary?: boolean | undefined
          readonly batch_tool?: boolean | undefined
          readonly openTelemetry?: boolean | undefined
          readonly primary_tools?: ReadonlyArray<string> | undefined
          readonly continue_loop_on_deny?: boolean | undefined
          readonly brain?: boolean | undefined
          readonly brainMinHours?: number | undefined
          readonly brainMinSessions?: number | undefined
          readonly brainModel?: string | undefined
          readonly memory?: boolean | undefined
          readonly mcp_timeout?: number | undefined
          readonly tool_timeout?: number | false | undefined
          readonly task_timeout?: number | false | undefined
          readonly nativeLlm?: boolean | undefined
          readonly tui?:
            | {
                readonly cacheEviction?: boolean | undefined
                readonly messageVirtualization?: boolean | undefined
                readonly explorationGrouping?: boolean | undefined
              }
            | undefined
          readonly requests?: { readonly latestOnlyLspRefresh?: boolean | undefined } | undefined
          readonly events?: { readonly schemaEncoding?: boolean | undefined } | undefined
        }
      | undefined
    readonly rag?: { readonly model?: string | undefined; readonly provider?: string | undefined } | undefined
    readonly image?: { readonly model?: string | undefined; readonly provider?: string | undefined } | undefined
    readonly browser?: unknown | undefined
    readonly computer?:
      | {
          readonly mode?: "sandbox" | "host" | undefined
          readonly width?: number | undefined
          readonly height?: number | undefined
        }
      | undefined
    readonly attachment?:
      | {
          readonly image?:
            | {
                readonly auto_resize?: boolean | undefined
                readonly max_width?: number | undefined
                readonly max_height?: number | undefined
                readonly max_base64_bytes?: number | undefined
              }
            | undefined
        }
      | undefined
    readonly speak?:
      | {
          readonly provider?: string | undefined
          readonly model?: string | undefined
          readonly modelId?: string | undefined
          readonly outputFormat?: string | undefined
        }
      | undefined
    readonly notifications?:
      | {
          readonly todo?:
            | {
                readonly enabled?: boolean | undefined
                readonly macos?: boolean | undefined
                readonly slack?:
                  | {
                      readonly enabled?: boolean | undefined
                      readonly connector?: string | undefined
                      readonly channel?: string | undefined
                    }
                  | undefined
                readonly discord?:
                  | { readonly enabled?: boolean | undefined; readonly webhook?: string | undefined }
                  | undefined
              }
            | undefined
          readonly icon?: { readonly url?: string | undefined; readonly alt?: string | undefined } | undefined
          readonly notify?:
            | {
                readonly enabled?: boolean | undefined
                readonly macos?: boolean | undefined
                readonly slack?:
                  | {
                      readonly enabled?: boolean | undefined
                      readonly connector?: string | undefined
                      readonly channel?: string | undefined
                    }
                  | undefined
                readonly discord?:
                  | { readonly enabled?: boolean | undefined; readonly webhook?: string | undefined }
                  | undefined
                readonly events?:
                  | {
                      readonly sessionIdle?: boolean | undefined
                      readonly sessionError?: boolean | undefined
                      readonly permissionAsked?: boolean | undefined
                      readonly questionAsked?: boolean | undefined
                    }
                  | undefined
                readonly idleMinMs?: number | undefined
                readonly rateLimit?:
                  | { readonly windowMs?: number | undefined; readonly maxPerWindow?: number | undefined }
                  | undefined
                readonly retry?:
                  | {
                      readonly attempts?: number | undefined
                      readonly delay?: number | undefined
                      readonly factor?: number | undefined
                      readonly maxDelay?: number | undefined
                      readonly timeoutMs?: number | undefined
                    }
                  | undefined
                readonly breaker?:
                  | { readonly failures?: number | undefined; readonly cooldownMs?: number | undefined }
                  | undefined
                readonly quietHours?:
                  | {
                      readonly enabled?: boolean | undefined
                      readonly start?: string | undefined
                      readonly end?: string | undefined
                      readonly suppress?: ReadonlyArray<"macos" | "slack" | "discord"> | undefined
                    }
                  | undefined
              }
            | undefined
        }
      | undefined
    readonly mobile?:
      | {
          readonly tophat?:
            | {
                readonly enabled?: boolean | undefined
                readonly cliPath?: string | undefined
                readonly defaultPlatform?: "ios" | "android" | undefined
                readonly defaultDestination?: "device" | "simulator" | "emulator" | undefined
                readonly autoDetect?: boolean | undefined
              }
            | undefined
        }
      | undefined
  } & { readonly [x: string]: any }
}

export type ConfigUpdateOutput = Config

export type ConfigProvidersOutput = ConfigProviders

export type ConnectorsStatusOutput = ConnectorsStatusOutput2

export type ConnectorsAuthSetInput = {
  readonly name: { readonly name: string }["name"]
  readonly token?: ConnectorsAuthSetPayload["token"]
  readonly botToken?: ConnectorsAuthSetPayload["botToken"]
  readonly apiKey?: ConnectorsAuthSetPayload["apiKey"]
  readonly teamId?: ConnectorsAuthSetPayload["teamId"]
  readonly expiresAt?: ConnectorsAuthSetPayload["expiresAt"]
  readonly refreshToken?: ConnectorsAuthSetPayload["refreshToken"]
  readonly refreshTokenExpiresAt?: ConnectorsAuthSetPayload["refreshTokenExpiresAt"]
}

export type ConnectorsAuthSetOutput = ConnectorsSuccess

export type ConnectorsAuthRemoveInput = { readonly name: { readonly name: string }["name"] }

export type ConnectorsAuthRemoveOutput = ConnectorsSuccess

export type ConnectorsInvalidateInput = { readonly name?: ConnectorsInvalidatePayload["name"] }

export type ConnectorsInvalidateOutput = ConnectorsSuccess

export type DoctorRunOutput = DoctorReport

export type ExperimentalToolIDsOutput = ToolIDs

export type ExperimentalToolsInput = {
  readonly provider: { readonly provider: string; readonly model: string }["provider"]
  readonly model: { readonly provider: string; readonly model: string }["model"]
}

export type ExperimentalToolsOutput = ToolList

export type ExperimentalWorktreeCreateInput = {
  readonly name?: ExperimentalWorktreeCreatePayload["name"]
  readonly branch?: ExperimentalWorktreeCreatePayload["branch"]
  readonly branchPrefix?: ExperimentalWorktreeCreatePayload["branchPrefix"]
  readonly baseBranch?: ExperimentalWorktreeCreatePayload["baseBranch"]
  readonly remote?: ExperimentalWorktreeCreatePayload["remote"]
  readonly startCommand?: ExperimentalWorktreeCreatePayload["startCommand"]
}

export type ExperimentalWorktreeCreateOutput = Worktree

export type ExperimentalWorktreeOutput = WorktreeList

export type ExperimentalWorktreeRemoveInput = { readonly directory: ExperimentalWorktreeRemovePayload["directory"] }

export type ExperimentalWorktreeRemoveOutput = boolean

export type ExperimentalWorktreeResetInput = { readonly directory: ExperimentalWorktreeResetPayload["directory"] }

export type ExperimentalWorktreeResetOutput = boolean

export type ExperimentalResourceOutput = McpResourceMap

export type ExperimentalManagedWorktreeCreateInput = {
  readonly from: ExperimentalManagedWorktreeCreatePayload["from"]
  readonly name?: ExperimentalManagedWorktreeCreatePayload["name"]
  readonly into?: ExperimentalManagedWorktreeCreatePayload["into"]
}

export type ExperimentalManagedWorktreeCreateOutput = ManagedWorktreeInfo

export type ExperimentalManagedWorktreeRemoveInput = { readonly at: ExperimentalManagedWorktreeRemovePayload["at"] }

export type ExperimentalManagedWorktreeRemoveOutput = null

export type ExperimentalManagedWorktreeLinkInput = {
  readonly at: ExperimentalManagedWorktreeLinkPayload["at"]
  readonly to?: ExperimentalManagedWorktreeLinkPayload["to"]
}

export type ExperimentalManagedWorktreeLinkOutput = ManagedWorktreeInfo

export type ExperimentalManagedWorktreeChildrenInput = { readonly of: { readonly of: string }["of"] }

export type ExperimentalManagedWorktreeChildrenOutput = ManagedWorktreeList

export type ExperimentalManagedWorktreeAncestorsInput = { readonly of: { readonly of: string }["of"] }

export type ExperimentalManagedWorktreeAncestorsOutput = ManagedWorktreeList

export type ExperimentalManagedWorktreeListOutput = ManagedWorktreeList

export type FileFindTextInput = { readonly pattern: { readonly pattern: string }["pattern"] }

export type FileFindTextOutput = Array<SearchMatch>

export type FileFindFileInput = {
  readonly query: {
    readonly query: string
    readonly dirs?: "true" | "false" | undefined
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["query"]
  readonly dirs?: {
    readonly query: string
    readonly dirs?: "true" | "false" | undefined
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["dirs"]
  readonly type?: {
    readonly query: string
    readonly dirs?: "true" | "false" | undefined
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["type"]
  readonly limit?: {
    readonly query: string
    readonly dirs?: "true" | "false" | undefined
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type FileFindFileOutput = Array<string>

export type FileFindSymbolInput = { readonly query: { readonly query: string }["query"] }

export type FileFindSymbolOutput = Array<Symbol>

export type FileListInput = { readonly path: { readonly path: string }["path"] }

export type FileListOutput = Array<FileNode>

export type FileContentInput = { readonly path: { readonly path: string }["path"] }

export type FileContentOutput = FileContent

export type FileWriteInput = { readonly path: FileWritePayload["path"]; readonly content: FileWritePayload["content"] }

export type FileWriteOutput = FileWriteResult

export type FileStatusOutput = Array<File>

export type GlobalHealthOutput = GlobalHealth

export type GlobalDisposeOutput = boolean

export type McpStatusOutput = MCPStatusMap

export type McpAddInput = { readonly name: McpAddPayload["name"]; readonly config: McpAddPayload["config"] }

export type McpAddOutput = MCPStatusMap

export type McpStartAuthInput = { readonly name: { readonly name: string }["name"] }

export type McpStartAuthOutput = McpStartAuthResponse

export type McpAuthCallbackInput = {
  readonly name: { readonly name: string }["name"]
  readonly code: McpAuthCallbackPayload["code"]
}

export type McpAuthCallbackOutput = MCPStatus

export type McpAuthenticateInput = { readonly name: { readonly name: string }["name"] }

export type McpAuthenticateOutput = MCPStatus

export type McpRemoveAuthInput = { readonly name: { readonly name: string }["name"] }

export type McpRemoveAuthOutput = McpMutationSuccess

export type McpConnectInput = { readonly name: { readonly name: string }["name"] }

export type McpConnectOutput = boolean

export type McpDisconnectInput = { readonly name: { readonly name: string }["name"] }

export type McpDisconnectOutput = boolean

export type McpToggleInput = {
  readonly name: { readonly name: string }["name"]
  readonly enabled: McpTogglePayload["enabled"]
}

export type McpToggleOutput = MCPStatusMap

export type MissionListOutput = MissionListOutput2

export type MissionTemplatesOutput = MissionTemplatesOutput2

export type MissionGenerateInput = {
  readonly description: MissionGeneratePayload["description"]
  readonly model?: MissionGeneratePayload["model"]
  readonly agent?: MissionGeneratePayload["agent"]
  readonly sessionID?: MissionGeneratePayload["sessionID"]
}

export type MissionGenerateOutput = MissionDefinition

export type MissionRecentExecsInput = { readonly limit?: { readonly limit?: number }["limit"] }

export type MissionRecentExecsOutput = MissionExecsOutput2

export type MissionGetInput = { readonly id: { readonly id: string }["id"] }

export type MissionGetOutput = MissionGetOutput2

export type MissionUpsertInput = {
  readonly name: MissionUpsertPayload["name"]
  readonly brief: MissionUpsertPayload["brief"]
  readonly milestones: MissionUpsertPayload["milestones"]
  readonly models?: MissionUpsertPayload["models"]
  readonly timeoutMs?: MissionUpsertPayload["timeoutMs"]
  readonly sandbox?: MissionUpsertPayload["sandbox"]
  readonly worktree?: MissionUpsertPayload["worktree"]
}

export type MissionUpsertOutput = MissionDefinition

export type MissionUpdateInput = {
  readonly id: { readonly id: string }["id"]
  readonly name: MissionUpdatePayload["name"]
  readonly brief: MissionUpdatePayload["brief"]
  readonly milestones: MissionUpdatePayload["milestones"]
  readonly models?: MissionUpdatePayload["models"]
  readonly timeoutMs?: MissionUpdatePayload["timeoutMs"]
  readonly sandbox?: MissionUpdatePayload["sandbox"]
  readonly worktree?: MissionUpdatePayload["worktree"]
  readonly status?: MissionUpdatePayload["status"]
  readonly createdAt: MissionUpdatePayload["createdAt"]
}

export type MissionUpdateOutput = MissionDefinition

export type MissionRemoveInput = { readonly id: { readonly id: string }["id"] }

export type MissionRemoveOutput = MissionBooleanResult

export type MissionStartInput = {
  readonly id: { readonly id: string }["id"]
  readonly sessionID?: MissionStartPayload["sessionID"]
}

export type MissionStartOutput = MissionBooleanResult

export type MissionPauseInput = { readonly id: { readonly id: string }["id"] }

export type MissionPauseOutput = MissionBooleanResult

export type MissionCancelInput = { readonly id: { readonly id: string }["id"] }

export type MissionCancelOutput = MissionBooleanResult

export type MissionFeatureMutateInput = {
  readonly id: { readonly id: string; readonly featureID: string }["id"]
  readonly featureID: { readonly id: string; readonly featureID: string }["featureID"]
  readonly status?: MissionFeatureMutatePayload["status"]
  readonly error?: MissionFeatureMutatePayload["error"]
  readonly appendDependsOn?: MissionFeatureMutatePayload["appendDependsOn"]
}

export type MissionFeatureMutateOutput = MissionDefinition

export type MissionExecsInput = {
  readonly id: { readonly id: string }["id"]
  readonly limit?: { readonly limit?: number }["limit"]
}

export type MissionExecsOutput = MissionExecsOutput2

export type MobileAuthTokenListOutput = Array<MobileAuthTokenPublic>

export type MobileAuthTokenCreateInput = {
  readonly name?: MobileAuthTokenCreatePayload["name"]
  readonly expiresInDays?: MobileAuthTokenCreatePayload["expiresInDays"]
}

export type MobileAuthTokenCreateOutput = { token: string; info: MobileAuthTokenPublic }

export type MobileAuthTokenRevokeInput = { readonly id: { readonly id: string }["id"] }

export type MobileAuthTokenRevokeOutput = { revoked: boolean }

export type MobileBootstrapOutput = MobileBootstrap

export type MobileCommandListOutput = Array<MobileCommand>

export type MobileProjectListOutput = Array<MobileProject>

export type MobileMemoryHistoryOutput = Array<MobilePromptHistoryEntry>

export type MobileMemorySearchInput = { readonly query: { readonly query: string }["query"] }

export type MobileMemorySearchOutput = Array<MobileMemorySearchHit>

export type MobileMemoryStashListOutput = Array<MobilePromptStashEntry>

export type MobileMemoryStashCreateInput = { readonly input: MobileMemoryStashCreatePayload["input"] }

export type MobileMemoryStashCreateOutput = MobilePromptStashEntry

export type MobileMemoryStashDeleteInput = { readonly id: { readonly id: string }["id"] }

export type MobileMemoryStashDeleteOutput = MobileSuccess

export type MobileGithubReposOutput = Array<unknown>

export type MobileGithubBranchesInput = {
  readonly owner: { readonly owner: string; readonly repo: string }["owner"]
  readonly repo: { readonly owner: string; readonly repo: string }["repo"]
}

export type MobileGithubBranchesOutput = Array<MobileGithubBranch>

export type MobileGithubWorkflowsInput = {
  readonly owner: { readonly owner: string; readonly repo: string }["owner"]
  readonly repo: { readonly owner: string; readonly repo: string }["repo"]
}

export type MobileGithubWorkflowsOutput = Array<MobileGithubWorkflow>

export type MobileGithubWorkflowRunsInput = {
  readonly owner: { readonly owner: string; readonly repo: string }["owner"]
  readonly repo: { readonly owner: string; readonly repo: string }["repo"]
  readonly branch?: { readonly branch?: string | undefined; readonly limit?: number | undefined }["branch"]
  readonly limit?: { readonly branch?: string | undefined; readonly limit?: number | undefined }["limit"]
}

export type MobileGithubWorkflowRunsOutput = MobileGithubWorkflowRunList

export type MobileGithubWorkflowRunJobsInput = {
  readonly owner: { readonly owner: string; readonly repo: string; readonly runID: string }["owner"]
  readonly repo: { readonly owner: string; readonly repo: string; readonly runID: string }["repo"]
  readonly runID: { readonly owner: string; readonly repo: string; readonly runID: string }["runID"]
}

export type MobileGithubWorkflowRunJobsOutput = Array<MobileGithubWorkflowJob>

export type MobileGithubWorkflowRunRerunInput = {
  readonly owner: { readonly owner: string; readonly repo: string; readonly runID: string }["owner"]
  readonly repo: { readonly owner: string; readonly repo: string; readonly runID: string }["repo"]
  readonly runID: { readonly owner: string; readonly repo: string; readonly runID: string }["runID"]
  readonly failedOnly?: MobileGithubWorkflowRunRerunPayload["failedOnly"]
}

export type MobileGithubWorkflowRunRerunOutput = MobileSuccess

export type MobileGithubWorkflowRunCancelInput = {
  readonly owner: { readonly owner: string; readonly repo: string; readonly runID: string }["owner"]
  readonly repo: { readonly owner: string; readonly repo: string; readonly runID: string }["repo"]
  readonly runID: { readonly owner: string; readonly repo: string; readonly runID: string }["runID"]
}

export type MobileGithubWorkflowRunCancelOutput = MobileSuccess

export type MobileGithubWorkflowDispatchInput = {
  readonly owner: { readonly owner: string; readonly repo: string; readonly workflowID: string }["owner"]
  readonly repo: { readonly owner: string; readonly repo: string; readonly workflowID: string }["repo"]
  readonly workflowID: { readonly owner: string; readonly repo: string; readonly workflowID: string }["workflowID"]
  readonly ref: MobileGithubWorkflowDispatchPayload["ref"]
  readonly inputs?: MobileGithubWorkflowDispatchPayload["inputs"]
}

export type MobileGithubWorkflowDispatchOutput = MobileSuccess

export type MobileGithubImportsOutput = Array<MobileGithubImport>

export type MobileGithubOauthClientInput = { readonly clientId: MobileGithubOauthClientPayload["clientId"] }

export type MobileGithubOauthClientOutput = MobileConfigInfo

export type MobileGithubOauthDeviceStartOutput = MobileGithubDeviceAuthStart

export type MobileGithubOauthDevicePollInput = { readonly deviceCode: MobileGithubOauthDevicePollPayload["deviceCode"] }

export type MobileGithubOauthDevicePollOutput = MobileGithubDeviceAuthPollResult

export type MobileGithubAuthSetInput = { readonly token: MobileGithubAuthSetPayload["token"] }

export type MobileGithubAuthSetOutput = MobileSuccess

export type MobileGithubAuthRemoveOutput = MobileSuccess

export type MobileGithubImportInput = {
  readonly owner: MobileGithubImportPayload["owner"]
  readonly repo: MobileGithubImportPayload["repo"]
  readonly cloneUrl: MobileGithubImportPayload["cloneUrl"]
  readonly defaultBranch: MobileGithubImportPayload["defaultBranch"]
  readonly private?: MobileGithubImportPayload["private"]
}

export type MobileGithubImportOutput = { import: MobileGithubImport; project: Project }

export type MobileGithubSessionCreateInput = {
  readonly owner: MobileGithubSessionCreatePayload["owner"]
  readonly repo: MobileGithubSessionCreatePayload["repo"]
  readonly cloneUrl: MobileGithubSessionCreatePayload["cloneUrl"]
  readonly htmlUrl?: MobileGithubSessionCreatePayload["htmlUrl"]
  readonly defaultBranch: MobileGithubSessionCreatePayload["defaultBranch"]
  readonly baseBranch: MobileGithubSessionCreatePayload["baseBranch"]
  readonly private?: MobileGithubSessionCreatePayload["private"]
  readonly title?: MobileGithubSessionCreatePayload["title"]
  readonly executionTarget?: MobileGithubSessionCreatePayload["executionTarget"]
}

export type MobileGithubSessionCreateOutput = MobileGithubSessionCreateResult

export type MobileSessionListInput = {
  readonly limit?: { readonly limit?: number | undefined; readonly search?: string | undefined }["limit"]
  readonly search?: { readonly limit?: number | undefined; readonly search?: string | undefined }["search"]
}

export type MobileSessionListOutput = Array<MobileSessionSummary>

export type MobileSessionCreateInput = {
  readonly parentID?: MobileSessionCreatePayload["parentID"]
  readonly title?: MobileSessionCreatePayload["title"]
  readonly permission?: MobileSessionCreatePayload["permission"]
  readonly github?: MobileSessionCreatePayload["github"]
  readonly executionTarget?: MobileSessionCreatePayload["executionTarget"]
}

export type MobileSessionCreateOutput = Session2

export type MobileSessionDetailInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type MobileSessionDetailOutput = MobileSessionDetail

export type MobileSessionDeleteInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type MobileSessionDeleteOutput = MobileSuccess

export type MobileSessionDiffInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type MobileSessionDiffOutput = Array<FileDiff2>

export type MobileSessionCommandListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type MobileSessionCommandListOutput = Array<MobileCommand>

export type MobileSessionCommandInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly command: MobileSessionCommandPayload["command"]
  readonly arguments?: MobileSessionCommandPayload["arguments"]
  readonly agent?: MobileSessionCommandPayload["agent"]
  readonly model?: MobileSessionCommandPayload["model"]
  readonly variant?: MobileSessionCommandPayload["variant"]
}

export type MobileSessionCommandOutput = { info: Message1; parts: Array<Part1> }

export type MobileSessionMessageInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID?: MobileSessionMessagePayload["messageID"]
  readonly delivery?: MobileSessionMessagePayload["delivery"]
  readonly model?: MobileSessionMessagePayload["model"]
  readonly agent?: MobileSessionMessagePayload["agent"]
  readonly noReply?: MobileSessionMessagePayload["noReply"]
  readonly tools?: MobileSessionMessagePayload["tools"]
  readonly format?: MobileSessionMessagePayload["format"]
  readonly system?: MobileSessionMessagePayload["system"]
  readonly variant?: MobileSessionMessagePayload["variant"]
  readonly parts: MobileSessionMessagePayload["parts"]
  readonly parentSessionID?: MobileSessionMessagePayload["parentSessionID"]
}

export type MobileSessionMessageOutput = MobileAccepted

export type MobileSessionAbortInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type MobileSessionAbortOutput = MobileSuccess

export type MobilePermissionRespondInput = {
  readonly sessionID: { readonly sessionID: string; readonly permissionID: string }["sessionID"]
  readonly permissionID: { readonly sessionID: string; readonly permissionID: string }["permissionID"]
  readonly response: MobilePermissionRespondPayload["response"]
}

export type MobilePermissionRespondOutput = MobileSuccess

export type MobileQuestionRespondInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly answers: MobileQuestionRespondPayload["answers"]
}

export type MobileQuestionRespondOutput = MobileSuccess

export type MobileQuestionRejectInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type MobileQuestionRejectOutput = MobileSuccess

export type MobileSessionPublishInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly title?: MobileSessionPublishPayload["title"]
  readonly body?: MobileSessionPublishPayload["body"]
  readonly commitMessage?: MobileSessionPublishPayload["commitMessage"]
}

export type MobileSessionPublishOutput = MobileGithubPublishResult

export type MobileSessionCleanupInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type MobileSessionCleanupOutput = MobileSuccess

export type MobileSessionStreamInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type MobileSessionStreamOutput = unknown

export type MobileSessionRenameInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly title: MobileSessionRenamePayload["title"]
}

export type MobileSessionRenameOutput = MobileSuccess

export type MobileSessionTodoInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type MobileSessionTodoOutput = { todos: Array<Todo> }

export type MobileTeleportUploadBeginOutput = { uploadID: string }

export type MobileTeleportUploadChunkInput = { readonly uploadID: { readonly uploadID: string }["uploadID"] }

export type MobileTeleportUploadChunkOutput = { ok: boolean }

export type MobileTeleportInInput = {
  readonly title?: MobileTeleportInPayload["title"]
  readonly name?: MobileTeleportInPayload["name"]
  readonly origin?: MobileTeleportInPayload["origin"]
  readonly permission?: MobileTeleportInPayload["permission"]
  readonly messages: MobileTeleportInPayload["messages"]
  readonly uploadID?: MobileTeleportInPayload["uploadID"]
}

export type MobileTeleportInOutput = MobileTeleportResult

export type MobileTeleportOutInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly url: MobileTeleportOutPayload["url"]
  readonly token: MobileTeleportOutPayload["token"]
  readonly content?: MobileTeleportOutPayload["content"]
  readonly includeGit?: MobileTeleportOutPayload["includeGit"]
}

export type MobileTeleportOutOutput = MobileTeleportResult

export type MobileWorktreeCreateInput = {
  readonly name?: MobileWorktreeCreatePayload["name"]
  readonly branch?: MobileWorktreeCreatePayload["branch"]
  readonly branchPrefix?: MobileWorktreeCreatePayload["branchPrefix"]
  readonly baseBranch?: MobileWorktreeCreatePayload["baseBranch"]
  readonly remote?: MobileWorktreeCreatePayload["remote"]
  readonly startCommand?: MobileWorktreeCreatePayload["startCommand"]
  readonly detached?: MobileWorktreeCreatePayload["detached"]
  readonly sourceDirectory?: MobileWorktreeCreatePayload["sourceDirectory"]
  readonly root?: MobileWorktreeCreatePayload["root"]
}

export type MobileWorktreeCreateOutput = Worktree2

export type MobileWorktreeRemoveInput = {
  readonly directory: MobileWorktreeRemovePayload["directory"]
  readonly force?: MobileWorktreeRemovePayload["force"]
}

export type MobileWorktreeRemoveOutput = MobileSuccess

export type MobileWorktreeResetInput = { readonly directory: MobileWorktreeResetPayload["directory"] }

export type MobileWorktreeResetOutput = MobileSuccess

export type MobileGitStatusOutput = MobileGitStatus

export type MobileGitDiffInput = {
  readonly file?: { readonly file?: string | undefined; readonly staged?: "true" | "false" | undefined }["file"]
  readonly staged?: { readonly file?: string | undefined; readonly staged?: "true" | "false" | undefined }["staged"]
}

export type MobileGitDiffOutput = Array<MobileGitFileDiff>

export type MobileGitCommitsInput = { readonly limit?: { readonly limit?: number | undefined }["limit"] }

export type MobileGitCommitsOutput = Array<MobileGitCommit>

export type MobileGitBranchesOutput = Array<MobileGitBranch>

export type MobileGitCommitInput = {
  readonly message: MobileGitCommitPayload["message"]
  readonly files?: MobileGitCommitPayload["files"]
  readonly amend?: MobileGitCommitPayload["amend"]
  readonly stagedOnly?: MobileGitCommitPayload["stagedOnly"]
}

export type MobileGitCommitOutput = { sha: string; message: string }

export type MobileGitCheckoutInput = {
  readonly branch: MobileGitCheckoutPayload["branch"]
  readonly create?: MobileGitCheckoutPayload["create"]
}

export type MobileGitCheckoutOutput = MobileSuccess

export type MobileGitStageInput = { readonly files: MobileGitStagePayload["files"] }

export type MobileGitStageOutput = MobileSuccess

export type MobileGitUnstageInput = { readonly files: MobileGitUnstagePayload["files"] }

export type MobileGitUnstageOutput = MobileSuccess

export type MobileGitDiscardInput = { readonly files: MobileGitDiscardPayload["files"] }

export type MobileGitDiscardOutput = MobileSuccess

export type MobileGitPushInput = { readonly upstream?: { readonly upstream?: string | undefined }["upstream"] }

export type MobileGitPushOutput = { success: true; pushed: boolean }

export type MobileGitPullOutput = { success: true; pulled: boolean; conflicts?: Array<string> | undefined }

export type MobileLoopListOutput = { loops: Array<LoopDefinition>; runtimes: Array<MobileLoopRuntime> }

export type MobileLoopCreateInput = {
  readonly name: MobileLoopCreatePayload["name"]
  readonly stages: MobileLoopCreatePayload["stages"]
  readonly trigger: MobileLoopCreatePayload["trigger"]
  readonly maxRuns?: MobileLoopCreatePayload["maxRuns"]
  readonly timeoutMs?: MobileLoopCreatePayload["timeoutMs"]
  readonly createPR?: MobileLoopCreatePayload["createPR"]
  readonly sandbox?: MobileLoopCreatePayload["sandbox"]
  readonly worktree?: MobileLoopCreatePayload["worktree"]
  readonly paused?: MobileLoopCreatePayload["paused"]
  readonly enabled: MobileLoopCreatePayload["enabled"]
}

export type MobileLoopCreateOutput = LoopDefinition

export type MobileLoopTemplatesOutput = { templates: Array<MobileLoopTemplate> }

export type MobileLoopGenerateInput = {
  readonly description: MobileLoopGeneratePayload["description"]
  readonly model?: MobileLoopGeneratePayload["model"]
  readonly agent?: MobileLoopGeneratePayload["agent"]
  readonly sessionID?: MobileLoopGeneratePayload["sessionID"]
}

export type MobileLoopGenerateOutput = LoopDefinition

export type MobileLoopRunsRecentInput = { readonly limit?: { readonly limit?: number | undefined }["limit"] }

export type MobileLoopRunsRecentOutput = { runs: Array<MobileLoopRun> }

export type MobileLoopGetInput = { readonly id: { readonly id: string }["id"] }

export type MobileLoopGetOutput = { loop: LoopDefinition; runtime: MobileLoopRuntime }

export type MobileLoopDeleteInput = { readonly id: { readonly id: string }["id"] }

export type MobileLoopDeleteOutput = MobileSuccess

export type MobileLoopUpdateInput = {
  readonly id: { readonly id: string }["id"]
  readonly name: MobileLoopUpdatePayload["name"]
  readonly stages: MobileLoopUpdatePayload["stages"]
  readonly trigger: MobileLoopUpdatePayload["trigger"]
  readonly maxRuns?: MobileLoopUpdatePayload["maxRuns"]
  readonly timeoutMs?: MobileLoopUpdatePayload["timeoutMs"]
  readonly createPR?: MobileLoopUpdatePayload["createPR"]
  readonly sandbox?: MobileLoopUpdatePayload["sandbox"]
  readonly worktree?: MobileLoopUpdatePayload["worktree"]
  readonly paused?: MobileLoopUpdatePayload["paused"]
  readonly enabled: MobileLoopUpdatePayload["enabled"]
}

export type MobileLoopUpdateOutput = LoopDefinition

export type MobileLoopRunsInput = {
  readonly id: { readonly id: string }["id"]
  readonly limit?: { readonly limit?: number | undefined }["limit"]
}

export type MobileLoopRunsOutput = { runs: Array<MobileLoopRun> }

export type MobileLoopRunInput = { readonly id: { readonly id: string }["id"] }

export type MobileLoopRunOutput = MobileSuccess

export type MobileLoopAbortInput = { readonly id: { readonly id: string }["id"] }

export type MobileLoopAbortOutput = MobileSuccess

export type MobileLoopToggleInput = {
  readonly id: { readonly id: string }["id"]
  readonly enabled: MobileLoopTogglePayload["enabled"]
}

export type MobileLoopToggleOutput = LoopDefinition

export type MobileLoopPauseInput = { readonly id: { readonly id: string }["id"] }

export type MobileLoopPauseOutput = MobileSuccess

export type MobileLoopResumeInput = { readonly id: { readonly id: string }["id"] }

export type MobileLoopResumeOutput = MobileSuccess

export type MobileRoutineListOutput = Array<MobileRoutine>

export type MobileRoutineCreateInput = {
  readonly name: MobileRoutineCreatePayload["name"]
  readonly prompt: MobileRoutineCreatePayload["prompt"]
  readonly triggers?: MobileRoutineCreatePayload["triggers"]
  readonly model?: MobileRoutineCreatePayload["model"]
}

export type MobileRoutineCreateOutput = MobileRoutine

export type MobileRoutineGetInput = { readonly id: { readonly id: string }["id"] }

export type MobileRoutineGetOutput = MobileRoutine

export type MobileRoutineDeleteInput = { readonly id: { readonly id: string }["id"] }

export type MobileRoutineDeleteOutput = MobileSuccess

export type MobileRoutineUpdateInput = {
  readonly id: { readonly id: string }["id"]
  readonly name?: MobileRoutineUpdatePayload["name"]
  readonly prompt?: MobileRoutineUpdatePayload["prompt"]
  readonly triggers?: MobileRoutineUpdatePayload["triggers"]
  readonly model?: MobileRoutineUpdatePayload["model"]
  readonly paused?: MobileRoutineUpdatePayload["paused"]
}

export type MobileRoutineUpdateOutput = MobileRoutine

export type MobileRoutineRunInput = {
  readonly id: { readonly id: string }["id"]
  readonly text?: MobileRoutineRunPayload["text"]
}

export type MobileRoutineRunOutput = Session2

export type MobileRoutinePauseInput = { readonly id: { readonly id: string }["id"] }

export type MobileRoutinePauseOutput = MobileRoutine

export type MobileRoutineResumeInput = { readonly id: { readonly id: string }["id"] }

export type MobileRoutineResumeOutput = MobileRoutine

export type MobileRoutineTriggerInput = {
  readonly token: { readonly token: string }["token"]
  readonly text?: MobileRoutineTriggerPayload["text"]
}

export type MobileRoutineTriggerOutput = Session2

export type MobilePtyListOutput = Array<Pty>

export type MobilePtyCreateInput = {
  readonly command?: MobilePtyCreatePayload["command"]
  readonly args?: MobilePtyCreatePayload["args"]
  readonly cwd?: MobilePtyCreatePayload["cwd"]
  readonly title?: MobilePtyCreatePayload["title"]
  readonly env?: MobilePtyCreatePayload["env"]
}

export type MobilePtyCreateOutput = Pty

export type MobilePtyGetInput = { readonly ptyID: { readonly ptyID: string }["ptyID"] }

export type MobilePtyGetOutput = Pty

export type MobilePtyUpdateInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly title?: MobilePtyUpdatePayload["title"]
  readonly size?: MobilePtyUpdatePayload["size"]
}

export type MobilePtyUpdateOutput = Pty

export type MobilePtyRemoveInput = { readonly ptyID: { readonly ptyID: string }["ptyID"] }

export type MobilePtyRemoveOutput = boolean

export type MobileMissionListOutput = {
  missions: Array<MobileMissionDefinition>
  runtimes: Array<MobileMissionRuntime>
}

export type MobileMissionCreateInput = {
  readonly name: MobileMissionCreatePayload["name"]
  readonly brief: MobileMissionCreatePayload["brief"]
  readonly milestones: MobileMissionCreatePayload["milestones"]
  readonly models?: MobileMissionCreatePayload["models"]
  readonly timeoutMs?: MobileMissionCreatePayload["timeoutMs"]
  readonly sandbox?: MobileMissionCreatePayload["sandbox"]
  readonly worktree?: MobileMissionCreatePayload["worktree"]
}

export type MobileMissionCreateOutput = MobileMissionDefinition

export type MobileMissionTemplatesOutput = { templates: Array<MobileMissionTemplate> }

export type MobileMissionGenerateInput = {
  readonly description: MobileMissionGeneratePayload["description"]
  readonly model?: MobileMissionGeneratePayload["model"]
  readonly agent?: MobileMissionGeneratePayload["agent"]
  readonly sessionID?: MobileMissionGeneratePayload["sessionID"]
}

export type MobileMissionGenerateOutput = MobileMissionDefinition

export type MobileMissionExecsRecentInput = { readonly limit?: { readonly limit?: number | undefined }["limit"] }

export type MobileMissionExecsRecentOutput = { execs: Array<MobileMissionExec> }

export type MobileMissionGetInput = { readonly id: { readonly id: string }["id"] }

export type MobileMissionGetOutput = { mission: MobileMissionDefinition; runtime: MobileMissionRuntime }

export type MobileMissionUpdateInput = {
  readonly id: { readonly id: string }["id"]
  readonly name: MobileMissionUpdatePayload["name"]
  readonly brief: MobileMissionUpdatePayload["brief"]
  readonly milestones: MobileMissionUpdatePayload["milestones"]
  readonly models?: MobileMissionUpdatePayload["models"]
  readonly timeoutMs?: MobileMissionUpdatePayload["timeoutMs"]
  readonly sandbox?: MobileMissionUpdatePayload["sandbox"]
  readonly worktree?: MobileMissionUpdatePayload["worktree"]
  readonly status?: MobileMissionUpdatePayload["status"]
  readonly createdAt: MobileMissionUpdatePayload["createdAt"]
}

export type MobileMissionUpdateOutput = MobileMissionDefinition

export type MobileMissionDeleteInput = { readonly id: { readonly id: string }["id"] }

export type MobileMissionDeleteOutput = MobileSuccess

export type MobileMissionExecsInput = {
  readonly id: { readonly id: string }["id"]
  readonly limit?: { readonly limit?: number | undefined }["limit"]
}

export type MobileMissionExecsOutput = { execs: Array<MobileMissionExec> }

export type MobileMissionStartInput = { readonly id: { readonly id: string }["id"] }

export type MobileMissionStartOutput = MobileSuccess

export type MobileMissionPauseInput = { readonly id: { readonly id: string }["id"] }

export type MobileMissionPauseOutput = MobileSuccess

export type MobileMissionCancelInput = { readonly id: { readonly id: string }["id"] }

export type MobileMissionCancelOutput = MobileSuccess

export type MobileMissionFeatureMutateInput = {
  readonly id: { readonly id: string; readonly featureID: string }["id"]
  readonly featureID: { readonly id: string; readonly featureID: string }["featureID"]
  readonly status?: MobileMissionFeatureMutatePayload["status"]
  readonly error?: MobileMissionFeatureMutatePayload["error"]
  readonly appendDependsOn?: MobileMissionFeatureMutatePayload["appendDependsOn"]
}

export type MobileMissionFeatureMutateOutput = MobileMissionDefinition

export type MobileEventsOutput = unknown

export type MobileBrainStatusOutput = {
  enabled: boolean
  memoryEnabled: boolean
  minHours: number
  minSessions: number
  lastBrainAt: number
  hoursSinceLastBrain: number
  sessionsSinceLastBrain: number
  shouldTrigger: boolean
  model?: { providerID: string; modelID: string } | undefined
}

export type MobileBrainTriggerInput = { readonly payload: { readonly force?: boolean | undefined } | undefined }

export type MobileBrainTriggerOutput = {
  success: boolean
  sessionsReviewed: number
  hoursSinceLastBrain: number
  error?: string | undefined
  sessionID?: string | undefined
}

export type MobileChatBotListOutput = {
  bots: Array<{ name: string; type: string; running: boolean; webhookPath: string }>
}

export type MobileChatBotStartInput = { readonly name: { readonly name: string }["name"] }

export type MobileChatBotStartOutput = { running: boolean; error?: string | undefined }

export type MobileChatBotStopInput = { readonly name: { readonly name: string }["name"] }

export type MobileChatBotStopOutput = { removed: boolean }

export type MobileObservabilityGetOutput = { enabled: boolean; otlpEndpoint: string | null }

export type MobileObservabilitySetInput = { readonly enabled: MobileObservabilitySetPayload["enabled"] }

export type MobileObservabilitySetOutput = { enabled: boolean; otlpEndpoint: string | null }

export type MobileLspStatusOutput = {
  servers: Array<{ id: string; name: string; root: string; status: "connected" | "error" }>
  error?: string | undefined
}

export type MobileFusionListOutput = { presets: Array<{ name: string; builtin: boolean; enabled: boolean }> }

export type MobileFusionSetInput = {
  readonly name: MobileFusionSetPayload["name"]
  readonly enabled: MobileFusionSetPayload["enabled"]
}

export type MobileFusionSetOutput = { name: string; enabled: boolean }

export type MobileHostBrowserOutput = {
  available: boolean
  reason?: string | undefined
  sessions?: Array<unknown> | undefined
}

export type MobileHostComputerOutput = {
  available: boolean
  reason?: string | undefined
  platform?: string | undefined
  screenshot?: boolean | undefined
  input?: boolean | undefined
  detail?: string | undefined
}

export type MobileHostHerdrGetOutput = {
  available: boolean
  reason?: string | undefined
  enabled?: boolean | undefined
  installed?: boolean | undefined
}

export type MobileHostHerdrSetInput = { readonly enabled: MobileHostHerdrSetPayload["enabled"] }

export type MobileHostHerdrSetOutput = {
  available: boolean
  reason?: string | undefined
  enabled?: boolean | undefined
  installed?: boolean | undefined
}

export type MobileHostIslandOutput = {
  available: boolean
  reason?: string | undefined
  supported?: boolean | undefined
  enabled?: boolean | undefined
  appRunning?: boolean | undefined
  sessions?: number | undefined
}

export type MobileHostDevtoolsOutput = {
  available: boolean
  reason?: string | undefined
  rss?: number | undefined
  heapUsed?: number | undefined
  heapTotal?: number | undefined
  external?: number | undefined
  pid?: number | undefined
  uptimeSec?: number | undefined
  platform?: string | undefined
}

export type MobileHostLanGetOutput = MobileHostLan

export type MobileHostLanStartInput = { readonly mdns?: MobileHostLanStartPayload["mdns"] }

export type MobileHostLanStartOutput = MobileHostLan

export type ProjectListOutput = Array<Project2>

export type ProjectCurrentOutput = Project2

export type ProjectUpdateInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly name?: ProjectUpdatePayload["name"]
  readonly icon?: ProjectUpdatePayload["icon"]
}

export type ProjectUpdateOutput = Project2

export type ProjectDirectoryListInput = { readonly projectID: { readonly projectID: string }["projectID"] }

export type ProjectDirectoryListOutput = Array<ProjectDirectory>

export type ProjectCopyCreateInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly strategy: ProjectCopyCreatePayload["strategy"]
  readonly directory: ProjectCopyCreatePayload["directory"]
  readonly name?: ProjectCopyCreatePayload["name"]
}

export type ProjectCopyCreateOutput = ProjectCopy

export type ProjectCopyRemoveInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly directory: ProjectCopyRemovePayload["directory"]
  readonly force: ProjectCopyRemovePayload["force"]
}

export type ProjectCopyRemoveOutput = void

export type ProjectCopyRefreshInput = { readonly projectID: { readonly projectID: string }["projectID"] }

export type ProjectCopyRefreshOutput = ProjectCopyRefresh

export type ProviderListOutput = ProviderList

export type ProviderAuthOutput = ProviderAuthMethods

export type ProviderApiInput = {
  readonly providerID: { readonly providerID: string }["providerID"]
  readonly key: ProviderApiPayload["key"]
}

export type ProviderApiOutput = ProviderMutationSuccess

export type ProviderRemoveAuthInput = { readonly providerID: { readonly providerID: string }["providerID"] }

export type ProviderRemoveAuthOutput = ProviderMutationSuccess

export type ProviderOauthAuthorizeInput = {
  readonly providerID: { readonly providerID: string }["providerID"]
  readonly method: ProviderOauthAuthorizePayload["method"]
}

export type ProviderOauthAuthorizeOutput = ProviderOAuthAuthorization | null

export type ProviderOauthCallbackInput = {
  readonly providerID: { readonly providerID: string }["providerID"]
  readonly method: ProviderOauthCallbackPayload["method"]
  readonly code?: ProviderOauthCallbackPayload["code"]
}

export type ProviderOauthCallbackOutput = boolean

export type QuestionListOutput = Array<QuestionRequest1>

export type QuestionReplyInput = {
  readonly requestID: { readonly requestID: string }["requestID"]
  readonly answers: QuestionReplyPayload["answers"]
}

export type QuestionReplyOutput = boolean

export type QuestionRejectInput = { readonly requestID: { readonly requestID: string }["requestID"] }

export type QuestionRejectOutput = boolean

export type PermissionListOutput = Array<PermissionRequest1>

export type PermissionBlockedOutput = Array<PermissionBlocked>

export type PermissionReplyInput = {
  readonly requestID: { readonly requestID: string }["requestID"]
  readonly reply: PermissionReplyPayload["reply"]
  readonly message?: PermissionReplyPayload["message"]
}

export type PermissionReplyOutput = boolean

export type PtyListOutput = PtyList

export type PtyCreateInput = {
  readonly command?: PtyCreatePayload["command"]
  readonly args?: PtyCreatePayload["args"]
  readonly cwd?: PtyCreatePayload["cwd"]
  readonly title?: PtyCreatePayload["title"]
  readonly env?: PtyCreatePayload["env"]
}

export type PtyCreateOutput = Pty1

export type PtyGetInput = { readonly ptyID: { readonly ptyID: string }["ptyID"] }

export type PtyGetOutput = Pty1

export type PtyUpdateInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly title?: PtyUpdatePayload["title"]
  readonly size?: PtyUpdatePayload["size"]
}

export type PtyUpdateOutput = Pty1

export type PtyRemoveInput = { readonly ptyID: { readonly ptyID: string }["ptyID"] }

export type PtyRemoveOutput = boolean

export type LoopListOutput = LoopListOutput2

export type LoopTemplatesOutput = LoopTemplatesOutput2

export type LoopGenerateInput = {
  readonly description: LoopGeneratePayload["description"]
  readonly model?: LoopGeneratePayload["model"]
  readonly agent?: LoopGeneratePayload["agent"]
  readonly sessionID?: LoopGeneratePayload["sessionID"]
}

export type LoopGenerateOutput = LoopDefinition

export type LoopRecentRunsInput = { readonly limit?: { readonly limit?: number }["limit"] }

export type LoopRecentRunsOutput = LoopRunsOutput2

export type LoopGetInput = { readonly id: { readonly id: string }["id"] }

export type LoopGetOutput = LoopGetOutput2

export type LoopUpsertInput = {
  readonly name: LoopUpsertPayload["name"]
  readonly stages: LoopUpsertPayload["stages"]
  readonly trigger: LoopUpsertPayload["trigger"]
  readonly maxRuns?: LoopUpsertPayload["maxRuns"]
  readonly timeoutMs?: LoopUpsertPayload["timeoutMs"]
  readonly createPR?: LoopUpsertPayload["createPR"]
  readonly sandbox?: LoopUpsertPayload["sandbox"]
  readonly worktree?: LoopUpsertPayload["worktree"]
  readonly paused?: LoopUpsertPayload["paused"]
  readonly enabled?: LoopUpsertPayload["enabled"]
}

export type LoopUpsertOutput = LoopDefinition

export type LoopUpdateInput = {
  readonly id: { readonly id: string }["id"]
  readonly name: LoopUpdatePayload["name"]
  readonly stages: LoopUpdatePayload["stages"]
  readonly trigger: LoopUpdatePayload["trigger"]
  readonly maxRuns?: LoopUpdatePayload["maxRuns"]
  readonly timeoutMs?: LoopUpdatePayload["timeoutMs"]
  readonly createPR?: LoopUpdatePayload["createPR"]
  readonly sandbox?: LoopUpdatePayload["sandbox"]
  readonly worktree?: LoopUpdatePayload["worktree"]
  readonly paused?: LoopUpdatePayload["paused"]
  readonly enabled: LoopUpdatePayload["enabled"]
  readonly createdAt: LoopUpdatePayload["createdAt"]
}

export type LoopUpdateOutput = LoopDefinition

export type LoopRemoveInput = { readonly id: { readonly id: string }["id"] }

export type LoopRemoveOutput = LoopBooleanResult

export type LoopToggleInput = {
  readonly id: { readonly id: string }["id"]
  readonly enabled: LoopTogglePayload["enabled"]
}

export type LoopToggleOutput = LoopDefinition

export type LoopRunInput = {
  readonly id: { readonly id: string }["id"]
  readonly sessionID?: LoopRunPayload["sessionID"]
}

export type LoopRunOutput = LoopBooleanResult

export type LoopAbortInput = { readonly id: { readonly id: string }["id"] }

export type LoopAbortOutput = LoopBooleanResult

export type LoopPauseInput = { readonly id: { readonly id: string }["id"] }

export type LoopPauseOutput = LoopBooleanResult

export type LoopResumeInput = { readonly id: { readonly id: string }["id"] }

export type LoopResumeOutput = LoopBooleanResult

export type LoopRunsInput = {
  readonly id: { readonly id: string }["id"]
  readonly limit?: { readonly limit?: number }["limit"]
}

export type LoopRunsOutput = LoopRunsOutput2

export type SessionListInput = {
  readonly directory?: {
    readonly directory?: string
    readonly roots?: boolean
    readonly start?: number
    readonly search?: string
    readonly limit?: number
  }["directory"]
  readonly roots?: {
    readonly directory?: string
    readonly roots?: boolean
    readonly start?: number
    readonly search?: string
    readonly limit?: number
  }["roots"]
  readonly start?: {
    readonly directory?: string
    readonly roots?: boolean
    readonly start?: number
    readonly search?: string
    readonly limit?: number
  }["start"]
  readonly search?: {
    readonly directory?: string
    readonly roots?: boolean
    readonly start?: number
    readonly search?: string
    readonly limit?: number
  }["search"]
  readonly limit?: {
    readonly directory?: string
    readonly roots?: boolean
    readonly start?: number
    readonly search?: string
    readonly limit?: number
  }["limit"]
}

export type SessionListOutput = SessionList

export type SessionCreateInput = {
  readonly parentID?: SessionCreatePayload["parentID"]
  readonly title?: SessionCreatePayload["title"]
  readonly permission?: SessionCreatePayload["permission"]
  readonly skills?: SessionCreatePayload["skills"]
  readonly github?: SessionCreatePayload["github"]
  readonly workspaceID?: SessionCreatePayload["workspaceID"]
}

export type SessionCreateOutput = Session2

export type SessionStatusOutput = SessionStatusMap

export type SessionGetInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionGetOutput = Session2

export type SessionRemoveInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionRemoveOutput = BooleanResult

export type SessionUpdateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly title?: SessionUpdatePayload["title"]
  readonly time?: SessionUpdatePayload["time"]
}

export type SessionUpdateOutput = Session2

export type SessionForkInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID?: SessionForkPayload["messageID"]
}

export type SessionForkOutput = Session2

export type SessionAbortInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionAbortOutput = BooleanResult

export type SessionRevertInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID: SessionRevertPayload["messageID"]
  readonly partID?: SessionRevertPayload["partID"]
}

export type SessionRevertOutput = Session2

export type SessionUnrevertInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionUnrevertOutput = Session2

export type SessionShareInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionShareOutput = Session2

export type SessionUnshareInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionUnshareOutput = Session2

export type SessionSummarizeInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly providerID: SessionSummarizePayload["providerID"]
  readonly modelID: SessionSummarizePayload["modelID"]
  readonly auto?: SessionSummarizePayload["auto"]
}

export type SessionSummarizeOutput = BooleanResult

export type SessionCommandInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID?: SessionCommandPayload["messageID"]
  readonly delivery?: SessionCommandPayload["delivery"]
  readonly agent?: SessionCommandPayload["agent"]
  readonly model?: SessionCommandPayload["model"]
  readonly arguments: SessionCommandPayload["arguments"]
  readonly command: SessionCommandPayload["command"]
  readonly variant?: SessionCommandPayload["variant"]
  readonly parts?: SessionCommandPayload["parts"]
}

export type SessionCommandOutput = MessageWithParts

export type SessionShellInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly agent: SessionShellPayload["agent"]
  readonly model?: SessionShellPayload["model"]
  readonly command: SessionShellPayload["command"]
}

export type SessionShellOutput = MessageWithParts

export type SessionPermissionRespondInput = {
  readonly sessionID: { readonly sessionID: string; readonly permissionID: string }["sessionID"]
  readonly permissionID: { readonly sessionID: string; readonly permissionID: string }["permissionID"]
  readonly response: SessionPermissionRespondPayload["response"]
}

export type SessionPermissionRespondOutput = BooleanResult

export type SessionChildrenInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionChildrenOutput = SessionList

export type SessionTodoInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionTodoOutput = TodoList

export type SessionDiffInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID?: { readonly messageID?: string }["messageID"]
}

export type SessionDiffOutput = FileDiffList

export type SessionMessagesInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: { readonly limit?: number }["limit"]
}

export type SessionMessagesOutput = MessageList

export type SessionPendingInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionPendingOutput = SessionPendingInputList

export type SessionPendingSteerInput = {
  readonly sessionID: { readonly sessionID: string; readonly pendingID: string }["sessionID"]
  readonly pendingID: { readonly sessionID: string; readonly pendingID: string }["pendingID"]
}

export type SessionPendingSteerOutput = SessionPendingInput2

export type SessionMessageInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type SessionMessageOutput = MessageWithParts

export type SessionMessageRemoveInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type SessionMessageRemoveOutput = BooleanResult

export type SessionPartRemoveInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string; readonly partID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string; readonly partID: string }["messageID"]
  readonly partID: { readonly sessionID: string; readonly messageID: string; readonly partID: string }["partID"]
}

export type SessionPartRemoveOutput = BooleanResult

export type SessionPartUpdateInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string; readonly partID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string; readonly partID: string }["messageID"]
  readonly partID: { readonly sessionID: string; readonly messageID: string; readonly partID: string }["partID"]
  readonly payload:
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "text"
        readonly text: string
        readonly synthetic?: boolean
        readonly ignored?: boolean
        readonly time?: { readonly start: number; readonly end?: number }
        readonly metadata?: { readonly [x: string]: any }
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "subtask"
        readonly prompt: string
        readonly description: string
        readonly agent: string
        readonly model?: { readonly providerID: string; readonly modelID: string }
        readonly command?: string
        readonly background?: boolean
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "reasoning"
        readonly text: string
        readonly metadata?: { readonly [x: string]: any }
        readonly time: { readonly start: number; readonly end?: number }
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "file"
        readonly mime: string
        readonly filename?: string
        readonly url: string
        readonly source?:
          | {
              readonly text: { readonly value: string; readonly start: number; readonly end: number }
              readonly type: "file"
              readonly path: string
            }
          | {
              readonly text: { readonly value: string; readonly start: number; readonly end: number }
              readonly type: "symbol"
              readonly path: string
              readonly range: {
                readonly start: { readonly line: number; readonly character: number }
                readonly end: { readonly line: number; readonly character: number }
              }
              readonly name: string
              readonly kind: number
            }
          | {
              readonly text: { readonly value: string; readonly start: number; readonly end: number }
              readonly type: "resource"
              readonly clientName: string
              readonly uri: string
            }
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "tool"
        readonly callID: string
        readonly tool: string
        readonly state:
          | { readonly status: "pending"; readonly input: { readonly [x: string]: any }; readonly raw: string }
          | {
              readonly status: "running"
              readonly input: { readonly [x: string]: any }
              readonly title?: string
              readonly metadata?: { readonly [x: string]: any }
              readonly structured?: { readonly [x: string]: any }
              readonly content?: ReadonlyArray<
                | { readonly type: "text"; readonly text: string }
                | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }
              >
              readonly time: { readonly start: number }
            }
          | {
              readonly status: "completed"
              readonly input: { readonly [x: string]: any }
              readonly output: string
              readonly title: string
              readonly metadata: { readonly [x: string]: any }
              readonly time: { readonly start: number; readonly end: number; readonly compacted?: number }
              readonly attachments?: ReadonlyArray<{
                readonly id: string
                readonly sessionID: string
                readonly messageID: string
                readonly type: "file"
                readonly mime: string
                readonly filename?: string
                readonly url: string
                readonly source?:
                  | {
                      readonly text: { readonly value: string; readonly start: number; readonly end: number }
                      readonly type: "file"
                      readonly path: string
                    }
                  | {
                      readonly text: { readonly value: string; readonly start: number; readonly end: number }
                      readonly type: "symbol"
                      readonly path: string
                      readonly range: {
                        readonly start: { readonly line: number; readonly character: number }
                        readonly end: { readonly line: number; readonly character: number }
                      }
                      readonly name: string
                      readonly kind: number
                    }
                  | {
                      readonly text: { readonly value: string; readonly start: number; readonly end: number }
                      readonly type: "resource"
                      readonly clientName: string
                      readonly uri: string
                    }
              }>
            }
          | {
              readonly status: "error"
              readonly input: { readonly [x: string]: any }
              readonly error: string
              readonly metadata?: { readonly [x: string]: any }
              readonly time: { readonly start: number; readonly end: number }
            }
        readonly metadata?: { readonly [x: string]: any }
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "step-start"
        readonly snapshot?: string
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "step-finish"
        readonly reason: string
        readonly snapshot?: string
        readonly cost: number
        readonly tokens: {
          readonly total?: number
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "snapshot"
        readonly snapshot: string
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "patch"
        readonly hash: string
        readonly files: ReadonlyArray<string>
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "agent"
        readonly name: string
        readonly source?: { readonly value: string; readonly start: number; readonly end: number }
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "retry"
        readonly attempt: number
        readonly error: {
          readonly name: "APIError"
          readonly data: {
            readonly message: string
            readonly statusCode?: number
            readonly isRetryable: boolean
            readonly responseHeaders?: { readonly [x: string]: string }
            readonly responseBody?: string
            readonly metadata?: { readonly [x: string]: string }
            readonly classification?: "payload-too-large"
          }
        }
        readonly time: { readonly created: number }
      }
    | {
        readonly id: string
        readonly sessionID: string
        readonly messageID: string
        readonly type: "compaction"
        readonly auto: boolean
      }
}

export type SessionPartUpdateOutput = Part1

export type SessionV2EntriesInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionV2EntriesOutput = SessionV2EntryList

export type SessionV2StateInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionV2StateOutput = SessionV2State

export type SessionV2EventsInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionV2EventsOutput = SessionV2EventList

export type SessionInstructionsInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionInstructionsOutput = SessionInstructionList

export type SessionContextBreakdownInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionContextBreakdownOutput = SessionContextBreakdown

export type SessionContextToggleInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly kind: SessionContextTogglePayload["kind"]
  readonly key: SessionContextTogglePayload["key"]
  readonly enabled: SessionContextTogglePayload["enabled"]
}

export type SessionContextToggleOutput = SessionContextBreakdown

export type SessionGoalInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionGoalOutput = SessionGoalOutput2

export type SessionBackgroundInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionBackgroundOutput = SessionBackgroundOutput2

export type SessionBackgroundInspectInput = {
  readonly sessionID: { readonly sessionID: string; readonly delegationID: string }["sessionID"]
  readonly delegationID: { readonly sessionID: string; readonly delegationID: string }["delegationID"]
}

export type SessionBackgroundInspectOutput = SessionBackgroundInspectOutput2

export type SessionBackgroundReadInput = {
  readonly sessionID: { readonly sessionID: string; readonly delegationID: string }["sessionID"]
  readonly delegationID: { readonly sessionID: string; readonly delegationID: string }["delegationID"]
}

export type SessionBackgroundReadOutput = string

export type SessionBackgroundCancelInput = {
  readonly sessionID: { readonly sessionID: string; readonly delegationID: string }["sessionID"]
  readonly delegationID: { readonly sessionID: string; readonly delegationID: string }["delegationID"]
}

export type SessionBackgroundCancelOutput = boolean

export type SessionBackgroundResumeInput = {
  readonly sessionID: { readonly sessionID: string; readonly delegationID: string }["sessionID"]
  readonly delegationID: { readonly sessionID: string; readonly delegationID: string }["delegationID"]
}

export type SessionBackgroundResumeOutput = boolean

export type SessionMonitorInput = {
  readonly sessionID: { readonly sessionID: string; readonly monitorID: string }["sessionID"]
  readonly monitorID: { readonly sessionID: string; readonly monitorID: string }["monitorID"]
}

export type SessionMonitorOutput = SessionMonitorOutput2

export type SessionMonitorLogInput = {
  readonly sessionID: { readonly sessionID: string; readonly monitorID: string }["sessionID"]
  readonly monitorID: { readonly sessionID: string; readonly monitorID: string }["monitorID"]
  readonly lines?: { readonly lines?: number }["lines"]
}

export type SessionMonitorLogOutput = SessionMonitorLogOutput2

export type SessionMonitorCancelInput = {
  readonly sessionID: { readonly sessionID: string; readonly monitorID: string }["sessionID"]
  readonly monitorID: { readonly sessionID: string; readonly monitorID: string }["monitorID"]
}

export type SessionMonitorCancelOutput = SessionMonitorOutput2

export type AccountActiveOutput = AccountResponse

export type AccountLoginOutput = AccountResponse

export type AccountCompleteInput = {
  readonly deviceCode: AccountCompletePayload["deviceCode"]
  readonly expiresIn?: AccountCompletePayload["expiresIn"]
}

export type AccountCompleteOutput = AccountResponse

export type SyncEventInput = {
  readonly event: SyncEventPayload["event"]
  readonly projectID: SyncEventPayload["projectID"]
}

export type SyncEventOutput = void

export type SyncOutboxInput = {
  readonly projectID: { readonly projectID: string; readonly since?: number | undefined }["projectID"]
  readonly since?: { readonly projectID: string; readonly since?: number | undefined }["since"]
}

export type SyncOutboxOutput = SyncOutboxResponse

export type SyncSnapshotInput = {
  readonly aggregateID: { readonly aggregateID: string }["aggregateID"]
  readonly projectID: { readonly projectID: string }["projectID"]
}

export type SyncSnapshotOutput = SyncSnapshotResponse

export type SyncStreamInput = {
  readonly projectID: { readonly projectID: string; readonly token: string }["projectID"]
  readonly token: { readonly projectID: string; readonly token: string }["token"]
}

export type SyncStreamOutput = unknown

export type SyncStatsInput = { readonly projectID?: { readonly projectID?: string | undefined }["projectID"] }

export type SyncStatsOutput = SyncStatsOutput2

export type SyncConfigInput = {
  readonly url: SyncConfigPayload["url"]
  readonly token?: SyncConfigPayload["token"]
  readonly autostart?: SyncConfigPayload["autostart"]
}

export type SyncConfigOutput = SyncConfigSetResponse

export type SyncConnectOutput = void

export type SyncDisconnectOutput = void

export type SyncDrainOutput = void

export type TuiAppendPromptInput = { readonly text: TuiAppendPromptPayload["text"] }

export type TuiAppendPromptOutput = TuiBooleanResult

export type TuiOpenHelpOutput = TuiBooleanResult

export type TuiOpenSessionsOutput = TuiBooleanResult

export type TuiOpenThemesOutput = TuiBooleanResult

export type TuiOpenModelsOutput = TuiBooleanResult

export type TuiSubmitPromptOutput = TuiBooleanResult

export type TuiClearPromptOutput = TuiBooleanResult

export type TuiExecuteCommandInput = { readonly command: TuiExecuteCommandPayload["command"] }

export type TuiExecuteCommandOutput = TuiBooleanResult

export type TuiShowToastInput = {
  readonly title?: TuiShowToastPayload["title"]
  readonly message: TuiShowToastPayload["message"]
  readonly variant: TuiShowToastPayload["variant"]
  readonly duration: TuiShowToastPayload["duration"]
}

export type TuiShowToastOutput = TuiBooleanResult

export type TuiPublishInput = {
  readonly type: TuiPublishPayload["type"]
  readonly properties: TuiPublishPayload["properties"]
}

export type TuiPublishOutput = TuiBooleanResult

export type TuiSelectSessionInput = { readonly sessionID: TuiSelectSessionPayload["sessionID"] }

export type TuiSelectSessionOutput = TuiBooleanResult

export type TuiConfigOutput = TuiConfig

export type TuiControlNextOutput = TuiControlRequest

export type TuiControlResponseInput = {
  readonly path: TuiControlResponsePayload["path"]
  readonly body: TuiControlResponsePayload["body"]
}

export type TuiControlResponseOutput = TuiBooleanResult

export type WorkspaceAdaptorsOutput = Array<WorkspaceAdaptorInfo>

export type WorkspaceSyncListOutput = void

export type WorkspaceStatusOutput = Array<WorkspaceConnectionStatus>

export type WorkspaceCreateInput = {
  readonly id: { readonly id: string }["id"]
  readonly branch: WorkspaceCreatePayload["branch"]
  readonly config: WorkspaceCreatePayload["config"]
}

export type WorkspaceCreateOutput = Workspace1

export type WorkspaceListOutput = Array<Workspace1>

export type WorkspaceRemoveInput = { readonly id: { readonly id: string }["id"] }

export type WorkspaceRemoveOutput = OptionalWorkspace

export type WorkspaceRestoreInput = {
  readonly id: { readonly id: string }["id"]
  readonly timeoutMs?: { readonly timeoutMs?: number | undefined }["timeoutMs"]
}

export type WorkspaceRestoreOutput = WorkspaceRestore

export type WorkspaceSessionRestoreInput = {
  readonly id: { readonly id: string; readonly sessionID: string }["id"]
  readonly sessionID: { readonly id: string; readonly sessionID: string }["sessionID"]
  readonly timeoutMs?: { readonly timeoutMs?: number | undefined }["timeoutMs"]
}

export type WorkspaceSessionRestoreOutput = WorkspaceSessionRestore

export type WorkspaceWarpInput = {
  readonly id: WorkspaceWarpPayload["id"]
  readonly sessionID: WorkspaceWarpPayload["sessionID"]
  readonly copyChanges?: WorkspaceWarpPayload["copyChanges"]
  readonly timeoutMs?: WorkspaceWarpPayload["timeoutMs"]
}

export type WorkspaceWarpOutput = void

export type AuthSetInput = {
  readonly providerID: { readonly providerID: string }["providerID"]
  readonly payload:
    | {
        readonly type: "oauth"
        readonly refresh: string
        readonly access: string
        readonly expires: number
        readonly accountId?: string | undefined
        readonly enterpriseUrl?: string | undefined
      }
    | { readonly type: "api"; readonly key: string }
    | { readonly type: "wellknown"; readonly key: string; readonly token: string }
}

export type AuthSetOutput = boolean

export type AuthRemoveInput = { readonly providerID: { readonly providerID: string }["providerID"] }

export type AuthRemoveOutput = boolean

export type ConfigManagementReloadOutput = ConfigReloadResponse

export type ConfigManagementMcpAddInput = {
  readonly name: ConfigManagementMcpAddPayload["name"]
  readonly config: ConfigManagementMcpAddPayload["config"]
}

export type ConfigManagementMcpAddOutput = SuccessFlag

export type ConfigManagementMcpUpdateInput = {
  readonly name: { readonly name: string }["name"]
  readonly payload: { readonly [x: string]: any }
}

export type ConfigManagementMcpUpdateOutput = SuccessFlag

export type ConfigManagementMcpRemoveInput = { readonly name: { readonly name: string }["name"] }

export type ConfigManagementMcpRemoveOutput = SuccessFlag

export type ConfigManagementProfilesListOutput = ConfigProfilesList

export type ConfigManagementProfileCreateInput = { readonly name: ConfigManagementProfileCreatePayload["name"] }

export type ConfigManagementProfileCreateOutput = SuccessFlag

export type ConfigManagementProfileActivateInput = { readonly name: { readonly name: string }["name"] }

export type ConfigManagementProfileActivateOutput = SuccessFlag

export type SessionPromptPromptInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID?: SessionPromptPromptPayload["messageID"]
  readonly delivery?: SessionPromptPromptPayload["delivery"]
  readonly model?: SessionPromptPromptPayload["model"]
  readonly agent?: SessionPromptPromptPayload["agent"]
  readonly noReply?: SessionPromptPromptPayload["noReply"]
  readonly tools?: SessionPromptPromptPayload["tools"]
  readonly format?: SessionPromptPromptPayload["format"]
  readonly system?: SessionPromptPromptPayload["system"]
  readonly variant?: SessionPromptPromptPayload["variant"]
  readonly parts: SessionPromptPromptPayload["parts"]
}

export type SessionPromptPromptOutput = SessionPromptResponse

export type SessionPromptPromptAsyncInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID?: SessionPromptPromptAsyncPayload["messageID"]
  readonly delivery?: SessionPromptPromptAsyncPayload["delivery"]
  readonly model?: SessionPromptPromptAsyncPayload["model"]
  readonly agent?: SessionPromptPromptAsyncPayload["agent"]
  readonly noReply?: SessionPromptPromptAsyncPayload["noReply"]
  readonly tools?: SessionPromptPromptAsyncPayload["tools"]
  readonly format?: SessionPromptPromptAsyncPayload["format"]
  readonly system?: SessionPromptPromptAsyncPayload["system"]
  readonly variant?: SessionPromptPromptAsyncPayload["variant"]
  readonly parts: SessionPromptPromptAsyncPayload["parts"]
}

export type SessionPromptPromptAsyncOutput = void

export type ShareShortInput = { readonly shareID: { readonly shareID: string }["shareID"] }

export type ShareShortOutput = { readonly body: void; readonly headers: { readonly location: string } }

export type SharePageInput = { readonly shareID: { readonly shareID: string }["shareID"] }

export type SharePageOutput = ShareData

export type ShareApiInput = { readonly shareID: { readonly shareID: string }["shareID"] }

export type ShareApiOutput = ShareData

export type ShareDataInput = { readonly shareID: { readonly shareID: string }["shareID"] }

export type ShareDataOutput = ShareData

export type EventsSubscribeOutput = Event

export type EventsGlobalOutput = GlobalEvent

export type WorkspaceExtraEventsInput = {
  readonly id: { readonly id: string }["id"]
  readonly from?: { readonly from?: number | undefined }["from"]
}

export type WorkspaceExtraEventsOutput = Array<WorkspaceJournalEvent>

export type WorkspaceExtraSessionWarpInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly workspaceID: WorkspaceExtraSessionWarpPayload["workspaceID"]
  readonly copyChanges?: WorkspaceExtraSessionWarpPayload["copyChanges"]
  readonly timeoutMs?: WorkspaceExtraSessionWarpPayload["timeoutMs"]
}

export type WorkspaceExtraSessionWarpOutput = WorkspaceSessionWarpResponse

export type UsersRegisterInput = {
  readonly username: UsersRegisterPayload["username"]
  readonly email: UsersRegisterPayload["email"]
  readonly password: UsersRegisterPayload["password"]
  readonly displayName?: UsersRegisterPayload["displayName"]
}

export type UsersRegisterOutput = UserSession

export type UsersLoginInput = {
  readonly email: UsersLoginPayload["email"]
  readonly password: UsersLoginPayload["password"]
}

export type UsersLoginOutput = UserSession

export type UsersUpdateInput = {
  readonly id: { readonly id: string }["id"]
  readonly displayName?: UsersUpdatePayload["displayName"]
  readonly password?: UsersUpdatePayload["password"]
  readonly role?: UsersUpdatePayload["role"]
}

export type UsersUpdateOutput = PublicUser
