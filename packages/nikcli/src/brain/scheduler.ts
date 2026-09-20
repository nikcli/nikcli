import { Scheduler } from "@/scheduler"
import { AppRuntime, InstanceState } from "@/effect"
import { Brain } from "./index"
import { Log } from "@nikcli-ai/util/log"
import { Effect } from "effect"

const log = Log.create({ service: "brain-scheduler" })

export function initBrainScheduler(): void {
  // Captured at registration, not read inside `run`. `Scheduler.run` starts no
  // instance scope of its own — the task only ever found one because
  // AsyncLocalStorage propagates into a timer created inside the scope.
  const instance = InstanceState.ambient()
  Scheduler.register({
    id: "brain",
    interval: 60 * 60 * 1000,
    scope: "instance",
    async run() {
      // EOT-13: emit a span per tick. It has to run on `AppRuntime` (or any
      // runtime from `makeRuntime`) to land anywhere: those merge
      // `Observability.layer`, and a bare `Effect.runPromise` uses Effect's
      // default runtime, whose tracer discards the span silently — a span
      // that costs the allocation and reports nothing.
      try {
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const shouldTrigger = yield* Effect.promise(() => Brain.shouldTrigger(instance))
            if (!shouldTrigger) return
            log.info("brain conditions met, triggering")
            const result = yield* Effect.promise(() => Brain.trigger(instance))
            if (result.success) {
              log.info("brain completed", {
                sessionsReviewed: result.sessionsReviewed,
                hoursSinceLastBrain: result.hoursSinceLastBrain,
              })
            } else {
              log.warn("brain failed", { error: result.error })
            }
          }).pipe(
            Effect.withSpan("brain.scheduler.tick", {
              attributes: {
                "service.name": "nikcli.brain",
                "event.class": "brain.tick",
              },
            }),
          ),
        )
      } catch (e) {
        log.error("brain scheduler error", { error: String(e) })
      }
    },
  })
}
