import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { account } from "@/database/schema"
import { Database } from "@/database/database"
import { runPromiseWithLayer } from "@/effect"

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-database-home-"))
const dbPath = path.join(testDir, "nikcli.db")

function runDatabase<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return runPromiseWithLayer(Database.layerFromPath(dbPath), effect)
}

afterAll(async () => {
  await removeTestDir(testDir)
})

describe("Database.Service", () => {
  it("opens SQLite with PRAGMAs and applies the migration journal", async () => {
    const result = await runDatabase(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const foreignKeys = database.native.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
        const journal = database.native.query<{ id: string }, []>("SELECT id FROM migration ORDER BY id").all()
        const tables = database.native
          .query<
            { name: string },
            []
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('account', 'analytics_publish', 'analytics_stat', 'users', 'mobile_tokens', 'workspace', 'session_info', 'session_pending', 'instruction_blob', 'instruction_state', 'message_info', 'message_part', 'todo_info', 'permission_ruleset', 'sync_event', 'sync_sequence') ORDER BY name")
          .all()
        const mmap = database.native.query<{ mmap_size: number }, []>("PRAGMA mmap_size").get()
        return { foreignKeys, journal, tables, mmap }
      }),
    )

    expect(result.foreignKeys?.foreign_keys).toBe(1)
    expect(result.mmap?.mmap_size).toBe(0)
    expect(result.journal).toEqual([
      { id: "20260610211500_initial" },
      { id: "20260611000000_session_message_todo_permission" },
      { id: "20260611010000_sync_event_sequence" },
      { id: "20260611020000_import_legacy_databases" },
      { id: "20260611030000_import_json_storage" },
      { id: "20260611040000_import_sync_json" },
      { id: "20260612000000_session_v2_event" },
      { id: "20260630000000_sync_unify" },
      { id: "20260630000100_workspace_drop_events" },
      { id: "20260716000000_user_external_subject" },
      { id: "20260805000000_session_entry" },
      { id: "20260805120000_drop_session_v2_event" },
      { id: "20260805130000_session_entry_id_order" },
      { id: "20260811000000_analytics_stat" },
      { id: "20260814000000_loop_sql" },
      { id: "20260814010000_session_time_suspended" },
      { id: "20260814020000_domain_sql" },
      { id: "20260814030000_project_sql" },
      { id: "20260814040000_analytics_share" },
      { id: "20260814050000_session_goal" },
      { id: "20260814060000_background_run" },
      { id: "20260814070000_routine" },
      { id: "20260814080000_session_diff" },
      { id: "20260814090000_workspace_json" },
      { id: "20260814100000_session_pending" },
      { id: "20260814110000_instruction_sync" },
      { id: "20260816000000_session_last_model" },
      { id: "20260824000000_session_directory_key" },
      { id: "20260924000000_sync_event_project_seq" },
    ])
    expect(result.tables.map((table) => table.name)).toEqual([
      "account",
      "analytics_publish",
      "analytics_stat",
      "instruction_blob",
      "instruction_state",
      "message_info",
      "message_part",
      "mobile_tokens",
      "permission_ruleset",
      "session_info",
      "session_pending",
      "sync_event",
      "sync_sequence",
      "todo_info",
      "users",
      "workspace",
    ])
  })

  it("serves the newest events of a project from an index, not a sort", async () => {
    // `GET /sync/stats` runs this every two seconds on the server's thread. A
    // temp B-tree here means reading every event of the project to return 50.
    const plan = await runDatabase(
      Effect.gen(function* () {
        const database = yield* Database.Service
        return database.native
          .query<{ detail: string }, [string]>(
            "EXPLAIN QUERY PLAN SELECT * FROM sync_event WHERE project_id = ? ORDER BY seq DESC LIMIT 50",
          )
          .all("project")
          .map((row) => row.detail)
      }),
    )

    expect(plan.join(" | ")).toContain("idx_sync_event_project_seq")
    expect(plan.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false)
  })

  it("runs Drizzle queries through the central database service", async () => {
    const row = await runDatabase(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const now = Date.now()
        db.insert(account)
          .values({
            id: "acct_database_test",
            email: "database@example.com",
            url: "https://example.com",
            accessToken: "access-token",
            refreshToken: "refresh-token",
            tokenExpiry: now + 60_000,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        return db.select().from(account).where(eq(account.id, "acct_database_test")).get()
      }),
    )

    expect(row?.email).toBe("database@example.com")
  })

  it("truncates the WAL after checkpointing", async () => {
    const result = await runDatabase(
      Effect.gen(function* () {
        const database = yield* Database.Service
        database.native.exec("CREATE TABLE IF NOT EXISTS checkpoint_test (id INTEGER PRIMARY KEY, value TEXT)")
        database.native.exec("INSERT INTO checkpoint_test (value) VALUES ('pending')")
        const wal = Bun.file(`${database.filename}-wal`)
        const before = wal.size
        const checkpoint = Database.checkpointWal(database.native)
        const after = Bun.file(`${database.filename}-wal`).size
        return { before, after, checkpoint }
      }),
    )

    expect(result.before).toBeGreaterThan(0)
    expect(result.checkpoint?.busy).toBe(0)
    expect(result.after).toBe(0)
  })

  it("imports legacy databases, JSON storage, and sync JSON on first open", async () => {
    const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-database-legacy-"))
    try {
      // Legacy accounts.db
      const { Database: BunDatabase } = await import("bun:sqlite")
      const accounts = new BunDatabase(path.join(legacyDir, "accounts.db"), {
        create: true,
      })
      accounts.exec(`
        CREATE TABLE account (
          id TEXT PRIMARY KEY, email TEXT NOT NULL, url TEXT NOT NULL,
          access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
          token_expiry INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE config (id INTEGER PRIMARY KEY DEFAULT 1, active_account_id TEXT, active_org_id TEXT);
        INSERT INTO account VALUES ('acct_legacy', 'legacy@example.com', 'https://example.com', 'at', 'rt', 1, 1, 1);
        INSERT INTO config (id, active_account_id) VALUES (1, 'acct_legacy');
      `)
      accounts.close()

      // Legacy JSON storage records
      const write = async (parts: string[], content: unknown) => {
        const file = path.join(legacyDir, ...parts)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, JSON.stringify(content))
      }
      const session = {
        id: "ses_legacy",
        projectID: "proj_legacy",
        title: "Legacy session",
        directory: "/tmp",
        version: "1",
        time: { created: 100, updated: 200 },
      }
      await write(["storage", "session", "proj_legacy", "ses_legacy.json"], session)
      const message = {
        id: "msg_legacy",
        sessionID: "ses_legacy",
        role: "user",
        time: { created: 150 },
      }
      await write(["storage", "message", "ses_legacy", "msg_legacy.json"], message)
      const part = {
        id: "prt_legacy",
        messageID: "msg_legacy",
        sessionID: "ses_legacy",
        type: "text",
        text: "hi",
      }
      await write(["storage", "part", "msg_legacy", "prt_legacy.json"], part)
      await write(["storage", "todo", "ses_legacy.json"], [{ id: "todo-1", content: "do it", status: "pending" }])
      await write(["storage", "permission", "proj_legacy.json"], [{ permission: "bash", action: "allow" }])
      await write(
        ["sync", "proj_legacy.events.json"],
        [
          {
            id: "evt_1",
            aggregate: "session",
            seq: 3,
            type: "session.created",
            data: { id: "ses_legacy" },
            timestamp: 1,
          },
        ],
      )
      await write(["sync", "proj_legacy.sequence.json"], { session: 3 })

      const result = await runPromiseWithLayer(
        Database.layerFromPath(path.join(legacyDir, "nikcli.db")),
        Effect.gen(function* () {
          const database = yield* Database.Service
          const query = <T>(sql: string) => database.native.query<T, []>(sql).get()
          return {
            account: query<{ email: string }>("SELECT email FROM account WHERE id = 'acct_legacy'"),
            config: query<{ active_account_id: string }>("SELECT active_account_id FROM config WHERE id = 1"),
            session: query<{ project_id: string; data: string }>(
              "SELECT project_id, data FROM session_info WHERE id = 'ses_legacy'",
            ),
            message: query<{ role: string }>("SELECT role FROM message_info WHERE id = 'msg_legacy'"),
            part: query<{ message_id: string }>("SELECT message_id FROM message_part WHERE id = 'prt_legacy'"),
            todo: query<{ todos: string }>("SELECT todos FROM todo_info WHERE session_id = 'ses_legacy'"),
            ruleset: query<{ rules: string }>("SELECT rules FROM permission_ruleset WHERE project_id = 'proj_legacy'"),
            event: query<{ seq: number }>("SELECT seq FROM sync_event WHERE id = 'evt_1'"),
            sequence: query<{ seq: number }>(
              "SELECT seq FROM sync_sequence WHERE project_id = 'proj_legacy' AND aggregate = 'session'",
            ),
          }
        }),
      )

      expect(result.account?.email).toBe("legacy@example.com")
      expect(result.config?.active_account_id).toBe("acct_legacy")
      expect(result.session?.project_id).toBe("proj_legacy")
      expect(JSON.parse(result.session?.data ?? "{}").title).toBe("Legacy session")
      expect(result.message?.role).toBe("user")
      expect(result.part?.message_id).toBe("msg_legacy")
      expect(JSON.parse(result.todo?.todos ?? "[]")).toHaveLength(1)
      expect(JSON.parse(result.ruleset?.rules ?? "[]")).toHaveLength(1)
      expect(result.event?.seq).toBe(3)
      expect(result.sequence?.seq).toBe(3)
    } finally {
      await removeTestDir(legacyDir)
    }
  })
})
