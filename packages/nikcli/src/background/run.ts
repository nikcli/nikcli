import fs from "fs/promises"
import path from "path"
import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator"
import { Global } from "@nikcli-ai/util/global"
import { Instance } from "@/project/instance"
import { SandboxRegistry } from "@/sandbox/registry"
import { Sandbox } from "@/sandbox/types"
import type { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Log } from "@nikcli-ai/util/log"
import { Effect, Schema } from "effect"
import { type DeepMutable, zod, zodObject } from "@nikcli-ai/util/effect-zod"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { BackgroundRunRepo } from "./repo"
import { LOOP_RUN_LEASE_MS } from "@/loop/schema"

export namespace BackgroundRun {
  const log = Log.create({ service: "background.run" })
  /** This process as a lease owner. The start stamp survives PID reuse, so a restart never inherits its predecessor's claim. */
  export const OWNER_ID = `${process.pid}-${Date.now()}`
  /**
   * EOT-09 lease source of truth.
   *
   * Loops and missions both lease an in-flight run to a process via the same
   * predicate. The single canonical value lives in `@/loop/schema` as
   * `LOOP_RUN_LEASE_MS`; BackgroundRun re-exports it so a future drift
   * cannot orphan one side and not the other. `Mission` already imports
   * `LOOP_RUN_LEASE_MS` directly per its own schema docblock.
   */
  export const LEASE_TIMEOUT_MS = LOOP_RUN_LEASE_MS
  type Metadata = { [key: string]: unknown }

  const StatusSchema = Schema.Literals(["running", "complete", "error", "timeout", "cancelled", "orphaned"])
  export const Status = zod(StatusSchema)
  export type Status = Schema.Schema.Type<typeof StatusSchema>

  /**
   * Statuses after which a run is settled. A terminal record is the durable
   * outcome of the job: nothing may reopen it, overwrite it with a second
   * outcome, or restart its lease.
   *
   * This is a named invariant rather than an inline `status !== "running"`
   * because the two only coincide while `running` is the sole non-terminal
   * state. Adding a `queued`/`starting` state to the schema would silently
   * make the inline check refuse to finalize a job that was never running,
   * while this one keeps meaning what it says.
   */
  export const TERMINAL_STATUSES: ReadonlySet<Status> = new Set<Status>([
    "complete",
    "error",
    "timeout",
    "cancelled",
    "orphaned",
  ])

  export function isTerminal(status: Status): boolean {
    return TERMINAL_STATUSES.has(status)
  }

  /** A run may move to a new status only while it is not already settled. */
  export function canTransition(from: Status, to: Status): boolean {
    if (isTerminal(from)) return false
    return from !== to
  }

  /**
   * Terminal statuses that mean "stopped without an answer", so restarting the
   * run is a repair rather than a second opinion. `cancelled` is absent by
   * design: the user stopping a task *is* its outcome.
   */
  export const RESUMABLE_STATUSES: ReadonlySet<Status> = new Set<Status>(["orphaned", "error", "timeout"])

  export function isResumable(status: Status): boolean {
    return RESUMABLE_STATUSES.has(status)
  }

  /** A run that takes nikcli down with it would otherwise restart forever. */
  export const MAX_RESUME_ATTEMPTS = 3

  /** Past this, an unattended restart stops being a recovery and becomes a surprise. */
  export const RESUME_WINDOW_MS = 60 * 60_000

  const SourceSchema = Schema.Literals([
    "task",
    "model-subtask",
    "advisor",
    "research",
    "ultrareview",
    "delegator",
    "delegator-followup",
    "loop",
    "other",
  ])
  export const Source = zod(SourceSchema)
  export type Source = Schema.Schema.Type<typeof SourceSchema>

  const RoleSchema = Schema.Literals(["worker", "delegator", "followup", "advisor", "other"])
  export const Role = zod(RoleSchema)
  export type Role = Schema.Schema.Type<typeof RoleSchema>

