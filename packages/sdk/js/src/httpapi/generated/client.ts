import type {
  TopLevelDisposeOutput,
  TopLevelPathOutput,
  TopLevelVcsOutput,
  TopLevelVcsStatusOutput,
  TopLevelVcsDiffRawOutput,
  TopLevelVcsApplyInput,
  TopLevelVcsApplyOutput,
  TopLevelCommandOutput,
  TopLevelAgentOutput,
  TopLevelSkillOutput,
  TopLevelLspOutput,
  TopLevelFormatterOutput,
  AnalyticsGlobalOutput,
  AnalyticsDailyInput,
  AnalyticsDailyOutput,
  AnalyticsSessionInput,
  AnalyticsSessionOutput,
  AnalyticsSessionsOutput,
  AnalyticsLeaderboardOutput,
  AnalyticsDataInput,
  AnalyticsDataOutput,
  AppLogInput,
  AppLogOutput,
  AppSkillCreateInput,
  AppSkillCreateOutput,
  AppSkillDeleteInput,
  AppSkillDeleteOutput,
  BrainStatusOutput,
  BrainTriggerInput,
  BrainTriggerOutput,
  ChatbotBotsOutput,
  ChatbotStartInput,
  ChatbotStartOutput,
  ChatbotStopInput,
  ChatbotStopOutput,
  DiscordStatusOutput,
  DiscordSetupInput,
  DiscordSetupOutput,
  DiscordStartOutput,
  DiscordStopOutput,
  VoiceTranscribeInput,
  VoiceTranscribeOutput,
  ProfileGetOutput,
  ProfilePatchInput,
  ProfilePatchOutput,
  ProfileClearOutput,
  ProfileHabitsInput,
  ProfileHabitsOutput,
  ProfilePreviewInput,
  ProfilePreviewOutput,
  ProfileClearHabitsInput,
  ProfileClearHabitsOutput,
  ConfigGetOutput,
  ConfigUpdateInput,
  ConfigUpdateOutput,
  ConfigProvidersOutput,
  ConnectorsStatusOutput,
  ConnectorsAuthSetInput,
  ConnectorsAuthSetOutput,
  ConnectorsAuthRemoveInput,
  ConnectorsAuthRemoveOutput,
  ConnectorsInvalidateInput,
  ConnectorsInvalidateOutput,
  DoctorRunOutput,
  ExperimentalToolIDsOutput,
  ExperimentalToolsInput,
  ExperimentalToolsOutput,
  ExperimentalWorktreeCreateInput,
  ExperimentalWorktreeCreateOutput,
  ExperimentalWorktreeOutput,
  ExperimentalWorktreeRemoveInput,
  ExperimentalWorktreeRemoveOutput,
  ExperimentalWorktreeResetInput,
  ExperimentalWorktreeResetOutput,
  ExperimentalResourceOutput,
  ExperimentalManagedWorktreeCreateInput,
  ExperimentalManagedWorktreeCreateOutput,
  ExperimentalManagedWorktreeRemoveInput,
  ExperimentalManagedWorktreeRemoveOutput,
  ExperimentalManagedWorktreeLinkInput,
  ExperimentalManagedWorktreeLinkOutput,
  ExperimentalManagedWorktreeChildrenInput,
  ExperimentalManagedWorktreeChildrenOutput,
  ExperimentalManagedWorktreeAncestorsInput,
  ExperimentalManagedWorktreeAncestorsOutput,
  ExperimentalManagedWorktreeListOutput,
  FileFindTextInput,
  FileFindTextOutput,
  FileFindFileInput,
  FileFindFileOutput,
  FileFindSymbolInput,
  FileFindSymbolOutput,
  FileListInput,
  FileListOutput,
  FileContentInput,
  FileContentOutput,
  FileWriteInput,
  FileWriteOutput,
  FileStatusOutput,
  GlobalHealthOutput,
  GlobalDisposeOutput,
  McpStatusOutput,
  McpAddInput,
  McpAddOutput,
  McpStartAuthInput,
  McpStartAuthOutput,
  McpAuthCallbackInput,
  McpAuthCallbackOutput,
  McpAuthenticateInput,
  McpAuthenticateOutput,
  McpRemoveAuthInput,
  McpRemoveAuthOutput,
  McpConnectInput,
  McpConnectOutput,
  McpDisconnectInput,
  McpDisconnectOutput,
  McpToggleInput,
  McpToggleOutput,
  MissionListOutput,
  MissionTemplatesOutput,
  MissionGenerateInput,
  MissionGenerateOutput,
  MissionRecentExecsInput,
  MissionRecentExecsOutput,
  MissionGetInput,
  MissionGetOutput,
  MissionUpsertInput,
  MissionUpsertOutput,
  MissionUpdateInput,
  MissionUpdateOutput,
  MissionRemoveInput,
  MissionRemoveOutput,
  MissionStartInput,
  MissionStartOutput,
  MissionPauseInput,
  MissionPauseOutput,
  MissionCancelInput,
  MissionCancelOutput,
  MissionFeatureMutateInput,
  MissionFeatureMutateOutput,
  MissionExecsInput,
  MissionExecsOutput,
  MobileAuthTokenListOutput,
  MobileAuthTokenCreateInput,
  MobileAuthTokenCreateOutput,
  MobileAuthTokenRevokeInput,
  MobileAuthTokenRevokeOutput,
  MobileBootstrapOutput,
  MobileCommandListOutput,
  MobileProjectListOutput,
  MobileMemoryHistoryOutput,
  MobileMemorySearchInput,
  MobileMemorySearchOutput,
  MobileMemoryStashListOutput,
  MobileMemoryStashCreateInput,
  MobileMemoryStashCreateOutput,
  MobileMemoryStashDeleteInput,
  MobileMemoryStashDeleteOutput,
  MobileGithubReposOutput,
  MobileGithubBranchesInput,
  MobileGithubBranchesOutput,
  MobileGithubWorkflowsInput,
  MobileGithubWorkflowsOutput,
  MobileGithubWorkflowRunsInput,
  MobileGithubWorkflowRunsOutput,
  MobileGithubWorkflowRunJobsInput,
  MobileGithubWorkflowRunJobsOutput,
  MobileGithubWorkflowRunRerunInput,
  MobileGithubWorkflowRunRerunOutput,
  MobileGithubWorkflowRunCancelInput,
  MobileGithubWorkflowRunCancelOutput,
  MobileGithubWorkflowDispatchInput,
  MobileGithubWorkflowDispatchOutput,
  MobileGithubImportsOutput,
  MobileGithubOauthClientInput,
  MobileGithubOauthClientOutput,
  MobileGithubOauthDeviceStartOutput,
  MobileGithubOauthDevicePollInput,
  MobileGithubOauthDevicePollOutput,
  MobileGithubAuthSetInput,
  MobileGithubAuthSetOutput,
  MobileGithubAuthRemoveOutput,
  MobileGithubImportInput,
  MobileGithubImportOutput,
  MobileGithubSessionCreateInput,
  MobileGithubSessionCreateOutput,
  MobileSessionListInput,
  MobileSessionListOutput,
  MobileSessionCreateInput,
  MobileSessionCreateOutput,
  MobileSessionDetailInput,
  MobileSessionDetailOutput,
  MobileSessionDeleteInput,
  MobileSessionDeleteOutput,
  MobileSessionDiffInput,
  MobileSessionDiffOutput,
  MobileSessionCommandListInput,
  MobileSessionCommandListOutput,
  MobileSessionCommandInput,
  MobileSessionCommandOutput,
  MobileSessionMessageInput,
  MobileSessionMessageOutput,
  MobileSessionAbortInput,
  MobileSessionAbortOutput,
  MobilePermissionRespondInput,
  MobilePermissionRespondOutput,
  MobileQuestionRespondInput,
  MobileQuestionRespondOutput,
  MobileQuestionRejectInput,
  MobileQuestionRejectOutput,
  MobileSessionPublishInput,
  MobileSessionPublishOutput,
  MobileSessionCleanupInput,
  MobileSessionCleanupOutput,
  MobileSessionStreamInput,
  MobileSessionStreamOutput,
  MobileSessionRenameInput,
  MobileSessionRenameOutput,
  MobileSessionTodoInput,
  MobileSessionTodoOutput,
  MobileTeleportUploadBeginOutput,
  MobileTeleportUploadChunkInput,
  MobileTeleportUploadChunkOutput,
  MobileTeleportInInput,
  MobileTeleportInOutput,
  MobileTeleportOutInput,
  MobileTeleportOutOutput,
  MobileWorktreeCreateInput,
  MobileWorktreeCreateOutput,
  MobileWorktreeRemoveInput,
  MobileWorktreeRemoveOutput,
  MobileWorktreeResetInput,
  MobileWorktreeResetOutput,
  MobileGitStatusOutput,
  MobileGitDiffInput,
  MobileGitDiffOutput,
  MobileGitCommitsInput,
  MobileGitCommitsOutput,
  MobileGitBranchesOutput,
  MobileGitCommitInput,
  MobileGitCommitOutput,
  MobileGitCheckoutInput,
  MobileGitCheckoutOutput,
  MobileGitStageInput,
  MobileGitStageOutput,
  MobileGitUnstageInput,
  MobileGitUnstageOutput,
  MobileGitDiscardInput,
  MobileGitDiscardOutput,
  MobileGitPushInput,
  MobileGitPushOutput,
  MobileGitPullOutput,
  MobileLoopListOutput,
  MobileLoopCreateInput,
  MobileLoopCreateOutput,
  MobileLoopTemplatesOutput,
  MobileLoopGenerateInput,
  MobileLoopGenerateOutput,
  MobileLoopRunsRecentInput,
  MobileLoopRunsRecentOutput,
  MobileLoopGetInput,
  MobileLoopGetOutput,
  MobileLoopDeleteInput,
  MobileLoopDeleteOutput,
  MobileLoopUpdateInput,
  MobileLoopUpdateOutput,
  MobileLoopRunsInput,
  MobileLoopRunsOutput,
  MobileLoopRunInput,
  MobileLoopRunOutput,
  MobileLoopAbortInput,
  MobileLoopAbortOutput,
  MobileLoopToggleInput,
  MobileLoopToggleOutput,
  MobileLoopPauseInput,
  MobileLoopPauseOutput,
  MobileLoopResumeInput,
  MobileLoopResumeOutput,
  MobileRoutineListOutput,
  MobileRoutineCreateInput,
  MobileRoutineCreateOutput,
  MobileRoutineGetInput,
  MobileRoutineGetOutput,
  MobileRoutineDeleteInput,
  MobileRoutineDeleteOutput,
  MobileRoutineUpdateInput,
  MobileRoutineUpdateOutput,
  MobileRoutineRunInput,
  MobileRoutineRunOutput,
  MobileRoutinePauseInput,
  MobileRoutinePauseOutput,
  MobileRoutineResumeInput,
  MobileRoutineResumeOutput,
  MobileRoutineTriggerInput,
  MobileRoutineTriggerOutput,
  MobilePtyListOutput,
  MobilePtyCreateInput,
  MobilePtyCreateOutput,
  MobilePtyGetInput,
  MobilePtyGetOutput,
  MobilePtyUpdateInput,
  MobilePtyUpdateOutput,
  MobilePtyRemoveInput,
  MobilePtyRemoveOutput,
  MobileMissionListOutput,
  MobileMissionCreateInput,
  MobileMissionCreateOutput,
  MobileMissionTemplatesOutput,
  MobileMissionGenerateInput,
  MobileMissionGenerateOutput,
  MobileMissionExecsRecentInput,
  MobileMissionExecsRecentOutput,
  MobileMissionGetInput,
  MobileMissionGetOutput,
  MobileMissionUpdateInput,
  MobileMissionUpdateOutput,
  MobileMissionDeleteInput,
  MobileMissionDeleteOutput,
  MobileMissionExecsInput,
  MobileMissionExecsOutput,
  MobileMissionStartInput,
  MobileMissionStartOutput,
  MobileMissionPauseInput,
  MobileMissionPauseOutput,
  MobileMissionCancelInput,
  MobileMissionCancelOutput,
  MobileMissionFeatureMutateInput,
  MobileMissionFeatureMutateOutput,
  MobileEventsOutput,
  MobileBrainStatusOutput,
  MobileBrainTriggerInput,
  MobileBrainTriggerOutput,
  MobileChatBotListOutput,
  MobileChatBotStartInput,
  MobileChatBotStartOutput,
  MobileChatBotStopInput,
  MobileChatBotStopOutput,
  MobileObservabilityGetOutput,
  MobileObservabilitySetInput,
  MobileObservabilitySetOutput,
  MobileLspStatusOutput,
  MobileFusionListOutput,
  MobileFusionSetInput,
  MobileFusionSetOutput,
  MobileHostBrowserOutput,
  MobileHostComputerOutput,
  MobileHostHerdrGetOutput,
  MobileHostHerdrSetInput,
  MobileHostHerdrSetOutput,
  MobileHostIslandOutput,
  MobileHostDevtoolsOutput,
  MobileHostLanGetOutput,
  MobileHostLanStartInput,
  MobileHostLanStartOutput,
  ProjectListOutput,
  ProjectCurrentOutput,
  ProjectUpdateInput,
  ProjectUpdateOutput,
  ProjectDirectoryListInput,
  ProjectDirectoryListOutput,
  ProjectCopyCreateInput,
  ProjectCopyCreateOutput,
  ProjectCopyRemoveInput,
  ProjectCopyRemoveOutput,
  ProjectCopyRefreshInput,
  ProjectCopyRefreshOutput,
  ProviderListOutput,
  ProviderAuthOutput,
  ProviderApiInput,
  ProviderApiOutput,
  ProviderRemoveAuthInput,
  ProviderRemoveAuthOutput,
  ProviderOauthAuthorizeInput,
  ProviderOauthAuthorizeOutput,
  ProviderOauthCallbackInput,
  ProviderOauthCallbackOutput,
  QuestionListOutput,
  QuestionReplyInput,
  QuestionReplyOutput,
  QuestionRejectInput,
  QuestionRejectOutput,
  PermissionListOutput,
  PermissionBlockedOutput,
  PermissionReplyInput,
  PermissionReplyOutput,
  PtyListOutput,
  PtyCreateInput,
  PtyCreateOutput,
  PtyGetInput,
  PtyGetOutput,
  PtyUpdateInput,
  PtyUpdateOutput,
  PtyRemoveInput,
  PtyRemoveOutput,
  LoopListOutput,
  LoopTemplatesOutput,
  LoopGenerateInput,
  LoopGenerateOutput,
  LoopRecentRunsInput,
  LoopRecentRunsOutput,
  LoopGetInput,
  LoopGetOutput,
  LoopUpsertInput,
  LoopUpsertOutput,
  LoopUpdateInput,
  LoopUpdateOutput,
  LoopRemoveInput,
  LoopRemoveOutput,
  LoopToggleInput,
  LoopToggleOutput,
  LoopRunInput,
  LoopRunOutput,
  LoopAbortInput,
  LoopAbortOutput,
  LoopPauseInput,
  LoopPauseOutput,
  LoopResumeInput,
  LoopResumeOutput,
  LoopRunsInput,
  LoopRunsOutput,
  SessionListInput,
  SessionListOutput,
  SessionCreateInput,
  SessionCreateOutput,
  SessionStatusOutput,
  SessionGetInput,
  SessionGetOutput,
  SessionRemoveInput,
  SessionRemoveOutput,
  SessionUpdateInput,
  SessionUpdateOutput,
  SessionForkInput,
  SessionForkOutput,
  SessionAbortInput,
  SessionAbortOutput,
  SessionRevertInput,
  SessionRevertOutput,
  SessionUnrevertInput,
  SessionUnrevertOutput,
  SessionShareInput,
  SessionShareOutput,
  SessionUnshareInput,
  SessionUnshareOutput,
  SessionSummarizeInput,
  SessionSummarizeOutput,
  SessionCommandInput,
  SessionCommandOutput,
  SessionShellInput,
  SessionShellOutput,
  SessionPermissionRespondInput,
  SessionPermissionRespondOutput,
  SessionChildrenInput,
  SessionChildrenOutput,
  SessionTodoInput,
  SessionTodoOutput,
  SessionDiffInput,
  SessionDiffOutput,
  SessionMessagesInput,
  SessionMessagesOutput,
  SessionPendingInput,
  SessionPendingOutput,
  SessionPendingSteerInput,
  SessionPendingSteerOutput,
  SessionMessageInput,
  SessionMessageOutput,
  SessionMessageRemoveInput,
  SessionMessageRemoveOutput,
  SessionPartRemoveInput,
  SessionPartRemoveOutput,
  SessionPartUpdateInput,
  SessionPartUpdateOutput,
  SessionV2EntriesInput,
  SessionV2EntriesOutput,
  SessionV2StateInput,
  SessionV2StateOutput,
  SessionV2EventsInput,
  SessionV2EventsOutput,
  SessionInstructionsInput,
  SessionInstructionsOutput,
  SessionContextBreakdownInput,
  SessionContextBreakdownOutput,
  SessionContextToggleInput,
  SessionContextToggleOutput,
  SessionGoalInput,
  SessionGoalOutput,
  SessionBackgroundInput,
  SessionBackgroundOutput,
  SessionBackgroundInspectInput,
  SessionBackgroundInspectOutput,
  SessionBackgroundReadInput,
  SessionBackgroundReadOutput,
  SessionBackgroundCancelInput,
  SessionBackgroundCancelOutput,
  SessionBackgroundResumeInput,
  SessionBackgroundResumeOutput,
  SessionMonitorInput,
  SessionMonitorOutput,
  SessionMonitorLogInput,
  SessionMonitorLogOutput,
  SessionMonitorCancelInput,
  SessionMonitorCancelOutput,
  AccountActiveOutput,
  AccountLoginOutput,
  AccountCompleteInput,
  AccountCompleteOutput,
  SyncEventInput,
  SyncEventOutput,
  SyncOutboxInput,
  SyncOutboxOutput,
  SyncSnapshotInput,
  SyncSnapshotOutput,
  SyncStreamInput,
  SyncStreamOutput,
  SyncStatsInput,
  SyncStatsOutput,
  SyncConfigInput,
  SyncConfigOutput,
  SyncConnectOutput,
  SyncDisconnectOutput,
  SyncDrainOutput,
  TuiAppendPromptInput,
  TuiAppendPromptOutput,
  TuiOpenHelpOutput,
  TuiOpenSessionsOutput,
  TuiOpenThemesOutput,
  TuiOpenModelsOutput,
  TuiSubmitPromptOutput,
  TuiClearPromptOutput,
  TuiExecuteCommandInput,
  TuiExecuteCommandOutput,
  TuiShowToastInput,
  TuiShowToastOutput,
  TuiPublishInput,
  TuiPublishOutput,
  TuiSelectSessionInput,
  TuiSelectSessionOutput,
  TuiConfigOutput,
  TuiControlNextOutput,
  TuiControlResponseInput,
  TuiControlResponseOutput,
  WorkspaceAdaptorsOutput,
  WorkspaceSyncListOutput,
  WorkspaceStatusOutput,
  WorkspaceCreateInput,
  WorkspaceCreateOutput,
  WorkspaceListOutput,
  WorkspaceRemoveInput,
  WorkspaceRemoveOutput,
  WorkspaceRestoreInput,
  WorkspaceRestoreOutput,
  WorkspaceSessionRestoreInput,
  WorkspaceSessionRestoreOutput,
  WorkspaceWarpInput,
  WorkspaceWarpOutput,
  AuthSetInput,
  AuthSetOutput,
  AuthRemoveInput,
  AuthRemoveOutput,
  ConfigManagementReloadOutput,
  ConfigManagementMcpAddInput,
  ConfigManagementMcpAddOutput,
  ConfigManagementMcpUpdateInput,
  ConfigManagementMcpUpdateOutput,
  ConfigManagementMcpRemoveInput,
  ConfigManagementMcpRemoveOutput,
  ConfigManagementProfilesListOutput,
  ConfigManagementProfileCreateInput,
  ConfigManagementProfileCreateOutput,
  ConfigManagementProfileActivateInput,
  ConfigManagementProfileActivateOutput,
  SessionPromptPromptInput,
  SessionPromptPromptOutput,
  SessionPromptPromptAsyncInput,
  SessionPromptPromptAsyncOutput,
  ShareShortInput,
  ShareShortOutput,
  SharePageInput,
  SharePageOutput,
  ShareApiInput,
  ShareApiOutput,
  ShareDataInput,
  ShareDataOutput,
  EventsSubscribeOutput,
  EventsGlobalOutput,
  WorkspaceExtraEventsInput,
  WorkspaceExtraEventsOutput,
  WorkspaceExtraSessionWarpInput,
  WorkspaceExtraSessionWarpOutput,
  UsersRegisterInput,
  UsersRegisterOutput,
  UsersLoginInput,
  UsersLoginOutput,
  UsersUpdateInput,
  UsersUpdateOutput,
} from "./types.js"
import { ClientError } from "./client-error.js"

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: RequestInit["headers"]
}

