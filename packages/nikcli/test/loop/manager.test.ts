import { preserveTestEnv } from "../helpers/env"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Database } from "@/database/database"
import { Instance } from "@/project/instance"
import { loop, loopRun } from "@/loop/loop.sql"
import * as Manager from "@/loop/manager"
import { generateID, type LoopDefinition, type LoopRun } from "@/loop/schema"
import { InstanceState, type InstanceContext } from "@/effect"
import { testDb } from "../helpers/sqlite"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-loop-manager-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-loop-manager-project-"))
const resolvedDir = await fs.realpath(projectDir)

/**
 * Enter an instance scope and hand the body the instance. The manager takes
 * the project id explicitly now, so the scope is here to satisfy everything
 * *below* the manager; the id itself is passed. Re-uses the `Instance.provide`
 * cache keyed on `resolvedDir`, so it is cheap across many tests.
 */
async function withInstance<A>(fn: (instance: InstanceContext) => Promise<A>): Promise<A> {
  return Instance.provide({
    directory: resolvedDir,
    fn: async () => fn(InstanceState.ambient()),
  })
}

afterEach(() => {
  const db = testDb(Database)
  db.delete(loopRun).run()
  db.delete(loop).run()
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await fs.rm(testHome, { recursive: true, force: true })
  await fs.rm(projectDir, { recursive: true, force: true })
})

