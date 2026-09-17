import { describe, expect, test } from "bun:test"
import { AGENTS } from "./agents"
import { hasRealMark, initialOf, REAL_MARK_IDS } from "./marks"

describe("REAL_MARK_IDS", () => {
  /*
   * The claim this list makes is "these are the actual product marks". An id
   * here that no agent has is a claim about nothing, and the drift would be
   * invisible: the launcher would simply keep drawing a monogram while this
   * file says otherwise.
   */
  test("every id named is an agent that exists", () => {
    const known = new Set(AGENTS.map((agent) => agent.id))
    for (const id of REAL_MARK_IDS) expect(known.has(id)).toBe(true)
  })

  test("no id is listed twice", () => {
    expect(new Set(REAL_MARK_IDS).size).toBe(REAL_MARK_IDS.length)
  })

  /*
   * Every agent ADE can start is now drawn with its authentic mark.
   */
  test("every agent in the catalogue is drawn with its own mark", () => {
    for (const agent of AGENTS) {
      expect(hasRealMark(agent.id)).toBe(true)
    }
  })

  test("hermes is drawn with Nous Research mark", () => {
    expect(hasRealMark("hermes")).toBe(true)
  })

  test("an agent ADE does not know has no mark", () => {
    expect(hasRealMark("qualcosaltro")).toBe(false)
    expect(hasRealMark("")).toBe(false)
  })
})

describe("initialOf", () => {
  test("the product's own initial, capitalised", () => {
    expect(initialOf("opencode")).toBe("O")
    expect(initialOf("kimi")).toBe("K")
  })

  /*
   * Taken from the id and not the label, because the id is the stable name:
   * "Kimi Code" could be relabelled tomorrow and the mark must not move
   * with it.
   */
  test("skips punctuation in a hyphenated id", () => {
    expect(initialOf("-claude-code")).toBe("C")
  })

  test("an id with no letter still draws something", () => {
    expect(initialOf("")).toBe("•")
    expect(initialOf("---")).toBe("•")
  })

  test("every agent in the catalogue produces a mark of some kind", () => {
    for (const agent of AGENTS) {
      expect(hasRealMark(agent.id) || initialOf(agent.id).length > 0).toBe(true)
    }
  })
})
