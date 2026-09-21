import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  ConnectorStatus,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  FileDiff,
  Workspace,
  SessionEntry,
  SessionPendingInput2,
} from "@nikcli-ai/sdk/httpapi"
import type { Config } from "@nikcli-ai/sdk/httpapi"
import { createNikcliClient } from "@nikcli-ai/sdk/httpapi"
import { createStore, produce, reconcile } from "solid-js/store"
import { useSDK } from "@tui/context/sdk"
import { useProject } from "@tui/context/project"
import { Binary } from "@nikcli-ai/util/binary"
import { createSimpleContext } from "./helper"
import { clientErrorStatus, isTransientHttpInterrupt, namedFailures, retryTransient } from "@tui/util/settled"
import { createReconnectGate } from "@tui/util/reconnect"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, createEffect, on, onCleanup, onMount } from "solid-js"
import { debounce } from "@solid-primitives/scheduled"
import { Log } from "@nikcli-ai/util/log"
import { createLru } from "@tui/util/lru-cache"
import { createLatestOnlyAsync } from "@tui/util/signal"
import type { Path } from "@nikcli-ai/sdk/httpapi"
import { features } from "@nikcli-ai/util/features"
import { appendInstructionNotice, type InstructionNotice } from "@nikcli-ai/util/instruction-delta"

