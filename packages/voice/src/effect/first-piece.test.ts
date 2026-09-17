import { describe, expect, test } from "bun:test"
import { finishedUpTo, firstPieceUpTo } from "./program"

describe("the first piece of a reply is said as soon as it can stand alone", () => {
  test("a finished sentence, as for every piece", () => {
    const text = "Parigi, ovviamente. E poi"
    expect(firstPieceUpTo(text)).toBe(finishedUpTo(text))
  })

  test("while the first sentence is written, its first clause long enough", () => {
    const text = "La capitale della Francia è Parigi, che ha"
    expect(text.slice(0, firstPieceUpTo(text))).toBe("La capitale della Francia è Parigi,")
  })

  test("not a short opening, a decimal, or a comma still at the end", () => {
    expect(firstPieceUpTo("Sì, certo, ")).toBe(0)
    expect(firstPieceUpTo("Il valore di pi greco è circa 3,14 e")).toBe(0)
    expect(firstPieceUpTo("La capitale della Francia è Parigi,")).toBe(0)
  })
})
