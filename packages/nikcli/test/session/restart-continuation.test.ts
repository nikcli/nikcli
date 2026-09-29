import { preserveTestEnv } from "../helpers/env"
import { Effect } from "effect"
import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import type { Session } from "@/session"
import { testDb } from "../helpers/sqlite"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-restart-continuation-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG", "XDG_DATA_HOME"])

const { Database } = await import("@/database/database")
const { SessionRepo } = await import("@/session/repo")
const { sessionInfo } = await import("@/session/session.sql")

afterEach(() => {
  testDb(Database).delete(sessionInfo).run()
})

afterAll(async () => {
  await removeTestDir(testHome)
})

let counter = 0
function makeSession(overrides: Partial<Session.Info> = {}): Session.Info {
  const now = Date.now()
  counter++
  // SAFETY: the literal below sets every field the repo round-trip reads; the
  // assertion covers the optional members no test here exercises.
  return {
    id: `ses_test_${counter}`,
    projectID: "proj_test",
    directory: "/tmp/project",
    title: "test session",
    version: "local",
    time: { created: now, updated: now },
    ...overrides,
  } as Session.Info
}

describe("session restart continuation", () => {
  it("round-trips a suspension and returns the directory needed to resume", () => {
    const info = makeSession({ directory: "/tmp/project-a" })
    Effect.runSync(SessionRepo.upsert(info))

    Effect.runSync(SessionRepo.suspend([info.id]))

    expect(Effect.runSync(SessionRepo.consumeSuspended())).toEqual([{ id: info.id, directory: "/tmp/project-a" }])
  })

  it("claims each suspension exactly once", () => {
    const first = makeSession()
    const second = makeSession()
    Effect.runSync(SessionRepo.upsert(first))
    Effect.runSync(SessionRepo.upsert(second))
    Effect.runSync(SessionRepo.suspend([first.id, second.id]))

    // Two servers racing on one data directory: the clear happens in the same
    // statement as the read, so the second claim comes back empty.
    const claimed = Effect.runSync(SessionRepo.consumeSuspended())
    const raced = Effect.runSync(SessionRepo.consumeSuspended())

    expect(claimed.map((row) => row.id).sort()).toEqual([first.id, second.id].sort())
    expect(raced).toEqual([])
  })

  it("returns nothing when no server suspended anything (the hard-crash case)", () => {
    Effect.runSync(SessionRepo.upsert(makeSession()))
    expect(Effect.runSync(SessionRepo.consumeSuspended())).toEqual([])
  })

  it("suspending an empty list is a no-op", () => {
    Effect.runSync(SessionRepo.upsert(makeSession()))
    Effect.runSync(SessionRepo.suspend([]))
    expect(Effect.runSync(SessionRepo.consumeSuspended())).toEqual([])
  })

  it("keeps the mark across an unrelated session write", () => {
    const info = makeSession()
    Effect.runSync(SessionRepo.upsert(info))
    Effect.runSync(SessionRepo.suspend([info.id]))

    // A session can still be touched between the mark and the next startup —
    // a title update, a projector. Neither the upsert nor the update names
    // `time_suspended` in its set clause, so the mark must survive.
    Effect.runSync(SessionRepo.upsert({ ...info, title: "renamed" }))
    Effect.runSync(
      SessionRepo.update(info.id, (session) => ({
        ...session,
        title: "renamed again",
      })),
    )

    expect(Effect.runSync(SessionRepo.consumeSuspended()).map((row) => row.id)).toEqual([info.id])
  })

  it("keeps the mark out of Session.Info", () => {
    const info = makeSession()
    Effect.runSync(SessionRepo.upsert(info))
    Effect.runSync(SessionRepo.suspend([info.id]))

    const read = Effect.runSync(SessionRepo.get(info.id))
    expect(read).toBeDefined()
    expect(read).not.toHaveProperty("timeSuspended")
    expect(read).not.toHaveProperty("time_suspended")
    expect(Object.keys(read!.time).sort()).toEqual(["created", "updated"])
  })
})
