import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { ShareNext as ShareNextNamespace } from "@/share/share-next"
import type { Session as SessionNamespace } from "@/session"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * What a share is on the wire and on disk
 * ([specs/v2/share-v2-contract.md](../../../../specs/v2/share-v2-contract.md)).
 *
 * The four claims under test are the ones a reader would otherwise have to
 * take on trust: the envelope list, that `publicData` reads the local table
 * only, that `remove` deletes rather than tombstones, and that a remote share
 * needs id + secret where a local one needs id + url.
 *
 * The remote endpoint is a stub `Bun.serve` reached through `enterprise.url`,
 * so nothing in this file talks to s.nikcli-ai.dev.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-share-contract-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_TEST_MODE = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")
delete process.env.NIKCLI_DISABLE_SHARE

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_TEST_MODE",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])
for (const dir of ["data", "cache", "config", "state"]) {
  await fs.mkdir(path.join(testHome, dir), { recursive: true })
}

const deleted: string[] = []
const synced: Array<{ id: string; count: number }> = []

const remote = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/api/share") {
      const id = `shr_${Math.random().toString(36).slice(2, 10)}`
      return Response.json({ id, url: `${url.origin}/share/${id}`, secret: "s3cret" })
    }
    const sync = url.pathname.match(/^\/api\/share\/([^/]+)\/sync$/)
    if (request.method === "POST" && sync) {
      const body = (await request.json()) as { data: unknown[] }
      synced.push({ id: sync[1], count: body.data.length })
      return new Response("ok")
    }
    const remove = url.pathname.match(/^\/api\/share\/([^/]+)$/)
    if (request.method === "DELETE" && remove) {
      deleted.push(remove[1])
      return new Response("ok")
    }
    return new Response("not found", { status: 404 })
  },
})

async function makeProject(enterpriseUrl: string, prefix: string) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  await Bun.write(
    path.join(directory, "nikcli.json"),
    JSON.stringify({ $schema: "https://nikcli-ai.dev/config.json", enterprise: { url: enterpriseUrl } }, null, 2),
  )
  return directory
}

// One instance points at the stub; the other at a port nothing listens on, so
// the documented local fallback is reached the way it is in production —
// by the remote request failing.
const remoteDir = await makeProject(`http://127.0.0.1:${remote.port}`, "nikcli-share-remote-")
const localDir = await makeProject("http://127.0.0.1:1", "nikcli-share-local-")

const { Instance } = await import("@/project/instance")
const { ShareNext } = await import("@/share/share-next")
const { ShareRepo } = await import("@/share/repo")
const { Session } = await import("@/session")
const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")

const runShare = <A, E>(effect: Effect.Effect<A, E, ShareNextNamespace.Service>) =>
  runPromiseWithLayer(ShareNext.defaultLayer, withCurrentInstance(effect))

const runSession = <A, E>(effect: Effect.Effect<A, E, SessionNamespace.Service>) =>
  runPromiseWithLayer(Session.defaultLayer, withCurrentInstance(effect))

async function newSession(title: string) {
  const created = await runSession(
    Effect.gen(function* () {
      return yield* (yield* Session.Service).create({ title })
    }),
  )
  return created.id
}

afterAll(async () => {
  remote.stop(true)
  await Instance.disposeAll().catch(() => undefined)
  await removeTestDir(testHome)
  await removeTestDir(remoteDir)
  await removeTestDir(localDir)
})

