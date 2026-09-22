import path from "path"
import { Effect } from "effect"
import { Log } from "@nikcli-ai/util/log"
import { UserDB } from "@/user/users"
import { UserSession } from "@nikcli-ai/util/user-session"
import { ArtifactRepo } from "./repo"

/**
 * Published artifacts — Claude-artifacts-style pages hosted on nikcli-ai.dev.
 *
 * The CLI publishes a local file (html/markdown/image/video) to the
 * nikcli-ai.dev worker (`POST /api/artifact`), which stores it in R2 and
 * serves it at `https://nikcli-ai.dev/artifact/{id}`. Publishing never asks
 * for a password: the active CLI user session (same `nku_` token as
 * /user/login, from src/user) binds ownership when the store can verify it
 * against this host's server; otherwise the publish is anonymous. Viewing
 * requires the owner's login or the artifact's viewKey capability, which the
 * CLI-printed link and the mobile app's inline previews use.
 */
export namespace Artifact {
  const log = Log.create({ service: "artifact" })

  export type Kind = "html" | "markdown" | "image" | "video" | "text"

  export type Info = {
    id: string
    title: string
    description?: string
    filename: string
    contentType: string
    kind: Kind
    url: string
    /** Read capability appended as ?key= for previews without a store login. */
    viewKey: string
    version: number
    sessionID: string
    size: number
    time: { created: number; updated: number }
  }

  type StoredRecord = Info & { secret: string }

  const MIME_BY_EXT: Record<string, string> = {
    ".html": "text/html",
    ".htm": "text/html",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
  }

  export const MAX_BYTES = 25 * 1024 * 1024

  export function contentTypeFor(filePath: string): string | undefined {
    return MIME_BY_EXT[path.extname(filePath).toLowerCase()]
  }

  export function kindFor(contentType: string): Kind {
    if (contentType.startsWith("text/html")) return "html"
    if (contentType.startsWith("text/markdown")) return "markdown"
    if (contentType.startsWith("image/")) return "image"
    if (contentType.startsWith("video/")) return "video"
    return "text"
  }

  export function baseUrl(): string {
    return (process.env["NIKCLI_ARTIFACT_URL"] ?? "https://nikcli-ai.dev").replace(/\/$/, "")
  }

  export function previewUrl(info: Pick<Info, "id" | "viewKey">): string {
    return `${baseUrl()}/artifact/${info.id}/raw?key=${encodeURIComponent(info.viewKey)}`
  }

  export function viewerUrl(info: Pick<Info, "url" | "viewKey">): string {
    if (!info.viewKey) return info.url
    const url = new URL(info.url)
    url.searchParams.set("key", info.viewKey)
    return url.toString()
  }

  /** The nikcli server whose UserDB is authoritative for artifact ownership. */
  export function authServerUrl(): string {
    return (
      process.env["NIKCLI_ARTIFACT_AUTH_SERVER"] ??
      process.env["NIKCLI_REMOTE_URL"] ??
      "https://s.nikcli-ai.dev"
    ).replace(/\/$/, "")
  }

  /**
   * Use the active CLI/TUI user session. Artifact auth never stores a second
   * credential, and it never blocks publishing: the store worker is the
   * authority on whether the token binds ownership, so local verification is
   * best-effort only (a DB hiccup must not strip the token).
   */
  export async function token(): Promise<string | undefined> {
    const env = process.env["NIKCLI_STORE_TOKEN"]
    if (env) return env
    const active = UserSession.getSync()
    if (!active) return undefined
    try {
      return Effect.runSync(UserDB.verifySession(active)) ? active : undefined
    } catch (error) {
      log.warn("local session verification unavailable, sending token anyway", { error })
      return active
    }
  }

  /** Display identity attached to anonymous publishes (best-effort). */
  function localAuthor(): string | undefined {
    try {
      const active = UserSession.getSync()
      if (!active) return undefined
      const user = Effect.runSync(UserDB.verifySession(active))
      return user ? user.email : undefined
    } catch {
      return undefined
    }
  }

  /** Resolve the active CLI identity; kept as a command-friendly status check. */
  export async function login(): Promise<{ token: string; user: UserDB.PublicUser }> {
    const active = UserSession.getSync()
    const user = active ? Effect.runSync(UserDB.verifySession(active)) : null
    if (!active || !user) throw new NotLoggedInError()
    return { token: active, user }
  }

