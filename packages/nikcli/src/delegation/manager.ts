import fs from "fs/promises"
import path from "path"
import z from "zod"
import { BackgroundRun } from "@/background/run"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Global } from "@nikcli-ai/util/global"
import { Monitor } from "@/monitor/manager"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Log } from "@nikcli-ai/util/log"
import { formatDuration } from "@nikcli-ai/util/loop-validation"
import { Effect, Schema } from "effect"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"

const DelegationCompletedEvent = BusEvent.schema(
  "delegation.completed",
  Schema.Struct({
    delegationID: Schema.String,
    parentSessionID: Schema.String,
    status: Schema.Literals(["running", "complete", "error", "timeout", "cancelled", "orphaned"]),
    title: Schema.String,
  }),
)

export namespace Delegation {
  const log = Log.create({ service: "delegation" })

  function runSessionPrompt<A, E>(effect: Effect.Effect<A, E, SessionPrompt.Service>) {
    return runPromiseWithLayer(SessionPrompt.defaultLayer, withCurrentInstance(effect))
  }

  function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>) {
    return runPromiseWithLayer(Session.defaultLayer, withCurrentInstance(effect))
  }

  export const Status = z.enum(["running", "complete", "error", "timeout", "cancelled", "orphaned"])
  export type Status = z.infer<typeof Status>
  export type Record = BackgroundRun.Record
  export const Event = {
    Completed: DelegationCompletedEvent,
  }

  export interface ListItem {
    id: string
    status: Status
    title: string
    agent: string
    parentAgent?: string
    description?: string
  }

  export interface InspectResult {
    id: string
    status: Status
    title: string
    agent: string
    parentAgent?: string
    source?: BackgroundRun.Source
    prompt: string
    parentSessionID: string
    sessionID?: string
    delegatorID?: string
    delegatorSessionID?: string
    createdAt: number
    updatedAt: number
    completedAt?: number
    lastActivityAt?: number
    progressSummary?: string
    resultSummary?: string
    error?: string
    metadata?: { [key: string]: unknown }
  }

  const MINUTE = 60 * 1000

  /**
   * How long a running delegation is given before it is declared dead.
   *
   * A single fixed deadline cannot tell "still working" from "leaked": it kills
   * a healthy long task at the same minute it kills a hung one. So a delegation
   * is judged on three numbers instead:
   *
   * - `min` — floor. Never expired before this, even with zero output.
   * - `idle` — after `min`, this much silence means stuck, not slow.
   * - `max` — ceiling. Expired even while it is actively streaming.
   *
   * "Activity" is a progress signal ({@link updateProgress}, fed by the
   * subagent's own parts) — deliberately NOT the lease heartbeat, which only
   * proves the owning process is alive and would keep a leaked delegation on
   * life support forever.
   */
  interface TimeoutPolicy {
    min: number
    idle: number
    max: number
  }

  const TIMEOUT_POLICIES: { [key: string]: TimeoutPolicy } = {
    default: { min: 15 * MINUTE, idle: 5 * MINUTE, max: 60 * MINUTE },
    task: { min: 30 * MINUTE, idle: 10 * MINUTE, max: 120 * MINUTE },
    "model-subtask": { min: 10 * MINUTE, idle: 3 * MINUTE, max: 40 * MINUTE },
    research: { min: 20 * MINUTE, idle: 5 * MINUTE, max: 80 * MINUTE },
    advisor: { min: 5 * MINUTE, idle: 2 * MINUTE, max: 20 * MINUTE },
    ultrareview: { min: 15 * MINUTE, idle: 5 * MINUTE, max: 60 * MINUTE },
    delegator: { min: 10 * MINUTE, idle: 3 * MINUTE, max: 40 * MINUTE },
    "delegator-followup": { min: 10 * MINUTE, idle: 3 * MINUTE, max: 40 * MINUTE },
    other: { min: 10 * MINUTE, idle: 3 * MINUTE, max: 40 * MINUTE },
  }

  /** The longest any delegation can run, so waiters outlive the work they wait on. */
  const WAIT_SETTLED_TIMEOUT_MS = Math.max(...Object.values(TIMEOUT_POLICIES).map((policy) => policy.max))

  // Configuration constants
  const FORCE_FINALIZE_DELAY_MS = 1000
  const MIN_HEARTBEAT_INTERVAL_MS = 1000
  /** Upper bound on the watchdog poll; short policies (tests, overrides) tick faster. */
  const MAX_WATCHDOG_TICK_MS = 15_000
  const MIN_WATCHDOG_TICK_MS = 100
  const Source = z.enum([
    "task",
    "model-subtask",
    "advisor",
    "research",
    "ultrareview",
    "delegator",
    "delegator-followup",
    "other",
  ])
  const Role = z.enum(["worker", "delegator", "followup", "advisor", "other"])

  // Input validation schema
  const CreateParamsSchema = z.object({
    parentSessionID: z.string().min(1, "parentSessionID is required"),
    agent: z.string().min(1, "agent is required"),
    parentAgent: z.string().min(1, "parentAgent is required").optional(),
    prompt: z.string().min(1, "prompt is required"),
    session: z
      .object({
        id: z.string().min(1),
        directory: z.string(),
        workspaceID: z.string(),
      })
      .optional(),
    source: Source.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    delegatorID: z.string().optional(),
    delegatorSessionID: z.string().optional(),
    delegatorEnabled: z.boolean().optional(),
    jobID: z.string().optional(),
    rootDelegationID: z.string().optional(),
    parentDelegationID: z.string().optional(),
    role: Role.optional(),
    /** Per-delegation override of the source's {@link TimeoutPolicy}. */
    timeout: z
      .object({
        minMs: z.number().int().positive().optional(),
        idleMs: z.number().int().positive().optional(),
        maxMs: z.number().int().positive().optional(),
      })
      .optional(),
  })
  type CreateParams = z.infer<typeof CreateParamsSchema>
  type TimeoutOverride = NonNullable<CreateParams["timeout"]>

  function resolvePolicy(source: string | undefined, override: TimeoutOverride | undefined): TimeoutPolicy {
    const base = (source ? TIMEOUT_POLICIES[source] : undefined) ?? TIMEOUT_POLICIES.default!
    const min = Math.max(1, override?.minMs ?? base.min)
    const idle = Math.max(1, override?.idleMs ?? base.idle)
    // A `max` below `min` would defeat the floor, so the floor wins.
    const max = Math.max(min, override?.maxMs ?? base.max)
    return { min, idle, max }
  }

  export function buildParentWakePromptInput(
    parentSessionID: string,
    result: {
      jobId: string
      delegationId: string
      delegatorDelegationId: string
      description: string
      status: string
      summary: string
      parentAgent?: string
      parentModel: {
        modelID: string
        providerID: string
      }
    },
  ) {
    return BackgroundRun.buildParentWakePromptInput(parentSessionID, result)
  }

  export interface SynthesisItem {
    id: string
    status: Status
    title: string
    agent: string
    parentAgent?: string
    source?: BackgroundRun.Source
    resultSummary?: string
    progressSummary?: string
    error?: string
    metadata?: { [key: string]: unknown }
  }

  export type JobStatus = Status | "synthesizing"

  export interface JobItem {
    jobID: string
    rootDelegationID: string
    parentSessionID: string
    title: string
    agent: string
    parentAgent?: string
    status: JobStatus
    source?: BackgroundRun.Source
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

  /** Live supervision state for one running delegation. See {@link TimeoutPolicy}. */
  interface Watchdog {
    policy: TimeoutPolicy
    startedAt: number
    lastActivityAt: number
    /** When the current silent stretch began; unset while the delegation is producing output. */
    stalledSince?: number
    timer: NodeJS.Timeout
  }

  interface ManagerState {
    activeDelegations: Map<string, Record>
    sessionToDelegation: Map<string, string>
    timers: Map<string, NodeJS.Timeout>
    heartbeats: Map<string, NodeJS.Timeout>
    watchdogs: Map<string, Watchdog>
    requestedFinalizations: Map<string, { status: Exclude<Status, "running" | "orphaned">; error?: string }>
    reconcileTimer?: NodeJS.Timeout
  }

  const state = Instance.state<ManagerState>(
    () => ({
      activeDelegations: new Map<string, Record>(),
      sessionToDelegation: new Map<string, string>(),
      timers: new Map<string, NodeJS.Timeout>(),
      heartbeats: new Map<string, NodeJS.Timeout>(),
      watchdogs: new Map<string, Watchdog>(),
      requestedFinalizations: new Map<string, { status: Exclude<Status, "running" | "orphaned">; error?: string }>(),
      reconcileTimer: undefined,
    }),
    async (entry) => {
      for (const timer of entry.timers.values()) {
        clearTimeout(timer)
      }
      for (const timer of entry.heartbeats.values()) {
        clearInterval(timer)
      }
      for (const watchdog of entry.watchdogs.values()) {
        clearInterval(watchdog.timer)
      }
      if (entry.reconcileTimer) {
        clearInterval(entry.reconcileTimer)
      }
      entry.activeDelegations.clear()
      entry.sessionToDelegation.clear()
      entry.timers.clear()
      entry.heartbeats.clear()
      entry.watchdogs.clear()
      entry.requestedFinalizations.clear()
      entry.reconcileTimer = undefined
    },
  )

  function current() {
    return state()
  }

  function getDelegationsDir(parentSessionID: string): string {
    return path.join(Global.Path.data, "delegations", parentSessionID)
  }

  async function ensureDelegationsDir(parentSessionID: string): Promise<string> {
    const dir = getDelegationsDir(parentSessionID)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  function toInspectResult(record: Record): InspectResult {
    return {
      id: record.id,
      status: record.status,
      title: record.title,
      agent: record.agent,
      parentAgent: record.parentAgent,
      source: record.source,
      prompt: record.prompt,
      parentSessionID: record.parentSessionID,
      sessionID: record.sessionID,
      delegatorID: record.delegatorID,
      delegatorSessionID: record.delegatorSessionID,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      completedAt: record.completedAt,
      lastActivityAt: record.lastActivityAt,
      progressSummary: record.progressSummary,
      resultSummary: record.resultSummary,
      error: record.error,
      metadata: record.metadata,
    }
  }

  function hasAccess(record: Pick<Record, "parentSessionID" | "sessionID" | "delegatorSessionID">, sessionID: string) {
    return (
      record.parentSessionID === sessionID || record.sessionID === sessionID || record.delegatorSessionID === sessionID
    )
  }

  function projectJob(records: Record[]): JobItem | undefined {
    if (records.length === 0) return undefined
    const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt)
    const root = sorted.find((record) => record.id === BackgroundRun.getRootDelegationID(record)) ?? sorted[0]
    const worker =
      sorted.find(
        (record) =>
          BackgroundRun.getRole(record) === "worker" && record.id === BackgroundRun.getRootDelegationID(record),
      ) ??
      sorted.find((record) => BackgroundRun.getRole(record) === "worker") ??
      root
    const delegator = sorted.find((record) => BackgroundRun.getRole(record) === "delegator")
    const running = sorted.filter((record) => record.status === "running")
    const runningNonDelegators = running.filter((record) => BackgroundRun.getRole(record) !== "delegator")
    const latest = [...sorted].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const completedAt = Math.max(...sorted.map((record) => record.completedAt ?? 0)) || undefined
    const lastActivityAt = Math.max(...sorted.map((record) => record.lastActivityAt ?? 0)) || undefined
    const errorRecord = [...sorted].reverse().find((record) => record.error)
    const progressSummary =
      (delegator?.status === "running" ? delegator.progressSummary : undefined) ??
      latest.progressSummary ??
      worker.progressSummary ??
      delegator?.resultSummary ??
      worker.resultSummary
    const resultSummary = delegator?.resultSummary ?? worker.resultSummary
    const jobError = delegator?.error ?? errorRecord?.error

    let status: JobStatus
    if (delegator?.status === "running" && runningNonDelegators.length === 0) {
      status = "synthesizing"
    } else if (running.length > 0) {
      status = "running"
    } else if (delegator && delegator.status !== "running") {
      status = delegator.status
    } else {
      status = worker.status
    }

    // The ten optional members are spread in only when they have a value.
    // `DelegationJob` on the HTTP contract declares them `Schema.optionalKey`,
    // which rejects a *present* `undefined` at encode time — writing them
    // unconditionally answers 400 on `GET /session/:id/delegation`.
    return {
      jobID: BackgroundRun.getJobID(root),
      rootDelegationID: BackgroundRun.getRootDelegationID(root),
      parentSessionID: root.parentSessionID,
      title: worker.title,
      agent: worker.agent,
      ...(worker.parentAgent !== undefined && { parentAgent: worker.parentAgent }),
      status,
      ...(worker.source !== undefined && { source: worker.source }),
      ...(worker.sessionID !== undefined && { workerSessionID: worker.sessionID }),
      ...(worker.delegatorID !== undefined && { delegatorID: worker.delegatorID }),
      ...(worker.delegatorSessionID !== undefined && { delegatorSessionID: worker.delegatorSessionID }),
      createdAt: root.createdAt,
      updatedAt: latest.updatedAt,
      ...(completedAt !== undefined && { completedAt }),
      ...(lastActivityAt !== undefined && { lastActivityAt }),
      ...(progressSummary !== undefined && { progressSummary }),
      ...(resultSummary !== undefined && { resultSummary }),
      ...(jobError !== undefined && { error: jobError }),
    }
  }

  function cleanup(record: Pick<Record, "id" | "sessionID">): void {
    const entry = current()
    clearTimer(record.id)
    clearHeartbeat(record.id)
    clearWatchdog(record.id)
    entry.requestedFinalizations.delete(record.id)
    entry.activeDelegations.delete(record.id)
    if (record.sessionID && entry.sessionToDelegation.get(record.sessionID) === record.id) {
      entry.sessionToDelegation.delete(record.sessionID)
    }
  }

  function clearTimer(delegationID: string): void {
    const entry = current()
    const timer = entry.timers.get(delegationID)
    if (!timer) return
    clearTimeout(timer)
    entry.timers.delete(delegationID)
  }

  function clearHeartbeat(delegationID: string): void {
    const entry = current()
    const timer = entry.heartbeats.get(delegationID)
    if (!timer) return
    clearInterval(timer)
    entry.heartbeats.delete(delegationID)
  }

  function setHeartbeat(delegationID: string): void {
    const entry = current()
    clearHeartbeat(delegationID)
    const interval = Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(BackgroundRun.LEASE_TIMEOUT_MS / 3))
    const timer = setInterval(() => {
      void BackgroundRun.touchLease(delegationID).catch((error) => {
        log.warn("Failed to refresh delegation lease", {
          delegationID,
          error,
        })
      })
    }, interval)
    entry.heartbeats.set(delegationID, timer)
  }

  function requestFinalization(
    delegationID: string,
    status: Exclude<Status, "running" | "orphaned">,
    error?: string,
  ): void {
    const entry = current()
    if (!entry.activeDelegations.has(delegationID)) return
    entry.requestedFinalizations.set(delegationID, { status, error })
  }

  function scheduleForcedFinalize(
    delegationID: string,
    status: Exclude<Status, "running" | "orphaned">,
    error?: string,
    delayMs: number = FORCE_FINALIZE_DELAY_MS,
  ): void {
    const entry = current()
    clearTimer(delegationID)
    const timer = setTimeout(() => {
      void finalize(delegationID, status, "", error).catch((err) => {
        log.error(`Failed to force finalize delegation ${delegationID}: ${err}`)
      })
    }, delayMs)
    entry.timers.set(delegationID, timer)
  }

  function clearWatchdog(delegationID: string): void {
    const entry = current()
    const watchdog = entry.watchdogs.get(delegationID)
    if (!watchdog) return
    clearInterval(watchdog.timer)
    entry.watchdogs.delete(delegationID)
  }

  /**
   * Records that a delegation produced output. Resets the idle clock, which is
   * the only thing separating a slow delegation from a leaked one.
   */
  function touchActivity(delegationID: string): void {
    const watchdog = current().watchdogs.get(delegationID)
    if (!watchdog) return
    watchdog.lastActivityAt = Date.now()
    if (watchdog.stalledSince) {
      log.info("delegation resumed producing output", {
        delegationID,
        stalledFor: formatDuration(Date.now() - watchdog.stalledSince),
      })
      watchdog.stalledSince = undefined
    }
  }

  function setWatchdog(delegationID: string, policy: TimeoutPolicy): void {
    const entry = current()
    clearWatchdog(delegationID)
    const now = Date.now()
    const tick = Math.min(
      MAX_WATCHDOG_TICK_MS,
      Math.max(MIN_WATCHDOG_TICK_MS, Math.floor(Math.min(policy.idle, policy.max) / 4)),
    )
    const timer = setInterval(() => checkWatchdog(delegationID), tick)
    timer.unref?.()
    entry.watchdogs.set(delegationID, {
      policy,
      startedAt: now,
      lastActivityAt: now,
      timer,
    })
  }

  function checkWatchdog(delegationID: string): void {
    const entry = current()
    const watchdog = entry.watchdogs.get(delegationID)
    if (!watchdog) return
    if (!entry.activeDelegations.has(delegationID)) {
      clearWatchdog(delegationID)
      return
    }

    const now = Date.now()
    const elapsed = now - watchdog.startedAt
    const idleFor = now - watchdog.lastActivityAt
    const { policy } = watchdog

    if (idleFor >= policy.idle && !watchdog.stalledSince) {
      watchdog.stalledSince = watchdog.lastActivityAt
      log.warn("delegation stalled", {
        delegationID,
        idleFor: formatDuration(idleFor),
        elapsed: formatDuration(elapsed),
        // Not fatal yet: the floor still has to pass before we call it dead.
        expiresIn: formatDuration(Math.max(0, policy.min - elapsed)),
      })
    }

    // The floor is unconditional — a delegation always gets `min` wall clock,
    // silent or not. Past it, silence is what kills; output only buys time up
    // to the ceiling.
    if (elapsed >= policy.max) {
      expire(delegationID, `Timed out after ${formatDuration(elapsed)} (hard cap ${formatDuration(policy.max)})`)
      return
    }
    if (elapsed >= policy.min && idleFor >= policy.idle) {
      expire(delegationID, `Timed out after ${formatDuration(elapsed)}: no output for ${formatDuration(idleFor)}`)
    }
  }

  function expire(delegationID: string, reason: string): void {
    clearWatchdog(delegationID)
    try {
      const record = current().activeDelegations.get(delegationID)
      log.warn("delegation timed out", { delegationID, reason })
      requestFinalization(delegationID, "timeout", reason)
      if (record?.sessionID) {
        void runSessionPrompt(
          Effect.gen(function* () {
            const sessionPrompt = yield* SessionPrompt.Service
            yield* sessionPrompt.cancel(record.sessionID!)
          }),
        ).catch((error) => {
          log.warn("failed to cancel session for timed out delegation", { delegationID, error })
        })
      }
      scheduleForcedFinalize(delegationID, "timeout", reason)
    } catch (err) {
      log.error(`Failed to finalize delegation ${delegationID} on timeout: ${err}`)
    }
  }

  export async function init() {
    const entry = current()
    await BackgroundRun.reconcileInterrupted(new Set(entry.activeDelegations.keys()))
    if (entry.reconcileTimer) return
    entry.reconcileTimer = setInterval(() => {
      void BackgroundRun.reconcileInterrupted(new Set(entry.activeDelegations.keys())).catch((error) => {
        log.warn("Failed to reconcile background runs", {
          error,
        })
      })
    }, BackgroundRun.LEASE_TIMEOUT_MS)
    entry.reconcileTimer.unref()
  }

  export async function create(params: CreateParams): Promise<Record> {
    const validated = CreateParamsSchema.parse(params)
    await ensureDelegationsDir(validated.parentSessionID)
    const entry = current()

    const record = await BackgroundRun.create({
      parentSessionID: validated.parentSessionID,
      agent: validated.agent,
      parentAgent: validated.parentAgent,
      prompt: validated.prompt,
      session: validated.session,
      source: validated.source,
      metadata: validated.metadata,
      delegatorID: validated.delegatorID,
      delegatorSessionID: validated.delegatorSessionID,
      delegatorEnabled: validated.delegatorEnabled,
      jobID: validated.jobID,
      rootDelegationID: validated.rootDelegationID,
      parentDelegationID: validated.parentDelegationID,
      role: validated.role,
    })

    entry.activeDelegations.set(record.id, record)
    const policy = resolvePolicy(validated.source, validated.timeout)
    setWatchdog(record.id, policy)
    setHeartbeat(record.id)

    log.info(`Created delegation ${record.id} for agent ${params.agent}`, {
      timeout: `${formatDuration(policy.min)}..${formatDuration(policy.max)}`,
      idle: formatDuration(policy.idle),
    })
    return record
  }

  /**
   * Re-arms the in-process machinery for a reopened run. Without it a resumed
   * delegation has no heartbeat and no stall watchdog, so the next sweep would
   * settle the very work we just restarted.
   */
  export function reattach(record: Record): void {
    const entry = current()
    entry.activeDelegations.set(record.id, record)
    if (record.sessionID) entry.sessionToDelegation.set(record.sessionID, record.id)
    setWatchdog(record.id, resolvePolicy(record.source, undefined))
    setHeartbeat(record.id)
  }

  export function setSessionID(delegationID: string, sessionID: string): void {
    const entry = current()
    const record = entry.activeDelegations.get(delegationID)
    if (record) {
      record.sessionID = sessionID
      entry.sessionToDelegation.set(sessionID, delegationID)
    }
    touchActivity(delegationID)

    void runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.get(sessionID)
      }),
    )
      .then((info) => BackgroundRun.updateSession(delegationID, info))
      .catch(() => {
        log.warn("Failed to attach session to background run", {
          delegationID,
          sessionID,
        })
      })
  }

  /**
   * Returns a delegation record from the in-memory active map only.
   * Use {@link inspect} / {@link getDurable} for cross-process / durable lookups.
   */
  export function getActive(id: string): Record | undefined {
    return current().activeDelegations.get(id)
  }

  /**
   * Returns a delegation record from durable storage, falling back to the
   * in-memory active map so callers get a consistent view across processes.
   */
  export async function getDurable(id: string): Promise<Record | undefined> {
    const persisted = await BackgroundRun.get(id).catch(() => undefined)
    if (persisted) return persisted
    return current().activeDelegations.get(id)
  }

  export function getBySessionID(sessionID: string): Record | undefined {
    const entry = current()
    const delegationID = entry.sessionToDelegation.get(sessionID)
    if (!delegationID) return undefined
    return entry.activeDelegations.get(delegationID)
  }

  export async function finalize(
    delegationID: string,
    status: Status,
    result: string,
    error?: string,
    metadata?: { [key: string]: unknown },
  ): Promise<void> {
    const entry = current()
    const active = entry.activeDelegations.get(delegationID)
    const persisted = await BackgroundRun.get(delegationID).catch(() => undefined)
    if (!persisted || persisted.status !== "running") return

    const requested = entry.requestedFinalizations.get(delegationID)
    const finalStatus = requested?.status ?? status
    const finalError = requested?.error ?? error
    let finalized: Awaited<ReturnType<typeof BackgroundRun.finalize>>
    try {
      finalized = await BackgroundRun.finalize(delegationID, finalStatus, result, finalError, metadata)
      if (!finalized) return

      // Cleanup in-memory state BEFORE publishing event
      // so subscribers see consistent state
      cleanup(active ?? { id: delegationID, sessionID: persisted.sessionID })

      await Bus.publish(DelegationCompletedEvent, {
        delegationID: finalized.id,
        parentSessionID: finalized.parentSessionID,
        status: finalStatus,
        title: finalized.prompt.slice(0, 50),
      })

      log.info(`Finalized delegation ${delegationID} with status ${finalStatus}`)
    } catch (e) {
      // Cleanup even on error
      cleanup(active ?? { id: delegationID, sessionID: persisted.sessionID })
      throw e
    }
  }

  /**
   * Cheap in-memory liveness ping: "this delegation is still producing".
   * Callers that already throttle their durable {@link updateProgress} writes
   * use this on every event so the idle clock stays accurate without extra IO.
   */
  export function touch(delegationID: string): void {
    touchActivity(delegationID)
  }

  export async function updateProgress(delegationID: string, progressSummary?: string): Promise<void> {
    const active = current().activeDelegations.get(delegationID)
    if (active) {
      active.progressSummary = progressSummary
      active.lastActivityAt = Date.now()
    }
    touchActivity(delegationID)
    await BackgroundRun.updateProgress(delegationID, progressSummary)
  }

  /**
   * Attach the supervising delegator record's ID to a subagent delegation so
   * UIs and `inspect()` consumers can jump from a task record to its
   * synthesizing delegator without scanning every delegation.
   */
  export async function linkDelegator(delegationID: string, delegatorID: string): Promise<void> {
    const active = current().activeDelegations.get(delegationID)
    if (active) active.delegatorID = delegatorID
    await BackgroundRun.setDelegatorID(delegationID, delegatorID)
  }

  export async function inspect(delegationID: string): Promise<InspectResult | undefined> {
    const record = await BackgroundRun.get(delegationID).catch(() => undefined)
    if (!record) return undefined
    return toInspectResult(record)
  }

  async function resolveJobID(identifier: string): Promise<string | undefined> {
    const record = await BackgroundRun.get(identifier).catch(() => undefined)
    if (record) return BackgroundRun.getJobID(record)
    const matches = await BackgroundRun.listForJob(identifier)
    if (matches.length > 0) return identifier
    return undefined
  }

  export async function listJobs(parentSessionID: string): Promise<JobItem[]> {
    const groups = new Map<string, Record[]>()
    for (const record of await BackgroundRun.listForParent(parentSessionID)) {
      const jobID = BackgroundRun.getJobID(record)
      const list = groups.get(jobID)
      if (list) list.push(record)
      else groups.set(jobID, [record])
    }
    return [...groups.values()]
      .map((records) => projectJob(records))
      .filter((item): item is JobItem => Boolean(item))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  export async function inspectJob(identifier: string): Promise<JobItem | undefined> {
    const jobID = await resolveJobID(identifier)
    if (!jobID) return undefined
    return projectJob(await BackgroundRun.listForJob(jobID))
  }

  export async function inspectForSession(sessionID: string, delegationID: string): Promise<InspectResult | undefined> {
    const record = await BackgroundRun.get(delegationID).catch(() => undefined)
    if (!record || !hasAccess(record, sessionID)) return undefined
    return toInspectResult(record)
  }

  export async function inspectJobForSession(sessionID: string, identifier: string): Promise<JobItem | undefined> {
    const jobID = await resolveJobID(identifier)
    if (!jobID) return undefined
    const records = await BackgroundRun.listForJob(jobID)
    if (!records.some((record) => hasAccess(record, sessionID))) return undefined
    return projectJob(records)
  }

  export async function read(delegationID: string): Promise<string> {
    return BackgroundRun.readArtifact(delegationID)
  }

  async function resolveReadableRecordForJob(identifier: string): Promise<Record | undefined> {
    const jobID = await resolveJobID(identifier)
    if (!jobID) return undefined
    const records = await BackgroundRun.listForJob(jobID)
    return findPrimaryRecord(records)
  }

  function findPrimaryRecord(records: Record[]): Record | undefined {
    return (
      records.find((record) => BackgroundRun.getRole(record) === "delegator") ??
      records.find((record) => record.id === BackgroundRun.getRootDelegationID(record)) ??
      records[0]
    )
  }

  export async function readJob(identifier: string): Promise<string | undefined> {
    const record = await resolveReadableRecordForJob(identifier)
    if (!record) return undefined
    return BackgroundRun.readArtifact(record.id)
  }

  export async function readForSession(sessionID: string, delegationID: string): Promise<string | undefined> {
    const record = await BackgroundRun.get(delegationID).catch(() => undefined)
    if (!record || !hasAccess(record, sessionID)) return undefined
    return BackgroundRun.readArtifact(delegationID)
  }

  export async function readJobForSession(sessionID: string, identifier: string): Promise<string | undefined> {
    const jobID = await resolveJobID(identifier)
    if (!jobID) return undefined
    const records = await BackgroundRun.listForJob(jobID)
    if (!records.some((record) => hasAccess(record, sessionID))) return undefined
    const readable = findPrimaryRecord(records)
    if (!readable) return undefined
    return BackgroundRun.readArtifact(readable.id)
  }

  export async function list(parentSessionID: string): Promise<ListItem[]> {
    return (await BackgroundRun.listForParent(parentSessionID)).map((record) => ({
      id: record.id,
      status: record.status,
      title: record.title,
      agent: record.agent,
      parentAgent: record.parentAgent,
      description:
        typeof record.metadata?.question === "string"
          ? record.metadata.question
          : record.status === "running"
            ? "(running)"
            : undefined,
    }))
  }

  export async function findRunningForParent(
    parentSessionID: string,
    agent: string,
  ): Promise<InspectResult | undefined> {
    const record = (await BackgroundRun.listForParent(parentSessionID)).find(
      (item) => item.agent === agent && item.status === "running" && item.source !== "delegator",
    )
    return record ? toInspectResult(record) : undefined
  }

  export async function getRunningCount(parentSessionID: string): Promise<number> {
    return BackgroundRun.countRunningForParent(parentSessionID)
  }

  export async function cancel(delegationID: string): Promise<boolean> {
    const active = current().activeDelegations.get(delegationID)
    const persisted = await BackgroundRun.get(delegationID).catch(() => undefined)
    if (!persisted || persisted.status !== "running") return false

    requestFinalization(delegationID, "cancelled", "Cancelled")
    if (persisted.sessionID) {
      await runSessionPrompt(
        Effect.gen(function* () {
          const sessionPrompt = yield* SessionPrompt.Service
          yield* sessionPrompt.cancel(persisted.sessionID!)
        }),
      )
      await Monitor.cancelAll(persisted.sessionID)
    }

    if (active) {
      scheduleForcedFinalize(delegationID, "cancelled", "Cancelled")
      return true
    }

    await finalize(delegationID, "cancelled", persisted.resultSummary ?? "", "Cancelled")
    return true
  }

  export async function cancelJob(identifier: string): Promise<boolean> {
    const jobID = await resolveJobID(identifier)
    if (!jobID) return false
    const records = await BackgroundRun.listForJob(jobID)
    const running = records.filter((record) => record.status === "running")
    if (running.length === 0) return false
    const result = await Promise.all(running.map((record) => cancel(record.id)))
    return result.some(Boolean)
  }

  export async function cancelJobForSession(sessionID: string, identifier: string): Promise<boolean> {
    const jobID = await resolveJobID(identifier)
    if (!jobID) return false
    const records = await BackgroundRun.listForJob(jobID)
    if (!records.some((record) => hasAccess(record, sessionID))) return false
    return cancelJob(jobID)
  }

  /**
   * Restarts a single delegation the calling session can see. Unlike cancel,
   * this does not widen to the job tree: resuming one interrupted run is a
   * clear request, resuming a whole tree is not.
   */
  export async function resumeJobForSession(sessionID: string, delegationID: string): Promise<boolean> {
    const record = await BackgroundRun.get(delegationID).catch(() => undefined)
    if (!record || !hasAccess(record, sessionID)) return false
    // Lazy: the task tool imports this module, so a static import closes the cycle.
    const { resumeBackgroundDelegation } = await import("@/tool/task")
    return resumeBackgroundDelegation(delegationID)
  }

  export async function collectResults(parentSessionID: string): Promise<SynthesisItem[]> {
    return (await BackgroundRun.listForParent(parentSessionID))
      .filter((record) => record.source !== "delegator")
      .map((record) => ({
        id: record.id,
        status: record.status,
        title: record.title,
        agent: record.agent,
        parentAgent: record.parentAgent,
        source: record.source,
        resultSummary: record.resultSummary,
        progressSummary: record.progressSummary,
        error: record.error,
        metadata: record.metadata,
      }))
  }

  export async function collectResultsForJob(identifier: string): Promise<SynthesisItem[]> {
    const jobID = await resolveJobID(identifier)
    if (!jobID) return []
    return (await BackgroundRun.listForJob(jobID))
      .filter((record) => BackgroundRun.getRole(record) !== "delegator")
      .map((record) => ({
        id: record.id,
        status: record.status,
        title: record.title,
        agent: record.agent,
        parentAgent: record.parentAgent,
        source: record.source,
        resultSummary: record.resultSummary,
        progressSummary: record.progressSummary,
        error: record.error,
      }))
  }

  export async function waitForSettled(parentSessionID: string, timeoutMs = WAIT_SETTLED_TIMEOUT_MS): Promise<void> {
    const hasRunningDelegations = async () => {
      const records = await BackgroundRun.listForParent(parentSessionID)
      return records.some((record) => record.source !== "delegator" && record.status === "running")
    }

    if (!(await hasRunningDelegations())) return

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribeCompleted()
        unsubscribeDisposed()
        resolve()
      }

      const check = () => {
        void hasRunningDelegations()
          .then((running) => {
            if (!running) finish()
          })
          .catch((error) => {
            log.warn("failed to check running delegations", { parentSessionID, error })
          })
      }

      const timer = setTimeout(finish, timeoutMs)
      const unsubscribeCompleted = Bus.subscribe(Event.Completed, (event) => {
        if (event.properties.parentSessionID !== parentSessionID) return
        check()
      })
      const unsubscribeDisposed = Bus.subscribe(Bus.InstanceDisposed, () => {
        finish()
      })

      void check()
    })
  }

  /**
   * Reconcile all interrupted delegations for current instance.
   */
  export async function reconcileAll(): Promise<void> {
    const active = new Set(current().activeDelegations.keys())
    await BackgroundRun.reconcileInterrupted(active)
  }

  export async function waitForSettledJob(identifier: string, timeoutMs = WAIT_SETTLED_TIMEOUT_MS): Promise<void> {
    const jobID = await resolveJobID(identifier)
    if (!jobID) return

    const hasRunningDelegations = async () => {
      const records = await BackgroundRun.listForJob(jobID)
      return records.some((record) => BackgroundRun.getRole(record) !== "delegator" && record.status === "running")
    }

    if (!(await hasRunningDelegations())) return

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribeCompleted()
        unsubscribeDisposed()
        resolve()
      }

      const check = () => {
        void hasRunningDelegations()
          .then((running) => {
            if (!running) finish()
          })
          .catch((error) => {
            log.warn("failed to check running delegations", { jobID, error })
          })
      }

      const timer = setTimeout(finish, timeoutMs)
      const unsubscribeCompleted = Bus.subscribe(Event.Completed, (event) => {
        void resolveJobID(event.properties.delegationID).then((resolved) => {
          if (resolved !== jobID) return
          check()
        })
      })
      const unsubscribeDisposed = Bus.subscribe(Bus.InstanceDisposed, () => {
        finish()
      })

      void check()
    })
  }

  export async function cancelForSession(sessionID: string, delegationID: string): Promise<boolean> {
    const record = await BackgroundRun.get(delegationID).catch(() => undefined)
    if (!record || !hasAccess(record, sessionID)) return false
    return cancel(delegationID)
  }

  /**
   * Cancels every running delegation related to the given session (as parent,
   * worker, or delegator). Intended for explicit "cancel everything" flows.
   * HTTP handlers scoping to a single delegation should use {@link cancelOwnedBySessionID}.
   */
  export async function cancelBySessionID(sessionID: string): Promise<boolean> {
    const related = await BackgroundRun.listForRelatedSession(sessionID)
    const running = related.filter((item) => item.status === "running")
    if (running.length === 0) return false
    const result = await Promise.all(running.map((item) => cancel(item.id)))
    return result.some(Boolean)
  }

  /**
   * Cancels the single delegation that owns the given worker session, if any.
   * O(1) via the in-memory worker-session→delegation index; falls back to the
   * durable store when the delegation was created by another process.
   */
  export async function cancelOwnedBySessionID(sessionID: string): Promise<boolean> {
    const active = getBySessionID(sessionID)
    if (active) return cancelJob(active.id)
    const related = await BackgroundRun.listForRelatedSession(sessionID)
    const owned = related.find(
      (item) => (item.sessionID === sessionID || item.delegatorSessionID === sessionID) && item.status === "running",
    )
    if (!owned) return false
    return cancelJob(owned.id)
  }

  export function outputPreview(record: Pick<Record, "status" | "progressSummary" | "resultSummary">) {
    return BackgroundRun.outputPreview(record)
  }
}
