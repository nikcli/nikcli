import { describe, expect, test } from "bun:test"
import { CODE_LINES, SMOKE_MAX, anagramLine, rng, smokeLine } from "./anagram"

describe("anagramLine", () => {
  const line = "const session = await host.spawn({ command, cwd })"

  test("keeps the structure exactly where it was", () => {
    /*
     * This is what makes the smoke read as code rather than as noise. Every
     * space, brace, dot and equals stays at its own index; only letters and
     * digits move.
     */
    const scrambled = anagramLine(line, 7)
    expect(scrambled.length).toBe(line.length)
    for (let i = 0; i < line.length; i++) {
      const original = line[i]!
      if (!/[A-Za-z0-9]/.test(original)) {
        expect([i, scrambled[i]]).toEqual([i, original])
      }
    }
  })

  test("is an anagram: the same letters, rearranged", () => {
    const sort = (text: string) => [...text].sort().join("")
    expect(sort(anagramLine(line, 3))).toBe(sort(line))
  })

  test("is actually rearranged, not returned as it came", () => {
    expect(anagramLine(line, 3)).not.toBe(line)
  })

  test("the same seed gives the same line, twice", () => {
    // The splash has to look the same on two launches, and a test cannot
    // assert anything about output that changes every run.
    expect(anagramLine(line, 42)).toBe(anagramLine(line, 42))
    expect(anagramLine(line, 42)).not.toBe(anagramLine(line, 43))
  })

  test("survives a line with nothing to move", () => {
    expect(anagramLine("{ } => ;", 1)).toBe("{ } => ;")
    expect(anagramLine("", 1)).toBe("")
  })

  test("keeps non-ASCII letters intact rather than splitting them", () => {
    // A `[...text]` walk and not `split("")`: an accented character cut in
    // half is a replacement glyph in the middle of the smoke.
    const accented = "const città = 'però'"
    const scrambled = anagramLine(accented, 5)
    expect([...scrambled].length).toBe([...accented].length)
    expect(scrambled).toContain("à")
    expect(scrambled).toContain("ò")
  })
})

describe("rng", () => {
  test("is deterministic and stays inside 0…1", () => {
    const a = rng(99)
    const b = rng(99)
    for (let i = 0; i < 200; i++) {
      const value = a()
      expect(value).toBe(b())
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  test("a seed of zero still produces a sequence", () => {
    // A generator whose state never leaves zero returns the same number
    // forever, and every puff would then be identical.
    const next = rng(0)
    const drawn = new Set([next(), next(), next(), next()])
    expect(drawn.size).toBe(4)
  })
})

describe("smokeLine", () => {
  test("walks the catalogue rather than drawing from it at random", () => {
    // With a random draw the same line came up twice in a row often enough
    // to read as a bug.
    const first = smokeLine(0, 1)
    const second = smokeLine(1, 1)
    expect(first).not.toBe(second)
  })

  test("wraps past the end of the list, in both directions", () => {
    expect(smokeLine(CODE_LINES.length, 1)).toBe(smokeLine(0, 1))
    expect(() => smokeLine(-1, 1)).not.toThrow()
  })

  test("is a fragment, short enough not to become a banner", () => {
    /*
     * The failure this locks down: whole lines are about fifty characters,
     * six of them overlap into a solid band, and the band covers the thing
     * the picture is of.
     */
    for (let index = 0; index < 40; index++) {
      const piece = smokeLine(index, index * 3 + 1)
      expect([index, piece.length <= SMOKE_MAX]).toEqual([index, true])
      expect([index, piece.length > 0]).toEqual([index, true])
      // No leading or trailing space: a cut through one would put the puff
      // off centre by half its margin.
      expect(piece).toBe(piece.trim())
    }
  })

  test("a different seed cuts a different piece", () => {
    // `bornPuff` seeds each puff differently, so the same line coming round
    // again does not repeat the same handful of characters.
    expect(smokeLine(0, 7)).not.toBe(smokeLine(0, 8))
  })

  test("every source line has something to scramble", () => {
    for (const source of CODE_LINES) {
      const movable = [...source].filter((c) => /[A-Za-z0-9]/.test(c))
      expect([source, movable.length > 3]).toEqual([source, true])
    }
  })
})
