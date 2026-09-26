import { and, asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@/database/database"
import { backgroundRun } from "./run.sql"
import type { BackgroundRun } from "./run"

/**
 * SQL-backed repository for background/delegation runs.
 *
 * Replaces the `["background_run", projectID, id]` JSON key tree. Sanitization
 * happens on the way out: a corrupt row is dropped rather than surfaced.
 */
export namespace BackgroundRunRepo {
  type Executor = Database.TxOrDb

  function toRow(projectId: string, record: BackgroundRun.Record) {
    return {
      id: record.id,
      projectId,
      status: record.status,
      parentSessionId: record.parentSessionID,
      data: JSON.stringify(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  function readRows(rows: { data: string }[]): BackgroundRun.Record[] {
    return rows.flatMap((row) => {
      const record = readRecord(row.data)
      return record ? [record] : []
    })
  }

  function readRecord(data: string): BackgroundRun.Record | undefined {
    try {
      const parsed = JSON.parse(data) as BackgroundRun.Record
      if (!parsed || typeof parsed.id !== "string") return undefined
      if (typeof parsed.parentSessionID !== "string" || typeof parsed.status !== "string") return undefined
      if (typeof parsed.createdAt !== "number" || typeof parsed.updatedAt !== "number") return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  export function get(projectId: string, id: string, executor?: Executor) {
    return Database.query(
      "BackgroundRunRepo.get",
      (db) => {
        const row = db
          .select({ data: backgroundRun.data })
          .from(backgroundRun)
          .where(and(eq(backgroundRun.projectId, projectId), eq(backgroundRun.id, id)))
          .get()
        return row ? readRecord(row.data) : undefined
      },
      executor,
    )
  }

  export function upsert(projectId: string, record: BackgroundRun.Record, executor?: Executor) {
    return Database.query(
      "BackgroundRunRepo.upsert",
      (db) => {
        const row = toRow(projectId, record)
        db.insert(backgroundRun)
          .values(row)
          .onConflictDoUpdate({
            target: [backgroundRun.projectId, backgroundRun.id],
            set: {
              status: row.status,
              parentSessionId: row.parentSessionId,
              data: row.data,
              updatedAt: row.updatedAt,
            },
          })
          .run()
      },
      executor,
    )
  }

  /**
   * Mutate-in-place, matching `Storage.update`. Returns undefined when missing.
   *
   * Read and write happen in one immediate transaction. Every status change a
   * run goes through (lease heartbeat, progress, finalize, reopen) is a
   * read-modify-write of the same row, and the writers are not one process:
   * the completion path and the stall watchdog race inside nikcli, and a
   * second nikcli recovering the same project races from outside. Without the
   * write lock taken up front, two of them read the same `running` row and the
   * later upsert overwrites the earlier outcome. When the caller is already in
   * a transaction, it is joined rather than nested.
   */
  export function update(
    projectId: string,
    id: string,
    fn: (draft: BackgroundRun.Record) => void,
    executor?: Executor,
  ): Effect.Effect<BackgroundRun.Record | undefined, Database.QueryError> {
    const apply = (db: Executor) =>
      Effect.gen(function* () {
        const current = yield* get(projectId, id, db)
        if (!current) return undefined
        const draft = structuredClone(current)
        fn(draft)
        yield* upsert(projectId, draft, db)
        return draft
      })
    if (executor) return apply(executor)
    return Database.transaction((tx) => apply(tx))
  }

  /** Oldest first, matching the previous JSON-list sort. */
  export function list(projectId: string, executor?: Executor) {
    return Database.query(
      "BackgroundRunRepo.list",
      (db) => {
        const rows = db
          .select({ data: backgroundRun.data })
          .from(backgroundRun)
          .where(eq(backgroundRun.projectId, projectId))
          .orderBy(asc(backgroundRun.createdAt))
          .all()
        return readRows(rows)
      },
      executor,
    )
  }

  export function listRunning(projectId: string, executor?: Executor) {
    return Database.query(
      "BackgroundRunRepo.listRunning",
      (db) => {
        const rows = db
          .select({ data: backgroundRun.data })
          .from(backgroundRun)
          .where(and(eq(backgroundRun.projectId, projectId), eq(backgroundRun.status, "running")))
          .orderBy(asc(backgroundRun.createdAt))
          .all()
        return readRows(rows)
      },
      executor,
    )
  }

  export function listForParent(projectId: string, parentSessionId: string, executor?: Executor) {
    return Database.query(
      "BackgroundRunRepo.listForParent",
      (db) => {
        const rows = db
          .select({ data: backgroundRun.data })
          .from(backgroundRun)
          .where(and(eq(backgroundRun.projectId, projectId), eq(backgroundRun.parentSessionId, parentSessionId)))
          .orderBy(asc(backgroundRun.createdAt))
          .all()
        return readRows(rows)
      },
      executor,
    )
  }
}
