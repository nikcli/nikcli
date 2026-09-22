import { Hono } from "hono"
import { cors } from "hono/cors"
import z from "zod"
import { authenticateRequest, requireAuth } from "./auth"
import {
  appendMessage,
  deviceBelongsToUser,
  deleteSession,
  getSession,
  listDevices,
  listMessages,
  listSessions,
  pullSyncOperations,
  pushSyncOperations,
  recordSyncOperation,
  registerDevice,
  sessionBelongsToUser,
  upsertSession,
} from "./db"
import {
  DeviceRegistrationSchema,
  MessageCreateSchema,
  SessionUpsertSchema,
  SyncPullSchema,
  SyncPushSchema,
} from "./schema"
import { RelayRoom } from "./relay"
import type { CloudEnv } from "./types"

const app = new Hono<CloudEnv>()

type ErrorStatus = 400 | 401 | 403 | 404 | 409

function originMatchesList(origin: string, list: string[]) {
  return list.some((item) => item.toLowerCase() === origin.toLowerCase())
}

function defaultOriginAllowed(origin: string): boolean {
  if (origin.startsWith("http://localhost")) return true
  if (origin.startsWith("http://127.0.0.1")) return true
  if (origin.endsWith(".nikcli-ai.dev")) return true
  return false
}

app.use(
  "*",
  cors({
    credentials: false,
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    origin(origin, c) {
      if (!origin) return "*"

      const configured = c.env.ALLOWED_ORIGINS?.split(",")
        .map((item: string) => item.trim())
        .filter(Boolean)

      if (configured?.length && originMatchesList(origin, configured)) {
        return origin
      }

      if (defaultOriginAllowed(origin)) {
        return origin
      }

      return null
    },
  }),
)

function errorResponse(code: string, message: string, status: ErrorStatus, details?: unknown) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
    status,
  }
}

async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ success: true; data: T } | { success: false; error: unknown }> {
  const json = await request.json().catch(() => null)
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.flatten(),
    }
  }

  return {
    success: true,
    data: parsed.data,
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("")
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "nikcli-cloud",
    now: Date.now(),
  }),
)

app.get("/auth/me", requireAuth, async (c) => {
  const auth = c.get("auth")
  return c.json({
    userID: auth.userID,
    email: auth.email,
    claims: auth.claims,
  })
})

app.post("/auth/device/register", requireAuth, async (c) => {
  const body = await parseBody(c.req.raw, DeviceRegistrationSchema)
  if (!body.success) {
    const problem = errorResponse("VALIDATION_FAILED", "Invalid device registration payload", 400, body.error)
    return c.json(problem, problem.status)
  }

  const auth = c.get("auth")
  const device = await registerDevice(c.env.DB, auth, body.data).catch((error) => {
    if (error instanceof Error && error.message === "device_conflict") {
      return null
    }
    throw error
  })

  if (!device) {
    const problem = errorResponse("CONFLICT", "Device ID is already registered to another user", 409)
    return c.json(problem, problem.status)
  }

  return c.json({
    ok: true,
    device,
  })
})

app.get("/devices", requireAuth, async (c) => {
  const auth = c.get("auth")
  const devices = await listDevices(c.env.DB, auth.userID)
  return c.json({ devices })
})

app.get("/sessions", requireAuth, async (c) => {
  const auth = c.get("auth")
  const limit = clampInteger(c.req.query("limit"), 50, 1, 200)
  const sessions = await listSessions(c.env.DB, auth.userID, limit)
  return c.json({ sessions })
})

app.get("/sessions/:sessionID", requireAuth, async (c) => {
  const auth = c.get("auth")
  const session = await getSession(c.env.DB, auth.userID, c.req.param("sessionID"))
  if (!session) {
    const problem = errorResponse("NOT_FOUND", "Session not found", 404)
    return c.json(problem, problem.status)
  }

  return c.json({ session })
})

