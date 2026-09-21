import type { ViewEntry } from "../view"
import { createSignal } from "solid-js"
import type { JSX } from "@opentui/solid"
import { ToolPartView } from "../tool-view"
import { ReasoningPart } from "./reasoning-part"
import { RetryPart } from "./retry-part"
import { SubtaskPart } from "./subtask-part"
import { SyntheticPart } from "./synthetic-part"
import { TextPart } from "./text-part"

/**
 * Every part renderer takes the same four props.
 *
 * That uniformity was already true before this registry existed — the route
 * dispatched through `<Dynamic>` with exactly this shape — which is what makes a
 * registry the cheap way to let a plugin replace one. `entry` stays loose
 * because each renderer narrows it to the entry type it handles.
 */
export type PartProps = {
  last: boolean
  streaming: boolean
  /**
   * Loose on purpose. Each renderer narrows it to the entry type it handles,
   * and `ToolPartView` takes a `ToolEntry` rather than a bare `ViewEntry` — one
   * signature cannot be both without making the table uncallable.
   */
  entry: ViewEntry
  sessionID: string
}

export type PartComponent = (props: PartProps) => JSX.Element

/**
 * Which entry types draw themselves, and how.
 *
 * `fromEntries` folds four of the ten entry types into the turn itself (`user`,
 * `start`, `complete`, `compaction`); everything else lands in `turn.body` and
 * is looked up here. Anything missing from this table used to render as
 * *nothing at all* — a retried request and a delegated sub-agent simply were not
 * in the transcript, which is a step back from what the v1 renderer showed.
 * `UnknownPart` is the backstop, so a new entry type is visible from the day it
 * ships rather than silently dropped.
 *
 * None of the rows below stream: they are written once and never change, so
 * they cost one renderable each and nothing per token.
 */
export const PART_MAPPING = {
  text: TextPart,
  tool: ToolPartView,
  reasoning: ReasoningPart,
  retry: RetryPart,
  subtask: SubtaskPart,
  synthetic: SyntheticPart,
} as unknown as Record<string, PartComponent>

/**
 * Overrides, newest last.
 *
 * A stack rather than a single value so disposal restores what was there before
 * instead of deleting the entry outright: two plugins can claim the same type,
 * and when the newer one unloads — a hot reload, a plugin disabled mid-session —
 * the older must come back rather than the type falling through to its built-in.
 * The built-in is simply the bottom of every stack.
 */
type Override = { readonly token: symbol; readonly component: PartComponent }

const [stacks, setStacks] = createSignal<Readonly<Record<string, readonly Override[]>>>({})

/**
 * Registers a renderer for one entry type. Returns the disposer.
 *
 * Idempotent per call, not per plugin: registering twice yields two entries and
 * needs two disposals. The plugin runtime already holds one disposer per
 * registration, so tracking identity here would duplicate its bookkeeping.
 */
export function registerPart(type: string, component: PartComponent): () => void {
  const token = Symbol(type)
  setStacks((current) => ({ ...current, [type]: [...(current[type] ?? []), { token, component }] }))

  let disposed = false
  return () => {
    // Guard the double dispose: a plugin that unregisters in its own cleanup and
    // is then torn down by the runtime would otherwise pop an entry that by then
    // belongs to someone else.
    if (disposed) return
    disposed = true
    setStacks((current) => {
      const stack = current[type]
      if (!stack) return current
      const next = stack.filter((entry) => entry.token !== token)
      if (next.length === stack.length) return current
      const copy = { ...current }
      if (next.length === 0) delete copy[type]
      else copy[type] = next
      return copy
    })
  }
}

/**
 * The renderer for an entry type, or `undefined` when nothing handles it.
 *
 * Reads the override signal, so a row re-renders when a plugin registers or goes
 * away. `undefined` is not a failure — it is how an unrecognised entry reaches
 * `UnknownPart`, and that path predates this registry.
 */
export function resolvePart(type: string): PartComponent | undefined {
  const stack = stacks()[type]
  if (stack && stack.length > 0) return stack[stack.length - 1]!.component
  return PART_MAPPING[type]
}

/** Every entry type with a renderer, built-ins included. */
export function partTypes(): string[] {
  return [...new Set([...Object.keys(PART_MAPPING), ...Object.keys(stacks())])].sort()
}

/** Whether a plugin, rather than the built-in table, currently owns a type. */
export function isPartOverridden(type: string): boolean {
  return (stacks()[type]?.length ?? 0) > 0
}

/** Drops every override. Test isolation only — the TUI never calls this. */
export function resetPartOverrides(): void {
  setStacks({})
}
