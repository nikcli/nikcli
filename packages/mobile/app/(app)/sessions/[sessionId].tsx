import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useServer } from "@/lib/server-context"
import { ArrowLeft, Ellipsis, FolderOpen } from "lucide-react-native"
import * as Clipboard from "expo-clipboard"
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { FlashList, type FlashListRef } from "@shopify/flash-list"
import { router, useFocusEffect, useLocalSearchParams, type Href } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { AdaptiveBlur } from "@/components/GlassView"
import { MessageBubble } from "@/components/MessageBubble"
import { PermissionCard } from "@/components/PermissionCard"
import { useActionSheetRef } from "@/components/BottomSheet"

import { CommandPaletteSheet, type CommandPaletteItem } from "@/components/session/CommandPaletteSheet"
import { ComposerApprovalBar } from "@/components/session/ComposerApprovalBar"
import { SessionActionsSheet } from "@/components/session/SessionActionsSheet"
import { SessionInspectorSheet } from "@/components/session/SessionInspectorSheet"
import { SessionWallpaper } from "@/components/session/SessionWallpaper"
import { AttachmentPickerSheet } from "@/components/session/AttachmentPickerSheet"
import { ModelPickerSheet } from "@/components/session/ModelPickerSheet"
import { SessionComposer } from "@/components/session/SessionComposer"
import { JumpToLatestPill } from "@/components/session/JumpToLatestPill"
import { BackgroundActivitySheet } from "@/components/session/BackgroundActivitySheet"
import { ScaffoldingRow } from "@/components/session/ScaffoldingRow"
import { SessionStatusLine } from "@/components/session/SessionStatusLine"
import { TimeDivider } from "@/components/ui/TimeDivider"
import { buildTranscriptRows, type TranscriptRow } from "@/lib/transcript-rows"
import { collectBackgroundTasks, runningTasks, type BackgroundTask } from "@/lib/background-tasks"
import { SessionRenameSheet } from "@/components/session/SessionRenameSheet"
import { PermissionModeSheet } from "@/components/session/PermissionModeSheet"
import {
  detectPermissionMode,
  permissionModeTitle,
  permissionPresetPatch,
  presetPermissionMode,
  toPermissionMap,
  type PermissionMap,
  type PermissionModeSetting,
  type PermissionPreset,
} from "@/lib/permission-presets"
import { SessionTeleportSheet } from "@/components/session/SessionTeleportSheet"
import { markSessionSeen, setTeleportTarget } from "@/lib/storage"
import { type as typeStyle } from "@/lib/typography"
import { setTerminalLaunchIntent } from "@/lib/terminal-launch"
import {
  buildModelCatalog,
  findModelOption,
  formatVariantLabel,
  modelKey,
  parseModelKey,
  type MobileModelOption,
} from "@/lib/model-catalog"
import { getModelVariant, setModelVariant } from "@/lib/model-preferences"
import { PublishSheet } from "@/components/session/PublishSheet"
import { SessionSummaryCard } from "@/components/session/SessionSummaryCard"
import {
  ArtifactViewerSheet,
  SessionPreviewStrip,
  SessionPreviewSheet,
  type SessionPreview,
  type SessionProjectPanel,
} from "@/components/session/SessionPreviewStrip"
import { extractSessionPreviews } from "@/lib/session-artifacts"
import { GitStatusBar } from "@/components/git/GitStatusBar"
import { GitReviewModal } from "@/components/git/GitReviewModal"
import { EmptyState } from "@/components/ui/EmptyState"
import { triggerHaptic } from "@/lib/haptics"
import { useUIStore } from "@/lib/store"
import { sessionWorkspaceDirectory, sessionWorkspaceFallback } from "@/lib/client"
import {
  buildSessionLiveActivitySnapshot,
  compactActivityText,
  sendLocalNotification,
  stopSessionLiveActivity,
  upsertSessionLiveActivity,
} from "@/lib/notifications"
import { SessionDetailSkeleton } from "@/components/session/SessionDetailSkeleton"
import { countOfflineQueueForSession, enqueueOp, isOfflineSendError } from "@/lib/offline"
import { countQueuedUserMessages, getPendingAssistantMessageId, sessionIsProcessing } from "@/lib/session-queue"
import { hexToRgba, useAppTheme } from "@/lib/theme"
import {
  type CommandInfo,
  MOBILE_DEFAULT_MODEL_ID,
  MOBILE_DEFAULT_PROVIDER_ID,
  type FileDiff,
  type GitState,
  type MessageWithParts,
  type PromptStashEntry,
  type QuestionRequest,
  type SessionDetail,
  type SessionStreamEvent,
  type ToolState,
} from "@/lib/types"

const STARTER_PROMPTS = ["Explain this codebase", "What changed recently?", "Fix the failing tests"]

export type PendingAttachment = {
  id: string
  mime: string
  filename: string
  base64: string
  previewUri?: string
  sizeLabel?: string
}
import { useSessionStream } from "@/hooks/use-session-stream"

/** Stable identity so a closed palette never hands its child a fresh array. */
const EMPTY_PALETTE_ITEMS: CommandPaletteItem[] = []

function upsertMessage(messages: MessageWithParts[], next: MessageWithParts["info"]) {
  const index = messages.findIndex((item) => item.info.id === next.id)
  if (index !== -1) {
    const updated = [...messages]
    updated[index] = { ...messages[index], info: next }
    return updated
  }
  return [...messages, { info: next, parts: [] }].sort((a, b) => a.info.time.created - b.info.time.created)
}

function upsertPart(messages: MessageWithParts[], part: MessageWithParts["parts"][number]) {
  const index = messages.findIndex((item) => item.info.id === part.messageID)
  if (index === -1) return messages
  const next = [...messages]
  const message = { ...next[index], parts: [...next[index].parts] }
  const partIndex = message.parts.findIndex((item) => item.id === part.id)
  if (partIndex === -1) message.parts.push(part)
  else message.parts[partIndex] = part
  next[index] = message
  return next
}

function sessionErrorMessage(event: SessionStreamEvent) {
  if (event.type !== "session.error") return null
  const message = event.properties?.error?.data?.message ?? event.properties?.error?.message
  return typeof message === "string" && message.trim() ? message : "Session failed"
}

function parseSlashCommand(value: string) {
  const trimmed = value.trim()
  if (!trimmed.startsWith("/")) return null
  const match = trimmed.match(/^\/([^\s]+)\s*(.*)$/s)
  if (!match) return null
  return {
    command: match[1],
    argumentsText: match[2] ?? "",
  }
}

