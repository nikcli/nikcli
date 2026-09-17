import { createMemo, createSignal } from "solid-js"

/**
 * Maps an array of items by a unique key, preserving object identity across updates.
 *
 * Solid's `<For>` keys by reference; wrapping items in a stable object holding a reactive
 * accessor ensures DOM nodes are preserved across selection/state changes rather than
 * being torn down and rebuilt.
 */
export function createKeyedList<T>(
  source: () => readonly T[],
  keyFn: (item: T) => string,
): () => Array<{ id: string; data: () => T }> {
  let prevMap = new Map<string, { id: string; data: () => T; set: (val: T) => void }>()

  return createMemo(() => {
    const items = source()
    const nextMap = new Map<string, { id: string; data: () => T; set: (val: T) => void }>()
    const result: Array<{ id: string; data: () => T }> = []

    for (const item of items) {
      const key = keyFn(item)
      let entry = prevMap.get(key)
      if (entry) {
        entry.set(item)
      } else {
        const [get, set] = createSignal(item)
        entry = { id: key, data: get, set }
      }
      nextMap.set(key, entry)
      result.push(entry)
    }

    prevMap = nextMap
    return result
  })
}
