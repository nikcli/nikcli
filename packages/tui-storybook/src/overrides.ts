import path from "path"
import type { BorderCharset, ComponentId, ComponentPatchMap } from "@tui/context/component-tokens"

/**
 * Reads and writes the same `.nikcli/components.json` the TUI loads.
 *
 * The storybook is an editor for that file and nothing more. It has no format
 * of its own and no export step: what it writes, the running TUI picks up on
 * its next theme reload, because both sides go through `readComponentPatches`.
 * A private storybook format would have needed a converter, and a converter is
 * where the two would have started to disagree.
 */

export const OVERRIDE_FILE = "components.json"

export function overridePath(directory = process.cwd()): string {
  return path.join(directory, ".nikcli", OVERRIDE_FILE)
}

export async function readOverrides(directory = process.cwd()): Promise<ComponentPatchMap> {
  // Absent is the normal state, not a failure: the file exists only once
  // somebody has changed something.
  const document = await Bun.file(overridePath(directory))
    .json()
    .catch(() => undefined)
  if (!document || typeof document !== "object" || Array.isArray(document)) return {}
  return document as ComponentPatchMap
}

export async function writeOverrides(patches: ComponentPatchMap, directory = process.cwd()): Promise<string> {
  const target = overridePath(directory)
  // Two spaces and a trailing newline: this file is meant to be opened and
  // hand-edited afterwards, and a diff against a hand edit should be one line.
  await Bun.write(target, JSON.stringify(patches, null, 2) + "\n")
  return target
}

type Numeric = "paddingTop" | "paddingBottom" | "paddingLeft" | "paddingRight" | "marginTop" | "marginBottom" | "gap"

/**
 * Sets one numeric box field, returning a new map.
 *
 * Merges rather than replaces, and drops a field that lands back on the value
 * it would have had anyway: an override file should only ever record real
 * departures from the theme, otherwise it pins values the theme can no longer
 * move and it does so invisibly.
 */
export function setBoxField(
  patches: ComponentPatchMap,
  id: ComponentId,
  field: Numeric,
  value: number,
  themeDefault: number,
): ComponentPatchMap {
  const previous = patches[id]
  const box: Record<string, unknown> = { ...previous?.box }
  if (value === themeDefault) delete box[field]
  else box[field] = value

  const next: ComponentPatchMap = { ...patches }
  if (Object.keys(box).length === 0 && !previous?.colors) delete (next as Record<string, unknown>)[id]
  else (next as Record<string, unknown>)[id] = { ...previous, box }
  return next
}

export function setCharset(
  patches: ComponentPatchMap,
  id: ComponentId,
  value: BorderCharset,
  themeDefault: BorderCharset,
): ComponentPatchMap {
  const previous = patches[id]
  const box: Record<string, unknown> = { ...previous?.box }
  if (value === themeDefault) delete box.borderCharset
  else box.borderCharset = value

  const next: ComponentPatchMap = { ...patches }
  if (Object.keys(box).length === 0 && !previous?.colors) delete (next as Record<string, unknown>)[id]
  else (next as Record<string, unknown>)[id] = { ...previous, box }
  return next
}

/** Drops every override for one component. */
export function clearComponent(patches: ComponentPatchMap, id: ComponentId): ComponentPatchMap {
  const next: ComponentPatchMap = { ...patches }
  delete (next as Record<string, unknown>)[id]
  return next
}
