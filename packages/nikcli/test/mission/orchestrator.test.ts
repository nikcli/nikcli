import { preserveTestEnv } from "../helpers/env"
import { Effect } from "effect"
import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Database } from "@/database/database"
import { Instance } from "@/project/instance"
import { InstanceState, type InstanceContext } from "@/effect"
import { mission, missionExec } from "@/mission/mission.sql"
import * as Manager from "@/mission/manager"
import * as Orchestrator from "@/mission/orchestrator"
import { MissionRepo } from "@/mission/repo"
import {
  generateID,
  readyFeatures,
  MISSION_EXEC_LEASE_MS,
  type MissionDefinition,
  type MissionFeature,
  type MissionMilestone,
} from "@/mission/schema"
import { testDb } from "../helpers/sqlite"

/**
 * The lifecycle invariants in `src/mission/orchestrator.ts`
 * ([specs/v2/mission-orchestrator-contract.md](../../../../specs/v2/mission-orchestrator-contract.md)).
 *
 * The HTTP surface was already covered; the orchestrator itself was not, so
 * "features execute in dependency order" and "expired execs recover to
 * orphaned" were claims rather than checks. Worker execution is stubbed
 * through `_internalSetGoalRunner`, the seam the module exports for exactly
 * this, so no provider is involved.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mission-orch-home-"))
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

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mission-orch-project-")))

async function withInstance<A>(fn: (instance: InstanceContext) => Promise<A>): Promise<A> {
  return Instance.provide({ directory: projectDir, fn: async () => fn(InstanceState.ambient()) })
}

afterEach(async () => {
  Orchestrator._internalSetGoalRunner(undefined)
  await withInstance(async () => {
    Orchestrator.dispose()
  })
  const db = testDb(Database)
  db.delete(missionExec).run()
  db.delete(mission).run()
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await removeTestDir(testHome)
  await removeTestDir(projectDir)
})

function feature(overrides: Partial<MissionFeature> & { id: string }): MissionFeature {
  return {
    name: overrides.id,
    objective: `objective ${overrides.id}`,
    agent: "build",
    dependsOn: [],
    status: "pending",
    ...overrides,
  }
}

function makeDef(features: MissionFeature[], overrides: Partial<MissionDefinition> = {}): MissionDefinition {
  const milestone: MissionMilestone = {
    id: "m1",
    name: "milestone one",
    features,
    // Validation would add a second exec kind; ordering is the question here.
    validation: "none",
    status: "pending",
  }
  return {
    id: generateID(),
    name: "test mission",
    brief: "a brief",
    milestones: [milestone],
    models: {},
    // The host checkout is not a git repo here; sandboxing is covered by
    // `orchestrator-sandbox.test.ts`.
    sandbox: false,
    status: "ready",
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("mission/schema · readyFeatures", () => {
  it("withholds a feature until every dependency has settled", () => {
    const milestone = makeDef([feature({ id: "b", dependsOn: ["a"] }), feature({ id: "a" })]).milestones[0]
    expect(readyFeatures(milestone).map((f) => f.id)).toEqual(["a"])
  })

  it("treats skipped as settled, the same as done", () => {
    const milestone = makeDef([feature({ id: "b", dependsOn: ["a"] }), feature({ id: "a", status: "skipped" })])
      .milestones[0]
    expect(readyFeatures(milestone).map((f) => f.id)).toEqual(["b"])
  })

  it("does not release a dependant whose dependency errored", () => {
    const milestone = makeDef([feature({ id: "b", dependsOn: ["a"] }), feature({ id: "a", status: "error" })])
      .milestones[0]
    expect(readyFeatures(milestone)).toEqual([])
  })
})

describe("mission/orchestrator · dependency ordering", () => {
  it("runs a prerequisite before the feature that declares it, whatever the array order", async () => {
    const ran: string[] = []
    Orchestrator._internalSetGoalRunner(async (args) => {
      ran.push(args.objective)
      return { ok: true, timedOut: false }
    })
    await withInstance(async (inst) => {
      // "b" is listed first on purpose: index order would run it first, and
      // the point of the contract is that the dependency does.
      const def = makeDef([feature({ id: "b", dependsOn: ["a"] }), feature({ id: "a" })])
      await Manager.upsert(inst.project.id, def)
      await Orchestrator.start(def.id)

      expect(ran).toEqual(["objective a", "objective b"])
      const stored = await Manager.get(inst.project.id, def.id)
      expect(stored?.milestones[0].features.map((f) => f.status)).toEqual(["done", "done"])
    })
  })

  it("blocks the milestone instead of running a feature whose dependency failed", async () => {
    const ran: string[] = []
    Orchestrator._internalSetGoalRunner(async (args) => {
      ran.push(args.objective)
      return { ok: false, error: "worker said no", timedOut: false }
    })
    await withInstance(async (inst) => {
      const def = makeDef([feature({ id: "a" }), feature({ id: "b", dependsOn: ["a"] })])
      await Manager.upsert(inst.project.id, def)
      await Orchestrator.start(def.id)

      expect(ran).toEqual(["objective a"])
      const stored = await Manager.get(inst.project.id, def.id)
      expect(stored?.status).toBe("error")
      expect(stored?.milestones[0].status).toBe("blocked")
      expect(stored?.milestones[0].features.find((f) => f.id === "b")?.status).toBe("pending")
    })
  })
})

describe("mission/orchestrator · restore", () => {
  it("orphans an exec whose lease expired", async () => {
    await withInstance(async (inst) => {
      const def = makeDef([feature({ id: "a" })])
      await Manager.upsert(inst.project.id, def)
      const exec = await Manager.startExec(inst.project.id, def.id, "feature", "a", "a")
      const expired = Date.now() - MISSION_EXEC_LEASE_MS - 1_000
      Effect.runSync(
        MissionRepo.updateExec(inst.project.id, def.id, exec.id, (draft) => {
          draft.startedAt = expired
          draft.heartbeatAt = expired
        }),
      )

      await Orchestrator.restore()

      const execs = await Manager.listExecs(inst.project.id, def.id)
      expect(execs[0].status).toBe("orphaned")
      expect(execs[0].ok).toBe(false)
      expect(execs[0].error).toBeTruthy()
    })
  })

  it("leaves an exec with a fresh heartbeat running", async () => {
    await withInstance(async (inst) => {
      const def = makeDef([feature({ id: "a" })])
      await Manager.upsert(inst.project.id, def)
      await Manager.startExec(inst.project.id, def.id, "feature", "a", "a")

      await Orchestrator.restore()

      const execs = await Manager.listExecs(inst.project.id, def.id)
      expect(execs[0].status).toBe("running")
    })
  })

  it("demotes a mission persisted as running to paused, so a resume is explicit", async () => {
    await withInstance(async (inst) => {
      const def = makeDef([feature({ id: "a" })], { status: "running" })
      await Manager.upsert(inst.project.id, def)

      await Orchestrator.restore()

      expect((await Manager.get(inst.project.id, def.id))?.status).toBe("paused")
    })
  })
})
