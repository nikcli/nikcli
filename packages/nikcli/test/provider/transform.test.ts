import { describe, expect, it } from "bun:test"
import * as ProviderTransform from "@/provider/transform"
import type { Provider } from "@/provider/provider"

// These transforms only read providerID, model.id, model.api.{npm,id}, and capabilities.reasoning.
function mockModel(input: { id: string; npm: string; apiId: string; reasoning: boolean }): Provider.Model {
  return {
    providerID: "openrouter",
    id: input.id,
    api: {
      id: input.apiId,
      url: "https://openrouter.ai/api/v1",
      npm: input.npm,
    },
    capabilities: { reasoning: input.reasoning },
  } as unknown as Provider.Model
}

describe("ProviderTransform.message — cache breakpoints", () => {
  it("adds OpenRouter cache breakpoints", () => {
    const model = mockModel({
      id: "openrouter/fusion",
      apiId: "openrouter/fusion",
      npm: "@openrouter/ai-sdk-provider",
      reasoning: false,
    })
    const messages = ProviderTransform.message([{ role: "system", content: "stable instructions" }], model, {})

    expect(messages[0]?.providerOptions?.openrouter).toEqual({
      cacheControl: { type: "ephemeral" },
    })
  })
})

describe("ProviderTransform.variants — openrouter fusion", () => {
  it("returns quality and budget presets even without reasoning capabilities", () => {
    const result = ProviderTransform.variants(
      mockModel({
        id: "openrouter/fusion",
        apiId: "openrouter/fusion",
        npm: "@openrouter/ai-sdk-provider",
        reasoning: false,
      }),
    )

    expect(result).toEqual({
      quality: {
        plugins: [
          {
            id: "fusion",
            analysis_models: ["~anthropic/claude-opus-latest", "~openai/gpt-latest", "~google/gemini-pro-latest"],
            model: "~anthropic/claude-opus-latest",
          },
        ],
      },
      budget: {
        plugins: [
          {
            id: "fusion",
            analysis_models: ["~google/gemini-flash-latest", "~moonshotai/kimi-latest", "deepseek/deepseek-v4-pro"],
            model: "~google/gemini-flash-latest",
          },
        ],
      },
    })
  })

  it("does not apply fusion presets to other openrouter models", () => {
    const result = ProviderTransform.variants(
      mockModel({
        id: "openrouter/some-model",
        apiId: "openrouter/some-model",
        npm: "@openrouter/ai-sdk-provider",
        reasoning: false,
      }),
    )
    expect(result).toEqual({})
  })

  it("exposes xhigh for grok multi-agent through OpenRouter's generic passthrough", () => {
    const result = ProviderTransform.variants(
      mockModel({
        id: "x-ai/grok-4.20-multi-agent-0309",
        apiId: "x-ai/grok-4.20-multi-agent-0309",
        npm: "@openrouter/ai-sdk-provider",
        reasoning: true,
      }),
    )
    expect(result).toEqual({
      low: { reasoning: { effort: "low" } },
      medium: { reasoning: { effort: "medium" } },
      high: { reasoning: { effort: "high" } },
      xhigh: { reasoning: { effort: "xhigh" } },
    })
  })

  it("maps fusion variant options to the OpenRouter request body namespace", () => {
    const model = mockModel({
      id: "openrouter/fusion",
      apiId: "openrouter/fusion",
      npm: "@openrouter/ai-sdk-provider",
      reasoning: false,
    })
    const budget = ProviderTransform.variants(model).budget

    expect(ProviderTransform.providerOptions(model, budget)).toEqual({
      openrouter: budget,
    })
  })
})