app.put("/sessions/:sessionID", requireAuth, async (c) => {
  const body = await parseBody(c.req.raw, SessionUpsertSchema)
  if (!body.success) {
    const problem = errorResponse("VALIDATION_FAILED", "Invalid session payload", 400, body.error)
    return c.json(problem, problem.status)
  }

  const auth = c.get("auth")
  const sessionID = c.req.param("sessionID")

  const session = await upsertSession(c.env.DB, auth.userID, sessionID, body.data).catch((error) => {
    if (error instanceof Error && error.message === "session_conflict") {
      return null
    }
    throw error
  })

  if (!session) {
    const problem = errorResponse("CONFLICT", "Session ID is already owned by another user", 409)
    return c.json(problem, problem.status)
  }

  const payload = JSON.stringify({
    title: session.title,
    directoryHash: session.directoryHash,
    encryptedState: session.encryptedState,
    syncVersion: session.syncVersion,
  })
  const hash = await sha256Hex(payload)

  await recordSyncOperation(c.env.DB, auth.userID, {
    sessionID,
    operation: "upsert",
    entityType: "session",
    entityID: sessionID,
    payload,
    hash,
    timestamp: Date.now(),
  })

  return c.json({ session })
})

app.delete("/sessions/:sessionID", requireAuth, async (c) => {
  const auth = c.get("auth")
  const sessionID = c.req.param("sessionID")
  const owned = await sessionBelongsToUser(c.env.DB, auth.userID, sessionID)

  if (!owned) {
    const problem = errorResponse("NOT_FOUND", "Session not found", 404)
    return c.json(problem, problem.status)
  }

  await recordSyncOperation(c.env.DB, auth.userID, {
    sessionID,
    operation: "delete",
    entityType: "session",
    entityID: sessionID,
    hash: await sha256Hex(`${sessionID}:delete:session`),
    timestamp: Date.now(),
  })

  await deleteSession(c.env.DB, auth.userID, sessionID)

  return c.json({ ok: true })
})

