/**
 * What ADE is willing to believe from a plugin.
 *
 * The trust boundary, stated plainly
 * ---------------------------------
 * A plugin is third-party code running in the same JavaScript context as the
 * workbench. It can already reach `document` and `window`; nothing here
 * pretends otherwise, and this module is not a sandbox. What it does is stop
 * plugin-supplied *strings* from being used as though ADE had written them,
 * because those strings travel much further than the plugin's own code:
 *
 *  - a **command id** becomes a key in the palette's command list, and the
 *    palette dispatches by id. An unchecked id is a way to impersonate
 *    `pane.close` or `project.open` — the user picks a row that looks like
 *    ADE's own and gets the plugin's handler. Namespacing (below) makes that
 *    impossible; the charset makes the namespaced key safe to put in the DOM.
 *  - a **pane name** and a **section name** are concatenated into element ids
 *    and `data-*` attributes, and the palette already does
 *    `querySelector('[data-index="…"]')`. A name containing a quote breaks out
 *    of the selector.
 *  - a **pane id** is what `close` takes, and the workbench looks panes up by
 *    it. A plugin must not be able to name a pane it does not own.
 *
 * The rule: identifiers are validated against a strict charset and rejected on
 * the spot. Human-readable text (titles, group names) is *not* validated — it
 * reaches the DOM only as a text node, which Solid escapes — but it is clamped
 * in length, because a title with ten thousand characters is a layout attack
 * on a fixed-width palette rather than a label.
 *
 * Rejection is a throw, not a skip. A plugin that half-registers is a plugin
 * whose author sees their feature partly working and goes looking in the wrong
 * place; the runtime catches the throw, disables the plugin and says why.
 */

/**
 * Identifier charset: ASCII alphanumerics plus `. _ -`, first character
 * alphanumeric, 64 characters at most.
 *
 * Deliberately narrower than "what would be safe". Colons are excluded because
 * the host uses `:` as its own namespace separator, and a plugin that could
 * write one could forge a qualified key. Unicode is excluded because
 * confusable characters make two visually identical ids, which is the whole
 * impersonation problem again in a form no charset check would catch.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * C0, DEL and C1. Stripped from labels rather than rejected.
 *
 * A character-code test rather than a regex: written literally the class puts
 * a NUL byte in this file, and written with escapes it trips
 * `no-control-regex` — a rule worth keeping on, since the one place matching
 * a control character is wanted is exactly here.
 */
function stripControl(value: string): string {
  let out = ""
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : character
  }
  return out
}

/** Long enough for a real sentence, short enough not to break the palette. */
export const MAX_LABEL = 120

export function isValidIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value)
}

/**
 * Checks one identifier, naming what it was for so the error is actionable.
 *
 * `owner` is the plugin id (or the spec, before the id is known), `kind` is
 * what was being registered. Together they turn "invalid id" into a message
 * that says which plugin and which registration.
 */
export function assertIdentifier(owner: string, kind: string, value: unknown): string {
  if (!isValidIdentifier(value)) {
    throw new TypeError(
      `V2 ADE plugin ${owner} registered ${kind} with an invalid id ${JSON.stringify(value)}: ` +
        `expected 1-64 characters of [A-Za-z0-9._-] starting with a letter or digit`,
    )
  }
  return value
}

/**
 * A label as it may be shown.
 *
 * Anything that is not a usable string falls back to `fallback` — the
 * identifier, which is already validated — so a plugin that forgets a title
 * gets a row it can find rather than an empty one it cannot.
 */
export function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  // A stray newline in a title is a typo, not an attack, so it is collapsed
  // rather than made a reason to refuse the whole registration.
  const clean = stripControl(value).replace(/\s+/g, " ").trim()
  if (!clean) return fallback
  return clean.length > MAX_LABEL ? `${clean.slice(0, MAX_LABEL - 1)}…` : clean
}

/** Keywords, filtered to the ones that are actually searchable text. */
export function safeKeywords(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => stripControl(item).replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 0 && item.length <= MAX_LABEL)
  return list.length ? list : undefined
}

/**
 * `data` as it is allowed to reach a pane.
 *
 * Passed through by value, but only the enumerable own keys and only when the
 * whole thing is a plain object: a plugin handing the workbench something with
 * a live getter on it would have that getter run inside ADE's render, on ADE's
 * schedule, which is a different thing from passing data.
 */
export function safePaneData(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = item
  return Object.keys(out).length ? out : undefined
}

/** The separator the host owns. Plugin identifiers cannot contain it. */
export const NAMESPACE = ":"

/** How a plugin's command id is spelled once it is in ADE's global namespace. */
export function qualifiedCommandId(pluginId: string, commandId: string): string {
  return `plugin${NAMESPACE}${pluginId}${NAMESPACE}${commandId}`
}

/**
 * Reads a qualified id back, or `undefined` when it is not one of ours.
 *
 * `runCommand` uses this to decide whether a palette selection belongs to a
 * plugin before it goes looking through its own `if` chain — which is also why
 * the prefix has to be unmistakable rather than merely unlikely.
 */
export function parseCommandId(value: string): { pluginId: string; commandId: string } | undefined {
  const parts = value.split(NAMESPACE)
  if (parts.length !== 3) return undefined
  const [prefix, pluginId, commandId] = parts
  if (prefix !== "plugin") return undefined
  if (!isValidIdentifier(pluginId) || !isValidIdentifier(commandId)) return undefined
  return { pluginId, commandId }
}

/** How an open plugin pane is named in the workbench. */
export function pluginPaneId(pluginId: string, name: string, sequence: number): string {
  return `plugin${NAMESPACE}${pluginId}${NAMESPACE}${name}${NAMESPACE}${sequence}`
}
