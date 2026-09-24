import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core"

// ============================================================================
// Sync Events — single source of truth for sessions + workspace events
// ============================================================================

export const syncEvent = sqliteTable(
  "sync_event",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    /**
     * Optional workspace this event belongs to. Null for project-level
     * events (e.g. permission.*, question.*) or session events not yet
     * attached to a workspace.
     */
    workspaceId: text("workspace_id"),
    aggregate: text("aggregate").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    /** Full JSON-serialized event data */
    data: text("data").notNull(),
    timestamp: integer("timestamp").notNull(),
    /**
     * Where this event originated. `local` for events emitted by this
     * process, `remote:<id>` for events received from a remote hub server
     * (id is the remote server identifier).
     */
    origin: text("origin").notNull().default("local"),
    /**
     * The sequence number assigned by the origin server, if remote. Null
     * for local events. Used to detect and reconcile renumbering.
     */
    originSeq: integer("origin_seq"),
  },
  (table) => ({
    projectIdx: index("idx_sync_event_project").on(table.projectId),
    aggregateIdx: index("idx_sync_event_aggregate").on(table.projectId, table.aggregate),
    seqIdx: index("idx_sync_event_seq").on(table.projectId, table.aggregate, table.seq),
    projectSeqIdx: index("idx_sync_event_project_seq").on(table.projectId, table.seq),
    workspaceIdx: index("idx_sync_event_workspace").on(table.workspaceId),
    originIdx: index("idx_sync_event_origin").on(table.origin),
    projectOriginIdx: index("idx_sync_event_project_origin").on(
      table.projectId,
      table.origin,
      table.aggregate,
      table.seq,
    ),
  }),
)

// ============================================================================
// Sync Snapshots — cold-start projection cache
// ============================================================================

export const syncSnapshot = sqliteTable(
  "sync_snapshot",
  {
    projectId: text("project_id").notNull(),
    aggregate: text("aggregate").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    lastSeq: integer("last_seq").notNull(),
    /** JSON-serialized compact projection of the aggregate state */
    state: text("state").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.projectId, table.aggregate, table.aggregateId],
    }),
  }),
)

// ============================================================================
// Sync Outbox — pending push queue to a remote hub server
// ============================================================================

export const syncOutbox = sqliteTable(
  "sync_outbox",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    target: text("target").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    statusIdx: index("idx_sync_outbox_status").on(table.status, table.nextAttemptAt),
    eventIdx: index("idx_sync_outbox_event").on(table.eventId),
  }),
)

// ============================================================================
// Sync Sequences — SQL backend for JSON-backed sequence counter storage
// ============================================================================

export const syncSequence = sqliteTable(
  "sync_sequence",
  {
    projectId: text("project_id").notNull(),
    aggregate: text("aggregate").notNull(),
    seq: integer("seq").notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.aggregate] }),
  }),
)
