import type { Context } from "./context.js"

export type { Context }

export type Cleanup = () => Promise<void> | void

/**
 * Identical in shape to `v2/tui/plugin.ts`, and that is the point: the entry
 * form a plugin author writes does not change between surfaces, only the
 * context they are handed does. A module can export both by re-reading
 * `context.ui` — what it cannot do is assume which one it got.
 */
export interface Definition {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}

export function define(plugin: Definition) {
  return plugin
}
