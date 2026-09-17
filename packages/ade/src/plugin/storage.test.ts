import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { clearPluginStorage, pluginStorage, storageKey } from "./storage"

beforeEach(() => {
  clearPluginStorage()
  localStorage.clear()
})

afterEach(() => {
  clearPluginStorage()
  localStorage.clear()
})

describe("memory", () => {
  test("mutations are visible immediately", () => {
    const [state, mutate] = pluginStorage("p").memory("draft", { initial: { text: "" } })
    mutate((draft) => {
      draft.text = "ciao"
    })
    expect(state.text).toBe("ciao")
  })

  /*
   * Memoized above the plugin lifecycle on purpose: reloading a plugin hands
   * the new generation the same live store, so a counter or a half-typed
   * draft survives its own plugin being replaced.
   */
  test("the same key gives back the same live store", () => {
    const [first, mutate] = pluginStorage("p").memory("draft", { initial: { text: "" } })
    mutate((draft) => {
      draft.text = "ciao"
    })
    const [second] = pluginStorage("p").memory("draft", { initial: { text: "" } })
    expect(second).toBe(first)
    expect(second.text).toBe("ciao")
  })

  test("two plugins with the same key do not share", () => {
    const [mine, mutate] = pluginStorage("a").memory("k", { initial: { n: 0 } })
    pluginStorage("b").memory("k", { initial: { n: 0 } })
    mutate((draft) => {
      draft.n = 5
    })
    const [theirs] = pluginStorage("b").memory("k", { initial: { n: 0 } })
    expect(mine.n).toBe(5)
    expect(theirs.n).toBe(0)
  })
})

describe("store", () => {
  test("a mutation is written under a namespaced key", async () => {
    const [, mutate] = pluginStorage("p").store("prefs", { initial: { open: false } })
    await mutate((draft) => {
      draft.open = true
    })
    expect(JSON.parse(localStorage.getItem(storageKey("p", "prefs"))!)).toEqual({ open: true })
  })

  test("what was written is read back, merged over the initial value", () => {
    localStorage.setItem(storageKey("p", "prefs"), JSON.stringify({ open: true }))
    const [state] = pluginStorage("p").store("prefs", { initial: { open: false, size: 3 } })
    expect(state.open).toBe(true)
    // A key added by a later version of the plugin still gets its default.
    expect(state.size).toBe(3)
  })

  /*
   * Corrupt, absent, or the wrong shape entirely: the initial value is a
   * complete answer to all three, and a plugin must not fail to load because
   * its saved state was half-written.
   */
  test("unreadable saved state falls back to the initial value", () => {
    localStorage.setItem(storageKey("p", "a"), "{ not json")
    expect(pluginStorage("p").store("a", { initial: { n: 1 } })[0].n).toBe(1)

    localStorage.setItem(storageKey("p", "b"), JSON.stringify(["x"]))
    expect(pluginStorage("p").store("b", { initial: { n: 1 } })[0].n).toBe(1)
  })

  test("the same key gives back the same live store", () => {
    const [first] = pluginStorage("p").store("prefs", { initial: { open: false } })
    const [second] = pluginStorage("p").store("prefs", { initial: { open: false } })
    expect(second).toBe(first)
  })
})
