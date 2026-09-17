/**
 * Pure theme resolution logic.
 *
 * No DOM access — all functions are deterministic and testable without a
 * browser. The component layer reads the preference from localStorage and
 * applies `data-theme` on `<html>`; this module only decides *which* value
 * to apply.
 */

/** The three settings a user can store. */
export type Theme = "dark" | "light" | "system"

/** Concrete outcome after resolving "system". */
export type ResolvedTheme = "dark" | "light"

/**
 * Resolve a preference to a concrete theme.
 *
 * "system" defers to the OS-level preference passed as the second argument.
 * An undefined or unrecognised preference defaults to "system" — the
 * safest fallback because it honours whatever the user already chose at
 * OS level without us having to guess.
 */
export function resolveTheme(
  pref: Theme | undefined | null,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (pref === "dark") return "dark"
  if (pref === "light") return "light"
  // "system", undefined, null, or anything else
  return systemPrefersDark ? "dark" : "light"
}

const VALID_THEMES = new Set<string>(["dark", "light", "system"])

/**
 * Parse a stored string into a Theme, tolerantly.
 *
 * Accepts any casing and trims whitespace. Returns "system" for anything
 * unrecognised so a corrupted localStorage value never crashes the UI.
 */
export function parseTheme(raw: string | null | undefined): Theme {
  if (raw == null) return "system"
  const normalised = raw.trim().toLowerCase()
  if (VALID_THEMES.has(normalised)) return normalised as Theme
  return "system"
}

/**
 * Serialize a Theme for storage. Returns the canonical lowercase string.
 */
export function serializeTheme(theme: Theme): string {
  return theme
}
