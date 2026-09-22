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

// Spelled out rather than `BackgroundRun.Status`: the module is pulled in with
// a dynamic import so the binding is a value, and its namespace is not in scope
// for types. Kept in step with `StatusSchema` in `src/background/run.ts`.
type Status = "running" | "complete" | "error" | "timeout" | "cancelled" | "orphaned"

type Overrides = Partial<{
  status: Status
  ownerID: string | undefined
  heartbeatAt: number | undefined
  sessionID: string | undefined
  completedAt: number | undefined
  resumeCount: number
}>

function record(id: string, over: Overrides = {}) {
  return {
    id,
    parentSessionID: "ses_parent",
    agent: "explore",
    prompt: "p",
    status: "running" as Status,
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

  it("leaves our own run alone when its heartbeat interval was starved", async () => {
    // The reported failure: under load or after the machine suspends, the 5s
    // heartbeat misses its window and the 15s sweep settles a delegation that
    // is still running in this process.
    await project(`self${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_self", { ownerID: BackgroundRun.OWNER_ID, heartbeatAt: STALE() })

      await BackgroundRun.reconcileInterrupted()

      expect(await statusOf(projectId, "bg_self")).toBe("running")
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

  it("reopen puts an orphaned run back under this process's lease", async () => {
    await project(`reopen${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_reopen", { status: "orphaned", completedAt: Date.now() })

      const reopened = await BackgroundRun.reopen("bg_reopen")

      expect(reopened?.status).toBe("running")
      expect(reopened?.ownerID).toBe(BackgroundRun.OWNER_ID)
      expect(reopened?.resumeCount).toBe(1)
      expect(await statusOf(projectId, "bg_reopen")).toBe("running")
    })
  })

  it("reopen refuses a run that finished or that the user stopped", async () => {
    // Restarting these would replace an outcome the run actually reached.
    await project(`noreopen${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_complete", { status: "complete" })
      await put(projectId, "bg_cancelled", { status: "cancelled" })

      expect(await BackgroundRun.reopen("bg_complete")).toBeUndefined()
      expect(await BackgroundRun.reopen("bg_cancelled")).toBeUndefined()
      expect(await statusOf(projectId, "bg_complete")).toBe("complete")
      expect(await statusOf(projectId, "bg_cancelled")).toBe("cancelled")
    })
  })

  it("reopen stops at the attempt cap, so a crash loop cannot restart forever", async () => {
    await project(`cap${counter}`, async () => {
      const projectId = Instance.project.id
      await put(projectId, "bg_cap", {
        status: "orphaned",
        resumeCount: BackgroundRun.MAX_RESUME_ATTEMPTS,
      })

      expect(await BackgroundRun.reopen("bg_cap")).toBeUndefined()
      expect(await statusOf(projectId, "bg_cap")).toBe("orphaned")
    })
  })

  it("only crash-killed, recent, unexhausted runs are restarted unattended", async () => {
    // Everything excluded here is a run the user should decide about: a failure
    // to retry, work old enough to be forgotten, or one already retried to death.
    await project(`auto${counter}`, async () => {
      const projectId = Instance.project.id
      const recent = { status: "orphaned" as Status, sessionID: "ses_x", completedAt: Date.now() }
      await put(projectId, "bg_auto", recent)
      await put(projectId, "bg_failed", { ...recent, status: "error" })
      await put(projectId, "bg_nosession", { ...recent, sessionID: undefined })
      await put(projectId, "bg_old", {
        ...recent,
        completedAt: Date.now() - BackgroundRun.RESUME_WINDOW_MS - 1_000,
      })
      await put(projectId, "bg_exhausted", { ...recent, resumeCount: BackgroundRun.MAX_RESUME_ATTEMPTS })

      const ids = (await BackgroundRun.listAutoResumable()).map((r) => r.id)

      expect(ids).toEqual(["bg_auto"])
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
