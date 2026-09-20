import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { PermissionNext as PermissionNextNamespace } from "@/permission/next"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * The two invariants of the mobile contract that are not about routing
 * ([specs/v2/mobile-companion-protocol.md](../../../../specs/v2/mobile-companion-protocol.md)):
 * the permission reply union, and that authentication is a bearer token
 * produced by the pairing ceremony.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mobile-permission-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_TEST_MODE = "1"
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_TEST_MODE",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])
for (const dir of ["data", "cache", "config", "state"]) {
  await fs.mkdir(path.join(testHome, dir), { recursive: true })
}

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mobile-permission-project-")))
const { Instance } = await import("@/project/instance")
const { Server } = await import("@/server/server")
const { PermissionNext } = await import("@/permission/next")
const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
const { Auth } = await import("@/server/httpapi/auth")
const { MobileAuth } = await import("@/mobile/auth")

function request(pathname: string, init?: RequestInit) {
  return Server.fetch(
    new Request(`http://nikcli.local/mobile${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-nikcli-directory": projectDir,
        ...init?.headers,
      },
    }),
  )
}

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await removeTestDir(testHome)
  await removeTestDir(projectDir)
})

async function createSession(title: string): Promise<string> {
  const response = await request("/session", { method: "POST", body: JSON.stringify({ title }) })
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

describe("mobile permission replies", () => {
  /**
   * The pending map lives in an `InstanceState` cache owned by the layer
   * build, and `runPromiseWithLayer` memoises one runtime per layer. Going
   * through the same bridge the mobile handler uses (`runPermission`) is
   * therefore not a convenience here — a local `Effect.provide` would build a
   * second service, and the reply would land in a map this test cannot see.
   */
  const runPermission = <A, E>(effect: Effect.Effect<A, E, PermissionNextNamespace.Service>) =>
    runPromiseWithLayer(PermissionNext.defaultLayer, withCurrentInstance(effect))

  const pendingAfterAsk = async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const list = await runPermission(
        Effect.gen(function* () {
          return yield* (yield* PermissionNext.Service).list()
        }),
      )
      if (list.length > 0) return list
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return []
  }

  for (const reply of ["once", "always", "reject"] as const) {
    // A distinct pattern per case on purpose: replying "always" persists a
    // project-scoped approval, so a shared pattern would make the third ask
    // resolve without ever parking. That persistence is asserted below.
    const pattern = `src/${reply}.ts`
    it(`delivers "${reply}" to PermissionNext`, async () => {
      const sessionID = await createSession(`permission ${reply}`)
      await Instance.provide({
        directory: projectDir,
        fn: async () => {
          const asked = runPermission(
            Effect.gen(function* () {
              yield* (yield* PermissionNext.Service).ask({
                permission: "edit",
                patterns: [pattern],
                sessionID,
                metadata: { tool: "edit" },
                always: [pattern],
                ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
              })
            }),
          ).then(
            () => "resolved" as const,
            () => "failed" as const,
          )

          const pending = await pendingAfterAsk()
          expect(pending).toHaveLength(1)

          const response = await request(`/session/${sessionID}/permissions/${pending[0].id}`, {
            method: "POST",
            body: JSON.stringify({ response: reply }),
          })
          expect(response.status).toBe(200)

          // A rejected ask fails the caller; the other two let it continue.
          // Either way the reply reached the service, which is the claim.
          expect(await asked).toBe(reply === "reject" ? "failed" : "resolved")
          expect(
            await runPermission(
              Effect.gen(function* () {
                return yield* (yield* PermissionNext.Service).list()
              }),
            ),
          ).toHaveLength(0)
        },
      })
    })
  }

  it('remembers an "always" reply, so the next ask for that pattern never parks', async () => {
    const sessionID = await createSession("permission always again")
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        // No reply is sent here. If the approval had not persisted, this would
        // park forever and the test would time out.
        await runPermission(
          Effect.gen(function* () {
            yield* (yield* PermissionNext.Service).ask({
              permission: "edit",
              patterns: ["src/always.ts"],
              sessionID,
              metadata: { tool: "edit" },
              always: ["src/always.ts"],
              ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
            })
          }),
        )
        expect(
          await runPermission(
            Effect.gen(function* () {
              return yield* (yield* PermissionNext.Service).list()
            }),
          ),
        ).toHaveLength(0)
      },
    })
  })

  it("refuses a reply outside the union at the contract, before any handler runs", async () => {
    const sessionID = await createSession("permission bad reply")
    const response = await request(`/session/${sessionID}/permissions/per_whatever`, {
      method: "POST",
      body: JSON.stringify({ response: "maybe" }),
    })
    expect(response.status).toBe(400)
  })
})

describe("mobile bearer authentication", () => {
  it("accepts a token minted by the pairing ceremony and rejects anything else", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const created = await MobileAuth.create({ name: "test device" })
        const token = created.token

        expect(await MobileAuth.verify(token)).toBeDefined()
        expect(await MobileAuth.verify(`${token}-tampered`)).toBeUndefined()
        expect(await MobileAuth.verify("nkm_never_issued")).toBeUndefined()

        const authorized = await Auth.authenticate(
          new Request("http://nikcli.local/mobile/session", { headers: { authorization: `Bearer ${token}` } }),
          { mobileAuthRequired: true },
        )
        expect(authorized.ok).toBe(true)
        expect(authorized.ok && authorized.principal.type).toBe("mobile")

        const rejected = await Auth.authenticate(
          new Request("http://nikcli.local/mobile/session", {
            headers: { authorization: "Bearer nkm_never_issued" },
          }),
          { mobileAuthRequired: true },
        )
        expect(rejected.ok).toBe(false)
        expect(rejected.ok === false && rejected.response.status).toBe(401)

        const missing = await Auth.authenticate(new Request("http://nikcli.local/mobile/session"), {
          mobileAuthRequired: true,
        })
        expect(missing.ok).toBe(false)
      },
    })
  })

  it("refuses a guarded path the token's scope does not carry, with 403 and not 401", async () => {
    // The enforcement half of EOT-19 requirement 9. Until 2026-09-21
    // `MobileAuth.can` had no production call site, so a `cli-sync` token —
    // a journal transport — could open a pty.
    //
    // 403 rather than 401 is the point: the token is valid and the caller is
    // who they say. Answering 401 tells a paired device to re-authenticate,
    // which cannot help, and is how a capability refusal turns into "the host
    // is broken".
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const sync = await MobileAuth.create({ name: "sync transport", scope: "cli-sync" })
        const phone = await MobileAuth.create({ name: "paired phone" })

        const attempt = (token: string, pathname: string) =>
          Auth.authenticate(
            new Request(`http://nikcli.local${pathname}`, {
              headers: { authorization: `Bearer ${token}` },
            }),
            { mobileAuthRequired: true },
          )

        const denied = await attempt(sync.token, "/mobile/pty")
        expect(denied.ok).toBe(false)
        expect(denied.ok === false && denied.response.status).toBe(403)
        expect(denied.ok === false && (await denied.response.text())).toContain("pty")

        // The same token on an unguarded path is still fine: the guard refuses
        // an operation, it does not revoke the token.
        const allowed = await attempt(sync.token, "/mobile/session")
        expect(allowed.ok).toBe(true)

        // And the device the capability was written for is not locked out.
        for (const pathname of ["/mobile/pty", "/mobile/teleport", "/mobile/git/status"]) {
          const ok = await attempt(phone.token, pathname)
          expect(ok.ok).toBe(true)
        }
      },
    })
  })

  it("reads the bearer scheme case-insensitively and ignores anything else", () => {
    const bearer = (headers: Record<string, string>) =>
      MobileAuth.bearer(new Request("http://nikcli.local/mobile/session", { headers }))
    expect(bearer({ authorization: "Bearer nkm_abc" })).toBe("nkm_abc")
    expect(bearer({ authorization: "bearer nkm_abc" })).toBe("nkm_abc")
    expect(bearer({ authorization: "Basic nkm_abc" })).toBeUndefined()
    expect(bearer({})).toBeUndefined()
  })
})