export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly headers?: RequestInit["headers"]
}

interface RequestDescriptor {
  readonly method: string
  readonly path: string
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, unknown>
  readonly body?: unknown
  readonly successStatus: number
  readonly declaredStatuses: ReadonlyArray<number>
  readonly responseHeaders?: ReadonlyArray<string>
  readonly errorHeaders?: { readonly [status: string]: ReadonlyArray<string> }
  readonly emptyErrors?: ReadonlyArray<number>
  readonly empty: boolean
  readonly text?: true
}

const maxSseEventBytes = 16 * 1024 * 1024

export function make(options: ClientOptions) {
  const fetch = options.fetch ?? globalThis.fetch

  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    const url = new URL(descriptor.path, options.baseUrl)
    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)
    const headers = new Headers(options.headers)
    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {
      if (value !== undefined && value !== null) headers.set(key, String(value))
    }
    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)
    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    return {
      url,
      init: {
        method: descriptor.method,
        signal: requestOptions?.signal,
        headers,
        body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),
      } satisfies RequestInit,
    }
  }

  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    try {
      const prepared = prepare(descriptor, requestOptions)
      return await fetch(prepared.url, prepared.init)
    } catch (cause) {
      throw new ClientError("Transport", { cause })
    }
  }

  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {
    if (descriptor.declaredStatuses.includes(response.status)) {
      const names = descriptor.errorHeaders?.[String(response.status)]
      if (descriptor.emptyErrors?.includes(response.status)) {
        try {
          await response.body?.cancel()
        } catch {}
        throw { headers: readDeclaredHeaders(response, names) ?? {} }
      }
      throw await json(response)
    }
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
  }

  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {
    const response = await execute(descriptor, requestOptions)
    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)
    if (descriptor.text) return (await response.text()) as A
    if (descriptor.empty) {
      try {
        await response.body?.cancel()
      } catch {}
      return attachDeclaredHeaders(undefined, response, descriptor.responseHeaders) as A
    }
    return attachDeclaredHeaders(await json(response), response, descriptor.responseHeaders) as A
  }

  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> => ({
    async *[Symbol.asyncIterator]() {
      const response = await execute(descriptor, requestOptions)
      if (response.status !== descriptor.successStatus) await responseError(response, descriptor)
      if (!isContentType(response, "text/event-stream")) {
        try {
          await response.body?.cancel()
        } catch {}
        throw new ClientError("UnsupportedContentType")
      }
      if (response.body === null) throw new ClientError("MalformedResponse")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          let next
          try {
            next = await reader.read()
          } catch (cause) {
            throw new ClientError("Transport", { cause })
          }
          buffer += decoder.decode(next.value, { stream: !next.done })
          if (buffer.length > maxSseEventBytes) throw new ClientError("SseEventTooLarge")
          const trailingCarriageReturn = !next.done && buffer.endsWith("\r")
          if (trailingCarriageReturn) buffer = buffer.slice(0, -1)
          buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
          if (trailingCarriageReturn) buffer += "\r"
          if (next.done && buffer !== "") buffer += "\n\n"
          let boundary = buffer.indexOf("\n\n")
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = block
              .split("\n")
              .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
              .join("\n")
            if (data !== "") {
              try {
                yield JSON.parse(data) as A
              } catch (cause) {
                throw new ClientError("MalformedResponse", { cause })
              }
            }
            boundary = buffer.indexOf("\n\n")
          }
          if (next.done) return
        }
      } finally {
        try {
          await reader.cancel()
        } catch {}
        reader.releaseLock()
      }
    },
  })

  return {
    "top-level": {
      dispose: (requestOptions?: RequestOptions) =>
        request<TopLevelDisposeOutput>(
          { method: "POST", path: `/instance/dispose`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      path: (requestOptions?: RequestOptions) =>
        request<TopLevelPathOutput>(
          { method: "GET", path: `/path`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      vcs: (requestOptions?: RequestOptions) =>
        request<TopLevelVcsOutput>(
          { method: "GET", path: `/vcs`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      vcsStatus: (requestOptions?: RequestOptions) =>
        request<TopLevelVcsStatusOutput>(
          { method: "GET", path: `/vcs/status`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      vcsDiffRaw: (requestOptions?: RequestOptions) =>
        request<TopLevelVcsDiffRawOutput>(
          { method: "GET", path: `/vcs/diff/raw`, successStatus: 200, declaredStatuses: [], empty: false, text: true },
          requestOptions,
        ),
      vcsApply: (input: TopLevelVcsApplyInput, requestOptions?: RequestOptions) =>
        request<TopLevelVcsApplyOutput>(
          {
            method: "POST",
            path: `/vcs/apply`,
            body: { patch: input["patch"] },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      command: (requestOptions?: RequestOptions) =>
        request<TopLevelCommandOutput>(
          { method: "GET", path: `/command`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      agent: (requestOptions?: RequestOptions) =>
        request<TopLevelAgentOutput>(
          { method: "GET", path: `/agent`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      skill: (requestOptions?: RequestOptions) =>
        request<TopLevelSkillOutput>(
          { method: "GET", path: `/skill`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      lsp: (requestOptions?: RequestOptions) =>
        request<TopLevelLspOutput>(
          { method: "GET", path: `/lsp`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      formatter: (requestOptions?: RequestOptions) =>
        request<TopLevelFormatterOutput>(
          { method: "GET", path: `/formatter`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
    },
    analytics: {
      global: (requestOptions?: RequestOptions) =>
        request<AnalyticsGlobalOutput>(
          { method: "GET", path: `/analytics/global`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      daily: (input?: AnalyticsDailyInput, requestOptions?: RequestOptions) =>
        request<AnalyticsDailyOutput>(
          {
            method: "GET",
            path: `/analytics/daily`,
            query: { from: input?.["from"], to: input?.["to"], days: input?.["days"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      session: (input: AnalyticsSessionInput, requestOptions?: RequestOptions) =>
        request<AnalyticsSessionOutput>(
          {
            method: "GET",
            path: `/analytics/session/${encodeURIComponent(input.sessionID)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      sessions: (requestOptions?: RequestOptions) =>
        request<AnalyticsSessionsOutput>(
          { method: "GET", path: `/analytics/sessions`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      leaderboard: (requestOptions?: RequestOptions) =>
        request<AnalyticsLeaderboardOutput>(
          { method: "GET", path: `/analytics/leaderboard`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      data: (input?: AnalyticsDataInput, requestOptions?: RequestOptions) =>
        request<AnalyticsDataOutput>(
          {
            method: "GET",
            path: `/analytics/data`,
            query: { days: input?.["days"], seriesDays: input?.["seriesDays"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    app: {
      log: (input: AppLogInput, requestOptions?: RequestOptions) =>
        request<AppLogOutput>(
          {
            method: "POST",
            path: `/log`,
            body: {
              service: input["service"],
              level: input["level"],
              message: input["message"],
              extra: input["extra"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      skillCreate: (input: AppSkillCreateInput, requestOptions?: RequestOptions) =>
        request<AppSkillCreateOutput>(
          {
            method: "POST",
            path: `/skill`,
            body: {
              name: input["name"],
              description: input["description"],
              category: input["category"],
              tags: input["tags"],
              content: input["content"],
              scope: input["scope"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      skillDelete: (input: AppSkillDeleteInput, requestOptions?: RequestOptions) =>
        request<AppSkillDeleteOutput>(
          {
            method: "DELETE",
            path: `/skill/${encodeURIComponent(input.name)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    brain: {
      status: (requestOptions?: RequestOptions) =>
        request<BrainStatusOutput>(
          { method: "GET", path: `/brain`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      trigger: (input?: BrainTriggerInput, requestOptions?: RequestOptions) =>
        request<BrainTriggerOutput>(
          {
            method: "POST",
            path: `/brain/trigger`,
            body: { force: input?.["force"], sessionID: input?.["sessionID"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    chatbot: {
      bots: (requestOptions?: RequestOptions) =>
        request<ChatbotBotsOutput>(
          { method: "GET", path: `/chatbot/bots`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      start: (input: ChatbotStartInput, requestOptions?: RequestOptions) =>
        request<ChatbotStartOutput>(
          {
            method: "POST",
            path: `/chatbot/bots/${encodeURIComponent(input.name)}/start`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      stop: (input: ChatbotStopInput, requestOptions?: RequestOptions) =>
        request<ChatbotStopOutput>(
          {
            method: "POST",
            path: `/chatbot/bots/${encodeURIComponent(input.name)}/stop`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    discord: {
      status: (requestOptions?: RequestOptions) =>
        request<DiscordStatusOutput>(
          { method: "GET", path: `/discord`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      setup: (input: DiscordSetupInput, requestOptions?: RequestOptions) =>
        request<DiscordSetupOutput>(
          {
            method: "POST",
            path: `/discord/setup`,
            body: { botToken: input["botToken"] },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      start: (requestOptions?: RequestOptions) =>
        request<DiscordStartOutput>(
          { method: "POST", path: `/discord/start`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      stop: (requestOptions?: RequestOptions) =>
        request<DiscordStopOutput>(
          { method: "POST", path: `/discord/stop`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
    },
    voice: {
      transcribe: (input: VoiceTranscribeInput, requestOptions?: RequestOptions) =>
        request<VoiceTranscribeOutput>(
          {
            method: "POST",
            path: `/voice/transcribe`,
            body: { audio: input["audio"], format: input["format"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    profile: {
      get: (requestOptions?: RequestOptions) =>
        request<ProfileGetOutput>(
          { method: "GET", path: `/profile`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      patch: (input?: ProfilePatchInput, requestOptions?: RequestOptions) =>
        request<ProfilePatchOutput>(
          {
            method: "PATCH",
            path: `/profile`,
            body: {
              name: input?.["name"],
              role: input?.["role"],
              about: input?.["about"],
              stack: input?.["stack"],
              expertise: input?.["expertise"],
              learning: input?.["learning"],
              skills: input?.["skills"],
              tools: input?.["tools"],
              conventions: input?.["conventions"],
              communication: input?.["communication"],
              custom: input?.["custom"],
              habits: input?.["habits"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      clear: (requestOptions?: RequestOptions) =>
        request<ProfileClearOutput>(
          { method: "DELETE", path: `/profile`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      habits: (input?: ProfileHabitsInput, requestOptions?: RequestOptions) =>
        request<ProfileHabitsOutput>(
          {
            method: "GET",
            path: `/profile/habits`,
            query: { worktree: input?.["worktree"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      preview: (input?: ProfilePreviewInput, requestOptions?: RequestOptions) =>
        request<ProfilePreviewOutput>(
          {
            method: "GET",
            path: `/profile/preview`,
            query: { worktree: input?.["worktree"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      clearHabits: (input?: ProfileClearHabitsInput, requestOptions?: RequestOptions) =>
        request<ProfileClearHabitsOutput>(
          {
            method: "DELETE",
            path: `/profile/habits`,
            query: { worktree: input?.["worktree"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    config: {
      get: (requestOptions?: RequestOptions) =>
        request<ConfigGetOutput>(
          { method: "GET", path: `/config`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      update: (input: ConfigUpdateInput, requestOptions?: RequestOptions) =>
        request<ConfigUpdateOutput>(
          {
            method: "PATCH",
            path: `/config`,
            body: input["payload"],
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      providers: (requestOptions?: RequestOptions) =>
        request<ConfigProvidersOutput>(
          { method: "GET", path: `/config/providers`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
    },
    connectors: {
      status: (requestOptions?: RequestOptions) =>
        request<ConnectorsStatusOutput>(
          { method: "GET", path: `/connectors`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      authSet: (input: ConnectorsAuthSetInput, requestOptions?: RequestOptions) =>
        request<ConnectorsAuthSetOutput>(
          {
            method: "POST",
            path: `/connectors/${encodeURIComponent(input.name)}/auth`,
            body: {
              token: input["token"],
              botToken: input["botToken"],
              apiKey: input["apiKey"],
              teamId: input["teamId"],
              expiresAt: input["expiresAt"],
              refreshToken: input["refreshToken"],
              refreshTokenExpiresAt: input["refreshTokenExpiresAt"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      authRemove: (input: ConnectorsAuthRemoveInput, requestOptions?: RequestOptions) =>
        request<ConnectorsAuthRemoveOutput>(
          {
            method: "DELETE",
            path: `/connectors/${encodeURIComponent(input.name)}/auth`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      invalidate: (input?: ConnectorsInvalidateInput, requestOptions?: RequestOptions) =>
        request<ConnectorsInvalidateOutput>(
          {
            method: "POST",
            path: `/connectors/invalidate`,
            body: { name: input?.["name"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    doctor: {
      run: (requestOptions?: RequestOptions) =>
        request<DoctorRunOutput>(
          { method: "GET", path: `/doctor`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
    },
    experimental: {
      toolIDs: (requestOptions?: RequestOptions) =>
        request<ExperimentalToolIDsOutput>(
          { method: "GET", path: `/experimental/tool/ids`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      tools: (input: ExperimentalToolsInput, requestOptions?: RequestOptions) =>
        request<ExperimentalToolsOutput>(
          {
            method: "GET",
            path: `/experimental/tool`,
            query: { provider: input["provider"], model: input["model"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      worktreeCreate: (input?: ExperimentalWorktreeCreateInput, requestOptions?: RequestOptions) =>
        request<ExperimentalWorktreeCreateOutput>(
          {
            method: "POST",
            path: `/experimental/worktree`,
            body: {
              name: input?.["name"],
              branch: input?.["branch"],
              branchPrefix: input?.["branchPrefix"],
              baseBranch: input?.["baseBranch"],
              remote: input?.["remote"],
              startCommand: input?.["startCommand"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      worktree: (requestOptions?: RequestOptions) =>
        request<ExperimentalWorktreeOutput>(
          { method: "GET", path: `/experimental/worktree`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      worktreeRemove: (input: ExperimentalWorktreeRemoveInput, requestOptions?: RequestOptions) =>
        request<ExperimentalWorktreeRemoveOutput>(
          {
            method: "DELETE",
            path: `/experimental/worktree`,
            body: { directory: input["directory"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      worktreeReset: (input: ExperimentalWorktreeResetInput, requestOptions?: RequestOptions) =>
        request<ExperimentalWorktreeResetOutput>(
          {
            method: "POST",
            path: `/experimental/worktree/reset`,
            body: { directory: input["directory"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      resource: (requestOptions?: RequestOptions) =>
        request<ExperimentalResourceOutput>(
          { method: "GET", path: `/experimental/resource`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      managedWorktreeCreate: (input: ExperimentalManagedWorktreeCreateInput, requestOptions?: RequestOptions) =>
        request<ExperimentalManagedWorktreeCreateOutput>(
          {
            method: "POST",
            path: `/experimental/managed-worktree`,
            body: { from: input["from"], name: input["name"], into: input["into"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      managedWorktreeRemove: (input: ExperimentalManagedWorktreeRemoveInput, requestOptions?: RequestOptions) =>
        request<ExperimentalManagedWorktreeRemoveOutput>(
          {
            method: "DELETE",
            path: `/experimental/managed-worktree`,
            body: { at: input["at"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      managedWorktreeLink: (input: ExperimentalManagedWorktreeLinkInput, requestOptions?: RequestOptions) =>
        request<ExperimentalManagedWorktreeLinkOutput>(
          {
            method: "POST",
            path: `/experimental/managed-worktree/link`,
            body: { at: input["at"], to: input["to"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      managedWorktreeChildren: (input: ExperimentalManagedWorktreeChildrenInput, requestOptions?: RequestOptions) =>
        request<ExperimentalManagedWorktreeChildrenOutput>(
          {
            method: "GET",
            path: `/experimental/managed-worktree/children`,
            query: { of: input["of"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      managedWorktreeAncestors: (input: ExperimentalManagedWorktreeAncestorsInput, requestOptions?: RequestOptions) =>
        request<ExperimentalManagedWorktreeAncestorsOutput>(
          {
            method: "GET",
            path: `/experimental/managed-worktree/ancestors`,
            query: { of: input["of"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      managedWorktreeList: (requestOptions?: RequestOptions) =>
        request<ExperimentalManagedWorktreeListOutput>(
          {
            method: "GET",
            path: `/experimental/managed-worktree`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    file: {
      findText: (input: FileFindTextInput, requestOptions?: RequestOptions) =>
        request<FileFindTextOutput>(
          {
            method: "GET",
            path: `/find`,
            query: { pattern: input["pattern"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      findFile: (input: FileFindFileInput, requestOptions?: RequestOptions) =>
        request<FileFindFileOutput>(
          {
            method: "GET",
            path: `/find/file`,
            query: { query: input["query"], dirs: input["dirs"], type: input["type"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      findSymbol: (input: FileFindSymbolInput, requestOptions?: RequestOptions) =>
        request<FileFindSymbolOutput>(
          {
            method: "GET",
            path: `/find/symbol`,
            query: { query: input["query"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      list: (input: FileListInput, requestOptions?: RequestOptions) =>
        request<FileListOutput>(
          {
            method: "GET",
            path: `/file`,
            query: { path: input["path"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      content: (input: FileContentInput, requestOptions?: RequestOptions) =>
        request<FileContentOutput>(
          {
            method: "GET",
            path: `/file/content`,
            query: { path: input["path"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      write: (input: FileWriteInput, requestOptions?: RequestOptions) =>
        request<FileWriteOutput>(
          {
            method: "PUT",
            path: `/file/content`,
            body: { path: input["path"], content: input["content"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      status: (requestOptions?: RequestOptions) =>
        request<FileStatusOutput>(
          { method: "GET", path: `/file/status`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
    },
    global: {
      health: (requestOptions?: RequestOptions) =>
        request<GlobalHealthOutput>(
          { method: "GET", path: `/global/health`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      dispose: (requestOptions?: RequestOptions) =>
        request<GlobalDisposeOutput>(
          { method: "POST", path: `/global/dispose`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
    },
    mcp: {
      status: (requestOptions?: RequestOptions) =>
        request<McpStatusOutput>(
          { method: "GET", path: `/mcp`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      add: (input: McpAddInput, requestOptions?: RequestOptions) =>
        request<McpAddOutput>(
          {
            method: "POST",
            path: `/mcp`,
            body: { name: input["name"], config: input["config"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      startAuth: (input: McpStartAuthInput, requestOptions?: RequestOptions) =>
        request<McpStartAuthOutput>(
          {
            method: "POST",
            path: `/mcp/${encodeURIComponent(input.name)}/auth`,
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      authCallback: (input: McpAuthCallbackInput, requestOptions?: RequestOptions) =>
        request<McpAuthCallbackOutput>(
          {
            method: "POST",
            path: `/mcp/${encodeURIComponent(input.name)}/auth/callback`,
            body: { code: input["code"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      authenticate: (input: McpAuthenticateInput, requestOptions?: RequestOptions) =>
        request<McpAuthenticateOutput>(
          {
            method: "POST",
            path: `/mcp/${encodeURIComponent(input.name)}/auth/authenticate`,
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      removeAuth: (input: McpRemoveAuthInput, requestOptions?: RequestOptions) =>
        request<McpRemoveAuthOutput>(
          {
            method: "DELETE",
            path: `/mcp/${encodeURIComponent(input.name)}/auth`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      connect: (input: McpConnectInput, requestOptions?: RequestOptions) =>
        request<McpConnectOutput>(
          {
            method: "POST",
            path: `/mcp/${encodeURIComponent(input.name)}/connect`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      disconnect: (input: McpDisconnectInput, requestOptions?: RequestOptions) =>
        request<McpDisconnectOutput>(
          {
            method: "POST",
            path: `/mcp/${encodeURIComponent(input.name)}/disconnect`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      toggle: (input: McpToggleInput, requestOptions?: RequestOptions) =>
        request<McpToggleOutput>(
          {
            method: "POST",
            path: `/mcp/${encodeURIComponent(input.name)}/toggle`,
            body: { enabled: input["enabled"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    mission: {
      list: (requestOptions?: RequestOptions) =>
        request<MissionListOutput>(
          { method: "GET", path: `/mission`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      templates: (requestOptions?: RequestOptions) =>
        request<MissionTemplatesOutput>(
          { method: "GET", path: `/mission/templates`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      generate: (input: MissionGenerateInput, requestOptions?: RequestOptions) =>
        request<MissionGenerateOutput>(
          {
            method: "POST",
            path: `/mission/generate`,
            body: {
              description: input["description"],
              model: input["model"],
              agent: input["agent"],
              sessionID: input["sessionID"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      recentExecs: (input?: MissionRecentExecsInput, requestOptions?: RequestOptions) =>
        request<MissionRecentExecsOutput>(
          {
            method: "GET",
            path: `/mission/execs/recent`,
            query: { limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: MissionGetInput, requestOptions?: RequestOptions) =>
        request<MissionGetOutput>(
          {
            method: "GET",
            path: `/mission/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      upsert: (input: MissionUpsertInput, requestOptions?: RequestOptions) =>
        request<MissionUpsertOutput>(
          {
            method: "PUT",
            path: `/mission`,
            body: {
              name: input["name"],
              brief: input["brief"],
              milestones: input["milestones"],
              models: input["models"],
              timeoutMs: input["timeoutMs"],
              sandbox: input["sandbox"],
              worktree: input["worktree"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: MissionUpdateInput, requestOptions?: RequestOptions) =>
        request<MissionUpdateOutput>(
          {
            method: "POST",
            path: `/mission/${encodeURIComponent(input.id)}`,
            body: {
              name: input["name"],
              brief: input["brief"],
              milestones: input["milestones"],
              models: input["models"],
              timeoutMs: input["timeoutMs"],
              sandbox: input["sandbox"],
              worktree: input["worktree"],
              status: input["status"],
              createdAt: input["createdAt"],
            },
            successStatus: 200,
            declaredStatuses: [404, 400],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: MissionRemoveInput, requestOptions?: RequestOptions) =>
        request<MissionRemoveOutput>(
          {
            method: "DELETE",
            path: `/mission/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      start: (input: MissionStartInput, requestOptions?: RequestOptions) =>
        request<MissionStartOutput>(
          {
            method: "POST",
            path: `/mission/${encodeURIComponent(input.id)}/start`,
            body: { sessionID: input["sessionID"] },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      pause: (input: MissionPauseInput, requestOptions?: RequestOptions) =>
        request<MissionPauseOutput>(
          {
            method: "POST",
            path: `/mission/${encodeURIComponent(input.id)}/pause`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      cancel: (input: MissionCancelInput, requestOptions?: RequestOptions) =>
        request<MissionCancelOutput>(
          {
            method: "POST",
            path: `/mission/${encodeURIComponent(input.id)}/cancel`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      featureMutate: (input: MissionFeatureMutateInput, requestOptions?: RequestOptions) =>
        request<MissionFeatureMutateOutput>(
          {
            method: "POST",
            path: `/mission/${encodeURIComponent(input.id)}/feature/${encodeURIComponent(input.featureID)}`,
            body: { status: input["status"], error: input["error"], appendDependsOn: input["appendDependsOn"] },
            successStatus: 200,
            declaredStatuses: [404, 400],
            empty: false,
          },
          requestOptions,
        ),
      execs: (input: MissionExecsInput, requestOptions?: RequestOptions) =>
        request<MissionExecsOutput>(
          {
            method: "GET",
            path: `/mission/${encodeURIComponent(input.id)}/execs`,
            query: { limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    mobile: {
      authTokenList: (requestOptions?: RequestOptions) =>
        request<MobileAuthTokenListOutput>(
          { method: "GET", path: `/mobile/auth/token`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      authTokenCreate: (input?: MobileAuthTokenCreateInput, requestOptions?: RequestOptions) =>
        request<MobileAuthTokenCreateOutput>(
          {
            method: "POST",
            path: `/mobile/auth/token`,
            body: { name: input?.["name"], expiresInDays: input?.["expiresInDays"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      authTokenRevoke: (input: MobileAuthTokenRevokeInput, requestOptions?: RequestOptions) =>
        request<MobileAuthTokenRevokeOutput>(
          {
            method: "DELETE",
            path: `/mobile/auth/token/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      bootstrap: (requestOptions?: RequestOptions) =>
        request<MobileBootstrapOutput>(
          { method: "GET", path: `/mobile/bootstrap`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      commandList: (requestOptions?: RequestOptions) =>
        request<MobileCommandListOutput>(
          { method: "GET", path: `/mobile/command`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      projectList: (requestOptions?: RequestOptions) =>
        request<MobileProjectListOutput>(
          { method: "GET", path: `/mobile/project`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      memoryHistory: (requestOptions?: RequestOptions) =>
        request<MobileMemoryHistoryOutput>(
          { method: "GET", path: `/mobile/memory/history`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      memorySearch: (input: MobileMemorySearchInput, requestOptions?: RequestOptions) =>
        request<MobileMemorySearchOutput>(
          {
            method: "GET",
            path: `/mobile/memory/search`,
            query: { query: input["query"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      memoryStashList: (requestOptions?: RequestOptions) =>
        request<MobileMemoryStashListOutput>(
          { method: "GET", path: `/mobile/memory/stash`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      memoryStashCreate: (input: MobileMemoryStashCreateInput, requestOptions?: RequestOptions) =>
        request<MobileMemoryStashCreateOutput>(
          {
            method: "POST",
            path: `/mobile/memory/stash`,
            body: { input: input["input"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      memoryStashDelete: (input: MobileMemoryStashDeleteInput, requestOptions?: RequestOptions) =>
        request<MobileMemoryStashDeleteOutput>(
          {
            method: "DELETE",
            path: `/mobile/memory/stash/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      githubRepos: (requestOptions?: RequestOptions) =>
        request<MobileGithubReposOutput>(
          {
            method: "GET",
            path: `/mobile/github/repos`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      githubBranches: (input: MobileGithubBranchesInput, requestOptions?: RequestOptions) =>
        request<MobileGithubBranchesOutput>(
          {
            method: "GET",
            path: `/mobile/github/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      githubWorkflows: (input: MobileGithubWorkflowsInput, requestOptions?: RequestOptions) =>
        request<MobileGithubWorkflowsOutput>(
          {
            method: "GET",
            path: `/mobile/github/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/workflows`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      githubWorkflowRuns: (input: MobileGithubWorkflowRunsInput, requestOptions?: RequestOptions) =>
        request<MobileGithubWorkflowRunsOutput>(
          {
            method: "GET",
            path: `/mobile/github/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/runs`,
            query: { branch: input["branch"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      githubWorkflowRunJobs: (input: MobileGithubWorkflowRunJobsInput, requestOptions?: RequestOptions) =>
        request<MobileGithubWorkflowRunJobsOutput>(
          {
            method: "GET",
            path: `/mobile/github/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/runs/${encodeURIComponent(input.runID)}/jobs`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      githubWorkflowRunRerun: (input: MobileGithubWorkflowRunRerunInput, requestOptions?: RequestOptions) =>
        request<MobileGithubWorkflowRunRerunOutput>(
          {
            method: "POST",
            path: `/mobile/github/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/runs/${encodeURIComponent(input.runID)}/rerun`,
            body: { failedOnly: input["failedOnly"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      githubWorkflowRunCancel: (input: MobileGithubWorkflowRunCancelInput, requestOptions?: RequestOptions) =>
        request<MobileGithubWorkflowRunCancelOutput>(
          {
            method: "POST",
            path: `/mobile/github/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/runs/${encodeURIComponent(input.runID)}/cancel`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      githubWorkflowDispatch: (input: MobileGithubWorkflowDispatchInput, requestOptions?: RequestOptions) =>
        request<MobileGithubWorkflowDispatchOutput>(
          {
            method: "POST",
            path: `/mobile/github/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/workflows/${encodeURIComponent(input.workflowID)}/dispatch`,
            body: { ref: input["ref"], inputs: input["inputs"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      githubImports: (requestOptions?: RequestOptions) =>
        request<MobileGithubImportsOutput>(
          { method: "GET", path: `/mobile/github/imports`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      githubOauthClient: (input: MobileGithubOauthClientInput, requestOptions?: RequestOptions) =>
        request<MobileGithubOauthClientOutput>(
          {
            method: "POST",
            path: `/mobile/github/oauth/client`,
            body: { clientId: input["clientId"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      githubOauthDeviceStart: (requestOptions?: RequestOptions) =>
        request<MobileGithubOauthDeviceStartOutput>(
          {
            method: "POST",
            path: `/mobile/github/oauth/device`,
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      githubOauthDevicePoll: (input: MobileGithubOauthDevicePollInput, requestOptions?: RequestOptions) =>
        request<MobileGithubOauthDevicePollOutput>(
          {
            method: "POST",
            path: `/mobile/github/oauth/device/poll`,
            body: { deviceCode: input["deviceCode"] },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      githubAuthSet: (input: MobileGithubAuthSetInput, requestOptions?: RequestOptions) =>
        request<MobileGithubAuthSetOutput>(
          {
            method: "POST",
            path: `/mobile/github/auth`,
            body: { token: input["token"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      githubAuthRemove: (requestOptions?: RequestOptions) =>
        request<MobileGithubAuthRemoveOutput>(
          { method: "DELETE", path: `/mobile/github/auth`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      githubImport: (input: MobileGithubImportInput, requestOptions?: RequestOptions) =>
        request<MobileGithubImportOutput>(
          {
            method: "POST",
            path: `/mobile/github/import`,
            body: {
              owner: input["owner"],
              repo: input["repo"],
              cloneUrl: input["cloneUrl"],
              defaultBranch: input["defaultBranch"],
              private: input["private"],
            },
            successStatus: 200,
            declaredStatuses: [401],
            empty: false,
          },
          requestOptions,
        ),
      githubSessionCreate: (input: MobileGithubSessionCreateInput, requestOptions?: RequestOptions) =>
        request<MobileGithubSessionCreateOutput>(
          {
            method: "POST",
            path: `/mobile/github/session`,
            body: {
              owner: input["owner"],
              repo: input["repo"],
              cloneUrl: input["cloneUrl"],
              htmlUrl: input["htmlUrl"],
              defaultBranch: input["defaultBranch"],
              baseBranch: input["baseBranch"],
              private: input["private"],
              title: input["title"],
              executionTarget: input["executionTarget"],
            },
            successStatus: 200,
            declaredStatuses: [401],
            empty: false,
          },
          requestOptions,
        ),
      sessionList: (input?: MobileSessionListInput, requestOptions?: RequestOptions) =>
        request<MobileSessionListOutput>(
          {
            method: "GET",
            path: `/mobile/session`,
            query: { limit: input?.["limit"], search: input?.["search"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      sessionCreate: (input?: MobileSessionCreateInput, requestOptions?: RequestOptions) =>
        request<MobileSessionCreateOutput>(
          {
            method: "POST",
            path: `/mobile/session`,
            body: {
              parentID: input?.["parentID"],
              title: input?.["title"],
              permission: input?.["permission"],
              github: input?.["github"],
              executionTarget: input?.["executionTarget"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      sessionDetail: (input: MobileSessionDetailInput, requestOptions?: RequestOptions) =>
        request<MobileSessionDetailOutput>(
          {
            method: "GET",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      sessionDelete: (input: MobileSessionDeleteInput, requestOptions?: RequestOptions) =>
        request<MobileSessionDeleteOutput>(
          {
            method: "DELETE",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      sessionDiff: (input: MobileSessionDiffInput, requestOptions?: RequestOptions) =>
        request<MobileSessionDiffOutput>(
          {
            method: "GET",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/diff/${encodeURIComponent(input.messageID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      sessionCommandList: (input: MobileSessionCommandListInput, requestOptions?: RequestOptions) =>
        request<MobileSessionCommandListOutput>(
          {
            method: "GET",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/command`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      sessionCommand: (input: MobileSessionCommandInput, requestOptions?: RequestOptions) =>
        request<MobileSessionCommandOutput>(
          {
            method: "POST",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/command`,
            body: {
              command: input["command"],
              arguments: input["arguments"],
              agent: input["agent"],
              model: input["model"],
              variant: input["variant"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      sessionMessage: (input: MobileSessionMessageInput, requestOptions?: RequestOptions) =>
        request<MobileSessionMessageOutput>(
          {
            method: "POST",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/message`,
            body: {
              messageID: input["messageID"],
              delivery: input["delivery"],
              model: input["model"],
              agent: input["agent"],
              noReply: input["noReply"],
              tools: input["tools"],
              format: input["format"],
              system: input["system"],
              variant: input["variant"],
              parts: input["parts"],
              parentSessionID: input["parentSessionID"],
            },
            successStatus: 202,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      sessionAbort: (input: MobileSessionAbortInput, requestOptions?: RequestOptions) =>
        request<MobileSessionAbortOutput>(
          {
            method: "POST",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/abort`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      permissionRespond: (input: MobilePermissionRespondInput, requestOptions?: RequestOptions) =>
        request<MobilePermissionRespondOutput>(
          {
            method: "POST",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/permissions/${encodeURIComponent(input.permissionID)}`,
            body: { response: input["response"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      questionRespond: (input: MobileQuestionRespondInput, requestOptions?: RequestOptions) =>
        request<MobileQuestionRespondOutput>(
          {
            method: "POST",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/question/${encodeURIComponent(input.requestID)}`,
            body: { answers: input["answers"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      questionReject: (input: MobileQuestionRejectInput, requestOptions?: RequestOptions) =>
        request<MobileQuestionRejectOutput>(
          {
            method: "DELETE",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/question/${encodeURIComponent(input.requestID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      sessionPublish: (input: MobileSessionPublishInput, requestOptions?: RequestOptions) =>
        request<MobileSessionPublishOutput>(
          {
            method: "POST",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/publish`,
            body: { title: input["title"], body: input["body"], commitMessage: input["commitMessage"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      sessionCleanup: (input: MobileSessionCleanupInput, requestOptions?: RequestOptions) =>
        request<MobileSessionCleanupOutput>(
          {
            method: "POST",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/cleanup`,
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      sessionStream: (
        input: MobileSessionStreamInput,
        requestOptions?: RequestOptions,
      ): AsyncIterable<MobileSessionStreamOutput> =>
        sse<MobileSessionStreamOutput>(
          {
            method: "GET",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/stream`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      sessionRename: (input: MobileSessionRenameInput, requestOptions?: RequestOptions) =>
        request<MobileSessionRenameOutput>(
          {
            method: "POST",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/rename`,
            body: { title: input["title"] },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      sessionTodo: (input: MobileSessionTodoInput, requestOptions?: RequestOptions) =>
        request<MobileSessionTodoOutput>(
          {
            method: "GET",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/todo`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      teleportUploadBegin: (requestOptions?: RequestOptions) =>
        request<MobileTeleportUploadBeginOutput>(
          { method: "POST", path: `/mobile/teleport/upload`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      teleportUploadChunk: (input: MobileTeleportUploadChunkInput, requestOptions?: RequestOptions) =>
        request<MobileTeleportUploadChunkOutput>(
          {
            method: "POST",
            path: `/mobile/teleport/upload/${encodeURIComponent(input.uploadID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      teleportIn: (input: MobileTeleportInInput, requestOptions?: RequestOptions) =>
        request<MobileTeleportInOutput>(
          {
            method: "POST",
            path: `/mobile/teleport`,
            body: {
              title: input["title"],
              name: input["name"],
              origin: input["origin"],
              permission: input["permission"],
              messages: input["messages"],
              uploadID: input["uploadID"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      teleportOut: (input: MobileTeleportOutInput, requestOptions?: RequestOptions) =>
        request<MobileTeleportOutOutput>(
          {
            method: "POST",
            path: `/mobile/session/${encodeURIComponent(input.sessionID)}/teleport`,
            body: {
              url: input["url"],
              token: input["token"],
              content: input["content"],
              includeGit: input["includeGit"],
            },
            successStatus: 200,
            declaredStatuses: [400, 404],
            empty: false,
          },
          requestOptions,
        ),
      worktreeCreate: (input?: MobileWorktreeCreateInput, requestOptions?: RequestOptions) =>
        request<MobileWorktreeCreateOutput>(
          {
            method: "POST",
            path: `/mobile/worktree`,
            body: {
              name: input?.["name"],
              branch: input?.["branch"],
              branchPrefix: input?.["branchPrefix"],
              baseBranch: input?.["baseBranch"],
              remote: input?.["remote"],
              startCommand: input?.["startCommand"],
              detached: input?.["detached"],
              sourceDirectory: input?.["sourceDirectory"],
              root: input?.["root"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      worktreeRemove: (input: MobileWorktreeRemoveInput, requestOptions?: RequestOptions) =>
        request<MobileWorktreeRemoveOutput>(
          {
            method: "DELETE",
            path: `/mobile/worktree`,
            body: { directory: input["directory"], force: input["force"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      worktreeReset: (input: MobileWorktreeResetInput, requestOptions?: RequestOptions) =>
        request<MobileWorktreeResetOutput>(
          {
            method: "POST",
            path: `/mobile/worktree/reset`,
            body: { directory: input["directory"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      gitStatus: (requestOptions?: RequestOptions) =>
        request<MobileGitStatusOutput>(
          { method: "GET", path: `/mobile/git/status`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      gitDiff: (input?: MobileGitDiffInput, requestOptions?: RequestOptions) =>
        request<MobileGitDiffOutput>(
          {
            method: "GET",
            path: `/mobile/git/diff`,
            query: { file: input?.["file"], staged: input?.["staged"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      gitCommits: (input?: MobileGitCommitsInput, requestOptions?: RequestOptions) =>
        request<MobileGitCommitsOutput>(
          {
            method: "GET",
            path: `/mobile/git/commits`,
            query: { limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      gitBranches: (requestOptions?: RequestOptions) =>
        request<MobileGitBranchesOutput>(
          { method: "GET", path: `/mobile/git/branches`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      gitCommit: (input: MobileGitCommitInput, requestOptions?: RequestOptions) =>
        request<MobileGitCommitOutput>(
          {
            method: "POST",
            path: `/mobile/git/commit`,
            body: {
              message: input["message"],
              files: input["files"],
              amend: input["amend"],
              stagedOnly: input["stagedOnly"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      gitCheckout: (input: MobileGitCheckoutInput, requestOptions?: RequestOptions) =>
        request<MobileGitCheckoutOutput>(
          {
            method: "POST",
            path: `/mobile/git/checkout`,
            body: { branch: input["branch"], create: input["create"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      gitStage: (input: MobileGitStageInput, requestOptions?: RequestOptions) =>
        request<MobileGitStageOutput>(
          {
            method: "POST",
            path: `/mobile/git/stage`,
            body: { files: input["files"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      gitUnstage: (input: MobileGitUnstageInput, requestOptions?: RequestOptions) =>
        request<MobileGitUnstageOutput>(
          {
            method: "POST",
            path: `/mobile/git/unstage`,
            body: { files: input["files"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      gitDiscard: (input: MobileGitDiscardInput, requestOptions?: RequestOptions) =>
        request<MobileGitDiscardOutput>(
          {
            method: "POST",
            path: `/mobile/git/discard`,
            body: { files: input["files"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      gitPush: (input?: MobileGitPushInput, requestOptions?: RequestOptions) =>
        request<MobileGitPushOutput>(
          {
            method: "POST",
            path: `/mobile/git/push`,
            query: { upstream: input?.["upstream"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      gitPull: (requestOptions?: RequestOptions) =>
        request<MobileGitPullOutput>(
          { method: "POST", path: `/mobile/git/pull`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      loopList: (requestOptions?: RequestOptions) =>
        request<MobileLoopListOutput>(
          { method: "GET", path: `/mobile/loops`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      loopCreate: (input: MobileLoopCreateInput, requestOptions?: RequestOptions) =>
        request<MobileLoopCreateOutput>(
          {
            method: "POST",
            path: `/mobile/loops`,
            body: {
              name: input["name"],
              stages: input["stages"],
              trigger: input["trigger"],
              maxRuns: input["maxRuns"],
              timeoutMs: input["timeoutMs"],
              createPR: input["createPR"],
              sandbox: input["sandbox"],
              worktree: input["worktree"],
              paused: input["paused"],
              enabled: input["enabled"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      loopTemplates: (requestOptions?: RequestOptions) =>
        request<MobileLoopTemplatesOutput>(
          { method: "GET", path: `/mobile/loops/templates`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      loopGenerate: (input: MobileLoopGenerateInput, requestOptions?: RequestOptions) =>
        request<MobileLoopGenerateOutput>(
          {
            method: "POST",
            path: `/mobile/loops/generate`,
            body: {
              description: input["description"],
              model: input["model"],
              agent: input["agent"],
              sessionID: input["sessionID"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      loopRunsRecent: (input?: MobileLoopRunsRecentInput, requestOptions?: RequestOptions) =>
        request<MobileLoopRunsRecentOutput>(
          {
            method: "GET",
            path: `/mobile/loops/runs/recent`,
            query: { limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      loopGet: (input: MobileLoopGetInput, requestOptions?: RequestOptions) =>
        request<MobileLoopGetOutput>(
          {
            method: "GET",
            path: `/mobile/loops/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      loopDelete: (input: MobileLoopDeleteInput, requestOptions?: RequestOptions) =>
        request<MobileLoopDeleteOutput>(
          {
            method: "DELETE",
            path: `/mobile/loops/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      loopUpdate: (input: MobileLoopUpdateInput, requestOptions?: RequestOptions) =>
        request<MobileLoopUpdateOutput>(
          {
            method: "PATCH",
            path: `/mobile/loops/${encodeURIComponent(input.id)}`,
            body: {
              name: input["name"],
              stages: input["stages"],
              trigger: input["trigger"],
              maxRuns: input["maxRuns"],
              timeoutMs: input["timeoutMs"],
              createPR: input["createPR"],
              sandbox: input["sandbox"],
              worktree: input["worktree"],
              paused: input["paused"],
              enabled: input["enabled"],
            },
            successStatus: 200,
            declaredStatuses: [400, 404],
            empty: false,
          },
          requestOptions,
        ),
      loopRuns: (input: MobileLoopRunsInput, requestOptions?: RequestOptions) =>
        request<MobileLoopRunsOutput>(
          {
            method: "GET",
            path: `/mobile/loops/${encodeURIComponent(input.id)}/runs`,
            query: { limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      loopRun: (input: MobileLoopRunInput, requestOptions?: RequestOptions) =>
        request<MobileLoopRunOutput>(
          {
            method: "POST",
            path: `/mobile/loops/${encodeURIComponent(input.id)}/run`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      loopAbort: (input: MobileLoopAbortInput, requestOptions?: RequestOptions) =>
        request<MobileLoopAbortOutput>(
          {
            method: "POST",
            path: `/mobile/loops/${encodeURIComponent(input.id)}/abort`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      loopToggle: (input: MobileLoopToggleInput, requestOptions?: RequestOptions) =>
        request<MobileLoopToggleOutput>(
          {
            method: "POST",
            path: `/mobile/loops/${encodeURIComponent(input.id)}/toggle`,
            body: { enabled: input["enabled"] },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      loopPause: (input: MobileLoopPauseInput, requestOptions?: RequestOptions) =>
        request<MobileLoopPauseOutput>(
          {
            method: "POST",
            path: `/mobile/loops/${encodeURIComponent(input.id)}/pause`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      loopResume: (input: MobileLoopResumeInput, requestOptions?: RequestOptions) =>
        request<MobileLoopResumeOutput>(
          {
            method: "POST",
            path: `/mobile/loops/${encodeURIComponent(input.id)}/resume`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      routineList: (requestOptions?: RequestOptions) =>
        request<MobileRoutineListOutput>(
          { method: "GET", path: `/mobile/routines`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      routineCreate: (input: MobileRoutineCreateInput, requestOptions?: RequestOptions) =>
        request<MobileRoutineCreateOutput>(
          {
            method: "POST",
            path: `/mobile/routines`,
            body: { name: input["name"], prompt: input["prompt"], triggers: input["triggers"], model: input["model"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      routineGet: (input: MobileRoutineGetInput, requestOptions?: RequestOptions) =>
        request<MobileRoutineGetOutput>(
          {
            method: "GET",
            path: `/mobile/routines/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      routineDelete: (input: MobileRoutineDeleteInput, requestOptions?: RequestOptions) =>
        request<MobileRoutineDeleteOutput>(
          {
            method: "DELETE",
            path: `/mobile/routines/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      routineUpdate: (input: MobileRoutineUpdateInput, requestOptions?: RequestOptions) =>
        request<MobileRoutineUpdateOutput>(
          {
            method: "PATCH",
            path: `/mobile/routines/${encodeURIComponent(input.id)}`,
            body: {
              name: input["name"],
              prompt: input["prompt"],
              triggers: input["triggers"],
              model: input["model"],
              paused: input["paused"],
            },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      routineRun: (input: MobileRoutineRunInput, requestOptions?: RequestOptions) =>
        request<MobileRoutineRunOutput>(
          {
            method: "POST",
            path: `/mobile/routines/${encodeURIComponent(input.id)}/run`,
            body: { text: input["text"] },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      routinePause: (input: MobileRoutinePauseInput, requestOptions?: RequestOptions) =>
        request<MobileRoutinePauseOutput>(
          {
            method: "POST",
            path: `/mobile/routines/${encodeURIComponent(input.id)}/pause`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      routineResume: (input: MobileRoutineResumeInput, requestOptions?: RequestOptions) =>
        request<MobileRoutineResumeOutput>(
          {
            method: "POST",
            path: `/mobile/routines/${encodeURIComponent(input.id)}/resume`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      routineTrigger: (input: MobileRoutineTriggerInput, requestOptions?: RequestOptions) =>
        request<MobileRoutineTriggerOutput>(
          {
            method: "POST",
            path: `/mobile/routines/trigger/${encodeURIComponent(input.token)}`,
            body: { text: input["text"] },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      ptyList: (requestOptions?: RequestOptions) =>
        request<MobilePtyListOutput>(
          { method: "GET", path: `/mobile/pty`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      ptyCreate: (input?: MobilePtyCreateInput, requestOptions?: RequestOptions) =>
        request<MobilePtyCreateOutput>(
          {
            method: "POST",
            path: `/mobile/pty`,
            body: {
              command: input?.["command"],
              args: input?.["args"],
              cwd: input?.["cwd"],
              title: input?.["title"],
              env: input?.["env"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      ptyGet: (input: MobilePtyGetInput, requestOptions?: RequestOptions) =>
        request<MobilePtyGetOutput>(
          {
            method: "GET",
            path: `/mobile/pty/${encodeURIComponent(input.ptyID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      ptyUpdate: (input: MobilePtyUpdateInput, requestOptions?: RequestOptions) =>
        request<MobilePtyUpdateOutput>(
          {
            method: "PUT",
            path: `/mobile/pty/${encodeURIComponent(input.ptyID)}`,
            body: { title: input["title"], size: input["size"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      ptyRemove: (input: MobilePtyRemoveInput, requestOptions?: RequestOptions) =>
        request<MobilePtyRemoveOutput>(
          {
            method: "DELETE",
            path: `/mobile/pty/${encodeURIComponent(input.ptyID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      missionList: (requestOptions?: RequestOptions) =>
        request<MobileMissionListOutput>(
          { method: "GET", path: `/mobile/missions`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      missionCreate: (input: MobileMissionCreateInput, requestOptions?: RequestOptions) =>
        request<MobileMissionCreateOutput>(
          {
            method: "POST",
            path: `/mobile/missions`,
            body: {
              name: input["name"],
              brief: input["brief"],
              milestones: input["milestones"],
              models: input["models"],
              timeoutMs: input["timeoutMs"],
              sandbox: input["sandbox"],
              worktree: input["worktree"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      missionTemplates: (requestOptions?: RequestOptions) =>
        request<MobileMissionTemplatesOutput>(
          { method: "GET", path: `/mobile/missions/templates`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      missionGenerate: (input: MobileMissionGenerateInput, requestOptions?: RequestOptions) =>
        request<MobileMissionGenerateOutput>(
          {
            method: "POST",
            path: `/mobile/missions/generate`,
            body: {
              description: input["description"],
              model: input["model"],
              agent: input["agent"],
              sessionID: input["sessionID"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      missionExecsRecent: (input?: MobileMissionExecsRecentInput, requestOptions?: RequestOptions) =>
        request<MobileMissionExecsRecentOutput>(
          {
            method: "GET",
            path: `/mobile/missions/execs/recent`,
            query: { limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      missionGet: (input: MobileMissionGetInput, requestOptions?: RequestOptions) =>
        request<MobileMissionGetOutput>(
          {
            method: "GET",
            path: `/mobile/missions/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      missionUpdate: (input: MobileMissionUpdateInput, requestOptions?: RequestOptions) =>
        request<MobileMissionUpdateOutput>(
          {
            method: "PATCH",
            path: `/mobile/missions/${encodeURIComponent(input.id)}`,
            body: {
              name: input["name"],
              brief: input["brief"],
              milestones: input["milestones"],
              models: input["models"],
              timeoutMs: input["timeoutMs"],
              sandbox: input["sandbox"],
              worktree: input["worktree"],
              status: input["status"],
              createdAt: input["createdAt"],
            },
            successStatus: 200,
            declaredStatuses: [404, 400],
            empty: false,
          },
          requestOptions,
        ),
      missionDelete: (input: MobileMissionDeleteInput, requestOptions?: RequestOptions) =>
        request<MobileMissionDeleteOutput>(
          {
            method: "DELETE",
            path: `/mobile/missions/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      missionExecs: (input: MobileMissionExecsInput, requestOptions?: RequestOptions) =>
        request<MobileMissionExecsOutput>(
          {
            method: "GET",
            path: `/mobile/missions/${encodeURIComponent(input.id)}/execs`,
            query: { limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      missionStart: (input: MobileMissionStartInput, requestOptions?: RequestOptions) =>
        request<MobileMissionStartOutput>(
          {
            method: "POST",
            path: `/mobile/missions/${encodeURIComponent(input.id)}/start`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      missionPause: (input: MobileMissionPauseInput, requestOptions?: RequestOptions) =>
        request<MobileMissionPauseOutput>(
          {
            method: "POST",
            path: `/mobile/missions/${encodeURIComponent(input.id)}/pause`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      missionCancel: (input: MobileMissionCancelInput, requestOptions?: RequestOptions) =>
        request<MobileMissionCancelOutput>(
          {
            method: "POST",
            path: `/mobile/missions/${encodeURIComponent(input.id)}/cancel`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      missionFeatureMutate: (input: MobileMissionFeatureMutateInput, requestOptions?: RequestOptions) =>
        request<MobileMissionFeatureMutateOutput>(
          {
            method: "POST",
            path: `/mobile/missions/${encodeURIComponent(input.id)}/feature/${encodeURIComponent(input.featureID)}`,
            body: { status: input["status"], error: input["error"], appendDependsOn: input["appendDependsOn"] },
            successStatus: 200,
            declaredStatuses: [404, 400],
            empty: false,
          },
          requestOptions,
        ),
      events: (requestOptions?: RequestOptions): AsyncIterable<MobileEventsOutput> =>
        sse<MobileEventsOutput>(
          { method: "GET", path: `/mobile/events`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      brainStatus: (requestOptions?: RequestOptions) =>
        request<MobileBrainStatusOutput>(
          { method: "GET", path: `/mobile/brain`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      brainTrigger: (input: MobileBrainTriggerInput, requestOptions?: RequestOptions) =>
        request<MobileBrainTriggerOutput>(
          {
            method: "POST",
            path: `/mobile/brain`,
            body: input["payload"],
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      chatBotList: (requestOptions?: RequestOptions) =>
        request<MobileChatBotListOutput>(
          { method: "GET", path: `/mobile/chatbot/bots`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      chatBotStart: (input: MobileChatBotStartInput, requestOptions?: RequestOptions) =>
        request<MobileChatBotStartOutput>(
          {
            method: "POST",
            path: `/mobile/chatbot/bots/${encodeURIComponent(input.name)}/start`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      chatBotStop: (input: MobileChatBotStopInput, requestOptions?: RequestOptions) =>
        request<MobileChatBotStopOutput>(
          {
            method: "POST",
            path: `/mobile/chatbot/bots/${encodeURIComponent(input.name)}/stop`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      observabilityGet: (requestOptions?: RequestOptions) =>
        request<MobileObservabilityGetOutput>(
          { method: "GET", path: `/mobile/observability`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      observabilitySet: (input: MobileObservabilitySetInput, requestOptions?: RequestOptions) =>
        request<MobileObservabilitySetOutput>(
          {
            method: "POST",
            path: `/mobile/observability`,
            body: { enabled: input["enabled"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      lspStatus: (requestOptions?: RequestOptions) =>
        request<MobileLspStatusOutput>(
          { method: "GET", path: `/mobile/lsp`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      fusionList: (requestOptions?: RequestOptions) =>
        request<MobileFusionListOutput>(
          { method: "GET", path: `/mobile/fusion`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      fusionSet: (input: MobileFusionSetInput, requestOptions?: RequestOptions) =>
        request<MobileFusionSetOutput>(
          {
            method: "POST",
            path: `/mobile/fusion`,
            body: { name: input["name"], enabled: input["enabled"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      hostBrowser: (requestOptions?: RequestOptions) =>
        request<MobileHostBrowserOutput>(
          { method: "GET", path: `/mobile/host/browser`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      hostComputer: (requestOptions?: RequestOptions) =>
        request<MobileHostComputerOutput>(
          { method: "GET", path: `/mobile/host/computer`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      hostHerdrGet: (requestOptions?: RequestOptions) =>
        request<MobileHostHerdrGetOutput>(
          { method: "GET", path: `/mobile/host/herdr`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      hostHerdrSet: (input: MobileHostHerdrSetInput, requestOptions?: RequestOptions) =>
        request<MobileHostHerdrSetOutput>(
          {
            method: "POST",
            path: `/mobile/host/herdr`,
            body: { enabled: input["enabled"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      hostIsland: (requestOptions?: RequestOptions) =>
        request<MobileHostIslandOutput>(
          { method: "GET", path: `/mobile/host/island`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      hostDevtools: (requestOptions?: RequestOptions) =>
        request<MobileHostDevtoolsOutput>(
          { method: "GET", path: `/mobile/host/devtools`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      hostLanGet: (requestOptions?: RequestOptions) =>
        request<MobileHostLanGetOutput>(
          { method: "GET", path: `/mobile/host/lan`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      hostLanStart: (input?: MobileHostLanStartInput, requestOptions?: RequestOptions) =>
        request<MobileHostLanStartOutput>(
          {
            method: "POST",
            path: `/mobile/host/lan`,
            body: { mdns: input?.["mdns"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    project: {
      list: (requestOptions?: RequestOptions) =>
        request<ProjectListOutput>(
          { method: "GET", path: `/project`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      current: (requestOptions?: RequestOptions) =>
        request<ProjectCurrentOutput>(
          { method: "GET", path: `/project/current`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      update: (input: ProjectUpdateInput, requestOptions?: RequestOptions) =>
        request<ProjectUpdateOutput>(
          {
            method: "PATCH",
            path: `/project/${encodeURIComponent(input.projectID)}`,
            body: { name: input["name"], icon: input["icon"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      directoryList: (input: ProjectDirectoryListInput, requestOptions?: RequestOptions) =>
        request<ProjectDirectoryListOutput>(
          {
            method: "GET",
            path: `/project/${encodeURIComponent(input.projectID)}/directory`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      copyCreate: (input: ProjectCopyCreateInput, requestOptions?: RequestOptions) =>
        request<ProjectCopyCreateOutput>(
          {
            method: "POST",
            path: `/project/${encodeURIComponent(input.projectID)}/copy`,
            body: { strategy: input["strategy"], directory: input["directory"], name: input["name"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      copyRemove: (input: ProjectCopyRemoveInput, requestOptions?: RequestOptions) =>
        request<ProjectCopyRemoveOutput>(
          {
            method: "DELETE",
            path: `/project/${encodeURIComponent(input.projectID)}/copy`,
            body: { directory: input["directory"], force: input["force"] },
            successStatus: 204,
            declaredStatuses: [],
            empty: true,
          },
          requestOptions,
        ),
      copyRefresh: (input: ProjectCopyRefreshInput, requestOptions?: RequestOptions) =>
        request<ProjectCopyRefreshOutput>(
          {
            method: "POST",
            path: `/project/${encodeURIComponent(input.projectID)}/copy/refresh`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    provider: {
      list: (requestOptions?: RequestOptions) =>
        request<ProviderListOutput>(
          { method: "GET", path: `/provider`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      auth: (requestOptions?: RequestOptions) =>
        request<ProviderAuthOutput>(
          { method: "GET", path: `/provider/auth`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      api: (input: ProviderApiInput, requestOptions?: RequestOptions) =>
        request<ProviderApiOutput>(
          {
            method: "POST",
            path: `/provider/${encodeURIComponent(input.providerID)}/api`,
            body: { key: input["key"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      removeAuth: (input: ProviderRemoveAuthInput, requestOptions?: RequestOptions) =>
        request<ProviderRemoveAuthOutput>(
          {
            method: "DELETE",
            path: `/provider/${encodeURIComponent(input.providerID)}/auth`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      oauthAuthorize: (input: ProviderOauthAuthorizeInput, requestOptions?: RequestOptions) =>
        request<ProviderOauthAuthorizeOutput>(
          {
            method: "POST",
            path: `/provider/${encodeURIComponent(input.providerID)}/oauth/authorize`,
            body: { method: input["method"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      oauthCallback: (input: ProviderOauthCallbackInput, requestOptions?: RequestOptions) =>
        request<ProviderOauthCallbackOutput>(
          {
            method: "POST",
            path: `/provider/${encodeURIComponent(input.providerID)}/oauth/callback`,
            body: { method: input["method"], code: input["code"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    question: {
      list: (requestOptions?: RequestOptions) =>
        request<QuestionListOutput>(
          { method: "GET", path: `/question`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      reply: (input: QuestionReplyInput, requestOptions?: RequestOptions) =>
        request<QuestionReplyOutput>(
          {
            method: "POST",
            path: `/question/${encodeURIComponent(input.requestID)}/reply`,
            body: { answers: input["answers"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      reject: (input: QuestionRejectInput, requestOptions?: RequestOptions) =>
        request<QuestionRejectOutput>(
          {
            method: "POST",
            path: `/question/${encodeURIComponent(input.requestID)}/reject`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    permission: {
      list: (requestOptions?: RequestOptions) =>
        request<PermissionListOutput>(
          { method: "GET", path: `/permission`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      blocked: (requestOptions?: RequestOptions) =>
        request<PermissionBlockedOutput>(
          { method: "GET", path: `/permission/blocked`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      reply: (input: PermissionReplyInput, requestOptions?: RequestOptions) =>
        request<PermissionReplyOutput>(
          {
            method: "POST",
            path: `/permission/${encodeURIComponent(input.requestID)}/reply`,
            body: { reply: input["reply"], message: input["message"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    pty: {
      list: (requestOptions?: RequestOptions) =>
        request<PtyListOutput>(
          { method: "GET", path: `/pty`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      create: (input?: PtyCreateInput, requestOptions?: RequestOptions) =>
        request<PtyCreateOutput>(
          {
            method: "POST",
            path: `/pty`,
            body: {
              command: input?.["command"],
              args: input?.["args"],
              cwd: input?.["cwd"],
              title: input?.["title"],
              env: input?.["env"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: PtyGetInput, requestOptions?: RequestOptions) =>
        request<PtyGetOutput>(
          {
            method: "GET",
            path: `/pty/${encodeURIComponent(input.ptyID)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: PtyUpdateInput, requestOptions?: RequestOptions) =>
        request<PtyUpdateOutput>(
          {
            method: "PUT",
            path: `/pty/${encodeURIComponent(input.ptyID)}`,
            body: { title: input["title"], size: input["size"] },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: PtyRemoveInput, requestOptions?: RequestOptions) =>
        request<PtyRemoveOutput>(
          {
            method: "DELETE",
            path: `/pty/${encodeURIComponent(input.ptyID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    loop: {
      list: (requestOptions?: RequestOptions) =>
        request<LoopListOutput>(
          { method: "GET", path: `/loop`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      templates: (requestOptions?: RequestOptions) =>
        request<LoopTemplatesOutput>(
          { method: "GET", path: `/loop/templates`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      generate: (input: LoopGenerateInput, requestOptions?: RequestOptions) =>
        request<LoopGenerateOutput>(
          {
            method: "POST",
            path: `/loop/generate`,
            body: {
              description: input["description"],
              model: input["model"],
              agent: input["agent"],
              sessionID: input["sessionID"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      recentRuns: (input?: LoopRecentRunsInput, requestOptions?: RequestOptions) =>
        request<LoopRecentRunsOutput>(
          {
            method: "GET",
            path: `/loop/runs/recent`,
            query: { limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: LoopGetInput, requestOptions?: RequestOptions) =>
        request<LoopGetOutput>(
          {
            method: "GET",
            path: `/loop/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      upsert: (input: LoopUpsertInput, requestOptions?: RequestOptions) =>
        request<LoopUpsertOutput>(
          {
            method: "PUT",
            path: `/loop`,
            body: {
              name: input["name"],
              stages: input["stages"],
              trigger: input["trigger"],
              maxRuns: input["maxRuns"],
              timeoutMs: input["timeoutMs"],
              createPR: input["createPR"],
              sandbox: input["sandbox"],
              worktree: input["worktree"],
              paused: input["paused"],
              enabled: input["enabled"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: LoopUpdateInput, requestOptions?: RequestOptions) =>
        request<LoopUpdateOutput>(
          {
            method: "POST",
            path: `/loop/${encodeURIComponent(input.id)}`,
            body: {
              name: input["name"],
              stages: input["stages"],
              trigger: input["trigger"],
              maxRuns: input["maxRuns"],
              timeoutMs: input["timeoutMs"],
              createPR: input["createPR"],
              sandbox: input["sandbox"],
              worktree: input["worktree"],
              paused: input["paused"],
              enabled: input["enabled"],
              createdAt: input["createdAt"],
            },
            successStatus: 200,
            declaredStatuses: [404, 400],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: LoopRemoveInput, requestOptions?: RequestOptions) =>
        request<LoopRemoveOutput>(
          {
            method: "DELETE",
            path: `/loop/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      toggle: (input: LoopToggleInput, requestOptions?: RequestOptions) =>
        request<LoopToggleOutput>(
          {
            method: "POST",
            path: `/loop/${encodeURIComponent(input.id)}/toggle`,
            body: { enabled: input["enabled"] },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      run: (input: LoopRunInput, requestOptions?: RequestOptions) =>
        request<LoopRunOutput>(
          {
            method: "POST",
            path: `/loop/${encodeURIComponent(input.id)}/run`,
            body: { sessionID: input["sessionID"] },
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      abort: (input: LoopAbortInput, requestOptions?: RequestOptions) =>
        request<LoopAbortOutput>(
          {
            method: "POST",
            path: `/loop/${encodeURIComponent(input.id)}/abort`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      pause: (input: LoopPauseInput, requestOptions?: RequestOptions) =>
        request<LoopPauseOutput>(
          {
            method: "POST",
            path: `/loop/${encodeURIComponent(input.id)}/pause`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      resume: (input: LoopResumeInput, requestOptions?: RequestOptions) =>
        request<LoopResumeOutput>(
          {
            method: "POST",
            path: `/loop/${encodeURIComponent(input.id)}/resume`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      runs: (input: LoopRunsInput, requestOptions?: RequestOptions) =>
        request<LoopRunsOutput>(
          {
            method: "GET",
            path: `/loop/${encodeURIComponent(input.id)}/runs`,
            query: { limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    session: {
      list: (input?: SessionListInput, requestOptions?: RequestOptions) =>
        request<SessionListOutput>(
          {
            method: "GET",
            path: `/session`,
            query: {
              directory: input?.["directory"],
              roots: input?.["roots"],
              start: input?.["start"],
              search: input?.["search"],
              limit: input?.["limit"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      create: (input?: SessionCreateInput, requestOptions?: RequestOptions) =>
        request<SessionCreateOutput>(
          {
            method: "POST",
            path: `/session`,
            body: {
              parentID: input?.["parentID"],
              title: input?.["title"],
              permission: input?.["permission"],
              skills: input?.["skills"],
              github: input?.["github"],
              workspaceID: input?.["workspaceID"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      status: (requestOptions?: RequestOptions) =>
        request<SessionStatusOutput>(
          { method: "GET", path: `/session/status`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      get: (input: SessionGetInput, requestOptions?: RequestOptions) =>
        request<SessionGetOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: SessionRemoveInput, requestOptions?: RequestOptions) =>
        request<SessionRemoveOutput>(
          {
            method: "DELETE",
            path: `/session/${encodeURIComponent(input.sessionID)}`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: SessionUpdateInput, requestOptions?: RequestOptions) =>
        request<SessionUpdateOutput>(
          {
            method: "PATCH",
            path: `/session/${encodeURIComponent(input.sessionID)}`,
            body: { title: input["title"], time: input["time"] },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      fork: (input: SessionForkInput, requestOptions?: RequestOptions) =>
        request<SessionForkOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/fork`,
            body: { messageID: input["messageID"] },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      abort: (input: SessionAbortInput, requestOptions?: RequestOptions) =>
        request<SessionAbortOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/abort`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      revert: (input: SessionRevertInput, requestOptions?: RequestOptions) =>
        request<SessionRevertOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/revert`,
            body: { messageID: input["messageID"], partID: input["partID"] },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      unrevert: (input: SessionUnrevertInput, requestOptions?: RequestOptions) =>
        request<SessionUnrevertOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/unrevert`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      share: (input: SessionShareInput, requestOptions?: RequestOptions) =>
        request<SessionShareOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/share`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      unshare: (input: SessionUnshareInput, requestOptions?: RequestOptions) =>
        request<SessionUnshareOutput>(
          {
            method: "DELETE",
            path: `/session/${encodeURIComponent(input.sessionID)}/share`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      summarize: (input: SessionSummarizeInput, requestOptions?: RequestOptions) =>
        request<SessionSummarizeOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/summarize`,
            body: { providerID: input["providerID"], modelID: input["modelID"], auto: input["auto"] },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      command: (input: SessionCommandInput, requestOptions?: RequestOptions) =>
        request<SessionCommandOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/command`,
            body: {
              messageID: input["messageID"],
              delivery: input["delivery"],
              agent: input["agent"],
              model: input["model"],
              arguments: input["arguments"],
              command: input["command"],
              variant: input["variant"],
              parts: input["parts"],
            },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      shell: (input: SessionShellInput, requestOptions?: RequestOptions) =>
        request<SessionShellOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/shell`,
            body: { agent: input["agent"], model: input["model"], command: input["command"] },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      permissionRespond: (input: SessionPermissionRespondInput, requestOptions?: RequestOptions) =>
        request<SessionPermissionRespondOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/permissions/${encodeURIComponent(input.permissionID)}`,
            body: { response: input["response"] },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      children: (input: SessionChildrenInput, requestOptions?: RequestOptions) =>
        request<SessionChildrenOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/children`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      todo: (input: SessionTodoInput, requestOptions?: RequestOptions) =>
        request<SessionTodoOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/todo`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      diff: (input: SessionDiffInput, requestOptions?: RequestOptions) =>
        request<SessionDiffOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/diff`,
            query: { messageID: input["messageID"] },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      messages: (input: SessionMessagesInput, requestOptions?: RequestOptions) =>
        request<SessionMessagesOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/message`,
            query: { limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      pending: (input: SessionPendingInput, requestOptions?: RequestOptions) =>
        request<SessionPendingOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/pending`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      pendingSteer: (input: SessionPendingSteerInput, requestOptions?: RequestOptions) =>
        request<SessionPendingSteerOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/pending/${encodeURIComponent(input.pendingID)}/steer`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      message: (input: SessionMessageInput, requestOptions?: RequestOptions) =>
        request<SessionMessageOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      messageRemove: (input: SessionMessageRemoveInput, requestOptions?: RequestOptions) =>
        request<SessionMessageRemoveOutput>(
          {
            method: "DELETE",
            path: `/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      partRemove: (input: SessionPartRemoveInput, requestOptions?: RequestOptions) =>
        request<SessionPartRemoveOutput>(
          {
            method: "DELETE",
            path: `/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}/part/${encodeURIComponent(input.partID)}`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      partUpdate: (input: SessionPartUpdateInput, requestOptions?: RequestOptions) =>
        request<SessionPartUpdateOutput>(
          {
            method: "PATCH",
            path: `/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}/part/${encodeURIComponent(input.partID)}`,
            body: input["payload"],
            successStatus: 200,
            declaredStatuses: [404, 409, 400],
            empty: false,
          },
          requestOptions,
        ),
      v2Entries: (input: SessionV2EntriesInput, requestOptions?: RequestOptions) =>
        request<SessionV2EntriesOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/v2/entries`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      v2State: (input: SessionV2StateInput, requestOptions?: RequestOptions) =>
        request<SessionV2StateOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/v2/state`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      v2Events: (input: SessionV2EventsInput, requestOptions?: RequestOptions) =>
        request<SessionV2EventsOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/v2/events`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      instructions: (input: SessionInstructionsInput, requestOptions?: RequestOptions) =>
        request<SessionInstructionsOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/instructions`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      contextBreakdown: (input: SessionContextBreakdownInput, requestOptions?: RequestOptions) =>
        request<SessionContextBreakdownOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/context`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      contextToggle: (input: SessionContextToggleInput, requestOptions?: RequestOptions) =>
        request<SessionContextToggleOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/context/toggle`,
            body: { kind: input["kind"], key: input["key"], enabled: input["enabled"] },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      goal: (input: SessionGoalInput, requestOptions?: RequestOptions) =>
        request<SessionGoalOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/goal`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      background: (input: SessionBackgroundInput, requestOptions?: RequestOptions) =>
        request<SessionBackgroundOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/background`,
            successStatus: 200,
            declaredStatuses: [404],
            empty: false,
          },
          requestOptions,
        ),
      backgroundInspect: (input: SessionBackgroundInspectInput, requestOptions?: RequestOptions) =>
        request<SessionBackgroundInspectOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/background/${encodeURIComponent(input.delegationID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      backgroundRead: (input: SessionBackgroundReadInput, requestOptions?: RequestOptions) =>
        request<SessionBackgroundReadOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/background/${encodeURIComponent(input.delegationID)}/read`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      backgroundCancel: (input: SessionBackgroundCancelInput, requestOptions?: RequestOptions) =>
        request<SessionBackgroundCancelOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/background/${encodeURIComponent(input.delegationID)}/cancel`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      backgroundResume: (input: SessionBackgroundResumeInput, requestOptions?: RequestOptions) =>
        request<SessionBackgroundResumeOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/background/${encodeURIComponent(input.delegationID)}/resume`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      monitor: (input: SessionMonitorInput, requestOptions?: RequestOptions) =>
        request<SessionMonitorOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/monitor/${encodeURIComponent(input.monitorID)}`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      monitorLog: (input: SessionMonitorLogInput, requestOptions?: RequestOptions) =>
        request<SessionMonitorLogOutput>(
          {
            method: "GET",
            path: `/session/${encodeURIComponent(input.sessionID)}/monitor/${encodeURIComponent(input.monitorID)}/log`,
            query: { lines: input["lines"] },
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
      monitorCancel: (input: SessionMonitorCancelInput, requestOptions?: RequestOptions) =>
        request<SessionMonitorCancelOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/monitor/${encodeURIComponent(input.monitorID)}/cancel`,
            successStatus: 200,
            declaredStatuses: [404, 409],
            empty: false,
          },
          requestOptions,
        ),
    },
    account: {
      active: (requestOptions?: RequestOptions) =>
        request<AccountActiveOutput>(
          { method: "GET", path: `/account`, successStatus: 200, declaredStatuses: [502], empty: false },
          requestOptions,
        ),
      login: (requestOptions?: RequestOptions) =>
        request<AccountLoginOutput>(
          { method: "POST", path: `/account/login`, successStatus: 200, declaredStatuses: [502], empty: false },
          requestOptions,
        ),
      complete: (input: AccountCompleteInput, requestOptions?: RequestOptions) =>
        request<AccountCompleteOutput>(
          {
            method: "POST",
            path: `/account/login/complete`,
            body: { deviceCode: input["deviceCode"], expiresIn: input["expiresIn"] },
            successStatus: 200,
            declaredStatuses: [502],
            empty: false,
          },
          requestOptions,
        ),
    },
    sync: {
      event: (input: SyncEventInput, requestOptions?: RequestOptions) =>
        request<SyncEventOutput>(
          {
            method: "POST",
            path: `/sync/event`,
            body: { event: input["event"], projectID: input["projectID"] },
            successStatus: 204,
            declaredStatuses: [429, 401],
            errorHeaders: { "401": ["www-authenticate"], "429": ["retry-after"] },
            emptyErrors: [429, 401],
            empty: true,
          },
          requestOptions,
        ),
      outbox: (input: SyncOutboxInput, requestOptions?: RequestOptions) =>
        request<SyncOutboxOutput>(
          {
            method: "GET",
            path: `/sync/outbox`,
            query: { projectID: input["projectID"], since: input["since"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      snapshot: (input: SyncSnapshotInput, requestOptions?: RequestOptions) =>
        request<SyncSnapshotOutput>(
          {
            method: "GET",
            path: `/sync/snapshot/${encodeURIComponent(input.aggregateID)}`,
            query: { projectID: input["projectID"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      stream: (input: SyncStreamInput, requestOptions?: RequestOptions): AsyncIterable<SyncStreamOutput> =>
        sse<SyncStreamOutput>(
          {
            method: "GET",
            path: `/sync/stream`,
            query: { projectID: input["projectID"], token: input["token"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      stats: (input?: SyncStatsInput, requestOptions?: RequestOptions) =>
        request<SyncStatsOutput>(
          {
            method: "GET",
            path: `/sync/stats`,
            query: { projectID: input?.["projectID"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      config: (input: SyncConfigInput, requestOptions?: RequestOptions) =>
        request<SyncConfigOutput>(
          {
            method: "POST",
            path: `/sync/config`,
            body: { url: input["url"], token: input["token"], autostart: input["autostart"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      connect: (requestOptions?: RequestOptions) =>
        request<SyncConnectOutput>(
          { method: "POST", path: `/sync/connect`, successStatus: 204, declaredStatuses: [], empty: true },
          requestOptions,
        ),
      disconnect: (requestOptions?: RequestOptions) =>
        request<SyncDisconnectOutput>(
          { method: "POST", path: `/sync/disconnect`, successStatus: 204, declaredStatuses: [], empty: true },
          requestOptions,
        ),
      drain: (requestOptions?: RequestOptions) =>
        request<SyncDrainOutput>(
          { method: "POST", path: `/sync/drain`, successStatus: 204, declaredStatuses: [], empty: true },
          requestOptions,
        ),
    },
    tui: {
      appendPrompt: (input: TuiAppendPromptInput, requestOptions?: RequestOptions) =>
        request<TuiAppendPromptOutput>(
          {
            method: "POST",
            path: `/tui/append-prompt`,
            body: { text: input["text"] },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      openHelp: (requestOptions?: RequestOptions) =>
        request<TuiOpenHelpOutput>(
          { method: "POST", path: `/tui/open-help`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      openSessions: (requestOptions?: RequestOptions) =>
        request<TuiOpenSessionsOutput>(
          { method: "POST", path: `/tui/open-sessions`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      openThemes: (requestOptions?: RequestOptions) =>
        request<TuiOpenThemesOutput>(
          { method: "POST", path: `/tui/open-themes`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      openModels: (requestOptions?: RequestOptions) =>
        request<TuiOpenModelsOutput>(
          { method: "POST", path: `/tui/open-models`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      submitPrompt: (requestOptions?: RequestOptions) =>
        request<TuiSubmitPromptOutput>(
          { method: "POST", path: `/tui/submit-prompt`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      clearPrompt: (requestOptions?: RequestOptions) =>
        request<TuiClearPromptOutput>(
          { method: "POST", path: `/tui/clear-prompt`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      executeCommand: (input: TuiExecuteCommandInput, requestOptions?: RequestOptions) =>
        request<TuiExecuteCommandOutput>(
          {
            method: "POST",
            path: `/tui/execute-command`,
            body: { command: input["command"] },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      showToast: (input: TuiShowToastInput, requestOptions?: RequestOptions) =>
        request<TuiShowToastOutput>(
          {
            method: "POST",
            path: `/tui/show-toast`,
            body: {
              title: input["title"],
              message: input["message"],
              variant: input["variant"],
              duration: input["duration"],
            },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      publish: (input: TuiPublishInput, requestOptions?: RequestOptions) =>
        request<TuiPublishOutput>(
          {
            method: "POST",
            path: `/tui/publish`,
            body: { type: input["type"], properties: input["properties"] },
            successStatus: 200,
            declaredStatuses: [400],
            empty: false,
          },
          requestOptions,
        ),
      selectSession: (input: TuiSelectSessionInput, requestOptions?: RequestOptions) =>
        request<TuiSelectSessionOutput>(
          {
            method: "POST",
            path: `/tui/select-session`,
            body: { sessionID: input["sessionID"] },
            successStatus: 200,
            declaredStatuses: [400, 404],
            empty: false,
          },
          requestOptions,
        ),
      config: (requestOptions?: RequestOptions) =>
        request<TuiConfigOutput>(
          { method: "GET", path: `/tui/config`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      controlNext: (requestOptions?: RequestOptions) =>
        request<TuiControlNextOutput>(
          { method: "GET", path: `/tui/control/next`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      controlResponse: (input: TuiControlResponseInput, requestOptions?: RequestOptions) =>
        request<TuiControlResponseOutput>(
          {
            method: "POST",
            path: `/tui/control/response`,
            body: { path: input["path"], body: input["body"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    workspace: {
      adaptors: (requestOptions?: RequestOptions) =>
        request<WorkspaceAdaptorsOutput>(
          {
            method: "GET",
            path: `/experimental/workspace/adaptor`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      syncList: (requestOptions?: RequestOptions) =>
        request<WorkspaceSyncListOutput>(
          {
            method: "POST",
            path: `/experimental/workspace/sync-list`,
            successStatus: 204,
            declaredStatuses: [],
            empty: true,
          },
          requestOptions,
        ),
      status: (requestOptions?: RequestOptions) =>
        request<WorkspaceStatusOutput>(
          {
            method: "GET",
            path: `/experimental/workspace/status`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      create: (input: WorkspaceCreateInput, requestOptions?: RequestOptions) =>
        request<WorkspaceCreateOutput>(
          {
            method: "POST",
            path: `/experimental/workspace/${encodeURIComponent(input.id)}`,
            body: { branch: input["branch"], config: input["config"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      list: (requestOptions?: RequestOptions) =>
        request<WorkspaceListOutput>(
          { method: "GET", path: `/experimental/workspace`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      remove: (input: WorkspaceRemoveInput, requestOptions?: RequestOptions) =>
        request<WorkspaceRemoveOutput>(
          {
            method: "DELETE",
            path: `/experimental/workspace/${encodeURIComponent(input.id)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      restore: (input: WorkspaceRestoreInput, requestOptions?: RequestOptions) =>
        request<WorkspaceRestoreOutput>(
          {
            method: "POST",
            path: `/experimental/workspace/${encodeURIComponent(input.id)}/restore`,
            query: { timeoutMs: input["timeoutMs"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      sessionRestore: (input: WorkspaceSessionRestoreInput, requestOptions?: RequestOptions) =>
        request<WorkspaceSessionRestoreOutput>(
          {
            method: "POST",
            path: `/experimental/workspace/${encodeURIComponent(input.id)}/session/${encodeURIComponent(input.sessionID)}/restore`,
            query: { timeoutMs: input["timeoutMs"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      warp: (input: WorkspaceWarpInput, requestOptions?: RequestOptions) =>
        request<WorkspaceWarpOutput>(
          {
            method: "POST",
            path: `/experimental/workspace/warp`,
            body: {
              id: input["id"],
              sessionID: input["sessionID"],
              copyChanges: input["copyChanges"],
              timeoutMs: input["timeoutMs"],
            },
            successStatus: 204,
            declaredStatuses: [],
            empty: true,
          },
          requestOptions,
        ),
    },
    auth: {
      set: (input: AuthSetInput, requestOptions?: RequestOptions) =>
        request<AuthSetOutput>(
          {
            method: "PUT",
            path: `/auth/${encodeURIComponent(input.providerID)}`,
            body: input["payload"],
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: AuthRemoveInput, requestOptions?: RequestOptions) =>
        request<AuthRemoveOutput>(
          {
            method: "DELETE",
            path: `/auth/${encodeURIComponent(input.providerID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    "config-management": {
      reload: (requestOptions?: RequestOptions) =>
        request<ConfigManagementReloadOutput>(
          { method: "POST", path: `/config/reload`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      mcpAdd: (input: ConfigManagementMcpAddInput, requestOptions?: RequestOptions) =>
        request<ConfigManagementMcpAddOutput>(
          {
            method: "POST",
            path: `/config/mcp`,
            body: { name: input["name"], config: input["config"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      mcpUpdate: (input: ConfigManagementMcpUpdateInput, requestOptions?: RequestOptions) =>
        request<ConfigManagementMcpUpdateOutput>(
          {
            method: "PATCH",
            path: `/config/mcp/${encodeURIComponent(input.name)}`,
            body: input["payload"],
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      mcpRemove: (input: ConfigManagementMcpRemoveInput, requestOptions?: RequestOptions) =>
        request<ConfigManagementMcpRemoveOutput>(
          {
            method: "DELETE",
            path: `/config/mcp/${encodeURIComponent(input.name)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      profilesList: (requestOptions?: RequestOptions) =>
        request<ConfigManagementProfilesListOutput>(
          { method: "GET", path: `/config/profiles`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      profileCreate: (input: ConfigManagementProfileCreateInput, requestOptions?: RequestOptions) =>
        request<ConfigManagementProfileCreateOutput>(
          {
            method: "POST",
            path: `/config/profiles`,
            body: { name: input["name"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      profileActivate: (input: ConfigManagementProfileActivateInput, requestOptions?: RequestOptions) =>
        request<ConfigManagementProfileActivateOutput>(
          {
            method: "POST",
            path: `/config/profiles/activate/${encodeURIComponent(input.name)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    "session-prompt": {
      prompt: (input: SessionPromptPromptInput, requestOptions?: RequestOptions) =>
        request<SessionPromptPromptOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/message`,
            body: {
              messageID: input["messageID"],
              delivery: input["delivery"],
              model: input["model"],
              agent: input["agent"],
              noReply: input["noReply"],
              tools: input["tools"],
              format: input["format"],
              system: input["system"],
              variant: input["variant"],
              parts: input["parts"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      promptAsync: (input: SessionPromptPromptAsyncInput, requestOptions?: RequestOptions) =>
        request<SessionPromptPromptAsyncOutput>(
          {
            method: "POST",
            path: `/session/${encodeURIComponent(input.sessionID)}/prompt_async`,
            body: {
              messageID: input["messageID"],
              delivery: input["delivery"],
              model: input["model"],
              agent: input["agent"],
              noReply: input["noReply"],
              tools: input["tools"],
              format: input["format"],
              system: input["system"],
              variant: input["variant"],
              parts: input["parts"],
            },
            successStatus: 204,
            declaredStatuses: [],
            empty: true,
          },
          requestOptions,
        ),
    },
    share: {
      short: (input: ShareShortInput, requestOptions?: RequestOptions) =>
        request<ShareShortOutput>(
          {
            method: "GET",
            path: `/s/${encodeURIComponent(input.shareID)}`,
            successStatus: 308,
            declaredStatuses: [],
            responseHeaders: ["location"],
            empty: true,
          },
          requestOptions,
        ),
      page: (input: SharePageInput, requestOptions?: RequestOptions) =>
        request<SharePageOutput>(
          {
            method: "GET",
            path: `/share/${encodeURIComponent(input.shareID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      api: (input: ShareApiInput, requestOptions?: RequestOptions) =>
        request<ShareApiOutput>(
          {
            method: "GET",
            path: `/api/share/${encodeURIComponent(input.shareID)}`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      data: (input: ShareDataInput, requestOptions?: RequestOptions) =>
        request<ShareDataOutput>(
          {
            method: "GET",
            path: `/api/share/${encodeURIComponent(input.shareID)}/data`,
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    events: {
      subscribe: (requestOptions?: RequestOptions): AsyncIterable<EventsSubscribeOutput> =>
        sse<EventsSubscribeOutput>(
          { method: "GET", path: `/event`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
      global: (requestOptions?: RequestOptions): AsyncIterable<EventsGlobalOutput> =>
        sse<EventsGlobalOutput>(
          { method: "GET", path: `/global/event`, successStatus: 200, declaredStatuses: [], empty: false },
          requestOptions,
        ),
    },
    "workspace-extra": {
      events: (input: WorkspaceExtraEventsInput, requestOptions?: RequestOptions) =>
        request<WorkspaceExtraEventsOutput>(
          {
            method: "GET",
            path: `/experimental/workspace/${encodeURIComponent(input.id)}/events`,
            query: { from: input["from"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      sessionWarp: (input: WorkspaceExtraSessionWarpInput, requestOptions?: RequestOptions) =>
        request<WorkspaceExtraSessionWarpOutput>(
          {
            method: "POST",
            path: `/experimental/workspace/session/${encodeURIComponent(input.sessionID)}/warp`,
            body: {
              workspaceID: input["workspaceID"],
              copyChanges: input["copyChanges"],
              timeoutMs: input["timeoutMs"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
    users: {
      register: (input: UsersRegisterInput, requestOptions?: RequestOptions) =>
        request<UsersRegisterOutput>(
          {
            method: "POST",
            path: `/user/register`,
            body: {
              username: input["username"],
              email: input["email"],
              password: input["password"],
              displayName: input["displayName"],
            },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      login: (input: UsersLoginInput, requestOptions?: RequestOptions) =>
        request<UsersLoginOutput>(
          {
            method: "POST",
            path: `/user/login`,
            body: { email: input["email"], password: input["password"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: UsersUpdateInput, requestOptions?: RequestOptions) =>
        request<UsersUpdateOutput>(
          {
            method: "PATCH",
            path: `/user/${encodeURIComponent(input.id)}`,
            body: { displayName: input["displayName"], password: input["password"], role: input["role"] },
            successStatus: 200,
            declaredStatuses: [],
            empty: false,
          },
          requestOptions,
        ),
    },
  }
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return
  if (value === null) {
    params.append(key, "null")
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item)
    return
  }
  if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item)
    return
  }
  params.append(key, String(value))
}

async function json(response: Response): Promise<unknown> {
  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnsupportedContentType")
  }
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    throw new ClientError("Transport", { cause })
  }
  if (text === "") throw new ClientError("MalformedResponse")
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ClientError("MalformedResponse", { cause })
  }
}

function isContentType(response: Response, expected: string) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected
}

function readDeclaredHeaders(response: Response, names: ReadonlyArray<string> | undefined) {
  if (names === undefined) return undefined
  const headers: { [key: string]: string } = {}
  for (const name of names) {
    const value = response.headers.get(name)
    if (value !== null) headers[name] = value
  }
  return headers
}

function attachDeclaredHeaders<A>(body: A, response: Response, names: ReadonlyArray<string> | undefined): A {
  const headers = readDeclaredHeaders(response, names)
  return headers === undefined ? body : ({ body, headers } as A)
}
