import { describe, expect, test } from "bun:test"
import {
  DEFAULT_WORD_CORRECTION_THRESHOLD,
  correctCustomWords,
  editDistance,
  normalizeForMatch,
} from "./custom-words"

/** The vocabulary this project actually loses to a speech model. */
const WORDS = ["nikcli", "opencode", "worktree", "codex", "xterm", "Tauri"]

const fix = (text: string) => correctCustomWords(text, WORDS).text

describe("normalizeForMatch", () => {
  test("compares on letters and digits alone", () => {
    expect(normalizeForMatch("Open-Code!")).toBe("opencode")
    expect(normalizeForMatch("  NikCLI  ")).toBe("nikcli")
  })

  test("folds accents, which a model puts in and leaves out freely", () => {
    expect(normalizeForMatch("códex")).toBe("codex")
  })
})

describe("editDistance", () => {
  test("counts the usual edits", () => {
    expect(editDistance("nikcli", "nikcli")).toBe(0)
    expect(editDistance("nickcli", "nikcli")).toBe(1)
    expect(editDistance("", "abc")).toBe(3)
  })

  /*
   * The bound is an optimisation, and an optimisation that changes answers is
   * a bug: below the limit the number must still be exact.
   */
  test("a bounded call is exact up to the bound and merely over it beyond", () => {
    expect(editDistance("nickcli", "nikcli", 2)).toBe(1)
    expect(editDistance("qwerty", "nikcli", 2)).toBeGreaterThan(2)
  })
})

describe("correctCustomWords", () => {
  /*
   * The split is the case this exists for. A model that has never seen
   * "opencode" emits the two words it does know, and the agent is then told
   * about a thing called "open code".
   */
  test("rejoins a word the model split in two", () => {
    expect(fix("lancia open code sul progetto")).toBe("lancia opencode sul progetto")
    expect(fix("apri il work tree")).toBe("apri il worktree")
  })

  test("repairs a respelling", () => {
    expect(fix("avvia nick cli")).toBe("avvia nikcli")
  })

  test("leaves a word that is already right exactly as it is", () => {
    const result = correctCustomWords("avvia nikcli adesso", WORDS)
    expect(result.text).toBe("avvia nikcli adesso")
    expect(result.corrections).toEqual([])
  })

  test("reports what it changed, so the interface can say so", () => {
    const result = correctCustomWords("apri open code", WORDS)
    expect(result.corrections).toEqual([{ heard: "open code", wrote: "opencode" }])
  })

  test("spells the word the way the user wrote it, not the way it was heard", () => {
    expect(fix("usa tauri")).toBe("usa Tauri")
  })

  /*
   * The failure mode that makes a feature like this worse than nothing: a
   * threshold loose enough to rewrite ordinary speech into jargon. At 0.18 a
   * five-letter word tolerates no edits at all, so none of these may move.
   */
  test("does not rewrite ordinary words into jargon", () => {
    expect(fix("il codice va bene")).toBe("il codice va bene")
    expect(fix("chiudi il pannello")).toBe("chiudi il pannello")
    expect(fix("vai in alto")).toBe("vai in alto")
    expect(fix("come stai")).toBe("come stai")
    expect(fix("si")).toBe("si")
    expect(fix("no")).toBe("no")
  })

  test("an empty or wordless list changes nothing", () => {
    expect(correctCustomWords("apri open code", []).text).toBe("apri open code")
    expect(correctCustomWords("apri open code", ["", "  ", "..."]).text).toBe("apri open code")
  })

  test("keeps the spacing it was given", () => {
    expect(fix("apri\n  open code\n")).toBe("apri\n  opencode\n")
  })

  test("corrects more than once in a line", () => {
    expect(fix("apri open code e poi work tree")).toBe("apri opencode e poi worktree")
  })

  /*
   * The regression that made the first version worse than nothing: taking the
   * widest window that merely passed the threshold, rather than the closest
   * match. "open code e" is one edit from "opencode", so the conjunction was
   * absorbed into the replacement and the sentence lost a word.
   */
  test("does not swallow the word after a correction", () => {
    expect(fix("apri open code e chiudi")).toBe("apri opencode e chiudi")
    expect(fix("open code a")).toBe("opencode a")
  })

  /*
   * A longer window wins at the same position, because leaving "code" behind
   * after matching "open" is worse than not matching at all.
   */
  test("prefers the longer window over a shorter one that also matches", () => {
    expect(fix("open code")).toBe("opencode")
  })

  test("the threshold is the documented one and can be tightened", () => {
    expect(DEFAULT_WORD_CORRECTION_THRESHOLD).toBe(0.18)
    // At zero only exact matches survive, so the respelling stays as heard.
    expect(correctCustomWords("avvia nick cli", WORDS, 0).text).toBe("avvia nick cli")
  })

  test("an empty transcript is returned untouched", () => {
    expect(correctCustomWords("", WORDS)).toEqual({ text: "", corrections: [] })
  })
})
