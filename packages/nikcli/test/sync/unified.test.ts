import { preserveTestEnv } from "../helpers/env"
import { Effect } from "effect"
import { removeTestDir } from "../helpers/fs"
import { describe, expect, it, afterAll } from "bun:test"
import { Database } from "@/database/database"
import { Sync, type SyncEventRecord } from "@/sync"
import { SyncProjector, type WorkspaceState, type SessionState } from "@/sync/projector"
import { SyncReducer } from "@/sync/reducer"
import { Outbox } from "@/sync/outbox"
import { syncSnapshot } from "@/sync/sync.sql"
import { and, eq } from "drizzle-orm"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const tempDir = mkdtempSync(join(tmpdir(), "nikcli-sync-test-"))
process.env.NIKCLI_DB = join(tempDir, "test.db")
process.env.XDG_DATA_HOME = tempDir
preserveTestEnv(["NIKCLI_DB", "XDG_DATA_HOME"])

afterAll(async () => {
  Database.close(join(tempDir, "test.db"))
  // Awaited rather than `rmSync`: closing the database hands the file back to the
  // OS asynchronously, and on Windows the removal loses the race. The retrying
  // helper yields between attempts, which is what lets that close finish.
  await removeTestDir(tempDir)
})

describe("Sync — unified event log", () => {
  it("emitRaw appends to sync_event and assigns a monotonic seq", async () => {
    const projectID = "test_proj_seq"
    const aggregate = "wrk_test_seq"

    const e1 = await Sync.emitRaw(projectID, aggregate, {
      type: "workspace.test",
      i: 0,
    })
    const e2 = await Sync.emitRaw(projectID, aggregate, {
      type: "workspace.test",
      i: 1,
    })
    const e3 = await Sync.emitRaw(projectID, aggregate, {
      type: "workspace.test",
      i: 2,
    })

    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e3.seq).toBe(3)

    const events = await Sync.readAggregate(aggregate)
    expect(events).toHaveLength(3)
  })

  it("stamps workspace_id / origin / origin_seq on append", async () => {
    const projectID = "test_proj_stamp"
    const aggregate = "wrk_stamp"

    const e = await Sync.emitRaw(
      projectID,
      aggregate,
      { type: "workspace.created" },
      { workspaceID: aggregate, origin: "remote:cli-1", originSeq: 42 },
    )
    expect(e.id).toBeTruthy()
    // Read back from DB
    const events = await Sync.getEvents(projectID, aggregate)
    expect(events).toHaveLength(1)
    const row = events[0]
    expect(row.workspaceId).toBe(aggregate)
    expect(row.origin).toBe("remote:cli-1")
    expect(row.originSeq).toBe(42)
  })
})

describe("SyncProjector — pure reducer", () => {
  it("workspace projector updates state on workspace.created", () => {
    const initial: WorkspaceState = {
      id: "wrk_x",
      projectID: "proj_x",
      name: "",
      branch: null,
      config: null,
      lastTouchedAt: 0,
    }
    const event: SyncEventRecord = {
      id: "syn_1",
      projectId: "proj_x",
      aggregate: "wrk_x",
      seq: 1,
      type: "raw",
      data: {
        type: "workspace.created",
        name: "my-workspace",
        branch: "main",
        config: { type: "worktree", directory: "/tmp" },
      },
      timestamp: 1000,
    }
    const next = SyncProjector.workspace(initial, event)
    expect(next.name).toBe("my-workspace")
    expect(next.branch).toBe("main")
    expect(next.lastTouchedAt).toBe(1000)
  })

  it("ignores unknown event types", () => {
    const initial: WorkspaceState = {
      id: "wrk_x",
      projectID: "proj_x",
      name: "preset",
      branch: null,
      config: null,
      lastTouchedAt: 0,
    }
    const event: SyncEventRecord = {
      id: "syn_1",
      projectId: "proj_x",
      aggregate: "wrk_x",
      seq: 1,
      type: "raw",
      data: { type: "unknown.event" },
      timestamp: 9999,
    }
    const next = SyncProjector.workspace(initial, event)
    expect(next).toEqual(initial)
  })
})

