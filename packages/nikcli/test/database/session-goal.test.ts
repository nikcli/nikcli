import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { existsSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { testDb, withIsolatedDatabase } from "../helpers/sqlite"

function goalState(sessionID = "ses_goal_1") {
  return {
    sessionID,
    goalID: "gol_sql_1",
    objective: "move goals off JSON",
    status: "active" as const,
    tokenBudget: 100,
    tokensUsed: 12,
    timeUsedSeconds: 4,
    iterationCount: 2,
    timeCreated: 1_700_000_000_000,
    timeUpdated: 1_700_000_000_100,
  }
}

describe("session goal SQL", () => {
  it("backfills the JSON tree into SQL on first open", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const storage = path.join(home, "data", "storage")
      const state = goalState()

      await fs.mkdir(path.join(storage, "goal"), { recursive: true })
      await fs.writeFile(path.join(storage, "goal", `${state.sessionID}.json`), JSON.stringify(state))

      const { Database } = await import("@/database/database")
      const { GoalRepo } = await import("@/session/goal-repo")
      testDb(Database)

      expect(Effect.runSync(GoalRepo.get(state.sessionID))?.objective).toBe("move goals off JSON")
      expect(Effect.runSync(GoalRepo.get(state.sessionID))?.tokensUsed).toBe(12)

      const sessionGoal = (await import("@/database/migration/20260814050000_session_goal")).default
      sessionGoal.up(Database.syncNative())
      expect(Effect.runSync(GoalRepo.get(state.sessionID))?.goalID).toBe("gol_sql_1")

      expect(await fs.readFile(path.join(storage, "goal", `${state.sessionID}.json`), "utf8")).toContain(
        "move goals off JSON",
      )
    })
  })

  it("does not write JSON files after the domain has moved", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { GoalRepo } = await import("@/session/goal-repo")
      testDb(Database)

      const state = goalState("ses_no_json")
      Effect.runSync(GoalRepo.upsert(state))

      const storage = path.join(home, "data", "storage")
      expect(existsSync(path.join(storage, "goal"))).toBe(false)
      expect(Effect.runSync(GoalRepo.get(state.sessionID))?.objective).toBe("move goals off JSON")
    })
  })

  it("runtime reads ignore leftover JSON after the domain has moved", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { GoalRepo } = await import("@/session/goal-repo")
      testDb(Database)

      const state = goalState("ses_trap")
      Effect.runSync(GoalRepo.upsert({ ...state, objective: "sql-objective" }))

      const storage = path.join(home, "data", "storage")
      await fs.mkdir(path.join(storage, "goal"), { recursive: true })
      await fs.writeFile(
        path.join(storage, "goal", `${state.sessionID}.json`),
        JSON.stringify({ ...state, objective: "json-objective" }),
      )

      expect(Effect.runSync(GoalRepo.get(state.sessionID))?.objective).toBe("sql-objective")

      const onlyJson = goalState("ses_json_only")
      await fs.writeFile(path.join(storage, "goal", `${onlyJson.sessionID}.json`), JSON.stringify(onlyJson))
      expect(Effect.runSync(GoalRepo.get(onlyJson.sessionID))).toBeUndefined()
    })
  })

  it("update and remove operate on the SQL row", async () => {
    await withIsolatedDatabase(async () => {
      const { Database } = await import("@/database/database")
      const { GoalRepo } = await import("@/session/goal-repo")
      testDb(Database)

      const state = goalState("ses_mutate")
      Effect.runSync(GoalRepo.upsert(state))
      const updated = Effect.runSync(
        GoalRepo.update(state.sessionID, (draft) => {
          draft.status = "paused"
          draft.iterationCount += 1
        }),
      )
      expect(updated?.status).toBe("paused")
      expect(updated?.iterationCount).toBe(3)
      expect(Effect.runSync(GoalRepo.get(state.sessionID))?.status).toBe("paused")

      expect(Effect.runSync(GoalRepo.remove(state.sessionID))).toBe(true)
      expect(Effect.runSync(GoalRepo.get(state.sessionID))).toBeUndefined()
      expect(
        Effect.runSync(
          GoalRepo.update(state.sessionID, (draft) => {
            draft.status = "active"
          }),
        ),
      ).toBeUndefined()
    })
  })
})
