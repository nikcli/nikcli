import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { createHash, randomBytes } from "node:crypto"
import z from "zod"
import { Global } from "@nikcli-ai/util/global"
import { Database } from "@/database/database"
import { mobileTokens } from "./auth.sql"

type RunResult = { changes: number; lastInsertRowid: number | bigint }
function getChanges(result: void | RunResult): number {
  // SAFETY: drizzle types `.run()` as returning void, but bun:sqlite always
  // returns `{ changes, lastInsertRowid }` at runtime. Callers only ever pass
  // the result of a `.run()` on this driver, so the void half of the union is
  // a typing artefact rather than a value that can reach here.
  return (result as RunResult).changes
}

export namespace MobileAuth {
  /**
   * Token scope: `mobile` (paired mobile device), `cli-sync` (CLI↔hub sync),
   * `studio` (desktop UI). `/sync/*` accepts any of these when a bearer
   * token or `?token=` query param is presented.
   */
  export const Scope = z.enum(["mobile", "cli-sync", "studio"])
  export type Scope = z.infer<typeof Scope>

  export const SYNC_SCOPES = new Set<Scope>(["mobile", "cli-sync", "studio"])

  /**
   * What a paired device is allowed to reach.
   *
   * `specs/effect-tui/19-mobile-companion-bridge.md` requirement 9: the bridge
   * advertises capabilities per device, and a device without one cannot use the
   * operation it guards — surfaced as a typed affordance, never a silent no-op.
   * A no-op is worse than a refusal here: the phone shows a button, the button
   * does nothing, and the user concludes the host is broken.
   */
  export const Capability = z.enum(["read", "write", "pty", "teleport", "git"])
  export type Capability = z.infer<typeof Capability>

  /**
   * Capabilities by scope.
   *
   * Derived from the scope rather than stored on the token: every existing
   * token would otherwise need a migration and a default, and the default is
   * exactly this table. Making them per-token is a later slice — the shape
   * below is what it would migrate *to*, so call sites written against `can`
   * do not change when it happens.
   *
   * `cli-sync` is a sync transport, not an operator: it moves journal rows and
   * has no business opening a pty or reading a working tree.
   */
  const CAPABILITIES: Readonly<Record<Scope, readonly Capability[]>> = {
    mobile: ["read", "write", "pty", "teleport", "git"],
    studio: ["read", "write", "git"],
    "cli-sync": ["read"],
  }

  /** The capabilities a scope carries, for the handshake to advertise. */
  export function capabilities(scope: string): readonly Capability[] {
    const parsed = Scope.safeParse(scope)
    // An unrecognised scope gets nothing rather than the default set: a token
    // whose scope this build does not know is a token from a newer or forged
    // issuer, and guessing generously is the wrong direction to guess.
    return parsed.success ? CAPABILITIES[parsed.data] : []
  }

  /** Whether a scope may perform an operation. */
  export function can(scope: string, capability: Capability): boolean {
    return capabilities(scope).includes(capability)
  }

  /**
   * The capability a request path requires, or `undefined` for no requirement.
   *
   * This is the half that makes `can` more than a table nobody consults. It is
   * evaluated once, in `Auth.authenticate`, for bearer principals only — a
   * local caller with no token is admitted as it always was, so the desktop
   * terminal on loopback is untouched.
   *
   * **Only the three unambiguous capabilities are listed.** `pty`, `teleport`
   * and `git` each map to a route prefix that means exactly the thing the
   * capability names. `read` and `write` do not: classifying every mobile and
   * session route as one or the other is a larger slice with real blast radius
   * — `/sync/*` in particular moves journal rows for `cli-sync`, whose only
   * capability is `read`, so a hasty `write` rule there would stop sync dead.
   * The hole that left — a `cli-sync` token reaching routes it has no business
   * on — is closed by `scopeReaches`, an allowlist for that scope alone.
   */
  export function requiredCapability(pathname: string): Capability | undefined {
    if (pathname.startsWith("/mobile/pty") || pathname.startsWith("/pty/")) return "pty"
    if (pathname.includes("/teleport")) return "teleport"
    if (pathname.startsWith("/mobile/git/") || pathname.startsWith("/mobile/github/")) return "git"
    return undefined
  }

