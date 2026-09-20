import { Instance } from "@/project/instance"
import { Cause, Effect, Exit, Fiber } from "effect"
import { locallyInstance, locallyWorkspace, type InstanceContext } from "./instance-ref"
import { FINALIZER_GRACE_MS, increment as lifecycleIncrement } from "./lifecycle-counters"

export interface WithInput {
  readonly directory: string
  readonly workspaceID?: string
  /**
   * Bootstrap to run for this instance if it has not had one yet — in
   * practice always `InstanceBootstrap`, which is the only `init` passed
   * anywhere in `src`. It is a property of the instance, not of this call:
   * `Instance.provide` runs it once per directory, retroactively for an
   * instance an earlier bootstrap-free acquisition created, and shares one
   * run between concurrent askers.
   */
  readonly init?: (instance: InstanceContext) => Promise<void>
}

/**
 * `specs/effect-tui/16-workspace-isolation.md` starts here: `workspaceID` is
 * currently a value carried alongside the instance, so two workspaces on the
 * same directory share this scope's resources. That spec promotes the
 * workspace itself to the owning `Scope`, which changes what disposal releases.
 */
export const InstanceScope = {
  /**
   * Bridge an Effect into the instance scope of `input.directory`.
   *
   * The effect must execute inside `Instance.provide`'s AsyncLocalStorage
   * scope (legacy code in effect bodies still reads `Instance.directory`
   * from ALS), so it is forked onto that instance's `ManagedRuntime` from
   * within the scope. The runtime's layer provides `InstanceRef`, so fibers
   * see the instance without an ALS fallback. Unlike a plain promise
   * hand-off, the bridge stays structured:
   *
   * - the inner fiber's full Exit (typed failures, defects, interruption)
   *   is rethrown in the caller's fiber instead of being squashed to Error
   * - interrupting the caller interrupts the inner fiber and waits for its
   *   finalizers before the interruption completes
   *
   * Only instance bootstrap failures surface as the widened `Error`.
   */
  with<A, E, R>(input: WithInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Error> {
    return Effect.callback<A, E | Error>((resume) => {
      let inner: Fiber.Fiber<A, E> | undefined
      let cancelled = false
      let leakTimer: ReturnType<typeof setTimeout> | undefined
      lifecycleIncrement("scope.created")

      /** Stop the leak watchdog once the scope has actually settled. */
      const settled = () => {
        if (leakTimer === undefined) return
        clearTimeout(leakTimer)
        leakTimer = undefined
      }

      Instance.provide({
        directory: input.directory,
        init: input.init,
        fn: () => {
          // R2 boundary: builds InstanceContext inside provide after lookup/bootstrap.
          const ctx: InstanceContext = {
            directory: Instance.directory,
            worktree: Instance.worktree,
            project: Instance.project,
          }
          const scoped = input.workspaceID
            ? locallyWorkspace({ id: input.workspaceID }, locallyInstance(ctx, effect))
            : locallyInstance(ctx, effect)
          // SAFETY: `locallyInstance` (and `locallyWorkspace` when a workspace is
          // pinned) provide every requirement the effect declares. The instance
          // runtime's layer also provides `InstanceRef`; the explicit provide
          // keeps the same ctx the ALS scope just installed.
          const fiber = Instance.runtime.runFork(scoped as Effect.Effect<A, E, never>)
          inner = fiber
          if (cancelled) fiber.interruptUnsafe()
          return new Promise<Exit.Exit<A, E>>((resolve) => {
            fiber.addObserver(resolve)
          })
        },
      })
        // Instance.provide types its result as Promise<R> with R = Promise<Exit>;
        // the runtime flattens, this .then aligns the types with that.
        .then((exit) => exit)
        .then(
          // An Exit is an Effect of its own outcome: resuming with it replays
          // the inner fiber's result — including defects — in the caller's fiber.
          (exit) => {
            settled()
            // A cancelled scope was already counted by the canceller below,
            // and it still arrives here: interrupting the inner fiber makes
            // it produce an Exit, which settles this promise. Counting in
            // both places booked every cancellation twice.
            if (!cancelled) {
              const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              lifecycleIncrement(interrupted ? "scope.interrupted" : "scope.completed")
            }
            return resume(exit)
          },
          (error) => {
            // Errors reaching this branch are bootstrap failures: the inner
            // fiber never ran, so its Cause was never replayed through an
            // Exit. A scope that failed to start is not an interrupted one —
            // unless the caller is the reason it stopped, which the canceller
            // has already counted.
            settled()
            if (!cancelled) lifecycleIncrement("scope.failed")
            return resume(Effect.fail(error instanceof Error ? error : new Error(String(error), { cause: error })))
          },
        )

      return Effect.suspend(() => {
        // Counted here rather than where the Exit lands, so the counter has
        // moved by the time the caller's own interrupt completes. The Exit
        // arrives a few microtasks later, through two promise hops, and a
        // caller that interrupts and then reads the counter would otherwise
        // see the cancellation it just performed as not having happened.
        // `cancelled` is what keeps the Exit handler from counting it again.
        cancelled = true
        lifecycleIncrement("scope.interrupted")
        // `with` promises that interrupting the caller waits for the inner
        // fiber's finalizers. A finalizer that never returns turns that into
        // a scope nobody is waiting on any more, and the process shows no
        // symptom at all. Arm a watchdog so it is at least counted. Unref'd:
        // an outstanding leak must not by itself keep Bun alive.
        leakTimer = setTimeout(() => {
          leakTimer = undefined
          lifecycleIncrement("scope.finalizer-leak")
        }, FINALIZER_GRACE_MS)
        leakTimer.unref?.()
        const fiber = inner
        if (!fiber) return Effect.void
        return Effect.asVoid(Fiber.interrupt(fiber))
      })
    })
  },
}
