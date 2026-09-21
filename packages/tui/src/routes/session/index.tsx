import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useProject } from "@tui/context/project"
import { borderCharsFor, SplitBorder } from "@tui/component/border"
import { PendingInputCard } from "@tui/component/pending-input-card"
import { SessionTaskCard } from "@tui/component/session-task-card"
import { Spinner } from "@tui/component/spinner"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { ScrollBoxRenderable, addDefaultParsers, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import { TuiPluginRuntime } from "@tui/plugin"
import { createNikcliClient, type Part, type SessionPendingInput2 } from "@nikcli-ai/sdk/httpapi"
import { useLocal } from "@tui/context/local"
import { Locale } from "@nikcli-ai/util/locale"
import { reasoningSummary } from "@tui/context/thinking"
import { Token } from "@nikcli-ai/util/token"

import { normalizeVizComponents } from "@nikcli-ai/util/viz"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "@tui/context/keybind"
import { parsePatch } from "diff"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { MessageMarkdown } from "@tui/feature-plugins/math/markdown"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { LANGUAGE_EXTENSIONS } from "@nikcli-ai/util/language"
import parsers from "../../../parsers-config.ts"
import { Clipboard } from "../../util/clipboard"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { useServer } from "../../context/server"
import { Editor } from "../../util/editor"
import { SubagentFooter } from "./subagent-footer.tsx"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import { Global } from "@nikcli-ai/util/global"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript, formatTranscriptJson } from "../../util/transcript"
import { TurnUsage } from "../../util/turn-usage"
import { DialogWebPreview } from "@tui/component/dialog-web-preview"
import { Renderer as VizRenderer } from "@tui/component/dialog-opentui-viz"
import { compilePartialSpec } from "@tui/util/spec-stream"
import { TuiImageList } from "@tui/component/tui-image"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogBgAgents } from "./dialog-bg-agents"
import { features } from "@nikcli-ai/util/features"
import { useLanguage } from "@tui/context/language"
import { spacerHeights, visibleRange } from "./message-window"
import { groupParts, type ExplorationGroup } from "./rows"
import { liveMarkdown, splitLiveMarkdown, wrapDiagramsInFences } from "./diagram"
import { SESSION_SIDEBAR_WIDTH } from "@tui/ui/layout"
import { RevertBanner } from "./revert-banner"
import { sessionCommandLabels } from "./session-command-labels"
import {
  dismissBackground as dismissBackgroundUtil,
  getBackgroundDismissed,
  undismissBackground as undismissBackgroundUtil,
} from "../../util/background"
import { friendlyErrorMessage, shareErrorMessage } from "../../util/error-message"
import { Link } from "../../ui/link"
import { context, use } from "./session-context"
import {
  DEFAULT_TURN_HEIGHT_METRICS,
  estimateTurnHeight,
  fromEntries,
  stabilize,
  type Turn,
  type ViewEntry,
} from "./view"
import { chromeRows, type StyleOf } from "@tui/context/component-tokens"
import { AssistantMessage, PendingUserMessage, UserMessage } from "./parts"
import { formatInstructionDelta, visibleInstructionNotices } from "@nikcli-ai/util/instruction-delta"
import { getScrollAcceleration, scrollChildIntoView } from "@tui/util/scroll"

/** The file fields the user-message badge row and image preview read. */
import { DialogMonitorLog, ExplorationSummary, ToolPartView } from "./tool-view"
import { moveSelection } from "@tui/ui/select-controller"

