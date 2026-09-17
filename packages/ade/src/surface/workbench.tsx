import { onMount, onCleanup, on, createSignal, createEffect, createMemo, createResource, Show, For } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import { getHost, stripAnsi, type SpawnedSession } from "../host/shell"
import { every } from "../host/every"
import { isRemoteRoot, remoteRoot, sshArgs, sshAsking, type RemoteTarget } from "../remote/ssh"
import { RemoteSpaceDialog } from "../remote/remote-dialog"
import { discoverProject, openProject, type Project } from "../host/project"
import { addRecent, serializeRecents, parseRecents, type RecentEntry } from "../host/recent"
import { pathEquals } from "../host/path"
import { serializeWorkspace, parseWorkspace, type WorkspaceState } from "../session/persist"
import { DEFAULT_BINDINGS, resolveDefaultBindings } from "../keyboard/bindings"
import { formatChord, parseChord } from "../keyboard/keymap"
import { CommandPalette } from "../command/palette"
import { SessionNew } from "../session-new/session-new"
import { AGENTS, agentById, agentLabel } from "../session-new/agents"
import { KeyRequestDialog, KeysSection, type KeysHost } from "../secrets/keys-section"
import { KEYS_VERBS, runKeysCommand } from "../secrets/keys"
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
import { RESUME, planFork, planRestore, planResume, planStart, type ResumePlan } from "../session-new/resume"
import { followReports, newNonce } from "../session-new/agent-link"
import { HOOK_TARGETS, hookTarget, readHookStatus, refreshHookScript, type HookHost, type HookStatus } from "../session-new/agent-hooks"
import { AgentHooksSection } from "../session-new/agent-hooks-panel"
import { BotSection, GridSection, LanguageSection, ProviderSection, RoutineSection, SkillsSection } from "../settings/sections"
import { locale, refreshSystemLocale, syncDocumentLanguage, t, translate } from "../i18n"
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
import { NikChromeLogo } from "./nik-chrome-logo"
const isTauriDesktop = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)

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
import {
  createWorkbench,
  type Pane,
  addPane,
  closePane,
  updatePane,
  isPanelPane,
  expandPane,
  setColumns,
  reorderPanes,
  resizePane,
  deriveWorkspaces,
  toWorkspaceState,
  fromWorkspaceState,
  sessionsToResume,
  nextView,
  ADE_VIEW_LABELS,
  VISIBLE_VIEWS,
  isViewVisible,
  type Workbench as WorkbenchState,
} from "./state"
import { AgentConsole } from "../agent/agent-console"
import { Chat } from "../chat/chat"
import { BotsMain, BotsRoster } from "../bots/bots"
import type { AgentFile } from "../bots/nikcli"
import type { Runner } from "../bots/runners"
import { senderToken } from "../session/senders"
import { boardCandidates, parseOwners, whoOwns } from "../session/owners"
import { mayReroute, pickProvider, setProviderPicker } from "../session/provider-pick"
import { pickByQuota } from "../session/quota-pick"
import { freshSharedQuota } from "../session/quota-store"
import { botLaunch } from "../bots/store"
import { buildCommands, keepsPaletteOpen } from "./commands"
import { createRecorder, eventsPathFor, micPathFor, voicePathFor, type StartOptions } from "../record/recorder"
import { startMicTake } from "../record/mic"
import { exportPromo } from "../record/export"
import { RECORD_VERBS, runRecordRequest, type RecordConsent } from "../record/record-panel"
import { RecordConsentDialog } from "../record/consent-dialog"
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
import { importPluginModule } from "../plugin/loader"
import { PluginSection } from "../plugin/pane"
import { parseCommandId } from "../plugin/trust"
import { CONSENT_KEY, consentQuestion, hasConsent, withConsent } from "../plugin/consent"
import { toPluginSession } from "../plugin/session"
import type { DiscoveryIO } from "../plugin/discovery"
import {
  markSaved,
  openBuffer,
  saveBlockedReason,
} from "../editor"
import {
  detectPermission,
  isResolved,
  type PermissionAnswer,
} from "../session/permission"
import { readReportLine } from "../session/report"
import { asOneLine, asSubmittedLine, pasteSettled } from "../session/typing"
import { searchPaths, walkProject } from "../search"
import {
  DEFAULT_MAX_SPAWNED,
  USAGE,
  agentsTable,
  briefOf,
  byProject,
  formatCancel,
  formatNudge,
  formatUpdate,
  parseActivity,
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
  isFree,
  statusFromActivity,
  sameDir,
  formatLateReply,
  formatRequest,
  parseMessage,
  resolveAgent,
  resolveTarget,
  sessionsTable,
  verifySender,
  type MailPane,
  type Message,
  formatBell,
  formatUnread,
  formatWedged,
  interruptKeys,
  WEDGE_MS,
  openDecisions,
  type OpenDecision,
  goesToInbox,
  inboxAction,
  inboxName,
  parseInbox,
  type InboxEntry,
} from "../session/mailbox"

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
import { displayArgs, introArgs, withIntro } from "../session-new/intro"
import { createThemeState } from "./theme-state"
import { createPaneRecords } from "./pane-records"
import { createAutosave } from "./autosave"
import { createPaneRenderer } from "./pane-renderer"
import { Splash } from "../splash/splash"
import { createPanelRouter } from "../panels/router"
import { panelsHelp } from "../panels/protocol"
import { BROWSER_VERBS, runBrowserCommand, type BrowserController } from "../browser/binding"
import { formatRequestDetails, formatRequestLine, requestStem, type BrowserRequest, type Rect } from "../browser/request"
import { devServerUrl, offerKey, shouldOffer, type DevServerOffer } from "../browser/dev-server"
import { DevServerOffers } from "../browser/dev-server-offer"
import { VIDEO_VERBS } from "../video/video"
import { MODEL_VERBS } from "../model3d/model"
import { SIMULATOR_VERBS } from "../simulator/simulator"
import { PLAYABLE_EXTENSIONS } from "../video/video"
import { playWav } from "../voice/wav-player"
import { MODEL_EXTENSIONS } from "../model3d/model"
import { paneShowing, routeForFile } from "./open-route"
import { guessDevServers } from "../simulator/simulator"
import { countLabel } from "../decisions/answer"
import { DecisionsSheet } from "../decisions/decisions-sheet"
import {
  deliveryLine,
  deliveryState,
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
  type OutboxItem,
} from "../decisions/delivery"
import { createDecisionsHub } from "../decisions/hub"
import { createDecisionsRegister } from "../decisions/register"
import { decisionsPath } from "../decisions/store"
import {
  AgentOrb,
  createMicMeter,
  createPlaybackMeter,
  createVoiceEngine,
  createWebSpeechSpeaker,
  createFakeSpeaker,
  createNaturalSpeaker,
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
  type VoiceSettings,
} from "@nikcli-ai/voice"
import { ShotTray, createShotSource } from "../shots"
import { disposeTerminal, noteInTerminal, refreshTerminalThemes, startOnCleanScreen, writeToTerminal } from "../terminal/registry"
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
import { isReleasePage } from "../update/release"
import { createAdeVoiceHost } from "../voice/host"
import { createPushToTalkHandler, resolveVoiceOrAdeKey } from "../voice/shortcuts"
import {
  GLOBAL_VOICE_EVENT,
  globalVoiceAction,
  registerVoiceShortcuts,
  unknownChordMessage,
} from "../voice/global-shortcut"
import { createListenGuard, LOCK_POLL_MS } from "../voice/listen-guard"

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
  "browser.new",
  "process.kill",
  "voice.toggle",
  "voice.settings",
])