describe("SyncReducer — replay with snapshot cache", () => {
  it("cold-replays an explicitly cleared session workspaceID", async () => {
    const projectID = `test_proj_session_clear_${Date.now()}`
    const aggregate = `ses_clear_${Date.now()}`
    await Sync.emitRaw(projectID, aggregate, {
      type: "session.created",
      workspaceID: "wrk_attached",
      title: "attached",
    })
    await Sync.emitRaw(projectID, aggregate, {
      type: "session.updated",
      workspaceID: null,
    })

    const result = await SyncReducer.replayWithSnapshot<SessionState>(
      { projectID, aggregate, aggregateID: aggregate },
      { id: aggregate, projectID, workspaceID: "wrk_stale", title: "", lastTouchedAt: 0 },
      [SyncProjector.session],
    )
    expect(result.state.workspaceID).toBeUndefined()
    expect(result.state.title).toBe("attached")
    expect(result.lastSeq).toBe(2)
  })

  it("replays from seq=0 when no snapshot exists", async () => {
    const projectID = "test_proj_replay"
    const aggregate = "wrk_replay"

    await Sync.emitRaw(projectID, aggregate, {
      type: "workspace.created",
      name: "alpha",
    })
    await Sync.emitRaw(projectID, aggregate, {
      type: "workspace.statusChanged",
      status: "connected",
    })

    const { state, lastSeq } = await SyncReducer.replayWithSnapshot<WorkspaceState>(
      { projectID, aggregate, aggregateID: aggregate },
      {
        id: aggregate,
        projectID,
        name: "",
        branch: null,
        config: null,
        lastTouchedAt: 0,
      },
      [SyncProjector.workspace],
    )
    expect(state.name).toBe("alpha")
    expect(state.status).toBe("connected")
    expect(lastSeq).toBeGreaterThanOrEqual(2)
  })

  it("skips already-replayed events via snapshot", async () => {
    const projectID = "test_proj_snapshot"
    const aggregate = "wrk_snapshot"
    const key = { projectID, aggregate, aggregateID: aggregate }

    // First 3 events
    await Sync.emitRaw(projectID, aggregate, {
      type: "workspace.created",
      name: "beta",
    })
    await Sync.emitRaw(projectID, aggregate, {
      type: "workspace.statusChanged",
      status: "connected",
    })
    await Sync.emitRaw(projectID, aggregate, {
      type: "workspace.statusChanged",
      status: "error",
    })

    // Cold-start replay
    const first = await SyncReducer.replayWithSnapshot<WorkspaceState>(
      key,
      {
        id: aggregate,
        projectID,
        name: "",
        branch: null,
        config: null,
        lastTouchedAt: 0,
      },
      [SyncProjector.workspace],
    )
    expect(first.state.status).toBe("error")
    expect(first.lastSeq).toBe(3)

    // 4th event after the snapshot
    await Sync.emitRaw(projectID, aggregate, {
      type: "workspace.statusChanged",
      status: "connected",
    })

    // Replay again — should only see the 4th event because of the snapshot
    const second = await SyncReducer.replayWithSnapshot<WorkspaceState>(
      key,
      {
        id: aggregate,
        projectID,
        name: "",
        branch: null,
        config: null,
        lastTouchedAt: 0,
      },
      [SyncProjector.workspace],
    )
    expect(second.state.status).toBe("connected")
    expect(second.lastSeq).toBe(4)
  })

  it("falls back to full replay on snapshot corruption", async () => {
    const projectID = "test_proj_corrupt"
    const aggregate = "wrk_corrupt"
    const key = { projectID, aggregate, aggregateID: aggregate }

    await Sync.emitRaw(projectID, aggregate, {
      type: "workspace.created",
      name: "gamma",
    })
    // Manually corrupt the snapshot row in the DB
    const db = Database.syncDb()
    db.update(syncSnapshot)
      .set({ state: "not-json{" })
      .where(
        and(
          eq(syncSnapshot.projectId, projectID),
          eq(syncSnapshot.aggregate, aggregate),
          eq(syncSnapshot.aggregateId, aggregate),
        ),
      )
      .run()

    const { state } = await SyncReducer.replayWithSnapshot<WorkspaceState>(
      key,
      {
        id: aggregate,
        projectID,
        name: "",
        branch: null,
        config: null,
        lastTouchedAt: 0,
      },
      [SyncProjector.workspace],
    )
    expect(state.name).toBe("gamma")
  })
})

describe("Outbox — pending push queue", () => {
  it("enqueues and reports counts", () => {
    const target = "https://s.nikcli-ai.dev"
    Effect.runSync(Outbox.enqueue("syn_aaa", target))
    Effect.runSync(Outbox.enqueue("syn_bbb", target))
    Effect.runSync(Outbox.enqueue("syn_ccc", target))

    const status = Effect.runSync(Outbox.status(target))
    expect(status.pending).toBeGreaterThanOrEqual(3)
  })

  it("is idempotent on (eventId, target)", () => {
    const target = "https://s.nikcli-ai.dev"
    const before = Effect.runSync(Outbox.status(target)).pending
    Effect.runSync(Outbox.enqueue("syn_idempotent", target))
    Effect.runSync(Outbox.enqueue("syn_idempotent", target))
    Effect.runSync(Outbox.enqueue("syn_idempotent", target))
    const after = Effect.runSync(Outbox.status(target)).pending
    expect(after - before).toBe(1)
  })

  it("drain marks sent on successful push", async () => {
    const target = "https://s.nikcli-ai.dev"
    const eventId = "syn_drain_test"
    Effect.runSync(Outbox.enqueue(eventId, target))

    const result = await Outbox.drain(target, async () => ({ ok: true }), 10)
    expect(result.sent).toBeGreaterThanOrEqual(1)
  })
})