describe("ProviderTransform.variants — xai reasoning efforts", () => {
  const xaiModel = (id: string, reasoning = true) => mockModel({ id, apiId: id, npm: "@ai-sdk/xai", reasoning })

  it("gives grok-4.5 low/medium/high", () => {
    expect(ProviderTransform.variants(xaiModel("grok-4.5"))).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    })
  })

  it("gives grok multi-agent low/medium/high, dropping xhigh the SDK schema rejects", () => {
    expect(ProviderTransform.variants(xaiModel("grok-4.20-multi-agent-0309"))).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    })
  })

  it("keeps grok-3-mini at low/high", () => {
    expect(ProviderTransform.variants(xaiModel("grok-3-mini"))).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    })
  })

  it("gives fixed-depth grok reasoning models no variants", () => {
    for (const id of ["grok-4.3", "grok-4.20-0309-reasoning", "grok-code-fast-1", "grok-build-0.1", "grok-4"]) {
      expect(ProviderTransform.variants(xaiModel(id))).toEqual({})
    }
  })

  it("gives non-grok models served under the xai provider no variants", () => {
    expect(ProviderTransform.variants(xaiModel("composer-2.5"))).toEqual({})
  })

  it("does not treat non-reasoning grok models as effort-capable", () => {
    expect(ProviderTransform.variants(xaiModel("grok-4.5", false))).toEqual({})
  })
})

// GPT-6 Astra (gpt-6-astra, released 2026-09-03) drops the `none` and `minimal`
// tiers GPT-5.x exposed — both 400 on this family — and adds `max` at the top.
// `max` is Responses-API only, so chat-shaped fronts get the shorter set.
// see: https://developers.openai.com/api/docs/models/gpt-6-astra
describe("ProviderTransform.variants — gpt-6 astra reasoning efforts", () => {
  function openaiModel(apiId: string, npm = "@ai-sdk/openai", providerID = "openai"): Provider.Model {
    return {
      providerID,
      id: apiId,
      release_date: "2026-09-03",
      api: { id: apiId, url: "https://api.openai.com/v1", npm },
      capabilities: { reasoning: true },
    } as unknown as Provider.Model
  }

  it("exposes low/medium/high/xhigh/max on direct OpenAI", () => {
    expect(Object.keys(ProviderTransform.variants(openaiModel("gpt-6-astra")))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  it("never offers none or minimal", () => {
    const efforts = Object.keys(ProviderTransform.variants(openaiModel("gpt-6-astra")))
    expect(efforts).not.toContain("none")
    expect(efforts).not.toContain("minimal")
  })

  it("carries the encrypted-reasoning include so stateless multi-turn works", () => {
    const result = ProviderTransform.variants(openaiModel("gpt-6-astra"))
    expect(result.medium).toEqual({
      reasoningEffort: "medium",
      reasoningSummary: "detailed",
      include: ["reasoning.encrypted_content"],
    })
  })

  it("drops the Responses-only max tier on OpenRouter", () => {
    expect(
      Object.keys(
        ProviderTransform.variants(openaiModel("openai/gpt-6-astra", "@openrouter/ai-sdk-provider", "openrouter")),
      ),
    ).toEqual(["low", "medium", "high", "xhigh"])
  })

  it("drops the Responses-only max tier on Copilot and Azure", () => {
    for (const npm of ["@ai-sdk/github-copilot", "@ai-sdk/azure"]) {
      expect(Object.keys(ProviderTransform.variants(openaiModel("gpt-6-astra", npm, "azure")))).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
      ])
    }
  })

  it("leaves the gpt-5 tier sets untouched", () => {
    expect(Object.keys(ProviderTransform.variants(openaiModel("gpt-5.2")))).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ])
    expect(Object.keys(ProviderTransform.variants(openaiModel("gpt-5-pro")))).toEqual(["high"])
  })

  it("matches the family anchored, so gpt-60 is not read as gpt-6", () => {
    expect(ProviderTransform.isGpt6Family("gpt-6-astra")).toBe(true)
    expect(ProviderTransform.isGpt6Family("openai/gpt-6-astra")).toBe(true)
    expect(ProviderTransform.isGpt6Family("GPT-6-Astra")).toBe(true)
    expect(ProviderTransform.isGpt6Family("gpt-60")).toBe(false)
    expect(ProviderTransform.isGpt6Family("gpt-5.4")).toBe(false)
  })
})