function isHandledCommand(id: string): boolean {
  return HANDLED_COMMANDS.has(id) || id.startsWith("project.recent.")
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

/**
 * How much of a session's output a pane keeps in memory.
 *
 * The scrollback the user can actually reach; what goes to disk is bounded
 * separately by `transcript-budget`.
 */
const MAX_PANE_LINES = 200

/**
 * The shortest time the startup screen stays up.
 *
 * A warm start finishes in under a tenth of a second, and a screen that
 * appears and vanishes in that time reads as a glitch. Long enough to be
 * looked at, short enough not to be waited for.
 */
const SPLASH_FLOOR_MS = 7000

export function Workbench() {
  const platform = navigator.userAgent.includes("Mac") ? "mac" : "other"
  const bindings = resolveDefaultBindings(platform)
  
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

  /**
   * Applies a whole new workbench, keeping the parts that did not change.
   *
   * The reducers in `state.ts` are pure and return a fresh object; `reconcile`
   * turns that back into the smallest set of writes against the store, keyed
   * by pane id, so replacing the object does not invalidate every pane in it.
   */
  const setWb = (next: WorkbenchState | ((current: WorkbenchState) => WorkbenchState)) => {
    const current = unwrap(wbStore)
    const value = typeof next === "function" ? next(current) : next
    if (value !== current) setWbStore(reconcile(value, { key: "id" }))
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
    typeof window !== "undefined" &&
      "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>),
  )
  const [project, setProject] = createSignal<Project>()
  const [recents, setRecents] = createSignal<RecentEntry[]>([])

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
    const list: Array<{ root: string; name: string; branch?: string }> = recents().map((r) => ({
      root: r.root,
      name: r.name,
      branch: (r.root === currentProject?.root || r.name === currentProject?.name) ? currentProject?.branch : undefined,
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

  /*
   * xterm is handed concrete colours, so it cannot follow the theme on its own.
   *
   * The attribute below drives the whole stylesheet, but a terminal resolved
   * its palette once and keeps it: the repaint has to be pushed. Deferred by a
   * frame because this effect runs before the new `data-theme` has been
   * committed to the DOM, and the probe reads the cascade as it stands.
   */
  createEffect(() => {
    theme()
    const frame = requestAnimationFrame(() => refreshTerminalThemes())
    onCleanup(() => cancelAnimationFrame(frame))
  })

  /*
   * Everything keyed by pane id, in one place so it is forgotten in one place.
   * See `pane-records.ts` for why that matters.
   */
  const records = createPaneRecords()
  const { reports, buffers, bufferLoading, permissions } = records

  /*
   * One line for things the user has to be told but must not be stopped for.
   *
   * It used to be the worktree board's status line, which is where the file
   * editor borrowed it from. With the board gone those messages had nowhere
   * left to appear, and a save that failed would have failed in silence — so
   * the notice is now the shell's own, rendered above the section.
   */
  const [notice, setNotice] = createSignal<string>()

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

  /** Says it once, in both places: the strip now, the bell afterwards. */
  const report = (text: string, kind: NoticeKind = "error", paneId?: string) => {
    setNotice(text)
    setNotices((list) => addNotice(list, { kind, text, at: Date.now(), ...(paneId ? { paneId } : {}) }))
  }

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
    for (const line of panels.greeting(panel)) appendLine(paneId, line, "note")
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
  const [keyRequest, setKeyRequest] = createSignal<{ env: string; reason: string }>()
  panels.register("keys", {
    verbs: KEYS_VERBS,
    run: (request) => {
      return runKeysCommand({ list: keysService.list, ask: (env, reason) => setKeyRequest({ env, reason }) }, request).catch(
        (failure: unknown) => ({ ok: false as const, reason: failure instanceof Error ? failure.message : String(failure) }),
      )
    },
  })

  /*
   * `@ade browser …` (S46): a session opens a web pane bound to itself and
   * drives it. One handler for every pane, since the answer depends on who
   * asks; each mounted pane leaves its controls in `browserControllers`.
   */
  const browserControllers = new Map<string, BrowserController>()
  /** The web pane bound to session `ownerId`, the most recent if several. */
  const ownedBrowser = (ownerId: string) => wb().panes.filter((p) => p.browserUrl && p.browserOwner?.id === ownerId).at(-1)
  /** A new web pane on `url`, bound to `owner`, in the owner's project. */
  const openOwnedBrowser = (url: string, owner: { id: string; title: string }, focus: boolean): Pane => {
    const pane: Pane = {
      id: `b${Date.now()}`,
      title: "Browser",
      status: "working",
      model: "—",
      mode: "browser",
      browserUrl: url,
      browserOwner: owner,
      workspaceId: wb().panes.find((p) => p.id === owner.id)?.workspaceId ?? project()?.name ?? "workspace",
      lines: [],
    }
    setWb((w) => (focus ? addPane(w, pane) : { ...addPane(w, pane), focusedId: w.focusedId }))
    return pane
  }
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
    if (!pane || !shouldOffer({ sessionId: paneId, url, seen: offersSeen, ownedUrl: ownedBrowser(paneId)?.browserUrl })) return
    offersSeen.add(offerKey(paneId, url))
    setDevOffers((list) => [...list.filter((offer) => offer.sessionId !== paneId), { sessionId: paneId, title: pane.title, url }].slice(-3))
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
  const pickRecordDir = async () => {
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
  }

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
    answer: (consent: RecordConsent) => void
  }>()
  const confirmRecording = (target: Parameters<typeof recorder.start>[0]) =>
    new Promise<RecordConsent>((resolve) => {
      // One question at a time: a second agent asking meanwhile is refused.
      if (recordAsk()) return resolve({ allowed: false, mic: false })
      setRecordAsk({
        target,
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
      const events = await host.readTextFile(eventsPathFor(video)).then((file) => file.text).catch(() => "")
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
    run: (request) =>
      runRecordRequest(request, {
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
      }).catch((failure: unknown) => ({
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
    setWb((w) => addPane(w, {
      id: `m${Date.now()}`,
      title: path ? (path.split(/[\\/]/).pop() ?? t("newPane.model")) : t("newPane.model"),
      status: "working",
      model: "—",
      mode: "model",
      modelPath: path,
      workspaceId: project()?.name ?? "workspace",
      lines: [],
    }))
  }

  /** A video panel on `path`, or the one already playing it. */
  const openVideo = (path: string) => {
    const existing = paneShowing(wb().panes, "video", path)
    if (existing) {
      setWb((w) => ({ ...w, focusedId: existing.id }))
      return
    }
    setWb((w) => addPane(w, {
      id: `v${Date.now()}`,
      title: path.split(/[\\/]/).pop() ?? t("pane.video.title"),
      status: "working",
      model: "—",
      mode: "video",
      videoPath: path,
      workspaceId: project()?.name ?? "workspace",
      lines: [],
    }))
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
      host.readTextFile!(`${base}/${relative}`, 256_000).then((file) => file.text, () => undefined)
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
  const decisionsRegister = createDecisionsRegister({
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
        ...(host.appendTextFile ? { appendTextFile: (path: string, text: string) => host.appendTextFile!(path, text) } : {}),
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
  const decisionCandidates = () =>
    mailPanes().map((pane) => ({ id: pane.id, title: pane.title, project: pane.project, running: isRunning(pane.id) }))
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
    const target = decisionRecipient()
    if (target.state !== "pronta") return
    const host = await getHost()
    if (!host) return
    deliveringDecisions = true
    try {
      for (const item of pending) {
        const decision = state.decisions.find((entry) => entry.k === item.k)
        if (!decision || !running.has(target.id) || !(await freeNow(host, target.id))) continue
        // Through the inbox when the line is long (a note of a few paragraphs), like every other message.
        if (!(await deliverText(host, target.id, deliveryLine(decision), { id: `decisione-${decision.k}`, kind: "send", from: "" }))) continue
        const stored = decisionsOutbox().find((entry) => entry.path === item.path && entry.k === item.k && entry.answeredAt === item.answeredAt)
        if (stored) saveDecisionsOutbox(markDelivered(decisionsOutbox(), stored, target.title, Date.now()))
        appendLine(target.id, t("decisions.delivered", decision.k), "note")
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
      saveDecisionsOutbox(enqueue(decisionsOutbox(), { path, k: decision.k, answeredAt: event.at, queuedAt: Date.now() }))
      void deliverDecisions()
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

  const [decisionsOpen, setDecisionsOpen] = createSignal(false)
  const decisionsWaiting = createMemo(() => decisionsRegister.state()?.decisions.filter((decision) => decision.status === "aperta").length ?? 0)

  onMount(() => {
    onCleanup(decisionsRegister.watch())
    // Only does work while an answer is waiting to go out.
    onCleanup(every(3000, () => deliverDecisions(), { whenHidden: 15_000 }))
  })

  /** Opens the Decisions panel, or focuses the one already open. */
  const openDecisionsPane = () => {
    const existing = wb().panes.find((pane) => pane.mode === "decisions")
    if (existing) {
      setWb((w) => ({ ...w, view: "code", focusedId: existing.id }))
      return
    }
    setWb((w) => ({
      ...addPane(w, {
        id: `d${Date.now()}`,
        title: "Decisioni",
        status: "working",
        model: "—",
        mode: "decisions",
        workspaceId: project()?.name ?? "workspace",
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
    if ("skipped" in handled) return appendLine(paneId, handled.skipped, "note")
    // Written to the transcript too, because what an agent did to a panel is
    // something the user has to be able to see afterwards.
    appendLine(paneId, handled.reply, "note")
    panels.typed(paneId, handled.reply)
    running.get(paneId)?.write(asSubmittedLine(handled.reply))
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
    appendLine(to, t("note.browserRequest", request.paneTitle), "note")
    return { ok: true }
  }

  const running = new Map<string, SpawnedSession>()
  const [runningTick, setRunningTick] = createSignal(0)
  const touchRunning = () => setRunningTick(n => n + 1)
  const isRunning = (id: string) => { runningTick(); return running.has(id) }

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
          status: running.has(pane.id) ? pane.status : "chiusa",
          project: pane.workspaceId,
        })),
    )

  /** Long enough for a TUI's paste detection to close before Enter arrives. */
  const SUBMIT_DELAY_MS = 400
  let delivering = false

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
  const typeLine = async (session: SpawnedSession, text: string): Promise<boolean> => {
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
    session.write(bracketed ? `${ESC}[200~${line}${ESC}[201~` : line)
    if (bracketed) {
      while (!pasteSettled({ typedAt, lastOutputAt: lastOutputAt.get(paneId), now: Date.now() })) {
        if (![...running.values()].includes(session)) return false
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    } else await new Promise((resolve) => setTimeout(resolve, Math.min(2500, SUBMIT_DELAY_MS + line.length)))
    if (![...running.values()].includes(session)) return false
    session.write("\r")
    if (paneId !== undefined) {
      // A line ADE submits starts a turn exactly as the user's Enter does.
      markWorking(paneId)
      void confirmSubmitted(paneId, session, typedAt)
    }
    return true
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
   * `UserPromptSubmit` runs the moment a prompt is sent. If it has not run
   * within a few seconds the line is still in the input box, and Enter goes
   * again — twice at most, never over a permission prompt, and not at all for
   * a CLI without the hook, where no answer is not evidence of anything.
   */
  const confirmSubmitted = async (paneId: string, session: SpawnedSession, typedAt: number) => {
    const host = await getHost()
    const nonce = paneNonces.get(paneId)
    if (!host?.readAgentActivity || !nonce || !hooked(paneId)) return
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      if (running.get(paneId) !== session || permissions()[paneId]) return
      const resumeId = wb().panes.find((pane) => pane.id === paneId)?.resumeId
      const activity = parseActivity(await host.readAgentActivity(nonce), resumeId)
      if (activity && activity.at >= typedAt) {
        activityOf.set(paneId, activity)
        return
      }
      /*
       * Busy from before the line was typed: the CLI queued it behind the
       * current turn, and it will be submitted when that turn ends. An Enter
       * now would land in whatever the turn is doing.
       */
      if (activity?.state === "busy") return
      session.write("\r")
      appendLine(paneId, t("note.resent"), "note")
    }
  }

  /** Messages held for a busy recipient, whose sender has already been told. */
  const held = new Set<string>()
  /** Late replies and updates for a caller that is busy: typed when its turn ends. */
  const heldLines: { paneId: string; text: string; inbox?: InboxMeta }[] = []

  /** Whether a pane can be typed into now without interrupting it; reads its turn activity when hooked. */
  const freeNow = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, paneId: string): Promise<boolean> => {
    const isHooked = hooked(paneId)
    let activity = activityOf.get(paneId)
    const nonce = paneNonces.get(paneId)
    if (isHooked && nonce && host.readAgentActivity) {
      const resumeId = wb().panes.find((pane) => pane.id === paneId)?.resumeId
      activity = keptActivity(activity, parseActivity(await host.readAgentActivity(nonce), resumeId))
      if (activity) activityOf.set(paneId, activity)
      else activityOf.delete(paneId)
    }
    return isFree(
      {
        hooked: isHooked,
        permissionPending: Boolean(permissions()[paneId]),
        ...(activity ? { activity } : {}),
        ...(lastOutputAt.has(paneId) ? { lastOutputAt: lastOutputAt.get(paneId)! } : {}),
      },
      Date.now(),
    )
  }

  /** Messages taken from the outbox and not delivered yet, oldest first. */
  const mailQueue: { id: string; message: Message; at: number }[] = []

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
  const openRequests = new Map<string, OpenRequest>(parseOpenRequests(readStored(REQUESTS_KEY)).map((request) => [request.id, request]))
  const saveRequests = () => writeStored(REQUESTS_KEY, JSON.stringify([...openRequests.values()]))

  /** Long messages left in an inbox and not yet read (S20). */
  const INBOX_KEY = "ade.mailbox.inbox"
  const inboxPending: InboxEntry[] = parseInbox(readStored(INBOX_KEY))
  const saveInbox = () => writeStored(INBOX_KEY, JSON.stringify(inboxPending))

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
  ): Promise<boolean> => {
    const session = running.get(paneId)
    if (!session) return false
    if (!goesToInbox(line) || !host.mailboxInboxPut || !host.mailboxInboxRead) return typeLine(session, line)
    const at = Date.now()
    const entry: InboxEntry = { id: meta.id, paneId, name: inboxName(meta.id, at), from: meta.from, kind: meta.kind, chars: line.length, at, ringAt: at, rings: 0 }
    const stored = await host.mailboxInboxPut(paneId, entry.name, line).then(
      () => true,
      () => false,
    )
    if (!stored) return typeLine(session, line)
    inboxPending.push(entry)
    saveInbox()
    return typeLine(session, formatBell(entry, mailPanes().find((pane) => pane.id === meta.from), line.length))
  }

  /** Rings again for unread inbox messages, and tells the sender of one never read. */
  const followInbox = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, now: number) => {
    if (!host.mailboxInboxRead || inboxPending.length === 0) return
    let changed = false
    for (const entry of [...inboxPending]) {
      const session = running.get(entry.paneId)
      const read = session ? await host.mailboxInboxRead(entry.paneId, entry.name).catch(() => false) : false
      const free = session && !read ? await freeNow(host, entry.paneId) : false
      const action = inboxAction(entry, { running: Boolean(session), free, read }, now)
      if (action === "wait") continue
      const panes = mailPanes()
      if (action === "ring" && session) {
        entry.rings += 1
        entry.ringAt = now
        void typeLine(session, formatBell(entry, panes.find((pane) => pane.id === entry.from), entry.chars))
        appendLine(entry.paneId, t("note.rang", entry.rings), "note")
      } else {
        inboxPending.splice(inboxPending.indexOf(entry), 1)
        if (action === "warn" && entry.from && running.has(entry.from)) {
          heldLines.push({ paneId: entry.from, text: formatUnread(entry, panes.find((pane) => pane.id === entry.paneId)) })
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
        return raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string") : []
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
      if ((agent !== "claude-code" && agent !== "codex") || !pane.resumeId || !pane.cwd || isRemoteRoot(pane.cwd)) continue
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

  /** Each running pane's hook nonce, and the last turn start or end its hook reported. */
  const paneNonces = new Map<string, string>()
  const activityOf = new Map<string, Activity>()
  const hooked = (paneId: string) => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    return paneNonces.has(paneId) && Boolean(hookTarget(pane?.agent ?? pane?.model ?? "")?.activityEvents?.length)
  }

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

  const SPAWNABLE = AGENTS.filter((agent) => agent.id !== "terminal")

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
    permissionPending: Boolean(permissions()[request.to]),
    lastOutputAt: lastOutputAt.get(request.to),
    activity: activityOf.get(request.to),
    hooked: hooked(request.to),
    waitingOnOthers: [...openRequests.values()].some((other) => other.from === request.to),
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
        const text = await host.readTextFile(entry.path).then((read) => read.text).catch(() => "")
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
   * The turn activity of every running session with hooks, each mail pass.
   *
   * Not only of those that owe an answer: the status in the sidebar and in
   * `ade-msg list` comes from here, and a session is at work whoever started
   * its turn. One small file read per hooked session.
   */
  const readActivities = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>) => {
    if (!host.readAgentActivity) return
    for (const paneId of running.keys()) {
      const nonce = paneNonces.get(paneId)
      if (!nonce || !hooked(paneId)) continue
      const pane = wb().panes.find((candidate) => candidate.id === paneId)
      const read = parseActivity(await host.readAgentActivity(nonce), pane?.resumeId)
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
      const next = pane ? statusFromActivity(pane.status, activity, workingSince.get(paneId)) : undefined
      if (next === "working") {
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
  const settle = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, id: string, result?: string) => {
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
    if (result !== undefined) await host.mailboxResult?.(id, result).catch(() => {})
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
  const unintegrated = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, paneId: string): Promise<string | undefined> => {
    const pane = wb().panes.find((candidate) => candidate.id === paneId)
    if (!pane?.worktree || !host.run) return undefined
    const status = await host.run("git", ["status", "--porcelain"], pane.worktree)
    if (status.code === 0 && status.stdout.trim()) return `"${pane.title}" ha modifiche non committate in ${pane.worktree}`
    const branch = pane.tree?.branch
    const root = (await projectOfPane(host, paneId))?.root
    if (branch && root) {
      const merged = await host.run("git", ["branch", "--list", branch, "--merged"], root)
      if (merged.code === 0 && !merged.stdout.trim()) return `"${pane.title}" ha commit sul branch ${branch} non ancora integrati`
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
  ): Promise<{ closed: string[]; kept: string[] } | { error: string }> => {
    const ids = [...descendants(paneId, spawnedBy), paneId].filter((id) => wb().panes.some((pane) => pane.id === id))
    const blocked = new Map<string, string>()
    for (const id of ids) {
      const reason = await unintegrated(host, id)
      if (reason) blocked.set(id, reason)
    }
    if (blocked.size > 0 && !force) {
      return { error: `non chiudo: ${[...blocked.values()].join("; ")}. Integra o committa prima, oppure usa --force (la worktree resta su disco)` }
    }
    const closed: string[] = []
    const kept: string[] = []
    for (const id of ids) {
      const pane = wb().panes.find((candidate) => candidate.id === id)
      if (!pane) continue
      for (const request of [...openRequests.values()]) {
        if (request.to === id) await settle(host, request.id, `[ade-msg] richiesta ${request.id} interrotta: la sessione "${pane.title}" è stata chiusa`)
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
    return { closed, kept }
  }

  /** Makes sure `.ade/` (where subagents put long results) is ignored by git in this project. */
  const excludeAdeResults = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, root: string) => {
    if (!host.run || !host.readTextFile || !host.writeTextFile) return
    const common = await host.run("git", ["rev-parse", "--git-common-dir"], root)
    if (common.code !== 0) return
    const dir = common.stdout.trim()
    const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(dir) ? dir : `${root}/${dir}`
    const file = `${absolute}/info/exclude`
    const current = await host.readTextFile(file).then((read) => read.text).catch(() => "")
    const next = excludeWithAde(current)
    if (next !== undefined) await host.writeTextFile(file, next).catch(() => null)
  }

  const deliverPending = async () => {
    const host = await getHost()
    if (!host?.mailboxTake || !host.mailboxReceipt) return
    for (const { id, body } of await host.mailboxTake().catch(() => [])) {
      const parsed = parseMessage(body)
      // A pane's token, or a background turn's (voice agent, bot) registered for its length.
      const message = parsed && verifySender(parsed, (paneId) => (running.has(paneId) ? paneTokens.get(paneId) : senderToken(paneId)))
      if (message) mailQueue.push({ id, message, at: Date.now() })
      else await host.mailboxReceipt(id, "errore: messaggio non valido").catch(() => {})
    }

    for (const item of [...heldLines]) {
      const session = running.get(item.paneId)
      if (!session) heldLines.splice(heldLines.indexOf(item), 1)
      else if (await freeNow(host, item.paneId)) {
        heldLines.splice(heldLines.indexOf(item), 1)
        void (item.inbox ? deliverText(host, item.paneId, item.text, item.inbox) : typeLine(session, item.text))
      }
    }

    for (const item of [...mailQueue]) {
      const done = await deliverOne(host, item.id, item.message)
      if (done) mailQueue.splice(mailQueue.indexOf(item), 1)
    }

    await readActivities(host)
    const now = Date.now()
    const panes = mailPanes()
    await watchFolders(host, now)
    await readDecisions(host, now)
    for (const request of [...openRequests.values()]) {
      const state = stateOf(request, now)
      // A request whose answerer is gone will never be answered; the caller is told, not left waiting.
      if (state === "sessione chiusa") {
        const title = wb().panes.find((pane) => pane.id === request.to)?.title ?? request.to
        await settle(host, request.id, `[ade-msg] errore: la sessione "${title}" si è chiusa senza rispondere alla richiesta ${request.id}`)
        continue
      }
      if (state === "forse bloccata" && !request.wedgeWarned) {
        request.wedgeWarned = true
        saveRequests()
        if (request.from && running.has(request.from)) {
          heldLines.push({ paneId: request.from, text: formatWedged(request, panes.find((pane) => pane.id === request.to), now) })
        }
        appendLine(request.to, t("pane.maybeStuck", request.id), "note")
      }
      if (statesWritten.get(request.id) !== state) {
        statesWritten.set(request.id, state)
        /* "in corso" is what every request is; printing it tells the waiter nothing. Empty removes the file. */
        await host.mailboxState?.(request.id, state === "in corso" ? "" : state).catch(() => {})
      }
      const session = running.get(request.to)
      // Typed, and no turn began: the line is sitting in the input box. One more Enter sends it.
      if (session && shouldRering(request, targetOf(request), now)) {
        request.rings = (request.rings ?? 0) + 1
        saveRequests()
        session.write("\r")
        appendLine(request.to, t("note.resentRequest", request.id), "note")
        continue
      }
      // Finished, gone quiet, and never replied: reminded, so the caller is not left to its timeout.
      if (session && shouldNudge(request, targetOf(request), now)) {
        request.nudges = (request.nudges ?? 0) + 1
        request.nudgedAt = now
        saveRequests()
        void typeLine(session, formatNudge(request.id, panes.find((pane) => pane.id === request.from)))
        appendLine(request.to, t("note.nudged", request.id), "note")
      }
    }

    await followInbox(host, now)

    const table = requestsTable([...openRequests.values()], panes, (request) => stateOf(request, now), now, decisions)
    if (table !== publishedRequests) {
      publishedRequests = table
      await host.mailboxPublish?.(table, "requests").catch(() => {})
    }
  }

  /** Delivers one message; false leaves it queued for the next pass. */
  const deliverOne = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, id: string, message: Message): Promise<boolean> => {
    const answer = (text: string) => host.mailboxReceipt!(id, text).catch(() => {})
    const panes = mailPanes()
    const sender = panes.find((pane) => pane.id === message.from)

    if (message.kind === "reply") {
      const request = openRequests.get(message.ref)
      if (request && request.to !== message.from) {
        await answer(`errore: la richiesta ${message.ref} non è stata fatta a questa sessione`)
        return true
      }
      if (!host.mailboxResult) {
        await answer("errore: questa versione di ADE non accetta risposte")
        return true
      }
      await settle(host, message.ref, message.text)
      const caller = request ? panes.find((pane) => pane.id === request.from) : undefined
      if (sender) appendLine(sender.id, (caller ? t("note.replySentTo", caller.title, message.ref) : t("note.replySent", message.ref)), "note")
      if (caller) appendLine(caller.id, t("note.replyFrom", sender?.title ?? t("note.someSession"), message.text), "note")
      await answer(
        `ok: risposta consegnata${caller ? ` a "${caller.title}"` : ""}` +
          (request?.autoClose ? " — se non ha lavoro da integrare questa sessione ora si chiude" : " — la sessione resta aperta per i seguiti"),
      )
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
            const note = "error" in outcome ? t("note.keptOpen", outcome.error) : t("note.closedAfterReply", outcome.closed.join(", "))
            appendLine(request.to, note, "note")
            if (caller) appendLine(caller.id, note, "note")
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
      if (caller) appendLine(caller.id, t("note.updateFrom", sender?.title ?? t("note.someSession"), message.state, message.text), "note")
      await answer(`ok: aggiornamento consegnato${caller ? ` a "${caller.title}"` : ""}; la richiesta resta aperta, aspetta la sua risposta`)
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
      const session = running.get(request.to)
      if (session && !permissions()[request.to]) void typeLine(session, formatCancel(request.id, sender))
      await answer(`ok: richiesta ${request.id} annullata; la sessione resta aperta (chiudila con ade-msg close se non serve più)`)
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
        const text = await host.readTextFile(path).then((read) => read.text).catch(() => undefined)
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
      const current = host.readTextFile ? await host.readTextFile(path).then((read) => read.text).catch(() => "") : ""
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
      appendLine(sender.id, t("note.memory", entry.line.trim()), "note")
      await answer(memoryAddReply(path, next.length))
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
        await answer(`errore: questa sessione è già al livello ${depth - 1} e il massimo è ${maxDepth()}: fai il lavoro qui o chiedi a chi ti ha avviato`)
        return true
      }

      let name: string | undefined
      if (message.name !== undefined) {
        const checked = checkName(message.name)
        if ("error" in checked) {
          await answer(`errore: ${checked.error}`)
          return true
        }
        if (nameTaken(panes.map((pane) => pane.title), checked.name)) {
          await answer(`errore: esiste già una sessione "${checked.name}": scegli un altro nome, o mandale una richiesta con ade-msg ask`)
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
          json = await host.readTextFile!(dispatchPath).then((read) => read.text).catch(() => undefined)
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
      const spawnArgs: string[] = fork ? [...(wb().panes.find((pane) => pane.id === message.from)?.spawnArgs ?? [])] : []
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
          await answer(`errore: worktree non creata (${(added.stderr || added.stdout).trim().split(/\r?\n/)[0] || "git ha rifiutato"})`)
          return true
        }
        worktree = { path: plan.path, branch: plan.branch }
        worktreeBase = base ?? "HEAD del progetto"
        spawnArgs.push(...worktreeArgs(agent.id, plan.path))
      }
      if (root) await excludeAdeResults(host, root)

      const title = name ?? `${agentLabel(agent.id)} ← ${sender?.title ?? "ade-msg"}: ${briefOf(message.text, 48)}`
      const index = (owner ? wb().panes.filter((pane) => pane.workspaceId === owner) : wb().panes).length + 1
      const task = formatRequest(id, message.text, sender, {
        ...(worktree ? { worktree } : {}),
        ...(worktree || root ? { resultsDir: resultsDir(worktree?.path ?? root!) } : {}),
        depth,
        maxDepth: maxDepth(),
      })
      const created = addAgent(
        { agentId: agent.id, count: 1, task, title, workspaceId: owner, ...(worktree ? { worktree } : {}), spawnArgs, ...(fork ? { fork } : {}) },
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
      })
      saveRequests()
      if (message.from) {
        spawnedBy.set(created.id, message.from)
        saveSpawned()
      }
      if (sender) appendLine(sender.id, t("note.subagent", created.title), "note")
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

    const target = resolveTarget(panes, message.to, message.from)
    if ("error" in target) {
      await answer(`errore: ${target.error}`)
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
      appendLine(target.pane.id, t("note.interruptedBy", sender?.title ?? t("note.someSession")), "note")
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
            await settle(host, request.id, `[ade-msg] richiesta ${request.id} interrotta: la sessione "${pane.title}" è stata riavviata da zero`)
          }
        }
        void startProcess(pane.id, agentId, "")
      } else {
        const updated = wb().panes.find((candidate) => candidate.id === pane.id)
        if (updated) void reopen(updated)
      }
      appendLine(pane.id, t(message.fresh ? "note.restartedFresh" : "note.restarted", sender?.title ?? t("note.someSession"), message.model ?? ""), "note")
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
          (message.fresh ? " da zero con la tua nota: se serve il compito intero mandalo con ade-msg ask" : " con la tua nota; riprende la sua conversazione e le richieste aperte restano valide"),
      )
      return true
    }

    if (message.kind === "close") {
      if (!message.from || spawnedBy.get(target.pane.id) !== message.from) {
        await answer(`errore: puoi chiudere solo le sessioni avviate da questa sessione con spawn ("${target.pane.title}" non lo è)`)
        return true
      }
      const outcome = await closeTree(host, target.pane.id, message.force)
      if ("error" in outcome) {
        await answer(`errore: ${outcome.error}`)
        return true
      }
      await answer(
        `ok: chiuse ${outcome.closed.map((title) => `"${title}"`).join(", ")}` +
          (outcome.kept.length ? `; worktree lasciate su disco: ${outcome.kept.join(", ")}` : ""),
      )
      return true
    }

    if (message.kind === "ask" && message.effort) {
      await answer("errore: l'effort di una sessione aperta non si cambia con ask: usa spawn --effort, oppure relaunch --effort --note")
      return true
    }
    if (message.kind === "ask" && target.pane.id === message.from) {
      await answer("errore: una sessione non può fare una richiesta a se stessa")
      return true
    }
    const session = running.get(target.pane.id)
    if (!session) {
      // Its sender stopped reading receipts when it was held: an ask is answered where the caller waits.
      if (held.delete(id)) {
        if (message.kind === "ask") await settle(host, id, `[ade-msg] errore: la sessione "${target.pane.title}" si è chiusa prima di ricevere la richiesta ${id}`)
        return true
      }
      await answer(`errore: la sessione "${target.pane.title}" non è attiva`)
      return true
    }
    // A standing permission prompt reads the next Enter as its answer: the message waits for it to go.
    if (permissions()[target.pane.id]) return false

    /*
     * In the background: a note or a request waits for the recipient's turn
     * to end instead of landing in the middle of its work (see `isFree`). The
     * sender is told at once, so it neither resends nor stops waiting.
     */
    if (!(await freeNow(host, target.pane.id))) {
      if (!held.has(id)) {
        held.add(id)
        await answer(`ok: in coda, arriva a "${target.pane.title}" quando finisce il turno`)
      }
      return false
    }

    const targetPane = wb().panes.find((pane) => pane.id === target.pane.id)
    const targetDepth = depthOf(target.pane.id, parentOf)
    const line =
      message.kind === "ask"
        ? formatRequest(id, message.text, sender, {
            ...(targetPane?.cwd ? { resultsDir: resultsDir(targetPane.cwd) } : {}),
            depth: targetDepth,
            maxDepth: maxDepth(),
          })
        : formatDelivery(message, sender)
    if (!(await deliverText(host, target.pane.id, line, { id, kind: message.kind === "ask" ? "ask" : "send", from: message.from }))) {
      await answer(`errore: la sessione "${target.pane.title}" si è chiusa durante la consegna`)
      return true
    }
    // The caller has spoken to a session that said it was blocked on it: that is the answer it was waiting for.
    for (const request of openRequests.values()) {
      if (request.update && request.from === message.from && request.to === target.pane.id) {
        delete request.update
        saveRequests()
      }
    }
    if (message.kind === "ask") {
      const at = Date.now()
      openRequests.set(id, { id, kind: "ask", from: message.from, to: target.pane.id, at, deliveredAt: at, brief: briefOf(message.text) })
      saveRequests()
    }
    const ask = message.kind === "ask"
    appendLine(target.pane.id, t(ask ? "note.askFrom" : "note.messageFrom", sender?.title ?? t("note.someSession"), message.text), "note")
    if (sender) appendLine(sender.id, t(ask ? "note.askTo" : "note.messageTo", target.pane.title, message.text), "note")
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
      onUpdate: (update) =>
        setNotices((list) =>
          addNotice(list, {
            kind: "info",
            text: t("update.available", update.version),
            href: update.url,
            at: Date.now(),
          }),
        ),
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
      setNotices((list) =>
        addNotice(list, { kind: "info", text: t("update.desktopOnly"), at: Date.now() }),
      )
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
      if (result.status === "update" && result.update && notices().some((notice) => notice.href === result.update?.url)) {
        setNotices((list) =>
          addNotice(list, { kind: "info", text: t("update.alreadyShown", result.update?.version ?? ""), at: Date.now() }),
        )
        return
      }
      const message = checkMessage(result)
      setNotices((list) =>
        addNotice(list, { kind: message.kind, text: message.text, ...(message.href ? { href: message.href } : {}), at: Date.now() }),
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
  const installUpdate = async (href: string) => {
    if (updating()) return
    const running = wb().panes.filter(
      (pane) =>
        !isPanelPane(pane) && (pane.agent ?? pane.model) &&
        pane.status !== "done" && pane.status !== "error",
    ).length
    if (running > 0) {
      const { ask } = await import("@tauri-apps/plugin-dialog")
      const go = await ask(
        t("update.restart", running),
        { title: t("update.restart.title"), kind: "warning", okLabel: t("update.restart.ok"), cancelLabel: t("update.restart.later") },
      )
      if (!go) return
    }
    setUpdating(true)
    autosave.flush()
    // localStorage reaches WebView2's disk store a moment after setItem.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("ade_update_install")
    } catch (error) {
      setUpdating(false)
      report(t("update.installFailed", String(error)))
      await openNoticeLink(href)
    }
  }

  onMount(() => {
    /*
     * Mail has to keep moving while ADE is minimised — agents message each
     * other whether or not anyone is watching — but a hidden window can wait
     * longer, and with no session running a pass every three seconds is
     * plenty for a request arriving from outside.
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
        { whenHidden: 2_000 },
      ),
    )
    // Usage only feeds what is on screen and `ade-msg stats`: paused while hidden.
    onCleanup(every(15_000, () => refreshUsage()))
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
  const voiceAvailable =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia
  const rawSavedVoice = typeof localStorage !== "undefined" ? localStorage.getItem("voice.settings") : null
  const initialVoice = loadVoiceSettings()
  const [voiceSettings, setVoiceSettings] = createSignal<VoiceSettings>(initialVoice.settings)
  const [voiceSettingsOpen, setVoiceSettingsOpen] = createSignal(false)

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
  const shadowedVoiceChords = summarizeVoiceShortcutConflicts(
    initialVoice.settings,
    bindings,
    platform
  )
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
  const movedToName = initialVoice.migrations.some((m) => m === "name-only" || m === "wake-word" || m === "always-listen")
  const agentShortcut = describeShortcut(initialVoice.settings.agentChord, platform)
  const [voiceSettingsNotice, setVoiceSettingsNotice] = createSignal<string | undefined>(
    wakeWordEnabled() && !shortcutActivationEnabled() && movedToName
      ? t("voice.nameOnly", agentShortcut, t("vui.listen.manual"))
      : movedToShortcut
        ? t("voice.shortcutOnly", agentShortcut)
        : wakeWordEnabled() && (migratedToWakeWord || migratedToAlwaysListen)
          ? t("voice.alwaysListening", initialVoice.settings.wakeWord, t("vui.listen.manual"), t("vui.activation.toggle"))
          : undefined,
  )

  const [voiceNotice, setVoiceNotice] = createSignal<string | undefined>(
    [
      initialVoice.corrections.filter((c) => !c.includes("assenti")).length > 0
        ? initialVoice.corrections.filter((c) => !c.includes("assenti")).join(" ")
        : rawSavedVoice !== null && initialVoice.corrections.length > 0
          ? initialVoice.corrections.join(" ")
          : undefined,
      shadowedVoiceChords,
    ]
      .filter((line): line is string => line !== undefined)
      .join(" ") || undefined
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
    getRunningSession: (id) => running.get(id),
    openFile: (path) => openFile(path),
    appendLine: (id, text, kind) => appendLine(id, text, kind),
    permissions,
    answerPermission: (id, ans) => answerPermission(id, ans),
    getHost,
    recents,
    agentAvailability: () => agentStatuses(),
    switchProject: (root) => switchProjectTo(root),
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
      ? createWebSpeechSpeaker({ lang: "it-IT" })
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
  /*
   * S15: replies in Piper's voice where the desktop host has it, with the
   * system voice underneath while it downloads or when it fails. The host is
   * looked up per call, so the browser harness simply never gets past status.
   */
  const naturalSpeaker = createNaturalSpeaker({
    voice: () => voiceSettings().replyVoice,
    status: async (voice) => {
      const host = await getHost()
      return host?.ttsPiperStatus ? host.ttsPiperStatus(voice) : { supported: false, installed: false }
    },
    install: async (voice) => {
      const host = await getHost()
      if (!host?.ttsPiperInstall) throw new Error(t("voice.noHost.download"))
      await host.ttsPiperInstall(voice)
    },
    synthesize: async (voice, text) => {
      const host = await getHost()
      if (!host?.ttsPiperSpeak) throw new Error(t("voice.noHost"))
      return host.ttsPiperSpeak(voice, text)
    },
    play: (wav, signal) => {
      // A take keeps the assistant's voice as its own track (S36).
      recorder.noteVoice(wav)
      return playWav(wav, signal, voiceSettings().outputDeviceId, playbackMeter)
    },
    fallback: systemSpeaker,
    onInstall: (voice, state, problem) => {
      if (state === "failed") console.warn(`ADE: voce ${voice} non scaricata: ${problem ?? ""}`)
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
    ...(voiceAvailable ? {} : { transcriber: noMicrophone }),
    speaker,
    micMeter,
    now: () => Date.now(),
    getContext: () => ({
      focusedPaneId: wb().focusedId,
    }),
  })

  // S15: the moment the microphone wakes, load the reply voice so the first answer is not the slow one.
  createEffect(
    on(
      () => voiceEngine.isRunning(),
      (running) => {
        if (running && voiceSettings().speakReplies !== false) speaker.prepare()
      },
      { defer: true },
    ),
  )

  /* Set once the native shell has registered the voice hotkeys; see onMount. */
  let registerGlobalShortcuts: ((settings: VoiceSettings) => Promise<void>) | undefined

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
    (s.backend === "parakeet" || Boolean(s.openRouterApiKey))
  const listenForName = () => {
    if (!voiceEngine.isRunning()) void voiceEngine.start("agent", { waitForName: true })
  }

  const handleVoiceSettingsChange = async (next: VoiceSettings) => {
    // Once they have been in here and changed something, the note is spent —
    // and the profile was written back on the way in, so it does not return.
    setVoiceSettingsNotice(undefined)
    const before = listensByItself(voiceSettings())
    const saved = saveVoiceSettings(next)
    setVoiceSettings(saved.settings)
    await voiceEngine.updateSettings(saved.settings)
    await registerGlobalShortcuts?.(saved.settings)
    const after = listensByItself(saved.settings)
    // The switch is the switch: on opens the microphone, off closes it.
    if (after && !before) listenForName()
    else if (before && !after && voiceEngine.isRunning()) void voiceEngine.stop()
  }

  onMount(() => {
    if (listensByItself(voiceSettings())) listenForName()
    /* Paused only while the PC is locked or asleep; see `voice/listen-guard.ts`. */
    const guard = createListenGuard({
      now: () => Date.now(),
      isLocked: async () => {
        // Set from a test driving the page, in a dev build only: a lock cannot be
        // staged on the user's PC, and a release must not read it.
        const staged = import.meta.env.DEV
          ? (window as unknown as { __adeSessionLockedForTest?: unknown }).__adeSessionLockedForTest
          : undefined
        if (typeof staged === "boolean") return staged
        if (!isTauriDesktop()) return false
        const { invoke } = await import("@tauri-apps/api/core")
        return (await invoke("session_locked")) === true
      },
      shouldListen: () => listensByItself(voiceSettings()),
      isListening: () => voiceEngine.isRunning(),
      isPaused: () => voiceEngine.listenPaused(),
      pause: () => voiceEngine.pauseListening(),
      resume: () => voiceEngine.start("agent", { waitForName: true }),
      restart: async () => {
        await voiceEngine.stop()
        await voiceEngine.start("agent", { waitForName: true })
      },
    })
    let ticking = false
    const timer = setInterval(() => {
      if (ticking) return
      ticking = true
      void guard.tick().finally(() => (ticking = false))
    }, LOCK_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

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
    internal: ({ status, registry }) => [createManagerPlugin(status, registry)],
    async trust(root, plugins) {
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
          list: () => wb().panes.filter((pane) => !isPanelPane(pane)).map(toPluginSession),
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
            workspaceId: project()?.name ?? "workspace",
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
      }
    }

    // Discover project
    if (host) {
      setBooting(t("boot.project"))
      const path = restored?.projectPath || (host.currentDir ? await host.currentDir() : "")
      const p = await discoverProject(host, path)
      setProject(p)

      const newRecents = addRecent(recents(), { root: p.root, name: p.name })
      setRecents(newRecents)
      localStorage.setItem("ade.recents", serializeRecents(newRecents))

      setWb(w => ({ ...w, projectPath: p.root }))

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
          sessionsToResume(restored).map(async (pane) => ({
            agentId: pane.agent,
            cwd: pane.cwd || p.root,
            ...(pane.resumeId !== undefined ? { resumeId: pane.resumeId } : {}),
            missing: await conversationMissing(pane.agent, pane.resumeId, pane.cwd || p.root),
            pane,
          })),
        )
        for (const { session, plan } of planRestore(sessions)) {
          void startProcess(session.pane.id, session.pane.agent, session.pane.task ?? "", plan)
        }

        /*
         * And the sessions whose agent had already exited, too.
         *
         * They used to wait for a click on "Riprendi", and nobody opens ADE to
         * look at a dead transcript: the pane is there to be used. `reopen`
         * asks for the conversation by id when there is one, and starts the
         * agent fresh when there is not.
         */
        const planned = new Set(sessions.map((session) => session.pane.id))
        for (const pane of wb().panes) {
          if (planned.has(pane.id)) continue
          if (isPanelPane(pane)) continue
          if (!(pane.agent ?? pane.model)) continue
          void reopen(pane)
        }
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
    const remaining = SPLASH_FLOOR_MS - (Date.now() - startedAt)
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
      if (isTerminal && resolution.type === "ade") return

      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
      if (isInput && !e.ctrlKey && !e.metaKey && !e.altKey) return

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

    /*
     * Closing the window is the one way out of ADE that `close` cannot guard.
     * A modified buffer lives only in memory, so quitting with one open loses
     * it as completely as closing its pane would.
     */
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const unsaved = Object.values(buffers()).filter((buffer) => buffer.dirty)
      if (unsaved.length === 0) return
      event.preventDefault()
      // Browsers ignore the text and show their own, but setting returnValue
      // is still what makes the prompt appear at all.
      event.returnValue = ""
    }

    window.addEventListener("keydown", handleKeyDown, true)
    window.addEventListener("keyup", handleKeyUp, true)
    window.addEventListener("blur", handleBlur)
    window.addEventListener("beforeunload", handleBeforeUnload)
    // Auto-sync OpenRouter API key from nikcli auth.json if not present in localStorage
    if (!voiceSettings().openRouterApiKey) {
      void (async () => {
        try {
          const host = await getHost()
          const home = await host?.homeDir?.()
          if (home) {
            const normalizedHome = home.replace(/\\/g, "/")
            const candidatePaths = [
              `${normalizedHome}/AppData/Local/nikcli/auth.json`,
              `${home}/AppData/Local/nikcli/auth.json`,
              `${home}\\AppData\\Local\\nikcli\\auth.json`,
              `${normalizedHome}/AppData/Roaming/nikcli/auth.json`,
              `${home}/AppData/Roaming/nikcli/auth.json`,
              `${home}\\AppData\\Roaming\\nikcli\\auth.json`,
              `${normalizedHome}/.config/nikcli/auth.json`,
              `${normalizedHome}/.nikcli/auth.json`,
            ]
            for (const authPath of candidatePaths) {
              try {
                const file = await host?.readTextFile?.(authPath, 64 * 1024)
                if (file?.text) {
                  const parsed = JSON.parse(file.text)
                  const orKey = parsed?.openrouter?.key
                  if (typeof orKey === "string" && orKey.trim().length > 0) {
                    await handleVoiceSettingsChange({
                      ...voiceSettings(),
                      openRouterApiKey: orKey.trim(),
                    })
                    break
                  }
                }
              } catch {
                // check next path
              }
            }
          }
        } catch {
          // ignore
        }
      })()
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
           */
          const syncGlobalShortcuts = async (settings: VoiceSettings) => {
            await registerVoiceShortcuts(settings, {
              unregisterAll: () => invoke("unregister_global_voice_shortcuts") as Promise<void>,
              register: (chord) => invoke("register_global_voice_shortcut", { chord }) as Promise<void>,
              report: (message) => report(message, "warning"),
            })
          }

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
      window.removeEventListener("keydown", handleKeyDown, true)
      window.removeEventListener("keyup", handleKeyUp, true)
      window.removeEventListener("blur", handleBlur)
      window.removeEventListener("beforeunload", handleBeforeUnload)
    })
  })

  // Commands
  const runCommand = async (id: string) => {
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
          setWb(w => ({ ...w, projectPath: p.root, expandedId: undefined }))
          const newRecents = addRecent(recents(), { root: p.root, name: p.name })
          setRecents(newRecents)
          localStorage.setItem("ade.recents", serializeRecents(newRecents))
        }
      }
    } else if (id === "pane.close") {
      if (wb().focusedId) close(wb().focusedId!)
    } else if (id === "pane.expand") {
      if (wb().focusedId) setWb(w => expandPane(w, w.focusedId!))
    } else if (id === "pane.rename") {
      // Handled by the pane itself: the title is edited where it is shown.
      requestRename(wb().focusedId)
    } else if (id === "view.toggle") {
      setWb(w => ({ ...w, view: nextView(w.view) }))
    } else if (id.startsWith("view.")) {
      // Matched against the list rather than parsed off the id, so a command
      // called "view.anything" cannot put the workbench in a view that has no
      // branch to render it.
      // Only a section the bar shows: a hidden one has no command to run (S40).
      const target = VISIBLE_VIEWS.find((view) => `view.${view}` === id)
      if (target) setWb(w => ({ ...w, view: target }))
    } else if (id === "theme.set.light" || id === "theme.set.dark") {
      themeState.set(id === "theme.set.light" ? "light" : "dark")
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
      setWb(w => addPane(w, {
        id: `v${Date.now()}`,
        title: t("pane.video.title"),
        status: "working",
        model: "—",
        mode: "video",
        videoPath: "",
        workspaceId: project()?.name ?? "workspace",
        lines: []
      }))
    } else if (id === "update.check") {
      void checkForUpdates()
    } else if (id === "decisions.open") {
      setDecisionsOpen(true)
    } else if (id === "decisions.pane") {
      openDecisionsPane()
    } else if (id === "model.new") {
      // Opened empty, like the video panel; a model file clicked in the tree opens it directly.
      openModel("")
    } else if (id === "app.new") {
      /*
       * Opened empty: the panel lists the dev servers the project's config
       * points at, and guessing one to load would load the wrong app half
       * the time — or ADE's own Vite server.
       */
      setWb(w => addPane(w, {
        id: `a${Date.now()}`,
        title: "Simulatore",
        status: "working",
        model: "—",
        mode: "app",
        appUrl: "",
        workspaceId: project()?.name ?? "workspace",
        lines: []
      }))
    } else if (id === "browser.new") {
      const newId = `b${Date.now()}`
      setWb(w => addPane(w, {
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
        workspaceId: project()?.name ?? "workspace",
        lines: []
      }))
    } else if (id === "process.kill") {
      if (wb().focusedId && isRunning(wb().focusedId!)) {
        running.get(wb().focusedId!)?.kill()
        running.delete(wb().focusedId!)
        touchRunning()
        setWb(w => updatePane(w, w.focusedId!, { status: "error", activity: "killed", lines: [...(w.panes.find(p=>p.id===w.focusedId)?.lines||[]), {kind:"note", text:t("pane.killed")}] }))
      }
    } else if (id === "voice.toggle") {
      void voiceEngine.toggle()
    } else if (id === "record.toggle") {
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
    } else if (id.startsWith("project.recent.")) {
      const root = id.slice("project.recent.".length)
      const host = await getHost()
      if (host) {
        const p = await discoverProject(host, root)
        setProject(p)
        setWb(w => ({ ...w, projectPath: p.root, expandedId: undefined }))
        const newRecents = addRecent(recents(), { root: p.root, name: p.name })
        setRecents(newRecents)
        localStorage.setItem("ade.recents", serializeRecents(newRecents))
      }
    }
    // Moving focus between panes is not handled here: the grid measures its own
    // columns, so `SessionGrid` owns the arrow keys and answers with the real
    // geometry rather than a guess made from the window size.
    setPaletteOpen(false)
  }

  const allCommands = createMemo(() => {
    // Reading the tick is what makes "uccidi processo" enable itself the moment
    // a process starts, and disable itself when it dies.
    runningTick()
    return buildCommands({
      workbench: wb(),
      recents: recents(),
      hasHost: hasHost(),
      running: new Set(running.keys()),
      platform,
      voiceAvailable,
      voiceActive: voiceEngine.isRunning(),
      voiceChord: voiceSettings().agentChord,
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
    quietTimers.set(paneId, setTimeout(() => {
      quietTimers.delete(paneId)
      if (wb().panes.find((pane) => pane.id === paneId)?.status !== "working") return
      // Without turn hooks, a session that owes an answer is working until it answers (S14).
      const outcome = quietOutcome({
        hooked: hooked(paneId),
        busy: activityOf.get(paneId)?.state === "busy",
        owesAnswer: holdsForAnswer([...openRequests.values()], paneId, Date.now()),
      })
      // The hold has to be re-armed: it ends with time passing, and nothing
      // else would come back to look at a pane whose terminal has gone quiet.
      if (outcome === "recheck") return settleWhenQuiet(paneId)
      if (outcome === "wait") return
      setWb((w) => updatePane(w, paneId, { status: "idle", activity: "ready" }))
    }, QUIET_MS))
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

    writeToTerminal(paneId, chunk)
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
    // Per-pane bookkeeping kept in plain maps, which nothing else clears: a
    // long day of opening and closing sessions used to keep every one of them.
    lastOutputAt.delete(id)
    usageOf.delete(id)
    paneTokens.delete(id)
    paneNonces.delete(id)
    activityOf.delete(id)
    bracketedPaste.delete(id)
  }

  const close = (id: string) => {
    /*
     * An unsaved file is not closed without asking.
     *
     * The buffer model has always known whether there is anything to lose;
     * nothing asked it. Closing a file pane — by the X, by Ctrl+W, or by the
     * command — dropped the draft with no warning and no way back.
     */
    const buffer = buffers()[id]
    if (buffer?.dirty) {
      const discard = confirm(
        t("editor.closeDirty", buffer.path),
      )
      if (!discard) return
    }

    running.get(id)?.kill()
    running.delete(id)
    touchRunning()
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
    setWb(w => closePane(w, id))
  }

  const finish = (id: string, code: number | null) => {
    running.delete(id)
    touchRunning()
    forgetQuiet(id)
    setWb(w => updatePane(w, id, {
      status: code === 0 ? "done" : "error",
      activity: code === 0 ? "done" : exitedActivity(code)
    }))
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
  const openFile = async (path: string) => {
    setSelectedFile(path)

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
      setWb((w) => ({ ...w, focusedId: existing.id }))
      return
    }

    const host = await getHost()
    if (!host?.readTextFile) return

    const id = `f${Date.now()}`
    setWb((w) =>
      addPane(w, {
        id,
        title: path.split(/[\\/]/).pop() ?? path,
        status: "done",
        model: "—",
        mode: "file",
        filePath: path,
        lines: [],
        workspaceId: project()?.name ?? "workspace",
      }),
    )

    bufferLoading.set(id, true)
    try {
      const read = await host.readTextFile(path)
      buffers.set(id, openBuffer({ path, text: read.text, truncated: read.truncated }))
    } catch (error) {
      appendLine(id, error instanceof Error ? error.message : String(error))
    } finally {
      bufferLoading.set(id, false)
    }
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
        const anyway = confirm(
          t("editor.saveUnreadable", buffer.path, String(unreadable)),
        )
        if (!anyway) {
          report(t("editor.saveCancelled.unreadable", String(unreadable)), "warning")
          return
        }
      } else if (onDisk && !onDisk.truncated && onDisk.text !== buffer.saved) {
        const overwrite = confirm(
          t("editor.saveChanged", buffer.path),
        )
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

  const appendLine = (id: string, text: string, kind: "step" | "shell" | "note" = "note") => {
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
      if (!isResolved(pending, recent, agent)) return
      permissions.forget(paneId)
      // The agent moved on by itself, so the pane is working again.
      setWb((w) => updatePane(w, paneId, { status: "working", activity: "running" }))
      return
    }

    const request = detectPermission(recent, agent)
    if (!request) return

    permissions.set(paneId, request)
    setWb((w) => updatePane(w, paneId, { status: "waiting", activity: "permission" }))
    if (voiceEngine.isRunning()) {
      void voiceEngine.handlePermissionRequest(paneId, request.what)
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
    return path ? !(await host.exists(path)) : false
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
  const reopen = async (pane: Pane, line?: string) => {
    const agentId = pane.agent ?? pane.model
    if (running.has(pane.id)) return
    const missing = await conversationMissing(agentId, pane.resumeId, pane.cwd)
    const plan = planResume({
      agentId,
      ...(pane.resumeId ? { resumeId: pane.resumeId } : {}),
      // "The most recent one here" only when this is the one pane of that
      // agent: with two, the latest thread is as likely the other's.
      lastTaken: wb().panes.some((other) => other.id !== pane.id && (other.agent ?? other.model) === agentId),
      missing,
    })
    const text = line?.trim() ? line : plan.kind === "fresh" ? (pane.task ?? "") : ""
    await startProcess(pane.id, agentId, text, plan, undefined, Boolean(line?.trim()))
  }

  /**
   * The project a pane's process runs in: its own, not whichever is open.
   *
   * Panes of every project stay in the workbench and keep talking to each
   * other, so a session of a project that is not on screen — restarted, or
   * spawned by one of its agents — has to start in its own root. Found by
   * name among the known projects; the open one when the pane's is unknown.
   */
  const projectOfPane = async (host: NonNullable<Awaited<ReturnType<typeof getHost>>>, paneId: string): Promise<Project | undefined> => {
    const open = project()
    const owner = wb().panes.find((pane) => pane.id === paneId)?.workspaceId
    if (!owner || owner === open?.name) return open
    const entry = recents().find((candidate) => candidate.name === owner)
    if (!entry) return open
    return discoverProject(host, entry.root).catch(() => open)
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
    const host = await getHost()
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
    const resumed = resume?.kind === "resume"
    const opening = resume?.kind === "resume" ? { args: resume.args } : planStart(agentId, resume?.resumeId)
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
    const extraArgs = [...introArgs(agentId), ...(launched?.spawnArgs ?? []), ...opening.args, ...(extra ?? [])]
    const mintedId = "resumeId" in opening ? opening.resumeId : undefined

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
    const linked = hookStates()[agentId]?.installed ?? false
    const nonce = linked ? newNonce() : undefined
    // Kept per pane so turn activity can be read for as long as this spawn lives.
    if (nonce) paneNonces.set(paneId, nonce)
    else paneNonces.delete(paneId)
    activityOf.delete(paneId)
    bracketedPaste.delete(paneId)
    let spawned: SpawnedSession | undefined

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
    try {
      const hasTask = Boolean(task.trim())
      setWb(w => updatePane(w, paneId, {
        cwd: workDir,
        tree: launched?.worktree && launched.tree
          ? launched.tree
          : p.branch ? { branch: p.branch, fidelity: "project" } : undefined,
        status: hasTask ? "working" : "idle",
        activity: resumed ? "resumed" : (hasTask ? "running" : "ready"),
        // A fresh start drops an id whose conversation is gone, so the pane
        // stops promising to reopen it.
        ...(mintedId ? { resumeId: mintedId } : resume?.kind === "fresh" ? { resumeId: undefined } : {}),
      }))

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
          if (assigned.length > 0) appendLine(paneId, t("keys.passed", assigned.map((key) => key.env).join(", ")), "note")
        } catch (failure) {
          appendLine(paneId, t("keys.unread", failure instanceof Error ? failure.message : String(failure)), "note")
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
      const session = await host.spawn({
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
          void handlePanelRequest(paneId, line)
          noticeDevServer(paneId, line)
        },
        /*
         * Only this spawn's exit ends the pane. A relaunch kills the old process
         * and starts the new one at once, and the old one's exit arriving later
         * must not mark the new session finished.
         */
        onExit: (code) => {
          if (!running.has(paneId) || running.get(paneId) === spawned) finish(paneId, code)
        },
        ...(nonce ? { link: { pane: paneId, nonce } } : {}),
        pane: paneId,
        paneToken: mintPaneToken(paneId),
        ...(secretNames.length > 0 ? { secrets: secretNames } : {}),
      })

      spawned = session
      running.set(paneId, session)
      touchRunning()

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
            ? latest.read((await readText(latest.path(home), 1_000_000).catch(() => undefined))?.text ?? "", p.root)
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
        void followReports({
          pane: paneId,
          nonce,
          read: (n) => host.readAgentLink?.(n) ?? Promise.resolve(null),
          clear: async (n) => {
            await host.clearAgentLink?.(n)
          },
          cancelled: () => running.get(paneId) !== session,
          onReport: (report) => {
            if (running.get(paneId) !== session) return
            setWb((w) => updatePane(w, paneId, { resumeId: report.sessionId }))
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
      if (task.trim() && (!resumed || typeIntoResumed)) {
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
            permissionPending: Boolean(permissions()[paneId]),
          })
          if (decision === "wait") return

          stopOpeningPoll(poll)
          if (decision === "send") {
            setWb(w => updatePane(w, paneId, {
              status: "working",
              activity: "running",
            }))
            // Opening tasks only — a line the user typed later is theirs alone.
            // Text and Enter apart, for the reason `typeLine` gives.
            const session = running.get(paneId)
            const opening = typeIntoResumed ? task : withIntro(agentId, task)
            // A task from `ade-msg spawn` is a request like any other: too long to type, it goes to the inbox.
            const spawned = [...openRequests.values()].find((request) => request.kind === "spawn" && request.to === paneId)
            if (session && spawned) {
              void getHost().then((host) =>
                host ? deliverText(host, paneId, opening, { id: spawned.id, kind: "spawn", from: spawned.from }) : typeLine(session, opening),
              )
            } else if (session) void typeLine(session, opening)
            return
          }
          /*
           * Said, not swallowed. An opening task that was never delivered is
           * the user's sentence going missing; they need to know it is still
           * theirs to send, and the terminal is where they are looking.
           */
          setWb(w => updatePane(w, paneId, {
            status: "idle",
            activity: "ready",
          }))
          noteInTerminal(
            paneId,
            t("task.notSent"),
          )
          appendLine(paneId, t("task.notSent.short"), "note")
        }, 100)
        openingPolls.add(poll)
      }

    } catch (e) {
      appendLine(paneId, String(e))
      setWb(w => updatePane(w, paneId, { status: "error", activity: "startFailed" }))
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
    try {
      startOnCleanScreen(paneId)
      const session = await host.spawn({
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
          if (!running.has(paneId) || running.get(paneId) === spawned) finish(paneId, code)
        },
        pane: paneId,
        paneToken: mintPaneToken(paneId),
      })
      spawned = session
      running.set(paneId, session)
      touchRunning()

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
        const lastLine = tail.split(/\r?\n|\r/).filter((line) => line.trim()).pop() ?? ""
        const decision = decideOpening({
          startedAt: stepStart,
          firstByteAt: stepFirst,
          lastByteAt: stepFirst === undefined ? undefined : last,
          now: Date.now(),
          permissionPending: sshAsking(lastLine) || Boolean(permissions()[paneId]),
          // The first step waits out a password typed by hand.
          ...(index === 0 ? { timeoutMs: 180_000 } : {}),
        })
        if (decision === "wait") return
        if (decision === "abandon") {
          stopOpeningPoll(poll)
          noteInTerminal(paneId, t("task.stepNotSent", String(steps[index])))
          setWb((w) => updatePane(w, paneId, { status: "idle", activity: "ready" }))
          return
        }
        const text = steps[index]!
        index += 1
        void typeLine(session, text)
        setWb((w) => updatePane(w, paneId, { activity: index < steps.length || !task.trim() ? "connected" : "running" }))
        if (index >= steps.length) {
          stopOpeningPoll(poll)
          return
        }
        stepStart = Date.now()
        stepFirst = undefined
      }, 150)
      openingPolls.add(poll)
    } catch (e) {
      appendLine(paneId, String(e))
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
    if (!wb().panes.some((pane) => pane.workspaceId === opened.name)) {
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
    const currentProj = input.workspaceId && input.workspaceId !== open?.name ? undefined : open
    setWb(w => addPane(w, {
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
      cwd: input.worktree?.path ?? currentProj?.root,
      tree: input.worktree
        ? { branch: input.worktree.branch, fidelity: "full", note: `Worktree ${input.worktree.path}` }
        : currentProj?.branch ? { branch: currentProj.branch, fidelity: "project" } : undefined,
      ...(input.worktree ? { worktree: input.worktree.path } : {}),
      ...(input.spawnArgs?.length ? { spawnArgs: input.spawnArgs } : {}),
      ...(input.fork?.resumeId ? { resumeId: input.fork.resumeId } : {}),
    }))
    setStarting(false)
    // A fork opens as a resumed conversation, and the task is typed into it all the same.
    if (input.fork) void startProcess(id, entry.agentId, task, { kind: "resume", via: "id", args: input.fork.args }, undefined, true)
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
    const owner = project()?.name
    const mine = owner ? wb().panes.filter((p) => p.workspaceId === owner) : wb().panes
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
    const owner = project()?.name
    const mine = owner ? wb().panes.filter((p) => p.workspaceId === owner) : wb().panes
    const id = `n${Date.now()}-bot-${++paneSequence}`

    setWb((w) => addPane(w, {
      id,
      title: bot.identifier,
      status: "idle",
      activity: "ready",
      model: bot.model ?? launch.command,
      agent: launch.agentId,
      mode: "bot",
      task: "",
      lines: [{ kind: "note", text: `${launch.command} ${launch.args.join(" ")}` }],
      workspaceId: owner || "workspace",
    }))
    /* Narrowed to nothing, or the grid keeps showing whichever session was
       expanded and the one just started is off screen. */
    setWb((w) => ({ ...w, view: "code", focusedId: id, expandedId: undefined }))
    setStarting(false)
    void startProcess(id, launch.agentId, "", undefined, launch.args)
    return { id, index: mine.length + 1 }
  }

  /*
   * A runner's own sign-in, in a pane of its own: the browser flow and the
   * code to paste are the CLI's, and a terminal is where it expects them.
   */
  const openLoginSession = (runner: Runner) => {
    const agentId = runner.id === "claude" ? "claude-code" : runner.id
    if (!agentById(agentId) || runner.login.length === 0) return
    const owner = project()?.name
    const id = `n${Date.now()}-login-${++paneSequence}`
    setWb((w) => addPane(w, {
      id,
      title: `${runner.label} · accesso`,
      status: "idle",
      activity: "ready",
      model: runner.command,
      agent: agentId,
      mode: "bot",
      task: "",
      lines: [{ kind: "note", text: `${runner.command} ${runner.login.join(" ")}` }],
      workspaceId: owner || "workspace",
    }))
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
        id: `b${Date.now()}`,
        title: "Guida MCP",
        status: "working",
        model: "—",
        mode: "browser",
        browserUrl: url,
        workspaceId: project()?.name ?? "workspace",
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
    close,
    saveFile: (id) => void saveFile(id),
    answerPermission,
    restart: (pane, line) => void reopen(pane, line),
    pickVideo,
    pickModel,
    readBytes: (path, maxBytes) =>
      getHost().then((host) => {
        if (!host?.readBytes) throw new Error("questo host non può leggere file binari")
        return host.readBytes(path, maxBytes)
      }),
    readDir: (path) =>
      getHost().then((host) => (host?.readDir ? host.readDir(path) : [])),
    captureFrame,
    guessServers,
    decisions: decisionsHub,
    panels,
    announceToAll,
    pluginRuntime,
    browserControllers,
    sendBrowserRequest,
  })

  const paletteChord = createMemo(() => {
    const entry = DEFAULT_BINDINGS.find((binding) => binding.commandId === "palette.open")
    return entry ? formatChord(parseChord(entry.chord, platform), platform) : ""
  })

  /*
   * How much of the window the sidebar takes, so the bar's middle group can
   * centre on the sessions rather than on the whole window. Measured, not read
   * from state: the sidebar owns its width while it is being dragged.
   */
  const [sidebarPx, setSidebarPx] = createSignal(0)
  onMount(() => {
    const sidebar = document.querySelector<HTMLElement>('[data-component="ade-sidebar"]')
    if (!sidebar || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setSidebarPx(sidebar.getBoundingClientRect().width))
    observer.observe(sidebar)
    onCleanup(() => observer.disconnect())
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
        style={{ "--ade-bar-offset": `${sidebarPx()}px` }}
        onDblClick={(e) => {
          if (e.target === e.currentTarget) void adeWindowToggleMaximize()
        }}
      >
        {/* Three groups: who and where on the left, the navigation in the
            middle, the controls on the right. The middle one is centred on
            the sessions area — the window minus the sidebar — rather than on
            what is left over, so the section you are in does not move when a
            project name gets longer. */}
        <div data-slot="ade-bar-side" data-side="start">
          {/*
            The mark, not the word.
            It draws in `currentColor`, so the ink the bar spends on it
            follows the theme — which a pair of baked assets never managed.
            The name stays in the accessibility tree: the mark is decorative
            and the label is on the box around it.
          */}
          <Show when={!(isTauriDesktop() && isMacOS())}>
            <span data-slot="ade-brand" role="img" aria-label="ADE">
              {/*
                Concept 03: Molten Chrome Mercury (N).
                Continuous liquid metal ribbon with animated caustic sheen
                and floating mercury micro-droplets.
              */}
              <NikChromeLogo size={30} />
            </span>
          </Show>
          <ProjectBar project={project()} />
          <span data-slot="ade-count">{t("bar.sessions", wb().panes.filter(p => !isPanelPane(p)).length)}</span>
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
                onClick={() => setWb(w => ({ ...w, view }))}
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
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2L14 14" stroke-linecap="round" />
          </svg>
        </button>
        {/* Decisions waiting for the user. Hidden at zero; opens only when pressed. */}
        <Show when={decisionsWaiting() > 0}>
          <button
            type="button"
            data-slot="decisions-badge"
            onClick={() => setDecisionsOpen(true)}
            title={t("decisions.waiting")}
          >
            {countLabel(decisionsWaiting())}
          </button>
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
        <Show when={showsNewPane(wb().view)}>
          <div data-slot="ade-menu-anchor">
            <button
              type="button"
              data-slot="ade-icon"
              data-action="new-pane"
              data-open={newPaneOpen() ? "true" : undefined}
              aria-haspopup="menu"
              aria-expanded={newPaneOpen()}
              onClick={() => setNewPaneOpen((open) => !open)}
              aria-label={t("bar.newPane")}
              title={t("bar.newPane")}
            >
              {/* Four frames: the grid this button adds to. */}
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">
                <rect x="2" y="2" width="5" height="5" rx="1.2" />
                <rect x="9" y="2" width="5" height="5" rx="1.2" />
                <rect x="2" y="9" width="5" height="5" rx="1.2" />
                <rect x="9" y="9" width="5" height="5" rx="1.2" />
              </svg>
            </button>

            <Show when={newPaneOpen()}>
              <div data-slot="ade-menu" role="menu" aria-label={t("bar.newPane")}>
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
        </Show>

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
                ? t(recordMicOn() ? "record.active.mic" : "record.active.noMic", recordState().status === "recording" ? (recordState() as { recording: { path: string } }).recording.path : "")
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
          <span data-slot="ade-brand" data-place="end" role="img" aria-label="ADE">
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
              <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1" style={{ "pointer-events": "none" }}>
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
              <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.2" style={{ "pointer-events": "none" }}>
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

      <div data-slot="ade-body">
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
          project={project()}
          searchFiles={hasHost() ? searchProjectFiles : undefined}
          selectedFilePath={selectedFile()}
          onSelectFile={(path) => void openFile(path)}
          onOpenSettings={() => setVoiceSettingsOpen(true)}
          bottom={
            <ShotTray
              shots={shotSource.shots()}
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
                aria-label={theme() === "dark" ? "Passa al tema chiaro" : "Passa al tema scuro"}
                title={theme() === "dark" ? "Tema chiaro" : "Tema scuro"}
              >
                <Show
                  when={theme() === "dark"}
                  fallback={
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">
                      <path d="M13 9.5A5.2 5.2 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" stroke-linejoin="round" />
                    </svg>
                  }
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">
                    <circle cx="8" cy="8" r="3.2" />
                    <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" stroke-linecap="round" />
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
                    unreadCount(notices()) > 0
                      ? `Notifiche, ${unreadCount(notices())} da leggere`
                      : "Notifiche"
                  }
                  title={t("bell.title")}
                >
                  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">
                    <path d="M8 2.2a3.8 3.8 0 0 1 3.8 3.8v2.2l1 2H3.2l1-2V6A3.8 3.8 0 0 1 8 2.2z" stroke-linejoin="round" />
                    <path d="M6.6 12.6a1.5 1.5 0 0 0 2.8 0" stroke-linecap="round" />
                  </svg>
                  <Show when={unreadCount(notices()) > 0}>
                    <span data-slot="ade-badge">{Math.min(unreadCount(notices()), 99)}</span>
                  </Show>
                </button>

                <Show when={noticesOpen()}>
                  <div data-slot="ade-menu" data-wide="true" role="menu" aria-label={t("bell.title")}>
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
                    <Show
                      when={notices().length > 0}
                      fallback={<p data-slot="ade-menu-empty">{t("bell.empty")}</p>}
                    >
                      <For each={notices()}>
                        {(notice) => (
                          <div data-slot="ade-notice-row" data-kind={notice.kind}>
                            <span data-slot="ade-notice-text">{notice.text}</span>
                            <Show when={notice.href}>
                              {(href) => (
                                <button
                                  type="button"
                                  data-slot="ade-notice-link"
                                  disabled={updating()}
                                  onClick={() => void installUpdate(href())}
                                >
                                  {updating() ? "Aggiornamento…" : "Aggiorna"}
                                </button>
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
          {(ask) => <RecordConsentDialog target={ask().target} onAnswer={(consent) => ask().answer(consent)} />}
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
              canPlan={Boolean(voiceSettings().openRouterApiKey)}
              held={voiceEngine.held()}
              onSubmit={(text) => void voiceEngine.submitText(text)}
              onToggleMic={() => void (voiceEngine.isRunning() ? voiceEngine.stop() : voiceEngine.toggle())}
              onOpenSettings={() => setVoiceSettingsOpen(true)}
            />
          </Show>

          <Show when={wb().view === "chat" && isViewVisible("chat")}>
            {/* The same credential the assistant uses. Asking for it twice is
                a way to get one of the two wrong. */}
            <Chat
              apiKey={voiceSettings().openRouterApiKey ?? ""}
              onOpenSettings={() => setVoiceSettingsOpen(true)}
            />
          </Show>

          <Show when={wb().view === "bot" && isViewVisible("bot")}>
            {/* A bot is a nikcli agent, so there is no key to ask for and no
                roster of ADE's own: the section reads the files nikcli reads,
                and starting one is the session the user would start. */}
            <BotsMain
              {...(project()?.root ? { projectRoot: project()!.root } : {})}
              onLaunch={(bot) => openBotSession(bot)}
              onOpenFile={(path) => void openFile(path)}
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
                  onFocus={(id) => setWb(w => ({ ...w, focusedId: id }))}
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

      <Show when={decisionsOpen()}>
        <DecisionsSheet
          hub={decisionsHub}
          onClose={() => setDecisionsOpen(false)}
          onOpenPanel={() => {
            setDecisionsOpen(false)
            openDecisionsPane()
          }}
        />
      </Show>

      <Show when={keyRequest() && keysHost()}>
        <KeyRequestDialog
          host={keysHost()!}
          agents={AGENTS}
          env={keyRequest()!.env}
          reason={keyRequest()!.reason}
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
        <VoiceSettingsPanel
          engine={voiceEngine}
          settings={voiceSettings()}
          onChange={handleVoiceSettingsChange}
          onClose={() => setVoiceSettingsOpen(false)}
          onOpenVoiceSource={(voice) => void getHost().then((host) => host?.ttsOpenVoiceSource?.(voice))}
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
          extraGroup="ADE"
          extraSections={[
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
                  <AgentHooksSection
                    host={hookHost()}
                    states={hookStates()}
                    onChanged={() => void refreshHooks()}
                  />
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
                        {(section) => (
                          <PluginSection title={section.title} render={() => section.render({})} />
                        )}
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
      </Show>

      {/*
        Last in the shell, so it paints over the grid without being inside it.
        The target is named rather than implied: dictation lands in the focused
        pane, and a widget that transcribed into a session the user had stopped
        looking at would be a surprise every time.
      */}
      <VoiceHud
        engine={voiceEngine}
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
        onOpenSettings={() => setVoiceSettingsOpen(true)}
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
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3">
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
    </svg>
  )
}
