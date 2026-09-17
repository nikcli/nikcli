/**
 * Shared state for the JEV plugin.
 *
 * Same split as the background plugin: the settings live in the TUI key-value
 * store, which the plugin api (`api.kv`, used by the slash commands) and the
 * dialogs (`useKV`) both reach through this one minimal interface — so a
 * command and a dialog row change exactly the same thing.
 */
import { createSignal } from "solid-js"
import { JEV_KV_KEY, normalize, type JevSettings } from "./settings"

export type KVLike = {
  get: <Value = unknown>(key: string, fallback?: Value) => Value
  set: (key: string, value: unknown) => void
}

export function readSettings(kv: KVLike): JevSettings {
  return normalize(kv.get(JEV_KV_KEY))
}

export function writeSettings(kv: KVLike, patch: Partial<JevSettings>): JevSettings {
  const next: JevSettings = { ...readSettings(kv), ...patch }
  kv.set(JEV_KV_KEY, next)
  return next
}

// Which fetch generation the panels are on. A module-level signal rather than
// component state: `/jev refresh` runs from the command palette, outside any
// open dialog, and an already-open panel still has to notice.
const [generation, setGeneration] = createSignal(0)

export const refresh = {
  get current() {
    return generation()
  },
  next() {
    setGeneration((value) => value + 1)
  },
}