addDefaultParsers(parsers.parsers)

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const kv = useKV()
  const server = useServer()
  const { theme, component } = useTheme()
  // Already merged: the theme layers the studio preset for the session in view
  // over the document and the user's `components.json`, so there is nothing to
  // combine here and no second place a message's shape is decided.
  const userStyle = createMemo(() => component("session.user-message"))
  const lang = useLanguage()
  const commandLabels = sessionCommandLabels(lang)
  const promptRef = usePromptRef()
  // Refs and reactive primitives that are referenced from earlier `createEffect` /
  // `createMemo` callbacks. Must be declared before any usage site to avoid TDZ
  // errors when effects run before JSX `ref={(r) => …}` callbacks.
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef
  let lastSwitch: string | undefined = undefined
  const session = createMemo(() => sync.session.get(route.sessionID))
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const backgroundWorkerChildren = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    if (!parentID) return []
    const workerIDs = new Set(
      sync.background
        .list(parentID)
        .map((job) => job.workerSessionID)
        .filter((id): id is string => Boolean(id)),
    )
    return sync.data.session.filter((x) => workerIDs.has(x.id)).toSorted((a, b) => a.time.created - b.time.created)
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  /**
   * The conversation as turns — the seam the renderer draws from.
   *
   * Built from v1 messages and parts today; `fromEntries` produces the same
   * turns from the v2 entry store, and `test/tui/session-view.test.ts` proves
   * the two agree. Swapping the provider is the whole remaining migration.
   */
  // `stabilize` keeps the object identity of turns that did not change, because
  // `<For>` below reconciles by reference: without it every arriving entry
  // rebuilt the whole list and made Solid tear down and repaint every message
  // in the conversation. See the comment on `stabilize` in ./view.
  const turns = createMemo<Turn[]>(
    (previous) => stabilize(previous, fromEntries((sync.data.entry[route.sessionID] ?? []) as unknown as ViewEntry[])),
    [],
  )
  /**
   * Per-turn token rows, keyed by the assistant message that ends the turn.
   * Computed once here rather than per row: each turn needs the steps before it,
   * so deriving it inside the message component would be quadratic over a long
   * session. Empty (and free) unless the `turn_tokens` TUI option is on.
   */
  const turnUsage = createMemo(() =>
    sync.data.config.tui?.turn_tokens === true ? TurnUsage.byMessage(messages()) : undefined,
  )
  // The virtualizer uses estimated heights. While the assistant is streaming,
  // the active row grows on every text delta, so those estimates no longer
  // describe the scroll position and can window the live response out.
  const streaming = createMemo(() => turns().some((turn) => turn.role === "assistant" && !turn.completedAt))
  /**
   * Fallback row height, used only when a turn's content cannot be measured.
   * `estimateTurnHeight` derives the real figure from the turn's body.
   */
  const MESSAGE_HEIGHT_FALLBACK = 6
  const OVERSCAN = 5
  const virtualizationEnabled = createMemo(() => features(sync.data.config).tui.messageVirtualization)
  const [scrollPos, setScrollPos] = createSignal(0)
  const [viewportH, setViewportH] = createSignal(24)
  createEffect(() => {
    if (!virtualizationEnabled()) return
    const id = setInterval(() => {
      if (!scroll || scroll.isDestroyed) return
      setScrollPos(scroll.scrollTop)
      setViewportH(Math.max(1, scroll.viewport.height || dimensions().height - 10))
    }, 50)
    onCleanup(() => clearInterval(id))
  })
  /**
   * Windowed message list for C1 virtualization. Flag off → full list (bit-identical).
   * On any error → full list fallback.
   */
  const windowed = createMemo(() => {
    const all = turns()
    if (!virtualizationEnabled() || streaming() || all.length === 0) {
      return { items: all, top: 0, bottom: 0, baseIndex: 0 }
    }
    try {
      // Per-turn, from content. A flat constant was wrong in both directions
      // and the errors did not cancel: a one-line acknowledgement was
      // over-reserved while a long diff was under-reserved by an order of
      // magnitude, so the offset drifted further the more the transcript mixed
      // the two. `specs/effect-tui/06-terminal-rendering.md`.
      const columns = Math.max(1, scroll?.viewport.width || dimensions().width || 80)
      // Chrome rows come from the *resolved* message style, not a constant. A
      // theme that changes the message padding changes how tall every turn
      // renders; an estimator still counting the stock 3 would mis-reserve and
      // the scroll offset would drift — which reads as a renderer bug, not a
      // theming one.
      const box = userStyle().box
      const userColumns = Math.max(
        1,
        columns -
          box.paddingLeft -
          box.paddingRight -
          Number(box.borderSides.includes("left")) -
          Number(box.borderSides.includes("right")),
      )
      const metrics = {
        chromeRows: chromeRows(box),
        entryRows: DEFAULT_TURN_HEIGHT_METRICS.entryRows,
      }
      const heights = all.map(
        (turn) =>
          estimateTurnHeight(
            turn,
            turn.role === "user" ? userColumns : columns,
            turn.role === "user" ? metrics : DEFAULT_TURN_HEIGHT_METRICS,
          ) || MESSAGE_HEIGHT_FALLBACK,
      )
      const scrollTop = scrollPos()
      const vp = viewportH()
      // Sticky-bottom is owned by the scrollbox itself (stickyScroll=true,
      // stickyStart="bottom"). Do NOT clamp scrollTop here — double-sticky
      // causes jumpy viewport during streaming when the flag is on.
      const range = visibleRange({
        heights,
        scrollTop,
        viewportHeight: vp,
        overscan: OVERSCAN,
      })
      const spacers = spacerHeights(heights, range)
      return {
        items: all.slice(range.start, range.end),
        top: spacers.top,
        bottom: spacers.bottom,
        baseIndex: range.start,
      }
    } catch {
      return { items: all, top: 0, bottom: 0, baseIndex: 0 }
    }
  })
  const messageCreatedAt = createMemo(() =>
    Object.fromEntries(messages().map((message) => [message.id, message.time.created])),
  )
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })

  const pending = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant" && !x.time.completed)?.id
  })

  const pendingInputs = createMemo(() => {
    const visible = new Set(messages().map((message) => message.id))
    return sync.session.pending(route.sessionID).filter((item) => !visible.has(item.messageID))
  })

  const instructionNotices = createMemo(() =>
    visibleInstructionNotices(sync.data.session_instructions[route.sessionID]),
  )

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode, setDiffWrapMode] = createSignal<"word" | "none">("word")
  const [animationsEnabled, setAnimationsEnabled] = kv.signal("animations_enabled", true)

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? SESSION_SIDEBAR_WIDTH : 0) - 4)

  const scrollAcceleration = createMemo(() => getScrollAcceleration(sync.data.config.tui))
  const toast = useToast()
  const sdk = useSDK()
  const project = useProject()

  createEffect(async () => {
    const sessionID = route.sessionID
    // Opencode parity: opening a session that belongs to a different
    // workspace switches the TUI's current workspace and re-bootstraps the
    // scoped data (path/vcs/config/sessions) so the whole UI reflects the
    // worktree (branch, directory, ...) instead of the root checkout.
    const workspaceID = route.workspaceID ?? untrack(() => sync.session.get(sessionID)?.workspaceID)
    const previousWorkspace = untrack(() => project.workspace.current())
    if (workspaceID !== previousWorkspace) {
      project.workspace.set(workspaceID)
      try {
        await sync.bootstrap()
      } catch {}
    }
    if (route.sessionID !== sessionID) return
    await sync.session
      .sync(sessionID)
      .then(() => {
        if (scroll) scroll.scrollBy(100_000)
      })
      .catch(() => {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
        })
        return navigate({
          type: "home",
          workspaceID: sync.session.get(sessionID)?.workspaceID,
        })
      })
  })

  // Handle initial prompt from fork
  createEffect(
    on(
      () => route.initialPrompt,
      (initialPrompt) => {
        if (initialPrompt && prompt) {
          prompt.set(initialPrompt)
        }
      },
      { defer: true },
    ),
  )

  onMount(() => {
    const autoBackgroundedTasks = new Set<string>()
    const off = sdk.event.on("message.part.updated", (evt) => {
      const part = evt.properties.part
      if (part.type !== "tool") return

      // Auto-background: handle task parts for ANY session that is a known
      // parent (not just the currently active route) so events aren't lost
      // when the user navigates away during background task startup.
      if (part.tool === "task") {
        const metadata = (part.state as any)?.metadata
        const backgroundID = metadata?.rootDelegationId ?? metadata?.delegationId ?? part.id
        const parentID = part.sessionID
        if (metadata?.background === true && !autoBackgroundedTasks.has(backgroundID)) {
          autoBackgroundedTasks.add(backgroundID)
          undismissBackground(parentID, backgroundID)
          void sync.background.sync(parentID)
        }
        return
      }

      // plan_enter/plan_exit only matter for the currently active session
      if (part.sessionID !== route.sessionID) return
      if (part.state.status !== "completed") return
      if (part.id === lastSwitch) return

      if (part.tool === "plan_exit") {
        local.agent.set("build")
        lastSwitch = part.id
      } else if (part.tool === "plan_enter") {
        local.agent.set("plan")
        lastSwitch = part.id
      }
    })

    onCleanup(() => off())
  })

  const keybind = useKeybind()
  const status = createMemo(() => sync.data.session_status?.[route.sessionID] ?? { type: "idle" as const })

  const getDismissed = (parentID: string) => getBackgroundDismissed(kv, parentID)
  const dismissBackground = (parentID: string, delegationID: string) =>
    dismissBackgroundUtil(kv, parentID, delegationID)
  const undismissBackground = (parentID: string, delegationID: string) =>
    undismissBackgroundUtil(kv, parentID, delegationID)

  // Allow exit when in child session (prompt is hidden)
  const { exit } = useExit()
  useKeyboard((evt) => {
    if (!session()?.parentID) return
    if (keybind.match("app_exit", evt)) {
      exit()
    }
  })

  useKeyboard((evt) => {
    const parentID = session()?.parentID
    if (!parentID) return
    if (!keybind.match("subtask_background", evt)) return

    evt.preventDefault()
    evt.stopPropagation()
    const job = sync.background.findBySession(route.sessionID)
    if (job) undismissBackground(parentID, job.rootDelegationID)
    navigate({
      type: "session",
      sessionID: parentID,
      workspaceID: sync.session.get(parentID)?.workspaceID,
    })
  })

  // In subagent sessions, Esc should behave like Ctrl+B (background + return to parent).
  useKeyboard((evt) => {
    const parentID = session()?.parentID
    if (!parentID) return
    if (evt.name !== "escape") return

    evt.preventDefault()
    evt.stopPropagation()
    const job = sync.background.findBySession(route.sessionID)
    if (job) undismissBackground(parentID, job.rootDelegationID)
    navigate({
      type: "session",
      sessionID: parentID,
      workspaceID: sync.session.get(parentID)?.workspaceID,
    })
  })

  // Session pin toggle with <leader>p
  useKeyboard((evt) => {
    if (!keybind.match("session_pin_toggle", evt)) return
    evt.preventDefault()
    evt.stopPropagation()
    const sessionID = route.sessionID
    if (!sessionID) return
    const isPinned = local.session.isPinned(sessionID)
    local.session.togglePin(sessionID)
    toast.show({
      message: isPinned ? "Session unpinned" : "Session pinned",
      variant: "info",
      duration: 2000,
    })
  })

  // Quick-switch to pinned sessions with <leader>1-9
  useKeyboard((evt) => {
    if (!evt.name) return
    const num = parseInt(evt.name, 10)
    if (isNaN(num) || num < 1 || num > 9) return
    if (!keybind.match(`session_quick_switch_${num}`, evt)) return
    evt.preventDefault()
    evt.stopPropagation()
    const slots = local.session.slots()
    const targetSessionID = slots[num - 1]
    if (!targetSessionID) {
      toast.show({
        message: `No session pinned in slot ${num}`,
        variant: "warning",
        duration: 2000,
      })
      return
    }
    navigate({
      type: "session",
      sessionID: targetSessionID,
      workspaceID: sync.session.get(targetSessionID)?.workspaceID,
    })
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messageSet = new Set(messages().map((m) => m.id))
    const scrollTop = scroll.scrollTop

    const isValidMessage = (c: (typeof children)[0]) => {
      if (!c.id || !messageSet.has(c.id)) return false
      const parts = sync.data.part[c.id]
      return parts?.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored) ?? false
    }

    // Children are already in DOM order (sorted by y), no need to re-sort
    if (direction === "next") {
      for (const c of children) {
        if (c.y > scrollTop + 10 && isValidMessage(c)) return c.id
      }
    } else {
      for (let i = children.length - 1; i >= 0; i--) {
        const c = children[i]
        if (c.y < scrollTop - 10 && isValidMessage(c)) return c.id
      }
    }
    return null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    scrollChildIntoView(scroll, targetID)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (scroll) scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = useLocal()

  function moveChild(direction: number) {
    const targets = backgroundWorkerChildren()
    if (targets.length === 0) return
    if (targets.length === 1 && targets[0]?.id === session()?.id) return
    const next = moveSelection(
      targets.findIndex((x) => x.id === session()?.id),
      {
        count: targets.length,
        delta: direction,
        policy: "wrap",
      },
    )
    if (targets[next]) {
      navigate({
        type: "session",
        sessionID: targets[next].id,
        workspaceID: targets[next].workspaceID,
      })
    }
  }

  const command = useCommandDialog()
  command.register(() => [
    {
      title: commandLabels.backgroundSubtask,
      value: "subtask.background",
      keybind: "subtask_background",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => {
        const parentID = session()?.parentID
        if (!parentID) return
        const job = sync.background.findBySession(route.sessionID)
        if (job) undismissBackground(parentID, job.rootDelegationID)
        navigate({
          type: "session",
          sessionID: parentID,
          workspaceID: sync.session.get(parentID)?.workspaceID,
        })
        dialog.clear()
      },
    },
    {
      title: commandLabels.backgroundAgents,
      value: "session.bg_agents",
      category: commandLabels.category,
      slash: {
        name: "bg-agents",
        aliases: ["monitors", "agents"],
      },
      onSelect: (dialog) => {
        const backgroundSessionID = session()?.parentID ?? route.sessionID
        void sync.background.sync(backgroundSessionID)
        dialog.replace(() => (
          <DialogBgAgents
            sessionID={backgroundSessionID}
            onOpenMonitor={(monitorID, title, command, status, logPath) => {
              dialog.setSize("xlarge")
              dialog.replace(
                () => (
                  <DialogMonitorLog
                    sessionID={backgroundSessionID}
                    monitorID={monitorID}
                    title={title}
                    command={command}
                    status={status}
                    logPath={logPath}
                  />
                ),
                () => dialog.setSize("medium"),
              )
            }}
          />
        ))
      },
    },
    {
      title: session()?.share?.url ? commandLabels.copyShareLink : commandLabels.share,
      value: "session.share",
      suggested: route.type === "session",
      keybind: "session_share",
      category: commandLabels.category,
      enabled: sync.data.config.share !== "disabled",
      slash: {
        name: "share",
      },
      onSelect: async (dialog) => {
        const copy = (url: string) =>
          Clipboard.copy(url)
            .then(() =>
              toast.show({
                message: lang.t("session.share.copied"),
                variant: "success",
              }),
            )
            .catch(() =>
              toast.show({
                message: "Failed to copy URL to clipboard",
                variant: "error",
              }),
            )

        const shareSession = async (client = sdk.client) => {
          const result = await client.session.share(
            {
              sessionID: route.sessionID,
            },
            { throwOnError: true },
          )
          const next = result.data?.share?.url
          if (!next) throw new Error("Share URL missing from session response")
          await copy(next)
        }

        const url = session()?.share?.url
        const shouldRefreshLocalShare =
          !!url &&
          /^https?:\/\/(?:127\.0\.0\.1|localhost|nikcli\.local)(?::\d+)?\//i.test(url) &&
          /^https?:\/\/nikcli\.local(?::\d+)?$/i.test(sdk.url)

        if (url && !shouldRefreshLocalShare) {
          await copy(url)
          dialog.clear()
          return
        }

        try {
          await shareSession()
        } catch (error) {
          const canStartLocalServer = /^https?:\/\/nikcli\.local(?::\d+)?$/i.test(sdk.url) && !!server.startServer
          if (!canStartLocalServer) {
            toast.show({
              message: shareErrorMessage(error),
              variant: "error",
              duration: 5000,
            })
            dialog.clear()
            return
          }

          try {
            const baseUrl = await server.startServer?.()
            if (!baseUrl) throw new Error("Failed to start local share server")
            const client = createNikcliClient({
              baseUrl,
              directory: sdk.directory,
              fetch: sdk.fetch,
            })
            await shareSession(client)
          } catch (retryError) {
            toast.show({
              message: shareErrorMessage(retryError),
              variant: "error",
              duration: 5000,
            })
          }
        }
        dialog.clear()
      },
    },
    {
      title: commandLabels.rename,
      value: "session.rename",
      keybind: "session_rename",
      category: commandLabels.category,
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: commandLabels.jumpToMessage,
      value: "session.timeline",
      keybind: "session_timeline",
      category: commandLabels.category,
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              scrollChildIntoView(scroll, messageID)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: commandLabels.forkFromMessage,
      value: "session.fork",
      keybind: "session_fork",
      category: commandLabels.category,
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              scrollChildIntoView(scroll, messageID)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: commandLabels.compact,
      value: "session.compact",
      keybind: "session_compact",
      category: commandLabels.category,
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: commandLabels.unshare,
      value: "session.unshare",
      keybind: "session_unshare",
      category: commandLabels.category,
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      onSelect: async (dialog) => {
        const ok = await DialogConfirm.show(
          dialog,
          "Unshare session?",
          "This will revoke the public share URL. Anyone with the old link will no longer be able to view this session.",
          "confirm",
        )
        if (!ok) return
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() =>
            toast.show({
              message: "Session unshared successfully",
              variant: "success",
            }),
          )
          .catch((error) =>
            toast.show({
              message: shareErrorMessage(error),
              variant: "error",
              duration: 5000,
            }),
          )
        dialog.clear()
      },
    },
    {
      title: commandLabels.undo,
      value: "session.undo",
      keybind: "messages_undo",
      category: commandLabels.category,
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: commandLabels.redo,
      value: "session.redo",
      keybind: "messages_redo",
      category: commandLabels.category,
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt.set({ input: "", parts: [] })
          return
        }
        sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: sidebarVisible() ? commandLabels.hideSidebar : commandLabels.showSidebar,
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: commandLabels.category,
      onSelect: (dialog) => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: commandLabels.toggleConceal,
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal" as any,
      category: commandLabels.category,
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? commandLabels.hideTimestamps : commandLabels.showTimestamps,
      value: "session.toggle.timestamps",
      category: commandLabels.category,
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showThinking() ? commandLabels.hideThinking : commandLabels.showThinking,
      value: "session.toggle.thinking",
      category: commandLabels.category,
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: commandLabels.toggleDiffWrap,
      value: "session.toggle.diffwrap",
      category: commandLabels.category,
      slash: {
        name: "diffwrap",
      },
      onSelect: (dialog) => {
        setDiffWrapMode((prev) => (prev === "word" ? "none" : "word"))
        dialog.clear()
      },
    },
    {
      title: showDetails() ? commandLabels.hideToolDetails : commandLabels.showToolDetails,
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: commandLabels.category,
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: commandLabels.toggleScrollbar,
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: commandLabels.category,
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: animationsEnabled() ? commandLabels.disableAnimations : commandLabels.enableAnimations,
      value: "session.toggle.animations",
      category: commandLabels.category,
      onSelect: (dialog) => {
        setAnimationsEnabled((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: commandLabels.pageUp,
      value: "session.page.up",
      keybind: "messages_page_up",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: commandLabels.pageDown,
      value: "session.page.down",
      keybind: "messages_page_down",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: commandLabels.lineUp,
      value: "session.line.up",
      keybind: "messages_line_up",
      category: commandLabels.category,
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: commandLabels.lineDown,
      value: "session.line.down",
      keybind: "messages_line_down",
      category: commandLabels.category,
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: commandLabels.halfPageUp,
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: commandLabels.halfPageDown,
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: commandLabels.firstMessage,
      value: "session.first",
      keybind: "messages_first",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: commandLabels.lastMessage,
      value: "session.last",
      keybind: "messages_last",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: commandLabels.lastUserMessage,
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: commandLabels.category,
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            scrollChildIntoView(scroll, message.id)
            break
          }
        }
      },
    },
    {
      title: commandLabels.nextMessage,
      value: "session.message.next",
      keybind: "messages_next",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: commandLabels.prevMessage,
      value: "session.message.previous",
      keybind: "messages_previous",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: commandLabels.copyLastAssistant,
      value: "messages.copy",
      keybind: "messages_copy",
      category: commandLabels.category,
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({
            message: "No assistant messages found",
            variant: "error",
          })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({
            message: "No text parts found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() =>
            toast.show({
              message: "Message copied to clipboard!",
              variant: "success",
            }),
          )
          .catch(() =>
            toast.show({
              message: "Failed to copy to clipboard",
              variant: "error",
            }),
          )
        dialog.clear()
      },
    },
    {
      title: commandLabels.copyTranscript,
      value: "session.copy",
      category: commandLabels.category,
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({
              info: msg,
              parts: sync.data.part[msg.id] ?? [],
            })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
            },
          )
          await Clipboard.copy(transcript)
          toast.show({
            message: "Session transcript copied to clipboard!",
            variant: "success",
          })
        } catch {
          toast.show({
            message: "Failed to copy session transcript",
            variant: "error",
          })
        }
        dialog.clear()
      },
    },
    {
      title: commandLabels.exportTranscript,
      value: "session.export",
      category: commandLabels.category,
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const withParts = sessionMessages.map((msg) => ({
            info: msg,
            parts: sync.data.part[msg.id] ?? [],
          }))
          const transcriptOptions = {
            thinking: options.thinking,
            toolDetails: options.toolDetails,
            assistantMetadata: options.assistantMetadata,
          }
          // The filename picks the format — the dialog has always advertised
          // `.json` as an accepted extension, it just never honoured it.
          const format = options.filename.trim().toLowerCase().endsWith(".json") ? "json" : "markdown"
          const transcript =
            format === "json"
              ? formatTranscriptJson(sessionData, withParts, transcriptOptions)
              : formatTranscript(sessionData, withParts, transcriptOptions)

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Bun.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Bun.write(filepath, result)
            }

            toast.show({
              message: `Session exported as ${format} to ${filepath}`,
              variant: "success",
            })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: commandLabels.nextChild,
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => {
        moveChild(1)
        dialog.clear()
      },
    },
    {
      title: commandLabels.prevChild,
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => {
        moveChild(-1)
        dialog.clear()
      },
    },
    {
      title: commandLabels.parent,
      value: "session.parent",
      keybind: "session_parent",
      category: commandLabels.category,
      hidden: true,
      onSelect: (dialog) => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
            workspaceID: sync.session.get(parentID)?.workspaceID,
          })
        }
        dialog.clear()
      },
    },
    {
      title: commandLabels.closeSubagent,
      value: "session.child.close",
      keybind: "session_child_close",
      category: commandLabels.category,
      hidden: true,
      onSelect: async (dialog) => {
        const parentID = session()?.parentID
        const currentID = route.sessionID
        const status = sync.data.session_status[currentID]?.type

        if (parentID && currentID) {
          // If busy, kill the task (which also removes it from background)
          if (status !== "idle") {
            await sdk.client.session.abort({ sessionID: currentID }).catch(() => {})
          } else {
            // If idle, just remove from background tasks
            const job = sync.background.findBySession(currentID)
            if (job) dismissBackground(parentID, job.rootDelegationID)
          }

          navigate({
            type: "session",
            sessionID: parentID,
            workspaceID: sync.session.get(parentID)?.workspaceID,
          })
        }
        dialog.clear()
      },
    },
  ])

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => {
    const diffText = revertInfo()?.diff ?? ""
    if (!diffText) return []

    try {
      const patches = parsePatch(diffText)
      return patches.map((patch) => {
        const filename = patch.newFileName || patch.oldFileName || "unknown"
        const cleanFilename = filename.replace(/^[ab]\//, "")
        return {
          filename: cleanFilename,
          additions: patch.hunks.reduce(
            (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("+")).length,
            0,
          ),
          deletions: patch.hunks.reduce(
            (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("-")).length,
            0,
          ),
        }
      })
    } catch {
      return []
    }
  })

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  const dialog = useDialog()
  const renderer = useRenderer()

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        get height() {
          return dimensions().height
        },
        sessionID: route.sessionID,
        conceal,
        showThinking,
        showTimestamps,
        showDetails,
        diffWrapMode,
        messageCreatedAt,
        sync,
      }}
    >
      <box flexDirection="row">
        <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
          <Show when={session()}>
            <scrollbox
              ref={(r) => (scroll = r)}
              viewportOptions={{
                paddingRight: showScrollbar() ? 1 : 0,
              }}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                visible: showScrollbar(),
                trackOptions: {
                  backgroundColor: theme.surface.offset,
                  foregroundColor: theme.border.default,
                },
              }}
              stickyScroll={true}
              stickyStart="bottom"
              flexGrow={1}
              scrollAcceleration={scrollAcceleration()}
            >
              <Show when={windowed().top > 0}>
                <box height={windowed().top} flexShrink={0} />
              </Show>
              {/* RevertBanner is rendered outside <For> so virtualization cannot
                  unmount it on slice change — keeps click handlers alive when
                  the user scrolls while the banner is visible. */}
              <Show when={revert()}>
                <RevertBanner count={revert()!.reverted.length} diffFiles={revert()!.diffFiles} />
              </Show>
              <For each={windowed().items}>
                {(turn, index) => (
                  <Switch>
                    <Match when={revert()?.messageID && turn.messageID >= revert()!.messageID}>
                      <></>
                    </Match>
                    <Match when={turn.role === "user"}>
                      <UserMessage
                        style={userStyle()}
                        index={windowed().baseIndex + index()}
                        onMouseUp={() => {
                          if (renderer.getSelection()?.getSelectedText()) return
                          dialog.replace(() => (
                            <DialogMessage
                              messageID={turn.messageID}
                              sessionID={route.sessionID}
                              setPrompt={(promptInfo) => prompt.set(promptInfo)}
                            />
                          ))
                        }}
                        turn={turn}
                        pending={pending()}
                      />
                    </Match>
                    <Match when={turn.role === "assistant"}>
                      <AssistantMessage
                        last={lastAssistant()?.id === turn.messageID}
                        turn={turn}
                        usage={turnUsage()?.get(turn.messageID)}
                      />
                    </Match>
                  </Switch>
                )}
              </For>
              <Show when={windowed().bottom > 0}>
                <box height={windowed().bottom} flexShrink={0} />
              </Show>
              <For each={pendingInputs()}>{(item) => <PendingUserMessage pending={item} />}</For>
              <For each={instructionNotices()}>
                {(notice) => (
                  <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0}>
                    <text fg={theme.foreground.muted} wrapMode="word">
                      {lang.t("session.instructions.updated", {
                        keys: formatInstructionDelta(notice.delta),
                      })}
                    </text>
                  </box>
                )}
              </For>
            </scrollbox>
            <box flexShrink={0}>
              <TuiPluginRuntime.Slot name="session.prompt.top" sessionID={route.sessionID} />
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} />
              </Show>
              <Show when={permissions().length === 0 && questions().length > 0}>
                <QuestionPrompt request={questions()[0]} />
              </Show>
              <Show when={session()?.parentID && permissions().length === 0 && questions().length === 0}>
                <SubagentFooter />
              </Show>
              <Prompt
                visible={!session()?.parentID && permissions().length === 0 && questions().length === 0}
                ref={(r) => {
                  prompt = r
                  promptRef.set(r)
                  // Apply initial prompt when prompt component mounts (e.g., from fork)
                  if (route.initialPrompt) {
                    r.set(route.initialPrompt)
                  }
                }}
                disabled={permissions().length > 0 || questions().length > 0}
                onSubmit={() => {
                  toBottom()
                }}
                sessionID={route.sessionID}
              />
            </box>
          </Show>
          <Toast />
        </box>
        <Show when={sidebarVisible()}>
          <Switch>
            <Match when={wide()}>
              <Sidebar sessionID={route.sessionID} />
            </Match>
            <Match when={!wide()}>
              <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                alignItems="flex-end"
                backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
              >
                <Sidebar sessionID={route.sessionID} />
              </box>
            </Match>
          </Switch>
        </Show>
      </box>
    </context.Provider>
  )
}
