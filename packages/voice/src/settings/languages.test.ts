import { describe, expect, test } from "bun:test"
import { availableLanguages, isLanguageSupported } from "./languages"

describe("settings/languages - availableLanguages", () => {
  test("reads Parakeet languages dynamically from parakeet.js rather than a constant", () => {
    // Injectable mock proving the returned languages are derived strictly at runtime from parakeet.js
    const customLanguages = ["klingon", "elvish", "esperanto"]
    const fakeParakeetLib = {
      getModelConfig: (_modelId: string) => ({
        languages: customLanguages,
      }),
      getLanguageName: (code: string) => `Custom ${code}`,
      supportsLanguage: (_modelId: string, code?: string) => Boolean(code && customLanguages.includes(code)),
    }

    const langs = availableLanguages("parakeet", {
      parakeetLib: fakeParakeetLib,
    })

    expect(langs).toHaveLength(3)
    expect(langs.map((l) => l.code)).toEqual(customLanguages)
    expect(langs.every((l) => typeof l.label === "string" && l.label.length > 0)).toBe(true)

    // isLanguageSupported uses the same runtime contract
    expect(
      isLanguageSupported("parakeet", "elvish", {
        parakeetLib: fakeParakeetLib,
      }),
    ).toBe(true)
    expect(
      isLanguageSupported("parakeet", "it", {
        parakeetLib: fakeParakeetLib,
      }),
    ).toBe(false)
  })

  test("returns real multilingual Parakeet model languages by default", () => {
    const langs = availableLanguages("parakeet")

    // The official Parakeet TDT 0.6B v3 model supports 13 languages including Italian and English
    expect(langs.length).toBeGreaterThanOrEqual(10)
    const codes = langs.map((l) => l.code)
    expect(codes).toContain("it")
    expect(codes).toContain("en")
    expect(codes).toContain("fr")
    expect(codes).toContain("es")

    const itEntry = langs.find((l) => l.code === "it")
    expect(itEntry?.label.toLowerCase()).toContain("italiano")
  })

  test("returns ISO-639-1 languages for openrouter", () => {
    const langs = availableLanguages("openrouter")
    expect(langs.length).toBeGreaterThanOrEqual(10)
    expect(isLanguageSupported("openrouter", "it")).toBe(true)
    expect(isLanguageSupported("openrouter", "auto")).toBe(true)
  })
})
