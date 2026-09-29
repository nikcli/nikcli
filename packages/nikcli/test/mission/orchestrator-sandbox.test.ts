import { preserveTestEnv } from "../helpers/env"
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
import { RunSandbox } from "@/worktree/sandbox"
import { generateID, type MissionDefinition, type MissionFeature } from "@/mission/schema"
import { testDb } from "../helpers/sqlite"

/**
 * The sandbox half of the mission contract
 * ([specs/v2/mission-orchestrator-contract.md](../../../../specs/v2/mission-orchestrator-contract.md)):
 * a mission runs in an isolated git worktree, and a resume re-attaches to the
 * worktree recorded at initialization rather than creating a second one.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mission-sandbox-home-"))
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

async function git(directory: string, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`)
  return stdout
}

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mission-sandbox-project-")))
await git(projectDir, "init", "-b", "main")
await fs.writeFile(path.join(projectDir, "README.md"), "# mission sandbox\n")
await git(projectDir, "add", "README.md")
await git(projectDir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial")

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

function makeDef(name: string, overrides: Partial<MissionDefinition> = {}): MissionDefinition {
  const feature: MissionFeature = {
    id: "a",
    name: "a",
    objective: "objective a",
    agent: "build",
    dependsOn: [],
    status: "pending",
  }
  return {
    id: generateID(),
    name,
    brief: "a brief",
    milestones: [{ id: "m1", name: "milestone one", features: [feature], validation: "none", status: "pending" }],
    models: {},
    status: "ready",
    createdAt: Date.now(),
    ...overrides,
  }
}

/** Put the single feature back to pending so the mission can be started again. */
async function rearm(project: string, def: MissionDefinition) {
  await Manager.setFeatureStatus(project, def.id, "a", "pending")
  await Manager.setMilestoneStatus(project, def.id, "m1", "pending")
  await Manager.setStatus(project, def.id, "ready")
}

describe("mission/orchestrator · sandbox", () => {
  it("runs the worker inside an isolated worktree and records it on the definition", async () => {
    const directories: Array<string | undefined> = []
    Orchestrator._internalSetGoalRunner(async (args) => {
      directories.push(args.directory)
      return { ok: true, timedOut: false }
    })

    await withInstance(async (inst) => {
      const def = makeDef("sandboxed mission")
      await Manager.upsert(inst.project.id, def)
      await Orchestrator.start(def.id)

      const saved = await Manager.get(inst.project.id, def.id)
      expect(saved?.worktree).toBeDefined()
      expect(path.dirname(saved!.worktree!.directory)).toBe(path.join(projectDir, RunSandbox.ROOT))
      expect(directories).toEqual([saved!.worktree!.directory])
      expect(directories[0]).not.toBe(projectDir)
    })
  })

  it("re-attaches the recorded worktree on a resume instead of creating a second one", async () => {
    Orchestrator._internalSetGoalRunner(async () => ({ ok: true, timedOut: false }))

    await withInstance(async (inst) => {
      const def = makeDef("resumed mission")
      await Manager.upsert(inst.project.id, def)
      await Orchestrator.start(def.id)
      const first = (await Manager.get(inst.project.id, def.id))?.worktree
      expect(first).toBeDefined()

      await rearm(inst.project.id, def)
      await Orchestrator.start(def.id)
      const second = (await Manager.get(inst.project.id, def.id))?.worktree

      expect(second).toEqual(first!)
      // And exactly one worktree on disk for this mission — a resume that
      // failed to re-attach would leave a second one beside it. Other tests in
      // this file have their own worktrees under the same root, so the count
      // is scoped to this mission's directory rather than to the root.
      const worktrees = (await git(projectDir, "worktree", "list", "--porcelain"))
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim())
      expect(worktrees.filter((dir) => dir === first!.directory)).toHaveLength(1)
      expect(worktrees.filter((dir) => path.basename(dir).includes("resumed"))).toHaveLength(1)
    })
  })

  it("leaves the host checkout untouched while the worker writes files", async () => {
    Orchestrator._internalSetGoalRunner(async (args) => {
      await fs.writeFile(path.join(args.directory!, "mission-output.md"), "# written by the mission\n")
      return { ok: true, timedOut: false }
    })

    await withInstance(async (inst) => {
      const def = makeDef("writer mission")
      await Manager.upsert(inst.project.id, def)
      await Orchestrator.start(def.id)

      const saved = await Manager.get(inst.project.id, def.id)
      expect(await Bun.file(path.join(saved!.worktree!.directory, "mission-output.md")).exists()).toBe(true)
      expect(await Bun.file(path.join(projectDir, "mission-output.md")).exists()).toBe(false)
      expect((await git(projectDir, "status", "--porcelain")).trim()).toBe("")
    })
  })

  it("runs in the host directory when the mission opts out", async () => {
    const directories: Array<string | undefined> = []
    Orchestrator._internalSetGoalRunner(async (args) => {
      directories.push(args.directory)
      return { ok: true, timedOut: false }
    })

    await withInstance(async (inst) => {
      const def = makeDef("host mission", { sandbox: false })
      await Manager.upsert(inst.project.id, def)
      await Orchestrator.start(def.id)

      expect((await Manager.get(inst.project.id, def.id))?.worktree).toBeUndefined()
      expect(directories).toEqual([undefined])
    })
  })
})
