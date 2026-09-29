import { preserveTestEnv } from "../helpers/env"
import { Effect } from "effect"
import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, describe, expect, it } from "bun:test"
import { testDb } from "../helpers/sqlite"

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-sync-projection-"))
process.env.NIKCLI_TEST_HOME = testDir
process.env.NIKCLI_DB = path.join(testDir, "nikcli.db")

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DB"])

const { Sync } = await import("@/sync")
const { SyncProjection } = await import("@/sync/projection")
const { SyncSnapshot } = await import("@/sync/snapshot")
const { Server } = await import("@/server/server")

const run = Math.random().toString(36).slice(2)
const projectID = `proj_projection_${run}`

afterAll(async () => {
  await removeTestDir(testDir)
})

describe("SyncProjection", () => {
  it("projects a session aggregate from journaled events and persists a snapshot", async () => {
    const sessionID = `ses_projection_${run}`

    await Sync.emitRaw(projectID, sessionID, {
      type: "session.created",
      properties: { sessionID, title: "First title" },
    })
    await Sync.emitRaw(projectID, sessionID, {
      type: "session.updated",
      properties: { sessionID, title: "Renamed" },
    })
    await Sync.emitRaw(projectID, sessionID, {
      type: "session.idle",
      properties: { sessionID },
    })

    const { state, lastSeq } = await SyncProjection.session(projectID, sessionID)
    expect(lastSeq).toBe(3)
    expect(state.id).toBe(sessionID)
    expect(state.title).toBe("Renamed")

    // First replay persists the snapshot; the next read starts from it.
    const snapshot = Effect.runSync(SyncSnapshot.load({ projectID, aggregate: sessionID, aggregateID: sessionID }))
    expect(snapshot?.lastSeq).toBe(3)

    const again = await SyncProjection.session(projectID, sessionID)
    expect(again.lastSeq).toBe(3)
    expect(again.state.title).toBe("Renamed")
  })

  it("dispatches by aggregate prefix and rejects unknown kinds", async () => {
    const workspaceID = `wrk_projection_${run}`
    await Sync.emitRaw(projectID, workspaceID, {
      type: "workspace.created",
      name: "space",
      branch: "main",
      config: { type: "worktree" },
    })

    const workspace = await SyncProjection.byAggregate(projectID, workspaceID)
    expect((workspace?.state as any)?.name).toBe("space")

    expect(await SyncProjection.byAggregate(projectID, "foo_unknown")).toBeUndefined()
  })
})

describe("GET /sync/snapshot/:aggregateID", () => {
  it("returns the projected state for a session aggregate", async () => {
    const sessionID = `ses_route_${run}`
    await Sync.emitRaw(projectID, sessionID, {
      type: "session.created",
      properties: { sessionID, title: "Via route" },
    })

    const res = await Server.fetch(new Request(`http://localhost/sync/snapshot/${sessionID}?projectID=${projectID}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { lastSeq: number; state: { title: string } }
    expect(body.lastSeq).toBe(1)
    expect(body.state.title).toBe("Via route")
  })

  it("rejects unsupported aggregate kinds", async () => {
    const res = await Server.fetch(new Request(`http://localhost/sync/snapshot/foo_unknown?projectID=${projectID}`))
    expect(res.status).toBe(400)
  })
})

describe("replay across a compacted range", () => {
  /**
   * A projection that replayed across a hole is incomplete, and persisting it
   * would launder the hole into the durable record: the next cold start would
   * load a snapshot that looks authoritative with no way to know it is missing
   * a prefix. `specs/effect-tui/15-sync-snapshots-watermarks.md` requirement 4 —
   * a gap surfaces as visible stale state, never as silent catch-up.
   */
  it("reports the gap and leaves the stale snapshot in place", async () => {
    const { Database } = await import("@/database/database")
    const { syncEvent } = await import("@/sync/sync.sql")
    const { and, eq, lte } = await import("drizzle-orm")

    const sessionID = `ses_gap_${run}`
    for (let i = 0; i < 4; i++) {
      await Sync.emitRaw(projectID, sessionID, {
        type: "session.updated",
        properties: { sessionID, title: `title ${i}` },
      })
    }

    const key = { projectID, aggregate: sessionID, aggregateID: sessionID }
    // A snapshot that has fallen behind, then compaction removing the events
    // it would have needed to catch up.
    Effect.runSync(SyncSnapshot.save(key, 1, { id: sessionID, title: "stale" }))
    testDb(Database)
      .delete(syncEvent)
      .where(and(eq(syncEvent.aggregate, sessionID), lte(syncEvent.seq, 2)))
      .run()

    const replayed = await SyncProjection.session(projectID, sessionID)

    expect(replayed.gap).toBeDefined()
    expect(replayed.gap?.fromSeq).toBe(1)

    // The stale snapshot is still the one on disk: an incomplete projection
    // must not become the record the next cold start trusts.
    expect(Effect.runSync(SyncSnapshot.load(key))?.lastSeq).toBe(1)
  })
})

describe("replay equivalence", () => {
  /**
   * `specs/effect-tui/05-reactive-state.md` asks for replay equivalence to be
   * verified, not assumed: a snapshot is only a legitimate shortcut if
   * replaying from it reaches the same state as replaying the whole journal.
   * A projector that is not a pure function of (state, event) — one that reads
   * a clock, a counter, or anything outside its arguments — breaks that
   * silently, and the symptom is a cold start that disagrees with a warm one.
   */
  it("reaches the same state from a snapshot as from a cold journal", async () => {
    const { SyncSnapshot } = await import("@/sync/snapshot")

    const sessionID = `ses_equiv_${run}`
    for (let i = 0; i < 5; i++) {
      await Sync.emitRaw(projectID, sessionID, {
        type: "session.updated",
        properties: { sessionID, title: `title ${i}` },
      })
    }

    // Warm: the first replay persists a snapshot, the second starts from it.
    const first = await SyncProjection.session(projectID, sessionID)
    const warm = await SyncProjection.session(projectID, sessionID)

    // Cold: drop the snapshot and replay the journal from zero.
    const key = { projectID, aggregate: sessionID, aggregateID: sessionID }
    Effect.runSync(SyncSnapshot.save(key, 0, undefined))
    const cold = await SyncProjection.session(projectID, sessionID)

    expect(warm.lastSeq).toBe(first.lastSeq)
    expect(cold.lastSeq).toBe(first.lastSeq)
    expect(warm.state).toEqual(first.state)
    expect(cold.state).toEqual(first.state)
  })
})
