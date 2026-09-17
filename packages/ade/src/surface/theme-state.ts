import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { parseTheme, resolveTheme, serializeTheme, type ResolvedTheme, type Theme } from "../theme"

/**
 * The theme, as a piece of live state rather than four things scattered
 * through the workbench.
 *
 * `theme.ts` already holds the decisions — what a stored string means, what
 * "system" resolves to — and they are tested there. What lived in
 * `workbench.tsx` was everything around them: the preference signal, the
 * media query that has to be *watched* rather than sampled, the key the
 * choice is stored under, and the toggle that writes it back. Four small
 * pieces that only make sense together, and the one place they could be got
 * wrong — forgetting that "system" has to keep following the OS — is not
 * visible when they are three hundred lines apart.
 *
 * A `.ts` and not a component, so it can be tested: the DOM pieces it needs
 * are parameters with the obvious defaults.
 */

/** Where the choice is kept between launches. */
export const THEME_STORAGE_KEY = "ade.theme"

/** The bits of `localStorage` this needs, so a test can pass a fake. */
export interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The bit of `window.matchMedia` this needs, for the same reason. */
export interface ThemeQuery {
  matches: boolean
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void
}

export interface ThemeStateOptions {
  /** Absent in a test with no DOM, and then nothing is stored or restored. */
  storage?: ThemeStorage
  /** The OS preference. Absent means "assume dark", as ADE always has. */
  query?: ThemeQuery
}

export interface ThemeState {
  /** What `data-theme` should say right now. */
  theme: Accessor<ResolvedTheme>
  /** The stored preference, which may be "system". */
  preference: Accessor<Theme>
  /** Reads the preference back from storage. Safe before the DOM exists. */
  restore(): void
  /** Sets the theme the user named, and writes the choice down. */
  set(next: ResolvedTheme): void
  /** Flips dark to light and back, and writes the choice down. */
  toggle(): void
}

/** `localStorage` when there is one, and nothing at all when there is not. */
function defaultStorage(): ThemeStorage | undefined {
  if (typeof localStorage === "undefined") return undefined
  return localStorage
}

/** The OS preference, when the browser can be asked. */
function defaultQuery(): ThemeQuery | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined
  return window.matchMedia("(prefers-color-scheme: dark)") as unknown as ThemeQuery
}

export function createThemeState(options: ThemeStateOptions = {}): ThemeState {
  const storage = "storage" in options ? options.storage : defaultStorage()
  const query = "query" in options ? options.query : defaultQuery()

  // The preference is what gets stored; "system" is a real answer and has to
  // survive a reload, so the resolved value is derived rather than saved.
  const [preference, setPreference] = createSignal<Theme>("system")

  /*
   * The OS preference is watched, not sampled.
   *
   * It used to be read once per render of the memo below, which subscribes to
   * nothing: with the preference on "system", switching the OS to light in the
   * middle of a session left ADE dark until the window was reopened — and
   * "system" is the default, so that was the common case rather than a corner.
   */
  const [prefersDark, setPrefersDark] = createSignal(true)
  if (query) {
    setPrefersDark(query.matches)
    const onChange = (event: { matches: boolean }) => setPrefersDark(event.matches)
    query.addEventListener("change", onChange)
    onCleanup(() => query.removeEventListener("change", onChange))
  }

  const theme = createMemo(() => resolveTheme(preference(), prefersDark()))

  return {
    theme,
    preference,
    restore() {
      setPreference(parseTheme(storage?.getItem(THEME_STORAGE_KEY) ?? null))
    },
    set(next: ResolvedTheme) {
      setPreference(next)
      storage?.setItem(THEME_STORAGE_KEY, serializeTheme(next))
    },
    toggle() {
      /*
       * Resolved and then flipped, rather than cycling the preference.
       *
       * From "system" the user is looking at one of the two concrete themes,
       * and the button says which one it will switch to. Cycling would send
       * "system" to "dark" for someone already looking at dark, so the first
       * press of a button labelled "light theme" would change nothing.
       */
      const next: Theme = theme() === "dark" ? "light" : "dark"
      setPreference(next)
      storage?.setItem(THEME_STORAGE_KEY, serializeTheme(next))
    },
  }
}