describe("ProviderTransform.options — gpt-6 astra defaults", () => {
  function optionsFor(apiId: string, npm = "@ai-sdk/openai", providerID = "openai") {
    return ProviderTransform.options({
      sessionID: "ses_test",
      model: {
        providerID,
        id: apiId,
        release_date: "2026-09-03",
        api: { id: apiId, url: "https://api.openai.com/v1", npm },
        capabilities: { reasoning: true },
        limit: { context: 1_050_000, output: 128_000 },
      },
    } as unknown as Parameters<typeof ProviderTransform.options>[0])
  }

  it("defaults to medium effort with a detailed summary on direct OpenAI", () => {
    const result = optionsFor("gpt-6-astra")
    expect(result["reasoningEffort"]).toBe("medium")
    expect(result["reasoningSummary"]).toBe("detailed")
    expect(result["include"]).toEqual(["reasoning.encrypted_content"])
  })

  it("does not send textVerbosity, which is undocumented for the family", () => {
    expect(optionsFor("gpt-6-astra")["textVerbosity"]).toBeUndefined()
  })

  it("falls back to an auto summary on gateways", () => {
    expect(optionsFor("gpt-6-astra", "@ai-sdk/github-copilot", "github-copilot")["reasoningSummary"]).toBe("auto")
  })

  it("still sets textVerbosity for gpt-5.x", () => {
    expect(optionsFor("gpt-5.2")["textVerbosity"]).toBe("low")
  })
})

// GPT-Reserve is the model a ChatGPT plan falls back to once its main models
// are spent. It is version-less, so it matches neither the gpt-5 nor the gpt-6
// family rules and needs its own tier set: low/medium/high/xhigh/max, with no
// `none`/`minimal` (both 400) and `max` Responses-only, like gpt-6.
describe("ProviderTransform — gpt-reserve", () => {
  function reserveModel(apiId = "gpt-reserve", npm = "@ai-sdk/openai", providerID = "openai"): Provider.Model {
    return {
      providerID,
      id: apiId,
      release_date: "2026-09-03",
      api: { id: apiId, url: "https://api.openai.com/v1", npm },
      capabilities: { reasoning: true },
      limit: { context: 272_000, output: 128_000 },
    } as unknown as Provider.Model
  }

  it("exposes low/medium/high/xhigh/max on direct OpenAI", () => {
    expect(Object.keys(ProviderTransform.variants(reserveModel()))).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  it("never offers none or minimal", () => {
    // Without its own branch the generic OpenAI rules would add `none` off the
    // release date, which the reserve rejects.
    const efforts = Object.keys(ProviderTransform.variants(reserveModel()))
    expect(efforts).not.toContain("none")
    expect(efforts).not.toContain("minimal")
  })

  it("drops the Responses-only max tier on chat-shaped fronts", () => {
    expect(
      Object.keys(ProviderTransform.variants(reserveModel("gpt-reserve", "@openrouter/ai-sdk-provider", "openrouter"))),
    ).toEqual(["low", "medium", "high", "xhigh"])
  })

  it("matches anchored, so an unrelated id is not read as the reserve", () => {
    expect(ProviderTransform.isGptReserve("gpt-reserve")).toBe(true)
    expect(ProviderTransform.isGptReserve("openai/gpt-reserve")).toBe(true)
    expect(ProviderTransform.isGptReserve("GPT-Reserve")).toBe(true)
    expect(ProviderTransform.isGptReserve("gpt-reserved")).toBe(false)
    expect(ProviderTransform.isGptReserve("gpt-6-astra")).toBe(false)
  })

  it("defaults to medium effort with the encrypted-reasoning include", () => {
    const result = ProviderTransform.options({
      sessionID: "ses_test",
      model: reserveModel(),
    } as unknown as Parameters<typeof ProviderTransform.options>[0])
    expect(result["reasoningEffort"]).toBe("medium")
    expect(result["reasoningSummary"]).toBe("detailed")
    expect(result["include"]).toEqual(["reasoning.encrypted_content"])
    // The Codex manifest marks the reserve as verbosity-aware, defaulting low.
    expect(result["textVerbosity"]).toBe("low")
  })
})
