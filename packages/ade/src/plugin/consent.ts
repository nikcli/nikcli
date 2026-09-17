/**
 * Which project plugins the user has agreed to run.
 *
 * Remembered per project and per exact list of entrypoints: a repository that
 * later adds a plugin, or points an old name at a new file, asks again. Pure,
 * over a string store, so the rule is tested rather than trusted.
 */
import type { ResolvedPlugin } from "./discovery"

export const CONSENT_KEY = "ade.pluginConsent"

type Declared = Pick<ResolvedPlugin, "spec" | "entry">

/** What was approved: the entrypoints, in a stable order. */
export function consentFingerprint(plugins: readonly Declared[]): string {
  return plugins
    .map((plugin) => plugin.entry)
    .sort()
    .join("\n")
}

function parse(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    )
  } catch {
    return {}
  }
}

export function hasConsent(raw: string | null, root: string, plugins: readonly Declared[]): boolean {
  return parse(raw)[root] === consentFingerprint(plugins)
}

/** The store with this project's approval recorded. */
export function withConsent(raw: string | null, root: string, plugins: readonly Declared[]): string {
  return JSON.stringify({ ...parse(raw), [root]: consentFingerprint(plugins) })
}

/** The question put to the user, naming every plugin that would run. */
export function consentQuestion(root: string, plugins: readonly Declared[]): string {
  const list = plugins.map((plugin) => `• ${plugin.spec}`).join("\n")
  return `Il progetto\n${root}\n\ndichiara in .nikcli/tui.json dei plugin che verrebbero eseguiti dentro ADE:\n\n${list}\n\nUn plugin è codice con accesso alle sessioni e ai file del progetto. Eseguirli?`
}
