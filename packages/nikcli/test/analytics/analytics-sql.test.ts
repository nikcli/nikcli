import { describe, expect, it } from "bun:test"
import { existsSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { testDb, withIsolatedDatabase } from "../helpers/sqlite"

function at(day: string, hour = 12) {
  return Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`)
}

describe("analytics SQL", () => {
  it("queries global, daily, and session totals from message_info", async () => {
    await withIsolatedDatabase(async () => {
      const { Database } = await import("@/database/database")
      const { Analytics } = await import("@/analytics/analytics")
      const db = Database.syncNative()
      const created = at("2026-08-01")

      db.query(
        `INSERT INTO session_info (id, project_id, title, directory, version, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("ses_a", "proj_a", "alpha", "/tmp/a", "1", "{}", created, created + 5_000)

      db.query(`INSERT INTO message_info (id, session_id, role, info, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        "msg_a",
        "ses_a",
        "assistant",
        JSON.stringify({
          providerID: "openai",
          modelID: "gpt-4",
          cost: 0.02,
          time: { created, completed: created + 1_000 },
          tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } },
        }),
        created,
      )
      db.query(
        `INSERT INTO message_part (id, message_id, session_id, type, info, sort_key) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("part_a", "msg_a", "ses_a", "tool", JSON.stringify({ tool: "read", state: { status: "completed" } }), "0")

      await Analytics.recordMessage({
        sessionID: "ses_a",
        projectID: "proj_a",
        directory: "/tmp/a",
        providerID: "openai",
        modelID: "gpt-4",
        tokens: { input: 99, output: 99, reasoning: 99, cache: { read: 99, write: 99 } },
        cost: 9,
        timestamp: created,
      })

      const global = await Analytics.getGlobal()
      expect(global.totals.sessions).toBe(1)
      expect(global.totals.messages).toBe(1)
      expect(global.totals.tokens.input).toBe(10)
      expect(global.totals.tokens.output).toBe(20)
      expect(global.totals.tokens.reasoning).toBe(5)
      expect(global.totals.cost).toBeCloseTo(0.02)
      expect(global.totals.toolCalls).toBe(1)
      expect(global.byProvider.openai?.messages).toBe(1)
      expect(global.byModel["openai/gpt-4"]?.tokens.output).toBe(20)
      expect(global.byProject.proj_a?.sessions).toBe(1)

      const daily = await Analytics.getDaily("2026-08-01", "2026-08-01")
      expect(daily).toHaveLength(1)
      expect(daily[0]?.messages).toBe(1)
      expect(daily[0]?.tools.read?.success).toBe(1)

      const session = await Analytics.getSession("ses_a")
      expect(session?.title).toBe("alpha")
      expect(session?.messages).toBe(1)
      expect(session?.toolCalls).toBe(1)
      expect(session?.providerID).toBe("openai")

      expect(await Analytics.getSession("ses_missing")).toBeNull()

      const listed = await Analytics.getAllSessions()
      expect(listed.map((row) => row.sessionID)).toEqual(["ses_a"])
    })
  })

  // getAllSessions used to run the same correlated subqueries as getSession, once
  // per session. It now aggregates each table in a single pass and joins on the
  // session id, so the two have to keep agreeing row for row.
  it("aggregates the session list identically to a single-session read", async () => {
    await withIsolatedDatabase(async () => {
      const { Database } = await import("@/database/database")
      const { Analytics } = await import("@/analytics/analytics")
      const db = Database.syncNative()
      const day = at("2026-08-02")

      const session = (id: string, project: string, title: string, created: number, updated: number) =>
        db
          .query(
            `INSERT INTO session_info (id, project_id, title, directory, version, data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, project, title, `/tmp/${id}`, "1", "{}", created, updated)

      const message = (id: string, sessionID: string, role: string, created: number, info: Record<string, unknown>) =>
        db
          .query(`INSERT INTO message_info (id, session_id, role, info, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(id, sessionID, role, JSON.stringify(info), created)

      const PART_INSERT = `INSERT INTO message_part (id, message_id, session_id, type, info, sort_key)
         VALUES (?, ?, ?, ?, ?, ?)`

      const toolPart = (id: string, messageID: string, sessionID: string, tool: string) =>
        db
          .query(PART_INSERT)
          .run(id, messageID, sessionID, "tool", JSON.stringify({ tool, state: { status: "completed" } }), "0")

      const assistant = (model: string, tokens: number) => ({
        providerID: "openai",
        modelID: model,
        cost: 0.5,
        time: { created: day, completed: day + 1_000 },
        tokens: { input: tokens, output: tokens, reasoning: tokens, cache: { read: tokens, write: tokens } },
      })

      session("ses_multi", "proj_x", "multi", day, day + 9_000)
      // Two models in one session: provider/model must come from the newest turn.
      message("msg_1", "ses_multi", "assistant", day, assistant("gpt-4", 10))
      message("msg_2", "ses_multi", "assistant", day + 5_000, assistant("gpt-5", 100))
      // User turns and model-less failures must not reach any total.
      message("msg_3", "ses_multi", "user", day + 6_000, { text: "hi" })
      message("msg_4", "ses_multi", "assistant", day + 7_000, { cost: 999, tokens: { input: 999 } })
      toolPart("part_1", "msg_1", "ses_multi", "read")
      toolPart("part_2", "msg_2", "ses_multi", "bash")

      // A session that never produced a message still belongs in the list.
      session("ses_empty", "proj_y", "empty", day, day + 1_000)

      const listed = await Analytics.getAllSessions()
      expect(listed.map((row) => row.sessionID)).toEqual(["ses_multi", "ses_empty"])

      for (const row of listed) {
        expect(row).toEqual((await Analytics.getSession(row.sessionID))!)
      }

      const multi = listed.find((row) => row.sessionID === "ses_multi")!
      expect(multi.providerID).toBe("openai")
      expect(multi.modelID).toBe("gpt-5")
      // msg_4 carries no model, so it counts as a message but adds no tokens.
      expect(multi.messages).toBe(3)
      expect(multi.tokens.input).toBe(1109)
      expect(multi.tokens.cacheWrite).toBe(110)
      expect(multi.toolCalls).toBe(2)

      const empty = listed.find((row) => row.sessionID === "ses_empty")!
      expect(empty.messages).toBe(0)
      expect(empty.toolCalls).toBe(0)
      expect(empty.providerID).toBe("unknown")
      expect(empty.tokens.input).toBe(0)
    })
  })

  // Reads are memoized against a row-count fingerprint, because scanning the
  // tool payloads in message_part costs seconds. A write has to invalidate it.
  it("re-reads totals once new messages land", async () => {
    await withIsolatedDatabase(async () => {
      const { Database } = await import("@/database/database")
      const { Analytics } = await import("@/analytics/analytics")
      const db = Database.syncNative()
      const day = at("2026-08-03")
      const stamp = day + 1_000

      db.query(
        `INSERT INTO session_info (id, project_id, title, directory, version, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("ses_cache", "proj_c", "cache", "/tmp/c", "1", "{}", day, stamp)

      const write = (id: string, tokens: number) => {
        db.query(`INSERT INTO message_info (id, session_id, role, info, created_at) VALUES (?, ?, ?, ?, ?)`).run(
          id,
          "ses_cache",
          "assistant",
          JSON.stringify({
            providerID: "openai",
            modelID: "gpt-4",
            cost: 1,
            time: { created: day, completed: stamp },
            tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
          day,
        )
        db.query(
          `INSERT INTO message_part (id, message_id, session_id, type, info, sort_key) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          `part_${id}`,
          id,
          "ses_cache",
          "tool",
          JSON.stringify({ tool: "read", state: { status: "completed" } }),
          "0",
        )
      }

      write("msg_c1", 10)
      const first = await Analytics.getGlobal()
      expect(first.totals.messages).toBe(1)
      expect(first.totals.tokens.input).toBe(10)
      expect(first.totals.toolCalls).toBe(1)

      // Same input, same answer — and the cached value must be usable as-is.
      expect(await Analytics.getGlobal()).toEqual(first)
      const dayKey = "2026-08-03"
      expect(await Analytics.getDaily(dayKey, dayKey)).toEqual(await Analytics.getDaily(dayKey, dayKey))
      expect(await Analytics.getAllSessions()).toEqual(await Analytics.getAllSessions())

      write("msg_c2", 32)

      const second = await Analytics.getGlobal()
      expect(second.totals.messages).toBe(2)
      expect(second.totals.tokens.input).toBe(42)
      expect(second.totals.toolCalls).toBe(2)

      const daily = await Analytics.getDaily(dayKey, dayKey)
      expect(daily[0]?.messages).toBe(2)
      expect(daily[0]?.tokens.input).toBe(42)
      expect(daily[0]?.toolCalls).toBe(2)

      const sessions = await Analytics.getAllSessions()
      expect(sessions[0]?.messages).toBe(2)
      expect(sessions[0]?.tokens.input).toBe(42)
      expect(sessions[0]?.toolCalls).toBe(2)
    })
  })

  it("does not write analytics JSON after the snapshots have moved", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { Analytics } = await import("@/analytics/analytics")
      testDb(Database)
      await Analytics.recordSession({
        sessionID: "ses_no_json",
        projectID: "proj",
        directory: "/tmp",
        timestamp: Date.now(),
      })
      await Analytics.recordSessionEnd({
        sessionID: "ses_no_json",
        projectID: "proj",
        directory: "/tmp",
        title: "no json",
        providerID: "openai",
        modelID: "gpt-4",
        messages: 1,
        tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        toolCalls: 0,
        duration: 0,
        created: Date.now(),
        completed: Date.now(),
      })
      expect(existsSync(path.join(home, "data", "storage", "analytics"))).toBe(false)
    })
  })

  it("backfills the install UUID from leftover JSON and then ignores it", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const storage = path.join(home, "data", "storage", "analytics")
      await fs.mkdir(storage, { recursive: true })
      await fs.writeFile(
        path.join(storage, "share-state.json"),
        JSON.stringify({ installID: "11111111-1111-4111-8111-111111111111", lastDay: "2026-01-01" }),
      )

      const { Database } = await import("@/database/database")
      testDb(Database)
      const row = Database.syncNative()
        .query<{ install_id: string }, []>(`SELECT install_id FROM analytics_share WHERE id = 'local'`)
        .get()
      expect(row?.install_id).toBe("11111111-1111-4111-8111-111111111111")

      const analyticsShare = (await import("@/database/migration/20260814040000_analytics_share")).default
      analyticsShare.up(Database.syncNative())
      expect(Database.syncNative().query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM analytics_share`).get()?.n).toBe(
        1,
      )

      await fs.writeFile(
        path.join(storage, "share-state.json"),
        JSON.stringify({ installID: "22222222-2222-4222-8222-222222222222" }),
      )
      const { AnalyticsShare } = await import("@/analytics/share")
      // enabled() does not read state; run() would. Probe the table again after a
      // leftover JSON rewrite — runtime must not pick up the new id.
      expect(
        Database.syncNative()
          .query<{ install_id: string }, []>(`SELECT install_id FROM analytics_share WHERE id = 'local'`)
          .get()?.install_id,
      ).toBe("11111111-1111-4111-8111-111111111111")
      expect(AnalyticsShare.enabled(undefined)).toBe(true)
    })
  })
})
