import { preserveTestEnv } from "../helpers/env"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { barrier, deferred } from "../helpers/barrier"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-effect-instance-home-"))
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

const { InstanceRef, InstanceScope, InstanceState, WorkspaceRef, withInstanceAsync } = await import("@/effect")
const { Instance } = await import("@/project/instance")

const projectDirs: string[] = []

async function makeProjectDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-effect-instance-project-"))
  const resolved = await fs.realpath(dir)
  projectDirs.push(resolved)
  return resolved
}

describe("InstanceScope", () => {
  it("waits for acquisition and releases exactly once when cancellation races with acquisition", async () => {
    const directory = await makeProjectDir()
    const acquiring = barrier()
    const acquired = deferred()
    const finalizing = barrier()
    const release = deferred()
    const events: string[] = []
    const fiber = Effect.runFork(
      InstanceScope.with(
        { directory },
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.gen(function* () {
                acquiring.arrive()
                yield* Effect.promise(() => acquired.promise)
                events.push("acquired")
                return "resource"
              }),
              (resource, exit) =>
                Effect.gen(function* () {
                  expect(resource).toBe("resource")
                  expect(Exit.isFailure(exit)).toBe(true)
                  if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
                  finalizing.arrive()
                  yield* Effect.promise(() => release.promise)
                  events.push("released")
                }),
            )
            events.push("used")
          }),
        ),
      ),
    )
    let settled = false
    try {
      await acquiring.wait()
      // interruptUnsafe delivers the request synchronously before acquisition is released.
      fiber.interruptUnsafe()
      const completion = Effect.runPromise(Fiber.await(fiber)).then((exit) => {
        settled = true
        return exit
      })
      expect(settled).toBe(false)
      acquired.resolve()
      await finalizing.wait()
      expect(events).toEqual(["acquired"])
      expect(settled).toBe(false)
      release.resolve()
      const exit = await completion
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(events).toEqual(["acquired", "released"])
    } finally {
      acquired.resolve()
      release.resolve()
      await Effect.runPromise(Fiber.interrupt(fiber))
    }
    expect(events).toEqual(["acquired", "released"])
  })

  it("provides InstanceRef and InstanceState context inside an Effect boundary", async () => {
    const directory = await makeProjectDir()
    const result = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const ref = yield* InstanceRef
          const ctx = yield* InstanceState.context
          return {
            refDirectory: ref.directory,
            ctxDirectory: ctx.directory,
            projectID: ctx.project.id,
          }
        }),
      ),
    )

    expect(result.refDirectory).toBe(directory)
    expect(result.ctxDirectory).toBe(directory)
    expect(result.projectID).toBe("global")
  })

  it("provides WorkspaceRef when workspaceID is present", async () => {
    const directory = await makeProjectDir()
    const workspace = await Effect.runPromise(
      InstanceScope.with(
        { directory, workspaceID: "workspace-test" },
        Effect.gen(function* () {
          return yield* WorkspaceRef
        }),
      ),
    )

    expect(workspace.id).toBe("workspace-test")
  })

  it("exposes legacy Instance ALS reads inside the bridged effect", async () => {
    const directory = await makeProjectDir()
    const seen = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          // Legacy code paths read Instance.* from AsyncLocalStorage even when
          // invoked from inside Effect bodies — the bridge must keep that working.
          const viaSync = yield* Effect.sync(() => Instance.directory)
          const viaPromise = yield* Effect.promise(async () => Instance.directory)
          return { viaSync, viaPromise }
        }),
      ),
    )

    expect(seen.viaSync).toBe(directory)
    expect(seen.viaPromise).toBe(directory)
  })

  it("preserves typed failures across the bridge instead of squashing to Error", async () => {
    class MarkerError extends Schema.TaggedError<MarkerError>()("MarkerError", {
      detail: Schema.String,
    }) {}

    const directory = await makeProjectDir()
    const exit = await Effect.runPromiseExit(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          return yield* new MarkerError({ detail: "kept" })
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (failure._tag === "Some") {
        // SAFETY: the effect under test fails with exactly `MarkerError`, and
        // the `_tag === "Some"` guard above proves a failure was found.
        const error = failure.value as MarkerError
        expect(error._tag).toBe("MarkerError")
        expect(error.detail).toBe("kept")
      }
    }
  })

  it("propagates interruption into the bridged effect and waits for finalizers", async () => {
    const directory = await makeProjectDir()
    let finalized = false
    let started: (() => void) | undefined
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })

    const bridged = InstanceScope.with(
      { directory },
      Effect.gen(function* () {
        yield* Effect.sync(() => started!())
        yield* Effect.never
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true
          }),
        ),
      ),
    )

    const fiber = Effect.runFork(bridged)
    await startedPromise
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(finalized).toBe(true)
  })
})

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

/**
 * `withInstanceAsync` used to have two implementations: callers passing an
 * `init` went through `Instance.provide` directly and a hand-rolled fork onto
 * `AppRuntime`, everyone else went through `InstanceScope.with`. The busiest
 * callers in the codebase — the HTTP router, the websocket upgrade, workspace
 * connection — were all on the first one, so the bridge with the weaker
 * guarantees carried the most traffic. There is one path now; these pin what
 * an `init` caller must still get.
 */
describe("withInstanceAsync with an init", () => {
  it("runs init once per directory and provides the instance to the body", async () => {
    const directory = await makeProjectDir()
    let inits = 0
    const init = async () => {
      inits++
    }

    const first = await withInstanceAsync({ directory, init }, async () => Instance.directory)
    const second = await withInstanceAsync({ directory, init }, async () => Instance.directory)

    expect(first).toBe(directory)
    expect(second).toBe(directory)
    expect(inits).toBe(1)
  })

  it("bootstraps retroactively through this entry point too", async () => {
    const directory = await makeProjectDir()
    let inits = 0

    // An acquisition with no init no longer decides that the directory is
    // never bootstrapped.
    await withInstanceAsync({ directory }, async () => undefined)
    await withInstanceAsync(
      {
        directory,
        init: async () => {
          inits++
        },
      },
      async () => undefined,
    )

    expect(inits).toBe(1)
  })

  it("rejects with the body's own error, not a re-wrapped one", async () => {
    const directory = await makeProjectDir()
    class Sentinel extends Error {}
    const thrown = new Sentinel("body exploded")

    // The old init branch squashed the Cause to get here; the shared bridge
    // replays the Exit. Both preserve identity, and that is what callers
    // catching a specific error depend on.
    const caught = await withInstanceAsync({ directory, init: async () => {} }, async () => {
      throw thrown
    }).catch((error) => error)

    expect(caught).toBe(thrown)
  })

  it("provides WorkspaceRef alongside init", async () => {
    const directory = await makeProjectDir()
    const seen = await withInstanceAsync({ directory, workspaceID: "wrk_init", init: async () => {} }, async () =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* WorkspaceRef
        }).pipe(Effect.provideService(WorkspaceRef, { id: "wrk_init" })),
      ),
    )
    expect(seen.id).toBe("wrk_init")
  })

  it("forks onto a per-directory runtime whose layer provides InstanceRef", async () => {
    const directory = await makeProjectDir()
    const fromLayer = await Instance.provide({
      directory,
      fn: () =>
        Instance.runtime.runPromise(
          Effect.gen(function* () {
            const ref = yield* InstanceRef
            return ref.directory
          }),
        ),
    })
    expect(fromLayer).toBe(directory)
  })
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(projectDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await fs.rm(testHome, { recursive: true, force: true })
})
