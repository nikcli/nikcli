import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, describe, expect, it } from "bun:test"

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-sync-ordering-"))
process.env.NIKCLI_TEST_HOME = testDir
process.env.NIKCLI_DB = path.join(testDir, "nikcli.db")
preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DB"])

const { Sync, SyncStorage } = await import("@/sync")

// Unique per run: the database singleton is process-wide and another file in
// the same run may already have opened it.
const run = Math.random().toString(36).slice(2)
const projectID = `proj_sync_order_${run}`

afterAll(async () => {
  await removeTestDir(testDir)
})

/**
 * Multi-device ordering, which is the half of EOT-15's gate that rests on a
 * claim rather than a test.
 *
 * `reserveSeqAndAppend` reads the aggregate's current sequence and appends in
 * one `BEGIN IMMEDIATE` transaction. That is the whole ordering model: **`seq`
 * is assigned by the writer's database, per aggregate, and it is the order.** A
 * device's own `origin` and `origin_seq` are provenance and idempotency, not
 * sequence — two devices do not interleave their own counters into one stream.
 *
 * **What these cases establish, precisely.** They pin the property: no
 * duplicate `seq`, no holes, per-aggregate independence, cursor reads in order.
 * They do *not* isolate which mechanism provides it. Flipping the transaction
 * to `deferred` was tried, in-process and across four contending processes, and
 * nothing failed either time — in-process because the drizzle driver is
 * synchronous so the read and the append cannot interleave at all, and across
 * processes because SQLite's own locking and retry appear to close the window
 * before the transaction mode has to. So the property is more robust than the
 * one line it is usually credited to, and a regression in it would still be
 * caught here — but this is not evidence that `BEGIN IMMEDIATE` is load-bearing,
 * and it should not be cited as such.
 *
 * It matters because `detectSequenceGap` reads consecutiveness as proof that
 * nothing was deleted. Two appends that collided on one `seq` would leave the
 * next reader's gap check quietly wrong: no hole to find, and an event missing.
 *
 * `specs/effect-tui/15-sync-snapshots-watermarks.md`.
 */
describe("sequence assignment under concurrency (EOT-15)", () => {
  it("gives every concurrent append on one aggregate its own seq", async () => {
    const workspaceID = `wrk_${run}_race`
    const writes = 40

    // Fired together rather than awaited in turn: the serial version passes
    // whatever the transaction does, which is the version that would have
    // been written without asking what the comment is claiming.
    await Promise.all(
      Array.from({ length: writes }, (_, i) =>
        Sync.emitRaw(projectID, workspaceID, { type: "session.status", properties: { i } }),
      ),
    )

    const events = await SyncStorage.getEvents(projectID, workspaceID)
    const seqs = events.map((record) => record.seq)
    expect(seqs.length).toBe(writes)
    // Distinct, and with no holes: `detectSequenceGap` reads a hole as deletion.
    expect(new Set(seqs).size).toBe(writes)
    expect(seqs.toSorted((a, b) => a - b)).toEqual(Array.from({ length: writes }, (_, i) => i + 1))
  })

  it("keeps concurrent aggregates on independent counters", async () => {
    const a = `wrk_${run}_ind_a`
    const b = `wrk_${run}_ind_b`

    await Promise.all([
      ...Array.from({ length: 10 }, () => Sync.emitRaw(projectID, a, { type: "t", properties: {} })),
      ...Array.from({ length: 10 }, () => Sync.emitRaw(projectID, b, { type: "t", properties: {} })),
    ])

    // Per aggregate, not global: one busy workspace must not advance another's
    // cursor, or every reader of the quiet one sees a gap that is not there.
    for (const aggregate of [a, b]) {
      const seqs = (await SyncStorage.getEvents(projectID, aggregate)).map((r) => r.seq)
      expect(seqs.toSorted((x, y) => x - y)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1))
    }
  })

  it("returns a cursor read in seq order, whatever order the writes landed in", async () => {
    const workspaceID = `wrk_${run}_cursor`
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        Sync.emitRaw(projectID, workspaceID, { type: "session.status", properties: { i } }),
      ),
    )

    const all = await SyncStorage.getEvents(projectID, workspaceID)
    const tail = await SyncStorage.getEvents(projectID, workspaceID, 6)
    expect(all.map((r) => r.seq)).toEqual([...all.map((r) => r.seq)].toSorted((a, b) => a - b))
    expect(tail.map((r) => r.seq)).toEqual([7, 8, 9, 10, 11, 12])
  })

  it("leaves no gap for the detector to find after a concurrent burst", async () => {
    // The two halves meeting: a burst that produced holes would make a
    // reconnecting client resync for nothing, or worse, not resync at all.
    const { detectSequenceGap } = await import("@/sync/gap")
    const workspaceID = `wrk_${run}_gapfree`
    await Promise.all(
      Array.from({ length: 20 }, () => Sync.emitRaw(projectID, workspaceID, { type: "t", properties: {} })),
    )

    const seqs = (await SyncStorage.getEvents(projectID, workspaceID)).map((r) => r.seq).toSorted((a, b) => a - b)
    for (let i = 1; i < seqs.length; i++) {
      expect(detectSequenceGap({ fromSeq: seqs[i - 1], oldestAvailableSeq: seqs[i] })).toBeUndefined()
    }
  })
})

/**
 * The cross-process case.
 *
 * The server runs a process per workspace, so several of them sharing
 * `nikcli.db` is the production shape rather than a contrived one, and it is
 * the only arrangement where the read and the append could interleave at all —
 * the driver is synchronous, so one process cannot race itself.
 */
describe("sequence assignment across processes (EOT-15)", () => {
  it("hands every process a distinct seq on one aggregate", async () => {
    const aggregate = `wrk_${run}_xproc`
    const processes = 4
    const perProcess = 15

    const script = path.join(import.meta.dirname, "..", "..", "script", "sync-append-burst.ts")
    const spawned = Array.from({ length: processes }, () =>
      Bun.spawn(["bun", "run", script, projectID, aggregate, String(perProcess)], {
        cwd: path.join(import.meta.dirname, "..", ".."),
        env: { ...process.env, NIKCLI_TEST_HOME: testDir, NIKCLI_DB: path.join(testDir, "nikcli.db") },
        stdout: "ignore",
        stderr: "pipe",
      }),
    )
    const codes = await Promise.all(spawned.map((proc) => proc.exited))
    expect(codes).toEqual(Array.from({ length: processes }, () => 0))

    const seqs = (await SyncStorage.getEvents(projectID, aggregate)).map((record) => record.seq)
    const expected = processes * perProcess
    expect(seqs.length).toBe(expected)
    // The failure this exists for: two processes reading the same sequence and
    // both writing it. The reader then sees fewer events than were appended and
    // `detectSequenceGap` finds no hole to report, because there is none — the
    // event was overwritten, not deleted.
    expect(new Set(seqs).size).toBe(expected)
    expect(seqs.toSorted((a, b) => a - b)).toEqual(Array.from({ length: expected }, (_, i) => i + 1))
  }, 120_000)
})
