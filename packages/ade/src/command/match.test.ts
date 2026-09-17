import { describe, expect, test } from "bun:test"
import { fuzzyMatch } from "./match"

describe("fuzzyMatch", () => {
  describe("basic matching", () => {
    test("empty query matches everything with neutral score", () => {
      const result = fuzzyMatch("", "Nuova Sessione")
      expect(result).toBeDefined()
      expect(result!.score).toBe(0)
      expect(result!.ranges).toEqual([])
    })

    test("exact substring is found", () => {
      const result = fuzzyMatch("nuova", "Nuova Sessione")
      expect(result).toBeDefined()
      expect(result!.score).toBeGreaterThan(0)
    })

    test("subsequence is found across word boundaries", () => {
      const result = fuzzyMatch("nse", "Nuova Sessione")
      expect(result).toBeDefined()
      expect(result!.ranges.length).toBeGreaterThan(0)
    })

    test("returns undefined when subsequence is not found", () => {
      expect(fuzzyMatch("xyz", "Nuova Sessione")).toBeUndefined()
    })

    test("query longer than text returns undefined", () => {
      expect(fuzzyMatch("abcdefgh", "abc")).toBeUndefined()
    })
  })

  describe("case insensitivity", () => {
    test("matches regardless of case", () => {
      expect(fuzzyMatch("NSE", "Nuova Sessione")).toBeDefined()
      expect(fuzzyMatch("nse", "NUOVA SESSIONE")).toBeDefined()
    })
  })

  describe("scoring and ranking", () => {
    test("'nse' prefers 'Nuova Sessione' over a sparse mid-word match", () => {
      const good = fuzzyMatch("nse", "Nuova Sessione")!
      const bad = fuzzyMatch("nse", "inserisci_segnalibro")!
      expect(good.score).toBeGreaterThan(bad.score)
    })

    test("word-boundary hits score higher than mid-word hits", () => {
      // "cp" should prefer "Chiudi Pannello" (two word starts) over "occupato"
      const boundary = fuzzyMatch("cp", "Chiudi Pannello")!
      const midWord = fuzzyMatch("cp", "occupato")!
      expect(boundary.score).toBeGreaterThan(midWord.score)
    })

    test("consecutive characters score higher than scattered ones", () => {
      const consecutive = fuzzyMatch("ses", "Sessione attiva")!
      const scattered = fuzzyMatch("ses", "Selezione rapida estesa")!
      expect(consecutive.score).toBeGreaterThan(scattered.score)
    })

    test("exact full match scores well", () => {
      const result = fuzzyMatch("test", "test")!
      expect(result.score).toBeGreaterThan(0)
      expect(result.ranges).toEqual([[0, 4]])
    })
  })

  describe("highlight ranges", () => {
    test("ranges are non-overlapping and ascending", () => {
      const result = fuzzyMatch("nse", "Nuova Sessione")!
      for (let i = 1; i < result.ranges.length; i++) {
        expect(result.ranges[i][0]).toBeGreaterThanOrEqual(result.ranges[i - 1][1])
      }
    })

    test("consecutive matches are merged into a single range", () => {
      const result = fuzzyMatch("ses", "Sessione")!
      // "ses" matches the first three characters — one range [0, 3)
      expect(result.ranges).toEqual([[0, 3]])
    })

    test("non-consecutive matches produce multiple ranges", () => {
      const result = fuzzyMatch("nse", "Nuova Sessione")!
      expect(result.ranges.length).toBeGreaterThanOrEqual(2)
    })

    test("single character query produces a single range of length 1", () => {
      const result = fuzzyMatch("n", "Nuova")!
      expect(result.ranges).toEqual([[0, 1]])
    })
  })

  describe("unicode", () => {
    test("matches accented characters", () => {
      const result = fuzzyMatch("à", "qualità")
      expect(result).toBeDefined()
    })

    test("works with mixed scripts", () => {
      const result = fuzzyMatch("ab", "αaβb")
      expect(result).toBeDefined()
    })
  })

  describe("edge cases", () => {
    test("single character text", () => {
      expect(fuzzyMatch("a", "a")).toBeDefined()
      expect(fuzzyMatch("b", "a")).toBeUndefined()
    })

    test("query equals text", () => {
      const result = fuzzyMatch("hello", "hello")!
      expect(result.ranges).toEqual([[0, 5]])
    })

    test("repeated characters in query", () => {
      const result = fuzzyMatch("ss", "Sessione")
      expect(result).toBeDefined()
      expect(result!.ranges.length).toBeGreaterThan(0)
    })
  })
})
