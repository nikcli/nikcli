import { Global } from "@nikcli-ai/util/global"
import { createSignal, onCleanup, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import path from "path"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()
    const file = Bun.file(path.join(Global.Path.state, "kv.json"))

    file
      .json()
      .then((x) => {
        setStore(x)
      })
      .catch(() => {})
      .finally(() => {
        setReady(true)
      })

    let flushTimer: ReturnType<typeof setTimeout> | undefined

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        // Debounce writes to disk (flush on exit via onCleanup)
        if (flushTimer) clearTimeout(flushTimer)
        flushTimer = setTimeout(() => {
          flushTimer = undefined
          Bun.write(file, JSON.stringify(store, null, 2))
        }, 250)
      },
      flush() {
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = undefined
        }
        Bun.write(file, JSON.stringify(store, null, 2))
      },
    }

    // Ensure pending writes are flushed on exit
    const flushOnExit = () => result.flush()
    process.on("exit", flushOnExit)
    // A provider torn down before the process exits (restart, an embedding
    // host, a test) takes its listener with it, and writes only what is pending.
    onCleanup(() => {
      process.off("exit", flushOnExit)
      if (flushTimer) result.flush()
    })

    return result
  },
})