app.get("/sessions/:sessionID/messages", requireAuth, async (c) => {
  const auth = c.get("auth")
  const sessionID = c.req.param("sessionID")
  const owned = await sessionBelongsToUser(c.env.DB, auth.userID, sessionID)
  if (!owned) {
    const problem = errorResponse("NOT_FOUND", "Session not found", 404)
    return c.json(problem, problem.status)
  }

  const after = clampInteger(c.req.query("after"), 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = clampInteger(c.req.query("limit"), 200, 1, 1000)
  const messages = await listMessages(c.env.DB, auth.userID, sessionID, after, limit)

  return c.json({ messages })
})

app.post("/sessions/:sessionID/messages", requireAuth, async (c) => {
  const body = await parseBody(c.req.raw, MessageCreateSchema)
  if (!body.success) {
    const problem = errorResponse("VALIDATION_FAILED", "Invalid message payload", 400, body.error)
    return c.json(problem, problem.status)
  }

  const auth = c.get("auth")
  const sessionID = c.req.param("sessionID")

  const message = await appendMessage(c.env.DB, auth.userID, sessionID, body.data).catch((error) => {
    if (error instanceof Error && error.message === "session_not_found") {
      return null
    }
    if (error instanceof Error && error.message === "message_conflict") {
      return "conflict"
    }
    throw error
  })

  if (message === "conflict") {
    const problem = errorResponse("CONFLICT", "Message ID is already owned by another user", 409)
    return c.json(problem, problem.status)
  }

  if (!message) {
    const problem = errorResponse("NOT_FOUND", "Session not found", 404)
    return c.json(problem, problem.status)
  }

  const payload = JSON.stringify({
    role: message.role,
    encryptedContent: message.encryptedContent,
    createdAt: message.createdAt,
    syncVersion: message.syncVersion,
  })

  await recordSyncOperation(c.env.DB, auth.userID, {
    sessionID,
    deviceID: message.deviceID,
    operation: "upsert",
    entityType: "message",
    entityID: message.id,
    payload,
    hash: await sha256Hex(payload),
    timestamp: Date.now(),
  })

  return c.json({ message })
})

app.post("/sync/push", requireAuth, async (c) => {
  const body = await parseBody(c.req.raw, SyncPushSchema)
  if (!body.success) {
    const problem = errorResponse("VALIDATION_FAILED", "Invalid sync payload", 400, body.error)
    return c.json(problem, problem.status)
  }

  const auth = c.get("auth")
  const hasDevice = await deviceBelongsToUser(c.env.DB, auth.userID, body.data.deviceID)
  if (!hasDevice) {
    const problem = errorResponse("FORBIDDEN", "Unknown device for user", 403)
    return c.json(problem, problem.status)
  }

  const cursor = await pushSyncOperations(c.env.DB, auth.userID, body.data.deviceID, body.data.operations).catch(
    (error) => {
      if (error instanceof Error && error.message === "session_conflict") {
        return -1
      }
      throw error
    },
  )

  if (cursor < 0) {
    const problem = errorResponse("CONFLICT", "Sync operation references a session owned by another user", 409)
    return c.json(problem, problem.status)
  }

  return c.json({
    ok: true,
    applied: body.data.operations.length,
    cursor,
  })
})

app.post("/sync/pull", requireAuth, async (c) => {
  const body = await parseBody(c.req.raw, SyncPullSchema)
  if (!body.success) {
    const problem = errorResponse("VALIDATION_FAILED", "Invalid sync cursor payload", 400, body.error)
    return c.json(problem, problem.status)
  }

  const auth = c.get("auth")
  const result = await pullSyncOperations(c.env.DB, auth.userID, body.data.since, body.data.limit)

  return c.json({
    operations: result.operations,
    cursor: result.cursor,
  })
})

app.get("/relay/:sessionID", requireAuth, async (c) => {
  const auth = c.get("auth")
  const sessionID = c.req.param("sessionID")
  const owned = await sessionBelongsToUser(c.env.DB, auth.userID, sessionID)

  if (!owned) {
    const problem = errorResponse("NOT_FOUND", "Session not found", 404)
    return c.json(problem, problem.status)
  }

  return c.json({
    sessionID,
    websocket: true,
    instructions: "Use this endpoint with WebSocket upgrade and a bearer token",
  })
})

const worker: ExportedHandler<CloudEnv["Bindings"]> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const isRelayPath = /^\/relay\/.+/.test(url.pathname)
    const isWebSocket = request.headers.get("upgrade")?.toLowerCase() === "websocket"

    if (isRelayPath && isWebSocket) {
      const auth = await authenticateRequest(request, env, { allowQueryToken: true }).catch(() => null)
      if (!auth) {
        return new Response("Unauthorized", { status: 401 })
      }

      const sessionID = url.pathname.split("/")[2] || ""
      if (!sessionID) {
        return new Response("Missing session identifier", { status: 400 })
      }

      const owned = await sessionBelongsToUser(env.DB, auth.userID, sessionID)
      if (!owned) {
        return new Response("Session not found", { status: 404 })
      }

      const id = env.RELAY_ROOM.idFromName(`${auth.userID}:${sessionID}`)
      const stub = env.RELAY_ROOM.get(id)

      const headers = new Headers(request.headers)
      headers.set("x-nikcli-user-id", auth.userID)
      headers.set("x-nikcli-session-id", sessionID)
      const deviceID = url.searchParams.get("deviceID")
      if (!deviceID) {
        return new Response("Missing deviceID", { status: 400 })
      }

      const hasDevice = await deviceBelongsToUser(env.DB, auth.userID, deviceID)
      if (!hasDevice) {
        return new Response("Unknown device", { status: 403 })
      }
      headers.set("x-nikcli-device-id", deviceID)

      const forwarded = new Request(request, {
        headers,
      })

      return stub.fetch(forwarded)
    }

    return app.fetch(request, env, ctx)
  },
}

export default worker
export { RelayRoom }
