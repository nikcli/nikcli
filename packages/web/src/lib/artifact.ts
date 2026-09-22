import type { R2Bucket } from "@cloudflare/workers-types"
import { verifyAccessToken } from "@nikcli-ai/auth"

/** Public artifact metadata, returned once a viewer is authorized. */
export type ArtifactMeta = {
  id: string
  title: string
  description?: string
  filename: string
  contentType: string
  kind: ArtifactKind
  size: number
  version: number
  sessionID?: string
  /** nikcli-ai.dev user id of the publisher. */
  owner: string
  author?: string
  time: { created: number; updated: number }
}

export type ArtifactKind = "html" | "markdown" | "image" | "video" | "text"

/** Stored in R2 alongside the meta; secret/viewKey are never returned to viewers. */
export type StoredArtifact = ArtifactMeta & {
  /** Authorizes publishing new versions. */
  secret: string
  /** Capability for read access without a store login (mobile previews). */
  viewKey: string
}

export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024

/** Cookie the artifact viewer sets after a /user/login; same token space as Bearer auth. */
export const ARTIFACT_TOKEN_COOKIE = "nikcli_token"
export const DEFAULT_NIKCLI_AUTH_SERVER = "https://s.nikcli-ai.dev"

export function parseByteRange(value: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null

  const startText = match[1]
  const endText = match[2]
  if (!startText && !endText) return null

  if (!startText) {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    const length = Math.min(suffix, size)
    return { offset: size - length, length }
  }

  const offset = Number(startText)
  const requestedEnd = endText ? Number(endText) : size - 1
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd)) return null
  if (offset < 0 || offset >= size || requestedEnd < offset) return null
  const end = Math.min(requestedEnd, size - 1)
  return { offset, length: end - offset + 1 }
}

