import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { testDb, withIsolatedDatabase } from "../helpers/sqlite"

function workspaceRecord(id = "wrk_json_1") {
  return {
    id,
    projectID: "proj_ws_1",
    name: "json workspace",
    timeUsed: 1_700_000_000_000,
    branch: "feat/sql",
    config: {
      type: "worktree" as const,
      directory: "/tmp/ws-json",
    },
  }
}

describe("workspace JSON backfill", () => {
  it("imports leftover JSON workspace records on first open", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const storage = path.join(home, "data", "storage")
      const record = workspaceRecord()

      await fs.mkdir(path.join(storage, "workspace"), { recursive: true })
      await fs.writeFile(path.join(storage, "workspace", `${record.id}.json`), JSON.stringify(record))

      const { Database } = await import("@/database/database")
      const { WorkspaceDB } = await import("@/workspace/db")
      testDb(Database)

      expect(Effect.runSync(WorkspaceDB.get(record.id))?.name).toBe("json workspace")
      expect(Effect.runSync(WorkspaceDB.get(record.id))?.config).toEqual(record.config)

      const workspaceJson = (await import("@/database/migration/20260814090000_workspace_json")).default
      workspaceJson.up(Database.syncNative())
      expect(Effect.runSync(WorkspaceDB.list(record.projectID))).toHaveLength(1)

      expect(await fs.readFile(path.join(storage, "workspace", `${record.id}.json`), "utf8")).toContain(
        "json workspace",
      )
    })
  })

  it("runtime reads ignore leftover JSON after the backfill has run", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { WorkspaceDB } = await import("@/workspace/db")
      testDb(Database)

      const record = workspaceRecord("wrk_trap")
      Effect.runSync(WorkspaceDB.upsert({ ...record, name: "sql-title" }))

      const storage = path.join(home, "data", "storage")
      await fs.mkdir(path.join(storage, "workspace"), { recursive: true })
      await fs.writeFile(
        path.join(storage, "workspace", `${record.id}.json`),
        JSON.stringify({ ...record, name: "json-title" }),
      )

      expect(Effect.runSync(WorkspaceDB.get(record.id))?.name).toBe("sql-title")

      const onlyJson = workspaceRecord("wrk_json_only")
      await fs.writeFile(path.join(storage, "workspace", `${onlyJson.id}.json`), JSON.stringify(onlyJson))
      expect(Effect.runSync(WorkspaceDB.get(onlyJson.id))).toBeUndefined()
    })
  })
})
