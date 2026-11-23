import { onMount, onCleanup, on, createSignal, createEffect, createMemo, createResource, Show, For } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import { getHost, stripAnsi, type SpawnedSession } from "../host/shell"
import {
  EXISTS_MS,
  LIST_MS,
  MINT_MS,
  MINT_SLOW_LEFT_S,
  MINT_SLOW_MS,
  mintTrace,
  waitForAnswer,
} from "../session-new/ask-cli"
import { every, pageHidden, watchDue } from "../host/every"
import {
  mustConfirmLeaving,
  shouldConfirmWindowClose,
  closeConfirmationMessage,
  countWorkingSessions,
  isWorkingAgentPane,
} from "./before-unload"
import { hideButtons, hideChoice, markTrayNoticed, planHide, trayNoticed } from "./tray-hide"
import { NIKCLI_VERSION_EVERY_MS, parseNikcliVersion } from "../host/nikcli-version"
import { isRemoteRoot, remoteRoot, sshArgs, sshAsking, type RemoteTarget } from "../remote/ssh"
import { RemoteSpaceDialog } from "../remote/remote-dialog"
import { discoverProject, grantedRoots, openProject, rootMissing, type Project } from "../host/project"
import {
  addRecent,
  isMissingRecent,
  missingRecents,
  parseRecents,
  removeRecent,
  serializeRecents,
  withMissing,
  withoutMissing,
  type RecentEntry,
} from "../host/recent"
import { pathEquals } from "../host/path"
import { belongsTo, goneFolder, paneProject } from "./pane-project"
import { writeWorkbench } from "./workbench-write"
import { onePickAtATime } from "../record/folder-pick"
import { syncOpenRouterKey } from "../host/openrouter-key-sync"
import { serializeWorkspace, parseWorkspace, type WorkspaceState } from "../session/persist"
import { DEFAULT_BINDINGS, FROM_TERMINALS, NOT_FROM_TEXT_FIELDS, resolveDefaultBindings } from "../keyboard/bindings"
import { formatChord, parseChord } from "../keyboard/keymap"
import { CommandPalette } from "../command/palette"
import { paletteStep } from "../command/palette-keys"
import { SessionNew } from "../session-new/session-new"
import { AGENTS, agentById, agentLabel } from "../session-new/agents"
import { oneAtATime } from "./one-at-a-time"
import { RunningSessions } from "./running"
import { restartOf, startArgsFor } from "./start-args"
import { KeyRequestDialog, KeysSection, type KeysHost } from "../secrets/keys-section"
import { KEYS_VERBS, runKeysCommand, type KeyAsker } from "../secrets/keys"
import {
  DEFAULT_MAX_DEPTH,
  checkName,
  depthOf,
  descendants,
  excludeWithAde,
  modelArgs,
  nameTaken,
  withoutModel,
  resultsDir,
  slugify,
  worktreeArgs,
  worktreePlan,
  effortArgs,
  modelIn,
  withoutEffort,
  dispatchChoice,
  isBaseRef,
  worktreeAddArgs,
} from "../session/orchestra"
import { detectAgents } from "../session-new/availability"
import {
  RESUME,
  lastTakenFor,
  planFork,
  planLastHere,
  planMint,
  startingState,
  mintMark,
  MintLedger,
  lastHereBesideMints,
  planRestore,
  restoreClaims,
  claimedByRestore,
  openedConversation,
  LIST_COLS,
  planResume,
  planStart,
  lostConversation,
  resumePromise,
  type ResumePlan,
} from "../session-new/resume"
import {
  countingLines,
  followReports,
  followedFolder,
  lastReportedId,
  newNonce,
  otherFolder,
  parseReport,
} from "../session-new/agent-link"
import { sameFolder } from "../session-new/folder"
import {
  HOOK_TARGETS,
  HOOK_TIMEOUT,
  hookTarget,
  reportsTurns,
  takesActivityExtension,
  reportFamily,
  readHookStatus,
  refreshHookScript,
  type HookHost,
  type HookStatus,
} from "../session-new/agent-hooks"
import { AgentHooksSection } from "../session-new/agent-hooks-panel"
import {
  BotSection,
  GridSection,
  LanguageSection,
  ProviderSection,
  RoutineSection,
  SkillsSection,
  ThemeSection,
} from "../settings/sections"
import { applyNativeGlass, checkNativeGlassStatus, type GlassStatus } from "./glass-window"
import { locale, refreshSystemLocale, syncDocumentLanguage, t, translate } from "../i18n"
import {
  formatMb,
  parseUpdateProgress,
  progressPercent,
  UPDATE_PROGRESS_EVENT,
  type UpdateProgress,
} from "../update/progress"
import { exitedActivity } from "../grid/activity"
import { ExtensionsPage } from "../extensions/extensions-page"
import type { McpConfigIO } from "../extensions/mcp-config"
import { willLaunch, type LaunchEntry } from "../session-new/launch"
import type { PresetId } from "../session-new/preset"
import { defaultPaneTitle } from "./pane-title"
import { Sidebar } from "../sidebar"
import { SessionGrid } from "../grid/session-grid"
import { requestRename } from "../grid/rename"
import { EmptyProject } from "./empty-project"
import { ProjectBar } from "./project-bar"
import { SidebarToggle, readSidebarHidden, writeSidebarHidden } from "./sidebar-toggle"
import { BarQueueButton } from "./bar-queue-button"
import { queueShown } from "./bar-queue"
import { NikChromeLogo } from "./nik-chrome-logo"
const isTauriDesktop = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)

/**
 * On macOS the window keeps its native traffic lights, drawn over the bar
 * (`TitleBarStyle::Overlay` in lib.rs), so the bar draws no controls of its
 * own and leaves room for the lights on the left.
 */
const isMacOS = () => typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent ?? "")

async function adeWindowMinimize() {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_window_minimize")
  } catch {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().minimize()
    } catch (e) {
      console.error("Failed to minimize window:", e)
    }
  }
}

async function adeWindowToggleMaximize() {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_window_toggle_maximize")
  } catch {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().toggleMaximize()
    } catch (e) {
      console.error("Failed to toggle maximize window:", e)
    }
  }
}

async function adeWindowClose() {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_window_close")
  } catch {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().close()
    } catch (e) {
      console.error("Failed to close window:", e)
    }
  }
}

function askCloseConfirmation(message: string): Promise<boolean> {
  return askYesNo(message, { ok: t("window.closeConfirm.ok"), cancel: t("window.closeConfirm.cancel") })
}

import { askYesNo } from "../host/ask"
import { createCloser } from "../editor/closer"
import {
  createWorkbench,
  type Pane,
  addPane,
  closePane,
  updatePane,
  withPaneNotice,
  isPanelPane,
  expandPane,
  setColumns,
  reorderPanes,
  resizePane,
  deriveWorkspaces,
  toWorkspaceState,
  fromWorkspaceState,
  exitedToReopen,
  sessionsToResume,
  nextView,
  ADE_VIEW_LABELS,
  VISIBLE_VIEWS,
  isViewVisible,
  type Workbench as WorkbenchState,
} from "./state"
import { AgentConsole } from "../agent/agent-console"
import {
  clearNaturalVoiceFailure,
  naturalVoiceFailureFor,
  transcriptionReady,
  type NaturalVoiceFailure,
} from "../agent/onboarding"
import { Chat } from "../chat/chat"
import { appChatStore } from "../chat/store"
import { barSessionCount } from "./bar-sessions"
import { BotsMain, BotsRoster } from "../bots/bots"
import { scrubSecrets } from "../bots/terms"
import type { AgentFile } from "../bots/nikcli"
import type { Runner } from "../bots/runners"
import { senderToken } from "../session/senders"
import { createActivityReads, type ActivityReads } from "../session/activity-reads"
import { boardCandidates, parseOwners, whoOwns } from "../session/owners"
import { mayReroute, pickProvider, setProviderPicker } from "../session/provider-pick"
import { pickByQuota } from "../session/quota-pick"
import { freshSharedQuota } from "../session/quota-store"
import { botLaunch } from "../bots/store"
import { buildCommands, guardedBySheet, keepsPaletteOpen, parseDesignVariantCommand } from "./commands"
import { createRecorder, eventsPathFor, micPathFor, voicePathFor, type StartOptions } from "../record/recorder"
import { startMicTake } from "../record/mic"
import { exportPromo } from "../record/export"
import { RECORD_VERBS, runRecordRequest, type RecordConsent } from "../record/record-panel"
import { RecordConsentDialog } from "../record/consent-dialog"
import { UpdateDialog } from "../update/update-dialog"
import { BRAND } from "../brand"
import { coverSecrets } from "../record/sensitive"
import {
  DEFAULT_QUALITY,
  qualityLevel,
  QUALITY_LEVELS,
  sizePerMinute,
  type RecordQuality,
  type RecordState,
} from "../record/recording"
import { createAdePluginRuntime } from "../plugin/runtime"
import { createManagerPlugin } from "../plugin/built-in/manager"
import { createModsPlugin } from "../plugin/built-in/mods"
import { FILE_PLUGINS_DISABLED, importPluginModule } from "../plugin/loader"
import { PluginSection } from "../plugin/pane"
import { parseCommandId } from "../plugin/trust"
import { CONSENT_KEY, consentQuestion, hasConsent, withConsent } from "../plugin/consent"
import { toPluginSession } from "../plugin/session"
import type { DiscoveryIO } from "../plugin/discovery"
import { markSaved, openBuffer, saveBlockedReason } from "../editor"
import { detectPermission, followPermission, type PermissionAnswer } from "../session/permission"
import { readReportLine } from "../session/report"
import { asOneLine, asSubmittedLine, confirmDeadline, pasteSettled, submitCheck } from "../session/typing"
import { searchPaths, walkProject } from "../search"
import {
  DEFAULT_MAX_SPAWNED,
  USAGE,
  agentsTable,
  briefOf,
  byProject,
  formatCancel,
  formatNudge,
  updatesAnsweredBy,
  formatElapsed,
  formatTimeNote,
  timeNoteFor,
  lineIsTaken,
  formatUpdate,
  activityOrFormer,
  keptActivity,
  parseOpenRequests,
  shouldRering,
  type Activity,
  requestState,
  relaunchRefusal,
  requestsTable,
  shouldNudge,
  type OpenRequest,
  formatDelivery,
  holdsForAnswer,
  quietOutcome,
  hookClosesScreenPrompt,
  interruptEnds,
  afterInterrupt,
  isFree,
  isQuestionOpen,
  activityOccupiesPane,
  statusFromActivity,
  sameDir,
  formatLateReply,
  formatLost,
  noticeTarget,
  registerAuthor,
  formatRequest,
  parseMessage,
  resolveAgent,
  resolveTarget,
  sessionsTable,
  verifySender,
  unverifiedSenderRefusal,
  voiceConfirmationFor,
  type MailPane,
  type Message,
  formatBell,
  formatHeld,
  formatHeldReceipt,
  HELD_BY_LINE,
  formatUnread,
  formatWedged,
  interruptKeys,
  shellRefusal,
  typesMailInto,
  WEDGE_MS,
  openDecisions,
  type OpenDecision,
  goesToInbox,
  inboxAction,
  inboxName,
  parseInbox,
  type InboxEntry,
} from "../session/mailbox"
import { outputRun, outputSaysWorking, stampingInput, type OutputRun } from "../session/output-activity"
import { createLineQueue } from "../session/line-queue"
import {
  deliveryResult,
  enterAgain,
  lineGiven,
  ringAgain,
  typeThenEnter,
  type DeliveryResult,
  type LineOutcome,
} from "../session/enter"
import { isTyping, submittedSince, typedAfter } from "../session/typed-line"
import {
  canSuspend,
  stopForSuspend,
  offersSuspend,
  parseSuspendedMail,
  suspendedDelivery,
  suspendedMailToSave,
  keptWithoutProcess,
  SUSPEND_REASON,
  type SuspendCheck,
  type SuspendContext,
} from "../session/suspend"
import {
  formatFallbackLine,
  formatHandoff,
  handoffOutcome,
  parseHandoffs,
  parseNativeSessions,
  routeFor,
  type Handoff,
  type NativeSession,
} from "../session/native-mail"

/** Who a message is from and what it is, for the inbox when it is too long to type. */
type InboxMeta = { id: string; kind: InboxEntry["kind"]; from: string }
import {
  applyKv,
  emptySpace,
  memoryAddReply,
  memoryEntry,
  parseKvStore,
  statsTable,
  withMemoryEntry,
  type TokenUsage,
} from "../session/shared"
import { displayArgs, withIntro } from "../session-new/intro"
import { createThemeState } from "./theme-state"
import { createPaneRecords } from "./pane-records"
import { createAutosave } from "./autosave"
import { closeAfterSaving } from "./close-window"
import { createInFlight } from "../session/in-flight"
import { bindMenu } from "../ui/menu"
import { createPaneRenderer } from "./pane-renderer"
import { Splash } from "../splash/splash"
import { splashRemainingMs } from "../splash/timing"
import { createPanelRouter, createPendingPanelReplies, dictationHold, panelReplyHold } from "../panels/router"
import { acceptsRequests, panelsHelp } from "../panels/protocol"
import { alternateRows, createScreenRequests } from "../panels/screen-requests"
import { BROWSER_VERBS, runBrowserCommand, type BrowserController } from "../browser/binding"
import {
  formatRequestDetails,
  formatRequestLine,
  requestStem,
  type BrowserRequest,
  type Rect,
} from "../browser/request"
import { devServerUrl, offerKey, shouldOffer, type DevServerOffer } from "../browser/dev-server"
import { DevServerOffers } from "../browser/dev-server-offer"
import { VIDEO_VERBS } from "../video/video"
import { MODEL_VERBS } from "../model3d/model"
import { SIMULATOR_VERBS } from "../simulator/simulator"
import { PLAYABLE_EXTENSIONS } from "../video/video"
import { playWav } from "../voice/wav-player"
import { MODEL_EXTENSIONS } from "../model3d/model"
import {
  createOutsideConfirmationTracker,
  markdownLinkRefusal,
  openPathLink,
  paneShowing,
  readsText,
  routeForFile,
  viewKind,
} from "./open-route"
import { guessDevServers } from "../simulator/simulator"
import { DecisionsSheet } from "../decisions/decisions-sheet"
import { ChoicesSheet } from "../choices/choices-sheet"
import { choiceCounts, choiceItems, distinctNames, type ChoiceItem } from "../choices/list"
import { createToast } from "./toast"
import { createSettled } from "./settled"
import {
  deliveryLine,
  deliveryState,
  answerItem,
  enqueue,
  markDelivered,
  OUTBOX_KEY,
  parseOutbox,
  pendingFor,
  chooseRecipient,
  parseRecipients,
  RECIPIENT_KEY,
  resolveRecipient,
  type RecipientChoice,
  pruneOutbox,
  reopenLine,
  resolveDeliveryTarget,
  type OutboxItem,
} from "../decisions/delivery"
import { createDecisionsHub } from "../decisions/hub"
import { createDecisionsRegister } from "../decisions/register"
import { askerLedger } from "../session/asker-ledger"
import { decisionsPath } from "../decisions/store"
import { formatMoment as formatDesignMoment } from "../design/answer"
import { DesignSheet } from "../design/design-sheet"
import { Sheet } from "../ui/sheet"
import {
  OUTBOX_KEY as DESIGN_OUTBOX_KEY,
  RECIPIENT_KEY as DESIGN_RECIPIENT_KEY,
  chooseRecipient as chooseDesignRecipient,
  deliveryLine as designDeliveryLine,
  deliveryState as designDeliveryState,
  answerItem as designAnswerItem,
  enqueue as enqueueDesign,
  markDelivered as markDesignDelivered,
  parseOutbox as parseDesignOutbox,
  parseRecipients as parseDesignRecipients,
  pendingFor as pendingForDesign,
  pruneOutbox as pruneDesignOutbox,
  reopenLine as designReopenLine,
  resolveDeliveryTarget as resolveDesignDeliveryTarget,
  resolveRecipient as resolveDesignRecipient,
} from "../design/delivery"
import { createDesignHub } from "../design/hub"
import { createDesignRegister } from "../design/register"
import { watchRegisters } from "../host/register-watch"
import { designPath } from "../design/store"
import type { DesignProposal } from "../design/state"
import { mediaUrl } from "../video/video"
import { createSheetWatch, sheetLabel, sheetPaneFor, sheetTitle, sheetUrl, type PaneSheet } from "../design/sheet"
import { formatNotesFile, formatNotesLine, notesFilePath, notesFileRelative } from "../design/notes"
import { registerWrite, withPlace } from "../session/register-write"
import {
  AgentOrb,
  createMicMeter,
  createPlaybackMeter,
  createVoiceEngine,
  createWebSpeechSpeaker,
  createFakeSpeaker,
  createNaturalSpeaker,
  activeReplyVoice,
  speakingReplyVoice,
  isKokoroVoice,
  type ReplyVoice,
  interfaceLocale,
  replyLocale,
  g2pLocale,
  isOpenRouterKeyRemoved,
  dropLegacyParakeet,
  loadVoiceSettings,
  saveVoiceSettings,
  summarizeVoiceShortcutConflicts,
  NikCube,
  VoiceHud,
  VoiceOrb,
  ListeningIndicator,
  VoiceSettingsPanel,
  wakeWordEnabled,
  shortcutActivationEnabled,
  describeShortcut,
  holdsToTalk,
  type VoiceEngine,
  type VoiceMode,
  type VoiceSettings,
  type InstallProgress,
  type PackState,
  kokoroVoice,
  KOKORO_DOWNLOAD_BYTES,
} from "@nikcli-ai/voice"
import { createPackController, followInstall, installCancelled } from "./voice-pack-controller"
import { ShotTray, createShotSource } from "../shots"
import {
  copyToClipboard,
  disposeTerminal,
  getTerminal,
  hasTerminal,
  ptySize,
  refreshTerminalThemes,
  startOnCleanScreen,
  writeToTerminal,
} from "../terminal/registry"
import type { LinkRequest } from "../terminal/links"
import { decideOpening } from "../session/opening"
import { cleanTranscriptLine } from "../session/transcript-line"
import { createRawWindows } from "../session/raw-window"
import { NEW_PANE_ITEMS, showsNewPane, type NewPaneItem } from "./new-pane"
import {
  addNotice,
  bellTone,
  dismissNotice,
  markAllRead,
  unreadCount,
  type Notice,
  type NoticeKind,
} from "./notifications"
import { checkMessage, createUpdateWatch, type UpdateMemory, type UpdateWatch } from "../update/watch"
import { isReleasePage, type AvailableUpdate } from "../update/release"
import { createAdeVoiceHost } from "../voice/host"
import { createPushToTalkHandler, resolveVoiceOrAdeKey } from "../voice/shortcuts"
import {
  GLOBAL_VOICE_EVENT,
  globalVoiceAction,
  refusalsOf,
  registerVoiceShortcuts,
  serialiseRegistrations,
  unknownChordMessage,
} from "../voice/global-shortcut"
import { createListenGuard, pollListenGuard } from "../voice/listen-guard"
import { createProactiveAlerts } from "../voice/proactive-alerts"

const DEFAULT_PREVIEW_URL = "http://localhost:3000"

/** Every command `runCommand` below actually implements. */
const HANDLED_COMMANDS = new Set([
  "palette.open",
  "session.new",
  "project.open",
  "pane.close",
  "pane.expand",
  "pane.rename",
  "view.toggle",
  "theme.toggle",
  "sidebar.toggle",
  "browser.new",
  "process.kill",
  "voice.toggle",
  "voice.settings",
  "panes.closeGone",
  "recents.forgetGone",
])

function isHandledCommand(id: string): boolean {
  return HANDLED_COMMANDS.has(id) || id.startsWith("project.recent.") || parseDesignVariantCommand(id) !== undefined
}

/**
 * Makes every pane id different from every other, whatever the clock says.
 *
 * Ids were `n${Date.now()}-${index}`, unique within one launch because the
 * form numbers its slots, and not unique across launches: two sessions started
 * in the same millisecond with the same slot number — four spoken sessions, or
 * one started just after a close freed an index — produced the same string
 * twice. Nothing checks for it. `addPane` appends, `closePane` would then drop
 * both, `updatePane` would write to both, and the terminal registry would hand
 * them a single xterm. A counter makes the case impossible.
 */
let paneSequence = 0

/** A new pane id for panes that are not sessions: browser, video, design, diff, file (review area 2). */
const newPaneId = (prefix: string) => `${prefix}${Date.now()}-${++paneSequence}`

/**
 * How much of a session's output a pane keeps in memory.
 *
 * The scrollback the user can actually reach; what goes to disk is bounded
 * separately by `transcript-budget`.
 */
const MAX_PANE_LINES = 200

export function Workbench() {
  const platform = navigator.userAgent.includes("Mac") ? "mac" : "other"
  const bindings = resolveDefaultBindings(platform)

  // The sidebar, shown or hidden from the top bar, the palette or Ctrl+Shift+B (`sidebar-toggle.tsx`).
  const sidebarStorage = (() => {
    try {
      return window.localStorage
    } catch {
      return undefined
    }
  })()
  const [sidebarHidden, setSidebarHidden] = createSignal(readSidebarHidden(sidebarStorage))
  const toggleSidebar = () => {
    const hidden = !sidebarHidden()
    setSidebarHidden(hidden)
    writeSidebarHidden(sidebarStorage, hidden)
  }

  /*
   * The workbench is a store, and `wb()` hands back the store itself.
   *
   * It was one signal holding every pane and every transcript, so a single
   * line of output from one agent replaced the whole object and woke every
   * consumer of `wb()` — the sidebar's project list, the tab strip's session
   * count, the autosave, the grid — several times a second, with four agents
   * running. A store notifies per property: pushing a line onto one pane's
   * transcript reaches the component drawing that transcript and nobody else.
   *
   * The accessor shape stays `wb()` so the reads below are unchanged, and it
   * still works: what tracks is the property read on the proxy it returns,
   * not the call. The one thing that no longer tracks is reading `wb()` and
   * nothing else, which the autosave used to do — see `revision`.
   */
  const [wbStore, setWbStore] = createStore<WorkbenchState>(createWorkbench())
  const wb = () => wbStore

  /**
   * Bumped by every write to the workbench.
   *
   * The autosave has to run on any change at all, and with a store there is no
   * single thing to read that means "anything moved". `equals: false` makes
   * every bump a notification even when the number repeats.
   */
  const [revision, setRevision] = createSignal(0, { equals: false })

  /** Applies a whole new workbench, keeping the parts that did not change: see `workbench-write.ts`. */
  const setWb = (next: WorkbenchState | ((current: WorkbenchState) => WorkbenchState)) => {
    writeWorkbench(wbStore, setWbStore, next)
    setRevision((n) => n + 1)
  }
  /*
   * Which panes have a terminal worth drawing.
   *
   * Not derived from `running`: a session that has exited still has scrollback
   * the user is reading, and a pane restored from a previous run has none at
   * all. Membership starts at the first byte and ends when the pane closes.
   */
  const [liveTerminals, setLiveTerminals] = createSignal<Set<string>>(new Set())
  /*
   * Started before the host is known to exist, because the check is the same
   * one the host module already makes and asking twice would only mean the
   * tray misses the screenshots taken while it waited for an answer.
   */
  const shotSource = createShotSource(
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>),
  )
  const [project, setProject] = createSignal<Project>()
  // The Chat's conversations are sessions of the project too (bar-sessions.ts).
  const chatStore = appChatStore()
  /** Who a new pane belongs to: the open project, by name and by folder (see `pane-project.ts`). */
  const here = () => {
    const open = project()
    return { workspaceId: open?.name ?? "workspace", ...(open?.root ? { projectRoot: open.root } : {}) }
  }
  /** The installed nikcli, read from the binary; undefined until asked, and
      after an answer that says nothing. */
  const [nikcliVersion, setNikcliVersion] = createSignal<string>()
  const [recents, setRecents] = createSignal<RecentEntry[]>([])
  /* The recent projects whose folder is gone, marked in the sidebar and the palette; never removed on their own. */
  const [missingRoots, setMissingRoots] = createSignal<ReadonlySet<string>>(new Set())

  /**
   * What the startup screen is saying, or nothing once it is done.
   *
   * A string rather than a flag: the splash is up for as long as ADE is
   * genuinely still finding things, and telling the user *which* thing is
   * the difference between a wait and a hang.
   */
  const [booting, setBooting] = createSignal<string | undefined>(t("boot.host"))
  let skipSplashResolver: (() => void) | undefined
  const dismissSplash = () => {
    if (skipSplashResolver) {
      skipSplashResolver()
      skipSplashResolver = undefined
    }
    setBooting(undefined)
  }

  /**
   * The sidebar's project list, rebuilt only when it would differ.
   *
   * A memo rather than a call in the JSX: it reads a handful of fields per
   * pane — id, title, status, workspaceId, activity — and with those tracked
   * one at a time, a pane printing output does not rebuild the list, and the
   * sidebar is not handed a new array to diff for every line.
   */
  const workspaces = createMemo(() => {
    const currentProject = project()
    const gone = missingRoots()
    const list: Array<{ root: string; name: string; branch?: string; missing?: boolean }> = recents().map((r) => ({
      root: r.root,
      name: r.name,
      missing: isMissingRecent(gone, r.root),
      branch: r.root === currentProject?.root || r.name === currentProject?.name ? currentProject?.branch : undefined,
    }))
    if (currentProject && !list.some((p) => p.name === currentProject.name || p.root === currentProject.root)) {
      list.unshift({
        root: currentProject.root,
        name: currentProject.name,
        branch: currentProject.branch,
      })
    }
    return deriveWorkspaces(wb().panes, list)
  })
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [hasHost, setHasHost] = createSignal(false)
  const [selectedFile, setSelectedFile] = createSignal<string | undefined>()
  // The launch screen is a state, not an empty grid: it has to be reachable with
  // six sessions already running, which is exactly when a seventh is wanted.
  const [starting, setStarting] = createSignal(false)
  const [remoteOpen, setRemoteOpen] = createSignal(false)
  const themeState = createThemeState()
  const theme = themeState.theme
  const [glassStatus, setGlassStatus] = createSignal<GlassStatus>()
  onMount(() => void checkNativeGlassStatus().then(setGlassStatus))

  /*
   * xterm is handed concrete colours, so it cannot follow the theme on its own.
   *
   * The attribute below drives the whole stylesheet, but a terminal resolved
   * its palette once and keeps it: the repaint has to be pushed. Deferred by a
   * frame because this effect runs before the new `data-theme` has been
   * committed to the DOM, and the probe reads the cascade as it stands.
   */
  createEffect(() => {
    const currentTheme = theme()
    const isGlass = currentTheme === "glass"
    void applyNativeGlass(isGlass).then((err) => {
      if (err && isGlass) {
        setGlassStatus({ supported: false, effect: "none", reason: err })
      }
    })

    const opacity = themeState.glassOpacity() / 100
    if (typeof document !== "undefined") {
      if (isGlass) {
        document.documentElement.setAttribute("data-theme", "glass")
        document.documentElement.style.setProperty("--ade-glass-opacity", String(opacity))
      } else {
        document.documentElement.removeAttribute("data-theme")
        document.documentElement.style.removeProperty("--ade-glass-opacity")
      }
      const shell = document.querySelector<HTMLElement>('[data-component="ade-shell"]')
      if (shell) {
        shell.style.setProperty("--ade-glass-opacity", String(opacity))
      }
    }

    const frame = requestAnimationFrame(() => refreshTerminalThemes())
    onCleanup(() => {
      cancelAnimationFrame(frame)
      if (typeof document !== "undefined") {
        document.documentElement.removeAttribute("data-theme")
        document.documentElement.style.removeProperty("--ade-glass-opacity")
      }
    })
  })

  /*
   * Everything keyed by pane id, in one place so it is forgotten in one place.
   * See `pane-records.ts` for why that matters.
   */
  const records = createPaneRecords()
  const { reports, buffers, bufferLoading, bufferError, permissions } = records

  /*
   * One line for things the user has to be told but must not be stopped for.
   *
   * It used to be the worktree board's status line, which is where the file
   * editor borrowed it from. With the board gone those messages had nowhere
   * left to appear, and a save that failed would have failed in silence — so
   * the notice is now the shell's own, rendered above the section.
   */
  const [notice, setNotice] = createSignal<string>()
  // Where the last answer of a sheet went, once the sheet is gone (`surface/toast.ts`).
  const toast = createToast()

  /*
   * The same messages, kept.
   *
   * The strip above is transient by design — it is for the thing that just
   * happened — and everything it showed was lost the moment the next one
   * arrived or the user dismissed it. The bell is where they accumulate, so
   * a save that failed while the user was reading another session is still
   * findable afterwards.
   */
  const [notices, setNotices] = createSignal<Notice[]>([])
  const [noticesOpen, setNoticesOpen] = createSignal(false)
  const [newPaneOpen, setNewPaneOpen] = createSignal(false)
  // The buttons the two menus give the focus back to on Esc (`bindMenu`).
  let newPaneButton: HTMLButtonElement | undefined
  let noticesButton: HTMLButtonElement | undefined

  /** Says it once, in both places: the strip now, the bell afterwards. */
  const report = (text: string, kind: NoticeKind = "error", paneId?: string) => {
    setNotice(text)
    setNotices((list) => addNotice(list, { kind, text, at: Date.now(), ...(paneId ? { paneId } : {}) }))
  }
  /* A button on the strip, for the one notice it was made for: shown only while that text is. */
  const [noticeAction, setNoticeAction] = createSignal<{ text: string; label: string; run: () => void }>()

  /*
   * What the agents actually wrote, for the detectors that search it.
   * See `session/raw-window.ts`: the transcript is the cleaned copy and is
   * the wrong thing to run a regex over.
   */
  const rawWindows = createRawWindows()

  /*
   * Where an agent's `@ade …` line ends up. See `panels/router.ts`.
   *
   * The registry is here and not inside a pane because the agent asking is
   * not in the pane being asked: a session types the request on its own
   * stdout, and the panel that answers is a different tile in the grid.
   */
  const panels = createPanelRouter()

  /**
   * Notes in one session's transcript which panels it can drive.
   *
   * Never typed into the pty. Each line typed there is a prompt submitted to
   * the agent: opening one 3D panel queued six in Claude Code, and agy
   * redrew the usage lines where `onLine` read them back as requests, which
   * answered with an error, which agy redrew, with no end (0.5.0 trial).
   */
  const announcePanels = (paneId: string, panel: string) => {
    if (!running.has(paneId)) return
    for (const line of panels.greeting(panel)) appendLine(paneId, line, "note", "ade")
  }

  /*
   * API keys (S23): the host keeps the values in the system keychain; here
   * only names travel. An agent can list what exists and ask the user for a
   * key with `@ade keys ask ENV motivo`, which opens a dialog and nothing more.
   */
  const [keysAvailable, setKeysAvailable] = createSignal(false)
  void getHost().then((host) => setKeysAvailable(Boolean(host?.listSecrets)))
  const withKeys = async () => {
    const host = await getHost()
    if (!host?.listSecrets || !host.saveSecret || !host.deleteSecret || !host.copySecret) {
      throw new Error("questa versione di ADE non ha il portachiavi")
    }
    return host as Required<Pick<typeof host, "listSecrets" | "saveSecret" | "deleteSecret" | "copySecret">>
  }
  const keysService: KeysHost = {
    list: () => withKeys().then((host) => host.listSecrets()),
    save: (draft) => withKeys().then((host) => host.saveSecret(draft)),
    remove: (name) => withKeys().then((host) => host.deleteSecret(name)),
    copy: (name) => withKeys().then((host) => host.copySecret(name)),
  }
  const keysHost = (): KeysHost | undefined => (keysAvailable() ? keysService : undefined)

  /** The session that wrote a request, by name: the questions say who asks. */
  const askerOf = (from: string | undefined): string | undefined => {
    const pane = from ? wb().panes.find((candidate) => candidate.id === from) : undefined
    return pane?.title || undefined
  }

  /*
   * A panel opening a page that is not this machine's, on the user's yes:
   * once per request, never remembered (review of review-alti, 1.3). A file
   * an agent shows can carry «@ade browser open …» as well as the agent can.
   */
  const confirmOpen = (panel: "browser" | "app", url: string, from: string | undefined) =>
    askYesNo(
      t(
        panel === "browser" ? "panels.consent.browser" : "panels.consent.app",
        askerOf(from) ?? t("panels.consent.someone"),
        url,
      ),
      {
        ok: t("panels.consent.allow"),
        cancel: t("panels.consent.deny"),
      },
    )
  const [keyRequest, setKeyRequest] = createSignal<{ env: string; reason: string; asker?: KeyAsker }>()
  panels.register("keys", {
    verbs: KEYS_VERBS,
    run: (request, from) => {
      // Who asks, for the dialog: the pane's name and its agent.
      const pane = from ? wb().panes.find((candidate) => candidate.id === from) : undefined
      const agentId = pane?.agent ?? pane?.model
      const asker = pane && agentId ? { title: pane.title, agentId } : undefined
      const ask = (env: string, reason: string) => setKeyRequest({ env, reason, ...(asker ? { asker } : {}) })
      return runKeysCommand({ list: keysService.list, ask }, request).catch((failure: unknown) => ({
        ok: false as const,
        reason: failure instanceof Error ? failure.message : String(failure),
      }))
    },
  })

  /*
   * `@ade browser …` (S46): a session opens a web pane bound to itself and
   * drives it. One handler for every pane, since the answer depends on who
   * asks; each mounted pane leaves its controls in `browserControllers`.
   */
  const browserControllers = new Map<string, BrowserController>()
  /** The web pane bound to session `ownerId`, the most recent if several. */
  const ownedBrowser = (ownerId: string) =>
    wb()
      .panes.filter((p) => p.browserUrl && p.browserOwner?.id === ownerId)
      .at(-1)
  /** A new web pane on `url`, bound to `owner`, in the owner's project. */
  /** `sheet`: a design sheet's pane is born with it, or its first load refuses the `ade-media` address. */
  const openOwnedBrowser = (
    url: string,
    owner: { id: string; title: string },
    focus: boolean,
    sheet?: PaneSheet,
  ): Pane => {
    const pane: Pane = {
      id: newPaneId("b"),
      title: sheet ? sheetLabel(sheet) : "Browser",
      ...(sheet ? { designSheet: sheet } : {}),
      status: "working",
      model: "—",
      mode: "browser",
      browserUrl: url,
      browserOwner: owner,
      // The owning session's project, name and folder both; the open one without an owner pane.
      ...(() => {
        const ownerPane = wb().panes.find((p) => p.id === owner.id)
        if (!ownerPane) return here()
        return {
          workspaceId: ownerPane.workspaceId,
          ...(ownerPane.projectRoot ? { projectRoot: ownerPane.projectRoot } : {}),
        }
      })(),
      lines: [],
    }
    setWb((w) => (focus ? addPane(w, pane) : { ...addPane(w, pane), focusedId: w.focusedId }))
    return pane
  }
  /*
   * The design sheets' reload: one more register in the pass that lists `.ade/`
   * already (`watchRegisters` below). The pane's own Reload does it, so the
   * address and the history stay as they are.
   */
  const sheetWatch = createSheetWatch({
    sheets: () =>
      wb().panes.flatMap((pane) => (pane.designSheet ? [{ id: pane.id, file: pane.designSheet.file }] : [])),
    reload: (id) => browserControllers.get(id)?.reload(),
  })
  panels.register("browser", {
    verbs: BROWSER_VERBS,
    run: (request, from) =>
      runBrowserCommand(
        {
          session: (id) => {
            const pane = wb().panes.find((p) => p.id === id && !isPanelPane(p))
            return pane && isRunning(pane.id) ? { id: pane.id, title: pane.title } : undefined
          },
          ownedPane: ownedBrowser,
          // Next to the session; the user's focus stays where it is.
          openPane: (url, owner) => openOwnedBrowser(url, owner, false),
          navigate: (paneId, url) => setWb((w) => updatePane(w, paneId, { browserUrl: url })),
          controller: (paneId) => browserControllers.get(paneId),
          confirmOpen: (url) => confirmOpen("browser", url, from),
        },
        request,
        from,
      ),
  })

  /*
   * A dev server a session started (S46 F4, D45): offered, not opened. The
   * session that wants its pane asks with `@ade browser open`.
   */
  const [devOffers, setDevOffers] = createSignal<DevServerOffer[]>([])
  const offersSeen = new Set<string>()
  const noticeDevServer = (paneId: string, line: string) => {
    const url = devServerUrl(line)
    if (!url) return
    const pane = wb().panes.find((p) => p.id === paneId && !isPanelPane(p))
    if (!pane || !shouldOffer({ sessionId: paneId, url, seen: offersSeen, ownedUrl: ownedBrowser(paneId)?.browserUrl }))
      return
    offersSeen.add(offerKey(paneId, url))
    setDevOffers((list) =>
      [...list.filter((offer) => offer.sessionId !== paneId), { sessionId: paneId, title: pane.title, url }].slice(-3),
    )
  }
  const acceptDevOffer = (offer: DevServerOffer) => {
    setDevOffers((list) => list.filter((item) => item !== offer))
    const session = wb().panes.find((p) => p.id === offer.sessionId)
    if (!session) return
    const owned = ownedBrowser(session.id)
    if (owned) setWb((w) => ({ ...updatePane(w, owned.id, { browserUrl: offer.url }), focusedId: owned.id }))
    else openOwnedBrowser(offer.url, { id: session.id, title: session.title }, true)
  }

  /*
   * Recording a video of ADE in use (S36).
   *
   * The folder is remembered rather than asked every time: a promo take is
   * started in the middle of doing something, and a dialog in the first second
   * is in the video. `record.folder` changes it.
   */
  const [recordState, setRecordState] = createSignal<RecordState>({ status: "idle" })
  const [recordDir, setRecordDir] = createSignal<string | undefined>(
    (() => {
      try {
        return localStorage.getItem("ade.record.dir") ?? undefined
      } catch {
        return undefined
      }
    })(),
  )
  const [recordQuality, setRecordQuality] = createSignal<RecordQuality>(
    (() => {
      try {
        const saved = localStorage.getItem("ade.record.quality")
        return QUALITY_LEVELS.some((level) => level.id === saved) ? (saved as RecordQuality) : DEFAULT_QUALITY
      } catch {
        return DEFAULT_QUALITY
      }
    })(),
  )
  /** The microphone for takes the user starts: off until switched on (`record.mic`). */
  const [recordMic, setRecordMic] = createSignal(
    (() => {
      try {
        return localStorage.getItem("ade.record.mic") === "on"
      } catch {
        return false
      }
    })(),
  )
  const recorder = createRecorder({
    start: async (target, dir, name, quality) => {
      const host = await getHost()
      if (!host?.recordStart) throw new Error(t("record.desktopOnly"))
      // Covered before the first frame exists, uncovered only once the take is over:
      // two frames, so the covered page is painted before the capture starts.
      coverSecrets(true)
      await new Promise<void>((painted) => requestAnimationFrame(() => requestAnimationFrame(() => painted())))
      try {
        return await host.recordStart(target, dir, name, quality)
      } catch (error) {
        coverSecrets(false)
        throw error
      }
    },
    stop: async () => {
      const host = await getHost()
      if (!host?.recordStop) throw new Error(t("record.desktopOnly"))
      return host.recordStop()
    },
    writeText: async (path, text) => {
      const host = await getHost()
      await host?.recordWrite?.(path, new TextEncoder().encode(text))
    },
    writeBytes: async (path, bytes) => {
      const host = await getHost()
      await host?.recordWrite?.(path, bytes)
    },
    startMic: () => startMicTake(voiceSettings().inputDeviceId),
    frame: (target) => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      ...(target.kind === "pane"
        ? { cropX: target.x, cropY: target.y, cropWidth: target.width, cropHeight: target.height }
        : {}),
    }),
    dir: () => recordDir(),
    quality: () => qualityLevel(recordQuality()),
    now: () => Date.now(),
    onState: setRecordState,
  })

  /** Asks for the folder once, and keeps it for the next takes. */
  // One dialog at a time: a second command while it is open waits for its answer.
  const pickRecordDir = onePickAtATime(async () => {
    const host = await getHost()
    const chosen = await host?.pickDirectory?.("Dove salvare i video registrati")
    if (!chosen) return undefined
    setRecordDir(chosen)
    try {
      localStorage.setItem("ade.record.dir", chosen)
    } catch {
      // A take still records; only the choice is forgotten next launch.
    }
    return chosen
  })

  /*
   * The folder is not made a write root: Rust writes and serves only the
   * files of the takes it started (`record_write`, `ade-media`).
   */
  const startRecording = async (target: Parameters<typeof recorder.start>[0], options: StartOptions) => {
    if (!recordDir() && !(await pickRecordDir())) return translate(options.language ?? locale(), "record.noFolder")
    return recorder.start(target, options)
  }

  createEffect(() => {
    if (recordState().status === "idle") coverSecrets(false)
  })

  /*
   * A minimised window ends the take: the capture gets no frames then, and a
   * video frozen on the last one is not what anybody meant to record.
   */
  createEffect(() => {
    if (recordState().status !== "recording") return
    const watch = setInterval(() => {
      void getHost()
        .then((host) => host?.recordState?.())
        .then(async (now) => {
          if (!now?.minimized || recordState().status !== "recording") return
          const problem = await recorder.stop()
          report(problem ?? t("record.minimized"), "info")
        })
        .catch(() => {})
    }, 1000)
    onCleanup(() => clearInterval(watch))
  })

  const recordMicOn = () => {
    const now = recordState()
    return now.status !== "idle" && now.recording.mic === true
  }

  /** An agent's take waits here for the user's answer. */
  const [recordAsk, setRecordAsk] = createSignal<{
    target: Parameters<typeof recorder.start>[0]
    asker?: string
    answer: (consent: RecordConsent) => void
  }>()
  const confirmRecording = (target: Parameters<typeof recorder.start>[0], asker: string | undefined) =>
    new Promise<RecordConsent>((resolve) => {
      // One question at a time: a second agent asking meanwhile is refused.
      if (recordAsk()) return resolve({ allowed: false, mic: false })
      setRecordAsk({
        target,
        ...(asker ? { asker } : {}),
        answer: (consent) => {
          setRecordAsk(undefined)
          resolve(consent)
        },
      })
    })

  /** The last take, remembered so "esporta" knows which one. */
  const [lastTake, setLastTake] = createSignal<string | undefined>()
  createEffect(() => {
    const now = recordState()
    if (now.status === "stopping") setLastTake(now.recording.path)
  })

  const [exporting, setExporting] = createSignal(false)
  /** Writes `<nome>.promo.mp4` beside the take: zoom, click rings, pointer, both tracks. */
  const exportLastTake = async () => {
    const video = lastTake()
    if (!video) return report(t("record.nothingToExport"), "info")
    if (exporting()) return report(t("record.export.busy"), "info")
    const host = await getHost()
    if (!host?.readTextFile || !host.recordWrite) return report(t("record.export.desktopOnly"))
    setExporting(true)
    report(t("record.exporting"), "info")
    try {
      const events = await host
        .readTextFile(eventsPathFor(video))
        .then((file) => file.text)
        .catch(() => "")
      const exists = async (path: string) => ((await host.exists?.(path).catch(() => false)) ? path : undefined)
      const mic = (await exists(micPathFor(video, "webm"))) ?? (await exists(micPathFor(video, "m4a")))
      const voice = await exists(voicePathFor(video))
      const level = qualityLevel(recordQuality())
      const result = await exportPromo({
        video,
        eventsText: events,
        ...(voice ? { voice } : {}),
        ...(mic ? { mic } : {}),
        fps: level.fps,
        bitrate: level.bitrate,
      })
      const out = `${video.replace(/\.mp4$/i, "")}.promo.${result.extension}`
      await host.recordWrite(out, result.bytes)
      report(t("record.export.done", out), "info")
    } catch (failure) {
      report(t("record.export.failed", failure instanceof Error ? failure.message : String(failure)))
    } finally {
      setExporting(false)
    }
  }

  /*
   * What the pointer did, at about a frame's pace, and every click.
   *
   * On the window rather than on each pane: a take follows the user wherever
   * they go, and a listener per pane would miss the space between them.
   */
  const noteMove = (event: PointerEvent) =>
    recorder.note({ kind: "pointer", at: Date.now(), x: Math.round(event.clientX), y: Math.round(event.clientY) })
  const noteClick = (event: PointerEvent) =>
    recorder.note({
      kind: "click",
      at: Date.now(),
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
    })
  window.addEventListener("pointermove", noteMove, { passive: true })
  window.addEventListener("pointerdown", noteClick, { passive: true })
  onCleanup(() => {
    window.removeEventListener("pointermove", noteMove)
    window.removeEventListener("pointerdown", noteClick)
  })

  panels.register("record", {
    verbs: RECORD_VERBS,
    run: (request, from) =>
      runRecordRequest(
        request,
        {
          confirm: confirmRecording,
          start: (target, options) => startRecording(target, { mic: options.mic === true, language: options.language }),
          stop: (language) => recorder.stop(language),
          paneRect: (name) => {
            const pane = wb().panes.find((p, index) => p.id === name || p.title === name || String(index + 1) === name)
            if (!pane) return undefined
            const node = document.querySelector(`[data-pane-id="${pane.id}"]`)
            const rect = node?.getBoundingClientRect()
            if (!rect || rect.width < 2 || rect.height < 2) return undefined
            const scale = window.devicePixelRatio || 1
            return {
              x: Math.round(rect.left * scale),
              y: Math.round(rect.top * scale),
              width: Math.round(rect.width * scale),
              height: Math.round(rect.height * scale),
            }
          },
          state: () => {
            const now = recordState()
            return now.status === "recording" ? { recording: true, path: now.recording.path } : { recording: false }
          },
        },
        askerOf(from),
      ).catch((failure: unknown) => ({
        ok: false as const,
        reason: failure instanceof Error ? failure.message : String(failure),
      })),
  })

  /** Announces a newly opened panel to every session currently running. */
  const announceToAll = (panel: string) => {
    for (const id of running.keys()) announcePanels(id, panel)
  }

  /** The native picker, narrowed to what a webview will actually play. */
  const pickVideo = async () => {
    const host = await getHost()
    return host?.pickFile?.({
      title: t("picker.video"),
      filters: [{ name: t("picker.video.filter"), extensions: [...PLAYABLE_EXTENSIONS] }],
    })
  }

  /** The native picker, narrowed to the formats the 3D panel reads. */
  const pickModel = async () => {
    const host = await getHost()
    return host?.pickFile?.({
      title: t("picker.model"),
      filters: [{ name: t("picker.model.filter"), extensions: [...MODEL_EXTENSIONS] }],
    })
  }

  /** Opens a 3D panel on `path`, or focuses the one already showing it. */
  const openModel = (path: string) => {
    const existing = paneShowing(wb().panes, "model", path)
    if (existing) {
      setWb((w) => ({ ...w, focusedId: existing.id }))
      return
    }
    setWb((w) =>
      addPane(w, {
        id: newPaneId("m"),
        title: path ? (path.split(/[\\/]/).pop() ?? t("newPane.model")) : t("newPane.model"),
        status: "working",
        model: "—",
        mode: "model",
        modelPath: path,
        ...here(),
        lines: [],
      }),
    )
  }

  /** A video panel on `path`, or the one already playing it. */
  const openVideo = (path: string) => {
    const existing = paneShowing(wb().panes, "video", path)
    if (existing) {
      setWb((w) => ({ ...w, focusedId: existing.id }))
      return
    }
    setWb((w) =>
      addPane(w, {
        id: newPaneId("v"),
        title: path.split(/[\\/]/).pop() ?? t("pane.video.title"),
        status: "working",
        model: "—",
        mode: "video",
        videoPath: path,
        ...here(),
        lines: [],
      }),
    )
  }

  /**
   * Where the open project serves its app, read from its own config.
   *
   * Three small files, read when a simulator opens; any that is missing is
   * simply not evidence.
   */
  const guessServers = async () => {
    const host = await getHost()
    const root = project()?.root
    if (!host?.readTextFile || !root) return []
    const base = root.replace(/[/\\]+$/, "")
    const read = (relative: string) =>
      host.readTextFile!(`${base}/${relative}`, 256_000).then(
        (file) => file.text,
        () => undefined,
      )
    const [packageJson, tauriConf, appJson] = await Promise.all([
      read("package.json"),
      read("src-tauri/tauri.conf.json"),
      read("app.json"),
    ])
    return guessDevServers({ packageJson, tauriConf, appJson })
  }

  /*
   * Decisions: the register in `.ade/decisions.jsonl`, a badge in the bar
   * while any waits for the user, the window that goes through them one at a
   * time, and the panel with all of them. See `decisions/`.
   *
   * An answer given here is appended to the register and then typed into the
   * Master session as a `risolta` line, when that session is running and
   * between turns; until then it waits in an outbox that survives a restart.
   */
  // Which pane asked, as ADE wrote it: a `fromPane` written by hand in a register is not trusted.
  const askers = askerLedger(() => (typeof localStorage === "undefined" ? undefined : localStorage))
  const decisionsRegister = createDecisionsRegister({
    vouch: askers.vouch,
    path: () => {
      const root = project()?.root
      return root ? decisionsPath(root) : undefined
    },
    io: async () => {
      const host = await getHost()
      if (!host?.readTextFile || !host.writeTextFile) return undefined
      return {
        readTextFile: (path: string, maxBytes?: number) => host.readTextFile!(path, maxBytes),
        writeTextFile: (path: string, contents: string) => host.writeTextFile!(path, contents),
        ...(host.appendTextFile
          ? { appendTextFile: (path: string, text: string) => host.appendTextFile!(path, text) }
          : {}),
        ...(host.readDir ? { readDir: (path: string) => host.readDir!(path) } : {}),
      }
    },
  })

  const [decisionsOutbox, setDecisionsOutbox] = createSignal<OutboxItem[]>(
    (() => {
      try {
        return parseOutbox(localStorage.getItem(OUTBOX_KEY))
      } catch {
        return []
      }
    })(),
  )
  const saveDecisionsOutbox = (items: OutboxItem[]) => {
    setDecisionsOutbox(items)
    try {
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(items))
    } catch {}
  }

  /*
   * Who receives a project's answers is the user's choice, per register, by
   * pane id. No session is picked by its title: with nobody chosen, answers
   * wait in the outbox and the panel says so.
   */
  const [decisionsRecipients, setDecisionsRecipients] = createSignal<Record<string, RecipientChoice>>(
    (() => {
      try {
        return parseRecipients(localStorage.getItem(RECIPIENT_KEY))
      } catch {
        return {}
      }
    })(),
  )
  // Two panes of the same title are told apart in «Risposte a», «→» and «chiesta da» (`distinctNames`).
  const paneNames = () => distinctNames(mailPanes())
  const decisionCandidates = () =>
    mailPanes().map((pane) => ({
      id: pane.id,
      title: paneNames().get(pane.id) ?? pane.title,
      project: pane.project,
      running: isRunning(pane.id),
    }))
  const decisionRecipient = () => {
    const path = decisionsRegister.path()
    return resolveRecipient(decisionCandidates(), path ? decisionsRecipients()[path] : undefined)
  }
  const chooseDecisionsRecipient = (id: string | undefined) => {
    const path = decisionsRegister.path()
    if (!path) return
    const pane = id ? decisionCandidates().find((candidate) => candidate.id === id) : undefined
    const next = chooseRecipient(decisionsRecipients(), path, pane ? { id: pane.id, title: pane.title } : undefined)
    setDecisionsRecipients(next)
    try {
      localStorage.setItem(RECIPIENT_KEY, JSON.stringify(next))
    } catch {}
    void deliverDecisions()
  }

  let deliveringDecisions = false
  const deliverDecisions = async () => {
    const path = decisionsRegister.path()
    const state = decisionsRegister.state()
    if (!path || !state || deliveringDecisions) return
    const kept = pruneOutbox(decisionsOutbox(), path, state.decisions)
    if (kept.length !== decisionsOutbox().length) saveDecisionsOutbox(kept)
    const pending = pendingFor(kept, path)
    if (pending.length === 0) return
    const currentTarget = decisionRecipient()
    const candidates = decisionCandidates()
    const host = await getHost()
    if (!host) return
    deliveringDecisions = true
    try {
      for (const item of pending) {
        const decision = state.decisions.find((entry) => entry.k === item.k)
        if (!decision) continue
        const target = resolveDeliveryTarget(item, candidates, currentTarget)
        if (!target || !running.has(target.id) || !(await freeNow(host, target.id))) continue
        // Through the inbox when the line is long (a note of a few paragraphs), like every other message.
        if (
          (await deliverText(host, target.id, item.text ?? deliveryLine(decision), {
            id: `decisione-${decision.k}`,
            kind: "send",
            from: "",
          })) !== "given"
        )
          continue
        const stored = decisionsOutbox().find(
          (entry) => entry.path === item.path && entry.k === item.k && entry.answeredAt === item.answeredAt,
        )
        if (stored)
          saveDecisionsOutbox(
            markDelivered(decisionsOutbox(), stored, { id: target.id, title: target.title }, Date.now()),
          )
        appendLine(
          target.id,
          item.kind === "riaperta"
            ? t("decisions.reopened.delivered", decision.k)
            : t("decisions.delivered", decision.k),
          "note",
          "ade",
        )
      }
    } finally {
      deliveringDecisions = false
    }
  }

  const decisionsHub = createDecisionsHub({
    register: decisionsRegister,
    recipient: decisionRecipient,
    sessions: decisionCandidates,
    choose: chooseDecisionsRecipient,
    delivery: (decision) => deliveryState(decisionsOutbox(), decisionsRegister.path() ?? "", decision),
    onAnswered: (decision, event) => {
      const path = decisionsRegister.path()
      if (!path) return
      saveDecisionsOutbox(
        // To the pane that asked, when the event says which (`answerItem`).
        enqueue(decisionsOutbox(), answerItem(path, decision, event.at, Date.now())),
      )
      void deliverDecisions()
    },
    onReopened: (decision, deliveredTo, deliveredToId) => {
      const path = decisionsRegister.path()
      if (!path) return
      saveDecisionsOutbox(
        enqueue(decisionsOutbox(), {
          path,
          k: decision.k,
          answeredAt: new Date().toISOString(),
          queuedAt: Date.now(),
          kind: "riaperta",
          text: reopenLine(decision.k),
          to: deliveredTo,
          ...(deliveredToId ? { toId: deliveredToId } : {}),
        }),
      )
      void deliverDecisions()
    },
  })

  /*
   * Design: the register in `.ade/design.jsonl`, a badge in the bar
   * while any proposal waits for the user, the window that goes through them one at a
   * time, and the panel with all of them. See `design/`.
   */
  const designRegister = createDesignRegister({
    vouch: askers.vouch,
    path: () => {
      const root = project()?.root
      return root ? designPath(root) : undefined
    },
    io: async () => {
      const host = await getHost()
      if (!host?.readTextFile || !host.writeTextFile) return undefined
      return {
        readTextFile: (path: string, maxBytes?: number) => host.readTextFile!(path, maxBytes),
        writeTextFile: (path: string, contents: string) => host.writeTextFile!(path, contents),
        ...(host.appendTextFile
          ? { appendTextFile: (path: string, text: string) => host.appendTextFile!(path, text) }
          : {}),
        ...(host.readDir ? { readDir: (path: string) => host.readDir!(path) } : {}),
      }
    },
  })

  const [designOutbox, setDesignOutbox] = createSignal<OutboxItem[]>(
    (() => {
      try {
        return parseDesignOutbox(localStorage.getItem(DESIGN_OUTBOX_KEY))
      } catch {
        return []
      }
    })(),
  )
  const saveDesignOutbox = (items: OutboxItem[]) => {
    setDesignOutbox(items)
    try {
      localStorage.setItem(DESIGN_OUTBOX_KEY, JSON.stringify(items))
    } catch {}
  }

  const [designRecipients, setDesignRecipients] = createSignal<Record<string, RecipientChoice>>(
    (() => {
      try {
        return parseDesignRecipients(localStorage.getItem(DESIGN_RECIPIENT_KEY))
      } catch {
        return {}
      }
    })(),
  )
  const designCandidates = () =>
    mailPanes().map((pane) => ({
      id: pane.id,
      title: paneNames().get(pane.id) ?? pane.title,
      project: pane.project,
      running: isRunning(pane.id),
    }))
  const designRecipient = () => {
    const path = designRegister.path()
    return resolveDesignRecipient(designCandidates(), path ? designRecipients()[path] : undefined)
  }
  const chooseDesignRecipientAction = (id: string | undefined) => {
    const path = designRegister.path()
    if (!path) return
    const pane = id ? designCandidates().find((candidate) => candidate.id === id) : undefined
    const next = chooseDesignRecipient(designRecipients(), path, pane ? { id: pane.id, title: pane.title } : undefined)
    setDesignRecipients(next)
    try {
      localStorage.setItem(DESIGN_RECIPIENT_KEY, JSON.stringify(next))
    } catch {}
    void deliverDesign()
  }

  let deliveringDesign = false
  const deliverDesign = async () => {
    const path = designRegister.path()
    const state = designRegister.state()
    if (!path || !state || deliveringDesign) return
    const kept = pruneDesignOutbox(designOutbox(), path, state.proposals)
    if (kept.length !== designOutbox().length) saveDesignOutbox(kept)
    const pending = pendingForDesign(kept, path)
    if (pending.length === 0) return
    const currentTarget = designRecipient()
    const candidates = designCandidates()
    const host = await getHost()
    if (!host) return
    deliveringDesign = true
    try {
      for (const item of pending) {
        const proposal = state.proposals.find((entry) => entry.k === item.k)
        if (!proposal) continue
        const target = resolveDesignDeliveryTarget(item, candidates, currentTarget)
        if (!target || !running.has(target.id) || !(await freeNow(host, target.id))) continue
        if (
          (await deliverText(host, target.id, item.text ?? designDeliveryLine(proposal), {
            id: `design-${proposal.k}`,
            kind: "send",
            from: "",
          })) !== "given"
        )
          continue
        const stored = designOutbox().find(
          (entry) => entry.path === item.path && entry.k === item.k && entry.answeredAt === item.answeredAt,
        )
        if (stored)
          saveDesignOutbox(
            markDesignDelivered(designOutbox(), stored, { id: target.id, title: target.title }, Date.now()),
          )
        appendLine(
          target.id,
          item.kind === "riaperta"
            ? t("design.reopened.delivered", proposal.k)
            : t("design.delivery.done", target.title, formatDesignMoment(Date.now(), new Date())),
          "note",
          "ade",
        )
      }
    } finally {
      deliveringDesign = false
    }
  }

  const designHub = createDesignHub({
    register: designRegister,
    projectRoot: () => project()?.root,
    recipient: designRecipient,
    sessions: designCandidates,
    choose: chooseDesignRecipientAction,
    delivery: (proposal) => designDeliveryState(designOutbox(), designRegister.path() ?? "", proposal),
    onAnswered: (proposal, event) => {
      const path = designRegister.path()
      if (!path) return
      saveDesignOutbox(enqueueDesign(designOutbox(), designAnswerItem(path, proposal, event.at, Date.now())))
      void deliverDesign()
    },
    onReopened: (proposal, deliveredTo, deliveredToId) => {
      const path = designRegister.path()
      if (!path) return
      saveDesignOutbox(
        enqueueDesign(designOutbox(), {
          path,
          k: proposal.k,
          answeredAt: new Date().toISOString(),
          queuedAt: Date.now(),
          kind: "riaperta",
          text: designReopenLine(proposal.k),
          to: deliveredTo,
          ...(deliveredToId ? { toId: deliveredToId } : {}),
        }),
      )
      void deliverDesign()
    },
  })

  /*
   * S41: <html lang> matches the interface, and under "System" a change of
   * the OS language shows at once instead of at the next launch.
   */
  onMount(() => {
    syncDocumentLanguage()
    window.addEventListener("languagechange", refreshSystemLocale)
    onCleanup(() => window.removeEventListener("languagechange", refreshSystemLocale))
  })

  /*
   * «Da scegliere»: one button and one list for what waits for the user,
   * decisions and design alike (notifiche-design). An entry opens its own
   * window at that entry.
   */
  const [choicesOpen, setChoicesOpen] = createSignal(false)
  const [choiceStart, setChoiceStart] = createSignal<string>()
  const [decisionsOpen, setDecisionsOpen] = createSignal(false)
  const decisionsWaiting = createMemo(
    () => decisionsRegister.state()?.decisions.filter((decision) => decision.status === "aperta").length ?? 0,
  )

  const [designOpen, setDesignOpen] = createSignal(false)
  const designWaiting = createMemo(
    () => designRegister.state()?.proposals.filter((proposal) => proposal.status === "aperta").length ?? 0,
  )
  // Answers recorded but not delivered: the bar says so, even with nothing left open.
  const decisionsQueued = createMemo(
    () =>
      decisionsRegister
        .state()
        ?.decisions.filter(
          (decision) => decision.status === "risposta" && decisionsHub.delivery(decision).state === "in coda",
        ).length ?? 0,
  )
  // Lines thrown away and events refused: the button shows them too, so a wrong line never passes unseen.
  const decisionsDiscarded = createMemo(
    () => (decisionsRegister.loaded()?.problems.length ?? 0) + (decisionsRegister.state()?.rejected.length ?? 0),
  )
  const designDiscarded = createMemo(
    () => (designRegister.loaded()?.problems.length ?? 0) + (designRegister.state()?.rejected.length ?? 0),
  )
  const designQueued = createMemo(
    () =>
      designRegister
        .state()
        ?.proposals.filter(
          (proposal) =>
            (proposal.status === "risposta" || proposal.status === "giro") &&
            designHub.delivery(proposal).state === "in coda",
        ).length ?? 0,
  )
  // An answer on its way to the pane that asked is queued for half a second: not «0» on the button (`createSettled`).
  const settledQueued = createSettled(() => decisionsQueued() + designQueued())
  const choicesCounts = createMemo(() => ({
    ...choiceCounts(
      { waiting: decisionsWaiting(), queued: decisionsQueued(), discarded: decisionsDiscarded() },
      { waiting: designWaiting(), queued: designQueued(), discarded: designDiscarded() },
    ),
    queued: settledQueued(),
  }))
  // Not a memo: it reads the panes (`mailPanes`), defined further down, and a memo runs at once.
  const choices = () =>
    choiceItems(decisionsRegister.state()?.decisions ?? [], designRegister.state()?.proposals ?? [], paneNames())
  /** An entry of «Da scegliere» opens its own window, at that entry. */
  const pickChoice = (item: ChoiceItem) => {
    setChoicesOpen(false)
    setChoiceStart(item.k)
    if (item.kind === "decision") setDecisionsOpen(true)
    else setDesignOpen(true)
  }

  onMount(() => {
    // One pass and one listing of `.ade/` for both registers (P1-C2c).
    onCleanup(
      watchRegisters([decisionsRegister, designRegister, sheetWatch], async () => {
        const host = await getHost()
        return host?.readDir ? (path: string) => host.readDir!(path) : undefined
      }),
    )
    // Only does work while an answer is waiting to go out.
    onCleanup(
      every(
        3000,
        () => {
          void deliverDecisions()
          void deliverDesign()
        },
        { whenHidden: 15_000 },
      ),
    )
  })

  /** Opens the Design panel, or focuses the one already open. */
  const openDesignPane = () => {
    const existing = wb().panes.find((pane) => pane.mode === "design")
    if (existing) {
      setWb((w) => ({ ...w, view: "code", focusedId: existing.id }))
      return
    }
    setWb((w) => ({
      ...addPane(w, {
        id: newPaneId("des"),
        title: "Design",
        status: "working",
        model: "—",
        mode: "design",
        ...here(),
        lines: [],
      }),
      view: "code",
    }))
  }

  /** Opens the Decisions panel, or focuses the one already open. */
  const openDecisionsPane = () => {
    const existing = wb().panes.find((pane) => pane.mode === "decisions")
    if (existing) {
      setWb((w) => ({ ...w, view: "code", focusedId: existing.id }))
      return
    }
    setWb((w) => ({
      ...addPane(w, {
        id: newPaneId("d"),
        title: "Decisioni",
        status: "working",
        model: "—",
        mode: "decisions",
        ...here(),
        lines: [],
      }),
      view: "code",
    }))
  }

  /**
   * Writes a captured frame next to the project, and says where it went.
   *
   * Inside the project rather than the screenshots folder: the frame is
   * evidence about the thing being built, the agent is about to be handed
   * the path, and `write_bytes` only writes inside the roots this window has
   * declared — which the screenshots folder is not.
   */
  const captureFrame = async (name: string, png: Uint8Array): Promise<string> => {
    const host = await getHost()
    const root = project()?.root
    if (!host?.writeBytes || !root) throw new Error("nessun progetto aperto in cui salvare")
    const path = `${root.replace(/[/\\]+$/, "")}/.ade/frames/${name}`
    const failure = await host.writeBytes(path, png)
    if (failure) throw new Error(failure)
    return path
  }

  /*
   * Panel answers waiting for their pane (`createPendingPanelReplies`, which says
   * why each of its rules is there).
   *
   * Not `heldLines`: those are mail, they are persisted so a suspended session
   * finds them on the next start, and a panel answer persisted would be typed
   * into a session that stopped waiting minutes ago — a stale answer arriving as
   * a new turn of the user's. This one lives minutes at most, and only while the
   * pane is not free: the agent is blocked on its stdin until it goes, so the
   * retry is not politeness, it is the delivery.
   */
  const pendingPanelReplies = createPendingPanelReplies<SpawnedSession>()

  /*
   * The requests of an agent that draws its screen with the cursor (nikcli),
   * which never reach `onLine` as a line: read from the screen once the pane
   * goes quiet (`panels/screen-requests.ts`, which says why each rule is there).
   */
  const onAlternateScreen = (paneId: string) =>
    hasTerminal(paneId) && getTerminal(paneId).terminal.buffer.active.type === "alternate"
  const screenRequests = createScreenRequests({
    rows: (paneId) => {
      const pane = wb().panes.find((candidate) => candidate.id === paneId)
      // Only from an agent, as on `onLine` (`acceptsRequests`).
      if (!pane || !acceptsRequests(pane.agent ?? pane.model) || !hasTerminal(paneId)) return undefined
      return alternateRows(getTerminal(paneId).terminal)
    },
    onRequest: (paneId, line) => void handlePanelRequest(paneId, line),
  })

  /**
   * Acts on one line of agent output, if it was addressed to a panel.
   *
   * The answer goes back into the pty, not only into the transcript: the
   * agent is blocked on its own stdin waiting for it, and a reply written
   * where only the user can see it leaves the session stopped forever.
   */
  const handlePanelRequest = async (paneId: string, line: string) => {
    const handled = await panels.handle(line, paneId)
    if (!handled) return
    // A skipped line is said in the transcript only: typed back, the TUI would redraw it.
    if ("skipped" in handled) return appendLine(paneId, handled.skipped, "note", "ade")
    // Written to the transcript too, because what an agent did to a panel is
    // something the user has to be able to see afterwards.
    appendLine(paneId, handled.reply, "note", "ade")
    const session = running.get(paneId)
    if (!session) return
    /*
     * Typed like every other line, and that is the whole of the change: the road
     * through `typeLine` is the line queue, the paste, the wait, `questionOpen` and
     * the Enter check, and writing the pty here went past all of them. An agent
     * that printed an `@ade` line and then asked for a permission used to have
     * this answer typed over the prompt, and its Enter confirmed the selected
     * choice — a numbered option list makes it worse, because a reply beginning
     * with a digit picks one.
     */
    const hold = panelReplyHold({
      alive: running.get(paneId) === session,
      typing: isTyping(records.typed.get(paneId)),
      questionOpen: questionOpen(paneId),
    })
    if (hold) {
      pendingPanelReplies.queue(paneId, session, handled.reply)
      return appendLine(paneId, t("note.panelReplyHeld", hold), "note", "ade")
    }
    /*
     * Something already waiting for this pane: this answer goes to the end of that
     * list and the round writes them in order. Typing it straight out here would
     * overtake the ones before it, and if it could not be given it would be
     * dropped — the check after the write used to see the *older* answers waiting
     * and read them as a reason to leave this one out, when it is the newest of
     * the three.
     */
    if (!pendingPanelReplies.admit(paneId, session, handled.reply)) return
    // Out of the waiting before it is typed, so the round below cannot send it a
    // second time while this one is still in the queue.
    pendingPanelReplies.take(paneId, handled.reply)
    void typeLine(session, handled.reply, { unlessBusy: true }).then((given) => {
      // Given, nothing to retry. Not given, back in the waiting with the age it
      // was made at, where the round will find it in the right place in the order.
      if (given) return
      pendingPanelReplies.restore(paneId, session, handled.reply, Date.now())
    })
  }

  /** Types the panel answers whose pane has gone free, and keeps or drops the rest. */
  const flushPanelReplies = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>) => {
    const now = Date.now()
    for (const paneId of pendingPanelReplies.panes()) {
      const session = running.get(paneId)
      // A pane closed, or restarted or resumed: the same id, a process that never
      // asked for these answers.
      if (!session || session !== pendingPanelReplies.sessionOf(paneId)) {
        pendingPanelReplies.forget(paneId)
        continue
      }
      // Ageing first, so a pane that stays busy for an hour gives its answers up
      // instead of keeping them until the heat death of the app.
      const { waits, stale } = pendingPanelReplies.claim(paneId, now)
      if (stale > 0) appendLine(paneId, t("note.panelReplyStale", stale), "note", "ade")
      if (waits.length === 0) continue
      if (!(await freeNow(host, paneId))) continue
      for (const wait of waits) {
        pendingPanelReplies.take(paneId, wait.text)
        const outcome = await typeLineOutcome(session, wait.text, { unlessBusy: true })
        if (deliveryResult(outcome, running.get(paneId) === session) !== "held") continue
        // Not given — a prompt opened again, or the user is typing: back in the
        // waiting, still as old as it was, so it cannot be kept alive by trying,
        // and in the place that age puts it, so the answers asked after it do not
        // overtake it (`restore`).
        pendingPanelReplies.restore(paneId, session, wait.text, wait.at)
        // And the round stops here, which is the other half of the same thing:
        // `restore` puts the order back for the next round, and this stops the
        // one after it from sending a later answer off while this one is still
        // unanswered. Either alone leaves an inversion, one round apart.
        break
      }
    }
  }

  /*
   * A request from a browser pane (S46): the details and the picture go in
   * the project's `.ade/browser/`, and one line waits for the session's turn
   * to end, like a message from another session.
   */
  const sendBrowserRequest = async (
    to: string,
    request: BrowserRequest,
    capture: { crop: Rect; redact: Rect[]; scale: number },
  ): Promise<{ ok: true } | { ok: false; reason: string; stopped?: boolean }> => {
    const target = wb().panes.find((pane) => pane.id === to && !isPanelPane(pane))
    if (!target || !running.has(to)) return { ok: false, reason: t("browser.send.stopped"), stopped: true }
    const host = await getHost()
    const root = project()?.root?.replace(/\\/g, "/").replace(/\/+$/, "")
    if (!host?.writeTextFile || !root) return { ok: false, reason: t("browser.send.noProject") }
    const at = new Date()
    const stem = requestStem(at, request.paneTitle)
    const dir = `${root}/.ade/browser`
    let shot: { path: string } | { error: string }
    try {
      shot = host.browserShot
        ? { path: (await host.browserShot({ path: `${dir}/${stem}.png`, ...capture })).path }
        : { error: t("browser.shot.unavailable") }
    } catch (error) {
      shot = { error: error instanceof Error ? error.message : String(error) }
    }
    // Requests are working notes, not project files.
    if (host.exists && !(await host.exists(`${dir}/.gitignore`).catch(() => true))) {
      await host.writeTextFile(`${dir}/.gitignore`, "*\n")
    }
    const details = `${dir}/${stem}.md`
    const failure = await host.writeTextFile(details, formatRequestDetails(request, { at, shot }))
    if (failure) return { ok: false, reason: failure }
    heldLines.push({ paneId: to, text: formatRequestLine(request, details) })
    tellPane(to, t("note.browserRequest", request.paneTitle))
    return { ok: true }
  }

  /*
   * A design sheet's notes, to the session that wrote the sheet (piece 2): the
   * Markdown file beside the sheet, and one line that points at it. Only the
   * pane's «Invia» button calls this, and the recipient is the session saved
   * by `ade-msg design` or the one the user picked, never one the page names.
   */
  const sendSheetNotes = async (
    paneId: string,
    to?: string,
  ): Promise<{ ok: true; title: string } | { ok: false; reason: string; stopped?: boolean }> => {
    const sheet = wb().panes.find((pane) => pane.id === paneId)?.designSheet
    const notes = sheet?.notes ?? []
    if (!sheet || notes.length === 0) return { ok: false, reason: t("sheet.notes.none") }
    const target = to ?? sheet.from
    const session = wb().panes.find((pane) => pane.id === target && !isPanelPane(pane))
    if (!session || !running.has(target)) return { ok: false, reason: t("browser.send.stopped"), stopped: true }
    const host = await getHost()
    if (!host?.writeTextFile) return { ok: false, reason: t("browser.send.noProject") }
    const at = new Date()
    const failure = await host.writeTextFile(notesFilePath(sheet.file, at), formatNotesFile(sheet.file, notes, at))
    if (failure) return { ok: false, reason: failure }
    heldLines.push({
      paneId: target,
      text: formatNotesLine(sheet.file, notes.length, notesFileRelative(sheet.file, at)),
    })
    tellPane(target, t("note.sheetNotes", sheetLabel(sheet)))
    // Sent: the list empties, and a session the user picked is where the next notes go.
    const { notes: _sent, ...kept } = sheet
    setWb((w) => updatePane(w, paneId, { designSheet: { ...kept, from: target } }))
    return { ok: true, title: session.title }
  }

  // The surface going away without the page (a hot update of this file) ends them too: see `RunningSessions`.
  const running = new RunningSessions()
  onCleanup(() => running.endAll())
  // The panes being started back (`reopen`, the restore): recorded before their awaits, not after (ALTO 3).
  const reopening = oneAtATime()
  const [runningTick, setRunningTick] = createSignal(0)
  const touchRunning = () => setRunningTick((n) => n + 1)
  const isRunning = (id: string) => {
    runningTick()
    return running.has(id)
  }
  /** Suspended by the user (P1-C6): its mail waits for "Riprendi", and nothing wakes it. */
  const isSuspendedPane = (paneId: string) => wb().panes.some((pane) => pane.id === paneId && pane.suspended)

  /*
   * Messages between sessions. See `session/mailbox.ts` and `mailbox.rs`.
   *
   * The sessions are the agent panes in grid order — the same order, and so
   * the same numbers, that `ade-msg list` prints — and only a running one
   * can receive: typing into a pane with no process reaches nobody.
   */
  const mailPanes = (): MailPane[] =>
    // Grouped by project, which is also the order `ade-msg list` numbers them in.
    byProject(
      wb()
        .panes.filter((pane) => !isPanelPane(pane) && (pane.agent ?? pane.model))
        .map((pane) => ({
          id: pane.id,
          title: pane.title,
          agent: pane.agent ?? pane.model,
          status: running.has(pane.id) ? pane.status : pane.suspended ? "sospesa" : "chiusa",
          project: pane.workspaceId,
        })),
    )

  const agentOfPane = (paneId: string) => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    return pane?.agent ?? pane?.model
  }

  /** Long enough for a TUI's paste detection to close before Enter arrives. */
  const SUBMIT_DELAY_MS = 400
  let delivering = false
  // When the watch half of the last pass ran: see `watchDue`.
  let watchedAt = 0

  const deliverMail = async () => {
    // One pass at a time: a pass now waits between text and Enter, and two
    // overlapping passes would interleave two messages in one input box.
    if (delivering) return
    delivering = true
    try {
      await deliverPending()
    } finally {
      delivering = false
    }
  }

  /*
   * The text, and the Enter on its own a moment later.
   *
   * Written together, the whole line and its carriage return reach the CLI in
   * one burst, and Claude Code and codex take a burst for a paste: the return
   * becomes part of the pasted text and the line sits in the input box waiting
   * for someone to press Enter. A keystroke that arrives after the paste has
   * settled is a keystroke. False when the session went away in between.
   */
  /*
   * One line at a time per session (`session/line-queue.ts`): the next line
   * starts once the one before has had its Enter, or two texts share one
   * Enter. With `unlessBusy`, the check is made in the queue, at the moment of
   * writing, and the line is dropped (false) if the user has begun a draft or
   * a permission prompt has opened since it was queued (`lineIsTaken`): the
   * caller then does not count it as given.
   */
  const lineQueue = createLineQueue()
  /*
   * A fit that came while `host.spawn` was awaited went to `sessionFor`,
   * found nothing in `running` and was lost; the cell does not change size
   * again, so nothing sent it later (S77). Called right after `running.set`.
   */
  const resyncSize = (paneId: string, session: SpawnedSession, bornAt: { cols: number; rows: number } | undefined) => {
    const now = ptySize(paneId)
    if (now && (now.cols !== bornAt?.cols || now.rows !== bornAt?.rows)) session.resize(now.cols, now.rows)
  }

  /*
   * True when the text reached the input box, with its Enter or without
   * (`lineGiven`): a line held back by a permission prompt is given all the
   * same, and typing it again would put it there twice.
   */
  const typeLine = async (
    session: SpawnedSession,
    text: string,
    options: { unlessBusy?: boolean } = {},
  ): Promise<boolean> => lineGiven(await typeLineOutcome(session, text, options))

  /** The lines queued or being typed, per pane: `freeNow` reads it first. */
  const linesInFlight = createInFlight()

  const typeLineOutcome = (
    session: SpawnedSession,
    text: string,
    options: { unlessBusy?: boolean } = {},
  ): Promise<LineOutcome> => {
    const paneId = [...running.entries()].find(([, live]) => live === session)?.[0]
    const job = async (): Promise<LineOutcome> => {
      if (
        options.unlessBusy &&
        paneId !== undefined &&
        lineIsTaken({
          typing: isTyping(records.typed.get(paneId)),
          permissionPending: paneId !== undefined && questionOpen(paneId),
        })
      )
        return "not-typed"
      return typeLineNow(session, text)
    }
    return paneId === undefined ? job() : linesInFlight.track(paneId, lineQueue(paneId, job))
  }

  const typeLineNow = async (session: SpawnedSession, text: string): Promise<LineOutcome> => {
    const line = asOneLine(text)
    const paneId = [...running.entries()].find(([, live]) => live === session)?.[0]
    /*
     * A paste, said as one, when the CLI has asked for that. Claude Code and
     * codex switch bracketed paste on, and then text between the markers is
     * a paste by declaration rather than by guesswork about timing, and the
     * Enter after it is a keystroke once the program has taken the paste in
     * (`pasteSettled`: a fixed 120 ms lost the Enter of every long message to
     * codex and agy). Otherwise: the text, and Enter
     * after a wait that grows with the line — a thousand characters with the
     * reply contract were still being taken in when a fixed 400 ms Enter came.
     */
    const bracketed = paneId !== undefined && bracketedPaste.get(paneId) === true
    // A message that quotes an `@ade` line must not run it when the TUI echoes it.
    if (paneId !== undefined) {
      panels.newTurn(paneId)
      panels.typed(paneId, line)
    }
    const typedAt = Date.now()
    const alive = () => [...running.values()].includes(session)
    /*
     * The Enter is pressed only if no permission prompt opened during the
     * wait (B1 bis): it would confirm the selected choice. The text stays in
     * the box, and the pane says why it was not sent.
     */
    const outcome = await typeThenEnter({
      text: bracketed ? `${ESC}[200~${line}${ESC}[201~` : line,
      write: (data) => session.write(data),
      wait: async () => {
        if (!bracketed)
          return void (await new Promise((resolve) =>
            setTimeout(resolve, Math.min(2500, SUBMIT_DELAY_MS + line.length)),
          ))
        while (alive() && !pasteSettled({ typedAt, lastOutputAt: lastOutputAt.get(paneId), now: Date.now() })) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      },
      alive,
      permissionOpen: () => paneId !== undefined && questionOpen(paneId),
      // A key of the user's since the text went in: not a draft from before.
      typedDuring: () => paneId !== undefined && (records.typed.get(paneId)?.at ?? -1) >= typedAt,
    })
    if (paneId !== undefined && outcome === "sent") {
      // A line ADE submits starts a turn exactly as the user's Enter does.
      markWorking(paneId)
      void confirmSubmitted(paneId, session, typedAt)
    }
    if (paneId !== undefined && outcome === "typed-no-enter") appendLine(paneId, t("note.enterHeld"), "note", "ade")
    return outcome
  }

  const ESC = String.fromCharCode(27)

  /** Whether each pane's program has bracketed paste on, from the mode switches in its own output. */
  const bracketedPaste = new Map<string, boolean>()
  const noteBracketedPaste = (paneId: string, chunk: string) => {
    const on = chunk.lastIndexOf(`${ESC}[?2004h`)
    const off = chunk.lastIndexOf(`${ESC}[?2004l`)
    if (on >= 0 || off >= 0) bracketedPaste.set(paneId, on > off)
  }

  /**
   * Makes sure a typed line became a turn, where the CLI's hooks can say so.
   *
   * `UserPromptSubmit` runs the moment a prompt is sent. The confirmation
   * window is `HOOK_TIMEOUT` plus 2 s because under load the hook can take
   * several seconds, and an Enter sent before the hook writes lands inside a
   * turn that has already started. We do not use pane output to detect
   * submission: `confirmSubmitted` exists for when CR gets swallowed into a
   * paste, where Claude Code redraws the input box with an extra newline and
   * produces output even though the line was never submitted.
   */
  const confirmSubmitted = async (paneId: string, session: SpawnedSession, typedAt: number) => {
    const host = await getHost()
    const nonce = paneNonces.get(paneId)
    if (!host?.readAgentActivity || !nonce || !hooked(paneId)) return
    for (let attempt = 0; attempt < 2; attempt++) {
      const sentAt = Date.now()
      const deadline = confirmDeadline(sentAt, HOOK_TIMEOUT)
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (running.get(paneId) !== session || questionOpen(paneId)) return
        const activity = await paneActivity(host, paneId, await host.readAgentActivity(nonce))
        const check = submitCheck({ typedAt, activity, now: Date.now(), deadline })
        if (check === "confirmed") {
          activityOf.set(paneId, activity!)
          return
        }
        if (check === "queued") {
          /*
           * Busy from before the line was typed: the CLI queued it behind the
           * current turn, and it will be submitted when that turn ends. An Enter
           * now would land in whatever the turn is doing.
           */
          return
        }
        if (check === "wait") {
          continue
        }
        if (check === "resend") {
          // Not over a prompt (B1 bis), not into the user's draft, and in the pane's queue (`enterAgain`).
          if (!(await pressAgain(paneId, session))) return
          appendLine(paneId, t("note.resent"), "note", "ade")
          break
        }
      }
    }
  }

  /** An Enter on its own, for a line ADE typed and no turn took: see `enterAgain`. */
  const pressAgain = (paneId: string, session: SpawnedSession): Promise<boolean> =>
    enterAgain({
      queue: lineQueue,
      key: paneId,
      write: (data) => session.write(data),
      alive: () => running.get(paneId) === session,
      typing: () => isTyping(records.typed.get(paneId)),
      permissionOpen: () => questionOpen(paneId),
    })

  /** Messages held for a busy recipient, whose sender has already been told. */
  const held = new Set<string>()
  /** The state last written for a queued request, so a waiter hears about changes only. */
  const heldStates = new Map<string, string>()

  /*
   * The sessions Claude Code lists (`claude agents --json`, documented), so a
   * pane can be addressed by the name the CLI actually kept. Asked at most
   * every few seconds and never waited on for long: a CLI that hangs, is too
   * old to list, or is not installed answers "nobody", and the message is
   * typed as it always was.
   */
  /**
   * Native handoffs waiting for the sender's word. Booked when the receipt
   * goes out, closed by `ade-msg delivered`, by the target's turn hook, or by
   * the clock — the last two so a sender that forgets never leaves the other
   * session without its mail.
   */
  const handoffs = new Map<string, Handoff & { failed?: string; acked?: boolean }>()
  /** Saved with the same care as the requests: a `send` has no other line on disk. */
  let saveHandoffs = () => {}
  /**
   * How each closed handoff ended. The live test showed the target's turn hook
   * confirming a delivery before the sender got round to `ade-msg delivered`,
   * and the sender then read "no handoff waiting" as a failure. A confirmation
   * that arrives after the fact is answered with what happened, not an error.
   */
  const closedHandoffs = new Map<string, "confermata" | "digitata">()

  /** Types what a handoff did not deliver, and says so on both sides. */
  const fallBackToTyping = (handoff: Handoff, reason: string) => {
    handoffs.delete(handoff.id)
    saveHandoffs()
    closedHandoffs.set(handoff.id, "digitata")
    const request = openRequests.get(handoff.id)
    if (request) {
      request.via = "digitata"
      delete request.acked
      saveRequests()
    }
    heldLines.push({
      paneId: handoff.paneId,
      text: formatFallbackLine(handoff.line, reason),
      ...(handoff.full ? { full: formatFallbackLine(handoff.full, reason) } : {}),
      inbox: { id: handoff.id, kind: handoff.kind, from: handoff.from },
    })
    appendLine(handoff.paneId, t("note.viaFallback", reason), "note", "ade")
    if (running.has(handoff.from)) appendLine(handoff.from, t("note.viaFallback", reason), "note", "ade")
  }

  /** Closes the handoffs the sender confirmed, the hook showed, or the clock ran out on. */
  const settleHandoffs = (now: number) => {
    for (const handoff of [...handoffs.values()]) {
      const outcome = handoffOutcome(
        handoff,
        { ...(handoff.acked ? { acked: true } : {}), ...(handoff.failed !== undefined ? { failed: true } : {}) },
        now,
      )
      if (outcome === "wait") continue
      if (outcome === "fallback") {
        /*
         * Deleted after the work, not before. A held line for a pane that is
         * not running is discarded, and at a restart the panes come back a
         * moment after the handoffs are loaded: the review found an expired
         * handoff lost in the very pass that was recovering it. The handoff
         * stays saved until its pane is alive; only a pane that no longer
         * exists lets it go.
         */
        if (!running.has(handoff.paneId)) {
          if (!wb().panes.some((pane) => pane.id === handoff.paneId)) {
            handoffs.delete(handoff.id)
            saveHandoffs()
          }
          continue
        }
        fallBackToTyping(handoff, handoff.failed || "nessuna conferma dal mittente")
        continue
      }
      handoffs.delete(handoff.id)
      saveHandoffs()
      closedHandoffs.set(handoff.id, "confermata")
      const request = openRequests.get(handoff.id)
      if (request) {
        request.acked = true
        saveRequests()
      }
      appendLine(handoff.paneId, t("note.viaNativeAck"), "note", "ade")
      if (running.has(handoff.from)) appendLine(handoff.from, t("note.viaNativeAck"), "note", "ade")
    }
  }

  const NATIVE_LIST_TTL_MS = 5_000
  const NATIVE_LIST_TIMEOUT_MS = 3_000
  let nativeList: { at: number; sessions: NativeSession[] | undefined } | undefined
  const listNativeSessions = async (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
  ): Promise<NativeSession[] | undefined> => {
    const now = Date.now()
    if (nativeList && now - nativeList.at < NATIVE_LIST_TTL_MS) return nativeList.sessions
    // Not `host.run`: that door is git-only by design. The live test of S70
    // found every claude→claude message falling back on "the CLI does not list"
    // because of it, so the listing has a door of its own.
    if (!host.claudeAgents) return undefined
    const listing = host
      .claudeAgents(project()?.root)
      .then((result) => (result.code === 0 ? parseNativeSessions(result.stdout) : undefined))
      .catch(() => undefined)
    const late = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), NATIVE_LIST_TIMEOUT_MS))
    const sessions = await Promise.race([listing, late])
    nativeList = { at: Date.now(), sessions }
    return sessions
  }
  /** Late replies and updates for a caller that is busy: typed when its turn ends. */
  const heldLines: {
    paneId: string
    text: string
    inbox?: InboxMeta
    told?: boolean
    full?: string
    suspended?: true
  }[] = []
  /**
   * Replies to natively delivered requests, kept as files until the caller is
   * free. On the typed route the caller is already blocked in `ade-msg ask`
   * when the answer lands; on the native route it delivered the request itself
   * and reaches `ade-msg wait` a few tool calls later. The live test saw the
   * answer taken back after three seconds, the wait run its 110 s out empty,
   * and the answer typed only then. So: claimed by the wait whenever it starts,
   * taken back and typed only once the caller's turn has ended.
   */
  const lateReplies: { ref: string; callerId: string; from: string; sender: MailPane | undefined }[] = []

  /*
   * How much mail is waiting for each pane, for the badge in its header.
   *
   * Recomputed from the two queues on every pass rather than kept in step by
   * hand at each push and splice: a count that drifts is a badge that lies,
   * and the queues are touched from a dozen places.
   */
  const [mailWaiting, setMailWaiting] = createSignal<Record<string, number>>({})
  const refreshMailWaiting = () => {
    const counts: Record<string, number> = {}
    for (const held of heldLines) counts[held.paneId] = (counts[held.paneId] ?? 0) + 1
    for (const entry of inboxPending) counts[entry.paneId] = (counts[entry.paneId] ?? 0) + 1
    setMailWaiting((current) => {
      const ids = new Set([...Object.keys(current), ...Object.keys(counts)])
      for (const id of ids) if ((current[id] ?? 0) !== (counts[id] ?? 0)) return counts
      return current
    })
  }

  /**
   * Writes into a session's input line on the user's behalf — dropped paths,
   * dictated speech — and counts it as typed, because it is: nothing is
   * submitted until the user says so, and until then the line is theirs.
   *
   * Not over a question, and the reason is where the text lands rather than an
   * Enter: `dictationHold` says it at length. The words are not written and the
   * pane says why, so the user answers with the keys or the card's buttons and
   * dictates again afterwards.
   */
  const typeAsUser = (paneId: string, text: string) => {
    const session = running.get(paneId)
    if (!session) return
    if (dictationHold({ alive: true, questionOpen: questionOpen(paneId) }))
      return tellPane(paneId, t("note.dictationHeld"))
    records.typed.update(paneId, (line) => typedAfter(line, text, Date.now()))
    session.write(text)
  }

  /**
   * Shows the user what a pane is waiting for, without typing a character.
   *
   * The badge opens into the pane's own transcript: the mail is ADE's to
   * show, and the session reads it when its line is free. Looking is not
   * reading — the badge stays until the session itself takes the mail.
   */
  const showMail = (paneId: string) => {
    const panes = mailPanes()
    const named = (from: string | undefined) => panes.find((pane) => pane.id === from)?.title ?? "una sessione"
    const waiting = [
      ...heldLines.filter((held) => held.paneId === paneId).map((held) => held.text),
      ...inboxPending
        .filter((entry) => entry.paneId === paneId)
        .map((entry) => `${named(entry.from)}: ${entry.chars} caratteri, ${entry.id}`),
    ]
    if (waiting.length === 0) return
    for (const line of waiting) tellPane(paneId, t("note.mailWaiting", asOneLine(line).slice(0, 160)))
  }

  /** The activity files, one call a pass; a delivery reuses the pass's read for a second (P1-C2a). */
  let activityReads: { host: object; reads: ActivityReads } | undefined
  /** Lines sent into each pane, so the hook report's check speeds up after one (P1-C2b). */
  const linesSent = new Map<string, number>()
  const readsOf = (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
    readOne: (nonce: string) => Promise<string | null>,
  ) => {
    if (activityReads?.host !== host) {
      activityReads = {
        host,
        reads: createActivityReads({
          readOne,
          ...(host.readAgentActivities ? { readMany: host.readAgentActivities } : {}),
        }),
      }
    }
    return activityReads.reads
  }

  /** Whether a pane can be typed into now without interrupting it; reads its turn activity when hooked. */
  const freeNow = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, paneId: string): Promise<boolean> => {
    // A line on its way is a turn about to start (`createInFlight`).
    if (linesInFlight.has(paneId)) return false
    const isHooked = hooked(paneId)
    let activity = activityOf.get(paneId)
    const nonce = paneNonces.get(paneId)
    if (isHooked && nonce && host.readAgentActivity) {
      activity = keptActivity(
        activity,
        afterInterrupt(
          await paneActivity(host, paneId, await readsOf(host, host.readAgentActivity).read(nonce)),
          interruptSettled.get(paneId),
        ),
      )
      if (activity) activityOf.set(paneId, activity)
      else activityOf.delete(paneId)
    }
    /*
     * The CLI's own hook is certain where the count is a guess: a turn that
     * began after the last keystroke means the line was sent, whatever key
     * emptied it. Heals a count left too high by Ctrl+K, a vim command, or
     * any key `typed-line.ts` does not know — for every CLI that has the hook.
     */
    if (activity?.state === "busy") {
      const submittedAt = activity.at
      records.typed.update(paneId, (line) => submittedSince(line, submittedAt))
    }
    return isFree(
      {
        hooked: isHooked,
        permissionPending: questionOpen(paneId),
        // A line the user began is not the agent being busy, but it is just
        // as much a reason not to type: see `session/typing.ts`.
        typing: isTyping(records.typed.get(paneId)),
        ...(activity ? { activity } : {}),
        ...(lastOutputAt.has(paneId) ? { lastOutputAt: lastOutputAt.get(paneId)! } : {}),
      },
      Date.now(),
    )
  }

  /** Messages taken from the outbox and not delivered yet, oldest first. */
  const mailQueue: { id: string; message: Message; at: number }[] = []

  /*
   * A `send` the voice agent wrote is held here until the user says yes out
   * loud (rilievo 20). `requested` keeps the question from being asked twice
   * while the message waits in the queue on the next passes.
   */
  const voiceSendDecisions = new Map<string, "approved" | "rejected">()
  const voiceSendRequested = new Set<string>()

  /*
   * What survives a restart, in localStorage: the requests still waiting for
   * an answer, and which session started which with `spawn`. Pane ids survive
   * a restore, so both still point at the right panes afterwards.
   */
  const REQUESTS_KEY = "ade.mailbox.requests"
  const SPAWNED_KEY = "ade.mailbox.spawned"
  const KV_KEY = "ade.mailbox.kv"
  const readStored = (key: string): string | null => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  const writeStored = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch {}
  }

  /** The `ask` and `spawn` requests still waiting for a reply. */
  const openRequests = new Map<string, OpenRequest>(
    parseOpenRequests(readStored(REQUESTS_KEY)).map((request) => [request.id, request]),
  )
  const saveRequests = () => writeStored(REQUESTS_KEY, JSON.stringify([...openRequests.values()]))

  /*
   * Native handoffs still in the sender's hands, replayed after a restart.
   * The review's serious loss: a `send` booked natively, ADE closed before the
   * sender's `delivered`, and at reopening no clock, no fallback, no trace.
   * Loaded here, they run into the same clock as live ones on the first pass
   * of `settleHandoffs`: one older than the limit is typed, marked as a
   * possible repeat; a younger one keeps waiting for the sender's word.
   */
  const HANDOFFS_KEY = "ade.mailbox.handoffs"
  for (const handoff of parseHandoffs(readStored(HANDOFFS_KEY))) handoffs.set(handoff.id, handoff)
  saveHandoffs = () => writeStored(HANDOFFS_KEY, JSON.stringify([...handoffs.values()]))

  /** Long messages left in an inbox and not yet read (S20). */
  const INBOX_KEY = "ade.mailbox.inbox"
  const inboxPending: InboxEntry[] = parseInbox(readStored(INBOX_KEY))
  const saveInbox = () => writeStored(INBOX_KEY, JSON.stringify(inboxPending))

  /* The mail queued for suspended sessions (P1-C6), read back once the panes are restored. */
  const SUSPENDED_MAIL_KEY = "ade.mailbox.suspended"
  const paneExists = (paneId: string) => wb().panes.some((pane) => pane.id === paneId)
  const saveSuspendedMail = () =>
    writeStored(SUSPENDED_MAIL_KEY, JSON.stringify(suspendedMailToSave(heldLines, paneExists)))

  /**
   * Types `line` into `paneId`, or leaves it in the pane's inbox and types a bell.
   *
   * Only a line too long to type safely goes to the inbox (`goesToInbox`); a
   * host without the inbox, or a write that fails, types it as before. False
   * when the session went away.
   */
  const deliverText = async (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
    paneId: string,
    line: string,
    meta: InboxMeta,
    /** What the inbox file holds when it differs from the typed line: the same text with its line breaks. */
    full: string = line,
  ): Promise<DeliveryResult> => {
    const session = running.get(paneId)
    if (!session) return "closed"
    // A prompt open now takes no text at all: the message waits for it to go (`deliveryResult`).
    if (questionOpen(paneId)) return "held"
    // Given even when a prompt held its Enter back; the sender is told it is waiting.
    const given = (outcome: LineOutcome, stored = false) => {
      if (outcome === "typed-no-enter" && meta.from) {
        appendLine(
          meta.from,
          t("note.enterHeldFor", mailPanes().find((pane) => pane.id === paneId)?.title ?? paneId),
          "note",
          "ade",
        )
      }
      return deliveryResult(outcome, running.get(paneId) === session, stored)
    }
    if (!goesToInbox(line) || !host.mailboxInboxPut || !host.mailboxInboxRead)
      return given(await typeLineOutcome(session, line))
    const at = Date.now()
    const entry: InboxEntry = {
      id: meta.id,
      paneId,
      name: inboxName(meta.id, at),
      from: meta.from,
      kind: meta.kind,
      chars: full.length,
      at,
      ringAt: at,
      rings: 0,
    }
    const stored = await host.mailboxInboxPut(paneId, entry.name, full).then(
      () => true,
      () => false,
    )
    if (!stored) return given(await typeLineOutcome(session, line))
    inboxPending.push(entry)
    saveInbox()
    return given(
      await typeLineOutcome(
        session,
        formatBell(
          entry,
          mailPanes().find((pane) => pane.id === meta.from),
          line.length,
        ),
      ),
      true,
    )
  }

  /** A notice for whoever sent a message: its session, or the window's notices when none is behind it (`noticeTarget`). */
  const tellSender = (from: string | undefined, text: string) => {
    const target = noticeTarget(from, (paneId) => running.has(paneId))
    if (target === "window") report(text, "info")
    else if (target) heldLines.push({ paneId: target.pane, text })
  }

  /** Rings again for unread inbox messages, and tells the sender of one never read. */
  const followInbox = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, now: number) => {
    if (!host.mailboxInboxRead || inboxPending.length === 0) return
    let changed = false
    for (const entry of [...inboxPending]) {
      const session = running.get(entry.paneId)
      const state = session
        ? await host.mailboxInboxRead(entry.paneId, entry.name).catch(() => "unread" as const)
        : "unread"
      if (state === "lost") {
        /*
         * Gone before it was read: said as lost, to the sender and, for a
         * request, to whoever waits on it, so nobody believes it arrived. A
         * file the reader moved is "read"; only a file in neither place is this.
         */
        inboxPending.splice(inboxPending.indexOf(entry), 1)
        const reader = mailPanes().find((pane) => pane.id === entry.paneId)
        appendLine(entry.paneId, t("note.inboxLost", entry.id), "note", "ade")
        if (entry.kind === "ask" || entry.kind === "spawn") {
          if (openRequests.has(entry.id)) await settle(host, entry.id, formatLost(entry, reader))
        } else {
          tellSender(entry.from, formatLost(entry, reader))
        }
        changed = true
        continue
      }
      const read = state === "read"
      const free = session && !read ? await freeNow(host, entry.paneId) : false
      const action = inboxAction(
        entry,
        { running: Boolean(session), free, read, typing: isTyping(records.typed.get(entry.paneId)) },
        now,
      )
      if (action === "wait") continue
      const panes = mailPanes()
      if (action === "tell") {
        entry.told = true
        tellSender(
          entry.from,
          formatHeld(
            entry,
            panes.find((pane) => pane.id === entry.paneId),
          ),
        )
        changed = true
        continue
      }
      if (action === "ring" && session) {
        entry.rings += 1
        entry.ringAt = now
        void typeLine(
          session,
          formatBell(
            entry,
            panes.find((pane) => pane.id === entry.from),
            entry.chars,
          ),
        )
        appendLine(entry.paneId, t("note.rang", entry.rings), "note", "ade")
      } else {
        inboxPending.splice(inboxPending.indexOf(entry), 1)
        if (action === "warn") {
          tellSender(
            entry.from,
            formatUnread(
              entry,
              panes.find((pane) => pane.id === entry.paneId),
            ),
          )
        }
      }
      changed = true
    }
    if (changed) saveInbox()
  }
  /*
   * Restored requests count their grace from now, not from when they were
   * made: their sessions are being reopened, and "not running" during that is
   * not "closed".
   */
  const loadedAt = Date.now()

  /** Sessions started with `spawn`: pane id → the pane that started it, the only one that may close it. */
  const spawnedBy = new Map<string, string>(
    (() => {
      try {
        const raw: unknown = JSON.parse(readStored(SPAWNED_KEY) ?? "{}")
        return raw && typeof raw === "object"
          ? Object.entries(raw as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            )
          : []
      } catch {
        return []
      }
    })(),
  )
  const saveSpawned = () => writeStored(SPAWNED_KEY, JSON.stringify(Object.fromEntries(spawnedBy)))

  /** The shared key-value store, one space per project name. See `session/shared.ts`. */
  let kvStore = parseKvStore(readStored(KV_KEY))
  const saveKv = () => writeStored(KV_KEY, JSON.stringify(kvStore))

  /** Token usage per pane, from each session's transcript, for `ade-msg stats`. */
  const usageOf = new Map<string, TokenUsage>()
  let publishedStats = ""
  const refreshUsage = async () => {
    const host = await getHost()
    if (!host?.transcriptUsage || !host.mailboxPublish) return
    const rows: { title: string; agent: string; project?: string; usage: TokenUsage }[] = []
    for (const pane of wb().panes) {
      const agent = pane.agent ?? pane.model
      if ((agent !== "claude-code" && agent !== "codex") || !pane.resumeId || !pane.cwd || isRemoteRoot(pane.cwd))
        continue
      const usage = await host.transcriptUsage(agent, pane.resumeId, pane.cwd)
      if (usage) usageOf.set(pane.id, usage)
      const known = usageOf.get(pane.id)
      if (known) rows.push({ title: pane.title, agent, project: pane.workspaceId, usage: known })
    }
    const table = statsTable(rows)
    if (table !== publishedStats) {
      publishedStats = table
      await host.mailboxPublish(table, "stats").catch(() => {})
    }
  }

  /** When each pane last printed anything: a session silent for a while has stopped working. */
  const lastOutputAt = new Map<string, number>()
  /** When anything was last typed or sent into each pane: the output after it is its echo. */
  const lastInputAt = new Map<string, number>()
  /** Each idle pane's run of windows with output (`session/output-activity.ts`). */
  const outputRuns = new Map<string, OutputRun>()

  /** Each running pane's hook nonce, and the last turn start or end its hook reported. */
  const paneNonces = new Map<string, string>()
  /*
   * The nonce of a pane's previous spawn, while this one's file is silent: a
   * Prime worker that outlived ADE still writes under it (`activityOrFormer`).
   */
  const formerNonces = new Map<string, string>()
  /** A pane's activity from this spawn's file, or from the previous spawn's while this one is silent. */
  const paneActivity = async (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
    paneId: string,
    text: string | null,
  ): Promise<Activity | undefined> => {
    const resumeId = wb().panes.find((pane) => pane.id === paneId)?.resumeId
    const former = formerNonces.get(paneId)
    // This spawn speaks: the old file has nothing more to say.
    if (text !== null) formerNonces.delete(paneId)
    const formerText =
      text === null && former && resumeId && host.readAgentActivity
        ? await readsOf(host, host.readAgentActivity).read(former)
        : null
    return activityOrFormer(text, formerText, resumeId)
  }
  const activityOf = new Map<string, Activity>()
  /**
   * When ADE last saw a question in each pane open or close by itself, without
   * the hook: a hook written before that is older news (`statusFromActivity`).
   */
  const questionSeenAt = new Map<string, number>()
  /** When each pane was last interrupted by an Esc or a Ctrl-C, typed or sent by `ade-msg interrupt`. */
  const interruptedAt = new Map<string, number>()
  /** The interruption that last ended a hooked pane's turn: older hook reads are its idle (`afterInterrupt`). */
  const interruptSettled = new Map<string, number>()
  const hooked = (paneId: string) => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    return paneNonces.has(paneId) && reportsTurns(pane?.agent ?? pane?.model ?? "")
  }

  /*
   * Whether a question is open in a pane, and so nothing may be typed into it or
   * Entered into it: the prompt the screen found, or the one a `Notification` hook
   * reported (`isQuestionOpen`, which says why both are needed).
   *
   * Every place that holds a line, an Enter or a nudge back asks this, and not one
   * of the two sources alone. Reading only the screen is what the first version of
   * the hook did, and it is a hole the size of the thing the hook was added for: the
   * prompt the reading does not recognise — an option list, a live-updating counter,
   * a frame that changed since the pane was sampled — is precisely the prompt a
   * delivery then Enters over, confirming whichever choice was selected. The nudge
   * after 45 s of silence, the re-ring, the Enter of `confirmSubmitted`, the line's
   * own Enter, the free test, the held line, the target of a request, the cancel
   * note, the suspension and the voice alert all come through here. The first time
   * this was reviewed the miss was in `isFree` alone, and the Architect says he had
   * missed the rest here too on the first pass.
   */
  const questionOpen = (paneId: string) => isQuestionOpen(permissions()[paneId], activityOf.get(paneId))

  /*
   * One secret per spawn, in that process tree's environment only. A pane id
   * is public — `ade-msg list` prints them — so a `from` counts as the sender
   * only when the token that came with it is this pane's.
   */
  const paneTokens = new Map<string, string>()
  const mintPaneToken = (paneId: string) => {
    const token = newNonce()
    paneTokens.set(paneId, token)
    return token
  }

  /** How long a reply may sit unclaimed before it is typed into the caller instead. */
  const CLAIM_WINDOW_MS = 3000
  /** How long a session that replied with `--close` keeps running, so its own `ade-msg reply` can finish. */
  const AUTO_CLOSE_DELAY_MS = 2500

  // Nor an app run as a server (T3 Code): an agent asking for help wants another agent.
  const SPAWNABLE = AGENTS.filter((agent) => agent.id !== "terminal" && agent.kind !== "app")

  /*
   * The quota rule for spawn (S9, `session/quota-pick.ts`).
   *
   * The report is read again at the moment of the spawn rather than taken from
   * the last tick: a choice of agent made on a reading thirty seconds old can
   * send work to a provider that has just run out. No timer is started on the
   * picker's account, and a read that hangs gives up rather than hold the spawn.
   */
  setProviderPicker(async (input) => {
    const store = await freshSharedQuota()
    return pickByQuota(input, store.snapshot(), store.now())
  })
  onCleanup(() => setProviderPicker())

  /** The cap on sessions `spawn` keeps open at once; `ade.mailbox.maxSpawned` in localStorage overrides it. */
  const maxSpawned = () => {
    const stored = Number(readStored("ade.mailbox.maxSpawned"))
    return Number.isInteger(stored) && stored > 0 ? stored : DEFAULT_MAX_SPAWNED
  }

  const targetOf = (request: OpenRequest) => ({
    running: running.has(request.to),
    suspended: isSuspendedPane(request.to),
    permissionPending: questionOpen(request.to),
    lastOutputAt: lastOutputAt.get(request.to),
    activity: activityOf.get(request.to),
    hooked: hooked(request.to),
    waitingOnOthers: [...openRequests.values()].some((other) => other.from === request.to),
    // A line the user began there: nothing is typed over it (the reminders and the time notes).
    typing: isTyping(records.typed.get(request.to)),
    ...(folderChanges.has(request.to) ? { lastWriteAt: folderChanges.get(request.to)!.changedAt } : {}),
  })

  /*
   * Whether a long turn is changing its folder, for "forse bloccata" (S21).
   *
   * Looked at only for a session already busy half the wedge time, and at
   * most every five minutes: a `git status` snapshot, and the time it last
   * differed. The first look counts from the start of the turn, so a turn
   * that has written nothing since its baseline reads as silent.
   */
  const folderChanges = new Map<string, { snapshot: string; changedAt: number; checkedAt: number }>()
  const watchFolders = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, now: number) => {
    if (!host.run) return
    for (const request of openRequests.values()) {
      const activity = activityOf.get(request.to)
      if (activity?.state !== "busy" || now - activity.at < WEDGE_MS / 2) {
        folderChanges.delete(request.to)
        continue
      }
      const seen = folderChanges.get(request.to)
      if (seen && now - seen.checkedAt < 5 * 60_000) continue
      const pane = wb().panes.find((candidate) => candidate.id === request.to)
      const dir = pane?.worktree ?? pane?.cwd
      if (!dir) continue
      const status = await host.run("git", ["status", "--porcelain"], dir).catch(() => undefined)
      if (!status || status.code !== 0) continue
      const snapshot = status.stdout
      folderChanges.set(request.to, {
        snapshot,
        checkedAt: now,
        changedAt: !seen ? activity.at : seen.snapshot !== snapshot ? now : seen.changedAt,
      })
    }
  }

  /** Open decisions from the team board's `status/*.log`, read at most once a minute. */
  let decisions: OpenDecision[] = []
  let decisionsReadAt = 0
  const readDecisions = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, now: number) => {
    const current = project()
    if (now - decisionsReadAt < 60_000 || !current || current.remote || !host.readDir || !host.readTextFile) return
    decisionsReadAt = now
    const logs: { spec: string; text: string }[] = []
    for (const board of boardCandidates(current.root)) {
      const dir = `${board.replace(/[\\/][^\\/]+$/, "")}/status`
      const entries = await host.readDir(dir).catch(() => [])
      for (const entry of entries) {
        if (entry.is_dir || !entry.name.endsWith(".log")) continue
        const text = await host
          .readTextFile(entry.path)
          .then((read) => read.text)
          .catch(() => "")
        logs.push({ spec: entry.name.slice(0, -4), text })
      }
      if (entries.length) break
    }
    decisions = openDecisions(logs)
  }

  /*
   * The branch a session shows is the one it is working on.
   *
   * It used to be the launch folder's forever, so a session that moved into a
   * worktree kept showing the main tree's branch. The hook reports the
   * agent's working directory each turn; when it changes, its branch is
   * asked of git once and put on the pane. Sessions without hooks keep the
   * branch they were started with, which for a `spawn --worktree` already is
   * the worktree's.
   */
  const cwdSeen = new Map<string, string>()
  const followCwd = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, paneId: string, cwd: string) => {
    const seen = cwdSeen.get(paneId)
    if (seen !== undefined && sameDir(seen, cwd)) return
    cwdSeen.set(paneId, cwd)
    const result = await host.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => undefined)
    const branch = result && result.code === 0 ? result.stdout.trim() : ""
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (!pane || !branch || branch === "HEAD" || pane.tree?.branch === branch) return
    setWb((w) => updatePane(w, paneId, { tree: { branch, fidelity: "full", note: `Lavora in ${cwd}` } }))
  }

  /** When each pane was last set working, so an older idle from its hook does not end the new turn. */
  const workingSince = new Map<string, number>()
  const markWorking = (paneId: string) => {
    workingSince.set(paneId, Date.now())
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (pane?.status === "idle") setWb((w) => updatePane(w, paneId, { status: "working", activity: "running" }))
    settleWhenQuiet(paneId)
  }

  /*
   * A line submitted by the user in the pane: Enter in the terminal, or the composer.
   *
   * It went straight to working without `workingSince`, so on the next mail
   * pass the previous turn's Stop counted as newer than the turn just typed and
   * set the pane idle again, until `UserPromptSubmit` came: a flicker of a
   * second or so on every Enter in a hooked Claude Code.
   *
   * An Enter into a prompt only the hook reported is its answer: see `promptAnswered`.
   */
  const turnSubmitted = (paneId: string) => {
    promptAnswered(paneId)
    markWorking(paneId)
  }

  /*
   * A key typed into a prompt only the hook reported: its answer.
   *
   * The screen reading, which closes the prompts it finds, never had this one,
   * and the hook says nothing until the turn ends: without this the pane stayed
   * on «Permesso» for the rest of the turn, after a «1» as after an Enter. The
   * hook's `permission` still keeps mail out until its next write
   * (`isQuestionOpen`); only the status moves.
   */
  const promptAnswered = (paneId: string) => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (pane?.status !== "waiting" || permissions()[paneId] || activityOf.get(paneId)?.state !== "permission") return
    questionSeenAt.set(paneId, Date.now())
    setWb((w) => updatePane(w, paneId, { status: "working", activity: "running" }))
  }

  /*
   * The turn activity of every running session with hooks, each mail pass.
   *
   * Not only of those that owe an answer: the status in the sidebar and in
   * `ade-msg list` comes from here, and a session is at work whoever started
   * its turn. One small file read per hooked session.
   */
  const readActivities = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>) => {
    if (!host.readAgentActivity) return
    const hookedPanes = [...running.keys()].flatMap((paneId) => {
      const nonce = paneNonces.get(paneId)
      return nonce && hooked(paneId) ? [{ paneId, nonce }] : []
    })
    const texts = await readsOf(host, host.readAgentActivity).readAll(hookedPanes.map((entry) => entry.nonce))
    for (const [index, { paneId }] of hookedPanes.entries()) {
      const pane = wb().panes.find((candidate) => candidate.id === paneId)
      const read = afterInterrupt(await paneActivity(host, paneId, texts[index] ?? null), interruptSettled.get(paneId))
      if (!read) {
        // Gone or unreadable: a busy stays busy, an old idle would let mail in mid-turn.
        const kept = keptActivity(activityOf.get(paneId), read)
        if (kept) activityOf.set(paneId, kept)
        else activityOf.delete(paneId)
        continue
      }
      const activity = read
      activityOf.set(paneId, activity)
      if (activity.cwd && pane) void followCwd(host, pane.id, activity.cwd)
      if (permissions()[paneId] && hookClosesScreenPrompt(activity, questionSeenAt.get(paneId))) {
        permissions.forget(paneId)
        // What is still in the window was answered: not to be found again on the next line.
        rawWindows.forget(paneId)
        if (voiceEngine.isRunning()) void voiceEngine.handlePermissionResolved(paneId)
      }
      const next = pane
        ? statusFromActivity(pane.status, activity, workingSince.get(paneId), questionSeenAt.get(paneId))
        : undefined
      if (next === "waiting") {
        setWb((w) => updatePane(w, paneId, { status: "waiting", activity: "permission" }))
      } else if (next === "working") {
        panels.newTurn(paneId, activity.at)
        workingSince.set(paneId, Date.now())
        setWb((w) => updatePane(w, paneId, { status: "working", activity: "running" }))
      } else if (next === "idle") {
        setWb((w) => updatePane(w, paneId, { status: "idle", activity: "ready" }))
      }
    }
  }
  const stateOf = (request: OpenRequest, now = Date.now()) =>
    requestState({ ...request, at: Math.max(request.at, loadedAt) }, targetOf(request), now)

  /** The last state written for each request, so a waiter hears about changes only. */
  const statesWritten = new Map<string, string>()
  let publishedRequests = ""

  /** Ends a request: its waiter gets `result`, and nothing about it is kept. */
  const settle = async (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
    id: string,
    result?: string,
  ): Promise<boolean> => {
    /*
     * The answer first, the closing after. Closing first meant a result that
     * failed to be written left a closed request and, since a closed request
     * takes no second answer, no way to send it again. Now a failed write
     * leaves the request open, and the replier is told to try again.
     */
    if (result !== undefined && host.mailboxResult) {
      try {
        await host.mailboxResult(id, result)
      } catch {
        return false
      }
    }
    const answering = openRequests.get(id)?.to
    openRequests.delete(id)
    saveRequests()
    /*
     * The answer is what ends the turn for a session without turn hooks: with
     * the request gone, `holdsForAnswer` stops holding it at work, and the
     * quiet that follows the reply settles it back to "Disponibile" (S14).
     */
    if (answering) settleWhenQuiet(answering)
    statesWritten.delete(id)
    await host.mailboxState?.(id, "").catch(() => {})
    return true
  }

  /** How deep sessions may start sessions; `ade.mailbox.maxDepth` in localStorage overrides it. */
  const maxDepth = () => {
    const stored = Number(readStored("ade.mailbox.maxDepth"))
    return Number.isInteger(stored) && stored > 0 ? stored : DEFAULT_MAX_DEPTH
  }
  const parentOf = (paneId: string) => spawnedBy.get(paneId)

  /**
   * Why a session's worktree cannot be thrown away yet, or nothing.
   *
   * What firstmate learned the hard way: a worker is torn down when its work
   * has landed, not when it says it is done. Uncommitted changes, or commits
   * on its branch the project's branch does not have, are work that closing
   * would strand.
   */
  const unintegrated = async (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
    paneId: string,
  ): Promise<string | undefined> => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (!pane?.worktree || !host.run) return undefined
    const status = await host.run("git", ["status", "--porcelain"], pane.worktree)
    if (status.code === 0 && status.stdout.trim())
      return `"${pane.title}" ha modifiche non committate in ${pane.worktree}`
    const branch = pane.tree?.branch
    const root = (await projectOfPane(host, paneId))?.root
    if (branch && root) {
      const merged = await host.run("git", ["branch", "--list", branch, "--merged"], root)
      if (merged.code === 0 && !merged.stdout.trim())
        return `"${pane.title}" ha commit sul branch ${branch} non ancora integrati`
    }
    return undefined
  }

  /**
   * Closes a spawned session and every session below it, or says why not.
   *
   * Refused when any of them has work not yet integrated, unless forced. A
   * worktree whose work is integrated is removed; one closed by force stays on
   * disk with its branch, because closing a session must never delete work.
   */
  const closeTree = async (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
    paneId: string,
    force: boolean,
  ): Promise<{ closed: string[]; kept: string[]; asking: string[] } | { error: string }> => {
    const ids = [...descendants(paneId, spawnedBy), paneId].filter((id) => wb().panes.some((pane) => pane.id === id))
    const blocked = new Map<string, string>()
    for (const id of ids) {
      const reason = await unintegrated(host, id)
      if (reason) blocked.set(id, reason)
    }
    if (blocked.size > 0 && !force) {
      return {
        error: `non chiudo: ${[...blocked.values()].join("; ")}. Integra o committa prima, oppure usa --force (la worktree resta su disco)`,
      }
    }
    const closed: string[] = []
    const kept: string[] = []
    const asking: string[] = []
    for (const id of ids) {
      const pane = wb().panes.find((candidate) => candidate.id === id)
      if (!pane) continue
      // An unsaved file waits on the user's answer, and may be kept: not «closed» (review F-confirm, BASSO 1).
      if (buffers()[id]?.dirty) {
        close(id)
        asking.push(pane.title)
        continue
      }
      for (const request of [...openRequests.values()]) {
        if (request.to === id)
          await settle(
            host,
            request.id,
            `[ade-msg] richiesta ${request.id} interrotta: la sessione "${pane.title}" è stata chiusa`,
          )
      }
      spawnedBy.delete(id)
      close(id)
      closed.push(pane.title)
      if (pane.worktree) {
        const root = (await projectOfPane(host, id))?.root
        if (!blocked.has(id) && root && host.run) {
          const removed = await host.run("git", ["worktree", "remove", pane.worktree], root)
          if (removed.code !== 0) kept.push(pane.worktree)
        } else {
          kept.push(pane.worktree)
        }
      }
    }
    saveSpawned()
    return { closed, kept, asking }
  }

  /** Makes sure `.ade/` (where subagents put long results) is ignored by git in this project. */
  const excludeAdeResults = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, root: string) => {
    if (!host.run || !host.readTextFile || !host.writeTextFile) return
    const common = await host.run("git", ["rev-parse", "--git-common-dir"], root)
    if (common.code !== 0) return
    const dir = common.stdout.trim()
    const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(dir) ? dir : `${root}/${dir}`
    const file = `${absolute}/info/exclude`
    const current = await host
      .readTextFile(file)
      .then((read) => read.text)
      .catch(() => "")
    const next = excludeWithAde(current)
    if (next !== undefined) await host.writeTextFile(file, next).catch(() => null)
  }

  const deliverPending = async () => {
    const host = await getHost()
    if (!host?.mailboxTake || !host.mailboxReceipt) return
    for (const { id, body } of await host.mailboxTake().catch(() => [])) {
      const parsed = parseMessage(body)
      // A pane's token, or a background turn's (voice agent, bot) registered for its length.
      const message =
        parsed && verifySender(parsed, (paneId) => (running.has(paneId) ? paneTokens.get(paneId) : senderToken(paneId)))
      if (message) mailQueue.push({ id, message, at: Date.now() })
      else await host.mailboxReceipt(id, "errore: messaggio non valido").catch(() => {})
    }

    for (const item of [...lateReplies]) {
      if (!running.has(item.callerId)) {
        lateReplies.splice(lateReplies.indexOf(item), 1)
      } else if (await freeNow(host, item.callerId)) {
        lateReplies.splice(lateReplies.indexOf(item), 1)
        const text = await host.mailboxResultReclaim?.(item.ref).catch(() => null)
        if (text != null) {
          heldLines.push({
            paneId: item.callerId,
            text: formatLateReply(item.ref, text, item.sender),
            full: formatLateReply(item.ref, text, item.sender, { keepLines: true }),
            inbox: { id: item.ref, kind: "reply", from: item.from },
          })
        }
      }
    }

    for (const item of [...heldLines]) {
      const session = running.get(item.paneId)
      if (!session) {
        // A suspended session keeps its mail until the user resumes it, and until it is typed.
        if (keptWithoutProcess(item, { exists: paneExists(item.paneId), suspended: isSuspendedPane(item.paneId) }))
          continue
        heldLines.splice(heldLines.indexOf(item), 1)
        if (item.suspended) saveSuspendedMail()
      } else if (!typesMailInto(agentOfPane(item.paneId))) {
        // A shell runs what is typed: the line is shown in the pane as a notice and never given to it.
        heldLines.splice(heldLines.indexOf(item), 1)
        if (item.suspended) saveSuspendedMail()
        tellPane(item.paneId, t("note.mailNotTyped", asOneLine(item.text).slice(0, 160)))
      } else if (await freeNow(host, item.paneId)) {
        heldLines.splice(heldLines.indexOf(item), 1)
        if (item.suspended) saveSuspendedMail()
        // Not typed while the session is still there (a prompt opened): back among the held lines.
        void (
          item.inbox
            ? deliverText(host, item.paneId, item.text, item.inbox, item.full).then((result) => {
                // Queued while suspended: the request reached the session now, and its clock starts now.
                const request =
                  item.suspended && item.inbox?.kind === "ask" && result === "given"
                    ? openRequests.get(item.inbox.id)
                    : undefined
                if (request) {
                  request.at = request.deliveredAt = Date.now()
                  saveRequests()
                }
                return result === "held"
              })
            : typeLineOutcome(session, item.text).then(
                (outcome) => deliveryResult(outcome, running.get(item.paneId) === session) === "held",
              )
        ).then((again) => {
          if (!again) return
          heldLines.push(item)
          if (item.suspended) saveSuspendedMail()
        })
      } else if (
        !item.told &&
        item.inbox?.from &&
        item.inbox.from !== item.paneId &&
        isTyping(records.typed.get(item.paneId))
      ) {
        // Replies and updates too, not only what went to the inbox: the
        // sender is told at once, and once, why this is not arriving.
        item.told = true
        if (running.has(item.inbox.from)) {
          const reader = mailPanes().find((pane) => pane.id === item.paneId)
          heldLines.push({ paneId: item.inbox.from, text: formatHeld(item.inbox, reader), told: true })
        }
      }
    }

    for (const item of [...mailQueue]) {
      const done = await deliverOne(host, item.id, item.message)
      if (done) mailQueue.splice(mailQueue.indexOf(item), 1)
    }

    /*
     * Minimised (P1-C1): the messages above move on every pass; what follows —
     * activity, open requests and their reminders, the inbox — only keeps
     * watch, and runs once every `HIDDEN_WATCH_MS` until the window is back.
     */
    if (!watchDue(pageHidden(), Date.now(), watchedAt)) return
    watchedAt = Date.now()
    await readActivities(host)
    const now = Date.now()
    const panes = mailPanes()
    await watchFolders(host, now)
    await readDecisions(host, now)
    for (const request of [...openRequests.values()]) {
      /*
       * Still in the sender's hands: nothing was typed, so there is nothing to
       * re-ring, and a reminder now would only open a turn in the target
       * before the message — the live test saw that reminder pass for a
       * delivery. The clock in `settleHandoffs` is what happens next.
       */
      if (handoffs.has(request.id)) continue
      const state = stateOf(request, now)
      // A request whose answerer is gone will never be answered; the caller is told, not left waiting.
      if (state === "sessione chiusa") {
        const title = wb().panes.find((pane) => pane.id === request.to)?.title ?? request.to
        await settle(
          host,
          request.id,
          `[ade-msg] errore: la sessione "${title}" si è chiusa senza rispondere alla richiesta ${request.id}`,
        )
        continue
      }
      if (state === "forse bloccata" && !request.wedgeWarned) {
        request.wedgeWarned = true
        saveRequests()
        if (request.from && running.has(request.from)) {
          heldLines.push({
            paneId: request.from,
            text: formatWedged(
              request,
              panes.find((pane) => pane.id === request.to),
              now,
            ),
          })
        }
        tellPane(request.to, t("pane.maybeStuck", request.id))
      }
      if (statesWritten.get(request.id) !== state) {
        statesWritten.set(request.id, state)
        /* "in corso" is what every request is; printing it tells the waiter nothing. Empty removes the file. */
        await host.mailboxState?.(request.id, state === "in corso" ? "" : state).catch(() => {})
      }
      const session = running.get(request.to)
      /*
       * The budget (D73): half-way and at the end, one line each, typed like
       * the reminders. Information for whoever works: it closes nothing and
       * leaves the reminders below as they were.
       */
      // Not over a line begun there, nor over a permission prompt (B1): not given either, so it comes on a later round.
      const timeNote = session ? timeNoteFor(request, now, targetOf(request)) : undefined
      if (session && timeNote) {
        // Counted now, so the next round does not queue it twice; given back if a draft stopped it.
        const before = request.timeNotes
        request.timeNotes = timeNote
        saveRequests()
        void typeLine(session, formatTimeNote(request, now, timeNote), { unlessBusy: true }).then((typed) => {
          if (typed || request.timeNotes !== timeNote) return
          request.timeNotes = before
          saveRequests()
        })
      }
      // Typed, and no turn began: the line is sitting in the input box. One more Enter sends it.
      if (session && !isTyping(records.typed.get(request.to)) && shouldRering(request, targetOf(request), now)) {
        void ringAgain(request, () => pressAgain(request.to, session), saveRequests).then((pressed) => {
          if (pressed) appendLine(request.to, t("note.resentRequest", request.id), "note", "ade")
        })
        continue
      }
      // Finished, gone quiet, and never replied: reminded, so the caller is not left to its timeout.
      if (session && shouldNudge(request, targetOf(request), now)) {
        // Counted now, so the next round does not queue it twice; given back if a draft stopped it.
        const before = { nudges: request.nudges, nudgedAt: request.nudgedAt }
        request.nudges = (request.nudges ?? 0) + 1
        request.nudgedAt = now
        saveRequests()
        void typeLine(
          session,
          formatNudge(
            request.id,
            panes.find((pane) => pane.id === request.from),
          ),
          { unlessBusy: true },
        ).then((typed) => {
          if (typed) return appendLine(request.to, t("note.nudged", request.id), "note", "ade")
          if (request.nudgedAt !== now) return
          request.nudges = before.nudges
          request.nudgedAt = before.nudgedAt
          saveRequests()
        })
      }
    }

    await followInbox(host, now)
    await flushPanelReplies(host)
    settleHandoffs(now)
    refreshMailWaiting()

    const table = requestsTable([...openRequests.values()], panes, (request) => stateOf(request, now), now, decisions)
    if (table !== publishedRequests) {
      publishedRequests = table
      await host.mailboxPublish?.(table, "requests").catch(() => {})
    }
  }

  /** Delivers one message; false leaves it queued for the next pass. */
  /**
   * A `send` or `ask` to a suspended session (P1-C6): queued among the held
   * lines, to be typed once the user resumes it, and the sender told at once.
   * An `ask` stays open, in the state "sessione sospesa"; a caller blocked in
   * `ade-msg ask` is woken with the same words instead of waiting it out.
   */
  const queueForSuspended = async (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
    id: string,
    message: Extract<Message, { kind: "send" | "ask" }>,
    target: MailPane,
    sender: MailPane | undefined,
    receipt: string,
  ): Promise<true> => {
    const ask = message.kind === "ask"
    const targetPane = wb().panes.find((pane) => pane.id === target.id)
    const context = {
      ...(targetPane?.cwd ? { resultsDir: resultsDir(targetPane.cwd) } : {}),
      depth: depthOf(target.id, parentOf),
      maxDepth: maxDepth(),
      ...(ask && message.budget ? { budget: message.budget } : {}),
    }
    const line = ask ? formatRequest(id, message.text, sender, context) : formatDelivery(message, sender)
    const full = ask
      ? formatRequest(id, message.text, sender, { ...context, keepLines: true })
      : formatDelivery(message, sender, { keepLines: true })
    heldLines.push({
      paneId: target.id,
      text: line,
      full,
      inbox: { id, kind: ask ? "ask" : "send", from: message.from },
      suspended: true,
    })
    saveSuspendedMail()
    if (ask) {
      openRequests.set(id, {
        id,
        kind: "ask",
        from: message.from,
        to: target.id,
        at: Date.now(),
        brief: briefOf(message.text),
        via: "digitata",
        ...(message.budget ? { budget: message.budget } : {}),
      })
      saveRequests()
    }
    appendLine(
      target.id,
      t(ask ? "note.askFrom" : "note.messageFrom", sender?.title ?? t("note.someSession"), message.text),
      "note",
      "ade",
    )
    if (sender)
      appendLine(sender.id, t(ask ? "note.askTo" : "note.messageTo", target.title, message.text), "note", "ade")
    heldStates.delete(id)
    // Held before, for a turn that has ended since: its sender was answered then, and stopped listening.
    if (!held.delete(id)) await host.mailboxReceipt!(id, receipt).catch(() => {})
    if (ask) {
      await host
        .mailboxState?.(
          id,
          `${receipt.replace(/^ok: /, "")}; la richiesta ${id} resta aperta: la risposta arriva con ade-msg wait ${id}`,
          "update",
        )
        .catch(() => {})
      // Taken back if nobody woke on it (`--no-wait`): a later `ade-msg wait` waits for the answer, not for this.
      setTimeout(() => void host.mailboxResultReclaim?.(id, "update").catch(() => null), CLAIM_WINDOW_MS)
    }
    return true
  }

  const deliverOne = async (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
    id: string,
    message: Message,
  ): Promise<boolean> => {
    const answer = (text: string) => host.mailboxReceipt!(id, text).catch(() => {})
    const refusal = unverifiedSenderRefusal(message)
    if (refusal) {
      await answer(refusal)
      return true
    }
    const panes = mailPanes()
    const sender = panes.find((pane) => pane.id === message.from)

    /*
     * A message from verified voice never acts unattended (rilievo 20; V1-bis,
     * ALTO 8: every kind that writes or acts, not only `send`): the first pass
     * asks for a spoken yes and leaves it in the queue; the next pass either
     * carries it out or tells the waiting `ade-msg` it was refused. Without a
     * running voice there is nobody to ask, so it is refused rather than
     * carried out in silence.
     */
    const spoken = voiceConfirmationFor(message)
    if (spoken) {
      const decision = voiceSendDecisions.get(id)
      if (decision === "rejected") {
        voiceSendDecisions.delete(id)
        voiceSendRequested.delete(id)
        await answer("errore: invio annullato dall'utente")
        return true
      }
      if (decision !== "approved") {
        if (!voiceSendRequested.has(id)) {
          voiceSendRequested.add(id)
          const asked = await voiceEngine
            .requestSendConfirmation(id, spoken.to, spoken.text, spoken.lead)
            .catch(() => false)
          if (!asked) {
            voiceSendRequested.delete(id)
            await answer("errore: invio rifiutato: la conferma vocale non è disponibile")
            return true
          }
        }
        return false
      }
      voiceSendDecisions.delete(id)
      voiceSendRequested.delete(id)
    }

    if (message.kind === "reply") {
      const request = openRequests.get(message.ref)
      /*
       * Every `ask` and `spawn` is booked here and stays until it is settled,
       * so an id that is not here is closed or was never made. The review
       * found the second reply to a request — the target answering both the
       * native copy and the typed repeat — accepted and overwriting the result
       * file in silence; now it is refused and the replier told.
       */
      if (!request) {
        await answer(
          `errore: la richiesta ${message.ref} non è aperta (già risposta, annullata o mai fatta): questa risposta non è stata consegnata`,
        )
        return true
      }
      if (request.to !== message.from) {
        await answer(`errore: la richiesta ${message.ref} non è stata fatta a questa sessione`)
        return true
      }
      if (!host.mailboxResult) {
        await answer("errore: questa versione di ADE non accetta risposte")
        return true
      }
      /*
       * The answer is the one certain witness of delivery: only a session
       * that has the request can answer it. A sender that forgot its
       * `ade-msg delivered` no longer costs the target a repeat (the live
       * test's scenario E).
       */
      const handoff = handoffs.get(message.ref)
      if (handoff && request && handoff.paneId === message.from) {
        handoff.acked = true
        settleHandoffs(Date.now())
      }
      if (!(await settle(host, message.ref, message.text))) {
        await answer(
          `errore: risposta non scritta, la richiesta ${message.ref} resta aperta: riprova ade-msg reply ${message.ref}`,
        )
        return true
      }
      const caller = request ? panes.find((pane) => pane.id === request.from) : undefined
      if (sender)
        appendLine(
          sender.id,
          caller ? t("note.replySentTo", caller.title, message.ref) : t("note.replySent", message.ref),
          "note",
          "ade",
        )
      if (caller)
        appendLine(caller.id, t("note.replyFrom", sender?.title ?? t("note.someSession"), message.text), "note", "ade")
      await answer(
        `ok: risposta consegnata${caller ? ` a "${caller.title}"` : ""}` +
          (request?.autoClose
            ? " — se non ha lavoro da integrare questa sessione ora si chiude"
            : " — la sessione resta aperta per i seguiti"),
      )
      if (request?.via === "nativa" && caller) {
        lateReplies.push({ ref: message.ref, callerId: caller.id, from: message.from, sender })
        return true
      }
      // Nobody claimed it: the caller stopped waiting, so it is typed in, the way a background subagent reports back.
      setTimeout(() => {
        void host.mailboxResultReclaim?.(message.ref).then((text) => {
          // Held until the caller's turn ends, like every other message.
          if (text != null && caller && running.has(caller.id)) {
            heldLines.push({
              paneId: caller.id,
              text: formatLateReply(message.ref, text, sender),
              inbox: { id: message.ref, kind: "reply", from: message.from },
            })
          }
        })
      }, CLAIM_WINDOW_MS)
      if (request?.autoClose) {
        setTimeout(() => {
          void closeTree(host, request.to, false).then((outcome) => {
            // A pane that should have closed and did not is said over the terminal; one that closed, only in the transcript.
            const say =
              "error" in outcome ? tellPane : (id: string, text: string) => appendLine(id, text, "note", "ade")
            const note =
              "error" in outcome
                ? t("note.keptOpen", outcome.error)
                : t("note.closedAfterReply", outcome.closed.join(", "))
            say(request.to, note)
            if (caller) say(caller.id, note)
          })
        }, AUTO_CLOSE_DELAY_MS)
      }
      return true
    }

    if (message.kind === "update") {
      const request = openRequests.get(message.ref)
      if (!request) {
        await answer(`errore: nessuna richiesta aperta con id ${message.ref}`)
        return true
      }
      if (request.to !== message.from) {
        await answer(`errore: la richiesta ${message.ref} non è stata fatta a questa sessione`)
        return true
      }
      request.update = { state: message.state, text: message.text, at: Date.now() }
      saveRequests()
      const caller = panes.find((pane) => pane.id === request.from)
      const line = formatUpdate(request.id, message.state, message.text, sender)
      await host.mailboxState?.(request.id, line, "update").catch(() => {})
      if (caller)
        appendLine(
          caller.id,
          t("note.updateFrom", sender?.title ?? t("note.someSession"), message.state, message.text),
          "note",
          "ade",
        )
      const elapsed = formatElapsed(request, Date.now())
      await answer(
        `ok: aggiornamento consegnato${caller ? ` a "${caller.title}"` : ""}; la richiesta resta aperta, aspetta la sua risposta${elapsed ? `; ${elapsed}` : ""}`,
      )
      // Nobody woke on it: typed into the caller, which is not waiting any more.
      setTimeout(() => {
        void host.mailboxResultReclaim?.(request.id, "update").then((text) => {
          if (text != null && caller && running.has(caller.id)) {
            heldLines.push({ paneId: caller.id, text, inbox: { id: request.id, kind: "update", from: message.from } })
          }
        })
      }, CLAIM_WINDOW_MS)
      return true
    }

    if (message.kind === "delivered") {
      const handoff = handoffs.get(message.ref)
      if (!handoff) {
        const closed = closedHandoffs.get(message.ref)
        await answer(
          closed === "confermata"
            ? `ok: consegna ${message.ref} già confermata dal turno del destinatario${message.ok ? "" : "; nessun doppione"}`
            : closed === "digitata"
              ? `ok: consegna ${message.ref} già digitata da ADE${message.ok ? ": il destinatario può averla due volte" : ""}`
              : `errore: nessuna consegna nativa in attesa con id ${message.ref}`,
        )
        return true
      }
      if (!message.from || handoff.from !== message.from) {
        await answer("errore: solo chi ha ricevuto la consegna può confermarla")
        return true
      }
      if (message.ok) handoff.acked = true
      else handoff.failed = message.text.trim() || "SendMessage non riuscito"
      settleHandoffs(Date.now())
      await answer(
        message.ok
          ? `ok: consegna ${message.ref} confermata`
          : `ok: ADE digita ${message.ref} nella sessione, con la protezione della riga`,
      )
      return true
    }
    if (message.kind === "cancel") {
      const request = openRequests.get(message.ref)
      if (!request) {
        await answer(`errore: nessuna richiesta aperta con id ${message.ref}`)
        return true
      }
      if (!message.from || request.from !== message.from) {
        await answer("errore: puoi annullare solo le richieste fatte da questa sessione")
        return true
      }
      await settle(host, request.id, `[ade-msg] richiesta ${request.id} annullata`)
      // The session stays: it may have other work, and closing is `ade-msg close`'s decision.
      // Held, like every other note: typed at once it landed mid-turn or inside
      // the user's draft (review area 2). The round types it when the line is free.
      if (running.has(request.to)) heldLines.push({ paneId: request.to, text: formatCancel(request.id, sender) })
      await answer(
        `ok: richiesta ${request.id} annullata; la sessione resta aperta (chiudila con ade-msg close se non serve più)`,
      )
      return true
    }

    if (message.kind === "kv") {
      const space = sender?.project || project()?.name || "workspace"
      const result = applyKv(
        kvStore[space] ?? emptySpace(),
        { op: message.op, key: message.key, value: message.text, ttl: message.ttl, force: message.force },
        sender ? { id: sender.id, title: sender.title } : undefined,
        Date.now(),
        (paneId) => running.has(paneId),
      )
      if (result.space !== kvStore[space]) {
        kvStore = { ...kvStore, [space]: result.space }
        saveKv()
      }
      await answer(result.reply)
      return true
    }

    if (message.kind === "whoowns") {
      const owner = message.from ? await projectOfPane(host, message.from) : project()
      if (!owner || owner.remote || !host.readTextFile) {
        await answer("errore: la bacheca del team si legge solo nei progetti locali")
        return true
      }
      for (const path of boardCandidates(owner.root)) {
        const text = await host
          .readTextFile(path)
          .then((read) => read.text)
          .catch(() => undefined)
        if (text === undefined) continue
        await answer(`ok\n${whoOwns(parseOwners(text), message.text)}`)
        return true
      }
      await answer(`errore: nessuna bacheca del team (${boardCandidates(owner.root).join(" o ")})`)
      return true
    }

    if (message.kind === "memory") {
      const owner = message.from ? await projectOfPane(host, message.from) : project()
      if (!owner || owner.remote) {
        await answer("errore: la memoria condivisa esiste solo per i progetti locali")
        return true
      }
      const path = `${owner.root}/.ade/memory.md`
      const current = host.readTextFile
        ? await host
            .readTextFile(path)
            .then((read) => read.text)
            .catch(() => "")
        : ""
      if (message.op === "show") {
        await answer(current.trim() ? `ok\n${current}` : `ok\n(memoria vuota: ${path})`)
        return true
      }
      if (!sender) {
        await answer("errore: scrivere in memoria richiede una sessione avviata da ADE")
        return true
      }
      const entry = memoryEntry(message.type, message.text, sender.title, new Date())
      if ("error" in entry) {
        await answer(`errore: ${entry.error}`)
        return true
      }
      const next = withMemoryEntry(current, entry.line)
      const failure = host.writeTextFile ? await host.writeTextFile(path, next) : "scrittura non disponibile"
      if (failure) {
        await answer(`errore: ${failure}`)
        return true
      }
      await excludeAdeResults(host, owner.root)
      appendLine(sender.id, t("note.memory", entry.line.trim()), "note", "ade")
      await answer(memoryAddReply(path, next.length))
      return true
    }

    /*
     * `ade-msg registro`: the one writer of the two registers (S75 point 5).
     * `registerWrite` checks, appends and reads back; here only the project,
     * the file and the host's I/O.
     */
    if (message.kind === "registro") {
      const owner = message.from ? await projectOfPane(host, message.from) : project()
      if (!owner || owner.remote || !host.readTextFile) {
        await answer("errore: i registri esistono solo per i progetti locali")
        return true
      }
      const path = message.register === "design" ? designPath(owner.root) : decisionsPath(owner.root)
      const read = async () => {
        try {
          return (await host.readTextFile!(path)).text
        } catch (error) {
          if (/not found|no such file|os error 2|impossibile trovare/i.test(String(error))) return ""
          throw error
        }
      }
      const reply = await registerWrite(
        {
          read,
          append: async (text) =>
            host.appendTextFile
              ? host.appendTextFile(path, text)
              : host.writeTextFile
                ? host.writeTextFile(path, `${await read()}${text}`)
                : "scrittura non disponibile",
          now: () => new Date(),
          sender: registerAuthor(sender?.title, message.from),
          // Verified by the token above: the answer goes back to this pane.
          fromPane: sender ? message.from : undefined,
          agent: wb().panes.find((pane) => pane.id === message.from)?.agent,
          remember: (k, at) => (sender ? askers.remember(path, k, at, message.from) : undefined),
        },
        message,
      )
      if (reply.startsWith("ok"))
        void (message.register === "design" ? designRegister.refresh() : decisionsRegister.refresh())
      // Which project's register, and whether it is the one the button shows (`withPlace`).
      const asked = message.from ? wb().panes.find((pane) => pane.id === message.from) : undefined
      const shown = project()
      await answer(
        withPlace(reply, message.register, {
          written: owner,
          ...(shown ? { shown } : {}),
          ...(asked ? { asked } : {}),
        }),
      )
      return true
    }

    if (message.kind === "spawn") {
      const asked = resolveAgent(SPAWNABLE, message.agent)
      if ("error" in asked) {
        await answer(`errore: ${asked.error}`)
        return true
      }
      /*
       * The quota router may send it to another agent (S9, `provider-pick.ts`).
       * Not for a fork, whose conversation belongs to its CLI, nor when the
       * caller chose a model; an answer ADE cannot start is ignored.
       */
      let agent = asked
      let rerouted: string | undefined
      let quotaNote: string | undefined
      if (mayReroute(message)) {
        const picked = await pickProvider({ agent: asked.id, from: message.from })
        const other = picked.agent !== asked.id ? resolveAgent(SPAWNABLE, picked.agent) : undefined
        if (other && !("error" in other)) {
          agent = other
          rerouted = `${asked.id} -> ${other.id}${picked.reason ? `: ${picked.reason}` : ""}`
        } else if (picked.reason) {
          // Started as asked, but the caller is told why that may not get far.
          quotaNote = picked.reason
        }
      }
      /*
       * A fork starts from the sender's own conversation: same CLI, same model,
       * same directory — the three things the prompt cache and the CLI's own
       * lookup of the conversation depend on.
       */
      let fork: { args: string[]; resumeId?: string } | undefined
      if (message.fork) {
        const parent = wb().panes.find((pane) => pane.id === message.from)
        const parentAgent = parent?.agent ?? parent?.model
        const refusal = !parent
          ? "--fork richiede una sessione avviata da ADE"
          : parentAgent !== agent.id
            ? `--fork parte dalla tua conversazione, quindi l'agente deve essere il tuo (${parentAgent})`
            : message.model
              ? "--fork usa il tuo modello: toglilo --model, un modello diverso non riusa la cache"
              : message.worktree
                ? "--fork e --worktree insieme non sono supportati: la conversazione è legata alla cartella"
                : parent.cwd && isRemoteRoot(parent.cwd)
                  ? "--fork non è disponibile negli ambienti remoti"
                  : undefined
        if (refusal) {
          await answer(`errore: ${refusal}`)
          return true
        }
        const planned = planFork(agent.id, parent!.resumeId)
        if ("error" in planned) {
          await answer(`errore: ${planned.error}`)
          return true
        }
        fork = planned
      }
      const open = [...spawnedBy.keys()].filter((paneId) => wb().panes.some((pane) => pane.id === paneId))
      if (open.length >= maxSpawned()) {
        await answer(
          `errore: ci sono già ${open.length} sessioni avviate con spawn (limite ${maxSpawned()}); chiudine una con ade-msg close <sessione> o aspetta che finiscano`,
        )
        return true
      }
      // Depth: the user's own sessions are level 0, and each spawn goes one down.
      const depth = message.from ? depthOf(message.from, parentOf) + 1 : 1
      if (depth > maxDepth()) {
        await answer(
          `errore: questa sessione è già al livello ${depth - 1} e il massimo è ${maxDepth()}: fai il lavoro qui o chiedi a chi ti ha avviato`,
        )
        return true
      }

      let name: string | undefined
      if (message.name !== undefined) {
        const checked = checkName(message.name)
        if ("error" in checked) {
          await answer(`errore: ${checked.error}`)
          return true
        }
        if (
          nameTaken(
            panes.map((pane) => pane.title),
            checked.name,
          )
        ) {
          await answer(
            `errore: esiste già una sessione "${checked.name}": scegli un altro nome, o mandale una richiesta con ade-msg ask`,
          )
          return true
        }
        name = checked.name
      }

      /*
       * Model and effort per task (S28): what the caller says, else what the
       * dispatch profile names for this agent. Both are printed in the receipt,
       * and an agent that cannot take one is refused rather than started at
       * its default.
       */
      let profileModel: string | undefined
      let profileEffort: string | undefined
      let profileWhy: string | undefined
      if (message.profile) {
        const board = message.from ? await projectOfPane(host, message.from) : project()
        let json: string | undefined
        for (const path of board && !board.remote && host.readTextFile ? boardCandidates(board.root) : []) {
          const dispatchPath = `${path.replace(/[\\/][^\\/]+$/, "")}/dispatch.json`
          json = await host.readTextFile!(dispatchPath)
            .then((read) => read.text)
            .catch(() => undefined)
          if (json !== undefined) break
        }
        if (json === undefined) {
          await answer("errore: --profile legge dispatch.json accanto a TEAM.md della bacheca, e non c'è")
          return true
        }
        const choice = dispatchChoice(json, message.profile, agent.id)
        if ("error" in choice) {
          await answer(`errore: ${choice.error}`)
          return true
        }
        profileModel = choice.model
        profileEffort = choice.effort
        profileWhy = choice.why
      }
      const model = message.model ?? (fork ? undefined : profileModel)
      const effort = message.effort ?? profileEffort

      // A fork keeps the parent's model choice: a different model is a different cache.
      const spawnArgs: string[] = fork
        ? [...(wb().panes.find((pane) => pane.id === message.from)?.spawnArgs ?? [])]
        : []
      if (model) {
        const chosen = modelArgs(agent.id, model)
        if ("error" in chosen) {
          await answer(`errore: ${chosen.error}`)
          return true
        }
        spawnArgs.push(...chosen)
      }
      if (effort) {
        const chosen = effortArgs(agent.id, effort, model ?? modelIn(spawnArgs))
        if ("error" in chosen) {
          await answer(`errore: ${chosen.error}`)
          return true
        }
        spawnArgs.splice(0, spawnArgs.length, ...withoutEffort(spawnArgs), ...chosen)
      }

      // A subagent works in its caller's project, whichever one is open in ADE.
      const owner = sender?.project || project()?.name
      const ownerProject = message.from ? await projectOfPane(host, message.from) : project()
      const root = ownerProject?.root
      let worktree: { path: string; branch: string } | undefined
      let worktreeBase = ""
      if (message.worktree) {
        if (!root || !host.run) {
          await answer("errore: nessun progetto in cui creare la worktree")
          return true
        }
        const plan = worktreePlan(root, slugify(name ?? `${agent.id}-${id.slice(-8)}`))
        /*
         * From the base asked for, else from the branch the caller is working
         * on: a spawn from a session in `feat/ade` works on `feat/ade`, not on
         * whatever the project's main checkout happens to have out (S24).
         */
        const callerBranch = wb().panes.find((pane) => pane.id === message.from)?.tree?.branch
        const base = message.base ?? (callerBranch && callerBranch !== "HEAD" ? callerBranch : undefined)
        if (base !== undefined && !isBaseRef(base)) {
          await answer(`errore: base non valida: ${base}`)
          return true
        }
        // Never inside another checkout: its git would see the new worktree as untracked files.
        // The folder itself when it exists, and the one holding it, which always does.
        let outer = ""
        for (const dir of [plan.container, plan.container.replace(/[\\/][^\\/]+$/, "")]) {
          const found = await host.run("git", ["rev-parse", "--show-toplevel"], dir).catch(() => undefined)
          if (found?.code === 0 && found.stdout.trim()) {
            outer = found.stdout.trim()
            break
          }
        }
        if (outer) {
          await answer(`errore: ${plan.container} è dentro il repository ${outer}: la worktree ci finirebbe dentro`)
          return true
        }
        const added = await host.run("git", worktreeAddArgs(plan, base), root)
        if (added.code !== 0) {
          await answer(
            `errore: worktree non creata (${(added.stderr || added.stdout).trim().split(/\r?\n/)[0] || "git ha rifiutato"})`,
          )
          return true
        }
        worktree = { path: plan.path, branch: plan.branch }
        worktreeBase = base ?? "HEAD del progetto"
        spawnArgs.push(...worktreeArgs(agent.id, plan.path))
      }
      if (root) await excludeAdeResults(host, root)

      const title = name ?? `${agentLabel(agent.id)} ← ${sender?.title ?? "ade-msg"}: ${briefOf(message.text, 48)}`
      const index = (ownerProject ? wb().panes.filter((pane) => belongsTo(pane, ownerProject)) : wb().panes).length + 1
      const task = formatRequest(id, message.text, sender, {
        ...(worktree ? { worktree } : {}),
        ...(worktree || root ? { resultsDir: resultsDir(worktree?.path ?? root!) } : {}),
        depth,
        maxDepth: maxDepth(),
        ...(message.budget ? { budget: message.budget } : {}),
      })
      const created = addAgent(
        {
          agentId: agent.id,
          count: 1,
          task,
          title,
          workspaceId: owner,
          ...(root ? { projectRoot: root } : {}),
          ...(worktree ? { worktree } : {}),
          spawnArgs,
          ...(fork ? { fork } : {}),
        },
        { index, agentId: agent.id, role: "agent" },
      )
      openRequests.set(id, {
        id,
        kind: "spawn",
        from: message.from,
        to: created.id,
        at: Date.now(),
        brief: briefOf(message.text),
        ...(message.autoClose ? { autoClose: true } : {}),
        ...(message.budget ? { budget: message.budget } : {}),
      })
      saveRequests()
      if (message.from) {
        spawnedBy.set(created.id, message.from)
        saveSpawned()
      }
      if (sender) appendLine(sender.id, t("note.subagent", created.title), "note", "ade")
      await answer(
        `ok: avviata la sessione "${created.title}" (${agent.id}, id ${created.id}, livello ${depth})` +
          (worktree ? ` nella worktree ${worktree.path} sul branch ${worktree.branch} (da ${worktreeBase})` : "") +
          (fork ? " come fork della tua conversazione" : "") +
          (model || effort ? `; modello ${model ?? "predefinito"}, effort ${effort ?? "predefinito"}` : "") +
          (message.profile ? ` (profilo ${message.profile}${profileWhy ? `: ${briefOf(profileWhy, 80)}` : ""})` : "") +
          (rerouted ? `; instradata ${rerouted}` : "") +
          (quotaNote ? `; attenzione: ${quotaNote}` : ""),
      )
      return true
    }

    /*
     * `ade-msg design <file>`: a page the session wrote in its `.ade/design/`,
     * shown in a web pane beside it. It names no session, so it is handled
     * before one is resolved. Rust checks the file (`media.rs`,
     * `design_sheet`); the same file again reloads the pane that shows it.
     */
    if (message.kind === "design") {
      const from = message.from ? wb().panes.find((pane) => pane.id === message.from) : undefined
      if (!from || isPanelPane(from) || !running.has(from.id)) {
        await answer("errore: design richiede una sessione avviata da ADE")
        return true
      }
      const cwd = activityOf.get(from.id)?.cwd || from.cwd || from.projectRoot
      if (!cwd || !host.designSheetPath) {
        await answer("errore: non so in che cartella lavori, e il foglio va cercato lì")
        return true
      }
      let file: string
      try {
        file = await host.designSheetPath(message.path, cwd)
      } catch (err) {
        await answer(`errore: ${typeof err === "string" ? err : err instanceof Error ? err.message : String(err)}`)
        return true
      }
      const shown = sheetPaneFor(wb().panes, file)
      // The same sheet sent again without --title keeps the one it was given.
      const title = sheetTitle(message.title) ?? shown?.designSheet?.title
      const sheet: PaneSheet = { file, from: from.id, ...(title ? { title } : {}) }
      if (shown) {
        setWb((w) => updatePane(w, shown.id, { designSheet: sheet, title: sheetLabel(sheet) }))
        browserControllers.get(shown.id)?.reload()
        await answer(`ok: ricaricato il foglio già aperto: ${sheetLabel(sheet)}`)
        return true
      }
      openOwnedBrowser(sheetUrl(file), { id: from.id, title: from.title }, false, sheet)
      await answer(`ok: aperto accanto a te: ${sheetLabel(sheet)}`)
      return true
    }

    const target = resolveTarget(panes, message.to, message.from)
    if ("error" in target) {
      await answer(`errore: ${target.error}`)
      return true
    }
    // A shell would run the line as a command: refused before anything is typed or booked.
    const forShell = shellRefusal(message.kind, target.pane)
    if (forShell) {
      await answer(forShell)
      return true
    }
    // Nothing wakes a suspended session: a restart is refused, and mail is queued below.
    const toSuspended = isSuspendedPane(target.pane.id) ? suspendedDelivery(message.kind, target.pane.title) : undefined
    if (toSuspended && !toSuspended.queue) {
      await answer(toSuspended.refusal)
      return true
    }

    if (message.kind === "interrupt") {
      if (!message.from) {
        await answer("errore: interrupt si usa solo da una sessione ADE")
        return true
      }
      const session = running.get(target.pane.id)
      if (!session) {
        await answer(`errore: la sessione "${target.pane.title}" non è attiva`)
        return true
      }
      const pane = wb().panes.find((candidate) => candidate.id === target.pane.id)
      session.write(interruptKeys(pane?.agent ?? pane?.model))
      interrupted(target.pane.id)
      // The TUI drops whatever was in the line with the work: so does the count.
      records.typed.forget(target.pane.id)
      tellPane(target.pane.id, t("note.interruptedBy", sender?.title ?? t("note.someSession")))
      // The point is to stop the work, not the session: say which happened.
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await answer(
        running.get(target.pane.id) === session
          ? `ok: interrotta "${target.pane.title}", la sessione resta aperta; mandale una riga correttiva con ade-msg send`
          : `attenzione: "${target.pane.title}" si è chiusa dopo l'interruzione`,
      )
      return true
    }

    if (message.kind === "relaunch") {
      const refusal = relaunchRefusal(message, target.pane, spawnedBy.get(target.pane.id))
      if (refusal) {
        await answer(refusal)
        return true
      }
      const pane = wb().panes.find((candidate) => candidate.id === target.pane.id)
      if (!pane) {
        await answer(`errore: la sessione "${target.pane.title}" non esiste più`)
        return true
      }
      const agentId = pane.agent ?? pane.model
      let spawnArgs = pane.spawnArgs ?? []
      if (message.model) {
        const chosen = modelArgs(agentId, message.model)
        if ("error" in chosen) {
          await answer(`errore: ${chosen.error}`)
          return true
        }
        spawnArgs = [...withoutModel(spawnArgs), ...chosen]
      }
      if (message.effort) {
        const chosen = effortArgs(agentId, message.effort, message.model ?? modelIn(spawnArgs))
        if ("error" in chosen) {
          await answer(`errore: ${chosen.error}`)
          return true
        }
        spawnArgs = [...withoutEffort(spawnArgs), ...chosen]
      }
      /*
       * Same pane, same worktree, same place in the tree. The old process goes
       * first; its exit is ignored because `running` already holds nothing for
       * the pane, and then the new spawn's.
       */
      const old = running.get(pane.id)
      running.delete(pane.id)
      touchRunning()
      old?.kill()
      setWb((w) => updatePane(w, pane.id, { spawnArgs, ...(message.fresh ? { resumeId: undefined } : {}) }))
      if (message.fresh) {
        for (const request of [...openRequests.values()]) {
          if (request.to === pane.id) {
            await settle(
              host,
              request.id,
              `[ade-msg] richiesta ${request.id} interrotta: la sessione "${pane.title}" è stata riavviata da zero`,
            )
          }
        }
        void startProcess(pane.id, agentId, "")
      } else {
        const updated = wb().panes.find((candidate) => candidate.id === pane.id)
        if (updated) void reopen(updated)
      }
      tellPane(
        pane.id,
        t(
          message.fresh ? "note.restartedFresh" : "note.restarted",
          sender?.title ?? t("note.someSession"),
          message.model ?? "",
        ),
      )
      // The note is typed once the new process is up, like any held line; given up after a minute.
      const noteText = `[Nota di ripresa da ${sender?.title ?? "una sessione"}]: ${message.note.trim()}`
      const waitStart = Date.now()
      const waitForRestart = setInterval(() => {
        const up = running.get(pane.id)
        if (up && up !== old) {
          clearInterval(waitForRestart)
          heldLines.push({ paneId: pane.id, text: noteText, inbox: { id: id, kind: "send", from: message.from } })
        } else if (Date.now() - waitStart > 60_000) clearInterval(waitForRestart)
      }, 1000)
      await answer(
        `ok: riavviata "${pane.title}"${message.model ? ` con ${message.model}` : ""}${message.effort ? `, effort ${message.effort}` : ""}` +
          (message.fresh
            ? " da zero con la tua nota: se serve il compito intero mandalo con ade-msg ask"
            : " con la tua nota; riprende la sua conversazione e le richieste aperte restano valide"),
      )
      return true
    }

    if (message.kind === "close") {
      if (!message.from || spawnedBy.get(target.pane.id) !== message.from) {
        await answer(
          `errore: puoi chiudere solo le sessioni avviate da questa sessione con spawn ("${target.pane.title}" non lo è)`,
        )
        return true
      }
      const outcome = await closeTree(host, target.pane.id, message.force)
      if ("error" in outcome) {
        await answer(`errore: ${outcome.error}`)
        return true
      }
      await answer(
        `ok: chiuse ${outcome.closed.map((title) => `"${title}"`).join(", ")}` +
          (outcome.kept.length ? `; worktree lasciate su disco: ${outcome.kept.join(", ")}` : "") +
          (outcome.asking.length
            ? `; aperte in attesa dell'utente (file non salvato, può tenerle): ${outcome.asking.map((title) => `"${title}"`).join(", ")}`
            : ""),
      )
      return true
    }

    if (message.kind === "ask" && message.effort) {
      await answer(
        "errore: l'effort di una sessione aperta non si cambia con ask: usa spawn --effort, oppure relaunch --effort --note",
      )
      return true
    }
    if (message.kind === "ask" && target.pane.id === message.from) {
      await answer("errore: una sessione non può fare una richiesta a se stessa")
      return true
    }
    // Before the route: a suspended Claude session has no pipe, and `SendMessage` to it fails with ENOINBOX.
    if (toSuspended?.queue && (message.kind === "send" || message.kind === "ask")) {
      return queueForSuspended(host, id, message, target.pane, sender, toSuspended.receipt)
    }
    const session = running.get(target.pane.id)
    if (!session) {
      // Its sender stopped reading receipts when it was held: an ask is answered where the caller waits.
      if (held.delete(id)) {
        if (message.kind === "ask")
          await settle(
            host,
            id,
            `[ade-msg] errore: la sessione "${target.pane.title}" si è chiusa prima di ricevere la richiesta ${id}`,
          )
        return true
      }
      await answer(`errore: la sessione "${target.pane.title}" non è attiva`)
      return true
    }
    /*
     * Which way. Two Claude sessions talk over the CLI's own channel: the
     * caller sends, with `SendMessage`, the very line ADE would have typed,
     * and the message lands in the other's context without a keystroke —
     * between two tool calls if it is working, as a new turn if it is idle.
     * So nothing below about turns, permissions or half-written lines
     * applies to it. Every other pairing is typed, protected, as before,
     * and the reason is written where the user can read it.
     */
    const targetPane = wb().panes.find((pane) => pane.id === target.pane.id)
    const route = routeFor({
      senderAgent: sender?.agent,
      targetAgent: target.pane.agent,
      targetSessionId: targetPane?.resumeId,
      listed:
        sender?.agent === "claude-code" && target.pane.agent === "claude-code" && !message.via && !held.has(id)
          ? await listNativeSessions(host)
          : undefined,
      typedRequested: message.via === "typed",
      alreadyQueued: held.has(id),
    })
    if (route.via === "nativa") {
      const nativeContext = {
        ...(targetPane?.cwd ? { resultsDir: resultsDir(targetPane.cwd) } : {}),
        depth: depthOf(target.pane.id, parentOf),
        maxDepth: maxDepth(),
        ...(message.kind === "ask" && message.budget ? { budget: message.budget } : {}),
      }
      const line =
        message.kind === "ask"
          ? formatRequest(id, message.text, sender, nativeContext)
          : formatDelivery(message, sender)
      const full =
        message.kind === "ask"
          ? formatRequest(id, message.text, sender, { ...nativeContext, keepLines: true })
          : formatDelivery(message, sender, { keepLines: true })
      if (message.kind === "ask") {
        const at = Date.now()
        openRequests.set(id, {
          id,
          kind: "ask",
          from: message.from,
          to: target.pane.id,
          at,
          deliveredAt: at,
          brief: briefOf(message.text),
          via: "nativa",
          ...(message.budget ? { budget: message.budget } : {}),
        })
        saveRequests()
      }
      const ask = message.kind === "ask"
      appendLine(
        target.pane.id,
        t(ask ? "note.askFrom" : "note.messageFrom", sender?.title ?? t("note.someSession"), message.text),
        "note",
        "ade",
      )
      appendLine(target.pane.id, t("note.viaNative", route.name), "note", "ade")
      if (sender) {
        appendLine(sender.id, t(ask ? "note.askTo" : "note.messageTo", target.pane.title, message.text), "note", "ade")
        appendLine(sender.id, t("note.viaNative", route.name), "note", "ade")
      }
      held.delete(id)
      handoffs.set(id, {
        paneId: target.pane.id,
        line,
        full,
        id,
        kind: ask ? "ask" : "send",
        from: message.from,
        at: Date.now(),
      })
      saveHandoffs()
      await answer(formatHandoff(route.name, id, line))
      return true
    }

    // A standing permission prompt reads the next Enter as its answer: the message waits for it to go.
    if (questionOpen(target.pane.id)) return false

    /*
     * In the background: a note or a request waits for the recipient's turn
     * to end instead of landing in the middle of its work (see `isFree`). The
     * sender is told at once, so it neither resends nor stops waiting.
     */
    if (!(await freeNow(host, target.pane.id))) {
      const byLine = isTyping(records.typed.get(target.pane.id))
      if (!held.has(id)) {
        held.add(id)
        await answer(
          byLine
            ? formatHeldReceipt(target.pane)
            : `ok: in coda, arriva a "${target.pane.title}" quando finisce il turno`,
        )
      }
      /*
       * Whoever waits on `ade-msg wait` sees the reason as the request's
       * state, the moment it applies and the moment it stops: a line half
       * written in the other session is not the other session ignoring them.
       */
      if (message.kind === "ask") {
        const state = byLine ? HELD_BY_LINE : ""
        if (heldStates.get(id) !== state) {
          heldStates.set(id, state)
          await host.mailboxState?.(id, state).catch(() => {})
        }
      }
      return false
    }
    heldStates.delete(id)

    const targetDepth = depthOf(target.pane.id, parentOf)
    const context = {
      ...(targetPane?.cwd ? { resultsDir: resultsDir(targetPane.cwd) } : {}),
      depth: targetDepth,
      maxDepth: maxDepth(),
      ...(message.kind === "ask" && message.budget ? { budget: message.budget } : {}),
    }
    const line =
      message.kind === "ask" ? formatRequest(id, message.text, sender, context) : formatDelivery(message, sender)
    // The inbox copy, read and never typed, keeps the sender's line breaks.
    const stored =
      message.kind === "ask"
        ? formatRequest(id, message.text, sender, { ...context, keepLines: true })
        : formatDelivery(message, sender, { keepLines: true })
    const delivered = await deliverText(
      host,
      target.pane.id,
      line,
      { id, kind: message.kind === "ask" ? "ask" : "send", from: message.from },
      stored,
    )
    // A prompt opened before the text: the message stays queued, as for a prompt seen above.
    if (delivered === "held") return false
    if (delivered === "closed") {
      // Suspended while this was on its way: queued like the rest of its mail.
      const late = isSuspendedPane(target.pane.id) ? suspendedDelivery(message.kind, target.pane.title) : undefined
      if (late?.queue && (message.kind === "send" || message.kind === "ask"))
        return queueForSuspended(host, id, message, target.pane, sender, late.receipt)
      await answer(`errore: la sessione "${target.pane.title}" si è chiusa durante la consegna`)
      return true
    }
    // The caller has written to a session that said it was blocked on it: that note is the answer it was waiting for.
    for (const request of updatesAnsweredBy(openRequests.values(), message, target.pane.id)) {
      delete request.update
      saveRequests()
    }
    if (message.kind === "ask") {
      const at = Date.now()
      openRequests.set(id, {
        id,
        kind: "ask",
        from: message.from,
        to: target.pane.id,
        at,
        deliveredAt: at,
        brief: briefOf(message.text),
        via: "digitata",
        ...(message.budget ? { budget: message.budget } : {}),
      })
      saveRequests()
    }
    const ask = message.kind === "ask"
    appendLine(
      target.pane.id,
      t(ask ? "note.askFrom" : "note.messageFrom", sender?.title ?? t("note.someSession"), message.text),
      "note",
      "ade",
    )
    // Typed: say so, and why the CLI's channel was not used, so a message that
    // went missing can be looked for where it actually went.
    appendLine(target.pane.id, t("note.viaTyped", route.reason), "note", "ade")
    if (sender && sender.id !== target.pane.id && running.has(sender.id))
      appendLine(sender.id, t("note.viaTyped", route.reason), "note", "ade")
    if (sender)
      appendLine(sender.id, t(ask ? "note.askTo" : "note.messageTo", target.pane.title, message.text), "note", "ade")
    // A held message's sender was answered when it was held, and has stopped listening since.
    if (held.delete(id)) return true
    await answer(`ok: consegnato a ${panes.indexOf(target.pane) + 1} "${target.pane.title}"`)
    return true
  }

  /*
   * New releases reach the bell by themselves: a published `ade-v*` release
   * on the fork is announced once, with a button that installs it. Desktop only,
   * since a browser tab of the dev server has no installed version to be behind.
   */
  /*
   * Kept so "Controlla aggiornamenti" asks the same watch the timer uses:
   * one place counts the calls, so a person pressing the command cannot
   * push the window past GitHub's hourly limit.
   */
  let updateWatch: UpdateWatch | undefined

  onMount(() => {
    if (!isTauriDesktop()) return
    const watch = createUpdateWatch({
      currentVersion: async () => (await import("@tauri-apps/api/app")).getVersion(),
      onUpdate: (update) => {
        setLatestUpdate(update)
        setNotices((list) =>
          addNotice(list, {
            kind: "info",
            text: t("update.available", update.version),
            href: update.url,
            at: Date.now(),
          }),
        )
      },
      /*
       * The tag GitHub last answered with and the release it stood for, kept
       * together across restarts: the first check after launch then usually
       * costs a 304, which is not charged to the hourly limit, and still knows
       * which release that 304 means.
       */
      memory: {
        read: () => {
          try {
            const saved = localStorage.getItem("ade.update.memory")
            if (!saved) return undefined
            const parsed = JSON.parse(saved) as UpdateMemory
            // A release URL from storage opens a page: same rule as a notice.
            if (parsed.update && !isReleasePage(parsed.update.url)) return { ...parsed, update: undefined }
            return parsed
          } catch {
            return undefined
          }
        },
        write: (memory) => {
          try {
            localStorage.setItem("ade.update.memory", JSON.stringify(memory))
          } catch {
            /* A profile without storage still checks; it just pays for the list. */
          }
        },
      },
      // A window nobody is looking at does not poll: see `watch.ts`.
      isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
      /*
       * Coming back to ADE is the moment to look: the release may have been
       * published while the window sat behind something else. `focus` and
       * `visibilitychange` both fire here — the check's own spacing decides
       * whether either of them costs a call.
       */
      onForeground: (run) => {
        const onVisible = () => {
          if (document.visibilityState === "visible") run()
        }
        window.addEventListener("focus", run)
        document.addEventListener("visibilitychange", onVisible)
        return () => {
          window.removeEventListener("focus", run)
          document.removeEventListener("visibilitychange", onVisible)
        }
      },
    })
    updateWatch = watch
    watch.start()
    onCleanup(() => {
      watch.stop()
      updateWatch = undefined
    })
  })

  const [checkingUpdate, setCheckingUpdate] = createSignal(false)

  /** "Controlla aggiornamenti": the bell answers even when there is nothing new. */
  const checkForUpdates = async () => {
    if (checkingUpdate()) return
    if (!updateWatch) {
      setNotices((list) => addNotice(list, { kind: "info", text: t("update.desktopOnly"), at: Date.now() }))
      return
    }
    setCheckingUpdate(true)
    try {
      const result = await updateWatch.check({ force: true })
      /*
       * The release already has its line in the bell. Repeating it would be
       * two identical rows; saying nothing would look like the command did
       * nothing. So it says which one it found.
       */
      if (
        result.status === "update" &&
        result.update &&
        notices().some((notice) => notice.href === result.update?.url)
      ) {
        setNotices((list) =>
          addNotice(list, {
            kind: "info",
            text: t("update.alreadyShown", result.update?.version ?? ""),
            at: Date.now(),
          }),
        )
        return
      }
      const message = checkMessage(result)
      setNotices((list) =>
        addNotice(list, {
          kind: message.kind,
          text: message.text,
          ...(message.href ? { href: message.href } : {}),
          at: Date.now(),
        }),
      )
    } finally {
      setCheckingUpdate(false)
    }
  }

  const openNoticeLink = async (href: string) => {
    if (!isReleasePage(href)) return
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("ade_open_release", { url: href })
    } catch (error) {
      report(t("update.openFailed", String(error)))
    }
  }

  /*
   * A release notice installs the release: download, install, restart, all
   * inside ADE. The restart stops every running agent; the workspace is
   * written first, and not left to the autosave's debounce, because the
   * installer ends this process without a `pagehide` — and that saved state is
   * what brings the sessions back, resumed by conversation id, on the next
   * start. Asked first when there is something running. A platform the manifest does not cover (a .deb
   * or .rpm install, Linux on ARM) or a failed download falls back to the
   * release page, so the notice is never a dead end.
   */
  const [updating, setUpdating] = createSignal(false)
  /*
   * How far the download is, from the Rust side: the only sign of life ADE
   * gives between «Aggiorna e riavvia» and the window closing, so it must be
   * there for every megabyte and not only at the end.
   */
  const [updateProgress, setUpdateProgress] = createSignal<UpdateProgress | undefined>(undefined)
  const updateProgressText = () => {
    const progress = updateProgress()
    if (!progress) return t("update.acting")
    if (progress.phase === "install") return t("update.installing")
    return t(
      "update.downloading",
      formatMb(progress.downloaded, locale()),
      progress.total ? formatMb(progress.total, locale()) : null,
    )
  }
  onMount(() => {
    if (!isTauriDesktop()) return
    let unlisten: (() => void) | undefined
    let gone = false
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen(UPDATE_PROGRESS_EVENT, (event) => {
          const progress = parseUpdateProgress(event.payload)
          if (progress) setUpdateProgress(progress)
        }),
      )
      .then((stop) => {
        if (gone) stop()
        else unlisten = stop
      })
    onCleanup(() => {
      gone = true
      unlisten?.()
    })
  })
  /*
   * The release the bell announced, and whether the question is open. The
   * dialog is ADE's own (see update/update-dialog.tsx): it names the
   * version, says what happens to the running sessions, and stays up through
   * the download, so the window is never silent between the click and its
   * own closing. Asked every time, sessions or not, because the choice to
   * close and reopen ADE should always be the user's.
   */
  const [latestUpdate, setLatestUpdate] = createSignal<AvailableUpdate | undefined>(undefined)
  const [updateAsk, setUpdateAsk] = createSignal<{ href: string; version: string; running: number } | undefined>(
    undefined,
  )
  /*
   * What the dialog was showing when «Nascondi» put it away, so the bell can
   * bring it back while the download runs, and a failure brings it back by
   * itself: a person who hid the panel and went to work must not learn from
   * silence that the update failed.
   */
  const [hiddenAsk, setHiddenAsk] = createSignal<{ href: string; version: string; running: number } | undefined>(
    undefined,
  )
  const [updateError, setUpdateError] = createSignal<string | undefined>(undefined)
  const [installedVersion] = createResource(async () => {
    if (!isTauriDesktop()) return undefined
    return (await import("@tauri-apps/api/app")).getVersion()
  })
  const runningSessions = () =>
    wb().panes.filter(
      (pane) => !isPanelPane(pane) && (pane.agent ?? pane.model) && pane.status !== "done" && pane.status !== "error",
    ).length
  const installUpdate = (href: string) => {
    if (updating()) return
    const latest = latestUpdate()
    const version = latest && latest.url === href ? latest.version : (/\d+\.\d+\.\d+/.exec(href)?.[0] ?? "")
    setUpdateError(undefined)
    setHiddenAsk(undefined)
    setUpdateAsk({ href, version, running: runningSessions() })
  }
  const showUpdate = () => {
    const hidden = hiddenAsk()
    if (!hidden) return
    setHiddenAsk(undefined)
    setUpdateAsk(hidden)
  }
  const runUpdate = async () => {
    if (updating()) return
    setUpdateError(undefined)
    setUpdateProgress(undefined)
    setUpdating(true)
    autosave.flush()
    // localStorage reaches WebView2's disk store a moment after setItem.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("ade_update_install")
    } catch (error) {
      setUpdating(false)
      setUpdateProgress(undefined)
      setUpdateError(String(error))
      showUpdate()
      report(t("update.installFailed", String(error)))
    }
  }

  onMount(() => {
    /*
     * Mail has to keep moving while ADE is minimised — agents message each
     * other whether or not anyone is watching — so a hidden window delivers
     * at the same pace (P1-C1): only the watch half of the pass slows down,
     * inside `deliverPending`. With no session running a pass every three
     * seconds is plenty for a request arriving from outside.
     */
    let mailPass = 0
    onCleanup(
      every(
        700,
        () => {
          mailPass++
          if (running.size === 0 && mailPass % 4 !== 0) return
          return deliverMail()
        },
        { whenHidden: 700 },
      ),
    )
    // Usage only feeds what is on screen and `ade-msg stats`: paused while hidden.
    onCleanup(every(15_000, () => refreshUsage()))
    /*
     * Which nikcli is installed, for the top bar.
     *
     * Asked of the binary, not of any package.json: the project open here is
     * usually not nikcli's own. Once at startup and then very rarely, because
     * the answer only changes when nikcli updates itself, and paused while the
     * window is hidden. Every failure is the same silence.
     */
    onCleanup(
      every(
        NIKCLI_VERSION_EVERY_MS,
        async () => {
          const host = await getHost()
          if (!host?.nikcliBot) return
          const answer = await host.nikcliBot(["--version"]).catch(() => null)
          setNikcliVersion(parseNikcliVersion(answer))
        },
        { immediate: true },
      ),
    )
    void getHost().then((host) => {
      void host?.mailboxPublish?.(agentsTable(SPAWNABLE), "agents").catch(() => {})
      const panelVerbs = [
        { panel: "video", verbs: VIDEO_VERBS },
        { panel: "model", verbs: MODEL_VERBS },
        { panel: "app", verbs: SIMULATOR_VERBS },
        { panel: "browser", verbs: BROWSER_VERBS },
      ]
      void host?.mailboxPublish?.(`${USAGE}${panelsHelp(panelVerbs)}`, "usage").catch(() => {})
    })
  })

  // The list `ade-msg list` prints, rewritten when a session opens, closes or changes state.
  createEffect(() => {
    runningTick()
    const table = sessionsTable(mailPanes())
    void getHost().then((host) => host?.mailboxPublish?.(table, "sessions").catch(() => {}))
  })

  /*
   * What voice needs is a microphone, and nothing more.
   *
   * This used to ask for the browser's SpeechRecognition, which inside the
   * webview ADE ships in is a constructor with no service behind it: it
   * answered every start with an immediate end, no audio and no error. Both
   * engines that remain — the local model and the cloud one — read the
   * microphone themselves, so mediaDevices is the whole requirement.
   */
  const voiceAvailable = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia
  const rawSavedVoice = typeof localStorage !== "undefined" ? localStorage.getItem("voice.settings") : null
  const initialVoice = loadVoiceSettings()
  const [voiceSettings, setVoiceSettings] = createSignal<VoiceSettings>(initialVoice.settings)
  const [voiceSettingsOpen, setVoiceSettingsOpen] = createSignal(false)
  const [voiceSettingsSection, setVoiceSettingsSection] = createSignal<string | undefined>(undefined)
  const closeVoiceSettings = () => {
    setVoiceSettingsSection(undefined)
    setVoiceSettingsOpen(false)
  }
  /** One of the sheets on `Sheet` is open: modal, with a focus trap (see `waitsForSheet`). */
  const sheetOpen = () =>
    choicesOpen() ||
    decisionsOpen() ||
    designOpen() ||
    voiceSettingsOpen() ||
    remoteOpen() ||
    Boolean(recordAsk()) ||
    Boolean(keyRequest())
  const openVoiceSettings = (section?: string) => {
    setVoiceSettingsSection(section)
    setVoiceSettingsOpen(true)
  }

  /*
   * Which CLIs are set up to report their own session id.
   *
   * Read once at start and again after the settings panel changes one, rather
   * than asked per spawn: it is two file reads, it almost never changes, and
   * `startProcess` is already the slowest thing the user waits on.
   */
  const [hookStates, setHookStates] = createSignal<Record<string, HookStatus>>({})
  /* The host, kept for the settings panel, which renders synchronously. */
  const [hookHost, setHookHost] = createSignal<HookHost>({})
  const refreshHooks = async () => {
    const host = await getHost()
    if (!host) return
    setHookHost(() => host)
    const states = await Promise.all(HOOK_TARGETS.map((target) => readHookStatus(host, target)))
    setHookStates(Object.fromEntries(states.map((state) => [state.target.id, state])))
    // An install from an older ADE gets this version's script.
    for (const state of states) {
      if (!state.installed) continue
      const key = `ade.hookScript.${state.target.id}`
      let last: string | undefined
      try {
        last = localStorage.getItem(key) ?? undefined
      } catch {}
      const written = await refreshHookScript(host, state.target, last).catch(() => undefined)
      if (written) {
        try {
          localStorage.setItem(key, written)
        } catch {}
      }
    }
  }

  /*
   * A saved voice chord that ADE also claims resolves to ADE and opens no
   * microphone, and there is nothing on screen to say so — the user presses
   * the shortcut they configured and gets a pane command or nothing at all.
   * The panel says it too, but only once opened; this says it on the way in.
   */
  const shadowedVoiceChords = summarizeVoiceShortcutConflicts(initialVoice.settings, bindings, platform)
  /*
   * The migration to the wake word, kept for the settings panel.
   *
   * The strip above is dismissed and gone; this is the same sentence where the
   * switch that undoes it lives, and it stays until the user turns the rule
   * off or on themselves.
   */
  const migratedToWakeWord = initialVoice.migrations.includes("wake-word")
  const migratedToAlwaysListen = initialVoice.migrations.includes("always-listen")
  const movedToShortcut = initialVoice.migrations.includes("shortcut-only")
  const listeningOff = initialVoice.migrations.includes("listening-off")
  // The local engine is gone and the profile is on the cloud one now; told once (the profile is written back), with
  // what was turned off under it when it listened on its own.
  const localEngineRemoved = initialVoice.migrations.includes("parakeet-removed")
  const cloudListeningOff = initialVoice.migrations.includes("parakeet-listening-off")
  const localEngineNotice = cloudListeningOff
    ? t("voice.parakeetRemovedListeningOff", t("vui.listen.always"))
    : localEngineRemoved
      ? t("voice.parakeetRemoved")
      : undefined
  const movedToName = initialVoice.migrations.some(
    (m) => m === "name-only" || m === "wake-word" || m === "always-listen",
  )
  const agentShortcut = describeShortcut(initialVoice.settings.agentChord, platform)
  const [voiceSettingsNotice, setVoiceSettingsNotice] = createSignal<string | undefined>(
    localEngineNotice ??
      (listeningOff
        ? t("voice.listeningOff", agentShortcut, t("vui.listen.always"))
        : wakeWordEnabled() && !shortcutActivationEnabled() && movedToName
          ? t("voice.nameOnly", agentShortcut, t("vui.listen.manual"))
          : movedToShortcut
            ? t("voice.shortcutOnly", agentShortcut)
            : wakeWordEnabled() && (migratedToWakeWord || migratedToAlwaysListen)
              ? t(
                  "voice.alwaysListening",
                  initialVoice.settings.wakeWord,
                  t("vui.listen.manual"),
                  t("vui.activation.toggle"),
                )
              : undefined),
  )

  const [voiceNotice, setVoiceNotice] = createSignal<string | undefined>(
    [
      /*
       * Listening turned off under the user goes in the strip at the top, not
       * only next to the switch: it is their money and their microphone, and
       * a note that waits for someone to open the voice settings is a note
       * nobody reads.
       */
      listeningOff ? t("voice.listeningOff", agentShortcut, t("vui.listen.always")) : undefined,
      // Also in the strip: listening turned off under the user, and the service the voice now goes to, are theirs to know.
      localEngineNotice,
      initialVoice.corrections.filter((c) => !c.includes("assenti")).length > 0
        ? initialVoice.corrections.filter((c) => !c.includes("assenti")).join(" ")
        : rawSavedVoice !== null && initialVoice.corrections.length > 0
          ? initialVoice.corrections.join(" ")
          : undefined,
      shadowedVoiceChords,
    ]
      .filter((line): line is string => line !== undefined)
      .join(" ") || undefined,
  )

  /*
   * Which of the catalogue this machine can actually start.
   *
   * The new-session form probes for itself when it opens, and voice cannot
   * wait for a form nobody opened: told "avvia una sessione codex" it has to
   * know now whether codex exists here. `probe` is a PATH lookup rather than a
   * run (see `host.probe`), so asking at mount costs a dozen lookups and wakes
   * nothing. While it is still unanswered the voice host reports every agent
   * as available — see `listAgents` for why that, and not "assente".
   */
  const [agentStatuses] = createResource(async () =>
    // Caught here: a resource read outside a Suspense boundary rethrows its
    // failure, and losing the catalogue is not worth breaking `listAgents`.
    detectAgents((await getHost())?.probe).catch(() => undefined),
  )

  const voiceHost = createAdeVoiceHost({
    wb,
    setWb,
    project,
    runCommand: (id) => runCommand(id),
    isRunning,
    // Dictated text goes into the line and is not submitted: it counts as typed.
    getRunningSession: (id) => {
      const session = running.get(id)
      return session && { write: (text: string) => typeAsUser(id, text), kill: () => session.kill() }
    },
    openFile: (path) => openFile(path),
    appendLine: (id, text, kind) => appendLine(id, text, kind),
    tellPane: (id, text) => tellPane(id, text),
    permissions,
    answerPermission: (id, ans) => answerPermission(id, ans),
    confirmVoiceSend: (id, approved) => {
      if (approved) voiceSendDecisions.set(id, "approved")
      else voiceSendDecisions.set(id, "rejected")
    },
    getHost,
    recents,
    agentAvailability: () => agentStatuses(),
    codexFallback: () => voiceSettings().codexFallback === true,
    switchProject: (root) => switchProjectTo(root),
    // M11: a dictated path outside the project or the recent ones is asked, not opened.
    confirm: (question) => askYesNo(question, { ok: t("voice.path.open"), cancel: t("voice.path.cancel") }),
    openAgentSession: (input) => openVoiceSession(input),
  })

  /*
   * No transcriber is built here on purpose. The engine builds one from the
   * chosen backend every time it starts, so switching between the local model
   * and the cloud engine in the settings panel takes effect on the next press
   * instead of after a reload — which is what a single instance pinned at
   * mount cost us before.
   */
  const noMicrophone = {
    start: async () => {
      throw new Error(t("voice.noMic"))
    },
    stop: async () => {},
    onPartial: () => {},
    onFinal: () => {},
    onError: () => {},
  }
  /*
   * S33: how loud the reply is while it plays, for the agent's sphere. Piper's
   * sentences are measured from their WAV; the system voice has no samples, so
   * while it speaks the meter pulses instead.
   */
  const playbackMeter = createPlaybackMeter()
  const webSpeaker =
    typeof window !== "undefined" && "speechSynthesis" in window
      ? createWebSpeechSpeaker({ lang: () => (locale() === "en" ? "en-US" : "it-IT") })
      : createFakeSpeaker()
  const systemSpeaker = {
    ...webSpeaker,
    speak: async (text: string) => {
      const stop = playbackMeter.pulse()
      try {
        await webSpeaker.speak(text)
      } finally {
        stop()
      }
    },
    cancel: () => webSpeaker.cancel(),
  }
  const [voiceInstalled, setVoiceInstalled] = createSignal(false)
  const [voiceDownloading, setVoiceDownloading] = createSignal(false)
  const [voiceFailure, setVoiceFailure] = createSignal<NaturalVoiceFailure>()
  /** How the Piper download started from the panel is going (K3), while it goes. */
  const [piperProgress, setPiperProgress] = createSignal<InstallProgress>()
  /** The Kokoro pack as the host reports it, and what the panel started on it (K6). */
  const [kokoroPack, setKokoroPack] = createSignal<PackState>({})
  const kokoro = createPackController({
    provider: "kokoro",
    host: getHost,
    get: kokoroPack,
    set: setKokoroPack,
    fallback: t("voice.download.failed"),
    sizeBytes: KOKORO_DOWNLOAD_BYTES,
  })
  /*
   * «Prova»: a sentence in the language of the voice, so the reply-language
   * rule does not hand an English voice's sample to Ugo. Kokoro's and Lessac's
   * are English; the rest follow the interface.
   */
  const testReplyVoice = () => {
    const settings = voiceSettings()
    const voice = activeReplyVoice(settings.replyVoice, locale())
    const english =
      Boolean(kokoroVoice(settings.replyVoice)) || voice === "lessac" || (voice === "system" && locale() === "en")
    void speaker.speak(english ? t("vui.replies.sample.en") : t("vui.replies.sample.it"))
  }

  const activePiperVoice = () => activeReplyVoice(voiceSettings().replyVoice, locale())
  /*
   * The voice the speaker is actually asking the host for, which is not always
   * the one the panel shows: a Kokoro voice on an Italian reply is spoken by
   * Piper, and it is Piper's download that has to be tracked. The panel's own
   * choice stays `activePiperVoice`, and K6 is where the two are put together.
   */
  const speakingVoice = () => speakingReplyVoice(voiceSettings().replyVoice, voiceSettings().ttsLocale, locale())
  // The failure is looked for with the voice that is actually speaking, not with
  // the one the panel shows: they differ as soon as a Kokoro voice meets an
  // Italian reply, and a download error recorded under one and looked for under
  // the other is an error that never appears.
  const voiceError = createMemo(() => naturalVoiceFailureFor(voiceFailure(), speakingVoice()))
  const clearVoiceFailure = (voice: string) => {
    setVoiceFailure((current) => clearNaturalVoiceFailure(current, voice))
  }
  const failNaturalVoice = (voice: string, problem: unknown) => {
    const message =
      (problem instanceof Error ? problem.message : String(problem ?? "")).trim() || t("voice.download.failed")
    setVoiceFailure({ voice, problem: message })
    if (voice === speakingVoice()) report(t("voice.download.report", message))
  }

  const checkVoiceInstalled = async () => {
    const v = speakingVoice()
    if (v === "system") {
      setVoiceInstalled(true)
      clearVoiceFailure(v)
      return
    }
    try {
      const host = await getHost()
      if (!host?.ttsPiperStatus) {
        if (speakingVoice() === v) setVoiceInstalled(true)
        return
      }
      const st = await host.ttsPiperStatus(v)
      if (speakingVoice() !== v) return
      setVoiceInstalled(Boolean(st.installed))
      if (st.installed) clearVoiceFailure(v)
    } catch {
      if (speakingVoice() === v) setVoiceInstalled(false)
    }
  }

  /*
   * S15: replies in Piper's voice where the desktop host has it, with the
   * system voice underneath while it downloads or when it fails. The host is
   * looked up per call, so the browser harness simply never gets past status.
   */
  const naturalSpeaker = createNaturalSpeaker({
    /*
     * Which voice speaks, and in which language — one answer, because the voice
     * is chosen *for* the language and two of them could come apart. The
     * language is the one of the reply as its text says it, and the setting is
     * what answers when the text says nothing: a reply in Italian is read in
     * Italian, which is what keeps a Kokoro voice from reading it with an
     * English mouth. See `replyLocale`.
     */
    voiceFor: (detected) => {
      const settings = voiceSettings()
      // Not called `locale`: that is the language of the window, and it is asked
      // for one line below.
      const spoken = replyLocale(settings.replyVoice, detected, interfaceLocale(locale(), settings.ttsLocale))
      return { voice: speakingReplyVoice(settings.replyVoice, spoken, locale()), locale: spoken }
    },
    status: async (voice) => {
      const host = await getHost()
      // Which backend reads the voice decides which command answers: Piper's
      // voices are files of their own, Kokoro's four are one 219 MB download, and
      // asking the wrong backend about a voice it does not have is a question
      // with no answer.
      if (isKokoroVoice(voice as ReplyVoice)) {
        // The panel's shape: undefined means this build cannot run Kokoro at all,
        // which is not the same as a pack that is not there yet.
        const pack = host?.ttsLocalStatus ? await host.ttsLocalStatus("kokoro") : undefined
        return { supported: pack !== undefined, installed: pack?.installed ?? false }
      }
      if (host?.ttsPiperStatus) return host.ttsPiperStatus(voice)
      return { supported: false, installed: false }
    },
    install: async (voice) => {
      const host = await getHost()
      if (isKokoroVoice(voice as ReplyVoice)) {
        if (host?.ttsLocalInstall) return host.ttsLocalInstall("kokoro")
      } else if (host?.ttsPiperInstall) {
        return host.ttsPiperInstall(voice)
      }
      throw new Error(t("voice.noHost.download"))
    },
    synthesize: async (voice, text, token, ttsLocale) => {
      const host = await getHost()
      // The locale goes across as what the G2P is asked for, not as the setting:
      // `en-GB` is `en` for espeak, and K1 measured that asking for `en-gb` fails
      // outright. This is the boundary where that becomes true.
      const lang = g2pLocale(ttsLocale)
      // A Kokoro voice is read by the other backend, and it takes the voice id
      // too: its four voices are speaker numbers inside one model, not four files.
      if (isKokoroVoice(voice as ReplyVoice)) {
        if (host?.ttsLocalSpeak) return host.ttsLocalSpeak("kokoro", voice, text, token, lang)
        throw new Error(t("voice.noHost"))
      }
      if (!host?.ttsPiperSpeak) throw new Error(t("voice.noHost"))
      return host.ttsPiperSpeak(voice, text, token, lang)
    },
    cancel: async (tokens) => {
      const host = await getHost()
      // L'annullamento di Kokoro e' solo qui: l'host non ha un comando e una
      // richiesta gia' mandata finisce. Il segno arriva lo stesso e la frase che
      // non e' ancora partita non parte.
      await host?.ttsPiperCancel?.(tokens)
    },
    stop: async () => {
      const host = await getHost()
      // I due figli sono uno per backend: fermare quello che stava parlando, e la
      // catena si rimette sola al turno dopo.
      await host?.ttsLocalStop?.()
      return (await host?.ttsPiperStop?.()) ?? { busy: false }
    },
    stopOnCreate: true,
    play: (wav, signal) => {
      // A take keeps the assistant's voice as its own track (S36).
      recorder.noteVoice(wav)
      return playWav(wav, signal, voiceSettings().outputDeviceId, playbackMeter, () => {
        // The device the user picked is not there: the answer comes out of the
        // default speakers, and it says so once instead of never.
        report(t("vui.device.missing"), "warning")
      })
    },
    fallback: systemSpeaker,
    fallbackNotice: () => t("vui.reply.fallbackNotice"),
    onInstall: (voice, state, problem) => {
      if (voice !== speakingVoice()) return
      if (state === "ready") {
        setVoiceInstalled(true)
        setVoiceDownloading(false)
        clearVoiceFailure(voice)
      } else if (state === "downloading") {
        setVoiceDownloading(true)
      } else if (state === "failed") {
        setVoiceInstalled(false)
        setVoiceDownloading(false)
        // A download the user cancelled from the panel is not a failure (K6 review).
        void getHost().then(async (host) => {
          if (!(await installCancelled(host, "piper"))) failNaturalVoice(voice, problem)
        })
      }
    },
  })
  /*
   * The whole reply counts for the sphere, synthesis included: a long first
   * sentence takes Piper longer than the sphere waits, and it flew home and
   * back before the voice started.
   */
  const speaker = {
    ...naturalSpeaker,
    speak: async (text: string) => {
      const stop = playbackMeter.reply()
      try {
        await naturalSpeaker.speak(text)
      } finally {
        stop()
      }
    },
  }

  /*
   * The level meter drives the mic ring and the settings panel's waveform, and
   * nothing else. A second getUserMedia stream is the one part of starting up
   * that can fail on its own — a headless webview, a denied prompt — so its
   * failure is swallowed here: losing the animation must never cost the user
   * the ability to speak.
   */
  const rawMicMeter = voiceAvailable ? createMicMeter() : undefined
  const micMeter = rawMicMeter
    ? {
        start: async () => {
          try {
            await rawMicMeter.start()
          } catch {
            // level display only; recognition runs on its own stream
          }
        },
        onLevel: (cb: (level: number) => void) => rawMicMeter.onLevel(cb),
        // Passed through: the engine tells the meter which microphone to open
        // so the ring animates off the same device recognition is reading.
        setDevice: (deviceId: string | undefined) => rawMicMeter.setDevice(deviceId),
        stop: () => rawMicMeter.stop(),
        get isRunning() {
          return rawMicMeter.isRunning
        },
      }
    : undefined

  const voiceEngine = createVoiceEngine({
    host: voiceHost,
    settings: voiceSettings(),
    // A tap on a dictation chord held to speak closed it unseen: said, so the press is not dead.
    onDictationTap: () =>
      report(t("vui.dictation.tapHint", describeShortcut(voiceSettings().transcriptionChord, platform)), "info"),
    ...(voiceAvailable ? {} : { transcriber: noMicrophone }),
    speaker,
    micMeter,
    now: () => Date.now(),
    /*
     * What the planning provider said, beside the sentence the user heard. It
     * is the only way to tell a "riprova fra un momento" that keeps coming back
     * because of a rate limit from one that will because the key is wrong, and
     * a 401 quotes the key it refused — so it is scrubbed before it is shown,
     * and the Italian sentence is the only thing said out loud.
     */
    onProviderError: (detail) => report(scrubSecrets(detail)),
    getContext: () => ({
      focusedPaneId: wb().focusedId,
    }),
  })

  const downloadNaturalVoice = async () => {
    if (voiceDownloading()) return
    const v = activePiperVoice()
    setVoiceDownloading(true)
    speaker.prepare()
    if (v === "system") {
      setVoiceInstalled(true)
      clearVoiceFailure(v)
      setVoiceDownloading(false)
      return
    }
    let stopFollowing = () => {}
    const host = await getHost()
    try {
      if (!host?.ttsPiperInstall) throw new Error(t("voice.noHost.download"))
      // K3's progress, read while the install runs: the command answers only at the end.
      stopFollowing = followInstall(host, "piper", setPiperProgress)
      await host.ttsPiperInstall(v)
      if (activePiperVoice() !== v) return
      setVoiceInstalled(true)
      clearVoiceFailure(v)
    } catch (error) {
      if (activePiperVoice() !== v) return
      setVoiceInstalled(false)
      // Annulla in the panel ends the download with an error: it was asked for, it is not one.
      if (!(await installCancelled(host, "piper"))) failNaturalVoice(v, error)
    } finally {
      stopFollowing()
      setPiperProgress(undefined)
      if (activePiperVoice() === v) setVoiceDownloading(false)
    }
  }

  const hasVoiceAgent = createMemo(() => {
    const statuses = agentStatuses()
    if (!statuses) return true
    const engine = voiceSettings().agentEngine
    if (engine === "claude") {
      return statuses.find((s) => s.agent.id === "claude-code")?.availability !== "assente"
    }
    if (engine === "codex") {
      return statuses.find((s) => s.agent.id === "codex")?.availability !== "assente"
    }
    return statuses.some(
      (s) => (s.agent.id === "claude-code" || s.agent.id === "codex") && s.availability !== "assente",
    )
  })

  // Status only: never starts a download. Looking at Agent or Voice must not
  // pull 63 MB; that happens from the checklist button or when the voice speaks.
  const preloadNaturalVoice = () => {
    void checkVoiceInstalled()
  }

  // S15: the moment the microphone wakes, load the reply voice so the first answer is not the slow one.
  createEffect(
    on(
      () => voiceEngine.isRunning(),
      (running) => {
        if (running) {
          preloadNaturalVoice()
          if (voiceSettings().speakReplies !== false && voiceEngine.activeMode() === "agent") speaker.prepare()
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => wb().view === "agent",
      (isAgent) => {
        if (isAgent) preloadNaturalVoice()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => voiceSettingsOpen(),
      (open) => {
        if (open) preloadNaturalVoice()
        // What the host has of Kokoro, asked when the panel opens: it can change under ADE.
        if (open) void kokoro.refresh()
      },
      { defer: true },
    ),
  )

  /* Set once the native shell has registered the voice hotkeys; see onMount. */
  let registerGlobalShortcuts: ((settings: VoiceSettings) => Promise<void>) | undefined
  /* The chords the system refused at the last registration, shown in the voice settings. */
  const [shortcutRefusals, setShortcutRefusals] = createSignal<Partial<Record<VoiceMode, string>>>({})

  /*
   * Always-on listening: whether ADE should hold the microphone open by
   * itself. Needs something to transcribe with — without a key the cloud
   * engine would greet every launch with an error nobody asked for.
   */
  const listensByItself = (s: VoiceSettings) =>
    wakeWordEnabled() &&
    voiceAvailable &&
    s.alwaysListen &&
    s.activation === "wake-word" &&
    s.mode === "agent" &&
    Boolean(s.openRouterApiKey)
  const listenForName = () => {
    // Not the user's hand: a stop for spending is not lifted by a launch.
    if (!voiceEngine.isRunning()) void voiceEngine.start("agent", { waitForName: true, automatic: true })
  }

  const handleVoiceSettingsChange = async (next: VoiceSettings) => {
    // Once they have been in here and changed something, the note is spent —
    // and the profile was written back on the way in, so it does not return.
    setVoiceSettingsNotice(undefined)
    const before = listensByItself(voiceSettings())
    const previousVoice = activePiperVoice()
    const saved = saveVoiceSettings(next)
    setVoiceSettings(saved.settings)
    const nextVoice = activeReplyVoice(saved.settings.replyVoice, locale())
    if (nextVoice !== previousVoice) {
      setVoiceFailure(undefined)
      setVoiceInstalled(nextVoice === "system")
      setVoiceDownloading(false)
      void checkVoiceInstalled()
    }
    await voiceEngine.updateSettings(saved.settings)
    await registerGlobalShortcuts?.(saved.settings)
    const after = listensByItself(saved.settings)
    // The switch is the switch: on opens the microphone, off closes it.
    if (after && !before) listenForName()
    else if (before && !after && voiceEngine.isRunning()) void voiceEngine.stop()
  }

  const isScreenLocked = async () => {
    // Set from a test driving the page, in a dev build only: a lock cannot be
    // staged on the user's PC, and a release must not read it.
    const staged = import.meta.env.DEV
      ? (window as unknown as { __adeSessionLockedForTest?: unknown }).__adeSessionLockedForTest
      : undefined
    if (typeof staged === "boolean") return staged
    if (!isTauriDesktop()) return false
    const { invoke } = await import("@tauri-apps/api/core")
    return (await invoke("session_locked")) === true
  }

  const proactiveAlerts = createProactiveAlerts({
    now: () => Date.now(),
    isLocked: isScreenLocked,
    isEnabled: () => voiceSettings().spokenAlerts === true,
    isBusy: () => voiceEngine.isBusy(),
    speak: async (text) => {
      await speaker.speak(text)
    },
    openResponseWindow: async (options) => {
      await voiceEngine.openResponseWindow(options)
    },
    isPermissionPending: (paneId) => questionOpen(paneId),
    isDecisionOpen: (k) => {
      const decs = decisionsRegister.state()?.decisions
      return Boolean(decs?.some((d) => d.k === k && d.status === "aperta"))
    },
    report: (text) => report(text, "info"),
  })

  /** ADE's window is hidden in the tray (G11): set by Rust's `ade-window-hidden`/`ade-window-shown`. */
  let hiddenInTray = false

  onMount(() => {
    preloadNaturalVoice()
    if (listensByItself(voiceSettings())) listenForName()
    /* Paused only while the PC is locked or asleep; see `voice/listen-guard.ts`. */
    const guard = createListenGuard({
      now: () => Date.now(),
      isLocked: isScreenLocked,
      isHidden: () => hiddenInTray,
      isDictating: () => voiceEngine.activeMode() === "transcription",
      isLatched: () => voiceEngine.isLatched(),
      shouldListen: () => listensByItself(voiceSettings()),
      isListening: () => voiceEngine.isRunning(),
      isPaused: () => voiceEngine.listenPaused(),
      isHalted: () => voiceEngine.listenHalted(),
      pause: () => voiceEngine.pauseListening(),
      resume: () => voiceEngine.start("agent", { waitForName: true, automatic: true }),
      restart: async () => {
        await voiceEngine.stop()
        await voiceEngine.start("agent", { waitForName: true, automatic: true })
      },
    })
    /* `every` and not a bare interval, and a hidden window does not slow it: a
       lock is what the guard is here to notice, and a minimised ADE is how
       listening to it looks for most of the day. What to ask the guard is the
       guard's own decision, and it asks nothing with the voice off. */
    const stopGuard = pollListenGuard(guard)
    onCleanup(stopGuard)
  })

  const completionTurns = new Map<string, number>()

  // Proactive alerts: session completed work
  createEffect(
    on(
      () => wb().panes.map((p) => ({ id: p.id, title: p.title, status: p.status, lines: p.lines })),
      (currentPanes, previousPanes) => {
        if (!previousPanes) return
        for (const pane of currentPanes) {
          const prev = previousPanes.find((p) => p.id === pane.id)
          if (!prev) continue
          if (pane.status === "working" && prev.status !== "working") {
            completionTurns.set(pane.id, (completionTurns.get(pane.id) ?? 0) + 1)
            continue
          }
          if (prev.status === "working" && pane.status === "idle") {
            proactiveAlerts.notifyCompletion(pane.id, pane.title, pane.lines, completionTurns.get(pane.id) ?? 0)
          }
        }
      },
      { defer: true },
    ),
  )

  // Proactive alerts: open decision awaiting in register
  createEffect(
    on(
      () => decisionsRegister.state()?.decisions,
      (decisions) => {
        if (!decisions) return
        for (const dec of decisions) {
          if (dec.status === "aperta") {
            const latest = dec.history.at(-1)
            proactiveAlerts.notifyDecision(
              dec.k,
              dec.title,
              `${dec.openedAt}:${dec.history.length}:${latest?.type ?? "aperta"}:${latest?.at ?? ""}`,
            )
          }
        }
      },
      { defer: true },
    ),
  )

  // Too many sentences sent in an hour: said on screen, listening goes on.
  createEffect(
    on(
      () => voiceEngine.listenWarning(),
      (warning) => {
        if (warning) report(warning, "warning")
      },
      { defer: true },
    ),
  )

  const pttHandler = createPushToTalkHandler(voiceEngine)

  onCleanup(() => {
    void voiceEngine.stop()
  })

  /*
   * Plugins.
   *
   * Built here rather than in a provider because everything the runtime needs
   * is already a local of this function — the workbench signal, the project,
   * the palette — and a context would only be a way to reach them from
   * further away. `packages/ade/src/plugin/` holds the machinery; what is
   * wired here is the four places a plugin can reach ADE.
   */
  const pluginIO: DiscoveryIO = {
    async readTextFile(path, maxBytes) {
      const host = await getHost()
      if (!host?.readTextFile) throw new Error("nessun host desktop")
      return host.readTextFile(path, maxBytes)
    },
    async exists(path) {
      const host = await getHost()
      return (await host?.exists?.(path)) ?? false
    },
  }

  const pluginRuntime = createAdePluginRuntime({
    io: pluginIO,
    load: importPluginModule,
    internal: ({ status, registry }) => [createManagerPlugin(status, registry), createModsPlugin()],
    async trust(root, plugins) {
      /*
       * Consent is a question about code that is about to run. The loader
       * refuses every file plugin first, so the dialog would be asking the
       * user to authorize nothing: `hasConsent` and the question below come
       * back the day the loader does (brief: bloccare il caricatore).
       */
      if (FILE_PLUGINS_DISABLED) return true
      let stored: string | null = null
      try {
        stored = localStorage.getItem(CONSENT_KEY)
      } catch {
        // No storage: ask every time.
      }
      if (hasConsent(stored, root, plugins)) return true
      const { ask } = await import("@tauri-apps/plugin-dialog")
      const allowed = await ask(consentQuestion(root, plugins), {
        title: t("plugins.consent.title"),
        kind: "warning",
        okLabel: t("plugins.consent.run"),
        cancelLabel: t("plugins.consent.later"),
      })
      if (allowed) {
        try {
          localStorage.setItem(CONSENT_KEY, withConsent(stored, root, plugins))
        } catch {
          // Approved for this start only.
        }
      }
      return allowed
    },
    host: {
      data: {
        project: () => {
          const current = project()
          if (!current) return undefined
          return { name: current.name, root: current.root, branch: current.branch }
        },
        session: {
          list: () =>
            wb()
              .panes.filter((pane) => !isPanelPane(pane))
              .map(toPluginSession),
          get: (id) => {
            const pane = wb().panes.find((item) => item.id === id)
            return pane && !isPanelPane(pane) ? toPluginSession(pane) : undefined
          },
          focused: () => {
            const pane = wb().panes.find((item) => item.id === wb().focusedId)
            return pane && !isPanelPane(pane) ? toPluginSession(pane) : undefined
          },
        },
      },
      showPalette: () => setPaletteOpen(true),
      onPaneOpened: (pane) => {
        setWb((w) =>
          addPane(w, {
            id: pane.id,
            title: pane.title,
            // A plugin tile has no process, so the only honest status is the
            // one that draws no liveness sweep.
            status: "done",
            model: "—",
            mode: "plugin",
            ...here(),
            lines: [],
            plugin: { pluginId: pane.pluginId, name: pane.name },
          }),
        )
      },
      onPaneClosed: (paneId) => setWb((w) => closePane(w, paneId)),
    },
  })

  /*
   * Reloaded when the project changes, because what is declared is the
   * project's business: `.nikcli/tui.json` belongs to the checkout, and the
   * plugins of the project you just left have no reason to keep a section in
   * the sidebar of the one you just opened.
   */
  createEffect(
    on(
      () => project()?.root,
      (root) => {
        void pluginRuntime.start(root)
      },
    ),
  )

  // Synchronously, at the top level of the component: an `onCleanup` after an
  // await has a null owner and is a silent no-op.
  onCleanup(() => {
    void pluginRuntime.dispose()
  })

  // Load recents and workspace on mount
  onMount(async () => {
    const startedAt = Date.now()
    const host = await getHost()
    setHasHost(!!host)

    /*
     * Not awaited: it decides whether a spawn passes a nonce, and the panes
     * restored below take seconds to start. Holding the splash on two file
     * reads to win the id of a session that is not running yet is the wrong
     * trade — a session started before the answer arrives simply resumes the
     * way it did before the hook existed.
     */
    void refreshHooks()

    // Load recents
    const savedRecents = localStorage.getItem("ade.recents")
    if (savedRecents) {
      setRecents(parseRecents(savedRecents))
    }
    // Which of them are gone, asked in the background: marked, not removed.
    if (host?.exists) void missingRecents(recents(), host.exists).then(setMissingRoots)

    themeState.restore()
    setBooting(t("boot.restore"))

    // Load workspace
    const savedWs = localStorage.getItem("ade.workspace")
    let restored: WorkspaceState | undefined
    if (savedWs) {
      const state = parseWorkspace(savedWs)
      if (state) {
        restored = state
        setWb(fromWorkspaceState(state))
        // The suspended sessions' queues, now that their panes are back (P1-C6).
        // Also for a pane resumed just before ADE closed: its mail waits for the session to start again.
        heldLines.push(...parseSuspendedMail(readStored(SUSPENDED_MAIL_KEY)).filter((line) => paneExists(line.paneId)))
      }
    }

    // Discover project
    if (host) {
      setBooting(t("boot.project"))
      const here = host.currentDir ? await host.currentDir() : ""
      const saved = restored?.projectPath
      // The last project's folder gone: ADE opens where it was started, and says why.
      const gone = saved ? await refuseMissingRoot(host, saved) : false
      const path = (!gone && saved) || here
      const p = await discoverProject(host, path)
      setProject(p)

      const newRecents = addRecent(recents(), { root: p.root, name: p.name })
      setRecents(newRecents)
      localStorage.setItem("ade.recents", serializeRecents(newRecents))

      setWb((w) => ({ ...w, projectPath: p.root }))

      /*
       * Restarting what was running when the app went away.
       *
       * A pty is a child of this process: closing the window kills it, and a
       * machine restart kills everything, so no session literally survives.
       * What can survive is the session's identity — its agent, its directory
       * and the task it was given — and starting that work again on open is
       * what "the sessions come back" can actually mean.
       *
       * Only after the project resolves, because `startProcess` needs it to
       * choose a working directory, and only for sessions that were live and
       * carry a task: a finished one has nothing to resume, and a task-less
       * one would launch an agent with an empty prompt.
       */
      if (restored) {
        /*
         * Planned all at once, not one at a time.
         *
         * The CLIs that cannot be asked for a specific conversation can only
         * offer "the most recent one in this directory", and two panes both
         * taking that offer reopen the same conversation and then race each
         * other inside it. `planRestore` hands the claim out once.
         */
        /*
         * And checked against the disk first: an id ADE pinned is only a
         * conversation once the agent has written one. Resuming an id that was
         * never used prints "No conversation found" and opens a thread under
         * an id nobody recorded — on every restart, forever. The agent runs in
         * `p.root` (see `startProcess`), so that is where its transcript is.
         */
        const sessions = await Promise.all(
          sessionsToResume(restored).map(async (saved) => {
            // The conversation the pane last switched to, when ADE closed before reading it.
            const reported = await adoptLastReport(saved)
            const pane = reported ? { ...saved, resumeId: reported } : saved
            return {
              agentId: pane.agent,
              cwd: pane.cwd || p.root,
              ...(pane.resumeId !== undefined ? { resumeId: pane.resumeId } : {}),
              missing: await conversationMissing(pane.agent, pane.resumeId, pane.cwd || p.root),
              pane,
            }
          }),
        )
        const planned = planRestore(sessions)
        for (const { session, plan, sharedWith } of planned) {
          if (sharedWith) {
            // The conversation stays with the other pane: this one must not reopen it by its saved id.
            setWb((w) => updatePane(w, session.pane.id, { resumeId: undefined }))
            tellPane(session.pane.id, t("resume.shared", sharedWith.pane.title))
          }
          void reopening.run(session.pane.id, () =>
            startProcess(session.pane.id, session.pane.agent, session.pane.task ?? "", plan),
          )
        }

        /*
         * And the sessions whose agent had already exited, too.
         *
         * They used to wait for a click on "Riprendi", and nobody opens ADE to
         * look at a dead transcript: the pane is there to be used. `reopen`
         * asks for the conversation by id when there is one, and starts the
         * agent fresh when there is not.
         */
        // With the claims just handed out: a pane planned `here` has not reported its id yet.
        const claims = restoreClaims(planned)
        const plannedIds = new Set(sessions.map((session) => session.pane.id))
        for (const pane of exitedToReopen(wb().panes, plannedIds)) void reopen(pane, undefined, claims)
      }
    }

    /*
     * The splash stays up for a moment even when there was nothing to wait
     * for.
     *
     * On a warm start the whole of the above finishes in under a hundred
     * milliseconds, and a screen that appears and vanishes in that time is a
     * flash of something the user cannot read — worse than no splash at all.
     * A floor, not a delay: when the start really does take two seconds the
     * splash goes the moment it is over.
     */
    const remaining = splashRemainingMs(startedAt, Date.now())
    if (remaining > 0 && booting() !== undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining)
        skipSplashResolver = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    setBooting(undefined)
    // The local speech model that was removed left its download in the webview's storage: dropped once, after the screen is up.
    void dropLegacyParakeet()
  })

  const autosave = createAutosave({
    // The revision and not the store: reading `wb()` subscribes to nothing,
    // because a store is tracked per property and the save cares about all of
    // them.
    changed: revision,
    write: () =>
      // Unwrapped: serialising walks every pane and every line, and doing that
      // through the store's proxy would subscribe whatever happens to be
      // tracking to the entire workbench.
      localStorage.setItem("ade.workspace", serializeWorkspace(toWorkspaceState(unwrap(wbStore)))),
  })

  // Keydown listener
  onMount(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const resolution = resolveVoiceOrAdeKey(bindings, voiceSettings(), e, platform)

      /*
       * Voice shortcuts take absolute precedence everywhere, even inside terminals or text inputs!
       * Intercepted in capture phase with stopPropagation so xterm cannot swallow them.
       */
      if (resolution.type === "voice-agent" || resolution.type === "voice-transcription") {
        e.preventDefault()
        e.stopPropagation()
        const mode = resolution.type === "voice-agent" ? "agent" : "transcription"
        if (!voiceSettings().openRouterApiKey) {
          if (wb().view !== "agent") {
            setWb((w) => ({ ...w, view: "agent" }))
            return
          }
        }
        if (holdsToTalk(voiceSettings(), mode)) {
          const chord = mode === "agent" ? voiceSettings().agentChord : voiceSettings().transcriptionChord
          void pttHandler.onKeyDown(parseChord(chord, platform), e, mode)
        } else {
          if (e.repeat) return
          void voiceEngine.toggle(mode)
        }
        return
      }

      /*
       * Inside a terminal, the terminal gets the key.
       *
       * xterm renders into a textarea, and the guard below let every Ctrl
       * chord through on the grounds that a bare letter in a text field is
       * typing while Ctrl+something is a command. In a terminal it is the
       * other way round: Ctrl+W deletes a word, Ctrl+N walks the history,
       * Ctrl+Shift+V pastes. ADE was taking all three — and Ctrl+W did not
       * just steal a keystroke, it closed the pane and killed the agent
       * running in it. On Windows and Linux, where `mod` is Ctrl, that is a
       * daily occurrence.
       */
      const isTerminal = Boolean(target?.closest?.('[data-slot="pane-terminal"]'))
      if (isTerminal && resolution.type === "ade" && !FROM_TERMINALS.has(resolution.commandId ?? "")) return
      // And inside the palette, its Ctrl+N and Ctrl+P walk the list (`paletteStep`).
      if (target?.closest?.('[data-component="palette"]') && paletteStep(e) !== 0) return

      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
      if (isInput && !e.ctrlKey && !e.metaKey && !e.altKey) return
      // Nor a close, from a text field: the chord is swallowed, so it closes neither the pane nor the window.
      if (
        isInput &&
        resolution.type === "ade" &&
        resolution.commandId &&
        NOT_FROM_TEXT_FIELDS.has(resolution.commandId)
      ) {
        e.preventDefault()
        return
      }

      if (resolution.type === "ade") {
        if (resolution.commandId && isHandledCommand(resolution.commandId)) {
          e.preventDefault()
          e.stopPropagation()
          void runCommand(resolution.commandId)
        }
        return
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (pttHandler.isPressed() && pttHandler.shouldReleaseKey(e.key, e.code)) {
        e.preventDefault()
        e.stopPropagation()
        void pttHandler.onKeyUp(e.key, e.code)
      }
    }

    const handleBlur = () => {
      if (pttHandler.isPressed()) {
        void pttHandler.onBlur()
      }
    }

    let closingConfirmed = false
    let isHandlingClose = false

    /*
     * Closing the window is the one way out of ADE that `close` cannot guard.
     * A modified buffer lives only in memory, so quitting with one open loses
     * it as completely as closing its pane would; and a reload ends every
     * running agent (`mustConfirmLeaving`).
     */
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (closingConfirmed) return
      const unsavedBuffers = Object.values(buffers()).filter((buffer) => buffer.dirty).length
      if (!mustConfirmLeaving({ unsavedBuffers, runningSessions: running.size })) return
      event.preventDefault()
      // Browsers ignore the text and show their own, but setting returnValue
      // is still what makes the prompt appear at all.
      event.returnValue = ""
    }

    let unlistenClose: (() => void) | undefined
    let unlistenHide: (() => void) | undefined
    let unlistenHidden: (() => void) | undefined
    let unlistenShown: (() => void) | undefined
    if (isTauriDesktop()) {
      void import("@tauri-apps/api/event").then(({ listen }) => {
        listen<{ requestId?: number }>("ade-window-close-requested", async (event) => {
          const requestId = event.payload?.requestId
          if (isHandlingClose) return
          isHandlingClose = true
          const closeForGood = () =>
            closeAfterSaving({
              flush: () => autosave.flush(),
              close: async () => {
                try {
                  const { invoke } = await import("@tauri-apps/api/core")
                  await invoke("ade_confirm_close", { requestId })
                } catch {
                  const { getCurrentWindow } = await import("@tauri-apps/api/window")
                  await getCurrentWindow().close()
                }
              },
            })

          try {
            // Acknowledge receipt to Rust to disarm the safety timeout while
            // prompting the user, or while the workbench reaches the disk.
            try {
              const { invoke } = await import("@tauri-apps/api/core")
              await invoke("ade_close_ack", { requestId })
            } catch {}

            const working = countWorkingSessions(wb().panes, running)
            if (!shouldConfirmWindowClose({ working })) {
              closingConfirmed = true
              await closeForGood()
              return
            }

            const message = closeConfirmationMessage(working)
            const allowed = await askCloseConfirmation(message)
            if (allowed) {
              closingConfirmed = true
              await closeForGood()
            } else {
              try {
                const { invoke } = await import("@tauri-apps/api/core")
                await invoke("ade_cancel_close", { requestId })
              } catch {}
            }
          } finally {
            isHandlingClose = false
          }
        }).then((unlisten) => {
          unlistenClose = unlisten
        })

        /*
         * The X with a bot's gateway on hides ADE to the tray (G11): said
         * first, and with sessions at work asked (`surface/tray-hide.ts`).
         * Rust waits a few seconds for `ade_tray_take`, then hides anyway.
         */
        listen<{ requestId?: number }>("ade-window-hide-requested", async (event) => {
          const requestId = event.payload?.requestId
          const { invoke } = await import("@tauri-apps/api/core")
          if (requestId === undefined || !(await invoke<boolean>("ade_tray_take", { requestId }).catch(() => false)))
            return
          const working = wb().panes.filter((pane) => isWorkingAgentPane(pane, running))
          const storage = (() => {
            try {
              return window.localStorage
            } catch {
              return undefined
            }
          })()
          const plan = planHide({ working: working.length, noticed: trayNoticed(storage) })
          const dialog = await import("@tauri-apps/plugin-dialog")
          if (plan.kind === "ask") {
            const buttons = hideButtons()
            const answer = await dialog
              .message(t("tray.hide.working", plan.working), { title: "ADE", kind: "warning", buttons })
              .catch(() => undefined)
            const choice = hideChoice(answer, buttons)
            if (choice === "keep") return
            if (choice === "close-sessions") await closer.closeAll(working.map((pane) => pane.id))
          } else if (plan.kind === "notice") {
            await dialog.message(t("tray.hide.notice"), { title: "ADE", kind: "info" }).catch(() => undefined)
            markTrayNoticed(storage)
          }
          await invoke("ade_hide_to_tray").catch(() => {})
        }).then((unlisten) => {
          unlistenHide = unlisten
        })
        // Hidden: no microphone open in a window nobody sees; the guard brings listening back with the window.
        listen("ade-window-hidden", () => {
          hiddenInTray = true
          if (voiceEngine.isRunning()) void voiceEngine.pauseListening()
        }).then((unlisten) => {
          unlistenHidden = unlisten
        })
        listen("ade-window-shown", () => {
          hiddenInTray = false
        }).then((unlisten) => {
          unlistenShown = unlisten
        })
      })
    }

    window.addEventListener("keydown", handleKeyDown, true)
    window.addEventListener("keyup", handleKeyUp, true)
    window.addEventListener("blur", handleBlur)
    window.addEventListener("beforeunload", handleBeforeUnload)
    // The voice's OpenRouter key from nikcli's auth.json when the profile has none;
    // never under ADE Test's identity, whose profiles would get the user's paid key.
    if (!voiceSettings().openRouterApiKey) {
      void (async () => {
        const host = await getHost()
        if (!host?.homeDir || !host.readTextFile) return
        await syncOpenRouterKey({
          identifier: async () => (await import("@tauri-apps/api/app")).getIdentifier(),
          homeDir: () => host.homeDir!(),
          readTextFile: (path, maxBytes) => host.readTextFile!(path, maxBytes),
          save: (key) => handleVoiceSettingsChange({ ...voiceSettings(), openRouterApiKey: key }),
          removed: isOpenRouterKeyRemoved,
        })
      })().catch(() => {})
    }

    // The bots' gateways: a message from a chat becomes a turn of its bot (G4).
    // Rust reads no chat until this listens; the cleanup is registered before
    // the await, so a reloaded workbench never answers a chat twice.
    if (isTauriDesktop()) {
      let gateway: { stop: () => void } | undefined
      let gatewayGone = false
      onCleanup(() => {
        gatewayGone = true
        gateway?.stop()
      })
      void import("../bots/gateway/bridge")
        .then(({ startAppGatewayController }) => startAppGatewayController())
        .then((started) => (gatewayGone ? started.stop() : (gateway = started)))
        .catch((error) => console.warn("ADE: gateway dei bot non avviato", error))
    }

    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)) {
      /*
       * The cleanup is registered here, before the first await. It used to be
       * an `onCleanup` at the end of the async block below, where Solid has no
       * owner and the call does nothing: closing the workbench left the global
       * hotkeys registered and the listener alive.
       */
      let disposed = false
      let releaseGlobal: (() => void) | undefined
      onCleanup(() => {
        disposed = true
        releaseGlobal?.()
      })
      void (async () => {
        try {
          const { listen } = await import("@tauri-apps/api/event")
          const { invoke } = await import("@tauri-apps/api/core")

          /*
           * Registered from the settings as they are now, and again whenever
           * they change: the panel used to save a new chord that the OS kept
           * ignoring until the next launch, while the old one still opened
           * the microphone from anywhere.
           *
           * Through the serialiser, because a second save arriving while this
           * one is still claiming used to unregister what it had just claimed:
           * the chords the user kept were whichever finished last.
           */
          const syncGlobalShortcuts = serialiseRegistrations(async (settings: VoiceSettings) => {
            const { failed } = await registerVoiceShortcuts(settings, {
              unregisterAll: () => invoke("unregister_global_voice_shortcuts") as Promise<void>,
              register: (chord) => invoke("register_global_voice_shortcut", { chord }) as Promise<void>,
              report: (message) => report(message, "warning"),
            })
            setShortcutRefusals(refusalsOf(failed))
          })

          await syncGlobalShortcuts(voiceSettings())
          registerGlobalShortcuts = syncGlobalShortcuts

          /*
           * The OS takes a registered hotkey before the webview sees the key,
           * so inside ADE's own window this event is the only keydown these
           * chords ever produce. It has to do everything the window listener
           * does for them: tell the two features apart by chord, and honour
           * push-to-talk on the release.
           */
          const unlisten = await listen<unknown>(GLOBAL_VOICE_EVENT, (event) => {
            const action = globalVoiceAction(event.payload, voiceSettings(), platform)
            if (action.kind === "ignore") return
            if (action.kind === "unknown") {
              // Said, never guessed: see `globalVoiceAction`.
              report(unknownChordMessage(action.chord), "warning")
              return
            }

            if (action.kind === "release") {
              // No key to compare: the native side already said the chord let go.
              // Nothing held, nothing released.
              void pttHandler.onKeyUp()
              return
            }
            if (holdsToTalk(voiceSettings(), action.mode)) {
              const chord = action.mode === "agent" ? voiceSettings().agentChord : voiceSettings().transcriptionChord
              void pttHandler.onKeyDown(parseChord(chord, platform), { repeat: false }, action.mode)
              return
            }
            void voiceEngine.toggle(action.mode)
          })

          releaseGlobal = () => {
            releaseGlobal = undefined
            unlisten()
            registerGlobalShortcuts = undefined
            void invoke("unregister_global_voice_shortcuts").catch(() => {})
          }
          // Closed while the awaits above were still running.
          if (disposed) releaseGlobal()
        } catch (e) {
          console.warn("Inizializzazione scorciatoia globale saltata:", e)
        }
      })()
    }

    onCleanup(() => {
      unlistenClose?.()
      unlistenHide?.()
      unlistenHidden?.()
      unlistenShown?.()
      window.removeEventListener("keydown", handleKeyDown, true)
      window.removeEventListener("keyup", handleKeyUp, true)
      window.removeEventListener("blur", handleBlur)
      window.removeEventListener("beforeunload", handleBeforeUnload)
    })
  })

  // Commands
  // Behind an open sheet, what opens something to type into would open it under the sheet's focus trap.
  const runCommand = guardedBySheet(sheetOpen, async (id: string) => {
    // Returns, because the last line of this function closes the palette.
    // See `keepsPaletteOpen` for why that is not a detail.
    if (keepsPaletteOpen(id)) {
      setPaletteOpen(true)
      return
    }

    /*
     * Plugin commands are dispatched before ADE's own chain, and by shape
     * rather than by lookup in a list.
     *
     * `parseCommandId` only answers for the `plugin:<id>:<command>` form, and
     * `trust.ts` is what guarantees no ADE command can ever take that form —
     * so this branch cannot shadow a built-in, and a built-in cannot shadow a
     * plugin. The handler is still looked up in the registry: a command whose
     * plugin has been disposed since the palette drew the row is gone, and
     * running nothing is the right answer.
     */
    const qualified = parseCommandId(id)
    if (qualified) {
      const entry = pluginRuntime.registry.findCommand(id)
      // Awaited, so a command that throws is caught here rather than becoming
      // an unhandled rejection with no plugin named in it.
      if (entry) {
        await Promise.resolve()
          .then(() => entry.run())
          .catch((error) => {
            console.error(`[ade.plugin] ${entry.pluginId} command ${entry.commandId} failed`, error)
          })
      }
      setPaletteOpen(false)
      return
    }

    if (id === "session.new") {
      // A pane is born because a process is starting, never before: the button
      // opens the launch screen and the launch screen creates the panes.
      setStarting(true)
    } else if (id === "project.open") {
      const host = await getHost()
      if (host) {
        const p = await openProject(host)
        if (p) {
          setProject(p)
          // The panes of the project being left stay: their sessions keep running, and keep talking to the others.
          setWb((w) => ({ ...w, projectPath: p.root, expandedId: undefined }))
          const newRecents = addRecent(recents(), { root: p.root, name: p.name })
          setRecents(newRecents)
          localStorage.setItem("ade.recents", serializeRecents(newRecents))
        }
      }
    } else if (id === "pane.close") {
      // A shortcut or the palette: an agent at work is ended only on a yes (ALTO 6).
      if (wb().focusedId) closer.close(wb().focusedId!, { confirmRunning: true })
    } else if (id === "pane.expand") {
      if (wb().focusedId) setWb((w) => expandPane(w, w.focusedId!))
    } else if (id === "pane.rename") {
      // Handled by the pane itself: the title is edited where it is shown.
      requestRename(wb().focusedId)
    } else if (id === "view.toggle") {
      setWb((w) => ({ ...w, view: nextView(w.view) }))
    } else if (id.startsWith("view.")) {
      // Matched against the list rather than parsed off the id, so a command
      // called "view.anything" cannot put the workbench in a view that has no
      // branch to render it.
      // Only a section the bar shows: a hidden one has no command to run (S40).
      const target = VISIBLE_VIEWS.find((view) => `view.${view}` === id)
      if (target) setWb((w) => ({ ...w, view: target }))
    } else if (id === "theme.set.light" || id === "theme.set.dark" || id === "theme.set.glass") {
      themeState.set(id === "theme.set.light" ? "light" : id === "theme.set.dark" ? "dark" : "glass")
    } else if (id === "sidebar.toggle") {
      toggleSidebar()
    } else if (id === "theme.toggle") {
      // The attribute goes on ADE's own root, not the document's: ADE is mounted
      // inside another application and must not restyle its host.
      themeState.toggle()
    } else if (id === "video.new") {
      /*
       * Opened empty. The panel has its own picker over the project's media,
       * and guessing a file would be guessing which of a dozen recordings
       * the user meant — and the agent can open one itself with
       * `@ade video open <percorso>`.
       */
      setWb((w) =>
        addPane(w, {
          id: newPaneId("v"),
          title: t("pane.video.title"),
          status: "working",
          model: "—",
          mode: "video",
          videoPath: "",
          ...here(),
          lines: [],
        }),
      )
    } else if (id === "update.check") {
      void checkForUpdates()
    } else if (id === "decisions.open" || id === "design.open") {
      // Both open the one list; the voice's «apri le decisioni» comes here too.
      setChoicesOpen(true)
    } else if (id === "decisions.pane") {
      openDecisionsPane()
    } else if (id === "design.pane") {
      openDesignPane()
    } else if (id === "model.new") {
      // Opened empty, like the video panel; a model file clicked in the tree opens it directly.
      openModel("")
    } else if (id === "app.new") {
      /*
       * Opened empty: the panel lists the dev servers the project's config
       * points at, and guessing one to load would load the wrong app half
       * the time — or ADE's own Vite server.
       */
      setWb((w) =>
        addPane(w, {
          id: newPaneId("a"),
          title: "Simulatore",
          status: "working",
          model: "—",
          mode: "app",
          appUrl: "",
          ...here(),
          lines: [],
        }),
      )
    } else if (id === "browser.new") {
      const newId = newPaneId("b")
      setWb((w) =>
        addPane(w, {
          id: newId,
          title: "Browser",
          status: "working",
          model: "—",
          mode: "browser",
          // Where a dev server usually is. The pane has an address bar, so this is
          // a starting point rather than a decision the user is stuck with.
          browserUrl: DEFAULT_PREVIEW_URL,
          /*
           * The project's own id, like every other pane.
           *
           * "ws-browser" was not a workspace: `gridPanes` keeps only the panes
           * whose `workspaceId` matches the open project, so with a project open
           * the browser pane was created, given the focus, and then drawn
           * nowhere — and the next Ctrl+W closed a pane the user could not see.
           * It worked in the browser harness only because `project()` is
           * undefined there and the filter is skipped.
           */
          ...here(),
          lines: [],
        }),
      )
    } else if (id === "session.suspend") {
      if (wb().focusedId) void suspendSession(wb().focusedId!)
    } else if (id === "process.kill") {
      if (wb().focusedId && isRunning(wb().focusedId!)) {
        running.get(wb().focusedId!)?.kill()
        running.delete(wb().focusedId!)
        touchRunning()
        setWb((w) =>
          updatePane(w, w.focusedId!, {
            status: "error",
            activity: "killed",
            lines: [
              ...(w.panes.find((p) => p.id === w.focusedId)?.lines || []),
              { kind: "note", text: t("pane.killed") },
            ],
          }),
        )
      }
    } else if (id === "voice.toggle") {
      if (!voiceSettings().openRouterApiKey) {
        if (wb().view !== "agent") {
          setWb((w) => ({ ...w, view: "agent" }))
          return
        }
      }
      void voiceEngine.toggle()
    } else if (id === "record.toggle") {
      // Closed first: the folder dialog may open, and a palette left open behind it takes another Enter.
      setPaletteOpen(false)
      const problem =
        recordState().status === "recording"
          ? await recorder.stop()
          : await startRecording({ kind: "window" }, { mic: recordMic() })
      if (problem) report(problem)
    } else if (id === "record.mic") {
      const next = !recordMic()
      setRecordMic(next)
      try {
        localStorage.setItem("ade.record.mic", next ? "on" : "off")
      } catch {
        // Kept for this session only.
      }
      report(next ? t("record.mic.on") : t("record.mic.off"), "info")
    } else if (id === "record.quality") {
      /*
       * Cycled rather than a submenu: three levels, and the palette row
       * already says which one is on and what it costs a minute.
       */
      const order = QUALITY_LEVELS.map((level) => level.id)
      const next = order[(order.indexOf(recordQuality()) + 1) % order.length] ?? DEFAULT_QUALITY
      setRecordQuality(next)
      try {
        localStorage.setItem("ade.record.quality", next)
      } catch {
        // Kept for this session only.
      }
      const level = qualityLevel(next)
      report(t("record.quality.set", level.label, sizePerMinute(level)), "info")
    } else if (id === "record.export") {
      void exportLastTake()
    } else if (id === "record.folder") {
      await pickRecordDir()
    } else if (id === "voice.settings") {
      setVoiceSettingsOpen(true)
    } else if (id === "panes.closeGone") {
      await closer.closeAll(
        wb()
          .panes.filter((pane) => pane.gone && !running.has(pane.id))
          .map((pane) => pane.id),
      )
    } else if (id === "recents.forgetGone") {
      const count = recents().filter((entry) => isMissingRecent(missingRoots(), entry.root)).length
      if (count > 0 && (await askYesNo(t("confirm.forgetGone", count)))) {
        const next = withoutMissing(recents(), missingRoots())
        setRecents(next)
        localStorage.setItem("ade.recents", serializeRecents(next))
        setMissingRoots(new Set<string>())
        // The notice's «Togli dall'elenco» has nothing left to remove.
        setNoticeAction(undefined)
      }
    } else if (parseDesignVariantCommand(id)) {
      const wanted = parseDesignVariantCommand(id)!
      const proposal = designRegister.state()?.proposals.find((candidate) => candidate.k === wanted.k)
      // The proposal's one sheet, where every variant is (notifiche-design); the browser pane's Design mode is gone.
      if (proposal) {
        setChoiceStart(proposal.k)
        setDesignOpen(true)
      } else report(t("design.variant.missing", wanted.k, wanted.variant))
    } else if (id.startsWith("project.recent.")) {
      const root = id.slice("project.recent.".length)
      const host = await getHost()
      if (host && !(await refuseMissingRoot(host, root))) {
        const p = await discoverProject(host, root)
        setProject(p)
        setWb((w) => ({ ...w, projectPath: p.root, expandedId: undefined }))
        const newRecents = addRecent(recents(), { root: p.root, name: p.name })
        setRecents(newRecents)
        localStorage.setItem("ade.recents", serializeRecents(newRecents))
      }
    }
    // Moving focus between panes is not handled here: the grid measures its own
    // columns, so `SessionGrid` owns the arrow keys and answers with the real
    // geometry rather than a guess made from the window size.
    setPaletteOpen(false)
  })

  const allCommands = createMemo(() => {
    // Reading the tick is what makes "uccidi processo" enable itself the moment
    // a process starts, and disable itself when it dies.
    runningTick()
    return buildCommands({
      workbench: wb(),
      recents: recents(),
      missingRecent: (root) => isMissingRecent(missingRoots(), root),
      designVariants: (designRegister.state()?.proposals ?? [])
        .filter((proposal) => proposal.status !== "chiusa")
        .map((proposal) => ({
          k: proposal.k,
          title: proposal.title,
          variants: proposal.variants.map((variant) => variant.name),
        })),
      hasHost: hasHost(),
      running: new Set(running.keys()),
      sidebarHidden: sidebarHidden(),
      platform,
      voiceAvailable,
      voiceActive: voiceEngine.isRunning(),
      voiceChord: voiceSettings().agentChord,
      ...(wb().focusedId ? { suspendCheck: suspendCheckFor(wb().focusedId!) } : {}),
      recording: recordState().status === "recording",
      recordMic: recordMic(),
      recordQuality: `${qualityLevel(recordQuality()).label} (${sizePerMinute(qualityLevel(recordQuality()))})`,
      // Read through the registry signal, so a plugin loading or being torn
      // down changes the palette without anything having to refresh it.
      pluginCommands: pluginRuntime.registry.commands().map((command) => ({
        id: command.key,
        title: command.title,
        group: command.group,
        keywords: command.keywords,
      })),
    })
  })

  /*
   * Output goes to the pane's terminal whether or not that pane is on screen.
   * A session in a collapsed pane keeps running, and coming back to it must
   * show what happened while you were away rather than a gap.
   */
  /*
   * Working until the output goes quiet.
   *
   * Nothing else says when an interactive agent has finished its turn: the
   * process stays alive, so `finish` never runs, and a pane marked working
   * stayed working forever. Silence is the signal — an agent that is busy
   * animates, one waiting for the user does not.
   */
  const QUIET_MS = 2500
  const quietTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const settleWhenQuiet = (paneId: string) => {
    clearTimeout(quietTimers.get(paneId))
    quietTimers.set(
      paneId,
      setTimeout(() => {
        quietTimers.delete(paneId)
        const status = wb().panes.find((pane) => pane.id === paneId)?.status
        // Only where the hook reports turns: without it silence settles the pane
        // anyway, and a prompt the screen found is not taken back on an Esc
        // that another TUI may not honour.
        const cut = hooked(paneId) && interruptEnds(activityOf.get(paneId), interruptedAt.get(paneId))
        if (status !== "working" && !(cut && status === "waiting")) return
        // Without turn hooks, a session that owes an answer is working until it answers (S14).
        // A prompt counts as work here too, so a pane waiting on a key is not offered
        // as idle: see `activityOccupiesPane`.
        const outcome = quietOutcome({
          hooked: hooked(paneId),
          busy: activityOccupiesPane(activityOf.get(paneId)?.state),
          owesAnswer: holdsForAnswer([...openRequests.values()], paneId, Date.now()),
          interrupted: cut,
        })
        // The hold has to be re-armed: it ends with time passing, and nothing
        // else would come back to look at a pane whose terminal has gone quiet.
        if (outcome === "recheck") return settleWhenQuiet(paneId)
        if (outcome === "wait") return
        if (cut) settleInterrupt(paneId)
        setWb((w) => updatePane(w, paneId, { status: "idle", activity: "ready" }))
      }, QUIET_MS),
    )
  }
  /*
   * An Esc or a Ctrl-C in a pane: the turn may be over, and only silence will say.
   *
   * Claude Code reports an interruption to no hook, so its file goes on saying
   * busy, or permission after an Esc on a prompt. The quiet timer is armed here
   * as well as by the output that follows, because a pane on a prompt is not
   * working and its output would not arm it.
   */
  const interrupted = (paneId: string) => {
    interruptedAt.set(paneId, Date.now())
    settleWhenQuiet(paneId)
  }
  /** The idle the CLI never wrote, for an interrupted turn that has gone quiet. */
  const settleInterrupt = (paneId: string) => {
    const at = interruptedAt.get(paneId)
    if (at === undefined) return
    interruptSettled.set(paneId, at)
    const idle = afterInterrupt(activityOf.get(paneId), at)
    if (idle) activityOf.set(paneId, idle)
    // An Esc on a prompt the screen found cancels it: Claude Code answers no to the tool.
    if (permissions()[paneId]) {
      permissions.forget(paneId)
      rawWindows.forget(paneId)
      if (voiceEngine.isRunning()) void voiceEngine.handlePermissionResolved(paneId)
    }
  }
  /*
   * An idle agent printing without pause has started a turn ADE did not see begin.
   *
   * Only where no hook reports turns: there the hook is the truth both ways. Not
   * for a plain terminal, whose running program is not an agent's turn and which
   * nobody sends mail to.
   */
  const noticeWorkFromOutput = (pane: Pane) => {
    // A hooked pane whose hook has said nothing yet is guessed like any other.
    if ((pane.agent ?? pane.model) === "terminal" || (hooked(pane.id) && activityOf.has(pane.id))) return
    const run = outputRun(outputRuns.get(pane.id), Date.now(), lastInputAt.get(pane.id))
    if (!outputSaysWorking(run)) {
      if (run) outputRuns.set(pane.id, run)
      else outputRuns.delete(pane.id)
      return
    }
    outputRuns.delete(pane.id)
    markWorking(pane.id)
  }
  const forgetQuiet = (paneId: string) => {
    clearTimeout(quietTimers.get(paneId))
    quietTimers.delete(paneId)
  }

  const feedTerminal = (paneId: string, chunk: string) => {
    /*
     * Nothing is written to a pane that no longer exists.
     *
     * `writeToTerminal` creates the xterm instance on demand, so a chunk
     * that arrived after `close` — and one always does, because killing a
     * process does not retract what it already wrote — resurrected a whole
     * terminal, buffer and all, for a pane with no card on screen and no
     * way to reach it. It was then never disposed, because `close` had
     * already run.
     */
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (!pane) return

    // A working agent keeps repainting (spinner, streamed text); every chunk
    // pushes back the moment the pane is declared idle again.
    if (pane.status === "working") settleWhenQuiet(paneId)
    // An interrupted pane on a prompt is not working, and still waits for its silence.
    else if (hooked(paneId) && interruptEnds(activityOf.get(paneId), interruptedAt.get(paneId))) settleWhenQuiet(paneId)
    else if (pane.status === "idle") noticeWorkFromOutput(pane)

    writeToTerminal(paneId, chunk)
    screenRequests.fed(paneId)
    if (!liveTerminals().has(paneId)) {
      setLiveTerminals((ids) => new Set(ids).add(paneId))
    }
  }

  /**
   * Adds a project to the list, by asking the system where it is.
   *
   * Adding, not replacing: the list is where the user keeps the projects they
   * work in, and picking a new one should not quietly evict the last. The
   * sessions of the project being left keep running — they have their own
   * checkouts — and its row stays in the list to go back to.
   */
  const addProject = async () => {
    const host = await getHost()
    if (!host) return
    const picked = await openProject(host)
    if (!picked) return
    const newRecents = addRecent(recents(), { root: picked.root, name: picked.name })
    setRecents(newRecents)
    localStorage.setItem("ade.recents", serializeRecents(newRecents))
    setProject(picked)
    // Same reason as switchProject: an expansion made in another project
    // narrows this one's grid to nothing.
    setWb((w) => ({ ...w, projectPath: picked.root, expandedId: undefined }))
    setStarting(false)
  }

  /**
   * Switches to a project already on disk, by its root.
   *
   * Split out of `switchProject` for voice, which resolves a spoken project
   * name to a root of its own and must not go through
   * `runCommand("project.recent.…")`: that one rebuilds the workbench from
   * scratch, and a spoken "apri nikcli e avvia due sessioni" would throw away
   * every pane of the project being left.
   */
  const switchProjectTo = async (root: string) => {
    const current = project()
    // Compared as a path: the same directory reaches this spelled both ways.
    if (current && pathEquals(current.root, root)) return
    const host = await getHost()
    if (!host) return
    if (await refuseMissingRoot(host, root)) return
    const opened = await discoverProject(host, root)
    setProject(opened)
    /*
     * The expansion belongs to the project it was made in.
     *
     * `gridPanes` keeps the panes of the open project and then, if
     * `expandedId` is set, narrows to that one — so an id left over from
     * another project narrows to nothing. The new project showed the launch
     * screen however many sessions it had running, with no visible control to
     * get out of an expansion the user could not see.
     */
    setWb((w) => ({ ...w, projectPath: opened.root, expandedId: undefined }))
    setStarting(false)
  }

  /**
   * A saved root whose folder is gone — a recent project, a Space, the one
   * restored at start — is not opened: `git` would fail in it and the
   * sessions would start in nothing. The notice says so and offers to take it
   * off the list; nothing is removed unless the user asks. True when refused.
   */
  const refuseMissingRoot = async (
    host: Pick<NonNullable<Awaited<ReturnType<typeof getHost>>>, "exists">,
    root: string,
  ) => {
    const gone = await rootMissing(host, root)
    setMissingRoots((set) => withMissing(set, root, gone))
    if (!gone) return false
    const text = t("project.missing", root)
    report(text, "warning")
    setNoticeAction({ text, label: t("project.missing.remove"), run: () => forgetRecent(root) })
    return true
  }

  /** "Togli dall'elenco": the one way a gone project leaves the list. */
  const forgetRecent = (root: string) => {
    const next = removeRecent(recents(), root)
    setRecents(next)
    localStorage.setItem("ade.recents", serializeRecents(next))
    setMissingRoots((set) => withMissing(set, root, false))
    setNotice(undefined)
  }

  /** Switches to a project already in the list, by the name its row carries. */
  const switchProject = async (id: string) => {
    const entry = recents().find((candidate) => candidate.name === id)
    if (!entry) return
    await switchProjectTo(entry.root)
  }

  /**
   * Opens a session from its row in the sidebar.
   *
   * The row used to set `focusedId` and nothing else, so clicking a session
   * did nothing visible whenever it was not already on screen: in another
   * project, behind another section (`agent`, `chat`), or outside an
   * expansion of a different pane. Opening it means making it the thing on
   * screen — its project, the terminals section, and that session expanded —
   * the same place a new session lands.
   */
  const openSession = async (id: string) => {
    const pane = wb().panes.find((candidate) => candidate.id === id)
    if (!pane) return
    const owner = pane.workspaceId
    if (owner && owner !== project()?.name) {
      const entry = recents().find((candidate) => candidate.name === owner)
      if (entry) await switchProjectTo(entry.root)
    }
    // The new-session form covers the grid while it is open.
    setStarting(false)
    setWb((w) => ({ ...w, view: "code", focusedId: id, expandedId: id }))
  }

  /**
   * Everything keyed by pane id, forgotten in one place.
   *
   * `close` used to clear the process, the terminal and the pane, and leave
   * seven maps holding entries for a pane that no longer exists. They grew for
   * as long as ADE stayed open.
   */
  const forgetPane = (id: string) => {
    records.forget(id)
    rawWindows.forget(id)
    forgetQuiet(id)
    screenRequests.forget(id)
    // Per-pane bookkeeping kept in plain maps, which nothing else clears: a
    // long day of opening and closing sessions used to keep every one of them.
    lastOutputAt.delete(id)
    lastInputAt.delete(id)
    outputRuns.delete(id)
    usageOf.delete(id)
    paneTokens.delete(id)
    paneNonces.delete(id)
    formerNonces.delete(id)
    activityOf.delete(id)
    questionSeenAt.delete(id)
    workingSince.delete(id)
    interruptedAt.delete(id)
    interruptSettled.delete(id)
    bracketedPaste.delete(id)
    sheetWatch.forget(id)
  }

  /*
   * An unsaved file is not closed without asking.
   *
   * The buffer model has always known whether there is anything to lose;
   * nothing asked it. Closing a file pane — by the X, by Ctrl+W, or by the
   * command — dropped the draft with no warning and no way back. The question
   * is the dialog plugin's, so it is answered later: `close` says whether the
   * pane went now, and it goes only on the yes (`editor/closer.ts`).
   */
  const closer = createCloser({
    unsaved: (id) => {
      const buffer = buffers()[id]
      return buffer?.dirty ? buffer.path : undefined
    },
    ask: (path) => askYesNo(t("editor.closeDirty", path)),
    closeNow: (id) => closeNow(id),
    exists: (id) => wb().panes.some((pane) => pane.id === id),
    running: (id) => {
      const pane = wb().panes.find((candidate) => candidate.id === id)
      return pane && running.has(id) ? pane.title || agentLabel(pane.agent ?? pane.model) : undefined
    },
    askRunning: (agent) => askYesNo(t("pane.closeRunning", agent)),
  })
  const close = (id: string): boolean => closer.close(id)

  const closeNow = (id: string) => {
    running.get(id)?.kill()
    running.delete(id)
    touchRunning()
    // A question the voice is asking about this pane has nobody left to answer it.
    if (questionOpen(id)) {
      permissions.forget(id)
      if (voiceEngine.isRunning()) void voiceEngine.handlePermissionResolved(id)
    }
    disposeTerminal(id)
    setLiveTerminals((ids) => {
      if (!ids.has(id)) return ids
      const next = new Set(ids)
      next.delete(id)
      return next
    })
    forgetPane(id)
    // The registry has to hear about it too, or `ui.pane.list()` keeps
    // reporting a tile the user closed and the plugin's own "already open"
    // check refuses to reopen it.
    pluginRuntime.registry.closePane(id)
    setWb((w) => closePane(w, id))
  }

  /*
   * `failed`: the host refused to start it (`onRefused`). There is no exit
   * code to show — «Uscito con ?» read as a process that ran and died — so
   * the header says what happened instead.
   */
  const finish = (id: string, code: number | null, failed?: "startFailed" | "connectFailed") => {
    running.delete(id)
    touchRunning()
    forgetQuiet(id)
    // Whatever was half-written belonged to the process that has gone. Left
    // behind, it would hold mail back from the session that starts next.
    records.typed.forget(id)
    // Suspended: the exit is the one asked for, not the session ending (P1-C6).
    if (wb().panes.find((pane) => pane.id === id)?.suspended) return
    setWb((w) =>
      updatePane(w, id, {
        status: code === 0 && !failed ? "done" : "error",
        activity: failed ?? (code === 0 ? "done" : exitedActivity(code)),
      }),
    )
  }

  /*
   * The project's file list, walked once and kept.
   *
   * Walking a repository costs seconds; doing it on every keystroke would make
   * the search box unusable on exactly the projects where search matters. The
   * list is read on the first query and reused until the project changes —
   * or until it is old enough that files created since would be missing. A
   * stale list still answers at once; the fresh one replaces it for the next
   * keystroke.
   */
  type Walked = { root: string; at: number; entries: { path: string; kind: "file" | "directory" }[] }
  const WALK_FRESH_MS = 30_000
  let walked: Walked | undefined
  let walkingPromise: Promise<Walked> | undefined

  const searchProjectFiles = async (query: string, kinds: ReadonlySet<"file" | "directory">) => {
    const host = await getHost()
    const current = project()
    if (!host || !current) return []

    const sameRoot = walked?.root === current.root
    if (!sameRoot || Date.now() - walked!.at > WALK_FRESH_MS) {
      if (!walkingPromise) {
        walkingPromise = walkProject({ host, root: current.root })
          .then((result) => {
            const entry: Walked = {
              root: current.root,
              at: Date.now(),
              entries: [
                ...(result.dirs ?? []).map((path) => ({ path, kind: "directory" as const })),
                ...result.files.map((path) => ({ path, kind: "file" as const })),
              ],
            }
            walked = entry
            walkingPromise = undefined
            return entry
          })
          .catch((err) => {
            walkingPromise = undefined
            throw err
          })
      }
      // Only a different project has to wait; a merely old list answers now.
      if (!sameRoot) await walkingPromise
    }

    if (!walked) return []
    return searchPaths(walked.entries, query, { root: current.root, kinds, limit: 200 })
  }

  /*
   * Opening a file makes a pane, like everything else here. A file already
   * open is focused rather than opened twice: two panes over one path would
   * let the user edit the same file against itself.
   */
  const openFile = async (path: string, line?: number) => {
    setSelectedFile(path)
    const goTo = line ? { line, at: Date.now() } : undefined

    // A model or a video is looked at, not edited as text: each opens in its panel.
    const route = routeForFile(path)
    if (route === "model") {
      openModel(path)
      return
    }
    if (route === "video") {
      openVideo(path)
      return
    }

    const existing = wb().panes.find((pane) => pane.filePath === path)
    if (existing) {
      setWb((w) => ({ ...updatePane(w, existing.id, goTo ? { fileGoTo: goTo } : {}), focusedId: existing.id }))
      return
    }

    const host = await getHost()
    if (!host?.readTextFile) return

    const id = newPaneId("f")
    setWb((w) =>
      addPane(w, {
        id,
        title: path.split(/[\\/]/).pop() ?? path,
        status: "done",
        model: "—",
        mode: "file",
        filePath: path,
        fileGoTo: goTo,
        lines: [],
        ...here(),
      }),
    )

    // An image, a font or a sound is drawn from its bytes, never read as text.
    if (!readsText(viewKind(path))) return

    bufferLoading.set(id, true)
    try {
      const read = await host.readTextFile(path)
      buffers.set(id, openBuffer({ path, text: read.text, truncated: read.truncated }))
    } catch (error) {
      // Into the pane's own state: `appendLine` wrote it to lines a file pane never shows.
      bufferError.set(id, error instanceof Error ? error.message : String(error))
    } finally {
      bufferLoading.set(id, false)
    }
  }

  /*
   * A click on a link in a session's terminal (`terminal/links.ts`).
   *
   * A URL opens in the browser panel tied to the session, like the offers do;
   * with Ctrl, in the system browser, for the logins that do not work in the
   * panel. A path is read against the folder the session works in and opens in
   * the editor at its line.
   */
  const terminalOutsideConfirm = createOutsideConfirmationTracker()
  // The roots granted to this window, as the host writes and ade-media serves them; not the recents (D1-2).
  const projectRoots = () => grantedRoots()

  const openLink = async (paneId: string, request: LinkRequest) => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    const say = (text: string) => tellPane(paneId, text)
    if (request.kind === "url") {
      if (!request.external) {
        openOwnedBrowser(request.target, { id: paneId, title: pane?.title ?? "" }, true)
        return
      }
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        await invoke("ade_open_external", { url: request.target })
      } catch (error) {
        say(String(error))
      }
      return
    }
    const host = await getHost()
    await openPathLink(request.target, activityOf.get(paneId)?.cwd ?? pane?.cwd ?? project()?.root, request.line, {
      readTextFile: host?.readTextFile,
      open: openFile,
      say: (path) => say(t("pane.link.missing", path)),
      roots: projectRoots(),
      sayNote: (note) => say(note),
      confirmOutside: (path) => terminalOutsideConfirm.checkAndRecord(path),
    })
  }

  const saveFile = async (paneId: string) => {
    const buffer = buffers()[paneId]
    const host = await getHost()
    if (!buffer || !host?.writeTextFile) return
    if (saveBlockedReason(buffer)) return

    /*
     * What somebody else did to the file while it was open.
     *
     * The agents write into the project, and with sessions running in the
     * project directory rather than a checkout of their own that is the same
     * file the editor is holding. Nothing compared the two, so a save silently
     * replaced the agent's version with a copy of the file as it was when the
     * pane opened it.
     */
    if (host.readTextFile) {
      /*
       * A read that failed is not a file that did not change.
       *
       * The `.catch(() => undefined)` here undid the whole check: with
       * `onDisk` undefined the comparison below was skipped and the save
       * went ahead unasked — which is the same overwrite this block exists
       * to prevent, reached by a different route. `readTextFile` throws on
       * purpose (`host/shell.ts`), and the honest answer to "I could not
       * look" is to ask rather than to assume.
       */
      let onDisk: Awaited<ReturnType<NonNullable<typeof host.readTextFile>>> | undefined
      let unreadable: string | undefined
      try {
        onDisk = await host.readTextFile(buffer.path)
      } catch (error) {
        unreadable = error instanceof Error ? error.message : String(error)
      }

      if (unreadable !== undefined) {
        const anyway = await askYesNo(t("editor.saveUnreadable", buffer.path, String(unreadable)))
        if (!anyway) {
          report(t("editor.saveCancelled.unreadable", String(unreadable)), "warning")
          return
        }
      } else if (onDisk && !onDisk.truncated && onDisk.text !== buffer.saved) {
        const overwrite = await askYesNo(t("editor.saveChanged", buffer.path))
        if (!overwrite) {
          report(t("editor.saveCancelled.changed"), "warning")
          return
        }
      }
    }

    // Captured before the await, so what gets written and what gets recorded
    // as written are the same string.
    const written = buffer.draft

    const error = await host.writeTextFile(buffer.path, written)
    if (error) {
      report(t("editor.saveFailed", String(error)))
      return
    }

    /*
     * The entry as it is now, not the one captured above.
     *
     * Writing to disk is a round trip, and the user goes on typing during it.
     * Putting the captured buffer back replaced the draft with the older one —
     * the characters typed during the save were gone, the cursor jumped,
     * and the buffer was marked clean while holding text nobody had saved.
     */
    buffers.update(paneId, (now) => (now ? markSaved(now, written) : now))
  }

  /**
   * A note the user has to read: in the transcript, and over the terminal of
   * a pane that has one, where the transcript is hidden (`withPaneNotice`).
   */
  const tellPane = (id: string, text: string) => {
    appendLine(id, text, "note", "ade")
    setWb((w) => {
      const pane = w.panes.find((candidate) => candidate.id === id)
      return pane ? updatePane(w, id, { notices: withPaneNotice(pane.notices, text) }) : w
    })
  }
  const dismissNotices = (id: string) => setWb((w) => updatePane(w, id, { notices: undefined }))

  /*
   * `from` says who wrote the line. ADE's own notes go in the transcript like
   * the rest, but they are not the agent: read as its report, «Cerco l'ultima
   * conversazione…» became the pane's activity and stayed in its header after
   * the conversation was found and open (Verifiche, live 4). Nor is a note of
   * ADE's a question the agent is asking.
   */
  const appendLine = (
    id: string,
    text: string,
    kind: "step" | "shell" | "note" = "note",
    from: "agent" | "ade" = "agent",
  ) => {
    /*
     * What is stored is the readable form; what is inspected below is the raw
     * line.
     *
     * A permission prompt or a cost can sit inside a frame far longer than a
     * transcript line is allowed to be, so the detectors keep the whole thing
     * and only the transcript is trimmed.
     */
    const shown = cleanTranscriptLine(text)
    if (shown !== undefined) {
      /*
       * The one write that happens thousands of times a minute, so it is the
       * one that does not rebuild the workbench.
       *
       * `produce` pushes onto the one array that grew. Going through the pure
       * reducers instead would copy the pane, the pane list and the workbench
       * for every line, and then hand `reconcile` the whole thing to diff —
       * per line, per agent.
       */
      setWbStore(
        produce((w) => {
          const pane = w.panes.find((p) => p.id === id)
          if (!pane) return
          // A frame redrawn is the same line again; one entry says as much.
          if (pane.lines.at(-1)?.text === shown) return
          pane.lines.push({ kind, text: shown })
          if (pane.lines.length > MAX_PANE_LINES) {
            pane.lines.splice(0, pane.lines.length - MAX_PANE_LINES)
          }
        }),
      )
      setRevision((n) => n + 1)
    }
    if (from === "ade") return
    watchForPermission(id, text)

    // Agents print what they are spending in among everything else. Reading it
    // here is the only way the pane's counters are real rather than decorative.
    reports.update(id, (before) => {
      // `readReportLine` hands the same object back when the line said nothing
      // about spending, which is almost every line: comparing against it keeps
      // a pane out of the map entirely until it has something to report.
      const base = before ?? {}
      const after = readReportLine(base, text)
      return after === base ? before : after
    })
  }

  /*
   * An agent that stops to ask something looks, from the outside, exactly like
   * one that is thinking: the process is alive and the output has stopped. The
   * difference is in the last few lines, which is why every line is read for a
   * question before it scrolls away.
   */
  const watchForPermission = (paneId: string, text: string) => {
    const pane = wb().panes.find((p) => p.id === paneId)
    if (!pane) return

    /*
     * The raw window, not the transcript.
     *
     * A window rather than the one line that just arrived, because a redrawn
     * frame is many lines and one of them cannot say whether the question is
     * still on screen. Raw, because the transcript is cleaned on the way in
     * — truncated at 400 characters and stripped of frame-only lines — and a
     * full-screen agent paints its prompt inside a frame far wider than that.
     * Reading the cleaned copy meant the detector never saw the very case it
     * exists for.
     */
    const recent = rawWindows.push(paneId, text)
    const agent = pane.agent ?? pane.model

    const pending = permissions()[paneId]
    if (pending) {
      // Still asked, perhaps with an answer more than when it was found (the «3. No» of a menu).
      const still = followPermission(pending, recent, agent)
      if (still === pending) return
      if (still) {
        permissions.set(paneId, still)
        return
      }
      permissions.forget(paneId)
      questionSeenAt.set(paneId, Date.now())
      // Answered here, by hand or by a button: the voice stops asking it (V1-bis, ALTO 3).
      if (voiceEngine.isRunning()) void voiceEngine.handlePermissionResolved(paneId)
      // The agent moved on by itself, so the pane is working again.
      setWb((w) => updatePane(w, paneId, { status: "working", activity: "running" }))
      return
    }

    const request = detectPermission(recent, agent)
    if (!request) return

    permissions.set(paneId, request)
    questionSeenAt.set(paneId, Date.now())
    setWb((w) => updatePane(w, paneId, { status: "waiting", activity: "permission" }))
    if (voiceEngine.isRunning()) {
      void voiceEngine.handlePermissionRequest(paneId, request.what, { kind: request.kind })
    } else {
      const pane = wb().panes.find((p) => p.id === paneId)
      proactiveAlerts.notifyPermission(paneId, pane?.title ?? paneId, request.what, request.kind)
    }
  }

  /** Answers a pending question on the process's own stdin, where it was asked. */
  const answerPermission = (paneId: string, answer: PermissionAnswer) => {
    const session = running.get(paneId)
    if (!session) return

    /*
     * Terminated, or the agent never receives it.
     *
     * `answer.send` is the keystroke that picks the answer; `\r` is the Enter
     * that submits it. Writing the keystroke alone left it sitting unread in
     * the agent's input buffer while the two lines below cleared the request
     * and told the user the session was running again — the interface said
     * answered, the agent was still waiting.
     */
    session.write(asSubmittedLine(answer.send))
    appendLine(paneId, `> ${answer.label}`, "shell")

    /*
     * The request is not cleared here.
     *
     * Whether the answer worked is something only the agent's next output can
     * say, and `watchForPermission` reads it: when the question stops being on
     * screen the request goes and the pane goes back to working. Clearing it
     * from this side is how ADE used to claim an answer had landed when it had
     * not — which matters most for the menus that need arrow keys rather than
     * a number, where the keystroke above genuinely does nothing.
     */
  }

  /*
   * The opening-task polls, held where a cleanup can still reach them.
   *
   * `startProcess` is async and has awaited `getHost()` and `host.spawn()`
   * before it starts one, and after an await Solid's owner is null — so the
   * `onCleanup(() => clearInterval(poll))` that used to sit next to the
   * `setInterval` was never registered and never ran. Nothing said so: the
   * call returns normally, and the interval simply outlived the surface,
   * firing every 100 ms against a workbench that no longer exists.
   *
   * Registering the cleanup synchronously, during setup, is the shape that
   * actually works; the set is what gives it something to clear.
   */
  const openingPolls = new Set<ReturnType<typeof setInterval>>()
  const stopOpeningPoll = (poll: ReturnType<typeof setInterval>) => {
    clearInterval(poll)
    openingPolls.delete(poll)
  }
  onCleanup(() => {
    for (const poll of openingPolls) clearInterval(poll)
    openingPolls.clear()
  })

  /**
   * Starts the process behind a pane.
   *
   * `resume` is what a restore passes: the arguments that reopen a
   * conversation the agent already has, instead of the ones that start a new
   * one. When it is given, the opening task is *not* typed — the agent is
   * being handed back its own thread, and retyping the original prompt into
   * it would ask for the whole job a second time.
   */
  /**
   * True when the agent was never made to write the conversation `resumeId`
   * names — see `ResumeRecipe.transcript`. False whenever it cannot be told:
   * an id that cannot be checked is trusted, as it was before.
   */
  // `cwd` is where the agent ran: a worktree session's transcripts are filed under the worktree, not the project.
  const conversationMissing = async (agentId: string, resumeId: string | undefined, cwd?: string) => {
    const host = await getHost()
    const root = cwd || project()?.root
    if (!resumeId || !root || !host?.homeDir || !host.exists) return false
    const home = await host.homeDir().catch(() => "")
    const path = home ? RESUME[agentId]?.transcript?.(home, root, resumeId) : undefined
    if (path) return !(await host.exists(path))
    // No file to look for (nikcli): the CLI is asked. No answer in time, and the id is reopened as before.
    const exists = RESUME[agentId]?.exists
    const command = agentById(agentId)?.command
    if (!exists || !command) return false
    const answer = await askCli(command, exists.args(resumeId), root, (output) => exists.read(output, resumeId), {
      timeoutMs: EXISTS_MS,
    })
    return answer === "gone"
  }

  /**
   * Asking a CLI for a conversation, for the ones that refuse an invented id.
   *
   * The command prints the new conversation and then stays up — it holds the
   * CLI's background service open — so this reads until the id appears and
   * kills it, rather than waiting for an exit that is not coming.
   */
  const mints = new MintLedger()
  const mintConversation = async (agentId: string, command: string, cwd: string, title: string, paneId: string) => {
    const plan = planMint(agentId, title)
    if (!plan) return undefined
    // Past `MINT_SLOW_MS` the pane says it is still waiting; past `MINT_MS` it starts without an id.
    const label = agentById(agentId)?.label || agentId
    const timing = {
      timeoutMs: MINT_MS,
      slow: { afterMs: MINT_SLOW_MS, say: () => tellPane(paneId, t("resume.slowMint", label, MINT_SLOW_LEFT_S)) },
    }
    // How long it took and what the CLI printed first, for a slow one to be traced (`mintTrace`).
    const began = performance.now()
    let first: { ms: number; line: string } | undefined
    const read = (output: string) => {
      first ??= { ms: performance.now() - began, line: output.split("\n")[0] ?? "" }
      return plan.read(output)
    }
    return await mints.track(
      askCli(command, plan.args, cwd, read, timing).then((id) => {
        const outcome = id ? "id" : id === null ? "none" : "timeout"
        console.info(mintTrace({ agent: agentId, ms: performance.now() - began, outcome, first, title }))
        return id ?? undefined
      }),
      paneId,
    )
  }

  /**
   * The most recent conversation of `cwd` that no other pane holds and no
   * other open pane minted, asked of the CLI (`ResumeRecipe.lastHere`).
   * Undefined when there is none or the command did not answer in time.
   */
  const lastConversationHere = async (
    agentId: string,
    command: string,
    cwd: string,
    taken: ReadonlySet<string>,
    paneId: string,
  ) => {
    // The other open panes' conversations by title, a mint whose id ADE never read among them.
    const marks = wb()
      .panes.filter((pane) => pane.id !== paneId)
      .map((pane) => mintMark(pane.id))
    const plan = planLastHere(agentId, cwd, taken, marks)
    if (!plan) return undefined
    return await lastHereBesideMints(
      (read) => askCli(command, plan.args, cwd, read, { timeoutMs: LIST_MS }),
      (output, excluded) => planLastHere(agentId, cwd, excluded, marks)!.read(output),
      taken,
      mints,
      (owner) => owner !== paneId && wb().panes.some((pane) => pane.id === owner),
    )
  }

  /**
   * Runs a short CLI command under a pty until `read` finds its answer in the
   * output, then kills it (`waitForAnswer`, which says what the answers mean).
   */
  const askCli = async (
    command: string,
    args: string[],
    cwd: string,
    read: (output: string) => string | null | undefined,
    timing: { timeoutMs: number; slow?: { afterMs: number; say: () => void } },
  ): Promise<string | null | undefined> => {
    const host = await getHost()
    if (!host) return undefined
    return await waitForAnswer({
      ...timing,
      read,
      start: (onLine, onExit) =>
        host.spawn({
          command,
          args,
          cwd,
          // A terminal, like every other agent: pipes are Claude Code's alone
          // (`pty.rs`). Wide enough that no line of the printed JSON is
          // wrapped: at 80 the id was cut, and a line past 400 (a long UNC
          // folder, a long permission rule) broke the parse and lost the
          // conversation (lettura di Mimo, F8).
          cols: LIST_COLS,
          rows: 12,
          onLine: (line) => onLine(stripAnsi(line)),
          onExit,
        }),
    })
  }

  /**
   * The id in the report the pane's previous spawn left and nobody took
   * (`lastReportedId`), written onto the pane; the file is cleared once read.
   */
  const adoptLastReport = async (pane: {
    id: string
    cwd?: string
    resumeId?: string
    otherDir?: string
    linkNonce?: string
    agent?: string
  }) => {
    const nonce = pane.linkNonce
    if (!nonce) return undefined
    const host = await getHost()
    const text = (await host?.readAgentLink?.(nonce).catch(() => null)) ?? null
    if (text === null) return undefined
    await host?.clearAgentLink?.(nonce).catch(() => {})
    const id = lastReportedId(text, { pane: pane.id, nonce }, pane.resumeId, reportFamily(pane.agent ?? ""))
    if (id) {
      const report = parseReport(text)
      const elsewhere = report && pane.cwd ? followedFolder(report, pane.cwd, pane) : undefined
      setWb((w) => updatePane(w, pane.id, { resumeId: id, otherDir: elsewhere }))
    }
    return id
  }

  /**
   * Brings a session with no process back from its own pane.
   *
   * A restored session whose agent had already exited — or one that exited
   * because its resume failed — was left as a transcript with a disabled
   * input and nothing to press: the conversation was still on disk and the
   * pane had no way to reach it. Now the pane reopens it by id when it can,
   * and `line`, when the user typed one, is sent once the agent is ready.
   */
  const reopen = async (given: Pane, line?: string, claims?: ReadonlySet<string>) => {
    if (running.has(given.id)) return
    // One at a time: its awaits left room for a second one to start the same pane twice (ALTO 3).
    await reopening.run(given.id, () => reopenPane(given, line, claims))
  }

  const reopenPane = async (given: Pane, line?: string, claims?: ReadonlySet<string>) => {
    const agentId = given.agent ?? given.model
    // A sign-in runs its sign-in again: the bare agent would start a session, on the default model.
    const restart = restartOf(given)
    if (restart.kind === "signIn") return startProcess(given.id, agentId, "", undefined, [...restart.extra])
    const reported = await adoptLastReport(given)
    let pane = reported ? { ...given, resumeId: reported } : given
    // Another open pane holds this conversation (ripristino review, point 1): it stays there.
    const holder = pane.resumeId
      ? wb().panes.find(
          (other) =>
            other.id !== pane.id && (other.agent ?? other.model) === agentId && other.resumeId === pane.resumeId,
        )
      : undefined
    if (holder) {
      pane = { ...pane, resumeId: undefined }
      setWb((w) => updatePane(w, pane.id, { resumeId: undefined }))
      tellPane(pane.id, t("resume.shared", holder.title))
    }
    const missing = await conversationMissing(agentId, pane.resumeId, pane.cwd)
    const plan = planResume({
      agentId,
      ...(pane.resumeId ? { resumeId: pane.resumeId } : {}),
      // "The most recent one here" unless another pane of this folder may be
      // in it: per folder, and for nikcli only a pane without an id of its own.
      lastTaken: lastTakenFor(pane, wb().panes) || claimedByRestore(claims, agentId, pane.cwd || project()?.root),
      missing,
    })
    // A `here` plan may start a new conversation, which then gets the task; a found one is not typed into.
    const text = line?.trim() ? line : plan.kind === "fresh" || plan.kind === "here" ? (pane.task ?? "") : ""
    await startProcess(pane.id, agentId, text, plan, undefined, Boolean(line?.trim()))
  }

  /*
   * Suspending a Claude session at rest (P1-C6): its processes are closed, the
   * pane keeps its place and its text, and "Riprendi" reopens the conversation.
   */
  const suspendContext = (pane: Pane, conversationMissing: boolean): SuspendContext => ({
    running: running.has(pane.id),
    conversationMissing,
    permission: questionOpen(pane.id),
    openRequests: openRequests.values(),
    heldLines,
    typing: isTyping(records.typed.get(pane.id)),
  })

  /**
   * The button's and the palette's answer. Whether the conversation is on disk
   * is asked on the disk, so only at the click: here it is taken as there.
   */
  const suspendCheckFor = (paneId: string): SuspendCheck | undefined => {
    // Read so the answer follows a process starting or ending, and the mail queues.
    runningTick()
    mailWaiting()
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (!pane || !offersSuspend(pane)) return undefined
    return canSuspend(pane, suspendContext(pane, false))
  }

  const suspendSession = async (paneId: string) => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (!pane || !offersSuspend(pane)) return
    const refuse = (check: SuspendCheck) => {
      if (!check.ok) tellPane(paneId, t("note.suspendRefused", t(SUSPEND_REASON[check.reason])))
    }
    const missing = await conversationMissing(pane.agent ?? pane.model, pane.resumeId, pane.cwd)
    const first = canSuspend(pane, suspendContext(pane, missing))
    if (!first.ok) return refuse(first)
    /*
     * The mark first, so a message arriving from here on is queued rather than
     * typed; then the same check again, since one may have come in while the
     * disk was asked; only then the kill. A check that fails now takes the
     * mark back and closes nothing.
     */
    setWb((w) => updatePane(w, paneId, { suspended: true }))
    const marked = wb().panes.find((candidate) => candidate.id === paneId)
    const again = marked ? canSuspend({ ...marked, suspended: undefined }, suspendContext(marked, missing)) : first
    if (!marked || !again.ok) {
      setWb((w) => updatePane(w, paneId, { suspended: undefined }))
      return refuse(again)
    }
    // The whole tree, MCP servers included, and waited for: a pane saying "Sospesa" has nothing left running.
    const closed = await stopForSuspend(paneId, running, touchRunning)
    if (!closed) {
      // Tracked again, so the mark goes; but deaf (see `stopForSuspend`), so the note asks for the pane to be closed and reopened.
      setWb((w) => updatePane(w, paneId, { suspended: undefined }))
      saveSuspendedMail()
      tellPane(paneId, t("note.suspendKillFailed"))
      return
    }
    forgetQuiet(paneId)
    setWb((w) => updatePane(w, paneId, { activity: "suspended" }))
    appendLine(paneId, t("note.suspended"), "note", "ade")
  }

  /**
   * "Riprendi": the same conversation by its id (`reopen`), then the mark goes
   * and the queued mail is typed in the order it came, as held lines are, once
   * the session is free. A session that does not start stays suspended, its
   * mail with it.
   */
  const resumeSession = async (paneId: string) => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (!pane?.suspended) return
    await reopen(pane)
    if (!running.has(paneId)) {
      tellPane(paneId, t("note.resumeFailed"))
      return
    }
    setWb((w) => updatePane(w, paneId, { suspended: undefined }))
    saveSuspendedMail()
  }

  /*
   * The sidebar row menu's verbs: the same functions the palette and the pane's
   * own buttons reach, called from the row the pointer is on.
   *
   * Two of them need a step the palette does not. Renaming goes through the
   * DOM (`requestRename`), so a session with no pane on screen has nothing to
   * ask — it is opened first and asked again a frame later, when its pane is
   * there. Closing every session of a project is `closeAll`, which the tray's
   * "chiudi sessioni" already uses, given the ids of that one project.
   */
  const renameSession = async (id: string) => {
    if (requestRename(id)) return
    await openSession(id)
    requestAnimationFrame(() => void requestRename(id))
  }

  const restartSession = (id: string) => {
    const pane = wb().panes.find((candidate) => candidate.id === id)
    if (pane) void reopen(pane)
  }

  const closeProjectSessions = async (workspaceId: string) => {
    const workspace = workspaces().find((candidate) => candidate.id === workspaceId)
    // An agent of the project may be at work: the tray's own "close sessions"
    // goes through closeAll bare too, but this one comes from a menu the user
    // reached without seeing the panes (review sidebar-clic, ALTO 1).
    await closer.closeAll(workspace?.sessions.map((session) => session.id) ?? [], { confirmRunning: true })
  }

  /**
   * The project a pane's process runs in: its own, not whichever is open.
   *
   * Panes of every project stay in the workbench and keep talking to each
   * other, so a session of a project that is not on screen — restarted, or
   * spawned by one of its agents — has to start in its own root. Found by
   * the folder the pane keeps, or by name for a pane saved before it kept one;
   * the open one when the pane's is unknown. See `pane-project.ts`.
   */
  const projectOfPane = async (
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
    paneId: string,
  ): Promise<Project | undefined> => {
    const open = project()
    const found = paneProject(
      wb().panes.find((pane) => pane.id === paneId),
      open,
      recents(),
    )
    if (found.kind === "open") return open
    return discoverProject(host, found.root).catch(() => open)
  }

  const startProcess = async (
    paneId: string,
    agentId: string,
    task: string,
    resume?: ResumePlan,
    /*
     * Arguments this particular session needs, on top of whatever opening the
     * agent's own plan asks for.
     *
     * Used by the bot section, where a session is `nikcli --agent <name>`: the
     * bot *is* those two arguments, and starting the CLI bare would open a
     * plain session that has never heard of it.
     */
    extra?: readonly string[],
    /** Type `task` even into a resumed conversation: the user just wrote it. */
    typeIntoResumed = false,
  ) => {
    const agent = agentById(agentId)
    // An app's pane is its server's console: a task typed there is a line the server does not read.
    if (agent?.kind === "app") task = ""
    const host = await getHost()
    /*
     * Its folder gone (a project removed, a worktree cleaned up): not started
     * somewhere else, and not left to die starting. The pane says which folder
     * and offers to be closed.
     */
    const gone = host
      ? await goneFolder(
          wb().panes.find((pane) => pane.id === paneId),
          project(),
          recents(),
          (path) => rootMissing(host, path),
        )
      : undefined
    if (gone) {
      setWb((w) => updatePane(w, paneId, { status: "error", activity: "folderGone", gone }))
      appendLine(paneId, t("project.missing", gone), "note", "ade")
      return
    }
    if (wb().panes.some((pane) => pane.id === paneId && pane.gone))
      setWb((w) => updatePane(w, paneId, { gone: undefined }))
    const p = host ? await projectOfPane(host, paneId) : undefined
    if (!agent || !agent.command || !host || !p) return
    if (p.remote) return startRemoteProcess(paneId, agentId, agent.command, task, p.remote, host)

    /*
     * The conversation id is chosen here, before the agent exists.
     *
     * Only some CLIs accept one — `resume.ts` has the table — and for those
     * it is the difference between coming back to the session and starting
     * an identical-looking new one. Recorded on the pane in the same breath,
     * because a pane that is running under an id ADE did not write down is
     * a session that cannot be resumed and looks like one that can.
     */
    let resumed = resume?.kind === "resume"
    let opening: { args: string[]; resumeId?: string } =
      resume?.kind === "resume"
        ? { args: resume.args }
        : planStart(agentId, resume?.kind === "fresh" ? resume.resumeId : undefined)
    /*
     * The `ade-msg` notice first: `codex -c …` has to precede a `resume`
     * subcommand, and for the rest the order does not matter. The shell has
     * no instructions to extend and gets nothing. See `session-new/intro.ts`.
     */
    /*
     * A spawned session keeps what it was spawned with: its worktree is its
     * directory, and its `--model` (or agy's `--add-dir`) comes back on every
     * restart. Before the opening, like the notice, so a `resume` subcommand
     * still comes after the flags.
     */
    const launched = wb().panes.find((pane) => pane.id === paneId)
    const workDir = launched?.worktree || p.root

    /*
     * And the id asked of the CLI, when that is the only way to have one.
     *
     * Before the real session starts, so it can be started *as* that
     * conversation: nikcli's `--session` continues one, it does not open one.
     * When the ask fails the session still starts — just without a
     * conversation ADE can name, which the pane then says out loud rather
     * than discovering at the next restart.
     */
    const recipe = RESUME[agentId]
    /*
     * "The most recent conversation here", asked of the CLI for this folder
     * rather than left to its `--continue`, which for nikcli is the whole
     * repository's latest: another worktree's conversation. The ids other
     * panes hold are left out. None found: a new one, asked for below.
     */
    if (resume?.kind === "here" && recipe?.byId) {
      appendLine(paneId, t("resume.lookingHere", agent.label || agentId), "note", "ade")
      const taken = new Set(
        wb()
          .panes.filter((pane) => pane.id !== paneId && pane.resumeId)
          .map((pane) => pane.resumeId as string),
      )
      const found = await lastConversationHere(agentId, agent.command, workDir, taken, paneId)
      if (found) {
        opening = { args: recipe.byId(found), resumeId: found }
        resumed = true
      } else tellPane(paneId, t("resume.noneHere", agent.label || agentId))
    }
    /*
     * A conversation the CLI no longer has (deleted from nikcli): not reopened,
     * which failed on the raw NotFoundError, and not kept, or every restart
     * would ask for it again. The pane starts a new one and says so.
     */
    const conversationGone = resume?.kind === "fresh" && resume.gone === true && launched?.resumeId !== undefined
    if (conversationGone) {
      setWb((w) => updatePane(w, paneId, { resumeId: undefined }))
      tellPane(paneId, t("resume.gone", agent.label || agentId))
    }
    if (!resumed && !opening.resumeId && launched?.resumeId && !conversationGone && recipe?.byId) {
      // Already has one: a restart reopens it. Minting here is what made the
      // pane lose its conversation on the second start.
      opening = { args: recipe.byId(launched.resumeId), resumeId: launched.resumeId }
    } else if (!resumed && !opening.resumeId && recipe?.mint) {
      /*
       * A title that tells the conversations apart inside the CLI, where they
       * are listed together: panes are often all called "Sessione 1 — nikcli".
       */
      const title = `${launched?.title || agent.label || agentId}${mintMark(paneId)}`
      appendLine(paneId, t("resume.asking", agent.label || agentId), "note", "ade")
      const minted = await mintConversation(agentId, agent.command, workDir, title, paneId)
      if (minted && recipe.byId) opening = { args: recipe.byId(minted), resumeId: minted }
      else tellPane(paneId, t("resume.noMint", agent.label || agentId))
    }

    const paneTitle = wb().panes.find((pane) => pane.id === paneId)?.title ?? agent.label ?? agentId
    // The pane's own arguments on every start, the first and each restart (`start-args.ts`).
    const extraArgs = startArgsFor(agentId, launched, {
      title: paneTitle,
      opening: opening.args,
      ...(extra ? { extra } : {}),
    })
    const mintedId = opening.resumeId
    const openedId = openedConversation(resume, mintedId, launched?.resumeId)

    /*
     * What ADE can promise about this session coming back, said once, here.
     *
     * A pane that cannot be reopened by id looks exactly like one that can
     * until the day ADE is restarted — which is the bug this was written for:
     * two nikcli sessions in one directory, and the second one came back as a
     * new conversation with the old title.
     */
    const others = wb().panes.some(
      (pane) => pane.id !== paneId && (pane.agent ?? pane.model) === agentId && sameFolder(pane.cwd || p.root, workDir),
    )
    /*
     * Said only where there is something to say: "the most recent one here" is
     * what these CLIs have always done and it is usually right, so announcing
     * it on every start of codex, agy or opencode would be noise. Two panes in
     * one directory is the case that is not right, and that one is said.
     */
    const promise = resumePromise({ agentId, ...(mintedId ? { resumeId: mintedId } : {}), sharedDirectory: others })
    if (lostConversation(agentId, promise, resumed)) tellPane(paneId, t("resume.none"))
    // Reopening a conversation of another folder, followed from nikcli's shared tabs: said again.
    if (resumed && launched?.otherDir && openedId !== undefined && openedId === launched.resumeId) {
      tellPane(paneId, t("resume.otherFolder", launched.otherDir))
    }

    /*
     * And the other direction: the CLI telling ADE which conversation it
     * opened.
     *
     * For codex there is no flag to pin an id, so this is the only way a pane
     * can be brought back to its own thread rather than to whatever codex
     * used last. For Claude Code it covers what the flag cannot: a
     * conversation the user resumed or cleared from inside the CLI has a new
     * id, and the pane would otherwise still be carrying the one ADE minted.
     *
     * Only when the user has installed the hook — see the settings panel.
     * Without it the variables are not set, and nothing changes.
     */
    // Prime and pi need nothing installed: their reporter comes with the spawn (`takesActivityExtension`).
    const linked = (hookStates()[agentId]?.installed ?? false) || takesActivityExtension(agentId)
    const nonce = linked ? newNonce() : undefined
    // Kept per pane so turn activity can be read for as long as this spawn lives.
    if (nonce) paneNonces.set(paneId, nonce)
    else paneNonces.delete(paneId)
    // The previous spawn's, saved with the pane: its worker may still be the one writing (MEDIO 1).
    const formerNonce = wb().panes.find((pane) => pane.id === paneId)?.linkNonce
    if (nonce && formerNonce && formerNonce !== nonce && takesActivityExtension(agentId)) {
      formerNonces.set(paneId, formerNonce)
    } else formerNonces.delete(paneId)
    activityOf.delete(paneId)
    bracketedPaste.delete(paneId)
    let spawned: SpawnedSession | undefined
    // The host refused to start it: said by `onRefused`, then the exit that follows.
    let refused = false

    /*
     * The project itself, not a worktree cut for the session.
     *
     * Every session used to be provisioned onto its own branch in its own
     * checkout, which meant opening a terminal put you somewhere that was not
     * the project you opened: a different path, a branch you did not ask for,
     * and your own work invisible from it. Branching is the user's decision and
     * they make it in the terminal like anywhere else. The worktree board still
     * lists and integrates the trees that exist — it just stops making them.
     */
    const starting = startingState({ task, resumed, typeIntoResumed })
    try {
      setWb((w) =>
        updatePane(w, paneId, {
          cwd: workDir,
          tree:
            launched?.worktree && launched.tree
              ? launched.tree
              : p.branch
                ? { branch: p.branch, fidelity: "project" }
                : undefined,
          status: starting.status,
          activity: starting.activity,
          // Saved, so the next start can read what this spawn reported last.
          linkNonce: nonce,
          // Another conversation than the one followed: its folder no longer applies.
          ...(openedId !== launched?.resumeId ? { otherDir: undefined } : {}),
          // A fresh start drops an id whose conversation is gone, so the pane
          // stops promising to reopen it.
          ...(mintedId ? { resumeId: mintedId } : resume?.kind === "fresh" ? { resumeId: undefined } : {}),
        }),
      )

      appendLine(paneId, `${workDir}> ${[agent.command, ...displayArgs(extraArgs)].join(" ")}`, "shell")

      /*
       * The keys chosen for this agent in Impostazioni › Chiavi API, by name,
       * read from the index alone; the host checks them again against the
       * command. The transcript says which variables were set, never what
       * they hold, and says so when the keys could not be read.
       */
      let secretNames: string[] = []
      if (host.assignedSecrets) {
        try {
          const assigned = await host.assignedSecrets(agent.command)
          secretNames = assigned.map((key) => key.name)
          if (assigned.length > 0)
            appendLine(paneId, t("keys.passed", assigned.map((key) => key.env).join(", ")), "note", "ade")
        } catch (failure) {
          tellPane(paneId, t("keys.unread", failure instanceof Error ? failure.message : String(failure)))
        }
      }

      /*
       * Started bare, the way the user would start it in their own terminal.
       *
       * No per-agent one-shot arguments any more: those turned every session
       * into a single question with no way to ask a second one, and for Claude
       * Code the argument-free form was not even reachable — without a terminal
       * it switched itself into `--print` and exited before the pane had drawn.
       * With a pty there is nothing to work around: whatever the agent does when
       * you run it yourself is what it does here.
       */
      /*
       * When the CLI first spoke, and when it last did.
       *
       * Both are needed to know the screen is drawn: the first byte says the
       * program is alive, the gap since the last one says it has stopped
       * repainting. See `decideOpening`.
       */
      let firstByteAt: number | undefined
      let lastByteAt: number | undefined

      // A restart reuses the pane's terminal; the new process starts at 1;1.
      startOnCleanScreen(paneId)
      // A conversation reopened is drawn again, requests and all: those were acted on.
      screenRequests.start(
        paneId,
        resumed || (launched?.resumeId !== undefined && opening.resumeId === launched.resumeId),
      )
      // Born at the pane's size, not the host's 120x30 (S77); undefined for a pane not yet fitted.
      const bornAt = ptySize(paneId)
      const session = await host.spawn({
        ...bornAt,
        command: agent.command,
        args: extraArgs,
        cwd: workDir,
        onData: (chunk) => {
          const now = Date.now()
          firstByteAt ??= now
          lastByteAt = now
          lastOutputAt.set(paneId, now)
          noteBracketedPaste(paneId, chunk)

          feedTerminal(paneId, chunk)
        },
        onLine: (line, stream) => {
          appendLine(paneId, line, stream === "err" ? "note" : "step")
          /*
           * The same line the transcript got, read once more for a request
           * addressed to a panel.
           *
           * `onLine` is already where every line is inspected — it is how a
           * permission prompt is noticed — so this costs one more parse on a
           * line that has already been split, and it is the only channel that
           * works with every CLI ADE runs: they read keystrokes and write
           * text, and this is text.
           */
          // Only from an agent: a terminal's output is the user's own, and may be anything (`acceptsRequests`).
          // Not from a screen drawn with the cursor: those lines are the screen's words run together, and its requests are read from the screen (`screenRequests`).
          if (acceptsRequests(agentId) && !onAlternateScreen(paneId)) void handlePanelRequest(paneId, line)
          noticeDevServer(paneId, line)
        },
        /*
         * Only this spawn's exit ends the pane. A relaunch kills the old process
         * and starts the new one at once, and the old one's exit arriving later
         * must not mark the new session finished.
         */
        onExit: (code) => {
          if (!running.has(paneId) || running.get(paneId) === spawned)
            finish(paneId, code, refused ? "startFailed" : undefined)
        },
        // Over the terminal: a pane started again keeps the old one live, and the transcript hidden.
        onRefused: (reason) => {
          refused = true
          tellPane(paneId, t("pane.startFailed", reason))
        },
        ...(nonce ? { link: { pane: paneId, nonce } } : {}),
        pane: paneId,
        paneToken: mintPaneToken(paneId),
        ...(secretNames.length > 0 ? { secrets: secretNames } : {}),
      })

      spawned = countingLines(session, () => linesSent.set(paneId, (linesSent.get(paneId) ?? 0) + 1))
      stampingInput(session, () => lastInputAt.set(paneId, Date.now()))
      running.set(paneId, session)
      touchRunning()
      resyncSize(paneId, session, bornAt)

      /*
       * Learning the id from the CLI's own record, for the ones that keep one.
       *
       * agy takes no id up front and has no hook ADE installs, but it writes
       * the latest conversation per directory to a file. What it said before
       * this session started is not ours; an id that shows up afterwards is,
       * unless another pane already holds it. Without this a restored agy
       * pane had nothing to ask for and came back as a new conversation.
       */
      const latest = RESUME[agentId]?.latest
      if (latest && !mintedId && host.homeDir && host.readTextFile) {
        const readText = host.readTextFile
        const home = await host.homeDir().catch(() => "")
        const readLatest = async () =>
          home
            ? latest.read((await readText(latest.path(home), 1_000_000).catch(() => undefined))?.text ?? "", workDir)
            : undefined
        const before = await readLatest()
        const poll = setInterval(async () => {
          if (running.get(paneId) !== session) {
            stopOpeningPoll(poll)
            return
          }
          const id = await readLatest()
          if (!id || id === before) return
          const panes = wb().panes
          if (panes.some((pane) => pane.id !== paneId && pane.resumeId === id)) return
          if (panes.find((pane) => pane.id === paneId)?.resumeId === id) return
          setWb((w) => updatePane(w, paneId, { resumeId: id }))
          // Up to 1 MB read per pass, for the life of the session: often enough
          // to catch a new conversation, not so often that it is the busiest
          // thing an idle agy pane does.
        }, 10_000)
        openingPolls.add(poll)
      }

      /*
       * Wait for the hook to say who the agent turned out to be.
       *
       * Not awaited: the session is live and the user is typing into it well
       * before the CLI reaches its own `SessionStart`, and there is nothing
       * to show for the wait. If it never answers the pane keeps whatever id
       * ADE minted, or none, which is exactly the behaviour without a hook.
       *
       * The pane is looked up again when the answer lands rather than
       * captured: by then it may have been closed, or restarted into a
       * different session, and writing an id onto a pane that has moved on
       * is worse than not writing one.
       */
      if (nonce) {
        // And after it: a `/resume` or `/clear` inside the CLI moves the pane too.
        const family = reportFamily(agentId)
        void followReports({
          pane: paneId,
          nonce,
          ...(family ? { family } : {}),
          read: (n) => host.readAgentLink?.(n) ?? Promise.resolve(null),
          clear: async (n) => {
            await host.clearAgentLink?.(n)
          },
          cancelled: () => running.get(paneId) !== session,
          linesSent: () => linesSent.get(paneId) ?? 0,
          onReport: (report) => {
            if (running.get(paneId) !== session) return
            const elsewhere = otherFolder(report, workDir)
            // Kept with the pane, so a restore says it again (ripristino review, BASSO 2); a report without its folder keeps what was known.
            const followed = wb().panes.find((pane) => pane.id === paneId)
            setWb((w) =>
              updatePane(w, paneId, {
                resumeId: report.sessionId,
                otherDir: followedFolder(report, workDir, followed ?? {}),
              }),
            )
            // Followed all the same, since the TUI does show it; but only one of the two can reopen it.
            const holder = wb().panes.find(
              (other) =>
                other.id !== paneId && (other.agent ?? other.model) === agentId && other.resumeId === report.sessionId,
            )
            if (holder) tellPane(paneId, t("resume.alsoOpen", holder.title))
            if (elsewhere) tellPane(paneId, t("resume.otherFolder", elsewhere))
          },
        })
      }

      /*
       * An opening task is typed in, not passed as an argument. It is the same
       * keystrokes the user would have made, so it works identically for all
       * eleven CLIs and leaves the session live afterwards — which a one-shot
       * flag never did.
       *
       * When to type it was a fixed 900 ms after spawn, and that was wrong for
       * most of the catalogue: five of the nine installed agents need longer
       * than that just to print their version. The text landed in a buffer
       * nobody was reading, or its Enter answered the CLI's own first question.
       * Now the session is polled until the output has actually settled, and
       * never typed into while a permission prompt is standing.
       */
      // Not typed when the session was resumed: the agent already has the
      // thread, and sending the original prompt again would ask for the whole
      // job a second time.
      if (starting.typesTask) {
        const startedAt = Date.now()
        const poll = setInterval(() => {
          // The pane was closed, or the process died, while we were waiting.
          if (!running.has(paneId)) {
            stopOpeningPoll(poll)
            return
          }

          const decision = decideOpening({
            startedAt,
            firstByteAt,
            lastByteAt,
            now: Date.now(),
            permissionPending: questionOpen(paneId),
          })
          if (decision === "wait") return

          stopOpeningPoll(poll)
          if (decision === "send") {
            setWb((w) =>
              updatePane(w, paneId, {
                status: "working",
                activity: "running",
              }),
            )
            // Opening tasks only — a line the user typed later is theirs alone.
            // Text and Enter apart, for the reason `typeLine` gives.
            const session = running.get(paneId)
            const opening = typeIntoResumed ? task : withIntro(agentId, task)
            // A task from `ade-msg spawn` is a request like any other: too long to type, it goes to the inbox.
            const spawned = [...openRequests.values()].find(
              (request) => request.kind === "spawn" && request.to === paneId,
            )
            if (session && spawned) {
              const meta = { id: spawned.id, kind: "spawn" as const, from: spawned.from }
              void getHost().then(async (host) => {
                if (!host) return void typeLine(session, opening)
                // A prompt at start-up: the task waits among the held lines instead of going missing.
                if ((await deliverText(host, paneId, opening, meta)) === "held")
                  heldLines.push({ paneId, text: opening, inbox: meta })
              })
            } else if (session) void typeLine(session, opening)
            return
          }
          /*
           * Said, not swallowed. An opening task that was never delivered is
           * the user's sentence going missing; they need to know it is still
           * theirs to send, and the terminal is where they are looking.
           */
          setWb((w) =>
            updatePane(w, paneId, {
              status: "idle",
              activity: "ready",
            }),
          )
          tellPane(paneId, t("task.notSent"))
        }, 100)
        openingPolls.add(poll)
      }
    } catch (e) {
      // Over the terminal: a pane started again keeps the old one live, and the transcript hidden.
      tellPane(paneId, t("pane.startFailed", String(e)))
      setWb((w) => updatePane(w, paneId, { status: "error", activity: "startFailed" }))
    }
  }

  /**
   * A session in a remote Space: ssh to the host, into its folder, then the
   * agent typed at the remote prompt the way the user would type it.
   *
   * Nothing local comes along — no resume id, no hook, no `ade-msg` notice:
   * those live on this machine, and the agent is on another one. What is typed
   * waits for the connection to settle and never goes into a password,
   * passphrase or fingerprint question; the user answers those in the pane.
   */
  const startRemoteProcess = async (
    paneId: string,
    agentId: string,
    command: string,
    task: string,
    target: RemoteTarget,
    host: NonNullable<Awaited<ReturnType<typeof getHost>>>,
  ) => {
    const args = sshArgs(target)
    const home = host.homeDir ? await host.homeDir().catch(() => undefined) : undefined
    const shellOnly = agentId === "terminal"
    paneNonces.delete(paneId)
    activityOf.delete(paneId)
    bracketedPaste.delete(paneId)
    records.typed.forget(paneId)
    setWb((w) =>
      updatePane(w, paneId, {
        cwd: remoteRoot(target),
        tree: undefined,
        resumeId: undefined,
        status: task.trim() ? "working" : "idle",
        activity: "sshConnecting",
      }),
    )
    appendLine(paneId, `ssh ${args.join(" ")}`, "shell")

    let tail = ""
    let spawned: SpawnedSession | undefined
    // The host refused to start it: said by `onRefused`, then the exit that follows.
    let refused = false
    try {
      startOnCleanScreen(paneId)
      // Born at the pane's size, not the host's 120x30 (S77); undefined for a pane not yet fitted.
      const bornAt = ptySize(paneId)
      const session = await host.spawn({
        ...bornAt,
        command: "ssh",
        args,
        ...(home ? { cwd: home } : {}),
        onData: (chunk) => {
          lastOutputAt.set(paneId, Date.now())
          noteBracketedPaste(paneId, chunk)
          tail = (tail + stripAnsi(chunk)).slice(-400)
          feedTerminal(paneId, chunk)
        },
        onLine: (line, stream) => appendLine(paneId, line, stream === "err" ? "note" : "step"),
        onExit: (code) => {
          if (!running.has(paneId) || running.get(paneId) === spawned)
            finish(paneId, code, refused ? "connectFailed" : undefined)
        },
        onRefused: (reason) => {
          refused = true
          tellPane(paneId, t("pane.connectFailed", reason))
        },
        pane: paneId,
        paneToken: mintPaneToken(paneId),
      })
      spawned = stampingInput(session, () => lastInputAt.set(paneId, Date.now()))
      running.set(paneId, session)
      touchRunning()
      resyncSize(paneId, session, bornAt)

      const steps = [...(shellOnly ? [] : [command]), ...(task.trim() ? [task] : [])]
      if (steps.length === 0) return
      let index = 0
      let stepStart = Date.now()
      let stepFirst: number | undefined
      const poll = setInterval(() => {
        if (running.get(paneId) !== session) {
          stopOpeningPoll(poll)
          return
        }
        const last = lastOutputAt.get(paneId)
        if (last !== undefined && last > stepStart) stepFirst ??= last
        const lastLine =
          tail
            .split(/\r?\n|\r/)
            .filter((line) => line.trim())
            .pop() ?? ""
        const decision = decideOpening({
          startedAt: stepStart,
          firstByteAt: stepFirst,
          lastByteAt: stepFirst === undefined ? undefined : last,
          now: Date.now(),
          permissionPending: sshAsking(lastLine) || questionOpen(paneId),
          // The first step waits out a password typed by hand.
          ...(index === 0 ? { timeoutMs: 180_000 } : {}),
        })
        if (decision === "wait") return
        if (decision === "abandon") {
          stopOpeningPoll(poll)
          tellPane(paneId, t("task.stepNotSent", String(steps[index])))
          setWb((w) => updatePane(w, paneId, { status: "idle", activity: "ready" }))
          return
        }
        const text = steps[index]!
        index += 1
        void typeLine(session, text)
        setWb((w) =>
          updatePane(w, paneId, { activity: index < steps.length || !task.trim() ? "connected" : "running" }),
        )
        if (index >= steps.length) {
          stopOpeningPoll(poll)
          return
        }
        stepStart = Date.now()
        stepFirst = undefined
      }, 150)
      openingPolls.add(poll)
    } catch (e) {
      tellPane(paneId, t("pane.connectFailed", String(e)))
      setWb((w) => updatePane(w, paneId, { status: "error", activity: "connectFailed" }))
    }
  }

  /** Adds a remote Space, makes it the one in use, and opens a terminal on it. */
  const addRemoteSpace = async (target: RemoteTarget) => {
    const host = await getHost()
    if (!host) return
    const opened = await discoverProject(host, remoteRoot(target))
    const newRecents = addRecent(recents(), { root: opened.root, name: opened.name })
    setRecents(newRecents)
    localStorage.setItem("ade.recents", serializeRecents(newRecents))
    setProject(opened)
    setWb((w) => ({ ...w, projectPath: opened.root, expandedId: undefined }))
    setRemoteOpen(false)
    if (!wb().panes.some((pane) => belongsTo(pane, opened))) {
      addAgent(
        { agentId: "terminal", count: 1, task: "", title: `ssh ${target.destination}` },
        { index: 1, agentId: "terminal", role: "shell" },
      )
    }
  }

  /**
   * Starts the sessions a launch describes — the ones the form promised.
   *
   * `willLaunch` decides what each slot is: which agent, and whether it is an
   * agent, a reviewer, or the shell a workbench preset puts in slot two. The
   * form has always drawn its "Partirà" list from it, and the launch used to
   * ignore it entirely and start `count` copies of the chosen agent. Picking
   * "Banco di lavoro" showed "2. Terminal — shell" and started a second copy
   * of the same agent instead.
   */
  const launchSessions = (input: { agentId: string; count: number; task: string; preset?: string }) => {
    const entries = willLaunch({
      preset: input.preset as PresetId | undefined,
      agentId: input.agentId,
      count: input.count,
    })
    for (const entry of entries) addAgent(input, entry)
  }

  const addAgent = (
    input: {
      agentId: string
      count: number
      task: string
      preset?: string
      title?: string
      workspaceId?: string
      /** That project's folder, when known: the name alone can belong to two. */
      projectRoot?: string
      /** A spawned session's own checkout, with the branch it is on. */
      worktree?: { path: string; branch: string }
      spawnArgs?: string[]
      /** Start as a fork of another conversation: the arguments, and the child's id when known. */
      fork?: { args: string[]; resumeId?: string }
    },
    entry: LaunchEntry,
  ) => {
    const id = `n${Date.now()}-${entry.index}-${++paneSequence}`
    // A shell slot opens a terminal, so the task the form collected is meant
    // for the agent beside it, not for a prompt nothing will read.
    const task = entry.role === "shell" ? "" : input.task
    const hasInitialTask = Boolean(task.trim())
    const title = input.title || task || defaultPaneTitle(entry.role, entry.index, agentLabel(entry.agentId))
    const open = project()
    // Another project's session (a subagent spawned from there) keeps that project's name; its root is found at start.
    const currentProj = input.projectRoot
      ? paneProject({ projectRoot: input.projectRoot }, open, []).kind === "open"
        ? open
        : undefined
      : input.workspaceId && input.workspaceId !== open?.name
        ? undefined
        : open
    setWb((w) =>
      addPane(w, {
        id,
        title,
        // If there is an initial task, provisioning begins; otherwise idle ("disponibile")
        status: hasInitialTask ? "provisioning" : "idle",
        activity: hasInitialTask ? "starting" : "ready",
        model: entry.agentId,
        agent: entry.agentId,
        mode: input.preset ?? "custom",
        task,
        lines: [{ kind: "note", text: task || t("task.none") }],
        workspaceId: input.workspaceId || currentProj?.name || "workspace",
        ...((input.projectRoot ?? currentProj?.root) ? { projectRoot: input.projectRoot ?? currentProj!.root } : {}),
        cwd: input.worktree?.path ?? currentProj?.root,
        tree: input.worktree
          ? { branch: input.worktree.branch, fidelity: "full", note: `Worktree ${input.worktree.path}` }
          : currentProj?.branch
            ? { branch: currentProj.branch, fidelity: "project" }
            : undefined,
        ...(input.worktree ? { worktree: input.worktree.path } : {}),
        ...(input.spawnArgs?.length ? { spawnArgs: input.spawnArgs } : {}),
        ...(input.fork?.resumeId ? { resumeId: input.fork.resumeId } : {}),
      }),
    )
    setStarting(false)
    // A fork opens as a resumed conversation, and the task is typed into it all the same.
    if (input.fork)
      void startProcess(id, entry.agentId, task, { kind: "resume", via: "id", args: input.fork.args }, undefined, true)
    else void startProcess(id, entry.agentId, task)
    // Handed back for the callers that need to keep talking to the pane they
    // just made; `launchSessions` ignores it.
    return { id, title }
  }

  /**
   * One session, started exactly the way the launch form starts one.
   *
   * This is `addAgent` with its result kept rather than a second copy of the
   * pane-creation logic: voice needs the pane id back, because a spoken plan
   * sends its follow-up prompts to the session it just opened. The slot number
   * continues the open project's own count, so an unnamed session reads as
   * "Sessione 3 — Claude Code" next to the two already there.
   */
  const openVoiceSession = (input: { agentId: string; task: string }) => {
    const open = project()
    const mine = open ? wb().panes.filter((p) => belongsTo(p, open)) : wb().panes
    const created = addAgent(
      { agentId: input.agentId, count: 1, task: input.task },
      { index: mine.length + 1, agentId: input.agentId, role: "agent" },
    )
    return { paneId: created.id, title: created.title }
  }

  /**
   * Opens a session as one of the bots — which is to say, as a nikcli agent.
   *
   * `nikcli --agent <name>` and nothing else: the same line the user would
   * type, in a real terminal, with the bot's persona and its tools and its
   * pinned model already in the file nikcli reads. The view switches to the
   * grid because otherwise the session starts somewhere the user is not
   * looking, and a button that appears to do nothing is worse than one that
   * takes you where it went.
   */
  const openBotSession = (bot: AgentFile) => {
    const launch = botLaunch(bot)
    if (!launch) return undefined
    const open = project()
    const mine = open ? wb().panes.filter((p) => belongsTo(p, open)) : wb().panes
    const id = `n${Date.now()}-bot-${++paneSequence}`

    setWb((w) =>
      addPane(w, {
        id,
        title: bot.identifier,
        status: "idle",
        activity: "ready",
        model: bot.model ?? launch.command,
        agent: launch.agentId,
        mode: "bot",
        task: "",
        lines: [{ kind: "note", text: `${launch.command} ${launch.args.join(" ")}` }],
        ...here(),
        /*
         * The bot's own flags, kept with the pane (review, ALTO 5): handed only
         * to this start, a restart ran the bare agent, without `--agent` and on
         * the default model, which can be a paid one.
         */
        ...(launch.args.length ? { spawnArgs: [...launch.args] } : {}),
      }),
    )
    /* Narrowed to nothing, or the grid keeps showing whichever session was
       expanded and the one just started is off screen. */
    setWb((w) => ({ ...w, view: "code", focusedId: id, expandedId: undefined }))
    setStarting(false)
    void startProcess(id, launch.agentId, "")
    return { id, index: mine.length + 1 }
  }

  /*
   * A runner's own sign-in, in a pane of its own: the browser flow and the
   * code to paste are the CLI's, and a terminal is where it expects them.
   */
  const openLoginSession = (runner: Runner) => {
    const agentId = runner.id === "claude" ? "claude-code" : runner.id
    if (!agentById(agentId) || runner.login.length === 0) return
    const id = `n${Date.now()}-login-${++paneSequence}`
    setWb((w) =>
      addPane(w, {
        id,
        title: `${runner.label} · accesso`,
        status: "idle",
        activity: "ready",
        model: runner.command,
        agent: agentId,
        mode: "bot",
        task: "",
        lines: [{ kind: "note", text: `${runner.command} ${runner.login.join(" ")}` }],
        ...here(),
        signIn: [...runner.login],
      }),
    )
    setWb((w) => ({ ...w, view: "code", focusedId: id, expandedId: undefined }))
    setStarting(false)
    void startProcess(id, agentId, "", undefined, [...runner.login])
  }

  /** The host calls the Estensioni page edits `.mcp.json` with; undefined without a writable host. */
  const [extensionsIo, setExtensionsIo] = createSignal<McpConfigIO>()
  void getHost().then((host) => {
    if (!host?.readTextFile || !host.writeTextFile) return
    setExtensionsIo({
      readTextFile: (path, maxBytes) => host.readTextFile!(path, maxBytes),
      writeTextFile: (path, contents) => host.writeTextFile!(path, contents),
      ...(host.exists ? { exists: (path: string) => host.exists!(path) } : {}),
    })
  })

  /** A server's guide or source, in a browser pane: ADE has no way to hand a URL to the system browser. */
  const openGuide = (url: string) => {
    setVoiceSettingsOpen(false)
    setWb((w) => ({
      ...addPane(w, {
        id: newPaneId("b"),
        title: "Guida MCP",
        status: "working",
        model: "—",
        mode: "browser",
        browserUrl: url,
        ...here(),
        lines: [],
      }),
      view: "code",
    }))
  }

  const gridPanes = createPaneRenderer({
    wb,
    setWb,
    project,
    records,
    liveTerminals,
    isRunning,
    sessionFor: (id) => running.get(id),
    appendLine,
    tellPane,
    close,
    saveFile: (id) => void saveFile(id),
    answerPermission,
    turnSubmitted,
    promptAnswered,
    interrupted,
    restart: (pane, line) => void reopen(pane, line),
    suspendCheck: suspendCheckFor,
    suspend: (id) => void suspendSession(id),
    resume: (id) => void resumeSession(id),
    pickVideo,
    pickModel,
    readBytes: (path, maxBytes) =>
      getHost().then((host) => {
        if (!host?.readBytes) throw new Error("questo host non può leggere file binari")
        return host.readBytes(path, maxBytes)
      }),
    readDir: (path) => getHost().then((host) => (host?.readDir ? host.readDir(path) : [])),
    captureFrame,
    guessServers,
    confirmOpen,
    decisions: decisionsHub,
    design: designHub,
    panels,
    mailWaiting,
    showMail,
    dismissNotices,
    openLink: (id, request) => void openLink(id, request),
    openFileLink: (id, link) => {
      // Refused: the note goes back to the file pane, which flashes it (it has no transcript to append to).
      if (link.kind === "file") return markdownLinkRefusal(link.path, projectRoots(), openFile)
      const pane = wb().panes.find((candidate) => candidate.id === id)
      openOwnedBrowser(link.url, { id, title: pane?.title ?? "" }, true)
    },
    typeAsUser,
    announceToAll,
    pluginRuntime,
    browserControllers,
    sendBrowserRequest,
    sendSheetNotes,
  })

  const paletteChord = createMemo(() => {
    const entry = DEFAULT_BINDINGS.find((binding) => binding.commandId === "palette.open")
    return entry ? formatChord(parseChord(entry.chord, platform), platform) : ""
  })

  return (
    <div data-component="ade-shell" data-theme={theme()}>
      {/* First, so it is over the workbench while the workbench is still
          half-built. It unmounts itself once its fade is done. */}
      <Splash visible={booting() !== undefined} status={booting()} onDismiss={dismissSplash} />

      <header
        data-slot="ade-bar"
        data-platform={isTauriDesktop() && isMacOS() ? "macos" : undefined}
        data-tauri-drag-region
        onDblClick={(e) => {
          if (e.target === e.currentTarget) void adeWindowToggleMaximize()
        }}
      >
        {/* Three groups in a grid: who and where on the left, the navigation
            in the middle, the controls on the right. The left one gives way
            first, so nothing is ever laid over anything (DS-polish). */}
        <div data-slot="ade-bar-side" data-side="start">
          {/*
            The mark, not the word.
            It draws in `currentColor`, so the ink the bar spends on it
            follows the theme — which a pair of baked assets never managed.
            The name stays in the accessibility tree: the mark is decorative
            and the label is on the box around it.
          */}
          <Show when={!(isTauriDesktop() && isMacOS())}>
            <span data-slot="ade-brand" role="img" aria-label={BRAND.name}>
              {/*
                Concept 03: Molten Chrome Mercury (N).
                Continuous liquid metal ribbon with animated caustic sheen
                and floating mercury micro-droplets.
              */}
              <NikChromeLogo size={30} />
            </span>
          </Show>
          <ProjectBar
            project={project()}
            adeVersion={installedVersion()}
            nikcliVersion={nikcliVersion()}
            sessions={barSessionCount(wb().panes, project(), chatStore)}
          />
          <SidebarToggle
            hidden={sidebarHidden()}
            onToggle={toggleSidebar}
            shortcut={formatChord(parseChord("mod+shift+b", platform), platform)}
          />
        </div>

        <div data-slot="ade-bar-center">
          {/* A segmented control rather than loose chips: with four sections
            the set is the navigation, and it has to read as one object with
            one selection — not as four independent toggles. */}
          <div data-slot="ade-views" role="tablist" aria-label={t("bar.sections")}>
            <For each={VISIBLE_VIEWS}>
              {(view) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={wb().view === view}
                  data-slot="ade-view-tab"
                  data-active={wb().view === view ? "true" : undefined}
                  onClick={() => setWb((w) => ({ ...w, view }))}
                >
                  {ADE_VIEW_LABELS[view]}
                </button>
              )}
            </For>
          </div>
          {/* The palette, next to the sections rather than in the middle of the
            bar: it is navigation too — the way to reach what the four tabs do
            not show — and it belongs with the thing it extends. Reduced to its
            icon so the group stays one object; the chord is in the tooltip,
            which is where a shortcut for a control this small belongs. */}
          <button
            type="button"
            data-slot="ade-icon"
            data-action="palette"
            onClick={() => setPaletteOpen(true)}
            aria-label={t("bar.palette")}
            title={`${t("bar.palette")}  ${paletteChord()}`}
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            >
              <circle cx="7" cy="7" r="4.2" />
              <path d="M10.2 10.2L14 14" stroke-linecap="round" />
            </svg>
          </button>
          {/* Decisions and design proposals waiting for the user: one button
            for both, «Da scegliere» (notifiche-design; it was one each).
            Hidden at zero; it opens its list only when pressed. */}
          <Show when={queueShown(choicesCounts())}>
            <BarQueueButton
              family="choices"
              counts={choicesCounts()}
              open={choicesOpen() || decisionsOpen() || designOpen()}
              theme={theme()}
              onOpen={() => setChoicesOpen(true)}
            />
          </Show>
        </div>

        <div data-slot="ade-bar-side" data-side="end">
          {/*
          The column chips used to sit here — a label and five buttons, shown
          only in `code`. They were configuration parked among the verbs: a
          decision taken once and then left alone, holding a permanent seat in
          a bar where every other control does something to the project right
          now. They live in Impostazioni › Codice, with room to say what
          "auto" means. See `GridSection`.
        */}
          {/*
          One control: the orb.

          The assistant and dictation are two features — both always available,
          neither a position of a switch the other has to be turned off for —
          but they share one microphone, and the bar shows what the microphone
          is doing. Two lit controls for one open microphone was two answers to
          one question. Pressing the orb opens it for whichever feature is the
          default; the two chords open the one they name; and the orb says
          which has it, without ever turning into a microphone glyph.

          There used to be a second button here that opened the voice panel.
          It was the third way into the same screen — the sidebar has the gear,
          and three of the views link to it — and it put a configuration
          control in the middle of the toolbar's verbs.
        */}
          <div
            data-slot="ade-voice-controls"
            data-voice-mode={voiceEngine.isRunning() ? voiceEngine.activeMode() : undefined}
            title={voiceAvailable ? undefined : t("palette.voice.unsupported")}
          >
            <VoiceOrb engine={voiceEngine} class={voiceAvailable ? undefined : "disabled"} />
            <Show when={voiceAvailable}>
              <ListeningIndicator engine={voiceEngine} />
            </Show>
          </div>

          {/* Everything that opens a pane, behind one mark.
            One button per kind worked while there were two; with a video
            player, and an emulator and a 3D viewer behind it, the bar would
            become a row of verbs competing with the navigation beside it. */}
          {/* Always in the layout, hidden where it does nothing (DS-polish,
            closure 9): the right group keeps its width, and the navigation
            in the middle does not move from one view to the next. */}
          <div
            data-slot="ade-menu-anchor"
            data-idle={showsNewPane(wb().view) ? undefined : "true"}
            inert={!showsNewPane(wb().view)}
          >
            <button
              type="button"
              data-slot="ade-icon"
              data-action="new-pane"
              data-open={newPaneOpen() ? "true" : undefined}
              aria-haspopup="menu"
              aria-expanded={newPaneOpen()}
              ref={newPaneButton}
              onClick={() => setNewPaneOpen((open) => !open)}
              aria-label={t("bar.newPane")}
              title={t("bar.newPane")}
            >
              {/* Four frames: the grid this button adds to. */}
              <svg
                viewBox="0 0 16 16"
                width="15"
                height="15"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
              >
                <rect x="2" y="2" width="5" height="5" rx="1.2" />
                <rect x="9" y="2" width="5" height="5" rx="1.2" />
                <rect x="2" y="9" width="5" height="5" rx="1.2" />
                <rect x="9" y="9" width="5" height="5" rx="1.2" />
              </svg>
            </button>

            <Show when={newPaneOpen() && showsNewPane(wb().view)}>
              <div
                data-slot="ade-menu"
                role="menu"
                aria-label={t("bar.newPane")}
                ref={(menu) => onCleanup(bindMenu(menu, { close: () => setNewPaneOpen(false), anchor: newPaneButton }))}
              >
                <For each={NEW_PANE_ITEMS}>
                  {(item) => (
                    <button
                      type="button"
                      role="menuitem"
                      data-slot="ade-menu-item"
                      onClick={() => {
                        setNewPaneOpen(false)
                        void runCommand(item.commandId)
                      }}
                    >
                      <span data-slot="ade-menu-glyph" aria-hidden="true">
                        <NewPaneGlyph kind={item.glyph} />
                      </span>
                      <span data-slot="ade-menu-text">
                        <span data-slot="ade-menu-label">{item.label}</span>
                        <span data-slot="ade-menu-hint">{item.hint}</span>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* The user must never be unsure whether ADE is filming: the badge
            stays above everything, says where the file is going, and stops
            the take when clicked. In the bar, before the window controls:
            laid over the corner it covered minimise, maximise and close. */}
          <Show when={recordState().status !== "idle"}>
            <button
              type="button"
              data-slot="ade-rec"
              data-stopping={recordState().status === "stopping" ? "" : undefined}
              data-mic={recordMicOn() ? "" : undefined}
              title={
                recordState().status === "recording"
                  ? t(
                      recordMicOn() ? "record.active.mic" : "record.active.noMic",
                      recordState().status === "recording"
                        ? (recordState() as { recording: { path: string } }).recording.path
                        : "",
                    )
                  : t("record.closing")
              }
              aria-label={t("palette.record.stop")}
              onClick={() => void recorder.stop().then((problem) => problem && report(problem))}
            >
              <span data-slot="ade-rec-dot" aria-hidden="true" />
              {recordState().status === "recording" ? (recordMicOn() ? "REC · MIC" : "REC") : "…"}
            </button>
          </Show>

          {/* On macOS the traffic lights hold the left edge, so the mark takes
            the place the window controls have elsewhere. */}
          <Show when={isTauriDesktop() && isMacOS()}>
            <span data-slot="ade-brand" data-place="end" role="img" aria-label={BRAND.name}>
              <NikChromeLogo size={30} />
            </span>
          </Show>

          <Show when={isTauriDesktop() && !isMacOS()}>
            <div data-slot="ade-window-controls" aria-label={t("bar.windowControls")}>
              <button
                type="button"
                data-slot="ade-win-btn"
                data-win="minimize"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  void adeWindowMinimize()
                }}
                title={t("window.minimize")}
                aria-label={t("window.minimize")}
              >
                <svg viewBox="0 0 10 1" width="10" height="1" style={{ "pointer-events": "none" }}>
                  <rect width="10" height="1" fill="currentColor" />
                </svg>
              </button>
              <button
                type="button"
                data-slot="ade-win-btn"
                data-win="maximize"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  void adeWindowToggleMaximize()
                }}
                title={t("window.maximize")}
                aria-label={t("window.maximize")}
              >
                <svg
                  viewBox="0 0 10 10"
                  width="10"
                  height="10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1"
                  style={{ "pointer-events": "none" }}
                >
                  <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
                </svg>
              </button>
              <button
                type="button"
                data-slot="ade-win-btn"
                data-win="close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  void adeWindowClose()
                }}
                title={t("window.close")}
                aria-label={t("window.close")}
              >
                <svg
                  viewBox="0 0 10 10"
                  width="10"
                  height="10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.2"
                  style={{ "pointer-events": "none" }}
                >
                  <path d="M1 1L9 9M9 1L1 9" />
                </svg>
              </button>
            </div>
          </Show>
        </div>
      </header>

      <Show when={voiceNotice()}>
        <div
          role="alert"
          data-slot="ade-voice-notice"
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            padding: "var(--ade-space-2) var(--ade-space-6)",
            background: "var(--ade-working-bg)",
            color: "var(--ade-working)",
            "border-bottom": "1px solid var(--ade-border)",
            "font-size": "var(--ade-font-sm)",
            "font-family": "var(--ade-sans)",
          }}
        >
          <span>{voiceNotice()}</span>
          <button
            type="button"
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              "font-size": "var(--ade-font-sm)",
              padding: "0 var(--ade-space-2)",
            }}
            onClick={() => setVoiceNotice(undefined)}
            aria-label={t("bar.dismissNotice")}
          >
            ✕
          </button>
        </div>
      </Show>

      <div data-slot="ade-body" data-sidebar-hidden={sidebarHidden() ? "true" : undefined}>
        <Sidebar
          workspaces={workspaces()}
          selectedSessionId={wb().focusedId}
          /* The bot section's roster lives in this column, where the sessions
             and files are otherwise: one list on the left, not two. The foot
             stays: the screenshots are what a bot will be shown. */
          content={
            wb().view === "bot" && isViewVisible("bot") ? (
              <BotsRoster {...(project()?.root ? { projectRoot: project()!.root } : {})} />
            ) : undefined
          }
          onSelectSession={(id) => void openSession(id)}
          /* No picker in the browser harness, so no button that could not work. */
          onAddProject={hasHost() ? () => void addProject() : undefined}
          onAddRemote={hasHost() ? () => setRemoteOpen(true) : undefined}
          onSelectProject={(id) => void switchProject(id)}
          onNewSession={() => setStarting(true)}
          /* The row menu's verbs: one callback each, into the functions above. */
          onRenameSession={(id) => void renameSession(id)}
          onCloseSession={(id) => {
            // The sidebar's ✕ is a click, not a shortcut held down: an agent
            // at work is stopped only after it is said out loud, the way the
            // pane's own ✕ does (review sidebar-clic, MEDIO 2).
            closer.close(id, { confirmRunning: true })
          }}
          onRestartSession={restartSession}
          onResumeSession={(id) => void resumeSession(id)}
          onCopySessionId={(id) => void copyToClipboard(id)}
          onCloseProjectSessions={(id) => void closeProjectSessions(id)}
          project={project()}
          searchFiles={hasHost() ? searchProjectFiles : undefined}
          selectedFilePath={selectedFile()}
          onSelectFile={(path) => void openFile(path)}
          onOpenSettings={() => setVoiceSettingsOpen(true)}
          bottom={
            <ShotTray
              shots={shotSource.shots()}
              unavailable={shotSource.state() === "none"}
              load={shotSource.load}
              onDismiss={shotSource.dismiss}
              onDelete={(path) => void shotSource.remove(path)}
            />
          }
          /*
           * The theme and the bell, down beside the gear.
           *
           * They were in the top bar, among the buttons that open a pane,
           * start a session or search the project. Neither of them does
           * anything to the project: one is how the window looks and the
           * other is what it has already told you. Down here they sit with
           * the only other control of the same kind.
           */
          footerActions={
            <>
              <button
                type="button"
                data-slot="ade-icon"
                onClick={() => runCommand("theme.toggle")}
                aria-label={
                  theme() === "light"
                    ? t("settings.theme.toDark")
                    : theme() === "dark"
                      ? t("settings.theme.toGlass")
                      : t("settings.theme.toLight")
                }
                title={
                  theme() === "light"
                    ? t("settings.theme.toDark")
                    : theme() === "dark"
                      ? t("settings.theme.toGlass")
                      : t("settings.theme.toLight")
                }
              >
                <Show
                  when={theme() === "light"}
                  fallback={
                    <Show
                      when={theme() === "dark"}
                      fallback={
                        <svg
                          viewBox="0 0 16 16"
                          width="14"
                          height="14"
                          aria-hidden="true"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.3"
                        >
                          <circle cx="8" cy="8" r="3.2" />
                          <path
                            d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"
                            stroke-linecap="round"
                          />
                        </svg>
                      }
                    >
                      <svg
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        aria-hidden="true"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.3"
                      >
                        <path d="M4 2h8l3 5-7 7-7-7 3-5z" stroke-linejoin="round" />
                        <path d="M1 7h14M7.5 2l-2 5 2 7M8.5 2l2 5-2 7" stroke-linejoin="round" />
                      </svg>
                    </Show>
                  }
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="14"
                    height="14"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.3"
                  >
                    <path d="M13 9.5A5.2 5.2 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" stroke-linejoin="round" />
                  </svg>
                </Show>
              </button>

              {/* The bell, and the only place a notice survives being missed.
                  `data-drop="up"` because at the foot of the column there is
                  nothing below the button to hang a menu on. */}
              <div data-slot="ade-menu-anchor" data-drop="up">
                <button
                  type="button"
                  data-slot="ade-icon"
                  data-action="notifications"
                  ref={noticesButton}
                  data-tone={bellTone(notices())}
                  aria-haspopup="menu"
                  aria-expanded={noticesOpen()}
                  onClick={() => {
                    const opening = !noticesOpen()
                    setNoticesOpen(opening)
                    // Opening is reading: they are one line each and all on screen.
                    if (opening) setNotices((list) => markAllRead(list))
                  }}
                  aria-label={
                    unreadCount(notices()) > 0 ? `Notifiche, ${unreadCount(notices())} da leggere` : "Notifiche"
                  }
                  title={t("bell.title")}
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="15"
                    height="15"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.3"
                  >
                    <path
                      d="M8 2.2a3.8 3.8 0 0 1 3.8 3.8v2.2l1 2H3.2l1-2V6A3.8 3.8 0 0 1 8 2.2z"
                      stroke-linejoin="round"
                    />
                    <path d="M6.6 12.6a1.5 1.5 0 0 0 2.8 0" stroke-linecap="round" />
                  </svg>
                  <Show when={unreadCount(notices()) > 0}>
                    <span data-slot="ade-badge">{Math.min(unreadCount(notices()), 99)}</span>
                  </Show>
                </button>

                <Show when={noticesOpen()}>
                  <div
                    data-slot="ade-menu"
                    data-wide="true"
                    role="menu"
                    aria-label={t("bell.title")}
                    ref={(menu) =>
                      onCleanup(bindMenu(menu, { close: () => setNoticesOpen(false), anchor: noticesButton }))
                    }
                  >
                    {/* The bell is where a release shows up, so it is also where
                        asking for one belongs: the answer lands in this list,
                        "nothing new" included. */}
                    <button
                      type="button"
                      data-slot="ade-menu-action"
                      data-action="update.check"
                      disabled={checkingUpdate()}
                      onClick={() => void checkForUpdates()}
                    >
                      {checkingUpdate() ? t("update.checking") : t("palette.update.check")}
                    </button>
                    <Show when={notices().length > 0} fallback={<p data-slot="ade-menu-empty">{t("bell.empty")}</p>}>
                      <For each={notices()}>
                        {(notice) => (
                          <div data-slot="ade-notice-row" data-kind={notice.kind}>
                            <span data-slot="ade-notice-text">{notice.text}</span>
                            <Show when={notice.href}>
                              {(href) => (
                                <Show
                                  when={!updating()}
                                  fallback={
                                    <span
                                      data-slot="ade-notice-progress"
                                      role="progressbar"
                                      aria-valuemin={0}
                                      aria-valuemax={100}
                                      aria-valuenow={progressPercent(updateProgress())}
                                      aria-label={updateProgressText()}
                                    >
                                      <span data-slot="ade-notice-progress-text">
                                        {updateProgressText()}
                                        <Show when={hiddenAsk()}>
                                          <button
                                            type="button"
                                            data-slot="ade-notice-progress-show"
                                            onClick={showUpdate}
                                          >
                                            {t("update.dialog.show")}
                                          </button>
                                        </Show>
                                      </span>
                                      <span data-slot="ade-notice-progress-track">
                                        <span
                                          data-slot="ade-notice-progress-fill"
                                          data-indeterminate={
                                            progressPercent(updateProgress()) === undefined ? "true" : undefined
                                          }
                                          style={{ width: `${progressPercent(updateProgress()) ?? 100}%` }}
                                        />
                                      </span>
                                    </span>
                                  }
                                >
                                  <button
                                    type="button"
                                    data-slot="ade-notice-link"
                                    onClick={() => void installUpdate(href())}
                                  >
                                    {t("update.action")}
                                  </button>
                                </Show>
                              )}
                            </Show>
                            <button
                              type="button"
                              data-slot="ade-notice-dismiss"
                              onClick={() => setNotices((list) => dismissNotice(list, notice.id))}
                              aria-label={t("bell.dismiss")}
                            >
                              ×
                            </button>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                </Show>
              </div>
            </>
          }
        />

        <Show when={recordAsk()}>
          {(ask) => (
            <RecordConsentDialog
              target={ask().target}
              {...(ask().asker ? { asker: ask().asker } : {})}
              onAnswer={(consent) => ask().answer(consent)}
            />
          )}
        </Show>

        <Show when={updateAsk()}>
          {(ask) => (
            <UpdateDialog
              fromVersion={installedVersion()}
              toVersion={ask().version}
              releaseUrl={ask().href}
              running={ask().running}
              updating={updating()}
              progress={updateProgress()}
              error={updateError()}
              onLater={() => {
                setHiddenAsk(updating() ? ask() : undefined)
                setUpdateError(undefined)
                setUpdateAsk(undefined)
              }}
              onGo={() => void runUpdate()}
              onOpenRelease={() => void openNoticeLink(ask().href)}
            />
          )}
        </Show>

        <main data-slot="ade-main">
          {/* Above the section rather than over it: these messages are about
              something that already happened, so they must not cover the
              thing the user is about to look at. Dismissed by hand, because a
              failed save that vanishes on a timer is a failed save nobody
              read. */}
          <Show when={notice()}>
            {(text) => (
              <div data-slot="ade-notice" role="status">
                <span data-slot="ade-notice-text">{text()}</span>
                <Show when={noticeAction()?.text === text() ? noticeAction() : undefined}>
                  {(action) => (
                    <button type="button" data-slot="ade-notice-action" onClick={() => action().run()}>
                      {action().label}
                    </button>
                  )}
                </Show>
                <button
                  type="button"
                  data-slot="ade-notice-close"
                  onClick={() => setNotice(undefined)}
                  aria-label={t("bar.dismissNotice")}
                >
                  ✕
                </button>
              </div>
            )}
          </Show>

          <Show when={wb().view === "agent"}>
            <AgentConsole
              history={voiceEngine.history()}
              running={voiceEngine.isRunning()}
              status={voiceEngine.status()}
              partial={voiceEngine.partialTranscript()}
              canPlan={hasVoiceAgent() && voiceSettings().agentEngine !== "off"}
              hasKey={transcriptionReady(voiceSettings())}
              hasAgent={hasVoiceAgent()}
              hasVoice={voiceInstalled() && !voiceError()}
              isVoiceDownloading={voiceDownloading()}
              voiceError={voiceError()}
              onDownloadVoice={() => void downloadNaturalVoice()}
              onOpenKeySettings={() => openVoiceSettings("voice-sec-backend")}
              onOpenAgentSettings={() => openVoiceSettings("set-sec-provider")}
              held={voiceEngine.held()}
              onSubmit={(text) => void voiceEngine.submitText(text)}
              onToggleMic={() => void (voiceEngine.isRunning() ? voiceEngine.stop() : voiceEngine.toggle())}
              onOpenSettings={(sec) => openVoiceSettings(sec)}
            />
          </Show>

          <Show when={wb().view === "chat" && isViewVisible("chat")}>
            <Chat projectRoot={project()?.root} />
          </Show>

          <Show when={wb().view === "bot" && isViewVisible("bot")}>
            {/* A bot is a nikcli agent, so there is no key to ask for and no
                roster of ADE's own: the section reads the files nikcli reads,
                and starting one is the session the user would start. */}
            <BotsMain
              {...(project()?.root ? { projectRoot: project()!.root } : {})}
              onLaunch={(bot) => openBotSession(bot)}
              onOpenFile={(path) => void openFile(path)}
              onOpenKeys={() => openVoiceSettings("set-sec-keys")}
            />
          </Show>

          <Show when={wb().view === "code"}>
            {/* Without a project there is nothing to run an agent in, and in the
                browser there is no way to run one at all. Offering the launch
                screen there would be offering a button that cannot work. */}
            <Show
              when={project()}
              fallback={<EmptyProject hasHost={hasHost()} onOpenProject={() => runCommand("project.open")} />}
            >
              {/* Counted within the project, not across all of them: standing
                  in a project with no sessions must offer the launch screen,
                  even while another project's sessions are still running. */}
              <Show
                when={gridPanes().length > 0 && !starting()}
                fallback={
                  <SessionNew
                    workspace={project()?.name || "workspace"}
                    path={project()?.root || ""}
                    /* Cancelling is only offered when there is something to go
                       back to; on an empty workbench it would lead nowhere. */
                    onClose={gridPanes().length > 0 ? () => setStarting(false) : undefined}
                    onLaunch={(input) => launchSessions(input)}
                  />
                }
              >
                <SessionGrid
                  panes={gridPanes()}
                  focused={wb().focusedId}
                  onFocus={(id) => setWb((w) => ({ ...w, focusedId: id }))}
                  onClose={close}
                  columns={wb().pinnedColumns}
                  tileOf={(id) => wb().panes.find((pane) => pane.id === id)}
                  onMove={(order) => setWb((w) => reorderPanes(w, order))}
                  onResize={(id, span) => setWb((w) => resizePane(w, id, span))}
                />
                <DevServerOffers
                  offers={devOffers().filter((offer) => gridPanes().some((pane) => pane.id === offer.sessionId))}
                  onOpen={acceptDevOffer}
                  onDismiss={(offer) => setDevOffers((list) => list.filter((item) => item !== offer))}
                />
              </Show>
            </Show>
          </Show>
        </main>
      </div>

      <RemoteSpaceDialog
        open={remoteOpen()}
        onClose={() => setRemoteOpen(false)}
        onConnect={(target) => void addRemoteSpace(target)}
      />

      <Show when={toast.text()}>
        {(text) => (
          <div data-slot="ade-toast" role="status" aria-live="polite">
            {text()}
          </div>
        )}
      </Show>

      <Show when={choicesOpen()}>
        <ChoicesSheet
          items={choices()}
          onPick={pickChoice}
          onClose={() => setChoicesOpen(false)}
          onOpenPanels={() => {
            setChoicesOpen(false)
            openDecisionsPane()
            openDesignPane()
          }}
        />
      </Show>

      <Show when={decisionsOpen()}>
        <DecisionsSheet
          hub={decisionsHub}
          start={choiceStart()}
          waiting={() => choices().length}
          onDone={(next, said) => {
            setDecisionsOpen(false)
            if (next === "list") setChoicesOpen(true)
            if (said) toast.show(said)
          }}
          onClose={() => setDecisionsOpen(false)}
          onOpenPanel={() => {
            setDecisionsOpen(false)
            openDecisionsPane()
          }}
        />
      </Show>

      <Show when={designOpen()}>
        <DesignSheet
          hub={designHub}
          start={choiceStart()}
          waiting={() => choices().length}
          onDone={(next, said) => {
            setDesignOpen(false)
            if (next === "list") setChoicesOpen(true)
            if (said) toast.show(said)
          }}
          onClose={() => setDesignOpen(false)}
          onOpenPanel={() => {
            setDesignOpen(false)
            openDesignPane()
          }}
        />
      </Show>

      <Show when={keyRequest() && keysHost()}>
        <KeyRequestDialog
          host={keysHost()!}
          agents={AGENTS}
          env={keyRequest()!.env}
          reason={keyRequest()!.reason}
          {...(keyRequest()!.asker ? { asker: keyRequest()!.asker } : {})}
          onClose={() => setKeyRequest(undefined)}
        />
      </Show>

      <CommandPalette
        open={paletteOpen()}
        commands={allCommands()}
        onRun={runCommand}
        onClose={() => setPaletteOpen(false)}
        platform={platform}
        emptyLabel={t("palette.empty")}
      />

      {/*
        ADE's one settings panel.
        The plugins used to be a card in the sidebar, between the file tree
        and the screenshot tray — a list of what is loaded, sitting in the
        column meant for projects and files. They are configuration, so they
        are here, in the same rail as everything else configurable. One
        panel, one gear, one answer to "where are the settings".
      */}
      <Show when={voiceSettingsOpen()}>
        {/* On Kobalte, as the other sheets: the panel draws its own box and title. */}
        <Sheet
          component="voice-settings-overlay"
          onClose={closeVoiceSettings}
          surface={false}
          labelledBy="voice-panel-title"
        >
          <VoiceSettingsPanel
            framed
            engine={voiceEngine}
            settings={voiceSettings()}
            initialSection={voiceSettingsSection()}
            shortcutRefusals={shortcutRefusals()}
            onChange={handleVoiceSettingsChange}
            onClose={closeVoiceSettings}
            onOpenVoiceSource={(voice) => void getHost().then((host) => host?.ttsOpenVoiceSource?.(voice))}
            naturalVoiceError={voiceError()}
            naturalVoiceDownloading={voiceDownloading()}
            onDownloadNaturalVoice={() => void downloadNaturalVoice()}
            {...(piperProgress() ? { naturalVoiceProgress: piperProgress() } : {})}
            onCancelInstall={(provider) =>
              void (provider === "kokoro"
                ? kokoro.cancel()
                : getHost().then((host) => host?.ttsInstallCancel?.(provider)))
            }
            kokoroPack={kokoroPack()}
            onInstallKokoro={() => void kokoro.install()}
            onDeleteKokoro={() => void kokoro.remove()}
            onTestVoice={testReplyVoice}
            existingBindings={bindings}
            settingsNotice={voiceSettingsNotice()}
            title={t("settings.title")}
            subtitle={t("settings.subtitle")}
            /*
             * Two headings, because the rail is now two lists.
             * Six voice screens followed by six of ADE's own, unbroken, gave
             * no clue where the microphone stopped and the application began.
             */
            builtInGroup={t("settings.group.voice")}
            extraGroup={BRAND.name}
            extraSections={[
              {
                id: "set-sec-theme",
                label: t("settings.theme.title"),
                glyph: "◐",
                render: () => (
                  <ThemeSection
                    value={themeState.preference}
                    onChange={(next) => themeState.set(next)}
                    opacity={themeState.glassOpacity}
                    onOpacityChange={(val) => themeState.setGlassOpacity(val)}
                    glassStatus={glassStatus}
                  />
                ),
              },
              {
                id: "set-sec-language",
                label: t("settings.language.label"),
                glyph: "文",
                render: () => <LanguageSection />,
              },
              {
                id: "set-sec-routine",
                label: t("settings.routine"),
                glyph: "↻",
                render: () => <RoutineSection />,
              },
              {
                id: "set-sec-bot",
                label: "Bot",
                glyph: "◍",
                // The project, so the list holds the bots that belong to it as
                // well as the global ones — which is what nikcli would see.
                render: () => <BotSection {...(project()?.root ? { projectRoot: project()!.root } : {})} />,
              },
              {
                /*
                 * "Codice" is the coding view's own settings: how its grid is
                 * laid out, and how a session finds its way back to the
                 * conversation it was having. Both are about the panes, and
                 * the panes are what the `code` view is.
                 */
                id: "set-sec-code",
                label: t("settings.code"),
                glyph: "⌗",
                value: String(Object.values(hookStates()).filter((state) => state.installed).length),
                render: () => (
                  <>
                    <GridSection
                      columns={wb().pinnedColumns}
                      onChange={(columns) => setWb((w) => setColumns(w, columns))}
                    />
                    <AgentHooksSection host={hookHost()} states={hookStates()} onChanged={() => void refreshHooks()} />
                  </>
                ),
              },
              {
                id: "set-sec-provider",
                label: "Provider",
                glyph: "⚿",
                render: () => <ProviderSection onLogin={(runner) => openLoginSession(runner)} />,
              },
              {
                id: "set-sec-keys",
                label: t("settings.keys"),
                glyph: "⚷",
                render: () => <KeysSection host={keysHost()} agents={AGENTS} />,
              },
              {
                /*
                 * MCP and plugins on one page (S16, variant B): what is
                 * installed, the verified MCP catalog, and the plugins. The two
                 * separate entries were one question — "what does ADE add to
                 * the agents?" — asked in two places, one of them empty.
                 */
                id: "set-sec-extensions",
                label: t("settings.extensions"),
                glyph: "⊞",
                value: String(pluginRuntime.registry.sections().length),
                render: () => (
                  <ExtensionsPage
                    projectRoot={project()?.root}
                    io={extensionsIo()}
                    pluginCount={pluginRuntime.registry.sections().length}
                    onOpenGuide={(url) => openGuide(url)}
                    plugins={() => (
                      <Show
                        when={pluginRuntime.registry.sections().length > 0}
                        fallback={<p data-slot="section-desc">{t("settings.noPlugins")}</p>}
                      >
                        <For each={pluginRuntime.registry.sections()}>
                          {(section) => <PluginSection title={section.title} render={() => section.render({})} />}
                        </For>
                      </Show>
                    )}
                  />
                ),
              },
              {
                id: "set-sec-skills",
                label: t("settings.tools"),
                glyph: "✦",
                render: () => <SkillsSection {...(project()?.root ? { projectRoot: project()!.root } : {})} />,
              },
            ]}
          />
        </Sheet>
      </Show>

      {/*
        Last in the shell, so it paints over the grid without being inside it.
        The target is named rather than implied: dictation lands in the focused
        pane, and a widget that transcribed into a session the user had stopped
        looking at would be a surprise every time.
      */}
      <VoiceHud
        engine={voiceEngine}
        naturalVoiceError={voiceError()}
        target={(() => {
          const focused = wb().panes.find((pane) => pane.id === wb().focusedId)
          return focused?.title
        })()}
        onCycleTarget={() => {
          const sessionPanes = wb().panes.filter((p) => !isPanelPane(p))
          if (sessionPanes.length <= 1) return
          const currentIndex = sessionPanes.findIndex((p) => p.id === wb().focusedId)
          const nextIndex = (currentIndex + 1) % sessionPanes.length
          const nextPane = sessionPanes[nextIndex]
          if (nextPane) {
            setWb((w) => ({ ...w, focusedId: nextPane.id }))
          }
        }}
        onOpenSettings={() => {
          setVoiceSettingsSection("voice-sec-mode")
          setVoiceSettingsOpen(true)
        }}
      />

      {/* S33: the agent speaks through its own sphere, over the workspace. */}
      <AgentOrb
        engine={voiceEngine}
        meter={playbackMeter}
        stage={() => document.querySelector('[data-slot="ade-main"]')}
      />
    </div>
  )
}

/**
 * The mark for one entry of the multiframe menu.
 *
 * Drawn here rather than in `new-pane.ts` because a glyph is a component and
 * that module has to stay importable under `bun test`, where a `.tsx` is not.
 */
function NewPaneGlyph(props: { kind: NewPaneItem["glyph"] }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
    >
      <Show when={props.kind === "session"}>
        <rect x="1.8" y="3" width="12.4" height="10" rx="1.6" />
        <path d="M4.4 6.6l2 1.9-2 1.9M8.4 10.4h3.2" stroke-linecap="round" stroke-linejoin="round" />
      </Show>
      <Show when={props.kind === "browser"}>
        <rect x="1.8" y="3" width="12.4" height="10" rx="1.6" />
        <path d="M1.8 6.2h12.4M4 4.6h.01M5.9 4.6h.01" stroke-linecap="round" />
      </Show>
      <Show when={props.kind === "video"}>
        <rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.6" />
        <path d="M6.6 6.4l3.8 2.2-3.8 2.2z" stroke-linejoin="round" />
      </Show>
      <Show when={props.kind === "app"}>
        <rect x="4.2" y="1.5" width="7.6" height="13" rx="1.6" />
        <path d="M7 12.4h2" stroke-linecap="round" />
      </Show>
      <Show when={props.kind === "model"}>
        <path d="M8 1.8l5.6 3.1v6.2L8 14.2l-5.6-3.1V4.9z" stroke-linejoin="round" />
        <path d="M2.4 4.9L8 8l5.6-3.1M8 8v6.2" stroke-linejoin="round" />
      </Show>
      <Show when={props.kind === "decisions"}>
        <path d="M8 1.8v3.4M8 5.2L3.2 9.4M8 5.2l4.8 4.2" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="3.2" cy="11.6" r="2.2" />
        <circle cx="12.8" cy="11.6" r="2.2" />
      </Show>
      <Show when={props.kind === "design"}>
        <path d="M11.5 2.5l2 2-7.5 7.5H4v-2l7.5-7.5z" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M10 4l2 2" stroke-linecap="round" />
      </Show>
    </svg>
  )
}