const KIND_BY_TYPE: Array<[RegExp, ArtifactKind]> = [
  [/^text\/html\b/, "html"],
  [/^text\/markdown\b/, "markdown"],
  [/^image\//, "image"],
  [/^video\//, "video"],
  [/^text\/plain\b/, "text"],
]

export function artifactKind(contentType: string): ArtifactKind | null {
  for (const [pattern, kind] of KIND_BY_TYPE) {
    if (pattern.test(contentType)) return kind
  }
  return null
}

function metaKey(id: string) {
  return `artifact/${id}/meta.json`
}

function contentKey(id: string, version: number) {
  return `artifact/${id}/v${version}`
}

function ownerKey(userId: string, id: string) {
  return `owner/${userId}/${id}`
}

export async function readArtifact(bucket: R2Bucket, id: string): Promise<StoredArtifact | null> {
  const object = await bucket.get(metaKey(id))
  if (!object) return null
  return (await object.json()) as StoredArtifact
}

export function publicMeta(stored: StoredArtifact): ArtifactMeta {
  const { secret: _secret, viewKey: _viewKey, ...meta } = stored
  return meta
}

/** Capability link the publisher should share — the bare `/artifact/{id}` page is login-gated. */
export function artifactShareUrl(id: string, viewKey: string, origin: string | URL): string {
  const url = new URL(`/artifact/${id}`, origin)
  url.searchParams.set("key", viewKey)
  return url.toString()
}

export async function readArtifactContent(bucket: R2Bucket, id: string, version: number) {
  return bucket.get(contentKey(id, version))
}

export async function headArtifactContent(bucket: R2Bucket, id: string, version: number) {
  return bucket.head(contentKey(id, version))
}

export async function readArtifactContentRange(
  bucket: R2Bucket,
  id: string,
  version: number,
  range: { offset: number; length: number },
) {
  return bucket.get(contentKey(id, version), { range })
}

export async function writeArtifact(bucket: R2Bucket, stored: StoredArtifact, content: ArrayBuffer): Promise<void> {
  await bucket.put(contentKey(stored.id, stored.version), content, {
    httpMetadata: { contentType: stored.contentType },
  })
  const metaJson = JSON.stringify(stored)
  await bucket.put(metaKey(stored.id), metaJson, {
    httpMetadata: { contentType: "application/json" },
  })
  // Owner index for "my artifacts" listings (public meta only). Anonymous
  // artifacts (owner "") are reachable only via their viewKey capability and
  // are never listed, so they get no index entry.
  if (stored.owner) {
    await bucket.put(ownerKey(stored.owner, stored.id), JSON.stringify(publicMeta(stored)), {
      httpMetadata: { contentType: "application/json" },
    })
  }
}

export async function listArtifactsByOwner(bucket: R2Bucket, userId: string): Promise<ArtifactMeta[]> {
  const listing = await bucket.list({ prefix: `owner/${userId}/`, limit: 200 })
  const metas: ArtifactMeta[] = []
  for (const object of listing.objects) {
    const item = await bucket.get(object.key)
    if (!item) continue
    metas.push((await item.json()) as ArtifactMeta)
  }
  metas.sort((a, b) => b.time.updated - a.time.updated)
  return metas
}

function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return cookies
}

/**
 * Validate a caller-supplied nikcli server URL (the `X-Nikcli-Server` header
 * the CLI sends). Identities are namespaced by that server's host, so callers
 * verifying against their own server can only claim identities under it.
 */
function callerAuthServer(request: Request): string | null {
  const header = request.headers.get("X-Nikcli-Server")
  if (!header) return null
  try {
    const url = new URL(header)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Resolve the logged-in nikcli user from a request, accepting the same
 * tokens the web app uses (`Authorization: Bearer` from /user/login) or the
 * viewer cookie set by the artifact login gate. The token is verified against
 * the caller's own nikcli server when `X-Nikcli-Server` names a reachable one,
 * falling back to the default auth server; the resulting id is namespaced by
 * the verifying server's host.
 */
export async function resolveViewerUserId(
  env: Pick<CloudflareEnv, "NIKCLI_AUTH_SERVER" | "AUTH_ISSUER" | "AUTH_AUDIENCE" | "AUTH_JWKS_URL">,
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const auth = request.headers.get("Authorization")
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null
  const cookie = parseCookies(request.headers.get("Cookie"))[ARTIFACT_TOKEN_COOKIE] ?? null
  const token = bearer ?? cookie
  if (!token) return null

  if (!token.startsWith("nku_")) {
    const issuer = env.AUTH_ISSUER ?? "https://auth.nikcli-ai.dev"
    try {
      const auth = await verifyAccessToken(token, {
        issuer,
        audience: env.AUTH_AUDIENCE ?? "nikcli-api",
        jwksUrl: env.AUTH_JWKS_URL ?? new URL("/.well-known/jwks.json", issuer).toString(),
      })
      return auth.accountID
    } catch {
      return null
    }
  }

  const authServer =
    callerAuthServer(request) ?? (env.NIKCLI_AUTH_SERVER || DEFAULT_NIKCLI_AUTH_SERVER).replace(/\/$/, "")
  try {
    const response = await fetcher(`${authServer}/user/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })
    if (!response.ok) return null
    const user = (await response.json()) as { id?: unknown }
    if (typeof user.id !== "string" || !user.id) return null
    return `${new URL(authServer).host}:${user.id}`
  } catch {
    return null
  }
}

/** Owner login or a valid view key grants read access. */
export function canViewArtifact(stored: StoredArtifact, viewer: { userId: string | null; key: string | null }) {
  if (viewer.key && viewer.key === stored.viewKey) return true
  if (viewer.userId && viewer.userId === stored.owner) return true
  return false
}

export function decodeBase64(value: string): ArrayBuffer | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  } catch {
    return null
  }
}

export function artifactJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  })
}

export type ArtifactPayload = {
  title?: unknown
  description?: unknown
  filename?: unknown
  contentType?: unknown
  content?: unknown
  sessionID?: unknown
  author?: unknown
}

export type ParsedArtifactPayload = {
  title: string
  description?: string
  filename: string
  contentType: string
  kind: ArtifactKind
  content: ArrayBuffer
  sessionID?: string
  author?: string
}

export function parseArtifactPayload(body: ArtifactPayload): ParsedArtifactPayload | { error: string } {
  const title = typeof body.title === "string" ? body.title.trim() : ""
  const filename = typeof body.filename === "string" ? body.filename.trim() : ""
  const contentType = typeof body.contentType === "string" ? body.contentType.trim().toLowerCase() : ""
  const rawContent = typeof body.content === "string" ? body.content : ""

  if (!title) return { error: "Missing title" }
  if (!filename) return { error: "Missing filename" }
  if (!contentType) return { error: "Missing contentType" }
  if (!rawContent) return { error: "Missing content" }

  const kind = artifactKind(contentType)
  if (!kind) return { error: `Unsupported contentType: ${contentType}` }

  const content = decodeBase64(rawContent)
  if (!content) return { error: "content must be base64-encoded" }
  if (content.byteLength > ARTIFACT_MAX_BYTES) {
    return { error: `Artifact exceeds ${ARTIFACT_MAX_BYTES} bytes` }
  }

  return {
    title: title.slice(0, 200),
    description: typeof body.description === "string" ? body.description.slice(0, 1000) : undefined,
    filename: filename.slice(0, 200),
    contentType,
    kind,
    content,
    sessionID: typeof body.sessionID === "string" ? body.sessionID.slice(0, 100) : undefined,
    author: typeof body.author === "string" ? body.author.slice(0, 100) : undefined,
  }
}
