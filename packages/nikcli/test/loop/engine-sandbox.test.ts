import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Database } from "@/database/database"
import { Instance } from "@/project/instance"
import { loop, loopRun } from "@/loop/loop.sql"
import * as Manager from "@/loop/manager"
import * as Engine from "@/loop/engine"
import { RunSandbox } from "@/worktree/sandbox"
import { generateID, type LoopDefinition } from "@/loop/schema"
import { InstanceState, type InstanceContext } from "@/effect"
import { testDb } from "../helpers/sqlite"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-loop-sandbox-home-"))
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
  const proc = Bun.spawn(["git", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`)
  return stdout
}

const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-loop-sandbox-project-"))
const resolvedDir = await fs.realpath(projectDir)
await git(resolvedDir, "init", "-b", "main")
await fs.writeFile(path.join(resolvedDir, "README.md"), "# loop sandbox\n")
await git(resolvedDir, "add", "README.md")
await git(resolvedDir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial")

async function withInstance<A>(fn: (instance: InstanceContext) => Promise<A>): Promise<A> {
  return Instance.provide({ directory: resolvedDir, fn: async () => fn(InstanceState.ambient()) })
}

afterEach(async () => {
  Engine._internalSetStageExecutor(undefined)
  Engine._internalSetPullRequestHook(undefined)
  await withInstance(async () => {
    Engine.dispose()
  })
  const db = testDb(Database)
  db.delete(loopRun).run()
  db.delete(loop).run()
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await removeTestDir(testHome)
  await removeTestDir(projectDir)
})

function makeDef(overrides: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: generateID(),
    name: "sandboxed loop",
    stages: [{ name: "stage", agent: "build", objective: "do it" }],
    trigger: { kind: "manual" },
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("loop/engine · sandbox", () => {
  it("runs stages inside an isolated worktree and records it on the definition", async () => {
    const directories: Array<string | undefined> = []
    Engine._internalSetStageExecutor(async (_def, _stage, _sessionID, _signal, directory) => {
      directories.push(directory)
      return { ok: true }
    })

    await withInstance(async (inst) => {
      const def = makeDef()
      await Manager.upsert(inst.project.id, def)
      await Engine.runOnce(def.id)

      const saved = await Manager.get(inst.project.id, def.id)
      expect(saved?.worktree).toBeDefined()
      expect(path.dirname(saved!.worktree!.directory)).toBe(path.join(resolvedDir, RunSandbox.ROOT))
      // Every stage ran bound to the sandbox, never to the user's checkout.
      expect(directories).toEqual([saved!.worktree!.directory])
      expect(directories[0]).not.toBe(resolvedDir)
    })
  })

  it("reuses the same worktree across runs", async () => {
    Engine._internalSetStageExecutor(async () => ({ ok: true }))

    await withInstance(async (inst) => {
      const def = makeDef({ name: "reused loop" })
      await Manager.upsert(inst.project.id, def)
      await Engine.runOnce(def.id)
      const first = (await Manager.get(inst.project.id, def.id))?.worktree
      await Engine.runOnce(def.id)
      const second = (await Manager.get(inst.project.id, def.id))?.worktree
      expect(second).toEqual(first!)
    })
  })

  it("leaves the host checkout untouched while the loop writes files", async () => {
    Engine._internalSetStageExecutor(async (_def, _stage, _sessionID, _signal, directory) => {
      await fs.writeFile(path.join(directory!, "agent-output.md"), "# written by the loop\n")
      return { ok: true }
    })

    await withInstance(async (inst) => {
      const def = makeDef({ name: "writer loop" })
      await Manager.upsert(inst.project.id, def)
      await Engine.runOnce(def.id)

      const saved = await Manager.get(inst.project.id, def.id)
      expect(await Bun.file(path.join(saved!.worktree!.directory, "agent-output.md")).exists()).toBe(true)
      expect(await Bun.file(path.join(resolvedDir, "agent-output.md")).exists()).toBe(false)
      // The sandbox root is self-ignoring, so the host repo stays clean.
      expect((await git(resolvedDir, "status", "--porcelain")).trim()).toBe("")
    })
  })

  it("runs in the host directory when the loop opts out of the sandbox", async () => {
    const directories: Array<string | undefined> = []
    Engine._internalSetStageExecutor(async (_def, _stage, _sessionID, _signal, directory) => {
      directories.push(directory)
      return { ok: true }
    })

    await withInstance(async (inst) => {
      const def = makeDef({ name: "unsandboxed loop", sandbox: false })
      await Manager.upsert(inst.project.id, def)
      await Engine.runOnce(def.id)

      expect(directories).toEqual([undefined])
      expect((await Manager.get(inst.project.id, def.id))?.worktree).toBeUndefined()
    })
  })
})