  const RecordSchema = Schema.Struct({
    id: Schema.String,
    sessionID: Schema.optional(Schema.String),
    parentSessionID: Schema.String,
    agent: Schema.String,
    parentAgent: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
    prompt: Schema.String,
    status: StatusSchema,
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    completedAt: Schema.optional(Schema.Number),
    artifactPath: Schema.String,
    title: Schema.String,
    workspaceID: Schema.optional(Schema.String),
    sandboxRef: Schema.optional(Sandbox.RefSchema),
    sandboxState: Schema.optional(Sandbox.StateSchema),
    source: Schema.optional(SourceSchema),
    resultSummary: Schema.optional(Schema.String),
    progressSummary: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    ownerID: Schema.optional(Schema.String),
    ownerPID: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
    heartbeatAt: Schema.optional(Schema.Number),
    lastActivityAt: Schema.optional(Schema.Number),
    // Delegator fields
    delegatorID: Schema.optional(Schema.String),
    delegatorSessionID: Schema.optional(Schema.String),
    delegatorEnabled: Schema.optional(Schema.Boolean),
    // Job tree fields
    jobID: Schema.optional(Schema.String),
    rootDelegationID: Schema.optional(Schema.String),
    parentDelegationID: Schema.optional(Schema.String),
    role: Schema.optional(RoleSchema),
    resumeCount: Schema.optional(Schema.Number),
  })
  export const Record = zodObject(RecordSchema)
  export type Record = DeepMutable<Schema.Schema.Type<typeof RecordSchema>>

  function generateID(): string {
    return uniqueNamesGenerator({
      dictionaries: [adjectives, colors, animals],
      separator: "-",
      length: 3,
      style: "lowerCase",
    })
  }

  /**
   * Generated names are only unique by chance, and the repository upserts: a
   * collision would silently overwrite another run's record and artifact.
   * Draw again while the name is taken; a handful of tries is plenty against a
   * dictionary of ~25 million names.
   */
  const ID_ATTEMPTS = 8

  function allocateID(): string {
    let id = generateID()
    for (let attempt = 1; attempt < ID_ATTEMPTS; attempt++) {
      if (!Effect.runSync(BackgroundRunRepo.get(projectID(), id))) return id
      id = generateID()
    }
    return id
  }

  /** R2 boundary: module funnel — one repo key for every export; threading would leave this file. */
  function projectID() {
    return Instance.project.id
  }

  /** One line, at most 50 characters: a multi-line prompt collapses to its words. */
  function titleOf(text: string) {
    return text
      .replace(/\s*\n\s*/g, " ")
      .trim()
      .slice(0, 50)
      .trim()
  }

  function missing(id: string): never {
    throw new Error(`Background run "${id}" not found.`)
  }

  function mutate(id: string, fn: (draft: Record) => void) {
    const updated = Effect.runSync(BackgroundRunRepo.update(projectID(), id, fn))
    if (!updated) missing(id)
    return updated
  }

  function directory(parentSessionID: string) {
    return path.join(Global.Path.data, "delegations", parentSessionID)
  }

  function artifactPath(parentSessionID: string, id: string) {
    return path.join(directory(parentSessionID), `${id}.md`)
  }

  function statusGlyph(status: Status) {
    if (status === "complete") return "✓"
    if (status === "error") return "✗"
    if (status === "timeout") return "⏰"
    if (status === "orphaned") return "!"
    return "-"
  }

  function metadataString(metadata: Metadata | undefined, key: string) {
    const value = metadata?.[key]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }

  function metadataNumber(metadata: Metadata | undefined, key: string) {
    const value = metadata?.[key]
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }

  function parseQuestion(prompt: string) {
    const explicit = prompt.match(/^Question:\s*(.+)$/im)?.[1]?.trim()
    if (explicit) return explicit
    const first = prompt
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
    return first?.slice(0, 200)
  }

