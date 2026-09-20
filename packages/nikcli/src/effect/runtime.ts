import { Instance } from "@/project/instance"
import { Observability } from "@/observability"
import { Log } from "@nikcli-ai/util/log"
import { Cause, Effect, Exit, Layer, Logger, ManagedRuntime, Option } from "effect"
import { currentInstance, locallyInstance, type InstanceContext } from "./instance-ref"
import { increment as lifecycleIncrement } from "./lifecycle-counters"

export const sharedMemoMap = Effect.runSync(Layer.makeMemoMap)
const runtimes = new WeakMap<Layer.Layer<any, any, never>, Map<string, ManagedRuntime.ManagedRuntime<any, any>>>()

// Effect's default logger writes to the console, which corrupts the TUI when
// runtime-internal logs fire (e.g. HttpApi span/error logs from the bridge).
// Route Effect-emitted logs into nikcli's `Log` sink instead — a file in TUI
// mode, stderr only when `--print-logs` is set.
const effectLog = Log.create({ service: "effect" })
export const LogRedirect = Logger.layer([
  Logger.make(({ message, logLevel, cause }) => {
    const text = Array.isArray(message) ? message.map((part) => String(part)).join(" ") : String(message)
    const line = cause.reasons.length > 0 ? `${text} ${Cause.pretty(cause)}` : text
    switch (logLevel) {
      case "Fatal":
      case "Error":
        effectLog.error(line)
        break
      case "Warn":
        effectLog.warn(line)
        break
      case "Debug":
      case "Trace":
        effectLog.debug(line)
        break
      default:
        effectLog.info(line)
    }
  }),
])

export function makeRuntime<R, E>(layer: Layer.Layer<R, E, never>) {
  // Merge OTLP observability into every runtime base. Memoised via the shared
  // memo map, so a single exporter/HttpClient is built and reused. No-op when
  // no OTEL endpoint is configured. `LogRedirect` replaces the console default
  // logger; the OTLP logger layer merges with whatever loggers are current.
  return ManagedRuntime.make(Layer.mergeAll(layer, LogRedirect, Observability.layer), { memoMap: sharedMemoMap })
}

export const AppRuntime = makeRuntime(Layer.empty)

function runtimeScope() {
  if (process.env.NIKCLI_TEST_MODE !== "1") return "default"
  return [process.env.NIKCLI_TEST_HOME ?? "", process.env.NIKCLI_DB ?? ""].join("\0")
}

export function runtimeFor<R, E>(layer: Layer.Layer<R, E, never>) {
  let scoped = runtimes.get(layer)
  if (!scoped) {
    scoped = new Map()
    runtimes.set(layer, scoped)
  }
  const scope = runtimeScope()
  let runtime = scoped.get(scope) as ManagedRuntime.ManagedRuntime<R, E> | undefined
  if (!runtime) {
    runtime = makeRuntime(layer)
    scoped.set(scope, runtime)
  }
  return runtime
}

/**
 * Run `effect` on the runtime built from `layer`.
 *
 * `R extends ROut` is the whole point: the layer has to provide everything the
 * effect requires. This used to be `Layer.Layer<any, LE, never>` plus a cast to
 * `Effect<A, E, any>`, which type-checked every mismatch — a caller could hand
 * over a layer providing nothing and find out at runtime.
 * `specs/effect-tui/02-effect-boundaries.md`.
 */
export function runPromiseWithLayer<A, E, R extends ROut, ROut, LE>(
  layer: Layer.Layer<ROut, LE, never>,
  effect: Effect.Effect<A, E, R>,
): Promise<A> {
  return runtimeFor(layer)
    .runPromise(effect)
    .then(
      (value) => {
        lifecycleIncrement("runtime.bridge.success")
        return value
      },
      (error) => {
        lifecycleIncrement("runtime.bridge.failure")
        throw error
      },
    )
}

export function runPromiseExitWithLayer<A, E, R extends ROut, ROut, LE>(
  layer: Layer.Layer<ROut, LE, never>,
  effect: Effect.Effect<A, E, R>,
): Promise<Exit.Exit<A, E | LE>> {
  return runtimeFor(layer)
    .runPromiseExit(effect)
    .then((exit) => {
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
        lifecycleIncrement("runtime.bridge.interrupted")
      } else if (Exit.isFailure(exit)) {
        lifecycleIncrement("runtime.bridge.failure")
      } else {
        lifecycleIncrement("runtime.bridge.success")
      }
      return exit
    })
}

export function withCurrentInstance<A, E, R>(effect: Effect.Effect<A, E, R>) {
  // Deliberately not an `Effect.gen`: this wraps every `Bus.publish`, i.e. once
  // per streaming token, and a generator frame per call is measurable there.
  return Effect.flatMap(currentInstance, (fiberCtx) => {
    if (Option.isSome(fiberCtx)) return effect
    // R2 boundary: Promise→Effect bridge. Do not delete — ~165 call sites have no context.
    const ctx: InstanceContext = {
      directory: Instance.directory,
      worktree: Instance.worktree,
      project: Instance.project,
    }
    return locallyInstance(ctx, effect)
  }) as Effect.Effect<A, E, R>
}

export function runPromise<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return AppRuntime.runPromise(effect)
}