type BackgroundJob = {
  jobID: string
  rootDelegationID: string
  parentSessionID: string
  title: string
  agent: string
  status: "running" | "synthesizing" | "complete" | "error" | "timeout" | "cancelled" | "orphaned"
  source?: string
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

type GoalState = {
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

type MonitorSnapshot = {
  id: string
  title: string
  command: string
  status: "running" | "complete" | "error" | "timeout" | "cancelled" | string
  logPath?: string
  exitCode?: number
  preview?: string
  bytes?: number
}

export const {
  use: useSync,
  provider: SyncProvider,
  context: SyncContext,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      /**
       * Best-effort resources that failed to load, by request name.
       *
       * `status` answers "has bootstrap finished", not "did everything
       * arrive". Folding one optional endpoint's failure into the status was
       * how a machine with, say, connectors down sat at `partial` forever —
       * and `partial` gates the empty-provider prompt, which needs none of
       * these resources.
       */
      degraded: string[]
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      config: Config
      permission: Record<string, PermissionRequest[]>
      question: Record<string, QuestionRequest[]>
      session: Session[]
      session_status: Record<string, SessionStatus>
      session_pending: Record<string, SessionPendingInput2[]>
      session_instructions: Record<string, InstructionNotice[]>
      session_goal: Record<string, GoalState>
      background_job: Record<string, BackgroundJob[]>
      monitor: Record<string, MonitorSnapshot[]>
      session_diff: Record<string, FileDiff[]>
      todo: Record<string, Todo[]>
      message: Record<string, Message[]>
      part: Record<string, Part[]>
      /**
       * The v2 read model, kept live off `session.entry.updated`.
       *
       * Sorted by id, which is safe because entry ids are derived from the
       * v1 ids they come from (`SessionEntry.idForPart`/`idForMessage`), so
       * a delta always lands on the entry it updates rather than appending a
       * near-duplicate.
       */
      entry: Record<string, SessionEntry[]>
      lsp: LspStatus[]
      mcp: Record<string, McpStatus>
      mcp_resource: Record<string, McpResource>
      connectors: Record<string, ConnectorStatus>
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      path: Path
      workspaceList: Workspace[]
    }>({
      status: "loading",
      degraded: [],
      provider: [],
      provider_default: {},
      provider_next: { all: [], default: {}, connected: [] },
      provider_auth: {},
      agent: [],
      command: [],
      config: {} as Config,
      permission: {},
      question: {},
      session: [],
      session_status: {},
      session_pending: {},
      session_instructions: {},
      session_goal: {},
      background_job: {},
      monitor: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      entry: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      connectors: {},
      formatter: [],
      vcs: undefined,
      path: { home: "", state: "", config: "", worktree: "", directory: "" },
      workspaceList: [],
    })

    const sdk = useSDK()
    const project = useProject()
    const backgroundRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

    /** Client scoped to the currently selected workspace (opencode parity):
     *  when a workspace is active every bootstrap fetch runs against the
     *  worktree instance, so path/vcs/config/sessions reflect the worktree. */
    function scopedClient() {
      const workspace = project.workspace.current()
      if (!workspace) return sdk.client
      return createNikcliClient({
        baseUrl: sdk.url,
        fetch: sdk.fetch,
        directory: sdk.directory,
        workspace,
      })
    }

    // Scoped like the bootstrap fetch is. `/lsp/status` carries no sessionID,
    // so the server cannot derive the workspace from the path the way it does
    // for `/session/:id` routes — an unscoped call answers for the root
    // instance. Bootstrap loaded the worktree's LSP state; refreshing it
    // through the root client overwrote that with another workspace's.
    // `scopedClient()` is called here rather than captured, so it follows the
    // workspace that is active when the refresh runs.
    const refreshLspLatest = createLatestOnlyAsync<[], Awaited<ReturnType<typeof sdk.client.lsp.status>>>(async () =>
      scopedClient().lsp.status(),
    )
    // Debounce rapid lsp.updated bursts (typing / file switches) so only the latest applies.
    // See specs/effect-tui/05-reactive-state.md.
    const applyLspRefresh = () =>
      refreshLspLatest()
        .then((x) => {
          if (x?.data) setStore("lsp", reconcile(x.data))
        })
        .catch(() => {})
    const refreshLspDebounced = debounce(applyLspRefresh, 300)

    async function refreshBackgroundJobs(sessionID: string) {
      const result = await sdk.client.session.background({ sessionID }).catch(() => undefined)
      if (!result?.data) return
      setStore("background_job", sessionID, reconcile(result.data))
    }

    // Last delegationID we scheduled a refresh for, keyed by session.
    // This trims the "delegation.completed + 12 message.part.updated"
    // flood that follows a child completion: the first event schedules
    // the refresh; subsequent events for the same delegationID find
    // the existing timer and just extend the debounce window, so the
    // request fires once per delegation (per session) instead of once
    // per event. Entries are evicted on `session.deleted` below.
    const lastDelegationBySession = new Map<string, string>()

    function scheduleBackgroundRefresh(sessionID?: string, delegationID?: string) {
      if (!sessionID) return
      // If the caller passes the same delegationID we already scheduled
      // for, treat the call as a debounce extension rather than a new
      // refresh. The first event for a new delegationID still records
      // the lookup so subsequent retries for the same one are merged.
      if (delegationID) {
        const previous = lastDelegationBySession.get(sessionID)
        if (previous !== delegationID) lastDelegationBySession.set(sessionID, delegationID)
      }
      const existing = backgroundRefreshTimers.get(sessionID)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        backgroundRefreshTimers.delete(sessionID)
        void refreshBackgroundJobs(sessionID).catch(() => {})
      }, 75)
      backgroundRefreshTimers.set(sessionID, timer)
    }

    function monitorFromRecord(record: {
      id: string
      title: string
      command: string
      status: MonitorSnapshot["status"]
      logPath: string
      exitCode?: number
      preview?: string
      bytes?: number
    }): MonitorSnapshot {
      return {
        id: record.id,
        title: record.title,
        command: record.command,
        status: record.status,
        logPath: record.logPath,
        exitCode: record.exitCode,
        preview: record.preview,
        bytes: record.bytes,
      }
    }

    function upsertMonitor(sessionID: string, monitor: MonitorSnapshot) {
      const monitors = store.monitor[sessionID]
      if (!monitors) {
        setStore("monitor", sessionID, [monitor])
        return
      }
      const result = Binary.search(monitors, monitor.id, (m) => m.id)
      if (result.found) {
        setStore("monitor", sessionID, result.index, reconcile(monitor))
        return
      }
      setStore(
        "monitor",
        sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, monitor)
        }),
      )
    }

    function patchMonitor(sessionID: string, monitorID: string, patch: Partial<MonitorSnapshot>) {
      const monitors = store.monitor[sessionID]
      if (!monitors) return
      const result = Binary.search(monitors, monitorID, (m) => m.id)
      if (!result.found) return
      setStore("monitor", sessionID, result.index, reconcile({ ...monitors[result.index], ...patch }))
    }

    async function syncWorkspaces() {
      const result = await sdk.client.experimental.workspace.list().catch(() => undefined)
      if (!result?.data) return
      setStore("workspaceList", reconcile(result.data))
    }

    function getSessionByID(sessionID: string) {
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const applyEvent: Parameters<typeof sdk.event.listen>[0] = (e) => {
      const event = e.details
      switch (event.type) {
        // Note: InstanceDisposed events are handled explicitly by the caller
        // (e.g., ApiMethod, AutoMethod, CodeMethod) to avoid double-bootstrap.
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          syncedSessions.delete(event.properties.info.id)
          sessionLru.forget(event.properties.info.id)
          lastDelegationBySession.delete(event.properties.info.id)
          const messageIDs = (store.message[event.properties.info.id] ?? []).map((message) => message.id)
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          setStore(
            produce((draft) => {
              delete draft.message[event.properties.info.id]
              delete draft.entry[event.properties.info.id]
              delete draft.todo[event.properties.info.id]
              delete draft.background_job[event.properties.info.id]
              delete draft.monitor[event.properties.info.id]
              delete draft.session_diff[event.properties.info.id]
              delete draft.session_status[event.properties.info.id]
              delete draft.session_pending[event.properties.info.id]
              delete draft.session_instructions[event.properties.info.id]
              delete draft.session_goal[event.properties.info.id]
              for (const messageID of messageIDs) {
                delete draft.part[messageID]
              }
            }),
          )
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          const parentID = getSessionByID(event.properties.sessionID)?.parentID
          scheduleBackgroundRefresh(parentID)
          break
        }

        case "session.pending.promoted": {
          const removed = new Set(event.properties.pendingIDs)
          setStore("session_pending", event.properties.sessionID, (pending) =>
            (pending ?? []).filter((item) => !removed.has(item.id)),
          )
          break
        }

        case "session.instructions.updated": {
          const { sessionID, delta } = event.properties
          if (!sessionID || !delta) break
          setStore("session_instructions", sessionID, (current) => appendInstructionNotice(current, delta, Date.now()))
          break
        }

        case "session.goal": {
          const { sessionID, goal } = event.properties
          if (goal) {
            setStore("session_goal", sessionID, reconcile(goal as GoalState))
          } else {
            setStore(
              produce((draft) => {
                delete draft.session_goal[sessionID]
              }),
            )
          }
          break
        }

        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          // A new user turn retires the instruction notices pinned under the
          // transcript. They announce a change the server folds into the
          // prompt prefix once it has been delivered, so past the turn that
          // carried it the chrome is stale and would otherwise never clear.
          if (
            event.properties.info.role === "user" &&
            !messages?.some((message) => message.id === event.properties.info.id)
          ) {
            setStore("session_instructions", event.properties.info.sessionID, [])
          }
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const refreshParentID = getSessionByID(event.properties.part.sessionID)?.parentID
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            scheduleBackgroundRefresh(refreshParentID)
            if (event.properties.part.type === "tool" && event.properties.part.tool === "task") {
              scheduleBackgroundRefresh(event.properties.part.sessionID)
            }
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            if (event.properties.part.type === "tool" && event.properties.part.tool === "task") {
              scheduleBackgroundRefresh(refreshParentID)
              scheduleBackgroundRefresh(event.properties.part.sessionID)
            }
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          scheduleBackgroundRefresh(refreshParentID)
          if (event.properties.part.type === "tool" && event.properties.part.tool === "task") {
            scheduleBackgroundRefresh(event.properties.part.sessionID)
          }
          break
        }

        case "delegation.completed": {
          // Pass the delegationID so the lastDelegationBySession
          // dedup can coalesce the burst of part.updated events that
          // typically follow a single completion.
          scheduleBackgroundRefresh(event.properties.parentSessionID, event.properties.delegationID)
          break
        }

        case "monitor.created": {
          upsertMonitor(event.properties.sessionID, monitorFromRecord(event.properties.record))
          break
        }

        case "monitor.updated": {
          upsertMonitor(event.properties.sessionID, monitorFromRecord(event.properties.record))
          break
        }

        case "monitor.output": {
          patchMonitor(event.properties.sessionID, event.properties.monitorID, {
            preview: event.properties.preview,
            bytes: event.properties.bytes,
            status: event.properties.status,
          })
          break
        }

        case "monitor.completed": {
          patchMonitor(event.properties.sessionID, event.properties.monitorID, {
            title: event.properties.title,
            status: event.properties.status,
            exitCode: event.properties.exitCode ?? undefined,
            logPath: event.properties.logPath,
          })
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        // ---- v2 read model -------------------------------------------------
        // Entries arrive one at a time and are keyed on a derived id, so a
        // delta replaces in place. This is the same shape `/v2/entries`
        // returns, so a client can seed from the route and stay live here.
        case "session.entry.updated": {
          const { sessionID, entry } = event.properties as {
            sessionID: string
            entry: SessionEntry
          }
          const entries = store.entry[sessionID]
          if (!entries) {
            setStore("entry", sessionID, [entry])
            break
          }
          const result = Binary.search(entries, entry.id, (e) => e.id)
          if (result.found) {
            setStore("entry", sessionID, result.index, reconcile(entry))
            break
          }
          setStore(
            "entry",
            sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, entry)
            }),
          )
          break
        }

        case "session.entry.removed": {
          const { sessionID, entryID } = event.properties as {
            sessionID: string
            entryID: string
          }
          const entries = store.entry[sessionID]
          if (!entries) break
          const result = Binary.search(entries, entryID, (e) => e.id)
          if (result.found)
            setStore(
              "entry",
              sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "lsp.updated": {
          if (features(store.config).requests.latestOnlyLspRefresh) {
            refreshLspDebounced()
          } else {
            void scopedClient()
              .lsp.status()
              .then((x) => setStore("lsp", x.data!))
              .catch(() => {})
          }
          break
        }
      }
    }

    // Backend events arrive in bursts while a turn streams; applying each one as it lands makes a
    // separate Solid update — and re-render — per event. Queue them and flush on a short timer
    // inside a single batch, preserving arrival order.
    const EVENT_FLUSH_MS = 10
    let queuedEvents: Array<Parameters<typeof applyEvent>[0]> = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined

    function flushEvents() {
      flushTimer = undefined
      if (queuedEvents.length === 0) return
      const pending = queuedEvents
      queuedEvents = []
      batch(() => {
        for (const event of pending) applyEvent(event)
      })
    }

    sdk.event.listen((e) => {
      queuedEvents.push(e)
      flushTimer ??= setTimeout(flushEvents, EVENT_FLUSH_MS)
    })

    onCleanup(() => {
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      flushTimer = undefined
      queuedEvents = []
    })

    // vcs.branch.updated is directory-scoped: with the global event stream we
    // receive branch updates from every instance (root + each worktree), so
    // only apply the one matching the currently displayed scope.
    sdk.onEnvelope(({ directory, payload }) => {
      if (payload.type !== "vcs.branch.updated") return
      if (directory && store.path.directory && directory !== store.path.directory) return
      setStore("vcs", { branch: payload.properties.branch })
    })

    const { exit } = useExit()
    const args = useArgs()

    async function refreshProviders() {
      // Refresh provider data without clearing session state
      const client = scopedClient()
      const [providerList, providerNext, providerAuth] = await Promise.all([
        client.config.providers({}, { throwOnError: true }),
        client.provider.list({}, { throwOnError: true }),
        client.provider.auth(),
      ])
      batch(() => {
        setStore("provider", reconcile(providerList.data!.providers))
        setStore("provider_default", reconcile(providerList.data!.default))
        setStore("provider_next", reconcile(providerNext.data!))
        setStore("provider_auth", reconcile(providerAuth.data ?? {}))
      })
    }

    let bootstrapVersion = 0

    async function bootstrap() {
      const version = ++bootstrapVersion
      const current = () => version === bootstrapVersion
      syncedSessions.clear()
      sessionLru.clear()
      setStore(
        produce((draft) => {
          draft.message = {}
          draft.part = {}
          draft.entry = {}
          draft.todo = {}
          draft.background_job = {}
          draft.monitor = {}
          draft.session_diff = {}
          draft.session_status = {}
          draft.session_pending = {}
          draft.session_instructions = {}
          draft.session_goal = {}
        }),
      )
      // Scoped to the current workspace (if any) so switching workspaces
      // re-fetches path/vcs/config/agents/sessions from the worktree instance.
      const client = scopedClient()
      const start = Date.now() - 30 * 24 * 60 * 60 * 1000
      const sessionListPromise = client.session.list({ start: start }).then((x) => {
        if (current()) setStore("session", reconcile((x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id))))
      })

      const fail = (label: string) => (error: unknown) => {
        const status =
          error instanceof Error &&
          typeof error.cause === "object" &&
          error.cause !== null &&
          "status" in error.cause &&
          typeof error.cause.status === "number"
            ? ` (HTTP ${error.cause.status})`
            : ""
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${label} failed: ${message}${status}`, { cause: error })
      }

      // blocking - include session.list when continuing a session.
      // GET /provider is the full models.dev catalog (~5MB) and is loaded
      // below without throwOnError so a 400/OOM there cannot kill the TUI.
      // GET /config/providers stays required for the model picker, but a 499/503
      // from an interrupted catalog build must not take the TUI down: retry,
      // then degrade to an empty list so the add-provider prompt still appears.
      const blockingRequests: Promise<unknown>[] = [
        retryTransient(() =>
          client.config.providers({}, { throwOnError: true }).then((x) => {
            if (!current()) return
            const providers = x.data!.providers
            const defaults = x.data!.default
            batch(() => {
              setStore("provider", reconcile(providers))
              setStore("provider_default", reconcile(defaults))
              setStore(
                "provider_next",
                reconcile({
                  all: providers,
                  default: defaults,
                  connected: providers.map((item) => item.id),
                }),
              )
            })
          }),
        ).catch((error) => {
          if (isTransientHttpInterrupt(error)) {
            Log.Default.warn("tui bootstrap GET /config/providers failed", {
              error: error instanceof Error ? error.message : String(error),
              status: clientErrorStatus(error),
            })
            return
          }
          fail("GET /config/providers")(error)
        }),
        retryTransient(() =>
          client.app
            .agents({}, { throwOnError: true })
            .then((x) => current() && setStore("agent", reconcile(x.data ?? []))),
        ).catch(fail("GET /agent")),
        retryTransient(() =>
          client.config
            .get({}, { throwOnError: true })
            .then((x) => current() && setStore("config", reconcile(x.data!))),
        ).catch(fail("GET /config")),
        ...(args.continue ? [sessionListPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(() => {
          if (!current()) return
          if (store.status !== "complete") setStore("status", "partial")
          // Best-effort, and settled rather than raced: `Promise.all` rejects on
          // the first failure, which left `status` pinned at `partial` even
          // though the other requests had already written their data. `partial`
          // gates the empty-provider prompt, so one unrelated endpoint being
          // down silently stopped a user with no provider from ever being asked
          // to add one. Which resources failed is now state, not a status.
          const optional: { name: string; run: Promise<unknown> }[] = [
            ...(args.continue ? [] : [{ name: "GET /session", run: sessionListPromise }]),
            {
              name: "GET /provider",
              run: client.provider.list().then((x) => {
                if (!current() || !x.data) return
                setStore("provider_next", reconcile(x.data))
              }),
            },
            {
              name: "GET /command",
              run: client.command.list().then((x) => current() && setStore("command", reconcile(x.data ?? []))),
            },
            {
              name: "GET /lsp",
              run: client.lsp.status().then((x) => current() && setStore("lsp", reconcile(x.data!))),
            },
            {
              name: "GET /mcp",
              run: client.mcp.status().then((x) => current() && setStore("mcp", reconcile(x.data!))),
            },
            {
              name: "GET /experimental/resource",
              run: client.experimental.resource
                .list()
                .then((x) => current() && setStore("mcp_resource", reconcile(x.data ?? {}))),
            },
            {
              name: "GET /connectors",
              run: client.connectors.status().then((x) => current() && setStore("connectors", reconcile(x.data!))),
            },
            {
              name: "GET /formatter",
              run: client.formatter.status().then((x) => current() && setStore("formatter", reconcile(x.data!))),
            },
            {
              name: "GET /session/status",
              run: client.session.status().then((x) => {
                if (!current()) return
                setStore("session_status", reconcile(x.data!))
              }),
            },
            {
              name: "GET /provider/auth",
              run: client.provider.auth().then((x) => current() && setStore("provider_auth", reconcile(x.data ?? {}))),
            },
            { name: "GET /vcs", run: client.vcs.get().then((x) => current() && setStore("vcs", reconcile(x.data))) },
            {
              name: "GET /path",
              run: client.path.get().then((x) => current() && setStore("path", reconcile(x.data!))),
            },
            { name: "project.sync", run: project.sync() },
            { name: "syncWorkspaces", run: syncWorkspaces() },
          ]
          void Promise.allSettled(optional.map((item) => item.run))
            .then((results) => {
              if (!current()) return
              const { failed, errors } = namedFailures(
                optional.map((item) => item.name),
                results,
              )
              if (failed.length > 0) Log.Default.warn("tui bootstrap optional refresh failed", { failed, errors })
              batch(() => {
                setStore("degraded", reconcile(failed))
                setStore("status", "complete")
              })
            })
            .catch((error) => {
              // Nothing above rejects, but an unhandled rejection here would
              // take down a TUI that is otherwise fine.
              Log.Default.error("tui bootstrap settle failed", {
                error: error instanceof Error ? error.message : String(error),
              })
            })
        })
        .catch(async (e) => {
          if (!current()) return
          Log.Default.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          await exit(e)
        })
    }

    onMount(() => {
      bootstrap()
    })

    /**
     * A reconnect resumes the live stream; it does not replay what was missed.
     *
     * The server feed is a live fan-out with a per-connection lag budget, not a
     * journal — there is no cursor to resume from. So while the SSE loop was
     * retrying, every event published on the other side was dropped, and
     * resuming the stream leaves the stores with a hole in the middle while the
     * UI reports "connected". Session parts, permission answers and job
     * completions all travel that way.
     *
     * Until there is a snapshot/watermark seam to resume against, the honest
     * recovery is the one EOT-04 prescribes: refetch, rather than assert a
     * lossless catch-up the transport cannot provide. `bootstrap` supersedes
     * itself through `bootstrapVersion`, so overlapping reconnects are safe.
     *
     * Only a transition through `reconnecting` triggers this. The first
     * `connecting` → `connected` is the initial connection, which `onMount`
     * above has already covered.
     */
    const reconnectGate = createReconnectGate()
    createEffect(
      on(
        () => sdk.connection.status(),
        (status) => {
          if (!reconnectGate.observe(status)) return
          Log.Default.info("tui reconnected; refetching state the live stream cannot replay")
          bootstrap()
        },
      ),
    )

    const syncedSessions = new Map<string, "partial" | "full">()

    // Bound the heavy per-session maps the store accumulates during long session-hopping.
    // See specs/effect-tui/05-reactive-state.md. The session being opened is touched
    // first (MRU) so it can never be a victim; sessions with active work, background jobs, or
    // that parent the active one are pinned. Re-opening an evicted session just re-runs sync().
    const sessionLru = createLru({ maxEntries: 25, ttlMs: 30 * 60_000 })
    function reapSessions(activeSessionID: string) {
      if (!features(store.config).tui.cacheEviction) return

      sessionLru.touch(activeSessionID)

      const pinned = new Set<string>([activeSessionID])
      const parentID = getSessionByID(activeSessionID)?.parentID
      if (parentID) pinned.add(parentID)
      for (const [sid, status] of Object.entries(store.session_status)) {
        if (status && status.type !== "idle") pinned.add(sid)
      }
      for (const sid of Object.keys(store.background_job)) {
        if ((store.background_job[sid] ?? []).length > 0) pinned.add(sid)
      }
      for (const sid of Object.keys(store.monitor)) {
        if ((store.monitor[sid] ?? []).some((m) => m.status === "running")) pinned.add(sid)
      }

      // evictExpired() is not pinning-aware, so re-touch any pinned-but-expired session to keep
      // it resident (e.g. a long-running streaming session with sparse events) and exclude all
      // pinned sessions from the final eviction set.
      const expired = sessionLru.evictExpired()
      for (const sid of expired) if (pinned.has(sid)) sessionLru.touch(sid)
      const evicted = [...new Set([...expired, ...sessionLru.evictOverflow(pinned)])].filter((sid) => !pinned.has(sid))
      if (evicted.length === 0) return
      setStore(
        produce((draft) => {
          for (const sid of evicted) {
            for (const message of draft.message[sid] ?? []) delete draft.part[message.id]
            delete draft.message[sid]
            delete draft.entry[sid]
            delete draft.session_diff[sid]
            delete draft.session_pending[sid]
            delete draft.todo[sid]
          }
        }),
      )
      for (const sid of evicted) syncedSessions.delete(sid)
    }

    async function refreshSessionPending(sessionID: string) {
      if (!sessionID) return []
      const pending = await sdk.client.session.pending({ sessionID })
      const items = pending.data ?? []
      setStore("session_pending", sessionID, reconcile(items))
      return items
    }

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        return store.status !== "loading"
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string, options?: { full?: boolean }) {
          // Refresh recency for the session being viewed (even on cache hit) and evict
          // least-recently-used sessions beyond the cap. The active session is MRU -> safe.
          reapSessions(sessionID)
          const mode = options?.full ? "full" : "partial"
          const existing = syncedSessions.get(sessionID)
          const cached = existing === "full" || existing === mode
          // A cache hit still refetches when the entries are missing: they are
          // what the session route draws from, and a session synced before
          // they were seeded would render empty.
          if (cached && store.entry[sessionID]) {
            void result.session.refreshPending(sessionID).catch(() => undefined)
            return result.session.get(sessionID)
          }
          // Entries ride along with the messages rather than being fetched by
          // whoever happens to render the session. This function is the one
          // seam every open path goes through — the tab switch, the tab
          // prefetch, a warp, a workspace create/attach, resuming a teleported
          // or backgrounded session — so seeding here is what guarantees there
          // is no path that opens a session with messages loaded and entries
          // missing.
          const [session, messages, todo, diff, backgroundJobs, goal, entries, pending] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            sdk.client.session.messages(options?.full ? { sessionID } : { sessionID, limit: 100 }),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
            sdk.client.session.background({ sessionID }).catch(() => undefined),
            sdk.client.session.goal({ sessionID }).catch(() => undefined),
            sdk.client.session.v2.entries({ sessionID }).catch(() => undefined),
            sdk.client.session.pending({ sessionID }).catch(() => undefined),
          ])
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = session.data!
              if (!match.found) draft.session.splice(match.index, 0, session.data!)
              draft.todo[sessionID] = todo.data ?? []
              draft.background_job[sessionID] = backgroundJobs?.data ?? []
              draft.message[sessionID] = messages.data!.map((x) => x.info)
              for (const message of messages.data!) {
                draft.part[message.info.id] = message.parts
              }
              draft.session_diff[sessionID] = diff.data ?? []
              if (goal?.data) draft.session_goal[sessionID] = goal.data as GoalState
              else delete draft.session_goal[sessionID]
              draft.entry[sessionID] = (entries?.data ?? []) as SessionEntry[]
              draft.session_pending[sessionID] = pending?.data ?? []
            }),
          )
          syncedSessions.set(sessionID, mode === "full" ? "full" : "partial")
          return session.data
        },
        async refreshDiff(sessionID: string) {
          if (!sessionID) return []
          const diff = await sdk.client.session.diff({ sessionID })
          const files = diff.data ?? []
          setStore("session_diff", sessionID, files)
          return files
        },
        pending(sessionID: string) {
          return store.session_pending[sessionID] ?? []
        },
        async refreshPending(sessionID: string) {
          return refreshSessionPending(sessionID)
        },
        async steerPending(sessionID: string, pendingID: string) {
          const result = await sdk.client.session.pendingSteer({ sessionID, pendingID }, { throwOnError: true })
          if (result.data) {
            setStore("session_pending", sessionID, (items) =>
              (items ?? []).map((item) => (item.id === result.data!.id ? result.data! : item)),
            )
          }
          void refreshSessionPending(sessionID).catch(() => undefined)
          return result.data
        },
      },
      background: {
        list(sessionID: string) {
          return store.background_job[sessionID] ?? []
        },
        get(sessionID: string, delegationID: string) {
          return (store.background_job[sessionID] ?? []).find((job) => job.rootDelegationID === delegationID)
        },
        findBySession(sessionID: string) {
          for (const jobs of Object.values(store.background_job)) {
            const match = jobs.find((job) => job.workerSessionID === sessionID || job.delegatorSessionID === sessionID)
            if (match) return match
          }
          return undefined
        },
        sync: refreshBackgroundJobs,
      },
      workspace: {
        get(workspaceID: string) {
          return store.workspaceList.find((workspace) => workspace.id === workspaceID)
        },
        sync: syncWorkspaces,
      },
      bootstrap,
      refreshProviders,
    }
    return result
  },
})