  /**
   * The only routes a `cli-sync` token reaches: the sync transport's own.
   *
   * `requiredCapability` guards the operator surfaces by capability and leaves
   * `read`/`write` unclassified, so a `cli-sync` token — a credential handed to
   * a remote hub or peer — could still reach every other route: sessions,
   * config, files. Classifying all of them is a large, risky slice; the
   * transport's needs are small and fixed, so this scope is an allowlist
   * instead. `src/sync/transport.ts` and `src/sync/remote-client.ts` call
   * `POST /sync/event`, `GET /sync/outbox` and `GET /sync/stream`; the
   * read-only `GET /sync/snapshot/:aggregateID` cold start belongs with them.
   * `/sync/config`, `/connect`, `/disconnect` and `/drain` reconfigure *this*
   * machine and stay out.
   */
  const CLI_SYNC_ROUTES = [/^\/sync\/(?:event|outbox|stream)\/?$/, /^\/sync\/snapshot\/[^/]+\/?$/]

  /** Whether a token of `scope` may reach `pathname` at all. */
  export function scopeReaches(scope: string, pathname: string): boolean {
    if (scope !== "cli-sync") return true
    return CLI_SYNC_ROUTES.some((route) => route.test(pathname))
  }

  export const Token = z
    .object({
      id: z.string(),
      name: z.string(),
      hash: z.string(),
      createdAt: z.number(),
      lastUsedAt: z.number().optional(),
      expiresAt: z.number().optional(),
      scope: z.string().default("mobile"),
    })
    .meta({ ref: "MobileAuthToken" })

  export const PublicToken = Token.omit({ hash: true }).meta({
    ref: "MobileAuthTokenPublic",
  })

  export type Token = z.infer<typeof Token>
  export type PublicToken = z.infer<typeof PublicToken>

  // ============================================================================
  // Database access — uses the shared central Database.Service
  // ============================================================================

  /** Run one synchronous query as this module's async functions expect it. */
  function query<A>(operation: string, run: (db: Database.TxOrDb) => A): A {
    return Effect.runSync(Database.query(`MobileAuth.${operation}`, run))
  }

  // ============================================================================
  // In-memory cache — eliminates DB reads on every authenticated request
  // ============================================================================

  const tokenCache = new Map<string, { token: PublicToken; expiresAt: number | undefined; cachedAt: number }>()
  const TOKEN_CACHE_TTL = 60_000 // 1 minute

  /** Minimum interval between lastUsedAt writes (5 minutes) */
  const LAST_USED_WRITE_INTERVAL = 300_000