  function extractSourceCount(text: string) {
    const matches = text.match(/https?:\/\/[^\s)\]]+/g) ?? []
    return new Set(matches).size
  }

  function extractConfidence(text: string) {
    return text.match(/^Confidence:\s*(.+)$/im)?.[1]?.trim()
  }

  function researchMetadata(record: Record, result: string, metadata?: Metadata) {
    const merged = {
      ...record.metadata,
      ...metadata,
    }
    if (record.agent !== "researcher" && merged.kind !== "research")
      return Object.keys(merged).length > 0 ? merged : undefined
    merged.kind = "research"
    merged.question = metadataString(merged, "question") ?? parseQuestion(record.prompt)
    merged.sourceCount = metadataNumber(merged, "sourceCount") ?? extractSourceCount(result)
    merged.confidence = metadataString(merged, "confidence") ?? extractConfidence(result)
    return merged
  }

  function renderMetadata(record: Record) {
    const metadata = record.metadata
    if (!metadata) return ""
    if (metadataString(metadata, "kind") !== "research" && record.agent !== "researcher") return ""
    const question = metadataString(metadata, "question")
    const confidence = metadataString(metadata, "confidence")
    const sourceCount = metadataNumber(metadata, "sourceCount")
    const followUpRounds = metadataNumber(metadata, "followUpRounds")
    return [
      question ? `**Question:** ${question}` : "",
      confidence ? `**Confidence:** ${confidence}` : "",
      typeof sourceCount === "number" ? `**Source Count:** ${sourceCount}` : "",
      typeof followUpRounds === "number" ? `**Follow-up Rounds:** ${followUpRounds}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  export function getRootDelegationID(record: Pick<Record, "id" | "rootDelegationID">) {
    return record.rootDelegationID ?? record.id
  }

  export function getJobID(record: Pick<Record, "id" | "jobID" | "rootDelegationID">) {
    return record.jobID ?? record.rootDelegationID ?? record.id
  }

  export function getRole(record: Pick<Record, "source" | "role">): Role {
    if (record.role) return record.role
    if (record.source === "delegator") return "delegator"
    if (record.source === "delegator-followup") return "followup"
    if (record.source === "advisor") return "advisor"
    return "worker"
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
    const allLines = result.summary.split("\n")
    const summaryLines = allLines.slice(0, 100).join("\n")
    const truncated = allLines.length > 100
    const lines = [
      `Background task "${result.description}" finished.`,
      `Status: ${result.status}`,
      `Job ID: ${result.jobId}`,
      "",
      "Result:",
      summaryLines,
      truncated ? "\n...(truncated)" : "",
      "",
      `Use delegation(action="read", delegationId="${result.delegatorDelegationId}") for the full result.`,
    ]

    return {
      sessionID: parentSessionID,
      delivery: "queue" as const,
      model: result.parentModel,
      ...(result.parentAgent ? { agent: result.parentAgent } : undefined),
      parts: [
        {
          type: "text" as const,
          text: lines.join("\n"),
        },
      ],
    }
  }

  async function ensureArtifactDirectory(parentSessionID: string) {
    const dir = directory(parentSessionID)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  function renderArtifact(record: Record, result = record.resultSummary ?? "", error = record.error) {
    const metadataBlock = renderMetadata(record)
    return `# ${statusGlyph(record.status)} ${record.title}

${record.prompt.slice(0, 200)}

**ID:** ${record.id}
**Job:** ${getJobID(record)}
**Root Delegation:** ${getRootDelegationID(record)}
**Role:** ${getRole(record)}
**Agent:** ${record.agent}
${record.parentAgent ? `**Parent Agent:** ${record.parentAgent}` : ""}
**Status:** ${record.status}
**Source:** ${record.source ?? "other"}
**Session:** ${record.sessionID ?? "N/A"}
**Started:** ${new Date(record.createdAt).toISOString()}
**Completed:** ${record.completedAt ? new Date(record.completedAt).toISOString() : "N/A"}
**Last Activity:** ${record.lastActivityAt ? new Date(record.lastActivityAt).toISOString() : "N/A"}
${record.progressSummary ? `**Progress:** ${record.progressSummary}` : ""}
${error ? `**Error:** ${error}` : ""}
${metadataBlock}

---

${result}
`
  }

  /**
   * Best effort. The record in the database is the outcome; the markdown file
   * is a rendering of it that {@link readArtifact} can rebuild on demand. A
   * full disk or a read-only data directory must not turn a finalized run back
   * into a failure for its caller — that would drop the parent wake-up while
   * the row already says the job is over.
   */
  async function persistArtifact(record: Record, result: string, error?: string) {
    try {
      await ensureArtifactDirectory(record.parentSessionID)
      await fs.writeFile(record.artifactPath, renderArtifact(record, result, error), "utf8")
      return true
    } catch (cause) {
      log.warn("failed to write background run artifact", {
        id: record.id,
        path: record.artifactPath,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return false
    }
  }

  export async function create(params: {
    parentSessionID: string
    agent: string
    parentAgent?: string
    prompt: string
    title?: string
    session?: Pick<Session.Info, "id" | "directory" | "workspaceID">
    source?: Source
    metadata?: Metadata
    delegatorID?: string
    delegatorSessionID?: string
    delegatorEnabled?: boolean
    jobID?: string
    rootDelegationID?: string
    parentDelegationID?: string
    role?: Role
  }): Promise<Record> {
    const id = allocateID()
    const rootDelegationID = params.rootDelegationID ?? id
    const jobID = params.jobID ?? rootDelegationID
    const record: Record = {
      id,
      sessionID: params.session?.id,
      parentSessionID: params.parentSessionID,
      agent: params.agent,
      parentAgent: params.parentAgent,
      prompt: params.prompt,
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      artifactPath: artifactPath(params.parentSessionID, id),
      title: titleOf(params.title ?? params.prompt) || id,
      workspaceID: params.session?.workspaceID,
      source: params.source,
      metadata: params.metadata,
      ownerID: OWNER_ID,
      ownerPID: process.pid,
      heartbeatAt: Date.now(),
      lastActivityAt: Date.now(),
      delegatorID: params.delegatorID,
      delegatorSessionID: params.delegatorSessionID,
      delegatorEnabled: params.delegatorEnabled,
      jobID,
      rootDelegationID,
      parentDelegationID: params.parentDelegationID,
      role: params.role ?? getRole({ source: params.source, role: undefined }),
    }

    if (params.session) {
      const sandbox = await SandboxRegistry.fromSession(params.session)
      record.sandboxRef = sandbox.ref
      record.sandboxState = sandbox.state
    }

    Effect.runSync(BackgroundRunRepo.upsert(projectID(), record))
    invalidateListCache()
    return record
  }

  export async function updateSession(id: string, session: Pick<Session.Info, "id" | "directory" | "workspaceID">) {
    const sandbox = await SandboxRegistry.fromSession(session)
    const updated = mutate(id, (draft) => {
      draft.sessionID = session.id
      draft.workspaceID = session.workspaceID
      draft.sandboxRef = sandbox.ref
      draft.sandboxState = sandbox.state
      draft.updatedAt = Date.now()
      draft.ownerID = OWNER_ID
      draft.ownerPID = process.pid
      draft.heartbeatAt = Date.now()
      draft.lastActivityAt = Date.now()
    })
    invalidateListCache()
    return updated
  }

  export async function touchLease(id: string) {
    return mutate(id, (draft) => {
      if (draft.status !== "running") return
      draft.ownerID = OWNER_ID
      draft.ownerPID = process.pid
      draft.heartbeatAt = Date.now()
      draft.updatedAt = Date.now()
    })
  }

  export async function updateProgress(id: string, progressSummary?: string) {
    const updated = mutate(id, (draft) => {
      if (isTerminal(draft.status)) return
      draft.progressSummary = progressSummary || undefined
      draft.lastActivityAt = Date.now()
      draft.updatedAt = Date.now()
      draft.ownerID = OWNER_ID
      draft.ownerPID = process.pid
      draft.heartbeatAt = Date.now()
    })
    invalidateListCache()
    return updated
  }

  export async function setDelegatorID(id: string, delegatorID: string) {
    const updated = mutate(id, (draft) => {
      draft.delegatorID = delegatorID
      draft.updatedAt = Date.now()
    })
    invalidateListCache()
    return updated
  }

  export async function get(id: string) {
    const record = Effect.runSync(BackgroundRunRepo.get(projectID(), id))
    if (!record) missing(id)
    return record
  }

  // Short-lived cache to avoid re-loading all records within a single logical operation.
  // Multiple list* calls in the same call chain (e.g. listJobs -> listForParent, then
  // projectJob -> listForJob) hit the cache instead of re-reading every row.
  //
  // Per instance, not per process. What it holds are the rows of one project id,
  // and one process drives many instances — the server runs a worktree per
  // session. As a module-level value it handed whichever project filled it first
  // to every other project for the next two seconds, and a mutation in one
  // project invalidated the cache of all of them. Every caller below already
  // stands in an instance scope: each is preceded by a repo call keyed on
  // `projectID()`.
  const listCache = Instance.state(() => ({
    value: undefined as { records: Record[]; expiresAt: number } | undefined,
  }))
  const LIST_CACHE_TTL_MS = 2_000

  async function listAll(): Promise<Record[]> {
    const cache = listCache()
    const now = Date.now()
    if (cache.value && now < cache.value.expiresAt) {
      return cache.value.records
    }
    const records = Effect.runSync(BackgroundRunRepo.list(projectID()))
    cache.value = { records, expiresAt: now + LIST_CACHE_TTL_MS }
    return records
  }

  /** Invalidate the list cache after a mutation (create, finalize, update). */
  function invalidateListCache() {
    listCache().value = undefined
  }

  async function filtered(predicate: (record: Record) => boolean): Promise<Record[]> {
    return (await listAll()).filter(predicate)
  }

  export async function listForParent(parentSessionID: string): Promise<Record[]> {
    return filtered((r) => r.parentSessionID === parentSessionID)
  }

  export async function listForJob(jobID: string): Promise<Record[]> {
    return filtered((r) => getJobID(r) === jobID)
  }

  export async function listForRelatedSession(sessionID: string): Promise<Record[]> {
    return filtered(
      (r) => r.parentSessionID === sessionID || r.sessionID === sessionID || r.delegatorSessionID === sessionID,
    )
  }

  export async function listRunning(): Promise<Record[]> {
    return Effect.runSync(BackgroundRunRepo.listRunning(projectID()))
  }

  export async function countRunningForParent(parentSessionID: string) {
    const records = await filtered((r) => r.parentSessionID === parentSessionID && r.status === "running")
    return records.length
  }

  export async function summarizeSession(sessionID: string, result?: MessageV2.WithParts) {
    const { Session } = await import("@/session")
    const messages = await runPromiseWithLayer(
      Session.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const session = yield* Session.Service
          return yield* session.messages({ sessionID })
        }),
      ),
    )
    const assistant =
      result?.info.role === "assistant"
        ? result
        : messages.findLast((item: MessageV2.WithParts) => item.info.role === "assistant")
    const text =
      assistant?.parts.findLast((part: MessageV2.Part): part is MessageV2.TextPart => part.type === "text")?.text ?? ""

    return {
      text,
      assistant: assistant?.info.role === "assistant" ? assistant.info : undefined,
    }
  }

  export async function finalize(id: string, status: Status, result: string, error?: string, metadata?: Metadata) {
    let finalized = false
    const record = mutate(id, (draft) => {
      if (!canTransition(draft.status, status)) return
      draft.status = status
      draft.updatedAt = Date.now()
      draft.completedAt = Date.now()
      draft.resultSummary = result || undefined
      draft.progressSummary = undefined
      draft.error = error
      draft.metadata = researchMetadata(draft, result, metadata)
      draft.heartbeatAt = Date.now()
      draft.lastActivityAt = Date.now()
      finalized = true
    })
    invalidateListCache()
    if (!finalized) return undefined
    await persistArtifact(record, result, error)
    return record
  }

  export async function finalizeFromSession(id: string) {
    const record = await get(id).catch(() => undefined)
    if (!record?.sessionID) return false

    const summary = await summarizeSession(record.sessionID)
    const error = summary.assistant?.error
    if (error) {
      const status: Status = MessageV2.AbortedError.isInstance(error) ? "cancelled" : "error"
      const message = "message" in error && typeof error.message === "string" ? error.message : undefined
      await finalize(id, status, summary.text, message)
      return true
    }

    const finish = summary.assistant?.finish
    if (!finish || ["tool-calls", "unknown"].includes(finish)) {
      return false
    }

    await finalize(id, "complete", summary.text)
    return true
  }

  export async function markOrphaned(id: string, reason = "Nikcli restarted before the background task completed.") {
    const record = await get(id)
    if (!leaseExpired(record)) return false
    let text = record.resultSummary ?? ""
    if (record.sessionID) {
      const summary = await summarizeSession(record.sessionID).catch(() => undefined)
      text = summary?.text ?? text
    }
    const finalized = await finalize(id, "orphaned", text, reason)
    return Boolean(finalized)
  }

  /**
   * Puts a run that stopped without an answer back under this process's lease so
   * its session can be driven again. The session is untouched, so the agent
   * resumes with its own prior work in context instead of starting over.
   */
  export async function reopen(id: string) {
    const record = await get(id)
    if (!isResumable(record.status)) return undefined
    if ((record.resumeCount ?? 0) >= MAX_RESUME_ATTEMPTS) return undefined
    const reopened = mutate(id, (draft) => {
      // Re-checked on the row the write sees: two processes recovering the
      // same project both read `orphaned` above, and only the first to get
      // here may take the run. The second finds it `running` and backs off.
      if (!isResumable(draft.status)) return
      if ((draft.resumeCount ?? 0) >= MAX_RESUME_ATTEMPTS) return
      draft.status = "running"
      draft.resumeCount = (draft.resumeCount ?? 0) + 1
      draft.completedAt = undefined
      draft.error = undefined
      draft.ownerID = OWNER_ID
      draft.ownerPID = process.pid
      draft.heartbeatAt = Date.now()
      draft.lastActivityAt = Date.now()
      draft.updatedAt = Date.now()
    })
    invalidateListCache()
    if (reopened.status !== "running" || reopened.ownerID !== OWNER_ID) return undefined
    return reopened
  }

  /**
   * Runs a fresh process may restart unattended: killed by a crash rather than
   * finished, recent enough to still be wanted, and not already retried to the
   * cap. Failures stay out — those are the user's call to retry.
   */
  export async function listAutoResumable(now = Date.now()): Promise<Record[]> {
    return filtered(
      (record) =>
        record.status === "orphaned" &&
        Boolean(record.sessionID) &&
        (record.resumeCount ?? 0) < MAX_RESUME_ATTEMPTS &&
        now - (record.completedAt ?? record.updatedAt) < RESUME_WINDOW_MS,
    )
  }

  export function leaseExpired(record: Pick<Record, "status" | "heartbeatAt" | "ownerID">, now = Date.now()) {
    if (record.status !== "running") return false
    if (!record.ownerID || !record.heartbeatAt) return true
    // The lease asks whether the owning process is gone, and for our own rows the
    // answer is no: this code is running. A heartbeat past the timeout then means
    // the interval was starved (CPU load, blocked event loop, machine suspended),
    // not that the work died. A run of ours that genuinely stops producing output
    // is the delegation stall watchdog's job, which settles it as `timeout`.
    if (record.ownerID === OWNER_ID) return false
    return now - record.heartbeatAt > LEASE_TIMEOUT_MS
  }

  export async function reconcileInterrupted(ignore = new Set<string>()) {
    const running = await listRunning()
    for (const record of running) {
      if (ignore.has(record.id)) continue
      if (!leaseExpired(record)) continue
      const finalized = await finalizeFromSession(record.id).catch((error) => {
        log.warn("failed to reconcile background run", {
          id: record.id,
          error,
        })
        return false
      })
      if (finalized) continue
      await markOrphaned(record.id).catch((error) => {
        log.warn("failed to orphan background run", {
          id: record.id,
          error,
        })
      })
    }
  }

  export async function readArtifact(id: string): Promise<string> {
    const record = await get(id).catch(() => undefined)
    if (!record) {
      throw new Error(`Delegation "${id}" not found.`)
    }

    try {
      return await fs.readFile(record.artifactPath, "utf8")
    } catch {
      return renderArtifact(record, record.resultSummary ?? record.progressSummary ?? "", record.error)
    }
  }

  export function outputPreview(record: Pick<Record, "status" | "progressSummary" | "resultSummary">) {
    if (record.status === "running") return record.progressSummary
    return record.resultSummary ?? record.progressSummary
  }
}
