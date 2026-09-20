import { describe, expect, it, beforeEach } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { OUTCOMES, record, reset, snapshot, summary, type Outcome } from "@/session/llm/coverage"

/**
 * EOT-11 route coverage.
 *
 * Two halves, and the second is the one that keeps this honest.
 *
 * The behaviour tests below pin the counters. The source test at the bottom
 * pins that each outcome is actually *emitted*: a counter with no call site
 * reads as "measured, none" when it means "never measured", which is the rule
 * `effect/lifecycle-counters.ts` was written under and the same trap this module
 * exists to avoid. Adding a seventh `Outcome` without the branch that records it
 * fails here.
 */

/** Module state is shared across a `bun test` run, so reset before, not only after. */
beforeEach(() => reset())

describe("llm coverage counters", () => {
  it("keys by provider and outcome, and totals across providers", () => {
    record({ outcome: "disabled", providerID: "anthropic", modelID: "claude-opus-5" })
    record({ outcome: "disabled", providerID: "anthropic", modelID: "claude-sonnet-5" })
    record({ outcome: "disabled", providerID: "openai", modelID: "gpt-5" })
    record({ outcome: "native", providerID: "openai", modelID: "gpt-5" })

    const s = snapshot()
    expect(s.counts["anthropic:disabled"]).toBe(2)
    expect(s.counts["openai:disabled"]).toBe(1)
    expect(s.counts["openai:native"]).toBe(1)
    expect(s.turns).toBe(4)

    const total = summary()
    expect(total.disabled).toBe(3)
    expect(total.native).toBe(1)
    expect(total.unmapped).toBe(0)
    expect(total.turns).toBe(4)
  })

  it("names every outcome in the summary even at zero", () => {
    // A summary that omits the zeroes cannot answer "did this never happen, or
    // did I forget to look" — the same distinction the module docblock is about.
    const total = summary()
    for (const outcome of OUTCOMES) expect(total[outcome]).toBe(0)
  })

  it("records refusal reasons only for the two ineligible outcomes", () => {
    record({ outcome: "ineligible", providerID: "azure", modelID: "gpt-5", reason: "API key is not configured" })
    record({ outcome: "ineligible-late", providerID: "azure", modelID: "gpt-5", reason: "protocol unsupported" })
    // A reason passed with an outcome that has none must not be counted: it
    // would make the reason totals disagree with the outcome totals.
    record({ outcome: "native", providerID: "azure", modelID: "gpt-5", reason: "ignored" })

    const s = snapshot()
    expect(s.reasons["API key is not configured"]).toBe(1)
    expect(s.reasons["protocol unsupported"]).toBe(1)
    expect(s.reasons["ignored"]).toBeUndefined()
  })

  it("lists refused models and never lists one that ran", () => {
    record({ outcome: "unmapped", providerID: "mistral", modelID: "large" })
    record({ outcome: "ineligible", providerID: "azure", modelID: "gpt-5", reason: "no key" })
    record({ outcome: "native", providerID: "openai", modelID: "gpt-5" })
    record({ outcome: "fallback", providerID: "openai", modelID: "gpt-5" })

    expect(snapshot().refusedModels).toEqual(["azure/gpt-5", "mistral/large"])
  })

  it("deduplicates a refused model rather than counting it twice", () => {
    for (let i = 0; i < 5; i++) record({ outcome: "unmapped", providerID: "mistral", modelID: "large" })

    const s = snapshot()
    expect(s.refusedModels).toEqual(["mistral/large"])
    expect(s.counts["mistral:unmapped"]).toBe(5)
    expect(s.refusedOverflow).toBe(0)
  })

  it("bounds the refused set and reports the overflow instead of growing", () => {
    // The bound is the claim (EOT-05 requirement 7: a stated, tested bound, not
    // an exception). 70 distinct models against a cap of 64.
    for (let i = 0; i < 70; i++) record({ outcome: "unmapped", providerID: "synthetic", modelID: `m${i}` })

    const s = snapshot()
    expect(s.refusedModels.length).toBe(64)
    expect(s.refusedOverflow).toBe(6)
    // Every turn is still counted — only the naming is capped.
    expect(s.counts["synthetic:unmapped"]).toBe(70)
  })

  it("buckets reasons past the cap under `other` without losing the count", () => {
    for (let i = 0; i < 40; i++) {
      record({ outcome: "ineligible", providerID: "synthetic", modelID: "m", reason: `reason ${i}` })
    }

    const s = snapshot()
    const named = Object.keys(s.reasons).filter((k) => k !== "other")
    expect(named.length).toBe(32)
    expect(s.reasons["other"]).toBe(8)
    const totalReasons = Object.values(s.reasons).reduce((a, b) => a + b, 0)
    expect(totalReasons).toBe(40)
  })

  it("clears everything on reset", () => {
    record({ outcome: "unmapped", providerID: "mistral", modelID: "large" })
    reset()

    const s = snapshot()
    expect(s.turns).toBe(0)
    expect(s.counts).toEqual({})
    expect(s.refusedModels).toEqual([])
  })
})

describe("every outcome has a call site", () => {
  const llm = readFileSync(fileURLToPath(new URL("../../src/session/llm.ts", import.meta.url)), "utf8")

  it.each(OUTCOMES as Outcome[])("%s is recorded by session/llm.ts", (outcome) => {
    // Assembled rather than spelled out, so the outcome list stays the single
    // source of truth for what this asserts.
    expect(llm).toContain(`outcome: "${outcome}"`)
  })

  it("records nothing the Outcome union does not declare", () => {
    const found = [...llm.matchAll(/outcome: "([a-z-]+)"/g)].map((m) => m[1])
    expect(found.length).toBeGreaterThanOrEqual(OUTCOMES.length)
    for (const outcome of found) expect(OUTCOMES).toContain(outcome as Outcome)
  })
})
