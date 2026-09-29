import fs from "fs/promises"
import os from "os"
import path from "path"
import { Database as BunDatabase } from "bun:sqlite"
import { afterAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { removeTestDir } from "../helpers/fs"
import { preserveTestEnv } from "../helpers/env"
import { account } from "@/database/schema"
import { Database } from "@/database/database"
import { testDb } from "../helpers/sqlite"

/**
 * The two semantics `specs/storage/retire-database-wrapper.md` calls load-bearing.
 *
 * Each has exactly one production consumer — post-commit publication happens in
 * `src/sync/sync-event.ts` and nowhere else — so before this file a refactor
 * could have changed either without failing a test. These are a fence around
 * behavior the retirement plan has to preserve while it moves 39 files.
 *
 * Group 1 landed: the post-commit queue is reached through the `ctx` the
 * transaction body receives, not a module-level `Database.effect`. The
 * behavior below is unchanged — that is the point of the fence.
 *
 * This exercises the **synchronous** surface (`transaction`, with `testDb` for the reads), which
 * reads the process singleton rather than the Effect layer, so the database is
 * selected through `NIKCLI_DB` rather than `layerFromPath`.
 *
 * `preserveTestEnv` is not optional here. `test/preload.ts` installs a
 * `beforeEach` that deletes every `NIKCLI_*` variable outside its baseline, so a
 * plain assignment is gone before the first `it` runs — and `Database.path()`
 * then resolves the developer's real `~/.local/share/nikcli/nikcli.db` and
 * writes test rows into it.
 */

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-database-tx-"))
const dbPath = path.join(testDir, "nikcli.db")

process.env.NIKCLI_DB = dbPath
preserveTestEnv(["NIKCLI_DB"])

afterAll(async () => {
  Database.close(dbPath)
  await removeTestDir(testDir)
})

let seq = 0
function insert(tx: Database.TxOrDb, id: string) {
  const now = Date.now() + seq++
  tx.insert(account)
    .values({
      id,
      email: `${id}@example.com`,
      url: "https://example.com",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiry: now + 60_000,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

function exists(id: string) {
  return testDb(Database).select().from(account).where(eq(account.id, id)).get() !== undefined
}

describe("Database.transaction — nesting", () => {
  it("writes to the temp database, not the developer's real one", () => {
    expect(Database.path()).toBe(dbPath)
  })

  it("commits a nested write with the outer transaction", () => {
    Effect.runSync(
      Database.transaction((tx) =>
        Effect.sync(() => {
          insert(tx, "tx_outer_ok")
          Effect.runSync(Database.transaction((inner) => Effect.sync(() => insert(inner, "tx_inner_ok"))))
        }),
      ),
    )

    expect(exists("tx_outer_ok")).toBe(true)
    expect(exists("tx_inner_ok")).toBe(true)
  })

  it("rolls a nested write back when the outer transaction throws", () => {
    expect(() =>
      Effect.runSync(
        Database.transaction((tx) =>
          Effect.sync(() => {
            insert(tx, "tx_outer_rollback")
            Effect.runSync(Database.transaction((inner) => Effect.sync(() => insert(inner, "tx_inner_rollback"))))
            throw new Error("outer fails after the inner block returned")
          }),
        ),
      ),
    ).toThrow("outer fails after the inner block returned")

    // The inner block returned normally. A real nested transaction would have
    // committed independently; joining the outer one is what makes a
    // rolled-back outer discard it too.
    expect(exists("tx_inner_rollback")).toBe(false)
    expect(exists("tx_outer_rollback")).toBe(false)
  })

  it("takes the write lock up front so a concurrent writer cannot interleave", () => {
    let concurrent: string | undefined

    Effect.runSync(
      Database.transaction((tx) =>
        Effect.sync(() => {
          insert(tx, "tx_lock_holder")

          // A second connection to the same file, with no busy timeout so the
          // attempt fails immediately instead of waiting out the default 5s.
          // `behavior: "immediate"` is what makes this deterministic: under
          // SQLite's "deferred" default the outer transaction would not yet hold
          // the write lock and this BEGIN IMMEDIATE would succeed.
          const other = new BunDatabase(dbPath)
          try {
            other.exec("PRAGMA busy_timeout = 0")
            other.exec("BEGIN IMMEDIATE")
            other.exec("ROLLBACK")
          } catch (error) {
            concurrent = error instanceof Error ? error.message : String(error)
          } finally {
            other.close()
          }
        }),
      ),
    )

    expect(concurrent).toBeDefined()
    expect(exists("tx_lock_holder")).toBe(true)
  })
})

describe("TransactionContext.afterCommit — post-commit drain", () => {
  it("runs after the commit, not during the transaction", () => {
    const order: string[] = []

    Effect.runSync(
      Database.transaction((tx, ctx) =>
        Effect.sync(() => {
          ctx.afterCommit(() => order.push("effect"))
          insert(tx, "tx_effect_order")
          order.push("write")
        }),
      ),
    )
    order.push("returned")

    // Queued first, run last: the effect waits for the commit. It drains
    // before `transaction()` hands control back, so "returned" is still after.
    expect(order).toEqual(["write", "effect", "returned"])
  })

  it("does not run when the transaction rolls back", () => {
    let ran = false

    expect(() =>
      Effect.runSync(
        Database.transaction((tx, ctx) =>
          Effect.sync(() => {
            ctx.afterCommit(() => {
              ran = true
            })
            insert(tx, "tx_effect_rollback")
            throw new Error("rollback")
          }),
        ),
      ),
    ).toThrow("rollback")

    expect(ran).toBe(false)
    expect(exists("tx_effect_rollback")).toBe(false)
  })

  it("drains an effect queued in a nested block with the outermost commit", () => {
    const order: string[] = []

    Effect.runSync(
      Database.transaction((tx) =>
        Effect.sync(() => {
          Effect.runSync(
            Database.transaction((inner, innerCtx) =>
              Effect.sync(() => {
                innerCtx.afterCommit(() => order.push("inner-effect"))
                insert(inner, "tx_effect_nested")
              }),
            ),
          )
          order.push("inner-returned")
          insert(tx, "tx_effect_nested_outer")
        }),
      ),
    )

    // The effect did not fire when the inner block returned. The nested call
    // receives a context over the *outer* queue, so "inner-effect" lands after
    // "inner-returned" instead of publishing before the outer write committed.
    expect(order).toEqual(["inner-returned", "inner-effect"])
  })

  it("keeps draining after one effect throws", () => {
    const ran: string[] = []

    Effect.runSync(
      Database.transaction((tx, ctx) =>
        Effect.sync(() => {
          ctx.afterCommit(() => {
            ran.push("first")
            throw new Error("post-commit failure is logged, not propagated")
          })
          ctx.afterCommit(() => ran.push("second"))
          insert(tx, "tx_effect_throws")
        }),
      ),
    )

    expect(ran).toEqual(["first", "second"])
    // The write is already committed; a failing side effect must not undo it.
    expect(exists("tx_effect_throws")).toBe(true)
  })
})