describe("ShareNext · remote mode", () => {
  it("stores id, secret and url, and publicData still reads nothing (it is local-only)", async () => {
    await Instance.provide({
      directory: remoteDir,
      fn: async () => {
        const sessionID = await newSession("remote share")
        const share = await runShare(
          Effect.gen(function* () {
            return yield* (yield* ShareNext.Service).create(sessionID)
          }),
        )

        expect(share.mode).toBe("remote")
        expect(share.id).toBeTruthy()
        expect(share.secret).toBe("s3cret")
        expect(share.url).toContain(share.id!)
        expect(Effect.runSync(ShareRepo.get(sessionID))).toMatchObject({ mode: "remote", secret: "s3cret" })
        // create() full-syncs, and the envelope list for a fresh session is
        // session + session_diff + model.
        expect(synced.at(-1)).toEqual({ id: share.id!, count: 3 })

        // The public read path consults the local table. A remote share has no
        // row there, so it is `undefined` — the server that holds the data is
        // the one that answers for it.
        const data = await runShare(
          Effect.gen(function* () {
            return yield* (yield* ShareNext.Service).publicData(share.id!)
          }),
        )
        expect(data).toBeUndefined()
      },
    })
  })

  it("deletes the row on remove — there is no tombstone to observe", async () => {
    await Instance.provide({
      directory: remoteDir,
      fn: async () => {
        const sessionID = await newSession("removed share")
        const share = await runShare(
          Effect.gen(function* () {
            return yield* (yield* ShareNext.Service).create(sessionID)
          }),
        )
        await runShare(
          Effect.gen(function* () {
            return yield* (yield* ShareNext.Service).remove(sessionID)
          }),
        )

        expect(deleted).toContain(share.id!)
        expect(Effect.runSync(ShareRepo.get(sessionID))).toBeUndefined()
        expect(Effect.runSync(ShareRepo.getLocal(share.id!))).toBeUndefined()
      },
    })
  })
})

describe("ShareNext · local mode", () => {
  it("falls back to a local share when the remote fails and a baseUrl is given", async () => {
    await Instance.provide({
      directory: localDir,
      fn: async () => {
        const sessionID = await newSession("local share")
        const share = await runShare(
          Effect.gen(function* () {
            return yield* (yield* ShareNext.Service).create(sessionID, { baseUrl: "https://viewer.example" })
          }),
        )

        expect(share.mode).toBe("local")
        expect(share.id).toBeTruthy()
        expect(share.url).toBe(`https://viewer.example/share/${share.id}`)
        // A local share carries no secret: there is no remote to authenticate to.
        expect(share.secret).toBeUndefined()

        const data = await runShare(
          Effect.gen(function* () {
            return yield* (yield* ShareNext.Service).publicData(share.id!)
          }),
        )
        expect(data).toBeDefined()
        expect(data!.map((item) => item.type).sort()).toEqual(["model", "session", "session_diff"])
        expect(data!.find((item) => item.type === "session")?.data).toMatchObject({ id: sessionID })
      },
    })
  })

  it("removes both rows and leaves the public read path empty", async () => {
    await Instance.provide({
      directory: localDir,
      fn: async () => {
        const sessionID = await newSession("local share removed")
        const share = await runShare(
          Effect.gen(function* () {
            return yield* (yield* ShareNext.Service).create(sessionID, { baseUrl: "https://viewer.example" })
          }),
        )
        expect(Effect.runSync(ShareRepo.getLocal(share.id!))).toBeDefined()

        await runShare(
          Effect.gen(function* () {
            return yield* (yield* ShareNext.Service).remove(sessionID)
          }),
        )

        expect(Effect.runSync(ShareRepo.get(sessionID))).toBeUndefined()
        expect(Effect.runSync(ShareRepo.getLocal(share.id!))).toBeUndefined()
        expect(
          await runShare(
            Effect.gen(function* () {
              return yield* (yield* ShareNext.Service).publicData(share.id!)
            }),
          ),
        ).toBeUndefined()
      },
    })
  })

  it("refuses to create anything when sharing is disabled", async () => {
    process.env.NIKCLI_DISABLE_SHARE = "1"
    try {
      await Instance.provide({
        directory: localDir,
        fn: async () => {
          const sessionID = await newSession("disabled share")
          const exit = await Effect.runPromiseExit(
            withCurrentInstance(
              Effect.gen(function* () {
                return yield* (yield* ShareNext.Service).create(sessionID)
              }),
            ).pipe(Effect.provide(ShareNext.defaultLayer)),
          )
          expect(exit._tag).toBe("Failure")
          expect(Effect.runSync(ShareRepo.get(sessionID))).toBeUndefined()
        },
      })
    } finally {
      delete process.env.NIKCLI_DISABLE_SHARE
    }
  })
})
