import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { existsSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { testDb, withIsolatedDatabase } from "../helpers/sqlite"

function diffs() {
  return [
    {
      file: "src/moved.ts",
      patch: "@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
      before: "old",
      after: "new",
    },
  ]
}

describe("session diff SQL", () => {
  it("backfills the JSON tree into SQL on first open", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const storage = path.join(home, "data", "storage")
      const sessionID = "ses_diff_1"
      const payload = diffs()

      await fs.mkdir(path.join(storage, "session_diff"), { recursive: true })
      await fs.writeFile(path.join(storage, "session_diff", `${sessionID}.json`), JSON.stringify(payload))

      const { Database } = await import("@/database/database")
      const { SessionDiffRepo } = await import("@/session/diff-repo")
      testDb(Database)

      expect(Effect.runSync(SessionDiffRepo.get(sessionID))).toEqual(payload)

      const sessionDiff = (await import("@/database/migration/20260814080000_session_diff")).default
      sessionDiff.up(Database.syncNative())
      expect(Effect.runSync(SessionDiffRepo.get(sessionID))[0]?.file).toBe("src/moved.ts")

      expect(await fs.readFile(path.join(storage, "session_diff", `${sessionID}.json`), "utf8")).toContain(
        "src/moved.ts",
      )
    })
  })

  it("does not write JSON files after the domain has moved", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { SessionDiffRepo } = await import("@/session/diff-repo")
      testDb(Database)

      const sessionID = "ses_no_json"
      Effect.runSync(SessionDiffRepo.upsert(sessionID, diffs()))

      const storage = path.join(home, "data", "storage")
      expect(existsSync(path.join(storage, "session_diff"))).toBe(false)
      expect(Effect.runSync(SessionDiffRepo.get(sessionID))[0]?.after).toBe("new")
    })
  })

  it("runtime reads ignore leftover JSON after the domain has moved", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { SessionDiffRepo } = await import("@/session/diff-repo")
      testDb(Database)

      const sessionID = "ses_trap"
      Effect.runSync(SessionDiffRepo.upsert(sessionID, [{ ...diffs()[0]!, after: "sql-after" }]))

      const storage = path.join(home, "data", "storage")
      await fs.mkdir(path.join(storage, "session_diff"), { recursive: true })
      await fs.writeFile(
        path.join(storage, "session_diff", `${sessionID}.json`),
        JSON.stringify([{ ...diffs()[0]!, after: "json-after" }]),
      )

      expect(Effect.runSync(SessionDiffRepo.get(sessionID))[0]?.after).toBe("sql-after")

      const onlyJson = "ses_json_only"
      await fs.writeFile(path.join(storage, "session_diff", `${onlyJson}.json`), JSON.stringify(diffs()))
      expect(Effect.runSync(SessionDiffRepo.get(onlyJson))).toEqual([])
    })
  })

  it("remove drops the SQL row", async () => {
    await withIsolatedDatabase(async () => {
      const { Database } = await import("@/database/database")
      const { SessionDiffRepo } = await import("@/session/diff-repo")
      testDb(Database)

      const sessionID = "ses_remove"
      Effect.runSync(SessionDiffRepo.upsert(sessionID, diffs()))
      expect(Effect.runSync(SessionDiffRepo.remove(sessionID))).toBe(true)
      expect(Effect.runSync(SessionDiffRepo.get(sessionID))).toEqual([])
      expect(Effect.runSync(SessionDiffRepo.remove(sessionID))).toBe(false)
    })
  })
})
