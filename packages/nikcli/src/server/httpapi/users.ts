import type { JsonValue } from "@/util/json"
import { Effect } from "effect"
import z from "zod"
import { UserDB } from "@/user/users"
import { Flag } from "@nikcli-ai/util/flag"
import { Auth } from "./auth"

/**
 * Instance-less `/user/*` handlers for the Effect backend.
 *
 * These are raw web `Response` handlers, not an `HttpApi` group, for two
 * reasons:
 * - the legacy routes are outside the declared OpenAPI surface (no
 *   `describeRoute`), which is exactly the case http-api.md assigns to raw
 *   Effect HTTP rather than `HttpApi`;
 * - every legacy error body is the same `{ error: string }` shape with only
 *   the status differing, and the `HttpApi` error encoder discriminates by
 *   value, so five identical schemas with different `httpApiStatus` cannot
 *   round-trip correctly.
 *
 * The session is resolved per-request via the canonical `Auth.resolveBearer`
 * (issuer JWT → `nku_` legacy). Served through the bridge's instance-less
 * branch — the instance middleware skips `/user/` paths, so no instance
 * context exists here.
 */
export namespace UsersHttp {
  const RegisterInput = z.object({
    username: z.string().min(2).max(64),
    email: z.string().email(),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[0-9]/, "Password must contain at least one number")
      .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
    displayName: z.string().max(128).optional(),
  })

  const LoginInput = z.object({
    email: z.string().email(),
    password: z.string(),
  })

  const PasswordInput = z.object({
    current: z.string(),
    next: z.string().min(8, "Password must be at least 8 characters"),
  })

  const UpdateInput = z.object({
    displayName: z.string().max(128).optional(),
    password: z.string().min(8).optional(),
    role: z.enum(["admin", "user"]).optional(),
  })

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }

  async function sessionFor(request: Request): Promise<{ user: UserDB.PublicUser; token: string } | null> {
    return Auth.sessionFor(request)
  }

  async function readJson(request: Request): Promise<JsonValue | undefined> {
    try {
      return await request.json()
    } catch {
      return undefined
    }
  }

  async function register(request: Request): Promise<Response> {
    if (Flag.requireOauth() && !Flag.legacyLogin()) {
      return json({ error: "Password registration is disabled" }, 403)
    }
    const parsed = RegisterInput.safeParse(await readJson(request))
    if (!parsed.success) {
      return json(
        {
          error: parsed.error.issues[0]?.message ?? "Invalid registration payload",
        },
        400,
      )
    }
    const body = parsed.data

    // Only allow registration if: no users exist OR caller is admin.
    if (Effect.runSync(UserDB.hasUsers())) {
      const session = await sessionFor(request)
      if (!session || session.user.role !== "admin") {
        return json({ error: "Only admins can create new users" }, 403)
      }
    }

    if (Effect.runSync(UserDB.findByEmail(body.email))) return json({ error: "Email already in use" }, 409)

    try {
      const user = await UserDB.create({
        username: body.username,
        email: body.email,
        password: body.password,
        displayName: body.displayName,
      })
      const token = Effect.runSync(UserDB.createSession(user.id, 30))
      return json({ token, user }, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("UNIQUE")) return json({ error: "Username or email already in use" }, 409)
      if (message.includes("not authorized")) return json({ error: message }, 403)
      throw err
    }
  }

  async function login(request: Request): Promise<Response> {
    if (Flag.requireOauth() && !Flag.legacyLogin()) {
      return json({ error: "Password login is disabled" }, 403)
    }
    const parsed = LoginInput.safeParse(await readJson(request))
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0]?.message ?? "Invalid login payload" }, 400)
    }
    const user = Effect.runSync(UserDB.findByEmail(parsed.data.email))
    if (!user) return json({ error: "Invalid credentials" }, 401)
    const valid = await UserDB.verifyPassword(user, parsed.data.password)
    if (!valid) return json({ error: "Invalid credentials" }, 401)
    const token = Effect.runSync(UserDB.createSession(user.id, 30))
    return json({ token, user: UserDB.toPublic(user) })
  }

  async function logout(request: Request): Promise<Response> {
    const session = await sessionFor(request)
    if (!session) return json({ error: "Unauthorized" }, 401)
    if (session.token.startsWith("nku_")) Effect.runSync(UserDB.revokeSession(session.token))
    return json({ ok: true })
  }

  async function me(request: Request): Promise<Response> {
    const session = await sessionFor(request)
    if (!session) return json({ error: "Unauthorized" }, 401)
    return json(session.user)
  }

  function status(): Response {
    return json({ hasUsers: Effect.runSync(UserDB.hasUsers()) })
  }

  /**
   * The two counters the profile view shows.
   *
   * Both are derived from the caller's own session, never from a path
   * parameter: the terminal used to read them in-process for whichever user id
   * it happened to hold, and that is not a check a route can skip.
   */
  async function meStats(request: Request): Promise<Response> {
    const session = await sessionFor(request)
    if (!session) return json({ error: "Unauthorized" }, 401)
    return json({
      contacts: Effect.runSync(UserDB.listContacts(session.user.id)).length,
      unread: Effect.runSync(UserDB.getTotalUnreadCount(session.user.id)),
    })
  }

  /**
   * Rotate the caller's own password, proving the current one first.
   *
   * `PATCH /user/:id` can already set a password, but it never asks for the old
   * one — an admin resetting someone else's account has no old one to give. A
   * self-service change does, and verifying it here keeps the check on the same
   * side as the hash: the terminal used to read the user row, call
   * `verifyPassword`, and then decide for itself whether to proceed.
   */
  async function changePassword(request: Request): Promise<Response> {
    const session = await sessionFor(request)
    if (!session) return json({ error: "Unauthorized" }, 401)

    const parsed = PasswordInput.safeParse(await readJson(request))
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0]?.message ?? "Invalid password payload" }, 400)
    }

    const user = Effect.runSync(UserDB.findById(session.user.id))
    if (!user) return json({ error: "User not found" }, 404)
    if (!(await UserDB.verifyPassword(user, parsed.data.current))) {
      return json({ error: "Incorrect password" }, 403)
    }

    const updated = await UserDB.updateUser(session.user.id, { password: parsed.data.next })
    if (!updated) return json({ error: "User not found" }, 404)
    return json(updated)
  }

  async function list(request: Request): Promise<Response> {
    const session = await sessionFor(request)
    if (!session) return json({ error: "Unauthorized" }, 401)
    if (session.user.role !== "admin") return json({ error: "Forbidden" }, 403)
    return json(Effect.runSync(UserDB.listUsers()))
  }

  async function update(request: Request, id: string): Promise<Response> {
    const session = await sessionFor(request)
    if (!session) return json({ error: "Unauthorized" }, 401)

    const isSelf = session.user.id === id
    const isAdmin = session.user.role === "admin"
    if (!isSelf && !isAdmin) return json({ error: "Forbidden" }, 403)

    const parsed = UpdateInput.safeParse(await readJson(request))
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0]?.message ?? "Invalid update payload" }, 400)
    }
    const body = parsed.data
    if (body.role && !isAdmin) return json({ error: "Only admins can change roles" }, 403)

    if (body.role === "admin") {
      const targetUser = Effect.runSync(UserDB.findById(id))
      if (!targetUser) return json({ error: "User not found" }, 404)
      if (!UserDB.isAdminEmail(targetUser.email)) {
        return json(
          {
            error: "This email address is not authorized to hold the admin role",
          },
          403,
        )
      }
    }

    try {
      const updated = await UserDB.updateUser(id, body)
      if (!updated) return json({ error: "User not found" }, 404)
      return json(updated)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("not authorized")) return json({ error: message }, 403)
      throw err
    }
  }

  async function remove(request: Request, id: string): Promise<Response> {
    const session = await sessionFor(request)
    if (!session) return json({ error: "Unauthorized" }, 401)
    if (session.user.role !== "admin") return json({ error: "Forbidden" }, 403)
    if (id === session.user.id) return json({ error: "Cannot delete yourself" }, 400)
    const deleted = Effect.runSync(UserDB.deleteUser(id))
    if (!deleted) return json({ error: "User not found" }, 404)
    return json({ ok: true })
  }

  /** Route an instance-less `/user/*` request. Returns null when unmatched. */
  export async function handle(request: Request): Promise<Response | null> {
    const pathname = new URL(request.url).pathname
    const method = request.method.toUpperCase()

    if (method === "POST" && pathname === "/user/register") return register(request)
    if (method === "POST" && pathname === "/user/login") return login(request)
    if (method === "POST" && pathname === "/user/logout") return logout(request)
    if (method === "GET" && pathname === "/user/me") return me(request)
    if (method === "GET" && pathname === "/user/me/stats") return meStats(request)
    if (method === "POST" && pathname === "/user/me/password") return changePassword(request)
    if (method === "GET" && pathname === "/user/status") return status()
    if (method === "GET" && pathname === "/user/list") return list(request)

    const idMatch = pathname.match(/^\/user\/([^/]+)$/)
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1])
      if (method === "PATCH") return update(request, id)
      if (method === "DELETE") return remove(request, id)
    }
    return null
  }
}
