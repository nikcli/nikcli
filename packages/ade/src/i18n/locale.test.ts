import { afterEach, describe, expect, test } from "bun:test"
import { createRenderEffect, createRoot } from "solid-js"
import {
  LOCALE_STORAGE_KEY,
  locale,
  localePreference,
  parseLocalePreference,
  resetLocaleForTests,
  setLocalePreference,
  systemLocaleFrom,
  t,
  translate,
} from "./index"

afterEach(() => {
  resetLocaleForTests()
  localStorage.removeItem(LOCALE_STORAGE_KEY)
})

describe("the system language", () => {
  test("Italian for an Italian system, English for anything else", () => {
    expect(systemLocaleFrom(["it-IT"])).toBe("it")
    expect(systemLocaleFrom(["it"])).toBe("it")
    expect(systemLocaleFrom(["IT-ch"])).toBe("it")
    expect(systemLocaleFrom(["en-US", "it-IT"])).toBe("en")
    expect(systemLocaleFrom(["de-DE"])).toBe("en")
    expect(systemLocaleFrom(["", undefined, "it-IT"])).toBe("it")
    expect(systemLocaleFrom([])).toBe("en")
  })
})

describe("the preference", () => {
  test("anything unknown in storage reads as System", () => {
    expect(parseLocalePreference("en")).toBe("en")
    expect(parseLocalePreference("it")).toBe("it")
    expect(parseLocalePreference("system")).toBe("system")
    expect(parseLocalePreference("fr")).toBe("system")
    expect(parseLocalePreference(null)).toBe("system")
  })

  test("System follows the machine, a choice overrides it, and the choice is stored", () => {
    resetLocaleForTests("system", "en")
    expect(locale()).toBe("en")
    setLocalePreference("it")
    expect(locale()).toBe("it")
    expect(localePreference()).toBe("it")
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("it")
    expect(document.documentElement.lang).toBe("it")
    setLocalePreference("system")
    expect(locale()).toBe("en")
    expect(document.documentElement.lang).toBe("en")
  })
})

describe("t()", () => {
  test("fills in values in either language", () => {
    expect(translate("it", "settings.language.systemNow", "Italiano")).toBe("Sistema (Italiano)")
    expect(translate("en", "settings.language.systemNow", "English")).toBe("System (English)")
  })

  test("a mounted text changes language without being mounted again", () => {
    resetLocaleForTests("it")
    const host = document.createElement("div")
    let runs = 0
    const dispose = createRoot((dispose) => {
      const title = document.createElement("h3")
      // What `<h3>{t("…")}</h3>` compiles to: one render effect per text.
      createRenderEffect(() => {
        runs++
        title.textContent = t("settings.language.title")
      })
      host.append(title)
      return dispose
    })
    const node = host.firstChild
    expect(host.textContent).toBe("Lingua")
    setLocalePreference("en")
    expect(host.textContent).toBe("Language")
    expect(host.firstChild).toBe(node)
    setLocalePreference("it")
    expect(host.textContent).toBe("Lingua")
    expect(runs).toBe(3)
    dispose()
  })
})