function makeDef(overrides: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: generateID(),
    name: "test loop",
    stages: [{ name: "stage", agent: "ralph", objective: "do it" }],
    trigger: { kind: "manual" },
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("loop/manager", () => {
  it("returns an empty list when no definitions exist", async () => {
    const defs = await withInstance((inst) => Manager.list(inst.project.id))
    expect(Array.isArray(defs)).toBe(true)
    expect(defs).toHaveLength(0)
  })

  it("upserts and reads back a definition", async () => {
    const def = makeDef({ name: "round-trip" })
    const saved = await withInstance((inst) => Manager.upsert(inst.project.id, def))
    expect(saved.id).toBe(def.id)
    expect(saved.name).toBe("round-trip")
    const back = await withInstance((inst) => Manager.get(inst.project.id, def.id))
    expect(back).toEqual(saved)
  })

  it("rejects invalid definitions with a thrown error", async () => {
    const bad = makeDef({
      // SAFETY: the empty objective is the invalid value under test; the
      // assertion only stops the literal from narrowing.
      stages: [{ name: "s", agent: "ralph", objective: "" as string }],
    })
    await expect(withInstance((inst) => Manager.upsert(inst.project.id, bad))).rejects.toThrow()
  })

  it("setEnabled flips the flag and returns the updated definition", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    const next = await withInstance((inst) => Manager.setEnabled(inst.project.id, def.id, false))
    expect(next?.enabled).toBe(false)
  })

  it("setWorktree records the sandbox handle", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    const next = await withInstance((inst) =>
      Manager.setWorktree(inst.project.id, def.id, {
        name: "worktree-loop-test",
        branch: "nikcli/loop/worktree-loop-test",
        directory: "/tmp/project/.nikcli/.worktrees/worktree-loop-test",
      }),
    )
    expect(next?.worktree?.directory).toBe("/tmp/project/.nikcli/.worktrees/worktree-loop-test")
  })

  it("keeps the sandbox handle when a client round-trips a definition without it", async () => {
    const def = makeDef({ name: "editable" })
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    await withInstance((inst) =>
      Manager.setWorktree(inst.project.id, def.id, {
        name: "worktree-loop-editable",
        directory: "/tmp/project/.nikcli/.worktrees/worktree-loop-editable",
      }),
    )
    // What the TUI edit dialog / a REST PUT sends: the whole definition,
    // minus the server-owned fields it never knew about.
    const edited = await withInstance((inst) => Manager.upsert(inst.project.id, { ...def, name: "renamed" }))
    expect(edited.name).toBe("renamed")
    expect(edited.worktree?.directory).toBe("/tmp/project/.nikcli/.worktrees/worktree-loop-editable")
  })

  it("defaults to sandboxed and honours an explicit opt-out", async () => {
    const on = await withInstance((inst) => Manager.upsert(inst.project.id, makeDef()))
    expect(on.sandbox).toBeUndefined()
    const off = await withInstance((inst) => Manager.upsert(inst.project.id, makeDef({ sandbox: false })))
    expect(off.sandbox).toBe(false)
  })

  it("setEnabled returns undefined for unknown loops", async () => {
    const result = await withInstance((inst) => Manager.setEnabled(inst.project.id, "nope", true))
    expect(result).toBeUndefined()
  })

  it("remove returns false for unknown loops and true for known", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    const ok = await withInstance((inst) => Manager.remove(inst.project.id, inst.directory, def.id))
    expect(ok).toBe(true)
    const missing = await withInstance((inst) => Manager.remove(inst.project.id, inst.directory, "nope"))
    expect(missing).toBe(false)
  })

  it("startRun creates a run with status=running and finishRun finalizes it", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    const run = await withInstance((inst) => Manager.startRun(inst.project.id, def.id))
    expect(run.loopID).toBe(def.id)
    expect(run.status).toBe("running")
    expect(run.ok).toBe(false)
    const finished = await withInstance((inst) =>
      Manager.finishRun(inst.project.id, def.id, run.id, {
        status: "complete",
        ok: true,
        endedAt: Date.now(),
      }),
    )
    expect(finished?.status).toBe("complete")
    expect(finished?.ok).toBe(true)
    expect(finished?.endedAt).toBeDefined()
  })

  it("finishRun preserves sessionID and error fields", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    const run = await withInstance((inst) => Manager.startRun(inst.project.id, def.id, "ses_x"))
    const finished = await withInstance((inst) =>
      Manager.finishRun(inst.project.id, def.id, run.id, {
        status: "error",
        ok: false,
        endedAt: Date.now(),
        sessionID: "ses_x",
        error: "boom",
      }),
    )
    expect(finished?.sessionID).toBe("ses_x")
    expect(finished?.error).toBe("boom")
  })

  it("listRuns returns most-recent-first", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    const a = await withInstance((inst) => Manager.startRun(inst.project.id, def.id))
    await new Promise((r) => setTimeout(r, 5))
    const b = await withInstance((inst) => Manager.startRun(inst.project.id, def.id))
    const list = await withInstance((inst) => Manager.listRuns(inst.project.id, def.id))
    expect(list.map((r: LoopRun) => r.id)).toEqual([b.id, a.id])
  })

  it("listRuns respects limit", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    for (let i = 0; i < 5; i++) await withInstance((inst) => Manager.startRun(inst.project.id, def.id))
    const list = await withInstance((inst) => Manager.listRuns(inst.project.id, def.id, 2))
    expect(list).toHaveLength(2)
  })

  it("countRuns counts every run", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    await withInstance((inst) => Manager.startRun(inst.project.id, def.id))
    await withInstance((inst) => Manager.startRun(inst.project.id, def.id))
    const count = await withInstance((inst) => Manager.countRuns(inst.project.id, def.id))
    expect(count).toBe(2)
  })

  it("remove cascade-deletes runs", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    const run = await withInstance((inst) => Manager.startRun(inst.project.id, def.id))
    await withInstance((inst) => Manager.remove(inst.project.id, inst.directory, def.id))
    const list = await withInstance((inst) => Manager.listRuns(inst.project.id, def.id))
    expect(list.find((r: LoopRun) => r.id === run.id)).toBeUndefined()
  })

  it("orphanRun flips a running record to orphaned and sets endedAt", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    const run = await withInstance((inst) => Manager.startRun(inst.project.id, def.id))
    const orphaned = await withInstance((inst) => Manager.orphanRun(inst.project.id, def.id, run.id))
    expect(orphaned?.status).toBe("orphaned")
    expect(orphaned?.ok).toBe(false)
    expect(orphaned?.endedAt).toBeDefined()
  })

  it("orphanRun is a no-op for already-finished runs", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    const run = await withInstance((inst) => Manager.startRun(inst.project.id, def.id))
    await withInstance((inst) =>
      Manager.finishRun(inst.project.id, def.id, run.id, {
        status: "complete",
        ok: true,
        endedAt: Date.now(),
      }),
    )
    const still = await withInstance((inst) => Manager.orphanRun(inst.project.id, def.id, run.id))
    expect(still?.status).toBe("complete")
  })

  it("listRunningRuns returns only running records", async () => {
    const def1 = makeDef()
    const def2 = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def1))
    await withInstance((inst) => Manager.upsert(inst.project.id, def2))
    const run1 = await withInstance((inst) => Manager.startRun(inst.project.id, def1.id))
    const run2 = await withInstance((inst) => Manager.startRun(inst.project.id, def2.id))
    await withInstance((inst) =>
      Manager.finishRun(inst.project.id, def2.id, run2.id, {
        status: "complete",
        ok: true,
        endedAt: Date.now(),
      }),
    )
    const running = await withInstance((inst) => Manager.listRunningRuns(inst.project.id))
    const ids = running.map((r: LoopRun) => r.id)
    expect(ids).toContain(run1.id)
    expect(ids).not.toContain(run2.id)
  })

  it("listAllRunsAcrossLoops aggregates across loops sorted by recency", async () => {
    const def1 = makeDef()
    const def2 = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def1))
    await withInstance((inst) => Manager.upsert(inst.project.id, def2))
    const older = await withInstance((inst) => Manager.startRun(inst.project.id, def1.id))
    await new Promise((r) => setTimeout(r, 5))
    const newer = await withInstance((inst) => Manager.startRun(inst.project.id, def2.id))
    const all = await withInstance((inst) => Manager.listAllRunsAcrossLoops(inst.project.id, 10))
    expect(all[0].id).toBe(newer.id)
    expect(all[1].id).toBe(older.id)
  })

  it("history is capped at HISTORY_LIMIT via the internal trimRuns (verified via listRuns length)", async () => {
    const def = makeDef()
    await withInstance((inst) => Manager.upsert(inst.project.id, def))
    // Create more runs than HISTORY_LIMIT to force trimming.
    for (let i = 0; i < 60; i++) {
      const run = await withInstance((inst) => Manager.startRun(inst.project.id, def.id))
      await withInstance((inst) =>
        Manager.finishRun(inst.project.id, def.id, run.id, {
          status: "complete",
          ok: true,
          endedAt: Date.now(),
        }),
      )
    }
    const list = await withInstance((inst) => Manager.listRuns(inst.project.id, def.id))
    expect(list.length).toBeLessThanOrEqual(50)
  })
})