  function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex")
  }

  function invalidateCache() {
    tokenCache.clear()
  }

  // ============================================================================
  // Internal: Drizzle row → Token conversion
  // ============================================================================

  function toToken(row: typeof mobileTokens.$inferSelect): Token {
    return {
      id: row.id,
      name: row.name,
      hash: row.hash,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt ?? undefined,
      expiresAt: row.expiresAt ?? undefined,
      scope: row.scope ?? "mobile",
    }
  }

  function toPublicToken(row: typeof mobileTokens.$inferSelect): PublicToken {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt ?? undefined,
      expiresAt: row.expiresAt ?? undefined,
      scope: row.scope ?? "mobile",
    }
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Migrate existing mobile-auth.json into SQLite.
   * Safe to call on every startup — skips if JSON file doesn't exist.
   */
  async function migrateFromJson(): Promise<void> {
    const jsonPath = (await import("path")).join(Global.Path.data, "mobile-auth.json")
    const file = Bun.file(jsonPath)

    if (!(await file.exists())) return

    try {
      const data = await file.json().catch(() => [])
      const parsed = z.array(Token).safeParse(data)
      if (!parsed.success) return

      for (const token of parsed.data) {
        query("migrateFromJson", (db) =>
          db
            .insert(mobileTokens)
            .values({
              id: token.id,
              name: token.name,
              hash: token.hash,
              createdAt: token.createdAt,
              lastUsedAt: token.lastUsedAt ?? null,
              expiresAt: token.expiresAt ?? null,
            })
            .onConflictDoNothing()
            .run(),
        )
      }

      // Remove the old JSON file after successful migration
      const { unlink } = await import("fs/promises")
      await unlink(jsonPath).catch(() => undefined)
    } catch {
      // Silently skip migration on any error
    }
  }

  // Run migration on first DB access
  let _migrated = false
  async function ensureMigrated() {
    if (!_migrated) {
      _migrated = true
      await migrateFromJson()
    }
  }

  export async function all(): Promise<Token[]> {
    await ensureMigrated()
    const rows = query("all", (db) => db.select().from(mobileTokens).all())
    return rows.map(toToken)
  }

  export async function list(): Promise<PublicToken[]> {
    const tokens = await all()
    const now = Date.now()
    return tokens
      .filter((item) => !item.expiresAt || item.expiresAt > now)
      .map((item) => PublicToken.parse(item))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  export async function create(input?: { name?: string; expiresInDays?: number; scope?: Scope }) {
    await ensureMigrated()
    const token = `nkm_${randomBytes(24).toString("base64url")}`
    const info: typeof mobileTokens.$inferInsert = {
      id: `mat_${randomBytes(8).toString("hex")}`,
      name: input?.name?.trim() || "mobile-app",
      hash: hashToken(token),
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt: input?.expiresInDays ? Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000 : null,
      scope: input?.scope ?? "mobile",
    }

    query("create", (db) => db.insert(mobileTokens).values(info).run())

    invalidateCache()

    return {
      token,
      info: PublicToken.parse({
        id: info.id,
        name: info.name,
        createdAt: info.createdAt,
        lastUsedAt: info.lastUsedAt ?? undefined,
        expiresAt: info.expiresAt ?? undefined,
        scope: info.scope,
      }),
    }
  }

  export async function remove(id: string) {
    await ensureMigrated()
    invalidateCache()
    const result = query("remove", (db) => db.delete(mobileTokens).where(eq(mobileTokens.id, id)).run())
    return getChanges(result) > 0
  }

  /**
   * Verify a bearer token.
   * Uses in-memory cache to avoid DB reads on every authenticated request.
   */
  export async function verify(token: string): Promise<PublicToken | undefined> {
    await ensureMigrated()
    const hashed = hashToken(token)
    const now = Date.now()

    // Check cache first
    const cached = tokenCache.get(hashed)
    if (cached) {
      if (now - cached.cachedAt < TOKEN_CACHE_TTL) {
        // Still within TTL
        if (!cached.expiresAt || cached.expiresAt > now) {
          return cached.token
        }
        // Token expired
        tokenCache.delete(hashed)
        return undefined
      }
      // TTL expired — fall through to DB
      tokenCache.delete(hashed)
    }

    // Cache miss — query SQLite
    const row = query("verify", (db) => db.select().from(mobileTokens).where(eq(mobileTokens.hash, hashed)).get())
    if (!row) return undefined

    if (row.expiresAt !== null && row.expiresAt <= now) return undefined

    // Debounced lastUsedAt update — only write if >5 minutes since last write
    if (!row.lastUsedAt || now - row.lastUsedAt > LAST_USED_WRITE_INTERVAL) {
      query("touch", (db) => db.update(mobileTokens).set({ lastUsedAt: now }).where(eq(mobileTokens.id, row.id)).run())
    }

    const publicToken = toPublicToken(row)

    // Populate cache
    tokenCache.set(hashed, {
      token: publicToken,
      expiresAt: row.expiresAt ?? undefined,
      cachedAt: now,
    })

    return publicToken
  }

  export function bearer(request: Request): string | undefined {
    const header = request.headers.get("authorization") || request.headers.get("Authorization")
    if (!header) return
    const [scheme, value] = header.split(/\s+/, 2)
    if (!scheme || !value) return
    if (scheme.toLowerCase() !== "bearer") return
    return value.trim()
  }
}
