import type { JsonValue } from "@/util/json"
import { and, eq, gt, sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiAuth } from "./security"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { GlobalBus } from "@nikcli-ai/util/global-bus"
import { Database } from "@/database/database"
import { MobileAuth } from "@/mobile/auth"
import { syncEvent, syncOutbox } from "@/sync/sync.sql"
import { SyncConfig } from "@/sync/sync-config"
import { Log } from "@nikcli-ai/util/log"
import { configUpdateGlobal } from "../mobile/helpers"
import { Auth } from "./auth"
import { EventFeed } from "./event-feed"

export namespace SyncHttpApi {
  const log = Log.create({ service: "server.sync" })
  const PUSH_WINDOW_MS = 60_000
  const PUSH_LIMIT_PER_WINDOW = 100
  const pushWindows = new Map<string, { windowStart: number; count: number }>()

  const SyncEventRecord = Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    workspaceId: Schema.optional(Schema.String),
    aggregate: Schema.String,
    seq: Schema.Int,
    type: Schema.String,
    data: Schema.Unknown,
    timestamp: Schema.Number,
    origin: Schema.optional(Schema.String),
    originSeq: Schema.optional(Schema.Number),
  }).annotate({ identifier: "SyncEventRecord" })

  const EventPushPayload = Schema.Struct({
    event: SyncEventRecord,
    projectID: Schema.String,
  }).annotate({ identifier: "SyncEventPushInput" })

  const OutboxQuery = Schema.Struct({
    projectID: Schema.String,
    since: Schema.optional(Schema.NumberFromString).annotate({
      description: "Return events with seq > since (default 0)",
    }),
  })

  const OutboxResponse = Schema.Struct({
    events: Schema.Array(Schema.Unknown),
    hasMore: Schema.Boolean,
  }).annotate({ identifier: "SyncOutboxResponse" })

  const SnapshotResponse = Schema.Struct({
    lastSeq: Schema.Number,
    state: Schema.Unknown,
  }).annotate({ identifier: "SyncSnapshotResponse" })

  const ConfigSetPayload = Schema.Struct({
    url: Schema.String,
    token: Schema.optional(Schema.String).annotate({
      description: "Omit to keep the token already saved in the config file",
    }),
    autostart: Schema.optional(Schema.Boolean),
  }).annotate({ identifier: "SyncConfigSetInput" })

  const ConfigSetResponse = Schema.Struct({
    configured: Schema.Boolean,
    url: Schema.optional(Schema.String),
    source: Schema.optional(Schema.Literals(["env", "config"])),
    started: Schema.Boolean,
    error: Schema.optional(Schema.String),
  }).annotate({ identifier: "SyncConfigSetResponse" })

  /** Shape returned by the raw `stats` handler below. */
  const StatsEvent = Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    workspaceId: Schema.optional(Schema.String),
    aggregate: Schema.String,
    seq: Schema.Number,
    type: Schema.String,
    timestamp: Schema.Number,
    origin: Schema.String,
    dataPreview: Schema.Unknown,
  }).annotate({ identifier: "SyncStatsEvent" })

  const StatsOutput = Schema.Struct({
    url: Schema.optional(Schema.String),
    configured: Schema.Boolean,
    source: Schema.String,
    connected: Schema.Boolean,
    pending: Schema.Number,
    failed: Schema.Number,
    total: Schema.Number,
    lastSeq: Schema.Number,
    lastError: Schema.optional(Schema.String),
    lastChange: Schema.Number,
    events: Schema.Array(StatsEvent),
  }).annotate({ identifier: "SyncStatsOutput" })

  const RateLimited = HttpApiSchema.WithHeaders(HttpApiSchema.Empty(429).annotate({ identifier: "SyncRateLimited" }), {
    "retry-after": Schema.NumberFromString,
  })

  const UnauthorizedChallenge = HttpApiSchema.WithHeaders(
    HttpApiSchema.Empty(401).annotate({ identifier: "UnauthorizedChallenge" }),
    { "www-authenticate": Schema.optional(Schema.String) },
  )

  export const Group = HttpApiGroup.make("sync")
    .add(
      HttpApiEndpoint.post("event", "/event", {
        payload: EventPushPayload,
        success: HttpApiSchema.NoContent,
        error: [RateLimited, UnauthorizedChallenge],
      }).annotate(OpenApi.Identifier, "sync.event.push"),
    )
    .add(
      HttpApiEndpoint.get("outbox", "/outbox", {
        query: OutboxQuery,
        success: OutboxResponse,
      }).annotate(OpenApi.Identifier, "sync.outbox.list"),
    )
    .add(
      HttpApiEndpoint.get("snapshot", "/snapshot/:aggregateID", {
        params: Schema.Struct({ aggregateID: Schema.String }),
        query: Schema.Struct({ projectID: Schema.String }),
        success: SnapshotResponse,
      }).annotate(OpenApi.Identifier, "sync.snapshot.get"),
    )
    .add(
      HttpApiEndpoint.get("stream", "/stream", {
        query: Schema.Struct({
          projectID: Schema.String,
          token: Schema.String.annotate({
            description: "Bearer token via query parameter — EventSource cannot send custom headers",
          }),
        }),
        success: HttpApiSchema.StreamSse({ data: Schema.Unknown }),
      }).annotate(OpenApi.Identifier, "sync.event.stream"),
    )
    .add(
      HttpApiEndpoint.get("stats", "/stats", {
        query: Schema.Struct({ projectID: Schema.optional(Schema.String) }),
        success: StatsOutput,
      }).annotate(OpenApi.Identifier, "sync.stats"),
    )
    .add(
      HttpApiEndpoint.post("config", "/config", {
        payload: ConfigSetPayload,
        success: ConfigSetResponse,
      }).annotate(OpenApi.Identifier, "sync.config.set"),
    )
    .add(
      HttpApiEndpoint.post("connect", "/connect", { success: HttpApiSchema.NoContent }).annotate(
        OpenApi.Identifier,
        "sync.connect",
      ),
    )
    .add(
      HttpApiEndpoint.post("disconnect", "/disconnect", { success: HttpApiSchema.NoContent }).annotate(
        OpenApi.Identifier,
        "sync.disconnect",
      ),
    )
    .add(
      HttpApiEndpoint.post("drain", "/drain", { success: HttpApiSchema.NoContent }).annotate(
        OpenApi.Identifier,
        "sync.drain",
      ),
    )
    .prefix("/sync")

  /** Handlers below build against this `Api`, so security is attached here —
   * see the note on `MobileHttpApi.Api` (H8). */
  export const Api = HttpApi.make("nikcli").add(Group.middleware(HttpApiAuth.Middleware))

  function pushAllowed(identity: string) {
    const now = Date.now()
    const window = pushWindows.get(identity)
    if (!window || now - window.windowStart >= PUSH_WINDOW_MS) {
      if (pushWindows.size > 1_000) {
        for (const [key, value] of pushWindows) {
          if (now - value.windowStart >= PUSH_WINDOW_MS) pushWindows.delete(key)
        }
      }
      pushWindows.set(identity, { windowStart: now, count: 1 })
      return { allowed: true, retryAfterMs: 0 }
    }
    if (window.count >= PUSH_LIMIT_PER_WINDOW) {
      return { allowed: false, retryAfterMs: window.windowStart + PUSH_WINDOW_MS - now }
    }
    window.count++
    return { allowed: true, retryAfterMs: 0 }
  }

  async function principal(request: Request) {
    return Auth.resolveBearer(request)
  }

  async function scopeDenied(request: Request): Promise<Response | undefined> {
    const resolved = await principal(request)
    if (resolved?.type !== "mobile") return
    const scope = resolved.token.scope ?? "mobile"
    if (MobileAuth.SYNC_SCOPES.has(scope as MobileAuth.Scope)) return
    log.warn("sync access denied: insufficient scope", {
      tokenID: resolved.token.id,
      scope,
      path: new URL(request.url).pathname,
    })
    return new Response("Forbidden: sync requires a mobile, cli-sync, or studio token", { status: 403 })
  }

  function raw(handler: (request: Request) => Promise<Response>) {
    return ({ request: serverRequest }: { readonly request: HttpServerRequest.HttpServerRequest }) =>
      Effect.gen(function* () {
        const request = serverRequest.source as Request
        const denied = yield* Effect.promise(() => scopeDenied(request))
        const response = denied ?? (yield* Effect.promise(() => handler(request)))
        return HttpServerResponse.fromWeb(response)
      })
  }

  const event = raw(async (request) => {
    const body = await decodeJson(EventPushPayload, request)
    if (body instanceof Response) return body
    const resolved = await principal(request)
    const token = resolved?.type === "mobile" ? resolved.token : undefined
    const identity = token?.id ?? "operator"
    const rate = pushAllowed(identity)
    if (!rate.allowed) {
      log.warn("sync push rate limited", { identity, path: new URL(request.url).pathname })
      return new Response("Rate limit exceeded", {
        status: 429,
        headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1_000)) },
      })
    }
    const existing = Effect.runSync(
      Database.query("SyncRoutes.ingest.existing", (db) =>
        db.select({ id: syncEvent.id }).from(syncEvent).where(eq(syncEvent.id, body.event.id)).get(),
      ),
    )
    if (existing) return new Response(null, { status: 204 })
    const inserted = Effect.runSync(
      Database.transaction((tx) =>
        Effect.sync(() => {
          const last = tx
            .select({ seq: syncEvent.seq })
            .from(syncEvent)
            .where(and(eq(syncEvent.projectId, body.event.projectId), eq(syncEvent.aggregate, body.event.aggregate)))
            .orderBy(syncEvent.seq)
            .all()
            .at(-1)
          const nextSeq = (last?.seq ?? 0) + 1
          tx.insert(syncEvent)
            .values({
              id: body.event.id,
              projectId: body.event.projectId,
              workspaceId: body.event.workspaceId,
              aggregate: body.event.aggregate,
              seq: nextSeq,
              type: body.event.type,
              data: JSON.stringify(body.event.data),
              timestamp: body.event.timestamp,
              origin: body.event.origin ?? "remote",
              originSeq: body.event.seq,
            })
            .run()
          return nextSeq
        }),
      ),
    )
    GlobalBus.emit("event", {
      directory: body.event.projectId,
      payload: { type: "sync.received", properties: { eventID: body.event.id, seq: inserted } },
    })
    log.info("remote event accepted", {
      eventID: body.event.id,
      seq: inserted,
      aggregate: body.event.aggregate,
      type: body.event.type,
      tokenID: token?.id ?? "operator",
      tokenName: token?.name,
    })
    return new Response(null, { status: 204 })
  })

  const outbox = raw(async (request) => {
    const url = new URL(request.url)
    const projectID = url.searchParams.get("projectID")
    if (!projectID) return new Response("Invalid query", { status: 400 })
    const since = Number(url.searchParams.get("since") ?? 0)
    if (!Number.isInteger(since) || since < 0) return new Response("Invalid query", { status: 400 })
    const rows = Effect.runSync(
      Database.query("SyncRoutes.since", (db) =>
        db
          .select()
          .from(syncEvent)
          .where(and(eq(syncEvent.projectId, projectID), gt(syncEvent.seq, since)))
          .orderBy(syncEvent.seq)
          .limit(500)
          .all(),
      ),
    )
    return Response.json({
      events: rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        workspaceId: row.workspaceId ?? undefined,
        aggregate: row.aggregate,
        seq: row.seq,
        type: row.type,
        data: safeJson(row.data),
        timestamp: row.timestamp,
        origin: row.origin,
        originSeq: row.originSeq ?? undefined,
      })),
      hasMore: rows.length === 500,
    })
  })

  const snapshot = raw(async (request) => {
    const url = new URL(request.url)
    const aggregateID = decodeURIComponent(url.pathname.slice("/sync/snapshot/".length))
    const projectID = url.searchParams.get("projectID")
    if (!projectID) return new Response("Invalid query", { status: 400 })
    const { SyncProjection } = await import("@/sync/projection")
    const result = await SyncProjection.byAggregate(projectID, aggregateID)
    return result ? Response.json(result) : new Response("Unsupported aggregate kind", { status: 400 })
  })

  const stats = raw(async (request) => {
    const projectID = new URL(request.url).searchParams.get("projectID") ?? ""
    const remote = await SyncConfig.resolve()
    const url = remote.url
    const { RemoteSync } = await import("@/sync/remote-sync")
    const connected = remote.configured && Boolean(url && RemoteSync.isActive({ url }))
    const lastError = formatHubError(url ? RemoteSync.lastHubError(url) : undefined)
    if (remote.configured && remote.autostart && url && remote.token && !connected) {
      const { SyncCliInit } = await import("@/sync/cli-init")
      void SyncCliInit.startForAllProjects({ url, token: remote.token }).catch((error) => {
        log.warn("sync autostart failed", { error })
      })
    }
    const counts = Effect.runSync(
      Database.query("SyncRoutes.stats.outbox", (db) => ({
        pending: db
          .select({ count: sql<number>`cast(count(*) as integer)` })
          .from(syncOutbox)
          .where(eq(syncOutbox.status, "pending"))
          .get(),
        failed: db
          .select({ count: sql<number>`cast(count(*) as integer)` })
          .from(syncOutbox)
          .where(eq(syncOutbox.status, "failed"))
          .get(),
      })),
    )
    const pending = counts.pending
    const failed = counts.failed
    const filterProjectID = await resolveStatsProjectID(projectID)
    const where = filterProjectID ? eq(syncEvent.projectId, filterProjectID) : undefined
    const events = Effect.runSync(
      Database.query("SyncRoutes.stats.events", (db) => {
        const latestQuery = db.select().from(syncEvent)
        const recentQuery = db.select().from(syncEvent)
        return {
          latest: (where ? latestQuery.where(where) : latestQuery)
            .orderBy(sql`${syncEvent.seq} DESC`)
            .limit(1)
            .get(),
          recent: (where ? recentQuery.where(where) : recentQuery)
            .orderBy(sql`${syncEvent.seq} DESC`)
            .limit(50)
            .all(),
        }
      }),
    )
    const latest = events.latest
    const recent = events.recent
    return Response.json({
      url,
      configured: remote.configured,
      source: remote.source,
      connected,
      pending: pending?.count ?? 0,
      failed: failed?.count ?? 0,
      total: (pending?.count ?? 0) + (failed?.count ?? 0),
      lastSeq: latest?.seq ?? 0,
      lastError,
      lastChange: Date.now(),
      events: recent.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        workspaceId: row.workspaceId ?? undefined,
        aggregate: row.aggregate,
        seq: row.seq,
        type: row.type,
        timestamp: row.timestamp,
        origin: row.origin,
        dataPreview: previewPayload(row.data),
      })),
    })
  })

  const config = raw(async (request) => {
    const body = await decodeJson(ConfigSetPayload, request)
    if (body instanceof Response) return body
    const url = normalizeHubUrl(body.url)
    if (!url) return new Response("Invalid hub URL", { status: 400 })
    const patch: { sync: { url: string; token?: string; autostart?: boolean } } = { sync: { url } }
    if (body.token) patch.sync.token = body.token
    patch.sync.autostart = body.autostart ?? true
    await configUpdateGlobal(patch)
    SyncConfig.invalidate()
    const resolved = await SyncConfig.resolve()
    let started = false
    let error: string | undefined
    if (resolved.configured) {
      try {
        const { SyncCliInit } = await import("@/sync/cli-init")
        const result = await SyncCliInit.startForAllProjects({ url: resolved.url!, token: resolved.token! })
        started = result.count > 0
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
    log.info("sync config saved from TUI", { url, configured: resolved.configured, started })
    return Response.json({
      configured: resolved.configured,
      url: resolved.url,
      source: resolved.source,
      started,
      error,
    })
  })

  const connect = raw(async () => {
    log.info("sync connect requested from TUI")
    const resolved = await SyncConfig.resolve()
    if (resolved.configured) {
      const { SyncCliInit } = await import("@/sync/cli-init")
      await SyncCliInit.startForAllProjects({ url: resolved.url!, token: resolved.token! }).catch((error) => {
        log.warn("sync connect failed", { error })
      })
    }
    return new Response(null, { status: 204 })
  })

  const noContent = (message: string) =>
    raw(async () => {
      log.info(message)
      return new Response(null, { status: 204 })
    })

  const SyncHandlers = HttpApiBuilder.group(Api, "sync", (handlers) =>
    handlers
      .handleRaw("event", event)
      .handleRaw("outbox", outbox)
      .handleRaw("snapshot", snapshot)
      .handleRaw("stream", raw(handleSse))
      .handleRaw("stats", stats)
      .handleRaw("config", config)
      .handleRaw("connect", connect)
      .handleRaw("disconnect", noContent("sync disconnect requested from TUI"))
      .handleRaw("drain", noContent("sync drain requested from TUI")),
  )

  /** The middleware implementation must be in scope while the group layer is
   * built — `HttpApiBuilder.group` captures the context it resolves middleware
   * from (H8). */
  export const HandlersLive = SyncHandlers.pipe(Layer.provide(HttpApiAuth.layer))

  const sseEncoder = new TextEncoder()
  const SSE_CONNECTED = sseEncoder.encode(": connected\n\n")
  const SSE_PING = sseEncoder.encode(": ping\n\n")

  export async function handleSse(request: Request): Promise<Response> {
    const denied = await scopeDenied(request)
    if (denied) return denied
    const projectID = new URL(request.url).searchParams.get("projectID") ?? ""
    const stream = EventFeed.filtered({
      signal: request.signal,
      envelope: (event) => event,
      greeting: SSE_CONNECTED,
      heartbeat: { frame: SSE_PING, intervalMs: 15_000 },
      encode: (value) => sseEncoder.encode(`event: sync\ndata: ${JSON.stringify(value)}\n\n`),
      subscribe(offer) {
        const handler = (raw: unknown) => {
          const envelope = raw as { directory?: string; payload?: { type?: string } }
          if (envelope?.directory === projectID) offer(envelope.payload, envelope.payload?.type)
        }
        GlobalBus.on("event", handler as never)
        return () => GlobalBus.off("event", handler as never)
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    })
  }

  function formatHubError(error: string | undefined) {
    if (!error) return undefined
    return error.includes("401") ? `${error} — check the token is valid on the hub` : error
  }

  async function resolveStatsProjectID(raw: string) {
    if (!raw) return ""
    if (!raw.includes("/") && !raw.includes("\\")) return raw
    try {
      const { Instance } = await import("@/project/instance")
      const { withInstanceAsync } = await import("@/effect")
      if (!Instance.has(raw)) return ""
      return await withInstanceAsync({ directory: raw }, async (instance) => instance.project.id)
    } catch {
      return ""
    }
  }

  function normalizeHubUrl(raw: string) {
    let value = raw.trim()
    if (!value) return undefined
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`
    try {
      const url = new URL(value)
      return (url.origin + url.pathname).replace(/\/+$/, "")
    } catch {
      return undefined
    }
  }

  function previewPayload(value: string) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") return parsed.type
      const result = JSON.stringify(parsed)
      return result.length > 80 ? result.slice(0, 79) + "…" : result
    } catch {
      return "raw"
    }
  }

  function safeJson(value: string): JsonValue {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  async function decodeJson<A>(schema: Schema.Decoder<A>, request: Request): Promise<A | Response> {
    try {
      return await Schema.decodeUnknownPromise(schema)(await request.json())
    } catch {
      return new Response("Invalid payload", { status: 400 })
    }
  }
}
