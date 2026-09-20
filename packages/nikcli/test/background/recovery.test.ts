import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-bg-recovery-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG"])

const [{ Instance }, { BackgroundRun }, { BackgroundRunRepo }, { runPromise }] = await Promise.all([
  import("@/project/instance"),
  import("@/background/run"),
  import("@/background/repo"),
  import("@/effect/runtime"),
])

/**
 * EOT-09's release gate is *durable* terminal states and recovery, and the
 * distinction matters: `isTerminal` and `canTransition` are pure functions with
 * their own tests, and neither says anything about what is in the database
 * after a crash.
 *
 * The state this covers is the one a crash actually leaves behind — a row that
 * says `running` owned by a process that is gone. Nothing times it out on its
 * own; `reconcileInterrupted` is what turns it into a settled outcome, and
 * until it runs the TUI shows a task that will never finish. Every assertion
 * here re-reads from the repository rather than trusting the return value,
 * because "durable" is the whole claim.
 */

const created: string[] = []

/**
 * A real git project, because the project id is derived from the root commit
 * and two plain temp directories share the fallback id `global` — which would
 * put every test's rows in one table and let a leak read as a pass.
 */
async function project<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `nikcli-bg-recovery-${label}-`))
  created.push(directory)
  await fs.writeFile(path.join(directory, "marker"), `${label} ${directory}`)
  await Bun.$`git init -q && git add -A && git commit -q -m init`
    .cwd(directory)
    .env({
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    })
    .quiet()
  return Instance.provide({ directory, fn })
}

type Overrides = Partial<{
  status: BackgroundRun.Status
  ownerID: string | undefined
  heartbeatAt: number | undefined
}>

function record(id: string, over: Overrides = {}) {
  return {
    id,
    parentSessionID: "ses_parent",
    agent: "explore",
    prompt: "p",
    status: "running" as BackgroundRun.Status,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    artifactPath: `/tmp/${id}.md`,
    title: id,
    ownerID: "another-process",
    heartbeatAt: Date.now(),
    ...over,
  }
}

/** Older than the lease by a clear margin, so no clock skew decides the test. */
const STALE = () => Date.now() - BackgroundRun.LEASE_TIMEOUT_MS * 4

// The repositories return `Effect<A, QueryError>` since the drizzle 1.0 bump,
// so a repo call that is merely awaited resolves the Effect object itself and
// every assertion reads `undefined` off it. Running them is the point.
async function put(projectId: string, id: string, over: Overrides = {}) {
  await runPromise(BackgroundRunRepo.upsert(projectId, record(id, over) as never))
}

async function statusOf(projectId: string, id: string) {
  const row = await runPromise(BackgroundRunRepo.get(projectId, id))
  return (row as { status?: string } | undefined)?.status
}

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  for (const dir of created) await removeTestDir(dir)
  await removeTestDir(testHome)
})

describe("background run recovery (EOT-09)", () => {
  let counter = 0
  beforeEach(() => {
    counter++
  })

  it("settles a run whose owner died, and the outcome survives the write", async () => {
    await project(`orphan${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_dead", { heartbeatAt: STALE() })

      await BackgroundRun.reconcileInterrupted()

      // Re-read: the claim is about the database, not the return value.
      expect(await statusOf(projectId, "bg_dead")).toBe("orphaned")
    })
  })

  it("leaves a run alone while its owner is still heartbeating", async () => {
    // The failure this guards is worse than a stuck row: one process sweeping
    // a sibling's live work would settle a task that is still running.
    await project(`live${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_live", { heartbeatAt: Date.now() })

      await BackgroundRun.reconcileInterrupted()

      expect(await statusOf(projectId, "bg_live")).toBe("running")
    })
  })

  it("treats a running row with no owner at all as abandoned", async () => {
    // Written before the owner was recorded, which is the window a crash
    // during startup leaves behind.
    await project(`noowner${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_noowner", { ownerID: undefined, heartbeatAt: undefined })

      await BackgroundRun.reconcileInterrupted()

      expect(await statusOf(projectId, "bg_noowner")).toBe("orphaned")
    })
  })

  it("does not reopen a run that already settled", async () => {
    await project(`settled${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_done", { status: "complete", heartbeatAt: STALE() })

      await BackgroundRun.reconcileInterrupted()

      expect(await statusOf(projectId, "bg_done")).toBe("complete")
    })
  })

  it("skips the runs the caller says it still owns", async () => {
    // `ignore` is how the process that is doing the sweeping keeps its own
    // in-flight work: its rows are stale by wall clock but not abandoned.
    await project(`ignore${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_mine", { heartbeatAt: STALE() })
      await put(projectId, "bg_theirs", { heartbeatAt: STALE() })

      await BackgroundRun.reconcileInterrupted(new Set(["bg_mine"]))

      expect(await statusOf(projectId, "bg_mine")).toBe("running")
      expect(await statusOf(projectId, "bg_theirs")).toBe("orphaned")
    })
  })

  it("refuses to overwrite a settled outcome, durably", async () => {
    // `canTransition` is enforced at the write path, and this is the half its
    // unit test cannot reach: that the refusal reaches the database.
    await project(`finalize${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_final", { status: "complete" })

      await BackgroundRun.finalize("bg_final", "error", "second outcome", "should not land")

      expect(await statusOf(projectId, "bg_final")).toBe("complete")
    })
  })

  it("is idempotent: sweeping twice does not change a settled outcome", async () => {
    await project(`twice${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_twice", { heartbeatAt: STALE() })

      await BackgroundRun.reconcileInterrupted()
      const first = await statusOf(projectId, "bg_twice")
      await BackgroundRun.reconcileInterrupted()

      expect(first).toBe("orphaned")
      expect(await statusOf(projectId, "bg_twice")).toBe("orphaned")
    })
  })
})
