import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { THEME_STORAGE_KEY, createThemeState, type ThemeQuery, type ThemeStorage } from "./theme-state"

/** A `localStorage` that is only a Map, so a test can see what was written. */
function storageWith(initial?: string): ThemeStorage & { written: string[] } {
  const held = new Map<string, string>()
  if (initial !== undefined) held.set(THEME_STORAGE_KEY, initial)
  const written: string[] = []
  return {
    written,
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value)
      if (key === THEME_STORAGE_KEY) written.push(value)
    },
  }
}

/** A media query whose answer a test can change, as the OS would. */
function queryWith(matches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>()
  const query: ThemeQuery & { announce(next: boolean): void; listening: () => number } = {
    matches,
    addEventListener: (_type, listener) => {
      listeners.add(listener)
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener)
    },
    announce(next) {
      query.matches = next
      for (const listener of listeners) listener({ matches: next })
    },
    listening: () => listeners.size,
  }
  return query
}

describe("createThemeState", () => {
  test("follows the OS while the preference is system", () => {
    createRoot((dispose) => {
      const query = queryWith(true)
      const state = createThemeState({ storage: storageWith(), query })

      expect(state.theme()).toBe("dark")

      // The case that was broken: the OS switching under a running window.
      query.announce(false)
      expect(state.theme()).toBe("light")

      dispose()
    })
  })

  test("stops listening to the OS when the owner goes away", () => {
    const query = queryWith(true)
    createRoot((dispose) => {
      createThemeState({ storage: storageWith(), query })
      expect(query.listening()).toBe(1)
      dispose()
    })
    expect(query.listening()).toBe(0)
  })

  test("an explicit choice wins over the OS", () => {
    createRoot((dispose) => {
      const query = queryWith(true)
      const state = createThemeState({ storage: storageWith("light"), query })

      state.restore()
      expect(state.preference()).toBe("light")
      expect(state.theme()).toBe("light")

      // The OS going dark does not take the choice back.
      query.announce(true)
      expect(state.theme()).toBe("light")

      dispose()
    })
  })

  test("a stored value nobody recognises reads as system", () => {
    createRoot((dispose) => {
      const state = createThemeState({ storage: storageWith("solarized"), query: queryWith(false) })
      state.restore()
      expect(state.preference()).toBe("system")
      expect(state.theme()).toBe("light")
      dispose()
    })
  })

  test("the first toggle from system flips what is on screen, not the preference name", () => {
    createRoot((dispose) => {
      // On "system" with a dark OS the user is looking at dark, and the button
      // says "light theme". Cycling the preference instead would have gone
      // system → dark and changed nothing.
      const storage = storageWith()
      const state = createThemeState({ storage, query: queryWith(true) })

      state.toggle()
      expect(state.theme()).toBe("light")
      expect(storage.written).toEqual(["light"])

      state.toggle()
      expect(state.theme()).toBe("dark")
      expect(storage.written).toEqual(["light", "dark"])

      dispose()
    })
  })

  test("works with no storage and no media query at all", () => {
    createRoot((dispose) => {
      const state = createThemeState({ storage: undefined, query: undefined })
      // Dark is what ADE has always assumed when it cannot ask.
      expect(state.theme()).toBe("dark")
      state.restore()
      expect(state.preference()).toBe("system")
      state.toggle()
      expect(state.theme()).toBe("light")
      dispose()
    })
  })
})
