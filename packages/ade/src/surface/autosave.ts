import { createEffect, onCleanup } from "solid-js"

/**
 * Writing the workspace down, debounced but never starved.
 *
 * Four pieces that only work together and were four hundred lines apart in
 * the workbench: a debounce, a ceiling on it, a pair of listeners for the
 * window going away, and one cleanup that has to undo all of them.
 *
 * The ceiling is the part with a bug in its history. The workbench changes on
 * every line an agent prints, so a plain debounce reset its own timer several
 * times a second and the workspace was never written at all for as long as
 * anything was running — exactly the stretch worth surviving a crash.
 *
 * The listeners are the other half. The debounce means up to ten seconds of a
 * session's life is only in memory, and closing the app — or the machine
 * restarting — is exactly when that memory is discarded. `pagehide` fires in
 * every one of those cases, including an OS shutdown closing the webview, and
 * unlike `beforeunload` it is not skipped when the page is discarded from the
 * back/forward cache. `visibilitychange` to hidden covers the rest: on Windows
 * a forced shutdown can hide the window and never unload it.
 *
 * Both write synchronously, which is why the store behind `write` has to be
 * synchronous too: an async save started from `pagehide` does not finish.
 */

/** How long to wait for the changes to stop before writing. */
export const SAVE_DEBOUNCE_MS = 1000

/** The longest the first change in a burst may wait for the write. */
export const SAVE_MAX_WAIT_MS = 10_000

export interface AutosaveOptions {
  /**
   * Read for its dependencies, so the save runs when they change.
   *
   * Deliberately not the thing being saved: the workbench is a store, tracked
   * per property, and there is no single read that means "anything moved".
   */
  changed: () => unknown
  /** Writes the current state. Called on the timers and on the way out. */
  write: () => void
  /**
   * The page the listeners go on. A test passes fakes; production passes
   * nothing and gets `window` and `document`.
   */
  page?: {
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
  }
  visibility?: {
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
    readonly visibilityState: string
  }
}

export interface Autosave {
  /** Writes now, cancelling anything pending. */
  flush(): void
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const page = "page" in options ? options.page : typeof window !== "undefined" ? window : undefined
  const visibility =
    "visibility" in options ? options.visibility : typeof document !== "undefined" ? document : undefined

  let debounce: ReturnType<typeof setTimeout> | undefined
  let ceiling: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    clearTimeout(debounce)
    clearTimeout(ceiling)
    debounce = undefined
    ceiling = undefined
    options.write()
  }

  createEffect(() => {
    options.changed()
    clearTimeout(debounce)
    debounce = setTimeout(flush, SAVE_DEBOUNCE_MS)
    // Set once per burst and not reset: this is the promise that a change
    // reaches the disk within SAVE_MAX_WAIT_MS whatever arrives after it.
    if (ceiling === undefined) ceiling = setTimeout(flush, SAVE_MAX_WAIT_MS)
  })

  const onHidden = () => {
    if (visibility?.visibilityState === "hidden") flush()
  }
  page?.addEventListener("pagehide", flush)
  visibility?.addEventListener("visibilitychange", onHidden)

  // Without this, a pending write can fire after the workbench is gone.
  onCleanup(() => {
    clearTimeout(debounce)
    clearTimeout(ceiling)
    page?.removeEventListener("pagehide", flush)
    visibility?.removeEventListener("visibilitychange", onHidden)
  })

  return { flush }
}
