import { describe, expect, test } from "bun:test"
import { parseTheme, resolveTheme, serializeTheme } from "./theme"
import type { Theme } from "./theme"

describe("resolveTheme", () => {
  test("explicit dark ignores system preference", () => {
    expect(resolveTheme("dark", false)).toBe("dark")
    expect(resolveTheme("dark", true)).toBe("dark")
  })

  test("explicit light ignores system preference", () => {
    expect(resolveTheme("light", false)).toBe("light")
    expect(resolveTheme("light", true)).toBe("light")
  })

  test("system follows OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark")
    expect(resolveTheme("system", false)).toBe("light")
  })

  test("undefined falls back to system behaviour", () => {
    expect(resolveTheme(undefined, true)).toBe("dark")
    expect(resolveTheme(undefined, false)).toBe("light")
  })

  test("null falls back to system behaviour", () => {
    expect(resolveTheme(null, true)).toBe("dark")
    expect(resolveTheme(null, false)).toBe("light")
  })
})

describe("parseTheme", () => {
  test("recognises canonical values", () => {
    expect(parseTheme("dark")).toBe("dark")
    expect(parseTheme("light")).toBe("light")
    expect(parseTheme("system")).toBe("system")
  })

  test("is case-insensitive and trims whitespace", () => {
    expect(parseTheme("  Dark ")).toBe("dark")
    expect(parseTheme("LIGHT")).toBe("light")
    expect(parseTheme(" System")).toBe("system")
  })

  test("returns system for garbage input", () => {
    expect(parseTheme("nope")).toBe("system")
    expect(parseTheme("")).toBe("system")
    expect(parseTheme("  ")).toBe("system")
  })

  test("returns system for null and undefined", () => {
    expect(parseTheme(null)).toBe("system")
    expect(parseTheme(undefined)).toBe("system")
  })
})

describe("serializeTheme", () => {
  test("round-trips through parse", () => {
    const values: Theme[] = ["dark", "light", "system"]
    for (const v of values) {
      expect(parseTheme(serializeTheme(v))).toBe(v)
    }
  })

  test("returns the canonical string", () => {
    expect(serializeTheme("dark")).toBe("dark")
    expect(serializeTheme("light")).toBe("light")
    expect(serializeTheme("system")).toBe("system")
  })
})
