import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { coverSecrets, RECORDING_ATTRIBUTE, SENSITIVE_SELECTOR } from "./sensitive"

describe("record/sensitive", () => {
  test("password fields and the OpenRouter key are secrets even without the mark", () => {
    document.body.innerHTML = `
      <input id="a" type="password">
      <input id="openrouter-key-field" type="text">
      <div id="b" data-sensitive="true"></div>
      <input id="c" type="text">`
    const found = [...document.querySelectorAll(SENSITIVE_SELECTOR)].map((element) => element.id)
    expect(found).toEqual(["a", "openrouter-key-field", "b"])
    document.body.innerHTML = ""
  })

  test("a take covers them and the end of the take uncovers them", () => {
    const root = document.createElement("html")
    coverSecrets(true, root)
    expect(root.hasAttribute(RECORDING_ATTRIBUTE)).toBe(true)
    coverSecrets(false, root)
    expect(root.hasAttribute(RECORDING_ATTRIBUTE)).toBe(false)
  })

  test("the stylesheet covers every kind of secret the selector names", () => {
    const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf8")
    for (const part of ["[data-sensitive]", 'input[type="password"]', "#openrouter-key-field"]) {
      expect(css).toContain(`html[${RECORDING_ATTRIBUTE}] ${part}`)
      // Selecting a covered field must not paint its text back.
      expect(css).toContain(`html[${RECORDING_ATTRIBUTE}] ${part}::selection`)
    }
  })
})
