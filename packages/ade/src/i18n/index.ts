/**
 * Translation for ADE: two catalogs and one function.
 *
 * `t()` reads the locale signal, so calling it inside JSX or a memo makes that
 * text follow the language as it changes. Calling it once and keeping the
 * string gives a text in the language of that moment, which is right for a
 * notice already shown and wrong for a label.
 */
import { en } from "./en"
import { it, type Messages } from "./it"
import { locale, type Locale } from "./locale"

export * from "./locale"
export type { Messages } from "./it"

export const CATALOGS: Record<Locale, Messages> = { it, en }

export type MessageKey = keyof Messages
export type MessageArgs<K extends MessageKey> = Messages[K] extends (...args: infer A) => string ? A : []

/** The text for `key` in the current language, with its values filled in. */
export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string {
  return translate(locale(), key, ...args)
}

/** The same, in a named language: for tests, and for text that must not follow the switch. */
export function translate<K extends MessageKey>(language: Locale, key: K, ...args: MessageArgs<K>): string {
  const entry = CATALOGS[language][key] as string | ((...values: unknown[]) => string)
  return typeof entry === "function" ? entry(...args) : entry
}