  export async function logout(): Promise<void> {
    // Artifact publishing intentionally has no independent session to remove.
    // The canonical login is managed by the CLI/TUI UserDB account surface.
  }

  export class NotLoggedInError extends Error {
    constructor() {
      super(
        "No active CLI user. Sign in from the nikcli TUI account screen, then retry (or set NIKCLI_STORE_TOKEN for automation).",
      )
    }
  }

  type PublishInput = {
    sessionID: string
    title: string
    description?: string
    filename: string
    contentType: string
    content: Uint8Array
    /** When set, publishes a new version of the existing artifact. */
    artifactID?: string
  }

  type ApiResponse = {
    id?: string
    url?: string
    secret?: string
    viewKey?: string
    version?: number
    error?: string
  }

  export async function publish(input: PublishInput): Promise<Info> {
    if (input.content.byteLength > MAX_BYTES) {
      throw new Error(`Artifact exceeds the ${Math.floor(MAX_BYTES / 1024 / 1024)}MB limit`)
    }

    const body = {
      title: input.title,
      description: input.description,
      filename: input.filename,
      contentType: input.contentType,
      content: Buffer.from(input.content).toString("base64"),
      sessionID: input.sessionID,
    }

    if (input.artifactID) {
      const existing = await read(input.sessionID, input.artifactID)
      if (!existing) throw new Error(`Unknown artifact ${input.artifactID} for this session`)

      const response = await fetch(`${baseUrl()}/api/artifact/${encodeURIComponent(input.artifactID)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, secret: existing.secret }),
      })
      const payload = (await response.json().catch(() => ({}))) as ApiResponse
      if (!response.ok) throw new Error(payload.error ?? `Artifact update failed (${response.status})`)

      const next: StoredRecord = {
        ...existing,
        title: input.title,
        description: input.description ?? existing.description,
        filename: input.filename,
        contentType: input.contentType,
        kind: kindFor(input.contentType),
        url: viewerUrl({ url: payload.url ?? existing.url, viewKey: payload.viewKey ?? existing.viewKey }),
        viewKey: payload.viewKey ?? existing.viewKey,
        size: input.content.byteLength,
        version: payload.version ?? existing.version + 1,
        time: { ...existing.time, updated: Date.now() },
      }
      await write(next)
      log.info("artifact updated", { id: next.id, version: next.version })
      const { secret: _secret, ...info } = next
      return info
    }

    // Publishing never requires a password or a store login: without a token
    // the artifact is anonymous (readable only via its viewKey capability
    // link). A token from the local CLI user session binds ownership when the
    // store worker can verify it against this host's server.
    const storeToken = await token()
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (storeToken) {
      headers["Authorization"] = `Bearer ${storeToken}`
      headers["X-Nikcli-Server"] = authServerUrl()
    }

    const response = await fetch(`${baseUrl()}/api/artifact`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, author: localAuthor() }),
    })
    const payload = (await response.json().catch(() => ({}))) as ApiResponse
    if (!response.ok || !payload.id || !payload.url || !payload.secret || !payload.viewKey) {
      throw new Error(payload.error ?? `Artifact publish failed (${response.status})`)
    }

    const now = Date.now()
    const record: StoredRecord = {
      id: payload.id,
      title: input.title,
      description: input.description,
      filename: input.filename,
      contentType: input.contentType,
      kind: kindFor(input.contentType),
      url: viewerUrl({ url: payload.url, viewKey: payload.viewKey }),
      viewKey: payload.viewKey,
      secret: payload.secret,
      version: payload.version ?? 1,
      sessionID: input.sessionID,
      size: input.content.byteLength,
      time: { created: now, updated: now },
    }
    await write(record)
    log.info("artifact published", { id: record.id, url: record.url })
    const { secret: _secret, ...info } = record
    return info
  }

  async function write(record: StoredRecord) {
    Effect.runSync(ArtifactRepo.upsert(record))
  }

  async function read(sessionID: string, artifactID: string): Promise<StoredRecord | undefined> {
    return Effect.runSync(ArtifactRepo.get(sessionID, artifactID))
  }

  /** Artifacts published from a session, newest first (secrets stripped). */
  export async function list(sessionID: string): Promise<Info[]> {
    return Effect.runSync(ArtifactRepo.list(sessionID)).map(({ secret: _secret, ...info }: StoredRecord) => info)
  }
}
