import { Hono } from "hono"
import { DurableObject } from "cloudflare:workers"

type Env = {
  // Durable Object namespace: one instance per shared session (keyed by the
  // session short name) holds the synced session state and fans it out to
  // connected web viewers over WebSocket. Typed as the non-generic namespace
  // (and accessed through SyncServerStub) to avoid the deep Durable Object RPC
  // mapped types blowing up tsc (TS2589).
  SYNC_SERVER: DurableObjectNamespace
  // R2 bucket for durable storage of shared session JSON (survives DO eviction).
  Bucket: R2Bucket
  // Public web origin used to build share URLs, e.g. "nikcli-ai.dev".
  WEB_DOMAIN: string
  // Secret guarding the admin share-delete endpoint.
  ADMIN_SECRET: string
}

// The subset of SyncServer methods invoked over the DO stub.
interface SyncServerStub {
  share(sessionID: string): Promise<string>
  assertSecret(secret: string): Promise<void>
  clear(): Promise<void>
  publish(key: string, content: any): Promise<Response | void>
  getData(): Promise<Array<{ key: string; content: any }>>
  fetch(request: Request): Promise<Response>
}

// Resolve the SyncServer instance for a given share short name.
function open(ns: DurableObjectNamespace, name: string): SyncServerStub {
  return ns.get(ns.idFromName(name)) as unknown as SyncServerStub
}

/**
 * Share/sync hub for a single shared session.
 *
 * Mirrors opencode's `SyncServer` Durable Object: the nikcli CLI pushes session
 * info/message/part updates here via `/share_sync`, the DO persists them (DO
 * storage + R2) and broadcasts each update to subscribed web viewers over a
 * WebSocket. The session itself keeps running on the user's machine — this is
 * only the synchronization backend for the public `/s/:shareID` viewer.
 */
export class SyncServer extends DurableObject<Env> {
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  async fetch() {
    const webSocketPair = new WebSocketPair()
    const [client, server] = Object.values(webSocketPair)

    this.ctx.acceptWebSocket(server)

    // Replay the current session state to the freshly connected viewer.
    const data = await this.ctx.storage.list()
    Array.from(data.entries())
      .filter(([key]) => key.startsWith("session/"))
      .map(([key, content]) => server.send(JSON.stringify({ key, content })))

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {}

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    ws.close(code, "Durable Object is closing WebSocket")
  }

  async publish(key: string, content: any) {
    const sessionID = await this.getSessionID()
    if (
      !key.startsWith(`session/info/${sessionID}`) &&
      !key.startsWith(`session/message/${sessionID}/`) &&
      !key.startsWith(`session/part/${sessionID}/`)
    )
      return new Response("Error: Invalid key", { status: 400 })

    await this.env.Bucket.put(`share/${key}.json`, JSON.stringify(content), {
      httpMetadata: {
        contentType: "application/json",
      },
    })
    await this.ctx.storage.put(key, content)
    const clients = this.ctx.getWebSockets()
    for (const client of clients) {
      client.send(JSON.stringify({ key, content }))
    }
  }

  public async share(sessionID: string) {
    let secret = await this.getSecret()
    if (secret) return secret
    secret = crypto.randomUUID()

    await this.ctx.storage.put("secret", secret)
    await this.ctx.storage.put("sessionID", sessionID)

    return secret
  }

  public async getData() {
    const data = (await this.ctx.storage.list()) as Map<string, any>
    return Array.from(data.entries())
      .filter(([key]) => key.startsWith("session/"))
      .map(([key, content]) => ({ key, content }))
  }

  public async assertSecret(secret: string) {
    if (secret !== (await this.getSecret())) throw new Error("Invalid secret")
  }

  private async getSecret() {
    return this.ctx.storage.get<string>("secret")
  }

  private async getSessionID() {
    return this.ctx.storage.get<string>("sessionID")
  }

  async clear() {
    const sessionID = await this.getSessionID()
    const list = await this.env.Bucket.list({
      prefix: `session/message/${sessionID}/`,
      limit: 1000,
    })
    for (const item of list.objects) {
      await this.env.Bucket.delete(item.key)
    }
    await this.env.Bucket.delete(`session/info/${sessionID}`)
    await this.ctx.storage.deleteAll()
  }

  static shortName(id: string) {
    return id.substring(id.length - 8)
  }
}

// Routes are attached as separate statements (rather than one long fluent
// chain) to avoid Hono's accumulated chain generics tripping TS2589.
const app = new Hono<{ Bindings: Env }>()

app.get("/", (c) => c.text("API"))

app.post("/share_create", async (c) => {
  const body = await c.req.json<{ sessionID: string }>()
  const sessionID = body.sessionID
  const short = SyncServer.shortName(sessionID)
  const stub = open(c.env.SYNC_SERVER, short)
  const secret = await stub.share(sessionID)
  return c.json({
    secret,
    url: `https://${c.env.WEB_DOMAIN}/s/${short}`,
  })
})

app.post("/share_delete", async (c) => {
  const body = await c.req.json<{ sessionID: string; secret: string }>()
  const stub = open(c.env.SYNC_SERVER, SyncServer.shortName(body.sessionID))
  await stub.assertSecret(body.secret)
  await stub.clear()
  return c.json({})
})

app.post("/share_delete_admin", async (c) => {
  const body = await c.req.json<{ sessionShortName: string; adminSecret: string }>()
  if (body.adminSecret !== c.env.ADMIN_SECRET) throw new Error("Invalid admin secret")
  const stub = open(c.env.SYNC_SERVER, body.sessionShortName)
  await stub.clear()
  return c.json({})
})

app.post("/share_sync", async (c) => {
  const body = await c.req.json<{
    sessionID: string
    secret: string
    key: string
    content: any
  }>()
  const stub = open(c.env.SYNC_SERVER, SyncServer.shortName(body.sessionID))
  await stub.assertSecret(body.secret)
  await stub.publish(body.key, body.content)
  return c.json({})
})

app.get("/share_poll", async (c) => {
  const upgradeHeader = c.req.header("Upgrade")
  if (!upgradeHeader || upgradeHeader !== "websocket") {
    return c.text("Error: Upgrade header is required", { status: 426 })
  }
  const id = c.req.query("id")
  if (!id) return c.text("Error: Share ID is required", { status: 400 })
  const stub = open(c.env.SYNC_SERVER, id)
  return stub.fetch(c.req.raw)
})

app.get("/share_data", async (c) => {
  const id = c.req.query("id")
  if (!id) return c.text("Error: Share ID is required", { status: 400 })
  const stub = open(c.env.SYNC_SERVER, id)
  const data = await stub.getData()

  let info
  const messages: Record<string, any> = {}
  data.forEach((d) => {
    const [root, type] = d.key.split("/")
    if (root !== "session") return
    if (type === "info") {
      info = d.content
      return
    }
    if (type === "message") {
      messages[d.content.id] = {
        parts: [],
        ...d.content,
      }
    }
    if (type === "part") {
      messages[d.content.messageID].parts.push(d.content)
    }
  })

  return c.json({ info, messages })
})

app.all("*", (c) => c.text("Not Found"))

export default app
