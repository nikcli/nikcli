import type { Database as BunDatabase } from "bun:sqlite"
import type { DatabaseMigration } from "../migration"

/**
 * `GET /sync/stats` reads the newest events of a project —
 * `WHERE project_id = ? ORDER BY seq DESC LIMIT n` — and the TUI polls it every
 * two seconds. Every existing index that leads with `project_id` puts
 * `aggregate` or `origin` before `seq`, so SQLite had to fetch every event of
 * the project, payload included, and sort them in a temp B-tree to return 50.
 *
 * On a real 2.2 GB database (56k events, ~21 KB each) that was 4-6 s per poll,
 * run synchronously on the server's thread: every other request, prompts
 * included, queued behind it. With this index the same read walks 50 index
 * entries and takes under a millisecond. Building it on that database took
 * about a second, once.
 */
export default {
  id: "20260924000000_sync_event_project_seq",
  up(database: BunDatabase) {
    database.exec(`CREATE INDEX IF NOT EXISTS idx_sync_event_project_seq ON sync_event (project_id, seq);`)
  },
} satisfies DatabaseMigration.Migration
