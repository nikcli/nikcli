import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { existsSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { testDb, withIsolatedDatabase } from "../helpers/sqlite"

function runRecord(id = "happy-blue-fox", parentSessionID = "ses_parent_1") {
  return {
    id,
    parentSessionID,
    agent: "explore",
    prompt: "Inspect the tree",
    status: "running" as const,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    artifactPath: `/tmp/delegations/${parentSessionID}/${id}.md`,
    title: "Inspect the tree",
    ownerID: "owner-1",
    heartbeatAt: 1_700_000_000_100,
  }
}

describe("background run SQL", () => {
  it("backfills the JSON tree into SQL on first open", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const projectID = "proj_bg_1"
      const storage = path.join(home, "data", "storage")
      const record = runRecord()

      await fs.mkdir(path.join(storage, "background_run", projectID), { recursive: true })
      await fs.writeFile(path.join(storage, "background_run", projectID, `${record.id}.json`), JSON.stringify(record))

      const { Database } = await import("@/database/database")
      const { BackgroundRunRepo } = await import("@/background/repo")
      testDb(Database)

      expect(Effect.runSync(BackgroundRunRepo.get(projectID, record.id))?.prompt).toBe("Inspect the tree")
      expect(Effect.runSync(BackgroundRunRepo.listRunning(projectID)).map((row) => row.id)).toEqual([record.id])

      const migration = (await import("@/database/migration/20260814060000_background_run")).default
      migration.up(Database.syncNative())
      expect(Effect.runSync(BackgroundRunRepo.list(projectID))).toHaveLength(1)

      expect(await fs.readFile(path.join(storage, "background_run", projectID, `${record.id}.json`), "utf8")).toContain(
        "Inspect the tree",
      )
    })
  })

  it("does not write JSON files after the domain has moved", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { BackgroundRunRepo } = await import("@/background/repo")
      testDb(Database)

      const projectID = "proj_no_json"
      const record = runRecord("quiet-red-owl")
      Effect.runSync(BackgroundRunRepo.upsert(projectID, record))

      const storage = path.join(home, "data", "storage")
      expect(existsSync(path.join(storage, "background_run"))).toBe(false)
      expect(Effect.runSync(BackgroundRunRepo.get(projectID, record.id))?.title).toBe("Inspect the tree")
    })
  })

  it("runtime reads ignore leftover JSON after the domain has moved", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { BackgroundRunRepo } = await import("@/background/repo")
      testDb(Database)

      const projectID = "proj_trap"
      const record = runRecord("stale-json-run")
      Effect.runSync(BackgroundRunRepo.upsert(projectID, { ...record, prompt: "sql-prompt" }))

      const storage = path.join(home, "data", "storage")
      await fs.mkdir(path.join(storage, "background_run", projectID), { recursive: true })
      await fs.writeFile(
        path.join(storage, "background_run", projectID, `${record.id}.json`),
        JSON.stringify({ ...record, prompt: "json-prompt" }),
      )

      expect(Effect.runSync(BackgroundRunRepo.get(projectID, record.id))?.prompt).toBe("sql-prompt")

      const onlyJson = runRecord("json-only-run")
      await fs.writeFile(
        path.join(storage, "background_run", projectID, `${onlyJson.id}.json`),
        JSON.stringify(onlyJson),
      )
      expect(Effect.runSync(BackgroundRunRepo.get(projectID, onlyJson.id))).toBeUndefined()
    })
  })

  it("update, listRunning, and listForParent operate on SQL rows", async () => {
    await withIsolatedDatabase(async () => {
      const { Database } = await import("@/database/database")
      const { BackgroundRunRepo } = await import("@/background/repo")
      testDb(Database)

      const projectID = "proj_mutate"
      const running = runRecord("keep-running", "ses_a")
      const other = runRecord("other-parent", "ses_b")
      Effect.runSync(BackgroundRunRepo.upsert(projectID, running))
      Effect.runSync(BackgroundRunRepo.upsert(projectID, other))

      const updated = Effect.runSync(
        BackgroundRunRepo.update(projectID, running.id, (draft) => {
          draft.status = "orphaned"
          draft.heartbeatAt = 1
        }),
      )
      expect(updated?.status).toBe("orphaned")
      expect(Effect.runSync(BackgroundRunRepo.listRunning(projectID)).map((row) => row.id)).toEqual([other.id])
      expect(Effect.runSync(BackgroundRunRepo.listForParent(projectID, "ses_a")).map((row) => row.id)).toEqual([
        running.id,
      ])
      expect(Effect.runSync(BackgroundRunRepo.get(projectID, running.id))?.heartbeatAt).toBe(1)
    })
  })
})
