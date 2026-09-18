/**
 * Shared keyboard predicates.
 *
 * Three panels each grew their own copy of `isPlainShortcut`, which is how the
 * modifier rules drifted apart (one of them forgot `super`, so cmd+g on macOS
 * jumped the list). One definition, one set of rules.
 */
export type PlainKeyEvent = {
  ctrl?: boolean
  meta?: boolean
  super?: boolean
  name?: string
}

/** True when `evt` is one of `names` pressed without ctrl/meta/super. */
export function isPlainShortcut(evt: PlainKeyEvent, ...names: string[]) {
  if (evt.ctrl || evt.meta || evt.super) return false
  return names.includes(evt.name ?? "")
}
