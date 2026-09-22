import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { InstanceReload } from "./reload"
import { Vcs } from "./vcs"
import { Flag } from "@nikcli-ai/util/flag"
import { Log } from "@nikcli-ai/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { Todo } from "../session/todo"
import { Delegation } from "@/delegation/manager"
import { Monitor } from "@/monitor/manager"
import * as LoopEngine from "@/loop/engine"
import * as MissionOrchestrator from "@/mission/orchestrator"
import { Routine } from "@/mobile/routine"
import { runPromiseWithLayer, runService, withCurrentInstance, type InstanceContext } from "@/effect"
import { Effect } from "effect"

function runProject<A, E>(effect: Effect.Effect<A, E, Project.Service>) {
  return runService(Project, effect)
}

function runPlugin<A, E>(effect: Effect.Effect<A, E, Plugin.Service>) {
  return runService(Plugin, effect, withCurrentInstance)
}

function runFile<A, E>(effect: Effect.Effect<A, E, File.Service>) {
  return runService(File, effect, withCurrentInstance)
}

function runLSP<A, E>(effect: Effect.Effect<A, E, LSP.Service>) {
  return runService(LSP, effect, withCurrentInstance)
}

// Startup inits that must not block instance creation run fire-and-forget,
// but a rejected promise must never escape as an unhandled rejection.
function background(service: string, promise: Promise<unknown>) {
  void promise.catch((error) => {
    Log.Default.warn("background init failed", { service, error })
  })
}

export async function InstanceBootstrap(instance: InstanceContext) {
  Log.Default.info("bootstrapping", { directory: instance.directory })
  await runPlugin(
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      yield* plugin.init()
    }),
  )
  background(
    "share",
    runPromiseWithLayer(
      ShareNext.defaultLayer,
      Effect.gen(function* () {
        const shareNext = yield* ShareNext.Service
        yield* shareNext.init()
      }),
    ),
  )
  background(
    "format",
    runPromiseWithLayer(
      Format.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const format = yield* Format.Service
          yield* format.init()
        }),
      ),
    ),
  )
  await runLSP(
    Effect.gen(function* () {
      const lsp = yield* LSP.Service
      yield* lsp.init()
    }),
  )
  background(
    "file-watcher",
    runPromiseWithLayer(
      FileWatcher.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const fileWatcher = yield* FileWatcher.Service
          yield* fileWatcher.init()
        }),
      ),
    ),
  )
  background(
    "file",
    runFile(
      Effect.gen(function* () {
        const file = yield* File.Service
        yield* file.init()
      }),
    ),
  )
  background(
    "vcs",
    runPromiseWithLayer(
      Vcs.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          yield* vcs.init()
        }),
      ),
    ),
  )
  background(
    "snapshot",
    runPromiseWithLayer(
      Snapshot.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          yield* snapshot.init()
        }),
      ),
    ),
  )
  background(
    "truncate",
    runPromiseWithLayer(
      Truncate.defaultLayer,
      Effect.gen(function* () {
        const truncate = yield* Truncate.Service
        yield* truncate.init()
      }),
    ),
  )
  background(
    "todo",
    runPromiseWithLayer(
      Todo.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const todo = yield* Todo.Service
          yield* todo.init()
        }),
      ),
    ),
  )
  // Event-sourced write path: projectors have to be installed before the
  // first session mutation, so this runs ahead of everything that writes.
  try {
    const { installProjectors } = await import("../sync/projectors")
    await installProjectors()
  } catch (error) {
    Log.Default.error("sync projector install failed", { error })
  }
  // Live v2 session projection — read-only subscriber of the v1 engine's
  // bus events; activating it cannot alter v1 behavior. Imported lazily:
  // session/v2 reaches back into this module's import graph via
  // session/prompt, and a static import would close that cycle.
  try {
    const { SessionV2 } = await import("../session/v2")
    SessionV2.init()
  } catch (error) {
    Log.Default.warn("session v2 projector init failed", { error })
  }
  await Delegation.init()
  // `init` has just settled the previous process's in-flight runs as orphaned,
  // so this is where they can be picked back up. Imported lazily: the task tool
  // reaches back into this module's import graph.
  try {
    const { resumeInterruptedDelegations } = await import("../tool/task")
    const resumed = await resumeInterruptedDelegations()
    if (resumed > 0) Log.Default.info("resuming interrupted delegations", { count: resumed })
  } catch (error) {
    Log.Default.warn("failed to resume interrupted delegations on startup", { error })
  }
  await Monitor.reconcile().catch((error) => {
    Log.Default.warn("failed to reconcile monitors on startup", { error })
  })
  // Restore headless interval loops for this instance. Safe to call repeatedly.
  await LoopEngine.restore().catch((error) => {
    Log.Default.warn("failed to restore loops on startup", { error })
  })
  // Restore mission orchestrator state (rehydrates runtimes, reconciles
  // orphaned execution records). Does not auto-resume missions — that is an
  // explicit user action, but a mission persisted as "running" is demoted to
  // "paused" so the user can inspect/continue it deliberately.
  await MissionOrchestrator.restore().catch((error) => {
    Log.Default.warn("failed to restore missions on startup", { error })
  })
  // Re-arm scheduled routine triggers for this instance. Without this, cron
  // routines silently stop firing after a process restart.
  await Routine.restoreSchedulers(instance).catch((error) => {
    Log.Default.warn("failed to restore routines on startup", { error })
  })

  // Arm the hourly brain review for this instance. The TUI used to do this on
  // plugin load, which meant the scheduler only ran when a terminal happened to
  // be attached — and made the terminal responsible for starting a background
  // job it does not own. Lazily imported: the brain pulls the provider chain,
  // which no bootstrap that never reviews should evaluate.
  await import("@/brain/scheduler")
    .then((module) => module.initBrainScheduler())
    .catch((error) => {
      Log.Default.warn("failed to start the brain scheduler on startup", { error })
    })

  // Config hot reload: watch the instance's config surface and invalidate
  // reloadable per-instance state when files change, announcing the reload
  // on the bus so connected clients stay in sync without a restart.
  if (!Flag.NIKCLI_DISABLE_HOT_RELOAD) {
    background(
      "hot-reload",
      InstanceReload.watch(instance).then((stop) => {
        Instance.registerDisposer(stop)
      }),
    )
  }

  // Unified backend: journal local (non-workspace) session restore events
  // into sync_event, same log the workspace loops and remote sync use.
  // Imported lazily: the bridge reaches into session/, which would close
  // an import cycle with this module if imported statically.
  if (!Flag.NIKCLI_DISABLE_SESSION_JOURNAL) {
    try {
      const { SessionSyncBridge } = await import("../session/sync-bridge")
      Instance.registerDisposer(SessionSyncBridge.init(instance))
    } catch (error) {
      Log.Default.warn("session sync bridge init failed", { error })
    }
  }

  // Optional hub-and-spoke remote sync (NIKCLI_REMOTE_URL + _TOKEN env
  // vars, or the config file's `sync` block set from the TUI /sync dialog).
  // Idempotent per (url, project); no-op when not configured.
  background(
    "remote-sync",
    import("@/sync/cli-init").then(async ({ SyncCliInit }) => {
      const stop = await SyncCliInit.initRemoteSyncFromEnv(instance)
      if (stop) Instance.registerDisposer(stop)
    }),
  )

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await runProject(
        Effect.gen(function* () {
          const project = yield* Project.Service
          yield* project.setInitialized(instance.project.id)
        }),
      )
    }
  })
}
