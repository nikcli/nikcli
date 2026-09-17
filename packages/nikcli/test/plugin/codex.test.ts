import { describe, expect, it } from "bun:test"
import {
  filterCodexOAuthModels,
  isUsageLimitResponse,
  readRequestModel,
  usageLimitResetAt,
  withReserveModel,
} from "@/plugin/codex"

// `filterCodexOAuthModels` trims the OpenAI catalog down to what a ChatGPT
// Pro/Plus OAuth session can actually call through the Codex backend. Anything
// left in the map is offered to the user, so a model the plan cannot reach must
// be removed and a model it can reach must survive.
function providerWith(...apiIds: string[]) {
  return {
    models: Object.fromEntries(apiIds.map((id) => [id, { api: { id } }])),
  }
}

function survivors(...apiIds: string[]) {
  const provider = providerWith(...apiIds)
  filterCodexOAuthModels(provider)
  return Object.keys(provider.models).sort()
}

describe("filterCodexOAuthModels", () => {
  it("keeps gpt-6-astra and its aeon sibling slug", () => {
    expect(survivors("gpt-6-astra", "gpt-6-astra-aeon")).toEqual(["gpt-6-astra", "gpt-6-astra-aeon"])
  })

  it("keeps every codex model", () => {
    expect(survivors("gpt-5.1-codex", "gpt-5.3-codex")).toEqual(["gpt-5.1-codex", "gpt-5.3-codex"])
  })

  it("keeps the explicitly allowed gpt-5.x models", () => {
    expect(survivors("gpt-5.2", "gpt-5.4", "gpt-5.5")).toEqual(["gpt-5.2", "gpt-5.4", "gpt-5.5"])
  })

  it("drops models the ChatGPT plan cannot reach", () => {
    expect(survivors("gpt-4o", "gpt-3.5-turbo", "o3", "gpt-5")).toEqual([])
  })

  it("reads the major version numerically rather than as a prefix", () => {
    // "gpt-60" is major 60, not gpt-6 — both are >= 6, so both are allowed,
    // but the distinction matters for anything that compares versions.
    expect(survivors("gpt-7", "gpt-60")).toEqual(["gpt-60", "gpt-7"])
    expect(survivors("gpt-4o")).toEqual([])
  })
})

describe("gpt-reserve fallback", () => {
  it("keeps the reserve model in an OAuth catalog", () => {
    // The reserve is version-less, so only the explicit allow-list entry saves
    // it — and it must not cost the main models their place.
    expect(survivors("gpt-reserve", "gpt-6-astra", "gpt-5.1-codex-max")).toEqual([
      "gpt-5.1-codex-max",
      "gpt-6-astra",
      "gpt-reserve",
    ])
  })

  it("reads the model out of a Responses body", () => {
    expect(readRequestModel(JSON.stringify({ model: "gpt-6-astra", input: [] }))).toBe("gpt-6-astra")
    expect(readRequestModel("not json")).toBeUndefined()
    expect(readRequestModel(JSON.stringify({ input: [] }))).toBeUndefined()
  })

  it("rewrites the model and clamps efforts the reserve does not have", () => {
    const rewrite = (body: unknown) => JSON.parse(withReserveModel(JSON.stringify(body))!)

    // gpt-6 exposes `ultra` above `max` and `none` below `low`; the reserve has
    // neither end, so an unclamped effort would 400 the retry.
    expect(rewrite({ model: "gpt-6-astra", reasoning: { effort: "ultra" } })).toEqual({
      model: "gpt-reserve",
      reasoning: { effort: "max" },
    })
    expect(rewrite({ model: "gpt-6-astra", reasoning: { effort: "none" } })).toEqual({
      model: "gpt-reserve",
      reasoning: { effort: "low" },
    })
    // A tier the reserve supports is left exactly as the caller set it.
    expect(rewrite({ model: "gpt-5.5", reasoning: { effort: "xhigh" } })).toEqual({
      model: "gpt-reserve",
      reasoning: { effort: "xhigh" },
    })
    expect(rewrite({ model: "gpt-5.5", input: [] })).toEqual({ model: "gpt-reserve", input: [] })
  })

  it("leaves a body it cannot safely rewrite alone", () => {
    expect(withReserveModel("not json")).toBeUndefined()
    expect(withReserveModel("null")).toBeUndefined()
  })

  it("separates a spent plan allowance from a throughput throttle", () => {
    const headers = (init?: Record<string, string>) => new Headers(init)

    // Spent allowance: the marker header, or the backend's own wording.
    expect(isUsageLimitResponse(429, headers({ "x-codex-rate-limit-reached-type": "usage_limit_reached" }), "")).toBe(
      true,
    )
    expect(isUsageLimitResponse(429, headers(), `{"detail":"You've hit your usage limit."}`)).toBe(true)
    expect(isUsageLimitResponse(429, headers(), `{"type":"workspace_owner_credits_depleted"}`)).toBe(true)

    // Sending too fast is retried at the same model, so it must not burn the
    // fallback and pin the session to the reserve.
    expect(isUsageLimitResponse(429, headers(), `{"error":{"code":"rate_limit_exceeded"}}`)).toBe(false)
    expect(isUsageLimitResponse(500, headers(), `{"detail":"You've hit your usage limit."}`)).toBe(false)
  })

  it("prefers the response's own reset hint over the default horizon", () => {
    const now = 1_000_000

    expect(usageLimitResetAt(new Headers({ "retry-after": "120" }), "", now)).toBe(now + 120_000)
    expect(usageLimitResetAt(new Headers(), `{"resets_in_seconds":300}`, now)).toBe(now + 300_000)
    expect(usageLimitResetAt(new Headers(), `{"resets_at":${(now + 60_000) / 1000}}`, now)).toBe(now + 60_000)

    // No hint at all: re-probe in 15 minutes rather than guessing a long window.
    expect(usageLimitResetAt(new Headers(), "{}", now)).toBe(now + 15 * 60 * 1000)

    // A bogus reset cannot pin the session to the reserve indefinitely.
    expect(usageLimitResetAt(new Headers({ "retry-after": "99999999" }), "", now)).toBe(now + 7 * 24 * 60 * 60 * 1000)
  })
})