function messagePlainText(message: MessageWithParts) {
  const text = message.parts
    .filter(
      (part): part is Extract<MessageWithParts["parts"][number], { type: "text" }> =>
        part.type === "text" && !part.synthetic,
    )
    .map((part) => part.text)
    .join("\n\n")
    .trim()
  if (text) return text
  if (message.info.role === "assistant") {
    return message.info.error?.data?.message?.trim() ?? ""
  }
  return ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asToolState(value: unknown): ToolState | null {
  if (!isRecord(value) || typeof value.status !== "string") return null
  return value as ToolState
}

function formatAttachmentSize(base64: string) {
  const bytes = Math.floor((base64.length * 3) / 4)
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export default function SessionScreen() {
  const { palette, isDark } = useAppTheme()
  const { sessionId, liveAction, requestID } = useLocalSearchParams<{
    sessionId: string
    liveAction?: "review" | "approveOnce" | "stop"
    requestID?: string
  }>()
  const { top } = useSafeAreaInsets()
  const { client, config, save, currentUser } = useServer()
  const composerPreferences = useUIStore((state) => state.composer)
  const promptPresets = useUIStore((state) => state.promptPresets)
  const offlineQueueRevision = useUIStore((state) => state.offlineQueueRevision)
  const listRef = useRef<FlashListRef<TranscriptRow>>(null)
  const statusRef = useRef<SessionDetail["status"]>(undefined)
  const permissionIDsRef = useRef<Set<string>>(new Set())
  const questionIDsRef = useRef<Set<string>>(new Set())
  const consumedLiveActionRef = useRef<string | null>(null)
  const followTranscriptRef = useRef(true)
  const prevMessageCountRef = useRef(0)
  const initialScrollDoneRef = useRef(false)
  const scrollRafRef = useRef<number | null>(null)
  const sessionModelBootstrappedRef = useRef<string | null>(null)
  const userModelOverrideRef = useRef(false)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isFollowing, setIsFollowing] = useState(true)
  const [unseenCount, setUnseenCount] = useState(0)
  const [offlineQueuedCount, setOfflineQueuedCount] = useState(0)
  const [diffs, setDiffs] = useState<Record<string, FileDiff[]>>({})
  const [diffLoading, setDiffLoading] = useState<Record<string, boolean>>({})
  const [diffLoaded, setDiffLoaded] = useState<Record<string, boolean>>({})
  const diffLoadedRef = useRef(diffLoaded)
  diffLoadedRef.current = diffLoaded
  const diffLoadingRef = useRef(diffLoading)
  diffLoadingRef.current = diffLoading
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishTitle, setPublishTitle] = useState("")
  const [publishBody, setPublishBody] = useState("")
  const [commitMessage, setCommitMessage] = useState("")
  const [mode, setMode] = useState<"plan" | "code">(composerPreferences.defaultMode)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [stashEntries, setStashEntries] = useState<PromptStashEntry[]>([])
  const [commandsLoading, setCommandsLoading] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState("")
  const chromeButtonFill = isDark ? "rgba(22,22,22,0.88)" : "rgba(255,255,255,0.88)"
  const chromeButtonOverlay = isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.16)"
  const chromeButtonStyle = {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: isDark ? hexToRgba(palette.ink, 0.16) : hexToRgba(palette.border, 0.82),
    overflow: "hidden" as const,
    padding: 12,
  }
  const [activeMessageID, setActiveMessageID] = useState<string | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [teleportOpen, setTeleportOpen] = useState(false)
  const [teleporting, setTeleporting] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false)
  const [gitState, setGitState] = useState<GitState | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [gitReviewOpen, setGitReviewOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [availableModels, setAvailableModels] = useState<MobileModelOption[]>([])
  const [activeModelKey, setActiveModelKey] = useState("")
  const [activeVariant, setActiveVariant] = useState<string | undefined>()
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; connected: boolean; enabled: boolean }>>([])
  const actionsSheetRef = useActionSheetRef()
  const modelPickerRef = useActionSheetRef()
  const previewSheetRef = useActionSheetRef()
  const artifactViewerRef = useActionSheetRef()
  const permissionSheetRef = useActionSheetRef()
  const [permissionMap, setPermissionMap] = useState<PermissionMap>({})
  const [permissionModeSetting, setPermissionModeSetting] = useState<PermissionModeSetting | undefined>()
  const [permissionSaving, setPermissionSaving] = useState(false)
  const [selectedArtifact, setSelectedArtifact] = useState<SessionPreview | null>(null)

  const openArtifact = useCallback((preview: SessionPreview) => {
    setSelectedArtifact(preview)
    requestAnimationFrame(() => {
      artifactViewerRef.current?.present()
    })
    void triggerHaptic("selection")
  }, [])

  const load = useCallback(async () => {
    if (!client || !sessionId) return
    try {
      setLoading(true)
      setDetail(await client.getSession(sessionId))
      setError(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [client, sessionId])

  // `load` without the spinner: a reconnect must not blank a transcript the
  // user is reading. A failure keeps what is on screen and reports nothing —
  // the stream's own error path already says it is disconnected.
  const refresh = useCallback(async () => {
    if (!client || !sessionId) return
    try {
      setDetail(await client.getSession(sessionId))
    } catch {
      // Keep the current transcript.
    }
  }, [client, sessionId])

  const loadCommands = useCallback(async () => {
    if (!client || !sessionId) {
      setCommands([])
      return
    }

    try {
      setCommandsLoading(true)
      setCommands(await client.listCommands(sessionId))
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setCommandsLoading(false)
    }
  }, [client, sessionId])

  const loadMemories = useCallback(async () => {
    if (!client) {
      setStashEntries([])
      return
    }

    try {
      setStashEntries(await client.listPromptStash())
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }, [client])

  /**
   * The git directory is a *string*, so it stays referentially equal across refetches even
   * though `detail.info` is a freshly parsed object every time.
   *
   * Depending on `detail?.info` directly used to spin a network loop: `load()` replaced
   * `detail`, which gave `loadGitState` a new identity, which changed the `useFocusEffect`
   * callback below, which re-ran the effect, which called `load()` again — six requests per
   * turn, as fast as the server could answer, for as long as the screen was open.
   */
  const gitDirectory = useMemo(
    () => (detail?.info ? sessionWorkspaceDirectory(detail.info) : undefined),
    [detail?.info],
  )

  const loadGitState = useCallback(async () => {
    if (!client) {
      setGitState(null)
      return
    }

    try {
      setGitLoading(true)
      const gitClient = gitDirectory ? client.withDirectory(gitDirectory) : client
      const state = await gitClient.getGitStatus()
      setGitState(state)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes("not a git repository")) console.warn("Failed to load git state:", error)
      setGitState(null)
    } finally {
      setGitLoading(false)
    }
  }, [client, gitDirectory])

  const loadPlugins = useCallback(async () => {
    if (!client) {
      setMcpServers([])
      return
    }

    try {
      const [hostConfig, mcpStatus] = await Promise.all([client.getConfig(), client.listMcpStatus()])

      const servers = Object.entries(hostConfig?.mcp ?? {}).map(([name, cfg]) => ({
        name,
        enabled: cfg.enabled !== false,
        connected: mcpStatus[name]?.status === "connected",
      }))
      setMcpServers(servers)
    } catch (error) {
      console.warn("Failed to load plugins:", error)
    }
  }, [client])

  const drawerSkills = useMemo(
    () =>
      commands.reduce<Array<{ name: string; description?: string }>>((acc, c) => {
        if (c.skill) acc.push({ name: c.name, description: c.description })
        return acc
      }, []),
    [commands],
  )

  const drawerTools = useMemo(
    () =>
      commands.reduce<Array<{ name: string; description?: string; enabled: true }>>((acc, c) => {
        if (!c.skill && !c.mcp && !c.subtask) {
          acc.push({ name: c.name, description: c.description, enabled: true })
        }
        return acc
      }, []),
    [commands],
  )

  const loadAvailableModels = useCallback(async () => {
    if (!client) return
    try {
      const providers = await client.listProviders()
      setAvailableModels(buildModelCatalog(providers, { connectedOnly: true }))
    } catch (error) {
      console.warn("Failed to load models:", error)
      setAvailableModels([])
    }
  }, [client])

  useFocusEffect(
    useCallback(() => {
      void load()
      void loadCommands()
      void loadMemories()
      void loadGitState()
      void loadPlugins()
      void loadAvailableModels()
      if (sessionId) void markSessionSeen(sessionId)
    }, [load, loadCommands, loadMemories, loadGitState, loadPlugins, loadAvailableModels, sessionId]),
  )

  useEffect(() => {
    if (!commandPaletteOpen) return
    void loadCommands()
    void loadMemories()
  }, [commandPaletteOpen, loadCommands, loadMemories])

  useEffect(() => {
    followTranscriptRef.current = composerPreferences.autoFollowTranscript
    initialScrollDoneRef.current = false
    prevMessageCountRef.current = 0
    setIsFollowing(composerPreferences.autoFollowTranscript)
    setUnseenCount(0)
  }, [composerPreferences.autoFollowTranscript, sessionId])

  useEffect(() => {
    setMode(composerPreferences.defaultMode)
  }, [composerPreferences.defaultMode, sessionId])

  useEffect(() => {
    if (!detail) return
    statusRef.current = detail.status
    permissionIDsRef.current = new Set(detail.permissions.map((item) => item.id))
  }, [detail])

  useEffect(() => {
    userModelOverrideRef.current = false
    sessionModelBootstrappedRef.current = null
    setActiveModelKey("")
    setActiveVariant(undefined)
  }, [sessionId])

  useEffect(() => {
    if (!config || !sessionId || loading) return
    if (userModelOverrideRef.current) return
    if (sessionModelBootstrappedRef.current === sessionId) return

    sessionModelBootstrappedRef.current = sessionId

    const lastUser = [...(detail?.messages ?? [])].reverse().find((item) => item.info.role === "user")
    if (lastUser?.info.role === "user") {
      setActiveModelKey(modelKey(lastUser.info.model.providerID, lastUser.info.model.modelID))
      setActiveVariant(lastUser.info.variant)
      return
    }

    const providerID = config.modelProviderID ?? MOBILE_DEFAULT_PROVIDER_ID
    const modelID = config.modelID ?? MOBILE_DEFAULT_MODEL_ID
    setActiveModelKey(modelKey(providerID, modelID))
    void getModelVariant(providerID, modelID).then(setActiveVariant)
  }, [config, detail?.messages, loading, sessionId, config?.modelID, config?.modelProviderID])

  useSessionStream({
    config,
    sessionID: sessionId,
    enabled: Boolean(config && sessionId),
    onReconnect: refresh,
    onEvent(event: SessionStreamEvent) {
      const nextError = sessionErrorMessage(event)
      if (nextError) {
        setError(nextError)
        void triggerHaptic("error")
        if (sessionId) {
          void stopSessionLiveActivity({
            sessionID: sessionId,
            title: detail?.info.title || "Session failed",
            subtitle: compactActivityText(nextError, 72),
          })
        }
        void sendLocalNotification({
          kind: "failures",
          title: detail?.info.title || "Session failed",
          body: nextError,
          dedupeKey: `${sessionId}:error:${nextError}`,
          href: sessionId ? `/sessions/${sessionId}` : undefined,
          sessionID: sessionId,
        })
        return
      }

      if (event.type === "permission.asked") {
        const requestID = event.properties.id
        if (!permissionIDsRef.current.has(requestID)) {
          permissionIDsRef.current.add(requestID)
          void triggerHaptic("permission")
          void sendLocalNotification({
            kind: "permissions",
            title: detail?.info.title || "Permission required",
            body: event.properties.permission,
            dedupeKey: `${sessionId}:permission:${requestID}`,
            href: sessionId ? `/sessions/${sessionId}` : undefined,
            sessionID: sessionId,
          })
        }
      }

      if (event.type === "permission.replied") {
        permissionIDsRef.current.delete(event.properties.requestID)
      }

      if (event.type === "question.asked") {
        const requestID = event.properties.id
        if (!questionIDsRef.current.has(requestID)) {
          questionIDsRef.current.add(requestID)
          void triggerHaptic("permission")
          void sendLocalNotification({
            kind: "permissions",
            title: detail?.info.title || "Question",
            body: event.properties.questions[0]?.question ?? "A question needs your response",
            dedupeKey: `${sessionId}:question:${requestID}`,
            href: sessionId ? `/sessions/${sessionId}` : undefined,
            sessionID: sessionId,
          })
        }
      }

      if (event.type === "question.replied" || event.type === "question.rejected") {
        questionIDsRef.current.delete(event.properties.requestID)
      }

      if (event.type === "session.status") {
        statusRef.current = event.properties.status
      }

      if (event.type === "session.idle") {
        if (statusRef.current?.type && statusRef.current.type !== "idle") {
          void triggerHaptic("success")
          void sendLocalNotification({
            kind: "sessionReady",
            title: detail?.info.title || "Session ready",
            body: "Execution is idle and ready for the next command.",
            dedupeKey: `${sessionId}:idle`,
            href: sessionId ? `/sessions/${sessionId}` : undefined,
            sessionID: sessionId,
          })
        }
        statusRef.current = { type: "idle" }
      }

      setDetail((current) => {
        if (!current) return current
        if (event.type === "message.updated")
          return {
            ...current,
            messages: upsertMessage(current.messages, event.properties.info),
          }
        if (event.type === "message.part.updated")
          return {
            ...current,
            messages: upsertPart(current.messages, event.properties.part),
          }
        if (event.type === "message.removed")
          return {
            ...current,
            messages: current.messages.filter((item) => item.info.id !== event.properties.messageID),
          }
        if (event.type === "message.part.removed") {
          return {
            ...current,
            messages: current.messages.map((item) =>
              item.info.id === event.properties.messageID
                ? {
                    ...item,
                    parts: item.parts.filter((part) => part.id !== event.properties.partID),
                  }
                : item,
            ),
          }
        }
        if (event.type === "session.updated") return { ...current, info: event.properties.info }
        if (event.type === "session.status") return { ...current, status: event.properties.status }
        if (event.type === "session.idle") return { ...current, status: { type: "idle" } }
        if (event.type === "permission.asked")
          return {
            ...current,
            permissions: [...current.permissions, event.properties],
          }
        if (event.type === "permission.replied") {
          return {
            ...current,
            permissions: current.permissions.filter((item) => item.id !== event.properties.requestID),
          }
        }
        if (event.type === "question.asked")
          return {
            ...current,
            questions: [...current.questions, event.properties],
          }
        if (event.type === "question.replied" || event.type === "question.rejected") {
          return {
            ...current,
            questions: current.questions.filter((item) => item.id !== event.properties.requestID),
          }
        }
        return current
      })
    },
    onError(message) {
      setError(message)
    },
  })

  const messages = useMemo(() => detail?.messages ?? [], [detail])
  // The transcript is laid out before it is rendered: timestamps between
  // sittings, injected context folded away from the conversation.
  const rows = useMemo(() => buildTranscriptRows(messages), [messages])
  const backgroundTasks = useMemo(() => collectBackgroundTasks(messages), [messages])
  const runningBackgroundTasks = useMemo(() => runningTasks(backgroundTasks), [backgroundTasks])
  const pendingAssistantId = useMemo(() => getPendingAssistantMessageId(messages), [messages])
  const queuedMessageCount = useMemo(
    () => countQueuedUserMessages(messages, pendingAssistantId),
    [messages, pendingAssistantId],
  )
  // FlashList recycles rows, so changes that don't come from the `data` array
  // (active highlight, lazily loaded diffs) must be signalled via `extraData`.
  const listExtraData = useMemo(
    () => ({
      activeMessageID,
      diffs,
      diffLoaded,
      diffLoading,
      pendingAssistantId,
    }),
    [activeMessageID, diffs, diffLoaded, diffLoading, pendingAssistantId],
  )
  const previews = useMemo(
    () => extractSessionPreviews(messages, config?.url, detail?.artifacts),
    [config?.url, detail?.artifacts, messages],
  )
  const sessionBlocked = sessionIsProcessing(detail?.status)
  const cleaned = Boolean(detail?.info.github?.worktree.cleanedAt ?? detail?.info.worktree?.cleanedAt)
  const hasCleanableWorktree = Boolean(detail?.info.github?.worktree ?? detail?.info.worktree)
  const sessionProject =
    detail?.info.github?.repo || detail?.info.directory?.split("/").filter(Boolean).pop() || "Workspace"
  const sessionOwner = currentUser?.display_name || currentUser?.username
  const sessionLocation = [sessionProject, sessionOwner].filter(Boolean).join(" · ")

  const openSessionExplorer = useCallback(() => {
    if (!sessionId || !detail) return
    const dir = sessionWorkspaceDirectory(detail.info)
    if (!dir) return
    const fallbackDirectory = sessionWorkspaceFallback(detail.info)
    void triggerHaptic("selection")
    router.push({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pathname: "/sessions/explorer" as any,
      params: {
        sessionId,
        directory: dir,
        fallbackDirectory: fallbackDirectory ?? "",
      },
    })
  }, [detail, sessionId])

  const sessionProjectPanel = useMemo((): SessionProjectPanel | null => {
    if (!detail) return null
    const gh = detail.info.github
    const workspacePrimary = gh?.fullName ?? detail.info.directory ?? "Workspace"
    const localPath = sessionWorkspaceDirectory(detail.info) ?? ""
    const pathDetail = localPath && localPath !== workspacePrimary ? localPath : undefined
    const explorerDir = sessionWorkspaceDirectory(detail.info) ?? ""
    return {
      sessionTitle: detail.info.title || "Session",
      workspacePrimary,
      pathDetail,
      branchLabel: gh?.worktree.branch ? `On ${gh.worktree.branch}` : undefined,
      githubUrl: gh?.htmlUrl,
      onBrowseWorkspace: explorerDir ? openSessionExplorer : undefined,
    }
  }, [detail, openSessionExplorer])
  const liveActivitySnapshot = useMemo(
    () => (detail && sessionId ? buildSessionLiveActivitySnapshot(detail, { publishing, cleaning }) : null),
    [cleaning, detail, publishing, sessionId],
  )
  const activeModel = useMemo(() => {
    const parsed = parseModelKey(activeModelKey)
    if (parsed) return parsed
    return {
      providerID: config?.modelProviderID ?? MOBILE_DEFAULT_PROVIDER_ID,
      modelID: config?.modelID ?? MOBILE_DEFAULT_MODEL_ID,
    }
  }, [activeModelKey, config?.modelID, config?.modelProviderID])

  const sendOptions = useMemo(
    () => ({
      model: activeModel,
      variant: activeVariant,
    }),
    [activeModel, activeVariant],
  )

  useEffect(() => {
    if (!sessionId || !liveActivitySnapshot) return

    if (liveActivitySnapshot.mode === "upsert") {
      void upsertSessionLiveActivity({
        sessionID: sessionId,
        activity: liveActivitySnapshot.activity,
      })
      return
    }

    void stopSessionLiveActivity({
      sessionID: sessionId,
      title: liveActivitySnapshot.title,
      subtitle: liveActivitySnapshot.subtitle,
    })
  }, [liveActivitySnapshot, sessionId])
  const modelLabel = useMemo(() => {
    const option = findModelOption(availableModels, activeModel.providerID, activeModel.modelID)
    const base = option?.shortName ?? activeModel.modelID.split(/[-/:]/).pop() ?? activeModel.modelID
    if (!activeVariant) return base
    return `${base} · ${formatVariantLabel(activeVariant)}`
  }, [activeModel, activeVariant, availableModels])

  const openModelPicker = useCallback(() => {
    modelPickerRef.current?.present()
    void triggerHaptic("selection")
  }, [])

  const permissionMode = useMemo(
    () => detectPermissionMode(permissionMap, permissionModeSetting),
    [permissionMap, permissionModeSetting],
  )

  useEffect(() => {
    if (!client) return
    let cancelled = false
    client
      .getConfig()
      .then((config) => {
        if (cancelled) return
        setPermissionMap(toPermissionMap(config.permission))
        setPermissionModeSetting(config.permission_mode as PermissionModeSetting | undefined)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  const applyPermissionPreset = useCallback(
    async (preset: PermissionPreset) => {
      if (!client || permissionSaving) return
      const before = permissionMap
      const beforeMode = permissionModeSetting
      const patch = permissionPresetPatch(preset)
      const nextMode = presetPermissionMode(preset)
      setPermissionMap({ ...toPermissionMap(before), ...patch })
      setPermissionModeSetting(nextMode)
      try {
        setPermissionSaving(true)
        await client.updateConfig({ permission: patch, permission_mode: nextMode } as Parameters<
          typeof client.updateConfig
        >[0])
        void triggerHaptic("success")
        permissionSheetRef.current?.dismiss()
      } catch (error) {
        setPermissionMap(before)
        setPermissionModeSetting(beforeMode)
        setError(error instanceof Error ? error.message : String(error))
      } finally {
        setPermissionSaving(false)
      }
    },
    [client, permissionMap, permissionModeSetting, permissionSaving],
  )
  const slashInput = useMemo(() => parseSlashCommand(input), [input])
  const slashSuggestions = useMemo(() => {
    if (!composerPreferences.slashSuggestions) return []
    if (!input.trimStart().startsWith("/")) return []
    const raw = input.trimStart().slice(1).split(/\s+/)[0]?.toLowerCase() ?? ""
    const compactSuggestion = {
      name: "compact",
      description: "Summarize earlier context while preserving key details",
      badge: "Session",
    }
    const remoteSuggestions = commands
      .filter((command) => command.name !== "compact" && command.name !== "summarize")
      .filter((command) => {
        if (!raw) return true
        return (
          command.name.toLowerCase().includes(raw) ||
          command.description?.toLowerCase().includes(raw) ||
          command.hints.some((hint) => hint.toLowerCase().includes(raw))
        )
      })
      .slice(0, 20)
      .map((command) => ({
        name: command.name,
        description: command.description || (command.hints.length ? command.hints.join(" ") : undefined),
        badge: command.skill
          ? "Skill"
          : command.mcp
            ? "MCP"
            : command.subtask
              ? "Task"
              : command.hints.length
                ? `${command.hints.length} args`
                : undefined,
      }))
    return [compactSuggestion, ...remoteSuggestions]
      .filter((command) => {
        if (!raw) return true
        return command.name.includes(raw) || command.description?.toLowerCase().includes(raw)
      })
      .slice(0, 20)
  }, [commands, composerPreferences.slashSuggestions, input])
  const activeMcpCount = useMemo(() => commands.filter((c) => c.mcp).length, [commands])

  const handleModelSelect = useCallback(
    (id: string, variant?: string) => {
      if (!config || id === "default") return
      const parsed = parseModelKey(id)
      if (!parsed) return
      userModelOverrideRef.current = true
      setActiveModelKey(id)
      setActiveVariant(variant)
      void (async () => {
        try {
          await save({
            ...config,
            modelProviderID: parsed.providerID,
            modelID: parsed.modelID,
          })
          await setModelVariant(parsed.providerID, parsed.modelID, variant)
          void triggerHaptic("selection")
        } catch (error) {
          console.warn("Failed to update model:", error)
          void triggerHaptic("error")
        }
      })()
    },
    [config, save],
  )

  const handleMcpToggle = useCallback(
    (name: string, enabled: boolean) => {
      if (!client) return
      void (async () => {
        try {
          await client.toggleMcp(name, enabled)
          await loadPlugins()
          void triggerHaptic("selection")
        } catch (error) {
          console.warn("Failed to toggle MCP:", error)
          void triggerHaptic("error")
        }
      })()
    },
    [client, loadPlugins],
  )

  async function handleRename(title: string) {
    if (!client || !sessionId) return
    try {
      setRenaming(true)
      await client.renameSession(sessionId, title)
      await load()
      setRenameOpen(false)
      void triggerHaptic("success")
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setRenaming(false)
    }
  }

  async function handleTeleport(target: { url: string; token: string }) {
    if (!client || !sessionId) return
    try {
      setTeleporting(true)
      await client.teleport(sessionId, target)
      await setTeleportTarget(target)
      setTeleportOpen(false)
      void triggerHaptic("success")
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      void triggerHaptic("error")
    } finally {
      setTeleporting(false)
    }
  }

  async function handleExport(format: "markdown" | "json") {
    if (!detail) return
    const messages = detail.messages
    let content: string
    let title: string
    if (format === "json") {
      content = JSON.stringify(detail, null, 2)
      title = `${detail.info.title}.json`
    } else {
      const lines: string[] = [`# ${detail.info.title}`, ""]
      for (const msg of messages) {
        const role = msg.info.role === "user" ? "**User**" : "**Assistant**"
        const text = msg.parts
          .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("\n\n")
        if (text) lines.push(`${role}\n\n${text}`, "")
      }
      content = lines.join("\n")
      title = `${detail.info.title}.md`
    }
    await Share.share({ message: content, title })
    void triggerHaptic("success")
  }

  function handleAddAttachment(item: PendingAttachment) {
    void triggerHaptic("selection")
    setPendingAttachments((prev) => [...prev, item])
  }

  function handlePickedAttachment(mime: string, filename: string, base64: string, previewUri?: string) {
    handleAddAttachment({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      mime,
      filename,
      base64,
      previewUri,
      sizeLabel: formatAttachmentSize(base64),
    })
  }

  function handleRemoveAttachment(id: string) {
    void triggerHaptic("selection")
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  function openPublishModal() {
    if (!detail?.info.github) return
    setPublishTitle(detail.info.github.pullRequest?.title || detail.info.title)
    setCommitMessage(detail.info.title)
    setPublishBody(
      detail.info.github.pullRequest
        ? `Updated from mobile session ${detail.info.id}.`
        : `## Summary\n- Generated from mobile session \`${detail.info.id}\`\n- Base branch: \`${detail.info.github.baseBranch}\`\n- Head branch: \`${detail.info.github.headBranch}\``,
    )
    setPublishOpen(true)
  }

  const sessionGitDir = useMemo(
    () => (detail?.info ? sessionWorkspaceDirectory(detail.info) : undefined),
    [detail?.info],
  )

  async function compactContext() {
    if (!client || !sessionId || compacting || cleaned) return
    if (sessionBlocked) {
      setError("Wait for the active run to finish before compacting the context.")
      void triggerHaptic("error")
      return
    }

    try {
      setCompacting(true)
      setError(null)
      const scopedClient = sessionGitDir ? client.withDirectory(sessionGitDir) : client
      await scopedClient.compactSession(sessionId, activeModel)
      await load()
      void triggerHaptic("success")
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      void triggerHaptic("error")
    } finally {
      setCompacting(false)
    }
  }

  async function send() {
    if (!client || !sessionId || !input.trim() || cleaned) return
    const submittedInput = input
    const submittedText = submittedInput.trim()
    const submittedSlashInput = slashInput
    const submittedAttachments = pendingAttachments

    if (
      submittedSlashInput &&
      (submittedSlashInput.command.toLowerCase() === "compact" ||
        submittedSlashInput.command.toLowerCase() === "summarize")
    ) {
      setInput("")
      await compactContext()
      return
    }

    try {
      setSending(true)
      setError(null)
      setInput("")
      if (submittedAttachments.length > 0) setPendingAttachments([])

      if (submittedSlashInput) {
        await client.sendCommand(sessionId, submittedSlashInput.command, submittedSlashInput.argumentsText, {
          ...sendOptions,
        })
        void triggerHaptic("command")
        return
      }
      const payload =
        mode === "plan"
          ? `Plan mode: analyze the request, propose the approach, and avoid making changes until explicitly requested.\n\nUser request: ${submittedText}`
          : submittedText
      if (submittedAttachments.length > 0) {
        const fileParts = submittedAttachments.map((a) => ({
          type: "file" as const,
          mime: a.mime,
          filename: a.filename,
          url: `data:${a.mime};base64,${a.base64}`,
        }))
        await client.sendParts(sessionId, [{ type: "text", text: payload }, ...fileParts], sendOptions)
      } else {
        await client.sendMessage(sessionId, payload, sendOptions)
      }
      void triggerHaptic("send")
    } catch (error) {
      void triggerHaptic("error")
      const offline =
        isOfflineSendError(error) &&
        sessionId &&
        submittedText &&
        !submittedSlashInput &&
        submittedAttachments.length === 0
      if (offline) {
        void enqueueOp({
          type: "sendMessage",
          sessionID: sessionId,
          text: submittedText,
          options: sendOptions,
        }).then(() => countOfflineQueueForSession(sessionId).then(setOfflineQueuedCount))
        setError(null)
      } else {
        setError(error instanceof Error ? error.message : String(error))
        setInput(submittedInput)
        if (submittedAttachments.length > 0) setPendingAttachments(submittedAttachments)
      }
    } finally {
      setSending(false)
    }
  }

  function insertSlashCommand(name: string) {
    void triggerHaptic("selection")
    const current = input.trimStart()
    const match = current.match(/^\/([^\s]+)(.*)$/s)
    const remainder = match?.[2] ?? ""
    const nextRemainder = remainder.startsWith(" ") || remainder === "" ? remainder : ` ${remainder}`
    setInput(`/${name}${nextRemainder || " "}`)
  }

  function scrollToTop() {
    followTranscriptRef.current = false
    listRef.current?.scrollToOffset({ offset: 0, animated: true })
  }

  function scrollToBottom() {
    followTranscriptRef.current = true
    setIsFollowing(true)
    setUnseenCount(0)
    listRef.current?.scrollToEnd({ animated: true })
  }

  function mergeDraft(nextValue: string) {
    const current = input.trim()
    if (current.startsWith("/")) {
      setInput(nextValue)
      return
    }
    if (!current) {
      setInput(nextValue)
      return
    }
    setInput(`${current}\n\n${nextValue}`)
  }

  function scrollToLatest(animated: boolean) {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current)
    }
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      listRef.current?.scrollToEnd({ animated })
    })
  }

  function updateTranscriptFollow(event: {
    nativeEvent: {
      layoutMeasurement: { height: number }
      contentOffset: { y: number }
      contentSize: { height: number }
    }
  }) {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent
    const distanceFromBottom = contentSize.height - (layoutMeasurement.height + contentOffset.y)
    const following = distanceFromBottom < 96
    followTranscriptRef.current = following
    setIsFollowing(following)
    if (following) setUnseenCount(0)
  }

  // Count messages that arrive while the user is scrolled away from the
  // bottom; the initial load (prev === 0) never counts as unseen.
  useEffect(() => {
    const prev = prevMessageCountRef.current
    prevMessageCountRef.current = messages.length
    if (prev !== 0 && messages.length > prev && !followTranscriptRef.current) {
      setUnseenCount((count) => count + (messages.length - prev))
    }
  }, [messages.length])

  const copyMessage = useCallback(async (message: MessageWithParts) => {
    const value = messagePlainText(message)
    if (!value) return
    await Clipboard.setStringAsync(value)
    setActiveMessageID(null)
    void triggerHaptic("selection")
  }, [])

  const reuseMessage = useCallback((message: MessageWithParts) => {
    const value = messagePlainText(message)
    if (!value) return
    setInput(message.info.role === "assistant" ? `Follow up on this result:\n\n${value}` : value)
    setActiveMessageID(null)
    void triggerHaptic("selection")
  }, [])

  const dismissActiveMessage = useCallback(() => setActiveMessageID(null), [])
  const activateMessage = useCallback((messageID: string) => setActiveMessageID(messageID), [])

  const loadDiff = useCallback(
    async (messageID: string) => {
      if (!client || !sessionId || diffLoadedRef.current[messageID] || diffLoadingRef.current[messageID]) return
      try {
        setDiffLoading((current) => ({ ...current, [messageID]: true }))
        setError(null)
        const next = await client.getDiff(sessionId, messageID)
        setDiffs((current) => ({ ...current, [messageID]: next }))
        setDiffLoaded((current) => ({ ...current, [messageID]: true }))
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
      } finally {
        setDiffLoading((current) => ({ ...current, [messageID]: false }))
      }
    },
    [client, sessionId],
  )

  async function respond(permissionID: string, response: "once" | "always" | "reject") {
    if (!client || !sessionId) return
    await client.respondToPermission(sessionId, permissionID, response)
    void triggerHaptic(response === "reject" ? "error" : "success")
  }

  async function abort() {
    if (!client || !sessionId) return
    await client.abortSession(sessionId)
    void triggerHaptic("error")
  }

  useEffect(() => {
    if (!client || !sessionId || !liveAction) return

    const actionKey = `${sessionId}:${liveAction}:${requestID ?? ""}`
    if (consumedLiveActionRef.current === actionKey) return

    if (liveAction === "review") {
      consumedLiveActionRef.current = actionKey
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }))
      void triggerHaptic("selection")
      return
    }

    if (liveAction === "approveOnce") {
      if (!detail || !requestID) return
      consumedLiveActionRef.current = actionKey

      if (!detail.permissions.some((permission) => permission.id === requestID)) {
        setError("This approval is no longer pending.")
        void load()
        return
      }

      void (async () => {
        try {
          setError(null)
          await client.respondToPermission(sessionId, requestID, "once")
          void triggerHaptic("success")
          await load()
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error))
          void triggerHaptic("error")
        }
      })()
      return
    }

    consumedLiveActionRef.current = actionKey
    Alert.alert("Stop this session?", "The active response will be cancelled. Existing changes will be kept.", [
      { text: "Keep working", style: "cancel" },
      {
        text: "Stop",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              setError(null)
              await client.abortSession(sessionId)
              void triggerHaptic("error")
              await load()
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error))
            }
          })()
        },
      },
    ])
  }, [client, detail, liveAction, load, requestID, sessionId])

  async function publish() {
    if (!client || !sessionId || !detail?.info.github || sessionBlocked || cleaned) return
    try {
      setPublishing(true)
      setError(null)
      const result = await client.publishGithubSession(sessionId, {
        title: publishTitle.trim() || detail.info.github.pullRequest?.title || detail.info.title,
        body: publishBody.trim() || undefined,
        commitMessage: commitMessage.trim() || detail.info.title,
      })
      void triggerHaptic("success")
      useUIStore.getState().showToast({
        message: result.pullRequest?.url ? `PR #${result.pullRequest.number} published` : "Pull request published",
        kind: "success",
      })
      void sendLocalNotification({
        kind: "sessionReady",
        title: detail.info.title,
        body: "GitHub publish workflow completed successfully.",
        dedupeKey: `${sessionId}:publish`,
        href: `/sessions/${sessionId}`,
        sessionID: sessionId,
      })
      setPublishOpen(false)
      await load()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setPublishing(false)
    }
  }

  async function cleanup() {
    if (!client || !sessionId || !hasCleanableWorktree || sessionBlocked || cleaned) return
    try {
      setCleaning(true)
      setError(null)
      await client.cleanupGithubSession(sessionId)
      void triggerHaptic("success")
      const repositoryDirectory = detail?.info.github?.repositoryDirectory || detail?.info.worktree?.repositoryDirectory
      if (config && repositoryDirectory) {
        await save({
          ...config,
          directory: repositoryDirectory,
        })
      }
      await load()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setCleaning(false)
    }
  }

  const paletteItems = useMemo<CommandPaletteItem[]>(() => {
    // `input` is a dependency, so this rebuilt every command, preset and stash entry — then
    // filtered them — on every keystroke in the composer, for a list nothing was showing.
    // The palette is the only consumer, so while it is closed there is nothing to build.
    if (!commandPaletteOpen) return EMPTY_PALETTE_ITEMS

    const localItems: CommandPaletteItem[] = [
      {
        id: "local.scroll.bottom",
        title: "Jump to latest output",
        description: "Scroll to the newest message in this transcript.",
        section: "View",
        badge: "Local",
        keywords: ["bottom", "latest", "newest", "transcript"],
        onPress: () => {
          setCommandPaletteOpen(false)
          void triggerHaptic("selection")
          scrollToBottom()
        },
      },
      {
        id: "local.scroll.permissions",
        title: "Jump to approvals",
        description: "Scroll to the top of the session and inspect pending permissions.",
        section: "View",
        badge: detail?.permissions.length ? `${detail.permissions.length}` : "Local",
        disabled: !detail?.permissions.length,
        keywords: ["permissions", "approvals", "top"],
        onPress: () => {
          setCommandPaletteOpen(false)
          void triggerHaptic("selection")
          scrollToTop()
        },
      },
      {
        id: "local.inspector",
        title: "Open session inspector",
        description: "Todos, MCP, LSP, context, and modified files for this session.",
        section: "View",
        badge: "Local",
        keywords: ["inspector", "todo", "mcp", "lsp", "files", "context"],
        onPress: () => {
          setCommandPaletteOpen(false)
          void triggerHaptic("selection")
          setInspectorOpen(true)
        },
      },
      {
        id: "local.missions",
        title: "Open missions",
        description: "Jump to multi-milestone automation on this host.",
        section: "Tools",
        badge: "Local",
        keywords: ["missions", "automation", "plan"],
        onPress: () => {
          setCommandPaletteOpen(false)
          void triggerHaptic("selection")
          router.push("/more/missions" as Href)
        },
      },
      {
        id: "local.brain",
        title: "Open brain",
        description: "Consolidate recent sessions into long-term host memory.",
        section: "Tools",
        badge: "Local",
        keywords: ["brain", "memory", "consolidate"],
        onPress: () => {
          setCommandPaletteOpen(false)
          void triggerHaptic("selection")
          router.push("/more/brain" as Href)
        },
      },
      {
        id: "local.appearance",
        title: "Session wallpaper",
        description: "Set a chat backdrop, math rendering, and rotating tips.",
        section: "Tools",
        badge: "Local",
        keywords: ["wallpaper", "appearance", "math", "tips", "backdrop"],
        onPress: () => {
          setCommandPaletteOpen(false)
          void triggerHaptic("selection")
          router.push("/more/settings/appearance" as Href)
        },
      },
      {
        id: "local.publish",
        title: "Open publish workflow",
        description: "Prepare commit, PR title, and publish notes for the current GitHub session.",
        section: "GitHub",
        badge: "Local",
        disabled: !detail?.info.github || cleaned,
        keywords: ["publish", "pull request", "pr", "commit"],
        onPress: () => {
          setCommandPaletteOpen(false)
          void triggerHaptic("selection")
          openPublishModal()
        },
      },
      {
        id: "local.compact",
        title: compacting ? "Compacting context…" : "Compact context",
        description: "Summarize earlier messages while preserving decisions, progress, and relevant files.",
        section: "Session",
        badge: "/compact",
        disabled: compacting || sessionBlocked || cleaned,
        keywords: ["compact", "summarize", "context", "tokens"],
        onPress: () => {
          setCommandPaletteOpen(false)
          void compactContext()
        },
      },
      {
        id: "local.abort",
        title: "Abort active run",
        description: "Stop the current execution if the session is busy.",
        section: "Session",
        badge: "Local",
        disabled: !sessionBlocked,
        keywords: ["abort", "stop", "cancel", "busy"],
        onPress: () => {
          setCommandPaletteOpen(false)
          void abort()
        },
      },
      {
        id: "local.clear",
        title: "Clear composer",
        description: "Remove the current draft from the composer.",
        section: "Compose",
        badge: "Local",
        disabled: !input.trim(),
        keywords: ["clear", "draft", "composer"],
        onPress: () => {
          setCommandPaletteOpen(false)
          void triggerHaptic("selection")
          setInput("")
        },
      },
      {
        id: "local.save-snippet",
        title: "Save draft to memories",
        description: "Store the current composer draft as a reusable host-backed snippet.",
        section: "Memories",
        badge: "Local",
        disabled: !input.trim(),
        keywords: ["save", "snippet", "memory", "stash", "draft"],
        onPress: () => {
          setCommandPaletteOpen(false)
          if (!client || !input.trim()) return
          void (async () => {
            try {
              await client.addPromptStash({ input: input.trim() })
              await loadMemories()
              void triggerHaptic("success")
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error))
              void triggerHaptic("error")
            }
          })()
        },
      },
    ]

    const presetItems = promptPresets.map<CommandPaletteItem>((preset) => ({
      id: `preset:${preset.id}`,
      title: preset.title,
      description: preset.prompt,
      section: "Presets",
      badge: preset.mode,
      keywords: [preset.mode, "preset", "prompt"],
      onPress: () => {
        setCommandPaletteOpen(false)
        setMode(preset.mode)
        mergeDraft(preset.prompt)
        void triggerHaptic("selection")
      },
    }))

    const stashItems = stashEntries.slice(0, 8).map<CommandPaletteItem>((entry) => ({
      id: `stash:${entry.id}`,
      title: `Snippet ${new Date(entry.timestamp).toLocaleDateString()}`,
      description: entry.input,
      section: "Memories",
      badge: entry.partsCount ? `${entry.partsCount} parts` : "Snippet",
      keywords: ["memory", "snippet", "stash"],
      onPress: () => {
        setCommandPaletteOpen(false)
        mergeDraft(entry.input)
        void triggerHaptic("selection")
      },
    }))

    const serverItems = commands.map<CommandPaletteItem>((command) => ({
      id: `command:${command.name}`,
      title: `/${command.name}`,
      description:
        command.description ||
        (command.hints.length
          ? `Arguments: ${command.hints.join(", ")}`
          : "Insert this slash command into the composer."),
      section: command.skill ? "Skills" : command.mcp ? "MCP" : command.subtask ? "Subtasks" : "Commands",
      badge: command.skill
        ? "Skill"
        : command.mcp
          ? "MCP"
          : command.subtask
            ? "Task"
            : command.hints.length
              ? `${command.hints.length} args`
              : undefined,
      keywords: command.skill ? [...command.hints, "skill"] : command.hints,
      onPress: () => {
        setCommandPaletteOpen(false)
        insertSlashCommand(command.name)
      },
    }))

    const items = [...localItems, ...presetItems, ...stashItems, ...serverItems]
    const term = commandQuery.trim().toLowerCase()
    if (!term) return items

    return items.filter((item) => {
      const haystack = [item.title, item.description ?? "", item.section, item.badge ?? "", ...(item.keywords ?? [])]
        .join(" ")
        .toLowerCase()
      return haystack.includes(term)
    })
  }, [
    abort,
    client,
    compacting,
    compactContext,
    commandQuery,
    commands,
    detail?.info.github,
    detail?.permissions.length,
    cleaned,
    input,
    loadMemories,
    promptPresets,
    sessionBlocked,
    stashEntries,
    commandPaletteOpen,
  ])

  useEffect(() => {
    if (!sessionId) return
    void countOfflineQueueForSession(sessionId).then(setOfflineQueuedCount)
  }, [sessionId, offlineQueueRevision])

  if (loading && !detail) {
    return (
      <View className="flex-1 bg-background" style={{ paddingTop: top + 8 }}>
        <SessionDetailSkeleton />
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <View
        style={{
          paddingHorizontal: 16,
          paddingBottom: 12,
          paddingTop: top + 8,
        }}
      >
        <View className="flex-row items-center gap-3">
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={chromeButtonStyle}
          >
            <AdaptiveBlur
              tint={isDark ? "dark" : "light"}
              intensity={44}
              style={StyleSheet.absoluteFill}
              fallbackColor={chromeButtonFill}
              pointerEvents="none"
            />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: chromeButtonOverlay }]} pointerEvents="none" />
            <ArrowLeft size={18} color={palette.ink} strokeWidth={2.2} />
          </Pressable>
          <Pressable
            className="flex-1"
            onPress={() => {
              void triggerHaptic("selection")
              setInspectorOpen(true)
            }}
            accessibilityRole="button"
            accessibilityLabel="Open session inspector"
            accessibilityHint="Shows todos, MCP, LSP, context, and files"
          >
            <Text className="text-base font-semibold text-ink" numberOfLines={1}>
              {detail?.info.title || "Session"}
            </Text>
            <Text className="mt-1 text-sm text-soft" numberOfLines={1}>
              {sessionLocation}
            </Text>
          </Pressable>
          <Pressable
            onPress={openSessionExplorer}
            accessibilityRole="button"
            accessibilityLabel="Open session files"
            accessibilityHint="Opens the file explorer for this session workspace"
            style={chromeButtonStyle}
          >
            <AdaptiveBlur
              tint={isDark ? "dark" : "light"}
              intensity={44}
              style={StyleSheet.absoluteFill}
              fallbackColor={chromeButtonFill}
              pointerEvents="none"
            />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: chromeButtonOverlay }]} pointerEvents="none" />
            <FolderOpen size={18} color={palette.ink} strokeWidth={2} />
          </Pressable>
          <Pressable
            onPress={() => {
              void triggerHaptic("selection")
              actionsSheetRef.current?.present()
            }}
            accessibilityRole="button"
            accessibilityLabel="Open session actions"
            accessibilityHint="Shows rename, export, publish, and cleanup actions"
            style={chromeButtonStyle}
          >
            <AdaptiveBlur
              tint={isDark ? "dark" : "light"}
              intensity={44}
              style={StyleSheet.absoluteFill}
              fallbackColor={chromeButtonFill}
              pointerEvents="none"
            />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: chromeButtonOverlay }]} pointerEvents="none" />
            <Ellipsis size={18} color={palette.ink} strokeWidth={2.2} />
          </Pressable>
        </View>
      </View>

      {/*
        FlashList v2 enables maintainVisibleContentPosition by default; it is disabled
        here to keep the existing manual scroll-to-latest logic authoritative.
      */}
      <View style={{ flex: 1 }}>
        <SessionWallpaper />
        <FlashList
          ref={listRef}
          style={{ flex: 1 }}
          maintainVisibleContentPosition={{ disabled: true }}
          getItemType={(row) => (row.kind === "message" ? row.message.info.role : row.kind)}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onLayout={() => {
            if (detail && !initialScrollDoneRef.current) {
              initialScrollDoneRef.current = true
              scrollToLatest(false)
            }
          }}
          onContentSizeChange={() => {
            if (!detail) return
            if (!initialScrollDoneRef.current) {
              initialScrollDoneRef.current = true
              scrollToLatest(false)
              return
            }
            if (followTranscriptRef.current) {
              scrollToLatest(!sessionBlocked)
            }
          }}
          onScroll={updateTranscriptFollow}
          scrollEventThrottle={16}
          data={rows}
          extraData={listExtraData}
          keyExtractor={(row) => row.id}
          renderItem={({ item: row }) => {
            if (row.kind === "time") return <TimeDivider label={row.label} />
            if (row.kind === "system") return <ScaffoldingRow message={row.message} />
            const item = row.message
            return (
              <View style={{ width: "100%", alignSelf: "stretch" }}>
                <MessageBubble
                  message={item}
                  diffs={diffs[item.info.id]}
                  diffLoaded={Boolean(diffLoaded[item.info.id])}
                  diffLoading={Boolean(diffLoading[item.info.id])}
                  onLoadDiff={loadDiff}
                  isActive={activeMessageID === item.info.id}
                  onCopy={copyMessage}
                  onFork={reuseMessage}
                  onDismiss={dismissActiveMessage}
                  onActivate={activateMessage}
                  onOpenArtifact={openArtifact}
                  queued={item.info.role === "user" && pendingAssistantId ? item.info.id > pendingAssistantId : false}
                />
              </View>
            )
          }}
          ListHeaderComponent={
            <>
              <SessionSummaryCard
                detail={detail}
                sessionBlocked={sessionBlocked}
                cleaned={cleaned}
                cleaning={cleaning}
                onPublish={openPublishModal}
                onAbort={() => void abort()}
                onCleanup={() => void cleanup()}
                onOpenGit={() => setGitReviewOpen(true)}
              />
              <SessionPreviewStrip previews={previews} project={sessionProjectPanel} onSelectPreview={openArtifact} />
              {detail?.permissions.length ? (
                <View className="mb-2">
                  {detail.permissions.map((item) => (
                    <PermissionCard
                      key={item.id}
                      item={item}
                      onRespond={(response) => void respond(item.id, response)}
                    />
                  ))}
                </View>
              ) : null}
            </>
          }
          ListEmptyComponent={
            <EmptyState
              title="No messages yet"
              description="Tell the agent what to do — it will work in this session and report back here."
              action={
                <View style={{ gap: 8 }}>
                  {STARTER_PROMPTS.map((prompt) => (
                    <Pressable
                      key={prompt}
                      accessibilityRole="button"
                      onPress={() => {
                        void triggerHaptic("selection")
                        setInput(prompt)
                      }}
                      style={({ pressed }) => ({
                        alignSelf: "stretch",
                        opacity: pressed ? 0.85 : 1,
                        transform: [{ scale: pressed ? 0.97 : 1 }],
                      })}
                    >
                      <View
                        style={{
                          minHeight: 44,
                          borderRadius: 999,
                          borderCurve: "continuous",
                          borderWidth: 1,
                          borderColor: hexToRgba(palette.ink, 0.12),
                          paddingHorizontal: 16,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text
                          numberOfLines={1}
                          style={{
                            color: palette.ink,
                            ...typeStyle(14, { weight: "500" }),
                          }}
                        >
                          {prompt}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              }
            />
          }
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 16,
          }}
        />

        <JumpToLatestPill visible={!isFollowing && messages.length > 0} count={unseenCount} onPress={scrollToBottom} />
      </View>

      {detail?.info.github ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <GitStatusBar
            gitState={gitState}
            loading={gitLoading}
            onPress={() => setGitReviewOpen(true)}
            onRefresh={() => void loadGitState()}
          />
        </View>
      ) : null}

      <View style={{ paddingHorizontal: 16 }}>
        <SessionStatusLine
          working={sessionBlocked}
          label="Thinking"
          runningCount={runningBackgroundTasks.length}
          onOpenActivity={() => setActivityOpen(true)}
        />
      </View>

      <ComposerApprovalBar
        approvals={[...(detail?.permissions ?? []), ...(detail?.questions ?? [])]}
        onPermissionRespond={(id, response) => void respond(id, response)}
        onQuestionAnswer={(requestID, answers) => {
          if (!client || !sessionId) return
          void client.respondToQuestion(sessionId, requestID, answers)
          void triggerHaptic("success")
        }}
        onQuestionReject={(requestID) => {
          if (!client || !sessionId) return
          void client.rejectQuestion(sessionId, requestID)
          void triggerHaptic("error")
        }}
      />

      <SessionComposer
        mode={mode}
        setMode={setMode}
        input={input}
        setInput={setInput}
        slashSuggestions={slashSuggestions}
        slashLoading={commandsLoading}
        sending={sending || compacting}
        sessionProcessing={sessionBlocked}
        queuedMessageCount={queuedMessageCount}
        offlineQueuedMessageCount={offlineQueuedCount}
        sessionBlocked={sessionBlocked}
        cleaned={cleaned}
        onOpenCommands={() => setCommandPaletteOpen(true)}
        onSelectSlash={insertSlashCommand}
        onSend={() => void send()}
        onOpenGit={() => setGitReviewOpen(true)}
        onStop={() => void abort()}
        pendingAttachments={pendingAttachments}
        onAttach={() => setAttachmentPickerOpen(true)}
        onAddAttachment={handleAddAttachment}
        onRemoveAttachment={handleRemoveAttachment}
        modelLabel={modelLabel}
        activeMcpCount={activeMcpCount}
        activeModelKey={activeModelKey}
        activeVariant={activeVariant}
        availableModels={availableModels}
        mcpServers={mcpServers}
        skills={drawerSkills}
        tools={drawerTools}
        onModelSelect={handleModelSelect}
        onOpenModelPicker={openModelPicker}
        onSkillSelect={insertSlashCommand}
        onMcpToggle={handleMcpToggle}
        permissionModeLabel={permissionModeTitle(permissionMode)}
        onOpenPermissions={() => {
          permissionSheetRef.current?.present()
        }}
        error={error}
        onDismissError={() => setError(null)}
      />

      <PermissionModeSheet
        sheetRef={permissionSheetRef}
        mode={permissionMode}
        saving={permissionSaving}
        onSelect={(preset) => void applyPermissionPreset(preset)}
        onOpenDetailed={() => router.push("/more/settings/permissions" as Parameters<typeof router.push>[0])}
      />

      <ModelPickerSheet
        sheetRef={modelPickerRef}
        models={availableModels}
        activeModelKey={activeModelKey}
        activeVariant={activeVariant}
        onSelect={handleModelSelect}
      />

      <AttachmentPickerSheet
        visible={attachmentPickerOpen}
        onClose={() => setAttachmentPickerOpen(false)}
        onFile={handlePickedAttachment}
      />

      <CommandPaletteSheet
        visible={commandPaletteOpen}
        loading={commandsLoading}
        query={commandQuery}
        onQueryChange={setCommandQuery}
        onClose={() => setCommandPaletteOpen(false)}
        items={paletteItems}
      />

      <PublishSheet
        visible={publishOpen}
        detail={detail}
        publishTitle={publishTitle}
        setPublishTitle={setPublishTitle}
        publishBody={publishBody}
        setPublishBody={setPublishBody}
        commitMessage={commitMessage}
        setCommitMessage={setCommitMessage}
        publishing={publishing}
        sessionBlocked={sessionBlocked}
        cleaned={cleaned}
        onClose={() => setPublishOpen(false)}
        onPublish={() => void publish()}
      />

      <BackgroundActivitySheet
        visible={activityOpen}
        tasks={backgroundTasks}
        onClose={() => setActivityOpen(false)}
        onStop={(task: BackgroundTask) => {
          // Each sub-agent owns a session, so a run is stopped precisely rather
          // than by aborting the turn that spawned it.
          if (!client || !task.childSessionID) return
          void client.abortSession(task.childSessionID).catch((abortError: unknown) => {
            setError(abortError instanceof Error ? abortError.message : String(abortError))
          })
        }}
        onOpenTranscript={(task: BackgroundTask) => {
          if (task.childSessionID) router.push(`/sessions/${task.childSessionID}`)
        }}
      />

      <SessionInspectorSheet
        visible={inspectorOpen}
        sessionID={sessionId ?? ""}
        detail={detail}
        gitState={gitState}
        onClose={() => setInspectorOpen(false)}
      />

      <SessionActionsSheet
        sheetRef={actionsSheetRef}
        title={detail?.info.title ?? ""}
        onInspect={() => {
          actionsSheetRef.current?.dismiss(() => setInspectorOpen(true))
        }}
        onOpenActivity={() => {
          actionsSheetRef.current?.dismiss(() => setActivityOpen(true))
        }}
        activityCount={backgroundTasks.length}
        onRename={() => {
          actionsSheetRef.current?.dismiss(() => setRenameOpen(true))
        }}
        onExportMarkdown={() => {
          actionsSheetRef.current?.dismiss()
          void handleExport("markdown")
        }}
        onExportJSON={() => {
          actionsSheetRef.current?.dismiss()
          void handleExport("json")
        }}
        onCopyID={() => {
          actionsSheetRef.current?.dismiss()
          if (sessionId) void Clipboard.setStringAsync(sessionId)
          void triggerHaptic("selection")
        }}
        onCompact={() => {
          actionsSheetRef.current?.dismiss(() => void compactContext())
        }}
        compacting={compacting}
        compactDisabled={sessionBlocked || cleaned}
        onTeleport={() => {
          actionsSheetRef.current?.dismiss(() => setTeleportOpen(true))
        }}
        onOpenPreview={() => {
          previewSheetRef.current?.present()
          void triggerHaptic("selection")
        }}
        previewCount={previews.length}
        onOpenTerminal={() => {
          actionsSheetRef.current?.dismiss()
          const cwd = detail ? sessionWorkspaceDirectory(detail.info) : undefined
          setTerminalLaunchIntent({
            cwd: cwd ?? undefined,
            title: detail?.info.title ? `${detail.info.title} shell` : undefined,
            sessionId,
          })
          router.push("/terminal" as Parameters<typeof router.push>[0])
        }}
      />

      <SessionPreviewSheet
        ref={previewSheetRef}
        title={detail?.info.title ?? "Session"}
        previews={previews}
        project={sessionProjectPanel}
        onSelectPreview={openArtifact}
      />

      <ArtifactViewerSheet ref={artifactViewerRef} preview={selectedArtifact} />

      <SessionRenameSheet
        visible={renameOpen}
        currentTitle={detail?.info.title ?? ""}
        saving={renaming}
        onClose={() => setRenameOpen(false)}
        onSave={(title) => void handleRename(title)}
      />

      <SessionTeleportSheet
        visible={teleportOpen}
        busy={teleporting}
        onClose={() => setTeleportOpen(false)}
        onTeleport={(target) => void handleTeleport(target)}
      />

      <GitReviewModal
        visible={gitReviewOpen}
        onClose={() => setGitReviewOpen(false)}
        sessionID={sessionId ?? ""}
        directory={sessionGitDir}
        github={
          detail?.info.github
            ? {
                owner: detail.info.github.owner,
                repo: detail.info.github.repo,
                baseBranch: detail.info.github.baseBranch,
                headBranch: detail.info.github.headBranch,
                pullRequest: detail.info.github.pullRequest,
              }
            : undefined
        }
        onCommit={async (message, files, options) => {
          if (!client) return
          const gitClient = sessionGitDir ? client.withDirectory(sessionGitDir) : client
          await gitClient.createGitCommit(message, files, options)
        }}
        onPublish={openPublishModal}
      />
    </KeyboardAvoidingView>
  )
}
