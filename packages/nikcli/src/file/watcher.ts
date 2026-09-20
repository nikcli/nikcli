import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "@nikcli-ai/util/log"
import { FileIgnore } from "./ignore"
import { Config } from "../config/config"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import { lazy } from "@nikcli-ai/util/lazy"
import { withTimeout } from "@/util/timeout"
import type ParcelWatcher from "@parcel/watcher"
import { Git } from "@/git"
import { Flag } from "@nikcli-ai/util/flag"
import { readdir } from "fs/promises"
import { InstanceState, locallyInstance, runPromiseWithLayer, type InstanceContext } from "@/effect"
import { Context, Effect, Layer, Schema } from "effect"

const SUBSCRIBE_TIMEOUT_MS = 10_000

declare const NIKCLI_LIBC: string | undefined

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })

  export const Event = {
    Updated: BusEvent.schema(
      "file.watcher.updated",
      Schema.Struct({
        file: Schema.String,
        event: Schema.Literals(["add", "change", "unlink"]),
      }),
    ),
  }

  const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
    try {
      const binding = require(
        `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${NIKCLI_LIBC || "glibc"}` : ""}`,
      )
      // SAFETY: `createWrapper` implements the `@parcel/watcher` surface over the
      // platform binding resolved just above; a missing binding throws and is
      // caught below.
      return createWrapper(binding) as typeof import("@parcel/watcher")
    } catch (error) {
      log.error("failed to load watcher binding", { error })
      return
    }
  })

  type State = {
    subs: ParcelWatcher.AsyncSubscription[]
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@nikcli/FileWatcher") {}

  function configGet(ctx: InstanceContext) {
    return runPromiseWithLayer(
      Config.defaultLayer,
      locallyInstance(
        ctx,
        Effect.gen(function* () {
          const config = yield* Config.Service
          return yield* config.get()
        }),
      ),
    )
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make<State>(
        Effect.fn("FileWatcher.state")(function* () {
          const ctx = yield* InstanceState.context
          if (ctx.project.vcs !== "git") return { subs: [] }

          log.info("init")
          const cfg = yield* Effect.promise(() => configGet(ctx))

          const backend = (() => {
            if (process.platform === "win32") return "windows"
            if (process.platform === "darwin") return "fs-events"
            if (process.platform === "linux") return "inotify"
          })()
          if (!backend) {
            log.error("watcher backend not supported", {
              platform: process.platform,
            })
            return { subs: [] }
          }
          log.info("watcher backend", { platform: process.platform, backend })

          const w = watcher()
          if (!w) return { subs: [] }

          const subscribe: ParcelWatcher.SubscribeCallback = (err, evts) => {
            if (err) return
            for (const evt of evts) {
              if (evt.type === "create") Bus.publish(Event.Updated, { file: evt.path, event: "add" })
              if (evt.type === "update") Bus.publish(Event.Updated, { file: evt.path, event: "change" })
              if (evt.type === "delete") Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
            }
          }

          const subs: ParcelWatcher.AsyncSubscription[] = []
          // Registered *before* anything is acquired. A native subscribe can stay pending for up to
          // SUBSCRIBE_TIMEOUT_MS, and the scope can close in that window (or between the two
          // subscriptions below) — registering the finalizer afterwards would leave whatever was
          // already acquired running past the instance it belongs to.
          let closed = false
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              closed = true
              await Promise.all(subs.splice(0).map((sub) => sub.unsubscribe().catch(() => undefined)))
            }),
          )
          const track = (sub: ParcelWatcher.AsyncSubscription | undefined) => {
            if (!sub) return
            // Resolved after teardown: nothing will ever unsubscribe it but us.
            if (closed) {
              void sub.unsubscribe().catch(() => undefined)
              return
            }
            subs.push(sub)
          }

          const cfgIgnores = cfg.watcher?.ignore ?? []

          if (Flag.NIKCLI_EXPERIMENTAL_FILEWATCHER) {
            const pending = w.subscribe(ctx.directory, subscribe, {
              ignore: [...FileIgnore.PATTERNS, ...cfgIgnores],
              backend,
            })
            const sub = yield* Effect.promise(() =>
              withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
                log.error("failed to subscribe to directory", { error: err })
                pending.then((s) => s.unsubscribe()).catch(() => {})
                return undefined
              }),
            )
            track(sub)
          }

          const vcsDir = yield* Effect.promise(() => Git.gitDir(ctx.worktree).catch(() => undefined))
          if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
            const gitDirContents = yield* Effect.promise(() => readdir(vcsDir).catch(() => []))
            const ignoreList = gitDirContents.filter((entry) => entry !== "HEAD")
            const pending = w.subscribe(vcsDir, subscribe, {
              ignore: ignoreList,
              backend,
            })
            const sub = yield* Effect.promise(() =>
              withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
                log.error("failed to subscribe to vcsDir", { error: err })
                pending.then((s) => s.unsubscribe()).catch(() => {})
                return undefined
              }),
            )
            track(sub)
          }

          return { subs }
        }),
      )

      const init = Effect.fn("FileWatcher.init")(function* () {
        if (Flag.disableFilewatcher()) return
        yield* InstanceState.get(state)
      })

      return Service.of({ init })
    }),
  )

  export const defaultLayer = layer
}
