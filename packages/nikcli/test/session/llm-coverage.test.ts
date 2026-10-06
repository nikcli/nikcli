import { describe, expect, it, beforeEach, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { OUTCOMES, record, report, reset, snapshot, summary, type Outcome } from "@/session/llm/coverage"
import { Log } from "@nikcli-ai/util/log"

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
    record({
      outcome: "unmapped",
      providerID: "anthropic",
      modelID: "claude-opus-5",
    })
    record({
      outcome: "unmapped",
      providerID: "anthropic",
      modelID: "claude-sonnet-5",
    })
    record({ outcome: "unmapped", providerID: "openai", modelID: "gpt-5" })
    record({ outcome: "native", providerID: "openai", modelID: "gpt-5" })

    const s = snapshot()
    expect(s.counts["anthropic:unmapped"]).toBe(2)
    expect(s.counts["openai:unmapped"]).toBe(1)
    expect(s.counts["openai:native"]).toBe(1)
    expect(s.turns).toBe(4)

    const total = summary()
    expect(total.unmapped).toBe(3)
    expect(total.native).toBe(1)
    expect(total.ineligible).toBe(0)
    expect(total.turns).toBe(4)
  })

  it("names every outcome in the summary even at zero", () => {
    // A summary that omits the zeroes cannot answer "did this never happen, or
    // did I forget to look" — the same distinction the module docblock is about.
    const total = summary()
    for (const outcome of OUTCOMES) expect(total[outcome]).toBe(0)
  })

  it("records refusal reasons only for the two ineligible outcomes", () => {
    record({
      outcome: "ineligible",
      providerID: "azure",
      modelID: "gpt-5",
      reason: "API key is not configured",
    })
    record({
      outcome: "ineligible-late",
      providerID: "azure",
      modelID: "gpt-5",
      reason: "protocol unsupported",
    })
    // A reason passed with an outcome that has none must not be counted: it
    // would make the reason totals disagree with the outcome totals.
    record({
      outcome: "native",
      providerID: "azure",
      modelID: "gpt-5",
      reason: "ignored",
    })

    const s = snapshot()
    expect(s.reasons["API key is not configured"]).toBe(1)
    expect(s.reasons["protocol unsupported"]).toBe(1)
    expect(s.reasons["ignored"]).toBeUndefined()
  })

  it("lists refused models and never lists one that ran", () => {
    record({ outcome: "unmapped", providerID: "mistral", modelID: "large" })
    record({
      outcome: "ineligible",
      providerID: "azure",
      modelID: "gpt-5",
      reason: "no key",
    })
    record({ outcome: "native", providerID: "openai", modelID: "gpt-5" })

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
    for (let i = 0; i < 70; i++)
      record({
        outcome: "unmapped",
        providerID: "synthetic",
        modelID: `m${i}`,
      })

    const s = snapshot()
    expect(s.refusedModels.length).toBe(64)
    expect(s.refusedOverflow).toBe(6)
    // Every turn is still counted — only the naming is capped.
    expect(s.counts["synthetic:unmapped"]).toBe(70)
  })

  it("buckets reasons past the cap under `other` without losing the count", () => {
    for (let i = 0; i < 40; i++) {
      record({
        outcome: "ineligible",
        providerID: "synthetic",
        modelID: "m",
        reason: `reason ${i}`,
      })
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
    expect(s.reasons).toEqual({})
    expect(s.refusedOverflow).toBe(0)
    expect(report().providers).toEqual([])
  })

  it("caps custom providers and retains every outcome in the reserved overflow bucket", () => {
    for (let i = 0; i < 40; i++) {
      for (const outcome of OUTCOMES) record({ outcome, providerID: `custom:${i}`, modelID: "m" })
    }
    // Existing providers remain named after admission closes.
    record({ outcome: "unmapped", providerID: "custom:0", modelID: "m" })
    record({ outcome: "native", providerID: "other", modelID: "m" })
    const s = snapshot()
    const r = report()
    expect(r.providers.length).toBe(33)
    expect(Object.keys(s.counts).length).toBe(33 * OUTCOMES.length)
    expect(s.counts["custom:0:unmapped"]).toBe(2)
    expect(s.counts["custom:32:native"]).toBeUndefined()
    for (const outcome of OUTCOMES) expect(s.counts[`other:${outcome}`]).toBe(outcome === "native" ? 9 : 8)
    expect(r.providers.find((p) => p.overflow)?.turns).toBe(8 * OUTCOMES.length + 1)
    for (const outcome of OUTCOMES) {
      expect(r.providers.reduce((sum, p) => sum + p[outcome], 0)).toBe(r[outcome])
    }
    expect(OUTCOMES.reduce((sum, outcome) => sum + r[outcome], 0)).toBe(40 * OUTCOMES.length + 2)
    expect(r.providers.reduce((sum, p) => sum + p.turns, 0)).toBe(r.turns)
    expect(Object.values(s.counts).reduce((sum, n) => sum + n, 0)).toBe(s.turns)
  })

  it("reserves provider and reason overflow names even when seen before the cap", () => {
    record({
      outcome: "ineligible",
      providerID: "other",
      modelID: "m",
      reason: "other",
    })
    for (let i = 0; i < 40; i++) {
      record({
        outcome: "ineligible",
        providerID: `p${i}`,
        modelID: "m",
        reason: `r${i}`,
      })
    }
    record({
      outcome: "ineligible-late",
      providerID: "p0",
      modelID: "m",
      reason: "r0",
    })
    record({
      outcome: "ineligible",
      providerID: "other",
      modelID: "m",
      reason: "other",
    })
    expect(report().providers.length).toBe(33)
    expect(snapshot().counts["other:ineligible"]).toBe(10)
    expect(Object.keys(snapshot().reasons).length).toBe(33)
    expect(snapshot().reasons.other).toBe(10)
    expect(snapshot().reasons.r0).toBe(2)
    expect(Object.values(snapshot().reasons).reduce((sum, n) => sum + n, 0)).toBe(43)
    reset()
    expect(report().providers).toEqual([])
    expect(snapshot().reasons).toEqual({})
  })

  it("reports mapped and refused turns per provider", () => {
    record({ outcome: "unmapped", providerID: "z:custom", modelID: "m" })
    for (const outcome of OUTCOMES) record({ outcome, providerID: "a", modelID: "m" })
    record({ outcome: "native", providerID: "a", modelID: "m" })
    const r = report()
    expect(r.providers.map((p) => p.providerID)).toEqual(["a", "z:custom"])
    expect(r.providers[0]).toMatchObject({
      turns: 6,
      mapped: 5,
      eligibilityRefused: 2,
      overflow: false,
    })
    expect(r.providers[1]).toMatchObject({
      turns: 1,
      mapped: 0,
      eligibilityRefused: 0,
    })
    expect(summary().unmapped).toBe(2)
    expect(summary().native).toBe(2)
    expect(summary().fallback).toBe(1)
    expect(report()).toEqual(r)
  })

  it("counts repeated unretained model observations, not distinct overflow models", () => {
    for (let i = 0; i < 64; i++) record({ outcome: "unmapped", providerID: "p", modelID: `m${i}` })
    for (let i = 0; i < 3; i++) record({ outcome: "unmapped", providerID: "p", modelID: "overflow" })
    record({ outcome: "unmapped", providerID: "p", modelID: "m0" })
    expect(snapshot().refusedOverflow).toBe(3)
    expect(snapshot().refusedModels.length).toBe(64)
  })

  it("feeds the real periodic logger a report without model or request data", () => {
    const logger = Log.create({ service: "llm-coverage" })
    const calls = spyOn(logger, "info")
    const writes = spyOn(process.stderr, "write")
    try {
      const input = {
        outcome: "ineligible" as const,
        providerID: "custom:private",
        modelID: "private-model",
        reason: "API key is not configured",
        sessionID: "private-session",
        prompt: "private-prompt",
        token: "private-token",
        path: "/private/path",
      }
      for (let i = 0; i < 24; i++) record(input)
      expect(calls).not.toHaveBeenCalled()
      record(input)
      expect(calls).toHaveBeenCalledTimes(1)
      expect(calls.mock.calls[0]).toEqual(["native route coverage", report()])
      const output = writes.mock.calls.map(([value]) => String(value)).join("")
      expect(output).toContain("native route coverage")
      expect(output).toContain("eligibilityRefused")
      for (const privateValue of [input.modelID, input.sessionID, input.prompt, input.token, input.path]) {
        expect(JSON.stringify(report())).not.toContain(privateValue)
        expect(output).not.toContain(privateValue)
      }
      expect(snapshot().refusedModels).toEqual([`${input.providerID}/${input.modelID}`])
      for (const privateValue of [input.sessionID, input.prompt, input.token, input.path]) {
        expect(JSON.stringify(snapshot())).not.toContain(privateValue)
      }
      record({
        outcome: "ineligible",
        providerID: "p",
        modelID: "m",
        reason: "Bearer sk-private012345678901234567890123456789",
      })
      for (let i = 0; i < 24; i++) record({ outcome: "native", providerID: "p", modelID: "m" })
      expect(calls).toHaveBeenCalledTimes(2)
      expect(writes.mock.calls.map(([value]) => String(value)).join("")).not.toContain(
        "sk-private012345678901234567890123456789",
      )
    } finally {
      calls.mockRestore()
      writes.mockRestore()
    }
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
