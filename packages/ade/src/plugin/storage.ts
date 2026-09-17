/**
 * Where plugin state lives in ADE.
 *
 * Same two-tier shape as `packages/tui/src/plugin/storage.ts` — `memory` for
 * what may be lost, `store` for what may not — with a different backing, for
 * the reason the ADE context spells out: there is no filesystem here. `store`
 * writes to `localStorage`, which is the only durable, synchronous,
 * origin-scoped thing a webview has.
 *
 * What this deliberately does not copy from the TUI: the cross-process lock
 * and the directory watcher. Both exist because several terminals share one
 * state directory. There is one ADE window per origin, so there is nothing to
 * synchronise with, and pretending otherwise would be ceremony.
 *
 * Entries are memoized above the plugin lifecycle in both tiers, so reloading
 * a plugin hands the new generation the same live store rather than a rebuilt
 * one — a counter or a draft survives its own plugin being replaced.
 */
import { createStore, produce, type Store } from "solid-js/store"

type Entry<Value extends object> = readonly [Store<Value>, (mutation: (draft: Value) => void) => Promise<void>]
type MemoryEntry<Value extends object> = readonly [Store<Value>, (mutation: (draft: Value) => void) => void]

const memories = new Map<string, MemoryEntry<object>>()
const stored = new Map<string, Entry<object>>()

/** One storage key per plugin id + key pair, namespaced away from ADE's own. */
export function storageKey(id: string, key: string): string {
  return `ade.plugin.${id}.${key}`
}

function read(name: string): Record<string, unknown> | undefined {
  try {
    const raw = localStorage.getItem(name)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    // Arrays and primitives are rejected rather than spread: the contract says
    // the value is an object, and merging `["a"]` into one produces `{0:"a"}`,
    // which is a shape no plugin asked for and none will recognise.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    // Absent, corrupted, or a browser with storage switched off. The initial
    // value is a complete answer to all three.
    return undefined
  }
}

export interface PluginStorage {
  store<Value extends object>(key: string, options: { readonly initial: Value }): Entry<Value>
  memory<Value extends object>(key: string, options: { readonly initial: Value }): MemoryEntry<Value>
}

export function pluginStorage(id: string): PluginStorage {
  return {
    memory<Value extends object>(key: string, options: { readonly initial: Value }) {
      const full = `${id}.${key}`
      const existing = memories.get(full)
      if (existing) return existing as MemoryEntry<Value>

      const [store, setStore] = createStore<Value>(options.initial)
      const entry = [store, (mutation: (draft: Value) => void) => setStore(produce(mutation))] as const
      memories.set(full, entry as unknown as MemoryEntry<object>)
      return entry
    },

    store<Value extends object>(key: string, options: { readonly initial: Value }) {
      const name = storageKey(id, key)
      const existing = stored.get(name)
      if (existing) return existing as Entry<Value>

      const [store, setStore] = createStore<Value>({
        ...options.initial,
        ...(read(name) as Partial<Value> | undefined),
      })

      /*
       * The mutation is applied before the write, and the write's failure does
       * not undo it.
       *
       * `localStorage.setItem` throws when the quota is full or when the
       * browser is set to block site data. Rolling the store back would mean a
       * plugin's UI silently reverting the change the user just made; letting
       * it stand means the session behaves and only the persistence is lost,
       * which is the failure the user can actually live with.
       */
      const entry = [
        store,
        async (mutation: (draft: Value) => void) => {
          setStore(produce(mutation))
          try {
            localStorage.setItem(name, JSON.stringify(store))
          } catch {
            // Nothing to do here that the plugin could not do better.
          }
        },
      ] as const

      stored.set(name, entry as unknown as Entry<object>)
      return entry
    },
  }
}

/** Drops every memoized store. Only for teardown and tests. */
export function clearPluginStorage() {
  memories.clear()
  stored.clear()
}
